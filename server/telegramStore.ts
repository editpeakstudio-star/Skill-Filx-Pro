import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  TelegramBotConfig,
  TelegramDashboardSummary,
  TelegramManagerSettings,
  TelegramNotificationJob,
  TelegramNotificationLog,
  TelegramNotificationStatus
} from '../src/types/index.ts';
import {
  deleteFirestoreDocument,
  listFirestoreCollection,
  upsertFirestoreDocument
} from './firebaseAuthVerify.ts';

export interface StoredTelegramBot extends TelegramBotConfig {
  encryptedToken: string;
}

interface StoreShape {
  bots: Record<string, StoredTelegramBot>;
  jobs: Record<string, TelegramNotificationJob>;
  logs: Record<string, TelegramNotificationLog>;
  settings: TelegramManagerSettings;
}

const DEFAULT_DATA_DIR = path.resolve(process.cwd(), '.data');
const STORE_FILENAME = 'telegram-store.json';

function resolveStorePath(): string {
  const dir = process.env.TELEGRAM_DATA_DIR
    ? path.resolve(process.env.TELEGRAM_DATA_DIR)
    : DEFAULT_DATA_DIR;
  return path.join(dir, STORE_FILENAME);
}

function emptyStore(): StoreShape {
  return {
    bots: {},
    jobs: {},
    logs: {},
    settings: { notifyOnResolution: false }
  };
}

function readStoreFile(): StoreShape {
  const filePath = resolveStorePath();
  try {
    if (!fs.existsSync(filePath)) {
      return emptyStore();
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return emptyStore();
    const parsed = JSON.parse(raw) as Partial<StoreShape>;
    return {
      bots: parsed.bots || {},
      jobs: parsed.jobs || {},
      logs: parsed.logs || {},
      settings: {
        notifyOnResolution: Boolean(parsed.settings?.notifyOnResolution)
      }
    };
  } catch (err) {
    console.warn('Warning reading telegram store, initializing clean store:', err);
    return emptyStore();
  }
}

let writeLock: Promise<void> = Promise.resolve();

function writeStoreFileSync(data: StoreShape): void {
  const filePath = resolveStorePath();
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpFile = `${filePath}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmpFile, filePath);
}

export async function mutateStore<T>(mutator: (store: StoreShape) => T | Promise<T>): Promise<T> {
  const run = writeLock.then(async () => {
    const store = readStoreFile();
    const result = await mutator(store);
    writeStoreFileSync(store);
    return result;
  });
  writeLock = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

export function readStoreSnapshot(): StoreShape {
  return readStoreFile();
}

/**
 * Strips encryptedToken before returning bot records to any API response or UI.
 */
export function toPublicBot(bot: StoredTelegramBot): TelegramBotConfig {
  const { encryptedToken: _omitted, ...publicFields } = bot;
  return publicFields;
}

export function computeDashboardSummary(store: StoreShape): TelegramDashboardSummary {
  const allBots = Object.values(store.bots);
  const activeBots = allBots.filter(b => b.isActive).length;
  const inactiveBots = allBots.length - activeBots;

  const allLogs = Object.values(store.logs);
  const sentLogs = allLogs.filter(l => l.status === 'SENT');
  const failedLogs = allLogs.filter(l => l.status === 'FAILED');

  let lastSuccessfulNotificationAt: string | null = null;
  for (const log of sentLogs) {
    const ts = log.sentAt || log.updatedAt;
    if (ts && (!lastSuccessfulNotificationAt || ts > lastSuccessfulNotificationAt)) {
      lastSuccessfulNotificationAt = ts;
    }
  }

  return {
    totalBots: allBots.length,
    activeBots,
    inactiveBots,
    totalNotificationsSent: sentLogs.length,
    totalFailedNotifications: failedLogs.length,
    lastSuccessfulNotificationAt
  };
}

export function queryPaginatedLogs(
  store: StoreShape,
  options: {
    status?: string;
    search?: string;
    page?: number;
    pageSize?: number;
  }
) {
  const statusFilter = (options.status || 'ALL').toUpperCase();
  const q = (options.search || '').trim().toLowerCase();
  const page = Math.max(1, Number(options.page || 1));
  const pageSize = Math.min(50, Math.max(5, Number(options.pageSize || 12)));

  let items = Object.values(store.logs);

  if (statusFilter !== 'ALL') {
    items = items.filter(l => l.status === (statusFilter as TelegramNotificationStatus));
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
  const paged = items.slice(start, start + pageSize);

  return {
    logs: paged,
    pagination: {
      page: safePage,
      pageSize,
      total,
      totalPages
    }
  };
}

// ======================================================
// FIRESTORE SYNCHRONIZATION (Best-Effort with Bearer Token)
// ======================================================

export async function syncBotToFirestore(bot: StoredTelegramBot, idToken?: string): Promise<void> {
  if (!idToken) return;
  try {
    await upsertFirestoreDocument(
      'telegramBots',
      bot.id,
      bot as unknown as Record<string, unknown>,
      idToken
    );
  } catch (err) {
    console.warn('Firestore telegramBots sync note:', (err as Error).message);
  }
}

export async function removeBotFromFirestore(botId: string, idToken?: string): Promise<void> {
  if (!idToken) return;
  try {
    await deleteFirestoreDocument('telegramBots', botId, idToken);
  } catch (err) {
    console.warn('Firestore telegramBots delete sync note:', (err as Error).message);
  }
}

export async function syncJobAndLogsToFirestore(
  job: TelegramNotificationJob,
  logs: TelegramNotificationLog[],
  idToken?: string
): Promise<void> {
  if (!idToken) return;
  try {
    await upsertFirestoreDocument(
      'telegramNotificationJobs',
      job.id,
      job as unknown as Record<string, unknown>,
      idToken
    );
    await Promise.allSettled(
      logs.map(log =>
        upsertFirestoreDocument(
          'telegramNotificationLogs',
          log.id,
          log as unknown as Record<string, unknown>,
          idToken
        )
      )
    );
  } catch (err) {
    console.warn('Firestore telegram job/log sync note:', (err as Error).message);
  }
}

/**
 * Reconciles remote Firestore bot/job/log records with local store when an authenticated
 * admin loads the Telegram Bot Manager dashboard.
 */
export async function syncStoreFromFirestore(idToken: string): Promise<void> {
  try {
    const [remoteBots, remoteJobs, remoteLogs] = await Promise.all([
      listFirestoreCollection('telegramBots', idToken).catch(() => null),
      listFirestoreCollection('telegramNotificationJobs', idToken).catch(() => null),
      listFirestoreCollection('telegramNotificationLogs', idToken).catch(() => null)
    ]);

    if (!remoteBots && !remoteJobs && !remoteLogs) return;

    await mutateStore(store => {
      if (remoteBots) {
        for (const item of remoteBots) {
          const bot = item as unknown as StoredTelegramBot;
          if (!bot.id || !bot.encryptedToken || !bot.maskedToken) continue;
          const local = store.bots[bot.id];
          if (!local || (bot.updatedAt && bot.updatedAt > local.updatedAt)) {
            store.bots[bot.id] = {
              ...bot,
              totalSentCount: Number(bot.totalSentCount || 0),
              totalFailedCount: Number(bot.totalFailedCount || 0)
            };
          }
        }
      }
      if (remoteJobs) {
        for (const item of remoteJobs) {
          const job = item as unknown as TelegramNotificationJob;
          if (!job.id) continue;
          const local = store.jobs[job.id];
          if (!local || (job.updatedAt && job.updatedAt > local.updatedAt)) {
            store.jobs[job.id] = {
              ...job,
              amount: Number(job.amount || 0),
              totalActiveBots: Number(job.totalActiveBots || 0),
              sentCount: Number(job.sentCount || 0),
              failedCount: Number(job.failedCount || 0)
            };
          }
        }
      }
      if (remoteLogs) {
        for (const item of remoteLogs) {
          const log = item as unknown as TelegramNotificationLog;
          if (!log.id) continue;
          const local = store.logs[log.id];
          if (!local || (log.updatedAt && log.updatedAt > local.updatedAt)) {
            store.logs[log.id] = {
              ...log,
              amount: Number(log.amount || 0),
              attemptCount: Number(log.attemptCount || 1)
            };
          }
        }
      }
    });
  } catch (err) {
    console.warn('Firestore bidirectional sync warning:', (err as Error).message);
  }
}
