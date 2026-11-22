import 'dotenv/config';
import express from 'express';
import type { Request, Response } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AiAdminConfigUpdatePayload, PaymentRequest, TelegramDashboardResponse } from './src/types/index.ts';
import {
  encryptBotToken,
  maskBotToken,
  sanitizeErrorMessage,
  validateBotTokenFormat,
  validateChatIdFormat
} from './server/telegramCrypto.ts';
import {
  authorizeAdmin,
  authorizeSuperAdmin,
  extractBearerToken,
  fetchFirestoreDocument,
  verifyFirebaseIdToken
} from './server/firebaseAuthVerify.ts';
import {
  computeDashboardSummary,
  mutateStore,
  queryPaginatedLogs,
  readStoreSnapshot,
  removeBotFromFirestore,
  syncBotToFirestore,
  syncStoreFromFirestore,
  toPublicBot
} from './server/telegramStore.ts';
import {
  dispatchPaymentNotification,
  retryFailedJobLogs,
  retryFailedNotificationLog,
  sendTestPaymentNotification,
  testBotConnection
} from './server/telegramEngine.ts';
import {
  AiServiceError,
  getAsyncAiStatus,
  handleSkillFlixAiChat,
  handleSkillFlixAiChatStream,
  testAiConfigurationConnection,
  type AiChatRequestBody
} from './server/skillFlixAi.ts';
import {
  getAdminAiConfigView,
  saveAdminAiConfig
} from './server/aiConfigStore.ts';

function resolveListenPort(): number {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--port' && args[i + 1]) {
      const parsed = Number(args[i + 1]);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    } else if (arg.startsWith('--port=')) {
      const parsed = Number(arg.slice('--port='.length));
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }
  const envPort = Number(process.env.PORT || 0);
  const nginxPort = Number(process.env.NGINX_PORT || 0);
  const defaultPort = Number(process.env.DEFAULT_APP_PORT || 3000);
  if (process.env.NODE_ENV !== 'production' && nginxPort > 0 && envPort === nginxPort) {
    return defaultPort;
  }
  return envPort > 0 ? envPort : defaultPort;
}

function resolveListenHost(): string {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--host' && args[i + 1]) return args[i + 1];
    if (arg.startsWith('--host=')) return arg.slice('--host='.length);
  }
  return process.env.HOST || '0.0.0.0';
}

const PORT = resolveListenPort();
const HOST = resolveListenHost();
const isProduction = process.env.NODE_ENV === 'production';

async function requireAdminContext(
  req: Request,
  res: Response,
  requiredPermission: 'telegram.manage' | 'payments.verify' | 'students.manage' = 'telegram.manage'
) {
  const token = extractBearerToken(req.headers.authorization);
  if (!token) {
    res.status(401).json({ error: 'Missing Firebase authentication token.' });
    return null;
  }
  try {
    return await authorizeAdmin(token, requiredPermission);
  } catch (err) {
    const message = (err as Error).message || 'Unauthorized';
    const status = message.toLowerCase().includes('forbidden') ? 403 : 401;
    res.status(status).json({ error: message });
    return null;
  }
}

async function requireSuperAdminContext(req: Request, res: Response) {
  const token = extractBearerToken(req.headers.authorization);
  if (!token) {
    res.status(401).json({ error: 'Missing Firebase authentication token.' });
    return null;
  }
  try {
    return await authorizeSuperAdmin(token);
  } catch (err) {
    const message = (err as Error).message || 'Forbidden';
    const status = message.toLowerCase().includes('forbidden') ? 403 : 401;
    res.status(status).json({ error: message });
    return null;
  }
}

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // ======================================================
  // HEALTH CHECK
  // ======================================================
  app.get('/api/telegram/health', (_req: Request, res: Response) => {
    res.json({ ok: true, service: 'skill-flix-telegram-engine', timestamp: new Date().toISOString() });
  });

  // ======================================================
  // ADMIN DASHBOARD (Summary, Bots, Paginated Logs, Jobs)
  // ======================================================
  app.get('/api/telegram/dashboard', async (req: Request, res: Response) => {
    const admin = await requireAdminContext(req, res, 'telegram.manage');
    if (!admin) return;

    await syncStoreFromFirestore(admin.idToken);

    const store = readStoreSnapshot();
    const status = typeof req.query.status === 'string' ? req.query.status : 'ALL';
    const search = typeof req.query.search === 'string' ? req.query.search : '';
    const page = Number(req.query.page || 1);
    const pageSize = Number(req.query.pageSize || 12);

    const bots = Object.values(store.bots)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .map(toPublicBot);

    const { logs, pagination } = queryPaginatedLogs(store, { status, search, page, pageSize });
    const summary = computeDashboardSummary(store);

    const payload: TelegramDashboardResponse = {
      summary,
      bots,
      logs,
      logsPagination: pagination,
      jobsByPaymentId: store.jobs,
      settings: store.settings
    };

    res.json(payload);
  });

  // Lightweight job statuses endpoint for Payment Proofs tab (accessible to payments.verify admins)
  app.get('/api/telegram/payment-jobs', async (req: Request, res: Response) => {
    const admin = await requireAdminContext(req, res, 'payments.verify');
    if (!admin) return;

    const store = readStoreSnapshot();
    res.json({
      jobsByPaymentId: store.jobs,
      logsByPaymentId: Object.values(store.logs).reduce<Record<string, typeof store.logs[string][]>>(
        (acc, log) => {
          if (!acc[log.paymentRequestId]) acc[log.paymentRequestId] = [];
          acc[log.paymentRequestId].push(log);
          return acc;
        },
        {}
      )
    });
  });

  // ======================================================
  // BOT CRUD & CONTROLS
  // ======================================================
  app.post('/api/telegram/bots', async (req: Request, res: Response) => {
    const admin = await requireAdminContext(req, res, 'telegram.manage');
    if (!admin) return;

    try {
      const body = req.body as {
        botName?: string;
        token?: string;
        chatId?: string;
        description?: string;
        isActive?: boolean;
      };

      const botName = (body.botName || '').trim();
      const rawToken = (body.token || '').trim();
      const chatId = (body.chatId || '').trim();
      const description = (body.description || '').trim();
      const isActive = body.isActive !== false;

      if (!botName || botName.length < 2) {
        res.status(400).json({ error: 'Bot Name must be at least 2 characters.' });
        return;
      }

      const tokenCheck = validateBotTokenFormat(rawToken);
      if (!tokenCheck.valid) {
        res.status(400).json({ error: tokenCheck.error });
        return;
      }

      const chatCheck = validateChatIdFormat(chatId);
      if (!chatCheck.valid) {
        res.status(400).json({ error: chatCheck.error });
        return;
      }

      const encryptedToken = encryptBotToken(rawToken);
      const maskedToken = maskBotToken(rawToken);
      const now = new Date().toISOString();
      const id = `tgbot_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;

      const stored = await mutateStore(store => {
        const record = {
          id,
          botName,
          maskedToken,
          encryptedToken,
          chatId,
          description,
          isActive,
          createdAt: now,
          updatedAt: now,
          createdByUid: admin.uid,
          createdByEmail: admin.email,
          totalSentCount: 0,
          totalFailedCount: 0
        };
        store.bots[id] = record;
        return record;
      });

      void syncBotToFirestore(stored, admin.idToken);
      res.status(201).json({ bot: toPublicBot(stored) });
    } catch (err) {
      res.status(500).json({ error: sanitizeErrorMessage((err as Error).message) });
    }
  });

  app.put('/api/telegram/bots/:id', async (req: Request, res: Response) => {
    const admin = await requireAdminContext(req, res, 'telegram.manage');
    if (!admin) return;

    try {
      const botId = String(req.params.id || '');
      const body = req.body as {
        botName?: string;
        token?: string;
        chatId?: string;
        description?: string;
        isActive?: boolean;
      };

      const botName = (body.botName || '').trim();
      const rawToken = (body.token || '').trim();
      const chatId = (body.chatId || '').trim();
      const description = (body.description || '').trim();

      if (!botName || botName.length < 2) {
        res.status(400).json({ error: 'Bot Name must be at least 2 characters.' });
        return;
      }

      const chatCheck = validateChatIdFormat(chatId);
      if (!chatCheck.valid) {
        res.status(400).json({ error: chatCheck.error });
        return;
      }

      if (rawToken) {
        const tokenCheck = validateBotTokenFormat(rawToken);
        if (!tokenCheck.valid) {
          res.status(400).json({ error: tokenCheck.error });
          return;
        }
      }

      const updated = await mutateStore(store => {
        const existing = store.bots[botId];
        if (!existing) return null;

        existing.botName = botName;
        existing.chatId = chatId;
        existing.description = description;
        if (typeof body.isActive === 'boolean') {
          existing.isActive = body.isActive;
        }
        if (rawToken) {
          existing.encryptedToken = encryptBotToken(rawToken);
          existing.maskedToken = maskBotToken(rawToken);
          existing.botUsername = undefined;
        }
        existing.updatedAt = new Date().toISOString();
        return existing;
      });

      if (!updated) {
        res.status(404).json({ error: 'Telegram bot not found.' });
        return;
      }

      void syncBotToFirestore(updated, admin.idToken);
      res.json({ bot: toPublicBot(updated) });
    } catch (err) {
      res.status(500).json({ error: sanitizeErrorMessage((err as Error).message) });
    }
  });

  app.patch('/api/telegram/bots/:id/toggle', async (req: Request, res: Response) => {
    const admin = await requireAdminContext(req, res, 'telegram.manage');
    if (!admin) return;

    const botId = String(req.params.id || '');
    const body = req.body as { isActive?: boolean };

    const updated = await mutateStore(store => {
      const existing = store.bots[botId];
      if (!existing) return null;
      existing.isActive = typeof body.isActive === 'boolean' ? body.isActive : !existing.isActive;
      existing.updatedAt = new Date().toISOString();
      return existing;
    });

    if (!updated) {
      res.status(404).json({ error: 'Telegram bot not found.' });
      return;
    }

    void syncBotToFirestore(updated, admin.idToken);
    res.json({ bot: toPublicBot(updated) });
  });

  app.delete('/api/telegram/bots/:id', async (req: Request, res: Response) => {
    const admin = await requireAdminContext(req, res, 'telegram.manage');
    if (!admin) return;

    const botId = String(req.params.id || '');
    const removed = await mutateStore(store => {
      if (!store.bots[botId]) return false;
      delete store.bots[botId];
      return true;
    });

    if (!removed) {
      res.status(404).json({ error: 'Telegram bot not found.' });
      return;
    }

    void removeBotFromFirestore(botId, admin.idToken);
    res.json({ deleted: true, id: botId });
  });

  app.post('/api/telegram/bots/test-connection', async (req: Request, res: Response) => {
    const admin = await requireAdminContext(req, res, 'telegram.manage');
    if (!admin) return;

    try {
      const body = req.body as {
        botId?: string;
        token?: string;
        chatId?: string;
        botName?: string;
      };
      const result = await testBotConnection({
        botId: body.botId,
        token: body.token,
        chatId: body.chatId,
        botName: body.botName,
        idToken: admin.idToken
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({ success: false, message: sanitizeErrorMessage((err as Error).message) });
    }
  });

  app.post('/api/telegram/bots/:id/send-test', async (req: Request, res: Response) => {
    const admin = await requireAdminContext(req, res, 'telegram.manage');
    if (!admin) return;

    try {
      const result = await sendTestPaymentNotification(String(req.params.id || ''), admin.idToken);
      res.json(result);
    } catch (err) {
      res.status(400).json({ success: false, message: sanitizeErrorMessage((err as Error).message) });
    }
  });

  // ======================================================
  // SETTINGS TOGGLE (Optional Resolution Notifications)
  // ======================================================
  app.put('/api/telegram/settings', async (req: Request, res: Response) => {
    const admin = await requireAdminContext(req, res, 'telegram.manage');
    if (!admin) return;

    const body = req.body as { notifyOnResolution?: boolean };
    const settings = await mutateStore(store => {
      store.settings.notifyOnResolution = Boolean(body.notifyOnResolution);
      return store.settings;
    });

    res.json({ settings });
  });

  // ======================================================
  // PAYMENT SUBMISSION & RESOLUTION DISPATCH
  // ======================================================
  app.post('/api/telegram/notify-payment', async (req: Request, res: Response) => {
    const idToken = extractBearerToken(req.headers.authorization);
    if (!idToken) {
      res.status(401).json({ error: 'Authentication required to trigger payment alert.' });
      return;
    }

    try {
      const caller = await verifyFirebaseIdToken(idToken);
      const body = req.body as { paymentRequestId?: string };
      const paymentRequestId = (body.paymentRequestId || '').trim();

      if (!paymentRequestId) {
        res.status(400).json({ error: 'paymentRequestId is required.' });
        return;
      }

      // Verify the payment request directly from Firestore using the authenticated caller's token
      const remoteDoc = await fetchFirestoreDocument('paymentRequests', paymentRequestId, idToken);
      if (!remoteDoc) {
        res.status(404).json({ error: 'Payment request not found in Firestore.' });
        return;
      }

      const payment = remoteDoc as unknown as PaymentRequest;
      const isOwner = caller.email.toLowerCase() === 'editpeakstudio@gmail.com' && caller.emailVerified;
      if (payment.uid !== caller.uid && !isOwner) {
        // Also allow verified payments admin to trigger notification manually
        try {
          await authorizeAdmin(idToken, 'payments.verify');
        } catch {
          res.status(403).json({ error: 'Forbidden: Cannot trigger notification for another student payment.' });
          return;
        }
      }

      const outcome = await dispatchPaymentNotification(payment, 'payment_submitted', { idToken });
      res.json(outcome);
    } catch (err) {
      res.status(400).json({ error: sanitizeErrorMessage((err as Error).message) });
    }
  });

  app.post('/api/telegram/notify-resolution', async (req: Request, res: Response) => {
    const admin = await requireAdminContext(req, res, 'payments.verify');
    if (!admin) return;

    try {
      const snap = readStoreSnapshot();
      if (!snap.settings.notifyOnResolution) {
        res.json({ skipped: true, reason: 'Resolution notifications are disabled in Telegram Bot Manager settings.' });
        return;
      }

      const body = req.body as {
        paymentRequestId?: string;
        status?: 'approved' | 'rejected';
        adminNote?: string;
      };

      const paymentRequestId = (body.paymentRequestId || '').trim();
      if (!paymentRequestId || (body.status !== 'approved' && body.status !== 'rejected')) {
        res.status(400).json({ error: 'Valid paymentRequestId and status are required.' });
        return;
      }

      const remoteDoc = await fetchFirestoreDocument('paymentRequests', paymentRequestId, admin.idToken);
      if (!remoteDoc) {
        res.status(404).json({ error: 'Payment request not found in Firestore.' });
        return;
      }

      const payment = remoteDoc as unknown as PaymentRequest;
      const eventType = body.status === 'approved' ? 'payment_approved' : 'payment_rejected';
      const outcome = await dispatchPaymentNotification(payment, eventType, {
        idToken: admin.idToken,
        adminNote: body.adminNote
      });

      res.json(outcome);
    } catch (err) {
      res.status(400).json({ error: sanitizeErrorMessage((err as Error).message) });
    }
  });

  // ======================================================
  // RETRY FAILED NOTIFICATIONS (Idempotent)
  // ======================================================
  app.post('/api/telegram/logs/:logId/retry', async (req: Request, res: Response) => {
    const admin = await requireAdminContext(req, res, 'telegram.manage');
    if (!admin) return;

    try {
      const logId = String(req.params.logId || '');
      const outcome = await retryFailedNotificationLog(
        logId,
        async paymentId => {
          const docData = await fetchFirestoreDocument('paymentRequests', paymentId, admin.idToken);
          return docData ? (docData as unknown as PaymentRequest) : null;
        },
        admin.idToken
      );
      res.json(outcome);
    } catch (err) {
      res.status(400).json({ error: sanitizeErrorMessage((err as Error).message) });
    }
  });

  app.post('/api/telegram/jobs/:jobId/retry-failed', async (req: Request, res: Response) => {
    const admin = await requireAdminContext(req, res, 'payments.verify');
    if (!admin) return;

    try {
      const jobId = String(req.params.jobId || '');
      const outcome = await retryFailedJobLogs(
        jobId,
        async paymentId => {
          const docData = await fetchFirestoreDocument('paymentRequests', paymentId, admin.idToken);
          return docData ? (docData as unknown as PaymentRequest) : null;
        },
        admin.idToken
      );
      res.json(outcome);
    } catch (err) {
      res.status(400).json({ error: sanitizeErrorMessage((err as Error).message) });
    }
  });

  // ======================================================
  // ADMIN USER SYNC BACKFILL (Firebase Auth -> Firestore)
  // ======================================================
  app.post('/api/admin/sync-users', async (req: Request, res: Response) => {
    const admin = await requireAdminContext(req, res, 'students.manage');
    if (!admin) return;

    const clientEmail = (process.env.FIREBASE_CLIENT_EMAIL || '').trim();
    const privateKeyRaw = (process.env.FIREBASE_PRIVATE_KEY || '').trim().replace(/\\n/g, '\n');
    const projectId = (process.env.FIREBASE_PROJECT_ID || 'skillflix-academy').trim();

    if (!clientEmail || !privateKeyRaw) {
      res.status(400).json({
        error:
          'Service account credentials (FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY) are not set on the API server to list legacy Auth users.'
      });
      return;
    }

    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const b64u = (v: string | Buffer) =>
        Buffer.from(v).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const header = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
      const claims = b64u(
        JSON.stringify({
          iss: clientEmail,
          sub: clientEmail,
          aud: 'https://oauth2.googleapis.com/token',
          scope: 'https://www.googleapis.com/auth/cloud-platform',
          iat: nowSec,
          exp: nowSec + 3600
        })
      );
      const signer = crypto.createSign('RSA-SHA256');
      signer.update(`${header}.${claims}`);
      signer.end();
      const sig = b64u(signer.sign(privateKeyRaw));

      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion: `${header}.${claims}.${sig}`
        }).toString()
      });
      const tokenJson = (await tokenRes.json()) as { access_token?: string; error_description?: string };
      if (!tokenRes.ok || !tokenJson.access_token) {
        throw new Error(tokenJson.error_description || 'Failed to obtain Google OAuth access token.');
      }

      const authToken = tokenJson.access_token;
      const authUsers: Array<{
        localId?: string;
        email?: string;
        displayName?: string;
        photoUrl?: string;
        phoneNumber?: string;
        createdAt?: string;
        lastLoginAt?: string;
        disabled?: boolean;
        providerUserInfo?: Array<{ providerId?: string }>;
      }> = [];

      let nextPageToken = '';
      for (let i = 0; i < 20; i++) {
        const listUrl = new URL(
          `https://identitytoolkit.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/accounts:batchGet`
        );
        listUrl.searchParams.set('maxResults', '500');
        if (nextPageToken) listUrl.searchParams.set('nextPageToken', nextPageToken);
        const uRes = await fetch(listUrl.toString(), {
          headers: { Authorization: `Bearer ${authToken}`, Accept: 'application/json' }
        });
        if (!uRes.ok) {
          throw new Error(`Identity Toolkit batchGet failed (${uRes.status})`);
        }
        const uJson = (await uRes.json()) as { users?: typeof authUsers; nextPageToken?: string };
        if (Array.isArray(uJson.users)) authUsers.push(...uJson.users);
        if (!uJson.nextPageToken) break;
        nextPageToken = uJson.nextPageToken;
      }

      const existingIds = new Set<string>();
      const fsBase = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/users`;
      let fsPageToken = '';
      for (let i = 0; i < 10; i++) {
        const fUrl = new URL(fsBase);
        fUrl.searchParams.set('pageSize', '200');
        if (fsPageToken) fUrl.searchParams.set('pageToken', fsPageToken);
        const fRes = await fetch(fUrl.toString(), {
          headers: { Authorization: `Bearer ${authToken}`, Accept: 'application/json' }
        });
        if (!fRes.ok) break;
        const fJson = (await fRes.json()) as {
          documents?: Array<{ name?: string }>;
          nextPageToken?: string;
        };
        for (const d of fJson.documents || []) {
          const id = d.name?.split('/').pop();
          if (id) existingIds.add(id);
        }
        if (!fJson.nextPageToken) break;
        fsPageToken = fJson.nextPageToken;
      }

      let syncedCount = 0;
      const nowIso = new Date().toISOString();
      for (const u of authUsers) {
        const uid = (u.localId || '').trim();
        if (!uid || existingIds.has(uid)) continue;
        const email = (u.email || '').trim().toLowerCase();
        const isOwner = email === 'editpeakstudio@gmail.com';
        const createdIso = u.createdAt ? new Date(Number(u.createdAt)).toISOString() : nowIso;
        const lastLoginIso = u.lastLoginAt ? new Date(Number(u.lastLoginAt)).toISOString() : createdIso;
        const ids = (u.providerUserInfo || []).map(p => (p.providerId || '').toLowerCase());
        const provider = ids.includes('google.com')
          ? 'google'
          : ids.includes('phone')
            ? 'phone'
            : ids.includes('password')
              ? 'password'
              : ids[0] || 'other';
        const displayName =
          (u.displayName || '').trim() || (email ? email.split('@')[0] : '') || u.phoneNumber || 'Student';
        const suspended = u.disabled === true && !isOwner;

        const createRes = await fetch(`${fsBase}/${encodeURIComponent(uid)}?currentDocument.exists=false`, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${authToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            fields: {
              uid: { stringValue: uid },
              email: { stringValue: email },
              displayName: { stringValue: displayName },
              photoURL: { stringValue: u.photoUrl || '' },
              phoneNumber: { stringValue: u.phoneNumber || '' },
              authProvider: { stringValue: provider },
              role: { stringValue: isOwner ? 'master_admin' : 'user' },
              hasAllAccess: { booleanValue: isOwner },
              allowedCategories: { arrayValue: { values: [] } },
              assignedCourses: { arrayValue: { values: [] } },
              subscriptionStatus: { stringValue: 'none' },
              accessExpiry: { nullValue: null },
              accountStatus: { stringValue: suspended ? 'suspended' : 'active' },
              isSuspended: { booleanValue: suspended },
              createdAt: { stringValue: createdIso },
              lastLogin: { stringValue: lastLoginIso },
              lastLoginAt: { stringValue: lastLoginIso }
            }
          })
        });
        if (createRes.ok) {
          syncedCount++;
          existingIds.add(uid);
        }
      }

      res.json({
        syncedCount,
        totalAuthUsers: authUsers.length,
        alreadySyncedCount: Math.max(0, authUsers.length - syncedCount)
      });
    } catch (err) {
      res.status(500).json({ error: sanitizeErrorMessage((err as Error).message) });
    }
  });

  // ======================================================
  // OWNER / SUPER ADMIN: AI CONFIGURATION & API SECRETS
  // ======================================================
  app.get('/api/admin/ai-config', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const superAdmin = await requireSuperAdminContext(req, res);
    if (!superAdmin) return;

    try {
      const view = await getAdminAiConfigView(superAdmin.idToken);
      res.json(view);
    } catch (err) {
      res.status(500).json({ error: sanitizeErrorMessage((err as Error).message) });
    }
  });

  app.put('/api/admin/ai-config', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const superAdmin = await requireSuperAdminContext(req, res);
    if (!superAdmin) return;

    const body = (req.body || {}) as Partial<AiAdminConfigUpdatePayload>;
    const submittedKey = typeof body.GEMINI_API_KEY === 'string' ? body.GEMINI_API_KEY.trim() : '';

    try {
      const updated = await saveAdminAiConfig(superAdmin, body);
      res.json(updated);
    } catch (err) {
      let msg = sanitizeErrorMessage((err as Error).message);
      if (submittedKey) {
        msg = msg.split(submittedKey).join('[REDACTED_KEY]');
      }
      const status =
        msg.toLowerCase().includes('must be') || msg.toLowerCase().includes('invalid') ? 400 : 500;
      res.status(status).json({ error: msg });
    }
  });

  app.post('/api/admin/ai-config/test', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const superAdmin = await requireSuperAdminContext(req, res);
    if (!superAdmin) return;

    try {
      const outcome = await testAiConfigurationConnection(superAdmin.idToken);
      res.json(outcome);
    } catch (err) {
      res.status(500).json({
        success: false,
        provider: 'unknown',
        model: 'unknown',
        latencyMs: 0,
        message: sanitizeErrorMessage((err as Error).message)
      });
    }
  });

  // ======================================================
  // SKILL-FLIX AI LEARNING ASSISTANT (Server-Side Free Tier)
  // ======================================================
  app.get('/api/ai/status', async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const status = await getAsyncAiStatus();
    res.json(status);
  });

  const handleExpressAiError = (res: Response, err: any) => {
    if (err instanceof AiServiceError) {
      res.status(err.status).json({
        code: err.code,
        error: err.message,
        quota: err.quota
      });
      return;
    }
    const message = sanitizeErrorMessage((err as Error)?.message || 'Authentication failed.');
    const lower = message.toLowerCase();
    const status =
      lower.includes('expired') || lower.includes('token') || lower.includes('authentication')
        ? 401
        : 500;
    res.status(status).json({
      code: status === 401 ? 'INVALID_AUTH_TOKEN' : 'AI_INTERNAL_ERROR',
      error: message
    });
  };

  const runExpressAiStream = async (req: Request, res: Response) => {
    const idToken = extractBearerToken(req.headers.authorization);
    if (!idToken) {
      res.status(401).json({
        code: 'AUTH_REQUIRED',
        error: 'Please sign in to your Skill-Flix account to chat with Skill-Flix AI.'
      });
      return;
    }

    const abortController = new AbortController();
    const onResClose = () => {
      if (!res.writableEnded) {
        abortController.abort();
      }
    };
    res.on('close', onResClose);

    try {
      const caller = await verifyFirebaseIdToken(idToken);
      const body = (req.body || {}) as AiChatRequestBody;

      await handleSkillFlixAiChatStream(
        caller,
        body,
        {
          onHeadersReady: () => {
            if (res.headersSent) return;
            res.status(200);
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache, no-store, no-transform');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');
            res.flushHeaders?.();
          },
          sendEvent: (event, data) => {
            if (res.writableEnded || abortController.signal.aborted) return;
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          }
        },
        abortController.signal
      );

      if (!res.writableEnded) {
        res.end();
      }
    } catch (err: any) {
      if (!res.headersSent) {
        handleExpressAiError(res, err);
      } else if (!res.writableEnded) {
        const message = sanitizeErrorMessage((err as Error)?.message || 'Skill-Flix AI stream failed.');
        res.write(
          `event: error\ndata: ${JSON.stringify({ status: 502, code: 'AI_STREAM_ERROR', error: message })}\n\n`
        );
        res.end();
      }
    } finally {
      res.off('close', onResClose);
    }
  };

  app.post('/api/ai/chat/stream', runExpressAiStream);

  app.post('/api/ai/chat', async (req: Request, res: Response) => {
    const wantsStream =
      Boolean((req.body as { stream?: unknown } | undefined)?.stream === true) ||
      String(req.headers.accept || '').toLowerCase().includes('text/event-stream');

    if (wantsStream) {
      await runExpressAiStream(req, res);
      return;
    }

    const idToken = extractBearerToken(req.headers.authorization);
    if (!idToken) {
      res.status(401).json({
        code: 'AUTH_REQUIRED',
        error: 'Please sign in to your Skill-Flix account to chat with Skill-Flix AI.'
      });
      return;
    }

    const abortController = new AbortController();
    const onResClose = () => {
      if (!res.writableEnded) abortController.abort();
    };
    res.on('close', onResClose);

    try {
      const caller = await verifyFirebaseIdToken(idToken);
      const body = (req.body || {}) as AiChatRequestBody;
      const outcome = await handleSkillFlixAiChat(caller, body, abortController.signal);
      res.json(outcome);
    } catch (err: any) {
      handleExpressAiError(res, err);
    } finally {
      res.off('close', onResClose);
    }
  });

  return app;
}

async function startServer() {
  const app = createApp();

  if (!isProduction) {
    let viteMiddleware: express.RequestHandler | null = null;
    let viteError: unknown = null;

    const viteReadyPromise = import('vite')
      .then(({ createServer: createViteServer }) =>
        createViteServer({
          server: {
            middlewareMode: true,
            hmr: process.env.DISABLE_HMR === 'true' ? false : undefined
          },
          appType: 'spa'
        })
      )
      .then(vite => {
        viteMiddleware = vite.middlewares;
      })
      .catch(err => {
        viteError = err;
        console.error('Failed to initialize Vite dev middleware:', err);
      });

    app.use(async (req, res, next) => {
      if (!viteMiddleware && !viteError) {
        await viteReadyPromise;
      }
      if (viteMiddleware) {
        viteMiddleware(req, res, next);
        return;
      }
      if (viteError) {
        res.status(500).send('Vite dev middleware failed to initialize.');
        return;
      }
      next();
    });
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    if (fs.existsSync(distDir)) {
      app.use(express.static(distDir));
      app.get('*', (_req: Request, res: Response) => {
        res.sendFile(path.join(distDir, 'index.html'));
      });
    }
  }

  const server = app.listen(PORT, HOST, () => {
    console.log(`Skill-Flix server running at http://${HOST}:${PORT}`);
  });

  server.on('error', err => {
    console.error(`Failed to bind server on ${HOST}:${PORT}:`, err);
    process.exit(1);
  });
}

// Only start HTTP listener when executed as entry module
const currentFile = fileURLToPath(import.meta.url);
const entryFile = process.argv[1] ? path.resolve(process.argv[1]) : '';
const isMainModule =
  Boolean(entryFile) &&
  (entryFile === currentFile ||
    (fs.existsSync(entryFile) && fs.realpathSync(entryFile) === fs.realpathSync(currentFile)));
if (isMainModule) {
  void startServer();
}
