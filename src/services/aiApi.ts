import { getAuth, onAuthStateChanged, type User } from 'firebase/auth';
import type { AiChatResponse, AiStatusResponse } from '../types';

const AI_API_BASE = (
  import.meta.env.VITE_AI_API_URL ||
  import.meta.env.VITE_TELEGRAM_API_URL ||
  ''
)
  .trim()
  .replace(/\/+$/, '');

function resolveAiUrl(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return AI_API_BASE ? `${AI_API_BASE}${normalized}` : normalized;
}

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

export async function fetchSkillFlixAiStatus(signal?: AbortSignal): Promise<AiStatusResponse> {
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

  return data as AiStatusResponse;
}

export async function sendSkillFlixAiMessage(params: {
  message: string;
  history: Array<{ role: 'user' | 'model'; text: string }>;
  signal?: AbortSignal;
}): Promise<AiChatResponse> {
  const user = await getCurrentFirebaseUser();
  if (!user) {
    throw new AiClientError(
      401,
      'AUTH_REQUIRED',
      'Please sign in to your Skill-Flix account to start chatting with Skill-Flix AI.'
    );
  }

  const idToken = await withPromiseTimeout(
    user.getIdToken(),
    8000,
    'Firebase authentication took too long. Please check your connection and try again.'
  );

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
    30_000,
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
