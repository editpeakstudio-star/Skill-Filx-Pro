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
        `Rate limit reached (${perMin} messages/minute). Please wait a few seconds before asking again.`
      );
    }
    if (bucket.dayCount >= perDay) {
      throw new HttpError(
        429,
        `Daily free-tier limit (${perDay} messages/day) reached. Quota resets tomorrow (UTC).`
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
  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents:runQuery`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${idToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({ structuredQuery })
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
}

export async function getWorkerAiStatus(env: WorkerEnv) {
  const cfg = await resolveWorkerAiConfig(env);
  const hasKey = Boolean(cfg.GEMINI_API_KEY);
  return {
    online: hasKey,
    provider: cfg.AI_PROVIDER === 'gemini' ? 'Google Gemini API (Free Tier)' : cfg.AI_PROVIDER,
    model: cfg.GEMINI_AI_MODEL,
    fallbackModel: cfg.GEMINI_FALLBACK_MODEL,
    freeTier: true,
    reason: hasKey ? undefined : 'GEMINI_API_KEY is not configured in Cloudflare Worker secrets or AI vault.',
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
    throw new HttpError(401, 'Please sign in to your Skill-Flix account to chat with Skill-Flix AI.');
  }

  const caller = await verifyFirebaseIdToken(idToken, env);
  const cleanMessage = typeof body.message === 'string' ? body.message.trim() : '';
  if (!cleanMessage) {
    throw new HttpError(400, 'Please enter a question for Skill-Flix AI.');
  }
  if (cleanMessage.length > MAX_MESSAGE_CHARS) {
    throw new HttpError(400, `Keep your question under ${MAX_MESSAGE_CHARS} characters.`);
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

  const cfg = await resolveWorkerAiConfig(env);
  const apiKey = cfg.GEMINI_API_KEY;
  if (!apiKey) {
    throw new HttpError(503, 'Skill-Flix AI is waiting for GEMINI_API_KEY to be configured by the Platform Owner.');
  }
  const quota = getWorkerQuota(caller.uid, cfg.AI_RATE_LIMIT_PER_MIN, cfg.AI_RATE_LIMIT_PER_DAY, true);

  const userProfile = await getFirestoreDoc(env, caller.idToken, 'users', caller.uid).catch(() => null);
  const isOwner = caller.email.toLowerCase() === PLATFORM_OWNER_EMAIL && caller.emailVerified;
  if (
    userProfile &&
    (userProfile.isSuspended === true || userProfile.accountStatus === 'suspended') &&
    !isOwner
  ) {
    throw new HttpError(403, 'Your Skill-Flix account is currently suspended.');
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

  const [rawCats, rawFolders, rawCatalog] = await Promise.all([
    isAdmin
      ? listFirestoreCollection(env, caller.idToken, 'categories').catch(() => [])
      : runWorkerFirestoreQuery(env, caller.idToken, {
          from: [{ collectionId: 'categories' }],
          where: {
            fieldFilter: { field: { fieldPath: 'isActive' }, op: 'EQUAL', value: { booleanValue: true } }
          },
          limit: 100
        }),
    listFirestoreCollection(env, caller.idToken, 'folders').catch(() => []),
    runWorkerFirestoreQuery(env, caller.idToken, {
      from: [{ collectionId: 'videoCatalog' }],
      where: {
        fieldFilter: { field: { fieldPath: 'isPublished' }, op: 'EQUAL', value: { booleanValue: true } }
      },
      limit: 250
    })
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
    });
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
        })
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

  const primary = cfg.GEMINI_AI_MODEL;
  const fallback = cfg.GEMINI_FALLBACK_MODEL;
  const modelsToTry = Array.from(new Set([primary, fallback].filter(Boolean)));

  let replyText = '';
  let usedModel = primary;
  let lastStatus = 502;

  for (const modelName of modelsToTry) {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemInstruction }] },
          contents: [
            ...cleanHistory.map(h => ({ role: h.role, parts: [{ text: h.text }] })),
            { role: 'user', parts: [{ text: cleanMessage }] }
          ]
        })
      }
    );

    if (geminiRes.ok) {
      const json = (await geminiRes.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      replyText = (json.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '').trim();
      usedModel = modelName;
      if (replyText) break;
    } else {
      lastStatus = geminiRes.status;
      if (geminiRes.status !== 429) break;
    }
  }

  if (!replyText) {
    if (lastStatus === 429) {
      throw new HttpError(429, 'Skill-Flix AI free-tier quota is temporarily full. Please wait a minute and try again.');
    }
    throw new HttpError(502, 'Skill-Flix AI could not complete your request right now.');
  }

  const lower = replyText.toLowerCase();
  const referencedCourses = courseNames.filter(name => lower.includes(name.toLowerCase()));

  return {
    reply: replyText,
    model: usedModel,
    provider: 'Google Gemini API (Free Tier)',
    freeTier: true,
    referencedCourses,
    quota
  };
}

export async function testWorkerAiConnection(env: WorkerEnv, admin: VerifiedAdmin) {
  const startedAt = Date.now();
  const cfg = await resolveWorkerAiConfig(env, admin.idToken);
  if (!cfg.GEMINI_API_KEY) {
    return {
      success: false,
      provider: 'Google Gemini API (Free Tier)',
      model: cfg.GEMINI_AI_MODEL,
      latencyMs: Date.now() - startedAt,
      message: 'GEMINI_API_KEY is not configured yet.'
    };
  }

  const modelsToTry = Array.from(new Set([cfg.GEMINI_AI_MODEL, cfg.GEMINI_FALLBACK_MODEL].filter(Boolean)));
  for (const modelName of modelsToTry) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': cfg.GEMINI_API_KEY
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Reply with: Skill-Flix AI connection verified.' }] }]
        })
      }
    );
    if (res.ok) {
      const json = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const replyPreview = (json.candidates?.[0]?.content?.parts?.[0]?.text || '').trim().slice(0, 120);
      return {
        success: true,
        provider: 'Google Gemini API (Free Tier)',
        model: modelName,
        latencyMs: Date.now() - startedAt,
        message: `Connected cleanly to ${modelName}.`,
        replyPreview
      };
    }
    if (res.status !== 429) {
      return {
        success: false,
        provider: 'Google Gemini API (Free Tier)',
        model: modelName,
        latencyMs: Date.now() - startedAt,
        message: `Gemini API returned HTTP ${res.status}.`
      };
    }
  }

  return {
    success: false,
    provider: 'Google Gemini API (Free Tier)',
    model: cfg.GEMINI_AI_MODEL,
    latencyMs: Date.now() - startedAt,
    message: 'Free-tier quota reached (429) across configured models.'
  };
}
