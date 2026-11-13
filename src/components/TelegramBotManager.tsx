import React, { Component, ErrorInfo, ReactNode, useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Bell,
  Bot,
  CheckCircle2,
  Clock,
  Edit2,
  Eye,
  EyeOff,
  Loader2,
  MessageSquare,
  Plus,
  Power,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Trash2,
  Wifi,
  X,
  XCircle
} from 'lucide-react';
import type {
  TelegramBotConfig,
  TelegramDashboardResponse,
  TelegramNotificationLog
} from '../types';
import {
  createTelegramBot,
  deleteTelegramBot,
  fetchTelegramDashboard,
  retryTelegramLog,
  sendTelegramTestNotification,
  testTelegramBotConnection,
  toggleTelegramBotStatus,
  updateTelegramBot,
  updateTelegramManagerSettings
} from '../services/telegramApi';
import { useToast } from './Toast';

interface BotFormState {
  id?: string;
  botName: string;
  token: string;
  chatId: string;
  description: string;
  isActive: boolean;
}

const EMPTY_FORM: BotFormState = {
  botName: '',
  token: '',
  chatId: '',
  description: '',
  isActive: true
};

function formatDateTime(iso?: string | null): string {
  if (!iso) return 'None yet';
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

export class TelegramBotManagerBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean; errorMessage: string; retryKey: number }
> {
  state = { hasError: false, errorMessage: '', retryKey: 0 };

  static getDerivedStateFromError(error: Error) {
    return {
      hasError: true,
      errorMessage: error?.message || 'Unexpected error rendering Telegram Bot Manager.'
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('TelegramBotManager isolated error:', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="p-6 rounded-2xl bg-[#090D16] border border-rose-500/35 text-zinc-100 space-y-3">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <h3 className="text-sm font-bold text-white">Telegram Bot Manager encountered an error</h3>
              <p className="text-xs text-rose-200/90 leading-relaxed">{this.state.errorMessage}</p>
              <p className="text-[11px] text-zinc-400">
                The rest of Skill-Flix and your Admin Panel remain unaffected.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() =>
              this.setState(prev => ({
                hasError: false,
                errorMessage: '',
                retryKey: prev.retryKey + 1
              }))
            }
            className="min-h-[40px] px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold inline-flex items-center gap-1.5 cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Retry Telegram Bot Manager</span>
          </button>
        </div>
      );
    }

    return <React.Fragment key={this.state.retryKey}>{this.props.children}</React.Fragment>;
  }
}

export const TelegramBotManager: React.FC = () => {
  const { showToast } = useToast();

  const [dashboard, setDashboard] = useState<TelegramDashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Filters & Pagination for Logs
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'SENT' | 'FAILED' | 'PENDING'>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [page, setPage] = useState(1);

  // Bot Add/Edit Modal State
  const [formOpen, setFormOpen] = useState(false);
  const [formState, setFormState] = useState<BotFormState>(EMPTY_FORM);
  const [showTokenInput, setShowTokenInput] = useState(false);
  const [savingBot, setSavingBot] = useState(false);
  const [testingModalConn, setTestingModalConn] = useState(false);
  const [modalTestFeedback, setModalTestFeedback] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  // Delete Confirmation Modal State
  const [botToDelete, setBotToDelete] = useState<TelegramBotConfig | null>(null);
  const [deletingBot, setDeletingBot] = useState(false);

  // Per-item busy flags
  const [busyBots, setBusyBots] = useState<Record<string, string>>({});
  const [retryingLogs, setRetryingLogs] = useState<Record<string, boolean>>({});
  const [savingSettings, setSavingSettings] = useState(false);

  const loadDashboard = useCallback(
    async (silent = false) => {
      try {
        if (silent) setRefreshing(true);
        else setLoading(true);
        setLoadError(null);

        const data = await fetchTelegramDashboard({
          status: statusFilter,
          search: searchQuery,
          page,
          pageSize: 10
        });
        setDashboard(data);
      } catch (err: unknown) {
        const message = (err as Error)?.message || 'Failed to load Telegram Bot Manager.';
        setLoadError(message);
        showToast(message, 'error');
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [page, searchQuery, showToast, statusFilter]
  );

  useEffect(() => {
    void loadDashboard(false);
  }, [loadDashboard]);

  const setBotBusy = (botId: string, action: string | null) => {
    setBusyBots(prev => {
      const next = { ...prev };
      if (action) next[botId] = action;
      else delete next[botId];
      return next;
    });
  };

  const openAddModal = () => {
    setFormState(EMPTY_FORM);
    setShowTokenInput(false);
    setModalTestFeedback(null);
    setFormOpen(true);
  };

  const openEditModal = (bot: TelegramBotConfig) => {
    setFormState({
      id: bot.id,
      botName: bot.botName,
      token: '', // Never prefill or expose saved token
      chatId: bot.chatId,
      description: bot.description || '',
      isActive: bot.isActive
    });
    setShowTokenInput(false);
    setModalTestFeedback(null);
    setFormOpen(true);
  };

  const closeFormModal = () => {
    setFormOpen(false);
    setFormState(EMPTY_FORM);
    setShowTokenInput(false);
    setModalTestFeedback(null);
  };

  const handleTestModalConnection = async () => {
    if (!formState.id && !formState.token.trim()) {
      setModalTestFeedback({ success: false, message: 'Enter a Telegram Bot Token first.' });
      return;
    }
    if (!formState.chatId.trim()) {
      setModalTestFeedback({ success: false, message: 'Enter a Telegram Chat ID first.' });
      return;
    }
    setTestingModalConn(true);
    setModalTestFeedback(null);
    try {
      const res = await testTelegramBotConnection({
        botId: formState.id,
        token: formState.token.trim() || undefined,
        chatId: formState.chatId.trim(),
        botName: formState.botName.trim() || 'Telegram Bot'
      });
      setModalTestFeedback({ success: res.success, message: res.message });
    } catch (err: unknown) {
      setModalTestFeedback({
        success: false,
        message: (err as Error).message || 'Connection test failed.'
      });
    } finally {
      setTestingModalConn(false);
    }
  };

  const handleSaveBot = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formState.botName.trim()) {
      showToast('Bot Name is required.', 'error');
      return;
    }
    if (!formState.id && !formState.token.trim()) {
      showToast('Telegram Bot Token is required.', 'error');
      return;
    }
    if (!formState.chatId.trim()) {
      showToast('Telegram Chat ID is required.', 'error');
      return;
    }

    setSavingBot(true);
    try {
      if (formState.id) {
        await updateTelegramBot(formState.id, {
          botName: formState.botName.trim(),
          token: formState.token.trim() || undefined,
          chatId: formState.chatId.trim(),
          description: formState.description.trim(),
          isActive: formState.isActive
        });
        showToast(`Updated bot "${formState.botName.trim()}".`, 'success');
      } else {
        await createTelegramBot({
          botName: formState.botName.trim(),
          token: formState.token.trim(),
          chatId: formState.chatId.trim(),
          description: formState.description.trim(),
          isActive: formState.isActive
        });
        showToast(`Added Telegram bot "${formState.botName.trim()}".`, 'success');
      }
      closeFormModal();
      await loadDashboard(true);
    } catch (err: unknown) {
      showToast((err as Error).message || 'Could not save Telegram bot.', 'error');
    } finally {
      setSavingBot(false);
    }
  };

  const handleToggleBot = async (bot: TelegramBotConfig) => {
    setBotBusy(bot.id, 'toggle');
    try {
      await toggleTelegramBotStatus(bot.id, !bot.isActive);
      showToast(
        `${bot.botName} ${!bot.isActive ? 'activated' : 'deactivated'}.`,
        !bot.isActive ? 'success' : 'info'
      );
      await loadDashboard(true);
    } catch (err: unknown) {
      showToast((err as Error).message || 'Failed to update bot status.', 'error');
    } finally {
      setBotBusy(bot.id, null);
    }
  };

  const handleTestBot = async (bot: TelegramBotConfig) => {
    setBotBusy(bot.id, 'test');
    try {
      const res = await testTelegramBotConnection({ botId: bot.id });
      showToast(res.message, res.success ? 'success' : 'error');
      await loadDashboard(true);
    } catch (err: unknown) {
      showToast((err as Error).message || 'Connection test failed.', 'error');
    } finally {
      setBotBusy(bot.id, null);
    }
  };

  const handleSendTestAlert = async (bot: TelegramBotConfig) => {
    setBotBusy(bot.id, 'send-test');
    try {
      const res = await sendTelegramTestNotification(bot.id);
      showToast(res.message, res.success ? 'success' : 'error');
      await loadDashboard(true);
    } catch (err: unknown) {
      showToast((err as Error).message || 'Failed to send test alert.', 'error');
    } finally {
      setBotBusy(bot.id, null);
    }
  };

  const handleConfirmDelete = async () => {
    if (!botToDelete) return;
    setDeletingBot(true);
    try {
      await deleteTelegramBot(botToDelete.id);
      showToast(`Deleted bot "${botToDelete.botName}".`, 'info');
      setBotToDelete(null);
      await loadDashboard(true);
    } catch (err: unknown) {
      showToast((err as Error).message || 'Failed to delete bot.', 'error');
    } finally {
      setDeletingBot(false);
    }
  };

  const handleRetryLog = async (log: TelegramNotificationLog) => {
    setRetryingLogs(prev => ({ ...prev, [log.id]: true }));
    try {
      const res = await retryTelegramLog(log.id);
      if (res.log.status === 'SENT') {
        showToast(`Notification resent to "${log.botName}" successfully.`, 'success');
      } else {
        showToast(res.log.errorMessage || 'Retry failed.', 'error');
      }
      await loadDashboard(true);
    } catch (err: unknown) {
      showToast((err as Error).message || 'Retry request failed.', 'error');
    } finally {
      setRetryingLogs(prev => ({ ...prev, [log.id]: false }));
    }
  };

  const handleToggleResolutionAlert = async () => {
    if (!dashboard) return;
    setSavingSettings(true);
    try {
      const next = !Boolean(dashboard.settings?.notifyOnResolution);
      await updateTelegramManagerSettings({ notifyOnResolution: next });
      showToast(
        next
          ? 'Telegram alerts enabled for payment approvals & rejections.'
          : 'Telegram alerts disabled for payment approvals & rejections.',
        'info'
      );
      await loadDashboard(true);
    } catch (err: unknown) {
      showToast((err as Error)?.message || 'Failed to update settings.', 'error');
    } finally {
      setSavingSettings(false);
    }
  };

  const renderStatusBadge = (status: TelegramNotificationLog['status']) => {
    if (status === 'SENT') {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-950/90 text-emerald-300 border border-emerald-500/30 text-[10px] font-bold whitespace-nowrap">
          <CheckCircle2 className="w-3 h-3 shrink-0" />
          <span>SENT</span>
        </span>
      );
    }
    if (status === 'FAILED') {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-rose-950/90 text-rose-300 border border-rose-500/30 text-[10px] font-bold whitespace-nowrap">
          <XCircle className="w-3 h-3 shrink-0" />
          <span>FAILED</span>
        </span>
      );
    }
    if (status === 'RETRYING') {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-cyan-950/90 text-cyan-300 border border-cyan-500/30 text-[10px] font-bold whitespace-nowrap">
          <RefreshCw className="w-3 h-3 shrink-0 animate-spin" />
          <span>RETRYING</span>
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-950/90 text-amber-300 border border-amber-500/30 text-[10px] font-bold whitespace-nowrap">
        <Clock className="w-3 h-3 shrink-0" />
        <span>PENDING</span>
      </span>
    );
  };

  const summary = dashboard?.summary || {
    totalBots: 0,
    activeBots: 0,
    inactiveBots: 0,
    totalNotificationsSent: 0,
    totalFailedNotifications: 0,
    lastSuccessfulNotificationAt: null
  };
  const bots = dashboard?.bots || [];
  const logs = dashboard?.logs || [];
  const pagination = dashboard?.logsPagination || { page: 1, pageSize: 10, total: 0, totalPages: 1 };

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Bot className="w-5 h-5 text-cyan-400 shrink-0" />
            <h2 className="text-lg font-bold text-white tracking-tight">Telegram Bot Manager</h2>
          </div>
          <p className="text-xs text-zinc-400 mt-0.5">
            Configure unlimited Telegram bots for instant multi-destination payment notifications.
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => void loadDashboard(true)}
            disabled={refreshing}
            className="min-h-[40px] px-3 py-2 rounded-xl bg-[#090D16] border border-zinc-800 hover:border-zinc-700 text-zinc-300 hover:text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer disabled:opacity-60 whitespace-nowrap"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>
          <button
            type="button"
            onClick={openAddModal}
            className="min-h-[40px] px-3.5 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold flex items-center gap-1.5 shadow-md shadow-blue-600/25 cursor-pointer whitespace-nowrap"
          >
            <Plus className="w-4 h-4 shrink-0" />
            <span>Add New Bot</span>
          </button>
        </div>
      </div>

      {/* Section-level Backend / Network Error Alert */}
      {loadError && (
        <div
          role="alert"
          className="p-4 rounded-2xl bg-rose-950/35 border border-rose-500/35 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
        >
          <div className="flex items-start gap-2.5 min-w-0">
            <XCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="text-xs font-bold text-rose-200">
                Could not connect to Telegram Bot Manager backend
              </p>
              <p className="text-[11px] text-rose-200/85 mt-0.5 break-words">{loadError}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void loadDashboard(false)}
            disabled={loading || refreshing}
            className="min-h-[38px] px-3.5 py-1.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold shrink-0 cursor-pointer inline-flex items-center gap-1.5 whitespace-nowrap disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading || refreshing ? 'animate-spin' : ''}`} />
            <span>Retry</span>
          </button>
        </div>
      )}

      {/* Warning when no active bots */}
      {!loading && !loadError && summary.activeBots === 0 && (
        <div className="p-3.5 rounded-2xl bg-amber-950/35 border border-amber-500/35 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div>
              <p className="text-xs font-bold text-amber-200">
                No active Telegram bots configured
              </p>
              <p className="text-[11px] text-amber-300/80 mt-0.5">
                Student payment submissions are still saved safely in Firestore and Admin Panel, but Telegram alerts will not fire until at least one bot is active.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={openAddModal}
            className="min-h-[38px] px-3 py-1.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-black text-xs font-bold shrink-0 cursor-pointer whitespace-nowrap"
          >
            Configure Bot
          </button>
        </div>
      )}

      {/* 6 Overview Metric Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-2.5 sm:gap-3">
        <div className="p-3.5 rounded-2xl bg-[#090D16] border border-blue-500/15">
          <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 block">
            Total Telegram Bots
          </span>
          <p className="text-xl font-extrabold text-white tabular-nums mt-1">{summary.totalBots}</p>
        </div>

        <div className="p-3.5 rounded-2xl bg-[#090D16] border border-emerald-500/20">
          <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 block">
            Active Bots
          </span>
          <p className="text-xl font-extrabold text-emerald-400 tabular-nums mt-1">{summary.activeBots}</p>
        </div>

        <div className="p-3.5 rounded-2xl bg-[#090D16] border border-zinc-800">
          <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 block">
            Inactive Bots
          </span>
          <p className="text-xl font-extrabold text-zinc-300 tabular-nums mt-1">{summary.inactiveBots}</p>
        </div>

        <div className="p-3.5 rounded-2xl bg-[#090D16] border border-cyan-500/20">
          <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 block">
            Notifications Sent
          </span>
          <p className="text-xl font-extrabold text-cyan-300 tabular-nums mt-1">
            {summary.totalNotificationsSent}
          </p>
        </div>

        <div className="p-3.5 rounded-2xl bg-[#090D16] border border-rose-500/20">
          <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 block">
            Failed Notifications
          </span>
          <p className="text-xl font-extrabold text-rose-400 tabular-nums mt-1">
            {summary.totalFailedNotifications}
          </p>
        </div>

        <div className="p-3.5 rounded-2xl bg-[#090D16] border border-blue-500/15 col-span-2 sm:col-span-1">
          <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 block">
            Last Successful Alert
          </span>
          <p className="text-xs font-semibold text-white tabular-nums mt-1.5 leading-snug">
            {formatDateTime(summary.lastSuccessfulNotificationAt)}
          </p>
        </div>
      </div>

      {/* Notification Preference Bar */}
      <div className="p-3.5 rounded-2xl bg-[#090D16] border border-zinc-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <Bell className="w-4 h-4 text-cyan-400 shrink-0 mt-0.5" />
          <div>
            <p className="text-xs font-bold text-white">
              Also notify bots when Admin Approves or Rejects a Payment
            </p>
            <p className="text-[11px] text-zinc-400">
              New student payment submissions always notify all active bots automatically. Enable this option to receive follow-up alerts upon resolution.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={handleToggleResolutionAlert}
          disabled={savingSettings || !dashboard}
          className={`min-h-[38px] px-3.5 py-1.5 rounded-xl text-xs font-bold cursor-pointer transition-colors shrink-0 whitespace-nowrap border ${
            dashboard?.settings?.notifyOnResolution
              ? 'bg-emerald-600/20 text-emerald-300 border-emerald-500/40'
              : 'bg-zinc-900 text-zinc-400 border-zinc-700 hover:text-white'
          }`}
        >
          {dashboard?.settings?.notifyOnResolution ? 'Resolution Alerts: ON' : 'Resolution Alerts: OFF'}
        </button>
      </div>

      {/* Configured Bots List */}
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
            <span>Configured Telegram Bots ({bots.length})</span>
          </h3>
          <span className="text-[11px] text-zinc-400">Encrypted at rest • Masked in UI</span>
        </div>

        {loading && !dashboard ? (
          <div className="p-8 rounded-2xl bg-[#090D16] border border-zinc-800 flex items-center justify-center gap-2 text-xs text-zinc-400">
            <Loader2 className="w-4 h-4 animate-spin text-blue-400" />
            <span>Loading configured bots...</span>
          </div>
        ) : loadError && !dashboard ? (
          <div className="p-6 rounded-2xl bg-[#090D16] border border-zinc-800 text-center text-xs text-zinc-400">
            Telegram bots could not be loaded until the backend connection is restored. Use the <strong className="text-white">Retry</strong> button above.
          </div>
        ) : bots.length === 0 ? (
          <div className="p-8 rounded-2xl bg-[#090D16] border border-zinc-800 text-center space-y-3">
            <Bot className="w-8 h-8 text-zinc-500 mx-auto" />
            <div>
              <p className="text-sm font-bold text-white">No Telegram bots added yet</p>
              <p className="text-xs text-zinc-400 mt-1 max-w-md mx-auto">
                Add your main payment bot, personal alert bot, or team group bots to receive instant HTML payment alerts.
              </p>
            </div>
            <button
              type="button"
              onClick={openAddModal}
              className="min-h-[40px] px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold cursor-pointer inline-flex items-center gap-1.5"
            >
              <Plus className="w-4 h-4" />
              <span>Add First Telegram Bot</span>
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
            {bots.map(bot => {
              const busyAction = busyBots[bot.id];
              return (
                <div
                  key={bot.id}
                  className="p-4 rounded-2xl bg-[#090D16] border border-blue-500/15 space-y-3"
                >
                  {/* Top Row: Name & Active Badge */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 className="text-sm font-bold text-white truncate">{bot.botName}</h4>
                        {bot.botUsername && (
                          <span className="text-[11px] font-mono text-cyan-300">
                            {bot.botUsername}
                          </span>
                        )}
                      </div>
                      {bot.description && (
                        <p className="text-xs text-zinc-400 mt-0.5 line-clamp-2">{bot.description}</p>
                      )}
                    </div>

                    <span
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold shrink-0 whitespace-nowrap ${
                        bot.isActive
                          ? 'bg-emerald-950/90 text-emerald-300 border border-emerald-500/35'
                          : 'bg-zinc-900 text-zinc-400 border border-zinc-700'
                      }`}
                    >
                      <Power className="w-3 h-3" />
                      <span>{bot.isActive ? 'ACTIVE' : 'INACTIVE'}</span>
                    </span>
                  </div>

                  {/* Masked Credentials & Delivery Summary */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
                    <div className="p-2.5 rounded-xl bg-[#05070D] border border-zinc-800/90">
                      <span className="text-zinc-500 block text-[10px] uppercase font-semibold">
                        Bot Token (Masked)
                      </span>
                      <span className="font-mono text-zinc-200 break-all">{bot.maskedToken}</span>
                    </div>
                    <div className="p-2.5 rounded-xl bg-[#05070D] border border-zinc-800/90">
                      <span className="text-zinc-500 block text-[10px] uppercase font-semibold">
                        Target Chat ID
                      </span>
                      <span className="font-mono text-cyan-300 break-all">{bot.chatId}</span>
                    </div>
                  </div>

                  {/* Status Metrics Row */}
                  <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-zinc-400 pt-1 border-t border-zinc-800/80">
                    <div className="flex items-center gap-3 tabular-nums">
                      <span>
                        Sent: <strong className="text-emerald-300">{bot.totalSentCount || 0}</strong>
                      </span>
                      <span>
                        Failed: <strong className="text-rose-300">{bot.totalFailedCount || 0}</strong>
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 text-[11px]">
                      <span>Last Alert:</span>
                      {bot.lastNotificationStatus ? (
                        <span
                          className={`font-bold ${
                            bot.lastNotificationStatus === 'SENT'
                              ? 'text-emerald-300'
                              : 'text-rose-300'
                          }`}
                        >
                          {bot.lastNotificationStatus} ({formatDateTime(bot.lastNotifiedAt)})
                        </span>
                      ) : (
                        <span className="text-zinc-500">Never</span>
                      )}
                    </div>
                  </div>

                  {/* Last Error / Test Message */}
                  {(bot.lastErrorMessage || bot.lastTestMessage) && (
                    <div
                      className={`p-2.5 rounded-xl text-[11px] border ${
                        bot.lastNotificationStatus === 'FAILED' || bot.lastTestStatus === 'FAILED'
                          ? 'bg-rose-950/30 border-rose-500/25 text-rose-200'
                          : 'bg-[#05070D] border-zinc-800 text-zinc-300'
                      }`}
                    >
                      {bot.lastErrorMessage || bot.lastTestMessage}
                    </div>
                  )}

                  {/* Actions */}
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => void handleToggleBot(bot)}
                      disabled={Boolean(busyAction)}
                      className={`min-h-[38px] px-3 py-1.5 rounded-xl text-xs font-bold cursor-pointer flex items-center gap-1.5 whitespace-nowrap disabled:opacity-50 ${
                        bot.isActive
                          ? 'bg-zinc-900 hover:bg-zinc-800 text-amber-300 border border-amber-500/30'
                          : 'bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/35'
                      }`}
                    >
                      <Power className="w-3.5 h-3.5" />
                      <span>{bot.isActive ? 'Deactivate' : 'Activate'}</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => void handleTestBot(bot)}
                      disabled={Boolean(busyAction)}
                      className="min-h-[38px] px-3 py-1.5 rounded-xl bg-[#05070D] hover:bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs font-semibold cursor-pointer flex items-center gap-1.5 whitespace-nowrap disabled:opacity-50"
                    >
                      {busyAction === 'test' ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Wifi className="w-3.5 h-3.5 text-cyan-400" />
                      )}
                      <span>Test Connection</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => void handleSendTestAlert(bot)}
                      disabled={Boolean(busyAction)}
                      className="min-h-[38px] px-3 py-1.5 rounded-xl bg-blue-600/20 hover:bg-blue-600/30 border border-blue-500/35 text-blue-200 text-xs font-semibold cursor-pointer flex items-center gap-1.5 whitespace-nowrap disabled:opacity-50"
                    >
                      {busyAction === 'send-test' ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Send className="w-3.5 h-3.5" />
                      )}
                      <span>Send Test Alert</span>
                    </button>

                    <div className="flex items-center gap-1.5 ml-auto">
                      <button
                        type="button"
                        onClick={() => openEditModal(bot)}
                        disabled={Boolean(busyAction)}
                        className="min-h-[38px] min-w-[38px] px-2.5 py-1.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-300 hover:text-white text-xs font-semibold cursor-pointer flex items-center gap-1"
                        title="Edit bot configuration"
                      >
                        <Edit2 className="w-3.5 h-3.5" />
                        <span className="sm:hidden">Edit</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => setBotToDelete(bot)}
                        disabled={Boolean(busyAction)}
                        className="min-h-[38px] min-w-[38px] px-2.5 py-1.5 rounded-xl bg-rose-950/50 hover:bg-rose-900/60 border border-rose-500/30 text-rose-300 text-xs font-semibold cursor-pointer flex items-center gap-1"
                        title="Delete bot"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span className="sm:hidden">Delete</span>
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Notification History & Logs */}
      <section className="space-y-3 pt-2">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-blue-400" />
              <span>Notification Delivery Logs ({pagination.total})</span>
            </h3>
            <p className="text-[11px] text-zinc-400">
              Track delivery per bot, inspect errors, and retry failed deliveries without duplicating sent alerts.
            </p>
          </div>

          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
            {/* Search */}
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={e => {
                  setSearchQuery(e.target.value);
                  setPage(1);
                }}
                placeholder="Search Payment ID, Student, Bot, UTR..."
                className="w-full sm:w-64 min-h-[38px] pl-8 pr-3 py-1.5 rounded-xl bg-[#090D16] border border-zinc-800 focus:border-blue-500 text-xs text-white outline-none"
              />
            </div>

            {/* Filter Tabs */}
            <div className="flex items-center gap-1 overflow-x-auto no-scrollbar">
              {(
                [
                  { id: 'ALL', label: 'All' },
                  { id: 'SENT', label: 'Successful' },
                  { id: 'FAILED', label: 'Failed' },
                  { id: 'PENDING', label: 'Pending' }
                ] as const
              ).map(tab => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => {
                    setStatusFilter(tab.id);
                    setPage(1);
                  }}
                  className={`min-h-[36px] px-3 py-1.5 rounded-xl text-xs font-bold cursor-pointer whitespace-nowrap shrink-0 transition-colors ${
                    statusFilter === tab.id
                      ? 'bg-blue-600 text-white'
                      : 'bg-[#090D16] border border-zinc-800 text-zinc-400 hover:text-white'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {logs.length === 0 ? (
          <div className="p-8 rounded-2xl bg-[#090D16] border border-zinc-800 text-center text-xs text-zinc-400">
            No notification logs match the current filter.
          </div>
        ) : (
          <>
            {/* Mobile Card View (< md) */}
            <div className="space-y-2.5 md:hidden">
              {logs.map(log => (
                <div
                  key={log.id}
                  className="p-3.5 rounded-2xl bg-[#090D16] border border-zinc-800 space-y-2 text-xs"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <span className="font-bold text-white block truncate">{log.studentName}</span>
                      <span className="text-[11px] text-zinc-400 font-mono block truncate">
                        {log.paymentRequestId}
                      </span>
                    </div>
                    {renderStatusBadge(log.status)}
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-[11px] text-zinc-300 pt-1">
                    <div>
                      <span className="text-zinc-500 block">Bot</span>
                      <span className="font-semibold truncate block">{log.botName}</span>
                    </div>
                    <div>
                      <span className="text-zinc-500 block">Amount / UTR</span>
                      <span className="font-mono tabular-nums">
                        ₹{log.amount} • {log.utr}
                      </span>
                    </div>
                  </div>

                  <div className="text-[11px] text-zinc-400 tabular-nums">
                    {formatDateTime(log.sentAt || log.createdAt)}
                  </div>

                  {log.errorMessage && (
                    <div className="p-2 rounded-xl bg-rose-950/35 border border-rose-500/25 text-[11px] text-rose-200">
                      {log.errorMessage}
                    </div>
                  )}

                  {log.status === 'FAILED' && (
                    <button
                      type="button"
                      onClick={() => void handleRetryLog(log)}
                      disabled={Boolean(retryingLogs[log.id])}
                      className="w-full min-h-[38px] py-1.5 px-3 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-200 text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
                    >
                      <RefreshCw
                        className={`w-3.5 h-3.5 ${retryingLogs[log.id] ? 'animate-spin' : ''}`}
                      />
                      <span>{retryingLogs[log.id] ? 'Retrying...' : 'Retry Failed Delivery'}</span>
                    </button>
                  )}
                </div>
              ))}
            </div>

            {/* Desktop Table View (md+) */}
            <div className="hidden md:block rounded-2xl bg-[#090D16] border border-blue-500/15 overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-[#05070D] text-zinc-400 uppercase text-[10px] tracking-wider border-b border-zinc-800">
                  <tr>
                    <th className="py-3 px-3.5">Payment Request</th>
                    <th className="py-3 px-3.5">Student</th>
                    <th className="py-3 px-3.5">Bot Name</th>
                    <th className="py-3 px-3.5">Notification Date</th>
                    <th className="py-3 px-3.5">Status</th>
                    <th className="py-3 px-3.5">Error / Details</th>
                    <th className="py-3 px-3.5 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/80">
                  {logs.map(log => (
                    <tr key={log.id} className="hover:bg-zinc-900/40">
                      <td className="py-3 px-3.5">
                        <span className="font-mono text-cyan-300 block">{log.paymentRequestId}</span>
                        <span className="text-[11px] text-zinc-400 font-mono">
                          ₹{log.amount} • UTR: {log.utr}
                        </span>
                      </td>
                      <td className="py-3 px-3.5">
                        <span className="font-semibold text-white block">{log.studentName}</span>
                        <span className="text-[11px] text-zinc-400">{log.courseName}</span>
                      </td>
                      <td className="py-3 px-3.5 font-semibold text-zinc-200">{log.botName}</td>
                      <td className="py-3 px-3.5 text-zinc-300 tabular-nums whitespace-nowrap">
                        {formatDateTime(log.sentAt || log.createdAt)}
                      </td>
                      <td className="py-3 px-3.5">{renderStatusBadge(log.status)}</td>
                      <td className="py-3 px-3.5 max-w-xs">
                        {log.errorMessage ? (
                          <span className="text-[11px] text-rose-300 line-clamp-2" title={log.errorMessage}>
                            {log.errorMessage}
                          </span>
                        ) : (
                          <span className="text-[11px] text-zinc-500">
                            {log.telegramMessageId ? `Msg #${log.telegramMessageId}` : 'Delivered'}
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-3.5 text-right">
                        {log.status === 'FAILED' ? (
                          <button
                            type="button"
                            onClick={() => void handleRetryLog(log)}
                            disabled={Boolean(retryingLogs[log.id])}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-200 text-[11px] font-bold cursor-pointer disabled:opacity-50 whitespace-nowrap"
                          >
                            <RefreshCw
                              className={`w-3 h-3 ${retryingLogs[log.id] ? 'animate-spin' : ''}`}
                            />
                            <span>Retry</span>
                          </button>
                        ) : (
                          <span className="text-[11px] text-zinc-600">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {pagination.totalPages > 1 && (
              <div className="flex items-center justify-between pt-1 text-xs">
                <span className="text-zinc-400 tabular-nums">
                  Page {pagination.page} of {pagination.totalPages} ({pagination.total} logs)
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={pagination.page <= 1}
                    onClick={() => setPage(p => Math.max(1, p - 1))}
                    className="min-h-[36px] px-3 py-1.5 rounded-xl bg-[#090D16] border border-zinc-800 text-zinc-300 hover:text-white disabled:opacity-40 cursor-pointer"
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    disabled={pagination.page >= pagination.totalPages}
                    onClick={() => setPage(p => p + 1)}
                    className="min-h-[36px] px-3 py-1.5 rounded-xl bg-[#090D16] border border-zinc-800 text-zinc-300 hover:text-white disabled:opacity-40 cursor-pointer"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </section>

      {/* ======================================================== */}
      {/* MODAL: ADD / EDIT TELEGRAM BOT                           */}
      {/* ======================================================== */}
      {formOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/90 overflow-y-auto">
          <div className="relative w-full max-w-md bg-[#0B0F19] border border-blue-500/30 rounded-2xl p-5 text-white my-6">
            <button
              type="button"
              onClick={closeFormModal}
              className="absolute top-3.5 right-3.5 p-1.5 rounded-lg bg-zinc-800 text-zinc-400 hover:text-white cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>

            <h3 className="font-bold text-sm mb-1 flex items-center gap-2">
              <Bot className="w-4 h-4 text-cyan-400" />
              <span>{formState.id ? 'Edit Telegram Bot' : 'Add New Telegram Bot'}</span>
            </h3>
            <p className="text-[11px] text-zinc-400 mb-4">
              Bot tokens are encrypted server-side with AES-256-GCM and never exposed after saving.
            </p>

            <form onSubmit={handleSaveBot} className="space-y-3 text-xs">
              <div>
                <label className="block text-zinc-300 mb-1 font-semibold">Bot Name *</label>
                <input
                  type="text"
                  required
                  value={formState.botName}
                  onChange={e => setFormState({ ...formState, botName: e.target.value })}
                  placeholder="e.g. Main Payment Bot"
                  className="w-full min-h-[40px] px-3 py-2 rounded-xl bg-[#05070D] border border-blue-500/25 focus:border-cyan-400 text-white outline-none"
                />
              </div>

              <div>
                <label className="block text-zinc-300 mb-1 font-semibold">
                  Telegram Bot Token {formState.id ? '(Optional to rotate)' : '*'}
                </label>
                <div className="relative">
                  <input
                    type={showTokenInput ? 'text' : 'password'}
                    required={!formState.id}
                    autoComplete="off"
                    value={formState.token}
                    onChange={e => setFormState({ ...formState, token: e.target.value })}
                    placeholder={
                      formState.id
                        ? 'Leave blank to keep existing encrypted token'
                        : '123456789:ABCdefGHIjklMNOpqrsTUVwxyz'
                    }
                    className="w-full min-h-[40px] pl-3 pr-10 py-2 rounded-xl bg-[#05070D] border border-blue-500/25 focus:border-cyan-400 text-white font-mono outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowTokenInput(v => !v)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-zinc-400 hover:text-white cursor-pointer"
                    title={showTokenInput ? 'Hide token' : 'Show token'}
                  >
                    {showTokenInput ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-zinc-300 mb-1 font-semibold">Telegram Chat ID *</label>
                <input
                  type="text"
                  required
                  value={formState.chatId}
                  onChange={e => setFormState({ ...formState, chatId: e.target.value })}
                  placeholder="e.g. 987654321 or -1001234567890"
                  className="w-full min-h-[40px] px-3 py-2 rounded-xl bg-[#05070D] border border-blue-500/25 focus:border-cyan-400 text-white font-mono outline-none"
                />
                <p className="text-[10px] text-zinc-500 mt-1">
                  Send /start to your bot in Telegram first for personal chats, or add the bot to your admin group.
                </p>
              </div>

              <div>
                <label className="block text-zinc-300 mb-1 font-semibold">
                  Description (Optional)
                </label>
                <input
                  type="text"
                  value={formState.description}
                  onChange={e => setFormState({ ...formState, description: e.target.value })}
                  placeholder="e.g. Finance Team Group / Backup Alert Account"
                  className="w-full min-h-[40px] px-3 py-2 rounded-xl bg-[#05070D] border border-blue-500/25 focus:border-cyan-400 text-white outline-none"
                />
              </div>

              <div className="pt-1">
                <label className="flex items-center gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formState.isActive}
                    onChange={e => setFormState({ ...formState, isActive: e.target.checked })}
                    className="rounded border-zinc-700 text-blue-600"
                  />
                  <div>
                    <span className="font-semibold text-white block">Active Notification Status</span>
                    <span className="text-[10px] text-zinc-400">
                      Only active bots receive instant payment submission notifications.
                    </span>
                  </div>
                </label>
              </div>

              {modalTestFeedback && (
                <div
                  className={`p-2.5 rounded-xl text-[11px] border ${
                    modalTestFeedback.success
                      ? 'bg-emerald-950/40 border-emerald-500/35 text-emerald-200'
                      : 'bg-rose-950/40 border-rose-500/35 text-rose-200'
                  }`}
                >
                  {modalTestFeedback.message}
                </div>
              )}

              <div className="flex flex-col sm:flex-row gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => void handleTestModalConnection()}
                  disabled={testingModalConn || savingBot}
                  className="min-h-[40px] px-3.5 py-2 rounded-xl bg-[#05070D] hover:bg-zinc-800 border border-zinc-700 text-cyan-300 font-bold text-xs cursor-pointer flex items-center justify-center gap-1.5 disabled:opacity-50"
                >
                  {testingModalConn ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Wifi className="w-3.5 h-3.5" />
                  )}
                  <span>Test Connection</span>
                </button>

                <button
                  type="submit"
                  disabled={savingBot}
                  className="flex-1 min-h-[40px] py-2 px-4 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs shadow-md cursor-pointer disabled:opacity-60 flex items-center justify-center gap-1.5"
                >
                  {savingBot && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  <span>{formState.id ? 'Update Bot' : 'Save Bot'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ======================================================== */}
      {/* MODAL: DELETE CONFIRMATION                               */}
      {/* ======================================================== */}
      {botToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/90">
          <div className="relative w-full max-w-sm bg-[#0B0F19] border border-rose-500/35 rounded-2xl p-5 text-white space-y-4">
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-xl bg-rose-500/15 border border-rose-500/30 flex items-center justify-center shrink-0">
                <Trash2 className="w-4 h-4 text-rose-400" />
              </div>
              <div>
                <h3 className="font-bold text-sm text-white">Delete Telegram Bot?</h3>
                <p className="text-xs text-zinc-400 mt-1">
                  Remove <strong className="text-white">{botToDelete.botName}</strong> ({botToDelete.maskedToken})? It will stop receiving payment notifications immediately.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setBotToDelete(null)}
                disabled={deletingBot}
                className="min-h-[40px] py-2 px-3 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-semibold cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmDelete()}
                disabled={deletingBot}
                className="min-h-[40px] py-2 px-3 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold cursor-pointer flex items-center justify-center gap-1.5 disabled:opacity-60"
              >
                {deletingBot && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                <span>Delete Bot</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
