import {
  decryptBotToken,
  maskBotToken,
  sanitizeError,
  validateBotTokenFormat,
  validateChatIdFormat
} from './crypto';
import {
  createFirestoreDocIfNotExists,
  getFirestoreDoc,
  listFirestoreCollection,
  upsertFirestoreDoc
} from './firebase';
import {
  HttpError,
  type PaymentRequestDoc,
  type PublicTelegramBot,
  type StoredTelegramBot,
  type TelegramEventType,
  type TelegramJobStatus,
  type TelegramNotificationJob,
  type TelegramNotificationLog,
  type WorkerEnv
} from './types';

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RETRY_ATTEMPTS = 3;

function getTelegramApiBase(env: WorkerEnv): string {
  return (env.TELEGRAM_API_BASE || 'https://api.telegram.org').trim().replace(/\/+$/, '');
}

export function toPublicBot(bot: StoredTelegramBot): PublicTelegramBot {
  const { encryptedToken: _omitted, ...publicFields } = bot;
  return publicFields;
}

export function escapeHtml(text: string): string {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isHttpUrl(url?: string): boolean {
  if (!url) return false;
  return /^https?:\/\/\S+$/i.test(url.trim());
}

function formatDateTimeIST(iso?: string): string {
  try {
    const d = iso ? new Date(iso) : new Date();
    if (Number.isNaN(d.getTime())) return String(iso || '');
    return (
      d.toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
      }) + ' IST'
    );
  } catch {
    return String(iso || new Date().toISOString());
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function mapTelegramError(statusCode: number, description: string): string {
  const lower = description.toLowerCase();
  if (statusCode === 401 || lower.includes('unauthorized')) {
    return 'Invalid or revoked Telegram Bot Token (401 Unauthorized).';
  }
  if (statusCode === 403 || lower.includes('bot was blocked') || lower.includes('kicked')) {
    return 'Bot cannot message this chat (403 Forbidden — user blocked bot or bot not added to group).';
  }
  if (lower.includes('chat not found')) {
    return 'Telegram Chat ID not found. Make sure the user started the bot (/start) or the group ID is correct.';
  }
  if (statusCode === 429) {
    return `Telegram rate limit reached (${description}).`;
  }
  return description || `Telegram API error (HTTP ${statusCode}).`;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500 || status === 408;
}

interface TelegramCallResult<T> {
  ok: boolean;
  result?: T;
  errorCode?: string;
  errorMessage?: string;
  attempts: number;
}

async function callTelegramApi<T>(
  env: WorkerEnv,
  botToken: string,
  method: string,
  payload?: Record<string, unknown>,
  options: { maxAttempts?: number; timeoutMs?: number } = {}
): Promise<TelegramCallResult<T>> {
  const maxAttempts = options.maxAttempts ?? MAX_RETRY_ATTEMPTS;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const url = `${getTelegramApiBase(env)}/bot${botToken}/${method}`;

  let lastErrorCode = 'UNKNOWN';
  let lastErrorMessage = 'Unknown Telegram API error.';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: payload ? 'POST' : 'GET',
        headers: payload
          ? { 'Content-Type': 'application/json', Accept: 'application/json' }
          : { Accept: 'application/json' },
        body: payload ? JSON.stringify(payload) : undefined,
        signal: controller.signal
      });
      clearTimeout(timer);

      type TelegramRawPayload = {
        ok?: boolean;
        result?: T;
        error_code?: number;
        description?: string;
        parameters?: { retry_after?: number };
      } | null;

      let json: TelegramRawPayload = null;
      try {
        json = (await response.json()) as TelegramRawPayload;
      } catch {
        json = null;
      }

      if (response.ok && json?.ok) {
        return { ok: true, result: json.result, attempts: attempt };
      }

      const status = json?.error_code || response.status || 500;
      const rawDesc = json?.description || response.statusText || `HTTP ${status}`;
      lastErrorCode = `TG_${status}`;
      lastErrorMessage = sanitizeError(mapTelegramError(status, rawDesc), [botToken]);

      if (!isRetryableStatus(status) || attempt >= maxAttempts) {
        return {
          ok: false,
          errorCode: lastErrorCode,
          errorMessage: lastErrorMessage,
          attempts: attempt
        };
      }

      const retryAfterSec = json?.parameters?.retry_after;
      const delayMs = retryAfterSec
        ? Math.min(Number(retryAfterSec) * 1000, 10_000)
        : Math.min(400 * Math.pow(2, attempt - 1), 3_000);
      await sleep(delayMs);
    } catch (err: unknown) {
      clearTimeout(timer);
      const isAbort = err instanceof Error && err.name === 'AbortError';
      lastErrorCode = isAbort ? 'TIMEOUT' : 'NETWORK_ERROR';
      lastErrorMessage = sanitizeError(
        isAbort
          ? 'Telegram API request timed out after 10 seconds.'
          : err instanceof Error
            ? err.message
            : 'Network error communicating with Telegram API.',
        [botToken]
      );

      if (attempt >= maxAttempts) {
        return {
          ok: false,
          errorCode: lastErrorCode,
          errorMessage: lastErrorMessage,
          attempts: attempt
        };
      }

      await sleep(Math.min(400 * Math.pow(2, attempt - 1), 3_000));
    }
  }

  return {
    ok: false,
    errorCode: lastErrorCode,
    errorMessage: lastErrorMessage,
    attempts: maxAttempts
  };
}

export function buildPaymentNotificationHtml(
  payment: PaymentRequestDoc,
  eventType: TelegramEventType,
  adminNote?: string
): string {
  const courseOrPlan =
    payment.planType === 'all_access'
      ? 'All-Access Pass (All Courses)'
      : payment.categoryName || payment.categoryId || 'Category Pass';

  const statusBadge =
    eventType === 'payment_approved'
      ? 'PAYMENT APPROVED'
      : eventType === 'payment_rejected'
        ? 'PAYMENT REJECTED'
        : 'PENDING VERIFICATION';

  const headerLine =
    eventType === 'payment_approved'
      ? '✅ <b>Payment Approved — Skill-Flix</b>'
      : eventType === 'payment_rejected'
        ? '❌ <b>Payment Rejected — Skill-Flix</b>'
        : '🔔 <b>New Payment Submitted — Skill-Flix</b>';

  const proofLine = isHttpUrl(payment.proofUrl)
    ? `<b>Proof Link:</b> <a href="${escapeHtml(payment.proofUrl.trim())}">View Payment Screenshot</a>`
    : payment.proofUrl
      ? `<b>Payment Proof:</b> Screenshot attached in Skill-Flix Admin Panel`
      : `<b>Payment Proof:</b> Not provided`;

  const lines = [
    headerLine,
    '',
    `<b>Student Name:</b> ${escapeHtml(payment.userName || 'Student')}`,
    `<b>Student Email:</b> ${escapeHtml(payment.userEmail || 'N/A')}`,
    `<b>Course / Plan:</b> ${escapeHtml(courseOrPlan)}`,
    `<b>Amount Paid:</b> ₹${escapeHtml(String(payment.amount))}`,
    `<b>Payment Method:</b> UPI`,
    `<b>Transaction ID / UTR:</b> <code>${escapeHtml(payment.utr)}</code>`,
    `<b>Submitted At:</b> ${escapeHtml(formatDateTimeIST(payment.submittedAt))}`,
    `<b>Payment Request ID:</b> <code>${escapeHtml(payment.id)}</code>`,
    `<b>Status:</b> ${statusBadge}`,
    proofLine
  ];

  if (adminNote && adminNote.trim()) {
    lines.push(`<b>Admin Note:</b> ${escapeHtml(adminNote.trim())}`);
  }

  return lines.join('\n');
}

export function computeJobOverallStatus(
  sentCount: number,
  failedCount: number,
  totalActive: number
): TelegramJobStatus {
  if (totalActive === 0) return 'SKIPPED_NO_ACTIVE_BOTS';
  if (sentCount > 0 && failedCount === 0) return 'SENT';
  if (sentCount > 0 && failedCount > 0) return 'PARTIAL_FAILURE';
  if (failedCount > 0 && sentCount === 0) return 'FAILED';
  return 'PENDING';
}

export function normalizeStoredBot(raw: Record<string, unknown>): StoredTelegramBot | null {
  if (!raw || typeof raw.id !== 'string' || !raw.encryptedToken || !raw.maskedToken) {
    return null;
  }
  return {
    id: String(raw.id),
    botName: String(raw.botName || 'Telegram Bot'),
    botUsername: typeof raw.botUsername === 'string' ? raw.botUsername : undefined,
    encryptedToken: String(raw.encryptedToken),
    maskedToken: String(raw.maskedToken),
    chatId: String(raw.chatId || ''),
    description: typeof raw.description === 'string' ? raw.description : '',
    isActive: raw.isActive !== false,
    createdAt: String(raw.createdAt || new Date().toISOString()),
    updatedAt: String(raw.updatedAt || new Date().toISOString()),
    createdByUid: typeof raw.createdByUid === 'string' ? raw.createdByUid : undefined,
    createdByEmail: typeof raw.createdByEmail === 'string' ? raw.createdByEmail : undefined,
    lastTestedAt: typeof raw.lastTestedAt === 'string' ? raw.lastTestedAt : undefined,
    lastTestStatus:
      raw.lastTestStatus === 'SUCCESS' || raw.lastTestStatus === 'FAILED'
        ? raw.lastTestStatus
        : undefined,
    lastTestMessage: typeof raw.lastTestMessage === 'string' ? raw.lastTestMessage : undefined,
    lastNotifiedAt: typeof raw.lastNotifiedAt === 'string' ? raw.lastNotifiedAt : undefined,
    lastNotificationStatus:
      raw.lastNotificationStatus === 'SENT' ||
      raw.lastNotificationStatus === 'FAILED' ||
      raw.lastNotificationStatus === 'PENDING' ||
      raw.lastNotificationStatus === 'RETRYING'
        ? raw.lastNotificationStatus
        : undefined,
    lastErrorMessage: typeof raw.lastErrorMessage === 'string' ? raw.lastErrorMessage : undefined,
    totalSentCount: Number(raw.totalSentCount || 0),
    totalFailedCount: Number(raw.totalFailedCount || 0)
  };
}

export function normalizeJob(raw: Record<string, unknown>): TelegramNotificationJob | null {
  if (!raw || typeof raw.id !== 'string') return null;
  return {
    id: String(raw.id),
    paymentRequestId: String(raw.paymentRequestId || raw.id),
    eventType:
      raw.eventType === 'payment_approved' || raw.eventType === 'payment_rejected'
        ? raw.eventType
        : 'payment_submitted',
    studentName: String(raw.studentName || 'Student'),
    studentEmail: String(raw.studentEmail || ''),
    courseName: String(raw.courseName || 'Course'),
    amount: Number(raw.amount || 0),
    utr: String(raw.utr || ''),
    paymentMethod: String(raw.paymentMethod || 'UPI'),
    paymentStatus:
      raw.paymentStatus === 'approved' || raw.paymentStatus === 'rejected'
        ? raw.paymentStatus
        : 'pending',
    overallStatus: (raw.overallStatus as TelegramJobStatus) || 'PENDING',
    totalActiveBots: Number(raw.totalActiveBots || 0),
    sentCount: Number(raw.sentCount || 0),
    failedCount: Number(raw.failedCount || 0),
    createdAt: String(raw.createdAt || new Date().toISOString()),
    updatedAt: String(raw.updatedAt || new Date().toISOString()),
    lastAttemptAt: typeof raw.lastAttemptAt === 'string' ? raw.lastAttemptAt : undefined
  };
}

export function normalizeLog(raw: Record<string, unknown>): TelegramNotificationLog | null {
  if (!raw || typeof raw.id !== 'string') return null;
  return {
    id: String(raw.id),
    jobId: String(raw.jobId || ''),
    paymentRequestId: String(raw.paymentRequestId || ''),
    botId: String(raw.botId || ''),
    botName: String(raw.botName || 'Telegram Bot'),
    chatId: String(raw.chatId || ''),
    eventType:
      raw.eventType === 'payment_approved' || raw.eventType === 'payment_rejected'
        ? raw.eventType
        : 'payment_submitted',
    studentName: String(raw.studentName || 'Student'),
    studentEmail: String(raw.studentEmail || ''),
    courseName: String(raw.courseName || 'Course'),
    amount: Number(raw.amount || 0),
    utr: String(raw.utr || ''),
    status: (raw.status as TelegramNotificationLog['status']) || 'PENDING',
    attemptCount: Number(raw.attemptCount || 1),
    telegramMessageId:
      typeof raw.telegramMessageId === 'number' ? raw.telegramMessageId : undefined,
    errorCode: typeof raw.errorCode === 'string' ? raw.errorCode : undefined,
    errorMessage: typeof raw.errorMessage === 'string' ? raw.errorMessage : undefined,
    createdAt: String(raw.createdAt || new Date().toISOString()),
    updatedAt: String(raw.updatedAt || new Date().toISOString()),
    sentAt: typeof raw.sentAt === 'string' ? raw.sentAt : undefined
  };
}

export async function testBotConnection(
  env: WorkerEnv,
  fsToken: string,
  params: {
    botId?: string;
    token?: string;
    chatId?: string;
    botName?: string;
  }
): Promise<{
  success: boolean;
  botUsername?: string;
  message: string;
  bot?: PublicTelegramBot;
}> {
  let resolvedToken = (params.token || '').trim();
  let resolvedChatId = (params.chatId || '').trim();
  let resolvedName = (params.botName || '').trim() || 'Telegram Bot';
  let existingBot: StoredTelegramBot | null = null;

  if (params.botId) {
    const doc = await getFirestoreDoc(env, fsToken, 'telegramBots', params.botId);
    existingBot = doc ? normalizeStoredBot(doc) : null;
    if (!existingBot) {
      throw new HttpError(404, 'Telegram bot not found.');
    }
    if (!resolvedToken) {
      resolvedToken = await decryptBotToken(existingBot.encryptedToken, env.TELEGRAM_ENCRYPTION_KEY);
    }
    if (!resolvedChatId) {
      resolvedChatId = existingBot.chatId;
    }
    resolvedName = existingBot.botName;
  } else {
    if (!resolvedToken && env.TELEGRAM_BOT_TOKEN) {
      resolvedToken = env.TELEGRAM_BOT_TOKEN.trim();
    }
    if (!resolvedChatId && env.TELEGRAM_CHAT_ID) {
      resolvedChatId = env.TELEGRAM_CHAT_ID.trim();
    }
  }

  const tokenCheck = validateBotTokenFormat(resolvedToken);
  if (!tokenCheck.valid) {
    throw new HttpError(400, tokenCheck.error || 'Invalid Telegram Bot Token format.');
  }
  const chatCheck = validateChatIdFormat(resolvedChatId);
  if (!chatCheck.valid) {
    throw new HttpError(400, chatCheck.error || 'Invalid Telegram Chat ID format.');
  }

  const meRes = await callTelegramApi<{ id: number; username?: string; first_name?: string }>(
    env,
    resolvedToken,
    'getMe',
    undefined,
    { maxAttempts: 2 }
  );

  if (!meRes.ok || !meRes.result) {
    const failMsg = meRes.errorMessage || 'Bot token verification failed.';
    if (existingBot) {
      const now = new Date().toISOString();
      const updatedBot: StoredTelegramBot = {
        ...existingBot,
        lastTestedAt: now,
        lastTestStatus: 'FAILED',
        lastTestMessage: failMsg,
        updatedAt: now
      };
      await upsertFirestoreDoc(
        env,
        fsToken,
        'telegramBots',
        existingBot.id,
        updatedBot as unknown as Record<string, unknown>
      );
      return { success: false, message: failMsg, bot: toPublicBot(updatedBot) };
    }
    return { success: false, message: failMsg };
  }

  const botUsername = meRes.result.username ? `@${meRes.result.username}` : meRes.result.first_name;

  const pingText = [
    `🤖 <b>Connection Verified — Skill-Flix</b>`,
    '',
    `<b>Bot Name:</b> ${escapeHtml(resolvedName)} (${escapeHtml(botUsername || 'Verified Bot')})`,
    `<b>Target Chat ID:</b> <code>${escapeHtml(resolvedChatId)}</code>`,
    `<b>Checked At:</b> ${escapeHtml(formatDateTimeIST())}`,
    '',
    `Your Skill-Flix payment notification channel is active and ready.`
  ].join('\n');

  const msgRes = await callTelegramApi<{ message_id: number }>(
    env,
    resolvedToken,
    'sendMessage',
    {
      chat_id: resolvedChatId,
      text: pingText,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    },
    { maxAttempts: 2 }
  );

  const now = new Date().toISOString();
  const success = msgRes.ok;
  const message = success
    ? `Connected to ${botUsername || 'bot'} and delivered verification message to ${resolvedChatId}.`
    : msgRes.errorMessage || 'Failed to deliver verification message to target Chat ID.';

  if (existingBot) {
    const updatedBot: StoredTelegramBot = {
      ...existingBot,
      botUsername,
      lastTestedAt: now,
      lastTestStatus: success ? 'SUCCESS' : 'FAILED',
      lastTestMessage: message,
      updatedAt: now
    };
    await upsertFirestoreDoc(
      env,
      fsToken,
      'telegramBots',
      existingBot.id,
      updatedBot as unknown as Record<string, unknown>
    );
    return {
      success,
      botUsername,
      message,
      bot: toPublicBot(updatedBot)
    };
  }

  return { success, botUsername, message };
}

export async function sendTestPaymentNotification(
  env: WorkerEnv,
  fsToken: string,
  botId: string
): Promise<{ success: boolean; message: string; bot: PublicTelegramBot }> {
  const doc = await getFirestoreDoc(env, fsToken, 'telegramBots', botId);
  const bot = doc ? normalizeStoredBot(doc) : null;
  if (!bot) {
    throw new HttpError(404, 'Telegram bot not found.');
  }

  const token = await decryptBotToken(bot.encryptedToken, env.TELEGRAM_ENCRYPTION_KEY);
  const sampleHtml = [
    `🧪 <b>Test Payment Notification — Skill-Flix</b>`,
    '',
    `<b>Bot:</b> ${escapeHtml(bot.botName)}`,
    `<b>Student Name:</b> Test Student (Sample)`,
    `<b>Student Email:</b> student@example.com`,
    `<b>Course / Plan:</b> All-Access Pass (All Courses)`,
    `<b>Amount Paid:</b> ₹999`,
    `<b>Payment Method:</b> UPI`,
    `<b>Transaction ID / UTR:</b> <code>TESTUTR${Date.now().toString().slice(-6)}</code>`,
    `<b>Submitted At:</b> ${escapeHtml(formatDateTimeIST())}`,
    `<b>Status:</b> PENDING VERIFICATION (TEST)`
  ].join('\n');

  const res = await callTelegramApi<{ message_id: number }>(
    env,
    token,
    'sendMessage',
    {
      chat_id: bot.chatId,
      text: sampleHtml,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    },
    { maxAttempts: 2 }
  );

  const now = new Date().toISOString();
  const statusMsg = res.ok
    ? `Test payment alert delivered (Message #${res.result?.message_id || 'OK'}).`
    : res.errorMessage || 'Test notification failed.';

  const updatedBot: StoredTelegramBot = {
    ...bot,
    lastTestedAt: now,
    lastTestStatus: res.ok ? 'SUCCESS' : 'FAILED',
    lastTestMessage: statusMsg,
    updatedAt: now
  };

  await upsertFirestoreDoc(
    env,
    fsToken,
    'telegramBots',
    bot.id,
    updatedBot as unknown as Record<string, unknown>
  );

  return {
    success: res.ok,
    message: statusMsg,
    bot: toPublicBot(updatedBot)
  };
}

export async function dispatchPaymentNotification(
  env: WorkerEnv,
  fsToken: string,
  payment: PaymentRequestDoc,
  eventType: TelegramEventType = 'payment_submitted',
  options: { adminNote?: string } = {}
): Promise<{ job: TelegramNotificationJob; logs: TelegramNotificationLog[]; deduplicated?: boolean }> {
  const courseName =
    payment.planType === 'all_access'
      ? 'All-Access Pass'
      : payment.categoryName || payment.categoryId || 'Category Pass';

  const jobId =
    eventType === 'payment_submitted' ? payment.id : `${payment.id}__${eventType}`;

  const rawBots = await listFirestoreCollection(env, fsToken, 'telegramBots');
  const activeBots = rawBots
    .map(normalizeStoredBot)
    .filter((b): b is StoredTelegramBot => Boolean(b && b.isActive));

  const envBotToken = (env.TELEGRAM_BOT_TOKEN || '').trim();
  const envChatId = (env.TELEGRAM_CHAT_ID || '').trim();
  const useEnvFallbackBot = activeBots.length === 0 && Boolean(envBotToken && envChatId);

  const dispatchTargets: Array<{
    bot: StoredTelegramBot;
    isEnvSecretBot: boolean;
  }> = activeBots.map(bot => ({ bot, isEnvSecretBot: false }));

  if (useEnvFallbackBot) {
    const nowEnv = new Date().toISOString();
    dispatchTargets.push({
      isEnvSecretBot: true,
      bot: {
        id: 'env_secret_bot',
        botName: 'Environment Secret Bot',
        encryptedToken: '',
        maskedToken: maskBotToken(envBotToken),
        chatId: envChatId,
        description: 'Configured via Cloudflare Worker Secrets (TELEGRAM_BOT_TOKEN)',
        isActive: true,
        createdAt: nowEnv,
        updatedAt: nowEnv,
        totalSentCount: 0,
        totalFailedCount: 0
      }
    });
  }

  const now = new Date().toISOString();

  const initialJob: TelegramNotificationJob = {
    id: jobId,
    paymentRequestId: payment.id,
    eventType,
    studentName: payment.userName,
    studentEmail: payment.userEmail,
    courseName,
    amount: payment.amount,
    utr: payment.utr,
    paymentMethod: 'UPI',
    paymentStatus: payment.status,
    overallStatus: dispatchTargets.length === 0 ? 'SKIPPED_NO_ACTIVE_BOTS' : 'PENDING',
    totalActiveBots: dispatchTargets.length,
    sentCount: 0,
    failedCount: 0,
    createdAt: now,
    updatedAt: now,
    lastAttemptAt: now
  };

  // Atomic idempotency claim prevents duplicate Telegram alerts on double-clicks / retries
  const claimed = await createFirestoreDocIfNotExists(
    env,
    fsToken,
    'telegramNotificationJobs',
    jobId,
    initialJob as unknown as Record<string, unknown>
  );

  if (!claimed) {
    const existingJobRaw = await getFirestoreDoc(env, fsToken, 'telegramNotificationJobs', jobId);
    const allLogsRaw = await listFirestoreCollection(env, fsToken, 'telegramNotificationLogs');
    const existingLogs = allLogsRaw
      .map(normalizeLog)
      .filter((l): l is TelegramNotificationLog => Boolean(l && l.jobId === jobId));
    return {
      job: (existingJobRaw && normalizeJob(existingJobRaw)) || initialJob,
      logs: existingLogs,
      deduplicated: true
    };
  }

  if (dispatchTargets.length === 0) {
    return { job: initialJob, logs: [] };
  }

  const messageHtml = buildPaymentNotificationHtml(payment, eventType, options.adminNote);

  const settled = await Promise.allSettled(
    dispatchTargets.map(async ({ bot, isEnvSecretBot }) => {
      const logId = `${jobId}__${bot.id}`;
      let plainToken = '';
      try {
        plainToken = isEnvSecretBot
          ? envBotToken
          : await decryptBotToken(bot.encryptedToken, env.TELEGRAM_ENCRYPTION_KEY);
      } catch (err) {
        return {
          botId: bot.id,
          logId,
          ok: false,
          attempts: 1,
          errorCode: 'DECRYPT_ERROR',
          errorMessage: sanitizeError((err as Error).message, [envBotToken])
        };
      }

      const result = await callTelegramApi<{ message_id: number }>(env, plainToken, 'sendMessage', {
        chat_id: bot.chatId,
        text: messageHtml,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      });

      return {
        botId: bot.id,
        logId,
        ok: result.ok,
        attempts: result.attempts,
        messageId: result.result?.message_id,
        errorCode: result.errorCode,
        errorMessage: result.errorMessage
      };
    })
  );

  const completedAt = new Date().toISOString();
  const finalLogs: TelegramNotificationLog[] = [];
  const updatedBots: StoredTelegramBot[] = [];
  let sentCount = 0;
  let failedCount = 0;

  settled.forEach((outcome, index) => {
    const { bot, isEnvSecretBot } = dispatchTargets[index];
    const logId = `${jobId}__${bot.id}`;

    if (outcome.status === 'fulfilled' && outcome.value.ok) {
      sentCount++;
      finalLogs.push({
        id: logId,
        jobId,
        paymentRequestId: payment.id,
        botId: bot.id,
        botName: bot.botName,
        chatId: bot.chatId,
        eventType,
        studentName: payment.userName,
        studentEmail: payment.userEmail,
        courseName,
        amount: payment.amount,
        utr: payment.utr,
        status: 'SENT',
        attemptCount: outcome.value.attempts,
        telegramMessageId: outcome.value.messageId,
        createdAt: now,
        updatedAt: completedAt,
        sentAt: completedAt
      });

      if (!isEnvSecretBot) {
        updatedBots.push({
          ...bot,
          totalSentCount: (bot.totalSentCount || 0) + 1,
          lastNotifiedAt: completedAt,
          lastNotificationStatus: 'SENT',
          lastErrorMessage: undefined,
          updatedAt: completedAt
        });
      }
    } else {
      failedCount++;
      const errCode =
        outcome.status === 'fulfilled' ? outcome.value.errorCode || 'FAILED' : 'UNEXPECTED_ERROR';
      const errMsg =
        outcome.status === 'fulfilled'
          ? outcome.value.errorMessage || 'Failed to deliver Telegram notification.'
          : sanitizeError(String(outcome.reason || 'Unexpected worker failure.'), [envBotToken]);

      finalLogs.push({
        id: logId,
        jobId,
        paymentRequestId: payment.id,
        botId: bot.id,
        botName: bot.botName,
        chatId: bot.chatId,
        eventType,
        studentName: payment.userName,
        studentEmail: payment.userEmail,
        courseName,
        amount: payment.amount,
        utr: payment.utr,
        status: 'FAILED',
        attemptCount: outcome.status === 'fulfilled' ? outcome.value.attempts : 1,
        errorCode: errCode,
        errorMessage: errMsg,
        createdAt: now,
        updatedAt: completedAt
      });

      if (!isEnvSecretBot) {
        updatedBots.push({
          ...bot,
          totalFailedCount: (bot.totalFailedCount || 0) + 1,
          lastNotifiedAt: completedAt,
          lastNotificationStatus: 'FAILED',
          lastErrorMessage: errMsg,
          updatedAt: completedAt
        });
      }
    }
  });

  const finalJob: TelegramNotificationJob = {
    ...initialJob,
    sentCount,
    failedCount,
    overallStatus: computeJobOverallStatus(sentCount, failedCount, dispatchTargets.length),
    updatedAt: completedAt,
    lastAttemptAt: completedAt
  };

  await Promise.allSettled([
    upsertFirestoreDoc(
      env,
      fsToken,
      'telegramNotificationJobs',
      finalJob.id,
      finalJob as unknown as Record<string, unknown>
    ),
    ...finalLogs.map(log =>
      upsertFirestoreDoc(
        env,
        fsToken,
        'telegramNotificationLogs',
        log.id,
        log as unknown as Record<string, unknown>
      )
    ),
    ...updatedBots.map(bot =>
      upsertFirestoreDoc(
        env,
        fsToken,
        'telegramBots',
        bot.id,
        bot as unknown as Record<string, unknown>
      )
    )
  ]);

  return { job: finalJob, logs: finalLogs };
}

export async function retryFailedNotificationLog(
  env: WorkerEnv,
  fsToken: string,
  logId: string
): Promise<{ log: TelegramNotificationLog; job: TelegramNotificationJob }> {
  const logRaw = await getFirestoreDoc(env, fsToken, 'telegramNotificationLogs', logId);
  const targetLog = logRaw ? normalizeLog(logRaw) : null;
  if (!targetLog) {
    throw new HttpError(404, 'Notification log entry not found.');
  }
  if (targetLog.status === 'SENT') {
    throw new HttpError(
      400,
      'This notification has already been delivered (SENT). Duplicate retries are blocked.'
    );
  }

  const isEnvSecretBot = targetLog.botId === 'env_secret_bot';
  let bot: StoredTelegramBot | null = null;
  let plainToken = '';

  if (isEnvSecretBot) {
    const envToken = (env.TELEGRAM_BOT_TOKEN || '').trim();
    const envChat = (env.TELEGRAM_CHAT_ID || targetLog.chatId || '').trim();
    if (!envToken || !envChat) {
      throw new HttpError(
        400,
        'Environment Secret Bot is not configured (missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID).'
      );
    }
    plainToken = envToken;
    bot = {
      id: 'env_secret_bot',
      botName: 'Environment Secret Bot',
      encryptedToken: '',
      maskedToken: maskBotToken(envToken),
      chatId: envChat,
      isActive: true,
      createdAt: targetLog.createdAt,
      updatedAt: targetLog.updatedAt,
      totalSentCount: 0,
      totalFailedCount: 0
    };
  } else {
    const botRaw = await getFirestoreDoc(env, fsToken, 'telegramBots', targetLog.botId);
    bot = botRaw ? normalizeStoredBot(botRaw) : null;
    if (!bot) {
      throw new HttpError(404, 'The configured Telegram bot for this log no longer exists.');
    }
    if (!bot.isActive) {
      throw new HttpError(
        400,
        `Bot "${bot.botName}" is currently inactive. Activate it before retrying.`
      );
    }
    plainToken = await decryptBotToken(bot.encryptedToken, env.TELEGRAM_ENCRYPTION_KEY);
  }

  const [jobRaw, paymentRaw] = await Promise.all([
    getFirestoreDoc(env, fsToken, 'telegramNotificationJobs', targetLog.jobId),
    getFirestoreDoc(env, fsToken, 'paymentRequests', targetLog.paymentRequestId).catch(() => null)
  ]);

  const parentJob = jobRaw ? normalizeJob(jobRaw) : null;
  const payment: PaymentRequestDoc = paymentRaw
    ? (paymentRaw as unknown as PaymentRequestDoc)
    : {
        id: targetLog.paymentRequestId,
        uid: '',
        userEmail: targetLog.studentEmail,
        userName: targetLog.studentName,
        planType: targetLog.courseName === 'All-Access Pass' ? 'all_access' : 'category',
        categoryName: targetLog.courseName,
        amount: targetLog.amount,
        utr: targetLog.utr,
        proofUrl: '',
        status: parentJob?.paymentStatus || 'pending',
        submittedAt: parentJob?.createdAt || targetLog.createdAt
      };

  const messageHtml = buildPaymentNotificationHtml(payment, targetLog.eventType);
  const res = await callTelegramApi<{ message_id: number }>(env, plainToken, 'sendMessage', {
    chat_id: bot.chatId,
    text: messageHtml,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  });

  const now = new Date().toISOString();
  const updatedLog: TelegramNotificationLog = {
    ...targetLog,
    attemptCount: (targetLog.attemptCount || 1) + res.attempts,
    updatedAt: now,
    status: res.ok ? 'SENT' : 'FAILED',
    telegramMessageId: res.ok ? res.result?.message_id : targetLog.telegramMessageId,
    errorCode: res.ok ? undefined : res.errorCode || 'FAILED',
    errorMessage: res.ok ? undefined : res.errorMessage || 'Retry delivery failed.',
    sentAt: res.ok ? now : targetLog.sentAt
  };

  const updatedBot: StoredTelegramBot = {
    ...bot,
    totalSentCount: res.ok ? (bot.totalSentCount || 0) + 1 : bot.totalSentCount,
    totalFailedCount: res.ok ? bot.totalFailedCount : (bot.totalFailedCount || 0) + 1,
    lastNotifiedAt: now,
    lastNotificationStatus: res.ok ? 'SENT' : 'FAILED',
    lastErrorMessage: res.ok ? undefined : updatedLog.errorMessage,
    updatedAt: now
  };

  const writes: Promise<void>[] = [
    upsertFirestoreDoc(
      env,
      fsToken,
      'telegramNotificationLogs',
      updatedLog.id,
      updatedLog as unknown as Record<string, unknown>
    )
  ];
  if (!isEnvSecretBot) {
    writes.push(
      upsertFirestoreDoc(
        env,
        fsToken,
        'telegramBots',
        updatedBot.id,
        updatedBot as unknown as Record<string, unknown>
      )
    );
  }
  await Promise.all(writes);

  const allLogsRaw = await listFirestoreCollection(env, fsToken, 'telegramNotificationLogs');
  const siblingLogs = allLogsRaw
    .map(normalizeLog)
    .filter((l): l is TelegramNotificationLog => Boolean(l && l.jobId === targetLog.jobId));

  const sentCount = siblingLogs.filter(item => item.status === 'SENT').length;
  const failedCount = siblingLogs.filter(item => item.status === 'FAILED').length;

  const updatedJob: TelegramNotificationJob = parentJob
    ? {
        ...parentJob,
        sentCount,
        failedCount,
        overallStatus: computeJobOverallStatus(sentCount, failedCount, siblingLogs.length),
        updatedAt: now,
        lastAttemptAt: now
      }
    : {
        id: targetLog.jobId,
        paymentRequestId: targetLog.paymentRequestId,
        eventType: targetLog.eventType,
        studentName: targetLog.studentName,
        studentEmail: targetLog.studentEmail,
        courseName: targetLog.courseName,
        amount: targetLog.amount,
        utr: targetLog.utr,
        paymentMethod: 'UPI',
        paymentStatus: payment.status,
        overallStatus: computeJobOverallStatus(sentCount, failedCount, siblingLogs.length),
        totalActiveBots: siblingLogs.length,
        sentCount,
        failedCount,
        createdAt: targetLog.createdAt,
        updatedAt: now,
        lastAttemptAt: now
      };

  await upsertFirestoreDoc(
    env,
    fsToken,
    'telegramNotificationJobs',
    updatedJob.id,
    updatedJob as unknown as Record<string, unknown>
  );

  return { log: updatedLog, job: updatedJob };
}

export async function retryFailedJobLogs(
  env: WorkerEnv,
  fsToken: string,
  jobId: string
): Promise<{ retriedCount: number; job: TelegramNotificationJob | undefined }> {
  const [allLogsRaw, jobRaw] = await Promise.all([
    listFirestoreCollection(env, fsToken, 'telegramNotificationLogs'),
    getFirestoreDoc(env, fsToken, 'telegramNotificationJobs', jobId)
  ]);

  const failedLogs = allLogsRaw
    .map(normalizeLog)
    .filter((l): l is TelegramNotificationLog => Boolean(l && l.jobId === jobId && l.status === 'FAILED'));

  let latestJob = jobRaw ? normalizeJob(jobRaw) || undefined : undefined;
  let retriedCount = 0;

  for (const log of failedLogs) {
    try {
      const outcome = await retryFailedNotificationLog(env, fsToken, log.id);
      latestJob = outcome.job;
      retriedCount++;
    } catch (err) {
      console.warn(`Retry skipped for log ${log.id}:`, (err as Error).message);
    }
  }

  return { retriedCount, job: latestJob };
}
