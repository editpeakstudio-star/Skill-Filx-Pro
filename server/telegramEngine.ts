import type {
  PaymentRequest,
  TelegramEventType,
  TelegramJobStatus,
  TelegramNotificationJob,
  TelegramNotificationLog
} from '../src/types/index.ts';
import {
  decryptBotToken,
  sanitizeErrorMessage,
  validateBotTokenFormat,
  validateChatIdFormat
} from './telegramCrypto.ts';
import {
  mutateStore,
  readStoreSnapshot,
  syncBotToFirestore,
  syncJobAndLogsToFirestore,
  toPublicBot
} from './telegramStore.ts';
import type { StoredTelegramBot } from './telegramStore.ts';

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RETRY_ATTEMPTS = 3;

function getTelegramApiBase(): string {
  return (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');
}

function escapeHtml(text: string): string {
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
    return d.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true
    }) + ' IST';
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
  botToken: string,
  method: string,
  payload?: Record<string, unknown>,
  options: { maxAttempts?: number; timeoutMs?: number } = {}
): Promise<TelegramCallResult<T>> {
  const maxAttempts = options.maxAttempts ?? MAX_RETRY_ATTEMPTS;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const apiBase = getTelegramApiBase();
  const url = `${apiBase}/bot${botToken}/${method}`;

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
      lastErrorMessage = sanitizeErrorMessage(mapTelegramError(status, rawDesc), [botToken]);

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
      lastErrorMessage = sanitizeErrorMessage(
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
  payment: PaymentRequest,
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

export async function testBotConnection(params: {
  botId?: string;
  token?: string;
  chatId?: string;
  botName?: string;
  idToken?: string;
}): Promise<{
  success: boolean;
  botUsername?: string;
  message: string;
  bot?: ReturnType<typeof toPublicBot>;
}> {
  let resolvedToken = params.token?.trim() || '';
  let resolvedChatId = params.chatId?.trim() || '';
  let resolvedName = params.botName?.trim() || 'Telegram Bot';
  let existingBot: StoredTelegramBot | undefined;

  if (params.botId) {
    const snap = readStoreSnapshot();
    existingBot = snap.bots[params.botId];
    if (!existingBot) {
      throw new Error('Telegram bot not found.');
    }
    if (!resolvedToken) {
      resolvedToken = decryptBotToken(existingBot.encryptedToken);
    }
    if (!resolvedChatId) {
      resolvedChatId = existingBot.chatId;
    }
    resolvedName = existingBot.botName;
  }

  const tokenCheck = validateBotTokenFormat(resolvedToken);
  if (!tokenCheck.valid) {
    throw new Error(tokenCheck.error);
  }
  const chatCheck = validateChatIdFormat(resolvedChatId);
  if (!chatCheck.valid) {
    throw new Error(chatCheck.error);
  }

  const meRes = await callTelegramApi<{ id: number; username?: string; first_name?: string }>(
    resolvedToken,
    'getMe',
    undefined,
    { maxAttempts: 2 }
  );

  if (!meRes.ok || !meRes.result) {
    const failMsg = meRes.errorMessage || 'Bot token verification failed.';
    if (existingBot) {
      const updated = await mutateStore(store => {
        const b = store.bots[existingBot!.id];
        if (!b) return undefined;
        b.lastTestedAt = new Date().toISOString();
        b.lastTestStatus = 'FAILED';
        b.lastTestMessage = failMsg;
        b.updatedAt = new Date().toISOString();
        return b;
      });
      if (updated) void syncBotToFirestore(updated, params.idToken);
      return { success: false, message: failMsg, bot: updated ? toPublicBot(updated) : undefined };
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
    const updated = await mutateStore(store => {
      const b = store.bots[existingBot!.id];
      if (!b) return undefined;
      b.botUsername = botUsername;
      b.lastTestedAt = now;
      b.lastTestStatus = success ? 'SUCCESS' : 'FAILED';
      b.lastTestMessage = message;
      b.updatedAt = now;
      return b;
    });
    if (updated) void syncBotToFirestore(updated, params.idToken);
    return {
      success,
      botUsername,
      message,
      bot: updated ? toPublicBot(updated) : undefined
    };
  }

  return { success, botUsername, message };
}

export async function sendTestPaymentNotification(
  botId: string,
  idToken?: string
): Promise<{ success: boolean; message: string; bot: ReturnType<typeof toPublicBot> }> {
  const snap = readStoreSnapshot();
  const bot = snap.bots[botId];
  if (!bot) {
    throw new Error('Telegram bot not found.');
  }

  const token = decryptBotToken(bot.encryptedToken);
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
  const updated = await mutateStore(store => {
    const target = store.bots[botId];
    if (!target) throw new Error('Telegram bot disappeared.');
    target.lastTestedAt = now;
    target.lastTestStatus = res.ok ? 'SUCCESS' : 'FAILED';
    target.lastTestMessage = res.ok
      ? `Test payment alert delivered (Message #${res.result?.message_id || 'OK'}).`
      : res.errorMessage || 'Test notification failed.';
    target.updatedAt = now;
    return target;
  });

  void syncBotToFirestore(updated, idToken);

  return {
    success: res.ok,
    message: updated.lastTestMessage || 'Completed.',
    bot: toPublicBot(updated)
  };
}

function computeJobOverallStatus(sentCount: number, failedCount: number, totalActive: number): TelegramJobStatus {
  if (totalActive === 0) return 'SKIPPED_NO_ACTIVE_BOTS';
  if (sentCount > 0 && failedCount === 0) return 'SENT';
  if (sentCount > 0 && failedCount > 0) return 'PARTIAL_FAILURE';
  if (failedCount > 0 && sentCount === 0) return 'FAILED';
  return 'PENDING';
}

export async function dispatchPaymentNotification(
  payment: PaymentRequest,
  eventType: TelegramEventType = 'payment_submitted',
  options: { idToken?: string; adminNote?: string } = {}
): Promise<{ job: TelegramNotificationJob; logs: TelegramNotificationLog[]; deduplicated?: boolean }> {
  const courseName =
    payment.planType === 'all_access'
      ? 'All-Access Pass'
      : payment.categoryName || payment.categoryId || 'Category Pass';

  // Idempotency key: initial payment_submitted uses exact payment.id; resolution uses suffix
  const jobId =
    eventType === 'payment_submitted'
      ? payment.id
      : `${payment.id}__${eventType}`;

  const existingSnap = readStoreSnapshot();
  const existingJob = existingSnap.jobs[jobId];
  if (existingJob && existingJob.overallStatus !== 'PENDING') {
    const existingLogs = Object.values(existingSnap.logs).filter(l => l.jobId === jobId);
    return { job: existingJob, logs: existingLogs, deduplicated: true };
  }

  const activeBots = Object.values(existingSnap.bots).filter(b => b.isActive);
  const now = new Date().toISOString();

  if (activeBots.length === 0) {
    const skippedJob: TelegramNotificationJob = {
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
      overallStatus: 'SKIPPED_NO_ACTIVE_BOTS',
      totalActiveBots: 0,
      sentCount: 0,
      failedCount: 0,
      createdAt: existingJob?.createdAt || now,
      updatedAt: now,
      lastAttemptAt: now
    };
    await mutateStore(store => {
      store.jobs[jobId] = skippedJob;
    });
    void syncJobAndLogsToFirestore(skippedJob, [], options.idToken);
    return { job: skippedJob, logs: [] };
  }

  const messageHtml = buildPaymentNotificationHtml(payment, eventType, options.adminNote);

  // Create initial PENDING job + log records per active bot
  const initialLogs: TelegramNotificationLog[] = activeBots.map(bot => ({
    id: `${jobId}__${bot.id}`,
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
    status: 'PENDING',
    attemptCount: 0,
    createdAt: now,
    updatedAt: now
  }));

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
    overallStatus: 'PENDING',
    totalActiveBots: activeBots.length,
    sentCount: 0,
    failedCount: 0,
    createdAt: existingJob?.createdAt || now,
    updatedAt: now,
    lastAttemptAt: now
  };

  await mutateStore(store => {
    store.jobs[jobId] = initialJob;
    for (const log of initialLogs) {
      store.logs[log.id] = log;
    }
  });

  // Deliver to all active bots concurrently with isolated error handling
  const settled = await Promise.allSettled(
    activeBots.map(async bot => {
      const logId = `${jobId}__${bot.id}`;
      let plainToken = '';
      try {
        plainToken = decryptBotToken(bot.encryptedToken);
      } catch (err) {
        return {
          botId: bot.id,
          logId,
          ok: false,
          attempts: 1,
          errorCode: 'DECRYPT_ERROR',
          errorMessage: sanitizeErrorMessage((err as Error).message)
        };
      }

      const result = await callTelegramApi<{ message_id: number }>(plainToken, 'sendMessage', {
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

  const finalOutcome = await mutateStore(store => {
    const job = store.jobs[jobId] || initialJob;
    const updatedLogs: TelegramNotificationLog[] = [];
    let sentCount = 0;
    let failedCount = 0;

    settled.forEach((outcome, index) => {
      const bot = activeBots[index];
      const logId = `${jobId}__${bot.id}`;
      const log = store.logs[logId];
      if (!log) return;

      if (outcome.status === 'fulfilled' && outcome.value.ok) {
        sentCount++;
        log.status = 'SENT';
        log.attemptCount = outcome.value.attempts;
        log.telegramMessageId = outcome.value.messageId;
        log.errorCode = undefined;
        log.errorMessage = undefined;
        log.sentAt = completedAt;
        log.updatedAt = completedAt;

        const targetBot = store.bots[bot.id];
        if (targetBot) {
          targetBot.totalSentCount = (targetBot.totalSentCount || 0) + 1;
          targetBot.lastNotifiedAt = completedAt;
          targetBot.lastNotificationStatus = 'SENT';
          targetBot.lastErrorMessage = undefined;
          targetBot.updatedAt = completedAt;
        }
      } else {
        failedCount++;
        const errCode =
          outcome.status === 'fulfilled' ? outcome.value.errorCode || 'FAILED' : 'UNEXPECTED_ERROR';
        const errMsg =
          outcome.status === 'fulfilled'
            ? outcome.value.errorMessage || 'Failed to deliver Telegram notification.'
            : sanitizeErrorMessage(String(outcome.reason || 'Unexpected worker failure.'));

        log.status = 'FAILED';
        log.attemptCount = outcome.status === 'fulfilled' ? outcome.value.attempts : 1;
        log.errorCode = errCode;
        log.errorMessage = errMsg;
        log.updatedAt = completedAt;

        const targetBot = store.bots[bot.id];
        if (targetBot) {
          targetBot.totalFailedCount = (targetBot.totalFailedCount || 0) + 1;
          targetBot.lastNotifiedAt = completedAt;
          targetBot.lastNotificationStatus = 'FAILED';
          targetBot.lastErrorMessage = errMsg;
          targetBot.updatedAt = completedAt;
        }
      }

      updatedLogs.push(log);
    });

    job.sentCount = sentCount;
    job.failedCount = failedCount;
    job.overallStatus = computeJobOverallStatus(sentCount, failedCount, activeBots.length);
    job.updatedAt = completedAt;
    job.lastAttemptAt = completedAt;

    return { job, logs: updatedLogs, botsToSync: activeBots.map(b => store.bots[b.id]).filter(Boolean) };
  });

  void syncJobAndLogsToFirestore(finalOutcome.job, finalOutcome.logs, options.idToken);
  if (options.idToken) {
    for (const bot of finalOutcome.botsToSync) {
      void syncBotToFirestore(bot, options.idToken);
    }
  }

  return { job: finalOutcome.job, logs: finalOutcome.logs };
}

/**
 * Retries a single FAILED notification log idempotently without touching any other bot.
 */
export async function retryFailedNotificationLog(
  logId: string,
  paymentLookup: (paymentRequestId: string) => Promise<PaymentRequest | null>,
  idToken?: string
): Promise<{ log: TelegramNotificationLog; job: TelegramNotificationJob }> {
  const snap = readStoreSnapshot();
  const targetLog = snap.logs[logId];
  if (!targetLog) {
    throw new Error('Notification log entry not found.');
  }
  if (targetLog.status === 'SENT') {
    throw new Error('This notification has already been delivered (SENT). Duplicate retries are blocked.');
  }

  const bot = snap.bots[targetLog.botId];
  if (!bot) {
    throw new Error('The configured Telegram bot for this log no longer exists.');
  }
  if (!bot.isActive) {
    throw new Error(`Bot "${bot.botName}" is currently inactive. Activate it before retrying.`);
  }

  const job = snap.jobs[targetLog.jobId];
  let payment = await paymentLookup(targetLog.paymentRequestId).catch(() => null);
  if (!payment) {
    payment = {
      id: targetLog.paymentRequestId,
      uid: '',
      userEmail: targetLog.studentEmail,
      userName: targetLog.studentName,
      planType: targetLog.courseName === 'All-Access Pass' ? 'all_access' : 'category',
      categoryName: targetLog.courseName,
      amount: targetLog.amount,
      utr: targetLog.utr,
      proofUrl: '',
      status: job?.paymentStatus || 'pending',
      submittedAt: job?.createdAt || targetLog.createdAt
    };
  }

  await mutateStore(store => {
    const l = store.logs[logId];
    if (l) {
      l.status = 'RETRYING';
      l.updatedAt = new Date().toISOString();
    }
  });

  const plainToken = decryptBotToken(bot.encryptedToken);
  const messageHtml = buildPaymentNotificationHtml(payment, targetLog.eventType);
  const res = await callTelegramApi<{ message_id: number }>(plainToken, 'sendMessage', {
    chat_id: bot.chatId,
    text: messageHtml,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  });

  const now = new Date().toISOString();
  const result = await mutateStore(store => {
    const l = store.logs[logId];
    if (!l) throw new Error('Notification log disappeared.');
    l.attemptCount = (l.attemptCount || 1) + res.attempts;
    l.updatedAt = now;

    const targetBot = store.bots[bot.id];
    if (res.ok) {
      l.status = 'SENT';
      l.telegramMessageId = res.result?.message_id;
      l.errorCode = undefined;
      l.errorMessage = undefined;
      l.sentAt = now;
      if (targetBot) {
        targetBot.totalSentCount = (targetBot.totalSentCount || 0) + 1;
        targetBot.lastNotifiedAt = now;
        targetBot.lastNotificationStatus = 'SENT';
        targetBot.lastErrorMessage = undefined;
        targetBot.updatedAt = now;
      }
    } else {
      l.status = 'FAILED';
      l.errorCode = res.errorCode || 'FAILED';
      l.errorMessage = res.errorMessage || 'Retry delivery failed.';
      if (targetBot) {
        targetBot.totalFailedCount = (targetBot.totalFailedCount || 0) + 1;
        targetBot.lastNotifiedAt = now;
        targetBot.lastNotificationStatus = 'FAILED';
        targetBot.lastErrorMessage = l.errorMessage;
        targetBot.updatedAt = now;
      }
    }

    const parentJob = store.jobs[l.jobId];
    const siblingLogs = Object.values(store.logs).filter(item => item.jobId === l.jobId);
    const sentCount = siblingLogs.filter(item => item.status === 'SENT').length;
    const failedCount = siblingLogs.filter(item => item.status === 'FAILED').length;

    if (parentJob) {
      parentJob.sentCount = sentCount;
      parentJob.failedCount = failedCount;
      parentJob.overallStatus = computeJobOverallStatus(sentCount, failedCount, siblingLogs.length);
      parentJob.updatedAt = now;
      parentJob.lastAttemptAt = now;
    }

    return { log: l, job: parentJob, botToSync: targetBot };
  });

  if (result.job) {
    void syncJobAndLogsToFirestore(result.job, [result.log], idToken);
  }
  if (result.botToSync && idToken) {
    void syncBotToFirestore(result.botToSync, idToken);
  }

  return result;
}

/**
 * Retries ONLY the FAILED logs belonging to a payment job (never duplicates already SENT bots).
 */
export async function retryFailedJobLogs(
  jobId: string,
  paymentLookup: (paymentRequestId: string) => Promise<PaymentRequest | null>,
  idToken?: string
): Promise<{ retriedCount: number; job: TelegramNotificationJob | undefined }> {
  const snap = readStoreSnapshot();
  const failedLogs = Object.values(snap.logs).filter(
    l => l.jobId === jobId && l.status === 'FAILED'
  );
  if (failedLogs.length === 0) {
    return { retriedCount: 0, job: snap.jobs[jobId] };
  }

  let latestJob = snap.jobs[jobId];
  let retriedCount = 0;

  for (const log of failedLogs) {
    try {
      const outcome = await retryFailedNotificationLog(log.id, paymentLookup, idToken);
      latestJob = outcome.job;
      retriedCount++;
    } catch (err) {
      console.warn(`Retry skipped for log ${log.id}:`, (err as Error).message);
    }
  }

  return { retriedCount, job: latestJob };
}
