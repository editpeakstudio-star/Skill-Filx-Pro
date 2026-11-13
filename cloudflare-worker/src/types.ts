export interface WorkerEnv {
  FIREBASE_PROJECT_ID?: string;
  ALLOWED_ORIGINS?: string;
  TELEGRAM_ENCRYPTION_KEY?: string;
  FIREBASE_CLIENT_EMAIL?: string;
  FIREBASE_PRIVATE_KEY?: string;
  TELEGRAM_API_BASE?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
}

export type TelegramNotificationStatus = 'SENT' | 'FAILED' | 'PENDING' | 'RETRYING';

export type TelegramJobStatus =
  | 'PENDING'
  | 'SENT'
  | 'PARTIAL_FAILURE'
  | 'FAILED'
  | 'SKIPPED_NO_ACTIVE_BOTS';

export type TelegramEventType = 'payment_submitted' | 'payment_approved' | 'payment_rejected';

export interface StoredTelegramBot {
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
  lastNotificationStatus?: TelegramNotificationStatus;
  lastErrorMessage?: string;
  totalSentCount: number;
  totalFailedCount: number;
}

export type PublicTelegramBot = Omit<StoredTelegramBot, 'encryptedToken'>;

export interface PaymentRequestDoc {
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

export interface TelegramNotificationJob {
  id: string;
  paymentRequestId: string;
  eventType: TelegramEventType;
  studentName: string;
  studentEmail: string;
  courseName: string;
  amount: number;
  utr: string;
  paymentMethod: string;
  paymentStatus: 'pending' | 'approved' | 'rejected';
  overallStatus: TelegramJobStatus;
  totalActiveBots: number;
  sentCount: number;
  failedCount: number;
  createdAt: string;
  updatedAt: string;
  lastAttemptAt?: string;
}

export interface TelegramNotificationLog {
  id: string;
  jobId: string;
  paymentRequestId: string;
  botId: string;
  botName: string;
  chatId: string;
  eventType: TelegramEventType;
  studentName: string;
  studentEmail: string;
  courseName: string;
  amount: number;
  utr: string;
  status: TelegramNotificationStatus;
  attemptCount: number;
  telegramMessageId?: number;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  sentAt?: string;
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
