import React, { useEffect, useRef, useState } from 'react';
import {
  Bot,
  Check,
  Copy,
  Lock,
  RefreshCw,
  Send,
  Sparkles,
  Trash2,
  X,
  AlertCircle
} from 'lucide-react';
import type { AiChatMessage, AiQuotaInfo, AiStatusResponse, UserProfile } from '../types';
import {
  AiClientError,
  fetchSkillFlixAiStatus,
  sendSkillFlixAiMessage
} from '../services/aiApi';

interface SkillFlixAiAssistantProps {
  currentUser: UserProfile | null;
  onOpenAuth: () => void;
}

const WELCOME_TEXT =
  "Hey! Welcome to Skill-Flix. I'm your personal AI learning assistant. Ask me anything about video editing, courses, PDFs or creative skills. Let's learn something new!";

const SUGGESTED_QUESTIONS: string[] = [
  'Help me learn video editing.',
  'Which course is best for beginners?',
  'Explain Alight Motion.',
  'Find my course resources.',
  'Give me editing tips.'
];

function createWelcomeMessage(): AiChatMessage {
  return {
    id: 'skillflix_welcome',
    role: 'model',
    text: WELCOME_TEXT,
    timestamp: new Date().toISOString()
  };
}

/**
 * Safe React inline text formatter supporting **bold** and `code` without raw HTML injection.
 */
function renderInlineSegments(line: string, keyPrefix: string): React.ReactNode[] {
  const parts = line.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, idx) => {
    const key = `${keyPrefix}_${idx}`;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return (
        <strong key={key} className="font-semibold text-white">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code
          key={key}
          className="px-1.5 py-0.5 rounded bg-white/10 text-cyan-300 font-mono text-[11px]"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    return <React.Fragment key={key}>{part}</React.Fragment>;
  });
}

function FormattedAiText({ text }: { text: string }) {
  const lines = text.split('\n');
  return (
    <div className="space-y-1.5 text-[13px] leading-relaxed text-slate-100 break-words">
      {lines.map((rawLine, index) => {
        const trimmed = rawLine.trim();
        if (!trimmed) {
          return <div key={`sp_${index}`} className="h-1" />;
        }

        const bulletMatch = trimmed.match(/^[-•*]\s+(.+)$/);
        if (bulletMatch) {
          return (
            <div key={`li_${index}`} className="flex items-start gap-2 pl-1">
              <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-cyan-400 shrink-0" />
              <span className="flex-1">{renderInlineSegments(bulletMatch[1], `b_${index}`)}</span>
            </div>
          );
        }

        const numberedMatch = trimmed.match(/^(\d+\.)\s+(.+)$/);
        if (numberedMatch) {
          return (
            <div key={`num_${index}`} className="flex items-start gap-2 pl-0.5">
              <span className="text-cyan-300 font-semibold shrink-0">{numberedMatch[1]}</span>
              <span className="flex-1">{renderInlineSegments(numberedMatch[2], `n_${index}`)}</span>
            </div>
          );
        }

        const headingMatch = trimmed.match(/^#{1,3}\s+(.+)$/);
        if (headingMatch) {
          return (
            <div key={`hd_${index}`} className="font-bold text-cyan-200 pt-0.5">
              {renderInlineSegments(headingMatch[1], `h_${index}`)}
            </div>
          );
        }

        return <p key={`p_${index}`}>{renderInlineSegments(trimmed, `p_${index}`)}</p>;
      })}
    </div>
  );
}

export const SkillFlixAiAssistant: React.FC<SkillFlixAiAssistantProps> = ({
  currentUser,
  onOpenAuth
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<AiChatMessage[]>(() => [createWelcomeMessage()]);
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [errorBanner, setErrorBanner] = useState<{ message: string; code?: string } | null>(null);
  const [lastFailedPrompt, setLastFailedPrompt] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [statusInfo, setStatusInfo] = useState<AiStatusResponse | null>(null);
  const [quota, setQuota] = useState<AiQuotaInfo | null>(null);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const activeControllerRef = useRef<AbortController | null>(null);
  const requestSeqRef = useRef(0);
  const inFlightRef = useRef(false);

  const abortActiveRequest = () => {
    requestSeqRef.current += 1;
    inFlightRef.current = false;
    if (activeControllerRef.current) {
      activeControllerRef.current.abort();
      activeControllerRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      abortActiveRequest();
    };
  }, []);

  useEffect(() => {
    abortActiveRequest();
    setIsSending(false);
  }, [currentUser?.uid]);

  useEffect(() => {
    if (!isOpen) return;
    let active = true;
    const statusController = new AbortController();
    fetchSkillFlixAiStatus(statusController.signal)
      .then(info => {
        if (active) setStatusInfo(info);
      })
      .catch(() => {
        if (active) {
          setStatusInfo({
            online: false,
            provider: 'Google Gemini API (Free Tier)',
            model: 'gemini-4-hydrogen',
            fallbackModel: 'gemini-3.1-flash-lite',
            freeTier: true,
            reason: 'Online when available',
            limits: { perMinute: 10, perDay: 60 }
          });
        }
      });
    return () => {
      active = false;
      statusController.abort();
    };
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isSending, isOpen]);

  const handleCopy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => {
        setCopiedId(prev => (prev === id ? null : prev));
      }, 2000);
    } catch {
      // Clipboard blocked in strict iframe contexts
    }
  };

  const handleClearChat = () => {
    abortActiveRequest();
    setIsSending(false);
    setMessages([createWelcomeMessage()]);
    setErrorBanner(null);
    setLastFailedPrompt(null);
  };

  const submitPrompt = async (rawPrompt: string) => {
    const cleanPrompt = rawPrompt.trim();
    if (!cleanPrompt || isSending || inFlightRef.current) return;

    if (!currentUser?.uid) {
      setErrorBanner({
        code: 'AUTH_REQUIRED',
        message: 'Sign in with your Skill-Flix student account to chat with Skill-Flix AI.'
      });
      return;
    }

    setErrorBanner(null);
    setLastFailedPrompt(null);

    const userMsg: AiChatMessage = {
      id: `u_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      role: 'user',
      text: cleanPrompt,
      timestamp: new Date().toISOString()
    };

    const historyForServer = messages
      .filter(m => m.id !== 'skillflix_welcome' && !m.isError)
      .slice(-10)
      .map(m => ({ role: m.role, text: m.text }));

    const seq = ++requestSeqRef.current;
    const controller = new AbortController();
    activeControllerRef.current = controller;
    inFlightRef.current = true;

    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setIsSending(true);

    try {
      const response = await sendSkillFlixAiMessage({
        message: cleanPrompt,
        history: historyForServer,
        signal: controller.signal
      });

      if (requestSeqRef.current !== seq) return;

      const assistantMsg: AiChatMessage = {
        id: `a_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        role: 'model',
        text: response.reply,
        timestamp: new Date().toISOString(),
        model: response.model,
        referencedCourses: response.referencedCourses
      };

      setMessages(prev => [...prev, assistantMsg]);
      setQuota(response.quota);
    } catch (err: any) {
      if (requestSeqRef.current !== seq) return;
      if (err instanceof AiClientError && err.code === 'AI_CANCELLED') {
        return;
      }

      const code = err instanceof AiClientError ? err.code : 'AI_REQUEST_FAILED';
      const msg =
        err instanceof Error && err.message
          ? err.message
          : 'Skill-Flix AI could not respond right now. Please try again.';

      setErrorBanner({ code, message: msg });
      setLastFailedPrompt(cleanPrompt);
    } finally {
      if (requestSeqRef.current === seq) {
        activeControllerRef.current = null;
        inFlightRef.current = false;
        setIsSending(false);
      }
    }
  };

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void submitPrompt(input);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submitPrompt(input);
    }
  };

  const showSuggestions = messages.length <= 1 && !isSending;
  const statusLabel = statusInfo
    ? statusInfo.online
      ? 'Online • Free Tier'
      : 'Online when available'
    : 'Online when available';

  return (
    <>
      {/* Floating Skill-Flix AI Launcher Button (Exact bottom-left position of previous button) */}
      <button
        type="button"
        onClick={() => setIsOpen(prev => !prev)}
        aria-label="Open Skill-Flix AI Learning Assistant"
        className="fixed bottom-20 sm:bottom-6 left-4 sm:left-6 z-40 group flex items-center gap-2 px-3.5 py-2.5 rounded-full bg-gradient-to-r from-purple-600 via-blue-600 to-cyan-500 hover:from-purple-500 hover:via-blue-500 hover:to-cyan-400 text-white font-bold text-xs shadow-[0_0_24px_rgba(139,92,246,0.55),0_0_40px_rgba(6,182,212,0.3)] border border-cyan-300/40 transition-all duration-200 hover:scale-105 active:scale-95 cursor-pointer"
        title="Skill-Flix AI — Your Personal Learning Assistant"
      >
        <span className="relative flex items-center justify-center">
          <Bot className="w-4 h-4 text-white" />
          <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-cyan-300 animate-pulse" />
        </span>
        <span className="hidden md:inline tracking-tight">Skill-Flix AI</span>
      </button>

      {/* Skill-Flix AI Chat Modal Window */}
      {isOpen && (
        <div
          className="fixed inset-x-2.5 bottom-20 sm:inset-x-auto sm:bottom-20 sm:left-6 z-50 w-auto sm:w-[410px] max-w-[calc(100vw-1.25rem)] h-[74dvh] sm:h-[580px] max-h-[calc(100dvh-9rem)] flex flex-col rounded-2xl bg-[#070B16]/95 backdrop-blur-xl border border-purple-500/35 shadow-[0_12px_48px_rgba(15,23,42,0.9),0_0_32px_rgba(139,92,246,0.28)] overflow-hidden text-slate-100 animate-in fade-in slide-in-from-bottom-4 duration-200"
          role="dialog"
          aria-label="Skill-Flix AI Chat"
        >
          {/* Header */}
          <div className="px-4 py-3 border-b border-white/[0.08] bg-gradient-to-r from-purple-950/70 via-[#0A1024] to-cyan-950/50 flex items-center justify-between gap-2 shrink-0">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-purple-600 via-blue-600 to-cyan-500 flex items-center justify-center shadow-[0_0_16px_rgba(6,182,212,0.45)] shrink-0">
                <Bot className="w-5 h-5 text-white" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <h3 className="text-sm font-extrabold text-white tracking-tight truncate">
                    Skill-Flix AI
                  </h3>
                  <Sparkles className="w-3.5 h-3.5 text-cyan-300 shrink-0" />
                </div>
                <p className="text-[11px] text-slate-300 truncate">
                  Your Personal Learning Assistant
                </p>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      statusInfo?.online ? 'bg-emerald-400 animate-pulse' : 'bg-cyan-400/70'
                    }`}
                  />
                  <span className="text-[10px] font-medium text-cyan-300/90">
                    {statusLabel}
                  </span>
                  {quota && (
                    <span className="text-[10px] text-slate-400 font-mono">
                      • {quota.dailyRemaining}/{quota.dailyLimit} today
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                onClick={handleClearChat}
                className="p-1.5 rounded-xl text-slate-400 hover:text-white hover:bg-white/[0.08] transition-colors cursor-pointer"
                title={isSending ? 'Cancel & clear chat' : 'Clear chat'}
                aria-label="Clear chat"
              >
                <Trash2 className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="p-1.5 rounded-xl text-slate-400 hover:text-white hover:bg-white/[0.08] transition-colors cursor-pointer"
                title="Close Skill-Flix AI"
                aria-label="Close Skill-Flix AI"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Messages Scroll Body */}
          <div className="flex-1 overflow-y-auto px-3.5 py-3.5 space-y-3 overscroll-contain">
            {messages.map(msg => {
              const isUser = msg.role === 'user';
              return (
                <div
                  key={msg.id}
                  className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}
                >
                  <div
                    className={`max-w-[88%] rounded-2xl px-3.5 py-2.5 shadow-sm ${
                      isUser
                        ? 'bg-gradient-to-br from-purple-600 via-blue-600 to-cyan-600 text-white rounded-br-sm'
                        : 'bg-[#0F172A] border border-blue-500/20 text-slate-100 rounded-bl-sm'
                    }`}
                  >
                    {isUser ? (
                      <p className="text-[13px] leading-relaxed whitespace-pre-wrap break-words">
                        {msg.text}
                      </p>
                    ) : (
                      <FormattedAiText text={msg.text} />
                    )}

                    {!isUser && msg.id !== 'skillflix_welcome' && (
                      <div className="mt-2 pt-1.5 border-t border-white/[0.06] flex items-center justify-between gap-2">
                        <span className="text-[10px] text-slate-400 truncate">
                          {msg.referencedCourses && msg.referencedCourses.length > 0
                            ? `Skill-Flix: ${msg.referencedCourses.slice(0, 2).join(', ')}`
                            : 'Skill-Flix AI Tutor'}
                        </span>
                        <button
                          type="button"
                          onClick={() => handleCopy(msg.id, msg.text)}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-white/[0.05] hover:bg-white/[0.12] text-[10px] font-semibold text-cyan-300 transition-colors cursor-pointer shrink-0"
                        >
                          {copiedId === msg.id ? (
                            <>
                              <Check className="w-3 h-3 text-emerald-400" />
                              <span>Copied</span>
                            </>
                          ) : (
                            <>
                              <Copy className="w-3 h-3" />
                              <span>Copy</span>
                            </>
                          )}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}

            {/* Suggested Questions */}
            {showSuggestions && (
              <div className="pt-1 space-y-1.5">
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 px-1 block">
                  Try asking in Hindi, Hinglish or English
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {SUGGESTED_QUESTIONS.map(q => (
                    <button
                      key={q}
                      type="button"
                      onClick={() => void submitPrompt(q)}
                      className="text-left px-3 py-1.5 rounded-xl bg-[#0D1426] hover:bg-blue-950/60 border border-cyan-500/25 hover:border-cyan-400/50 text-[11px] font-medium text-cyan-200 transition-all cursor-pointer"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Typing Indicator */}
            {isSending && (
              <div className="flex items-start">
                <div className="px-3.5 py-2.5 rounded-2xl rounded-bl-sm bg-[#0F172A] border border-purple-500/25 flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-purple-400 animate-bounce [animation-delay:0ms]" />
                  <span className="w-2 h-2 rounded-full bg-blue-400 animate-bounce [animation-delay:150ms]" />
                  <span className="w-2 h-2 rounded-full bg-cyan-400 animate-bounce [animation-delay:300ms]" />
                  <span className="text-[11px] text-slate-400 ml-1">Thinking...</span>
                </div>
              </div>
            )}

            {/* Sign-in Prompt for Guests or Error / Quota Banner */}
            {(!currentUser?.uid || errorBanner) && (
              <div className="p-3 rounded-xl bg-[#0D1322] border border-amber-500/25 space-y-2">
                <div className="flex items-start gap-2 text-xs">
                  {!currentUser?.uid ? (
                    <Lock className="w-4 h-4 text-cyan-400 shrink-0 mt-0.5" />
                  ) : (
                    <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                  )}
                  <p className="text-[11px] text-slate-200 leading-relaxed">
                    {errorBanner
                      ? errorBanner.message
                      : 'Sign in with your Skill-Flix account so Skill-Flix AI can tailor recommendations and guide you to your unlocked courses & PDFs.'}
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  {(!currentUser?.uid || errorBanner?.code === 'AUTH_REQUIRED') && (
                    <button
                      type="button"
                      onClick={() => {
                        setIsOpen(false);
                        onOpenAuth();
                      }}
                      className="px-3 py-1.5 rounded-lg bg-gradient-to-r from-purple-600 to-cyan-500 text-white text-[11px] font-bold cursor-pointer"
                    >
                      Sign In to Continue
                    </button>
                  )}
                  {lastFailedPrompt && currentUser?.uid && errorBanner?.code !== 'USER_DAILY_LIMIT' && (
                    <button
                      type="button"
                      onClick={() => void submitPrompt(lastFailedPrompt)}
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-cyan-300 text-[11px] font-semibold cursor-pointer"
                    >
                      <RefreshCw className="w-3 h-3" />
                      <span>Retry</span>
                    </button>
                  )}
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Input Bar */}
          <form
            onSubmit={handleFormSubmit}
            className="p-2.5 border-t border-white/[0.08] bg-[#050811] flex items-end gap-2 shrink-0"
          >
            <textarea
              ref={textareaRef}
              rows={1}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isSending}
              placeholder={
                currentUser?.uid
                  ? 'Ask in Hindi, Hinglish or English...'
                  : 'Sign in to ask Skill-Flix AI...'
              }
              className="flex-1 resize-none max-h-24 px-3 py-2 rounded-xl bg-[#0C1222] border border-blue-500/25 focus:border-cyan-400 text-xs text-white placeholder-slate-500 outline-none leading-relaxed"
            />
            <button
              type="submit"
              disabled={isSending || !input.trim()}
              aria-label="Send message"
              className="p-2.5 rounded-xl bg-gradient-to-r from-purple-600 via-blue-600 to-cyan-500 hover:from-purple-500 hover:to-cyan-400 disabled:opacity-40 text-white shadow-md shadow-blue-600/30 transition-all cursor-pointer shrink-0"
            >
              <Send className="w-4 h-4" />
            </button>
          </form>
        </div>
      )}
    </>
  );
};
