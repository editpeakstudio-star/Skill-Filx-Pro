import { sanitizeError } from './crypto';
import {
  getFirestoreAuthToken,
  getFirestoreDoc,
  hasServiceAccountConfig,
  listFirestoreCollection,
  verifyFirebaseIdToken
} from './firebase';
import { resolveWorkerAiConfig, type WorkerResolvedAiConfig } from './aiConfig';
import { HttpError, type WorkerEnv } from './types';

const DEFAULT_PROJECT_ID = 'skillflix-academy';
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

interface WorkerRateBucket {
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

const workerRateBuckets = new Map<string, WorkerRateBucket>();
const userProfileCache = new Map<string, UserProfileCacheEntry>();
const publicCatalogCache = new Map<string, CatalogCacheEntry>();
const adminCatalogCache = new Map<string, CatalogCacheEntry>();
const userPdfCache = new Map<string, UserPdfCacheEntry>();

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
  knownSecrets: string[] = [],
  externalSignal?: AbortSignal
): Promise<Response> {
  if (externalSignal?.aborted) {
    throw new HttpError(499, 'AI request was cancelled.', 'AI_CANCELLED');
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
      throw new HttpError(499, 'AI request was cancelled.', 'AI_CANCELLED');
    }
    if (timedOut || err?.name === 'AbortError') {
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
    externalSignal?.removeEventListener('abort', onExternalAbort);
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

  if (status === 499) {
    return new HttpError(499, 'AI request was cancelled.', 'AI_CANCELLED');
  }
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

function buildGeminiPayload(
  modelName: string,
  systemInstruction: string,
  history: Array<{ role: 'user' | 'model'; text: string }>,
  userMessage: string
) {
  const supportsThinkingLevel = /^gemini-(?:3|4)/i.test(modelName);
  const isFlashLite = /flash-lite/i.test(modelName);

  return {
    ...(systemInstruction
      ? { systemInstruction: { parts: [{ text: systemInstruction }] } }
      : {}),
    contents: [
      ...history.map(h => ({ role: h.role, parts: [{ text: h.text }] })),
      { role: 'user', parts: [{ text: userMessage }] }
    ],
    ...(supportsThinkingLevel
      ? {
          generationConfig: {
            thinkingConfig: {
              thinkingLevel: isFlashLite ? 'MINIMAL' : 'LOW'
            }
          }
        }
      : {})
  };
}

async function generateWithWorkerGemini(
  apiKey: string,
  primaryModel: string,
  fallbackModel: string,
  systemInstruction: string,
  history: Array<{ role: 'user' | 'model'; text: string }>,
  userMessage: string,
  quota?: ReturnType<typeof getWorkerQuota>,
  signal?: AbortSignal
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
          body: JSON.stringify(buildGeminiPayload(modelName, systemInstruction, history, userMessage))
        },
        25_000,
        [apiKey],
        signal
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
    } catch (err: any) {
      if (err instanceof HttpError && err.status === 499) throw err;
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
  quota?: ReturnType<typeof getWorkerQuota>,
  signal?: AbortSignal
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
      [apiKey],
      signal
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

async function consumeSseLines(
  stream: ReadableStream<Uint8Array>,
  onEventData: (dataStr: string) => void,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) {
    await stream.cancel().catch(() => {});
    throw new HttpError(499, 'AI request was cancelled.', 'AI_CANCELLED');
  }

  const reader = stream.getReader();
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
        throw new HttpError(499, 'AI request was cancelled.', 'AI_CANCELLED');
      }
      const { value, done } = await reader.read();
      if (signal?.aborted) {
        throw new HttpError(499, 'AI request was cancelled.', 'AI_CANCELLED');
      }
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nlIdx: number;
      while ((nlIdx = buffer.indexOf('\n')) !== -1) {
        if (signal?.aborted) {
          throw new HttpError(499, 'AI request was cancelled.', 'AI_CANCELLED');
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

async function streamWithWorkerGemini(
  apiKey: string,
  primaryModel: string,
  fallbackModel: string,
  systemInstruction: string,
  history: Array<{ role: 'user' | 'model'; text: string }>,
  userMessage: string,
  quota: ReturnType<typeof getWorkerQuota>,
  onStartModel: (modelName: string) => void,
  onDelta: (delta: string) => void,
  signal?: AbortSignal
): Promise<{ text: string; model: string }> {
  const modelsToTry = Array.from(new Set([primaryModel, fallbackModel].filter(Boolean)));
  let lastStatus = 502;
  let lastBody = '';
  let lastError: HttpError | null = null;

  for (const modelName of modelsToTry) {
    let emittedForModel = false;
    let accumulated = '';
    try {
      const res = await fetchAiWithTimeout(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:streamGenerateContent?alt=sse`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            'x-goog-api-key': apiKey
          },
          body: JSON.stringify(buildGeminiPayload(modelName, systemInstruction, history, userMessage))
        },
        28_000,
        [apiKey],
        signal
      );

      if (!res.ok) {
        lastStatus = res.status;
        lastBody = await res.text().catch(() => '');
        const upper = lastBody.toUpperCase();
        const isAuthOrInvalidKey =
          lastStatus === 401 ||
          lastStatus === 403 ||
          (lastStatus === 400 && (upper.includes('API_KEY') || upper.includes('KEY_INVALID')));
        if (isAuthOrInvalidKey) {
          throw classifyGeminiRestFailure(lastStatus, lastBody, quota, [apiKey]);
        }
        continue;
      }

      if (!res.body) {
        lastStatus = 502;
        lastBody = 'Missing response body stream.';
        continue;
      }

      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      if (contentType.includes('application/json') && !contentType.includes('event-stream')) {
        const json = (await res.json().catch(() => ({}))) as {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        };
        const text = (json.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '').trim();
        if (text) {
          onStartModel(modelName);
          onDelta(text);
          return { text, model: modelName };
        }
        lastStatus = 502;
        continue;
      }

      onStartModel(modelName);
      await consumeSseLines(
        res.body,
        rawData => {
          if (!rawData || rawData === '[DONE]') return;
          try {
            const parsed = JSON.parse(rawData) as {
              candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
            };
            const chunkText = parsed.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
            if (chunkText) {
              emittedForModel = true;
              accumulated += chunkText;
              onDelta(chunkText);
            }
          } catch {
            // Ignore malformed keepalive SSE chunk
          }
        },
        signal
      );

      const finalText = accumulated.trim();
      if (finalText) {
        return { text: finalText, model: modelName };
      }
      lastStatus = 502;
      lastBody = 'Empty streaming response from Gemini.';
    } catch (err: any) {
      if (err instanceof HttpError && err.status === 499) throw err;
      if (emittedForModel) {
        const cleanPartial = accumulated.trim();
        if (cleanPartial) return { text: cleanPartial, model: modelName };
      }
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

async function streamWithWorkerOpenAiProvider(
  env: WorkerEnv,
  provider: 'openrouter' | 'groq',
  apiKey: string,
  primaryModel: string,
  fallbackModel: string,
  systemInstruction: string,
  history: Array<{ role: 'user' | 'model'; text: string }>,
  userMessage: string,
  quota: ReturnType<typeof getWorkerQuota>,
  onStartModel: (modelName: string) => void,
  onDelta: (delta: string) => void,
  signal?: AbortSignal
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
            ...(systemInstruction ? [{ role: 'system', content: systemInstruction }] : []),
            ...history.map(h => ({ role: h.role === 'model' ? 'assistant' : 'user', content: h.text })),
            { role: 'user', content: userMessage }
          ]
        })
      },
      28_000,
      [apiKey],
      signal
    );

    if (!res.ok) {
      lastStatus = res.status;
      lastBody = sanitizeError(await res.text().catch(() => ''), [apiKey]);
      if (res.status === 400 || res.status === 401 || res.status === 403) break;
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
    await consumeSseLines(
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
      signal
    );

    const finalText = accumulated.trim();
    if (finalText) return { text: finalText, model };
    if (emitted && accumulated) return { text: accumulated, model };
    lastStatus = 502;
  }

  if (lastStatus === 429) {
    throw new HttpError(429, 'AI free-tier rate limit reached. Please wait a minute and try again.', 'UPSTREAM_QUOTA_EXHAUSTED', quota);
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

function tokenizeQuery(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\u0900-\u097f]+/gi, ' ')
    .split(/\s+/)
    .map(t => t.trim())
    .filter(t => t.length >= 2);
}

function scoreTextMatch(haystack: string, tokens: string[]): number {
  if (!tokens.length) return 0;
  const lower = haystack.toLowerCase();
  let score = 0;
  for (const tok of tokens) {
    if (lower.includes(tok)) score += 1;
  }
  return score;
}

function pruneHistory(rawHistory: unknown): Array<{ role: 'user' | 'model'; text: string }> {
  if (!Array.isArray(rawHistory)) return [];
  const valid = rawHistory.filter(
    (item): item is { role: 'user' | 'model'; text: string } =>
      Boolean(item) &&
      typeof item === 'object' &&
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

async function fetchCachedUserProfile(env: WorkerEnv, uid: string, idToken: string): Promise<Record<string, unknown> | null> {
  const projectId = (env.FIREBASE_PROJECT_ID || DEFAULT_PROJECT_ID).trim();
  const key = `${projectId}:${uid}`;
  const now = Date.now();
  const cached = userProfileCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.profile;
  }

  const profile = await getFirestoreDoc(env, idToken, 'users', uid).catch(() => null);
  if (userProfileCache.size > 300) userProfileCache.clear();
  userProfileCache.set(key, { profile, expiresAt: now + 15_000 });
  return profile;
}

async function fetchPublicCatalog(
  env: WorkerEnv,
  token: string,
  includePdfs: boolean,
  isAdmin: boolean
): Promise<CatalogCacheEntry> {
  const projectId = (env.FIREBASE_PROJECT_ID || DEFAULT_PROJECT_ID).trim();
  const now = Date.now();
  const cacheMap = isAdmin ? adminCatalogCache : publicCatalogCache;
  const cached = cacheMap.get(projectId);
  if (cached && cached.expiresAt > now && (!includePdfs || cached.pdfs !== undefined)) {
    return cached;
  }

  const [cats, folders, videos, pdfs] = await Promise.all([
    isAdmin
      ? listFirestoreCollection(env, token, 'categories').catch(() => [])
      : runWorkerFirestoreQuery(env, token, {
          from: [{ collectionId: 'categories' }],
          where: { fieldFilter: { field: { fieldPath: 'isActive' }, op: 'EQUAL', value: { booleanValue: true } } },
          limit: 100
        }).catch(() => []),
    listFirestoreCollection(env, token, 'folders').catch(() => []),
    runWorkerFirestoreQuery(env, token, {
      from: [{ collectionId: 'videoCatalog' }],
      where: { fieldFilter: { field: { fieldPath: 'isPublished' }, op: 'EQUAL', value: { booleanValue: true } } },
      limit: 250
    }).catch(() => []),
    includePdfs
      ? (isAdmin
          ? listFirestoreCollection(env, token, 'pdfs').catch(() => [])
          : runWorkerFirestoreQuery(env, token, {
              from: [{ collectionId: 'pdfs' }],
              where: { fieldFilter: { field: { fieldPath: 'isPublished' }, op: 'EQUAL', value: { booleanValue: true } } },
              limit: 200
            }).catch(() => []))
      : Promise.resolve(undefined)
  ]);

  const entry: CatalogCacheEntry = {
    cats,
    folders,
    videos,
    pdfs,
    expiresAt: now + 60_000
  };
  cacheMap.set(projectId, entry);
  return entry;
}

async function fetchUserPdfsCached(
  env: WorkerEnv,
  uid: string,
  idToken: string,
  hasAllAccess: boolean,
  unlockedSet: Set<string>,
  sharedPdfs?: Record<string, unknown>[]
): Promise<Record<string, unknown>[]> {
  // When fetched via Service Account, strictly enforce per-student category access in memory
  if (sharedPdfs) {
    if (hasAllAccess) return sharedPdfs;
    if (unlockedSet.size === 0) return [];
    return sharedPdfs.filter(p => unlockedSet.has(String(p.categoryId || '')));
  }

  if (!hasAllAccess && unlockedSet.size === 0) return [];

  const sortedIds = Array.from(unlockedSet).sort().join(',');
  const key = `${uid}:${hasAllAccess ? '1' : '0'}:${sortedIds}`;
  const now = Date.now();
  const cached = userPdfCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.pdfs;
  }

  let rawPdfs: Record<string, unknown>[] = [];
  if (hasAllAccess) {
    rawPdfs = await runWorkerFirestoreQuery(env, idToken, {
      from: [{ collectionId: 'pdfs' }],
      where: { fieldFilter: { field: { fieldPath: 'isPublished' }, op: 'EQUAL', value: { booleanValue: true } } },
      limit: 200
    }).catch(() => []);
  } else {
    const lists = await Promise.all(
      Array.from(unlockedSet).slice(0, 20).map(catId =>
        runWorkerFirestoreQuery(env, idToken, {
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

  if (userPdfCache.size > 300) userPdfCache.clear();
  userPdfCache.set(key, { pdfs: rawPdfs, expiresAt: now + 30_000 });
  return rawPdfs;
}

interface PreparedWorkerChat {
  cfg: WorkerResolvedAiConfig;
  isGeminiProvider: boolean;
  altKey: string;
  quota: ReturnType<typeof getWorkerQuota>;
  systemInstruction: string;
  cleanHistory: Array<{ role: 'user' | 'model'; text: string }>;
  cleanMessage: string;
  courseNames: string[];
}

async function prepareWorkerChat(
  authHeader: string | null,
  env: WorkerEnv,
  body: { message?: unknown; history?: unknown }
): Promise<PreparedWorkerChat> {
  const tokenMatch = (authHeader || '').match(/^Bearer\s+(.+)$/i);
  const idToken = tokenMatch ? tokenMatch[1].trim() : '';
  if (!idToken) {
    throw new HttpError(
      401,
      'Please sign in to your Skill-Flix account to chat with Skill-Flix AI.',
      'AUTH_REQUIRED'
    );
  }

  const cleanMessage = typeof body.message === 'string' ? body.message.trim() : '';
  if (!cleanMessage) {
    throw new HttpError(400, 'Please enter a question for Skill-Flix AI.', 'EMPTY_MESSAGE');
  }
  if (cleanMessage.length > MAX_MESSAGE_CHARS) {
    throw new HttpError(400, `Keep your question under ${MAX_MESSAGE_CHARS} characters.`, 'MESSAGE_TOO_LONG');
  }

  const cleanHistory = pruneHistory(body.history);

  // Run Firebase ID token verification & AI config resolution in parallel
  const [caller, initialCfg] = await Promise.all([
    verifyFirebaseIdToken(idToken, env),
    resolveWorkerAiConfig(env)
  ]);

  const useServiceAccountCatalog = hasServiceAccountConfig(env);
  const projectId = (env.FIREBASE_PROJECT_ID || DEFAULT_PROJECT_ID).trim();
  const hasWarmPublicCatalog = Boolean(
    publicCatalogCache.get(projectId) &&
      publicCatalogCache.get(projectId)!.expiresAt > Date.now()
  );

  // Fetch user profile in parallel with public catalog if Service Account not ready or warm cache missing
  const saTokenPromise = useServiceAccountCatalog
    ? getFirestoreAuthToken(env, undefined, true).catch(() => null)
    : Promise.resolve(null);

  const [userProfile, saToken] = await Promise.all([
    fetchCachedUserProfile(env, caller.uid, caller.idToken),
    saTokenPromise
  ]);

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

  let cfg = initialCfg;
  const missingActiveKey =
    (cfg.AI_PROVIDER === 'gemini' && !cfg.GEMINI_API_KEY) ||
    (cfg.AI_PROVIDER === 'groq' && !cfg.GROQ_API_KEY) ||
    (cfg.AI_PROVIDER === 'openrouter' && !cfg.OPENROUTER_API_KEY);
  if ((!cfg.firestoreVaultSynced || cfg.vaultDecryptError || missingActiveKey) && isMasterAdmin) {
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

  // Fetch cached catalog (shared 60s TTL; 0 Firestore calls on cache hits)
  const catalogToken = !isAdmin && saToken ? saToken : caller.idToken;
  const catalog = await fetchPublicCatalog(
    env,
    catalogToken,
    Boolean(saToken) || isAdmin,
    isAdmin && !hasWarmPublicCatalog
  );

  const rawPdfs = await fetchUserPdfsCached(
    env,
    caller.uid,
    caller.idToken,
    hasAllAccess,
    unlockedSet,
    isAdmin || saToken ? catalog.pdfs : undefined
  );

  const seenCats = new Set<string>();
  const cleanCats = catalog.cats
    .filter(c => (isAdmin ? true : c.isActive !== false))
    .sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0))
    .filter(c => {
      const key = String(c.slug || c.id || c.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!key || seenCats.has(key)) return false;
      seenCats.add(key);
      return true;
    });

  const lastUserTurn = [...cleanHistory].reverse().find(h => h.role === 'user')?.text || '';
  const tokens = tokenizeQuery(`${cleanMessage} ${lastUserTurn.slice(0, 120)}`);

  const scoredCats = cleanCats.map(c => {
    const catId = String(c.id || '');
    const catName = String(c.name || 'Course');
    const unlocked = hasAllAccess || unlockedSet.has(catId);
    const catFolders = catalog.folders
      .filter(f => String(f.categoryId || '') === catId || String(f.parentId || '') === catId)
      .map(f => String(f.name || '').trim())
      .filter(Boolean);
    const catLessons = catalog.videos.filter(
      v => !UNWANTED_DEMO_VIDEO_IDS.has(String(v.id || '')) && String(v.categoryId || '') === catId && v.isPublished === true
    );
    const catPdfs = rawPdfs.filter(
      p => !UNWANTED_DEMO_PDF_IDS.has(String(p.id || '')) && String(p.categoryId || '') === catId && (isAdmin || p.isPublished === true)
    );

    const catText = `${catName} ${c.description || ''} ${catFolders.join(' ')} ${catLessons.slice(0, 8).map(v => v.title || '').join(' ')} ${catPdfs.slice(0, 6).map(p => p.title || '').join(' ')}`;
    const relevance = scoreTextMatch(catText, tokens);

    return {
      c,
      catId,
      catName,
      unlocked,
      catFolders,
      catLessons,
      catPdfs,
      relevance
    };
  });

  // Pick top 3 relevant (or unlocked) categories for detailed expansion; summarize others in 1 line
  const detailedIds = new Set(
    [...scoredCats]
      .sort((a, b) => {
        if (b.relevance !== a.relevance) return b.relevance - a.relevance;
        if (a.unlocked !== b.unlocked) return a.unlocked ? -1 : 1;
        return Number(a.c.order ?? 0) - Number(b.c.order ?? 0);
      })
      .slice(0, 3)
      .map(x => x.catId)
  );

  const courseNames: string[] = [];
  const catalogBlock = scoredCats
    .map((item, idx) => {
      courseNames.push(item.catName);
      const statusTag = item.unlocked ? 'UNLOCKED' : `LOCKED ₹${item.c.price || 299}`;
      if (!detailedIds.has(item.catId)) {
        return `${idx + 1}. "${item.catName}" [${statusTag}] — ${item.catLessons.length} lessons${item.catPdfs.length ? `, ${item.catPdfs.length} PDFs` : ''}`;
      }

      const lessons = [...item.catLessons]
        .sort((a, b) => {
          const diff =
            scoreTextMatch(`${b.title || ''} ${b.folderName || ''}`, tokens) -
            scoreTextMatch(`${a.title || ''} ${a.folderName || ''}`, tokens);
          return diff !== 0 ? diff : Number(a.order ?? 0) - Number(b.order ?? 0);
        })
        .slice(0, 6)
        .map(v => `  - ${v.episode ? `[${v.episode}] ` : ''}${v.title}${v.isFreePreview ? ' [FREE]' : ''}`);

      const pdfs = [...item.catPdfs]
        .sort((a, b) => scoreTextMatch(String(b.title || ''), tokens) - scoreTextMatch(String(a.title || ''), tokens))
        .slice(0, 5)
        .map(p => `  - PDF: "${p.title}" (${p.pageCount || 12}p)`);

      const desc = String(item.c.description || '').trim().slice(0, 100);
      return `${idx + 1}. "${item.catName}" [${statusTag}]${desc ? ` — ${desc}` : ''}${
        item.catFolders.length ? `\n  Folders: ${item.catFolders.slice(0, 8).join(', ')}` : ''
      }\n  Lessons:\n${lessons.join('\n') || '  (None)'}${
        pdfs.length ? `\n  PDFs:\n${pdfs.join('\n')}` : ''
      }`;
    })
    .join('\n');

  const systemInstruction = `You are Skill-Flix AI ("Your Personal Learning Assistant") on Skill-Flix Pro.
Reply clearly, warmly, and concisely in the student's language (Hindi, Hinglish, or English) using short bullet points or steps.
Teach video editing (Alight Motion, CapCut, Premiere Pro, After Effects, PDFs, roadmaps, creator tips).
NEVER invent courses, lessons, or PDFs not in this catalog:
${catalogBlock || 'No active courses listed yet.'}`;

  return {
    cfg,
    isGeminiProvider,
    altKey,
    quota,
    systemInstruction,
    cleanHistory,
    cleanMessage,
    courseNames
  };
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
  body: { message?: unknown; history?: unknown },
  signal?: AbortSignal
) {
  const ctx = await prepareWorkerChat(authHeader, env, body);

  const outcome = ctx.isGeminiProvider
    ? await generateWithWorkerGemini(
        ctx.cfg.GEMINI_API_KEY,
        ctx.cfg.GEMINI_AI_MODEL,
        ctx.cfg.GEMINI_FALLBACK_MODEL,
        ctx.systemInstruction,
        ctx.cleanHistory,
        ctx.cleanMessage,
        ctx.quota,
        signal
      )
    : await generateWithWorkerOpenAiProvider(
        env,
        ctx.cfg.AI_PROVIDER as 'openrouter' | 'groq',
        ctx.altKey,
        ctx.cfg.GEMINI_AI_MODEL,
        ctx.cfg.GEMINI_FALLBACK_MODEL,
        ctx.systemInstruction,
        ctx.cleanHistory,
        ctx.cleanMessage,
        ctx.quota,
        signal
      );

  const lower = outcome.text.toLowerCase();
  const referencedCourses = ctx.courseNames.filter(name => lower.includes(name.toLowerCase()));

  return {
    reply: outcome.text,
    model: outcome.model,
    provider: ctx.isGeminiProvider ? 'Google Gemini API (Free Tier)' : ctx.cfg.AI_PROVIDER,
    freeTier: true,
    referencedCourses,
    quota: ctx.quota
  };
}

export async function handleWorkerAiChatStream(
  authHeader: string | null,
  env: WorkerEnv,
  body: { message?: unknown; history?: unknown },
  corsHeaders: Record<string, string>,
  requestSignal?: AbortSignal
): Promise<Response> {
  // Run auth, quota & context validation BEFORE opening SSE response so HTTP 400/401/403/429/503 return standard status codes
  const ctx = await prepareWorkerChat(authHeader, env, body);
  const providerLabel = ctx.isGeminiProvider ? 'Google Gemini API (Free Tier)' : ctx.cfg.AI_PROVIDER;
  const enc = new TextEncoder();

  const streamAbort = new AbortController();
  const onReqAbort = () => streamAbort.abort();
  if (requestSignal?.aborted) {
    streamAbort.abort();
  } else {
    requestSignal?.addEventListener('abort', onReqAbort, { once: true });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const closeStream = () => {
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
      };

      const onStreamAbort = () => closeStream();
      streamAbort.signal.addEventListener('abort', onStreamAbort, { once: true });

      const pushEvent = (event: string, data: unknown) => {
        if (closed || streamAbort.signal.aborted) return;
        try {
          controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      try {
        const onStartModel = (modelName: string) => {
          pushEvent('meta', {
            model: modelName,
            provider: providerLabel,
            quota: ctx.quota
          });
        };

        const onDelta = (delta: string) => {
          pushEvent('chunk', { delta });
        };

        const outcome = ctx.isGeminiProvider
          ? await streamWithWorkerGemini(
              ctx.cfg.GEMINI_API_KEY,
              ctx.cfg.GEMINI_AI_MODEL,
              ctx.cfg.GEMINI_FALLBACK_MODEL,
              ctx.systemInstruction,
              ctx.cleanHistory,
              ctx.cleanMessage,
              ctx.quota,
              onStartModel,
              onDelta,
              streamAbort.signal
            )
          : await streamWithWorkerOpenAiProvider(
              env,
              ctx.cfg.AI_PROVIDER as 'openrouter' | 'groq',
              ctx.altKey,
              ctx.cfg.GEMINI_AI_MODEL,
              ctx.cfg.GEMINI_FALLBACK_MODEL,
              ctx.systemInstruction,
              ctx.cleanHistory,
              ctx.cleanMessage,
              ctx.quota,
              onStartModel,
              onDelta,
              streamAbort.signal
            );

        const lower = outcome.text.toLowerCase();
        const referencedCourses = ctx.courseNames.filter(name => lower.includes(name.toLowerCase()));

        pushEvent('done', {
          reply: outcome.text,
          model: outcome.model,
          provider: providerLabel,
          freeTier: true,
          referencedCourses,
          quota: ctx.quota
        });
      } catch (err: any) {
        if (!streamAbort.signal.aborted && !(err instanceof HttpError && err.status === 499)) {
          const status = err instanceof HttpError ? err.status : 502;
          const code = err instanceof HttpError && err.code ? err.code : 'AI_UPSTREAM_ERROR';
          const message = sanitizeError(
            err?.message || 'Skill-Flix AI encountered an error.',
            [ctx.cfg.GEMINI_API_KEY, ctx.altKey]
          );
          pushEvent('error', {
            status,
            code,
            error: message,
            quota: err instanceof HttpError && err.quota ? err.quota : ctx.quota
          });
        }
      } finally {
        streamAbort.signal.removeEventListener('abort', onStreamAbort);
        requestSignal?.removeEventListener('abort', onReqAbort);
        closeStream();
      }
    },
    cancel() {
      streamAbort.abort();
      requestSignal?.removeEventListener('abort', onReqAbort);
    }
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, no-transform',
      Connection: 'keep-alive',
      ...corsHeaders
    }
  });
}

export async function testWorkerAiConnection(env: WorkerEnv, admin: { idToken: string }) {
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
