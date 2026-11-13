import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve(process.cwd(), '.data');
const KEY_FILE = path.join(DATA_DIR, '.telegram-master.key');
const ENCRYPTION_PREFIX = 'v1:';

let cachedKey: Buffer | null = null;

/**
 * Resolves a 32-byte AES-256-GCM master key.
 * Priority:
 * 1. process.env.TELEGRAM_ENCRYPTION_KEY (recommended for production)
 * 2. Persistent local master key stored in .data/.telegram-master.key (0600)
 */
export function getEncryptionMasterKey(): Buffer {
  if (cachedKey) return cachedKey;

  const envKey = process.env.TELEGRAM_ENCRYPTION_KEY?.trim();
  if (envKey) {
    if (/^[0-9a-fA-F]{64}$/.test(envKey)) {
      cachedKey = Buffer.from(envKey, 'hex');
      return cachedKey;
    }
    cachedKey = crypto.createHash('sha256').update(envKey, 'utf8').digest();
    return cachedKey;
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(KEY_FILE)) {
    const existingHex = fs.readFileSync(KEY_FILE, 'utf8').trim();
    if (/^[0-9a-fA-F]{64}$/.test(existingHex)) {
      cachedKey = Buffer.from(existingHex, 'hex');
      return cachedKey;
    }
  }

  const generated = crypto.randomBytes(32);
  fs.writeFileSync(KEY_FILE, generated.toString('hex'), { mode: 0o600 });
  cachedKey = generated;
  return cachedKey;
}

export function resetCachedKeyForTests(): void {
  cachedKey = null;
}

export function encryptBotToken(plainToken: string): string {
  const trimmed = plainToken.trim();
  if (!trimmed) {
    throw new Error('Telegram bot token cannot be empty.');
  }
  const key = getEncryptionMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(trimmed, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${ENCRYPTION_PREFIX}${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptBotToken(encryptedPayload: string): string {
  if (!encryptedPayload || !encryptedPayload.startsWith(ENCRYPTION_PREFIX)) {
    throw new Error('Invalid encrypted bot token format.');
  }
  const parts = encryptedPayload.slice(ENCRYPTION_PREFIX.length).split(':');
  if (parts.length !== 3) {
    throw new Error('Corrupted encrypted bot token payload.');
  }
  const [ivHex, tagHex, dataHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(tagHex, 'hex');
  const encrypted = Buffer.from(dataHex, 'hex');

  const key = getEncryptionMasterKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

export function maskBotToken(token: string): string {
  const clean = token.trim();
  if (!clean) return '••••••••';
  const colonIdx = clean.indexOf(':');
  if (colonIdx > 0 && colonIdx < clean.length - 6) {
    const botIdPart = clean.slice(0, colonIdx);
    const secretPart = clean.slice(colonIdx + 1);
    const head = secretPart.slice(0, 2);
    const tail = secretPart.slice(-4);
    return `${botIdPart}:${head}••••••••${tail}`;
  }
  if (clean.length <= 8) return '••••••••';
  return `${clean.slice(0, 3)}••••••••${clean.slice(-4)}`;
}

export function validateBotTokenFormat(token: string): { valid: boolean; error?: string } {
  const clean = token.trim();
  if (!clean) {
    return { valid: false, error: 'Telegram Bot Token is required.' };
  }
  if (!/^\d{6,16}:[A-Za-z0-9_-]{20,64}$/.test(clean)) {
    return {
      valid: false,
      error: 'Invalid Telegram Bot Token format. Expected format like 123456789:ABCdef...'
    };
  }
  return { valid: true };
}

export function validateChatIdFormat(chatId: string): { valid: boolean; error?: string } {
  const clean = chatId.trim();
  if (!clean) {
    return { valid: false, error: 'Telegram Chat ID is required.' };
  }
  if (!/^(?:-?\d{5,20}|@[A-Za-z][A-Za-z0-9_]{3,31})$/.test(clean)) {
    return {
      valid: false,
      error: 'Invalid Telegram Chat ID. Use a numeric user/group ID (e.g. 123456789 or -1001234567890) or @channelusername.'
    };
  }
  return { valid: true };
}

/**
 * Removes any Telegram bot token patterns or known secrets from error logs/messages.
 */
export function sanitizeErrorMessage(message: string, knownSecrets: string[] = []): string {
  let clean = String(message || 'Unknown error');
  for (const secret of knownSecrets) {
    if (secret && secret.trim()) {
      clean = clean.split(secret.trim()).join('[REDACTED_TOKEN]');
    }
  }
  clean = clean.replace(/bot\d{6,16}:[A-Za-z0-9_-]{12,}/gi, 'bot[REDACTED_TOKEN]');
  clean = clean.replace(/\d{6,16}:[A-Za-z0-9_-]{15,}/g, '[REDACTED_TOKEN]');
  return clean;
}
