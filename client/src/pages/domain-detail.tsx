import { useRef, useEffect, useState, useMemo } from 'react';
import { useLocation, useRoute } from 'wouter';
import { format, subDays, parseISO, isSameDay } from 'date-fns';
import { ArrowLeft, Plus, Activity, BrainCircuit, Dumbbell, Music, CalendarOff } from 'lucide-react';
import { useAppStore, Domain, DOMAIN_POLICY, findActiveDeviationAt, isDeviationActiveAt, type Session } from '@/store';
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

const RANGE_OPTIONS = [
  { label: '7d',  days: 7 },
  { label: '14d', days: 14 },
  { label: '30d', days: 30 },
  { label: '42d', days: 42 },
];

const ALL_DAYS = 42;
const BAR_SLOT_NARROW = 44;  // 7d
const BAR_SLOT_MED    = 30;  // 14d
const BAR_SLOT_WIDE   = 24;  // 30d / 42d
const CHART_HEIGHT    = 180;

// Shared chart content — defined outside main component to avoid recreation on each render
type ChartDatum = {
  dateKey: string;   // yyyy-MM-dd — unique x-domain key (used by XAxis + ReferenceArea)
  dayLabel: string;  // short tick label (e.g. "M5") — display only, not unique over long windows
  fullDate: string;
  minutes: number;
  isToday: boolean;
  tier: string;
  hasAnomaly: boolean;
  hasDeviation: boolean;
};

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

// Render a small filled circle above any bar whose day has an anomaly. Uses
// the Recharts custom-label callback signature; `value` and the rest are
// supplied by the Bar parent and ignored here aside from positional args.
const AnomalyMarker = ({ x, y, width, payload }: any) => {
  if (!payload?.hasAnomaly) return null;
  const cx = x + width / 2;
  const cy = y - 6;
  return (
    <g pointerEvents="none">
      <circle cx={cx} cy={cy} r={3} fill={ANOMALY_COLOR} stroke="#FFFFFF" strokeWidth={0.5} />
    </g>
  );
};

function ChartBars({ data, accentHex, needsScroll, fixedWidth, height, viewDays, policyDailyProRate, policySessionFloor, getBarOpacity }: ChartBarsProps) {
  const runs = deviationRuns(data);
  const internals = (
    <>
      <XAxis
        dataKey="dateKey"
        axisLine={false}
        tickLine={false}
        tick={{ fontSize: 9, fill: '#A9BBC2', fontWeight: 500 }}
        tickFormatter={(_v: string, idx: number) => data[idx]?.dayLabel ?? ''}
        dy={8}
        interval={viewDays <= 7 ? 0 : viewDays <= 14 ? 1 : 6}
      />
      <YAxis
        axisLine={false}
        tickLine={false}
        tick={{ fontSize: 10, fill: '#A9BBC2', fontWeight: 500 }}
        width={32}
      />
      <Tooltip
        cursor={{ fill: 'rgba(169,187,194,0.08)' }}
        content={(props: any) => (
          <TooltipContent {...props} accentHex={accentHex} sessionFloor={policySessionFloor} />
        )}
      />
      {/* Deviation bands — render before bars so they sit underneath. */}
      {runs.map((r, i) => (
        <ReferenceArea
          key={`dev-${i}-${r.x1}-${r.x2}`}
          x1={r.x1}
          x2={r.x2}
          fill={DEVIATION_BAND_COLOR}
          fillOpacity={0.18}
          stroke={DEVIATION_BAND_COLOR}
          strokeOpacity={0.25}
          ifOverflow="extendDomain"
        />
      ))}
      {/* Threshold annotations: session floor (lower) and daily pro-rate (target). */}
      <ReferenceLine
        y={policySessionFloor}
        stroke="#A9BBC2"
        strokeOpacity={0.45}
        strokeDasharray="2 4"
        label={{ value: `floor ${policySessionFloor}m`, position: 'insideBottomLeft', fontSize: 9, fill: '#A9BBC2', fillOpacity: 0.7, dy: -2 }}
      />
      <ReferenceLine
        y={policyDailyProRate}
        stroke={accentHex}
        strokeOpacity={0.35}
        strokeDasharray="3 3"
        label={{ value: `${policyDailyProRate}m/d`, position: 'insideTopLeft', fontSize: 9, fill: accentHex, fillOpacity: 0.6, dy: -2 }}
      />
      <Bar
        dataKey="minutes"
        radius={[4, 4, 0, 0]}
        maxBarSize={viewDays <= 7 ? 52 : viewDays <= 14 ? 36 : 18}
        label={AnomalyMarker as any}
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
      </Bar>
    </>
  );

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
  // Re-render when API-backed policy state arrives or refreshes.
  useAppStore(s => s.policyState);
  const escalationState = useAppStore(s => s.escalationState);

  // History range for the per-day tier strip — re-fetches /api/escalation-state
  // with ?days= so the timeline reflects the user's chosen lookback.
  const HISTORY_RANGE_OPTIONS = [
    { label: '7d',  days: 7 },
    { label: '14d', days: 14 },
    { label: '30d', days: 30 },
  ];
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
  const { score, status, trend, recentMinutes, targetMinutes, previousWeekMinutes, overachievementTier, overachievementRaw } = getDomainStatus(domain);
  // C2.2 — Show whenever non-NONE; the MIN gating already prevents sparse-
  // data false positives during ramp-up.
  const showOverachievement = overachievementTier !== 'NONE';

  // Build full 42-day dataset once; slice to viewDays for display.
  // Each day cell carries `hasAnomaly` (any session that day was flagged as
  // a 2-sigma anomaly) and `hasDeviation` (a deviation covers this domain
  // on that day) so the chart can render overlays without recomputing.
  const allChartData = useMemo<ChartDatum[]>(() => Array.from({ length: ALL_DAYS }).map((_, i) => {
    const date = subDays(new Date(), ALL_DAYS - 1 - i);
    const sameDaySessions = domainSessions.filter(s => isSameDay(parseISO(s.timestamp), date));
    const minutes = sameDaySessions.reduce((sum, s) => sum + s.durationMinutes, 0);
    const hasAnomaly = sameDaySessions.some(s => s.isAnomaly);
    const hasDeviation = deviations.some(d => isDeviationActiveAt(d, domain, date));
    const tier = i >= ALL_DAYS - 7 ? 'current' : i >= ALL_DAYS - 14 ? 'previous' : 'older';
    return {
      dateKey: format(date, 'yyyy-MM-dd'),
      dayLabel: format(date, 'EEE')[0] + format(date, 'd'),
      fullDate: format(date, 'MMM d'),
      minutes,
      isToday: i === ALL_DAYS - 1,
      tier,
      hasAnomaly,
      hasDeviation,
    };
  }), [domainSessions, deviations, domain]);

  const chartData = useMemo(() => allChartData.slice(ALL_DAYS - viewDays), [allChartData, viewDays]);

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

  const delta      = recentMinutes - previousWeekMinutes;
  const pctOfTarget = Math.round((recentMinutes / targetMinutes) * 100);

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
                {trend === 'up'   && <><span className="text-status-healthy">↗</span> Up</>}
                {trend === 'down' && <><span className="text-status-critical">↘</span> Down</>}
                {trend === 'flat' && <><span className="text-status-advisory">→</span> Flat</>}
              </div>
              <div className="text-xs font-medium text-muted-foreground mt-1">{recentMinutes}m vs {previousWeekMinutes}m</div>
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
              <strong className="text-foreground">Trend:</strong> {recentMinutes}m this 7-day window vs {previousWeekMinutes}m previous
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

          {/* Chart — responsive for ≤14d, fixed-scroll for >14d */}
          <div
            ref={scrollRef}
            className={`pb-4 px-3 ${needsScroll ? 'overflow-x-auto' : ''}`}
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
            />
          </div>

          {/* Current/Prev comparison footer */}
          <div className="px-5 pb-5 border-t border-border/40 pt-3">
            <div className="grid grid-cols-3 gap-2 text-center text-[11px]">
              <div>
                <div className="font-bold text-foreground text-sm">{recentMinutes}m</div>
                <div className="text-muted-foreground mt-0.5">Current 7d</div>
              </div>
              <div>
                <div className="font-bold text-foreground text-sm">{previousWeekMinutes}m</div>
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
