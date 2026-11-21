import { sanitizeError } from './crypto';
import {
  getFirestoreDoc,
  listFirestoreCollection,
  verifyFirebaseIdToken,
  type VerifiedAdmin
} from './firebase';
import { resolveWorkerAiConfig } from './aiConfig';
import { HttpError, type WorkerEnv } from './types';

const DEFAULT_PROJECT_ID = 'skillflix-academy';
const PLATFORM_OWNER_EMAIL = 'editpeakstudio@gmail.com';
const MAX_MESSAGE_CHARS = 1500;
const MAX_HISTORY_TURNS = 10;

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

interface WorkerRateBucket {
  minuteTimestamps: number[];
  dayKey: string;
  dayCount: number;
}

const workerRateBuckets = new Map<string, WorkerRateBucket>();

function getWorkerQuota(
  uid: string,
  perMinLimit: number,
  perDayLimit: number,
  consume: boolean
) {
  const perMin = Math.max(1, perMinLimit);
  const perDay = Math.max(1, perDayLimit);
  const now = Date.now();
  const cutoff = now - 60_000;
  const dayKey = new Date(now).toISOString().slice(0, 10);

  let bucket = workerRateBuckets.get(uid);
  if (!bucket) {
    bucket = { minuteTimestamps: [], dayKey, dayCount: 0 };
    workerRateBuckets.set(uid, bucket);
  }

  bucket.minuteTimestamps = bucket.minuteTimestamps.filter(t => t > cutoff);
  if (bucket.dayKey !== dayKey) {
    bucket.dayKey = dayKey;
    bucket.dayCount = 0;
  }

  const resetMinuteAt = new Date((bucket.minuteTimestamps[0] || now) + 60_000).toISOString();

  if (consume) {
    if (bucket.minuteTimestamps.length >= perMin) {
      throw new HttpError(
        429,
        `Rate limit reached (${perMin} messages/minute). Please wait a few seconds before asking again.`,
        'USER_RATE_LIMITED',
        {
          minuteLimit: perMin,
          minuteRemaining: 0,
          dailyLimit: perDay,
          dailyRemaining: Math.max(0, perDay - bucket.dayCount),
          resetMinuteAt
        }
      );
    }
    if (bucket.dayCount >= perDay) {
      throw new HttpError(
        429,
        `Daily free-tier limit (${perDay} messages/day) reached. Quota resets tomorrow (UTC).`,
        'USER_DAILY_LIMIT',
        {
          minuteLimit: perMin,
          minuteRemaining: Math.max(0, perMin - bucket.minuteTimestamps.length),
          dailyLimit: perDay,
          dailyRemaining: 0,
          resetMinuteAt
        }
      );
    }
    bucket.minuteTimestamps.push(now);
    bucket.dayCount += 1;
  }

  return {
    minuteLimit: perMin,
    minuteRemaining: Math.max(0, perMin - bucket.minuteTimestamps.length),
    dailyLimit: perDay,
    dailyRemaining: Math.max(0, perDay - bucket.dayCount),
    resetMinuteAt
  };
}

async function fetchAiWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 25_000,
  knownSecrets: string[] = []
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new HttpError(
        504,
        'Skill-Flix AI request timed out while waiting for a response. Please try again.',
        'AI_TIMEOUT'
      );
    }
    throw new HttpError(
      503,
      sanitizeError(err?.message || 'Upstream network request failed.', knownSecrets),
      'AI_NETWORK_ERROR'
    );
  } finally {
    clearTimeout(timer);
  }
}

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

async function runWorkerFirestoreQuery(
  env: WorkerEnv,
  idToken: string,
  structuredQuery: Record<string, unknown>
): Promise<Record<string, unknown>[]> {
  const projectId = (env.FIREBASE_PROJECT_ID || DEFAULT_PROJECT_ID).trim();
  const res = await fetchAiWithTimeout(
    `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents:runQuery`,
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
}

function classifyGeminiRestFailure(
  status: number,
  bodyText: string,
  quota?: ReturnType<typeof getWorkerQuota>,
  knownSecrets: string[] = []
): HttpError {
  const cleanBody = sanitizeError(bodyText, knownSecrets);
  const upper = cleanBody.toUpperCase();

  if (status === 408 || status === 504 || upper.includes('DEADLINE_EXCEEDED') || upper.includes('TIMEOUT')) {
    return new HttpError(
      504,
      'Skill-Flix AI took too long to respond from Gemini. Please try again in a moment.',
      'AI_TIMEOUT',
      quota
    );
  }
  if (status === 429 || upper.includes('RESOURCE_EXHAUSTED') || upper.includes('QUOTA')) {
    return new HttpError(
      429,
      'Skill-Flix AI free-tier capacity is temporarily full right now (API quota limit reached). Please wait a minute and try again.',
      'UPSTREAM_QUOTA_EXHAUSTED',
      quota
    );
  }
  if (status === 404 || upper.includes('NOT_FOUND')) {
    return new HttpError(
      404,
      'Configured Gemini AI model was not found or is unavailable. Check GEMINI_AI_MODEL and GEMINI_FALLBACK_MODEL in AI Configuration.',
      'AI_MODEL_UNAVAILABLE'
    );
  }
  if (status === 400 && (upper.includes('API_KEY') || upper.includes('KEY_INVALID'))) {
    return new HttpError(
      400,
      'Configured GEMINI_API_KEY was rejected as invalid by Google Gemini API. Verify the key in AI Configuration.',
      'AI_INVALID_API_KEY'
    );
  }
  if (status === 400) {
    return new HttpError(400, 'Gemini API rejected the request parameters.', 'AI_BAD_REQUEST');
  }
  if (status === 401 || upper.includes('UNAUTHENTICATED')) {
    return new HttpError(401, 'Gemini API authentication failed (401). Verify your GEMINI_API_KEY.', 'AI_PROVIDER_AUTH_FAILED');
  }
  if (status === 403 || upper.includes('PERMISSION_DENIED')) {
    return new HttpError(
      403,
      'Gemini API access was denied (403). Verify GEMINI_API_KEY permissions and API activation.',
      'AI_PERMISSION_DENIED'
    );
  }
  if (status === 503 || upper.includes('UNAVAILABLE')) {
    return new HttpError(
      503,
      'Gemini AI service is temporarily unavailable. Please try again in a moment.',
      'AI_PROVIDER_UNAVAILABLE'
    );
  }
  return new HttpError(
    502,
    'Skill-Flix AI could not complete your request right now. Please try again in a moment.',
    'AI_UPSTREAM_ERROR'
  );
}

async function generateWithWorkerGemini(
  apiKey: string,
  primaryModel: string,
  fallbackModel: string,
  systemInstruction: string,
  history: Array<{ role: 'user' | 'model'; text: string }>,
  userMessage: string,
  quota?: ReturnType<typeof getWorkerQuota>
): Promise<{ text: string; model: string }> {
  const modelsToTry = Array.from(new Set([primaryModel, fallbackModel].filter(Boolean)));
  let lastStatus = 502;
  let lastBody = '';
  let lastError: HttpError | null = null;

  for (const modelName of modelsToTry) {
    try {
      const geminiRes = await fetchAiWithTimeout(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey
          },
          body: JSON.stringify({
            ...(systemInstruction
              ? { systemInstruction: { parts: [{ text: systemInstruction }] } }
              : {}),
            contents: [
              ...history.map(h => ({ role: h.role, parts: [{ text: h.text }] })),
              { role: 'user', parts: [{ text: userMessage }] }
            ]
          })
        },
        25_000,
        [apiKey]
      );

      if (geminiRes.ok) {
        const json = (await geminiRes.json().catch(() => ({}))) as {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        };
        const text = (json.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '').trim();
        if (text) {
          return { text, model: modelName };
        }
        lastStatus = 502;
        lastBody = 'Empty response from Gemini model.';
        continue;
      }

      lastStatus = geminiRes.status;
      lastBody = await geminiRes.text().catch(() => '');
      const upper = lastBody.toUpperCase();
      const isAuthOrInvalidKey =
        lastStatus === 401 ||
        lastStatus === 403 ||
        (lastStatus === 400 && (upper.includes('API_KEY') || upper.includes('KEY_INVALID')));
      if (isAuthOrInvalidKey) {
        throw classifyGeminiRestFailure(lastStatus, lastBody, quota, [apiKey]);
      }
      // For 429 / 404 / 500 / 502 / 503 / 504 -> continue loop to try fallback model
    } catch (err: any) {
      if (err instanceof HttpError && err.status !== 504 && err.status !== 503) {
        throw err;
      }
      lastError = err instanceof HttpError ? err : null;
      lastStatus = lastError?.status || 503;
      lastBody = lastError?.message || '';
    }
  }

  if (lastError && (lastError.status === 504 || lastError.status === 503)) {
    throw lastError;
  }
  throw classifyGeminiRestFailure(lastStatus, lastBody, quota, [apiKey]);
}

async function generateWithWorkerOpenAiProvider(
  env: WorkerEnv,
  provider: 'openrouter' | 'groq',
  apiKey: string,
  primaryModel: string,
  fallbackModel: string,
  systemInstruction: string,
  history: Array<{ role: 'user' | 'model'; text: string }>,
  userMessage: string,
  quota?: ReturnType<typeof getWorkerQuota>
): Promise<{ text: string; model: string }> {
  const endpoint =
    provider === 'groq'
      ? 'https://api.groq.com/openai/v1/chat/completions'
      : 'https://openrouter.ai/api/v1/chat/completions';

  if (!apiKey) {
    throw new HttpError(
      503,
      `API key for configurable provider "${provider}" is not configured in Cloudflare Worker secrets.`,
      'AI_KEY_NOT_CONFIGURED'
    );
  }

  const defaultModel =
    provider === 'groq' ? 'llama-3.3-70b-versatile' : 'meta-llama/llama-3.3-70b-instruct:free';
  const configuredPrimary =
    (!primaryModel.toLowerCase().startsWith('gemini-') ? primaryModel : '') ||
    env.AI_MODEL?.trim() ||
    defaultModel;
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
            ...(systemInstruction ? [{ role: 'system', content: systemInstruction }] : []),
            ...history.map(h => ({ role: h.role === 'model' ? 'assistant' : 'user', content: h.text })),
            { role: 'user', content: userMessage }
          ]
        })
      },
      25_000,
      [apiKey]
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
    lastBody = sanitizeError(await res.text().catch(() => ''), [apiKey]);
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      break;
    }
  }

  if (lastStatus === 429) {
    throw new HttpError(
      429,
      'AI free-tier rate limit reached. Please wait a minute and try again.',
      'UPSTREAM_QUOTA_EXHAUSTED',
      quota
    );
  }
  if (lastStatus === 401) {
    throw new HttpError(401, `${provider} rejected the API key (401).`, 'AI_PROVIDER_AUTH_FAILED');
  }
  if (lastStatus === 403) {
    throw new HttpError(403, `${provider} access was denied (403).`, 'AI_PERMISSION_DENIED');
  }
  if (lastStatus === 404) {
    throw new HttpError(404, `${provider} model was not found (404).`, 'AI_MODEL_UNAVAILABLE');
  }
  if (lastStatus === 400) {
    throw new HttpError(400, `${provider} rejected the request (400).`, 'AI_BAD_REQUEST');
  }
  throw new HttpError(
    lastStatus === 503 ? 503 : 502,
    `Upstream ${provider} AI request failed (${lastStatus})${lastBody ? `: ${lastBody.slice(0, 120)}` : '.'}`,
    lastStatus === 503 ? 'AI_PROVIDER_UNAVAILABLE' : 'AI_UPSTREAM_ERROR'
  );
}

export async function getWorkerAiStatus(env: WorkerEnv) {
  const cfg = await resolveWorkerAiConfig(env);
  if (cfg.AI_PROVIDER === 'gemini') {
    const hasKey = Boolean(cfg.GEMINI_API_KEY);
    return {
      online: hasKey,
      provider: 'Google Gemini API (Free Tier)',
      model: cfg.GEMINI_AI_MODEL,
      fallbackModel: cfg.GEMINI_FALLBACK_MODEL,
      freeTier: true,
      reason: hasKey
        ? undefined
        : cfg.vaultDecryptError
          ? 'Encrypted GEMINI_API_KEY exists in vault, but TELEGRAM_ENCRYPTION_KEY in Cloudflare Worker failed to decrypt it.'
          : 'GEMINI_API_KEY is not configured in Cloudflare Worker secrets or AI vault.',
      limits: {
        perMinute: cfg.AI_RATE_LIMIT_PER_MIN,
        perDay: cfg.AI_RATE_LIMIT_PER_DAY
      }
    };
  }

  const altKey = cfg.AI_PROVIDER === 'groq' ? cfg.GROQ_API_KEY : cfg.OPENROUTER_API_KEY;
  return {
    online: Boolean(altKey),
    provider: cfg.AI_PROVIDER,
    model:
      (!cfg.GEMINI_AI_MODEL.toLowerCase().startsWith('gemini-') ? cfg.GEMINI_AI_MODEL : '') ||
      env.AI_MODEL ||
      (cfg.AI_PROVIDER === 'groq' ? 'llama-3.3-70b-versatile' : 'meta-llama/llama-3.3-70b-instruct:free'),
    fallbackModel: cfg.GEMINI_FALLBACK_MODEL,
    freeTier: true,
    reason: altKey ? undefined : `${cfg.AI_PROVIDER.toUpperCase()} API key is not configured in Cloudflare Worker secrets.`,
    limits: {
      perMinute: cfg.AI_RATE_LIMIT_PER_MIN,
      perDay: cfg.AI_RATE_LIMIT_PER_DAY
    }
  };
}

export async function handleWorkerAiChat(
  authHeader: string | null,
  env: WorkerEnv,
  body: { message?: unknown; history?: unknown }
) {
  const tokenMatch = (authHeader || '').match(/^Bearer\s+(.+)$/i);
  const idToken = tokenMatch ? tokenMatch[1].trim() : '';
  if (!idToken) {
    throw new HttpError(
      401,
      'Please sign in to your Skill-Flix account to chat with Skill-Flix AI.',
      'AUTH_REQUIRED'
    );
  }

  const caller = await verifyFirebaseIdToken(idToken, env);
  const cleanMessage = typeof body.message === 'string' ? body.message.trim() : '';
  if (!cleanMessage) {
    throw new HttpError(400, 'Please enter a question for Skill-Flix AI.', 'EMPTY_MESSAGE');
  }
  if (cleanMessage.length > MAX_MESSAGE_CHARS) {
    throw new HttpError(400, `Keep your question under ${MAX_MESSAGE_CHARS} characters.`, 'MESSAGE_TOO_LONG');
  }

  const cleanHistory = Array.isArray(body.history)
    ? body.history
        .filter(
          (item): item is { role: 'user' | 'model'; text: string } =>
            Boolean(item) &&
            typeof item === 'object' &&
            (item.role === 'user' || item.role === 'model') &&
            typeof item.text === 'string' &&
            item.text.trim().length > 0
        )
        .slice(-MAX_HISTORY_TURNS)
        .map(item => ({ role: item.role, text: item.text.trim().slice(0, MAX_MESSAGE_CHARS) }))
    : [];

  const userProfile = await getFirestoreDoc(env, caller.idToken, 'users', caller.uid).catch(() => null);
  const isOwner = caller.email.toLowerCase() === PLATFORM_OWNER_EMAIL && caller.emailVerified;
  if (
    userProfile &&
    (userProfile.isSuspended === true || userProfile.accountStatus === 'suspended') &&
    !isOwner
  ) {
    throw new HttpError(403, 'Your Skill-Flix account is currently suspended.', 'ACCOUNT_SUSPENDED');
  }

  const rawRole = typeof userProfile?.role === 'string' ? userProfile.role : 'user';
  const isMasterAdmin = isOwner || rawRole === 'master_admin';
  const isAdmin = isMasterAdmin || rawRole === 'admin';

  let cfg = await resolveWorkerAiConfig(env);
  if ((!cfg.firestoreVaultSynced || cfg.vaultDecryptError || !cfg.GEMINI_API_KEY) && isMasterAdmin) {
    cfg = await resolveWorkerAiConfig(env, caller.idToken, true);
  }

  const isGeminiProvider = cfg.AI_PROVIDER === 'gemini';
  const altKey = cfg.AI_PROVIDER === 'groq' ? cfg.GROQ_API_KEY : cfg.OPENROUTER_API_KEY;

  if (isGeminiProvider && !cfg.GEMINI_API_KEY) {
    throw new HttpError(
      503,
      cfg.vaultDecryptError
        ? 'An encrypted GEMINI_API_KEY exists in Firestore vault, but Cloudflare Worker could not decrypt it. Ensure TELEGRAM_ENCRYPTION_KEY matches or re-save the key.'
        : 'Skill-Flix AI is waiting for GEMINI_API_KEY to be configured by the Platform Owner.',
      cfg.vaultDecryptError ? 'AI_VAULT_DECRYPT_FAILED' : 'AI_KEY_NOT_CONFIGURED',
      getWorkerQuota(caller.uid, cfg.AI_RATE_LIMIT_PER_MIN, cfg.AI_RATE_LIMIT_PER_DAY, false)
    );
  }

  if (!isGeminiProvider && !altKey) {
    throw new HttpError(
      503,
      `API key for selected provider "${cfg.AI_PROVIDER}" is not configured in Cloudflare Worker secrets.`,
      'AI_KEY_NOT_CONFIGURED',
      getWorkerQuota(caller.uid, cfg.AI_RATE_LIMIT_PER_MIN, cfg.AI_RATE_LIMIT_PER_DAY, false)
    );
  }

  const quota = getWorkerQuota(caller.uid, cfg.AI_RATE_LIMIT_PER_MIN, cfg.AI_RATE_LIMIT_PER_DAY, true);

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

  const [rawCats, rawFolders, rawCatalog] = await Promise.all([
    isAdmin
      ? listFirestoreCollection(env, caller.idToken, 'categories').catch(() => [])
      : runWorkerFirestoreQuery(env, caller.idToken, {
          from: [{ collectionId: 'categories' }],
          where: {
            fieldFilter: { field: { fieldPath: 'isActive' }, op: 'EQUAL', value: { booleanValue: true } }
          },
          limit: 100
        }).catch(() => []),
    listFirestoreCollection(env, caller.idToken, 'folders').catch(() => []),
    runWorkerFirestoreQuery(env, caller.idToken, {
      from: [{ collectionId: 'videoCatalog' }],
      where: {
        fieldFilter: { field: { fieldPath: 'isPublished' }, op: 'EQUAL', value: { booleanValue: true } }
      },
      limit: 250
    }).catch(() => [])
  ]);

  let rawPdfs: Record<string, unknown>[] = [];
  if (isAdmin) {
    rawPdfs = await listFirestoreCollection(env, caller.idToken, 'pdfs').catch(() => []);
  } else if (hasAllAccess) {
    rawPdfs = await runWorkerFirestoreQuery(env, caller.idToken, {
      from: [{ collectionId: 'pdfs' }],
      where: {
        fieldFilter: { field: { fieldPath: 'isPublished' }, op: 'EQUAL', value: { booleanValue: true } }
      },
      limit: 200
    }).catch(() => []);
  } else if (unlockedSet.size > 0) {
    const lists = await Promise.all(
      Array.from(unlockedSet).slice(0, 20).map(catId =>
        runWorkerFirestoreQuery(env, caller.idToken, {
          from: [{ collectionId: 'pdfs' }],
          where: {
            compositeFilter: {
              op: 'AND',
              filters: [
                { fieldFilter: { field: { fieldPath: 'isPublished' }, op: 'EQUAL', value: { booleanValue: true } } },
                { fieldFilter: { field: { fieldPath: 'categoryId' }, op: 'EQUAL', value: { stringValue: catId } } }
              ]
            }
          },
          limit: 60
        }).catch(() => [])
      )
    );
    rawPdfs = lists.flat();
  }

  const seenCats = new Set<string>();
  const cleanCats = rawCats
    .filter(c => (isAdmin ? true : c.isActive !== false))
    .filter(c => {
      const key = String(c.slug || c.id || c.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!key || seenCats.has(key)) return false;
      seenCats.add(key);
      return true;
    });

  const courseNames: string[] = [];
  const catalogBlock = cleanCats
    .map((c, idx) => {
      const catId = String(c.id || '');
      const catName = String(c.name || 'Course');
      courseNames.push(catName);
      const unlocked = hasAllAccess || unlockedSet.has(catId);
      const folders = rawFolders
        .filter(f => String(f.categoryId || '') === catId || String(f.parentId || '') === catId)
        .map(f => String(f.name || '').trim())
        .filter(Boolean)
        .slice(0, 12);
      const lessons = rawCatalog
        .filter(v => !UNWANTED_DEMO_VIDEO_IDS.has(String(v.id || '')) && String(v.categoryId || '') === catId && v.isPublished === true)
        .slice(0, 14)
        .map(v => `    - ${v.episode ? `[${v.episode}] ` : ''}${v.title}${v.isFreePreview ? ' [FREE PREVIEW]' : ''}`);
      const pdfs = rawPdfs
        .filter(p => !UNWANTED_DEMO_PDF_IDS.has(String(p.id || '')) && String(p.categoryId || '') === catId)
        .slice(0, 10)
        .map(p => `    - PDF: "${p.title}" (${p.pageCount || 12} pages)`);
      return `${idx + 1}. "${catName}" [${unlocked ? 'UNLOCKED' : `LOCKED ₹${c.price || 299}`}]
  ${c.description || ''}
${folders.length ? `  Subfolders: ${folders.join(', ')}\n` : ''}  Lessons:\n${lessons.join('\n') || '    (None listed)'}
  Accessible PDFs:\n${pdfs.join('\n') || (unlocked ? '    (None yet)' : '    (Requires unlocking course)')}`;
    })
    .join('\n\n');

  const systemInstruction = `You are Skill-Flix AI ("Your Personal Learning Assistant") on Skill-Flix Pro.
Reply naturally in Hindi, Hinglish, or English matching the student's language.
Teach video editing (Alight Motion, CapCut, Premiere Pro, After Effects, PDFs, roadmaps, creator tips).
NEVER invent courses, lessons, or PDFs not listed below:

${catalogBlock || 'No active courses listed yet.'}`;

  const outcome = isGeminiProvider
    ? await generateWithWorkerGemini(
        cfg.GEMINI_API_KEY,
        cfg.GEMINI_AI_MODEL,
        cfg.GEMINI_FALLBACK_MODEL,
        systemInstruction,
        cleanHistory,
        cleanMessage,
        quota
      )
    : await generateWithWorkerOpenAiProvider(
        env,
        cfg.AI_PROVIDER as 'openrouter' | 'groq',
        altKey,
        cfg.GEMINI_AI_MODEL,
        cfg.GEMINI_FALLBACK_MODEL,
        systemInstruction,
        cleanHistory,
        cleanMessage,
        quota
      );

  const lower = outcome.text.toLowerCase();
  const referencedCourses = courseNames.filter(name => lower.includes(name.toLowerCase()));

  return {
    reply: outcome.text,
    model: outcome.model,
    provider: isGeminiProvider ? 'Google Gemini API (Free Tier)' : cfg.AI_PROVIDER,
    freeTier: true,
    referencedCourses,
    quota
  };
}

export async function testWorkerAiConnection(env: WorkerEnv, admin: VerifiedAdmin) {
  const startedAt = Date.now();
  const cfg = await resolveWorkerAiConfig(env, admin.idToken);

  if (cfg.AI_PROVIDER === 'gemini') {
    if (!cfg.GEMINI_API_KEY) {
      return {
        success: false,
        provider: 'Google Gemini API (Free Tier)',
        model: cfg.GEMINI_AI_MODEL,
        latencyMs: Date.now() - startedAt,
        statusCode: 503,
        errorCode: cfg.vaultDecryptError ? 'AI_VAULT_DECRYPT_FAILED' : 'AI_KEY_NOT_CONFIGURED',
        message: cfg.vaultDecryptError
          ? 'Encrypted GEMINI_API_KEY exists in vault, but TELEGRAM_ENCRYPTION_KEY in Cloudflare Worker failed to decrypt it.'
          : 'GEMINI_API_KEY is not configured yet.'
      };
    }

    try {
      const outcome = await generateWithWorkerGemini(
        cfg.GEMINI_API_KEY,
        cfg.GEMINI_AI_MODEL,
        cfg.GEMINI_FALLBACK_MODEL,
        'You are Skill-Flix AI. Reply concisely with "Skill-Flix AI connection verified."',
        [],
        'Ping'
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
        statusCode: err instanceof HttpError ? err.status : 502,
        errorCode: err instanceof HttpError ? err.code || 'AI_UPSTREAM_ERROR' : 'AI_UPSTREAM_ERROR',
        message: sanitizeError(err?.message || 'Gemini connection test failed.', [cfg.GEMINI_API_KEY])
      };
    }
  }

  const altKey = cfg.AI_PROVIDER === 'groq' ? cfg.GROQ_API_KEY : cfg.OPENROUTER_API_KEY;
  try {
    const outcome = await generateWithWorkerOpenAiProvider(
      env,
      cfg.AI_PROVIDER as 'openrouter' | 'groq',
      altKey,
      cfg.GEMINI_AI_MODEL,
      cfg.GEMINI_FALLBACK_MODEL,
      'Reply concisely with "Skill-Flix AI connection verified."',
      [],
      'Ping'
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
      model: env.AI_MODEL || cfg.GEMINI_AI_MODEL,
      latencyMs: Date.now() - startedAt,
      statusCode: err instanceof HttpError ? err.status : 502,
      errorCode: err instanceof HttpError ? err.code || 'AI_UPSTREAM_ERROR' : 'AI_UPSTREAM_ERROR',
      message: sanitizeError(err?.message || 'Provider connection test failed.', [altKey])
    };
  }
}
