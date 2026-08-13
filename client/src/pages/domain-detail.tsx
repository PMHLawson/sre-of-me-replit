import React, { useRef, useEffect, useState, useMemo } from 'react';
import { useLocation, useRoute } from 'wouter';
import { format, parseISO } from 'date-fns';
import { ArrowLeft, Plus, Activity, BrainCircuit, Dumbbell, Music, CalendarOff } from 'lucide-react';
import { useAppStore, Domain, DOMAIN_POLICY, findActiveDeviationAt, type Session } from '@/store';
import { buildChartData, buildTodayDatum, sumWindowMinutes, sumTodayMinutes, type ChartDatum } from '@/lib/domain-detail-aggregation';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ReferenceLine, ReferenceArea, Cell, ResponsiveContainer } from 'recharts';
import { ThemeToggle } from '@/components/theme-toggle';
import { EscalationCard, EscalationTimeline } from '@/components/escalation-surface';
import { SessionEditDialog } from '@/components/session-actions/session-edit-dialog';
import { SessionDeleteDialog } from '@/components/session-actions/session-delete-dialog';
import { ActivityLog } from '@/components/activity-log';
import { OverachievementBadge } from '@/components/overachievement-badge';
import { buildActivityLog } from '@/lib/activity-log';

// Documented palette (ADR-014 / 40.30.OCMP.915) — hardcoded hex required for Recharts SVG
const DOMAIN_COLOR: Record<Domain, string> = {
  'martial-arts': '#C8743A',  // Grounded energy / orange-bronze
  'meditation':   '#6B8EC4',  // Contemplative calm / slate-blue
  'fitness':      '#5FAE6E',  // Vitality / green
  'music':        '#7A6FD6',  // Creative reflection / purple
};

// SOMR-327: ranges are 7/14/28/42 — multiples of 7 days (complete weeks).
const RANGE_OPTIONS = [
  { label: '7d',  days: 7  },
  { label: '14d', days: 14 },
  { label: '28d', days: 28 },
  { label: '42d', days: 42 },
];

// Exported at module level so tests can assert the full set of options without
// mounting the component.  The user's stated preference: 7, 14, 28, and 42.
export const HISTORY_RANGE_OPTIONS = [
  { label: '7d',  days: 7  },
  { label: '14d', days: 14 },
  { label: '28d', days: 28 },
  { label: '42d', days: 42 },
];

const ALL_DAYS = 42;
const BAR_SLOT_NARROW = 44;  // 7d
const BAR_SLOT_MED    = 30;  // 14d
const BAR_SLOT_WIDE   = 24;  // 28d / 42d
const CHART_HEIGHT    = 180;

// Approximate Recharts plot-area geometry for the fixed 180px height.
// Used to align the Today column bar height with the completed-day bars.
//   margin.top = 8  (from the BarChart margin prop)
//   XAxis area ≈ 22px (dy=8 offset + 9px font + internal padding)
// Plot height = CHART_HEIGHT - top - xAxis ≈ 150px
const CHART_TOP_MARGIN = 8;
const X_AXIS_HEIGHT    = 22;
const CHART_PLOT_H     = CHART_HEIGHT - CHART_TOP_MARGIN - X_AXIS_HEIGHT; // ≈ 150

// ChartDatum is defined in domain-detail-aggregation.ts and re-exported here
// for the ChartBars component and tooltip/marker helpers defined below.

type ChartBarsProps = {
  data: ChartDatum[];
  accentHex: string;
  needsScroll: boolean;
  fixedWidth: number;
  height: number;
  viewDays: number;
  policyDailyProRate: number;
  policySessionFloor: number;
  getBarOpacity: (tier: string) => number;
  /** When provided, fixes the YAxis domain to [0, yDomainMax] so the scale
   *  matches the separately-rendered Today reference column exactly. */
  yDomainMax?: number;
};

// Color used for anomaly markers and warning overlays. Hardcoded amber/red
// to remain legible against any domain accent without inheriting Tailwind
// CSS-variable tokens (Recharts SVG can't resolve `hsl(var(--…))`).
const ANOMALY_COLOR = '#E2B23E';
const DEVIATION_BAND_COLOR = '#9CA3AF';

// Collapse consecutive deviation days into [start,end] dateKey pairs so the
// chart can render one ReferenceArea per contiguous run. dateKey (yyyy-MM-dd)
// is unique within the 42-day window — short dayLabel values like "M5" are
// not, so they would mis-anchor ReferenceArea bands on a categorical axis.
function deviationRuns(data: ChartDatum[]): { x1: string; x2: string }[] {
  const runs: { x1: string; x2: string }[] = [];
  let runStart: string | null = null;
  for (let i = 0; i < data.length; i++) {
    const cell = data[i];
    if (cell.hasDeviation) {
      if (runStart === null) runStart = cell.dateKey;
      const next = data[i + 1];
      if (!next || !next.hasDeviation) {
        runs.push({ x1: runStart, x2: cell.dateKey });
        runStart = null;
      }
    }
  }
  return runs;
}

const TooltipContent = ({
  active, payload, accentHex, sessionFloor,
}: { active?: boolean; payload?: any[]; accentHex: string; sessionFloor: number }) => {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload as ChartDatum;
  return (
    <div className="bg-popover border border-border/60 p-3 rounded-xl shadow-lg text-sm">
      <div className="font-semibold text-foreground">{d.fullDate}</div>
      <div className="mt-1 font-bold" style={{ color: accentHex }}>
        {d.minutes > 0 ? `${d.minutes}m` : 'No session'}
      </div>
      {d.minutes > 0 && d.minutes < sessionFloor && (
        <div className="text-[10px] text-status-degraded mt-0.5">Below {sessionFloor}m floor</div>
      )}
      {d.hasAnomaly && (
        <div className="text-[10px] mt-0.5" style={{ color: ANOMALY_COLOR }}>
          Anomalous session flagged
        </div>
      )}
      {d.hasDeviation && (
        <div className="text-[10px] text-muted-foreground mt-0.5">Deviation active</div>
      )}
      <div className="text-[10px] text-muted-foreground mt-0.5 capitalize">
        {d.tier === 'current' ? 'Current 7d' : d.tier === 'previous' ? 'Prev 7d' : 'Older'}
      </div>
    </div>
  );
};

// Props that Recharts injects into a Bar's `label` content renderer. Only
// the geometry and source datum are used here, but the shape is declared
// explicitly so the marker stays type-safe (no implicit `any`).
interface AnomalyMarkerProps {
  x?: number;
  y?: number;
  width?: number;
  payload?: ChartDatum;
}

// Render a small filled circle above any bar whose day has an anomaly.
// Recharts' label content type requires a non-null SVG element, so we return
// an empty `<g/>` for non-anomalous days rather than null.
function AnomalyMarker({ x, y, width, payload }: AnomalyMarkerProps): React.ReactElement<SVGElement> {
  if (!payload?.hasAnomaly || x === undefined || y === undefined || width === undefined) {
    return <g />;
  }
  const cx = x + width / 2;
  const cy = y - 6;
  return (
    <g pointerEvents="none">
      <circle cx={cx} cy={cy} r={3} fill={ANOMALY_COLOR} stroke="#FFFFFF" strokeWidth={0.5} />
    </g>
  );
}

export function ChartBars({ data, accentHex, needsScroll, fixedWidth, height, viewDays, policyDailyProRate, policySessionFloor, getBarOpacity, yDomainMax }: ChartBarsProps) {
  const runs = deviationRuns(data);
  const internals = [
    <XAxis
      key="x-axis"
      dataKey="dateKey"
      axisLine={false}
      tickLine={false}
      tick={{ fontSize: 9, fill: '#A9BBC2', fontWeight: 500 }}
      tickFormatter={(_v: string, idx: number) => data[idx]?.dayLabel ?? ''}
      dy={8}
      interval={viewDays <= 7 ? 0 : viewDays <= 14 ? 1 : 6}
    />,
    <YAxis
      key="y-axis"
      axisLine={false}
      tickLine={false}
      tick={{ fontSize: 10, fill: '#A9BBC2', fontWeight: 500 }}
      width={32}
      domain={yDomainMax !== undefined ? [0, yDomainMax] : [0, 'auto']}
    />,
    <Tooltip
      key="tooltip"
      cursor={{ fill: 'rgba(169,187,194,0.08)' }}
      content={(props: any) => (
        <TooltipContent {...props} accentHex={accentHex} sessionFloor={policySessionFloor} />
      )}
    />,
    // Deviation bands — render before bars so they sit underneath.
    ...runs.map((r, i) => (
      <ReferenceArea
        key={`ref-area-${i}`}
        x1={r.x1}
        x2={r.x2}
        fill={DEVIATION_BAND_COLOR}
        fillOpacity={0.18}
        stroke={DEVIATION_BAND_COLOR}
        strokeOpacity={0.25}
        ifOverflow="extendDomain"
      />
    )),
    // Threshold annotations: session floor (lower) and daily pro-rate (target).
    <ReferenceLine
      key="ref-floor"
      y={policySessionFloor}
      stroke="#A9BBC2"
      strokeOpacity={0.45}
      strokeDasharray="2 4"
      label={{ value: `floor ${policySessionFloor}m`, position: 'insideBottomLeft', fontSize: 9, fill: '#A9BBC2', fillOpacity: 0.7, dy: -2 }}
    />,
    <ReferenceLine
      key="ref-target"
      y={policyDailyProRate}
      stroke={accentHex}
      strokeOpacity={0.35}
      strokeDasharray="3 3"
      label={{ value: `${policyDailyProRate}m/d`, position: 'insideTopLeft', fontSize: 9, fill: accentHex, fillOpacity: 0.6, dy: -2 }}
    />,
    <Bar
      key="bar"
      dataKey="minutes"
      radius={[4, 4, 0, 0]}
      maxBarSize={viewDays <= 7 ? 52 : viewDays <= 14 ? 36 : 18}
      label={AnomalyMarker}
      isAnimationActive={false}
    >
      {data.map((entry, idx) => {
        const strokeColor = entry.hasAnomaly ? ANOMALY_COLOR : entry.isToday ? accentHex : 'none';
        const strokeWidth = entry.hasAnomaly ? 1.5 : entry.isToday ? 1.5 : 0;
        return (
          <Cell
            key={`cell-${idx}`}
            fill={entry.minutes > 0 ? accentHex : '#AAB8BC'}
            fillOpacity={entry.minutes > 0 ? getBarOpacity(entry.tier) : 0.18}
            stroke={strokeColor}
            strokeWidth={strokeWidth}
          />
        );
      })}
    </Bar>,
  ];

  if (needsScroll) {
    return (
      <div style={{ width: fixedWidth }}>
        <BarChart width={fixedWidth} height={height} data={data} margin={{ top: 8, right: 12, left: -20, bottom: 0 }} barCategoryGap="18%">
          {internals}
        </BarChart>
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 12, left: -20, bottom: 0 }} barCategoryGap="18%">
        {internals}
      </BarChart>
    </ResponsiveContainer>
  );
}

// ── Today reference column ────────────────────────────────────────────────────
//
// Rendered as a pinned HTML column to the RIGHT of the scrollable completed-
// day BarChart.  Keeping it outside the Recharts SVG means:
//   • It stays visible while the user scrolls through 28d / 42d bars.
//   • Full layout control — dashed separator, pulsing dot, zero-state baseline.
//   • Y-scale truthfulness is maintained by sharing `yDomainMax` with the YAxis
//     `domain` prop, so bar heights are proportionally identical.
//
// Geometry constants (see CHART_TOP_MARGIN / X_AXIS_HEIGHT at the top of file):
//   Total column height = CHART_HEIGHT = 180px
//     8px top-margin band  (mirrors Recharts margin.top — for minute label)
//   150px plot area        (bar grows from bottom; floor line rendered here)
//    22px x-axis band      (TODAY label + pulsing LIVE dot)

type TodayColumnProps = {
  minutes: number;
  yDomainMax: number;
  accentHex: string;
  policySessionFloor: number;
  viewDays: number;
};

function TodayColumn({ minutes, yDomainMax, accentHex, policySessionFloor, viewDays }: TodayColumnProps) {
  // Bar height in pixels, proportional to the shared Y scale.
  // Minimum 2px so a zero-today shows a clear baseline rather than nothing.
  const barPx   = yDomainMax > 0 ? Math.round((minutes          / yDomainMax) * CHART_PLOT_H) : 0;
  const floorPx = yDomainMax > 0 ? Math.round((policySessionFloor / yDomainMax) * CHART_PLOT_H) : 0;
  const isZero  = minutes === 0;

  // Match the bar width to the current view's bar-size tier.
  const barWidthPx = viewDays <= 7 ? 52 : viewDays <= 14 ? 36 : 18;
  // Outer column width: 12px left padding for the separator gap + 10px column padding + bar + 4px right
  const colWidthPx = barWidthPx + 26;

  return (
    <div
      className="flex shrink-0 items-end self-end"
      // Align bottom of Today column with bottom of the chart SVG.
      // `self-end` on this element inside `items-end` flex parent is redundant
      // but explicit for clarity.
      style={{ height: CHART_HEIGHT }}
      data-testid="col-today-reference"
    >
      {/* Dashed vertical separator — spans only the plot area, not the x-axis band */}
      <div
        className="shrink-0 self-stretch mx-2"
        style={{
          width: 1,
          marginBottom: X_AXIS_HEIGHT,
          borderLeft: `1.5px dashed`,
          borderColor: `${accentHex}55`,
        }}
        aria-hidden="true"
      />

      {/* Today bar column */}
      <div
        className="flex flex-col"
        style={{ width: colWidthPx, height: CHART_HEIGHT }}
      >
        {/* ── Top margin band (8px) — minute value label ── */}
        <div
          className="flex items-center justify-center shrink-0"
          style={{ height: CHART_TOP_MARGIN }}
        >
          {/* intentionally empty — minute label is absolutely positioned in plot area */}
        </div>

        {/* ── Plot area (150px) — bar + floor line + minute label ── */}
        <div
          className="relative flex items-end justify-center flex-1"
          style={{ minHeight: 0 }}
        >
          {/* Session-floor reference line — same height calculation as ChartBars */}
          {floorPx > 0 && (
            <div
              className="absolute left-0 right-0 pointer-events-none"
              style={{
                bottom: floorPx,
                borderTop: '1px dashed rgba(169,187,194,0.45)',
              }}
              aria-hidden="true"
            />
          )}

          {/* Minute value — floated above the bar */}
          <div
            className="absolute text-[9px] font-bold text-center w-full pointer-events-none"
            style={{
              bottom: Math.max(barPx, 2) + 3,
              color: isZero ? '#A9BBC2' : accentHex,
            }}
            data-testid="text-today-minutes"
          >
            {isZero ? '—' : `${minutes}m`}
          </div>

          {/* The bar itself */}
          <div
            className="rounded-t-sm"
            style={{
              width: '70%',
              height: Math.max(barPx, 2),
              backgroundColor: isZero ? 'transparent' : accentHex,
              opacity: isZero ? 1 : 0.85,
              border: `1.5px dashed ${accentHex}`,
              borderBottom: isZero ? `1.5px dashed ${accentHex}` : 'none',
              boxSizing: 'border-box',
            }}
          />
        </div>

        {/* ── X-axis band (22px) — TODAY + pulsing LIVE dot ── */}
        <div
          className="flex flex-col items-center justify-start shrink-0 pt-1 gap-0.5"
          style={{ height: X_AXIS_HEIGHT }}
        >
          <span
            className="text-[8px] font-bold uppercase tracking-widest"
            style={{ color: '#A9BBC2', lineHeight: 1 }}
          >
            TODAY
          </span>
          <div className="flex items-center gap-0.5">
            <span className="relative flex h-1.5 w-1.5" aria-hidden="true">
              <span
                className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-60"
                style={{ backgroundColor: accentHex }}
              />
              <span
                className="relative inline-flex rounded-full h-1.5 w-1.5"
                style={{ backgroundColor: accentHex }}
              />
            </span>
            <span
              className="text-[8px] font-bold uppercase tracking-widest"
              style={{ color: '#A9BBC2', lineHeight: 1 }}
            >
              LIVE
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

const DomainIcon = ({ domain, className, style }: { domain: Domain; className?: string; style?: React.CSSProperties }) => {
  switch (domain) {
    case 'martial-arts': return <Activity className={className} style={style} />;
    case 'meditation':   return <BrainCircuit className={className} style={style} />;
    case 'fitness':      return <Dumbbell className={className} style={style} />;
    case 'music':        return <Music className={className} style={style} />;
  }
};

const formatDomainName = (d: string) =>
  d.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

export default function DomainDetail() {
  const [_, setLocation] = useLocation();
  const [, params] = useRoute('/domain/:domain');
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewDays, setViewDays] = useState(42);

  const domain = (params?.domain as Domain) || 'fitness';
  const domainName = formatDomainName(domain);
  const policy = DOMAIN_POLICY[domain];
  const accentHex = DOMAIN_COLOR[domain];

  const sessions = useAppStore(s => s.sessions);
  const deviations = useAppStore(s => s.deviations);
  const updateSession = useAppStore(s => s.updateSession);
  const deleteSession = useAppStore(s => s.deleteSession);
  const getDomainStatus = useAppStore(s => s.getDomainStatus);
  const fetchEscalationState = useAppStore(s => s.fetchEscalationState);
  const [editing, setEditing] = useState<Session | null>(null);
  const [deleting, setDeleting] = useState<Session | null>(null);
  // Personal duration baseline for this domain — same 42-day rolling window
  // and cold-start rule the anomaly detector uses at save time. Surfaced here
  // so users can see what "normal" looks like before a prompt fires.
  type BaselineEntry = { coldStart: boolean; sampleCount: number; mean: number; stdDev: number };
  type BaselinesResponse = {
    baselineDays: number;
    coldStartThreshold: number;
    perDomain: Record<Domain, BaselineEntry>;
  };
  const [baselines, setBaselines] = useState<BaselinesResponse | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/baselines')
      .then(r => r.ok ? r.json() : null)
      .then((data: BaselinesResponse | null) => { if (!cancelled && data) setBaselines(data); })
      .catch(() => { /* surface stays hidden on error */ });
    return () => { cancelled = true; };
    // Re-fetch when this domain's session list changes so baseline reflects
    // a freshly logged / edited / deleted session.
  }, [sessions]);
  const baseline = baselines?.perDomain[domain];
  // SOMR-327: windowSets, sessionDays, and deviationDayMap are server-authoritative.
  // No client-side TZ math needed anywhere on this page.
  const policyState      = useAppStore(s => s.policyState);
  const windowSets       = policyState?.windowSets;
  const sessionDays      = policyState?.sessionDays;
  const deviationDayMap  = windowSets?.deviationDayMap ?? {};
  const escalationState = useAppStore(s => s.escalationState);

  // History range for the per-day tier strip — re-fetches /api/escalation-state
  // with ?days= so the timeline reflects the user's chosen lookback.
  // HISTORY_RANGE_OPTIONS is defined at module level and exported for testing.
  const [historyDays, setHistoryDays] = useState(14);
  useEffect(() => {
    fetchEscalationState(historyDays);
  }, [historyDays, fetchEscalationState]);
  // Other store actions (addSession / updateSession / deleteSession /
  // deviation mutations) call fetchEscalationState() with no days argument,
  // which would silently revert the history strip back to the default 14-day
  // window even when the user has 30d selected. Detect that drift via the
  // returned history length and re-fetch with the user's chosen range so the
  // toggle and the rendered timeline stay in agreement.
  const escalationHistoryLength = escalationState?.history.length ?? 0;
  useEffect(() => {
    if (escalationHistoryLength > 0 && escalationHistoryLength !== historyDays) {
      fetchEscalationState(historyDays);
    }
  }, [escalationHistoryLength, historyDays, fetchEscalationState]);
  const domainEscalation = escalationState?.perDomain[domain];
  const domainSessions = sessions.filter(s => s.domain === domain);
  const activeDeviation = findActiveDeviationAt(deviations, domain, new Date());
  // score/status/sloMinutes use the policy engine's configured windowDays.
  // Fixed 7-day Current/Prev windows are computed separately via windowSets (SOMR-327).
  const { score, status, recentMinutes: sloMinutes, targetMinutes, overachievementTier, overachievementRaw } = getDomainStatus(domain);
  // C2.2 — Show whenever non-NONE; the MIN gating already prevents sparse-
  // data false positives during ramp-up.
  const showOverachievement = overachievementTier !== 'NONE';

  // SOMR-327 (F2, F3): Build the set of w42 day keys on which a deviation for
  // this domain was active, using the server-precomputed deviationDayMap (which
  // is based on authoritative logical-day start boundaries, not UTC midnight).
  // Domain filtering happens here so buildChartData receives a plain Set<string>.
  const deviationActiveDays = useMemo(() => {
    const days = new Set<string>();
    for (const dev of deviations) {
      if (dev.domain !== domain || dev.deletedAt) continue;
      for (const dayKey of deviationDayMap[dev.id] ?? []) {
        days.add(dayKey);
      }
    }
    return days;
  }, [deviations, domain, deviationDayMap]);

  // SOMR-327: Chart uses server-authoritative logical-day keys from windowSets.w42.
  // Display labels are computed from noon UTC (browser-timezone-safe).
  // Tier labels are always the fixed 7d/7d split regardless of viewDays.
  const allChartData = useMemo<ChartDatum[]>(() => {
    if (!windowSets?.w42 || !sessionDays) return [];
    return buildChartData(
      windowSets.w42,
      sessionDays,
      domainSessions,
      deviationActiveDays,
      new Set(windowSets.w7),
      new Set(windowSets.prev7),
    );
  }, [domainSessions, sessionDays, windowSets, deviationActiveDays]);

  // SOMR-327: Fixed 7-day window totals — always exactly the most-recent 7
  // completed logical days (w7) and the 7 days immediately before that (prev7).
  const current7Minutes = useMemo(() => {
    if (!windowSets?.w7 || !sessionDays) return null;
    return sumWindowMinutes(windowSets.w7, sessionDays, domainSessions);
  }, [domainSessions, sessionDays, windowSets]);

  const prev7Minutes = useMemo(() => {
    if (!windowSets?.prev7 || !sessionDays) return null;
    return sumWindowMinutes(windowSets.prev7, sessionDays, domainSessions);
  }, [domainSessions, sessionDays, windowSets]);

  // SOMR-327 — Today (live context).  todayKey is the current in-progress
  // logical day; it is excluded from all window sets and from every SLO /
  // trend calculation.  todayMinutes and todaySessions surface it separately
  // so the user can answer "did I practice today?" without polluting the
  // completed-window metrics.
  const todayKey = windowSets?.todayKey ?? null;

  const todayMinutes = useMemo(() => {
    if (!todayKey || !sessionDays) return 0;
    return sumTodayMinutes(todayKey, sessionDays, domainSessions);
  }, [todayKey, sessionDays, domainSessions]);

  // Full Session objects for today so the activity display can show notes.
  const todaySessions = useMemo(() => {
    if (!todayKey || !sessionDays) return [];
    return domainSessions.filter((s) => sessionDays[s.id] === todayKey);
  }, [todayKey, sessionDays, domainSessions]);

  const chartData = useMemo(() => allChartData.slice(ALL_DAYS - viewDays), [allChartData, viewDays]);

  // Shared Y-axis ceiling for the completed-day chart AND the Today reference column.
  // Passing this to ChartBars as `yDomainMax` fixes the YAxis domain so bar heights
  // are proportionally identical between the two rendering contexts.
  // Include today's minutes so a large today session doesn't clip above the axis.
  const yDomainMax = useMemo(() => {
    const dataMax = chartData.reduce((m, d) => Math.max(m, d.minutes), 0);
    const raw     = Math.max(policy.dailyProRate, dataMax, todayMinutes);
    // Round up to the nearest 5 and add 15% headroom so bars never touch the top.
    return Math.ceil(raw * 1.15 / 5) * 5;
  }, [chartData, todayMinutes, policy.dailyProRate]);

  // Responsive vs. fixed-scroll strategy
  // ≤14d: fills full container width via ResponsiveContainer (no scroll needed)
  // >14d: fixed pixel width so bars stay readable at scale, overflow-x scrolls to today
  const needsScroll = viewDays > 14;
  const barSlot = viewDays <= 14 ? BAR_SLOT_MED : BAR_SLOT_WIDE;
  const fixedChartWidth = viewDays * barSlot + 48;

  // Auto-scroll to right (today) only for scrollable ranges
  useEffect(() => {
    if (needsScroll && scrollRef.current) {
      scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
    }
  }, [viewDays, needsScroll]);

  const getBarOpacity = (tier: string) => {
    if (tier === 'current')  return 1.0;
    if (tier === 'previous') return 0.55;
    return 0.28;
  };

  // Status helpers
  const statusText  = status === 'healthy' ? 'text-status-healthy'  : status === 'degraded' ? 'text-status-degraded'  : 'text-status-critical';
  const statusBg    = status === 'healthy' ? 'bg-status-healthy/10' : status === 'degraded' ? 'bg-status-degraded/10' : 'bg-status-critical/10';
  const statusBorder = status === 'healthy' ? 'border-status-healthy/20' : status === 'degraded' ? 'border-status-degraded/20' : 'border-status-critical/20';

  // SOMR-327: Fixed 7d comparison; null-coalesce to 0 while windowSets loads.
  const current7m  = current7Minutes ?? 0;
  const prev7m     = prev7Minutes ?? 0;
  const delta      = current7m - prev7m;
  const trend7d: 'up' | 'down' | 'flat' =
    current7m > prev7m ? 'up' : current7m < prev7m ? 'down' : 'flat';
  // pctOfTarget uses sloMinutes from the policy engine (user's configured
  // windowDays) so the SLO percentage reflects the full compliance window.
  const pctOfTarget = Math.round((sloMinutes / targetMinutes) * 100);

  // Recent activity for this domain — sessions interleaved with deviation
  // start/end events, newest first, capped to 5 entries.
  const recentActivity = useMemo(
    () =>
      buildActivityLog(sessions, deviations)
        .filter((e) => e.domain === domain)
        .slice(0, 5),
    [sessions, deviations, domain],
  );

  return (
    <div className="min-h-screen bg-background text-foreground font-sans transition-colors duration-300 pb-24">
      <header className="px-4 py-5 flex items-center justify-between sticky top-0 bg-background/90 backdrop-blur-xl z-10 border-b border-border/50">
        <div className="flex items-center gap-4">
          <button
            onClick={() => {
              const p = new URLSearchParams(window.location.search);
              setLocation(p.get('from') === 'system-health' ? '/system-health' : '/');
            }}
            className="p-2 -ml-2 rounded-full active:scale-95 hover:bg-accent/60 text-muted-foreground transition-all"
            data-testid="button-back"
          >
            <ArrowLeft className="w-6 h-6" />
          </button>
          <div className="flex items-center gap-3">
            {/* Domain accent icon */}
            <div className="p-2 rounded-xl" style={{ backgroundColor: `${accentHex}18` }}>
              <DomainIcon domain={domain} className="w-5 h-5" style={{ color: accentHex } as React.CSSProperties} />
            </div>
            <h1 className="text-xl font-bold tracking-tight">{domainName}</h1>
          </div>
        </div>
        <ThemeToggle />
      </header>

      <main className="px-4 py-6 space-y-5">

        {/* Escalation Surface — derived from /api/escalation-state */}
        {domainEscalation && (
          <EscalationCard esc={domainEscalation} domainLabel={domainName} />
        )}

        {/* Active deviation notice — surfaces the current deviation in context.
            Error-budget drawdown is held steady server-side while this is active. */}
        {activeDeviation && (
          <div
            className="bg-status-advisory/10 border border-status-advisory/30 rounded-2xl p-4 flex items-start gap-3"
            data-testid="notice-deviation-active"
          >
            <CalendarOff className="w-4 h-4 mt-0.5 text-status-advisory shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-bold uppercase tracking-widest text-status-advisory">
                  Deviation active
                </span>
                {activeDeviation.excludeFromComposite && (
                  <span className="text-[10px] font-bold uppercase tracking-widest text-status-advisory bg-status-advisory/15 px-2 py-0.5 rounded-full">
                    Excluded from composite
                  </span>
                )}
              </div>
              <p
                className="text-sm font-medium text-foreground mt-1 break-words"
                data-testid="text-deviation-reason"
              >
                {activeDeviation.reason}
              </p>
              <p className="text-xs text-muted-foreground mt-1 font-mono">
                Since {format(parseISO(activeDeviation.startAt), 'MMM d, h:mm a')}
                {activeDeviation.endAt
                  ? ` → planned end ${format(parseISO(activeDeviation.endAt), 'MMM d, h:mm a')}`
                  : ' → ongoing'}
              </p>
              <p className="text-xs text-muted-foreground mt-2">
                Error-budget drawdown is paused for this domain while the deviation is active.
                Manage from the Dashboard.
              </p>
            </div>
          </div>
        )}

        {/* Per-day tier history strip — last N days at a glance */}
        {escalationState?.history && escalationState.history.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-end">
              <div
                className="flex items-center gap-1 bg-muted/60 rounded-xl p-1"
                data-testid="group-history-range"
              >
                {HISTORY_RANGE_OPTIONS.map(opt => (
                  <button
                    key={opt.days}
                    onClick={() => setHistoryDays(opt.days)}
                    className={`px-3 py-1 rounded-lg text-xs font-bold transition-all ${
                      historyDays === opt.days
                        ? 'bg-background text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                    data-testid={`button-history-range-${opt.label}`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            <EscalationTimeline
              history={escalationState.history}
              domain={domain}
              domainLabel={domainName}
            />
          </div>
        )}

        {/* Status + Trend Comparison */}
        <section className={`bg-card border rounded-3xl p-5 shadow-sm ${statusBorder}`}>
          <div className="flex items-start justify-between mb-4">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2">SLO Score</div>
              <div className="flex items-center gap-3 flex-wrap">
                <span className={`text-5xl font-extrabold tracking-tighter ${statusText}`}>{score}</span>
                <div className={`px-3 py-1 rounded-lg text-xs font-bold uppercase tracking-wide border ${statusBg} ${statusText} ${statusBorder}`}>
                  {status}
                </div>
                {showOverachievement && (
                  <OverachievementBadge
                    tier={overachievementTier}
                    rawScore={overachievementRaw}
                    testIdSuffix={domain}
                  />
                )}
              </div>
              <div className="text-xs text-muted-foreground mt-1.5">
                {pctOfTarget}% of {targetMinutes}m/week SLO · {policy.cadence}
              </div>
            </div>

            <div className="text-right">
              <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2">Vs. Last Week</div>
              <div className="flex items-center justify-end gap-1.5 font-bold text-xl">
                {trend7d === 'up'   && <><span className="text-status-healthy">↗</span> Up</>}
                {trend7d === 'down' && <><span className="text-status-critical">↘</span> Down</>}
                {trend7d === 'flat' && <><span className="text-status-advisory">→</span> Flat</>}
              </div>
              <div className="text-xs font-medium text-muted-foreground mt-1">{current7m}m vs {prev7m}m</div>
              <div className={`text-[11px] font-bold mt-1 px-2 py-0.5 rounded-md ${
                delta > 0 ? 'bg-status-healthy/10 text-status-healthy' :
                delta < 0 ? 'bg-status-critical/10 text-status-critical' :
                'bg-status-advisory/10 text-status-advisory'
              }`}>
                {delta > 0 ? '+' : ''}{delta}m delta
              </div>
            </div>
          </div>

          <div className="pt-3 border-t border-border/50 space-y-2">
            <p className="text-sm text-muted-foreground leading-relaxed">
              <strong className="text-foreground">Trend:</strong> {current7m}m this 7-day window vs {prev7m}m previous
              ({delta > 0 ? '+' : ''}{delta}m). SLO: <strong className="text-foreground">{targetMinutes}m/week</strong>.
            </p>
            <div className="flex flex-wrap gap-2">
              <span className="text-[11px] bg-muted px-2.5 py-1 rounded-lg font-mono font-semibold text-muted-foreground">
                Floor: {policy.sessionFloor}m/session
              </span>
              <span className="text-[11px] bg-muted px-2.5 py-1 rounded-lg font-mono font-semibold text-muted-foreground">
                {policy.sessionsTarget}+ sessions/week
              </span>
            </div>
          </div>
        </section>

        {/* Personal session-length baseline — same 42-day window the anomaly
            detector uses at save time. Cold-start state is communicated
            explicitly so users know why anomaly prompts may not fire yet. */}
        {baselines && baseline && (
          <section
            className="bg-card border border-border/50 rounded-2xl p-4 shadow-sm"
            data-testid="card-baseline"
          >
            <div className="flex items-baseline justify-between mb-2">
              <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                Your typical session
              </div>
              <div className="text-[10px] text-muted-foreground font-mono">
                {baselines.baselineDays}d window
              </div>
            </div>
            {baseline.coldStart ? (
              <div data-testid="text-baseline-cold-start">
                <div className="text-sm font-semibold text-foreground">
                  Still learning your baseline
                </div>
                <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                  Need at least {baselines.coldStartThreshold} sessions in the last{' '}
                  {baselines.baselineDays} days to estimate your typical length.
                  You have <span className="font-mono font-semibold text-foreground" data-testid="text-baseline-sample-count">{baseline.sampleCount}</span>
                  {' '}so far — anomaly prompts will start once the baseline is established.
                </p>
              </div>
            ) : (
              <div>
                <div className="flex items-baseline gap-3 flex-wrap">
                  <span className="text-2xl font-extrabold tracking-tight text-foreground" data-testid="text-baseline-mean">
                    {Math.round(baseline.mean)}m
                  </span>
                  <span className="text-xs font-medium text-muted-foreground">
                    avg · σ <span className="font-mono font-semibold text-foreground" data-testid="text-baseline-stddev">{Math.round(baseline.stdDev)}m</span>
                    {' '}· n=<span className="font-mono font-semibold text-foreground" data-testid="text-baseline-sample-count">{baseline.sampleCount}</span>
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
                  Sessions outside roughly{' '}
                  <span className="font-mono">{Math.max(0, Math.round(baseline.mean - 2 * baseline.stdDev))}–{Math.round(baseline.mean + 2 * baseline.stdDev)}m</span>
                  {' '}will trigger an anomaly prompt at save.
                </p>
              </div>
            )}
          </section>
        )}

        {/* Chart Section */}
        <section className="bg-card border border-border/50 rounded-3xl shadow-sm overflow-hidden">

          {/* Chart header + range selector */}
          <div className="px-5 pt-5 pb-3">
            <div className="flex items-center justify-between mb-3">
              <div className="text-sm font-semibold text-foreground">Activity History</div>
              <div className="flex items-center gap-1 bg-muted/60 rounded-xl p-1">
                {RANGE_OPTIONS.map(opt => (
                  <button
                    key={opt.days}
                    onClick={() => setViewDays(opt.days)}
                    className={`px-3 py-1 rounded-lg text-xs font-bold transition-all ${
                      viewDays === opt.days
                        ? 'bg-background text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                    data-testid={`button-range-${opt.label}`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Opacity legend */}
            <div className="flex items-center gap-3 text-[10px] text-muted-foreground font-medium">
              {(['current','previous','older'] as const).map((tier, i) => (
                <span key={tier} className="flex items-center gap-1">
                  <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: accentHex, opacity: [1, 0.55, 0.28][i] }} />
                  {tier === 'current' ? 'Current 7d' : tier === 'previous' ? 'Prev 7d' : 'Older'}
                </span>
              ))}
            </div>
          </div>

          {/* Chart — flex row: scrollable completed-days bars + pinned Today reference column.
               The Today column sits OUTSIDE the scroll container so it remains visible
               when the user pans through 28d / 42d history. Both share `yDomainMax` so
               bar heights are proportionally truthful on the same Y scale. */}
          <div className="flex items-end pb-2">

            {/* ── Completed-day bars (scrollable for >14d) ── */}
            <div
              ref={scrollRef}
              className={`flex-1 min-w-0 px-3 ${needsScroll ? 'overflow-x-auto' : ''}`}
              style={needsScroll ? { WebkitOverflowScrolling: 'touch' } : {}}
            >
              <ChartBars
                data={chartData}
                accentHex={accentHex}
                needsScroll={needsScroll}
                fixedWidth={fixedChartWidth}
                height={CHART_HEIGHT}
                viewDays={viewDays}
                policyDailyProRate={policy.dailyProRate}
                policySessionFloor={policy.sessionFloor}
                getBarOpacity={getBarOpacity}
                yDomainMax={yDomainMax}
              />
            </div>

            {/* ── Today reference column (always visible, not in scroll area) ── */}
            {todayKey && (
              <TodayColumn
                minutes={todayMinutes}
                yDomainMax={yDomainMax}
                accentHex={accentHex}
                policySessionFloor={policy.sessionFloor}
                viewDays={viewDays}
              />
            )}
          </div>

          {/* Current/Prev comparison footer */}
          <div className="px-5 pb-5 border-t border-border/40 pt-3">
            <div className="grid grid-cols-3 gap-2 text-center text-[11px]">
              <div>
                <div className="font-bold text-foreground text-sm">{current7m}m</div>
                <div className="text-muted-foreground mt-0.5">Current 7d</div>
              </div>
              <div>
                <div className="font-bold text-foreground text-sm">{prev7m}m</div>
                <div className="text-muted-foreground mt-0.5">Prev 7d</div>
              </div>
              <div>
                <div className={`font-bold text-sm ${delta > 0 ? 'text-status-healthy' : delta < 0 ? 'text-status-critical' : 'text-status-advisory'}`}>
                  {delta > 0 ? '+' : ''}{delta}m
                </div>
                <div className="text-muted-foreground mt-0.5">Delta</div>
              </div>
            </div>
          </div>

          {/* ── Today session detail panel ────────────────────────────────
              The minute total and TODAY/LIVE label are already shown in the
              chart reference column above.  This panel provides the session
              notes that let the user answer "what exactly did I do today?"
              — compact, no aggregate duplication.
          ──────────────────────────────────────────────────────────────── */}
          {todayKey && (
            <div
              className="px-5 pb-4 pt-2.5 border-t border-dashed border-border/40"
              data-testid="card-today-live"
            >
              {todaySessions.length === 0 ? (
                /* Empty state */
                <p
                  className="text-xs text-muted-foreground"
                  data-testid="text-today-no-sessions"
                >
                  No sessions logged yet today.
                </p>
              ) : (
                /* Session list — notes give context the chart bar cannot */
                <ul
                  className="text-xs space-y-0.5"
                  data-testid="list-today-sessions"
                >
                  {todaySessions.map((s) => (
                    <li key={s.id}>
                      <span className="font-semibold text-foreground">{s.durationMinutes}m</span>
                      {s.notes ? (
                        <span className="text-muted-foreground"> · {s.notes}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}

              {/* Daily-avg context: helps the user relate today's bar to the trend */}
              {current7m > 0 && (
                <div className="text-[10px] text-muted-foreground mt-1.5">
                  {Math.round(current7m / 7)}m / day avg (current 7d) · not counted in SLO
                </div>
              )}
            </div>
          )}
        </section>

        {/* Recent Activity — sessions interleaved with deviation events */}
        <section>
          <h2 className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-3 px-1">Recent Activity</h2>
          <ActivityLog
            entries={recentActivity}
            variant="domain-detail"
            onEdit={(s) => setEditing(s)}
            onDelete={(s) => setDeleting(s)}
            emptyMessage="No activity yet for this domain."
          />
        </section>
      </main>

      <div className="fixed bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-background via-background/95 to-transparent pb-8">
        <button
          onClick={() => setLocation(`/log?domain=${domain}`)}
          className="w-full h-14 rounded-full text-primary-foreground font-semibold text-base flex items-center justify-center gap-2 active:scale-95 transition-transform shadow-lg"
          style={{ backgroundColor: accentHex }}
          data-testid="button-log-specific"
        >
          <Plus className="w-5 h-5" />
          Log {domainName}
        </button>
      </div>

      <SessionEditDialog
        open={!!editing}
        onOpenChange={(o) => { if (!o) setEditing(null); }}
        session={editing}
        onSubmit={(patch, reason) => editing ? updateSession(editing.id, patch, reason) : Promise.resolve(null)}
      />
      <SessionDeleteDialog
        open={!!deleting}
        onOpenChange={(o) => { if (!o) setDeleting(null); }}
        session={deleting}
        onConfirm={(id) => deleteSession(id)}
      />
    </div>
  );
}
