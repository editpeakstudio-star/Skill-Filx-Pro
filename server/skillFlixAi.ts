import { GoogleGenAI, ThinkingLevel, type Content, type Part } from '@google/genai';
import type { AiConnectionTestResult } from '../src/types/index.ts';
import {
  fetchFirestoreDocument,
  getServerServiceAccountToken,
  hasServerServiceAccount,
  type VerifiedFirebaseUser
} from './firebaseAuthVerify.ts';
import {
  getResolvedRuntimeAiConfig,
  hydrateAiConfigFromFirestore,
  type ResolvedAiRuntimeConfig
} from './aiConfigStore.ts';
import { sanitizeErrorMessage } from './telegramCrypto.ts';
import {
  getAllActiveCourseNames,
  routeAndExecuteToolsForPrompt,
  runSkillFlixTool,
  SKILLFLIX_TOOL_DECLARATIONS,
  type ToolExecutionContext
} from './skillFlixTools.ts';

const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'skillflix-academy';
const PLATFORM_OWNER_EMAIL = 'editpeakstudio@gmail.com';
const PLATFORM_OWNER_NAME = 'Pintu Kumar';

const MAX_MESSAGE_CHARS = 1500;
const MAX_HISTORY_TURNS = 6;
const MAX_TOOL_ROUNDS = 2;

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

const rateBuckets = new Map<string, UserRateBucket>();
const userProfileCache = new Map<string, UserProfileCacheEntry>();
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

async function fetchCachedUserProfile(uid: string, idToken: string): Promise<Record<string, unknown> | null> {
  const now = Date.now();
  const cached = userProfileCache.get(uid);
  if (cached && cached.expiresAt > now) {
    return cached.profile;
  }

  const profile = await fetchFirestoreDocument('users', uid, idToken).catch(() => null);
  if (userProfileCache.size > 300) userProfileCache.clear();
  // Short 5s cache so real-time unlocks/expiries reflect immediately while preventing duplicate hits
  userProfileCache.set(uid, { profile, expiresAt: now + 5_000 });
  return profile;
}

function buildSmartSystemInstruction(viewerFirstName: string, viewerRole: string): string {
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

function extractPartsText(parts?: Part[]): string {
  if (!Array.isArray(parts)) return '';
  return parts
    .filter(p => !p.thought && typeof p.text === 'string' && p.text.length > 0)
    .map(p => p.text!)
    .join('');
}

async function generateWithGeminiSdk(
  apiKey: string,
  primaryModel: string,
  fallbackModel: string,
  systemInstruction: string,
  history: AiTurnInput[],
  userMessage: string,
  quota: AiQuotaSnapshot,
  toolCtx?: ToolExecutionContext,
  externalSignal?: AbortSignal,
  customPrimaryTimeoutMs?: number
): Promise<{ text: string; model: string }> {
  const ai = getGeminiClient(apiKey);
  const baseContents: Content[] = [
    ...history.map(turn => ({
      role: turn.role,
      parts: [{ text: turn.text }]
    })),
    {
      role: 'user',
      parts: [{ text: userMessage }]
    }
  ];

  const modelsToTry = Array.from(new Set([primaryModel, fallbackModel].filter(Boolean)));
  let lastError: any = null;

  for (let mIdx = 0; mIdx < modelsToTry.length; mIdx++) {
    const modelName = modelsToTry[mIdx];
    const hasMoreModels = mIdx < modelsToTry.length - 1;
    const timeoutMs = hasMoreModels
      ? (customPrimaryTimeoutMs ?? 12_000)
      : (customPrimaryTimeoutMs ?? 18_000);
    const thinkingConfig = getThinkingConfig(modelName);
    const tools = toolCtx ? [{ functionDeclarations: SKILLFLIX_TOOL_DECLARATIONS }] : undefined;

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
    }, timeoutMs);

    try {
      let contents: Content[] = [...baseContents];
      let finalText = '';

      for (let round = 0; round <= (toolCtx ? MAX_TOOL_ROUNDS : 0); round++) {
        const allowToolsThisRound = Boolean(toolCtx && round < MAX_TOOL_ROUNDS);
        const response = await ai.models.generateContent({
          model: modelName,
          contents,
          config: {
            systemInstruction,
            abortSignal: controller.signal,
            ...(allowToolsThisRound && tools ? { tools } : {}),
            ...(thinkingConfig ? { thinkingConfig } : {})
          }
        });

        const candidateContent = response.candidates?.[0]?.content;
        const calls = response.functionCalls;

        if (allowToolsThisRound && toolCtx && Array.isArray(calls) && calls.length > 0 && candidateContent) {
          const toolResults = await Promise.all(
            calls.map(call => runSkillFlixTool(call.name || '', call.args, toolCtx))
          );

          const responseParts: Part[] = calls.map((call, idx) => {
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
            candidateContent,
            { role: 'user', parts: responseParts }
          ];
          continue;
        }

        finalText = extractPartsText(candidateContent?.parts).trim() || (response.text || '').trim();
        break;
      }

      if (!finalText) {
        throw new Error('Empty response received from Gemini model.');
      }
      return { text: finalText, model: modelName };
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
      if (isAuthOrKeyInvalid) {
        throw classifyUpstreamGeminiError(err, quota, [apiKey]);
      }
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExtAbort);
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
  toolCtx: ToolExecutionContext,
  onStartModel: (modelName: string) => void,
  onDelta: (delta: string) => void,
  externalSignal?: AbortSignal
): Promise<{ text: string; model: string }> {
  const ai = getGeminiClient(apiKey);
  const baseContents: Content[] = [
    ...history.map(turn => ({
      role: turn.role,
      parts: [{ text: turn.text }]
    })),
    {
      role: 'user',
      parts: [{ text: userMessage }]
    }
  ];

  const modelsToTry = Array.from(new Set([primaryModel, fallbackModel].filter(Boolean)));
  let lastError: any = null;
  let anyEmittedAcrossModels = false;

  for (let mIdx = 0; mIdx < modelsToTry.length; mIdx++) {
    const modelName = modelsToTry[mIdx];
    const hasMoreModels = mIdx < modelsToTry.length - 1;
    const firstTokenTimeoutMs = hasMoreModels ? 12_000 : 18_000;
    const chunkIdleTimeoutMs = 15_000;
    const thinkingConfig = getThinkingConfig(modelName);
    const tools = [{ functionDeclarations: SKILLFLIX_TOOL_DECLARATIONS }];

    if (externalSignal?.aborted) {
      throw new AiServiceError(499, 'AI_CANCELLED', 'AI request was cancelled.');
    }

    const controller = new AbortController();
    let timedOut = false;
    const onExtAbort = () => controller.abort();
    externalSignal?.addEventListener('abort', onExtAbort, { once: true });

    let chunkTimer: ReturnType<typeof setTimeout> | undefined;
    const armTimer = (ms: number) => {
      if (chunkTimer !== undefined) clearTimeout(chunkTimer);
      chunkTimer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, ms);
    };
    armTimer(firstTokenTimeoutMs);

    let emitted = false;
    let startedMeta = false;
    let accumulated = '';

    try {
      let contents: Content[] = [...baseContents];

      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        const allowToolsThisRound = round < MAX_TOOL_ROUNDS;
        armTimer(firstTokenTimeoutMs);

        const responseStream = await ai.models.generateContentStream({
          model: modelName,
          contents,
          config: {
            systemInstruction,
            abortSignal: controller.signal,
            ...(allowToolsThisRound ? { tools } : {}),
            ...(thinkingConfig ? { thinkingConfig } : {})
          }
        });

        const collectedParts: Part[] = [];
        const collectedCalls: Array<{ id?: string; name?: string; args?: Record<string, unknown> }> = [];
        let roundText = '';

        for await (const chunk of responseStream) {
          if (externalSignal?.aborted && !timedOut) {
            throw new AiServiceError(499, 'AI_CANCELLED', 'AI request was cancelled.');
          }
          armTimer(chunkIdleTimeoutMs);

          const parts = chunk?.candidates?.[0]?.content?.parts || [];
          for (const part of parts) {
            if (part && Object.keys(part).length > 0) {
              collectedParts.push(part);
            }
            if (part.functionCall) {
              collectedCalls.push({
                id: part.functionCall.id,
                name: part.functionCall.name,
                args: (part.functionCall.args || {}) as Record<string, unknown>
              });
            } else if (!part.thought && typeof part.text === 'string' && part.text.length > 0) {
              if (!startedMeta) {
                startedMeta = true;
                onStartModel(modelName);
              }
              emitted = true;
              anyEmittedAcrossModels = true;
              roundText += part.text;
              accumulated += part.text;
              onDelta(part.text);
            }
          }
        }

        if (allowToolsThisRound && collectedCalls.length > 0 && !emitted) {
          const toolResults = await Promise.all(
            collectedCalls.map(call => runSkillFlixTool(call.name || '', call.args, toolCtx))
          );

          const responseParts: Part[] = collectedCalls.map((call, idx) => {
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
            { role: 'model', parts: collectedParts },
            { role: 'user', parts: responseParts }
          ];
          continue;
        }

        const finalText = (accumulated || roundText).trim();
        if (finalText) {
          return { text: finalText, model: modelName };
        }
        lastError = new Error('Empty streaming response from Gemini model.');
        break;
      }
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
    } finally {
      if (chunkTimer !== undefined) clearTimeout(chunkTimer);
      externalSignal?.removeEventListener('abort', onExtAbort);
    }
  }

  // Last-resort fast non-stream backup with full tool calling
  const fastModel = fallbackModel || primaryModel;
  if (!anyEmittedAcrossModels && fastModel && !externalSignal?.aborted) {
    try {
      const backup = await generateWithGeminiSdk(
        apiKey,
        fastModel,
        '',
        systemInstruction,
        history,
        userMessage,
        quota,
        toolCtx,
        externalSignal,
        12_000
      );
      onStartModel(backup.model);
      onDelta(backup.text);
      return backup;
    } catch {
      // Fall through to classified error
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
  toolCtx: ToolExecutionContext;
  systemInstruction: string;
  cleanHistory: AiTurnInput[];
  cleanMessage: string;
}

async function prepareExpressValidation(
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

  const [, userProfile, saToken] = await Promise.all([
    hydrateAiConfigFromFirestore(),
    fetchCachedUserProfile(caller.uid, caller.idToken),
    hasServerServiceAccount() ? getServerServiceAccountToken().catch(() => null) : Promise.resolve(null)
  ]);

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
  const isMasterAdmin = isOwner || rawRole === 'master_admin';
  const isAdmin = isMasterAdmin || rawRole === 'admin';

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

  const rawName = isOwner
    ? PLATFORM_OWNER_NAME
    : (typeof userProfile?.displayName === 'string' && userProfile.displayName.trim()) ||
      caller.name ||
      'Student';
  const viewerFirstName = rawName.split(/\s+/)[0] || 'Student';
  const viewerRoleLabel = isOwner ? 'owner' : isMasterAdmin ? 'super_admin' : isAdmin ? 'admin' : 'student';

  const toolCtx: ToolExecutionContext = {
    projectId: FIREBASE_PROJECT_ID,
    caller,
    userProfile,
    saToken,
    isOwner,
    isMasterAdmin,
    isAdmin,
    memo: new Map(),
    knownSecrets: [geminiKey, altProviderKey].filter(Boolean)
  };

  const systemInstruction = buildSmartSystemInstruction(viewerFirstName, viewerRoleLabel);

  return {
    cfg,
    useGemini,
    geminiKey,
    altProviderKey,
    quota,
    toolCtx,
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
  const ctx = await prepareExpressValidation(caller, body);

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
      ctx.toolCtx,
      externalSignal
    );
    providerLabel = 'Google Gemini API (Free Tier)';
  } else {
    const toolResults = await routeAndExecuteToolsForPrompt(ctx.cleanMessage, ctx.cleanHistory, ctx.toolCtx);
    const augmentedInstruction = `${ctx.systemInstruction}\n\nREALTIME_SKILLFLIX_DATA:\n${JSON.stringify(toolResults)}`;
    result = await generateWithOpenAiCompatibleProvider(
      ctx.cfg.AI_PROVIDER as 'openrouter' | 'groq',
      ctx.altProviderKey,
      ctx.cfg.GEMINI_AI_MODEL,
      ctx.cfg.GEMINI_FALLBACK_MODEL,
      augmentedInstruction,
      ctx.cleanHistory,
      ctx.cleanMessage,
      ctx.quota,
      externalSignal
    );
    providerLabel = ctx.cfg.AI_PROVIDER;
  }

  const allCourseNames = await getAllActiveCourseNames(ctx.toolCtx);
  const lowerReply = result.text.toLowerCase();
  const referencedCourses = allCourseNames.filter(name =>
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
    onKeepalive?: () => void;
    sendEvent: (event: string, data: unknown) => void;
  },
  externalSignal?: AbortSignal
): Promise<void> {
  const ctx = await prepareExpressValidation(caller, body);
  const providerLabel = ctx.useGemini ? 'Google Gemini API (Free Tier)' : ctx.cfg.AI_PROVIDER;

  // Open SSE stream immediately + emit keepalive pings so mobile proxies never drop connection
  hooks.onHeadersReady?.();
  hooks.onKeepalive?.();
  const keepaliveTimer = setInterval(() => {
    hooks.onKeepalive?.();
  }, 3500);

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

    let result: { text: string; model: string };
    if (ctx.useGemini) {
      result = await streamWithGeminiSdk(
        ctx.geminiKey,
        ctx.cfg.GEMINI_AI_MODEL,
        ctx.cfg.GEMINI_FALLBACK_MODEL,
        ctx.systemInstruction,
        ctx.cleanHistory,
        ctx.cleanMessage,
        ctx.quota,
        ctx.toolCtx,
        onStartModel,
        onDelta,
        externalSignal
      );
    } else {
      const toolResults = await routeAndExecuteToolsForPrompt(ctx.cleanMessage, ctx.cleanHistory, ctx.toolCtx);
      const augmentedInstruction = `${ctx.systemInstruction}\n\nREALTIME_SKILLFLIX_DATA:\n${JSON.stringify(toolResults)}`;
      result = await streamWithOpenAiCompatibleProvider(
        ctx.cfg.AI_PROVIDER as 'openrouter' | 'groq',
        ctx.altProviderKey,
        ctx.cfg.GEMINI_AI_MODEL,
        ctx.cfg.GEMINI_FALLBACK_MODEL,
        augmentedInstruction,
        ctx.cleanHistory,
        ctx.cleanMessage,
        ctx.quota,
        onStartModel,
        onDelta,
        externalSignal
      );
    }

    const allCourseNames = await getAllActiveCourseNames(ctx.toolCtx);
    const lowerReply = result.text.toLowerCase();
    const referencedCourses = allCourseNames.filter(name =>
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
  } finally {
    clearInterval(keepaliveTimer);
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
        dummyQuota,
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
