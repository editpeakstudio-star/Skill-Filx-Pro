import {
  AnalyticsTimeframe,
  Category,
  NormalizedSaleTransaction,
  PaymentRequest,
  RevenueSegmentKey,
  SalesRecord,
  UserProfile
} from '../types';

export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // UTC+05:30 fixed offset (India has no DST)
const DAY_MS = 24 * 60 * 60 * 1000;

export interface PeriodSummaryMetrics {
  revenue: number;
  transactions: number;
  averageOrderValue: number;
  uniqueStudents: number;
  activePurchases: number;
  previousRevenue: number;
  previousTransactions: number;
  growthPercent: number | null; // null when previousRevenue === 0 && revenue > 0
  growthDirection: 'up' | 'down' | 'flat' | 'new';
  growthLabel: string;
  sparkline: number[];
}

export interface SalesChartPoint {
  key: string;
  label: string;
  axisLabel: string;
  tooltipTitle: string;
  revenue: number;
  transactions: number;
}

export interface TopCourseMetric {
  courseKey: string;
  courseName: string;
  thumbnailUrl?: string;
  segment: RevenueSegmentKey;
  purchases: number;
  revenue: number;
  percentage: number;
}

export interface RevenueBreakdownSlice {
  key: RevenueSegmentKey;
  label: string;
  revenue: number;
  transactions: number;
  percentage: number;
  color: string;
  glowColor: string;
}

export interface FilteredPeriodAnalytics {
  timeframe: AnalyticsTimeframe;
  revenue: number;
  transactions: number;
  averageOrderValue: number;
  uniqueStudents: number;
  previousRevenue: number;
  growthPercent: number | null;
  growthDirection: 'up' | 'down' | 'flat' | 'new';
  growthLabel: string;
  comparisonCaption: string;
  chartPoints: SalesChartPoint[];
  topCourses: TopCourseMetric[];
  recentSales: NormalizedSaleTransaction[];
  breakdown: RevenueBreakdownSlice[];
}

export interface FinancialAnalyticsDashboardData {
  allTransactions: NormalizedSaleTransaction[];
  today: PeriodSummaryMetrics;
  thisWeek: PeriodSummaryMetrics;
  thisMonth: PeriodSummaryMetrics;
  lifetime: PeriodSummaryMetrics;
  selected: FilteredPeriodAnalytics;
  allTimeTopCourses: TopCourseMetric[];
  allTimeRecentSales: NormalizedSaleTransaction[];
  istNowLabel: string;
}

/**
 * Safely converts Firestore Timestamp, Date, numeric epoch, or ISO string into epoch ms.
 */
export function parseFlexibleTimestampMs(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'object') {
    const obj = value as { toDate?: () => Date; seconds?: number; nanoseconds?: number };
    if (typeof obj.toDate === 'function') {
      try {
        const ms = obj.toDate().getTime();
        return Number.isFinite(ms) ? ms : null;
      } catch {
        return null;
      }
    }
    if (typeof obj.seconds === 'number' && Number.isFinite(obj.seconds)) {
      const ms = obj.seconds * 1000 + Math.round((obj.nanoseconds || 0) / 1e6);
      return Number.isFinite(ms) ? ms : null;
    }
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const ms = new Date(trimmed).getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

export interface IstCalendarParts {
  year: number;
  month: number; // 0-indexed (0=Jan..11=Dec)
  day: number; // 1..31
  dayOfWeek: number; // 0=Sun..6=Sat
  hour: number; // 0..23
  minute: number;
}

export function getIstParts(epochMs: number): IstCalendarParts {
  const shifted = new Date(epochMs + IST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    dayOfWeek: shifted.getUTCDay(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes()
  };
}

export function getIstDayBounds(epochMs: number): { startMs: number; endMs: number } {
  const { year, month, day } = getIstParts(epochMs);
  const startMs = Date.UTC(year, month, day, 0, 0, 0, 0) - IST_OFFSET_MS;
  return { startMs, endMs: startMs + DAY_MS - 1 };
}

/**
 * Week starts on Monday 00:00:00.000 IST and ends Sunday 23:59:59.999 IST.
 */
export function getIstWeekBounds(epochMs: number): { startMs: number; endMs: number } {
  const { year, month, day, dayOfWeek } = getIstParts(epochMs);
  const daysSinceMonday = (dayOfWeek + 6) % 7;
  const startMs = Date.UTC(year, month, day - daysSinceMonday, 0, 0, 0, 0) - IST_OFFSET_MS;
  return { startMs, endMs: startMs + 7 * DAY_MS - 1 };
}

export function getIstMonthBounds(epochMs: number): {
  startMs: number;
  endMs: number;
  daysInMonth: number;
  year: number;
  month: number;
} {
  const { year, month } = getIstParts(epochMs);
  const startMs = Date.UTC(year, month, 1, 0, 0, 0, 0) - IST_OFFSET_MS;
  const nextMonthStartMs = Date.UTC(year, month + 1, 1, 0, 0, 0, 0) - IST_OFFSET_MS;
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return { startMs, endMs: nextMonthStartMs - 1, daysInMonth, year, month };
}

export function getPreviousIstMonthBounds(epochMs: number): { startMs: number; endMs: number } {
  const { year, month } = getIstParts(epochMs);
  const startMs = Date.UTC(year, month - 1, 1, 0, 0, 0, 0) - IST_OFFSET_MS;
  const endMs = Date.UTC(year, month, 1, 0, 0, 0, 0) - IST_OFFSET_MS - 1;
  return { startMs, endMs };
}

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function formatInr(amount: number): string {
  const safe = Number.isFinite(amount) ? Math.round(amount) : 0;
  return `₹${safe.toLocaleString('en-IN')}`;
}

export function formatCompactInr(amount: number): string {
  const safe = Number.isFinite(amount) ? amount : 0;
  if (safe >= 10000000) return `₹${(safe / 10000000).toFixed(1).replace(/\.0$/, '')}Cr`;
  if (safe >= 100000) return `₹${(safe / 100000).toFixed(1).replace(/\.0$/, '')}L`;
  if (safe >= 1000) return `₹${(safe / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return `₹${Math.round(safe)}`;
}

export function formatRelativeIstTime(timestampMs: number, nowMs: number = Date.now()): string {
  const diffMs = nowMs - timestampMs;
  if (diffMs >= 0 && diffMs < 60 * 1000) return 'Just now';
  if (diffMs >= 60 * 1000 && diffMs < 60 * 60 * 1000) {
    const mins = Math.floor(diffMs / 60000);
    return `${mins} min ago`;
  }
  if (diffMs >= 60 * 60 * 1000 && diffMs < 24 * 60 * 60 * 1000) {
    const hrs = Math.floor(diffMs / 3600000);
    return `${hrs}h ago`;
  }
  const p = getIstParts(timestampMs);
  const currentYear = getIstParts(nowMs).year;
  const yearSuffix = p.year !== currentYear ? ` '${String(p.year).slice(-2)}` : '';
  return `${p.day} ${MONTH_SHORT[p.month]}${yearSuffix}`;
}

export function formatFullIstDateTime(timestampMs: number): string {
  try {
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    }).format(new Date(timestampMs));
  } catch {
    return new Date(timestampMs).toISOString();
  }
}

function isExcludedSaleRecord(sale: SalesRecord): boolean {
  if (!sale) return true;
  if (sale.isRefunded === true || Boolean(sale.refundedAt)) return true;
  const status = String(sale.status || '').trim().toLowerCase();
  if (
    status === 'pending' ||
    status === 'rejected' ||
    status === 'failed' ||
    status === 'refunded' ||
    status === 'cancelled'
  ) {
    return true;
  }
  const amount = Number(sale.amount);
  return !Number.isFinite(amount) || amount <= 0;
}

function resolveSegmentAndCourse(params: {
  planType?: string;
  planCategory?: string;
  categoryId?: string;
  categoryName?: string;
  categoriesById: Map<string, Category>;
  categoriesByLowerName: Map<string, Category>;
}): {
  segment: RevenueSegmentKey;
  courseKey: string;
  courseName: string;
  categoryId?: string;
  courseThumbnail?: string;
} {
  const rawPlanCategory = String(params.planCategory || '').trim().toLowerCase();
  const rawPlanType = String(params.planType || '').trim();
  const rawPlanLower = rawPlanType.toLowerCase();
  const rawCatName = String(params.categoryName || '').trim();

  const matchedCat =
    (params.categoryId ? params.categoriesById.get(params.categoryId) : undefined) ||
    (rawCatName ? params.categoriesByLowerName.get(rawCatName.toLowerCase()) : undefined) ||
    (rawPlanType ? params.categoriesByLowerName.get(rawPlanLower) : undefined);

  const isAllAccess =
    rawPlanCategory === 'all_access' ||
    rawPlanLower === 'all_access' ||
    /all[-\s]?access/.test(rawPlanLower);

  if (isAllAccess) {
    return {
      segment: 'all_access',
      courseKey: '__all_access__',
      courseName: 'All-Access Pro Plan',
      categoryId: undefined,
      courseThumbnail: undefined
    };
  }

  const isExplicitOther =
    rawPlanCategory === 'other' ||
    rawPlanLower === 'other' ||
    (!matchedCat && !rawCatName && (!rawPlanType || rawPlanLower === 'category pass'));

  if (isExplicitOther) {
    return {
      segment: 'other',
      courseKey: rawPlanType ? `other:${rawPlanLower}` : '__other__',
      courseName: rawCatName || rawPlanType || 'Other Payment',
      categoryId: params.categoryId,
      courseThumbnail: matchedCat?.thumbnailUrl
    };
  }

  const resolvedName = matchedCat?.name || rawCatName || rawPlanType || 'Course Pass';
  const resolvedKey = matchedCat?.id ? `cat:${matchedCat.id}` : `name:${resolvedName.toLowerCase()}`;

  return {
    segment: 'individual_course',
    courseKey: resolvedKey,
    courseName: resolvedName,
    categoryId: matchedCat?.id || params.categoryId,
    courseThumbnail: matchedCat?.thumbnailUrl
  };
}

/**
 * Reconciles and deduplicates verified successful financial transactions across
 * `sales_analytics` and `paymentRequests`, excluding pending, rejected, failed, and refunded records.
 */
export function normalizeFinancialTransactions(params: {
  sales: SalesRecord[];
  paymentRequests: PaymentRequest[];
  users: UserProfile[];
  categories: Category[];
}): NormalizedSaleTransaction[] {
  const { sales = [], paymentRequests = [], users = [], categories = [] } = params;

  const usersByUid = new Map<string, UserProfile>();
  const usersByEmail = new Map<string, UserProfile>();
  for (const u of users) {
    if (u?.uid) usersByUid.set(u.uid, u);
    if (u?.email) usersByEmail.set(u.email.trim().toLowerCase(), u);
  }

  const categoriesById = new Map<string, Category>();
  const categoriesByLowerName = new Map<string, Category>();
  for (const c of categories) {
    if (!c) continue;
    if (c.id) categoriesById.set(c.id, c);
    if (c.name) categoriesByLowerName.set(c.name.trim().toLowerCase(), c);
  }

  const requestsById = new Map<string, PaymentRequest>();
  const requestsByUtr = new Map<string, PaymentRequest>();
  for (const req of paymentRequests) {
    if (!req?.id) continue;
    requestsById.set(req.id, req);
    if (req.utr) {
      requestsByUtr.set(`${req.utr.trim().toLowerCase()}::${req.uid || req.userEmail?.toLowerCase() || ''}`, req);
    }
  }

  const canonicalMap = new Map<string, NormalizedSaleTransaction>();

  // 1. Process sales_analytics records, cross-checking linked paymentRequest status
  for (const sale of sales) {
    if (isExcludedSaleRecord(sale)) continue;

    const reqId = String(sale.requestId || '').trim();
    const linkedReq = reqId ? requestsById.get(reqId) : undefined;

    // If a linked payment request exists and is NOT approved (e.g. rejected/pending), skip this sale
    if (linkedReq && linkedReq.status !== 'approved') {
      continue;
    }

    const canonicalKey = reqId || sale.id;
    if (!canonicalKey || canonicalMap.has(canonicalKey)) continue;

    const amount = Number(linkedReq?.amount ?? sale.amount);
    if (!Number.isFinite(amount) || amount <= 0) continue;

    const timestampMs =
      parseFlexibleTimestampMs(linkedReq?.resolvedAt) ??
      parseFlexibleTimestampMs(sale.date) ??
      parseFlexibleTimestampMs(linkedReq?.submittedAt);
    if (timestampMs === null) continue;

    const rawUid = String(linkedReq?.uid || sale.uid || '').trim();
    const rawEmail = String(linkedReq?.userEmail || sale.userEmail || '').trim();
    const matchedUser =
      (rawUid ? usersByUid.get(rawUid) : undefined) ||
      (rawEmail ? usersByEmail.get(rawEmail.toLowerCase()) : undefined);

    const studentEmail = rawEmail || matchedUser?.email || '';
    const fallbackEmailName = studentEmail ? studentEmail.split('@')[0] : '';
    const studentName =
      String(linkedReq?.userName || sale.userName || matchedUser?.displayName || fallbackEmailName || 'Skill-Flix Student').trim() ||
      'Skill-Flix Student';
    const studentUid = rawUid || matchedUser?.uid || '';
    const studentKey = studentUid
      ? `uid:${studentUid}`
      : studentEmail
      ? `email:${studentEmail.toLowerCase()}`
      : `tx:${canonicalKey}`;

    const courseMeta = resolveSegmentAndCourse({
      planType: linkedReq?.planType || sale.planType,
      planCategory: sale.planCategory || linkedReq?.planType,
      categoryId: linkedReq?.categoryId || sale.categoryId,
      categoryName: linkedReq?.categoryName || sale.categoryName,
      categoriesById,
      categoriesByLowerName
    });

    canonicalMap.set(canonicalKey, {
      id: sale.id,
      canonicalKey,
      source: linkedReq ? 'reconciled' : 'sales_analytics',
      paymentRequestId: linkedReq?.id || reqId || undefined,
      utr: linkedReq?.utr,
      uid: studentUid,
      studentKey,
      studentName,
      studentEmail,
      courseKey: courseMeta.courseKey,
      courseName: courseMeta.courseName,
      courseThumbnail: courseMeta.courseThumbnail,
      categoryId: courseMeta.categoryId,
      segment: courseMeta.segment,
      amount,
      timestampMs,
      isoDate: new Date(timestampMs).toISOString(),
      status: 'approved'
    });
  }

  // 2. Include approved paymentRequests not yet represented in sales_analytics (legacy / un-synced approvals)
  for (const req of paymentRequests) {
    if (!req?.id || req.status !== 'approved') continue;
    const canonicalKey = req.id;
    if (canonicalMap.has(canonicalKey)) continue;

    const amount = Number(req.amount);
    if (!Number.isFinite(amount) || amount <= 0) continue;

    const timestampMs =
      parseFlexibleTimestampMs(req.resolvedAt) ?? parseFlexibleTimestampMs(req.submittedAt);
    if (timestampMs === null) continue;

    const rawUid = String(req.uid || '').trim();
    const rawEmail = String(req.userEmail || '').trim();
    const matchedUser =
      (rawUid ? usersByUid.get(rawUid) : undefined) ||
      (rawEmail ? usersByEmail.get(rawEmail.toLowerCase()) : undefined);

    const studentEmail = rawEmail || matchedUser?.email || '';
    const fallbackEmailName = studentEmail ? studentEmail.split('@')[0] : '';
    const studentName =
      String(req.userName || matchedUser?.displayName || fallbackEmailName || 'Skill-Flix Student').trim() ||
      'Skill-Flix Student';
    const studentUid = rawUid || matchedUser?.uid || '';
    const studentKey = studentUid
      ? `uid:${studentUid}`
      : studentEmail
      ? `email:${studentEmail.toLowerCase()}`
      : `tx:${canonicalKey}`;

    const courseMeta = resolveSegmentAndCourse({
      planType: req.planType,
      planCategory: req.planType,
      categoryId: req.categoryId,
      categoryName: req.categoryName,
      categoriesById,
      categoriesByLowerName
    });

    canonicalMap.set(canonicalKey, {
      id: req.id,
      canonicalKey,
      source: 'payment_request',
      paymentRequestId: req.id,
      utr: req.utr,
      uid: studentUid,
      studentKey,
      studentName,
      studentEmail,
      courseKey: courseMeta.courseKey,
      courseName: courseMeta.courseName,
      courseThumbnail: courseMeta.courseThumbnail,
      categoryId: courseMeta.categoryId,
      segment: courseMeta.segment,
      amount,
      timestampMs,
      isoDate: new Date(timestampMs).toISOString(),
      status: 'approved'
    });
  }

  return Array.from(canonicalMap.values()).sort((a, b) => b.timestampMs - a.timestampMs);
}

function computeGrowth(currentRevenue: number, previousRevenue: number): {
  growthPercent: number | null;
  growthDirection: 'up' | 'down' | 'flat' | 'new';
  growthLabel: string;
} {
  if (previousRevenue <= 0 && currentRevenue <= 0) {
    return { growthPercent: 0, growthDirection: 'flat', growthLabel: '0%' };
  }
  if (previousRevenue <= 0 && currentRevenue > 0) {
    return { growthPercent: null, growthDirection: 'new', growthLabel: 'New' };
  }
  const pct = ((currentRevenue - previousRevenue) / previousRevenue) * 100;
  const rounded = Math.round(pct * 10) / 10;
  const displayPct = Number.isInteger(rounded) ? `${Math.abs(rounded)}%` : `${Math.abs(rounded).toFixed(1)}%`;
  if (rounded > 0) {
    return { growthPercent: rounded, growthDirection: 'up', growthLabel: `+${displayPct}` };
  }
  if (rounded < 0) {
    return { growthPercent: rounded, growthDirection: 'down', growthLabel: `-${displayPct}` };
  }
  return { growthPercent: 0, growthDirection: 'flat', growthLabel: '0%' };
}

function summarizeTransactions(txs: NormalizedSaleTransaction[]): {
  revenue: number;
  transactions: number;
  averageOrderValue: number;
  uniqueStudents: number;
  activePurchases: number;
} {
  let revenue = 0;
  const students = new Set<string>();
  for (const tx of txs) {
    revenue += tx.amount;
    students.add(tx.studentKey);
  }
  const transactions = txs.length;
  return {
    revenue,
    transactions,
    averageOrderValue: transactions > 0 ? Math.round(revenue / transactions) : 0,
    uniqueStudents: students.size,
    activePurchases: transactions
  };
}

function buildHourlyBuckets(txs: NormalizedSaleTransaction[], dayStartMs: number): SalesChartPoint[] {
  const buckets: SalesChartPoint[] = [];
  for (let h = 0; h < 24; h++) {
    const label12 =
      h === 0 ? '12AM' : h < 12 ? `${h}AM` : h === 12 ? '12PM' : `${h - 12}PM`;
    const next12 =
      h === 23 ? '12AM' : h + 1 < 12 ? `${h + 1}AM` : h + 1 === 12 ? '12PM' : `${h + 1 - 12}PM`;
    const showAxis = h === 0 || h === 6 || h === 12 || h === 18 || h === 23;
    buckets.push({
      key: `h-${h}`,
      label: label12,
      axisLabel: showAxis ? label12 : '',
      tooltipTitle: `${label12} – ${next12} IST`,
      revenue: 0,
      transactions: 0
    });
  }
  for (const tx of txs) {
    const idx = Math.floor((tx.timestampMs - dayStartMs) / 3600000);
    if (idx >= 0 && idx < 24) {
      buckets[idx].revenue += tx.amount;
      buckets[idx].transactions += 1;
    }
  }
  return buckets;
}

function buildWeeklyBuckets(txs: NormalizedSaleTransaction[], weekStartMs: number): SalesChartPoint[] {
  const buckets: SalesChartPoint[] = WEEKDAY_LABELS.map((dayName, idx) => {
    const bucketMidMs = weekStartMs + idx * DAY_MS + 12 * 3600 * 1000;
    const parts = getIstParts(bucketMidMs);
    return {
      key: `w-${idx}`,
      label: dayName,
      axisLabel: dayName,
      tooltipTitle: `${dayName}, ${parts.day} ${MONTH_SHORT[parts.month]}`,
      revenue: 0,
      transactions: 0
    };
  });
  for (const tx of txs) {
    const idx = Math.floor((tx.timestampMs - weekStartMs) / DAY_MS);
    if (idx >= 0 && idx < 7) {
      buckets[idx].revenue += tx.amount;
      buckets[idx].transactions += 1;
    }
  }
  return buckets;
}

function buildMonthlyBuckets(
  txs: NormalizedSaleTransaction[],
  monthStartMs: number,
  daysInMonth: number,
  monthIndex: number
): SalesChartPoint[] {
  const monthName = MONTH_SHORT[monthIndex];
  const buckets: SalesChartPoint[] = [];
  const axisInterval = daysInMonth <= 28 ? 6 : 7;
  for (let d = 1; d <= daysInMonth; d++) {
    const showAxis = d === 1 || d % axisInterval === 0 || d === daysInMonth;
    buckets.push({
      key: `d-${d}`,
      label: `${d} ${monthName}`,
      axisLabel: showAxis ? `${d}` : '',
      tooltipTitle: `${d} ${monthName} (IST)`,
      revenue: 0,
      transactions: 0
    });
  }
  for (const tx of txs) {
    const idx = Math.floor((tx.timestampMs - monthStartMs) / DAY_MS);
    if (idx >= 0 && idx < daysInMonth) {
      buckets[idx].revenue += tx.amount;
      buckets[idx].transactions += 1;
    }
  }
  return buckets;
}

function buildLifetimeBuckets(txs: NormalizedSaleTransaction[], nowMs: number): SalesChartPoint[] {
  if (txs.length === 0) {
    const p = getIstParts(nowMs);
    return [
      {
        key: `${p.year}-${p.month}`,
        label: `${MONTH_SHORT[p.month]} ${String(p.year).slice(-2)}`,
        axisLabel: `${MONTH_SHORT[p.month]}`,
        tooltipTitle: `${MONTH_SHORT[p.month]} ${p.year}`,
        revenue: 0,
        transactions: 0
      }
    ];
  }

  let minMs = nowMs;
  let maxMs = 0;
  for (const tx of txs) {
    if (tx.timestampMs < minMs) minMs = tx.timestampMs;
    if (tx.timestampMs > maxMs) maxMs = tx.timestampMs;
  }
  const endRefMs = Math.max(nowMs, maxMs);
  const startParts = getIstParts(minMs);
  const endParts = getIstParts(endRefMs);

  const monthBuckets = new Map<string, SalesChartPoint>();
  let y = startParts.year;
  let m = startParts.month;
  const totalMonths = (endParts.year - startParts.year) * 12 + (endParts.month - startParts.month) + 1;

  // Guard against absurd dates (e.g. corrupt year 1970); cap range at 60 months unless data is inside
  const safeMonthsCount = Math.min(Math.max(totalMonths, 1), 60);
  if (totalMonths > 60) {
    const shiftedStart = endParts.year * 12 + endParts.month - 59;
    y = Math.floor(shiftedStart / 12);
    m = shiftedStart % 12;
  }

  for (let i = 0; i < safeMonthsCount; i++) {
    const curMonthIndex = (y * 12 + m + i);
    const cy = Math.floor(curMonthIndex / 12);
    const cm = curMonthIndex % 12;
    const key = `${cy}-${String(cm + 1).padStart(2, '0')}`;
    const shortLabel = `${MONTH_SHORT[cm]} '${String(cy).slice(-2)}`;
    monthBuckets.set(key, {
      key,
      label: shortLabel,
      axisLabel: shortLabel,
      tooltipTitle: `${MONTH_SHORT[cm]} ${cy}`,
      revenue: 0,
      transactions: 0
    });
  }

  for (const tx of txs) {
    const p = getIstParts(tx.timestampMs);
    const key = `${p.year}-${String(p.month + 1).padStart(2, '0')}`;
    const existing = monthBuckets.get(key);
    if (existing) {
      existing.revenue += tx.amount;
      existing.transactions += 1;
    }
  }

  const ordered = Array.from(monthBuckets.values());
  // Thin out axis labels if > 6 months
  if (ordered.length > 6) {
    const step = Math.ceil(ordered.length / 5);
    ordered.forEach((pt, idx) => {
      if (idx !== 0 && idx !== ordered.length - 1 && idx % step !== 0) {
        pt.axisLabel = '';
      }
    });
  }
  return ordered;
}

function buildTopCourses(txs: NormalizedSaleTransaction[], totalRevenue: number): TopCourseMetric[] {
  const map = new Map<string, TopCourseMetric>();
  for (const tx of txs) {
    const existing = map.get(tx.courseKey);
    if (existing) {
      existing.purchases += 1;
      existing.revenue += tx.amount;
      if (!existing.thumbnailUrl && tx.courseThumbnail) {
        existing.thumbnailUrl = tx.courseThumbnail;
      }
    } else {
      map.set(tx.courseKey, {
        courseKey: tx.courseKey,
        courseName: tx.courseName,
        thumbnailUrl: tx.courseThumbnail,
        segment: tx.segment,
        purchases: 1,
        revenue: tx.amount,
        percentage: 0
      });
    }
  }

  const rows = Array.from(map.values()).sort((a, b) => {
    if (b.revenue !== a.revenue) return b.revenue - a.revenue;
    return b.purchases - a.purchases;
  });

  return rows.map((row) => ({
    ...row,
    percentage: totalRevenue > 0 ? Math.round((row.revenue / totalRevenue) * 1000) / 10 : 0
  }));
}

function buildRevenueBreakdown(txs: NormalizedSaleTransaction[], totalRevenue: number): RevenueBreakdownSlice[] {
  const groups: Record<RevenueSegmentKey, { revenue: number; transactions: number }> = {
    individual_course: { revenue: 0, transactions: 0 },
    all_access: { revenue: 0, transactions: 0 },
    other: { revenue: 0, transactions: 0 }
  };

  for (const tx of txs) {
    groups[tx.segment].revenue += tx.amount;
    groups[tx.segment].transactions += 1;
  }

  const defs: Array<{ key: RevenueSegmentKey; label: string; color: string; glowColor: string }> = [
    {
      key: 'individual_course',
      label: 'Individual Courses',
      color: '#22D3EE',
      glowColor: 'rgba(34, 211, 238, 0.45)'
    },
    {
      key: 'all_access',
      label: 'All-Access Plans',
      color: '#A855F7',
      glowColor: 'rgba(168, 85, 247, 0.45)'
    },
    {
      key: 'other',
      label: 'Other Categories',
      color: '#F59E0B',
      glowColor: 'rgba(245, 158, 11, 0.45)'
    }
  ];

  return defs.map((def) => {
    const entry = groups[def.key];
    return {
      key: def.key,
      label: def.label,
      revenue: entry.revenue,
      transactions: entry.transactions,
      percentage: totalRevenue > 0 ? Math.round((entry.revenue / totalRevenue) * 1000) / 10 : 0,
      color: def.color,
      glowColor: def.glowColor
    };
  });
}

function compressSparkline(values: number[], targetPoints: number = 8): number[] {
  if (values.length === 0) return Array(targetPoints).fill(0);
  if (values.length <= targetPoints) return values;
  const chunk = values.length / targetPoints;
  const result: number[] = [];
  for (let i = 0; i < targetPoints; i++) {
    const start = Math.floor(i * chunk);
    const end = Math.floor((i + 1) * chunk);
    let sum = 0;
    for (let j = start; j < end; j++) {
      sum += values[j] || 0;
    }
    result.push(sum);
  }
  return result;
}

/**
 * Computes complete real-time financial & sales analytics in Indian Standard Time (IST).
 */
export function computeFinancialAnalytics(params: {
  sales: SalesRecord[];
  paymentRequests: PaymentRequest[];
  users: UserProfile[];
  categories: Category[];
  timeframe: AnalyticsTimeframe;
  nowMs?: number;
}): FinancialAnalyticsDashboardData {
  const nowMs = params.nowMs ?? Date.now();
  const allTransactions = normalizeFinancialTransactions({
    sales: params.sales,
    paymentRequests: params.paymentRequests,
    users: params.users,
    categories: params.categories
  });

  // IST calendar boundaries
  const todayBounds = getIstDayBounds(nowMs);
  const yesterdayBounds = { startMs: todayBounds.startMs - DAY_MS, endMs: todayBounds.startMs - 1 };

  const weekBounds = getIstWeekBounds(nowMs);
  const prevWeekBounds = { startMs: weekBounds.startMs - 7 * DAY_MS, endMs: weekBounds.startMs - 1 };

  const monthBounds = getIstMonthBounds(nowMs);
  const prevMonthBounds = getPreviousIstMonthBounds(nowMs);

  const todayTxs = allTransactions.filter((t) => t.timestampMs >= todayBounds.startMs && t.timestampMs <= todayBounds.endMs);
  const yesterdayTxs = allTransactions.filter((t) => t.timestampMs >= yesterdayBounds.startMs && t.timestampMs <= yesterdayBounds.endMs);

  const weekTxs = allTransactions.filter((t) => t.timestampMs >= weekBounds.startMs && t.timestampMs <= weekBounds.endMs);
  const prevWeekTxs = allTransactions.filter((t) => t.timestampMs >= prevWeekBounds.startMs && t.timestampMs <= prevWeekBounds.endMs);

  const monthTxs = allTransactions.filter((t) => t.timestampMs >= monthBounds.startMs && t.timestampMs <= monthBounds.endMs);
  const prevMonthTxs = allTransactions.filter((t) => t.timestampMs >= prevMonthBounds.startMs && t.timestampMs <= prevMonthBounds.endMs);

  const todayStats = summarizeTransactions(todayTxs);
  const yesterdayStats = summarizeTransactions(yesterdayTxs);
  const todayGrowth = computeGrowth(todayStats.revenue, yesterdayStats.revenue);

  const weekStats = summarizeTransactions(weekTxs);
  const prevWeekStats = summarizeTransactions(prevWeekTxs);
  const weekGrowth = computeGrowth(weekStats.revenue, prevWeekStats.revenue);

  const monthStats = summarizeTransactions(monthTxs);
  const prevMonthStats = summarizeTransactions(prevMonthTxs);
  const monthGrowth = computeGrowth(monthStats.revenue, prevMonthStats.revenue);

  const lifetimeStats = summarizeTransactions(allTransactions);

  const dayBuckets = buildHourlyBuckets(todayTxs, todayBounds.startMs);
  const weekBuckets = buildWeeklyBuckets(weekTxs, weekBounds.startMs);
  const monthBuckets = buildMonthlyBuckets(monthTxs, monthBounds.startMs, monthBounds.daysInMonth, monthBounds.month);
  const lifetimeBuckets = buildLifetimeBuckets(allTransactions, nowMs);

  const today: PeriodSummaryMetrics = {
    ...todayStats,
    previousRevenue: yesterdayStats.revenue,
    previousTransactions: yesterdayStats.transactions,
    ...todayGrowth,
    sparkline: compressSparkline(dayBuckets.map((b) => b.revenue), 8)
  };

  const thisWeek: PeriodSummaryMetrics = {
    ...weekStats,
    previousRevenue: prevWeekStats.revenue,
    previousTransactions: prevWeekStats.transactions,
    ...weekGrowth,
    sparkline: weekBuckets.map((b) => b.revenue)
  };

  const thisMonth: PeriodSummaryMetrics = {
    ...monthStats,
    previousRevenue: prevMonthStats.revenue,
    previousTransactions: prevMonthStats.transactions,
    ...monthGrowth,
    sparkline: compressSparkline(monthBuckets.map((b) => b.revenue), 8)
  };

  const lifetime: PeriodSummaryMetrics = {
    ...lifetimeStats,
    previousRevenue: 0,
    previousTransactions: 0,
    growthPercent: null,
    growthDirection: lifetimeStats.revenue > 0 ? 'up' : 'flat',
    growthLabel: 'Total Earnings',
    sparkline: compressSparkline(lifetimeBuckets.map((b) => b.revenue), 8)
  };

  // Filtered view calculations
  let activeTxs = allTransactions;
  let activeMetrics = lifetime;
  let activeBuckets = lifetimeBuckets;
  let comparisonCaption = 'All verified historical transactions';

  if (params.timeframe === 'day') {
    activeTxs = todayTxs;
    activeMetrics = today;
    activeBuckets = dayBuckets;
    comparisonCaption = `vs Yesterday (${formatInr(yesterdayStats.revenue)})`;
  } else if (params.timeframe === 'week') {
    activeTxs = weekTxs;
    activeMetrics = thisWeek;
    activeBuckets = weekBuckets;
    comparisonCaption = `vs Previous Week (${formatInr(prevWeekStats.revenue)})`;
  } else if (params.timeframe === 'month') {
    activeTxs = monthTxs;
    activeMetrics = thisMonth;
    activeBuckets = monthBuckets;
    comparisonCaption = `vs Last Month (${formatInr(prevMonthStats.revenue)})`;
  }

  const allTimeTopCourses = buildTopCourses(allTransactions, lifetime.revenue);

  const selected: FilteredPeriodAnalytics = {
    timeframe: params.timeframe,
    revenue: activeMetrics.revenue,
    transactions: activeMetrics.transactions,
    averageOrderValue: activeMetrics.averageOrderValue,
    uniqueStudents: activeMetrics.uniqueStudents,
    previousRevenue: activeMetrics.previousRevenue,
    growthPercent: activeMetrics.growthPercent,
    growthDirection: activeMetrics.growthDirection,
    growthLabel: activeMetrics.growthLabel,
    comparisonCaption,
    chartPoints: activeBuckets,
    topCourses: buildTopCourses(activeTxs, activeMetrics.revenue),
    recentSales: activeTxs,
    breakdown: buildRevenueBreakdown(activeTxs, activeMetrics.revenue)
  };

  return {
    allTransactions,
    today,
    thisWeek,
    thisMonth,
    lifetime,
    selected,
    allTimeTopCourses,
    allTimeRecentSales: allTransactions,
    istNowLabel: formatFullIstDateTime(nowMs)
  };
}
