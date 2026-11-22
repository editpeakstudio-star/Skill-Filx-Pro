export const PRODUCTION_WORKER_URL = 'https://skill-flix-telegram-api.editpeakstudio.workers.dev';

// Read Vite build-time env vars so production bundles preserve VITE_TELEGRAM_API_URL
const CONFIGURED_TELEGRAM_API_URL = (
  (typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env.VITE_TELEGRAM_API_URL : '') ||
  ''
)
  .trim()
  .replace(/\/+$/, '');
const CONFIGURED_AI_API_URL = (
  (typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env.VITE_AI_API_URL : '') ||
  ''
)
  .trim()
  .replace(/\/+$/, '');

function isFirebaseHostingHost(host: string): boolean {
  return (
    host === 'skillflix-academy.web.app' ||
    host === 'skillflix-academy.firebaseapp.com' ||
    host.endsWith('.web.app') ||
    host.endsWith('.firebaseapp.com')
  );
}

function isSameOriginExpressHost(host: string): boolean {
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host.endsWith('.run.app') ||
    host.endsWith('.googleusercontent.com') ||
    host.endsWith('.usercontent.goog') ||
    host.endsWith('.aistudio.google.com') ||
    host.endsWith('.cloudshell.dev') ||
    host.endsWith('.idx.google.com')
  );
}

function uniqueOrdered(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

/**
 * Returns ordered API base URLs to try for backend calls:
 * - On Firebase Hosting (static host): Worker directly.
 * - In AI Studio / Cloud Run / Localhost previews: same-origin Express '' FIRST
 *   (avoids ISP blocks on *.workers.dev and cross-origin CORS issues even in production builds),
 *   with Worker as fallback if the host serves static files only.
 * - On custom domains: explicit configured Worker first, same-origin Express as backup.
 */
export function getApiBaseCandidates(preferAiEnv = false): string[] {
  const configured = preferAiEnv
    ? CONFIGURED_AI_API_URL || CONFIGURED_TELEGRAM_API_URL
    : CONFIGURED_TELEGRAM_API_URL || CONFIGURED_AI_API_URL;
  const workerBase = configured || PRODUCTION_WORKER_URL;

  if (typeof window === 'undefined') {
    return [''];
  }

  const host = window.location.hostname.toLowerCase();

  if (isFirebaseHostingHost(host)) {
    return [workerBase];
  }

  if (isSameOriginExpressHost(host)) {
    return uniqueOrdered(['', workerBase]);
  }

  if (configured) {
    return uniqueOrdered([configured, '']);
  }

  return uniqueOrdered(['', PRODUCTION_WORKER_URL]);
}

export function resolveCandidateUrl(base: string, path: string): string {
  const clean = path.startsWith('/') ? path : `/${path}`;
  return base ? `${base}${clean}` : clean;
}

export function looksLikeHtmlPayload(contentType: string, rawText: string): boolean {
  const ct = contentType.toLowerCase();
  const trimmed = rawText.trimStart().toLowerCase();
  return (
    ct.includes('text/html') ||
    trimmed.startsWith('<!doctype') ||
    trimmed.startsWith('<html')
  );
}

export async function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
