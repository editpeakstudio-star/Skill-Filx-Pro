import {
  encryptBotToken,
  maskBotToken,
  randomHex,
  sanitizeError,
  validateBotTokenFormat,
  validateChatIdFormat
} from './crypto';
import {
  authorizeAdmin,
  deleteFirestoreDoc,
  getFirestoreAuthToken,
  getFirestoreDoc,
  listFirestoreCollection,
  upsertFirestoreDoc,
  verifyFirebaseIdToken
} from './firebase';
import {
  dispatchPaymentNotification,
  normalizeJob,
  normalizeLog,
  normalizeStoredBot,
  retryFailedJobLogs,
  retryFailedNotificationLog,
  sendTestPaymentNotification,
  testBotConnection,
  toPublicBot
} from './telegram';
import {
  HttpError,
  type PaymentRequestDoc,
  type StoredTelegramBot,
  type TelegramNotificationJob,
  type TelegramNotificationLog,
  type WorkerEnv
} from './types';

function resolveAllowedOrigin(request: Request, env: WorkerEnv): string | null {
  const origin = (request.headers.get('Origin') || '').trim();
  if (!origin) return '*';

  const configured = (
    env.ALLOWED_ORIGINS ||
    'https://skillflix-academy.web.app,https://skillflix-academy.firebaseapp.com,http://localhost:3000,http://127.0.0.1:3000'
  )
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  if (configured.includes('*') || configured.includes(origin)) {
    return origin;
  }

  // Allow Firebase Hosting preview channels for this project and AI Studio Cloud Run previews
  if (
    /^https:\/\/skillflix-academy(?:--[a-z0-9-]+)?\.(?:web\.app|firebaseapp\.com)$/i.test(origin) ||
    /^https:\/\/[a-z0-9-]+\.(?:[a-z0-9-]+\.)?run\.app$/i.test(origin)
  ) {
    return origin;
  }

  return null;
}

function buildCorsHeaders(request: Request, env: WorkerEnv): Record<string, string> {
  const allowedOrigin = resolveAllowedOrigin(request, env);
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };
  if (allowedOrigin) {
    headers['Access-Control-Allow-Origin'] = allowedOrigin;
  }
  return headers;
}

function jsonResponse(
  request: Request,
  env: WorkerEnv,
  data: unknown,
  status = 200
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...buildCorsHeaders(request, env)
    }
  });
}

async function readJsonBody<T extends Record<string, unknown>>(request: Request): Promise<T> {
  try {
    const raw = await request.text();
    if (!raw.trim()) return {} as T;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HttpError(400, 'Request body must be a JSON object.');
    }
    return parsed as T;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, 'Invalid JSON request body.');
  }
}

function extractBearerToken(authHeader: string | null): string {
  const match = (authHeader || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function computeDashboardSummary(
  bots: StoredTelegramBot[],
  logs: TelegramNotificationLog[]
) {
  const activeBots = bots.filter(b => b.isActive).length;
  const sentLogs = logs.filter(l => l.status === 'SENT');
  const failedLogs = logs.filter(l => l.status === 'FAILED');

  let lastSuccessfulNotificationAt: string | null = null;
  for (const log of sentLogs) {
    const ts = log.sentAt || log.updatedAt;
    if (ts && (!lastSuccessfulNotificationAt || ts > lastSuccessfulNotificationAt)) {
      lastSuccessfulNotificationAt = ts;
    }
  }

  return {
    totalBots: bots.length,
    activeBots,
    inactiveBots: bots.length - activeBots,
    totalNotificationsSent: sentLogs.length,
    totalFailedNotifications: failedLogs.length,
    lastSuccessfulNotificationAt
  };
}

function queryPaginatedLogs(
  logs: TelegramNotificationLog[],
  options: { status?: string; search?: string; page?: number; pageSize?: number }
) {
  const statusFilter = (options.status || 'ALL').toUpperCase();
  const q = (options.search || '').trim().toLowerCase();
  const page = Math.max(1, Number(options.page || 1));
  const pageSize = Math.min(50, Math.max(5, Number(options.pageSize || 12)));

  let items = [...logs];
  if (statusFilter !== 'ALL') {
    items = items.filter(l => l.status === statusFilter);
  }
  if (q) {
    items = items.filter(l => {
      return (
        l.paymentRequestId.toLowerCase().includes(q) ||
        l.studentName.toLowerCase().includes(q) ||
        l.studentEmail.toLowerCase().includes(q) ||
        l.botName.toLowerCase().includes(q) ||
        l.utr.toLowerCase().includes(q) ||
        l.courseName.toLowerCase().includes(q)
      );
    });
  }

  items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * pageSize;

  return {
    logs: items.slice(start, start + pageSize),
    pagination: {
      page: safePage,
      pageSize,
      total,
      totalPages
    }
  };
}

async function handleRequest(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method.toUpperCase();

  if (method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: buildCorsHeaders(request, env)
    });
  }

  // Health Check
  if ((pathname === '/api/telegram/health' || pathname === '/health' || pathname === '/') && method === 'GET') {
    return jsonResponse(request, env, {
      ok: true,
      service: 'skill-flix-telegram-worker',
      runtime: 'cloudflare-workers',
      timestamp: new Date().toISOString()
    });
  }

  const authHeader = request.headers.get('Authorization');

  // GET /api/telegram/dashboard
  if (pathname === '/api/telegram/dashboard' && method === 'GET') {
    const admin = await authorizeAdmin(authHeader, env, 'telegram.manage');
    const fsToken = await getFirestoreAuthToken(env, admin.idToken, false);

    const [rawBots, rawJobs, rawLogs, settingsDoc] = await Promise.all([
      listFirestoreCollection(env, fsToken, 'telegramBots'),
      listFirestoreCollection(env, fsToken, 'telegramNotificationJobs'),
      listFirestoreCollection(env, fsToken, 'telegramNotificationLogs'),
      getFirestoreDoc(env, fsToken, 'settings', 'telegram').catch(() => null)
    ]);

    const bots = rawBots
      .map(normalizeStoredBot)
      .filter((b): b is StoredTelegramBot => Boolean(b))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const jobsByPaymentId: Record<string, TelegramNotificationJob> = {};
    for (const item of rawJobs) {
      const job = normalizeJob(item);
      if (job) jobsByPaymentId[job.id] = job;
    }

    const allLogs = rawLogs
      .map(normalizeLog)
      .filter((l): l is TelegramNotificationLog => Boolean(l));

    const status = url.searchParams.get('status') || 'ALL';
    const search = url.searchParams.get('search') || '';
    const page = Number(url.searchParams.get('page') || 1);
    const pageSize = Number(url.searchParams.get('pageSize') || 12);

    const { logs, pagination } = queryPaginatedLogs(allLogs, { status, search, page, pageSize });
    const summary = computeDashboardSummary(bots, allLogs);

    return jsonResponse(request, env, {
      summary,
      bots: bots.map(toPublicBot),
      logs,
      logsPagination: pagination,
      jobsByPaymentId,
      settings: {
        notifyOnResolution: Boolean(settingsDoc?.notifyOnResolution)
      }
    });
  }

  // GET /api/telegram/payment-jobs
  if (pathname === '/api/telegram/payment-jobs' && method === 'GET') {
    const admin = await authorizeAdmin(authHeader, env, 'payments.verify');
    const fsToken = await getFirestoreAuthToken(env, admin.idToken, false);

    const [rawJobs, rawLogs] = await Promise.all([
      listFirestoreCollection(env, fsToken, 'telegramNotificationJobs'),
      listFirestoreCollection(env, fsToken, 'telegramNotificationLogs')
    ]);

    const jobsByPaymentId: Record<string, TelegramNotificationJob> = {};
    for (const item of rawJobs) {
      const job = normalizeJob(item);
      if (job) jobsByPaymentId[job.id] = job;
    }

    const logsByPaymentId: Record<string, TelegramNotificationLog[]> = {};
    for (const item of rawLogs) {
      const log = normalizeLog(item);
      if (!log) continue;
      if (!logsByPaymentId[log.paymentRequestId]) logsByPaymentId[log.paymentRequestId] = [];
      logsByPaymentId[log.paymentRequestId].push(log);
    }

    return jsonResponse(request, env, { jobsByPaymentId, logsByPaymentId });
  }

  // POST /api/telegram/bots
  if (pathname === '/api/telegram/bots' && method === 'POST') {
    const admin = await authorizeAdmin(authHeader, env, 'telegram.manage');
    const fsToken = await getFirestoreAuthToken(env, admin.idToken, false);

    const body = await readJsonBody<{
      botName?: string;
      token?: string;
      chatId?: string;
      description?: string;
      isActive?: boolean;
    }>(request);

    const botName = (typeof body.botName === 'string' ? body.botName : '').trim();
    const rawToken = (typeof body.token === 'string' ? body.token : '').trim();
    const chatId = (typeof body.chatId === 'string' ? body.chatId : '').trim();
    const description = (typeof body.description === 'string' ? body.description : '').trim();
    const isActive = body.isActive !== false;

    if (!botName || botName.length < 2) {
      throw new HttpError(400, 'Bot Name must be at least 2 characters.');
    }

    const tokenCheck = validateBotTokenFormat(rawToken);
    if (!tokenCheck.valid) {
      throw new HttpError(400, tokenCheck.error || 'Invalid Telegram Bot Token.');
    }

    const chatCheck = validateChatIdFormat(chatId);
    if (!chatCheck.valid) {
      throw new HttpError(400, chatCheck.error || 'Invalid Telegram Chat ID.');
    }

    const encryptedToken = await encryptBotToken(rawToken, env.TELEGRAM_ENCRYPTION_KEY);
    const maskedToken = maskBotToken(rawToken);
    const now = new Date().toISOString();
    const id = `tgbot_${Date.now()}_${randomHex(3)}`;

    const record: StoredTelegramBot = {
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

    await upsertFirestoreDoc(
      env,
      fsToken,
      'telegramBots',
      id,
      record as unknown as Record<string, unknown>
    );

    return jsonResponse(request, env, { bot: toPublicBot(record) }, 201);
  }

  // POST /api/telegram/bots/test-connection
  if (pathname === '/api/telegram/bots/test-connection' && method === 'POST') {
    const admin = await authorizeAdmin(authHeader, env, 'telegram.manage');
    const fsToken = await getFirestoreAuthToken(env, admin.idToken, false);

    const body = await readJsonBody<{
      botId?: string;
      token?: string;
      chatId?: string;
      botName?: string;
    }>(request);

    try {
      const result = await testBotConnection(env, fsToken, {
        botId: typeof body.botId === 'string' ? body.botId : undefined,
        token: typeof body.token === 'string' ? body.token : undefined,
        chatId: typeof body.chatId === 'string' ? body.chatId : undefined,
        botName: typeof body.botName === 'string' ? body.botName : undefined
      });
      return jsonResponse(request, env, result);
    } catch (err) {
      return jsonResponse(
        request,
        env,
        { success: false, message: sanitizeError((err as Error).message) },
        err instanceof HttpError ? err.status : 400
      );
    }
  }

  // POST /api/telegram/bots/:id/send-test
  const sendTestMatch = pathname.match(/^\/api\/telegram\/bots\/([^/]+)\/send-test$/);
  if (sendTestMatch && method === 'POST') {
    const admin = await authorizeAdmin(authHeader, env, 'telegram.manage');
    const fsToken = await getFirestoreAuthToken(env, admin.idToken, false);
    const botId = decodeURIComponent(sendTestMatch[1]);

    try {
      const result = await sendTestPaymentNotification(env, fsToken, botId);
      return jsonResponse(request, env, result);
    } catch (err) {
      return jsonResponse(
        request,
        env,
        { success: false, message: sanitizeError((err as Error).message) },
        err instanceof HttpError ? err.status : 400
      );
    }
  }

  // PATCH /api/telegram/bots/:id/toggle
  const toggleMatch = pathname.match(/^\/api\/telegram\/bots\/([^/]+)\/toggle$/);
  if (toggleMatch && method === 'PATCH') {
    const admin = await authorizeAdmin(authHeader, env, 'telegram.manage');
    const fsToken = await getFirestoreAuthToken(env, admin.idToken, false);
    const botId = decodeURIComponent(toggleMatch[1]);
    const body = await readJsonBody<{ isActive?: boolean }>(request);

    const doc = await getFirestoreDoc(env, fsToken, 'telegramBots', botId);
    const existing = doc ? normalizeStoredBot(doc) : null;
    if (!existing) {
      throw new HttpError(404, 'Telegram bot not found.');
    }

    const updated: StoredTelegramBot = {
      ...existing,
      isActive: typeof body.isActive === 'boolean' ? body.isActive : !existing.isActive,
      updatedAt: new Date().toISOString()
    };

    await upsertFirestoreDoc(
      env,
      fsToken,
      'telegramBots',
      botId,
      updated as unknown as Record<string, unknown>
    );

    return jsonResponse(request, env, { bot: toPublicBot(updated) });
  }

  // PUT / DELETE /api/telegram/bots/:id
  const botMatch = pathname.match(/^\/api\/telegram\/bots\/([^/]+)$/);
  if (botMatch && method === 'PUT') {
    const admin = await authorizeAdmin(authHeader, env, 'telegram.manage');
    const fsToken = await getFirestoreAuthToken(env, admin.idToken, false);
    const botId = decodeURIComponent(botMatch[1]);

    const body = await readJsonBody<{
      botName?: string;
      token?: string;
      chatId?: string;
      description?: string;
      isActive?: boolean;
    }>(request);

    const botName = (typeof body.botName === 'string' ? body.botName : '').trim();
    const rawToken = (typeof body.token === 'string' ? body.token : '').trim();
    const chatId = (typeof body.chatId === 'string' ? body.chatId : '').trim();
    const description = (typeof body.description === 'string' ? body.description : '').trim();

    if (!botName || botName.length < 2) {
      throw new HttpError(400, 'Bot Name must be at least 2 characters.');
    }

    const chatCheck = validateChatIdFormat(chatId);
    if (!chatCheck.valid) {
      throw new HttpError(400, chatCheck.error || 'Invalid Telegram Chat ID.');
    }

    if (rawToken) {
      const tokenCheck = validateBotTokenFormat(rawToken);
      if (!tokenCheck.valid) {
        throw new HttpError(400, tokenCheck.error || 'Invalid Telegram Bot Token.');
      }
    }

    const doc = await getFirestoreDoc(env, fsToken, 'telegramBots', botId);
    const existing = doc ? normalizeStoredBot(doc) : null;
    if (!existing) {
      throw new HttpError(404, 'Telegram bot not found.');
    }

    const updated: StoredTelegramBot = {
      ...existing,
      botName,
      chatId,
      description,
      isActive: typeof body.isActive === 'boolean' ? body.isActive : existing.isActive,
      encryptedToken: rawToken
        ? await encryptBotToken(rawToken, env.TELEGRAM_ENCRYPTION_KEY)
        : existing.encryptedToken,
      maskedToken: rawToken ? maskBotToken(rawToken) : existing.maskedToken,
      botUsername: rawToken ? undefined : existing.botUsername,
      updatedAt: new Date().toISOString()
    };

    await upsertFirestoreDoc(
      env,
      fsToken,
      'telegramBots',
      botId,
      updated as unknown as Record<string, unknown>
    );

    return jsonResponse(request, env, { bot: toPublicBot(updated) });
  }

  if (botMatch && method === 'DELETE') {
    const admin = await authorizeAdmin(authHeader, env, 'telegram.manage');
    const fsToken = await getFirestoreAuthToken(env, admin.idToken, false);
    const botId = decodeURIComponent(botMatch[1]);

    const doc = await getFirestoreDoc(env, fsToken, 'telegramBots', botId);
    if (!doc) {
      throw new HttpError(404, 'Telegram bot not found.');
    }

    await deleteFirestoreDoc(env, fsToken, 'telegramBots', botId);
    return jsonResponse(request, env, { deleted: true, id: botId });
  }

  // PUT /api/telegram/settings
  if (pathname === '/api/telegram/settings' && method === 'PUT') {
    const admin = await authorizeAdmin(authHeader, env, 'telegram.manage');
    const fsToken = await getFirestoreAuthToken(env, admin.idToken, false);
    const body = await readJsonBody<{ notifyOnResolution?: boolean }>(request);

    const notifyOnResolution = Boolean(body.notifyOnResolution);
    await upsertFirestoreDoc(env, fsToken, 'settings', 'telegram', {
      notifyOnResolution,
      updatedAt: new Date().toISOString(),
      updatedByUid: admin.uid
    });

    return jsonResponse(request, env, {
      settings: { notifyOnResolution }
    });
  }

  // POST /api/telegram/notify-payment (called by Student or Admin after creating paymentRequests/{id})
  if (pathname === '/api/telegram/notify-payment' && method === 'POST') {
    const idToken = extractBearerToken(authHeader);
    if (!idToken) {
      throw new HttpError(401, 'Authentication required to trigger payment alert.');
    }

    const caller = await verifyFirebaseIdToken(idToken, env);
    const body = await readJsonBody<{ paymentRequestId?: string }>(request);
    const paymentRequestId = (typeof body.paymentRequestId === 'string' ? body.paymentRequestId : '').trim();
    if (!paymentRequestId) {
      throw new HttpError(400, 'paymentRequestId is required.');
    }

    // Service Account token is required so student calls can read telegramBots & write jobs/logs
    const fsToken = await getFirestoreAuthToken(env, caller.idToken, true);
    const remoteDoc = await getFirestoreDoc(env, fsToken, 'paymentRequests', paymentRequestId);
    if (!remoteDoc) {
      throw new HttpError(404, 'Payment request not found in Firestore.');
    }

    const payment = remoteDoc as unknown as PaymentRequestDoc;
    const isOwner = caller.email.toLowerCase() === 'editpeakstudio@gmail.com' && caller.emailVerified;
    if (payment.uid !== caller.uid && !isOwner) {
      await authorizeAdmin(authHeader, env, 'payments.verify');
    }

    const outcome = await dispatchPaymentNotification(env, fsToken, payment, 'payment_submitted');
    return jsonResponse(request, env, outcome);
  }

  // POST /api/telegram/notify-resolution
  if (pathname === '/api/telegram/notify-resolution' && method === 'POST') {
    const admin = await authorizeAdmin(authHeader, env, 'payments.verify');
    const fsToken = await getFirestoreAuthToken(env, admin.idToken, false);

    const settingsDoc = await getFirestoreDoc(env, fsToken, 'settings', 'telegram').catch(() => null);
    if (!settingsDoc?.notifyOnResolution) {
      return jsonResponse(request, env, {
        skipped: true,
        reason: 'Resolution notifications are disabled in Telegram Bot Manager settings.'
      });
    }

    const body = await readJsonBody<{
      paymentRequestId?: string;
      status?: 'approved' | 'rejected';
      adminNote?: string;
    }>(request);

    const paymentRequestId = (typeof body.paymentRequestId === 'string' ? body.paymentRequestId : '').trim();
    if (!paymentRequestId || (body.status !== 'approved' && body.status !== 'rejected')) {
      throw new HttpError(400, 'Valid paymentRequestId and status are required.');
    }

    const remoteDoc = await getFirestoreDoc(env, fsToken, 'paymentRequests', paymentRequestId);
    if (!remoteDoc) {
      throw new HttpError(404, 'Payment request not found in Firestore.');
    }

    const payment = remoteDoc as unknown as PaymentRequestDoc;
    const eventType = body.status === 'approved' ? 'payment_approved' : 'payment_rejected';
    const outcome = await dispatchPaymentNotification(env, fsToken, payment, eventType, {
      adminNote: typeof body.adminNote === 'string' ? body.adminNote : undefined
    });

    return jsonResponse(request, env, outcome);
  }

  // POST /api/telegram/logs/:logId/retry
  const logRetryMatch = pathname.match(/^\/api\/telegram\/logs\/([^/]+)\/retry$/);
  if (logRetryMatch && method === 'POST') {
    const admin = await authorizeAdmin(authHeader, env, 'telegram.manage');
    const fsToken = await getFirestoreAuthToken(env, admin.idToken, false);
    const logId = decodeURIComponent(logRetryMatch[1]);

    const outcome = await retryFailedNotificationLog(env, fsToken, logId);
    return jsonResponse(request, env, outcome);
  }

  // POST /api/telegram/jobs/:jobId/retry-failed
  const jobRetryMatch = pathname.match(/^\/api\/telegram\/jobs\/([^/]+)\/retry-failed$/);
  if (jobRetryMatch && method === 'POST') {
    const admin = await authorizeAdmin(authHeader, env, 'payments.verify');
    const fsToken = await getFirestoreAuthToken(env, admin.idToken, false);
    const jobId = decodeURIComponent(jobRetryMatch[1]);

    const outcome = await retryFailedJobLogs(env, fsToken, jobId);
    return jsonResponse(request, env, outcome);
  }

  throw new HttpError(404, `Endpoint not found: ${method} ${pathname}`);
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    try {
      return await handleRequest(request, env);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      const message = sanitizeError((err as Error)?.message || 'Internal server error.');
      return jsonResponse(request, env, { error: message }, status);
    }
  }
};
