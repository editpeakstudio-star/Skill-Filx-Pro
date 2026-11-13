import * as admin from 'firebase-admin';
import * as crypto from 'node:crypto';
import { onDocumentCreated, onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();
const TELEGRAM_ENCRYPTION_KEY = defineSecret('TELEGRAM_ENCRYPTION_KEY');
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
  isActive: boolean;
  totalSentCount?: number;
  totalFailedCount?: number;
}

function resolveKey(secretValue: string): Buffer {
  const trimmed = secretValue.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }
  return crypto.createHash('sha256').update(trimmed, 'utf8').digest();
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

function buildHtml(payment: PaymentDoc, eventType: 'payment_submitted' | 'payment_approved' | 'payment_rejected'): string {
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

  return [
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
  ].join('\n');
}

async function sendMessageWithRetry(
  botToken: string,
  chatId: string,
  html: string
): Promise<{ ok: boolean; messageId?: number; errorCode?: string; errorMessage?: string; attempts: number }> {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  let lastCode = 'UNKNOWN';
  let lastMessage = 'Telegram sendMessage failed.';

  for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: html,
          parse_mode: 'HTML',
          disable_web_page_preview: true
        }),
        signal: controller.signal
      });
      clearTimeout(timer);

      const json = (await res.json().catch(() => null)) as {
        ok?: boolean;
        result?: { message_id?: number };
        error_code?: number;
        description?: string;
        parameters?: { retry_after?: number };
      } | null;

      if (res.ok && json?.ok) {
        return { ok: true, messageId: json.result?.message_id, attempts: attempt };
      }

      const code = json?.error_code || res.status || 500;
      lastCode = `TG_${code}`;
      lastMessage = sanitizeError(json?.description || `HTTP ${code}`, [botToken]);

      if (!(code === 429 || code >= 500) || attempt >= MAX_RETRY_ATTEMPTS) {
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
      if (attempt >= MAX_RETRY_ATTEMPTS) {
        return { ok: false, errorCode: lastCode, errorMessage: lastMessage, attempts: attempt };
      }
      await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt - 1)));
    }
  }

  return { ok: false, errorCode: lastCode, errorMessage: lastMessage, attempts: MAX_RETRY_ATTEMPTS };
}

async function dispatchForPayment(
  payment: PaymentDoc,
  eventType: 'payment_submitted' | 'payment_approved' | 'payment_rejected',
  secretValue: string
) {
  const jobId = eventType === 'payment_submitted' ? payment.id : `${payment.id}__${eventType}`;
  const jobRef = db.collection('telegramNotificationJobs').doc(jobId);

  // Idempotency claim via Firestore transaction
  const shouldProceed = await db.runTransaction(async tx => {
    const snap = await tx.get(jobRef);
    if (snap.exists && snap.data()?.overallStatus !== 'PENDING') {
      return false;
    }
    const now = new Date().toISOString();
    tx.set(jobRef, {
      id: jobId,
      paymentRequestId: payment.id,
      eventType,
      studentName: payment.userName,
      studentEmail: payment.userEmail,
      courseName:
        payment.planType === 'all_access'
          ? 'All-Access Pass'
          : payment.categoryName || payment.categoryId || 'Category Pass',
      amount: payment.amount,
      utr: payment.utr,
      paymentMethod: 'UPI',
      paymentStatus: payment.status,
      overallStatus: 'PENDING',
      totalActiveBots: 0,
      sentCount: 0,
      failedCount: 0,
      createdAt: now,
      updatedAt: now
    });
    return true;
  });

  if (!shouldProceed) return;

  const botsSnap = await db.collection('telegramBots').where('isActive', '==', true).get();
  const activeBots = botsSnap.docs.map(d => ({ id: d.id, ...d.data() }) as BotDoc);
  const now = new Date().toISOString();

  if (activeBots.length === 0) {
    await jobRef.update({
      overallStatus: 'SKIPPED_NO_ACTIVE_BOTS',
      updatedAt: now,
      lastAttemptAt: now
    });
    return;
  }

  const html = buildHtml(payment, eventType);
  const courseName =
    payment.planType === 'all_access'
      ? 'All-Access Pass'
      : payment.categoryName || payment.categoryId || 'Category Pass';

  const outcomes = await Promise.allSettled(
    activeBots.map(async bot => {
      const logId = `${jobId}__${bot.id}`;
      const logRef = db.collection('telegramNotificationLogs').doc(logId);
      const plainToken = decryptToken(bot.encryptedToken, secretValue);
      const res = await sendMessageWithRetry(plainToken, bot.chatId, html);
      const ts = new Date().toISOString();

      await logRef.set({
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
        status: res.ok ? 'SENT' : 'FAILED',
        attemptCount: res.attempts,
        ...(res.messageId ? { telegramMessageId: res.messageId } : {}),
        ...(res.errorCode ? { errorCode: res.errorCode } : {}),
        ...(res.errorMessage ? { errorMessage: res.errorMessage } : {}),
        createdAt: now,
        updatedAt: ts,
        ...(res.ok ? { sentAt: ts } : {})
      });

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
  const overallStatus =
    sentCount > 0 && failedCount === 0
      ? 'SENT'
      : sentCount > 0 && failedCount > 0
        ? 'PARTIAL_FAILURE'
        : 'FAILED';

  await jobRef.update({
    totalActiveBots: activeBots.length,
    sentCount,
    failedCount,
    overallStatus,
    updatedAt: new Date().toISOString(),
    lastAttemptAt: new Date().toISOString()
  });
}

export const onPaymentRequestCreated = onDocumentCreated(
  {
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
    await dispatchForPayment({ ...after, id: event.params.paymentId }, eventType, TELEGRAM_ENCRYPTION_KEY.value());
  }
);

export const retryFailedTelegramLog = onCall(
  { secrets: [TELEGRAM_ENCRYPTION_KEY] },
  async request => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Authentication required.');
    }
    const userDoc = await db.collection('users').doc(request.auth.uid).get();
    const profile = userDoc.data();
    const isOwner =
      request.auth.token.email === 'editpeakstudio@gmail.com' &&
      request.auth.token.email_verified === true;
    const isAllowed =
      isOwner ||
      (profile &&
        profile.isSuspended !== true &&
        (profile.role === 'master_admin' ||
          (profile.role === 'admin' &&
            Array.isArray(profile.permissions) &&
            profile.permissions.includes('telegram.manage'))));

    if (!isAllowed) {
      throw new HttpsError('permission-denied', 'Telegram management permission required.');
    }

    const logId = String(request.data?.logId || '').trim();
    if (!logId) throw new HttpsError('invalid-argument', 'logId is required.');

    const logRef = db.collection('telegramNotificationLogs').doc(logId);
    const logSnap = await logRef.get();
    if (!logSnap.exists) throw new HttpsError('not-found', 'Notification log not found.');
    const logData = logSnap.data()!;
    if (logData.status === 'SENT') {
      throw new HttpsError('failed-precondition', 'Notification already SENT.');
    }

    const botSnap = await db.collection('telegramBots').doc(logData.botId).get();
    if (!botSnap.exists) throw new HttpsError('not-found', 'Bot not found.');
    const bot = botSnap.data() as BotDoc;

    const paymentSnap = await db.collection('paymentRequests').doc(logData.paymentRequestId).get();
    if (!paymentSnap.exists) throw new HttpsError('not-found', 'Payment request not found.');
    const payment = { id: paymentSnap.id, ...paymentSnap.data() } as PaymentDoc;

    const plainToken = decryptToken(bot.encryptedToken, TELEGRAM_ENCRYPTION_KEY.value());
    const html = buildHtml(payment, logData.eventType);
    const res = await sendMessageWithRetry(plainToken, bot.chatId, html);
    const now = new Date().toISOString();

    await logRef.update({
      status: res.ok ? 'SENT' : 'FAILED',
      attemptCount: admin.firestore.FieldValue.increment(res.attempts),
      updatedAt: now,
      ...(res.ok
        ? {
            telegramMessageId: res.messageId || null,
            errorCode: admin.firestore.FieldValue.delete(),
            errorMessage: admin.firestore.FieldValue.delete(),
            sentAt: now
          }
        : {
            errorCode: res.errorCode || 'FAILED',
            errorMessage: res.errorMessage || 'Retry failed.'
          })
    });

    return { ok: res.ok, errorMessage: res.errorMessage };
  }
);
