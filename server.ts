import 'dotenv/config';
import express from 'express';
import type { Request, Response } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { PaymentRequest, TelegramDashboardResponse } from './src/types/index.ts';
import {
  encryptBotToken,
  maskBotToken,
  sanitizeErrorMessage,
  validateBotTokenFormat,
  validateChatIdFormat
} from './server/telegramCrypto.ts';
import {
  authorizeAdmin,
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

const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';

async function requireAdminContext(
  req: Request,
  res: Response,
  requiredPermission: 'telegram.manage' | 'payments.verify' = 'telegram.manage'
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

  return app;
}

async function startServer() {
  const app = createApp();

  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    if (fs.existsSync(distDir)) {
      app.use(express.static(distDir));
      app.get('*', (_req: Request, res: Response) => {
        res.sendFile(path.join(distDir, 'index.html'));
      });
    }
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Skill-Flix server running at http://0.0.0.0:${PORT}`);
  });
}

// Only start HTTP listener when executed as entry module
const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === path.resolve('server.ts');
if (isMainModule) {
  void startServer();
}
