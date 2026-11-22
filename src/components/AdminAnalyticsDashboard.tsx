import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  Calendar,
  CheckCircle2,
  Crown,
  Infinity as InfinityIcon,
  PieChart as PieChartIcon,
  RefreshCw,
  Search,
  Sparkles,
  Trophy,
  Users,
  X,
  Zap
} from 'lucide-react';
import {
  AnalyticsTimeframe,
  Category,
  NormalizedSaleTransaction,
  PaymentRequest,
  SalesRecord,
  UserProfile
} from '../types';
import {
  computeFinancialAnalytics,
  formatCompactInr,
  formatFullIstDateTime,
  formatInr,
  formatRelativeIstTime,
  RevenueBreakdownSlice,
  SalesChartPoint,
  TopCourseMetric
} from '../services/analyticsService';

interface AdminAnalyticsDashboardProps {
  currentUser: UserProfile | null;
  sales: SalesRecord[];
  paymentRequests: PaymentRequest[];
  users: UserProfile[];
  categories: Category[];
  onRefreshData: () => Promise<{ refreshedAt: string }>;
}

const TIMEFRAME_OPTIONS: Array<{ id: AnalyticsTimeframe; label: string; dropdownLabel: string }> = [
  { id: 'day', label: 'Day', dropdownLabel: 'Today' },
  { id: 'week', label: 'Week', dropdownLabel: 'This Week' },
  { id: 'month', label: 'Month', dropdownLabel: 'This Month' },
  { id: 'lifetime', label: 'Lifetime', dropdownLabel: 'All Time' }
];

function buildSparklinePath(values: number[], width: number, height: number): string {
  const pts = values.length >= 2 ? values : [0, ...(values.length === 1 ? values : [0])];
  const maxVal = Math.max(...pts, 1);
  const allZero = pts.every((v) => v <= 0);
  const padY = 4;
  const usableH = height - padY * 2;
  const stepX = width / Math.max(pts.length - 1, 1);

  const coords = pts.map((v, i) => {
    const x = i * stepX;
    const normalized = allZero ? 0.18 + Math.sin(i * 0.9) * 0.08 : v / maxVal;
    const y = height - padY - normalized * usableH;
    return { x, y };
  });

  let d = `M ${coords[0].x.toFixed(1)} ${coords[0].y.toFixed(1)}`;
  for (let i = 0; i < coords.length - 1; i++) {
    const curr = coords[i];
    const next = coords[i + 1];
    const mx = ((curr.x + next.x) / 2).toFixed(1);
    d += ` C ${mx} ${curr.y.toFixed(1)}, ${mx} ${next.y.toFixed(1)}, ${next.x.toFixed(1)} ${next.y.toFixed(1)}`;
  }
  return d;
}

function buildSmoothAreaChart(points: SalesChartPoint[], width: number, height: number, padLeft: number, padRight: number, padTop: number, padBottom: number) {
  const usableW = Math.max(width - padLeft - padRight, 10);
  const usableH = Math.max(height - padTop - padBottom, 10);
  const rawMax = Math.max(...points.map((p) => p.revenue), 0);

  // Clean rounded ceiling for Y-axis ticks
  let niceMax = 1000;
  if (rawMax > 0) {
    const magnitude = Math.pow(10, Math.floor(Math.log10(rawMax)));
    const normalized = rawMax / magnitude;
    const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
    niceMax = Math.max(step * magnitude, 100);
    if (rawMax > niceMax * 0.92) {
      niceMax = Math.ceil((rawMax * 1.15) / (magnitude / 2)) * (magnitude / 2);
    }
  }

  const coords = points.map((pt, idx) => {
    const ratioX = points.length <= 1 ? 0.5 : idx / (points.length - 1);
    const x = padLeft + ratioX * usableW;
    const ratioY = niceMax > 0 ? Math.min(pt.revenue / niceMax, 1) : 0;
    const y = padTop + usableH - ratioY * usableH;
    return { x, y, pt, idx };
  });

  if (coords.length === 0) {
    return { linePath: '', areaPath: '', coords: [], niceMax };
  }

  if (coords.length === 1) {
    const c = coords[0];
    const linePath = `M ${padLeft} ${c.y.toFixed(1)} L ${width - padRight} ${c.y.toFixed(1)}`;
    const base = padTop + usableH;
    const areaPath = `${linePath} L ${width - padRight} ${base} L ${padLeft} ${base} Z`;
    return { linePath, areaPath, coords, niceMax };
  }

  let linePath = `M ${coords[0].x.toFixed(1)} ${coords[0].y.toFixed(1)}`;
  for (let i = 0; i < coords.length - 1; i++) {
    const p0 = coords[Math.max(i - 1, 0)];
    const p1 = coords[i];
    const p2 = coords[i + 1];
    const p3 = coords[Math.min(i + 2, coords.length - 1)];

    const tension = 0.2;
    const cp1x = p1.x + (p2.x - p0.x) * tension;
    const cp1y = Math.min(padTop + usableH, Math.max(padTop, p1.y + (p2.y - p0.y) * tension));
    const cp2x = p2.x - (p3.x - p1.x) * tension;
    const cp2y = Math.min(padTop + usableH, Math.max(padTop, p2.y - (p3.y - p1.y) * tension));

    linePath += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }

  const base = padTop + usableH;
  const areaPath = `${linePath} L ${coords[coords.length - 1].x.toFixed(1)} ${base.toFixed(1)} L ${coords[0].x.toFixed(1)} ${base.toFixed(1)} Z`;

  return { linePath, areaPath, coords, niceMax };
}

function getCourseInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 'SF';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

function getStudentInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 'S';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

const CourseAvatar: React.FC<{ course: TopCourseMetric }> = ({ course }) => {
  const [imgFailed, setImgFailed] = useState(false);

  if (course.segment === 'all_access') {
    return (
      <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-amber-500/30 via-purple-600/30 to-indigo-600/30 border border-amber-400/40 flex items-center justify-center shrink-0">
        <Crown className="w-4 h-4 text-amber-300" />
      </div>
    );
  }

  if (course.thumbnailUrl && !imgFailed) {
    return (
      <img
        src={course.thumbnailUrl}
        alt={course.courseName}
        onError={() => setImgFailed(true)}
        className="w-9 h-9 rounded-xl object-cover border border-white/10 bg-slate-900 shrink-0"
      />
    );
  }

  return (
    <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-cyan-500/25 via-blue-600/25 to-purple-600/25 border border-cyan-400/30 flex items-center justify-center shrink-0 text-[10px] font-extrabold text-cyan-200 tracking-tight">
      {getCourseInitials(course.courseName)}
    </div>
  );
};

export const AdminAnalyticsDashboard: React.FC<AdminAnalyticsDashboardProps> = ({
  currentUser,
  sales,
  paymentRequests,
  users,
  categories,
  onRefreshData
}) => {
  const [timeframe, setTimeframe] = useState<AnalyticsTimeframe>('day');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [lastUpdatedIso, setLastUpdatedIso] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [hoveredChartIdx, setHoveredChartIdx] = useState<number | null>(null);
  const [activeSliceKey, setActiveSliceKey] = useState<string | null>(null);

  // View All Modals
  const [showAllCoursesModal, setShowAllCoursesModal] = useState(false);
  const [showAllSalesModal, setShowAllSalesModal] = useState(false);
  const [modalCourseSearch, setModalCourseSearch] = useState('');
  const [modalSalesSearch, setModalSalesSearch] = useState('');
  const [modalSalesScope, setModalSalesScope] = useState<'selected' | 'all'>('all');

  const refreshInFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const chartSvgRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const triggerRefresh = useCallback(async () => {
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    setIsRefreshing(true);
    setRefreshError(null);
    try {
      const result = await onRefreshData();
      if (mountedRef.current) {
        setLastUpdatedIso(result.refreshedAt);
        setHasLoadedOnce(true);
      }
    } catch (err: any) {
      if (mountedRef.current) {
        setRefreshError(err?.message || 'Unable to sync latest financial data from Firestore.');
        setHasLoadedOnce(true);
      }
    } finally {
      refreshInFlightRef.current = false;
      if (mountedRef.current) {
        setIsRefreshing(false);
      }
    }
  }, [onRefreshData]);

  // Auto-refresh whenever Admin Analytics tab opens
  useEffect(() => {
    void triggerRefresh();
  }, [triggerRefresh, currentUser?.uid]);

  const analytics = useMemo(() => {
    return computeFinancialAnalytics({
      sales,
      paymentRequests,
      users,
      categories,
      timeframe
    });
  }, [sales, paymentRequests, users, categories, timeframe]);

  // Default highlight index on the Sales Overview chart = highest revenue bucket
  const peakChartIndex = useMemo(() => {
    const pts = analytics.selected.chartPoints;
    if (pts.length === 0) return -1;
    let bestIdx = -1;
    let bestRev = 0;
    pts.forEach((p, idx) => {
      if (p.revenue > bestRev) {
        bestRev = p.revenue;
        bestIdx = idx;
      }
    });
    return bestIdx;
  }, [analytics.selected.chartPoints]);

  useEffect(() => {
    setHoveredChartIdx(null);
    setActiveSliceKey(null);
  }, [timeframe]);

  const activeChartIndex =
    hoveredChartIdx !== null && hoveredChartIdx >= 0 && hoveredChartIdx < analytics.selected.chartPoints.length
      ? hoveredChartIdx
      : peakChartIndex >= 0
      ? peakChartIndex
      : null;

  // Chart SVG geometry constants
  const SVG_W = 640;
  const SVG_H = 228;
  const PAD_L = 46;
  const PAD_R = 14;
  const PAD_T = 26;
  const PAD_B = 30;

  const chartGeometry = useMemo(
    () => buildSmoothAreaChart(analytics.selected.chartPoints, SVG_W, SVG_H, PAD_L, PAD_R, PAD_T, PAD_B),
    [analytics.selected.chartPoints]
  );

  const handleChartPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!chartSvgRef.current || chartGeometry.coords.length === 0) return;
    const rect = chartSvgRef.current.getBoundingClientRect();
    if (rect.width <= 0) return;
    const relX = ((e.clientX - rect.left) / rect.width) * SVG_W;
    let nearestIdx = 0;
    let minDist = Number.POSITIVE_INFINITY;
    for (const c of chartGeometry.coords) {
      const dist = Math.abs(c.x - relX);
      if (dist < minDist) {
        minDist = dist;
        nearestIdx = c.idx;
      }
    }
    setHoveredChartIdx(nearestIdx);
  };

  const renderGrowthBadge = (
    direction: 'up' | 'down' | 'flat' | 'new',
    label: string,
    suffix?: string
  ) => {
    if (direction === 'up' || direction === 'new') {
      return (
        <span className="inline-flex items-center gap-0.5 text-[10px] sm:text-[11px] font-bold text-emerald-400 tabular-nums">
          <ArrowUpRight className="w-3 h-3 shrink-0" />
          <span>{label}</span>
          {suffix && <span className="text-slate-400 font-normal hidden sm:inline">{suffix}</span>}
        </span>
      );
    }
    if (direction === 'down') {
      return (
        <span className="inline-flex items-center gap-0.5 text-[10px] sm:text-[11px] font-bold text-rose-400 tabular-nums">
          <ArrowDownRight className="w-3 h-3 shrink-0" />
          <span>{label}</span>
          {suffix && <span className="text-slate-400 font-normal hidden sm:inline">{suffix}</span>}
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-0.5 text-[10px] sm:text-[11px] font-semibold text-slate-400 tabular-nums">
        <span>{label}</span>
        {suffix && <span className="text-slate-500 font-normal hidden sm:inline">{suffix}</span>}
      </span>
    );
  };

  // Top courses & recent sales displayed in dashboard cards
  const displayedTopCourses = analytics.selected.topCourses.slice(0, 5);
  const displayedRecentSales = analytics.selected.recentSales.slice(0, 6);

  // Filtered datasets inside View All modals
  const modalCoursesList = useMemo(() => {
    const source = analytics.allTimeTopCourses;
    const q = modalCourseSearch.trim().toLowerCase();
    if (!q) return source;
    return source.filter((c) => c.courseName.toLowerCase().includes(q));
  }, [analytics.allTimeTopCourses, modalCourseSearch]);

  const modalSalesList = useMemo(() => {
    const base =
      modalSalesScope === 'all' ? analytics.allTimeRecentSales : analytics.selected.recentSales;
    const q = modalSalesSearch.trim().toLowerCase();
    if (!q) return base;
    return base.filter(
      (s) =>
        s.studentName.toLowerCase().includes(q) ||
        s.studentEmail.toLowerCase().includes(q) ||
        s.courseName.toLowerCase().includes(q) ||
        (s.utr || '').toLowerCase().includes(q)
    );
  }, [analytics.allTimeRecentSales, analytics.selected.recentSales, modalSalesScope, modalSalesSearch]);

  // Donut chart slices geometry
  const donutMeta = useMemo(() => {
    const slices = analytics.selected.breakdown;
    const total = slices.reduce((sum, s) => sum + s.revenue, 0);
    const radius = 52;
    const circumference = 2 * Math.PI * radius;
    let offsetAcc = 0;

    const segments = slices.map((slice) => {
      const fraction = total > 0 ? slice.revenue / total : 0;
      const strokeLength = fraction * circumference;
      const seg = {
        ...slice,
        dashArray: `${strokeLength} ${circumference}`,
        dashOffset: -offsetAcc
      };
      offsetAcc += strokeLength;
      return seg;
    });

    return { segments, total, radius, circumference };
  }, [analytics.selected.breakdown]);

  const activeDonutSlice: RevenueBreakdownSlice | null =
    donutMeta.segments.find((s) => s.key === activeSliceKey) || null;

  const isInitialSkeleton = !hasLoadedOnce && isRefreshing && analytics.allTransactions.length === 0;

  return (
    <div className="space-y-4 sm:space-y-5 w-full min-w-0 animate-in fade-in duration-150">
      {/* ============================================================ */}
      {/* HEADER BAR                                                   */}
      {/* ============================================================ */}
      <div className="relative overflow-hidden rounded-2xl sm:rounded-3xl bg-gradient-to-br from-[#0B1228] via-[#070B1A] to-[#050711] border border-indigo-500/25 p-3.5 sm:p-5 shadow-[0_14px_40px_-15px_rgba(79,70,229,0.35)]">
        {/* Subtle ambient neon glow orbs */}
        <div className="pointer-events-none absolute -top-16 -right-12 w-48 h-48 rounded-full bg-purple-600/15 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-16 -left-12 w-44 h-44 rounded-full bg-cyan-500/10 blur-3xl" />

        <div className="relative flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-11 h-11 sm:w-12 sm:h-12 rounded-2xl bg-gradient-to-br from-violet-600 via-purple-500 to-cyan-400 p-[1px] shadow-[0_0_24px_-4px_rgba(168,85,247,0.65)] shrink-0">
              <div className="w-full h-full rounded-[15px] bg-[#0B1024] flex items-center justify-center">
                <BarChart3 className="w-6 h-6 text-purple-300" />
              </div>
            </div>
            <div className="min-w-0">
              <h2 className="brand-font text-lg sm:text-2xl font-extrabold text-white tracking-tight truncate">
                Analytics Dashboard
              </h2>
              <p className="text-[11px] sm:text-xs text-slate-400 truncate">
                Track your sales &amp; growth in real-time (IST)
              </p>
            </div>
          </div>

          {/* Right Action Controls: Timeframe Dropdown + Manual Refresh */}
          <div className="flex items-center justify-between sm:justify-end gap-2 shrink-0">
            <select
              aria-label="Analytics period filter"
              value={timeframe}
              onChange={(e) => setTimeframe(e.target.value as AnalyticsTimeframe)}
              className="min-h-[40px] px-3 py-1.5 rounded-xl bg-[#0D1631] border border-indigo-400/30 text-xs font-bold text-white outline-none focus:border-cyan-400 cursor-pointer"
            >
              {TIMEFRAME_OPTIONS.map((opt) => (
                <option key={opt.id} value={opt.id} className="bg-[#0B1228] text-white">
                  {opt.dropdownLabel}
                </option>
              ))}
            </select>

            <button
              type="button"
              onClick={() => void triggerRefresh()}
              disabled={isRefreshing}
              className="min-h-[40px] px-3 py-1.5 rounded-xl bg-gradient-to-r from-cyan-500/20 to-blue-600/20 hover:from-cyan-500/30 hover:to-blue-600/30 border border-cyan-400/35 text-cyan-200 text-xs font-bold flex items-center gap-1.5 cursor-pointer disabled:opacity-60 transition-all active:scale-95"
              title="Re-fetch live financial records from Firestore"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin text-cyan-300' : ''}`} />
              <span>{isRefreshing ? 'Syncing...' : 'Refresh'}</span>
            </button>
          </div>
        </div>

        {/* Last Updated Strip */}
        <div className="relative mt-2.5 pt-2.5 border-t border-white/5 flex flex-wrap items-center justify-between gap-2 text-[10px] sm:text-[11px] text-slate-400">
          <span className="font-mono tabular-nums">
            {lastUpdatedIso
              ? `Last updated: ${formatFullIstDateTime(new Date(lastUpdatedIso).getTime())} IST`
              : `Synced: ${analytics.istNowLabel} IST`}
          </span>
          <span className="font-mono tabular-nums text-slate-500">
            Verified Net Sales Only • {analytics.lifetime.transactions} Unique Tx
          </span>
        </div>
      </div>

      {/* Error State Banner */}
      {refreshError && (
        <div className="p-3.5 rounded-2xl bg-rose-950/40 border border-rose-500/35 flex items-center justify-between gap-3 text-xs text-rose-200">
          <div className="flex items-center gap-2 min-w-0">
            <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
            <span className="truncate">{refreshError}</span>
          </div>
          <button
            type="button"
            onClick={() => void triggerRefresh()}
            className="px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white font-bold text-[11px] shrink-0 cursor-pointer"
          >
            Retry
          </button>
        </div>
      )}

      {/* ============================================================ */}
      {/* 2x2 MOBILE FINANCIAL KPI GRID (4 MAIN CARDS)                 */}
      {/* ============================================================ */}
      {isInitialSkeleton ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-3.5">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-[118px] rounded-2xl bg-[#090F22] border border-white/10 animate-pulse p-3.5" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-3.5">
          {/* CARD 1: TODAY'S SALES (Cyan / Blue) */}
          <button
            type="button"
            onClick={() => setTimeframe('day')}
            className={`text-left relative overflow-hidden rounded-2xl p-3 sm:p-4 bg-gradient-to-br from-[#0B1B38]/95 via-[#070F24]/95 to-[#050914] border transition-all cursor-pointer group ${
              timeframe === 'day'
                ? 'border-cyan-400/70 shadow-[0_0_26px_-6px_rgba(34,211,238,0.55)]'
                : 'border-cyan-400/30 shadow-[0_0_20px_-10px_rgba(34,211,238,0.35)] hover:border-cyan-400/55'
            }`}
          >
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-cyan-500/20 border border-cyan-400/40 flex items-center justify-center shrink-0">
                <Calendar className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-cyan-300" />
              </div>
              <span className="text-[11px] sm:text-xs font-semibold text-slate-200 truncate">
                Today&apos;s Sales
              </span>
            </div>

            <div className="mt-2 sm:mt-2.5 pr-12 sm:pr-16">
              <p className="brand-font text-lg sm:text-2xl font-extrabold text-white tabular-nums tracking-tight truncate">
                {formatInr(analytics.today.revenue)}
              </p>
            </div>

            <div className="mt-1.5 flex flex-col gap-0.5 pr-12 sm:pr-16">
              {renderGrowthBadge(analytics.today.growthDirection, analytics.today.growthLabel, 'vs yest')}
              <span className="text-[10px] text-slate-400 font-mono tabular-nums truncate">
                {analytics.today.transactions} tx • {analytics.today.activePurchases} active
              </span>
            </div>

            {/* Bottom-right Sparkline */}
            <svg
              viewBox="0 0 64 26"
              className="pointer-events-none absolute right-2 bottom-2 w-14 sm:w-16 h-7 opacity-85"
              aria-hidden="true"
            >
              <path
                d={buildSparklinePath(analytics.today.sparkline, 64, 26)}
                fill="none"
                stroke="#22D3EE"
                strokeWidth="2.2"
                strokeLinecap="round"
              />
            </svg>
          </button>

          {/* CARD 2: THIS WEEK (Purple / Magenta) */}
          <button
            type="button"
            onClick={() => setTimeframe('week')}
            className={`text-left relative overflow-hidden rounded-2xl p-3 sm:p-4 bg-gradient-to-br from-[#191038]/95 via-[#0C0B22]/95 to-[#060814] border transition-all cursor-pointer group ${
              timeframe === 'week'
                ? 'border-purple-400/75 shadow-[0_0_26px_-6px_rgba(168,85,247,0.55)]'
                : 'border-purple-400/30 shadow-[0_0_20px_-10px_rgba(168,85,247,0.35)] hover:border-purple-400/55'
            }`}
          >
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-purple-500/20 border border-purple-400/40 flex items-center justify-center shrink-0">
                <Calendar className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-purple-300" />
              </div>
              <span className="text-[11px] sm:text-xs font-semibold text-slate-200 truncate">
                This Week
              </span>
            </div>

            <div className="mt-2 sm:mt-2.5 pr-12 sm:pr-16">
              <p className="brand-font text-lg sm:text-2xl font-extrabold text-white tabular-nums tracking-tight truncate">
                {formatInr(analytics.thisWeek.revenue)}
              </p>
            </div>

            <div className="mt-1.5 flex flex-col gap-0.5 pr-12 sm:pr-16">
              {renderGrowthBadge(analytics.thisWeek.growthDirection, analytics.thisWeek.growthLabel, 'vs last wk')}
              <span className="text-[10px] text-slate-400 font-mono tabular-nums truncate">
                {analytics.thisWeek.transactions} tx • Mon–Sun
              </span>
            </div>

            <svg
              viewBox="0 0 64 26"
              className="pointer-events-none absolute right-2 bottom-2 w-14 sm:w-16 h-7 opacity-85"
              aria-hidden="true"
            >
              <path
                d={buildSparklinePath(analytics.thisWeek.sparkline, 64, 26)}
                fill="none"
                stroke="#C084FC"
                strokeWidth="2.2"
                strokeLinecap="round"
              />
            </svg>
          </button>

          {/* CARD 3: THIS MONTH (Emerald / Teal) */}
          <button
            type="button"
            onClick={() => setTimeframe('month')}
            className={`text-left relative overflow-hidden rounded-2xl p-3 sm:p-4 bg-gradient-to-br from-[#072621]/95 via-[#061519]/95 to-[#050912] border transition-all cursor-pointer group ${
              timeframe === 'month'
                ? 'border-emerald-400/75 shadow-[0_0_26px_-6px_rgba(16,185,129,0.55)]'
                : 'border-emerald-400/30 shadow-[0_0_20px_-10px_rgba(16,185,129,0.35)] hover:border-emerald-400/55'
            }`}
          >
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-emerald-500/20 border border-emerald-400/40 flex items-center justify-center shrink-0">
                <Calendar className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-emerald-300" />
              </div>
              <span className="text-[11px] sm:text-xs font-semibold text-slate-200 truncate">
                This Month
              </span>
            </div>

            <div className="mt-2 sm:mt-2.5 pr-12 sm:pr-16">
              <p className="brand-font text-lg sm:text-2xl font-extrabold text-white tabular-nums tracking-tight truncate">
                {formatInr(analytics.thisMonth.revenue)}
              </p>
            </div>

            <div className="mt-1.5 flex flex-col gap-0.5 pr-12 sm:pr-16">
              {renderGrowthBadge(analytics.thisMonth.growthDirection, analytics.thisMonth.growthLabel, 'vs last mo')}
              <span className="text-[10px] text-slate-400 font-mono tabular-nums truncate">
                {analytics.thisMonth.transactions} tx • IST Month
              </span>
            </div>

            <svg
              viewBox="0 0 64 26"
              className="pointer-events-none absolute right-2 bottom-2 w-14 sm:w-16 h-7 opacity-85"
              aria-hidden="true"
            >
              <path
                d={buildSparklinePath(analytics.thisMonth.sparkline, 64, 26)}
                fill="none"
                stroke="#34D399"
                strokeWidth="2.2"
                strokeLinecap="round"
              />
            </svg>
          </button>

          {/* CARD 4: LIFETIME SALES (Gold / Amber) */}
          <button
            type="button"
            onClick={() => setTimeframe('lifetime')}
            className={`text-left relative overflow-hidden rounded-2xl p-3 sm:p-4 bg-gradient-to-br from-[#271B09]/95 via-[#161009]/95 to-[#07080F] border transition-all cursor-pointer group ${
              timeframe === 'lifetime'
                ? 'border-amber-400/75 shadow-[0_0_26px_-6px_rgba(245,158,11,0.55)]'
                : 'border-amber-400/30 shadow-[0_0_20px_-10px_rgba(245,158,11,0.35)] hover:border-amber-400/55'
            }`}
          >
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-amber-500/20 border border-amber-400/40 flex items-center justify-center shrink-0">
                <InfinityIcon className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-amber-300" />
              </div>
              <span className="text-[11px] sm:text-xs font-semibold text-slate-200 truncate">
                Lifetime Sales
              </span>
            </div>

            <div className="mt-2 sm:mt-2.5 pr-12 sm:pr-16">
              <p className="brand-font text-lg sm:text-2xl font-extrabold text-white tabular-nums tracking-tight truncate">
                {formatInr(analytics.lifetime.revenue)}
              </p>
            </div>

            <div className="mt-1.5 flex flex-col gap-0.5 pr-12 sm:pr-16">
              <span className="inline-flex items-center gap-1 text-[10px] sm:text-[11px] font-bold text-amber-300 truncate">
                <Crown className="w-3 h-3 shrink-0" />
                <span>Total Earnings</span>
              </span>
              <span className="text-[10px] text-slate-400 font-mono tabular-nums truncate">
                {analytics.lifetime.transactions} tx • {analytics.lifetime.uniqueStudents} students
              </span>
            </div>

            <svg
              viewBox="0 0 64 26"
              className="pointer-events-none absolute right-2 bottom-2 w-14 sm:w-16 h-7 opacity-85"
              aria-hidden="true"
            >
              <path
                d={buildSparklinePath(analytics.lifetime.sparkline, 64, 26)}
                fill="none"
                stroke="#FBBF24"
                strokeWidth="2.2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      )}

      {/* ============================================================ */}
      {/* SALES OVERVIEW & INTERACTIVE GRAPH                           */}
      {/* ============================================================ */}
      <section className="rounded-2xl sm:rounded-3xl bg-[#070D1F]/95 border border-indigo-500/25 p-3.5 sm:p-5 shadow-[0_14px_40px_-20px_rgba(139,92,246,0.45)]">
        {/* Header + Segmented Time Filters */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-xl bg-cyan-500/15 border border-cyan-400/30 flex items-center justify-center shrink-0">
              <BarChart3 className="w-4 h-4 text-cyan-300" />
            </div>
            <div className="min-w-0">
              <h3 className="brand-font text-sm sm:text-base font-bold text-white truncate">
                Sales Overview
              </h3>
              <p className="text-[11px] text-slate-400 truncate">
                Your sales performance over time
              </p>
            </div>
          </div>

          {/* Segmented Tabs: Day | Week | Month | Lifetime */}
          <div
            role="tablist"
            aria-label="Sales timeframe"
            className="grid grid-cols-4 bg-[#040814] border border-white/10 rounded-xl p-1 gap-1 w-full md:w-auto"
          >
            {TIMEFRAME_OPTIONS.map((opt) => {
              const isActive = timeframe === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => setTimeframe(opt.id)}
                  className={`min-h-[34px] px-2.5 sm:px-3.5 py-1.5 rounded-lg text-[11px] sm:text-xs font-bold transition-all cursor-pointer whitespace-nowrap ${
                    isActive
                      ? 'bg-gradient-to-r from-violet-600 to-purple-500 text-white shadow-[0_0_16px_rgba(139,92,246,0.55)]'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Dynamic Filtered KPI Summary Strip */}
        <div className="mt-3.5 grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3 p-2.5 sm:p-3 rounded-2xl bg-[#040814]/80 border border-white/5">
          <div className="min-w-0">
            <span className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold block">
              Period Revenue
            </span>
            <span className="brand-font text-sm sm:text-base font-extrabold text-white tabular-nums block truncate mt-0.5">
              {formatInr(analytics.selected.revenue)}
            </span>
          </div>
          <div className="min-w-0">
            <span className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold block">
              Transactions
            </span>
            <span className="brand-font text-sm sm:text-base font-extrabold text-cyan-300 tabular-nums block truncate mt-0.5">
              {analytics.selected.transactions}
            </span>
          </div>
          <div className="min-w-0">
            <span className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold block">
              Avg Order Value
            </span>
            <span className="brand-font text-sm sm:text-base font-extrabold text-amber-300 tabular-nums block truncate mt-0.5">
              {formatInr(analytics.selected.averageOrderValue)}
            </span>
          </div>
          <div className="min-w-0">
            <span className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold block">
              Comparison
            </span>
            <div className="mt-0.5 truncate">
              {timeframe === 'lifetime' ? (
                <span className="text-[11px] font-bold text-purple-300 truncate block">
                  {analytics.selected.uniqueStudents} Paying Students
                </span>
              ) : (
                <span className="text-[11px] font-bold text-slate-200 truncate block tabular-nums">
                  {analytics.selected.growthLabel} ({analytics.selected.comparisonCaption})
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Chart Area */}
        <div className="mt-4 relative">
          {analytics.selected.transactions === 0 ? (
            <div className="h-[200px] sm:h-[228px] rounded-2xl border border-dashed border-indigo-500/25 bg-[#040814]/60 flex flex-col items-center justify-center p-4 text-center">
              <Sparkles className="w-7 h-7 text-purple-400/70 mb-2" />
              <p className="text-xs sm:text-sm font-bold text-slate-200">
                No verified sales in this {TIMEFRAME_OPTIONS.find((t) => t.id === timeframe)?.dropdownLabel.toLowerCase()} window
              </p>
              <p className="text-[11px] text-slate-400 mt-1 max-w-xs">
                Verified &amp; approved student payments will appear on this graph automatically.
              </p>
              {timeframe !== 'lifetime' && analytics.lifetime.transactions > 0 && (
                <button
                  type="button"
                  onClick={() => setTimeframe('lifetime')}
                  className="mt-3 px-3.5 py-1.5 rounded-xl bg-purple-600/25 hover:bg-purple-600/35 border border-purple-400/40 text-purple-200 text-xs font-bold cursor-pointer transition-colors"
                >
                  View Lifetime Sales ({formatInr(analytics.lifetime.revenue)})
                </button>
              )}
            </div>
          ) : (
            <div className="relative select-none">
              <svg
                ref={chartSvgRef}
                viewBox={`0 0 ${SVG_W} ${SVG_H}`}
                className="w-full h-[200px] sm:h-[240px] touch-pan-y cursor-crosshair overflow-visible"
                onPointerMove={handleChartPointerMove}
                onPointerDown={handleChartPointerMove}
                onPointerLeave={() => setHoveredChartIdx(null)}
                role="img"
                aria-label="Interactive sales revenue chart"
              >
                <defs>
                  <linearGradient id="sfSalesLineGrad" x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0%" stopColor="#6366F1" />
                    <stop offset="50%" stopColor="#A855F7" />
                    <stop offset="100%" stopColor="#EC4899" />
                  </linearGradient>
                  <linearGradient id="sfSalesAreaGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#A855F7" stopOpacity="0.45" />
                    <stop offset="65%" stopColor="#7C3AED" stopOpacity="0.16" />
                    <stop offset="100%" stopColor="#070D1F" stopOpacity="0.0" />
                  </linearGradient>
                  <filter id="sfNeonGlow" x="-15%" y="-15%" width="130%" height="130%">
                    <feGaussianBlur stdDeviation="3.5" result="blur" />
                    <feMerge>
                      <feMergeNode in="blur" />
                      <feMergeNode in="SourceGraphic" />
                    </feMerge>
                  </filter>
                </defs>

                {/* Horizontal Gridlines & Y-Axis Labels */}
                {[0, 0.25, 0.5, 0.75, 1].map((ratio, idx) => {
                  const usableH = SVG_H - PAD_T - PAD_B;
                  const y = PAD_T + usableH - ratio * usableH;
                  const tickVal = Math.round(chartGeometry.niceMax * ratio);
                  return (
                    <g key={idx}>
                      <line
                        x1={PAD_L}
                        x2={SVG_W - PAD_R}
                        y1={y}
                        y2={y}
                        stroke="rgba(148, 163, 184, 0.13)"
                        strokeWidth="1"
                      />
                      <text
                        x={PAD_L - 8}
                        y={y + 4}
                        textAnchor="end"
                        fill="#94A3B8"
                        fontSize="11"
                        fontFamily="JetBrains Mono, monospace"
                      >
                        {formatCompactInr(tickVal)}
                      </text>
                    </g>
                  );
                })}

                {/* Area Gradient Fill */}
                {chartGeometry.areaPath && (
                  <path d={chartGeometry.areaPath} fill="url(#sfSalesAreaGrad)" />
                )}

                {/* Glowing Curve Line */}
                {chartGeometry.linePath && (
                  <path
                    d={chartGeometry.linePath}
                    fill="none"
                    stroke="url(#sfSalesLineGrad)"
                    strokeWidth="3"
                    strokeLinecap="round"
                    filter="url(#sfNeonGlow)"
                  />
                )}

                {/* Active Vertical Guideline */}
                {activeChartIndex !== null && chartGeometry.coords[activeChartIndex] && (
                  <line
                    x1={chartGeometry.coords[activeChartIndex].x}
                    x2={chartGeometry.coords[activeChartIndex].x}
                    y1={PAD_T}
                    y2={SVG_H - PAD_B}
                    stroke="rgba(232, 121, 249, 0.45)"
                    strokeDasharray="3 3"
                    strokeWidth="1.5"
                  />
                )}

                {/* Interactive Data Nodes */}
                {chartGeometry.coords.map((c) => {
                  const isActive = c.idx === activeChartIndex;
                  const hasValue = c.pt.revenue > 0;
                  return (
                    <g
                      key={c.pt.key}
                      onClick={() => setHoveredChartIdx(c.idx)}
                      className="cursor-pointer"
                    >
                      {isActive && (
                        <circle
                          cx={c.x}
                          cy={c.y}
                          r="10"
                          fill="rgba(217, 70, 239, 0.28)"
                        />
                      )}
                      {(hasValue || isActive || chartGeometry.coords.length <= 12) && (
                        <circle
                          cx={c.x}
                          cy={c.y}
                          r={isActive ? 5 : 3.2}
                          fill={isActive ? '#FFFFFF' : '#E9D5FF'}
                          stroke={isActive ? '#E879F9' : '#9333EA'}
                          strokeWidth={isActive ? 2.5 : 1.5}
                        />
                      )}
                    </g>
                  );
                })}

                {/* X-Axis Labels */}
                {chartGeometry.coords.map((c) =>
                  c.pt.axisLabel ? (
                    <text
                      key={`x-${c.pt.key}`}
                      x={c.x}
                      y={SVG_H - 8}
                      textAnchor="middle"
                      fill="#94A3B8"
                      fontSize="11"
                      fontFamily="Plus Jakarta Sans, sans-serif"
                    >
                      {c.pt.axisLabel}
                    </text>
                  ) : null
                )}

                {/* Floating Dark Tooltip Pill */}
                {activeChartIndex !== null && chartGeometry.coords[activeChartIndex] && (() => {
                  const c = chartGeometry.coords[activeChartIndex];
                  const boxW = 116;
                  const boxH = 42;
                  const clampedX = Math.min(Math.max(c.x - boxW / 2, PAD_L), SVG_W - PAD_R - boxW);
                  const aboveY = c.y - boxH - 12;
                  const boxY = aboveY >= 2 ? aboveY : Math.min(c.y + 12, SVG_H - PAD_B - boxH);
                  return (
                    <g className="pointer-events-none">
                      <rect
                        x={clampedX}
                        y={boxY}
                        width={boxW}
                        height={boxH}
                        rx="10"
                        fill="#0E1730"
                        stroke="rgba(192, 132, 252, 0.55)"
                        strokeWidth="1.2"
                      />
                      <text
                        x={clampedX + boxW / 2}
                        y={boxY + 17}
                        textAnchor="middle"
                        fill="#FFFFFF"
                        fontSize="12.5"
                        fontWeight="800"
                        fontFamily="JetBrains Mono, monospace"
                      >
                        {formatInr(c.pt.revenue)}
                      </text>
                      <text
                        x={clampedX + boxW / 2}
                        y={boxY + 33}
                        textAnchor="middle"
                        fill="#CBD5E1"
                        fontSize="9.5"
                        fontFamily="Plus Jakarta Sans, sans-serif"
                      >
                        {c.pt.tooltipTitle} • {c.pt.transactions} tx
                      </text>
                    </g>
                  );
                })()}
              </svg>
            </div>
          )}
        </div>
      </section>

      {/* ============================================================ */}
      {/* TOP COURSES & RECENT SALES GRID                              */}
      {/* ============================================================ */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* TOP PERFORMING COURSES */}
        <section className="rounded-2xl sm:rounded-3xl bg-[#070D1F]/95 border border-indigo-500/20 p-3.5 sm:p-4 flex flex-col justify-between min-w-0">
          <div>
            <div className="flex items-center justify-between gap-2 mb-3">
              <div className="flex items-center gap-2 min-w-0">
                <Trophy className="w-4 h-4 text-amber-400 shrink-0" />
                <h3 className="brand-font text-sm sm:text-base font-bold text-white truncate">
                  Top Courses
                </h3>
                <span className="text-[10px] font-semibold text-slate-400 shrink-0">
                  ({TIMEFRAME_OPTIONS.find((t) => t.id === timeframe)?.dropdownLabel})
                </span>
              </div>
              <button
                type="button"
                onClick={() => {
                  setModalCourseSearch('');
                  setShowAllCoursesModal(true);
                }}
                className="min-h-[32px] px-2 py-1 rounded-lg text-xs font-bold text-purple-300 hover:text-purple-200 hover:bg-purple-500/10 flex items-center gap-1 shrink-0 cursor-pointer transition-colors"
              >
                <span>View All</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>

            {displayedTopCourses.length > 0 ? (
              <div className="space-y-2.5">
                {displayedTopCourses.map((course, idx) => {
                  const medalStyle =
                    idx === 0
                      ? 'bg-amber-400 text-slate-950 shadow-[0_0_12px_rgba(251,191,36,0.55)]'
                      : idx === 1
                      ? 'bg-slate-200 text-slate-950'
                      : idx === 2
                      ? 'bg-orange-400 text-slate-950'
                      : 'bg-slate-800 text-slate-300 border border-white/10';
                  return (
                    <div
                      key={course.courseKey}
                      className="p-2.5 rounded-xl bg-[#040814]/85 border border-white/5 hover:border-purple-400/30 transition-colors"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span
                          className={`w-5 h-5 rounded-full text-[10px] font-extrabold flex items-center justify-center shrink-0 tabular-nums ${medalStyle}`}
                        >
                          {idx + 1}
                        </span>
                        <CourseAvatar course={course} />
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-bold text-white truncate">
                            {course.courseName}
                          </p>
                          <p className="text-[10px] text-slate-400 font-mono tabular-nums truncate">
                            {course.purchases} purchase{course.purchases === 1 ? '' : 's'}
                          </p>
                        </div>
                        <div className="text-right shrink-0">
                          <p className="text-xs font-extrabold text-white font-mono tabular-nums">
                            {formatInr(course.revenue)}
                          </p>
                          <p className="text-[10px] font-bold text-cyan-300 font-mono tabular-nums">
                            {course.percentage}%
                          </p>
                        </div>
                      </div>
                      {/* Percentage Progress Bar */}
                      <div className="mt-2 h-1 w-full rounded-full bg-slate-800/80 overflow-hidden">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-cyan-400 via-blue-500 to-purple-500"
                          style={{ width: `${Math.min(Math.max(course.percentage, 3), 100)}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="py-8 px-3 text-center rounded-xl bg-[#040814]/60 border border-dashed border-white/10">
                <p className="text-xs text-slate-400">
                  No course sales in this timeframe yet.
                </p>
                {analytics.allTimeTopCourses.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowAllCoursesModal(true)}
                    className="mt-2 text-xs font-bold text-cyan-300 hover:text-cyan-200 cursor-pointer"
                  >
                    View Lifetime Top Courses →
                  </button>
                )}
              </div>
            )}
          </div>
        </section>

        {/* RECENT SALES */}
        <section className="rounded-2xl sm:rounded-3xl bg-[#070D1F]/95 border border-indigo-500/20 p-3.5 sm:p-4 flex flex-col justify-between min-w-0">
          <div>
            <div className="flex items-center justify-between gap-2 mb-3">
              <div className="flex items-center gap-2 min-w-0">
                <Zap className="w-4 h-4 text-amber-400 shrink-0" />
                <h3 className="brand-font text-sm sm:text-base font-bold text-white truncate">
                  Recent Sales
                </h3>
                <span className="text-[10px] font-semibold text-slate-400 shrink-0">
                  ({TIMEFRAME_OPTIONS.find((t) => t.id === timeframe)?.dropdownLabel})
                </span>
              </div>
              <button
                type="button"
                onClick={() => {
                  setModalSalesSearch('');
                  setModalSalesScope(analytics.selected.recentSales.length > 0 ? 'selected' : 'all');
                  setShowAllSalesModal(true);
                }}
                className="min-h-[32px] px-2 py-1 rounded-lg text-xs font-bold text-purple-300 hover:text-purple-200 hover:bg-purple-500/10 flex items-center gap-1 shrink-0 cursor-pointer transition-colors"
              >
                <span>View All</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>

            {displayedRecentSales.length > 0 ? (
              <div className="space-y-2">
                {displayedRecentSales.map((tx) => (
                  <div
                    key={tx.canonicalKey}
                    className="p-2.5 rounded-xl bg-[#040814]/85 border border-white/5 hover:border-cyan-400/30 transition-colors flex items-center justify-between gap-2.5 min-w-0"
                  >
                    <div className="flex items-center gap-2.5 min-w-0 flex-1">
                      <div className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-500/30 to-purple-500/30 border border-indigo-400/35 flex items-center justify-center text-[10px] font-extrabold text-indigo-200 shrink-0">
                        {getStudentInitials(tx.studentName)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <p className="text-xs font-bold text-white truncate">
                            {tx.studentName}
                          </p>
                          <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" />
                        </div>
                        <p className="text-[10px] text-slate-400 truncate">
                          {tx.studentEmail || 'Verified student'}
                        </p>
                        <p className="text-[10px] text-cyan-300/90 font-medium truncate mt-0.5">
                          {tx.courseName}
                        </p>
                      </div>
                    </div>

                    <div className="text-right shrink-0">
                      <p className="text-xs sm:text-sm font-extrabold text-emerald-400 font-mono tabular-nums">
                        {formatInr(tx.amount)}
                      </p>
                      <p className="text-[10px] text-slate-400 tabular-nums">
                        {formatRelativeIstTime(tx.timestampMs)}
                      </p>
                      <span className="inline-block text-[9px] font-bold uppercase tracking-wider text-emerald-300/90 mt-0.5">
                        Approved
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-8 px-3 text-center rounded-xl bg-[#040814]/60 border border-dashed border-white/10">
                <p className="text-xs text-slate-400">
                  No verified transactions in this timeframe.
                </p>
                {analytics.allTimeRecentSales.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setModalSalesScope('all');
                      setShowAllSalesModal(true);
                    }}
                    className="mt-2 text-xs font-bold text-cyan-300 hover:text-cyan-200 cursor-pointer"
                  >
                    Browse All {analytics.allTimeRecentSales.length} Historical Sales →
                  </button>
                )}
              </div>
            )}
          </div>
        </section>
      </div>

      {/* ============================================================ */}
      {/* REVENUE BREAKDOWN DONUT CHART                                */}
      {/* ============================================================ */}
      <section className="rounded-2xl sm:rounded-3xl bg-[#070D1F]/95 border border-indigo-500/20 p-3.5 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-8 h-8 rounded-xl bg-purple-500/15 border border-purple-400/30 flex items-center justify-center shrink-0">
              <PieChartIcon className="w-4 h-4 text-purple-300" />
            </div>
            <div>
              <h3 className="brand-font text-sm sm:text-base font-bold text-white">
                Revenue Breakdown
              </h3>
              <p className="text-[11px] text-slate-400">
                Distribution across Individual Courses, All-Access Plans &amp; Other Categories
              </p>
            </div>
          </div>
          <span className="text-[11px] font-bold text-slate-300 font-mono tabular-nums">
            {TIMEFRAME_OPTIONS.find((t) => t.id === timeframe)?.dropdownLabel} • {formatInr(donutMeta.total)}
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-12 gap-4 items-center">
          {/* Interactive SVG Donut Chart */}
          <div className="sm:col-span-5 flex items-center justify-center">
            <div className="relative w-40 h-40 sm:w-44 sm:h-44 flex items-center justify-center">
              <svg viewBox="0 0 140 140" className="w-full h-full -rotate-90" role="img" aria-label="Revenue breakdown donut chart">
                {/* Base Ring */}
                <circle
                  cx="70"
                  cy="70"
                  r={donutMeta.radius}
                  fill="none"
                  stroke="rgba(148, 163, 184, 0.12)"
                  strokeWidth="16"
                />
                {donutMeta.total > 0 &&
                  donutMeta.segments.map((seg) => {
                    if (seg.revenue <= 0) return null;
                    const isSelected = activeSliceKey === seg.key;
                    return (
                      <circle
                        key={seg.key}
                        cx="70"
                        cy="70"
                        r={donutMeta.radius}
                        fill="none"
                        stroke={seg.color}
                        strokeWidth={isSelected ? 20 : 16}
                        strokeDasharray={seg.dashArray}
                        strokeDashoffset={seg.dashOffset}
                        strokeLinecap="butt"
                        onMouseEnter={() => setActiveSliceKey(seg.key)}
                        onMouseLeave={() => setActiveSliceKey(null)}
                        onClick={() => setActiveSliceKey(isSelected ? null : seg.key)}
                        className="cursor-pointer transition-all duration-200"
                        style={{
                          filter: isSelected ? `drop-shadow(0 0 8px ${seg.glowColor})` : undefined
                        }}
                      />
                    );
                  })}
              </svg>

              {/* Center Metric Readout */}
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center px-3">
                <span className="text-[9px] uppercase tracking-wider text-slate-400 font-bold truncate max-w-[96px]">
                  {activeDonutSlice ? activeDonutSlice.label.split(' ')[0] : 'Net Sales'}
                </span>
                <span className="brand-font text-sm sm:text-base font-extrabold text-white tabular-nums mt-0.5">
                  {activeDonutSlice ? formatInr(activeDonutSlice.revenue) : formatInr(donutMeta.total)}
                </span>
                <span className="text-[10px] font-mono text-cyan-300 tabular-nums">
                  {activeDonutSlice
                    ? `${activeDonutSlice.percentage}%`
                    : `${analytics.selected.transactions} tx`}
                </span>
              </div>
            </div>
          </div>

          {/* Breakdown Legend & Exact Percentages */}
          <div className="sm:col-span-7 space-y-2.5">
            {donutMeta.segments.map((seg) => {
              const isSelected = activeSliceKey === seg.key;
              return (
                <button
                  key={seg.key}
                  type="button"
                  onClick={() => setActiveSliceKey(isSelected ? null : seg.key)}
                  className={`w-full text-left p-2.5 sm:p-3 rounded-xl border transition-all cursor-pointer ${
                    isSelected
                      ? 'bg-[#0C1736] border-white/25'
                      : 'bg-[#040814]/80 border-white/5 hover:border-white/15'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className="w-3 h-3 rounded-full shrink-0"
                        style={{ backgroundColor: seg.color, boxShadow: `0 0 10px ${seg.glowColor}` }}
                      />
                      <span className="text-xs font-bold text-white truncate">
                        {seg.label}
                      </span>
                    </div>
                    <div className="text-right shrink-0 flex items-center gap-2">
                      <span className="text-xs font-extrabold text-white font-mono tabular-nums">
                        {formatInr(seg.revenue)}
                      </span>
                      <span className="text-[11px] font-bold font-mono tabular-nums" style={{ color: seg.color }}>
                        {seg.percentage}%
                      </span>
                    </div>
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <div className="flex-1 h-1.5 rounded-full bg-slate-800/80 overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all duration-300"
                        style={{
                          width: `${Math.min(Math.max(seg.percentage, seg.revenue > 0 ? 3 : 0), 100)}%`,
                          backgroundColor: seg.color
                        }}
                      />
                    </div>
                    <span className="text-[10px] text-slate-400 font-mono tabular-nums shrink-0">
                      {seg.transactions} order{seg.transactions === 1 ? '' : 's'}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {/* ============================================================ */}
      {/* BOTTOM BANNER: TOTAL EARNINGS SO FAR                         */}
      {/* ============================================================ */}
      <section className="relative overflow-hidden rounded-2xl sm:rounded-3xl bg-gradient-to-r from-[#0C1430] via-[#13123A] to-[#0A1634] border border-purple-400/30 p-4 sm:p-5 shadow-[0_12px_36px_-14px_rgba(139,92,246,0.5)]">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3.5 min-w-0">
            <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-2xl bg-gradient-to-br from-amber-500/25 to-yellow-500/10 border border-amber-400/40 flex items-center justify-center shrink-0 shadow-[0_0_24px_-6px_rgba(245,158,11,0.65)]">
              <Crown className="w-6 h-6 sm:w-7 sm:h-7 text-amber-300" />
            </div>
            <div className="min-w-0">
              <p className="text-xs sm:text-sm font-semibold text-slate-300 truncate">
                Total Earnings So Far
              </p>
              <p className="brand-font text-2xl sm:text-3xl font-extrabold text-white tabular-nums tracking-tight truncate mt-0.5">
                {formatInr(analytics.lifetime.revenue)}
              </p>
              <p className="text-[10px] sm:text-xs text-slate-400 font-mono tabular-nums mt-0.5 truncate">
                {analytics.lifetime.transactions} verified payments • {analytics.lifetime.uniqueStudents} paying student{analytics.lifetime.uniqueStudents === 1 ? '' : 's'}
              </p>
            </div>
          </div>

          {/* Ascending Neon Bar + Arrow Graphic */}
          <svg
            viewBox="0 0 110 70"
            className="w-20 sm:w-28 h-14 sm:h-16 shrink-0 opacity-90"
            aria-hidden="true"
          >
            <defs>
              <linearGradient id="sfBannerBars" x1="0" y1="1" x2="1" y2="0">
                <stop offset="0%" stopColor="#06B6D4" />
                <stop offset="55%" stopColor="#3B82F6" />
                <stop offset="100%" stopColor="#A855F7" />
              </linearGradient>
            </defs>
            <rect x="8" y="48" width="11" height="18" rx="3" fill="url(#sfBannerBars)" opacity="0.55" />
            <rect x="25" y="39" width="11" height="27" rx="3" fill="url(#sfBannerBars)" opacity="0.7" />
            <rect x="42" y="30" width="11" height="36" rx="3" fill="url(#sfBannerBars)" opacity="0.82" />
            <rect x="59" y="21" width="11" height="45" rx="3" fill="url(#sfBannerBars)" opacity="0.92" />
            <rect x="76" y="13" width="11" height="53" rx="3" fill="url(#sfBannerBars)" />
            <path
              d="M 10 42 Q 48 34 89 9 M 81 8 L 91 7 L 89 17"
              fill="none"
              stroke="#C084FC"
              strokeWidth="3.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      </section>

      {/* ============================================================ */}
      {/* VIEW ALL TOP COURSES MODAL                                   */}
      {/* ============================================================ */}
      {showAllCoursesModal && (
        <div
          className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={() => setShowAllCoursesModal(false)}
        >
          <div
            className="w-full sm:max-w-lg max-h-[85vh] bg-[#080F24] border border-indigo-500/30 rounded-t-3xl sm:rounded-3xl flex flex-col overflow-hidden shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-4 border-b border-white/10 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Trophy className="w-5 h-5 text-amber-400" />
                <div>
                  <h4 className="brand-font text-base font-bold text-white">All Top Performing Courses</h4>
                  <p className="text-[11px] text-slate-400">
                    Ranked by verified lifetime revenue ({analytics.allTimeTopCourses.length} total)
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowAllCoursesModal(false)}
                className="min-h-[40px] min-w-[40px] rounded-xl bg-white/5 hover:bg-white/10 flex items-center justify-center text-slate-300 cursor-pointer"
                aria-label="Close top courses modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-3 border-b border-white/5">
              <div className="relative">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  value={modalCourseSearch}
                  onChange={(e) => setModalCourseSearch(e.target.value)}
                  placeholder="Search courses..."
                  className="w-full pl-9 pr-3 py-2 rounded-xl bg-[#040814] border border-white/10 focus:border-cyan-400 text-xs text-white outline-none"
                />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-3 space-y-2">
              {modalCoursesList.length > 0 ? (
                modalCoursesList.map((course, idx) => (
                  <div
                    key={course.courseKey}
                    className="p-3 rounded-xl bg-[#040814] border border-white/5 flex items-center justify-between gap-3"
                  >
                    <div className="flex items-center gap-2.5 min-w-0 flex-1">
                      <span className="w-6 h-6 rounded-full bg-slate-800 text-xs font-extrabold text-slate-200 flex items-center justify-center shrink-0 tabular-nums">
                        {idx + 1}
                      </span>
                      <CourseAvatar course={course} />
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-bold text-white truncate">{course.courseName}</p>
                        <p className="text-[10px] text-slate-400 font-mono tabular-nums">
                          {course.purchases} verified sale{course.purchases === 1 ? '' : 's'}
                        </p>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-xs font-extrabold text-amber-300 font-mono tabular-nums">
                        {formatInr(course.revenue)}
                      </p>
                      <p className="text-[10px] text-cyan-300 font-mono tabular-nums">
                        {course.percentage}%
                      </p>
                    </div>
                  </div>
                ))
              ) : (
                <div className="py-10 text-center text-xs text-slate-400">
                  No matching courses found.
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* VIEW ALL RECENT SALES MODAL                                  */}
      {/* ============================================================ */}
      {showAllSalesModal && (
        <div
          className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={() => setShowAllSalesModal(false)}
        >
          <div
            className="w-full sm:max-w-2xl max-h-[88vh] bg-[#080F24] border border-indigo-500/30 rounded-t-3xl sm:rounded-3xl flex flex-col overflow-hidden shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-4 border-b border-white/10 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Zap className="w-5 h-5 text-amber-400" />
                <div>
                  <h4 className="brand-font text-base font-bold text-white">Verified Sales Ledger</h4>
                  <p className="text-[11px] text-slate-400 font-mono tabular-nums">
                    {modalSalesList.length} transaction{modalSalesList.length === 1 ? '' : 's'} shown
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowAllSalesModal(false)}
                className="min-h-[40px] min-w-[40px] rounded-xl bg-white/5 hover:bg-white/10 flex items-center justify-center text-slate-300 cursor-pointer"
                aria-label="Close sales ledger modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-3 border-b border-white/5 flex flex-col sm:flex-row gap-2">
              <div className="relative flex-1">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  value={modalSalesSearch}
                  onChange={(e) => setModalSalesSearch(e.target.value)}
                  placeholder="Search student name, email, course or UTR..."
                  className="w-full pl-9 pr-3 py-2 rounded-xl bg-[#040814] border border-white/10 focus:border-cyan-400 text-xs text-white outline-none"
                />
              </div>
              <div className="grid grid-cols-2 bg-[#040814] border border-white/10 rounded-xl p-1 gap-1 shrink-0">
                <button
                  type="button"
                  onClick={() => setModalSalesScope('selected')}
                  className={`px-3 py-1.5 rounded-lg text-[11px] font-bold cursor-pointer ${
                    modalSalesScope === 'selected' ? 'bg-purple-600 text-white' : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {TIMEFRAME_OPTIONS.find((t) => t.id === timeframe)?.label}
                </button>
                <button
                  type="button"
                  onClick={() => setModalSalesScope('all')}
                  className={`px-3 py-1.5 rounded-lg text-[11px] font-bold cursor-pointer ${
                    modalSalesScope === 'all' ? 'bg-purple-600 text-white' : 'text-slate-400 hover:text-white'
                  }`}
                >
                  All Time
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-3 space-y-2">
              {modalSalesList.length > 0 ? (
                modalSalesList.map((tx: NormalizedSaleTransaction) => (
                  <div
                    key={tx.canonicalKey}
                    className="p-3 rounded-xl bg-[#040814] border border-white/5 flex items-center justify-between gap-3"
                  >
                    <div className="flex items-center gap-2.5 min-w-0 flex-1">
                      <div className="w-9 h-9 rounded-full bg-indigo-500/20 border border-indigo-400/35 flex items-center justify-center text-[11px] font-extrabold text-indigo-200 shrink-0">
                        {getStudentInitials(tx.studentName)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <p className="text-xs font-bold text-white truncate">{tx.studentName}</p>
                          <span className="text-[9px] font-bold uppercase text-emerald-300 shrink-0">
                            Approved
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-400 truncate">
                          {tx.studentEmail || 'No email recorded'}
                        </p>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5 text-[10px]">
                          <span className="text-cyan-300 font-semibold truncate">{tx.courseName}</span>
                          {tx.utr && (
                            <span className="text-slate-500 font-mono truncate">UTR: {tx.utr}</span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="text-right shrink-0">
                      <p className="text-sm font-extrabold text-emerald-400 font-mono tabular-nums">
                        {formatInr(tx.amount)}
                      </p>
                      <p className="text-[10px] text-slate-400 font-mono tabular-nums">
                        {formatFullIstDateTime(tx.timestampMs)}
                      </p>
                    </div>
                  </div>
                ))
              ) : (
                <div className="py-12 text-center text-xs text-slate-400">
                  <Users className="w-7 h-7 text-slate-600 mx-auto mb-2" />
                  No verified transactions match your filter.
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
