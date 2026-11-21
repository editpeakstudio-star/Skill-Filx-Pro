import type {
  AiAdminConfigSettings,
  AiAdminConfigUpdatePayload,
  AiAdminConfigView,
  AiKeySource,
  AiProviderType
} from '../src/types/index.ts';
import {
  fetchFirestoreDocument,
  getServerServiceAccountToken,
  hasServerServiceAccount,
  upsertFirestoreDocument,
  type VerifiedAdminContext
} from './firebaseAuthVerify.ts';
import { decryptBotToken, encryptBotToken } from './telegramCrypto.ts';

const AI_CONFIG_COLLECTION = 'aiConfig';
const AI_CONFIG_DOC_ID = 'active';

const ALLOWED_PROVIDERS = new Set<AiProviderType>(['gemini', 'openrouter', 'groq']);

export interface ResolvedAiRuntimeConfig extends AiAdminConfigSettings {
  GEMINI_API_KEY: string;
  OPENROUTER_API_KEY: string;
  GROQ_API_KEY: string;
  keySource: AiKeySource;
  hasStoredVaultKey: boolean;
  hasServerEnvKey: boolean;
  maskedGeminiApiKey: string;
  firestoreVaultSynced: boolean;
  updatedAt?: string;
  updatedByEmail?: string;
}

interface StoredVaultOverride {
  aiProvider?: AiProviderType;
  geminiAiModel?: string;
  geminiFallbackModel?: string;
  rateLimitPerMin?: number;
  rateLimitPerDay?: number;
  encryptedGeminiApiKey?: string;
  maskedGeminiApiKey?: string;
  hasStoredApiKey?: boolean;
  updatedAt?: string;
  updatedByEmail?: string;
}

let memoryOverride: StoredVaultOverride | null = null;
let firestoreSynced = false;
let lastLoadAttemptMs = 0;

function readEnvDefaults(): AiAdminConfigSettings {
  const rawProvider = (process.env.AI_PROVIDER || 'gemini').trim().toLowerCase() as AiProviderType;
  const provider: AiProviderType = ALLOWED_PROVIDERS.has(rawProvider) ? rawProvider : 'gemini';
  return {
    AI_PROVIDER: provider,
    GEMINI_AI_MODEL: (process.env.GEMINI_AI_MODEL || 'gemini-4-hydrogen').trim(),
    GEMINI_FALLBACK_MODEL: (process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.1-flash-lite').trim(),
    AI_RATE_LIMIT_PER_MIN: Math.max(1, Math.min(120, Number(process.env.AI_RATE_LIMIT_PER_MIN || 10) || 10)),
    AI_RATE_LIMIT_PER_DAY: Math.max(1, Math.min(5000, Number(process.env.AI_RATE_LIMIT_PER_DAY || 60) || 60))
  };
}

export function maskSecretKey(rawKey: string): string {
  const clean = rawKey.trim();
  if (!clean) return 'Not configured';
  if (clean.length <= 8) return '••••••••';
  return `${clean.slice(0, 4)}••••••••${clean.slice(-4)}`;
}

export function validateAiConfigInput(
  payload: Partial<AiAdminConfigUpdatePayload>
): { valid: true; normalized: AiAdminConfigSettings; newApiKey?: string; clearStoredApiKey: boolean } | { valid: false; error: string } {
  const rawProvider = typeof payload.AI_PROVIDER === 'string' ? payload.AI_PROVIDER.trim().toLowerCase() : '';
  if (!ALLOWED_PROVIDERS.has(rawProvider as AiProviderType)) {
    return { valid: false, error: 'AI_PROVIDER must be one of: gemini, openrouter, groq.' };
  }

  const primaryModel = typeof payload.GEMINI_AI_MODEL === 'string' ? payload.GEMINI_AI_MODEL.trim() : '';
  if (!primaryModel || primaryModel.length > 120 || !/^[A-Za-z0-9._:/-]+$/.test(primaryModel)) {
    return {
      valid: false,
      error: 'GEMINI_AI_MODEL must be a valid model identifier (e.g. gemini-4-hydrogen).'
    };
  }

  const fallbackModel = typeof payload.GEMINI_FALLBACK_MODEL === 'string' ? payload.GEMINI_FALLBACK_MODEL.trim() : '';
  if (!fallbackModel || fallbackModel.length > 120 || !/^[A-Za-z0-9._:/-]+$/.test(fallbackModel)) {
    return {
      valid: false,
      error: 'GEMINI_FALLBACK_MODEL must be a valid model identifier (e.g. gemini-3.1-flash-lite).'
    };
  }

  const perMin = Number(payload.AI_RATE_LIMIT_PER_MIN);
  if (!Number.isInteger(perMin) || perMin < 1 || perMin > 120) {
    return {
      valid: false,
      error: 'AI_RATE_LIMIT_PER_MIN must be a whole number between 1 and 120.'
    };
  }

  const perDay = Number(payload.AI_RATE_LIMIT_PER_DAY);
  if (!Number.isInteger(perDay) || perDay < 1 || perDay > 5000) {
    return {
      valid: false,
      error: 'AI_RATE_LIMIT_PER_DAY must be a whole number between 1 and 5000.'
    };
  }

  if (perDay < perMin) {
    return {
      valid: false,
      error: 'AI_RATE_LIMIT_PER_DAY should be greater than or equal to AI_RATE_LIMIT_PER_MIN.'
    };
  }

  const rawKey = typeof payload.GEMINI_API_KEY === 'string' ? payload.GEMINI_API_KEY.trim() : '';
  if (rawKey && (rawKey.length < 16 || rawKey.length > 256 || /\s/.test(rawKey))) {
    return {
      valid: false,
      error: 'GEMINI_API_KEY format looks invalid. Enter the full API key without spaces.'
    };
  }

  return {
    valid: true,
    normalized: {
      AI_PROVIDER: rawProvider as AiProviderType,
      GEMINI_AI_MODEL: primaryModel,
      GEMINI_FALLBACK_MODEL: fallbackModel,
      AI_RATE_LIMIT_PER_MIN: perMin,
      AI_RATE_LIMIT_PER_DAY: perDay
    },
    newApiKey: rawKey || undefined,
    clearStoredApiKey: payload.clearStoredApiKey === true
  };
}

function parseFirestoreDoc(doc: Record<string, unknown> | null): StoredVaultOverride | null {
  if (!doc) return null;
  const rawProvider = typeof doc.aiProvider === 'string' ? doc.aiProvider.trim().toLowerCase() : undefined;
  return {
    aiProvider: rawProvider && ALLOWED_PROVIDERS.has(rawProvider as AiProviderType) ? (rawProvider as AiProviderType) : undefined,
    geminiAiModel: typeof doc.geminiAiModel === 'string' ? doc.geminiAiModel.trim() : undefined,
    geminiFallbackModel: typeof doc.geminiFallbackModel === 'string' ? doc.geminiFallbackModel.trim() : undefined,
    rateLimitPerMin: typeof doc.rateLimitPerMin === 'number' ? doc.rateLimitPerMin : undefined,
    rateLimitPerDay: typeof doc.rateLimitPerDay === 'number' ? doc.rateLimitPerDay : undefined,
    encryptedGeminiApiKey:
      typeof doc.encryptedGeminiApiKey === 'string' && doc.encryptedGeminiApiKey.startsWith('v1:')
        ? doc.encryptedGeminiApiKey
        : undefined,
    maskedGeminiApiKey: typeof doc.maskedGeminiApiKey === 'string' ? doc.maskedGeminiApiKey : undefined,
    hasStoredApiKey: doc.hasStoredApiKey === true,
    updatedAt: typeof doc.updatedAt === 'string' ? doc.updatedAt : undefined,
    updatedByEmail: typeof doc.updatedByEmail === 'string' ? doc.updatedByEmail : undefined
  };
}

export async function hydrateAiConfigFromFirestore(authToken?: string): Promise<void> {
  const now = Date.now();
  if (!authToken && now - lastLoadAttemptMs < 30_000) {
    return;
  }
  lastLoadAttemptMs = now;

  try {
    const token = authToken || (await getServerServiceAccountToken());
    if (!token) return;

    const doc = await fetchFirestoreDocument(AI_CONFIG_COLLECTION, AI_CONFIG_DOC_ID, token);
    if (doc) {
      memoryOverride = parseFirestoreDoc(doc);
    }
    firestoreSynced = true;
  } catch (err) {
    // Non-fatal: continue with server env & memory cache cleanly
    console.warn('AI config Firestore sync note:', (err as Error)?.message || 'Skipped');
  }
}

export function getResolvedRuntimeAiConfig(): ResolvedAiRuntimeConfig {
  const defaults = readEnvDefaults();
  const envGeminiKey = (process.env.GEMINI_API_KEY || '').trim();
  const override = memoryOverride;

  let vaultKey = '';
  if (override?.encryptedGeminiApiKey) {
    try {
      vaultKey = decryptBotToken(override.encryptedGeminiApiKey).trim();
    } catch {
      vaultKey = '';
    }
  }

  const hasStoredVaultKey = Boolean(vaultKey);
  const hasServerEnvKey = Boolean(envGeminiKey);

  // If the Owner/Super Admin explicitly saved a key in the encrypted vault, prefer it; otherwise use server Secret env.
  const effectiveKey = vaultKey || envGeminiKey;
  const keySource: AiKeySource = vaultKey ? 'encrypted_vault' : envGeminiKey ? 'env_secret' : 'none';
  const maskedGeminiApiKey = vaultKey
    ? override?.maskedGeminiApiKey || maskSecretKey(vaultKey)
    : envGeminiKey
      ? maskSecretKey(envGeminiKey)
      : 'Not configured';

  return {
    AI_PROVIDER: override?.aiProvider || defaults.AI_PROVIDER,
    GEMINI_AI_MODEL: override?.geminiAiModel || defaults.GEMINI_AI_MODEL,
    GEMINI_FALLBACK_MODEL: override?.geminiFallbackModel || defaults.GEMINI_FALLBACK_MODEL,
    AI_RATE_LIMIT_PER_MIN: override?.rateLimitPerMin ?? defaults.AI_RATE_LIMIT_PER_MIN,
    AI_RATE_LIMIT_PER_DAY: override?.rateLimitPerDay ?? defaults.AI_RATE_LIMIT_PER_DAY,
    GEMINI_API_KEY: effectiveKey,
    OPENROUTER_API_KEY: (process.env.OPENROUTER_API_KEY || '').trim(),
    GROQ_API_KEY: (process.env.GROQ_API_KEY || '').trim(),
    keySource,
    hasStoredVaultKey,
    hasServerEnvKey,
    maskedGeminiApiKey,
    firestoreVaultSynced: firestoreSynced,
    updatedAt: override?.updatedAt,
    updatedByEmail: override?.updatedByEmail
  };
}

export async function getAdminAiConfigView(adminToken: string): Promise<AiAdminConfigView> {
  await hydrateAiConfigFromFirestore(adminToken);
  const resolved = getResolvedRuntimeAiConfig();

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
      maskedValue: resolved.maskedGeminiApiKey,
      activeSource: resolved.keySource
    },
    environment: {
      runtimeType: 'express_server',
      encryptionKeyConfigured: Boolean(process.env.TELEGRAM_ENCRYPTION_KEY?.trim()),
      serviceAccountConfigured: hasServerServiceAccount(),
      firestoreVaultSynced: resolved.firestoreVaultSynced,
      openrouterEnvConfigured: Boolean(resolved.OPENROUTER_API_KEY),
      groqEnvConfigured: Boolean(resolved.GROQ_API_KEY),
      cloudflareSyncNote:
        'Settings saved here update the encrypted Firestore vault (aiConfig/active). Cloudflare Worker secrets pushed via Wrangler CLI remain managed directly through Cloudflare Secrets.'
    },
    updatedAt: resolved.updatedAt,
    updatedByEmail: resolved.updatedByEmail
  };
}

export async function saveAdminAiConfig(
  admin: VerifiedAdminContext,
  payload: Partial<AiAdminConfigUpdatePayload>
): Promise<AiAdminConfigView> {
  const checked = validateAiConfigInput(payload);
  if (checked.valid === false) {
    throw new Error(checked.error);
  }

  await hydrateAiConfigFromFirestore(admin.idToken);

  let encryptedGeminiApiKey = checked.clearStoredApiKey ? '' : memoryOverride?.encryptedGeminiApiKey || '';
  let maskedGeminiApiKey = checked.clearStoredApiKey ? '' : memoryOverride?.maskedGeminiApiKey || '';

  if (checked.newApiKey) {
    encryptedGeminiApiKey = encryptBotToken(checked.newApiKey);
    maskedGeminiApiKey = maskSecretKey(checked.newApiKey);
  }

  const nowIso = new Date().toISOString();
  const hasStoredApiKey = Boolean(encryptedGeminiApiKey);

  const firestoreDoc = {
    id: AI_CONFIG_DOC_ID,
    aiProvider: checked.normalized.AI_PROVIDER,
    geminiAiModel: checked.normalized.GEMINI_AI_MODEL,
    geminiFallbackModel: checked.normalized.GEMINI_FALLBACK_MODEL,
    rateLimitPerMin: checked.normalized.AI_RATE_LIMIT_PER_MIN,
    rateLimitPerDay: checked.normalized.AI_RATE_LIMIT_PER_DAY,
    encryptedGeminiApiKey,
    maskedGeminiApiKey,
    hasStoredApiKey,
    updatedAt: nowIso,
    updatedByUid: admin.uid,
    updatedByEmail: admin.email
  };

  await upsertFirestoreDocument(AI_CONFIG_COLLECTION, AI_CONFIG_DOC_ID, firestoreDoc, admin.idToken);

  memoryOverride = {
    aiProvider: checked.normalized.AI_PROVIDER,
    geminiAiModel: checked.normalized.GEMINI_AI_MODEL,
    geminiFallbackModel: checked.normalized.GEMINI_FALLBACK_MODEL,
    rateLimitPerMin: checked.normalized.AI_RATE_LIMIT_PER_MIN,
    rateLimitPerDay: checked.normalized.AI_RATE_LIMIT_PER_DAY,
    encryptedGeminiApiKey: encryptedGeminiApiKey || undefined,
    maskedGeminiApiKey: maskedGeminiApiKey || undefined,
    hasStoredApiKey,
    updatedAt: nowIso,
    updatedByEmail: admin.email
  };
  firestoreSynced = true;

  return getAdminAiConfigView(admin.idToken);
}
