import { getAuth, onAuthStateChanged, type User } from 'firebase/auth';
import type {
  TelegramBotConfig,
  TelegramDashboardResponse,
  TelegramManagerSettings,
  TelegramNotificationJob,
  TelegramNotificationLog
} from '../types';
import {
  getApiBaseCandidates,
  looksLikeHtmlPayload,
  resolveCandidateUrl,
  sleepMs
} from './apiBaseResolver';

async function waitForSignedInUser(timeoutMs = 3000): Promise<User> {
  const auth = getAuth();
  if (auth.currentUser) {
    return auth.currentUser;
  }

  return new Promise<User>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsub();
      reject(new Error('You must be signed in to access Telegram Bot Manager.'));
    }, timeoutMs);

    const unsub = onAuthStateChanged(
      auth,
      user => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsub();
        if (user) {
          resolve(user);
        } else {
          reject(new Error('You must be signed in to access Telegram Bot Manager.'));
        }
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

async function apiRequest<T>(
  path: string,
  options: { method?: string; body?: unknown } = {}
): Promise<T> {
  const user = await waitForSignedInUser();
  let token = await user.getIdToken();
  const candidates = getApiBaseCandidates(false);

  let lastError: Error | null = null;
  let sawHtmlFallback = false;

  for (let cIdx = 0; cIdx < candidates.length; cIdx++) {
    const base = candidates[cIdx];
    const targetUrl = resolveCandidateUrl(base, path);
    const hasMoreCandidates = cIdx < candidates.length - 1;

    for (let attempt = 0; attempt < 2; attempt++) {
      let res: Response;
      try {
        res = await fetch(targetUrl, {
          method: options.method || 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            Accept: 'application/json'
          },
          body: options.body !== undefined ? JSON.stringify(options.body) : undefined
        });
      } catch (err: any) {
        lastError = new Error(
          `Network error reaching Telegram Bot Manager API${err?.message ? ` (${err.message})` : ''}.`
        );
        if (attempt === 0) {
          await sleepMs(350);
          continue;
        }
        break;
      }

      if (res.status === 401 && attempt === 0) {
        try {
          token = await user.getIdToken(true);
          continue;
        } catch {
          // Fall through
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
            'Telegram API backend is not connected on this host (received HTML instead of JSON). Deploy the Cloudflare Worker in cloudflare-worker/ and set VITE_TELEGRAM_API_URL in .env.production before building.'
          );
        }

        if ((res.status === 502 || res.status === 503 || res.status === 504) && attempt === 0) {
          await sleepMs(350);
          continue;
        }
        if (hasMoreCandidates && (res.status === 404 || res.status >= 502)) {
          lastError = new Error(`Telegram API request failed (${res.status}).`);
          break;
        }
        if (!res.ok) {
          throw new Error(`Telegram API request failed (${res.status}).`);
        }
        throw new Error('Telegram API returned an unexpected non-JSON response.');
      }

      let data: Record<string, unknown>;
      try {
        const parsed = rawText ? JSON.parse(rawText) : {};
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('Invalid JSON object');
        }
        data = parsed as Record<string, unknown>;
      } catch {
        throw new Error(`Telegram API returned malformed JSON (HTTP ${res.status}).`);
      }

      if (res.status === 404 && data.code === 'ENDPOINT_NOT_FOUND' && hasMoreCandidates) {
        break;
      }

      if (!res.ok) {
        const errMsg =
          (typeof data.error === 'string' && data.error) ||
          (typeof data.message === 'string' && data.message) ||
          `Request failed (${res.status})`;
        throw new Error(errMsg);
      }

      return data as unknown as T;
    }
  }

  if (sawHtmlFallback && !lastError) {
    throw new Error(
      'Telegram API backend is not connected on this host (received HTML instead of JSON). Deploy the Cloudflare Worker in cloudflare-worker/ and set VITE_TELEGRAM_API_URL in .env.production before building.'
    );
  }

  throw (
    lastError ||
    new Error(
      'Network error reaching Telegram Bot Manager API. Check your connection and VITE_TELEGRAM_API_URL configuration.'
    )
  );
}

function normalizeDashboardResponse(raw: Partial<TelegramDashboardResponse>): TelegramDashboardResponse {
  const summaryRaw = raw.summary && typeof raw.summary === 'object' ? raw.summary : undefined;
  const paginationRaw =
    raw.logsPagination && typeof raw.logsPagination === 'object' ? raw.logsPagination : undefined;
  const settingsRaw = raw.settings && typeof raw.settings === 'object' ? raw.settings : undefined;

  return {
    summary: {
      totalBots: Number(summaryRaw?.totalBots ?? 0),
      activeBots: Number(summaryRaw?.activeBots ?? 0),
      inactiveBots: Number(summaryRaw?.inactiveBots ?? 0),
      totalNotificationsSent: Number(summaryRaw?.totalNotificationsSent ?? 0),
      totalFailedNotifications: Number(summaryRaw?.totalFailedNotifications ?? 0),
      lastSuccessfulNotificationAt:
        typeof summaryRaw?.lastSuccessfulNotificationAt === 'string'
          ? summaryRaw.lastSuccessfulNotificationAt
          : null
    },
    bots: Array.isArray(raw.bots) ? raw.bots : [],
    logs: Array.isArray(raw.logs) ? raw.logs : [],
    logsPagination: {
      page: Number(paginationRaw?.page ?? 1),
      pageSize: Number(paginationRaw?.pageSize ?? 10),
      total: Number(paginationRaw?.total ?? 0),
      totalPages: Math.max(1, Number(paginationRaw?.totalPages ?? 1))
    },
    jobsByPaymentId:
      raw.jobsByPaymentId && typeof raw.jobsByPaymentId === 'object' ? raw.jobsByPaymentId : {},
    settings: {
      notifyOnResolution: Boolean(settingsRaw?.notifyOnResolution)
    }
  };
}

export async function fetchTelegramDashboard(params: {
  status?: string;
  search?: string;
  page?: number;
  pageSize?: number;
} = {}): Promise<TelegramDashboardResponse> {
  const sp = new URLSearchParams();
  if (params.status && params.status !== 'ALL') sp.set('status', params.status);
  if (params.search?.trim()) sp.set('search', params.search.trim());
  if (params.page) sp.set('page', String(params.page));
  if (params.pageSize) sp.set('pageSize', String(params.pageSize));
  const qs = sp.toString();
  const data = await apiRequest<Partial<TelegramDashboardResponse>>(
    `/api/telegram/dashboard${qs ? `?${qs}` : ''}`
  );
  return normalizeDashboardResponse(data);
}

export async function fetchPaymentNotificationJobs(): Promise<{
  jobsByPaymentId: Record<string, TelegramNotificationJob>;
  logsByPaymentId: Record<string, TelegramNotificationLog[]>;
}> {
  const data = await apiRequest<{
    jobsByPaymentId?: Record<string, TelegramNotificationJob>;
    logsByPaymentId?: Record<string, TelegramNotificationLog[]>;
  }>('/api/telegram/payment-jobs');
  return {
    jobsByPaymentId:
      data.jobsByPaymentId && typeof data.jobsByPaymentId === 'object' ? data.jobsByPaymentId : {},
    logsByPaymentId:
      data.logsByPaymentId && typeof data.logsByPaymentId === 'object' ? data.logsByPaymentId : {}
  };
}

export async function createTelegramBot(input: {
  botName: string;
  token: string;
  chatId: string;
  description?: string;
  isActive: boolean;
}): Promise<TelegramBotConfig> {
  const res = await apiRequest<{ bot: TelegramBotConfig }>('/api/telegram/bots', {
    method: 'POST',
    body: input
  });
  return res.bot;
}

export async function updateTelegramBot(
  botId: string,
  input: {
    botName: string;
    token?: string;
    chatId: string;
    description?: string;
    isActive: boolean;
  }
): Promise<TelegramBotConfig> {
  const res = await apiRequest<{ bot: TelegramBotConfig }>(`/api/telegram/bots/${encodeURIComponent(botId)}`, {
    method: 'PUT',
    body: input
  });
  return res.bot;
}

export async function toggleTelegramBotStatus(
  botId: string,
  isActive: boolean
): Promise<TelegramBotConfig> {
  const res = await apiRequest<{ bot: TelegramBotConfig }>(
    `/api/telegram/bots/${encodeURIComponent(botId)}/toggle`,
    {
      method: 'PATCH',
      body: { isActive }
    }
  );
  return res.bot;
}

export async function deleteTelegramBot(botId: string): Promise<void> {
  await apiRequest<{ deleted: boolean }>(`/api/telegram/bots/${encodeURIComponent(botId)}`, {
    method: 'DELETE'
  });
}

export async function testTelegramBotConnection(input: {
  botId?: string;
  token?: string;
  chatId?: string;
  botName?: string;
}): Promise<{ success: boolean; botUsername?: string; message: string; bot?: TelegramBotConfig }> {
  return apiRequest('/api/telegram/bots/test-connection', {
    method: 'POST',
    body: input
  });
}

export async function sendTelegramTestNotification(
  botId: string
): Promise<{ success: boolean; message: string; bot: TelegramBotConfig }> {
  return apiRequest(`/api/telegram/bots/${encodeURIComponent(botId)}/send-test`, {
    method: 'POST',
    body: {}
  });
}

export async function updateTelegramManagerSettings(
  settings: TelegramManagerSettings
): Promise<TelegramManagerSettings> {
  const res = await apiRequest<{ settings: TelegramManagerSettings }>('/api/telegram/settings', {
    method: 'PUT',
    body: settings
  });
  return res.settings || settings;
}

export async function retryTelegramLog(
  logId: string
): Promise<{ log: TelegramNotificationLog; job: TelegramNotificationJob }> {
  return apiRequest(`/api/telegram/logs/${encodeURIComponent(logId)}/retry`, {
    method: 'POST',
    body: {}
  });
}

export async function retryTelegramJobFailed(
  jobId: string
): Promise<{ retriedCount: number; job?: TelegramNotificationJob }> {
  return apiRequest(`/api/telegram/jobs/${encodeURIComponent(jobId)}/retry-failed`, {
    method: 'POST',
    body: {}
  });
}

export async function notifyPaymentSubmitted(paymentRequestId: string): Promise<void> {
  try {
    await apiRequest('/api/telegram/notify-payment', {
      method: 'POST',
      body: { paymentRequestId }
    });
  } catch (err) {
    // Non-blocking: payment is already stored safely in Firestore & Admin Panel.
    console.warn('Telegram notification dispatch note:', (err as Error).message);
  }
}

export async function notifyPaymentResolution(
  paymentRequestId: string,
  status: 'approved' | 'rejected',
  adminNote?: string
): Promise<void> {
  try {
    await apiRequest('/api/telegram/notify-resolution', {
      method: 'POST',
      body: { paymentRequestId, status, adminNote }
    });
  } catch (err) {
    console.warn('Telegram resolution notification note:', (err as Error).message);
  }
}

export async function syncExistingAuthUsers(): Promise<{
  syncedCount: number;
  totalAuthUsers: number;
  alreadySyncedCount: number;
  message?: string;
}> {
  return apiRequest('/api/admin/sync-users', {
    method: 'POST',
    body: {}
  });
}

