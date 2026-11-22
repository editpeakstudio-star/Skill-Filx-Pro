import { decryptBotToken, encryptBotToken, sanitizeError } from './crypto';
import {
  getFirestoreAuthToken,
  getFirestoreDoc,
  hasServiceAccountConfig,
  upsertFirestoreDoc,
  type VerifiedAdmin
} from './firebase';
import { HttpError, type WorkerEnv } from './types';

const AI_CONFIG_COLLECTION = 'aiConfig';
const AI_CONFIG_DOC_ID = 'active';
const ALLOWED_PROVIDERS = new Set(['gemini', 'openrouter', 'groq']);

export interface WorkerResolvedAiConfig {
  AI_PROVIDER: 'gemini' | 'openrouter' | 'groq';
  GEMINI_AI_MODEL: string;
  GEMINI_FALLBACK_MODEL: string;
  AI_RATE_LIMIT_PER_MIN: number;
  AI_RATE_LIMIT_PER_DAY: number;
  GEMINI_API_KEY: string;
  OPENROUTER_API_KEY: string;
  GROQ_API_KEY: string;
  keySource: 'env_secret' | 'encrypted_vault' | 'none';
  hasStoredVaultKey: boolean;
  hasServerEnvKey: boolean;
  vaultDecryptError: boolean;
  maskedValue: string;
  firestoreVaultSynced: boolean;
  updatedAt?: string;
  updatedByEmail?: string;
}

interface WorkerCacheEntry {
  expiresAt: number;
  doc: Record<string, unknown> | null;
  synced: boolean;
}

interface WorkerResolvedCacheEntry {
  expiresAt: number;
  envSig: string;
  value: WorkerResolvedAiConfig;
}

let vaultCache: WorkerCacheEntry | null = null;
let resolvedCache: WorkerResolvedCacheEntry | null = null;

function envSignature(env: WorkerEnv): string {
  return [
    env.FIREBASE_PROJECT_ID || '',
    env.TELEGRAM_ENCRYPTION_KEY ? '1' : '0',
    (env.GEMINI_API_KEY || '').slice(0, 8),
    (env.OPENROUTER_API_KEY || '').slice(0, 8),
    (env.GROQ_API_KEY || '').slice(0, 8),
    env.AI_PROVIDER || '',
    env.GEMINI_AI_MODEL || '',
    env.GEMINI_FALLBACK_MODEL || '',
    env.AI_RATE_LIMIT_PER_MIN || '',
    env.AI_RATE_LIMIT_PER_DAY || ''
  ].join('|');
}

function maskKey(raw: string): string {
  const clean = raw.trim();
  if (!clean) return 'Not configured';
  if (clean.length <= 8) return '••••••••';
  return `${clean.slice(0, 4)}••••••••${clean.slice(-4)}`;
}

async function fetchVaultDoc(
  env: WorkerEnv,
  callerToken?: string,
  bypassCache = false
): Promise<{ doc: Record<string, unknown> | null; synced: boolean }> {
  const now = Date.now();
  if (!callerToken && !bypassCache && vaultCache && vaultCache.expiresAt > now && vaultCache.synced && vaultCache.doc) {
    return { doc: vaultCache.doc, synced: vaultCache.synced };
  }

  try {
    let fsToken = callerToken || '';
    if (!fsToken && hasServiceAccountConfig(env)) {
      fsToken = await getFirestoreAuthToken(env, undefined, false);
    }
    if (!fsToken) {
      return { doc: null, synced: false };
    }
    const doc = await getFirestoreDoc(env, fsToken, AI_CONFIG_COLLECTION, AI_CONFIG_DOC_ID);
    vaultCache = { expiresAt: now + 30_000, doc, synced: true };
    return { doc, synced: true };
  } catch {
    return { doc: vaultCache?.doc || null, synced: false };
  }
}

export async function resolveWorkerAiConfig(
  env: WorkerEnv,
  callerToken?: string,
  bypassCache = false
): Promise<WorkerResolvedAiConfig> {
  const now = Date.now();
  const sig = envSignature(env);
  if (
    !callerToken &&
    !bypassCache &&
    resolvedCache &&
    resolvedCache.expiresAt > now &&
    resolvedCache.envSig === sig &&
    resolvedCache.value.firestoreVaultSynced
  ) {
    return resolvedCache.value;
  }

  const { doc, synced } = await fetchVaultDoc(env, callerToken, bypassCache);

  const envProvider = (env.AI_PROVIDER || 'gemini').trim().toLowerCase();
  const docProvider = typeof doc?.aiProvider === 'string' ? doc.aiProvider.trim().toLowerCase() : '';
  const provider = (ALLOWED_PROVIDERS.has(docProvider) ? docProvider : ALLOWED_PROVIDERS.has(envProvider) ? envProvider : 'gemini') as
    | 'gemini'
    | 'openrouter'
    | 'groq';

  const primaryModel =
    (typeof doc?.geminiAiModel === 'string' && doc.geminiAiModel.trim()) ||
    (env.GEMINI_AI_MODEL || 'gemini-4-hydrogen').trim();
  const fallbackModel =
    (typeof doc?.geminiFallbackModel === 'string' && doc.geminiFallbackModel.trim()) ||
    (env.GEMINI_FALLBACK_MODEL || 'gemini-3.1-flash-lite').trim();

  const perMinRaw =
    typeof doc?.rateLimitPerMin === 'number'
      ? doc.rateLimitPerMin
      : Number(env.AI_RATE_LIMIT_PER_MIN || 10);
  const perDayRaw =
    typeof doc?.rateLimitPerDay === 'number'
      ? doc.rateLimitPerDay
      : Number(env.AI_RATE_LIMIT_PER_DAY || 60);

  const perMin = Math.max(1, Math.min(120, Math.round(perMinRaw || 10)));
  const perDay = Math.max(1, Math.min(5000, Math.round(perDayRaw || 60)));

  let vaultKey = '';
  let vaultDecryptError = false;
  const encryptedPayload =
    typeof doc?.encryptedGeminiApiKey === 'string' && doc.encryptedGeminiApiKey.startsWith('v1:')
      ? doc.encryptedGeminiApiKey
      : '';
  if (encryptedPayload) {
    if (env.TELEGRAM_ENCRYPTION_KEY?.trim()) {
      try {
        vaultKey = (await decryptBotToken(encryptedPayload, env.TELEGRAM_ENCRYPTION_KEY)).trim();
      } catch {
        vaultKey = '';
        vaultDecryptError = true;
      }
    } else {
      vaultDecryptError = true;
    }
  }

  const envKey = (env.GEMINI_API_KEY || '').trim();
  const effectiveKey = vaultKey || envKey;
  const hasStoredVaultKey = Boolean(vaultKey);
  const hasServerEnvKey = Boolean(envKey);
  const keySource = vaultKey ? 'encrypted_vault' : envKey ? 'env_secret' : 'none';
  const maskedValue = vaultKey
    ? (typeof doc?.maskedGeminiApiKey === 'string' && doc.maskedGeminiApiKey) || maskKey(vaultKey)
    : envKey
      ? maskKey(envKey)
      : 'Not configured';

  const resolved: WorkerResolvedAiConfig = {
    AI_PROVIDER: provider,
    GEMINI_AI_MODEL: primaryModel,
    GEMINI_FALLBACK_MODEL: fallbackModel,
    AI_RATE_LIMIT_PER_MIN: perMin,
    AI_RATE_LIMIT_PER_DAY: perDay,
    GEMINI_API_KEY: effectiveKey,
    OPENROUTER_API_KEY: (env.OPENROUTER_API_KEY || '').trim(),
    GROQ_API_KEY: (env.GROQ_API_KEY || '').trim(),
    keySource,
    hasStoredVaultKey,
    hasServerEnvKey,
    vaultDecryptError,
    maskedValue,
    firestoreVaultSynced: synced,
    updatedAt: typeof doc?.updatedAt === 'string' ? doc.updatedAt : undefined,
    updatedByEmail: typeof doc?.updatedByEmail === 'string' ? doc.updatedByEmail : undefined
  };

  if (synced && doc && !vaultDecryptError) {
    resolvedCache = { expiresAt: now + 30_000, envSig: sig, value: resolved };
  }
  return resolved;
}

export async function getWorkerAdminAiConfigView(env: WorkerEnv, admin: VerifiedAdmin) {
  const fsToken = await getFirestoreAuthToken(env, admin.idToken, false);
  const resolved = await resolveWorkerAiConfig(env, fsToken);
  return {
    settings: {
      AI_PROVIDER: resolved.AI_PROVIDER,
      GEMINI_AI_MODEL: resolved.GEMINI_AI_MODEL,
      GEMINI_FALLBACK_MODEL: resolved.GEMINI_FALLBACK_MODEL,
      AI_RATE_LIMIT_PER_MIN: resolved.AI_RATE_LIMIT_PER_MIN,
      AI_RATE_LIMIT_PER_DAY: resolved.AI_RATE_LIMIT_PER_DAY
    },
    apiKey: {
      isConfigured: Boolean(resolved.GEMINI_API_KEY),
      hasStoredVaultKey: resolved.hasStoredVaultKey,
      hasServerEnvKey: resolved.hasServerEnvKey,
      vaultDecryptError: resolved.vaultDecryptError,
      maskedValue: resolved.maskedValue,
      activeSource: resolved.keySource
    },
    environment: {
      runtimeType: 'cloudflare_worker' as const,
      encryptionKeyConfigured: Boolean(env.TELEGRAM_ENCRYPTION_KEY?.trim()),
      serviceAccountConfigured: hasServiceAccountConfig(env),
      firestoreVaultSynced: resolved.firestoreVaultSynced,
      openrouterEnvConfigured: Boolean(resolved.OPENROUTER_API_KEY),
      groqEnvConfigured: Boolean(resolved.GROQ_API_KEY),
      cloudflareSyncNote:
        'Settings saved here update the encrypted Firestore vault (aiConfig/active). Cloudflare Worker secrets created via Wrangler CLI can only be updated directly via Wrangler CLI or Cloudflare Dashboard.'
    },
    updatedAt: resolved.updatedAt,
    updatedByEmail: resolved.updatedByEmail
  };
}

export async function saveWorkerAdminAiConfig(
  env: WorkerEnv,
  admin: VerifiedAdmin,
  body: Record<string, unknown>
) {
  const rawProvider = typeof body.AI_PROVIDER === 'string' ? body.AI_PROVIDER.trim().toLowerCase() : '';
  if (!ALLOWED_PROVIDERS.has(rawProvider)) {
    throw new HttpError(400, 'AI_PROVIDER must be one of: gemini, openrouter, groq.', 'INVALID_AI_PROVIDER');
  }

  const primaryModel = typeof body.GEMINI_AI_MODEL === 'string' ? body.GEMINI_AI_MODEL.trim() : '';
  if (!primaryModel || primaryModel.length > 120 || !/^[A-Za-z0-9._:/-]+$/.test(primaryModel)) {
    throw new HttpError(400, 'GEMINI_AI_MODEL must be a valid model identifier.', 'INVALID_AI_MODEL');
  }

  const fallbackModel = typeof body.GEMINI_FALLBACK_MODEL === 'string' ? body.GEMINI_FALLBACK_MODEL.trim() : '';
  if (!fallbackModel || fallbackModel.length > 120 || !/^[A-Za-z0-9._:/-]+$/.test(fallbackModel)) {
    throw new HttpError(400, 'GEMINI_FALLBACK_MODEL must be a valid model identifier.', 'INVALID_FALLBACK_MODEL');
  }

  const perMin = Number(body.AI_RATE_LIMIT_PER_MIN);
  if (!Number.isInteger(perMin) || perMin < 1 || perMin > 120) {
    throw new HttpError(400, 'AI_RATE_LIMIT_PER_MIN must be a whole number between 1 and 120.', 'INVALID_RATE_LIMIT');
  }

  const perDay = Number(body.AI_RATE_LIMIT_PER_DAY);
  if (!Number.isInteger(perDay) || perDay < 1 || perDay > 5000 || perDay < perMin) {
    throw new HttpError(
      400,
      'AI_RATE_LIMIT_PER_DAY must be a whole number between AI_RATE_LIMIT_PER_MIN and 5000.',
      'INVALID_RATE_LIMIT'
    );
  }

  const newKey = typeof body.GEMINI_API_KEY === 'string' ? body.GEMINI_API_KEY.trim() : '';
  if (newKey && (newKey.length < 16 || newKey.length > 256 || /\s/.test(newKey))) {
    throw new HttpError(400, 'GEMINI_API_KEY format looks invalid.', 'INVALID_API_KEY_FORMAT');
  }

  const fsToken = await getFirestoreAuthToken(env, admin.idToken, false);
  const existing = await getFirestoreDoc(env, fsToken, AI_CONFIG_COLLECTION, AI_CONFIG_DOC_ID).catch(() => null);

  let encryptedGeminiApiKey =
    body.clearStoredApiKey === true
      ? ''
      : typeof existing?.encryptedGeminiApiKey === 'string'
        ? existing.encryptedGeminiApiKey
        : '';
  let maskedGeminiApiKey =
    body.clearStoredApiKey === true
      ? ''
      : typeof existing?.maskedGeminiApiKey === 'string'
        ? existing.maskedGeminiApiKey
        : '';

  if (newKey) {
    try {
      encryptedGeminiApiKey = await encryptBotToken(newKey, env.TELEGRAM_ENCRYPTION_KEY);
      maskedGeminiApiKey = maskKey(newKey);
    } catch (err) {
      throw new HttpError(500, sanitizeError((err as Error).message, [newKey]), 'VAULT_ENCRYPT_FAILED');
    }
  }

  const nowIso = new Date().toISOString();
  await upsertFirestoreDoc(env, fsToken, AI_CONFIG_COLLECTION, AI_CONFIG_DOC_ID, {
    id: AI_CONFIG_DOC_ID,
    aiProvider: rawProvider,
    geminiAiModel: primaryModel,
    geminiFallbackModel: fallbackModel,
    rateLimitPerMin: perMin,
    rateLimitPerDay: perDay,
    encryptedGeminiApiKey,
    maskedGeminiApiKey,
    hasStoredApiKey: Boolean(encryptedGeminiApiKey),
    updatedAt: nowIso,
    updatedByUid: admin.uid,
    updatedByEmail: admin.email
  });

  vaultCache = null;
  resolvedCache = null;
  return getWorkerAdminAiConfigView(env, admin);
}
