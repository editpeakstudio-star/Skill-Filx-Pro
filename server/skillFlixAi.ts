import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import type { AiConnectionTestResult } from '../src/types/index.ts';
import {
  fetchFirestoreDocument,
  getServerServiceAccountToken,
  hasServerServiceAccount,
  listFirestoreCollection,
  type VerifiedFirebaseUser
} from './firebaseAuthVerify.ts';
import {
  getResolvedRuntimeAiConfig,
  hydrateAiConfigFromFirestore,
  type ResolvedAiRuntimeConfig
} from './aiConfigStore.ts';
import { sanitizeErrorMessage } from './telegramCrypto.ts';

const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'skillflix-academy';
const PLATFORM_OWNER_EMAIL = 'editpeakstudio@gmail.com';

const MAX_MESSAGE_CHARS = 1500;
const MAX_HISTORY_TURNS = 6;

const UNWANTED_DEMO_VIDEO_IDS = new Set([
  'vid_am_vectors',
  'vid_am_null_rigs',
  'vid_am_3d_camera',
  'vid_cap_velocity',
  'vid_cap_effects',
  'vid_prem_lumetri',
  'vid_ae_saber'
]);

const UNWANTED_DEMO_PDF_IDS = new Set([
  'pdf_am_cheatsheet',
  'pdf_cap_curves'
]);

export interface AiTurnInput {
  role: 'user' | 'model';
  text: string;
}

export interface AiChatRequestBody {
  message: string;
  history?: AiTurnInput[];
  stream?: boolean;
}

export interface AiQuotaSnapshot {
  minuteLimit: number;
  minuteRemaining: number;
  dailyLimit: number;
  dailyRemaining: number;
  resetMinuteAt: string;
}

export interface AiChatReply {
  reply: string;
  model: string;
  provider: string;
  freeTier: boolean;
  referencedCourses: string[];
  quota: AiQuotaSnapshot;
}

export interface AiPublicStatus {
  online: boolean;
  provider: string;
  model: string;
  fallbackModel: string;
  freeTier: boolean;
  reason?: string;
  limits: {
    perMinute: number;
    perDay: number;
  };
}

export class AiServiceError extends Error {
  status: number;
  code: string;
  quota?: AiQuotaSnapshot;

  constructor(status: number, code: string, message: string, quota?: AiQuotaSnapshot) {
    super(message);
    this.status = status;
    this.code = code;
    this.quota = quota;
  }
}

interface UserRateBucket {
  minuteTimestamps: number[];
  dayKey: string;
  dayCount: number;
}

interface UserProfileCacheEntry {
  profile: Record<string, unknown> | null;
  expiresAt: number;
}

interface CatalogCacheEntry {
  cats: Record<string, unknown>[];
  folders: Record<string, unknown>[];
  videos: Record<string, unknown>[];
  pdfs?: Record<string, unknown>[];
  expiresAt: number;
}

interface UserPdfCacheEntry {
  pdfs: Record<string, unknown>[];
  expiresAt: number;
}

const rateBuckets = new Map<string, UserRateBucket>();
const userProfileCache = new Map<string, UserProfileCacheEntry>();
const publicCatalogCache = new Map<string, CatalogCacheEntry>();
const adminCatalogCache = new Map<string, CatalogCacheEntry>();
const userPdfCache = new Map<string, UserPdfCacheEntry>();
const geminiClientCache = new Map<string, GoogleGenAI>();

function getGeminiClient(apiKey: string): GoogleGenAI {
  const existing = geminiClientCache.get(apiKey);
  if (existing) return existing;
  if (geminiClientCache.size > 6) geminiClientCache.clear();
  const client = new GoogleGenAI({
    apiKey,
    httpOptions: {
      timeout: 24_000,
      headers: {
        'User-Agent': 'aistudio-build'
      }
    }
  });
  geminiClientCache.set(apiKey, client);
  return client;
}

function currentDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function getOrUpdateQuota(
  uid: string,
  consume = false,
  perMinuteLimit?: number,
  perDayLimit?: number
): AiQuotaSnapshot {
  const cfg = getResolvedRuntimeAiConfig();
  const minuteLimit = Math.max(1, perMinuteLimit ?? cfg.AI_RATE_LIMIT_PER_MIN);
  const dailyLimit = Math.max(1, perDayLimit ?? cfg.AI_RATE_LIMIT_PER_DAY);
  const now = Date.now();
  const minuteCutoff = now - 60_000;
  const dayKey = currentDayKey(now);

  let bucket = rateBuckets.get(uid);
  if (!bucket) {
    bucket = { minuteTimestamps: [], dayKey, dayCount: 0 };
    rateBuckets.set(uid, bucket);
  }

  bucket.minuteTimestamps = bucket.minuteTimestamps.filter(ts => ts > minuteCutoff);
  if (bucket.dayKey !== dayKey) {
    bucket.dayKey = dayKey;
    bucket.dayCount = 0;
  }

  const oldestInWindow = bucket.minuteTimestamps[0] || now;
  const resetMinuteAt = new Date(oldestInWindow + 60_000).toISOString();

  if (consume) {
    if (bucket.minuteTimestamps.length >= minuteLimit) {
      throw new AiServiceError(
        429,
        'USER_RATE_LIMITED',
        `You have reached the ${minuteLimit} messages/minute limit. Please wait a few seconds before asking again.`,
        {
          minuteLimit,
          minuteRemaining: 0,
          dailyLimit,
          dailyRemaining: Math.max(0, dailyLimit - bucket.dayCount),
          resetMinuteAt
        }
      );
    }

    if (bucket.dayCount >= dailyLimit) {
      throw new AiServiceError(
        429,
        'USER_DAILY_LIMIT',
        `Daily free-tier limit (${dailyLimit} messages/day) reached for your account. Your quota resets tomorrow (UTC).`,
        {
          minuteLimit,
          minuteRemaining: Math.max(0, minuteLimit - bucket.minuteTimestamps.length),
          dailyLimit,
          dailyRemaining: 0,
          resetMinuteAt
        }
      );
    }

    bucket.minuteTimestamps.push(now);
    bucket.dayCount += 1;
  }

  return {
    minuteLimit,
    minuteRemaining: Math.max(0, minuteLimit - bucket.minuteTimestamps.length),
    dailyLimit,
    dailyRemaining: Math.max(0, dailyLimit - bucket.dayCount),
    resetMinuteAt
  };
}

export function getAiStatus(): AiPublicStatus {
  const cfg = getResolvedRuntimeAiConfig();
  const hasGeminiKey = Boolean(cfg.GEMINI_API_KEY);
  const hasAltKey = Boolean(
    cfg.AI_PROVIDER === 'groq' ? cfg.GROQ_API_KEY : cfg.AI_PROVIDER === 'openrouter' ? cfg.OPENROUTER_API_KEY : ''
  );

  if (cfg.AI_PROVIDER === 'gemini') {
    return {
      online: hasGeminiKey,
      provider: 'Google Gemini API (Free Tier)',
      model: cfg.GEMINI_AI_MODEL,
      fallbackModel: cfg.GEMINI_FALLBACK_MODEL,
      freeTier: true,
      reason: hasGeminiKey
        ? undefined
        : cfg.vaultDecryptError
          ? 'Encrypted GEMINI_API_KEY exists in vault, but TELEGRAM_ENCRYPTION_KEY failed to decrypt it.'
          : 'Gemini API key is not configured.',
      limits: {
        perMinute: cfg.AI_RATE_LIMIT_PER_MIN,
        perDay: cfg.AI_RATE_LIMIT_PER_DAY
      }
    };
  }

  return {
    online: hasAltKey,
    provider: cfg.AI_PROVIDER,
    model:
      (!cfg.GEMINI_AI_MODEL.toLowerCase().startsWith('gemini-') ? cfg.GEMINI_AI_MODEL : '') ||
      process.env.AI_MODEL ||
      (cfg.AI_PROVIDER === 'groq' ? 'llama-3.3-70b-versatile' : 'meta-llama/llama-3.3-70b-instruct:free'),
    fallbackModel: cfg.GEMINI_FALLBACK_MODEL,
    freeTier: true,
    reason: hasAltKey ? undefined : `${cfg.AI_PROVIDER.toUpperCase()} API key is not configured in server environment.`,
    limits: {
      perMinute: cfg.AI_RATE_LIMIT_PER_MIN,
      perDay: cfg.AI_RATE_LIMIT_PER_DAY
    }
  };
}

export async function getAsyncAiStatus(): Promise<AiPublicStatus> {
  await hydrateAiConfigFromFirestore();
  return getAiStatus();
}

// ======================================================
// FIRESTORE STRUCTURED QUERY + CACHING HELPERS
// ======================================================

type RawFsVal = Record<string, any>;

function decodeFsValue(val: RawFsVal): unknown {
  if (!val || typeof val !== 'object') return undefined;
  if ('stringValue' in val) return val.stringValue;
  if ('integerValue' in val) return Number(val.integerValue);
  if ('doubleValue' in val) return Number(val.doubleValue);
  if ('booleanValue' in val) return val.booleanValue;
  if ('nullValue' in val) return null;
  if ('timestampValue' in val) return val.timestampValue;
  if ('arrayValue' in val) {
    return Array.isArray(val.arrayValue?.values) ? val.arrayValue.values.map(decodeFsValue) : [];
  }
  if ('mapValue' in val) {
    const out: Record<string, unknown> = {};
    const fields = val.mapValue?.fields || {};
    for (const [k, v] of Object.entries(fields)) {
      out[k] = decodeFsValue(v as RawFsVal);
    }
    return out;
  }
  return undefined;
}

function decodeFsDoc(docJson: { name?: string; fields?: Record<string, RawFsVal> }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (docJson.name) {
    const parts = docJson.name.split('/');
    out.id = parts[parts.length - 1];
  }
  if (docJson.fields) {
    for (const [k, v] of Object.entries(docJson.fields)) {
      out[k] = decodeFsValue(v);
    }
  }
  return out;
}

async function fetchAiWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 25_000,
  knownSecrets: string[] = [],
  externalSignal?: AbortSignal
): Promise<globalThis.Response> {
  if (externalSignal?.aborted) {
    throw new AiServiceError(499, 'AI_CANCELLED', 'AI request was cancelled.');
  }

  const controller = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err: any) {
    if (externalSignal?.aborted && !timedOut) {
      throw new AiServiceError(499, 'AI_CANCELLED', 'AI request was cancelled.');
    }
    if (timedOut || err?.name === 'AbortError') {
      throw new AiServiceError(
        504,
        'AI_TIMEOUT',
        'Skill-Flix AI request timed out while waiting for the server. Please try again.'
      );
    }
    const cleanMsg = sanitizeErrorMessage(err?.message || 'Upstream network request failed.', knownSecrets);
    throw new AiServiceError(503, 'AI_NETWORK_ERROR', cleanMsg);
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}

async function runFirestoreQuery(
  structuredQuery: Record<string, unknown>,
  idToken: string
): Promise<Record<string, unknown>[]> {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents:runQuery`;
  const res = await fetchAiWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${idToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({ structuredQuery })
    },
    8000
  );

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Firestore query error (${res.status}): ${errText.slice(0, 160)}`);
  }

  const rows = (await res.json()) as Array<{ document?: { name?: string; fields?: Record<string, RawFsVal> } }>;
  const docs: Record<string, unknown>[] = [];
  for (const row of rows) {
    if (row.document) {
      docs.push(decodeFsDoc(row.document));
    }
  }
  return docs;
}

interface SkillFlixKnowledgeContext {
  viewerRole: 'owner' | 'admin' | 'student';
  viewerFirstName: string;
  hasAllAccess: boolean;
  unlockedCategoryIds: string[];
  allCourseNames: string[];
  categories: Array<{
    id: string;
    name: string;
    description: string;
    price: number;
    unlocked: boolean;
    lessonCount: number;
    pdfCount: number;
    detailed: boolean;
    folders: string[];
    lessons: Array<{
      title: string;
      episode: string;
      folderName: string;
      isFreePreview: boolean;
    }>;
    pdfs: Array<{
      title: string;
      pageCount: number;
    }>;
  }>;
}

function tokenizeQuery(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\u0900-\u097f]+/gi, ' ')
    .split(/\s+/)
    .map(t => t.trim())
    .filter(t => t.length >= 2);
}

function scoreMatch(haystack: string, tokens: string[]): number {
  if (!tokens.length) return 0;
  const lower = haystack.toLowerCase();
  let score = 0;
  for (const tok of tokens) {
    if (lower.includes(tok)) score += 1;
  }
  return score;
}

async function fetchCachedUserProfile(uid: string, idToken: string): Promise<Record<string, unknown> | null> {
  const now = Date.now();
  const cached = userProfileCache.get(uid);
  if (cached && cached.expiresAt > now) {
    return cached.profile;
  }

  const profile = await fetchFirestoreDocument('users', uid, idToken).catch(() => null);
  if (userProfileCache.size > 300) userProfileCache.clear();
  userProfileCache.set(uid, { profile, expiresAt: now + 15_000 });
  return profile;
}

async function fetchCachedCatalog(
  token: string,
  includePdfs: boolean,
  isAdmin: boolean
): Promise<CatalogCacheEntry> {
  const now = Date.now();
  const cacheMap = isAdmin ? adminCatalogCache : publicCatalogCache;
  const cached = cacheMap.get(FIREBASE_PROJECT_ID);
  if (cached && cached.expiresAt > now && (!includePdfs || cached.pdfs !== undefined)) {
    return cached;
  }

  const [cats, folders, videos, pdfs] = await Promise.all([
    isAdmin
      ? listFirestoreCollection('categories', token).catch(() => [])
      : runFirestoreQuery(
          {
            from: [{ collectionId: 'categories' }],
            where: {
              fieldFilter: {
                field: { fieldPath: 'isActive' },
                op: 'EQUAL',
                value: { booleanValue: true }
              }
            },
            limit: 100
          },
          token
        ).catch(() => []),
    listFirestoreCollection('folders', token).catch(() => []),
    runFirestoreQuery(
      {
        from: [{ collectionId: 'videoCatalog' }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'isPublished' },
            op: 'EQUAL',
            value: { booleanValue: true }
          }
        },
        limit: 250
      },
      token
    ).catch(() => []),
    includePdfs
      ? (isAdmin
          ? listFirestoreCollection('pdfs', token).catch(() => [])
          : runFirestoreQuery(
              {
                from: [{ collectionId: 'pdfs' }],
                where: {
                  fieldFilter: {
                    field: { fieldPath: 'isPublished' },
                    op: 'EQUAL',
                    value: { booleanValue: true }
                  }
                },
                limit: 200
              },
              token
            ).catch(() => []))
      : Promise.resolve(undefined)
  ]);

  const entry: CatalogCacheEntry = {
    cats,
    folders,
    videos,
    pdfs,
    expiresAt: now + 60_000
  };
  cacheMap.set(FIREBASE_PROJECT_ID, entry);
  return entry;
}

async function fetchCachedUserPdfs(
  uid: string,
  idToken: string,
  hasAllAccess: boolean,
  unlockedSet: Set<string>,
  sharedPdfs?: Record<string, unknown>[]
): Promise<Record<string, unknown>[]> {
  if (sharedPdfs) {
    if (hasAllAccess) return sharedPdfs;
    if (unlockedSet.size === 0) return [];
    return sharedPdfs.filter(p => unlockedSet.has(String(p.categoryId || '')));
  }

  if (!hasAllAccess && unlockedSet.size === 0) return [];

  const key = `${uid}:${hasAllAccess ? '1' : '0'}:${Array.from(unlockedSet).sort().join(',')}`;
  const now = Date.now();
  const cached = userPdfCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.pdfs;
  }

  let rawPdfs: Record<string, unknown>[] = [];
  if (hasAllAccess) {
    rawPdfs = await runFirestoreQuery(
      {
        from: [{ collectionId: 'pdfs' }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'isPublished' },
            op: 'EQUAL',
            value: { booleanValue: true }
          }
        },
        limit: 200
      },
      idToken
    ).catch(() => []);
  } else {
    const perCatPdfs = await Promise.all(
      Array.from(unlockedSet).slice(0, 20).map(catId =>
        runFirestoreQuery(
          {
            from: [{ collectionId: 'pdfs' }],
            where: {
              compositeFilter: {
                op: 'AND',
                filters: [
                  {
                    fieldFilter: {
                      field: { fieldPath: 'isPublished' },
                      op: 'EQUAL',
                      value: { booleanValue: true }
                    }
                  },
                  {
                    fieldFilter: {
                      field: { fieldPath: 'categoryId' },
                      op: 'EQUAL',
                      value: { stringValue: catId }
                    }
                  }
                ]
              }
            },
            limit: 60
          },
          idToken
        ).catch(() => [])
      )
    );
    rawPdfs = perCatPdfs.flat();
  }

  if (userPdfCache.size > 300) userPdfCache.clear();
  userPdfCache.set(key, { pdfs: rawPdfs, expiresAt: now + 30_000 });
  return rawPdfs;
}

async function retrieveSkillFlixKnowledge(
  caller: VerifiedFirebaseUser,
  userQuestion: string,
  preFetchedUserProfile?: Record<string, unknown> | null,
  preFetchedSaToken?: string | null
): Promise<SkillFlixKnowledgeContext> {
  const userProfile =
    preFetchedUserProfile !== undefined
      ? preFetchedUserProfile
      : await fetchCachedUserProfile(caller.uid, caller.idToken);

  const isOwner = caller.email.toLowerCase() === PLATFORM_OWNER_EMAIL && caller.emailVerified;
  if (
    userProfile &&
    (userProfile.isSuspended === true || userProfile.accountStatus === 'suspended') &&
    !isOwner
  ) {
    throw new AiServiceError(
      403,
      'ACCOUNT_SUSPENDED',
      'Your Skill-Flix account is currently suspended. Contact support for help.'
    );
  }

  const rawRole = typeof userProfile?.role === 'string' ? userProfile.role : 'user';
  const isAdmin = isOwner || rawRole === 'master_admin' || rawRole === 'admin';

  const expiryRaw =
    typeof userProfile?.accessExpiry === 'string'
      ? userProfile.accessExpiry
      : typeof userProfile?.accessExpiryAt === 'string'
        ? userProfile.accessExpiryAt
        : null;
  const isExpired = Boolean(
    userProfile?.subscriptionStatus === 'expired' ||
      (expiryRaw && !Number.isNaN(new Date(expiryRaw).getTime()) && new Date(expiryRaw).getTime() <= Date.now())
  );

  const hasAllAccess = isAdmin || (!isExpired && userProfile?.hasAllAccess === true);
  const unlockedSet = new Set<string>();
  if (!isExpired) {
    const allowed = Array.isArray(userProfile?.allowedCategories) ? userProfile.allowedCategories : [];
    const assigned = Array.isArray(userProfile?.assignedCourses) ? userProfile.assignedCourses : [];
    for (const id of [...allowed, ...assigned]) {
      if (typeof id === 'string' && id.trim()) unlockedSet.add(id.trim());
    }
  }
  const unlockedCategoryIds = Array.from(unlockedSet);

  const saToken =
    preFetchedSaToken !== undefined
      ? preFetchedSaToken
      : hasServerServiceAccount()
        ? await getServerServiceAccountToken().catch(() => null)
        : null;
  const hasWarmPublic = Boolean(
    publicCatalogCache.get(FIREBASE_PROJECT_ID) &&
      publicCatalogCache.get(FIREBASE_PROJECT_ID)!.expiresAt > Date.now()
  );

  const catalogToken = !isAdmin && saToken ? saToken : caller.idToken;
  const catalog = await fetchCachedCatalog(
    catalogToken,
    Boolean(saToken) || isAdmin,
    isAdmin && !hasWarmPublic
  );

  const rawPdfs = await fetchCachedUserPdfs(
    caller.uid,
    caller.idToken,
    hasAllAccess,
    unlockedSet,
    isAdmin || saToken ? catalog.pdfs : undefined
  );

  const seenCatKeys = new Set<string>();
  const cleanCategories = catalog.cats
    .filter(c => (isAdmin ? true : c.isActive !== false))
    .sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0))
    .filter(c => {
      const slug = String(c.slug || c.id || c.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!slug || seenCatKeys.has(slug)) return false;
      seenCatKeys.add(slug);
      return true;
    });

  const tokens = tokenizeQuery(userQuestion);

  const scoredCats = cleanCategories.map(cat => {
    const catId = String(cat.id || '');
    const catName = String(cat.name || 'Course');
    const unlocked = hasAllAccess || unlockedSet.has(catId);

    const catFolders = catalog.folders
      .filter(f => String(f.categoryId || '') === catId || String(f.parentId || '') === catId)
      .sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0))
      .map(f => String(f.name || '').trim())
      .filter(Boolean);

    const catLessons = catalog.videos.filter(v => {
      const vid = String(v.id || '');
      if (!vid || UNWANTED_DEMO_VIDEO_IDS.has(vid)) return false;
      if (String(v.categoryId || '') !== catId) return false;
      return v.isPublished === true;
    });

    const catPdfs = rawPdfs.filter(p => {
      const pid = String(p.id || '');
      if (!pid || UNWANTED_DEMO_PDF_IDS.has(pid)) return false;
      if (String(p.categoryId || '') !== catId) return false;
      return isAdmin || p.isPublished === true;
    });

    const catText = `${catName} ${cat.description || ''} ${catFolders.join(' ')} ${catLessons.slice(0, 8).map(v => v.title || '').join(' ')} ${catPdfs.slice(0, 6).map(p => p.title || '').join(' ')}`;
    const relevance = scoreMatch(catText, tokens);

    return {
      cat,
      catId,
      catName,
      unlocked,
      catFolders,
      catLessons,
      catPdfs,
      relevance
    };
  });

  // Expand full lesson/PDF details only for top 3 relevant/unlocked courses to keep prompt crisp & TTFT fast
  const detailedIds = new Set(
    [...scoredCats]
      .sort((a, b) => {
        if (b.relevance !== a.relevance) return b.relevance - a.relevance;
        if (a.unlocked !== b.unlocked) return a.unlocked ? -1 : 1;
        return Number(a.cat.order ?? 0) - Number(b.cat.order ?? 0);
      })
      .slice(0, 3)
      .map(x => x.catId)
  );

  const builtCategories = scoredCats.map(item => {
    const detailed = detailedIds.has(item.catId);
    const lessons = detailed
      ? [...item.catLessons]
          .sort((a, b) => {
            const scoreDiff =
              scoreMatch(`${b.title || ''} ${b.folderName || ''}`, tokens) -
              scoreMatch(`${a.title || ''} ${a.folderName || ''}`, tokens);
            if (scoreDiff !== 0) return scoreDiff;
            return Number(a.order ?? 0) - Number(b.order ?? 0);
          })
          .slice(0, 6)
          .map(v => ({
            title: String(v.title || '').trim(),
            episode: String(v.episode || '').trim(),
            folderName: String(v.folderName || '').trim(),
            isFreePreview: v.isFreePreview === true
          }))
      : [];

    const pdfs = detailed
      ? [...item.catPdfs]
          .sort((a, b) => scoreMatch(`${b.title || ''}`, tokens) - scoreMatch(`${a.title || ''}`, tokens))
          .slice(0, 5)
          .map(p => ({
            title: String(p.title || '').trim(),
            pageCount: Number(p.pageCount || 0)
          }))
      : [];

    return {
      id: item.catId,
      name: item.catName,
      description: String(item.cat.description || '').trim().slice(0, 100),
      price: Number(item.cat.price || 299),
      unlocked: item.unlocked,
      lessonCount: item.catLessons.length,
      pdfCount: item.catPdfs.length,
      detailed,
      folders: item.catFolders.slice(0, 8),
      lessons,
      pdfs
    };
  });

  const rawName =
    (typeof userProfile?.displayName === 'string' && userProfile.displayName.trim()) ||
    caller.name ||
    'Student';
  const viewerFirstName = rawName.split(/\s+/)[0] || 'Student';

  return {
    viewerRole: isOwner ? 'owner' : isAdmin ? 'admin' : 'student',
    viewerFirstName,
    hasAllAccess,
    unlockedCategoryIds,
    allCourseNames: builtCategories.map(c => c.name),
    categories: builtCategories
  };
}

function buildSystemInstruction(kb: SkillFlixKnowledgeContext): string {
  const catalogSummary = kb.categories.length
    ? kb.categories
        .map((c, idx) => {
          const accessLabel = c.unlocked ? 'UNLOCKED' : `LOCKED ₹${c.price}`;
          if (!c.detailed) {
            return `${idx + 1}. "${c.name}" [${accessLabel}] — ${c.lessonCount} lessons${c.pdfCount ? `, ${c.pdfCount} PDFs` : ''}`;
          }
          const lessonLines = c.lessons.length
            ? c.lessons
                .map(
                  l =>
                    `  - ${l.episode ? `[${l.episode}] ` : ''}${l.title}${l.isFreePreview ? ' [FREE]' : ''}${l.folderName ? ` (${l.folderName})` : ''}`
                )
                .join('\n')
            : '  (No published lessons yet)';
          const pdfLines = c.pdfs.length
            ? c.pdfs.map(p => `  - PDF: "${p.title}" (${p.pageCount || 12}p)`).join('\n')
            : '';
          return `${idx + 1}. "${c.name}" [${accessLabel}]${c.description ? ` — ${c.description}` : ''}${
            c.folders.length ? `\n  Folders: ${c.folders.join(', ')}` : ''
          }\n  Lessons:\n${lessonLines}${pdfLines ? `\n  PDFs:\n${pdfLines}` : ''}`;
        })
        .join('\n')
    : 'No active courses listed yet.';

  return `You are **Skill-Flix AI** ("Your Personal Learning Assistant") on Skill-Flix Pro.
Reply naturally in Hindi, Hinglish, or English matching the student (${kb.viewerFirstName}, role: ${kb.viewerRole}). Use clear bullets or numbered steps.
Teach video editing (Alight Motion, CapCut, Premiere Pro, After Effects), guide beginner roadmaps & creator tips.
STRICT RULES: Never invent courses/lessons/PDFs outside this catalog, respect LOCKED courses, never expose secrets/UIDs.
CATALOG:
${catalogSummary}`;
}

function classifyUpstreamGeminiError(
  err: any,
  quota: AiQuotaSnapshot,
  knownSecrets: string[] = []
): AiServiceError {
  if (err instanceof AiServiceError) {
    return err;
  }

  const status = Number(err?.status || err?.code || 0);
  const rawMessage = sanitizeErrorMessage(String(err?.message || ''), knownSecrets);
  const upper = rawMessage.toUpperCase();

  if (status === 499) {
    return new AiServiceError(499, 'AI_CANCELLED', 'AI request was cancelled.');
  }

  if (
    err?.name === 'AbortError' ||
    err?.name === 'TimeoutError' ||
    status === 408 ||
    status === 504 ||
    upper.includes('TIMEOUT') ||
    upper.includes('TIMED OUT') ||
    upper.includes('DEADLINE_EXCEEDED') ||
    upper.includes('ABORTED')
  ) {
    return new AiServiceError(
      504,
      'AI_TIMEOUT',
      'Skill-Flix AI took too long to respond from Gemini. Please try again in a moment.',
      quota
    );
  }

  if (status === 429 || upper.includes('RESOURCE_EXHAUSTED') || upper.includes('QUOTA')) {
    return new AiServiceError(
      429,
      'UPSTREAM_QUOTA_EXHAUSTED',
      'Skill-Flix AI free-tier capacity is temporarily full right now (API quota limit reached). Please wait a minute and try again.',
      quota
    );
  }

  if (status === 404 || upper.includes('NOT_FOUND') || upper.includes('MODEL_NOT_FOUND')) {
    return new AiServiceError(
      404,
      'AI_MODEL_UNAVAILABLE',
      'Configured Gemini AI model was not found or is unavailable. Check GEMINI_AI_MODEL and GEMINI_FALLBACK_MODEL in AI Configuration.'
    );
  }

  if (status === 400 && (upper.includes('API_KEY') || upper.includes('KEY_INVALID'))) {
    return new AiServiceError(
      400,
      'AI_INVALID_API_KEY',
      'Configured GEMINI_API_KEY was rejected as invalid by Google Gemini API. Verify the key in AI Configuration.'
    );
  }

  if (status === 400) {
    return new AiServiceError(
      400,
      'AI_BAD_REQUEST',
      'Gemini API rejected the request parameters. Check your model configuration and prompt.'
    );
  }

  if (status === 401 || upper.includes('UNAUTHENTICATED')) {
    return new AiServiceError(
      401,
      'AI_PROVIDER_AUTH_FAILED',
      'Gemini API authentication failed (401). Verify your GEMINI_API_KEY.'
    );
  }

  if (status === 403 || upper.includes('PERMISSION_DENIED')) {
    return new AiServiceError(
      403,
      'AI_PERMISSION_DENIED',
      'Gemini API access was denied (403). Verify GEMINI_API_KEY permissions and API activation.'
    );
  }

  if (status === 503 || upper.includes('UNAVAILABLE')) {
    return new AiServiceError(
      503,
      'AI_PROVIDER_UNAVAILABLE',
      'Gemini AI service is temporarily unavailable. Please try again in a moment.'
    );
  }

  return new AiServiceError(
    502,
    'AI_UPSTREAM_ERROR',
    'Skill-Flix AI could not complete your request right now. Please try again in a moment.'
  );
}

function getThinkingConfig(modelName: string) {
  if (!/^gemini-(?:3|4)/i.test(modelName)) return undefined;
  return {
    thinkingLevel: /flash-lite/i.test(modelName) ? ThinkingLevel.MINIMAL : ThinkingLevel.LOW
  };
}

async function generateWithGeminiSdk(
  apiKey: string,
  primaryModel: string,
  fallbackModel: string,
  systemInstruction: string,
  history: AiTurnInput[],
  userMessage: string,
  quota: AiQuotaSnapshot,
  externalSignal?: AbortSignal
): Promise<{ text: string; model: string }> {
  const ai = getGeminiClient(apiKey);
  const contents = [
    ...history.map(turn => ({
      role: turn.role,
      parts: [{ text: turn.text }]
    })),
    {
      role: 'user' as const,
      parts: [{ text: userMessage }]
    }
  ];

  const modelsToTry = Array.from(new Set([primaryModel, fallbackModel].filter(Boolean)));
  let lastError: any = null;

  for (const modelName of modelsToTry) {
    const thinkingConfig = getThinkingConfig(modelName);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (externalSignal?.aborted) {
        throw new AiServiceError(499, 'AI_CANCELLED', 'AI request was cancelled.');
      }
      const controller = new AbortController();
      let timedOut = false;
      const onExtAbort = () => controller.abort();
      externalSignal?.addEventListener('abort', onExtAbort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, 25_000);

      try {
        const response = await ai.models.generateContent({
          model: modelName,
          contents,
          config: {
            systemInstruction,
            abortSignal: controller.signal,
            ...(thinkingConfig ? { thinkingConfig } : {})
          }
        });
        const text = (response.text || '').trim();
        if (!text) {
          throw new Error('Empty response received from Gemini model.');
        }
        return { text, model: modelName };
      } catch (err: any) {
        if (externalSignal?.aborted && !timedOut) {
          throw new AiServiceError(499, 'AI_CANCELLED', 'AI request was cancelled.');
        }
        lastError = err;
        const msgUpper = String(err?.message || '').toUpperCase();
        const status = Number(err?.status || err?.code || 0);
        const isAuthOrKeyInvalid =
          status === 401 ||
          status === 403 ||
          (status === 400 && (msgUpper.includes('API_KEY') || msgUpper.includes('KEY_INVALID')));
        const isQuotaOrModelMissing =
          status === 429 ||
          status === 404 ||
          msgUpper.includes('RESOURCE_EXHAUSTED') ||
          msgUpper.includes('QUOTA') ||
          msgUpper.includes('NOT_FOUND');
        const isTransient =
          err?.name === 'AbortError' ||
          status === 408 ||
          status === 500 ||
          status === 502 ||
          status === 503 ||
          status === 504 ||
          msgUpper.includes('UNAVAILABLE') ||
          msgUpper.includes('TIMEOUT');

        if (isAuthOrKeyInvalid) {
          throw classifyUpstreamGeminiError(err, quota, [apiKey]);
        }
        if (isQuotaOrModelMissing) {
          break;
        }
        if (isTransient && attempt === 0) {
          await new Promise(resolve => setTimeout(resolve, 250));
          continue;
        }
        break;
      } finally {
        clearTimeout(timer);
        externalSignal?.removeEventListener('abort', onExtAbort);
      }
    }
  }

  throw classifyUpstreamGeminiError(lastError, quota, [apiKey]);
}

async function streamWithGeminiSdk(
  apiKey: string,
  primaryModel: string,
  fallbackModel: string,
  systemInstruction: string,
  history: AiTurnInput[],
  userMessage: string,
  quota: AiQuotaSnapshot,
  onStartModel: (modelName: string) => void,
  onDelta: (delta: string) => void,
  externalSignal?: AbortSignal
): Promise<{ text: string; model: string }> {
  const ai = getGeminiClient(apiKey);
  const contents = [
    ...history.map(turn => ({
      role: turn.role,
      parts: [{ text: turn.text }]
    })),
    {
      role: 'user' as const,
      parts: [{ text: userMessage }]
    }
  ];

  const modelsToTry = Array.from(new Set([primaryModel, fallbackModel].filter(Boolean)));
  let lastError: any = null;

  for (const modelName of modelsToTry) {
    const thinkingConfig = getThinkingConfig(modelName);
    if (externalSignal?.aborted) {
      throw new AiServiceError(499, 'AI_CANCELLED', 'AI request was cancelled.');
    }

    const controller = new AbortController();
    let timedOut = false;
    const onExtAbort = () => controller.abort();
    externalSignal?.addEventListener('abort', onExtAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 28_000);

    let emitted = false;
    let accumulated = '';
    try {
      const responseStream = await ai.models.generateContentStream({
        model: modelName,
        contents,
        config: {
          systemInstruction,
          abortSignal: controller.signal,
          ...(thinkingConfig ? { thinkingConfig } : {})
        }
      });

      onStartModel(modelName);
      for await (const chunk of responseStream) {
        if (externalSignal?.aborted && !timedOut) {
          throw new AiServiceError(499, 'AI_CANCELLED', 'AI request was cancelled.');
        }
        const chunkText = chunk?.text || '';
        if (chunkText) {
          emitted = true;
          accumulated += chunkText;
          onDelta(chunkText);
        }
      }

      const finalText = accumulated.trim();
      if (finalText) {
        return { text: finalText, model: modelName };
      }
      lastError = new Error('Empty streaming response from Gemini model.');
    } catch (err: any) {
      if (externalSignal?.aborted && !timedOut) {
        throw new AiServiceError(499, 'AI_CANCELLED', 'AI request was cancelled.');
      }
      if (emitted && accumulated.trim()) {
        return { text: accumulated.trim(), model: modelName };
      }
      lastError = err;
      const msgUpper = String(err?.message || '').toUpperCase();
      const status = Number(err?.status || err?.code || 0);
      const isAuthOrKeyInvalid =
        status === 401 ||
        status === 403 ||
        (status === 400 && (msgUpper.includes('API_KEY') || msgUpper.includes('KEY_INVALID')));
      if (isAuthOrKeyInvalid) {
        throw classifyUpstreamGeminiError(err, quota, [apiKey]);
      }
      // Try fallback model seamlessly
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExtAbort);
    }
  }

  throw classifyUpstreamGeminiError(lastError, quota, [apiKey]);
}

async function consumeNodeSseStream(
  body: ReadableStream<Uint8Array>,
  onEventData: (dataStr: string) => void,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) {
    await body.cancel().catch(() => {});
    throw new AiServiceError(499, 'AI_CANCELLED', 'AI request was cancelled.');
  }

  const reader = body.getReader();
  const onAbort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines: string[] = [];

  try {
    while (true) {
      if (signal?.aborted) {
        throw new AiServiceError(499, 'AI_CANCELLED', 'AI request was cancelled.');
      }
      const { value, done } = await reader.read();
      if (signal?.aborted) {
        throw new AiServiceError(499, 'AI_CANCELLED', 'AI request was cancelled.');
      }
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nlIdx: number;
      while ((nlIdx = buffer.indexOf('\n')) !== -1) {
        if (signal?.aborted) {
          throw new AiServiceError(499, 'AI_CANCELLED', 'AI request was cancelled.');
        }
        const line = buffer.slice(0, nlIdx).replace(/\r$/, '');
        buffer = buffer.slice(nlIdx + 1);

        if (line === '') {
          if (dataLines.length > 0) {
            onEventData(dataLines.join('\n'));
            dataLines = [];
          }
          continue;
        }
        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
        }
      }
    }
    buffer += decoder.decode();
    if (buffer.trim().startsWith('data:')) {
      dataLines.push(buffer.trim().slice(5).trimStart());
    }
    if (dataLines.length > 0) {
      onEventData(dataLines.join('\n'));
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

async function generateWithOpenAiCompatibleProvider(
  provider: 'openrouter' | 'groq',
  apiKey: string,
  primaryModel: string,
  fallbackModel: string,
  systemInstruction: string,
  history: AiTurnInput[],
  userMessage: string,
  quota: AiQuotaSnapshot,
  externalSignal?: AbortSignal
): Promise<{ text: string; model: string }> {
  const endpoint =
    provider === 'groq'
      ? 'https://api.groq.com/openai/v1/chat/completions'
      : 'https://openrouter.ai/api/v1/chat/completions';

  if (!apiKey) {
    throw new AiServiceError(
      503,
      'AI_KEY_NOT_CONFIGURED',
      `API key for configurable provider "${provider}" is not configured in server environment.`
    );
  }

  const defaultProviderModel =
    provider === 'groq' ? 'llama-3.3-70b-versatile' : 'meta-llama/llama-3.3-70b-instruct:free';
  const configuredPrimary =
    (!primaryModel.toLowerCase().startsWith('gemini-') ? primaryModel : '') ||
    process.env.AI_MODEL?.trim() ||
    defaultProviderModel;
  const configuredFallback =
    fallbackModel && !fallbackModel.toLowerCase().startsWith('gemini-') ? fallbackModel : '';
  const modelsToTry = Array.from(new Set([configuredPrimary, configuredFallback].filter(Boolean)));

  let lastStatus = 502;
  let lastBody = '';

  for (const model of modelsToTry) {
    const res = await fetchAiWithTimeout(
      endpoint,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemInstruction },
            ...history.map(h => ({
              role: h.role === 'model' ? 'assistant' : 'user',
              content: h.text
            })),
            { role: 'user', content: userMessage }
          ]
        })
      },
      25_000,
      [apiKey],
      externalSignal
    );

    if (res.ok) {
      const json = (await res.json().catch(() => ({}))) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = (json.choices?.[0]?.message?.content || '').trim();
      if (text) return { text, model };
      lastStatus = 502;
      continue;
    }

    lastStatus = res.status;
    lastBody = sanitizeErrorMessage(await res.text().catch(() => ''), [apiKey]);
    if (res.status === 401 || res.status === 403 || res.status === 400) {
      break;
    }
  }

  if (lastStatus === 429) {
    throw new AiServiceError(
      429,
      'UPSTREAM_QUOTA_EXHAUSTED',
      'AI free-tier rate limit reached. Please wait a minute and try again.',
      quota
    );
  }
  if (lastStatus === 401) {
    throw new AiServiceError(401, 'AI_PROVIDER_AUTH_FAILED', `${provider} rejected the API key (401).`);
  }
  if (lastStatus === 403) {
    throw new AiServiceError(403, 'AI_PERMISSION_DENIED', `${provider} access was denied (403).`);
  }
  if (lastStatus === 404) {
    throw new AiServiceError(404, 'AI_MODEL_UNAVAILABLE', `${provider} model was not found (404).`);
  }
  if (lastStatus === 400) {
    throw new AiServiceError(400, 'AI_BAD_REQUEST', `${provider} rejected the request (400).`);
  }
  throw new AiServiceError(
    lastStatus === 503 ? 503 : 502,
    lastStatus === 503 ? 'AI_PROVIDER_UNAVAILABLE' : 'AI_UPSTREAM_ERROR',
    `Upstream ${provider} AI request failed (${lastStatus})${lastBody ? `: ${lastBody.slice(0, 120)}` : '.'}`
  );
}

async function streamWithOpenAiCompatibleProvider(
  provider: 'openrouter' | 'groq',
  apiKey: string,
  primaryModel: string,
  fallbackModel: string,
  systemInstruction: string,
  history: AiTurnInput[],
  userMessage: string,
  quota: AiQuotaSnapshot,
  onStartModel: (modelName: string) => void,
  onDelta: (delta: string) => void,
  externalSignal?: AbortSignal
): Promise<{ text: string; model: string }> {
  const endpoint =
    provider === 'groq'
      ? 'https://api.groq.com/openai/v1/chat/completions'
      : 'https://openrouter.ai/api/v1/chat/completions';

  if (!apiKey) {
    throw new AiServiceError(
      503,
      'AI_KEY_NOT_CONFIGURED',
      `API key for configurable provider "${provider}" is not configured in server environment.`
    );
  }

  const defaultProviderModel =
    provider === 'groq' ? 'llama-3.3-70b-versatile' : 'meta-llama/llama-3.3-70b-instruct:free';
  const configuredPrimary =
    (!primaryModel.toLowerCase().startsWith('gemini-') ? primaryModel : '') ||
    process.env.AI_MODEL?.trim() ||
    defaultProviderModel;
  const configuredFallback =
    fallbackModel && !fallbackModel.toLowerCase().startsWith('gemini-') ? fallbackModel : '';
  const modelsToTry = Array.from(new Set([configuredPrimary, configuredFallback].filter(Boolean)));

  let lastStatus = 502;
  let lastBody = '';

  for (const model of modelsToTry) {
    let emitted = false;
    let accumulated = '';
    const res = await fetchAiWithTimeout(
      endpoint,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream'
        },
        body: JSON.stringify({
          model,
          stream: true,
          messages: [
            { role: 'system', content: systemInstruction },
            ...history.map(h => ({
              role: h.role === 'model' ? 'assistant' : 'user',
              content: h.text
            })),
            { role: 'user', content: userMessage }
          ]
        })
      },
      28_000,
      [apiKey],
      externalSignal
    );

    if (!res.ok) {
      lastStatus = res.status;
      lastBody = sanitizeErrorMessage(await res.text().catch(() => ''), [apiKey]);
      if (res.status === 401 || res.status === 403 || res.status === 400) break;
      continue;
    }

    if (!res.body) {
      lastStatus = 502;
      continue;
    }

    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('application/json') && !ct.includes('event-stream')) {
      const json = (await res.json().catch(() => ({}))) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = (json.choices?.[0]?.message?.content || '').trim();
      if (text) {
        onStartModel(model);
        onDelta(text);
        return { text, model };
      }
      lastStatus = 502;
      continue;
    }

    onStartModel(model);
    await consumeNodeSseStream(
      res.body,
      rawData => {
        if (!rawData || rawData === '[DONE]') return;
        try {
          const parsed = JSON.parse(rawData) as {
            choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
          };
          const delta = parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.message?.content ?? '';
          if (delta) {
            emitted = true;
            accumulated += delta;
            onDelta(delta);
          }
        } catch {
          // ignore keepalive frame
        }
      },
      externalSignal
    );

    const finalText = accumulated.trim();
    if (finalText) return { text: finalText, model };
    if (emitted && accumulated) return { text: accumulated, model };
    lastStatus = 502;
  }

  if (lastStatus === 429) {
    throw new AiServiceError(429, 'UPSTREAM_QUOTA_EXHAUSTED', 'AI free-tier rate limit reached. Please wait a minute and try again.', quota);
  }
  if (lastStatus === 401) {
    throw new AiServiceError(401, 'AI_PROVIDER_AUTH_FAILED', `${provider} rejected the API key (401).`);
  }
  if (lastStatus === 403) {
    throw new AiServiceError(403, 'AI_PERMISSION_DENIED', `${provider} access was denied (403).`);
  }
  if (lastStatus === 404) {
    throw new AiServiceError(404, 'AI_MODEL_UNAVAILABLE', `${provider} model was not found (404).`);
  }
  if (lastStatus === 400) {
    throw new AiServiceError(400, 'AI_BAD_REQUEST', `${provider} rejected the request (400).`);
  }
  throw new AiServiceError(
    lastStatus === 503 ? 503 : 502,
    lastStatus === 503 ? 'AI_PROVIDER_UNAVAILABLE' : 'AI_UPSTREAM_ERROR',
    `Upstream ${provider} AI request failed (${lastStatus})${lastBody ? `: ${lastBody.slice(0, 120)}` : '.'}`
  );
}

function pruneHistory(rawHistory: unknown): AiTurnInput[] {
  if (!Array.isArray(rawHistory)) return [];
  const valid = rawHistory.filter(
    (item): item is AiTurnInput =>
      Boolean(item) &&
      (item.role === 'user' || item.role === 'model') &&
      typeof item.text === 'string' &&
      item.text.trim().length > 0
  );
  const sliced = valid.slice(-MAX_HISTORY_TURNS);
  return sliced.map((item, idx) => {
    const isRecent = idx >= sliced.length - 2;
    const cap = isRecent ? 1000 : 480;
    return {
      role: item.role,
      text: item.text.trim().slice(0, cap)
    };
  });
}

interface PreparedExpressChat {
  cfg: ResolvedAiRuntimeConfig;
  useGemini: boolean;
  geminiKey: string;
  altProviderKey: string;
  quota: AiQuotaSnapshot;
  kb: SkillFlixKnowledgeContext;
  systemInstruction: string;
  cleanHistory: AiTurnInput[];
  cleanMessage: string;
}

async function prepareExpressChat(
  caller: VerifiedFirebaseUser,
  body: AiChatRequestBody
): Promise<PreparedExpressChat> {
  const cleanMessage = typeof body?.message === 'string' ? body.message.trim() : '';
  if (!cleanMessage) {
    throw new AiServiceError(400, 'EMPTY_MESSAGE', 'Please enter a question for Skill-Flix AI.');
  }
  if (cleanMessage.length > MAX_MESSAGE_CHARS) {
    throw new AiServiceError(
      400,
      'MESSAGE_TOO_LONG',
      `Keep your question under ${MAX_MESSAGE_CHARS} characters.`
    );
  }

  const cleanHistory = pruneHistory(body?.history);

  // Parallelize config sync + user profile + service account token
  const [, userProfile, saToken] = await Promise.all([
    hydrateAiConfigFromFirestore(),
    fetchCachedUserProfile(caller.uid, caller.idToken),
    hasServerServiceAccount() ? getServerServiceAccountToken().catch(() => null) : Promise.resolve(null)
  ]);

  const cfg = getResolvedRuntimeAiConfig();
  const altProviderKey =
    cfg.AI_PROVIDER === 'groq'
      ? cfg.GROQ_API_KEY
      : cfg.AI_PROVIDER === 'openrouter'
        ? cfg.OPENROUTER_API_KEY
        : '';
  const useGemini = cfg.AI_PROVIDER === 'gemini';
  const geminiKey = cfg.GEMINI_API_KEY;

  if (useGemini && !geminiKey) {
    throw new AiServiceError(
      503,
      cfg.vaultDecryptError ? 'AI_VAULT_DECRYPT_FAILED' : 'AI_KEY_NOT_CONFIGURED',
      cfg.vaultDecryptError
        ? 'An encrypted GEMINI_API_KEY exists in Firestore vault, but could not be decrypted. Ensure TELEGRAM_ENCRYPTION_KEY matches or re-save the key in Admin Panel.'
        : 'Skill-Flix AI is waiting for GEMINI_API_KEY to be configured by the Platform Owner.',
      getOrUpdateQuota(caller.uid, false, cfg.AI_RATE_LIMIT_PER_MIN, cfg.AI_RATE_LIMIT_PER_DAY)
    );
  }

  if (!useGemini && !altProviderKey) {
    throw new AiServiceError(
      503,
      'AI_KEY_NOT_CONFIGURED',
      `API key for selected provider "${cfg.AI_PROVIDER}" is not configured in server secrets.`,
      getOrUpdateQuota(caller.uid, false, cfg.AI_RATE_LIMIT_PER_MIN, cfg.AI_RATE_LIMIT_PER_DAY)
    );
  }

  const quota = getOrUpdateQuota(caller.uid, true, cfg.AI_RATE_LIMIT_PER_MIN, cfg.AI_RATE_LIMIT_PER_DAY);
  const lastUserTurn = [...cleanHistory].reverse().find(h => h.role === 'user')?.text || '';
  const kb = await retrieveSkillFlixKnowledge(
    caller,
    `${cleanMessage} ${lastUserTurn.slice(0, 120)}`,
    userProfile,
    saToken
  );
  const systemInstruction = buildSystemInstruction(kb);

  return {
    cfg,
    useGemini,
    geminiKey,
    altProviderKey,
    quota,
    kb,
    systemInstruction,
    cleanHistory,
    cleanMessage
  };
}

export async function handleSkillFlixAiChat(
  caller: VerifiedFirebaseUser,
  body: AiChatRequestBody,
  externalSignal?: AbortSignal
): Promise<AiChatReply> {
  const ctx = await prepareExpressChat(caller, body);

  let result: { text: string; model: string };
  let providerLabel: string;

  if (ctx.useGemini) {
    result = await generateWithGeminiSdk(
      ctx.geminiKey,
      ctx.cfg.GEMINI_AI_MODEL,
      ctx.cfg.GEMINI_FALLBACK_MODEL,
      ctx.systemInstruction,
      ctx.cleanHistory,
      ctx.cleanMessage,
      ctx.quota,
      externalSignal
    );
    providerLabel = 'Google Gemini API (Free Tier)';
  } else {
    result = await generateWithOpenAiCompatibleProvider(
      ctx.cfg.AI_PROVIDER as 'openrouter' | 'groq',
      ctx.altProviderKey,
      ctx.cfg.GEMINI_AI_MODEL,
      ctx.cfg.GEMINI_FALLBACK_MODEL,
      ctx.systemInstruction,
      ctx.cleanHistory,
      ctx.cleanMessage,
      ctx.quota,
      externalSignal
    );
    providerLabel = ctx.cfg.AI_PROVIDER;
  }

  const lowerReply = result.text.toLowerCase();
  const referencedCourses = ctx.kb.allCourseNames.filter(name =>
    lowerReply.includes(name.toLowerCase())
  );

  return {
    reply: result.text,
    model: result.model,
    provider: providerLabel,
    freeTier: true,
    referencedCourses,
    quota: ctx.quota
  };
}

export async function handleSkillFlixAiChatStream(
  caller: VerifiedFirebaseUser,
  body: AiChatRequestBody,
  hooks: {
    onHeadersReady?: () => void;
    sendEvent: (event: string, data: unknown) => void;
  },
  externalSignal?: AbortSignal
): Promise<void> {
  const ctx = await prepareExpressChat(caller, body);
  const providerLabel = ctx.useGemini ? 'Google Gemini API (Free Tier)' : ctx.cfg.AI_PROVIDER;

  hooks.onHeadersReady?.();

  try {
    const onStartModel = (modelName: string) => {
      hooks.sendEvent('meta', {
        model: modelName,
        provider: providerLabel,
        quota: ctx.quota
      });
    };

    const onDelta = (delta: string) => {
      hooks.sendEvent('chunk', { delta });
    };

    const result = ctx.useGemini
      ? await streamWithGeminiSdk(
          ctx.geminiKey,
          ctx.cfg.GEMINI_AI_MODEL,
          ctx.cfg.GEMINI_FALLBACK_MODEL,
          ctx.systemInstruction,
          ctx.cleanHistory,
          ctx.cleanMessage,
          ctx.quota,
          onStartModel,
          onDelta,
          externalSignal
        )
      : await streamWithOpenAiCompatibleProvider(
          ctx.cfg.AI_PROVIDER as 'openrouter' | 'groq',
          ctx.altProviderKey,
          ctx.cfg.GEMINI_AI_MODEL,
          ctx.cfg.GEMINI_FALLBACK_MODEL,
          ctx.systemInstruction,
          ctx.cleanHistory,
          ctx.cleanMessage,
          ctx.quota,
          onStartModel,
          onDelta,
          externalSignal
        );

    const lowerReply = result.text.toLowerCase();
    const referencedCourses = ctx.kb.allCourseNames.filter(name =>
      lowerReply.includes(name.toLowerCase())
    );

    hooks.sendEvent('done', {
      reply: result.text,
      model: result.model,
      provider: providerLabel,
      freeTier: true,
      referencedCourses,
      quota: ctx.quota
    });
  } catch (err: any) {
    if (err instanceof AiServiceError && err.status === 499) {
      return;
    }
    const status = err instanceof AiServiceError ? err.status : 502;
    const code = err instanceof AiServiceError ? err.code : 'AI_UPSTREAM_ERROR';
    const message = sanitizeErrorMessage(
      err?.message || 'Skill-Flix AI encountered an error.',
      [ctx.geminiKey, ctx.altProviderKey]
    );
    hooks.sendEvent('error', {
      status,
      code,
      error: message,
      quota: err instanceof AiServiceError && err.quota ? err.quota : ctx.quota
    });
  }
}

export async function testAiConfigurationConnection(adminToken: string): Promise<AiConnectionTestResult> {
  await hydrateAiConfigFromFirestore(adminToken);
  const cfg = getResolvedRuntimeAiConfig();
  const startedAt = Date.now();

  const altProviderKey =
    cfg.AI_PROVIDER === 'groq'
      ? cfg.GROQ_API_KEY
      : cfg.AI_PROVIDER === 'openrouter'
        ? cfg.OPENROUTER_API_KEY
        : '';
  const useGemini = cfg.AI_PROVIDER === 'gemini';
  const dummyQuota = getOrUpdateQuota('__config_test__', false, cfg.AI_RATE_LIMIT_PER_MIN, cfg.AI_RATE_LIMIT_PER_DAY);

  if (useGemini) {
    if (!cfg.GEMINI_API_KEY) {
      return {
        success: false,
        provider: 'Google Gemini API (Free Tier)',
        model: cfg.GEMINI_AI_MODEL,
        latencyMs: Date.now() - startedAt,
        statusCode: 503,
        errorCode: cfg.vaultDecryptError ? 'AI_VAULT_DECRYPT_FAILED' : 'AI_KEY_NOT_CONFIGURED',
        message: cfg.vaultDecryptError
          ? 'Encrypted GEMINI_API_KEY exists in vault, but TELEGRAM_ENCRYPTION_KEY failed to decrypt it. Re-save the key or align TELEGRAM_ENCRYPTION_KEY.'
          : 'GEMINI_API_KEY is not configured yet.'
      };
    }

    try {
      const outcome = await generateWithGeminiSdk(
        cfg.GEMINI_API_KEY,
        cfg.GEMINI_AI_MODEL,
        cfg.GEMINI_FALLBACK_MODEL,
        'You are Skill-Flix AI. Reply concisely with "Skill-Flix AI connection verified."',
        [],
        'Ping',
        dummyQuota
      );
      return {
        success: true,
        provider: 'Google Gemini API (Free Tier)',
        model: outcome.model,
        latencyMs: Date.now() - startedAt,
        statusCode: 200,
        message: `Connected cleanly to ${outcome.model}.`,
        replyPreview: outcome.text.slice(0, 120)
      };
    } catch (err: any) {
      return {
        success: false,
        provider: 'Google Gemini API (Free Tier)',
        model: cfg.GEMINI_AI_MODEL,
        latencyMs: Date.now() - startedAt,
        statusCode: err instanceof AiServiceError ? err.status : 502,
        errorCode: err instanceof AiServiceError ? err.code : 'AI_UPSTREAM_ERROR',
        message: sanitizeErrorMessage(err?.message || 'Gemini connection test failed.', [cfg.GEMINI_API_KEY])
      };
    }
  }

  try {
    const outcome = await generateWithOpenAiCompatibleProvider(
      cfg.AI_PROVIDER as 'openrouter' | 'groq',
      altProviderKey,
      cfg.GEMINI_AI_MODEL,
      cfg.GEMINI_FALLBACK_MODEL,
      'Reply concisely with "Skill-Flix AI connection verified."',
      [],
      'Ping',
      dummyQuota
    );
    return {
      success: true,
      provider: cfg.AI_PROVIDER,
      model: outcome.model,
      latencyMs: Date.now() - startedAt,
      statusCode: 200,
      message: `Connected cleanly to ${cfg.AI_PROVIDER} (${outcome.model}).`,
      replyPreview: outcome.text.slice(0, 120)
    };
  } catch (err: any) {
    return {
      success: false,
      provider: cfg.AI_PROVIDER,
      model: process.env.AI_MODEL || cfg.GEMINI_AI_MODEL,
      latencyMs: Date.now() - startedAt,
      statusCode: err instanceof AiServiceError ? err.status : 502,
      errorCode: err instanceof AiServiceError ? err.code : 'AI_UPSTREAM_ERROR',
      message: sanitizeErrorMessage(err?.message || 'Provider connection test failed.', [altProviderKey])
    };
  }
}
