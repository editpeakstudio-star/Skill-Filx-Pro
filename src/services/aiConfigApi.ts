import { getAuth, onAuthStateChanged, type User } from 'firebase/auth';
import type {
  AiAdminConfigUpdatePayload,
  AiAdminConfigView,
  AiConnectionTestResult
} from '../types';

const PRODUCTION_WORKER_URL = 'https://skill-flix-telegram-api.editpeakstudio.workers.dev';

function resolveAiConfigApiBase(): string {
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

const AI_CONFIG_API_BASE = resolveAiConfigApiBase();

function resolveUrl(path: string): string {
  const clean = path.startsWith('/') ? path : `/${path}`;
  return AI_CONFIG_API_BASE ? `${AI_CONFIG_API_BASE}${clean}` : clean;
}

async function waitForUser(timeoutMs = 3000): Promise<User> {
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

async function aiAdminRequest<T>(
  path: string,
  options: { method?: string; body?: unknown } = {}
): Promise<T> {
  const user = await waitForUser();
  const idToken = await user.getIdToken();
  const url = resolveUrl(path);

  let res: Response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    res = await fetch(url, {
      method: options.method || 'GET',
      headers: {
        Authorization: `Bearer ${idToken}`,
        Accept: 'application/json',
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {})
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller.signal
    });
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new Error('AI Configuration API request timed out after 25s. Please try again.');
    }
    throw new Error('Network error reaching AI Configuration API backend.');
  } finally {
    clearTimeout(timer);
  }

  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  const rawText = await res.text().catch(() => '');

  if (!contentType.includes('application/json')) {
    const looksLikeHtml =
      contentType.includes('text/html') ||
      rawText.trimStart().toLowerCase().startsWith('<!doctype') ||
      rawText.trimStart().toLowerCase().startsWith('<html');
    if (looksLikeHtml) {
      throw new Error(
        'AI Configuration API is not connected on this host (received HTML). Deploy the updated Cloudflare Worker in cloudflare-worker/ and set VITE_TELEGRAM_API_URL or VITE_AI_API_URL.'
      );
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

  if (!res.ok) {
    const msg =
      (typeof data.error === 'string' && data.error) ||
      (typeof data.message === 'string' && data.message) ||
      `Request failed (HTTP ${res.status}).`;
    throw new Error(msg);
  }

  return data as unknown as T;
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
