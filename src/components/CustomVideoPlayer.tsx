import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Play,
  Pause,
  Volume1,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  RotateCcw,
  RotateCw,
  SkipBack,
  SkipForward,
  Lock,
  Unlock,
  Settings,
  Subtitles,
  PictureInPicture,
  Loader2,
  AlertTriangle,
  Check,
  HelpCircle,
  X,
  ChevronRight,
  Tv
} from 'lucide-react';

export type PlayerKind = 'video' | 'youtube' | 'vimeo';

export interface CustomVideoPlayerProps {
  kind: PlayerKind;
  /** direct file URL for 'video'; provider video id for 'youtube' / 'vimeo' */
  src: string;
  /** optional Vimeo privacy hash */
  vimeoHash?: string;
  title: string;
  /** plain embed URL used if a provider API cannot be loaded */
  fallbackSrc?: string;
  lessonId?: string;
  episode?: string;
  categoryName?: string;
  durationStr?: string;
  thumbnailUrl?: string;
  onNext?: () => void;
  onPrev?: () => void;
  hasNext?: boolean;
  hasPrev?: boolean;
  nextLessonTitle?: string;
  prevLessonTitle?: string;
  onClose?: () => void;
  onComplete?: () => void;
}

interface Controller {
  play: () => void;
  pause: () => void;
  seek: (t: number) => void;
  setVolume: (v: number) => void;
  setMuted: (m: boolean) => void;
  setRate: (r: number) => Promise<boolean>;
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

const formatTime = (s: number) => {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/* ------------------------------------------------------------------ */
/* Provider SDK loaders (official scripts, loaded once)                */
/* ------------------------------------------------------------------ */

let ytPromise: Promise<any> | null = null;
const loadYouTubeApi = (): Promise<any> => {
  const w = window as any;
  if (w.YT && w.YT.Player) return Promise.resolve(w.YT);
  if (ytPromise) return ytPromise;
  ytPromise = new Promise((resolve, reject) => {
    const prev = w.onYouTubeIframeAPIReady;
    const timer = window.setTimeout(() => {
      ytPromise = null;
      reject(new Error('YouTube API timeout'));
    }, 10000);
    w.onYouTubeIframeAPIReady = () => {
      window.clearTimeout(timer);
      if (typeof prev === 'function') prev();
      resolve(w.YT);
    };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.async = true;
    s.onerror = () => {
      window.clearTimeout(timer);
      ytPromise = null;
      reject(new Error('YouTube API failed to load'));
    };
    document.head.appendChild(s);
  });
  return ytPromise;
};

let vimeoPromise: Promise<any> | null = null;
const loadVimeoApi = (): Promise<any> => {
  const w = window as any;
  if (w.Vimeo && w.Vimeo.Player) return Promise.resolve(w.Vimeo);
  if (vimeoPromise) return vimeoPromise;
  vimeoPromise = new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      vimeoPromise = null;
      reject(new Error('Vimeo SDK timeout'));
    }, 10000);
    const s = document.createElement('script');
    s.src = 'https://player.vimeo.com/api/player.js';
    s.async = true;
    s.onload = () => {
      window.clearTimeout(timer);
      if (w.Vimeo && w.Vimeo.Player) resolve(w.Vimeo);
      else {
        vimeoPromise = null;
        reject(new Error('Vimeo SDK missing'));
      }
    };
    s.onerror = () => {
      window.clearTimeout(timer);
      vimeoPromise = null;
      reject(new Error('Vimeo SDK failed to load'));
    };
    document.head.appendChild(s);
  });
  return vimeoPromise;
};

/* ------------------------------------------------------------------ */
/* Interactive Timeline / Slider with Hover Preview                   */
/* ------------------------------------------------------------------ */

interface SliderProps {
  value: number;
  max: number;
  buffered?: number;
  step?: number;
  ariaLabel: string;
  valueText?: string;
  onChange: (v: number) => void;
  onCommit?: (v: number) => void;
  onScrubStart?: () => void;
  className?: string;
}

const Slider: React.FC<SliderProps> = ({
  value,
  max,
  buffered = 0,
  step = 1,
  ariaLabel,
  valueText,
  onChange,
  onCommit,
  onScrubStart,
  className = ''
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [isDragging, setIsDragging] = useState(false);
  const [hoverInfo, setHoverInfo] = useState<{ pos: number; time: number } | null>(null);

  const pct = max > 0 ? clamp((value / max) * 100, 0, 100) : 0;

  const calc = (clientX: number) => {
    const el = ref.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    if (r.width <= 0) return 0;
    return clamp((clientX - r.left) / r.width, 0, 1) * max;
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (dragging.current) {
      onChange(calc(e.clientX));
    }
    const el = ref.current;
    if (el && max > 0) {
      const r = el.getBoundingClientRect();
      const relativeX = clamp((e.clientX - r.left) / r.width, 0, 1);
      setHoverInfo({
        pos: relativeX * 100,
        time: relativeX * max
      });
    }
  };

  return (
    <div
      ref={ref}
      role="slider"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={Math.round(max)}
      aria-valuenow={Math.round(value)}
      aria-valuetext={valueText}
      className={`group/slider relative flex h-8 sm:h-7 w-full items-center touch-none cursor-pointer select-none outline-none ${className}`}
      onPointerDown={(e) => {
        if (max <= 0) return;
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        dragging.current = true;
        setIsDragging(true);
        onScrubStart?.();
        onChange(calc(e.clientX));
      }}
      onPointerMove={handlePointerMove}
      onPointerLeave={() => {
        if (!dragging.current) setHoverInfo(null);
      }}
      onPointerUp={(e) => {
        if (!dragging.current) return;
        e.stopPropagation();
        dragging.current = false;
        setIsDragging(false);
        setHoverInfo(null);
        onCommit?.(calc(e.clientX));
      }}
      onPointerCancel={() => {
        if (!dragging.current) return;
        dragging.current = false;
        setIsDragging(false);
        setHoverInfo(null);
        onCommit?.(value);
      }}
      onKeyDown={(e) => {
        let next: number | null = null;
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = clamp(value + step, 0, max);
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = clamp(value - step, 0, max);
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = max;
        if (next === null) return;
        e.preventDefault();
        e.stopPropagation();
        onChange(next);
        onCommit?.(next);
      }}
    >
      {/* Floating Hover Time Tooltip */}
      {hoverInfo && max > 0 && (
        <div
          className="pointer-events-none absolute -top-8 -translate-x-1/2 rounded-md bg-[#05070D]/95 px-2 py-0.5 text-[11px] font-bold tabular-nums text-white shadow-xl border border-white/15 backdrop-blur-md transition-opacity duration-150 z-30"
          style={{ left: `${hoverInfo.pos}%` }}
        >
          {formatTime(hoverInfo.time)}
        </div>
      )}

      {/* Track Background */}
      <div
        className={`relative w-full rounded-full bg-white/20 transition-all duration-200 ${
          isDragging ? 'h-2' : 'h-1.5 group-hover/slider:h-2 group-focus-visible/slider:h-2'
        }`}
      >
        {/* Buffered Progress */}
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-white/30 transition-[width] duration-300"
          style={{ width: `${clamp(buffered, 0, 1) * 100}%` }}
        />

        {/* Played Progress with Gradient & Glow */}
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-blue-600 via-blue-400 to-cyan-400 shadow-[0_0_12px_rgba(59,130,246,0.6)]"
          style={{ width: `${pct}%` }}
        />

        {/* Scrubber Handle Thumb */}
        <div
          className={`absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_0_10px_rgba(6,182,212,0.8)] border border-blue-400 transition-transform duration-150 [@media(hover:none)]:scale-100 ${
            isDragging
              ? 'scale-125 ring-4 ring-blue-500/40'
              : 'scale-0 group-hover/slider:scale-100 group-focus-visible/slider:scale-100'
          }`}
          style={{ left: `${pct}%` }}
        >
          <div className="absolute inset-1 rounded-full bg-blue-500" />
        </div>
      </div>
    </div>
  );
};

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  active?: boolean;
}

const IconButton: React.FC<IconButtonProps> = ({
  label,
  active = false,
  className = '',
  children,
  ...rest
}) => (
  <button
    type="button"
    aria-label={label}
    title={label}
    className={`relative grid h-11 w-11 sm:h-9 sm:w-9 shrink-0 place-items-center rounded-full transition-all duration-200 active:scale-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ${
      active
        ? 'bg-blue-600/30 text-blue-400 border border-blue-500/40'
        : 'text-white/90 hover:bg-white/10 hover:text-white'
    } ${className}`}
    {...rest}
  >
    {children}
  </button>
);

/* ------------------------------------------------------------------ */
/* Main OTT Video Player Component                                    */
/* ------------------------------------------------------------------ */

export const CustomVideoPlayer: React.FC<CustomVideoPlayerProps> = ({
  kind,
  src,
  vimeoHash,
  title,
  fallbackSrc,
  lessonId,
  episode,
  categoryName,
  onNext,
  onPrev,
  hasNext = false,
  hasPrev = false,
  nextLessonTitle,
  prevLessonTitle,
  onClose,
  onComplete
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const ctlRef = useRef<Controller | null>(null);
  const activityTimer = useRef<number | undefined>(undefined);
  const pointerType = useRef('mouse');
  const scrubbingRef = useRef(false);

  // Gesture tracking refs
  const lastTapRef = useRef<{ time: number; x: number; side: 'left' | 'right' }>({ time: 0, x: 0, side: 'right' });
  const accumulatedSeekRef = useRef<number>(0);
  const singleTapTimerRef = useRef<number | undefined>(undefined);
  const seekFeedbackTimerRef = useRef<number | undefined>(undefined);

  // Playback state
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(kind !== 'video');
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [bufferedFrac, setBufferedFrac] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [rates, setRates] = useState<number[]>(SPEEDS);
  const [rateNote, setRateNote] = useState('');
  const [ended, setEnded] = useState(false);
  const [error, setError] = useState('');
  const [apiFailed, setApiFailed] = useState(false);
  const [scrubTime, setScrubTime] = useState<number | null>(null);
  const [activity, setActivity] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showRemainingTime, setShowRemainingTime] = useState(false);

  // OTT Features state
  const [isLocked, setIsLocked] = useState(false);
  const [showLockHint, setShowLockHint] = useState(false);
  const [seekFeedback, setSeekFeedback] = useState<{
    side: 'left' | 'right';
    seconds: number;
    animKey: number;
  } | null>(null);
  const [resumedFrom, setResumedFrom] = useState<number | null>(null);
  const [showResumeNotice, setShowResumeNotice] = useState(false);
  const [nextCountdown, setNextCountdown] = useState<number | null>(null);
  const [activeMenu, setActiveMenu] = useState<'none' | 'speed' | 'quality' | 'shortcuts'>('none');
  const [isPiPActive, setIsPiPActive] = useState(false);
  const [captionsActive, setCaptionsActive] = useState(false);
  const [captionToast, setCaptionToast] = useState('');
  const [selectedQuality, setSelectedQuality] = useState('1080p HD');
  const [availableQualities, setAvailableQualities] = useState<string[]>(['1080p HD', '720p', '480p', 'Auto']);

  const overlay = kind === 'video';
  const savedPosKey = lessonId ? `skillflix_pos_${lessonId}` : null;

  // Check Volume Settable (iOS restricts volume via JS)
  const volumeSettable = useMemo(() => {
    try {
      const a = new Audio();
      a.volume = 0.5;
      return a.volume === 0.5;
    } catch {
      return true;
    }
  }, []);

  // Picture in Picture supported check
  const pipSupported = useMemo(() => {
    return (
      typeof document !== 'undefined' &&
      'pictureInPictureEnabled' in document &&
      kind === 'video'
    );
  }, [kind]);

  // Fullscreen support
  const fsSupported = useMemo(() => {
    const d = document as any;
    return !!(d.fullscreenEnabled || d.webkitFullscreenEnabled);
  }, []);
  const showFsButton = fsSupported || kind === 'video';

  /* ---------------- Activity / Auto-Hide Controls ------------------ */
  const showControls = useCallback(() => {
    if (isLocked) return;
    setActivity(true);
    window.clearTimeout(activityTimer.current);
    activityTimer.current = window.setTimeout(() => {
      setActivity(false);
    }, 2800);
  }, [isLocked]);

  useEffect(() => {
    showControls();
    return () => window.clearTimeout(activityTimer.current);
  }, [showControls]);

  /* ---------------- Fullscreen Event Listeners --------------------- */
  useEffect(() => {
    const onChange = () => {
      const d = document as any;
      const el = d.fullscreenElement || d.webkitFullscreenElement;
      setIsFullscreen(!!el && el === containerRef.current);
    };
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('webkitfullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('webkitfullscreenchange', onChange);
    };
  }, []);

  /* ---------------- Close Menus on Click Outside ------------------- */
  useEffect(() => {
    if (activeMenu === 'none') return;
    const onDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setActiveMenu('none');
      }
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [activeMenu]);

  /* ---------------- Save Playback Position (Resume Feature) -------- */
  useEffect(() => {
    if (!savedPosKey || !playing || current < 3) return;
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem(savedPosKey, Math.floor(current).toString());
      } catch {}
    }, 2500);
    return () => window.clearTimeout(timer);
  }, [current, playing, savedPosKey]);

  /* ---------------- Clear Saved Position When Lesson Completes ----- */
  useEffect(() => {
    if (ended && savedPosKey) {
      try {
        localStorage.removeItem(savedPosKey);
      } catch {}
      onComplete?.();
    }
  }, [ended, savedPosKey, onComplete]);

  /* ---------------- Native <video> Controller ---------------------- */
  useEffect(() => {
    if (kind !== 'video') return;
    const v = videoRef.current;
    if (!v) return;

    ctlRef.current = {
      play: () => {
        v.play().catch(() => {});
      },
      pause: () => v.pause(),
      seek: (t) => {
        v.currentTime = t;
      },
      setVolume: (x) => {
        v.volume = x;
        if (x > 0 && v.muted) v.muted = false;
      },
      setMuted: (m) => {
        v.muted = m;
      },
      setRate: async (r) => {
        v.playbackRate = r;
        return true;
      }
    };

    // PiP events
    const onEnterPiP = () => setIsPiPActive(true);
    const onLeavePiP = () => setIsPiPActive(false);
    v.addEventListener('enterpictureinpicture', onEnterPiP);
    v.addEventListener('leavepictureinpicture', onLeavePiP);

    return () => {
      v.removeEventListener('enterpictureinpicture', onEnterPiP);
      v.removeEventListener('leavepictureinpicture', onLeavePiP);
      ctlRef.current = null;
    };
  }, [kind, src]);

  const syncBuffered = () => {
    const v = videoRef.current;
    if (!v || !v.duration || !Number.isFinite(v.duration)) return;
    const t = v.currentTime;
    let end = 0;
    for (let i = 0; i < v.buffered.length; i++) {
      if (v.buffered.start(i) <= t + 0.5 && v.buffered.end(i) >= end) end = v.buffered.end(i);
    }
    setBufferedFrac(end / v.duration);
  };

  /* ---------------- Resume playback when metadata loads ------------ */
  const handleLoadedMetadata = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const dur = e.currentTarget.duration || 0;
    setDuration(dur);

    if (savedPosKey && dur > 15) {
      try {
        const saved = parseFloat(localStorage.getItem(savedPosKey) || '0');
        if (saved > 5 && saved < dur - 10) {
          e.currentTarget.currentTime = saved;
          setCurrent(saved);
          setResumedFrom(saved);
          setShowResumeNotice(true);
          window.setTimeout(() => setShowResumeNotice(false), 5500);
        }
      } catch {}
    }
  };

  /* ---------------- YouTube Controller (official IFrame API) ------- */
  useEffect(() => {
    if (kind !== 'youtube') return;
    let cancelled = false;
    let player: any = null;
    let poll: number | undefined;
    const host = hostRef.current;

    loadYouTubeApi()
      .then((YT) => {
        if (cancelled || !host) return;
        const mount = document.createElement('div');
        host.appendChild(mount);
        player = new YT.Player(mount, {
          videoId: src,
          width: '100%',
          height: '100%',
          playerVars: {
            autoplay: 1,
            controls: 0,
            rel: 0,
            modestbranding: 1,
            playsinline: 1,
            fs: 0,
            iv_load_policy: 3,
            disablekb: 1,
            origin: window.location.origin
          },
          events: {
            onReady: () => {
              if (cancelled) return;
              ctlRef.current = {
                play: () => player.playVideo(),
                pause: () => player.pauseVideo(),
                seek: (t) => player.seekTo(t, true),
                setVolume: (x) => {
                  player.setVolume(Math.round(x * 100));
                  if (x > 0 && player.isMuted()) player.unMute();
                },
                setMuted: (m) => (m ? player.mute() : player.unMute()),
                setRate: async (r) => {
                  player.setPlaybackRate(r);
                  return true;
                }
              };
              const reported: number[] = player.getAvailablePlaybackRates
                ? player.getAvailablePlaybackRates()
                : [1];
              const usable = SPEEDS.filter((s) => reported.includes(s));
              setRates(usable.length ? usable : [1]);
              setDuration(player.getDuration() || 0);
              setVolume((player.getVolume() ?? 100) / 100);
              setMuted(!!player.isMuted());
              setBuffering(false);

              // Check YouTube qualities
              if (player.getAvailableQualityLevels) {
                const qLevels = player.getAvailableQualityLevels();
                if (Array.isArray(qLevels) && qLevels.length > 0) {
                  setAvailableQualities(qLevels);
                }
              }

              // Check saved resume point
              if (savedPosKey) {
                try {
                  const saved = parseFloat(localStorage.getItem(savedPosKey) || '0');
                  if (saved > 5) {
                    player.seekTo(saved, true);
                    setCurrent(saved);
                    setResumedFrom(saved);
                    setShowResumeNotice(true);
                    window.setTimeout(() => setShowResumeNotice(false), 5500);
                  }
                } catch {}
              }

              player.playVideo();
              poll = window.setInterval(() => {
                try {
                  if (!scrubbingRef.current) setCurrent(player.getCurrentTime() || 0);
                  const d = player.getDuration() || 0;
                  if (d) setDuration(d);
                  setBufferedFrac(player.getVideoLoadedFraction() || 0);
                  setVolume((player.getVolume() ?? 100) / 100);
                  setMuted(!!player.isMuted());
                } catch {}
              }, 250);
            },
            onStateChange: (e: any) => {
              if (cancelled) return;
              const s = e.data;
              if (s === 1) {
                setPlaying(true);
                setBuffering(false);
                setEnded(false);
                const d = player.getDuration() || 0;
                if (d) setDuration(d);
              } else if (s === 2) {
                setPlaying(false);
              } else if (s === 3) {
                setBuffering(true);
              } else if (s === 0) {
                setPlaying(false);
                setEnded(true);
                setBuffering(false);
              }
            },
            onPlaybackRateChange: (e: any) => {
              if (!cancelled) setRate(e.data);
            },
            onError: () => {
              if (!cancelled) setError('This video could not be played. Check permissions or network.');
            }
          }
        });
      })
      .catch(() => {
        if (!cancelled) setApiFailed(true);
      });

    return () => {
      cancelled = true;
      window.clearInterval(poll);
      try {
        player?.destroy();
      } catch {}
      if (host) host.innerHTML = '';
      ctlRef.current = null;
    };
  }, [kind, src, savedPosKey]);

  /* ---------------- Vimeo Controller (official Player SDK) --------- */
  useEffect(() => {
    if (kind !== 'vimeo') return;
    let cancelled = false;
    let player: any = null;
    const host = hostRef.current;

    loadVimeoApi()
      .then((Vimeo) => {
        if (cancelled || !host) return;
        const iframe = document.createElement('iframe');
        const params = new URLSearchParams({
          autoplay: '1',
          controls: '0',
          playsinline: '1',
          title: '0',
          byline: '0',
          portrait: '0'
        });
        if (vimeoHash) params.set('h', vimeoHash);
        iframe.src = `https://player.vimeo.com/video/${src}?${params.toString()}`;
        iframe.title = title;
        iframe.allow = 'autoplay; fullscreen; picture-in-picture';
        iframe.allowFullscreen = true;
        iframe.style.cssText = 'width:100%;height:100%;border:0';
        host.appendChild(iframe);

        player = new Vimeo.Player(iframe);
        ctlRef.current = {
          play: () => {
            player.play().catch(() => {});
          },
          pause: () => {
            player.pause().catch(() => {});
          },
          seek: (t) => {
            player.setCurrentTime(t).catch(() => {});
          },
          setVolume: (x) => {
            player.setVolume(x).catch(() => {});
            if (x > 0) player.setMuted(false).catch(() => {});
          },
          setMuted: (m) => {
            player.setMuted(m).catch(() => {});
          },
          setRate: async (r) => {
            try {
              await player.setPlaybackRate(r);
              return true;
            } catch {
              return false;
            }
          }
        };

        player.on('loaded', () => {
          if (cancelled) return;
          setBuffering(false);
          player.getDuration().then((d: number) => !cancelled && setDuration(d)).catch(() => {});
          player.getVolume().then((v: number) => !cancelled && setVolume(v)).catch(() => {});
          player.getMuted().then((m: boolean) => !cancelled && setMuted(m)).catch(() => {});

          if (savedPosKey) {
            try {
              const saved = parseFloat(localStorage.getItem(savedPosKey) || '0');
              if (saved > 5) {
                player.setCurrentTime(saved).catch(() => {});
                setCurrent(saved);
                setResumedFrom(saved);
                setShowResumeNotice(true);
                window.setTimeout(() => setShowResumeNotice(false), 5500);
              }
            } catch {}
          }
        });
        player.on('play', () => {
          setPlaying(true);
          setEnded(false);
          setBuffering(false);
        });
        player.on('pause', () => setPlaying(false));
        player.on('ended', () => {
          setPlaying(false);
          setEnded(true);
        });
        player.on('timeupdate', (d: any) => {
          if (!scrubbingRef.current) setCurrent(d.seconds || 0);
          if (d.duration) setDuration(d.duration);
        });
        player.on('progress', (d: any) => setBufferedFrac(d.percent || 0));
        player.on('bufferstart', () => setBuffering(true));
        player.on('bufferend', () => setBuffering(false));
        player.on('volumechange', (d: any) => {
          setVolume(d.volume);
          player.getMuted().then((m: boolean) => !cancelled && setMuted(m)).catch(() => {});
        });
        player.on('playbackratechange', (d: any) => setRate(d.playbackRate));
        player.on('error', () => {
          if (!cancelled) setError('This video could not be played.');
        });
      })
      .catch(() => {
        if (!cancelled) setApiFailed(true);
      });

    return () => {
      cancelled = true;
      try {
        const p = player?.destroy();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch {}
      if (host) host.innerHTML = '';
      ctlRef.current = null;
    };
  }, [kind, src, vimeoHash, title, savedPosKey]);

  /* ---------------- Autoplay Next Episode Countdown ---------------- */
  useEffect(() => {
    if (!ended || !hasNext || !onNext) {
      setNextCountdown(null);
      return;
    }
    setNextCountdown(5);
    const interval = window.setInterval(() => {
      setNextCountdown((prev) => {
        if (prev === null || prev <= 1) {
          window.clearInterval(interval);
          onNext();
          return null;
        }
        return prev - 1;
      });
    }, 1000);

    return () => window.clearInterval(interval);
  }, [ended, hasNext, onNext]);

  /* ---------------- Actions & Methods ------------------------------ */
  const effectiveDuration = Number.isFinite(duration) ? duration : 0;

  const togglePlay = () => {
    if (isLocked) return;
    const c = ctlRef.current;
    if (!c) return;
    if (ended) {
      c.seek(0);
      setCurrent(0);
      setEnded(false);
      c.play();
      return;
    }
    if (playing) c.pause();
    else c.play();
    showControls();
  };

  const seekTo = (t: number) => {
    const c = ctlRef.current;
    if (!c) return;
    const target = clamp(t, 0, effectiveDuration || t);
    c.seek(target);
    setCurrent(target);
    setEnded(false);
  };

  const seekBy = (delta: number) => {
    seekTo(current + delta);
  };

  const toggleMute = () => {
    const c = ctlRef.current;
    if (!c) return;
    if (muted || volume === 0) {
      if (volume === 0) {
        c.setVolume(0.5);
        setVolume(0.5);
      }
      c.setMuted(false);
      setMuted(false);
    } else {
      c.setMuted(true);
      setMuted(true);
    }
  };

  const changeVolume = (raw: number) => {
    const c = ctlRef.current;
    if (!c) return;
    const v = raw < 0.03 ? 0 : raw;
    c.setVolume(v);
    setVolume(v);
    setMuted(false);
    if (v === 0) c.setMuted(true);
  };

  const chooseRate = async (r: number) => {
    const c = ctlRef.current;
    if (!c) return;
    const ok = await c.setRate(r);
    if (ok) {
      setRate(r);
      setRateNote('');
      setActiveMenu('none');
    } else {
      setRateNote('Speed change not supported on this stream');
    }
  };

  const toggleFullscreen = async () => {
    const el = containerRef.current as any;
    const d = document as any;

    if (d.fullscreenElement || d.webkitFullscreenElement) {
      if (d.exitFullscreen) await d.exitFullscreen().catch(() => {});
      else if (d.webkitExitFullscreen) d.webkitExitFullscreen();

      try {
        if (screen.orientation && (screen.orientation as any).unlock) {
          (screen.orientation as any).unlock();
        }
      } catch {}
      return;
    }

    try {
      if (el?.requestFullscreen) {
        await el.requestFullscreen();
      } else if (el?.webkitRequestFullscreen) {
        el.webkitRequestFullscreen();
      } else if (kind === 'video' && videoRef.current && (videoRef.current as any).webkitEnterFullscreen) {
        (videoRef.current as any).webkitEnterFullscreen();
      }

      // Orientation lock on supported mobile browsers
      if (screen.orientation && (screen.orientation as any).lock) {
        try {
          await (screen.orientation as any).lock('landscape').catch(() => {});
        } catch {}
      }
    } catch (e) {
      console.warn('Fullscreen request failed:', e);
    }
  };

  const togglePiP = async () => {
    if (!videoRef.current || !pipSupported) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        await videoRef.current.requestPictureInPicture();
      }
    } catch (e) {
      console.warn('Picture in Picture error:', e);
    }
  };

  const toggleCaptions = () => {
    const v = videoRef.current;
    if (!v) return;

    const tracks = v.textTracks;
    if (!tracks || tracks.length === 0) {
      setCaptionToast('No subtitles available for this lesson');
      window.setTimeout(() => setCaptionToast(''), 3000);
      return;
    }

    const next = !captionsActive;
    setCaptionsActive(next);
    for (let i = 0; i < tracks.length; i++) {
      tracks[i].mode = next ? 'showing' : 'hidden';
    }
  };

  const handleRetryPlayback = () => {
    setError('');
    setBuffering(true);
    if (kind === 'video' && videoRef.current) {
      const v = videoRef.current;
      v.load();
      v.play().catch(() => {});
    }
  };

  /* ---------------- Double Tap Seek Gesture Handler ----------------- */
  const handleVideoAreaClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (isLocked) {
      setShowLockHint(true);
      window.clearTimeout(activityTimer.current);
      activityTimer.current = window.setTimeout(() => setShowLockHint(false), 2500);
      return;
    }

    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const width = rect.width;
    const side: 'left' | 'right' = clickX < width / 2 ? 'left' : 'right';
    const now = Date.now();
    const timeSinceLastTap = now - lastTapRef.current.time;

    // Check if double tap or repeated multi-tap (within 400ms on same side)
    if (timeSinceLastTap < 400 && lastTapRef.current.side === side) {
      if (singleTapTimerRef.current) {
        window.clearTimeout(singleTapTimerRef.current);
        singleTapTimerRef.current = undefined;
      }

      // Increment accumulated seek by 10s
      const delta = side === 'right' ? 10 : -10;
      accumulatedSeekRef.current += delta;
      const totalSeconds = Math.abs(accumulatedSeekRef.current);

      seekBy(delta);

      // Tactile mobile haptic feedback
      if (navigator.vibrate) {
        try {
          navigator.vibrate(20);
        } catch {}
      }

      setSeekFeedback({
        side,
        seconds: totalSeconds,
        animKey: now
      });

      if (seekFeedbackTimerRef.current) {
        window.clearTimeout(seekFeedbackTimerRef.current);
      }
      seekFeedbackTimerRef.current = window.setTimeout(() => {
        setSeekFeedback(null);
        accumulatedSeekRef.current = 0;
      }, 750);

      lastTapRef.current = { time: now, x: clickX, side };
    } else {
      // Single tap candidate
      lastTapRef.current = { time: now, x: clickX, side };
      accumulatedSeekRef.current = 0;

      if (singleTapTimerRef.current) {
        window.clearTimeout(singleTapTimerRef.current);
      }

      singleTapTimerRef.current = window.setTimeout(() => {
        singleTapTimerRef.current = undefined;
        // Toggle controls visibility
        if (!activity) {
          showControls();
        } else {
          togglePlay();
        }
      }, 260);
    }
  };

  /* ---------------- Keyboard Shortcuts ----------------------------- */
  const onKeyDown = (e: React.KeyboardEvent) => {
    const onControl = !!(e.target as HTMLElement).closest('button, [role="slider"], input');
    if (isLocked) {
      if (e.key === 'Escape') setIsLocked(false);
      return;
    }

    switch (e.key) {
      case ' ':
      case 'k':
      case 'K':
        if (onControl && e.key === ' ') return;
        e.preventDefault();
        togglePlay();
        break;
      case 'ArrowLeft':
      case 'j':
      case 'J':
        if (onControl && (e.target as HTMLElement).getAttribute('role') === 'slider') return;
        e.preventDefault();
        seekBy(-10);
        setSeekFeedback({ side: 'left', seconds: 10, animKey: Date.now() });
        window.setTimeout(() => setSeekFeedback(null), 600);
        break;
      case 'ArrowRight':
      case 'l':
      case 'L':
        if (onControl && (e.target as HTMLElement).getAttribute('role') === 'slider') return;
        e.preventDefault();
        seekBy(10);
        setSeekFeedback({ side: 'right', seconds: 10, animKey: Date.now() });
        window.setTimeout(() => setSeekFeedback(null), 600);
        break;
      case 'ArrowUp':
        if (onControl && (e.target as HTMLElement).getAttribute('role') === 'slider') return;
        if (!volumeSettable) return;
        e.preventDefault();
        changeVolume(clamp(volume + 0.1, 0, 1));
        break;
      case 'ArrowDown':
        if (onControl && (e.target as HTMLElement).getAttribute('role') === 'slider') return;
        if (!volumeSettable) return;
        e.preventDefault();
        changeVolume(clamp(volume - 0.1, 0, 1));
        break;
      case 'm':
      case 'M':
        e.preventDefault();
        toggleMute();
        break;
      case 'f':
      case 'F':
        if (!showFsButton) return;
        e.preventDefault();
        toggleFullscreen();
        break;
      case 'p':
      case 'P':
        if (pipSupported) {
          e.preventDefault();
          togglePiP();
        }
        break;
      case 'c':
      case 'C':
        e.preventDefault();
        toggleCaptions();
        break;
      case 'n':
      case 'N':
        if (hasNext && onNext) {
          e.preventDefault();
          onNext();
        }
        break;
      case '0':
      case '1':
      case '2':
      case '3':
      case '4':
      case '5':
      case '6':
      case '7':
      case '8':
      case '9':
        if (!onControl && effectiveDuration > 0) {
          e.preventDefault();
          const target = (parseInt(e.key, 10) / 10) * effectiveDuration;
          seekTo(target);
        }
        break;
      case '?':
        e.preventDefault();
        setActiveMenu((prev) => (prev === 'shortcuts' ? 'none' : 'shortcuts'));
        break;
      default:
        return;
    }
    showControls();
  };

  /* ---------------- Fallback: Plain Provider Embed ----------------- */
  if (apiFailed && fallbackSrc) {
    return (
      <div className="relative aspect-video w-full bg-black">
        <iframe
          src={fallbackSrc}
          title={title}
          className="h-full w-full border-0"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen"
          allowFullScreen
        />
      </div>
    );
  }

  /* ---------------- View State Derivations ------------------------- */
  const shownTime = scrubTime ?? current;
  const remainingTime = Math.max(0, effectiveDuration - shownTime);
  const controlsVisible =
    !isLocked &&
    (!overlay || !playing || activity || activeMenu !== 'none' || scrubTime !== null || ended);
  const VolIcon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;
  const speedChoices = rates;

  /* ---------------- Main Control Bar ------------------------------- */
  const controlBar = (
    <div
      className={
        overlay
          ? `absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/95 via-black/80 to-transparent pt-12 pb-2 px-3 sm:px-6 transition-all duration-300 ${
              controlsVisible ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-3 opacity-0'
            }`
          : 'relative z-20 border-t border-white/[0.08] bg-gradient-to-b from-[#0B1220] to-[#05070D] px-3 sm:px-6 py-2'
      }
      onPointerDown={(e) => {
        e.stopPropagation();
        overlay && showControls();
      }}
    >
      {/* Interactive Timeline & Seekbar */}
      <div className="w-full mb-1">
        <Slider
          ariaLabel="Video timeline scrub"
          value={shownTime}
          max={effectiveDuration}
          buffered={bufferedFrac}
          step={5}
          valueText={`${formatTime(shownTime)} of ${formatTime(effectiveDuration)}`}
          onScrubStart={() => {
            scrubbingRef.current = true;
          }}
          onChange={(t) => {
            scrubbingRef.current = true;
            setScrubTime(t);
          }}
          onCommit={(t) => {
            scrubbingRef.current = false;
            setScrubTime(null);
            seekTo(t);
          }}
        />
      </div>

      {/* Control Buttons Bar */}
      <div className="flex items-center justify-between gap-1 sm:gap-2">
        {/* Left Side: Playback, Next/Prev, Volume, Time */}
        <div className="flex items-center gap-0.5 sm:gap-1.5 min-w-0">
          {/* Previous Episode */}
          <IconButton
            label={hasPrev ? `Previous Episode: ${prevLessonTitle || ''}` : 'No previous episode'}
            disabled={!hasPrev}
            onClick={onPrev}
            className={!hasPrev ? 'opacity-30 cursor-not-allowed' : ''}
          >
            <SkipBack className="h-4 w-4 sm:h-5 sm:w-5" />
          </IconButton>

          {/* Quick Seek -10s */}
          <IconButton label="Seek backward 10 seconds" onClick={() => seekBy(-10)}>
            <div className="relative">
              <RotateCcw className="h-4 w-4 sm:h-5 sm:w-5" />
              <span className="absolute inset-0 flex items-center justify-center text-[8px] font-extrabold tabular-nums">
                10
              </span>
            </div>
          </IconButton>

          {/* Primary Play / Pause / Replay Button */}
          <IconButton
            label={ended ? 'Replay lesson' : playing ? 'Pause' : 'Play'}
            onClick={togglePlay}
            className="bg-blue-600/30 hover:bg-blue-600/50 text-white border border-blue-500/40 shadow-[0_0_15px_rgba(59,130,246,0.4)]"
          >
            {ended ? (
              <RotateCcw className="h-5 w-5" />
            ) : playing ? (
              <Pause className="h-5 w-5 fill-current" />
            ) : (
              <Play className="h-5 w-5 fill-current ml-0.5" />
            )}
          </IconButton>

          {/* Quick Seek +10s */}
          <IconButton label="Seek forward 10 seconds" onClick={() => seekBy(10)}>
            <div className="relative">
              <RotateCw className="h-4 w-4 sm:h-5 sm:w-5" />
              <span className="absolute inset-0 flex items-center justify-center text-[8px] font-extrabold tabular-nums">
                10
              </span>
            </div>
          </IconButton>

          {/* Next Episode */}
          <IconButton
            label={hasNext ? `Next Episode: ${nextLessonTitle || ''}` : 'No next episode'}
            disabled={!hasNext}
            onClick={onNext}
            className={!hasNext ? 'opacity-30 cursor-not-allowed' : ''}
          >
            <SkipForward className="h-4 w-4 sm:h-5 sm:w-5" />
          </IconButton>

          {/* Volume Control */}
          <div className="group/vol flex items-center">
            <IconButton label={muted || volume === 0 ? 'Unmute' : 'Mute'} onClick={toggleMute}>
              <VolIcon className="h-4 w-4 sm:h-5 sm:w-5" />
            </IconButton>
            {volumeSettable && (
              <div className="hidden sm:block w-0 overflow-hidden transition-all duration-300 group-hover/vol:w-20 group-focus-within/vol:w-20">
                <div className="w-20 px-2">
                  <Slider
                    ariaLabel="Volume slider"
                    value={muted ? 0 : volume}
                    max={1}
                    step={0.05}
                    valueText={`${Math.round((muted ? 0 : volume) * 100)}%`}
                    onChange={changeVolume}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Time Display (clickable to toggle remaining) */}
          <button
            type="button"
            onClick={() => setShowRemainingTime((r) => !r)}
            title="Click to toggle remaining time"
            className="ml-1 sm:ml-2 rounded px-1.5 py-0.5 text-[11px] sm:text-xs font-semibold tabular-nums text-white/80 hover:text-white hover:bg-white/10 transition-colors"
          >
            <span>{formatTime(shownTime)}</span>
            <span className="px-1 text-white/40">/</span>
            <span>{showRemainingTime ? `-${formatTime(remainingTime)}` : formatTime(effectiveDuration)}</span>
          </button>
        </div>

        {/* Right Side: Speed, Captions, PiP, Fullscreen, Settings */}
        <div className="flex items-center gap-0.5 sm:gap-1.5">
          {/* Subtitles / Captions Toggle */}
          {kind === 'video' && (
            <IconButton
              label={captionsActive ? 'Disable Subtitles' : 'Enable Subtitles'}
              active={captionsActive}
              onClick={toggleCaptions}
            >
              <Subtitles className="h-4 w-4 sm:h-5 sm:w-5" />
            </IconButton>
          )}

          {/* Picture in Picture */}
          {pipSupported && (
            <IconButton
              label={isPiPActive ? 'Exit Picture-in-Picture' : 'Picture-in-Picture'}
              active={isPiPActive}
              onClick={togglePiP}
            >
              <PictureInPicture className="h-4 w-4 sm:h-5 sm:w-5" />
            </IconButton>
          )}

          {/* Speed Selector Button */}
          {speedChoices.length > 1 && (
            <button
              type="button"
              aria-label="Playback speed"
              onClick={() => setActiveMenu((m) => (m === 'speed' ? 'none' : 'speed'))}
              className={`h-9 min-w-[40px] rounded-full px-2 text-[11px] sm:text-xs font-bold tabular-nums transition-all duration-200 hover:bg-white/10 active:scale-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ${
                activeMenu === 'speed' ? 'bg-blue-600/40 text-blue-400 border border-blue-500/30' : 'text-white/90'
              }`}
            >
              {rate}x
            </button>
          )}

          {/* Settings Menu Button */}
          <div ref={menuRef} className="relative">
            <IconButton
              label="Player Settings"
              active={activeMenu !== 'none'}
              onClick={() => setActiveMenu((m) => (m !== 'none' ? 'none' : 'speed'))}
            >
              <Settings className="h-4 w-4 sm:h-5 sm:w-5" />
            </IconButton>

            {/* Settings Flyout Modal */}
            {activeMenu !== 'none' && (
              <div
                role="menu"
                className="absolute bottom-full right-0 z-40 mb-3 w-56 rounded-2xl border border-white/10 bg-[#070B14]/95 p-3 shadow-2xl backdrop-blur-xl animate-in fade-in zoom-in-95 duration-150"
              >
                <div className="flex items-center justify-between border-b border-white/[0.08] pb-2 mb-2">
                  <span className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
                    <Settings className="h-3.5 w-3.5 text-blue-400" /> Settings
                  </span>
                  <button
                    type="button"
                    onClick={() => setActiveMenu('none')}
                    className="text-slate-400 hover:text-white p-0.5"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>

                {/* Speed Tab */}
                <div className="mb-3">
                  <span className="text-[11px] font-semibold text-slate-400 block mb-1.5">Playback Speed</span>
                  <div className="grid grid-cols-3 gap-1">
                    {speedChoices.map((r) => (
                      <button
                        key={r}
                        type="button"
                        onClick={() => chooseRate(r)}
                        className={`py-1.5 rounded-lg text-xs font-bold tabular-nums transition-colors ${
                          r === rate
                            ? 'bg-blue-600 text-white shadow-md shadow-blue-500/20'
                            : 'bg-white/5 text-slate-300 hover:bg-white/10 hover:text-white'
                        }`}
                      >
                        {r}x
                      </button>
                    ))}
                  </div>
                  {rateNote && <p className="mt-1 text-[10px] text-amber-300">{rateNote}</p>}
                </div>

                {/* Quality Indicator */}
                <div className="border-t border-white/[0.08] pt-2 mb-2">
                  <span className="text-[11px] font-semibold text-slate-400 block mb-1">Stream Quality</span>
                  <div className="flex items-center justify-between text-xs font-medium text-white px-2 py-1.5 rounded-lg bg-white/5">
                    <span className="flex items-center gap-1.5 text-blue-400">
                      <Tv className="h-3.5 w-3.5" /> {selectedQuality}
                    </span>
                    <span className="text-[10px] uppercase font-bold text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/20">
                      Optimal
                    </span>
                  </div>
                </div>

                {/* Shortcuts Helper */}
                <div className="border-t border-white/[0.08] pt-2">
                  <button
                    type="button"
                    onClick={() => setActiveMenu('shortcuts')}
                    className="w-full flex items-center justify-between text-xs text-slate-300 hover:text-white py-1.5 px-2 rounded-lg hover:bg-white/5 transition-colors"
                  >
                    <span className="flex items-center gap-1.5">
                      <HelpCircle className="h-3.5 w-3.5 text-cyan-400" /> Keyboard Shortcuts
                    </span>
                    <ChevronRight className="h-3.5 w-3.5 text-slate-500" />
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Fullscreen Toggle */}
          {showFsButton && (
            <IconButton
              label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
              onClick={toggleFullscreen}
            >
              {isFullscreen ? (
                <Minimize className="h-4 w-4 sm:h-5 sm:w-5" />
              ) : (
                <Maximize className="h-4 w-4 sm:h-5 sm:w-5" />
              )}
            </IconButton>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      role="region"
      aria-label={`${title} OTT video player`}
      onKeyDown={onKeyDown}
      onPointerMove={() => overlay && showControls()}
      className={`group/player relative flex w-full select-none flex-col bg-black outline-none overflow-hidden touch-manipulation ${
        isFullscreen ? 'fixed inset-0 z-[9999] h-full w-full' : ''
      }`}
    >
      {/* Scoped CSS animations for OTT gestures and ripples */}
      <style>{`
        @keyframes ott-ripple {
          0% { transform: scale(0.8); opacity: 0.8; }
          100% { transform: scale(1.6); opacity: 0; }
        }
        @keyframes ott-pulse-glow {
          0%, 100% { transform: scale(1); filter: drop-shadow(0 0 10px rgba(59,130,246,0.6)); }
          50% { transform: scale(1.06); filter: drop-shadow(0 0 20px rgba(6,182,212,0.9)); }
        }
        .ott-ripple-wave {
          animation: ott-ripple 0.65s ease-out forwards;
        }
        .ott-pulse {
          animation: ott-pulse-glow 2s ease-in-out infinite;
        }
      `}</style>

      {/* Main Video Area */}
      <div
        className={`relative overflow-hidden bg-black flex items-center justify-center ${
          isFullscreen ? 'h-full w-full' : 'aspect-video w-full'
        }`}
      >
        {/* Direct HTML5 Video Element */}
        {kind === 'video' ? (
          <>
            <video
              ref={videoRef}
              src={src}
              title={title}
              autoPlay
              playsInline
              preload="metadata"
              className="h-full w-full object-contain"
              onLoadedMetadata={handleLoadedMetadata}
              onDurationChange={(e) => setDuration(e.currentTarget.duration || 0)}
              onTimeUpdate={(e) => {
                if (!scrubbingRef.current) setCurrent(e.currentTarget.currentTime);
                syncBuffered();
              }}
              onProgress={syncBuffered}
              onPlay={() => {
                setPlaying(true);
                setEnded(false);
              }}
              onPause={() => setPlaying(false)}
              onPlaying={() => setBuffering(false)}
              onWaiting={() => setBuffering(true)}
              onCanPlay={() => setBuffering(false)}
              onVolumeChange={(e) => {
                setVolume(e.currentTarget.volume);
                setMuted(e.currentTarget.muted);
              }}
              onRateChange={(e) => setRate(e.currentTarget.playbackRate)}
              onEnded={() => {
                setPlaying(false);
                setEnded(true);
              }}
              onError={() => setError('Failed to load this lesson video. The file or stream may be temporarily unavailable.')}
            />

            {/* Gesture Overlay Area: Single Tap (controls/play) & Double Tap (seek -10s / +10s) */}
            <div
              className="absolute inset-0 z-10 cursor-pointer touch-manipulation"
              onPointerDown={(e) => {
                pointerType.current = e.pointerType;
              }}
              onClick={handleVideoAreaClick}
            />

            {/* Center Play / Pause Pulsing Indicator When Paused */}
            {!playing && !buffering && !error && !ended && (
              <div
                className="pointer-events-none absolute inset-0 z-10 grid place-items-center transition-all duration-300"
                aria-hidden="true"
              >
                <div className="relative grid h-16 w-16 sm:h-20 sm:w-20 place-items-center rounded-full border border-blue-400/30 bg-black/60 text-white shadow-2xl backdrop-blur-md ott-pulse">
                  <Play className="ml-1 h-7 w-7 sm:h-8 sm:w-8 fill-current text-blue-400" />
                </div>
              </div>
            )}
          </>
        ) : (
          /* YouTube / Vimeo Host */
          <div
            ref={hostRef}
            className="absolute inset-0 [&>div]:h-full [&>div]:w-full [&_iframe]:h-full [&_iframe]:w-full [&_iframe]:border-0"
          />
        )}

        {/* Double Tap Seek Feedback: Left Half (-10s, -20s...) */}
        {seekFeedback && seekFeedback.side === 'left' && (
          <div
            key={seekFeedback.animKey}
            className="pointer-events-none absolute inset-y-0 left-0 w-1/2 z-20 flex items-center justify-center bg-gradient-to-r from-blue-600/30 via-blue-500/10 to-transparent transition-opacity duration-300"
          >
            <div className="flex flex-col items-center">
              <div className="relative flex items-center justify-center h-20 w-20 rounded-full bg-blue-500/25 border border-blue-400/40 backdrop-blur-md">
                <span className="absolute inset-0 rounded-full border-2 border-blue-400/60 ott-ripple-wave" />
                <RotateCcw className="h-8 w-8 text-blue-300 animate-spin-reverse" />
              </div>
              <span className="mt-2 text-sm sm:text-base font-extrabold tracking-wide text-white drop-shadow-md tabular-nums">
                -{seekFeedback.seconds}s
              </span>
            </div>
          </div>
        )}

        {/* Double Tap Seek Feedback: Right Half (+10s, +20s...) */}
        {seekFeedback && seekFeedback.side === 'right' && (
          <div
            key={seekFeedback.animKey}
            className="pointer-events-none absolute inset-y-0 right-0 w-1/2 z-20 flex items-center justify-center bg-gradient-to-l from-cyan-600/30 via-cyan-500/10 to-transparent transition-opacity duration-300"
          >
            <div className="flex flex-col items-center">
              <div className="relative flex items-center justify-center h-20 w-20 rounded-full bg-cyan-500/25 border border-cyan-400/40 backdrop-blur-md">
                <span className="absolute inset-0 rounded-full border-2 border-cyan-400/60 ott-ripple-wave" />
                <RotateCw className="h-8 w-8 text-cyan-300 animate-spin" />
              </div>
              <span className="mt-2 text-sm sm:text-base font-extrabold tracking-wide text-white drop-shadow-md tabular-nums">
                +{seekFeedback.seconds}s
              </span>
            </div>
          </div>
        )}

        {/* Top Header Overlay (Title, Lock, Fullscreen Back) */}
        <div
          className={`absolute inset-x-0 top-0 z-20 flex items-center justify-between p-3 sm:p-5 bg-gradient-to-b from-black/90 via-black/50 to-transparent transition-all duration-300 ${
            controlsVisible ? 'translate-y-0 opacity-100' : 'pointer-events-none -translate-y-3 opacity-0'
          }`}
          onPointerDown={(e) => {
            e.stopPropagation();
            showControls();
          }}
        >
          {/* Left Title and Episode Badge */}
          <div className="flex items-center gap-2 sm:gap-3 truncate pr-4">
            {episode && (
              <span className="px-2 py-0.5 rounded text-[10px] font-extrabold uppercase tracking-wider bg-blue-500/20 text-blue-400 border border-blue-500/30">
                {episode}
              </span>
            )}
            <span className="text-xs sm:text-sm font-bold text-white truncate drop-shadow-md">
              {title}
            </span>
          </div>

          {/* Right Action Icons: Screen Lock, Close */}
          <div className="flex items-center gap-1 sm:gap-2 shrink-0">
            {/* Screen Lock Toggle Button */}
            <button
              type="button"
              onClick={() => {
                setIsLocked(true);
                setShowLockHint(true);
                window.setTimeout(() => setShowLockHint(false), 3000);
              }}
              title="Lock screen controls"
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-full text-xs font-semibold text-white/90 bg-white/10 hover:bg-white/20 border border-white/10 transition-colors"
            >
              <Lock className="h-3.5 w-3.5 text-blue-400" />
              <span className="hidden sm:inline">Lock</span>
            </button>

            {/* Exit Fullscreen or Close Modal Button */}
            {isFullscreen ? (
              <button
                type="button"
                onClick={toggleFullscreen}
                aria-label="Exit Fullscreen"
                className="p-1.5 rounded-full text-slate-300 hover:text-white bg-white/10 hover:bg-white/20 transition-colors"
              >
                <Minimize className="h-5 w-5" />
              </button>
            ) : onClose ? (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close lesson"
                className="p-1.5 rounded-full text-slate-300 hover:text-white bg-white/10 hover:bg-white/20 transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            ) : null}
          </div>
        </div>

        {/* Floating Unlock Control When Screen is Locked */}
        {isLocked && (
          <div className="absolute top-4 left-4 z-30 flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setIsLocked(false);
                showControls();
              }}
              className="flex items-center gap-2 px-3 py-2 rounded-full bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs shadow-2xl border border-blue-400/40 backdrop-blur-md transition-all active:scale-95"
            >
              <Unlock className="h-4 w-4" />
              <span>Tap to Unlock</span>
            </button>

            {showLockHint && (
              <span className="text-xs font-medium text-white/90 bg-black/70 px-3 py-1.5 rounded-full border border-white/10 backdrop-blur-md animate-in fade-in duration-200">
                Screen is locked
              </span>
            )}
          </div>
        )}

        {/* Resume Playback Prompt Pill */}
        {showResumeNotice && resumedFrom !== null && (
          <div className="absolute top-14 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 rounded-full bg-[#05070D]/90 border border-blue-500/40 px-3.5 py-1.5 text-xs text-white shadow-2xl backdrop-blur-md animate-in fade-in slide-in-from-top-4 duration-300">
            <span className="text-blue-400 font-bold">▶ Resumed from {formatTime(resumedFrom)}</span>
            <span className="text-white/40">·</span>
            <button
              type="button"
              onClick={() => {
                seekTo(0);
                setShowResumeNotice(false);
                if (savedPosKey) localStorage.removeItem(savedPosKey);
              }}
              className="font-bold underline text-slate-200 hover:text-white"
            >
              Start Over
            </button>
            <button
              type="button"
              onClick={() => setShowResumeNotice(false)}
              className="text-slate-400 hover:text-white ml-1"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* Subtitle / Caption Notice */}
        {captionToast && (
          <div className="absolute top-14 left-1/2 -translate-x-1/2 z-30 rounded-full bg-slate-900/95 border border-white/10 px-3.5 py-1.5 text-xs text-slate-200 shadow-xl backdrop-blur-md">
            {captionToast}
          </div>
        )}

        {/* Buffering Indicator */}
        {buffering && !error && (
          <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center bg-black/30 backdrop-blur-[2px]">
            <div className="flex flex-col items-center gap-2">
              <Loader2 className="h-10 w-10 sm:h-12 sm:w-12 animate-spin text-blue-400 drop-shadow-[0_0_15px_rgba(59,130,246,0.8)]" />
              <span className="text-xs font-bold text-white/90 tracking-wider">Loading masterclass...</span>
            </div>
          </div>
        )}

        {/* Playback Error with Retry Button */}
        {error && (
          <div className="absolute inset-0 z-30 grid place-items-center bg-black/90 p-6 text-center">
            <div className="max-w-md p-6 rounded-2xl bg-[#070B14] border border-amber-500/30 shadow-2xl">
              <AlertTriangle className="mx-auto mb-3 h-9 w-9 text-amber-400" />
              <h4 className="text-sm sm:text-base font-bold text-white mb-1">Playback Interrupted</h4>
              <p className="text-xs text-slate-300 mb-4">{error}</p>
              <div className="flex items-center justify-center gap-3">
                <button
                  type="button"
                  onClick={handleRetryPlayback}
                  className="px-4 py-2 rounded-xl text-xs font-bold text-white bg-blue-600 hover:bg-blue-500 shadow-lg shadow-blue-500/20 transition-all active:scale-95"
                >
                  Retry Playback
                </button>
                {onNext && hasNext && (
                  <button
                    type="button"
                    onClick={onNext}
                    className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-300 bg-white/10 hover:bg-white/20 transition-colors"
                  >
                    Skip to Next Episode
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* "Up Next" Episode Auto-Play Countdown Card When Ended */}
        {ended && hasNext && onNext && (
          <div className="absolute inset-0 z-30 flex items-center justify-center p-4 bg-black/85 backdrop-blur-md">
            <div className="w-full max-w-sm p-5 rounded-3xl bg-[#070B14] border border-blue-500/30 shadow-2xl text-center animate-in zoom-in-95 duration-200">
              <span className="text-[10px] font-extrabold uppercase tracking-widest text-blue-400 block mb-1">
                Up Next
              </span>
              <h3 className="text-base font-bold text-white mb-3 truncate">
                {nextLessonTitle || 'Next Masterclass Lesson'}
              </h3>

              {/* Countdown Circular Ring */}
              <div className="relative h-16 w-16 mx-auto mb-4 flex items-center justify-center">
                <svg className="h-full w-full -rotate-90">
                  <circle
                    cx="32"
                    cy="32"
                    r="28"
                    stroke="currentColor"
                    strokeWidth="3"
                    className="text-white/10"
                    fill="none"
                  />
                  <circle
                    cx="32"
                    cy="32"
                    r="28"
                    stroke="currentColor"
                    strokeWidth="3"
                    className="text-blue-500 transition-all duration-1000 ease-linear"
                    fill="none"
                    strokeDasharray={175.9}
                    strokeDashoffset={
                      nextCountdown !== null ? 175.9 * (1 - nextCountdown / 5) : 0
                    }
                  />
                </svg>
                <span className="absolute text-lg font-extrabold text-white tabular-nums">
                  {nextCountdown ?? 0}s
                </span>
              </div>

              <div className="flex items-center justify-center gap-2">
                <button
                  type="button"
                  onClick={onNext}
                  className="flex-1 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs shadow-lg shadow-blue-500/25 transition-all active:scale-95"
                >
                  Play Now
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setNextCountdown(null);
                    seekTo(0);
                    togglePlay();
                  }}
                  className="px-3.5 py-2.5 rounded-xl bg-white/10 hover:bg-white/20 text-slate-300 font-semibold text-xs transition-colors"
                >
                  Replay
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Keyboard Shortcuts Guide Modal */}
        {activeMenu === 'shortcuts' && (
          <div className="absolute inset-0 z-40 flex items-center justify-center p-4 bg-black/85 backdrop-blur-md">
            <div className="w-full max-w-md p-5 rounded-3xl bg-[#070B14] border border-blue-500/30 shadow-2xl text-left">
              <div className="flex items-center justify-between pb-3 border-b border-white/[0.08] mb-4">
                <h3 className="text-sm font-bold text-white flex items-center gap-2">
                  <HelpCircle className="h-4 w-4 text-cyan-400" /> Keyboard Shortcuts
                </h3>
                <button
                  type="button"
                  onClick={() => setActiveMenu('none')}
                  className="text-slate-400 hover:text-white"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="grid grid-cols-2 gap-y-2.5 gap-x-4 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-slate-300">Play / Pause</span>
                  <kbd className="px-2 py-0.5 rounded bg-white/10 text-white font-mono text-[11px]">Space / K</kbd>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-300">Seek ±10 seconds</span>
                  <kbd className="px-2 py-0.5 rounded bg-white/10 text-white font-mono text-[11px]">← / → / J / L</kbd>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-300">Volume Up / Down</span>
                  <kbd className="px-2 py-0.5 rounded bg-white/10 text-white font-mono text-[11px]">↑ / ↓</kbd>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-300">Mute / Unmute</span>
                  <kbd className="px-2 py-0.5 rounded bg-white/10 text-white font-mono text-[11px]">M</kbd>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-300">Fullscreen</span>
                  <kbd className="px-2 py-0.5 rounded bg-white/10 text-white font-mono text-[11px]">F</kbd>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-300">Picture-in-Picture</span>
                  <kbd className="px-2 py-0.5 rounded bg-white/10 text-white font-mono text-[11px]">P</kbd>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-300">Next Episode</span>
                  <kbd className="px-2 py-0.5 rounded bg-white/10 text-white font-mono text-[11px]">N</kbd>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-300">Jump 0% – 90%</span>
                  <kbd className="px-2 py-0.5 rounded bg-white/10 text-white font-mono text-[11px]">0 – 9</kbd>
                </div>
              </div>

              <div className="mt-4 pt-3 border-t border-white/[0.08] text-right">
                <button
                  type="button"
                  onClick={() => setActiveMenu('none')}
                  className="px-4 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold transition-colors"
                >
                  Got It
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Overlay Control Bar for HTML5 Video */}
        {overlay && controlBar}
      </div>

      {/* Docked Control Bar for YouTube & Vimeo Embeds */}
      {!overlay && controlBar}
    </div>
  );
};
