import { useState, useMemo, useEffect } from 'react';
import { useLocation } from 'wouter';
import { 
  Activity, 
  BrainCircuit, 
  Dumbbell, 
  Music, 
  Plus, 
  History, 
  GitPullRequestDraft,
  ChevronRight,
  Sun,
  Moon
} from 'lucide-react';
import { useAppStore, Domain } from '@/store';
import { Card, CardContent } from '@/components/ui/card';

const DomainIcon = ({ domain, className }: { domain: Domain, className?: string }) => {
  switch (domain) {
    case 'martial-arts': return <Activity className={className} />;
    case 'meditation': return <BrainCircuit className={className} />;
    case 'fitness': return <Dumbbell className={className} />;
    case 'music': return <Music className={className} />;
  }
};

const DomainCard = ({ domain, title }: { domain: Domain, title: string }) => {
  const [_, setLocation] = useLocation();
  const sessions = useAppStore(state => state.sessions);
  
  // Use stable references
  const getDomainStatus = useAppStore(state => state.getDomainStatus);
  const getWeakestDomain = useAppStore(state => state.getWeakestDomain);
  
  const domainStatus = getDomainStatus(domain);
  const weakest = getWeakestDomain();
  
  const { score, trend, status, recentMinutes, targetMinutes } = domainStatus;
  const isWeakest = weakest === domain;
  
  const getStatusColor = () => {
    switch (status) {
      case 'healthy': return 'bg-status-healthy';
      case 'degraded': return 'bg-status-degraded';
      case 'critical': return 'bg-status-critical';
      default: return 'bg-status-healthy';
    }
  };

  const getStatusTextColor = () => {
    switch (status) {
      case 'healthy': return 'text-status-healthy';
      case 'degraded': return 'text-status-degraded';
      case 'critical': return 'text-status-critical';
      default: return 'text-status-healthy';
    }
  };
  
  return (
    <Card 
      className={`relative overflow-hidden cursor-pointer transition-all active:scale-[0.98] bg-card border-border/60 hover:bg-accent/30 shadow-sm ${isWeakest ? 'ring-1 ring-status-critical/30' : ''}`}
      onClick={() => setLocation(`/domain/${domain}`)}
      data-testid={`card-domain-${domain}`}
    >
      <div className={`absolute top-0 left-0 w-1.5 h-full ${getStatusColor()} opacity-80`} />
      
      {isWeakest && (
        <div className="absolute top-3 right-3 flex h-2.5 w-2.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-status-critical opacity-60"></span>
          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-status-critical"></span>
        </div>
      )}

      <CardContent className="p-4 pl-6 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className={`p-3.5 rounded-2xl bg-${domain}/10 text-${domain}`}>
            <DomainIcon domain={domain} className="w-6 h-6" />
          </div>
          <div>
            <h3 className="font-semibold text-lg tracking-tight text-foreground">{title}</h3>
            <div className="flex items-center gap-2 mt-0.5">
              <div className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
                <span className="font-mono text-foreground/80">{score}/100</span>
                <span className="opacity-40 text-[10px]">•</span>
                <span className="text-xs">{recentMinutes}m / {targetMinutes}m</span>
                <span className="opacity-40 text-[10px]">•</span>
                <span>
                  {trend === 'up' && <span className="text-status-healthy font-bold" title="Trending up vs history">↗</span>}
                  {trend === 'down' && <span className="text-status-critical font-bold" title="Trending down vs history">↘</span>}
                  {trend === 'flat' && <span className="text-blue-500 font-bold" title="Holding steady">→</span>}
                </span>
              </div>
            </div>
          </div>
        </div>
        
        <div className="text-muted-foreground/30 pr-2">
          <ChevronRight className="w-5 h-5" />
        </div>
      </CardContent>
    </Card>
  );
};

export default function Dashboard() {
  const [_, setLocation] = useLocation();
  const theme = useAppStore(state => state.theme);
  const toggleTheme = useAppStore(state => state.toggleTheme);
  const getDomainStatus = useAppStore(state => state.getDomainStatus);
  const sessions = useAppStore(state => state.sessions);

  // Initialize theme class on mount
  useEffect(() => {
    const root = window.document.documentElement;
    if (theme === 'light') {
      root.classList.remove('dark');
      root.classList.add('light');
    } else {
      root.classList.remove('light');
      root.classList.add('dark');
    }
  }, [theme]);

  // Calculate overall composite health score
  const systemHealth = useMemo(() => {
    const domains: Domain[] = ['martial-arts', 'meditation', 'fitness', 'music'];
    let totalScore = 0;
    let criticalCount = 0;
    let degradedCount = 0;
    
    domains.forEach(d => {
      const { score, status } = getDomainStatus(d);
      totalScore += score;
      if (status === 'critical') criticalCount++;
      if (status === 'degraded') degradedCount++;
    });
    
    const average = Math.round(totalScore / 4);
    
    let sysStatus = 'Healthy';
    let sysColor = 'text-status-healthy';
    let sysBg = 'bg-status-healthy/10';
    
    if (criticalCount > 0) {
      sysStatus = 'Critical';
      sysColor = 'text-status-critical';
      sysBg = 'bg-status-critical/10';
    } else if (degradedCount > 0) {
      sysStatus = 'Degraded';
      sysColor = 'text-status-degraded';
      sysBg = 'bg-status-degraded/10';
    }
    
    return { score: average, status: sysStatus, color: sysColor, bg: sysBg };
  }, [sessions]); // Re-calculate when sessions change

  return (
    <div className="min-h-screen bg-background text-foreground pb-24 font-sans transition-colors duration-300">
      <header className="px-6 py-8 pb-6">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-foreground">SRE-of-Me</h1>
            <p className="text-sm font-medium text-muted-foreground mt-1 tracking-wide">SYSTEM OBSERVABILITY</p>
          </div>
          <div className="flex items-center gap-3">
            <button 
              onClick={toggleTheme}
              className="p-2.5 rounded-full bg-card shadow-sm border border-border/50 hover:bg-accent/50 text-foreground transition-all active:scale-95"
              aria-label="Toggle Theme"
            >
              {theme === 'dark' ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
            </button>
            <button 
              onClick={() => setLocation('/decide')}
              className="h-10 px-5 rounded-full bg-primary text-primary-foreground font-medium text-sm flex items-center gap-2 active:scale-95 transition-transform shadow-md shadow-primary/20"
              data-testid="button-decide"
            >
              <GitPullRequestDraft className="w-4 h-4" />
              Decide
            </button>
          </div>
        </div>
        
        {/* Composite Health Overview */}
        <div className="bg-card border border-border/50 rounded-3xl p-6 shadow-sm relative overflow-hidden">
          <div className="absolute -right-6 -top-6 w-32 h-32 bg-primary/5 rounded-full blur-3xl"></div>
          <div className="flex items-center justify-between relative z-10">
            <div>
              <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-2">System Health</div>
              <div className="flex items-center gap-3">
                <span className={`text-5xl font-extrabold tracking-tighter ${systemHealth.color}`}>
                  {systemHealth.score}
                </span>
              </div>
              <div className="text-xs text-muted-foreground mt-2 opacity-80 font-medium">Aggregate of 4 domain vitals</div>
            </div>
            <div className={`px-4 py-2 rounded-2xl text-sm font-bold tracking-wide ${systemHealth.bg} ${systemHealth.color}`}>
              {systemHealth.status}
            </div>
          </div>
        </div>
      </header>

      <main className="px-4 space-y-4">
        <div className="px-2 mb-2">
          <h2 className="text-sm font-bold text-muted-foreground uppercase tracking-widest">Domains</h2>
        </div>
        <div className="grid gap-3">
          <DomainCard domain="martial-arts" title="Martial Arts" />
          <DomainCard domain="meditation" title="Meditation" />
          <DomainCard domain="fitness" title="Fitness" />
          <DomainCard domain="music" title="Music" />
        </div>

        <div className="mt-8 flex gap-3 px-2">
          <button 
            onClick={() => setLocation('/log')}
            className="flex-1 bg-card border border-border/50 rounded-3xl p-5 flex flex-col items-center justify-center gap-3 active:scale-[0.98] transition-all hover:bg-accent/50 shadow-sm"
            data-testid="button-quick-log"
          >
            <div className="w-12 h-12 rounded-full bg-primary/10 text-primary flex items-center justify-center">
              <Plus className="w-6 h-6" />
            </div>
            <span className="text-sm font-semibold text-foreground">Quick Log</span>
          </button>
          
          <button 
            onClick={() => setLocation('/history')}
            className="flex-1 bg-card border border-border/50 rounded-3xl p-5 flex flex-col items-center justify-center gap-3 active:scale-[0.98] transition-all hover:bg-accent/50 shadow-sm"
            data-testid="button-history"
          >
            <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center">
              <History className="w-6 h-6 text-muted-foreground" />
            </div>
            <span className="text-sm font-semibold text-foreground">History</span>
          </button>
        </div>
      </main>
    </div>
  );
}