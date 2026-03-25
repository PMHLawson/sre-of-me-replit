import { useLocation } from 'wouter';
import { useAppStore, Domain } from '@/store';
import { ArrowLeft, Activity, BrainCircuit, Dumbbell, Music, Info, ChevronRight, TrendingUp, TrendingDown, Minus } from 'lucide-react';
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

export default function SystemHealth() {
  const [_, setLocation] = useLocation();
  const sessions = useAppStore(state => state.sessions);
  const getDomainStatus = useAppStore(state => state.getDomainStatus);
  
  // Calculate overall composite health score and gather deep insights
  const { systemHealth, domainsInfo, insights } = useMemo(() => {
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
    
    const average = Math.round(totalScore / 4);
    
    let sysStatus = 'Healthy';
    let sysColor = 'text-status-healthy';
    let sysBg = 'bg-status-healthy/10';
    let rationale = 'System is highly resilient. Baseline habits are secure, providing a stable foundation to take on optional tasks (P3) or experimental goals.';
    
    if (criticalCount > 0) {
      sysStatus = 'Critical Deficit';
      sysColor = 'text-status-critical';
      sysBg = 'bg-status-critical/10';
      rationale = `System is vulnerable. Core maintenance has dropped below safe minimums in ${criticalDomainsString(domainsInfo)}. Immediate load shedding is required to recover baseline. Reject non-essential demands.`;
    } else if (degradedCount > 0) {
      sysStatus = 'Degraded';
      sysColor = 'text-status-degraded';
      sysBg = 'bg-status-degraded/10';
      rationale = `System capacity is strained. Routine slippage detected in ${degradedDomainsString(domainsInfo)}. New commitments should be strictly time-boxed or deferred to prevent escalating to a critical deficit.`;
    } else if (trendingDownCount > 1) {
       rationale = `System is technically healthy, but momentum is slowing across multiple domains. Be cautious about adding new recurring commitments until trends stabilize.`;
    }

    const sortedDomains = domainsInfo.sort((a, b) => a.score - b.score);
    
    // Generate context-aware insights
    const topDomain = [...domainsInfo].sort((a, b) => b.score - a.score)[0];
    const weakestDomain = sortedDomains[0];
    
    const insights = [
      {
        title: "Current Vulnerability",
        desc: weakestDomain.status !== 'healthy' 
          ? `${formatDomainName(weakestDomain.domain)} is currently ${weakestDomain.status}. This is the primary limiting factor for your overall system capacity.`
          : `While healthy overall, ${formatDomainName(weakestDomain.domain)} is your relative weak point. Maintain current efforts to prevent slippage.`
      },
      {
        title: "Momentum",
        desc: trendingDownCount === 0 
          ? "You have zero domains trending downward compared to last week. Excellent consistency." 
          : trendingDownCount > 2 
            ? `Warning: ${trendingDownCount} domains are trending down compared to last week. This indicates widespread system fatigue.` 
            : `${trendingUpCount} domains are trending up, while ${trendingDownCount} are slowing down. Mixed momentum.`
      },
      {
        title: "Strongest Asset",
        desc: `${formatDomainName(topDomain.domain)} is anchoring the system at ${topDomain.score} health. It provides surplus resilience.`
      }
    ];
    
    return { 
      systemHealth: { score: average, status: sysStatus, color: sysColor, bg: sysBg, rationale },
      domainsInfo: sortedDomains,
      insights
    };
  }, [sessions, getDomainStatus]);

  function formatDomainName(domain: string) {
    return domain.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  }

  function criticalDomainsString(domains: any[]) {
    return domains.filter(d => d.status === 'critical').map(d => formatDomainName(d.domain)).join(', ');
  }
  
  function degradedDomainsString(domains: any[]) {
    return domains.filter(d => d.status === 'degraded').map(d => formatDomainName(d.domain)).join(', ');
  }

  const getStatusColor = (status: string) => {
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
        <section className="bg-card border border-border/50 rounded-3xl p-6 shadow-sm relative overflow-hidden">
          <div className="absolute -right-6 -top-6 w-32 h-32 bg-primary/5 rounded-full blur-3xl"></div>
          <div className="flex flex-col relative z-10">
            <div className="flex items-center justify-between mb-5">
              <div>
                <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-2">Composite Score</div>
                <div className={`text-5xl font-extrabold tracking-tighter ${systemHealth.color}`}>
                  {systemHealth.score}
                </div>
              </div>
              <div className={`px-4 py-2 rounded-2xl text-sm font-bold tracking-wide ${systemHealth.bg} ${systemHealth.color}`}>
                {systemHealth.status}
              </div>
            </div>
            <div className="pt-4 border-t border-border/40">
              <p className="text-sm text-foreground leading-relaxed font-medium">
                {systemHealth.rationale}
              </p>
            </div>
          </div>
        </section>

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

        <section className="space-y-4">
          <h2 className="text-xs font-bold text-muted-foreground uppercase tracking-widest pl-2">Domain State Board</h2>
          <div className="grid gap-3">
            {domainsInfo.map(d => (
              <div 
                key={d.domain} 
                className={`bg-card border rounded-2xl p-4 flex flex-col gap-4 cursor-pointer hover:bg-accent/30 transition-all active:scale-[0.98] ${
                  d.status === 'critical' ? 'border-status-critical/30 ring-1 ring-status-critical/10' :
                  d.status === 'degraded' ? 'border-status-degraded/30' :
                  'border-border/50'
                }`}
                onClick={() => setLocation(`/domain/${d.domain}`)}
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className={`p-2.5 rounded-xl bg-muted text-foreground`}>
                      <DomainIcon domain={d.domain} className="w-5 h-5 opacity-80" />
                    </div>
                    <div>
                      <div className="font-bold capitalize text-foreground text-base tracking-tight">{d.domain.replace('-', ' ')}</div>
                      <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground font-medium">
                        <span className="font-mono text-foreground">{d.score}/100</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    <div className={`px-3 py-1 rounded-full text-[10px] uppercase tracking-widest font-bold ${getStatusColor(d.status)}`}>
                      {d.status}
                    </div>
                    <div className="flex items-center gap-1 text-xs font-bold text-muted-foreground" title={`${d.recentMinutes}m this week vs ${d.previousWeekMinutes}m last week`}>
                      {d.trend === 'up' && <span className="text-status-healthy flex items-center"><TrendingUp className="w-3 h-3 mr-1"/> Up</span>}
                      {d.trend === 'down' && <span className="text-status-critical flex items-center"><TrendingDown className="w-3 h-3 mr-1"/> Down</span>}
                      {d.trend === 'flat' && <span className="text-foreground/50 flex items-center"><Minus className="w-3 h-3 mr-1"/> Flat</span>}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}