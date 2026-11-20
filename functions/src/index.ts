import * as admin from 'firebase-admin';
import * as crypto from 'node:crypto';
import * as functionsV1 from 'firebase-functions/v1';
import { onDocumentCreated, onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { onCall, onRequest, HttpsError } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();
const TELEGRAM_ENCRYPTION_KEY = defineSecret('TELEGRAM_ENCRYPTION_KEY');
const PLATFORM_OWNER_EMAIL = 'editpeakstudio@gmail.com';
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RETRY_ATTEMPTS = 3;

interface PaymentDoc {
  id: string;
  uid: string;
  userEmail: string;
  userName: string;
  planType: 'all_access' | 'category';
  categoryId?: string;
  categoryName?: string;
  amount: number;
  utr: string;
  proofUrl: string;
  status: 'pending' | 'approved' | 'rejected';
  adminNote?: string;
  submittedAt: string;
}

interface BotDoc {
  id: string;
  botName: string;
  botUsername?: string;
  encryptedToken: string;
  maskedToken: string;
  chatId: string;
  description?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  createdByUid?: string;
  createdByEmail?: string;
  lastTestedAt?: string;
  lastTestStatus?: 'SUCCESS' | 'FAILED';
  lastTestMessage?: string;
  lastNotifiedAt?: string;
  lastNotificationStatus?: 'SENT' | 'FAILED' | 'PENDING' | 'RETRYING';
  lastErrorMessage?: string;
  totalSentCount?: number;
  totalFailedCount?: number;
}

interface JobDoc {
  id: string;
  paymentRequestId: string;
  eventType: 'payment_submitted' | 'payment_approved' | 'payment_rejected';
  studentName: string;
  studentEmail: string;
  courseName: string;
  amount: number;
  utr: string;
  paymentMethod: string;
  paymentStatus: 'pending' | 'approved' | 'rejected';
  overallStatus: 'PENDING' | 'SENT' | 'PARTIAL_FAILURE' | 'FAILED' | 'SKIPPED_NO_ACTIVE_BOTS';
  totalActiveBots: number;
  sentCount: number;
  failedCount: number;
  createdAt: string;
  updatedAt: string;
  lastAttemptAt?: string;
}

interface LogDoc {
  id: string;
  jobId: string;
  paymentRequestId: string;
  botId: string;
  botName: string;
  chatId: string;
  eventType: 'payment_submitted' | 'payment_approved' | 'payment_rejected';
  studentName: string;
  studentEmail: string;
  courseName: string;
  amount: number;
  utr: string;
  status: 'SENT' | 'FAILED' | 'PENDING' | 'RETRYING';
  attemptCount: number;
  telegramMessageId?: number;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  sentAt?: string;
}

function resolveKey(secretValue: string): Buffer {
  const trimmed = (secretValue || '').trim();
  if (!trimmed) {
    throw new Error('TELEGRAM_ENCRYPTION_KEY secret is not configured in Firebase Functions.');
  }
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }
  return crypto.createHash('sha256').update(trimmed, 'utf8').digest();
}

function encryptToken(plainToken: string, secretValue: string): string {
  const trimmed = plainToken.trim();
  if (!trimmed) throw new Error('Telegram bot token cannot be empty.');
  const key = resolveKey(secretValue);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(trimmed, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `v1:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptToken(encryptedPayload: string, secretValue: string): string {
  const prefix = 'v1:';
  if (!encryptedPayload.startsWith(prefix)) {
    throw new Error('Invalid encrypted bot token format.');
  }
  const [ivHex, tagHex, dataHex] = encryptedPayload.slice(prefix.length).split(':');
  const key = resolveKey(secretValue);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const plain = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
  return plain.toString('utf8');
}

function maskBotToken(token: string): string {
  const clean = token.trim();
  if (!clean) return '••••••••';
  const colonIdx = clean.indexOf(':');
  if (colonIdx > 0 && colonIdx < clean.length - 6) {
    const botIdPart = clean.slice(0, colonIdx);
    const secretPart = clean.slice(colonIdx + 1);
    return `${botIdPart}:${secretPart.slice(0, 2)}••••••••${secretPart.slice(-4)}`;
  }
  if (clean.length <= 8) return '••••••••';
  return `${clean.slice(0, 3)}••••••••${clean.slice(-4)}`;
}

function validateBotTokenFormat(token: string): { valid: boolean; error?: string } {
  const clean = token.trim();
  if (!clean) return { valid: false, error: 'Telegram Bot Token is required.' };
  if (!/^\d{6,16}:[A-Za-z0-9_-]{20,64}$/.test(clean)) {
    return {
      valid: false,
      error: 'Invalid Telegram Bot Token format. Expected format like 123456789:ABCdef...'
    };
  }
  return { valid: true };
}

function validateChatIdFormat(chatId: string): { valid: boolean; error?: string } {
  const clean = chatId.trim();
  if (!clean) return { valid: false, error: 'Telegram Chat ID is required.' };
  if (!/^(?:-?\d{5,20}|@[A-Za-z][A-Za-z0-9_]{3,31})$/.test(clean)) {
    return {
      valid: false,
      error: 'Invalid Telegram Chat ID. Use numeric ID (e.g. 123456789 or -1001234567890) or @channelusername.'
    };
  }
  return { valid: true };
}

function toPublicBot(bot: BotDoc) {
  const { encryptedToken: _omitted, ...publicFields } = bot;
  return {
    ...publicFields,
    totalSentCount: Number(publicFields.totalSentCount || 0),
    totalFailedCount: Number(publicFields.totalFailedCount || 0)
  };
}

function sanitizeError(msg: string, secrets: string[] = []): string {
  let clean = String(msg || 'Unknown error');
  for (const s of secrets) {
    if (s) clean = clean.split(s).join('[REDACTED_TOKEN]');
  }
  clean = clean.replace(/bot\d{6,16}:[A-Za-z0-9_-]{12,}/gi, 'bot[REDACTED_TOKEN]');
  clean = clean.replace(/\d{6,16}:[A-Za-z0-9_-]{15,}/g, '[REDACTED_TOKEN]');
  return clean;
}

function escapeHtml(value: string): string {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isHttpUrl(url?: string): boolean {
  return Boolean(url && /^https?:\/\/\S+$/i.test(url.trim()));
}

function formatIST(iso?: string): string {
  const date = iso ? new Date(iso) : new Date();
  if (Number.isNaN(date.getTime())) return String(iso || '');
  return (
    date.toLocaleString('en-IN', {
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

function buildHtml(
  payment: PaymentDoc,
  eventType: 'payment_submitted' | 'payment_approved' | 'payment_rejected',
  adminNote?: string
): string {
  const course =
    payment.planType === 'all_access'
      ? 'All-Access Pass (All Courses)'
      : payment.categoryName || payment.categoryId || 'Category Pass';

  const statusText =
    eventType === 'payment_approved'
      ? 'PAYMENT APPROVED'
      : eventType === 'payment_rejected'
        ? 'PAYMENT REJECTED'
        : 'PENDING VERIFICATION';

  const header =
    eventType === 'payment_approved'
      ? '✅ <b>Payment Approved — Skill-Flix</b>'
      : eventType === 'payment_rejected'
        ? '❌ <b>Payment Rejected — Skill-Flix</b>'
        : '🔔 <b>New Payment Submitted — Skill-Flix</b>';

  const proofLine = isHttpUrl(payment.proofUrl)
    ? `<b>Proof Link:</b> <a href="${escapeHtml(payment.proofUrl)}">View Payment Screenshot</a>`
    : payment.proofUrl
      ? `<b>Payment Proof:</b> Screenshot attached in Skill-Flix Admin Panel`
      : `<b>Payment Proof:</b> Not provided`;

  const lines = [
    header,
    '',
    `<b>Student Name:</b> ${escapeHtml(payment.userName || 'Student')}`,
    `<b>Student Email:</b> ${escapeHtml(payment.userEmail || 'N/A')}`,
    `<b>Course / Plan:</b> ${escapeHtml(course)}`,
    `<b>Amount Paid:</b> ₹${escapeHtml(String(payment.amount))}`,
    `<b>Payment Method:</b> UPI`,
    `<b>Transaction ID / UTR:</b> <code>${escapeHtml(payment.utr)}</code>`,
    `<b>Submitted At:</b> ${escapeHtml(formatIST(payment.submittedAt))}`,
    `<b>Payment Request ID:</b> <code>${escapeHtml(payment.id)}</code>`,
    `<b>Status:</b> ${statusText}`,
    proofLine
  ];
  if (adminNote && adminNote.trim()) {
    lines.push(`<b>Admin Note:</b> ${escapeHtml(adminNote.trim())}`);
  }
  return lines.join('\n');
}

async function callTelegramApi<T>(
  botToken: string,
  method: string,
  payload?: Record<string, unknown>,
  maxAttempts = MAX_RETRY_ATTEMPTS
): Promise<{ ok: boolean; result?: T; errorCode?: string; errorMessage?: string; attempts: number }> {
  const url = `https://api.telegram.org/bot${botToken}/${method}`;
  let lastCode = 'UNKNOWN';
  let lastMessage = 'Telegram API request failed.';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        method: payload ? 'POST' : 'GET',
        headers: payload
          ? { 'Content-Type': 'application/json', Accept: 'application/json' }
          : { Accept: 'application/json' },
        body: payload ? JSON.stringify(payload) : undefined,
        signal: controller.signal
      });
      clearTimeout(timer);

      const json = (await res.json().catch(() => null)) as {
        ok?: boolean;
        result?: T;
        error_code?: number;
        description?: string;
        parameters?: { retry_after?: number };
      } | null;

      if (res.ok && json?.ok) {
        return { ok: true, result: json.result, attempts: attempt };
      }

      const code = json?.error_code || res.status || 500;
      lastCode = `TG_${code}`;
      lastMessage = sanitizeError(mapTelegramError(code, json?.description || `HTTP ${code}`), [botToken]);

      if (!(code === 429 || code >= 500) || attempt >= maxAttempts) {
        return { ok: false, errorCode: lastCode, errorMessage: lastMessage, attempts: attempt };
      }

      const waitMs = json?.parameters?.retry_after
        ? Math.min(json.parameters.retry_after * 1000, 10_000)
        : 500 * Math.pow(2, attempt - 1);
      await new Promise(r => setTimeout(r, waitMs));
    } catch (err) {
      clearTimeout(timer);
      lastCode = (err as Error).name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR';
      lastMessage = sanitizeError((err as Error).message, [botToken]);
      if (attempt >= maxAttempts) {
        return { ok: false, errorCode: lastCode, errorMessage: lastMessage, attempts: attempt };
      }
      await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt - 1)));
    }
  }

  return { ok: false, errorCode: lastCode, errorMessage: lastMessage, attempts: maxAttempts };
}

async function sendMessageWithRetry(botToken: string, chatId: string, html: string) {
  return callTelegramApi<{ message_id?: number }>(botToken, 'sendMessage', {
    chat_id: chatId,
    text: html,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  });
}

function computeOverallStatus(
  sentCount: number,
  failedCount: number,
  totalActive: number
): JobDoc['overallStatus'] {
  if (totalActive === 0) return 'SKIPPED_NO_ACTIVE_BOTS';
  if (sentCount > 0 && failedCount === 0) return 'SENT';
  if (sentCount > 0 && failedCount > 0) return 'PARTIAL_FAILURE';
  if (failedCount > 0 && sentCount === 0) return 'FAILED';
  return 'PENDING';
}

async function dispatchForPayment(
  payment: PaymentDoc,
  eventType: 'payment_submitted' | 'payment_approved' | 'payment_rejected',
  secretValue: string,
  adminNote?: string
): Promise<{ job: JobDoc; logs: LogDoc[]; deduplicated?: boolean }> {
  const jobId = eventType === 'payment_submitted' ? payment.id : `${payment.id}__${eventType}`;
  const jobRef = db.collection('telegramNotificationJobs').doc(jobId);
  const courseName =
    payment.planType === 'all_access'
      ? 'All-Access Pass'
      : payment.categoryName || payment.categoryId || 'Category Pass';

  // Atomic idempotency claim: only one execution can claim a given jobId
  const claimed = await db.runTransaction(async tx => {
    const snap = await tx.get(jobRef);
    if (snap.exists) {
      return false;
    }
    const now = new Date().toISOString();
    const initialJob: JobDoc = {
      id: jobId,
      paymentRequestId: payment.id,
      eventType,
      studentName: payment.userName || 'Student',
      studentEmail: payment.userEmail || '',
      courseName,
      amount: Number(payment.amount || 0),
      utr: payment.utr || '',
      paymentMethod: 'UPI',
      paymentStatus: payment.status || 'pending',
      overallStatus: 'PENDING',
      totalActiveBots: 0,
      sentCount: 0,
      failedCount: 0,
      createdAt: now,
      updatedAt: now
    };
    tx.set(jobRef, initialJob);
    return true;
  });

  if (!claimed) {
    const [existingJobSnap, existingLogsSnap] = await Promise.all([
      jobRef.get(),
      db.collection('telegramNotificationLogs').where('jobId', '==', jobId).get()
    ]);
    return {
      job: existingJobSnap.data() as JobDoc,
      logs: existingLogsSnap.docs.map(d => d.data() as LogDoc),
      deduplicated: true
    };
  }

  const botsSnap = await db.collection('telegramBots').where('isActive', '==', true).get();
  const activeBots = botsSnap.docs.map(d => ({ id: d.id, ...d.data() }) as BotDoc);
  const now = new Date().toISOString();

  if (activeBots.length === 0) {
    await jobRef.update({
      overallStatus: 'SKIPPED_NO_ACTIVE_BOTS',
      updatedAt: now,
      lastAttemptAt: now
    });
    const updatedSnap = await jobRef.get();
    return { job: updatedSnap.data() as JobDoc, logs: [] };
  }

  const html = buildHtml(payment, eventType, adminNote);
  const createdLogs: LogDoc[] = [];

  const outcomes = await Promise.allSettled(
    activeBots.map(async bot => {
      const logId = `${jobId}__${bot.id}`;
      const logRef = db.collection('telegramNotificationLogs').doc(logId);
      let res: { ok: boolean; result?: { message_id?: number }; errorCode?: string; errorMessage?: string; attempts: number };

      try {
        const plainToken = decryptToken(bot.encryptedToken, secretValue);
        res = await sendMessageWithRetry(plainToken, bot.chatId, html);
      } catch (err) {
        res = {
          ok: false,
          errorCode: 'DECRYPT_ERROR',
          errorMessage: sanitizeError((err as Error).message),
          attempts: 1
        };
      }

      const ts = new Date().toISOString();
      const logDoc: LogDoc = {
        id: logId,
        jobId,
        paymentRequestId: payment.id,
        botId: bot.id,
        botName: bot.botName,
        chatId: bot.chatId,
        eventType,
        studentName: payment.userName || 'Student',
        studentEmail: payment.userEmail || '',
        courseName,
        amount: Number(payment.amount || 0),
        utr: payment.utr || '',
        status: res.ok ? 'SENT' : 'FAILED',
        attemptCount: res.attempts,
        ...(res.result?.message_id ? { telegramMessageId: res.result.message_id } : {}),
        ...(res.errorCode ? { errorCode: res.errorCode } : {}),
        ...(res.errorMessage ? { errorMessage: res.errorMessage } : {}),
        createdAt: now,
        updatedAt: ts,
        ...(res.ok ? { sentAt: ts } : {})
      };

      await logRef.set(logDoc);
      createdLogs.push(logDoc);

      await db
        .collection('telegramBots')
        .doc(bot.id)
        .update({
          lastNotifiedAt: ts,
          lastNotificationStatus: res.ok ? 'SENT' : 'FAILED',
          ...(res.ok
            ? {
                totalSentCount: admin.firestore.FieldValue.increment(1),
                lastErrorMessage: admin.firestore.FieldValue.delete()
              }
            : {
                totalFailedCount: admin.firestore.FieldValue.increment(1),
                lastErrorMessage: res.errorMessage || 'Failed'
              }),
          updatedAt: ts
        });

      return res.ok;
    })
  );

  const sentCount = outcomes.filter(o => o.status === 'fulfilled' && o.value).length;
  const failedCount = activeBots.length - sentCount;
  const overallStatus = computeOverallStatus(sentCount, failedCount, activeBots.length);
  const completedAt = new Date().toISOString();

  await jobRef.update({
    totalActiveBots: activeBots.length,
    sentCount,
    failedCount,
    overallStatus,
    updatedAt: completedAt,
    lastAttemptAt: completedAt
  });

  const finalJobSnap = await jobRef.get();
  return { job: finalJobSnap.data() as JobDoc, logs: createdLogs };
}

async function performLogRetry(logId: string, secretValue: string): Promise<{ log: LogDoc; job: JobDoc }> {
  const logRef = db.collection('telegramNotificationLogs').doc(logId);
  const logSnap = await logRef.get();
  if (!logSnap.exists) throw new HttpStatusError(404, 'Notification log not found.');

  const logData = logSnap.data() as LogDoc;
  if (logData.status === 'SENT') {
    throw new HttpStatusError(400, 'This notification has already been delivered (SENT). Duplicate retries are blocked.');
  }

  const botSnap = await db.collection('telegramBots').doc(logData.botId).get();
  if (!botSnap.exists) throw new HttpStatusError(404, 'The configured Telegram bot no longer exists.');
  const bot = { id: botSnap.id, ...botSnap.data() } as BotDoc;
  if (!bot.isActive) {
    throw new HttpStatusError(400, `Bot "${bot.botName}" is inactive. Activate it before retrying.`);
  }

  const paymentSnap = await db.collection('paymentRequests').doc(logData.paymentRequestId).get();
  const payment: PaymentDoc = paymentSnap.exists
    ? ({ id: paymentSnap.id, ...paymentSnap.data() } as PaymentDoc)
    : {
        id: logData.paymentRequestId,
        uid: '',
        userEmail: logData.studentEmail,
        userName: logData.studentName,
        planType: logData.courseName === 'All-Access Pass' ? 'all_access' : 'category',
        categoryName: logData.courseName,
        amount: logData.amount,
        utr: logData.utr,
        proofUrl: '',
        status: 'pending',
        submittedAt: logData.createdAt
      };

  const plainToken = decryptToken(bot.encryptedToken, secretValue);
  const html = buildHtml(payment, logData.eventType);
  const res = await sendMessageWithRetry(plainToken, bot.chatId, html);
  const now = new Date().toISOString();

  await logRef.update({
    status: res.ok ? 'SENT' : 'FAILED',
    attemptCount: admin.firestore.FieldValue.increment(res.attempts),
    updatedAt: now,
    ...(res.ok
      ? {
          telegramMessageId: res.result?.message_id || null,
          errorCode: admin.firestore.FieldValue.delete(),
          errorMessage: admin.firestore.FieldValue.delete(),
          sentAt: now
        }
      : {
          errorCode: res.errorCode || 'FAILED',
          errorMessage: res.errorMessage || 'Retry failed.'
        })
  });

  await db
    .collection('telegramBots')
    .doc(bot.id)
    .update({
      lastNotifiedAt: now,
      lastNotificationStatus: res.ok ? 'SENT' : 'FAILED',
      ...(res.ok
        ? {
            totalSentCount: admin.firestore.FieldValue.increment(1),
            lastErrorMessage: admin.firestore.FieldValue.delete()
          }
        : {
            totalFailedCount: admin.firestore.FieldValue.increment(1),
            lastErrorMessage: res.errorMessage || 'Retry failed.'
          }),
      updatedAt: now
    });

  const siblingSnap = await db.collection('telegramNotificationLogs').where('jobId', '==', logData.jobId).get();
  const siblings = siblingSnap.docs.map(d => d.data() as LogDoc);
  const sentCount = siblings.filter(l => l.status === 'SENT').length;
  const failedCount = siblings.filter(l => l.status === 'FAILED').length;
  const jobRef = db.collection('telegramNotificationJobs').doc(logData.jobId);
  await jobRef.update({
    sentCount,
    failedCount,
    overallStatus: computeOverallStatus(sentCount, failedCount, siblings.length),
    updatedAt: now,
    lastAttemptAt: now
  });

  const [updatedLogSnap, updatedJobSnap] = await Promise.all([logRef.get(), jobRef.get()]);
  return {
    log: updatedLogSnap.data() as LogDoc,
    job: updatedJobSnap.data() as JobDoc
  };
}

class HttpStatusError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function verifyCaller(authHeader?: string) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new HttpStatusError(401, 'Missing Firebase authentication token.');
  }
  const token = authHeader.slice(7).trim();
  if (!token) throw new HttpStatusError(401, 'Missing Firebase authentication token.');
  try {
    return await admin.auth().verifyIdToken(token);
  } catch {
    throw new HttpStatusError(401, 'Invalid or expired Firebase authentication token.');
  }
}

async function authorizeAdminCaller(
  authHeader: string | undefined,
  requiredPermission: 'telegram.manage' | 'payments.verify' | 'students.manage' = 'telegram.manage'
) {
  const decoded = await verifyCaller(authHeader);
  const email = (decoded.email || '').trim().toLowerCase();
  const isOwner = email === PLATFORM_OWNER_EMAIL && decoded.email_verified === true;
  if (isOwner) {
    return { uid: decoded.uid, email, role: 'owner' as const };
  }

  const userSnap = await db.collection('users').doc(decoded.uid).get();
  if (!userSnap.exists) {
    throw new HttpStatusError(403, 'Forbidden: Administrator profile not found.');
  }
  const profile = userSnap.data()!;
  if (profile.isSuspended === true) {
    throw new HttpStatusError(403, 'Forbidden: Administrator account is suspended.');
  }

  const role = typeof profile.role === 'string' ? profile.role : 'user';
  const permissions: string[] = Array.isArray(profile.permissions) ? profile.permissions : [];

  if (role === 'master_admin') {
    return { uid: decoded.uid, email, role: 'master_admin' as const };
  }

  if (role === 'admin') {
    const allowed =
      permissions.includes(requiredPermission) ||
      (requiredPermission === 'telegram.manage' && permissions.includes('settings.manage')) ||
      (requiredPermission === 'students.manage' && permissions.includes('payments.verify'));
    if (allowed) {
      return { uid: decoded.uid, email, role: 'admin' as const };
    }
  }

  throw new HttpStatusError(403, 'Forbidden: You do not have permission to perform this administrative action.');
}

// ======================================================
// HTTPS API ENDPOINT FOR FIREBASE HOSTING REWRITES (/api/telegram/**)
// ======================================================

export const telegramApi = onRequest(
  {
    region: 'us-central1',
    secrets: [TELEGRAM_ENCRYPTION_KEY],
    cors: true
  },
  async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    const rawPath = (req.path || '/').replace(/^\/api\/telegram/, '') || '/';
    const routePath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
    const method = req.method.toUpperCase();
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;

    try {
      // GET /api/telegram/health
      if (method === 'GET' && routePath === '/health') {
        res.status(200).json({
          ok: true,
          service: 'skill-flix-telegram-cloud-function',
          timestamp: new Date().toISOString()
        });
        return;
      }

      // GET /api/telegram/dashboard
      if (method === 'GET' && routePath === '/dashboard') {
        await authorizeAdminCaller(req.headers.authorization, 'telegram.manage');

        const [botsSnap, logsSnap, jobsSnap, settingsSnap] = await Promise.all([
          db.collection('telegramBots').get(),
          db.collection('telegramNotificationLogs').get(),
          db.collection('telegramNotificationJobs').get(),
          db.collection('settings').doc('telegram').get()
        ]);

        const allBots = botsSnap.docs
          .map(d => ({ id: d.id, ...d.data() }) as BotDoc)
          .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());

        const allLogs = logsSnap.docs.map(d => ({ id: d.id, ...d.data() }) as LogDoc);
        const sentLogs = allLogs.filter(l => l.status === 'SENT');
        const failedLogs = allLogs.filter(l => l.status === 'FAILED');

        let lastSuccessfulNotificationAt: string | null = null;
        for (const l of sentLogs) {
          const ts = l.sentAt || l.updatedAt;
          if (ts && (!lastSuccessfulNotificationAt || ts > lastSuccessfulNotificationAt)) {
            lastSuccessfulNotificationAt = ts;
          }
        }

        const statusFilter = String(req.query.status || 'ALL').toUpperCase();
        const searchQ = String(req.query.search || '').trim().toLowerCase();
        const page = Math.max(1, Number(req.query.page || 1));
        const pageSize = Math.min(50, Math.max(5, Number(req.query.pageSize || 10)));

        let filteredLogs = allLogs;
        if (statusFilter !== 'ALL') {
          filteredLogs = filteredLogs.filter(l => l.status === statusFilter);
        }
        if (searchQ) {
          filteredLogs = filteredLogs.filter(
            l =>
              (l.paymentRequestId || '').toLowerCase().includes(searchQ) ||
              (l.studentName || '').toLowerCase().includes(searchQ) ||
              (l.studentEmail || '').toLowerCase().includes(searchQ) ||
              (l.botName || '').toLowerCase().includes(searchQ) ||
              (l.utr || '').toLowerCase().includes(searchQ) ||
              (l.courseName || '').toLowerCase().includes(searchQ)
          );
        }
        filteredLogs.sort(
          (a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
        );

        const total = filteredLogs.length;
        const totalPages = Math.max(1, Math.ceil(total / pageSize));
        const safePage = Math.min(page, totalPages);
        const pagedLogs = filteredLogs.slice((safePage - 1) * pageSize, safePage * pageSize);

        const jobsByPaymentId: Record<string, JobDoc> = {};
        for (const d of jobsSnap.docs) {
          const job = { id: d.id, ...d.data() } as JobDoc;
          jobsByPaymentId[job.id] = job;
        }

        const activeBotsCount = allBots.filter(b => b.isActive).length;

        res.status(200).json({
          summary: {
            totalBots: allBots.length,
            activeBots: activeBotsCount,
            inactiveBots: allBots.length - activeBotsCount,
            totalNotificationsSent: sentLogs.length,
            totalFailedNotifications: failedLogs.length,
            lastSuccessfulNotificationAt
          },
          bots: allBots.map(toPublicBot),
          logs: pagedLogs,
          logsPagination: {
            page: safePage,
            pageSize,
            total,
            totalPages
          },
          jobsByPaymentId,
          settings: {
            notifyOnResolution: Boolean(settingsSnap.data()?.notifyOnResolution)
          }
        });
        return;
      }

      // GET /api/telegram/payment-jobs
      if (method === 'GET' && routePath === '/payment-jobs') {
        await authorizeAdminCaller(req.headers.authorization, 'payments.verify');
        const [jobsSnap, logsSnap] = await Promise.all([
          db.collection('telegramNotificationJobs').get(),
          db.collection('telegramNotificationLogs').get()
        ]);

        const jobsByPaymentId: Record<string, JobDoc> = {};
        for (const d of jobsSnap.docs) {
          const j = { id: d.id, ...d.data() } as JobDoc;
          jobsByPaymentId[j.id] = j;
        }

        const logsByPaymentId: Record<string, LogDoc[]> = {};
        for (const d of logsSnap.docs) {
          const l = { id: d.id, ...d.data() } as LogDoc;
          if (!logsByPaymentId[l.paymentRequestId]) logsByPaymentId[l.paymentRequestId] = [];
          logsByPaymentId[l.paymentRequestId].push(l);
        }

        res.status(200).json({ jobsByPaymentId, logsByPaymentId });
        return;
      }

      // POST /api/telegram/bots
      if (method === 'POST' && routePath === '/bots') {
        const adminCtx = await authorizeAdminCaller(req.headers.authorization, 'telegram.manage');
        const botName = String(body.botName || '').trim();
        const rawToken = String(body.token || '').trim();
        const chatId = String(body.chatId || '').trim();
        const description = String(body.description || '').trim();
        const isActive = body.isActive !== false;

        if (!botName || botName.length < 2) {
          throw new HttpStatusError(400, 'Bot Name must be at least 2 characters.');
        }
        const tokenCheck = validateBotTokenFormat(rawToken);
        if (!tokenCheck.valid) throw new HttpStatusError(400, tokenCheck.error!);
        const chatCheck = validateChatIdFormat(chatId);
        if (!chatCheck.valid) throw new HttpStatusError(400, chatCheck.error!);

        const encryptedToken = encryptToken(rawToken, TELEGRAM_ENCRYPTION_KEY.value());
        const maskedToken = maskBotToken(rawToken);
        const now = new Date().toISOString();
        const id = `tgbot_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;

        const botDoc: BotDoc = {
          id,
          botName,
          maskedToken,
          encryptedToken,
          chatId,
          description,
          isActive,
          createdAt: now,
          updatedAt: now,
          createdByUid: adminCtx.uid,
          createdByEmail: adminCtx.email,
          totalSentCount: 0,
          totalFailedCount: 0
        };

        await db.collection('telegramBots').doc(id).set(botDoc);
        res.status(201).json({ bot: toPublicBot(botDoc) });
        return;
      }

      // POST /api/telegram/bots/test-connection
      if (method === 'POST' && routePath === '/bots/test-connection') {
        await authorizeAdminCaller(req.headers.authorization, 'telegram.manage');
        const botId = typeof body.botId === 'string' ? body.botId.trim() : '';
        let resolvedToken = typeof body.token === 'string' ? body.token.trim() : '';
        let resolvedChatId = typeof body.chatId === 'string' ? body.chatId.trim() : '';
        let resolvedName = typeof body.botName === 'string' ? body.botName.trim() : 'Telegram Bot';

        if (botId) {
          const snap = await db.collection('telegramBots').doc(botId).get();
          if (!snap.exists) throw new HttpStatusError(404, 'Telegram bot not found.');
          const existing = { id: snap.id, ...snap.data() } as BotDoc;
          if (!resolvedToken) {
            resolvedToken = decryptToken(existing.encryptedToken, TELEGRAM_ENCRYPTION_KEY.value());
          }
          if (!resolvedChatId) resolvedChatId = existing.chatId;
          resolvedName = existing.botName;
        }

        const tokenCheck = validateBotTokenFormat(resolvedToken);
        if (!tokenCheck.valid) throw new HttpStatusError(400, tokenCheck.error!);
        const chatCheck = validateChatIdFormat(resolvedChatId);
        if (!chatCheck.valid) throw new HttpStatusError(400, chatCheck.error!);

        const meRes = await callTelegramApi<{ id: number; username?: string; first_name?: string }>(
          resolvedToken,
          'getMe',
          undefined,
          2
        );

        const now = new Date().toISOString();
        if (!meRes.ok || !meRes.result) {
          const failMsg = meRes.errorMessage || 'Bot token verification failed.';
          if (botId) {
            await db.collection('telegramBots').doc(botId).update({
              lastTestedAt: now,
              lastTestStatus: 'FAILED',
              lastTestMessage: failMsg,
              updatedAt: now
            });
          }
          res.status(200).json({ success: false, message: failMsg });
          return;
        }

        const botUsername = meRes.result.username ? `@${meRes.result.username}` : meRes.result.first_name;
        const pingText = [
          '🤖 <b>Connection Verified — Skill-Flix</b>',
          '',
          `<b>Bot Name:</b> ${escapeHtml(resolvedName)} (${escapeHtml(botUsername || 'Verified Bot')})`,
          `<b>Target Chat ID:</b> <code>${escapeHtml(resolvedChatId)}</code>`,
          `<b>Checked At:</b> ${escapeHtml(formatIST())}`,
          '',
          'Your Skill-Flix payment notification channel is active and ready.'
        ].join('\n');

        const msgRes = await callTelegramApi<{ message_id?: number }>(
          resolvedToken,
          'sendMessage',
          {
            chat_id: resolvedChatId,
            text: pingText,
            parse_mode: 'HTML',
            disable_web_page_preview: true
          },
          2
        );

        const success = msgRes.ok;
        const message = success
          ? `Connected to ${botUsername || 'bot'} and delivered verification message to ${resolvedChatId}.`
          : msgRes.errorMessage || 'Failed to deliver verification message to target Chat ID.';

        let updatedBot: ReturnType<typeof toPublicBot> | undefined;
        if (botId) {
          const botRef = db.collection('telegramBots').doc(botId);
          await botRef.update({
            ...(botUsername ? { botUsername } : {}),
            lastTestedAt: now,
            lastTestStatus: success ? 'SUCCESS' : 'FAILED',
            lastTestMessage: message,
            updatedAt: now
          });
          const snap = await botRef.get();
          updatedBot = toPublicBot({ id: snap.id, ...snap.data() } as BotDoc);
        }

        res.status(200).json({ success, botUsername, message, bot: updatedBot });
        return;
      }

      // Match /bots/:id, /bots/:id/toggle, /bots/:id/send-test
      const botSubMatch = routePath.match(/^\/bots\/([^/]+?)(?:\/(toggle|send-test))?$/);
      if (botSubMatch) {
        const botId = decodeURIComponent(botSubMatch[1]);
        const subAction = botSubMatch[2];
        await authorizeAdminCaller(req.headers.authorization, 'telegram.manage');

        const botRef = db.collection('telegramBots').doc(botId);
        const snap = await botRef.get();
        if (!snap.exists) throw new HttpStatusError(404, 'Telegram bot not found.');
        const existing = { id: snap.id, ...snap.data() } as BotDoc;

        if (method === 'PUT' && !subAction) {
          const botName = String(body.botName || '').trim();
          const rawToken = String(body.token || '').trim();
          const chatId = String(body.chatId || '').trim();
          const description = String(body.description || '').trim();

          if (!botName || botName.length < 2) {
            throw new HttpStatusError(400, 'Bot Name must be at least 2 characters.');
          }
          const chatCheck = validateChatIdFormat(chatId);
          if (!chatCheck.valid) throw new HttpStatusError(400, chatCheck.error!);
          if (rawToken) {
            const tokenCheck = validateBotTokenFormat(rawToken);
            if (!tokenCheck.valid) throw new HttpStatusError(400, tokenCheck.error!);
          }

          const updates: Record<string, unknown> = {
            botName,
            chatId,
            description,
            updatedAt: new Date().toISOString()
          };
          if (typeof body.isActive === 'boolean') updates.isActive = body.isActive;
          if (rawToken) {
            updates.encryptedToken = encryptToken(rawToken, TELEGRAM_ENCRYPTION_KEY.value());
            updates.maskedToken = maskBotToken(rawToken);
            updates.botUsername = admin.firestore.FieldValue.delete();
          }

          await botRef.update(updates);
          const updatedSnap = await botRef.get();
          res.status(200).json({ bot: toPublicBot({ id: updatedSnap.id, ...updatedSnap.data() } as BotDoc) });
          return;
        }

        if (method === 'PATCH' && subAction === 'toggle') {
          const isActive = typeof body.isActive === 'boolean' ? body.isActive : !existing.isActive;
          await botRef.update({ isActive, updatedAt: new Date().toISOString() });
          const updatedSnap = await botRef.get();
          res.status(200).json({ bot: toPublicBot({ id: updatedSnap.id, ...updatedSnap.data() } as BotDoc) });
          return;
        }

        if (method === 'DELETE' && !subAction) {
          await botRef.delete();
          res.status(200).json({ deleted: true, id: botId });
          return;
        }

        if (method === 'POST' && subAction === 'send-test') {
          const plainToken = decryptToken(existing.encryptedToken, TELEGRAM_ENCRYPTION_KEY.value());
          const sampleHtml = [
            '🧪 <b>Test Payment Notification — Skill-Flix</b>',
            '',
            `<b>Bot:</b> ${escapeHtml(existing.botName)}`,
            '<b>Student Name:</b> Test Student (Sample)',
            '<b>Student Email:</b> student@example.com',
            '<b>Course / Plan:</b> All-Access Pass (All Courses)',
            '<b>Amount Paid:</b> ₹999',
            '<b>Payment Method:</b> UPI',
            `<b>Transaction ID / UTR:</b> <code>TESTUTR${Date.now().toString().slice(-6)}</code>`,
            `<b>Submitted At:</b> ${escapeHtml(formatIST())}`,
            '<b>Status:</b> PENDING VERIFICATION (TEST)'
          ].join('\n');

          const tgRes = await callTelegramApi<{ message_id?: number }>(
            plainToken,
            'sendMessage',
            {
              chat_id: existing.chatId,
              text: sampleHtml,
              parse_mode: 'HTML',
              disable_web_page_preview: true
            },
            2
          );

          const now = new Date().toISOString();
          const lastTestMessage = tgRes.ok
            ? `Test payment alert delivered (Message #${tgRes.result?.message_id || 'OK'}).`
            : tgRes.errorMessage || 'Test notification failed.';

          await botRef.update({
            lastTestedAt: now,
            lastTestStatus: tgRes.ok ? 'SUCCESS' : 'FAILED',
            lastTestMessage,
            updatedAt: now
          });

          const updatedSnap = await botRef.get();
          res.status(200).json({
            success: tgRes.ok,
            message: lastTestMessage,
            bot: toPublicBot({ id: updatedSnap.id, ...updatedSnap.data() } as BotDoc)
          });
          return;
        }
      }

      // PUT /api/telegram/settings
      if (method === 'PUT' && routePath === '/settings') {
        await authorizeAdminCaller(req.headers.authorization, 'telegram.manage');
        const nextSettings = { notifyOnResolution: Boolean(body.notifyOnResolution) };
        await db.collection('settings').doc('telegram').set(nextSettings, { merge: true });
        res.status(200).json({ settings: nextSettings });
        return;
      }

      // POST /api/telegram/notify-payment
      if (method === 'POST' && routePath === '/notify-payment') {
        const caller = await verifyCaller(req.headers.authorization);
        const paymentRequestId = String(body.paymentRequestId || '').trim();
        if (!paymentRequestId) throw new HttpStatusError(400, 'paymentRequestId is required.');

        const paySnap = await db.collection('paymentRequests').doc(paymentRequestId).get();
        if (!paySnap.exists) throw new HttpStatusError(404, 'Payment request not found in Firestore.');
        const payment = { id: paySnap.id, ...paySnap.data() } as PaymentDoc;

        const isOwner =
          (caller.email || '').toLowerCase() === PLATFORM_OWNER_EMAIL && caller.email_verified === true;
        if (payment.uid !== caller.uid && !isOwner) {
          await authorizeAdminCaller(req.headers.authorization, 'payments.verify');
        }

        const outcome = await dispatchForPayment(payment, 'payment_submitted', TELEGRAM_ENCRYPTION_KEY.value());
        res.status(200).json(outcome);
        return;
      }

      // POST /api/telegram/notify-resolution
      if (method === 'POST' && routePath === '/notify-resolution') {
        await authorizeAdminCaller(req.headers.authorization, 'payments.verify');
        const settingsSnap = await db.collection('settings').doc('telegram').get();
        if (!settingsSnap.exists || settingsSnap.data()?.notifyOnResolution !== true) {
          res.status(200).json({
            skipped: true,
            reason: 'Resolution notifications are disabled in Telegram Bot Manager settings.'
          });
          return;
        }

        const paymentRequestId = String(body.paymentRequestId || '').trim();
        const status = body.status;
        if (!paymentRequestId || (status !== 'approved' && status !== 'rejected')) {
          throw new HttpStatusError(400, 'Valid paymentRequestId and status are required.');
        }

        const paySnap = await db.collection('paymentRequests').doc(paymentRequestId).get();
        if (!paySnap.exists) throw new HttpStatusError(404, 'Payment request not found.');
        const payment = { id: paySnap.id, ...paySnap.data() } as PaymentDoc;

        const eventType = status === 'approved' ? 'payment_approved' : 'payment_rejected';
        const outcome = await dispatchForPayment(
          payment,
          eventType,
          TELEGRAM_ENCRYPTION_KEY.value(),
          typeof body.adminNote === 'string' ? body.adminNote : undefined
        );
        res.status(200).json(outcome);
        return;
      }

      // POST /api/telegram/logs/:logId/retry
      const logRetryMatch = routePath.match(/^\/logs\/([^/]+)\/retry$/);
      if (method === 'POST' && logRetryMatch) {
        await authorizeAdminCaller(req.headers.authorization, 'telegram.manage');
        const logId = decodeURIComponent(logRetryMatch[1]);
        const result = await performLogRetry(logId, TELEGRAM_ENCRYPTION_KEY.value());
        res.status(200).json(result);
        return;
      }

      // POST /api/telegram/jobs/:jobId/retry-failed
      const jobRetryMatch = routePath.match(/^\/jobs\/([^/]+)\/retry-failed$/);
      if (method === 'POST' && jobRetryMatch) {
        await authorizeAdminCaller(req.headers.authorization, 'payments.verify');
        const jobId = decodeURIComponent(jobRetryMatch[1]);
        const failedSnap = await db
          .collection('telegramNotificationLogs')
          .where('jobId', '==', jobId)
          .where('status', '==', 'FAILED')
          .get();

        let retriedCount = 0;
        let latestJob: JobDoc | undefined;
        for (const docSnap of failedSnap.docs) {
          try {
            const outcome = await performLogRetry(docSnap.id, TELEGRAM_ENCRYPTION_KEY.value());
            latestJob = outcome.job;
            retriedCount++;
          } catch {
            // Continue retrying other failed logs cleanly
          }
        }
        if (!latestJob) {
          const jobSnap = await db.collection('telegramNotificationJobs').doc(jobId).get();
          latestJob = jobSnap.exists ? (jobSnap.data() as JobDoc) : undefined;
        }
        res.status(200).json({ retriedCount, job: latestJob });
        return;
      }

      res.status(404).json({ error: `Unknown Telegram API route: ${method} ${routePath}` });
    } catch (err) {
      if (err instanceof HttpStatusError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      const message = sanitizeError((err as Error).message || 'Internal server error.');
      res.status(500).json({ error: message });
    }
  }
);

// ======================================================
// FIRESTORE TRIGGERS & CALLABLE FUNCTION
// ======================================================

export const onPaymentRequestCreated = onDocumentCreated(
  {
    region: 'us-central1',
    document: 'paymentRequests/{paymentId}',
    secrets: [TELEGRAM_ENCRYPTION_KEY]
  },
  async event => {
    const data = event.data?.data() as PaymentDoc | undefined;
    if (!data) return;
    const payment: PaymentDoc = { ...data, id: event.params.paymentId };
    await dispatchForPayment(payment, 'payment_submitted', TELEGRAM_ENCRYPTION_KEY.value());
  }
);

export const onPaymentRequestResolved = onDocumentUpdated(
  {
    region: 'us-central1',
    document: 'paymentRequests/{paymentId}',
    secrets: [TELEGRAM_ENCRYPTION_KEY]
  },
  async event => {
    const before = event.data?.before.data() as PaymentDoc | undefined;
    const after = event.data?.after.data() as PaymentDoc | undefined;
    if (!before || !after || before.status === after.status) return;
    if (after.status !== 'approved' && after.status !== 'rejected') return;

    const settingsSnap = await db.collection('settings').doc('telegram').get();
    if (!settingsSnap.exists || settingsSnap.data()?.notifyOnResolution !== true) return;

    const eventType = after.status === 'approved' ? 'payment_approved' : 'payment_rejected';
    await dispatchForPayment(
      { ...after, id: event.params.paymentId },
      eventType,
      TELEGRAM_ENCRYPTION_KEY.value(),
      after.adminNote
    );
  }
);

export const retryFailedTelegramLog = onCall(
  {
    region: 'us-central1',
    secrets: [TELEGRAM_ENCRYPTION_KEY]
  },
  async request => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Authentication required.');
    }
    const userDoc = await db.collection('users').doc(request.auth.uid).get();
    const profile = userDoc.data();
    const isOwner =
      (request.auth.token.email || '').toLowerCase() === PLATFORM_OWNER_EMAIL &&
      request.auth.token.email_verified === true;
    const isAllowed =
      isOwner ||
      (profile &&
        profile.isSuspended !== true &&
        (profile.role === 'master_admin' ||
          (profile.role === 'admin' &&
            Array.isArray(profile.permissions) &&
            (profile.permissions.includes('telegram.manage') ||
              profile.permissions.includes('settings.manage')))));

    if (!isAllowed) {
      throw new HttpsError('permission-denied', 'Telegram management permission required.');
    }

    const logId = String(request.data?.logId || '').trim();
    if (!logId) throw new HttpsError('invalid-argument', 'logId is required.');

    try {
      const result = await performLogRetry(logId, TELEGRAM_ENCRYPTION_KEY.value());
      return { ok: result.log.status === 'SENT', errorMessage: result.log.errorMessage };
    } catch (err) {
      throw new HttpsError('internal', sanitizeError((err as Error).message));
    }
  }
);

// ======================================================
// AUTOMATIC AUTH -> FIRESTORE USER REGISTRATION & BACKFILL
// ======================================================

function resolveAuthProviderFromRecord(user: {
  providerData?: Array<{ providerId?: string }>;
  phoneNumber?: string;
}): string {
  const ids = (user.providerData || []).map(p => (p.providerId || '').toLowerCase());
  if (ids.includes('google.com')) return 'google';
  if (ids.includes('phone') || (user.phoneNumber && ids.length === 0)) return 'phone';
  if (ids.includes('password')) return 'password';
  return ids[0] || 'other';
}

function buildUserDocFromAuthRecord(user: admin.auth.UserRecord) {
  const email = (user.email || '').trim().toLowerCase();
  const isOwner = email === PLATFORM_OWNER_EMAIL;
  const createdAtIso = user.metadata.creationTime
    ? new Date(user.metadata.creationTime).toISOString()
    : new Date().toISOString();
  const lastLoginIso = user.metadata.lastSignInTime
    ? new Date(user.metadata.lastSignInTime).toISOString()
    : createdAtIso;
  const displayName =
    (user.displayName || '').trim() ||
    (email ? email.split('@')[0] : '') ||
    user.phoneNumber ||
    'Student';
  const suspended = user.disabled === true && !isOwner;

  return {
    uid: user.uid,
    email,
    displayName,
    photoURL: user.photoURL || '',
    phoneNumber: user.phoneNumber || '',
    authProvider: resolveAuthProviderFromRecord(user),
    role: isOwner ? 'master_admin' : 'user',
    hasAllAccess: isOwner,
    allowedCategories: [] as string[],
    assignedCourses: [] as string[],
    subscriptionStatus: 'none' as const,
    accessExpiry: null as string | null,
    accountStatus: suspended ? 'suspended' : 'active',
    isSuspended: suspended,
    createdAt: createdAtIso,
    lastLogin: lastLoginIso,
    lastLoginAt: lastLoginIso,
    ...(isOwner ? { isPlatformOwner: true } : {})
  };
}

export const onAuthUserCreated = functionsV1
  .region('us-central1')
  .auth.user()
  .onCreate(async user => {
    const userRef = db.collection('users').doc(user.uid);
    const snap = await userRef.get();
    if (snap.exists) return;

    const email = (user.email || '').trim().toLowerCase();
    const isOwner = email === PLATFORM_OWNER_EMAIL;
    const nowIso = new Date().toISOString();
    const createdAtIso = user.metadata.creationTime
      ? new Date(user.metadata.creationTime).toISOString()
      : nowIso;
    const provider = resolveAuthProviderFromRecord(
      user as unknown as { providerData?: Array<{ providerId?: string }>; phoneNumber?: string }
    );

    await userRef.set(
      {
        uid: user.uid,
        email,
        displayName:
          (user.displayName || '').trim() ||
          (email ? email.split('@')[0] : '') ||
          user.phoneNumber ||
          'Student',
        photoURL: user.photoURL || '',
        phoneNumber: user.phoneNumber || '',
        authProvider: provider,
        role: isOwner ? 'master_admin' : 'user',
        hasAllAccess: isOwner,
        allowedCategories: [],
        assignedCourses: [],
        subscriptionStatus: 'none',
        accessExpiry: null,
        accountStatus: 'active',
        isSuspended: false,
        createdAt: createdAtIso,
        lastLogin: nowIso,
        lastLoginAt: nowIso,
        ...(isOwner ? { isPlatformOwner: true } : {})
      },
      { merge: true }
    );
  });

async function backfillAllAuthUsersToFirestore(): Promise<{
  syncedCount: number;
  totalAuthUsers: number;
  alreadySyncedCount: number;
}> {
  const authUsers: admin.auth.UserRecord[] = [];
  let pageToken: string | undefined;
  do {
    const result = await admin.auth().listUsers(1000, pageToken);
    authUsers.push(...result.users);
    pageToken = result.pageToken;
  } while (pageToken);

  const existingSnap = await db.collection('users').select().get();
  const existingUids = new Set(existingSnap.docs.map(d => d.id));

  let syncedCount = 0;
  let batch = db.batch();
  let batchOps = 0;

  for (const userRecord of authUsers) {
    if (existingUids.has(userRecord.uid)) continue;
    const userRef = db.collection('users').doc(userRecord.uid);
    batch.set(userRef, buildUserDocFromAuthRecord(userRecord));
    existingUids.add(userRecord.uid);
    syncedCount++;
    batchOps++;

    if (batchOps >= 400) {
      await batch.commit();
      batch = db.batch();
      batchOps = 0;
    }
  }

  if (batchOps > 0) {
    await batch.commit();
  }

  return {
    syncedCount,
    totalAuthUsers: authUsers.length,
    alreadySyncedCount: Math.max(0, authUsers.length - syncedCount)
  };
}

export const userManagementApi = onRequest(
  {
    region: 'us-central1',
    cors: true
  },
  async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const method = req.method.toUpperCase();
    const rawPath = (req.path || '/').replace(/^\/api\/admin/, '') || '/';
    try {
      if (method === 'POST' && rawPath === '/sync-users') {
        await authorizeAdminCaller(req.headers.authorization, 'students.manage');
        const outcome = await backfillAllAuthUsersToFirestore();
        res.status(200).json(outcome);
        return;
      }
      res.status(404).json({ error: `Unknown admin route: ${method} ${rawPath}` });
    } catch (err) {
      if (err instanceof HttpStatusError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: sanitizeError((err as Error).message || 'Sync failed.') });
    }
  }
);

export const syncAuthUsersToFirestore = onCall(
  {
    region: 'us-central1'
  },
  async request => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Authentication required.');
    }
    const email = (request.auth.token.email || '').toLowerCase();
    const isOwner = email === PLATFORM_OWNER_EMAIL && request.auth.token.email_verified === true;
    if (!isOwner) {
      const userDoc = await db.collection('users').doc(request.auth.uid).get();
      const profile = userDoc.data();
      const allowed =
        profile &&
        profile.isSuspended !== true &&
        (profile.role === 'master_admin' ||
          (profile.role === 'admin' &&
            Array.isArray(profile.permissions) &&
            (profile.permissions.includes('students.manage') ||
              profile.permissions.includes('payments.verify'))));
      if (!allowed) {
        throw new HttpsError('permission-denied', 'Student management permission required.');
      }
    }
    return backfillAllAuthUsersToFirestore();
  }
);
