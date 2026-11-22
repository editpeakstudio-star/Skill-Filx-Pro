import { getAuth, onAuthStateChanged, type User } from 'firebase/auth';
import type { AiChatResponse, AiQuotaInfo, AiStatusResponse } from '../types';

const PRODUCTION_WORKER_URL = 'https://skill-flix-telegram-api.editpeakstudio.workers.dev';

function resolveAiApiBase(): string {
  const configured = (
    import.meta.env.VITE_AI_API_URL ||
    import.meta.env.VITE_TELEGRAM_API_URL ||
    ''
  )
    .trim()
    .replace(/\/+$/, '');
  if (configured) return configured;

  if (typeof window !== 'undefined') {
    const host = window.location.hostname.toLowerCase();
    if (host === 'skillflix-academy.web.app' || host === 'skillflix-academy.firebaseapp.com') {
      return PRODUCTION_WORKER_URL;
    }
  }
  return '';
}

const AI_API_BASE = resolveAiApiBase();

function resolveAiUrl(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return AI_API_BASE ? `${AI_API_BASE}${normalized}` : normalized;
}

const STATUS_CACHE_TTL_MS = 45_000;
let cachedStatus: { value: AiStatusResponse; expiresAt: number } | null = null;
let inFlightStatusPromise: Promise<AiStatusResponse> | null = null;

async function getCurrentFirebaseUser(timeoutMs = 2500): Promise<User | null> {
  const auth = getAuth();
  if (auth.currentUser) return auth.currentUser;

  return new Promise<User | null>(resolve => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsub();
      resolve(auth.currentUser || null);
    }, timeoutMs);

    const unsub = onAuthStateChanged(
      auth,
      user => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsub();
        resolve(user);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsub();
        resolve(null);
      }
    );
  });
}

async function withPromiseTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new AiClientError(504, 'AI_TIMEOUT', timeoutMessage));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function fetchAiWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  externalSignal?: AbortSignal
): Promise<Response> {
  if (externalSignal?.aborted) {
    throw new AiClientError(499, 'AI_CANCELLED', 'Request was cancelled.');
  }

  const controller = new AbortController();
  let timedOut = false;

  const onExternalAbort = () => {
    controller.abort();
  };
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal
    });
  } catch (err: any) {
    if (externalSignal?.aborted && !timedOut) {
      throw new AiClientError(499, 'AI_CANCELLED', 'Request was cancelled.');
    }
    if (timedOut || err?.name === 'AbortError') {
      throw new AiClientError(
        504,
        'AI_TIMEOUT',
        'Skill-Flix AI took too long to respond (timeout). Please try again.'
      );
    }
    throw new AiClientError(
      503,
      'NETWORK_ERROR',
      'Network connection interrupted while contacting Skill-Flix AI. Please try again.'
    );
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}

function defaultErrorByStatus(status: number): { code: string; message: string } {
  switch (status) {
    case 400:
      return { code: 'AI_BAD_REQUEST', message: 'Invalid AI request. Check your message or AI configuration.' };
    case 401:
      return { code: 'AUTH_REQUIRED', message: 'Your session expired or failed authentication. Please sign in again.' };
    case 403:
      return { code: 'PERMISSION_DENIED', message: 'You do not have permission to access Skill-Flix AI right now.' };
    case 404:
      return {
        code: 'AI_MODEL_UNAVAILABLE',
        message: 'Configured AI route or model was not found. Ask the Platform Owner to check AI Configuration.'
      };
    case 429:
      return {
        code: 'UPSTREAM_QUOTA_EXHAUSTED',
        message: 'Skill-Flix AI rate limit or free-tier quota is temporarily full. Please wait a minute and retry.'
      };
    case 504:
      return {
        code: 'AI_TIMEOUT',
        message: 'Skill-Flix AI timed out waiting for an upstream response. Please try again.'
      };
    case 502:
    case 503:
      return {
        code: 'AI_PROVIDER_UNAVAILABLE',
        message: 'Skill-Flix AI service is temporarily unavailable. Please check API key setup or retry shortly.'
      };
    default:
      return {
        code: 'AI_INTERNAL_ERROR',
        message: 'Skill-Flix AI encountered an internal error. Please try again.'
      };
  }
}

export class AiClientError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface AiStreamMetaEvent {
  model?: string;
  provider?: string;
  quota?: AiQuotaInfo;
}

export async function fetchSkillFlixAiStatus(
  signal?: AbortSignal,
  forceRefresh = false
): Promise<AiStatusResponse> {
  const now = Date.now();
  if (!forceRefresh && cachedStatus && cachedStatus.expiresAt > now) {
    return cachedStatus.value;
  }
  if (!forceRefresh && inFlightStatusPromise) {
    return inFlightStatusPromise;
  }

  const run = (async () => {
    const res = await fetchAiWithTimeout(
      resolveAiUrl('/api/ai/status'),
      {
        method: 'GET',
        headers: { Accept: 'application/json' }
      },
      10_000,
      signal
    );

    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    const rawText = await res.text().catch(() => '');

    if (!contentType.includes('application/json')) {
      throw new AiClientError(503, 'AI_BACKEND_UNREACHABLE', 'Skill-Flix AI service is unavailable.');
    }

    let data: Partial<AiStatusResponse> & { error?: string };
    try {
      data = rawText ? (JSON.parse(rawText) as Partial<AiStatusResponse> & { error?: string }) : {};
    } catch {
      throw new AiClientError(res.status || 502, 'INVALID_SERVER_RESPONSE', 'Skill-Flix AI returned invalid JSON.');
    }

    if (!res.ok) {
      throw new AiClientError(res.status, 'AI_STATUS_ERROR', data.error || 'Could not reach Skill-Flix AI.');
    }

    const result = data as AiStatusResponse;
    cachedStatus = { value: result, expiresAt: Date.now() + STATUS_CACHE_TTL_MS };
    return result;
  })();

  inFlightStatusPromise = run;
  try {
    return await run;
  } finally {
    if (inFlightStatusPromise === run) {
      inFlightStatusPromise = null;
    }
  }
}

async function getAuthorizedIdToken(): Promise<string> {
  const user = await getCurrentFirebaseUser();
  if (!user) {
    throw new AiClientError(
      401,
      'AUTH_REQUIRED',
      'Please sign in to your Skill-Flix account to start chatting with Skill-Flix AI.'
    );
  }

  // Firebase SDK caches ID token in memory until expiry (auto-refreshes only when <5 min left)
  return withPromiseTimeout(
    user.getIdToken(false),
    8000,
    'Firebase authentication took too long. Please check your connection and try again.'
  );
}

export async function sendSkillFlixAiMessage(params: {
  message: string;
  history: Array<{ role: 'user' | 'model'; text: string }>;
  signal?: AbortSignal;
}): Promise<AiChatResponse> {
  const idToken = await getAuthorizedIdToken();

  const res = await fetchAiWithTimeout(
    resolveAiUrl('/api/ai/chat'),
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${idToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({
        message: params.message,
        history: params.history
      })
    },
    35_000,
    params.signal
  );

  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  const rawText = await res.text().catch(() => '');

  if (!contentType.includes('application/json')) {
    const fallback = defaultErrorByStatus(res.status || 502);
    throw new AiClientError(
      res.status || 502,
      res.status === 504 ? 'AI_TIMEOUT' : 'INVALID_SERVER_RESPONSE',
      res.status >= 500 ? fallback.message : 'Skill-Flix AI server returned an unexpected response.'
    );
  }

  let payload: Partial<AiChatResponse> & {
    error?: string;
    code?: string;
  };
  try {
    const parsed = rawText ? JSON.parse(rawText) : {};
    payload =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Partial<AiChatResponse> & { error?: string; code?: string })
        : {};
  } catch {
    throw new AiClientError(
      res.status || 502,
      'INVALID_SERVER_RESPONSE',
      'Skill-Flix AI server returned a malformed response. Please try again.'
    );
  }

  if (!res.ok || !payload.reply) {
    const fallback = defaultErrorByStatus(res.status || 500);
    throw new AiClientError(
      res.status || 500,
      payload.code || fallback.code,
      payload.error || fallback.message
    );
  }

  return payload as AiChatResponse;
}

export async function streamSkillFlixAiMessage(params: {
  message: string;
  history: Array<{ role: 'user' | 'model'; text: string }>;
  signal?: AbortSignal;
  onMeta?: (meta: AiStreamMetaEvent) => void;
  onChunk?: (delta: string, accumulated: string) => void;
}): Promise<AiChatResponse> {
  if (params.signal?.aborted) {
    throw new AiClientError(499, 'AI_CANCELLED', 'Request was cancelled.');
  }

  const idToken = await getAuthorizedIdToken();
  const streamController = new AbortController();
  let timedOut = false;

  const onExternalAbort = () => {
    streamController.abort();
  };
  params.signal?.addEventListener('abort', onExternalAbort, { once: true });

  // Overall ceiling + inactivity watchdog during active streaming
  const totalTimer = setTimeout(() => {
    timedOut = true;
    streamController.abort();
  }, 40_000);

  let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
  const resetInactivityTimer = () => {
    if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      timedOut = true;
      streamController.abort();
    }, 25_000);
  };
  resetInactivityTimer();

  try {
    const res = await fetch(resolveAiUrl('/api/ai/chat/stream'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${idToken}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream, application/json'
      },
      body: JSON.stringify({
        message: params.message,
        history: params.history,
        stream: true
      }),
      signal: streamController.signal
    });

    const contentType = (res.headers.get('content-type') || '').toLowerCase();

    // Non-SSE response (error JSON or JSON-only fallback backend)
    if (!contentType.includes('text/event-stream')) {
      const rawText = await res.text().catch(() => '');
      if (!contentType.includes('application/json')) {
        const fallback = defaultErrorByStatus(res.status || 502);
        throw new AiClientError(
          res.status || 502,
          res.status === 504 ? 'AI_TIMEOUT' : 'INVALID_SERVER_RESPONSE',
          res.status >= 500 ? fallback.message : 'Skill-Flix AI server returned an unexpected response.'
        );
      }

      let payload: Partial<AiChatResponse> & { error?: string; code?: string };
      try {
        payload = rawText ? (JSON.parse(rawText) as Partial<AiChatResponse> & { error?: string; code?: string }) : {};
      } catch {
        throw new AiClientError(
          res.status || 502,
          'INVALID_SERVER_RESPONSE',
          'Skill-Flix AI server returned malformed JSON.'
        );
      }

      if (!res.ok || !payload.reply) {
        if (res.status === 404 && payload.code === 'ENDPOINT_NOT_FOUND') {
          const fallbackReply = await sendSkillFlixAiMessage({
            message: params.message,
            history: params.history,
            signal: params.signal
          });
          params.onChunk?.(fallbackReply.reply, fallbackReply.reply);
          return fallbackReply;
        }
        const fallback = defaultErrorByStatus(res.status || 500);
        throw new AiClientError(
          res.status || 500,
          payload.code || fallback.code,
          payload.error || fallback.message
        );
      }

      params.onChunk?.(payload.reply, payload.reply);
      return payload as AiChatResponse;
    }

    if (!res.body) {
      throw new AiClientError(502, 'AI_STREAM_EMPTY', 'Skill-Flix AI stream closed unexpectedly.');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEvent = 'message';
    let currentDataLines: string[] = [];

    const defaultFallbackQuota = (): AiQuotaInfo => ({
      minuteRemaining: 0,
      minuteLimit: 10,
      dailyRemaining: 0,
      dailyLimit: 60,
      resetMinuteAt: new Date(Date.now() + 60_000).toISOString()
    });

    let accumulated = '';
    let latestMeta: AiStreamMetaEvent = {};
    const sseState: {
      donePayload: AiChatResponse | null;
      streamError: AiClientError | null;
    } = {
      donePayload: null,
      streamError: null
    };

    const flushEvent = () => {
      if (currentDataLines.length === 0) {
        currentEvent = 'message';
        return;
      }
      const dataStr = currentDataLines.join('\n').trim();
      const eventName = currentEvent;
      currentEvent = 'message';
      currentDataLines = [];

      if (!dataStr) return;

      let parsed: any;
      try {
        parsed = JSON.parse(dataStr);
      } catch {
        return;
      }

      if (eventName === 'meta') {
        latestMeta = {
          model: typeof parsed?.model === 'string' ? parsed.model : latestMeta.model,
          provider: typeof parsed?.provider === 'string' ? parsed.provider : latestMeta.provider,
          quota: parsed?.quota || latestMeta.quota
        };
        params.onMeta?.(latestMeta);
      } else if (eventName === 'chunk') {
        const delta = typeof parsed?.delta === 'string' ? parsed.delta : '';
        if (delta) {
          accumulated += delta;
          params.onChunk?.(delta, accumulated);
        }
      } else if (eventName === 'done') {
        const finalReply =
          typeof parsed?.reply === 'string' && parsed.reply.trim()
            ? parsed.reply
            : accumulated.trim();
        if (!accumulated && finalReply) {
          accumulated = finalReply;
          params.onChunk?.(finalReply, accumulated);
        }
        sseState.donePayload = {
          reply: finalReply,
          model: typeof parsed?.model === 'string' ? parsed.model : latestMeta.model || 'gemini-4-hydrogen',
          provider:
            typeof parsed?.provider === 'string'
              ? parsed.provider
              : latestMeta.provider || 'Google Gemini API (Free Tier)',
          freeTier: true,
          referencedCourses: Array.isArray(parsed?.referencedCourses) ? parsed.referencedCourses : [],
          quota: parsed?.quota || latestMeta.quota || defaultFallbackQuota()
        };
      } else if (eventName === 'error') {
        const status = Number(parsed?.status || 502);
        const fallback = defaultErrorByStatus(status);
        sseState.streamError = new AiClientError(
          status,
          typeof parsed?.code === 'string' ? parsed.code : fallback.code,
          typeof parsed?.error === 'string' && parsed.error ? parsed.error : fallback.message
        );
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      resetInactivityTimer();
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line === '') {
          flushEvent();
          if (sseState.streamError) {
            throw sseState.streamError;
          }
          continue;
        }
        if (line.startsWith(':')) continue;
        if (line.startsWith('event:')) {
          currentEvent = line.slice(6).trim() || 'message';
        } else if (line.startsWith('data:')) {
          currentDataLines.push(line.slice(5).trimStart());
        }
      }
    }

    if (buffer.trim()) {
      const line = buffer.trim();
      if (line.startsWith('data:')) {
        currentDataLines.push(line.slice(5).trimStart());
      }
    }
    flushEvent();

    if (sseState.streamError) {
      throw sseState.streamError;
    }

    if (sseState.donePayload && sseState.donePayload.reply) {
      return sseState.donePayload;
    }

    if (accumulated.trim()) {
      return {
        reply: accumulated.trim(),
        model: latestMeta.model || 'gemini-4-hydrogen',
        provider: latestMeta.provider || 'Google Gemini API (Free Tier)',
        freeTier: true,
        referencedCourses: [],
        quota: latestMeta.quota || defaultFallbackQuota()
      };
    }

    throw new AiClientError(
      502,
      'AI_EMPTY_STREAM',
      'Skill-Flix AI did not emit a response. Please try again.'
    );
  } catch (err: any) {
    if (err instanceof AiClientError) {
      throw err;
    }
    if (params.signal?.aborted && !timedOut) {
      throw new AiClientError(499, 'AI_CANCELLED', 'Request was cancelled.');
    }
    if (timedOut || err?.name === 'AbortError') {
      throw new AiClientError(
        504,
        'AI_TIMEOUT',
        'Skill-Flix AI took too long to respond (timeout). Please try again.'
      );
    }
    throw new AiClientError(
      503,
      'NETWORK_ERROR',
      'Network connection interrupted while streaming from Skill-Flix AI. Please try again.'
    );
  } finally {
    clearTimeout(totalTimer);
    if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
    params.signal?.removeEventListener('abort', onExternalAbort);
  }
}
