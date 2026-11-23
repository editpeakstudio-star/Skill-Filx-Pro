import { sanitizeError } from './crypto';
import {
  getFirestoreAuthToken,
  getFirestoreDoc,
  getProjectId,
  hasServiceAccountConfig,
  verifyFirebaseIdToken
} from './firebase';
import { resolveWorkerAiConfig, type WorkerResolvedAiConfig } from './aiConfig';
import {
  getWorkerActiveCourseNames,
  routeAndExecuteWorkerTools,
  runWorkerSkillFlixTool,
  WORKER_TOOL_DECLARATIONS,
  type WorkerToolContext
} from './aiTools';
import { HttpError, type WorkerEnv } from './types';

const DEFAULT_PROJECT_ID = 'skillflix-academy';
const PLATFORM_OWNER_EMAIL = 'editpeakstudio@gmail.com';
const PLATFORM_OWNER_NAME = 'Pintu Kumar';
const MAX_MESSAGE_CHARS = 1500;
const MAX_HISTORY_TURNS = 6;
const MAX_TOOL_ROUNDS = 2;

interface WorkerRateBucket {
  minuteTimestamps: number[];
  dayKey: string;
  dayCount: number;
}

interface UserProfileCacheEntry {
  profile: Record<string, unknown> | null;
  expiresAt: number;
}

const workerRateBuckets = new Map<string, WorkerRateBucket>();
const userProfileCache = new Map<string, UserProfileCacheEntry>();

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

interface GeminiRestPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: {
    id?: string;
    name?: string;
    args?: Record<string, unknown>;
  };
  functionResponse?: {
    id?: string;
    name: string;
    response: Record<string, unknown>;
  };
}

interface GeminiRestContent {
  role: string;
  parts: GeminiRestPart[];
}

function buildGeminiRestPayload(
  modelName: string,
  systemInstruction: string,
  contents: GeminiRestContent[],
  includeTools: boolean
) {
  const supportsThinkingLevel = /^gemini-(?:3|4)/i.test(modelName);
  const isFlashLite = /flash-lite/i.test(modelName);

  return {
    ...(systemInstruction
      ? { systemInstruction: { parts: [{ text: systemInstruction }] } }
      : {}),
    contents,
    ...(includeTools ? { tools: [{ functionDeclarations: WORKER_TOOL_DECLARATIONS }] } : {}),
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

function buildInitialContents(
  history: Array<{ role: 'user' | 'model'; text: string }>,
  userMessage: string
): GeminiRestContent[] {
  return [
    ...history.map(h => ({ role: h.role, parts: [{ text: h.text }] })),
    { role: 'user', parts: [{ text: userMessage }] }
  ];
}

function extractRestPartsText(parts?: GeminiRestPart[]): string {
  if (!Array.isArray(parts)) return '';
  return parts
    .filter(p => !p.thought && typeof p.text === 'string' && p.text.length > 0)
    .map(p => p.text!)
    .join('');
}

async function generateWithWorkerGemini(
  apiKey: string,
  primaryModel: string,
  fallbackModel: string,
  systemInstruction: string,
  history: Array<{ role: 'user' | 'model'; text: string }>,
  userMessage: string,
  quota?: ReturnType<typeof getWorkerQuota>,
  toolCtx?: WorkerToolContext,
  signal?: AbortSignal,
  customPrimaryTimeoutMs?: number
): Promise<{ text: string; model: string }> {
  const modelsToTry = Array.from(new Set([primaryModel, fallbackModel].filter(Boolean)));
  const baseContents = buildInitialContents(history, userMessage);
  let lastStatus = 502;
  let lastBody = '';
  let lastError: HttpError | null = null;

  for (let mIdx = 0; mIdx < modelsToTry.length; mIdx++) {
    const modelName = modelsToTry[mIdx];
    const hasMoreModels = mIdx < modelsToTry.length - 1;
    const timeoutMs = hasMoreModels
      ? (customPrimaryTimeoutMs ?? 12_000)
      : (customPrimaryTimeoutMs ?? 18_000);

    try {
      let contents: GeminiRestContent[] = [...baseContents];
      let finalText = '';

      for (let round = 0; round <= (toolCtx ? MAX_TOOL_ROUNDS : 0); round++) {
        const allowToolsThisRound = Boolean(toolCtx && round < MAX_TOOL_ROUNDS);
        const geminiRes = await fetchAiWithTimeout(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': apiKey,
              'User-Agent': 'aistudio-build'
            },
            body: JSON.stringify(buildGeminiRestPayload(modelName, systemInstruction, contents, allowToolsThisRound))
          },
          timeoutMs,
          [apiKey],
          signal
        );

        if (!geminiRes.ok) {
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
          if (!hasMoreModels && lastStatus === 400) {
            throw classifyGeminiRestFailure(lastStatus, lastBody, quota, [apiKey]);
          }
          finalText = '';
          break;
        }

        const json = (await geminiRes.json().catch(() => ({}))) as {
          candidates?: Array<{ content?: GeminiRestContent }>;
        };
        const candidateContent = json.candidates?.[0]?.content;
        const parts = candidateContent?.parts || [];
        const calls = parts
          .filter(p => Boolean(p.functionCall?.name))
          .map(p => p.functionCall!);

        if (allowToolsThisRound && toolCtx && calls.length > 0 && candidateContent) {
          const toolResults = await Promise.all(
            calls.map(call => runWorkerSkillFlixTool(call.name || '', call.args, toolCtx))
          );

          const responseParts: GeminiRestPart[] = calls.map((call, idx) => {
            const res = toolResults[idx];
            return {
              functionResponse: {
                ...(call.id ? { id: call.id } : {}),
                name: call.name || 'unknown',
                response:
                  res.status === 'ok'
                    ? { output: res.data || {} }
                    : { error: res.error || 'Tool unavailable' }
              }
            };
          });

          contents = [
            ...contents,
            { role: candidateContent.role || 'model', parts },
            { role: 'user', parts: responseParts }
          ];
          continue;
        }

        finalText = extractRestPartsText(parts).trim();
        break;
      }

      if (finalText) {
        return { text: finalText, model: modelName };
      }
      if (!lastBody) {
        lastStatus = 502;
        lastBody = 'Empty response from Gemini model.';
      }
    } catch (err: any) {
      if (err instanceof HttpError && err.status === 499) throw err;
      if (
        err instanceof HttpError &&
        err.status !== 504 &&
        err.status !== 503 &&
        err.status !== 429 &&
        err.status !== 404
      ) {
        throw err;
      }
      lastError = err instanceof HttpError ? err : null;
      lastStatus = lastError?.status || 503;
      lastBody = lastError?.message || '';
    }
  }

  if (lastError && (lastError.status === 504 || lastError.status === 503 || lastError.status === 429)) {
    throw lastError;
  }
  throw classifyGeminiRestFailure(lastStatus, lastBody, quota, [apiKey]);
}

async function consumeSseLines(
  stream: ReadableStream<Uint8Array>,
  onEventData: (dataStr: string) => void,
  signal?: AbortSignal,
  timeouts?: { firstByteTimeoutMs?: number; idleTimeoutMs?: number }
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
  let hasReceivedData = false;

  const readChunkWithTimeout = async () => {
    const ms = hasReceivedData
      ? (timeouts?.idleTimeoutMs ?? 15_000)
      : (timeouts?.firstByteTimeoutMs ?? 14_000);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            void reader.cancel().catch(() => {});
            reject(
              new HttpError(
                504,
                'Skill-Flix AI took too long to respond from Gemini. Please try again in a moment.',
                'AI_TIMEOUT'
              )
            );
          }, ms);
        })
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  try {
    while (true) {
      if (signal?.aborted) {
        throw new HttpError(499, 'AI request was cancelled.', 'AI_CANCELLED');
      }
      const { value, done } = await readChunkWithTimeout();
      if (signal?.aborted) {
        throw new HttpError(499, 'AI request was cancelled.', 'AI_CANCELLED');
      }
      if (done) break;
      hasReceivedData = true;
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
  toolCtx: WorkerToolContext,
  onStartModel: (modelName: string) => void,
  onDelta: (delta: string) => void,
  signal?: AbortSignal
): Promise<{ text: string; model: string }> {
  const modelsToTry = Array.from(new Set([primaryModel, fallbackModel].filter(Boolean)));
  const baseContents = buildInitialContents(history, userMessage);
  let lastStatus = 502;
  let lastBody = '';
  let lastError: HttpError | null = null;
  let anyEmitted = false;

  for (let mIdx = 0; mIdx < modelsToTry.length; mIdx++) {
    const modelName = modelsToTry[mIdx];
    const hasMoreModels = mIdx < modelsToTry.length - 1;
    const firstTokenTimeoutMs = hasMoreModels ? 12_000 : 18_000;
    const chunkIdleTimeoutMs = 15_000;

    let emittedForModel = false;
    let startedModel = false;
    let accumulated = '';
    let contents: GeminiRestContent[] = [...baseContents];

    try {
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        const allowToolsThisRound = round < MAX_TOOL_ROUNDS;
        const res = await fetchAiWithTimeout(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:streamGenerateContent?alt=sse`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'text/event-stream',
              'x-goog-api-key': apiKey,
              'User-Agent': 'aistudio-build'
            },
            body: JSON.stringify(buildGeminiRestPayload(modelName, systemInstruction, contents, allowToolsThisRound))
          },
          firstTokenTimeoutMs,
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
          break;
        }

        if (!res.body) {
          lastStatus = 502;
          lastBody = 'Missing response body stream.';
          break;
        }

        const collectedParts: GeminiRestPart[] = [];
        const collectedCalls: Array<{ id?: string; name?: string; args?: Record<string, unknown> }> = [];
        let roundText = '';

        const contentType = (res.headers.get('content-type') || '').toLowerCase();
        if (contentType.includes('application/json') && !contentType.includes('event-stream')) {
          const json = (await res.json().catch(() => ({}))) as {
            candidates?: Array<{ content?: GeminiRestContent }>;
          };
          const parts = json.candidates?.[0]?.content?.parts || [];
          for (const part of parts) {
            if (part && Object.keys(part).length > 0) collectedParts.push(part);
            if (part.functionCall?.name) {
              collectedCalls.push(part.functionCall);
            } else if (!part.thought && typeof part.text === 'string' && part.text.length > 0) {
              roundText += part.text;
            }
          }
          if (roundText && collectedCalls.length === 0) {
            onStartModel(modelName);
            onDelta(roundText);
            return { text: roundText.trim(), model: modelName };
          }
        } else {
          await consumeSseLines(
            res.body,
            rawData => {
              if (!rawData || rawData === '[DONE]') return;
              try {
                const parsed = JSON.parse(rawData) as {
                  candidates?: Array<{ content?: GeminiRestContent }>;
                };
                const parts = parsed.candidates?.[0]?.content?.parts || [];
                for (const part of parts) {
                  if (part && Object.keys(part).length > 0) {
                    collectedParts.push(part);
                  }
                  if (part.functionCall?.name) {
                    collectedCalls.push(part.functionCall);
                  } else if (!part.thought && typeof part.text === 'string' && part.text.length > 0) {
                    if (!startedModel) {
                      startedModel = true;
                      onStartModel(modelName);
                    }
                    emittedForModel = true;
                    anyEmitted = true;
                    roundText += part.text;
                    accumulated += part.text;
                    onDelta(part.text);
                  }
                }
              } catch {
                // Ignore malformed keepalive SSE chunk
              }
            },
            signal,
            { firstByteTimeoutMs: firstTokenTimeoutMs, idleTimeoutMs: chunkIdleTimeoutMs }
          );
        }

        if (allowToolsThisRound && collectedCalls.length > 0 && !emittedForModel) {
          const toolResults = await Promise.all(
            collectedCalls.map(call => runWorkerSkillFlixTool(call.name || '', call.args, toolCtx))
          );

          const responseParts: GeminiRestPart[] = collectedCalls.map((call, idx) => {
            const tr = toolResults[idx];
            return {
              functionResponse: {
                ...(call.id ? { id: call.id } : {}),
                name: call.name || 'unknown',
                response:
                  tr.status === 'ok'
                    ? { output: tr.data || {} }
                    : { error: tr.error || 'Tool unavailable' }
              }
            };
          });

          contents = [
            ...contents,
            { role: 'model', parts: collectedParts },
            { role: 'user', parts: responseParts }
          ];
          continue;
        }

        const finalText = (accumulated || roundText).trim();
        if (finalText) {
          return { text: finalText, model: modelName };
        }
        lastStatus = 502;
        lastBody = 'Empty streaming response from Gemini.';
        break;
      }
    } catch (err: any) {
      if (err instanceof HttpError && err.status === 499) throw err;
      if (emittedForModel) {
        const cleanPartial = accumulated.trim();
        if (cleanPartial) return { text: cleanPartial, model: modelName };
      }
      if (
        err instanceof HttpError &&
        err.status !== 504 &&
        err.status !== 503 &&
        err.status !== 429 &&
        err.status !== 404
      ) {
        throw err;
      }
      lastError = err instanceof HttpError ? err : null;
      lastStatus = lastError?.status || 503;
      lastBody = lastError?.message || '';
    }
  }

  // Last-resort fast non-stream backup with full tool calling
  const fastModel = fallbackModel || primaryModel;
  if (!anyEmitted && fastModel && !signal?.aborted) {
    try {
      const backup = await generateWithWorkerGemini(
        apiKey,
        fastModel,
        '',
        systemInstruction,
        history,
        userMessage,
        quota,
        toolCtx,
        signal,
        12_000
      );
      onStartModel(backup.model);
      onDelta(backup.text);
      return backup;
    } catch {
      // Fall through to classified error
    }
  }

  if (lastError && (lastError.status === 504 || lastError.status === 503 || lastError.status === 429)) {
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
      signal,
      { firstByteTimeoutMs: 14_000, idleTimeoutMs: 14_000 }
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
  userProfileCache.set(key, { profile, expiresAt: now + 5_000 });
  return profile;
}

function buildWorkerSystemInstruction(viewerFirstName: string, viewerRole: string): string {
  return `You are **Skill-Flix AI** ("Your Personal Learning Assistant") on Skill-Flix Pro.
Language: Reply naturally in Hindi, Hinglish, or English matching the user's language and tone. Use clear bullet points or numbered steps when listing items.
Capabilities & Real-Time Grounding:
- You assist students with Skill-Flix courses, video editing (Alight Motion, CapCut, Premiere Pro, After Effects), live website catalog/counts/prices, personal student access/subscriptions, leadership hierarchy, and public support channels.
- ALWAYS call the provided Skill-Flix tools to retrieve current numbers, prices, courses, PDF counts, personal unlock/expiry status, payment history, public support channels, and Owner/Admin directory. NEVER guess or invent counts, prices, or unlock statuses.
Security & Privacy Rules (STRICT):
- Account tools check ONLY the currently signed-in authenticated account. If a user asks for another student's account, another UID, or another email (e.g. checking a different user's courses or purchases), politely decline and explain you can only check their own signed-in account.
- If a user asks for admin-only financial analytics (total sales/revenue), customer lists, other users' UTRs, audit logs, API keys, or private admin emails/phone numbers, politely decline.
- Never output raw videoUrl, pdfUrl, UIDs, or private staff contact details.
- If subscriptionStatus is "expired" or isExpired is true, clearly state that their subscription/access has expired and guide them to renew.
Current user: ${viewerFirstName} (role: ${viewerRole}).`;
}

interface ValidatedWorkerChat {
  caller: Awaited<ReturnType<typeof verifyFirebaseIdToken>>;
  cfg: WorkerResolvedAiConfig;
  isGeminiProvider: boolean;
  altKey: string;
  quota: ReturnType<typeof getWorkerQuota>;
  toolCtx: WorkerToolContext;
  systemInstruction: string;
  cleanHistory: Array<{ role: 'user' | 'model'; text: string }>;
  cleanMessage: string;
}

async function validateWorkerChatRequest(
  authHeader: string | null,
  env: WorkerEnv,
  body: { message?: unknown; history?: unknown }
): Promise<ValidatedWorkerChat> {
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

  const [caller, initialCfg] = await Promise.all([
    verifyFirebaseIdToken(idToken, env),
    resolveWorkerAiConfig(env)
  ]);

  const useServiceAccountCatalog = hasServiceAccountConfig(env);
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

  const rawName = isOwner
    ? PLATFORM_OWNER_NAME
    : (typeof userProfile?.displayName === 'string' && userProfile.displayName.trim()) || 'Student';
  const viewerFirstName = rawName.split(/\s+/)[0] || 'Student';
  const viewerRoleLabel = isOwner ? 'owner' : isMasterAdmin ? 'super_admin' : isAdmin ? 'admin' : 'student';

  const toolCtx: WorkerToolContext = {
    env: { ...env, FIREBASE_PROJECT_ID: getProjectId(env) },
    caller,
    userProfile,
    saToken,
    isOwner,
    isMasterAdmin,
    isAdmin,
    memo: new Map(),
    knownSecrets: [cfg.GEMINI_API_KEY, altKey].filter(Boolean)
  };

  return {
    caller,
    cfg,
    isGeminiProvider,
    altKey,
    quota,
    toolCtx,
    systemInstruction: buildWorkerSystemInstruction(viewerFirstName, viewerRoleLabel),
    cleanHistory,
    cleanMessage
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
  const ctx = await validateWorkerChatRequest(authHeader, env, body);

  let outcome: { text: string; model: string };
  if (ctx.isGeminiProvider) {
    outcome = await generateWithWorkerGemini(
      ctx.cfg.GEMINI_API_KEY,
      ctx.cfg.GEMINI_AI_MODEL,
      ctx.cfg.GEMINI_FALLBACK_MODEL,
      ctx.systemInstruction,
      ctx.cleanHistory,
      ctx.cleanMessage,
      ctx.quota,
      ctx.toolCtx,
      signal
    );
  } else {
    const toolData = await routeAndExecuteWorkerTools(ctx.cleanMessage, ctx.cleanHistory, ctx.toolCtx);
    const augmented = `${ctx.systemInstruction}\n\nREALTIME_SKILLFLIX_DATA:\n${JSON.stringify(toolData)}`;
    outcome = await generateWithWorkerOpenAiProvider(
      env,
      ctx.cfg.AI_PROVIDER as 'openrouter' | 'groq',
      ctx.altKey,
      ctx.cfg.GEMINI_AI_MODEL,
      ctx.cfg.GEMINI_FALLBACK_MODEL,
      augmented,
      ctx.cleanHistory,
      ctx.cleanMessage,
      ctx.quota,
      signal
    );
  }

  const courseNames = await getWorkerActiveCourseNames(ctx.toolCtx);
  const lower = outcome.text.toLowerCase();
  const referencedCourses = courseNames.filter(name => lower.includes(name.toLowerCase()));

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
  const ctx = await validateWorkerChatRequest(authHeader, env, body);
  const providerLabel = ctx.isGeminiProvider ? 'Google Gemini API (Free Tier)' : ctx.cfg.AI_PROVIDER;
  const enc = new TextEncoder();

  const streamAbort = new AbortController();
  const onReqAbort = () => streamAbort.abort();
  if (requestSignal?.aborted) {
    streamAbort.abort();
  } else {
    requestSignal?.addEventListener('abort', onReqAbort, { once: true });
  }

  let keepaliveTimer: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const closeStream = () => {
        if (keepaliveTimer !== undefined) {
          clearInterval(keepaliveTimer);
          keepaliveTimer = undefined;
        }
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

      const pushComment = (comment: string) => {
        if (closed || streamAbort.signal.aborted) return;
        try {
          controller.enqueue(enc.encode(`: ${comment}\n\n`));
        } catch {
          closed = true;
        }
      };

      const pushEvent = (event: string, data: unknown) => {
        if (closed || streamAbort.signal.aborted) return;
        try {
          controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      // Flush initial SSE bytes immediately and keep mobile/proxy connection alive while tools + model execute
      pushComment('connected');
      keepaliveTimer = setInterval(() => {
        pushComment('ping');
      }, 3500);

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

        let outcome: { text: string; model: string };
        if (ctx.isGeminiProvider) {
          outcome = await streamWithWorkerGemini(
            ctx.cfg.GEMINI_API_KEY,
            ctx.cfg.GEMINI_AI_MODEL,
            ctx.cfg.GEMINI_FALLBACK_MODEL,
            ctx.systemInstruction,
            ctx.cleanHistory,
            ctx.cleanMessage,
            ctx.quota,
            ctx.toolCtx,
            onStartModel,
            onDelta,
            streamAbort.signal
          );
        } else {
          const toolData = await routeAndExecuteWorkerTools(ctx.cleanMessage, ctx.cleanHistory, ctx.toolCtx);
          const augmented = `${ctx.systemInstruction}\n\nREALTIME_SKILLFLIX_DATA:\n${JSON.stringify(toolData)}`;
          outcome = await streamWithWorkerOpenAiProvider(
            env,
            ctx.cfg.AI_PROVIDER as 'openrouter' | 'groq',
            ctx.altKey,
            ctx.cfg.GEMINI_AI_MODEL,
            ctx.cfg.GEMINI_FALLBACK_MODEL,
            augmented,
            ctx.cleanHistory,
            ctx.cleanMessage,
            ctx.quota,
            onStartModel,
            onDelta,
            streamAbort.signal
          );
        }

        const courseNames = await getWorkerActiveCourseNames(ctx.toolCtx);
        const lower = outcome.text.toLowerCase();
        const referencedCourses = courseNames.filter(name => lower.includes(name.toLowerCase()));

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
      if (keepaliveTimer !== undefined) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = undefined;
      }
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
        'Ping',
        undefined,
        undefined
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
