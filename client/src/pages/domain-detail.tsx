import { useRef, useEffect } from 'react';
import { useLocation, useRoute } from 'wouter';
import { format, subDays, parseISO, isSameDay } from 'date-fns';
import { ArrowLeft, Clock, Plus, Activity, BrainCircuit, Dumbbell, Music } from 'lucide-react';
import { useAppStore, Domain, DOMAIN_POLICY } from '@/store';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ReferenceLine, Cell } from 'recharts';
import { ThemeToggle } from '@/components/theme-toggle';

const DomainIcon = ({ domain, className }: { domain: Domain, className?: string }) => {
  switch (domain) {
    case 'martial-arts': return <Activity className={className} />;
    case 'meditation': return <BrainCircuit className={className} />;
    case 'fitness': return <Dumbbell className={className} />;
    case 'music': return <Music className={className} />;
  }
};

const formatDomainName = (domain: string) => {
  return domain.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
};

const BAR_SLOT_PX = 26;
const CHART_DAYS = 42;
const CHART_WIDTH = CHART_DAYS * BAR_SLOT_PX + 48;
const CHART_HEIGHT = 180;

export default function DomainDetail() {
  const [_, setLocation] = useLocation();
  const [match, params] = useRoute('/domain/:domain');
  const scrollRef = useRef<HTMLDivElement>(null);

  const domain = (params?.domain as Domain) || 'fitness';
  const domainName = formatDomainName(domain);
  const policy = DOMAIN_POLICY[domain];

  const sessions = useAppStore(state => state.sessions);
  const getDomainStatus = useAppStore(state => state.getDomainStatus);

  const domainSessions = sessions.filter(s => s.domain === domain);
  const { score, status, trend, recentMinutes, targetMinutes, previousWeekMinutes } = getDomainStatus(domain);

  // Generate last 42 days of chart data
  const chartData = Array.from({ length: CHART_DAYS }).map((_, i) => {
    const date = subDays(new Date(), CHART_DAYS - 1 - i);
    const minutes = domainSessions
      .filter(s => isSameDay(parseISO(s.timestamp), date))
      .reduce((sum, s) => sum + s.durationMinutes, 0);

    // Opacity tier: current 7d window / previous 7d window / older
    const tier = i >= CHART_DAYS - 7 ? 'current' : i >= CHART_DAYS - 14 ? 'previous' : 'older';

    return {
      date: format(date, 'M/d'),
      dayLabel: format(date, 'EEE')[0] + format(date, 'd'),
      fullDate: format(date, 'MMM d'),
      minutes,
      isToday: i === CHART_DAYS - 1,
      tier,
    };
  });

  // Auto-scroll to today (right edge) on mount
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
    }
  }, []);

  const getStatusColor = () => {
    switch (status) {
      case 'healthy': return 'text-status-healthy';
      case 'degraded': return 'text-status-degraded';
      case 'critical': return 'text-status-critical';
      default: return 'text-primary';
    }
  };

  const getStatusBgColor = () => {
    switch (status) {
      case 'healthy': return 'bg-status-healthy/10';
      case 'degraded': return 'bg-status-degraded/10';
      case 'critical': return 'bg-status-critical/10';
      default: return 'bg-primary/10';
    }
  };

  const getDomainColorHex = () => {
    switch (domain) {
      case 'martial-arts': return '#fb7185';
      case 'meditation': return '#38bdf8';
      case 'fitness': return '#34d399';
      case 'music': return '#a78bfa';
      default: return '#94a3b8';
    }
  };

  const getBarOpacity = (tier: string) => {
    if (tier === 'current') return 1.0;
    if (tier === 'previous') return 0.55;
    return 0.28;
  };

  const recentSessions = [...domainSessions]
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 5);

  const delta = recentMinutes - previousWeekMinutes;
  const pctOfTarget = Math.round((recentMinutes / targetMinutes) * 100);

  return (
    <div className="min-h-screen bg-background text-foreground font-sans transition-colors duration-300 pb-24">
      <header className="px-4 py-5 flex items-center justify-between sticky top-0 bg-background/90 backdrop-blur-xl z-10 border-b border-border/40">
        <div className="flex items-center gap-4">
          <button
            onClick={() => {
              const p = new URLSearchParams(window.location.search);
              setLocation(p.get('from') === 'system-health' ? '/system-health' : '/');
            }}
            className="p-2 -ml-2 rounded-full active:scale-95 hover:bg-accent/50 text-muted-foreground transition-all"
          >
            <ArrowLeft className="w-6 h-6" />
          </button>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-muted text-foreground">
              <DomainIcon domain={domain} className="w-5 h-5 opacity-70" />
            </div>
            <h1 className="text-xl font-bold tracking-tight">{domainName}</h1>
          </div>
        </div>
        <ThemeToggle />
      </header>

      <main className="px-4 py-6 space-y-6">

        {/* Status + Trend Comparison */}
        <section className="bg-card border border-border/60 rounded-3xl p-6 shadow-sm">
          <div className="flex items-start justify-between mb-5">
            <div>
              <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-2">SLO Score</div>
              <div className="flex items-center gap-3">
                <span className={`text-5xl font-extrabold tracking-tighter ${getStatusColor()}`}>
                  {score}
                </span>
                <div className={`px-3 py-1.5 rounded-xl text-xs font-bold uppercase tracking-wide ${getStatusBgColor()} ${getStatusColor()}`}>
                  {status}
                </div>
              </div>
              <div className="text-xs text-muted-foreground mt-1.5">
                {pctOfTarget}% of {targetMinutes}m/week SLO
              </div>
            </div>

            <div className="text-right">
              <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-2">Vs. Last Week</div>
              <div className="flex flex-col items-end">
                <div className="flex items-center justify-end gap-1.5 font-bold text-xl">
                  {trend === 'up' && <><span className="text-status-healthy">↗</span> Up</>}
                  {trend === 'down' && <><span className="text-status-critical">↘</span> Down</>}
                  {trend === 'flat' && <><span className="text-blue-500">→</span> Flat</>}
                </div>
                <div className="text-xs font-medium text-muted-foreground mt-1">
                  {recentMinutes}m vs {previousWeekMinutes}m
                </div>
                <div className={`text-[11px] font-bold mt-1 px-2 py-0.5 rounded-md ${delta > 0 ? 'bg-status-healthy/10 text-status-healthy' : delta < 0 ? 'bg-status-critical/10 text-status-critical' : 'bg-blue-500/10 text-blue-500'}`}>
                  {delta > 0 ? '+' : ''}{delta}m delta
                </div>
              </div>
            </div>
          </div>

          <div className="pt-4 border-t border-border/40 space-y-2">
            <p className="text-sm text-muted-foreground leading-relaxed">
              <strong className="text-foreground">Trend Analysis:</strong> {recentMinutes}m this 7-day window vs {previousWeekMinutes}m previous ({delta > 0 ? '+' : ''}{delta}m). SLO target: <strong className="text-foreground">{targetMinutes}m/week</strong> at <strong className="text-foreground">{policy.cadence}</strong> cadence.
            </p>
            <div className="flex flex-wrap gap-2 pt-1">
              <span className="text-[11px] bg-muted px-2.5 py-1 rounded-lg font-mono font-semibold text-muted-foreground">
                Floor: {policy.sessionFloor}m/session
              </span>
              <span className="text-[11px] bg-muted px-2.5 py-1 rounded-lg font-mono font-semibold text-muted-foreground">
                Target: {policy.sessionsTarget}+ sessions/week
              </span>
            </div>
          </div>
        </section>

        {/* 42-Day Scrollable Chart */}
        <section className="bg-card border border-border/60 rounded-3xl shadow-sm overflow-hidden">
          <div className="px-6 pt-6 pb-3">
            <div className="flex items-center justify-between mb-1">
              <div className="text-sm font-semibold text-foreground">42-Day History</div>
              <div className="text-xs text-muted-foreground">← scroll to audit</div>
            </div>
            <div className="flex items-center gap-3 text-[10px] text-muted-foreground font-medium">
              <span className="flex items-center gap-1">
                <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: getDomainColorHex(), opacity: 1 }}></span>
                Current 7d
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: getDomainColorHex(), opacity: 0.55 }}></span>
                Prev 7d
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: getDomainColorHex(), opacity: 0.28 }}></span>
                Older
              </span>
            </div>
          </div>

          <div
            ref={scrollRef}
            className="overflow-x-auto pb-5 px-3"
            style={{ WebkitOverflowScrolling: 'touch' }}
          >
            <div style={{ width: CHART_WIDTH }}>
              <BarChart
                width={CHART_WIDTH}
                height={CHART_HEIGHT}
                data={chartData}
                margin={{ top: 8, right: 12, left: -20, bottom: 0 }}
                barCategoryGap="20%"
              >
                <XAxis
                  dataKey="dayLabel"
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 9, fill: 'hsl(var(--muted-foreground))', fontWeight: 500 }}
                  dy={8}
                  interval={6}
                />
                <YAxis
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))', fontWeight: 500 }}
                  width={32}
                />
                <Tooltip
                  cursor={{ fill: 'rgba(148,163,184,0.1)' }}
                  content={({ active, payload }) => {
                    if (active && payload && payload.length) {
                      const d = payload[0].payload;
                      return (
                        <div className="bg-popover border border-border/50 p-3 rounded-xl shadow-lg text-sm">
                          <div className="font-semibold">{d.fullDate}</div>
                          <div className="mt-1 font-bold" style={{ color: getDomainColorHex() }}>
                            {d.minutes > 0 ? `${d.minutes}m` : 'No session'}
                          </div>
                          {d.minutes > 0 && d.minutes < policy.sessionFloor && (
                            <div className="text-[10px] text-status-degraded mt-0.5">Below {policy.sessionFloor}m floor</div>
                          )}
                          <div className="text-[10px] text-muted-foreground mt-1 capitalize">{d.tier.replace('current', 'Current 7d').replace('previous', 'Prev 7d')}</div>
                        </div>
                      );
                    }
                    return null;
                  }}
                />
                <ReferenceLine
                  y={policy.dailyProRate}
                  stroke={getDomainColorHex()}
                  strokeOpacity={0.35}
                  strokeDasharray="3 3"
                  label={{
                    value: `${policy.dailyProRate}m/d`,
                    position: 'insideTopLeft',
                    fontSize: 9,
                    fill: getDomainColorHex(),
                    fillOpacity: 0.6,
                    dy: -2,
                  }}
                />
                <Bar dataKey="minutes" radius={[4, 4, 0, 0]} maxBarSize={18}>
                  {chartData.map((entry, index) => (
                    <Cell
                      key={`cell-${index}`}
                      fill={entry.minutes > 0 ? getDomainColorHex() : 'hsl(var(--muted))'}
                      fillOpacity={entry.minutes > 0 ? getBarOpacity(entry.tier) : 0.2}
                      stroke={entry.isToday ? getDomainColorHex() : 'none'}
                      strokeWidth={entry.isToday ? 1.5 : 0}
                    />
                  ))}
                </Bar>
              </BarChart>
            </div>
          </div>

          <div className="px-6 pb-5 border-t border-border/30 pt-3">
            <div className="grid grid-cols-3 gap-2 text-center text-[11px]">
              <div>
                <div className="font-bold text-foreground">{recentMinutes}m</div>
                <div className="text-muted-foreground">Current 7d</div>
              </div>
              <div>
                <div className="font-bold text-foreground">{previousWeekMinutes}m</div>
                <div className="text-muted-foreground">Prev 7d</div>
              </div>
              <div>
                <div className={`font-bold ${delta > 0 ? 'text-status-healthy' : delta < 0 ? 'text-status-critical' : 'text-foreground'}`}>
                  {delta > 0 ? '+' : ''}{delta}m
                </div>
                <div className="text-muted-foreground">Delta</div>
              </div>
            </div>
          </div>
        </section>

        {/* Recent Sessions */}
        <section>
          <div className="flex items-center justify-between mb-4 px-2">
            <h2 className="text-sm font-bold text-muted-foreground uppercase tracking-widest">Recent Sessions</h2>
          </div>

          <div className="space-y-3">
            {recentSessions.length > 0 ? (
              recentSessions.map(session => (
                <div key={session.id} className="bg-card border border-border/60 rounded-2xl p-5 flex items-start justify-between group shadow-sm">
                  <div className="flex gap-4">
                    <div className="mt-0.5 text-muted-foreground/60">
                      <Clock className="w-5 h-5" />
                    </div>
                    <div>
                      <div className="font-semibold text-sm text-foreground">
                        {format(parseISO(session.timestamp), 'MMM d, yyyy • h:mm a')}
                      </div>
                      {session.notes && (
                        <div className="text-sm text-muted-foreground mt-1.5 leading-relaxed line-clamp-2">
                          {session.notes}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className={`font-mono text-sm font-bold px-2.5 py-1.5 rounded-lg ${session.durationMinutes >= policy.sessionFloor ? 'text-primary bg-primary/10' : 'text-status-degraded bg-status-degraded/10'}`}>
                    {session.durationMinutes}m
                  </div>
                </div>
              ))
            ) : (
              <div className="text-center py-10 text-muted-foreground bg-card border border-border/60 rounded-3xl shadow-sm">
                No recent sessions found.
              </div>
            )}
          </div>
        </section>
      </main>

      <div className="fixed bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-background via-background to-transparent pb-8">
        <button
          onClick={() => setLocation(`/log?domain=${domain}`)}
          className="w-full h-14 rounded-full bg-primary text-primary-foreground font-semibold text-lg flex items-center justify-center gap-2 active:scale-95 transition-transform shadow-lg shadow-primary/20"
          data-testid="button-log-specific"
        >
          <Plus className="w-5 h-5" />
          Log {domainName}
        </button>
      </div>
    </div>
  );
}
