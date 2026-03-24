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
  
  const { score, trend, status } = domainStatus;
  const isWeakest = weakest === domain;
  
  const getStatusColor = () => {
    switch (status) {
      case 'healthy': return 'bg-status-healthy';
      case 'degraded': return 'bg-status-degraded';
      case 'critical': return 'bg-status-critical';
      default: return 'bg-status-healthy';
    }
  };
  
  return (
    <Card 
      className={`relative overflow-hidden cursor-pointer transition-all active:scale-[0.98] bg-card border-border/50 hover:bg-accent/5 ${isWeakest ? 'ring-2 ring-status-critical/50' : ''}`}
      onClick={() => setLocation(`/domain/${domain}`)}
      data-testid={`card-domain-${domain}`}
    >
      <div className={`absolute top-0 left-0 w-1.5 h-full ${getStatusColor()}`} />
      
      {isWeakest && (
        <div className="absolute top-2 right-2 flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-status-critical opacity-75"></span>
          <span className="relative inline-flex rounded-full h-2 w-2 bg-status-critical"></span>
        </div>
      )}

      <CardContent className="p-4 pl-6 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className={`p-3 rounded-xl bg-${domain}/10 text-${domain}`}>
            <DomainIcon domain={domain} className="w-6 h-6" />
          </div>
          <div>
            <h3 className="font-medium text-lg tracking-tight text-foreground">{title}</h3>
            <div className="flex items-center gap-2 mt-1">
              <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <span className="font-mono">{score}</span>
                <span>
                  {trend === 'up' && <span className="text-emerald-500">↗</span>}
                  {trend === 'down' && <span className="text-rose-500">↘</span>}
                  {trend === 'flat' && <span className="text-blue-500">→</span>}
                </span>
              </div>
            </div>
          </div>
        </div>
        
        <div className="text-muted-foreground/50">
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
    let sysColor = 'text-emerald-500';
    let sysBg = 'bg-emerald-500/10';
    
    if (criticalCount > 0) {
      sysStatus = 'Critical';
      sysColor = 'text-rose-500';
      sysBg = 'bg-rose-500/10';
    } else if (degradedCount > 0) {
      sysStatus = 'Degraded';
      sysColor = 'text-amber-500';
      sysBg = 'bg-amber-500/10';
    }
    
    return { score: average, status: sysStatus, color: sysColor, bg: sysBg };
  }, [sessions]); // Re-calculate when sessions change

  return (
    <div className="min-h-screen bg-background text-foreground pb-24 font-sans transition-colors duration-200">
      <header className="px-6 py-6 pb-4">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">SRE-of-Me</h1>
          </div>
          <div className="flex items-center gap-3">
            <button 
              onClick={toggleTheme}
              className="p-2 rounded-full hover:bg-black/5 dark:hover:bg-white/5 text-muted-foreground transition-colors"
              aria-label="Toggle Theme"
            >
              {theme === 'dark' ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
            </button>
            <button 
              onClick={() => setLocation('/decide')}
              className="h-9 px-4 rounded-full bg-primary text-primary-foreground font-medium text-sm flex items-center gap-2 active:scale-95 transition-transform"
              data-testid="button-decide"
            >
              <GitPullRequestDraft className="w-4 h-4" />
              Decide
            </button>
          </div>
        </div>
        
        {/* Composite Health Overview */}
        <div className="bg-card border border-border/50 rounded-2xl p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-1">System Health</div>
              <div className="flex items-center gap-3">
                <span className={`text-4xl font-bold tracking-tighter ${systemHealth.color}`}>
                  {systemHealth.score}
                </span>
              </div>
            </div>
            <div className={`px-4 py-2 rounded-xl text-sm font-medium tracking-wide ${systemHealth.bg} ${systemHealth.color}`}>
              {systemHealth.status}
            </div>
          </div>
        </div>
      </header>

      <main className="px-4 space-y-4">
        <div className="grid gap-3">
          <DomainCard domain="martial-arts" title="Martial Arts" />
          <DomainCard domain="meditation" title="Meditation" />
          <DomainCard domain="fitness" title="Fitness" />
          <DomainCard domain="music" title="Music" />
        </div>

        <div className="mt-8 flex gap-3">
          <button 
            onClick={() => setLocation('/log')}
            className="flex-1 bg-card border border-border/50 rounded-2xl p-4 flex flex-col items-center justify-center gap-2 active:scale-[0.98] transition-all hover:bg-accent/5 shadow-sm"
            data-testid="button-quick-log"
          >
            <div className="w-10 h-10 rounded-full bg-primary/10 text-primary flex items-center justify-center">
              <Plus className="w-5 h-5" />
            </div>
            <span className="text-sm font-medium text-foreground">Quick Log</span>
          </button>
          
          <button 
            onClick={() => setLocation('/history')}
            className="flex-1 bg-card border border-border/50 rounded-2xl p-4 flex flex-col items-center justify-center gap-2 active:scale-[0.98] transition-all hover:bg-accent/5 shadow-sm"
            data-testid="button-history"
          >
            <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
              <History className="w-5 h-5 text-muted-foreground" />
            </div>
            <span className="text-sm font-medium text-foreground">History</span>
          </button>
        </div>
      </main>
    </div>
  );
}