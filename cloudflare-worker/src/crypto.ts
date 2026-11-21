import { HttpError } from './types';

const ENCRYPTION_PREFIX = 'v1:';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error('Invalid hex payload.');
  }
  const out = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function importAesKey(secret?: string): Promise<CryptoKey> {
  const trimmed = (secret || '').trim();
  if (!trimmed) {
    throw new HttpError(
      500,
      'TELEGRAM_ENCRYPTION_KEY secret is not configured in Cloudflare Worker.'
    );
  }

  let keyBytes: Uint8Array<ArrayBuffer>;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    keyBytes = fromHex(trimmed);
  } else {
    const hash = await crypto.subtle.digest('SHA-256', encoder.encode(trimmed));
    keyBytes = new Uint8Array(hash);
  }

  return crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptBotToken(plainToken: string, secret?: string): Promise<string> {
  const clean = plainToken.trim();
  if (!clean) {
    throw new HttpError(400, 'Telegram bot token cannot be empty.');
  }

  const key = await importAesKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encryptedBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, tagLength: 128 },
    key,
    encoder.encode(clean)
  );

  const combined = new Uint8Array(encryptedBuffer);
  const ciphertext = combined.slice(0, combined.length - 16);
  const authTag = combined.slice(combined.length - 16);

  return `${ENCRYPTION_PREFIX}${toHex(iv)}:${toHex(authTag)}:${toHex(ciphertext)}`;
}

export async function decryptBotToken(encryptedPayload: string, secret?: string): Promise<string> {
  if (!encryptedPayload || !encryptedPayload.startsWith(ENCRYPTION_PREFIX)) {
    throw new Error('Invalid encrypted bot token format.');
  }
  const parts = encryptedPayload.slice(ENCRYPTION_PREFIX.length).split(':');
  if (parts.length !== 3) {
    throw new Error('Corrupted encrypted bot token payload.');
  }

  const [ivHex, tagHex, cipherHex] = parts;
  const iv = fromHex(ivHex);
  const tag = fromHex(tagHex);
  const cipher = fromHex(cipherHex);

  const combined = new Uint8Array(new ArrayBuffer(cipher.length + tag.length));
  combined.set(cipher, 0);
  combined.set(tag, cipher.length);

  const key = await importAesKey(secret);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, tagLength: 128 },
    key,
    combined
  );
  return decoder.decode(decrypted);
}

export function maskBotToken(token: string): string {
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

export function validateBotTokenFormat(token: string): { valid: boolean; error?: string } {
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

export function validateChatIdFormat(chatId: string): { valid: boolean; error?: string } {
  const clean = chatId.trim();
  if (!clean) return { valid: false, error: 'Telegram Chat ID is required.' };
  if (!/^(?:-?\d{5,20}|@[A-Za-z][A-Za-z0-9_]{3,31})$/.test(clean)) {
    return {
      valid: false,
      error:
        'Invalid Telegram Chat ID. Use a numeric user/group ID (e.g. 123456789 or -1001234567890) or @channelusername.'
    };
  }
  return { valid: true };
}

export function sanitizeError(message: string, knownSecrets: string[] = []): string {
  let clean = String(message || 'Unknown error');
  for (const s of knownSecrets) {
    if (s && s.trim()) {
      clean = clean.split(s.trim()).join('[REDACTED_KEY]');
    }
  }
  clean = clean.replace(/bot\d{6,16}:[A-Za-z0-9_-]{12,}/gi, 'bot[REDACTED_TOKEN]');
  clean = clean.replace(/\d{6,16}:[A-Za-z0-9_-]{15,}/g, '[REDACTED_TOKEN]');
  clean = clean.replace(/AIza[0-9A-Za-z_-]{16,}/g, '[REDACTED_API_KEY]');
  clean = clean.replace(/\bAQ\.[A-Za-z0-9._-]{16,}/g, '[REDACTED_API_KEY]');
  clean = clean.replace(/\b(?:gsk_|sk-or-v1-|sk-)[A-Za-z0-9._-]{16,}/g, '[REDACTED_API_KEY]');
  clean = clean.replace(/Bearer\s+[A-Za-z0-9._-]{16,}/gi, 'Bearer [REDACTED_TOKEN]');
  return clean;
}

export function randomHex(byteCount = 4): string {
  return toHex(crypto.getRandomValues(new Uint8Array(byteCount)));
}
