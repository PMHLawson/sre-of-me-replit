import { useLocation } from 'wouter';
import { useAppStore, Domain } from '@/store';
import { ArrowLeft, Activity, BrainCircuit, Dumbbell, Music, ChevronRight, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { useMemo } from 'react';
import { ThemeToggle } from '@/components/theme-toggle';

const DomainIcon = ({ domain, className }: { domain: Domain, className?: string }) => {
  switch (domain) {
    case 'martial-arts': return <Activity className={className} />;
    case 'meditation': return <BrainCircuit className={className} />;
    case 'fitness': return <Dumbbell className={className} />;
    case 'music': return <Music className={className} />;
  }
};

type EscalationState = 'NOMINAL' | 'ADVISORY' | 'WARNING' | 'BREACH';

function getEscalationState(criticalCount: number, degradedCount: number, trendingDownCount: number): EscalationState {
  if (criticalCount > 0) return 'BREACH';
  if (degradedCount > 0) return 'WARNING';
  if (trendingDownCount > 1) return 'ADVISORY';
  return 'NOMINAL';
}

function escalationColor(state: EscalationState) {
  switch (state) {
    case 'BREACH':  return { text: 'text-status-critical',  bg: 'bg-status-critical/10',  border: 'border-status-critical/20' };
    case 'WARNING': return { text: 'text-status-degraded',  bg: 'bg-status-degraded/10',  border: 'border-status-degraded/20' };
    case 'ADVISORY':return { text: 'text-status-advisory',   bg: 'bg-status-advisory/10',   border: 'border-status-advisory/20' };
    case 'NOMINAL': return { text: 'text-status-healthy',   bg: 'bg-status-healthy/10',   border: 'border-status-healthy/20' };
  }
}

function escalationRationale(state: EscalationState, critDomains: string[], degDomains: string[], downDomains: string[]): string {
  switch (state) {
    case 'BREACH':
      return `System is in BREACH. SLO compliance has dropped critically below the session floor threshold in ${critDomains.join(', ')}. Per policy: cultivation is elevated to P1 priority. Decline all P2 and P3 demands. Schedule immediate makeup within 3 days and monitor until recovery to WARNING.`;
    case 'WARNING':
      return `System is in WARNING. Routine slippage detected across ${degDomains.join(', ')} — SLO compliance is below the green threshold for this 7-day window. Per policy: decline P3 demands, strictly time-box any P2 accepted. Schedule makeup sessions within 3 days to prevent escalation to BREACH.`;
    case 'ADVISORY':
      return `System is ADVISORY. All domains are above SLO floor, but ${downDomains.join(', ')} are trending downward versus the previous 7-day window. Per policy: note and monitor — no action change required. Avoid adding new recurring commitments until trend stabilizes.`;
    case 'NOMINAL':
      return 'System is NOMINAL. All domains are meeting or exceeding SLO targets and momentum is stable or improving. Full flex capacity: eligible to accept P2 demands and evaluate P3 demands for strategic alignment.';
  }
}

export default function SystemHealth() {
  const [_, setLocation] = useLocation();
  const sessions = useAppStore(state => state.sessions);
  const getDomainStatus = useAppStore(state => state.getDomainStatus);
  // Re-render and recompute the memo when API-backed policy state arrives.
  const policyState = useAppStore(state => state.policyState);

  const { escalation, domainsInfo, insights, compositeScore } = useMemo(() => {
    const domains: Domain[] = ['martial-arts', 'meditation', 'fitness', 'music'];
    let totalScore = 0;
    let criticalCount = 0;
    let degradedCount = 0;
    let trendingUpCount = 0;
    let trendingDownCount = 0;

    const domainsInfo = domains.map(d => {
      const status = getDomainStatus(d);
      totalScore += status.score;
      if (status.status === 'critical') criticalCount++;
      if (status.status === 'degraded') degradedCount++;
      if (status.trend === 'up') trendingUpCount++;
      if (status.trend === 'down') trendingDownCount++;
      return { domain: d, ...status };
    });

    const compositeScore = Math.round(totalScore / 4);
    const state = getEscalationState(criticalCount, degradedCount, trendingDownCount);
    const colors = escalationColor(state);

    const critDomains = domainsInfo.filter(d => d.status === 'critical').map(d => formatDomainName(d.domain));
    const degDomains = domainsInfo.filter(d => d.status === 'degraded').map(d => formatDomainName(d.domain));
    const downDomains = domainsInfo.filter(d => d.trend === 'down').map(d => formatDomainName(d.domain));

    const rationale = escalationRationale(state, critDomains, degDomains, downDomains);

    const sortedDomains = [...domainsInfo].sort((a, b) => a.score - b.score);
    const topDomain = [...domainsInfo].sort((a, b) => b.score - a.score)[0];
    const weakestDomain = sortedDomains[0];

    const insights = [
      {
        title: 'Primary Vulnerability',
        desc: weakestDomain.status !== 'healthy'
          ? `${formatDomainName(weakestDomain.domain)} is ${weakestDomain.status.toUpperCase()} at ${weakestDomain.recentMinutes}m this week (SLO: ${weakestDomain.targetMinutes}m). This is your system bottleneck — prioritize recovery here.`
          : `System is above SLO across all domains. ${formatDomainName(weakestDomain.domain)} is the relative weak point at ${weakestDomain.score}/100, but remains above minimum threshold. Maintain current cadence.`
      },
      {
        title: 'Momentum & Trajectory',
        desc: trendingDownCount === 0
          ? 'All domains are trending flat or positive vs the previous 7 days. You are building surplus capacity.'
          : trendingDownCount > 2
            ? `${trendingDownCount} domains are trending down vs the previous 7-day window. Widespread momentum decline — reduce optional commitments.`
            : `${trendingUpCount} domain${trendingUpCount !== 1 ? 's' : ''} trending up, ${trendingDownCount} slowing. Protect the domains with downward trajectories.`
      },
      {
        title: 'Policy Guidance',
        desc: state === 'NOMINAL'
          ? 'NOMINAL: Accept P2 demands normally. Evaluate P3 only for genuine high value or strategic leverage.'
          : state === 'ADVISORY'
            ? 'ADVISORY: Accept P2. Avoid new recurring P3 commitments until trends stabilize.'
            : state === 'WARNING'
              ? 'WARNING: Decline P3. Time-box any P2 accepted. Schedule makeup sessions within 3 days.'
              : 'BREACH: Cultivation is P1. Decline all P2 and P3 until system recovers to WARNING.'
      }
    ];

    return {
      escalation: { state, rationale, ...colors },
      domainsInfo: sortedDomains,
      insights,
      compositeScore
    };
  }, [sessions, getDomainStatus, policyState]);

  function formatDomainName(domain: string) {
    return domain.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  }

  const getDomainStatusColor = (status: string) => {
    switch (status) {
      case 'healthy': return 'text-status-healthy bg-status-healthy/10 border-status-healthy/20';
      case 'degraded': return 'text-status-degraded bg-status-degraded/10 border-status-degraded/20';
      case 'critical': return 'text-status-critical bg-status-critical/10 border-status-critical/20';
      default: return 'text-status-healthy bg-status-healthy/10 border-status-healthy/20';
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground font-sans transition-colors duration-300 pb-24">
      <header className="px-4 py-5 flex items-center justify-between sticky top-0 bg-background/90 backdrop-blur-xl border-b border-border/40 z-10">
        <div className="flex items-center gap-4">
          <button
            onClick={() => setLocation('/')}
            className="p-2 -ml-2 rounded-full active:scale-95 hover:bg-accent/50 text-muted-foreground transition-all"
          >
            <ArrowLeft className="w-6 h-6" />
          </button>
          <div>
            <h1 className="text-xl font-bold tracking-tight">System Health</h1>
            <p className="text-xs font-bold text-muted-foreground uppercase tracking-widest mt-0.5">DEEP DIAGNOSTIC</p>
          </div>
        </div>
        <ThemeToggle />
      </header>

      <main className="px-4 py-6 space-y-8">

        {/* Composite Score + Escalation State */}
        <section className={`border rounded-3xl p-6 shadow-sm relative overflow-hidden ${escalation.bg} ${escalation.border}`}>
          <div className="absolute -right-6 -top-6 w-32 h-32 bg-current/5 rounded-full blur-3xl opacity-30"></div>
          <div className="flex flex-col relative z-10">
            <div className="flex items-center justify-between mb-5">
              <div>
                <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-2">Composite Score</div>
                <div className={`text-5xl font-extrabold tracking-tighter ${escalation.text}`}>
                  {compositeScore}
                </div>
              </div>
              <div className={`px-4 py-2 rounded-2xl text-sm font-bold tracking-widest border ${escalation.bg} ${escalation.text} ${escalation.border}`}>
                {escalation.state}
              </div>
            </div>
            <div className="pt-4 border-t border-current/10">
              <p className="text-sm text-foreground leading-relaxed font-medium">
                {escalation.rationale}
              </p>
            </div>
          </div>
        </section>

        {/* Escalation Reference */}
        <section className="space-y-3">
          <h2 className="text-xs font-bold text-muted-foreground uppercase tracking-widest pl-2">Escalation Protocol</h2>
          <div className="grid grid-cols-2 gap-2">
            {([['NOMINAL','All SLOs met. Full flex capacity.','text-status-healthy bg-status-healthy/10'],
               ['ADVISORY','Trends declining. Note & monitor.','text-status-advisory bg-status-advisory/10'],
               ['WARNING','SLO slippage. Decline P3. Time-box P2.','text-status-degraded bg-status-degraded/10'],
               ['BREACH','Critical. Cultivation = P1.','text-status-critical bg-status-critical/10']] as const
            ).map(([state, desc, cls]) => (
              <div key={state} className={`rounded-2xl p-3.5 border border-transparent ${cls} ${escalation.state === state ? 'ring-2 ring-current/30' : ''}`}>
                <div className="font-bold text-xs tracking-widest mb-1">{state}</div>
                <div className="text-[10px] opacity-80 leading-snug font-medium">{desc}</div>
              </div>
            ))}
          </div>
        </section>

        {/* System Insights */}
        <section className="space-y-4">
          <h2 className="text-xs font-bold text-muted-foreground uppercase tracking-widest pl-2">System Insights</h2>
          <div className="grid gap-3">
            {insights.map((insight, i) => (
              <div key={i} className="bg-muted/40 border border-border/50 rounded-2xl p-4">
                <h3 className="font-semibold text-sm mb-1.5 text-foreground">{insight.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{insight.desc}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Domain State Board */}
        <section className="space-y-4">
          <h2 className="text-xs font-bold text-muted-foreground uppercase tracking-widest pl-2">Domain State Board</h2>
          <div className="grid gap-3">
            {domainsInfo.map(d => (
              <div
                key={d.domain}
                className={`bg-card border rounded-2xl p-4 flex flex-col gap-3 cursor-pointer hover:bg-accent/30 transition-all active:scale-[0.98] ${
                  d.status === 'critical' ? 'border-status-critical/30 ring-1 ring-status-critical/10' :
                  d.status === 'degraded' ? 'border-status-degraded/30' :
                  'border-border/50'
                }`}
                onClick={() => setLocation(`/domain/${d.domain}?from=system-health`)}
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="p-2.5 rounded-xl bg-muted text-foreground">
                      <DomainIcon domain={d.domain} className="w-5 h-5 opacity-80" />
                    </div>
                    <div>
                      <div className="font-bold capitalize text-foreground text-base tracking-tight">{d.domain.replace('-', ' ')}</div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="font-mono text-xs text-foreground">{d.score}/100</span>
                        <span className="text-[10px] text-muted-foreground">SLO: {d.targetMinutes}m/week</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    <div className={`px-3 py-1 rounded-full text-[10px] uppercase tracking-widest font-bold border ${getDomainStatusColor(d.status)}`}>
                      {d.status}
                    </div>
                    <ChevronRight className="w-4 h-4 text-muted-foreground/40" />
                  </div>
                </div>

                <div className="flex items-center gap-1 text-[11px] font-semibold pl-1">
                  {d.trend === 'up' && (
                    <span className="text-status-healthy flex items-center gap-1">
                      <TrendingUp className="w-3.5 h-3.5"/>
                      {d.recentMinutes}m vs {d.previousWeekMinutes}m (+{d.recentMinutes - d.previousWeekMinutes}m)
                    </span>
                  )}
                  {d.trend === 'down' && (
                    <span className="text-status-critical flex items-center gap-1">
                      <TrendingDown className="w-3.5 h-3.5"/>
                      {d.recentMinutes}m vs {d.previousWeekMinutes}m ({d.recentMinutes - d.previousWeekMinutes}m)
                    </span>
                  )}
                  {d.trend === 'flat' && (
                    <span className="text-foreground/50 flex items-center gap-1">
                      <Minus className="w-3.5 h-3.5"/>
                      {d.recentMinutes}m vs {d.previousWeekMinutes}m (flat)
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
