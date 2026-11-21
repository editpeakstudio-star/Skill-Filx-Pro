import React, { Component, ErrorInfo, ReactNode, useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  Check,
  CheckCircle2,
  Cloud,
  Copy,
  Edit2,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Lock,
  RefreshCw,
  Save,
  Server,
  ShieldCheck,
  Sparkles,
  Terminal,
  Trash2,
  Wifi,
  X,
  XCircle
} from 'lucide-react';
import type {
  AiAdminConfigView,
  AiConnectionTestResult,
  AiProviderType,
  UserProfile
} from '../types';
import {
  fetchAdminAiConfig,
  testAdminAiConnection,
  updateAdminAiConfig
} from '../services/aiConfigApi';
import { recordAuditLog } from '../services/firebase';
import { useToast } from './Toast';

interface AiConfigManagerProps {
  currentUser: UserProfile | null;
}

const PROVIDER_OPTIONS: Array<{ value: AiProviderType; label: string; hint: string }> = [
  { value: 'gemini', label: 'Google Gemini API (Free Tier)', hint: 'Recommended official SDK' },
  { value: 'openrouter', label: 'OpenRouter (Configurable)', hint: 'Requires OPENROUTER_API_KEY env' },
  { value: 'groq', label: 'Groq (Configurable)', hint: 'Requires GROQ_API_KEY env' }
];

const MODEL_PRESETS = [
  'gemini-4-hydrogen',
  'gemini-3.1-flash-lite',
  'gemini-4-neon'
];

const CLOUDFLARE_CLI_SNIPPET = `cd cloudflare-worker
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put TELEGRAM_ENCRYPTION_KEY
npx wrangler deploy`;

const CLOUDFLARE_ENV_SNIPPET = `AI_PROVIDER=gemini
GEMINI_AI_MODEL=gemini-4-hydrogen
GEMINI_FALLBACK_MODEL=gemini-3.1-flash-lite
AI_RATE_LIMIT_PER_MIN=10
AI_RATE_LIMIT_PER_DAY=60`;

function formatUpdatedTime(iso?: string): string {
  if (!iso) return 'Using server defaults';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });
  } catch {
    return iso;
  }
}

export class AiConfigManagerBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean; errorMessage: string }
> {
  state = { hasError: false, errorMessage: '' };

  static getDerivedStateFromError(error: Error) {
    return {
      hasError: true,
      errorMessage: error?.message || 'Unexpected error rendering AI Configuration panel.'
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('AiConfigManager isolated error:', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="p-6 rounded-2xl bg-[#090D16] border border-rose-500/35 text-zinc-100 space-y-3">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <h3 className="text-sm font-bold text-white">AI Configuration panel encountered an error</h3>
              <p className="text-xs text-rose-200/90 leading-relaxed">{this.state.errorMessage}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => this.setState({ hasError: false, errorMessage: '' })}
            className="min-h-[40px] px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold inline-flex items-center gap-1.5 cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Retry Panel</span>
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export const AiConfigManager: React.FC<AiConfigManagerProps> = ({ currentUser }) => {
  const { showToast } = useToast();

  const [config, setConfig] = useState<AiAdminConfigView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<AiConnectionTestResult | null>(null);

  // Editable Form State for the 6 required settings
  const [aiProvider, setAiProvider] = useState<AiProviderType>('gemini');
  const [primaryModel, setPrimaryModel] = useState('gemini-4-hydrogen');
  const [fallbackModel, setFallbackModel] = useState('gemini-3.1-flash-lite');
  const [ratePerMin, setRatePerMin] = useState('10');
  const [ratePerDay, setRatePerDay] = useState('60');
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [showKeyDraft, setShowKeyDraft] = useState(false);
  const [copiedBlock, setCopiedBlock] = useState<string | null>(null);

  const syncFormFromView = useCallback((view: AiAdminConfigView) => {
    setAiProvider(view.settings.AI_PROVIDER);
    setPrimaryModel(view.settings.GEMINI_AI_MODEL);
    setFallbackModel(view.settings.GEMINI_FALLBACK_MODEL);
    setRatePerMin(String(view.settings.AI_RATE_LIMIT_PER_MIN));
    setRatePerDay(String(view.settings.AI_RATE_LIMIT_PER_DAY));
    setApiKeyDraft('');
    setShowKeyDraft(false);
  }, []);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const view = await fetchAdminAiConfig();
      setConfig(view);
      syncFormFromView(view);
    } catch (err: any) {
      setLoadError(err?.message || 'Could not load AI Configuration.');
    } finally {
      setLoading(false);
    }
  }, [syncFormFromView]);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  const handleCopySnippet = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedBlock(id);
      setTimeout(() => setCopiedBlock(prev => (prev === id ? null : prev)), 2000);
      showToast('Copied CLI configuration to clipboard.', 'success');
    } catch {
      showToast('Clipboard permission unavailable in this browser context.', 'error');
    }
  };

  const handleCancelEdit = () => {
    if (config) syncFormFromView(config);
    setIsEditing(false);
  };

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    const minNum = Number(ratePerMin);
    const dayNum = Number(ratePerDay);

    if (!Number.isInteger(minNum) || minNum < 1 || minNum > 120) {
      showToast('AI_RATE_LIMIT_PER_MIN must be an integer between 1 and 120.', 'error');
      return;
    }
    if (!Number.isInteger(dayNum) || dayNum < minNum || dayNum > 5000) {
      showToast('AI_RATE_LIMIT_PER_DAY must be between AI_RATE_LIMIT_PER_MIN and 5000.', 'error');
      return;
    }

    setIsSaving(true);
    try {
      const trimmedNewKey = apiKeyDraft.trim();
      const updated = await updateAdminAiConfig({
        AI_PROVIDER: aiProvider,
        GEMINI_AI_MODEL: primaryModel.trim(),
        GEMINI_FALLBACK_MODEL: fallbackModel.trim(),
        AI_RATE_LIMIT_PER_MIN: minNum,
        AI_RATE_LIMIT_PER_DAY: dayNum,
        ...(trimmedNewKey ? { GEMINI_API_KEY: trimmedNewKey } : {})
      });
      setConfig(updated);
      syncFormFromView(updated);
      setIsEditing(false);
      setTestResult(null);

      if (currentUser) {
        void recordAuditLog({
          actorUid: currentUser.uid,
          actorEmail: currentUser.email,
          actorRole: currentUser.isPlatformOwner ? 'owner' : currentUser.role,
          action: 'ai.config.update',
          details: `Updated AI Configuration (${updated.settings.AI_PROVIDER}, primary=${updated.settings.GEMINI_AI_MODEL}, fallback=${updated.settings.GEMINI_FALLBACK_MODEL}, limits=${updated.settings.AI_RATE_LIMIT_PER_MIN}/min, ${updated.settings.AI_RATE_LIMIT_PER_DAY}/day${trimmedNewKey ? ', rotated API key' : ''})`
        });
      }

      showToast('AI Configuration & Secrets updated securely.', 'success');
    } catch (err: any) {
      showToast(err?.message || 'Failed to save AI Configuration.', 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleClearStoredVaultKey = async () => {
    if (!config) return;
    setIsSaving(true);
    try {
      const updated = await updateAdminAiConfig({
        AI_PROVIDER: aiProvider,
        GEMINI_AI_MODEL: primaryModel.trim(),
        GEMINI_FALLBACK_MODEL: fallbackModel.trim(),
        AI_RATE_LIMIT_PER_MIN: Number(ratePerMin) || config.settings.AI_RATE_LIMIT_PER_MIN,
        AI_RATE_LIMIT_PER_DAY: Number(ratePerDay) || config.settings.AI_RATE_LIMIT_PER_DAY,
        clearStoredApiKey: true
      });
      setConfig(updated);
      syncFormFromView(updated);
      setTestResult(null);

      if (currentUser) {
        void recordAuditLog({
          actorUid: currentUser.uid,
          actorEmail: currentUser.email,
          actorRole: currentUser.isPlatformOwner ? 'owner' : currentUser.role,
          action: 'ai.secret.clear',
          details: 'Cleared encrypted GEMINI_API_KEY override; reverted to server environment secret.'
        });
      }
      showToast('Cleared vault API key override cleanly.', 'success');
    } catch (err: any) {
      showToast(err?.message || 'Could not clear stored API key.', 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleTestConnection = async () => {
    setIsTesting(true);
    try {
      const outcome = await testAdminAiConnection();
      setTestResult(outcome);
      showToast(
        outcome.success ? `AI Connection verified (${outcome.model})` : outcome.message,
        outcome.success ? 'success' : 'error'
      );
    } catch (err: any) {
      const msg = err?.message || 'Connection test failed.';
      setTestResult({
        success: false,
        provider: aiProvider,
        model: primaryModel,
        latencyMs: 0,
        message: msg
      });
      showToast(msg, 'error');
    } finally {
      setIsTesting(false);
    }
  };

  return (
    <div className="space-y-5 animate-in fade-in duration-150 max-w-4xl">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-lg font-extrabold text-white flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-cyan-400" />
              <span>AI Configuration / API Secrets</span>
            </h2>
            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-amber-500/15 border border-amber-400/35 text-amber-300 inline-flex items-center gap-1">
              <ShieldCheck className="w-3 h-3" />
              Owner &amp; Super Admin Only
            </span>
          </div>
          <p className="text-xs text-zinc-400 mt-1">
            Manage Skill-Flix AI model routing, rate limits, and server-side API credentials securely.
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => void loadConfig()}
            disabled={loading || isSaving}
            className="min-h-[40px] px-3 py-2 rounded-xl bg-[#090D16] hover:bg-zinc-900 border border-zinc-800 text-zinc-300 hover:text-white text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>

          <button
            type="button"
            onClick={() => void handleTestConnection()}
            disabled={loading || isTesting || isSaving}
            className="min-h-[40px] px-3.5 py-2 rounded-xl bg-cyan-600/20 hover:bg-cyan-600/30 border border-cyan-500/35 text-cyan-200 text-xs font-bold inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
          >
            {isTesting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wifi className="w-3.5 h-3.5" />}
            <span>{isTesting ? 'Testing AI...' : 'Test AI Connection'}</span>
          </button>

          {!isEditing && config && (
            <button
              type="button"
              onClick={() => setIsEditing(true)}
              className="min-h-[40px] px-4 py-2 rounded-xl bg-gradient-to-r from-purple-600 via-blue-600 to-cyan-500 hover:from-purple-500 hover:to-cyan-400 text-white text-xs font-bold inline-flex items-center gap-1.5 shadow-md shadow-blue-600/25 cursor-pointer"
            >
              <Edit2 className="w-3.5 h-3.5" />
              <span>Edit Configuration</span>
            </button>
          )}
        </div>
      </div>

      {/* Loading / Error State */}
      {loading && !config && (
        <div className="p-8 rounded-2xl bg-[#090D16] border border-blue-500/20 flex items-center justify-center gap-2.5 text-xs text-zinc-300">
          <Loader2 className="w-4 h-4 text-cyan-400 animate-spin" />
          <span>Loading encrypted AI configuration...</span>
        </div>
      )}

      {loadError && (
        <div className="p-4 rounded-2xl bg-rose-950/30 border border-rose-500/35 flex items-start gap-3 text-xs text-rose-200">
          <XCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
          <div className="space-y-1 flex-1">
            <p className="font-bold text-white">Unable to load AI Configuration</p>
            <p className="leading-relaxed">{loadError}</p>
          </div>
        </div>
      )}

      {/* Connection Test Result Banner */}
      {testResult && (
        <div
          className={`p-3.5 rounded-2xl border flex items-start gap-3 text-xs ${
            testResult.success
              ? 'bg-emerald-950/25 border-emerald-500/35 text-emerald-200'
              : 'bg-rose-950/30 border-rose-500/35 text-rose-200'
          }`}
        >
          {testResult.success ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
          ) : (
            <XCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
          )}
          <div className="flex-1 min-w-0 space-y-0.5">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="font-bold text-white">
                {testResult.success
                  ? 'AI Connection Live'
                  : `AI Connection Check Failed${testResult.statusCode ? ` (HTTP ${testResult.statusCode})` : ''}`}
              </span>
              <span className="text-[11px] font-mono text-zinc-300">
                {testResult.model} • {testResult.latencyMs}ms
              </span>
            </div>
            <p className="leading-relaxed">{testResult.message}</p>
            {testResult.replyPreview && (
              <p className="text-[11px] text-cyan-300/90 font-mono truncate">
                Response: &quot;{testResult.replyPreview}&quot;
              </p>
            )}
          </div>
        </div>
      )}

      {config && (
        <>
          {config.apiKey.vaultDecryptError && (
            <div className="p-3.5 rounded-2xl bg-amber-950/35 border border-amber-500/40 flex items-start gap-3 text-xs text-amber-200">
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <div className="space-y-1 flex-1">
                <p className="font-bold text-white">Encrypted Vault Key Mismatch Detected</p>
                <p className="leading-relaxed">
                  An encrypted <code className="font-mono text-amber-300">GEMINI_API_KEY</code> exists in{' '}
                  <code className="font-mono text-amber-300">aiConfig/active</code>, but this backend could not decrypt it.
                  Make sure <code className="font-mono text-amber-300">TELEGRAM_ENCRYPTION_KEY</code> matches across Express and Cloudflare Worker, or click <strong>Edit Configuration</strong> and re-save your API key.
                </p>
              </div>
            </div>
          )}

          {/* Status Indicator Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="p-3.5 rounded-2xl bg-[#090D16] border border-blue-500/20 space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-400">
                  API Key Status
                </span>
                <KeyRound
                  className={`w-4 h-4 ${config.apiKey.isConfigured ? 'text-emerald-400' : 'text-amber-400'}`}
                />
              </div>
              <div className="text-sm font-extrabold text-white">
                {config.apiKey.isConfigured ? 'Configured & Active' : 'Key Missing'}
              </div>
              <div className="text-[11px] text-zinc-400 font-mono truncate">
                Source:{' '}
                {config.apiKey.activeSource === 'encrypted_vault'
                  ? 'Encrypted Admin Vault'
                  : config.apiKey.activeSource === 'env_secret'
                    ? 'Server Environment Secret'
                    : 'None'}
              </div>
            </div>

            <div className="p-3.5 rounded-2xl bg-[#090D16] border border-blue-500/20 space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-400">
                  Backend Runtime
                </span>
                <Server className="w-4 h-4 text-cyan-400" />
              </div>
              <div className="text-sm font-extrabold text-white">
                {config.environment.runtimeType === 'cloudflare_worker'
                  ? 'Cloudflare Worker Edge'
                  : 'Node Express Server'}
              </div>
              <div className="text-[11px] text-zinc-400 truncate">
                AES-256-GCM: {config.environment.encryptionKeyConfigured ? 'Env Secret Active' : 'Local Key Active'}
              </div>
            </div>

            <div className="p-3.5 rounded-2xl bg-[#090D16] border border-blue-500/20 space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-400">
                  Vault Sync
                </span>
                <Cloud
                  className={`w-4 h-4 ${
                    config.environment.firestoreVaultSynced ? 'text-purple-400' : 'text-zinc-500'
                  }`}
                />
              </div>
              <div className="text-sm font-extrabold text-white">
                {config.environment.firestoreVaultSynced ? 'Synced to Firestore' : 'Env Defaults Active'}
              </div>
              <div className="text-[11px] text-zinc-400 truncate">
                {formatUpdatedTime(config.updatedAt)}
              </div>
            </div>
          </div>

          {/* 6 Settings Management Form */}
          <form
            onSubmit={handleSaveConfig}
            className="rounded-2xl bg-[#090D16] border border-purple-500/25 overflow-hidden shadow-xl shadow-black/40"
          >
            <div className="px-4 sm:px-5 py-3.5 border-b border-white/[0.07] bg-gradient-to-r from-purple-950/35 via-[#0B1120] to-cyan-950/25 flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                <Bot className="w-4 h-4 text-cyan-400" />
                <span className="text-xs sm:text-sm font-bold text-white">
                  Environment Variables &amp; API Secret Vault (6 Settings)
                </span>
              </div>
              <span className="text-[11px] text-zinc-400 font-mono">
                {isEditing ? 'EDIT MODE' : 'READ-ONLY VIEW'}
              </span>
            </div>

            <div className="p-4 sm:p-5 space-y-4">
              {/* 1. AI_PROVIDER */}
              <div className="p-3.5 rounded-xl bg-[#05070D] border border-blue-500/15 grid grid-cols-1 md:grid-cols-12 gap-3 items-start md:items-center">
                <div className="md:col-span-5 space-y-1">
                  <div className="flex items-center gap-2">
                    <code className="px-2 py-0.5 rounded bg-purple-500/15 border border-purple-500/30 text-purple-300 font-mono text-xs font-bold">
                      AI_PROVIDER
                    </code>
                    <span className="text-[10px] text-zinc-500 uppercase font-semibold">#1</span>
                  </div>
                  <p className="text-[11px] text-zinc-400">
                    Active AI provider used by Skill-Flix AI Learning Assistant.
                  </p>
                </div>
                <div className="md:col-span-7">
                  {isEditing ? (
                    <select
                      value={aiProvider}
                      onChange={e => setAiProvider(e.target.value as AiProviderType)}
                      aria-label="AI_PROVIDER"
                      className="w-full min-h-[42px] px-3 py-2 rounded-xl bg-[#0A0F1C] border border-blue-500/30 focus:border-cyan-400 text-xs text-white font-semibold outline-none"
                    >
                      {PROVIDER_OPTIONS.map(opt => (
                        <option key={opt.value} value={opt.value}>
                          {opt.value} — {opt.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <div className="px-3 py-2.5 rounded-xl bg-[#0A0F1C]/70 border border-zinc-800/80 text-xs font-mono text-cyan-300 flex items-center justify-between gap-2">
                      <span>{config.settings.AI_PROVIDER}</span>
                      <span className="text-[10px] font-sans text-zinc-400">
                        {PROVIDER_OPTIONS.find(p => p.value === config.settings.AI_PROVIDER)?.label}
                      </span>
                    </div>
                  )}
                </div>
              </div>

              {/* 2. GEMINI_AI_MODEL */}
              <div className="p-3.5 rounded-xl bg-[#05070D] border border-blue-500/15 grid grid-cols-1 md:grid-cols-12 gap-3 items-start md:items-center">
                <div className="md:col-span-5 space-y-1">
                  <div className="flex items-center gap-2">
                    <code className="px-2 py-0.5 rounded bg-blue-500/15 border border-blue-500/30 text-blue-300 font-mono text-xs font-bold">
                      GEMINI_AI_MODEL
                    </code>
                    <span className="text-[10px] text-zinc-500 uppercase font-semibold">#2</span>
                  </div>
                  <p className="text-[11px] text-zinc-400">
                    Primary free-tier Gemini model ID for student chat responses.
                  </p>
                </div>
                <div className="md:col-span-7 space-y-2">
                  {isEditing ? (
                    <>
                      <input
                        type="text"
                        required
                        value={primaryModel}
                        onChange={e => setPrimaryModel(e.target.value)}
                        aria-label="GEMINI_AI_MODEL"
                        placeholder="gemini-4-hydrogen"
                        className="w-full min-h-[42px] px-3 py-2 rounded-xl bg-[#0A0F1C] border border-blue-500/30 focus:border-cyan-400 text-xs text-white font-mono outline-none"
                      />
                      <div className="flex flex-wrap gap-1.5">
                        {MODEL_PRESETS.map(preset => (
                          <button
                            key={preset}
                            type="button"
                            onClick={() => setPrimaryModel(preset)}
                            className={`px-2 py-0.5 rounded-lg text-[10px] font-mono border cursor-pointer transition-colors ${
                              primaryModel === preset
                                ? 'bg-cyan-500/20 border-cyan-400/50 text-cyan-200'
                                : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-white'
                            }`}
                          >
                            {preset}
                          </button>
                        ))}
                      </div>
                    </>
                  ) : (
                    <div className="px-3 py-2.5 rounded-xl bg-[#0A0F1C]/70 border border-zinc-800/80 text-xs font-mono text-white">
                      {config.settings.GEMINI_AI_MODEL}
                    </div>
                  )}
                </div>
              </div>

              {/* 3. GEMINI_FALLBACK_MODEL */}
              <div className="p-3.5 rounded-xl bg-[#05070D] border border-blue-500/15 grid grid-cols-1 md:grid-cols-12 gap-3 items-start md:items-center">
                <div className="md:col-span-5 space-y-1">
                  <div className="flex items-center gap-2">
                    <code className="px-2 py-0.5 rounded bg-blue-500/15 border border-blue-500/30 text-blue-300 font-mono text-xs font-bold">
                      GEMINI_FALLBACK_MODEL
                    </code>
                    <span className="text-[10px] text-zinc-500 uppercase font-semibold">#3</span>
                  </div>
                  <p className="text-[11px] text-zinc-400">
                    Automatic fallback model if primary free-tier quota is busy.
                  </p>
                </div>
                <div className="md:col-span-7 space-y-2">
                  {isEditing ? (
                    <>
                      <input
                        type="text"
                        required
                        value={fallbackModel}
                        onChange={e => setFallbackModel(e.target.value)}
                        aria-label="GEMINI_FALLBACK_MODEL"
                        placeholder="gemini-3.1-flash-lite"
                        className="w-full min-h-[42px] px-3 py-2 rounded-xl bg-[#0A0F1C] border border-blue-500/30 focus:border-cyan-400 text-xs text-white font-mono outline-none"
                      />
                      <div className="flex flex-wrap gap-1.5">
                        {MODEL_PRESETS.map(preset => (
                          <button
                            key={preset}
                            type="button"
                            onClick={() => setFallbackModel(preset)}
                            className={`px-2 py-0.5 rounded-lg text-[10px] font-mono border cursor-pointer transition-colors ${
                              fallbackModel === preset
                                ? 'bg-cyan-500/20 border-cyan-400/50 text-cyan-200'
                                : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-white'
                            }`}
                          >
                            {preset}
                          </button>
                        ))}
                      </div>
                    </>
                  ) : (
                    <div className="px-3 py-2.5 rounded-xl bg-[#0A0F1C]/70 border border-zinc-800/80 text-xs font-mono text-white">
                      {config.settings.GEMINI_FALLBACK_MODEL}
                    </div>
                  )}
                </div>
              </div>

              {/* 4. AI_RATE_LIMIT_PER_MIN */}
              <div className="p-3.5 rounded-xl bg-[#05070D] border border-blue-500/15 grid grid-cols-1 md:grid-cols-12 gap-3 items-start md:items-center">
                <div className="md:col-span-5 space-y-1">
                  <div className="flex items-center gap-2">
                    <code className="px-2 py-0.5 rounded bg-cyan-500/15 border border-cyan-500/30 text-cyan-300 font-mono text-xs font-bold">
                      AI_RATE_LIMIT_PER_MIN
                    </code>
                    <span className="text-[10px] text-zinc-500 uppercase font-semibold">#4</span>
                  </div>
                  <p className="text-[11px] text-zinc-400">
                    Maximum AI questions allowed per student every minute (1–120).
                  </p>
                </div>
                <div className="md:col-span-7">
                  {isEditing ? (
                    <input
                      type="number"
                      required
                      min={1}
                      max={120}
                      value={ratePerMin}
                      onChange={e => setRatePerMin(e.target.value)}
                      aria-label="AI_RATE_LIMIT_PER_MIN"
                      className="w-full min-h-[42px] px-3 py-2 rounded-xl bg-[#0A0F1C] border border-blue-500/30 focus:border-cyan-400 text-xs text-white font-mono outline-none"
                    />
                  ) : (
                    <div className="px-3 py-2.5 rounded-xl bg-[#0A0F1C]/70 border border-zinc-800/80 text-xs font-mono text-white">
                      {config.settings.AI_RATE_LIMIT_PER_MIN} requests / minute
                    </div>
                  )}
                </div>
              </div>

              {/* 5. AI_RATE_LIMIT_PER_DAY */}
              <div className="p-3.5 rounded-xl bg-[#05070D] border border-blue-500/15 grid grid-cols-1 md:grid-cols-12 gap-3 items-start md:items-center">
                <div className="md:col-span-5 space-y-1">
                  <div className="flex items-center gap-2">
                    <code className="px-2 py-0.5 rounded bg-cyan-500/15 border border-cyan-500/30 text-cyan-300 font-mono text-xs font-bold">
                      AI_RATE_LIMIT_PER_DAY
                    </code>
                    <span className="text-[10px] text-zinc-500 uppercase font-semibold">#5</span>
                  </div>
                  <p className="text-[11px] text-zinc-400">
                    Daily per-student quota ceiling across free-tier usage (1–5000).
                  </p>
                </div>
                <div className="md:col-span-7">
                  {isEditing ? (
                    <input
                      type="number"
                      required
                      min={1}
                      max={5000}
                      value={ratePerDay}
                      onChange={e => setRatePerDay(e.target.value)}
                      aria-label="AI_RATE_LIMIT_PER_DAY"
                      className="w-full min-h-[42px] px-3 py-2 rounded-xl bg-[#0A0F1C] border border-blue-500/30 focus:border-cyan-400 text-xs text-white font-mono outline-none"
                    />
                  ) : (
                    <div className="px-3 py-2.5 rounded-xl bg-[#0A0F1C]/70 border border-zinc-800/80 text-xs font-mono text-white">
                      {config.settings.AI_RATE_LIMIT_PER_DAY} requests / day
                    </div>
                  )}
                </div>
              </div>

              {/* 6. GEMINI_API_KEY (Encrypted Vault Secret — NEVER returned to client) */}
              <div className="p-3.5 rounded-xl bg-[#05070D] border border-amber-500/25 grid grid-cols-1 md:grid-cols-12 gap-3 items-start md:items-center">
                <div className="md:col-span-5 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <code className="px-2 py-0.5 rounded bg-amber-500/15 border border-amber-500/35 text-amber-300 font-mono text-xs font-bold inline-flex items-center gap-1">
                      <Lock className="w-3 h-3" />
                      GEMINI_API_KEY
                    </code>
                    <span className="text-[10px] text-zinc-500 uppercase font-semibold">#6 SECRET</span>
                  </div>
                  <p className="text-[11px] text-zinc-400">
                    Encrypted with AES-256-GCM server-side and never sent back to browser JavaScript.
                  </p>
                </div>

                <div className="md:col-span-7 space-y-2">
                  {isEditing ? (
                    <>
                      <div className="relative">
                        <input
                          type={showKeyDraft ? 'text' : 'password'}
                          value={apiKeyDraft}
                          onChange={e => setApiKeyDraft(e.target.value)}
                          autoComplete="new-password"
                          aria-label="GEMINI_API_KEY"
                          placeholder={
                            config.apiKey.isConfigured
                              ? `Current key hidden (${config.apiKey.maskedValue}) — enter new key to replace`
                              : 'Paste Gemini API key (stored encrypted on server)'
                          }
                          className="w-full min-h-[42px] pl-3 pr-10 py-2 rounded-xl bg-[#0A0F1C] border border-amber-500/35 focus:border-cyan-400 text-xs text-white font-mono outline-none"
                        />
                        <button
                          type="button"
                          onClick={() => setShowKeyDraft(prev => !prev)}
                          aria-label={showKeyDraft ? 'Hide drafted key' : 'Show drafted key'}
                          className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-zinc-400 hover:text-white cursor-pointer"
                        >
                          {showKeyDraft ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      </div>
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <span className="text-[10px] text-zinc-400">
                          Leave blank to keep the existing server key unchanged.
                        </span>
                        {config.apiKey.hasStoredVaultKey && (
                          <button
                            type="button"
                            onClick={() => void handleClearStoredVaultKey()}
                            disabled={isSaving}
                            className="inline-flex items-center gap-1 text-[11px] font-semibold text-rose-300 hover:text-rose-200 cursor-pointer disabled:opacity-50"
                          >
                            <Trash2 className="w-3 h-3" />
                            <span>Clear Vault Override</span>
                          </button>
                        )}
                      </div>
                    </>
                  ) : (
                    <div className="px-3 py-2.5 rounded-xl bg-[#0A0F1C]/70 border border-zinc-800/80 text-xs font-mono text-amber-200 flex items-center justify-between gap-2">
                      <span>
                        {config.apiKey.isConfigured ? config.apiKey.maskedValue : 'Not configured'}
                      </span>
                      <span className="text-[10px] font-sans text-zinc-400">
                        {config.apiKey.hasStoredVaultKey
                          ? 'Encrypted Vault'
                          : config.apiKey.hasServerEnvKey
                            ? 'Server Env Secret'
                            : 'Missing'}
                      </span>
                    </div>
                  )}
                </div>
              </div>

              {/* Action Buttons when Editing */}
              {isEditing && (
                <div className="pt-2 flex flex-col-reverse sm:flex-row sm:items-center justify-end gap-2.5">
                  <button
                    type="button"
                    onClick={handleCancelEdit}
                    disabled={isSaving}
                    className="min-h-[42px] px-4 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-300 text-xs font-bold inline-flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
                  >
                    <X className="w-3.5 h-3.5" />
                    <span>Cancel</span>
                  </button>
                  <button
                    type="submit"
                    disabled={isSaving}
                    className="min-h-[42px] px-5 py-2 rounded-xl bg-gradient-to-r from-purple-600 via-blue-600 to-cyan-500 hover:from-purple-500 hover:to-cyan-400 text-white text-xs font-bold inline-flex items-center justify-center gap-1.5 shadow-lg shadow-blue-600/25 cursor-pointer disabled:opacity-50"
                  >
                    {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                    <span>{isSaving ? 'Saving Configuration...' : 'Save & Update Settings'}</span>
                  </button>
                </div>
              )}
            </div>
          </form>

          {/* Honest Cloudflare Worker Secrets & Security Notice */}
          <div className="p-4 sm:p-5 rounded-2xl bg-[#090D16] border border-cyan-500/25 space-y-3">
            <div className="flex items-start gap-3">
              <Terminal className="w-5 h-5 text-cyan-400 shrink-0 mt-0.5" />
              <div className="space-y-1 min-w-0 flex-1">
                <h3 className="text-sm font-bold text-white">
                  Cloudflare Worker Secrets &amp; Deployment Instructions
                </h3>
                <p className="text-xs text-zinc-300 leading-relaxed">
                  {config.environment.cloudflareSyncNote}
                </p>
                <p className="text-[11px] text-zinc-400 leading-relaxed">
                  To update Cloudflare Worker runtime secrets directly inside Cloudflare&apos;s edge environment, run the Wrangler CLI commands below (or set them in Cloudflare Dashboard → Workers → Settings → Variables &amp; Secrets):
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              <div className="p-3 rounded-xl bg-[#05070D] border border-zinc-800 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-bold text-cyan-300">
                    1. Push Encrypted Secrets via Wrangler CLI
                  </span>
                  <button
                    type="button"
                    onClick={() => void handleCopySnippet('cli', CLOUDFLARE_CLI_SNIPPET)}
                    className="px-2 py-1 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-[10px] font-semibold text-zinc-200 inline-flex items-center gap-1 cursor-pointer"
                  >
                    {copiedBlock === 'cli' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                    <span>{copiedBlock === 'cli' ? 'Copied' : 'Copy'}</span>
                  </button>
                </div>
                <pre className="text-[11px] font-mono text-zinc-300 overflow-x-auto leading-relaxed">
                  {CLOUDFLARE_CLI_SNIPPET}
                </pre>
              </div>

              <div className="p-3 rounded-xl bg-[#05070D] border border-zinc-800 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-bold text-purple-300">
                    2. Worker `[vars]` / Environment Reference
                  </span>
                  <button
                    type="button"
                    onClick={() => void handleCopySnippet('vars', CLOUDFLARE_ENV_SNIPPET)}
                    className="px-2 py-1 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-[10px] font-semibold text-zinc-200 inline-flex items-center gap-1 cursor-pointer"
                  >
                    {copiedBlock === 'vars' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                    <span>{copiedBlock === 'vars' ? 'Copied' : 'Copy'}</span>
                  </button>
                </div>
                <pre className="text-[11px] font-mono text-zinc-300 overflow-x-auto leading-relaxed">
                  {CLOUDFLARE_ENV_SNIPPET}
                </pre>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
