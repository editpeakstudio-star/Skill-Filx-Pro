import { getAuth } from 'firebase/auth';
import type {
  TelegramBotConfig,
  TelegramDashboardResponse,
  TelegramManagerSettings,
  TelegramNotificationJob,
  TelegramNotificationLog
} from '../types';

async function getBearerToken(): Promise<string> {
  const auth = getAuth();
  const user = auth.currentUser;
  if (!user) {
    throw new Error('You must be signed in to access Telegram Bot Manager.');
  }
  return user.getIdToken();
}

async function apiRequest<T>(
  path: string,
  options: { method?: string; body?: unknown } = {}
): Promise<T> {
  const token = await getBearerToken();
  const res = await fetch(path, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      Accept: 'application/json'
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined
  });

  const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!res.ok) {
    throw new Error(data.error || data.message || `Request failed (${res.status})`);
  }
  return data as T;
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
  return apiRequest<TelegramDashboardResponse>(`/api/telegram/dashboard${qs ? `?${qs}` : ''}`);
}

export async function fetchPaymentNotificationJobs(): Promise<{
  jobsByPaymentId: Record<string, TelegramNotificationJob>;
  logsByPaymentId: Record<string, TelegramNotificationLog[]>;
}> {
  return apiRequest(`/api/telegram/payment-jobs`);
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
  return res.settings;
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
