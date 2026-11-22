import { getAuth, onAuthStateChanged, type User } from 'firebase/auth';
import type {
  AiAdminConfigUpdatePayload,
  AiAdminConfigView,
  AiConnectionTestResult
} from '../types';
import {
  getApiBaseCandidates,
  looksLikeHtmlPayload,
  resolveCandidateUrl,
  sleepMs
} from './apiBaseResolver';

async function waitForUser(timeoutMs = 6000): Promise<User> {
  const auth = getAuth();
  if (auth.currentUser) return auth.currentUser;

  return new Promise<User>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsub();
      reject(new Error('Sign in as the Owner or a Super Admin to manage AI Configuration.'));
    }, timeoutMs);

    const unsub = onAuthStateChanged(
      auth,
      user => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsub();
        if (user) resolve(user);
        else reject(new Error('Sign in as the Owner or a Super Admin to manage AI Configuration.'));
      },
      err => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsub();
        reject(err instanceof Error ? err : new Error('Authentication check failed.'));
      }
    );
  });
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 20_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function aiAdminRequest<T>(
  path: string,
  options: { method?: string; body?: unknown } = {}
): Promise<T> {
  const user = await waitForUser();
  let idToken = await user.getIdToken();
  const candidates = getApiBaseCandidates(true);

  let lastNetworkError: Error | null = null;
  let sawHtmlFallback = false;

  for (let cIdx = 0; cIdx < candidates.length; cIdx++) {
    const base = candidates[cIdx];
    const url = resolveCandidateUrl(base, path);
    const hasMoreCandidates = cIdx < candidates.length - 1;

    for (let attempt = 0; attempt < 2; attempt++) {
      let res: Response;
      try {
        res = await fetchWithTimeout(url, {
          method: options.method || 'GET',
          headers: {
            Authorization: `Bearer ${idToken}`,
            Accept: 'application/json',
            ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {})
          },
          body: options.body !== undefined ? JSON.stringify(options.body) : undefined
        });
      } catch (err: any) {
        if (err?.name === 'AbortError') {
          lastNetworkError = new Error('AI Configuration API request timed out. Please try again.');
        } else {
          const targetLabel = base ? 'Worker API' : 'same-origin /api';
          lastNetworkError = new Error(
            `Network error reaching ${targetLabel}${err?.message ? ` (${err.message})` : ''}.`
          );
        }
        if (attempt === 0) {
          await sleepMs(350);
          continue;
        }
        break;
      }

      if (res.status === 401 && attempt === 0) {
        try {
          idToken = await user.getIdToken(true);
          continue;
        } catch {
          // Fall through to parse server 401 response
        }
      }

      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      const rawText = await res.text().catch(() => '');

      if (!contentType.includes('application/json')) {
        if (looksLikeHtmlPayload(contentType, rawText)) {
          sawHtmlFallback = true;
          if (hasMoreCandidates) {
            break;
          }
          throw new Error(
            'AI Configuration API is not connected on this host (received HTML). Deploy the updated Cloudflare Worker in cloudflare-worker/ and set VITE_TELEGRAM_API_URL or VITE_AI_API_URL.'
          );
        }
        if ((res.status === 502 || res.status === 503 || res.status === 504) && attempt === 0) {
          await sleepMs(350);
          continue;
        }
        if (hasMoreCandidates && (res.status === 404 || res.status >= 502)) {
          lastNetworkError = new Error(`AI Configuration API returned HTTP ${res.status}.`);
          break;
        }
        throw new Error(`AI Configuration API request failed (HTTP ${res.status}).`);
      }

      let data: Record<string, unknown>;
      try {
        const parsed = rawText ? JSON.parse(rawText) : {};
        data = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {};
      } catch {
        throw new Error(`Invalid JSON returned by AI Configuration API (HTTP ${res.status}).`);
      }

      if (res.status === 404 && data.code === 'ENDPOINT_NOT_FOUND' && hasMoreCandidates) {
        break;
      }

      if (!res.ok) {
        const msg =
          (typeof data.error === 'string' && data.error) ||
          (typeof data.message === 'string' && data.message) ||
          `Request failed (HTTP ${res.status}).`;
        throw new Error(msg);
      }

      return data as unknown as T;
    }
  }

  if (sawHtmlFallback && !lastNetworkError) {
    throw new Error(
      'AI Configuration API is not connected on this host (received HTML). Deploy the updated Cloudflare Worker in cloudflare-worker/ and set VITE_TELEGRAM_API_URL or VITE_AI_API_URL.'
    );
  }

  throw (
    lastNetworkError ||
    new Error('Unable to reach AI Configuration API backend. Tap Refresh or check your internet connection.')
  );
}

export function fetchAdminAiConfig(): Promise<AiAdminConfigView> {
  return aiAdminRequest<AiAdminConfigView>('/api/admin/ai-config');
}

export function updateAdminAiConfig(payload: AiAdminConfigUpdatePayload): Promise<AiAdminConfigView> {
  return aiAdminRequest<AiAdminConfigView>('/api/admin/ai-config', {
    method: 'PUT',
    body: payload
  });
}

export function testAdminAiConnection(): Promise<AiConnectionTestResult> {
  return aiAdminRequest<AiConnectionTestResult>('/api/admin/ai-config/test', {
    method: 'POST'
  });
}
