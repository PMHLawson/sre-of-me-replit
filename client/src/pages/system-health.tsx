import { useLocation } from 'wouter';
import { useAppStore, Domain } from '@/store';
import { ArrowLeft, Activity, BrainCircuit, Dumbbell, Music, Info, ChevronRight } from 'lucide-react';
import { useMemo } from 'react';

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
  
  // Calculate overall composite health score
  const { systemHealth, domainsInfo } = useMemo(() => {
    const domains: Domain[] = ['martial-arts', 'meditation', 'fitness', 'music'];
    let totalScore = 0;
    let criticalCount = 0;
    let degradedCount = 0;
    
    const domainsInfo = domains.map(d => {
      const status = getDomainStatus(d);
      totalScore += status.score;
      if (status.status === 'critical') criticalCount++;
      if (status.status === 'degraded') degradedCount++;
      return { domain: d, ...status };
    });
    
    const average = Math.round(totalScore / 4);
    
    let sysStatus = 'Healthy';
    let sysColor = 'text-status-healthy';
    let sysBg = 'bg-status-healthy/10';
    let rationale = 'All domains are currently tracking well against targets. Surplus capacity is available.';
    
    if (criticalCount > 0) {
      sysStatus = 'Critical Deficit';
      sysColor = 'text-status-critical';
      sysBg = 'bg-status-critical/10';
      rationale = `${criticalCount} domain(s) have fallen critically behind baseline. Shed optional load to focus on recovery.`;
    } else if (degradedCount > 0) {
      sysStatus = 'Degraded';
      sysColor = 'text-status-degraded';
      sysBg = 'bg-status-degraded/10';
      rationale = `${degradedCount} domain(s) are tracking behind baseline. Time-box demands to prevent further decay.`;
    }
    
    return { 
      systemHealth: { score: average, status: sysStatus, color: sysColor, bg: sysBg, rationale },
      domainsInfo: domainsInfo.sort((a, b) => a.score - b.score) // Sort by score ascending (weakest first)
    };
  }, [sessions, getDomainStatus]);

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
            <p className="text-xs font-bold text-muted-foreground uppercase tracking-widest mt-0.5">COMPOSITE STATE</p>
          </div>
        </div>
      </header>

      <main className="px-4 py-6 space-y-8">
        <section className="bg-card border border-border/50 rounded-3xl p-6 shadow-sm relative overflow-hidden">
          <div className="absolute -right-6 -top-6 w-32 h-32 bg-primary/5 rounded-full blur-3xl"></div>
          <div className="flex flex-col relative z-10">
            <div className="flex items-center justify-between mb-4">
              <div>
                <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-2">Overall Score</div>
                <div className={`text-5xl font-extrabold tracking-tighter ${systemHealth.color}`}>
                  {systemHealth.score}
                </div>
              </div>
              <div className={`px-4 py-2 rounded-2xl text-sm font-bold tracking-wide ${systemHealth.bg} ${systemHealth.color}`}>
                {systemHealth.status}
              </div>
            </div>
            <div className="pt-4 border-t border-border/40">
              <p className="text-sm text-foreground/80 leading-relaxed font-medium">
                {systemHealth.rationale}
              </p>
            </div>
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="text-xs font-bold text-muted-foreground uppercase tracking-widest pl-2">Domain Contributions</h2>
          <div className="grid gap-3">
            {domainsInfo.map(d => (
              <div 
                key={d.domain} 
                className={`bg-card border rounded-2xl p-4 flex flex-col gap-3 cursor-pointer hover:bg-accent/30 transition-all active:scale-[0.98] ${
                  d.status === 'critical' ? 'border-status-critical/30 ring-1 ring-status-critical/10' :
                  d.status === 'degraded' ? 'border-status-degraded/30' :
                  'border-border/50'
                }`}
                onClick={() => setLocation(`/domain/${d.domain}`)}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className={`p-2 rounded-lg bg-muted text-foreground`}>
                      <DomainIcon domain={d.domain} className="w-5 h-5 opacity-70" />
                    </div>
                    <div>
                      <div className="font-bold capitalize text-foreground text-base">{d.domain.replace('-', ' ')}</div>
                      <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground font-medium">
                        <span className="font-mono">{d.score}/100</span>
                        <span className="opacity-40">•</span>
                        <span>{d.recentMinutes}m / {d.targetMinutes}m</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className={`px-3 py-1 rounded-full text-[10px] uppercase tracking-widest font-bold ${getStatusColor(d.status)}`}>
                      {d.status}
                    </div>
                    <ChevronRight className="w-4 h-4 text-muted-foreground/40" />
                  </div>
                </div>
                
                <div className="text-sm text-foreground/70 flex items-start gap-2 pt-2 border-t border-border/30 mt-1">
                  <Info className="w-4 h-4 shrink-0 opacity-50 mt-0.5" />
                  <span className="leading-snug">
                    {d.status === 'critical' ? 'Critically below baseline. Immediate recovery sessions required.' :
                     d.status === 'degraded' ? 'Falling behind baseline. Consider prioritizing this domain soon.' :
                     'Tracking well against targets. Surplus capacity is available here.'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}