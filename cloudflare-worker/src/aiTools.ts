import { sanitizeError } from './crypto';
import {
  getFirestoreDoc,
  getProjectId,
  listFirestoreCollection
} from './firebase';
import type { WorkerEnv } from './types';

const PLATFORM_OWNER_EMAIL = 'editpeakstudio@gmail.com';
const PLATFORM_OWNER_NAME = 'Pintu Kumar';

export const UNWANTED_DEMO_VIDEO_IDS = new Set([
  'vid_am_vectors',
  'vid_am_null_rigs',
  'vid_am_3d_camera',
  'vid_cap_velocity',
  'vid_cap_effects',
  'vid_prem_lumetri',
  'vid_ae_saber'
]);

export const UNWANTED_DEMO_PDF_IDS = new Set([
  'pdf_am_cheatsheet',
  'pdf_cap_curves'
]);

const DEFAULT_PUBLIC_SETTINGS = {
  platformName: 'Skill-Flix',
  upiId: 'editpeakstudio@ybl',
  payeeName: 'RAVI CHAUHAN',
  paymentPhone: '',
  allAccessPrice: 999,
  supportEmail: 'support@skillflix.io',
  supportPhone: '',
  supportWhatsapp: '',
  supportTelegram: 'https://t.me/skillflix_support'
};

export interface WorkerToolContext {
  env: WorkerEnv;
  caller: {
    uid: string;
    email: string;
    emailVerified: boolean;
    idToken: string;
  };
  userProfile: Record<string, unknown> | null;
  saToken: string | null;
  isOwner: boolean;
  isMasterAdmin: boolean;
  isAdmin: boolean;
  memo: Map<string, Promise<unknown>>;
  knownSecrets?: string[];
  firestoreOverrides?: {
    getDoc?: (collection: string, docId: string, token: string) => Promise<Record<string, unknown> | null>;
    listCollection?: (collection: string, token: string) => Promise<Record<string, unknown>[]>;
    runQuery?: (structuredQuery: Record<string, unknown>, token: string) => Promise<Record<string, unknown>[]>;
  };
}

export interface WorkerToolRecord {
  name: string;
  durationMs: number;
  status: 'ok' | 'error';
  data?: Record<string, unknown>;
  error?: string;
}

interface TimedCache<T> {
  value: T;
  expiresAt: number;
}

const CATALOG_TTL_MS = 20_000;
const ADMIN_DIR_TTL_MS = 30_000;

const catsCache = new Map<string, TimedCache<Record<string, unknown>[]>>();
const foldersCache = new Map<string, TimedCache<Record<string, unknown>[]>>();
const videosCache = new Map<string, TimedCache<Record<string, unknown>[]>>();
const allPdfsCache = new Map<string, TimedCache<Record<string, unknown>[]>>();
const userPdfsCache = new Map<string, TimedCache<Record<string, unknown>[]>>();
const adminDirCache = new Map<string, TimedCache<Record<string, unknown>[]>>();

function decodeFsVal(val: Record<string, any>): unknown {
  if (!val || typeof val !== 'object') return undefined;
  if ('stringValue' in val) return val.stringValue;
  if ('integerValue' in val) return Number(val.integerValue);
  if ('doubleValue' in val) return Number(val.doubleValue);
  if ('booleanValue' in val) return val.booleanValue;
  if ('nullValue' in val) return null;
  if ('timestampValue' in val) return val.timestampValue;
  if ('arrayValue' in val) {
    return Array.isArray(val.arrayValue?.values) ? val.arrayValue.values.map(decodeFsVal) : [];
  }
  if ('mapValue' in val) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val.mapValue?.fields || {})) {
      out[k] = decodeFsVal(v as Record<string, any>);
    }
    return out;
  }
  return undefined;
}

async function runFsQuery(
  ctx: WorkerToolContext,
  structuredQuery: Record<string, unknown>,
  token: string
): Promise<Record<string, unknown>[]> {
  if (ctx.firestoreOverrides?.runQuery) {
    return ctx.firestoreOverrides.runQuery(structuredQuery, token);
  }
  const projectId = getProjectId(ctx.env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(
      `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents:runQuery`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify({ structuredQuery }),
        signal: controller.signal
      }
    );
    if (!res.ok) return [];
    const rows = (await res.json()) as Array<{ document?: { name?: string; fields?: Record<string, any> } }>;
    const docs: Record<string, unknown>[] = [];
    for (const row of rows) {
      if (!row.document) continue;
      const out: Record<string, unknown> = {};
      if (row.document.name) out.id = row.document.name.split('/').pop();
      for (const [k, v] of Object.entries(row.document.fields || {})) {
        out[k] = decodeFsVal(v);
      }
      docs.push(out);
    }
    return docs;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchDoc(
  ctx: WorkerToolContext,
  collection: string,
  docId: string,
  token: string
): Promise<Record<string, unknown> | null> {
  if (ctx.firestoreOverrides?.getDoc) {
    return ctx.firestoreOverrides.getDoc(collection, docId, token);
  }
  return getFirestoreDoc(ctx.env, token, collection, docId);
}

async function listCollection(
  ctx: WorkerToolContext,
  collection: string,
  token: string
): Promise<Record<string, unknown>[]> {
  if (ctx.firestoreOverrides?.listCollection) {
    return ctx.firestoreOverrides.listCollection(collection, token);
  }
  return listFirestoreCollection(ctx.env, token, collection);
}

function memoize<T>(ctx: WorkerToolContext, key: string, loader: () => Promise<T>): Promise<T> {
  const existing = ctx.memo.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const p = loader().catch(err => {
    ctx.memo.delete(key);
    throw err;
  });
  ctx.memo.set(key, p);
  return p;
}

function computeEntitlements(profile: Record<string, unknown> | null, isAdmin: boolean) {
  const expiryRaw =
    typeof profile?.accessExpiry === 'string' && profile.accessExpiry.trim()
      ? profile.accessExpiry.trim()
      : typeof profile?.accessExpiryAt === 'string' && profile.accessExpiryAt.trim()
        ? profile.accessExpiryAt.trim()
        : null;

  const expiryMs = expiryRaw ? new Date(expiryRaw).getTime() : NaN;
  const expiredByTimestamp = Boolean(expiryRaw && !Number.isNaN(expiryMs) && expiryMs <= Date.now());
  const rawSubStatus =
    typeof profile?.subscriptionStatus === 'string' ? profile.subscriptionStatus : 'none';
  const isExpired = !isAdmin && (rawSubStatus === 'expired' || expiredByTimestamp);
  const effectiveSubStatus = isAdmin ? 'active' : isExpired ? 'expired' : rawSubStatus;

  const rawAllowed = Array.isArray(profile?.allowedCategories) ? profile.allowedCategories : [];
  const rawAssigned = Array.isArray(profile?.assignedCourses) ? profile.assignedCourses : [];
  const rawCourseIds = Array.from(
    new Set(
      [...rawAllowed, ...rawAssigned]
        .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
        .map(v => v.trim())
    )
  );

  const hasAllAccessFlag = profile?.hasAllAccess === true;
  const hasAllAccess = isAdmin || (!isExpired && hasAllAccessFlag);
  const unlockedSet = new Set<string>(!isExpired ? rawCourseIds : []);

  return {
    effectiveSubStatus,
    isExpired,
    accessExpiry: expiryRaw,
    hasAllAccess,
    hasAllAccessFlag,
    unlockedSet,
    assignedCourseIdsWhenExpired: isExpired ? rawCourseIds : []
  };
}

async function loadActiveCategories(ctx: WorkerToolContext): Promise<Record<string, unknown>[]> {
  return memoize(ctx, 'categories', async () => {
    const projectId = getProjectId(ctx.env);
    const canCache = !ctx.firestoreOverrides;
    const now = Date.now();
    const cached = canCache ? catsCache.get(projectId) : undefined;
    if (cached && cached.expiresAt > now) return cached.value;

    const token = ctx.saToken || ctx.caller.idToken;
    const rawCats =
      ctx.isAdmin || ctx.saToken
        ? await listCollection(ctx, 'categories', token).catch(() => [])
        : await runFsQuery(
            ctx,
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
          ).catch(() => []);

    const seenKeys = new Set<string>();
    const activeCats = rawCats
      .filter(c => c.isActive !== false)
      .sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0))
      .filter(c => {
        const key = String(c.slug || c.id || c.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        if (!key || seenKeys.has(key)) return false;
        seenKeys.add(key);
        return true;
      });

    if (canCache) catsCache.set(projectId, { value: activeCats, expiresAt: now + CATALOG_TTL_MS });
    return activeCats;
  });
}

async function loadFolders(ctx: WorkerToolContext): Promise<Record<string, unknown>[]> {
  return memoize(ctx, 'folders', async () => {
    const projectId = getProjectId(ctx.env);
    const canCache = !ctx.firestoreOverrides;
    const now = Date.now();
    const cached = canCache ? foldersCache.get(projectId) : undefined;
    if (cached && cached.expiresAt > now) return cached.value;

    const token = ctx.saToken || ctx.caller.idToken;
    const folders = await listCollection(ctx, 'folders', token).catch(() => []);
    if (canCache) foldersCache.set(projectId, { value: folders, expiresAt: now + CATALOG_TTL_MS });
    return folders;
  });
}

async function loadPublishedVideos(ctx: WorkerToolContext): Promise<Record<string, unknown>[]> {
  return memoize(ctx, 'videos', async () => {
    const projectId = getProjectId(ctx.env);
    const canCache = !ctx.firestoreOverrides;
    const now = Date.now();
    const cached = canCache ? videosCache.get(projectId) : undefined;
    if (cached && cached.expiresAt > now) return cached.value;

    const token = ctx.saToken || ctx.caller.idToken;
    const rows = await runFsQuery(
      ctx,
      {
        from: [{ collectionId: 'videoCatalog' }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'isPublished' },
            op: 'EQUAL',
            value: { booleanValue: true }
          }
        },
        limit: 400
      },
      token
    ).catch(() => []);

    const clean = rows.filter(v => {
      const id = String(v.id || '');
      return Boolean(id) && !UNWANTED_DEMO_VIDEO_IDS.has(id) && v.isPublished === true;
    });
    if (canCache) videosCache.set(projectId, { value: clean, expiresAt: now + CATALOG_TTL_MS });
    return clean;
  });
}

async function loadPublishedPdfs(
  ctx: WorkerToolContext,
  entitlements: ReturnType<typeof computeEntitlements>
): Promise<{ pdfs: Record<string, unknown>[]; hasGlobalPdfVisibility: boolean }> {
  return memoize(ctx, 'pdfs', async () => {
    const projectId = getProjectId(ctx.env);
    const canCache = !ctx.firestoreOverrides;
    const now = Date.now();
    const hasPrivilegedToken = Boolean(ctx.saToken) || ctx.isAdmin;

    if (hasPrivilegedToken) {
      const cached = canCache ? allPdfsCache.get(projectId) : undefined;
      if (cached && cached.expiresAt > now) {
        return { pdfs: cached.value, hasGlobalPdfVisibility: true };
      }
      const token = ctx.saToken || ctx.caller.idToken;
      const rows = await runFsQuery(
        ctx,
        {
          from: [{ collectionId: 'pdfs' }],
          where: {
            fieldFilter: {
              field: { fieldPath: 'isPublished' },
              op: 'EQUAL',
              value: { booleanValue: true }
            }
          },
          limit: 300
        },
        token
      ).catch(() => []);

      const clean = rows.filter(p => {
        const id = String(p.id || '');
        return Boolean(id) && !UNWANTED_DEMO_PDF_IDS.has(id) && p.isPublished === true;
      });
      if (canCache) allPdfsCache.set(projectId, { value: clean, expiresAt: now + CATALOG_TTL_MS });
      return { pdfs: clean, hasGlobalPdfVisibility: true };
    }

    if (!entitlements.hasAllAccess && entitlements.unlockedSet.size === 0) {
      return { pdfs: [], hasGlobalPdfVisibility: false };
    }

    const cacheKey = `${projectId}:${ctx.caller.uid}:${entitlements.hasAllAccess ? 'all' : Array.from(entitlements.unlockedSet).sort().join(',')}`;
    if (canCache) {
      const cached = userPdfsCache.get(cacheKey);
      if (cached && cached.expiresAt > now) {
        return { pdfs: cached.value, hasGlobalPdfVisibility: entitlements.hasAllAccess };
      }
    }

    let rawPdfs: Record<string, unknown>[] = [];
    if (entitlements.hasAllAccess) {
      rawPdfs = await runFsQuery(
        ctx,
        {
          from: [{ collectionId: 'pdfs' }],
          where: {
            fieldFilter: {
              field: { fieldPath: 'isPublished' },
              op: 'EQUAL',
              value: { booleanValue: true }
            }
          },
          limit: 300
        },
        ctx.caller.idToken
      ).catch(() => []);
    } else {
      const lists = await Promise.all(
        Array.from(entitlements.unlockedSet)
          .slice(0, 20)
          .map(catId =>
            runFsQuery(
              ctx,
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
                limit: 80
              },
              ctx.caller.idToken
            ).catch(() => [])
          )
      );
      rawPdfs = lists.flat();
    }

    const clean = rawPdfs.filter(p => {
      const id = String(p.id || '');
      return Boolean(id) && !UNWANTED_DEMO_PDF_IDS.has(id) && p.isPublished === true;
    });
    if (canCache) {
      if (userPdfsCache.size > 300) userPdfsCache.clear();
      userPdfsCache.set(cacheKey, { value: clean, expiresAt: now + CATALOG_TTL_MS });
    }
    return { pdfs: clean, hasGlobalPdfVisibility: entitlements.hasAllAccess };
  });
}

async function loadPublicSettings(ctx: WorkerToolContext): Promise<typeof DEFAULT_PUBLIC_SETTINGS> {
  return memoize(ctx, 'settings_general', async () => {
    const token = ctx.saToken || ctx.caller.idToken;
    const raw = await fetchDoc(ctx, 'settings', 'general', token).catch(() => null);
    if (!raw) return { ...DEFAULT_PUBLIC_SETTINGS };
    const priceNum = Number(raw.allAccessPrice);
    return {
      platformName: String(raw.platformName || DEFAULT_PUBLIC_SETTINGS.platformName).trim() || DEFAULT_PUBLIC_SETTINGS.platformName,
      upiId: String(raw.upiId || DEFAULT_PUBLIC_SETTINGS.upiId).trim(),
      payeeName: String(raw.payeeName || DEFAULT_PUBLIC_SETTINGS.payeeName).trim(),
      paymentPhone: String(raw.paymentPhone || '').trim(),
      allAccessPrice: Number.isFinite(priceNum) && priceNum > 0 ? priceNum : DEFAULT_PUBLIC_SETTINGS.allAccessPrice,
      supportEmail: String(raw.supportEmail || DEFAULT_PUBLIC_SETTINGS.supportEmail).trim(),
      supportPhone: String(raw.supportPhone || '').trim(),
      supportWhatsapp: String(raw.supportWhatsapp || '').trim(),
      supportTelegram: String(raw.supportTelegram || DEFAULT_PUBLIC_SETTINGS.supportTelegram).trim()
    };
  });
}

async function loadFreshUserProfile(ctx: WorkerToolContext): Promise<Record<string, unknown> | null> {
  return memoize(ctx, 'fresh_user_profile', async () => {
    if (ctx.userProfile !== undefined && ctx.userProfile !== null) {
      return ctx.userProfile;
    }
    return fetchDoc(ctx, 'users', ctx.caller.uid, ctx.caller.idToken).catch(() => null);
  });
}

export async function getWorkerActiveCourseNames(ctx: WorkerToolContext): Promise<string[]> {
  try {
    const cats = await loadActiveCategories(ctx);
    return cats.map(c => String(c.name || '').trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// ======================================================
// 7 WORKER SERVER-SIDE TOOLS
// ======================================================

export async function getWebsiteStats(ctx: WorkerToolContext): Promise<Record<string, unknown>> {
  const profile = await loadFreshUserProfile(ctx);
  const entitlements = computeEntitlements(profile, ctx.isAdmin);

  const [cats, folders, videos, pdfResult, settings] = await Promise.all([
    loadActiveCategories(ctx),
    loadFolders(ctx),
    loadPublishedVideos(ctx),
    loadPublishedPdfs(ctx, entitlements),
    loadPublicSettings(ctx)
  ]);

  const activeCatIds = new Set(cats.map(c => String(c.id || '')));
  const activeVideos = videos.filter(v => activeCatIds.has(String(v.categoryId || '')));

  let totalAvailablePdfs = 0;
  const categoryBreakdown = cats.map(cat => {
    const catId = String(cat.id || '');
    const catName = String(cat.name || 'Course').trim();
    const catVideos = activeVideos.filter(v => String(v.categoryId || '') === catId);
    const catFolders = folders.filter(
      f => String(f.categoryId || '') === catId || String(f.parentId || '') === catId
    );
    const queriedPdfs = pdfResult.pdfs.filter(p => String(p.categoryId || '') === catId);
    const isUnlocked = entitlements.hasAllAccess || entitlements.unlockedSet.has(catId);
    const catPdfCount =
      pdfResult.hasGlobalPdfVisibility || isUnlocked
        ? queriedPdfs.length
        : Math.max(0, Number(cat.pdfCount || 0));

    totalAvailablePdfs += catPdfCount;

    return {
      id: catId,
      name: catName,
      priceInr: Number(cat.price || 299),
      publishedVideos: catVideos.length,
      availablePdfs: catPdfCount,
      foldersCount: catFolders.length
    };
  });

  return {
    platformName: settings.platformName,
    totalPublishedVideos: activeVideos.length,
    totalAvailablePdfs,
    pdfCountAccuracy: pdfResult.hasGlobalPdfVisibility
      ? 'exact_pdfs_collection'
      : 'accessible_pdfs_plus_category_metadata',
    totalCategories: cats.length,
    totalFolders: folders.filter(f => activeCatIds.has(String(f.categoryId || ''))).length,
    allAccessPriceInr: settings.allAccessPrice,
    categories: categoryBreakdown,
    websiteFeatures: [
      'Organized Course Categories & Module Subfolders',
      'HD Video Lessons with Free Preview Episodes',
      'Downloadable Course PDF Study Notes & Guides',
      'Individual Course Packages & All-Access Pass',
      'UPI, Dynamic QR Code, PhonePe, Google Pay & Paytm Checkout',
      'Personal Student Profile & Real-Time Unlock Status',
      'Skill-Flix AI Personal Learning Assistant (Hindi, Hinglish & English)'
    ],
    retrievedAt: new Date().toISOString()
  };
}

export async function getCourseCatalog(
  ctx: WorkerToolContext,
  args: { courseQuery?: string; includeLessons?: boolean } = {}
): Promise<Record<string, unknown>> {
  const profile = await loadFreshUserProfile(ctx);
  const entitlements = computeEntitlements(profile, ctx.isAdmin);

  const [cats, folders, videos, pdfResult] = await Promise.all([
    loadActiveCategories(ctx),
    loadFolders(ctx),
    loadPublishedVideos(ctx),
    loadPublishedPdfs(ctx, entitlements)
  ]);

  const query = typeof args.courseQuery === 'string' ? args.courseQuery.trim().toLowerCase() : '';
  const includeLessons = args.includeLessons !== false;

  const matchedCats = query
    ? cats.filter(c => `${c.name || ''} ${c.description || ''} ${c.slug || ''}`.toLowerCase().includes(query))
    : cats;
  const targetCats = matchedCats.length > 0 ? matchedCats : cats;

  const courses = targetCats.map(cat => {
    const catId = String(cat.id || '');
    const catName = String(cat.name || 'Course').trim();
    const isUnlocked = entitlements.hasAllAccess || entitlements.unlockedSet.has(catId);

    const catFolders = folders
      .filter(f => String(f.categoryId || '') === catId || String(f.parentId || '') === catId)
      .sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0))
      .map(f => String(f.name || '').trim())
      .filter(Boolean);

    const catVideos = videos
      .filter(v => String(v.categoryId || '') === catId)
      .sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0));

    const queriedPdfs = pdfResult.pdfs
      .filter(p => String(p.categoryId || '') === catId)
      .sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0));

    const availablePdfsCount =
      pdfResult.hasGlobalPdfVisibility || isUnlocked
        ? queriedPdfs.length
        : Math.max(0, Number(cat.pdfCount || 0));

    const lessons = includeLessons
      ? catVideos.slice(0, 15).map(v => ({
          title: String(v.title || '').trim(),
          episode: String(v.episode || '').trim(),
          duration: String(v.duration || '').trim(),
          folderName: String(v.folderName || '').trim(),
          isFreePreview: v.isFreePreview === true
        }))
      : [];

    const unlockedPdfNotes =
      isUnlocked || ctx.isAdmin
        ? queriedPdfs.slice(0, 12).map(p => ({
            title: String(p.title || '').trim(),
            pageCount: Number(p.pageCount || 0),
            fileSize: String(p.fileSize || '').trim()
          }))
        : [];

    return {
      id: catId,
      name: catName,
      description: String(cat.description || '').trim(),
      priceInr: Number(cat.price || 299),
      isUnlockedForCaller: isUnlocked,
      folders: catFolders.slice(0, 12),
      publishedVideoCount: catVideos.length,
      availablePdfCount: availablePdfsCount,
      freePreviewCount: catVideos.filter(v => v.isFreePreview === true).length,
      ...(includeLessons ? { lessons } : {}),
      ...(unlockedPdfNotes.length > 0 ? { pdfNotes: unlockedPdfNotes } : {})
    };
  });

  return {
    filterApplied: query || null,
    matchedExact: Boolean(query && matchedCats.length > 0),
    totalCoursesReturned: courses.length,
    courses
  };
}

export async function getPackagePrices(
  ctx: WorkerToolContext,
  args: { packageQuery?: string } = {}
): Promise<Record<string, unknown>> {
  const profile = await loadFreshUserProfile(ctx);
  const entitlements = computeEntitlements(profile, ctx.isAdmin);

  const [cats, videos, pdfResult, settings] = await Promise.all([
    loadActiveCategories(ctx),
    loadPublishedVideos(ctx),
    loadPublishedPdfs(ctx, entitlements),
    loadPublicSettings(ctx)
  ]);

  const query = typeof args.packageQuery === 'string' ? args.packageQuery.trim().toLowerCase() : '';
  const activeVideos = videos.filter(v => cats.some(c => String(c.id || '') === String(v.categoryId || '')));

  const packages = cats
    .filter(c => {
      if (!query || query.includes('all')) return true;
      return `${c.name || ''} ${c.slug || ''}`.toLowerCase().includes(query);
    })
    .map(cat => {
      const catId = String(cat.id || '');
      const isUnlocked = entitlements.hasAllAccess || entitlements.unlockedSet.has(catId);
      const videoCount = activeVideos.filter(v => String(v.categoryId || '') === catId).length;
      const queriedPdfs = pdfResult.pdfs.filter(p => String(p.categoryId || '') === catId).length;
      const pdfCount =
        pdfResult.hasGlobalPdfVisibility || isUnlocked
          ? queriedPdfs
          : Math.max(0, Number(cat.pdfCount || 0));

      return {
        id: catId,
        packageName: String(cat.name || 'Course').trim(),
        priceInr: Number(cat.price || 299),
        currency: 'INR',
        videoCount,
        pdfCount,
        isUnlockedForCaller: isUnlocked
      };
    });

  return {
    currency: 'INR',
    allAccessPackage: {
      name: 'All-Access Pass',
      priceInr: settings.allAccessPrice,
      currency: 'INR',
      includesAllCourses: true,
      totalCoursesIncluded: cats.length,
      isUnlockedForCaller: entitlements.hasAllAccess
    },
    packages:
      packages.length > 0
        ? packages
        : cats.map(c => ({
            id: String(c.id || ''),
            packageName: String(c.name || 'Course').trim(),
            priceInr: Number(c.price || 299),
            currency: 'INR',
            isUnlockedForCaller: entitlements.hasAllAccess || entitlements.unlockedSet.has(String(c.id || ''))
          })),
    paymentMethods: [
      'UPI ID Payment',
      'Dynamic UPI QR Code Scan & Pay',
      'PhonePe',
      'Google Pay (GPay)',
      'Paytm',
      'Payment Proof Screenshot + 12-Digit UTR Submission'
    ]
  };
}

export async function getUserAccessStatus(ctx: WorkerToolContext): Promise<Record<string, unknown>> {
  const [profile, cats] = await Promise.all([
    loadFreshUserProfile(ctx),
    loadActiveCategories(ctx)
  ]);

  const entitlements = computeEntitlements(profile, ctx.isAdmin);
  const accountStatus =
    !ctx.isOwner && (profile?.isSuspended === true || profile?.accountStatus === 'suspended')
      ? 'suspended'
      : 'active';

  const catMap = new Map(cats.map(c => [String(c.id || ''), c]));

  const unlockedCourses = cats
    .filter(c => entitlements.hasAllAccess || entitlements.unlockedSet.has(String(c.id || '')))
    .map(c => ({ id: String(c.id || ''), name: String(c.name || '').trim() }));

  const lockedCourses = cats
    .filter(c => !entitlements.hasAllAccess && !entitlements.unlockedSet.has(String(c.id || '')))
    .map(c => ({
      id: String(c.id || ''),
      name: String(c.name || '').trim(),
      priceInr: Number(c.price || 299)
    }));

  const expiredCourseNames = entitlements.assignedCourseIdsWhenExpired
    .map(id => String(catMap.get(id)?.name || id))
    .filter(Boolean);

  const roleLabel = ctx.isOwner
    ? 'Platform Owner'
    : ctx.isMasterAdmin
      ? 'Super Admin (Master Admin)'
      : ctx.isAdmin
        ? 'Admin'
        : 'Student';

  const displayName = ctx.isOwner
    ? PLATFORM_OWNER_NAME
    : String(profile?.displayName || 'Student').trim() || 'Student';

  return {
    verifiedAccountName: displayName,
    role: roleLabel,
    accountStatus,
    subscriptionStatus: entitlements.effectiveSubStatus,
    isSubscriptionActive:
      entitlements.effectiveSubStatus === 'active' &&
      !entitlements.isExpired &&
      (entitlements.hasAllAccess || unlockedCourses.length > 0),
    isExpired: entitlements.isExpired,
    accessExpiry: entitlements.accessExpiry,
    hasAllAccess: entitlements.hasAllAccess,
    totalCoursesAccessible: unlockedCourses.length,
    totalActivePlatformCourses: cats.length,
    unlockedCourses,
    lockedCourses,
    ...(entitlements.isExpired && (entitlements.hasAllAccessFlag || expiredCourseNames.length > 0)
      ? {
          expiredPlanNotice:
            'Your previous subscription/access has expired. Please renew your package to regain access.',
          previouslyAssignedCourses: entitlements.hasAllAccessFlag ? ['All-Access Pass'] : expiredCourseNames
        }
      : {})
  };
}

export async function getUserSubscriptions(ctx: WorkerToolContext): Promise<Record<string, unknown>> {
  const [profile, cats, requests] = await Promise.all([
    loadFreshUserProfile(ctx),
    loadActiveCategories(ctx),
    memoize(ctx, 'caller_payment_requests', async () => {
      return runFsQuery(
        ctx,
        {
          from: [{ collectionId: 'paymentRequests' }],
          where: {
            fieldFilter: {
              field: { fieldPath: 'uid' },
              op: 'EQUAL',
              value: { stringValue: ctx.caller.uid }
            }
          },
          limit: 50
        },
        ctx.caller.idToken
      ).catch(() => []);
    })
  ]);

  const entitlements = computeEntitlements(profile, ctx.isAdmin);
  const catNameById = new Map(cats.map(c => [String(c.id || ''), String(c.name || '')]));

  const sortedRequests = [...requests]
    .sort((a, b) => String(b.submittedAt || '').localeCompare(String(a.submittedAt || '')))
    .map(r => {
      const rawUtr = String(r.utr || '').trim();
      const maskedUtr = rawUtr.length > 4 ? `****${rawUtr.slice(-4)}` : rawUtr || 'N/A';
      const planType = r.planType === 'all_access' ? 'all_access' : 'category';
      const packageName =
        planType === 'all_access'
          ? 'All-Access Pass'
          : String(r.categoryName || catNameById.get(String(r.categoryId || '')) || 'Course Package').trim();

      return {
        id: String(r.id || ''),
        planType,
        packageName,
        amountInr: Number(r.amount || 0),
        status: String(r.status || 'pending'),
        maskedUtr,
        submittedAt: String(r.submittedAt || ''),
        resolvedAt: typeof r.resolvedAt === 'string' ? r.resolvedAt : null,
        adminNote: typeof r.adminNote === 'string' ? r.adminNote.slice(0, 140) : null
      };
    });

  const approvedPurchases = sortedRequests.filter(r => r.status === 'approved');
  return {
    subscriptionStatus: entitlements.effectiveSubStatus,
    isExpired: entitlements.isExpired,
    accessExpiry: entitlements.accessExpiry,
    hasAllAccess: entitlements.hasAllAccess,
    totalPaymentRequests: sortedRequests.length,
    approvedCount: approvedPurchases.length,
    pendingCount: sortedRequests.filter(r => r.status === 'pending').length,
    rejectedCount: sortedRequests.filter(r => r.status === 'rejected').length,
    purchasedPackages: Array.from(new Set(approvedPurchases.map(p => p.packageName))),
    recentTransactions: sortedRequests.slice(0, 10)
  };
}

export async function getPublicSupportInfo(ctx: WorkerToolContext): Promise<Record<string, unknown>> {
  const settings = await loadPublicSettings(ctx);
  return {
    platformName: settings.platformName,
    publicSupportChannels: {
      platformName: settings.platformName,
      supportEmail: settings.supportEmail || null,
      supportTelegram: settings.supportTelegram || null,
      supportWhatsapp: settings.supportWhatsapp || null,
      supportPhone: settings.supportPhone || null,
      paymentHelpPhone: settings.paymentPhone || null
    },
    paymentCheckoutInfo: {
      upiId: settings.upiId || null,
      payeeName: settings.payeeName || null,
      supportedApps: ['UPI ID', 'UPI QR Code', 'PhonePe', 'Google Pay', 'Paytm'],
      verificationFlow: 'Pay via UPI/QR or app -> Upload payment screenshot & enter UTR -> Verification updates your account.'
    }
  };
}

function derivePublicStaffName(userDoc: Record<string, unknown>, isOwnerRow: boolean): string {
  const raw = String(userDoc.displayName || '').trim();
  if (isOwnerRow) {
    if (!raw || /^(student|platform owner|owner|editpeakstudio)$/i.test(raw)) {
      return PLATFORM_OWNER_NAME;
    }
    return raw;
  }
  if (raw && !raw.includes('@') && raw.toLowerCase() !== 'student') {
    return raw;
  }
  const title = String(userDoc.assignedRoleTitle || '').trim();
  if (title) return title;
  return userDoc.role === 'master_admin' ? 'Skill-Flix Super Admin' : 'Skill-Flix Admin';
}

export async function getPublicAdminDirectory(ctx: WorkerToolContext): Promise<Record<string, unknown>> {
  const canReadUsers = Boolean(ctx.saToken) || ctx.isAdmin;
  const projectId = getProjectId(ctx.env);
  let staffDocs: Record<string, unknown>[] = [];

  if (canReadUsers) {
    const canCache = !ctx.firestoreOverrides;
    const now = Date.now();
    const cached = canCache ? adminDirCache.get(projectId) : undefined;
    if (cached && cached.expiresAt > now) {
      staffDocs = cached.value;
    } else {
      const token = ctx.saToken || ctx.caller.idToken;
      staffDocs = await runFsQuery(
        ctx,
        {
          from: [{ collectionId: 'users' }],
          where: {
            fieldFilter: {
              field: { fieldPath: 'role' },
              op: 'IN',
              value: {
                arrayValue: {
                  values: [{ stringValue: 'master_admin' }, { stringValue: 'admin' }]
                }
              }
            }
          },
          limit: 50
        },
        token
      ).catch(async () => {
        if (!ctx.isAdmin && !ctx.saToken) return [];
        const all = await listCollection(ctx, 'users', token).catch(() => []);
        return all.filter(u => u.role === 'master_admin' || u.role === 'admin' || u.isPlatformOwner === true);
      });

      if (canCache && staffDocs.length > 0) {
        adminDirCache.set(projectId, { value: staffDocs, expiresAt: now + ADMIN_DIR_TTL_MS });
      }
    }
  }

  let ownerEntry = {
    name: PLATFORM_OWNER_NAME,
    roleTier: 'owner',
    roleLabel: 'Platform Owner',
    title: 'Founder & Platform Owner'
  };

  const superAdmins: Array<{ name: string; roleTier: string; roleLabel: string; title: string }> = [];
  const admins: Array<{ name: string; roleTier: string; roleLabel: string; title: string }> = [];

  for (const doc of staffDocs) {
    const email = String(doc.email || '').trim().toLowerCase();
    const isOwnerRow = doc.isPlatformOwner === true || email === PLATFORM_OWNER_EMAIL;
    const isSuspended = !isOwnerRow && (doc.isSuspended === true || doc.accountStatus === 'suspended');
    if (isSuspended) continue;

    if (isOwnerRow) {
      ownerEntry = {
        name: derivePublicStaffName(doc, true),
        roleTier: 'owner',
        roleLabel: 'Platform Owner',
        title: 'Founder & Platform Owner'
      };
      continue;
    }

    if (doc.role === 'master_admin') {
      superAdmins.push({
        name: derivePublicStaffName(doc, false),
        roleTier: 'super_admin',
        roleLabel: 'Super Admin',
        title: String(doc.assignedRoleTitle || 'Super Admin (Master Admin)').trim()
      });
    } else if (doc.role === 'admin') {
      admins.push({
        name: derivePublicStaffName(doc, false),
        roleTier: 'admin',
        roleLabel: 'Admin',
        title: String(doc.assignedRoleTitle || doc.predefinedRole || 'Platform Admin').trim()
      });
    }
  }

  return {
    owner: ownerEntry,
    superAdmins,
    admins,
    counts: {
      owner: 1,
      superAdmins: superAdmins.length,
      admins: admins.length
    },
    directorySyncedFromDatabase: canReadUsers && staffDocs.length > 0,
    roleHierarchy: {
      owner:
        'Top-level Founder & Platform Owner (Pintu Kumar). Holds supreme, permanent authority over the platform, Super Admins, Admins, API Secrets/AI Configuration, Analytics, Billing, Courses, and Students; cannot be modified or suspended.',
      superAdmin:
        'Appointed by the Owner (role: master_admin). Full operational access across courses, videos, PDFs, student access, payment verification, analytics, and AI Configuration, but cannot modify or demote the Owner or fellow Super Admins.',
      admin:
        'Delegated staff (role: admin) with specific assigned permissions (e.g. payment verification, student access management, course/video/PDF management). Cannot access Owner/Super-Admin API secrets or modify Super Admins.'
    }
  };
}

// ======================================================
// GEMINI REST FUNCTION DECLARATIONS & SAFE DISPATCHER
// ======================================================

export const WORKER_TOOL_DECLARATIONS = [
  {
    name: 'getWebsiteStats',
    description:
      'Get real-time Skill-Flix website statistics including total published videos, total available PDFs, total active categories, folders, All-Access price, per-category counts, and website features.'
  },
  {
    name: 'getCourseCatalog',
    description:
      'Get real-time Skill-Flix courses, subfolders, lesson titles (never video links), and unlocked PDF study notes.',
    parameters: {
      type: 'OBJECT',
      properties: {
        courseQuery: {
          type: 'STRING',
          description: 'Optional course/software filter such as Alight Motion, CapCut, Premiere Pro, After Effects.'
        },
        includeLessons: {
          type: 'BOOLEAN',
          description: 'Whether to include lesson lists (default true).'
        }
      }
    }
  },
  {
    name: 'getPackagePrices',
    description:
      'Get live Skill-Flix course package prices, All-Access Pass price, payment methods (UPI, QR, PhonePe, Google Pay, Paytm), and caller unlock state.',
    parameters: {
      type: 'OBJECT',
      properties: {
        packageQuery: {
          type: 'STRING',
          description: 'Optional package name or "all".'
        }
      }
    }
  },
  {
    name: 'getUserAccessStatus',
    description:
      'Get the authenticated student\'s OWN live course unlock status, accessible courses count, subscription status (active/expired/none), and expiry date. Always uses authenticated UID.'
  },
  {
    name: 'getUserSubscriptions',
    description:
      'Get the authenticated student\'s OWN payment requests, purchased packages history, and current subscription expiry state. Always uses authenticated UID.'
  },
  {
    name: 'getPublicSupportInfo',
    description:
      'Get Skill-Flix official public support channels (support email, Telegram, WhatsApp, support phone if configured) and payment checkout info.'
  },
  {
    name: 'getPublicAdminDirectory',
    description:
      'Get the public non-sensitive Skill-Flix leadership directory (Platform Owner Pintu Kumar, active Super Admins, active Admins) and role hierarchy.'
  }
];

function sanitizeArgsForLog(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== 'object') return {};
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (/uid|email|token|key|password|secret|phone/i.test(k)) continue;
    if (typeof v === 'string') clean[k] = v.slice(0, 60);
    else if (typeof v === 'number' || typeof v === 'boolean') clean[k] = v;
  }
  return clean;
}

function summarizeResult(name: string, data: Record<string, unknown>): string {
  switch (name) {
    case 'getWebsiteStats':
      return `videos=${data.totalPublishedVideos ?? '?'}, pdfs=${data.totalAvailablePdfs ?? '?'}, cats=${data.totalCategories ?? '?'}`;
    case 'getCourseCatalog':
      return `courses=${data.totalCoursesReturned ?? '?'}`;
    case 'getPackagePrices':
      return `packages=${Array.isArray(data.packages) ? data.packages.length : '?'}`;
    case 'getUserAccessStatus':
      return `sub=${data.subscriptionStatus ?? '?'}, expired=${data.isExpired ?? false}, unlocked=${data.totalCoursesAccessible ?? 0}`;
    case 'getUserSubscriptions':
      return `tx=${data.totalPaymentRequests ?? 0}, approved=${data.approvedCount ?? 0}`;
    case 'getPublicSupportInfo':
      return 'public_support_loaded';
    case 'getPublicAdminDirectory':
      return `synced=${data.directorySyncedFromDatabase ?? false}`;
    default:
      return 'ok';
  }
}

export async function runWorkerSkillFlixTool(
  name: string,
  rawArgs: unknown,
  ctx: WorkerToolContext
): Promise<WorkerToolRecord> {
  const startedAt = Date.now();
  const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>;
  const callerRole = ctx.isOwner
    ? 'owner'
    : ctx.isMasterAdmin
      ? 'super_admin'
      : ctx.isAdmin
        ? 'admin'
        : 'student';

  try {
    let data: Record<string, unknown>;
    switch (name) {
      case 'getWebsiteStats':
        data = await getWebsiteStats(ctx);
        break;
      case 'getCourseCatalog':
        data = await getCourseCatalog(ctx, {
          courseQuery: typeof args.courseQuery === 'string' ? args.courseQuery : undefined,
          includeLessons: typeof args.includeLessons === 'boolean' ? args.includeLessons : true
        });
        break;
      case 'getPackagePrices':
        data = await getPackagePrices(ctx, {
          packageQuery: typeof args.packageQuery === 'string' ? args.packageQuery : undefined
        });
        break;
      case 'getUserAccessStatus':
        data = await getUserAccessStatus(ctx);
        break;
      case 'getUserSubscriptions':
        data = await getUserSubscriptions(ctx);
        break;
      case 'getPublicSupportInfo':
        data = await getPublicSupportInfo(ctx);
        break;
      case 'getPublicAdminDirectory':
        data = await getPublicAdminDirectory(ctx);
        break;
      default:
        throw new Error(`Unknown Skill-Flix tool requested: ${name}`);
    }

    const durationMs = Date.now() - startedAt;
    console.info(
      JSON.stringify({
        tag: '[AI_TOOL_CALL]',
        tool: name,
        callerRole,
        durationMs,
        status: 'ok',
        args: sanitizeArgsForLog(args),
        summary: summarizeResult(name, data)
      })
    );
    return { name, durationMs, status: 'ok', data };
  } catch (err: any) {
    const durationMs = Date.now() - startedAt;
    const safeErr = sanitizeError(String(err?.message || 'Tool failed'), ctx.knownSecrets || []);
    console.warn(
      JSON.stringify({
        tag: '[AI_TOOL_CALL]',
        tool: name,
        callerRole,
        durationMs,
        status: 'error',
        args: sanitizeArgsForLog(args),
        summary: safeErr.slice(0, 100)
      })
    );
    return { name, durationMs, status: 'error', error: safeErr };
  }
}

export async function routeAndExecuteWorkerTools(
  userMessage: string,
  history: Array<{ role: 'user' | 'model'; text: string }>,
  ctx: WorkerToolContext
): Promise<Record<string, Record<string, unknown>>> {
  const recentUser = history
    .filter(h => h.role === 'user')
    .slice(-1)
    .map(h => h.text)
    .join(' ');
  const combined = `${userMessage} ${recentUser}`.toLowerCase();

  const wantsStats =
    /\b(video|videos|pdf|pdfs|category|categories|kitne|kitni|total|count|how many|feature|features|website|site)\b/i.test(combined);
  const wantsCatalog =
    /\b(course|courses|package|syllabus|lesson|lessons|episode|kya milega|kya hai|alight|capcut|premiere|after effects|content|module|folder)\b/i.test(combined);
  const wantsPrice =
    /\b(price|prices|cost|kitna|kitni|kitne ka|rate|fee|all.?access|pass|upi|paytm|phonepe|gpay|google pay|payment|buy|khareed)\b/i.test(combined);
  const wantsAccount =
    /\b(my|mera|meri|mere|mujhe|unlock|unlocked|access|expire|expiry|valid|subscription|active|status|account|kitne courses)\b/i.test(combined);
  const wantsSubscriptions =
    /\b(purchase|purchased|bought|order|transaction|utr|payment|khareeda|liya|history|receipt|subscription)\b/i.test(combined);
  const wantsSupport =
    /\b(support|contact|help|telegram|whatsapp|email|phone|number|complaint|issue|care)\b/i.test(combined);
  const wantsAdminDir =
    /\b(owner|malik|founder|pintu|admin|admins|super.?admin|master.?admin|management|team|difference|fark|antar|kaun)\b/i.test(combined);

  const calls: Array<{ name: string; args?: Record<string, unknown> }> = [];
  if (wantsStats) calls.push({ name: 'getWebsiteStats' });
  if (wantsCatalog) calls.push({ name: 'getCourseCatalog', args: { includeLessons: true } });
  if (wantsPrice) calls.push({ name: 'getPackagePrices' });
  if (wantsAccount) calls.push({ name: 'getUserAccessStatus' });
  if (wantsSubscriptions) calls.push({ name: 'getUserSubscriptions' });
  if (wantsSupport) calls.push({ name: 'getPublicSupportInfo' });
  if (wantsAdminDir) calls.push({ name: 'getPublicAdminDirectory' });

  if (calls.length === 0) {
    calls.push({ name: 'getWebsiteStats' }, { name: 'getUserAccessStatus' });
  }

  const results = await Promise.all(calls.map(c => runWorkerSkillFlixTool(c.name, c.args || {}, ctx)));
  const out: Record<string, Record<string, unknown>> = {};
  for (const r of results) {
    out[r.name] = r.status === 'ok' && r.data ? r.data : { error: r.error || 'Unavailable' };
  }
  return out;
}
