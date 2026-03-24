import { useState } from 'react';
import { useLocation } from 'wouter';
import { 
  Activity, 
  BrainCircuit, 
  Dumbbell, 
  Music, 
  Plus, 
  History, 
  GitPullRequestDraft,
  ChevronRight
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
  
  // Subscribe to sessions to trigger re-renders when data changes
  const sessions = useAppStore(state => state.sessions);
  
  // Get functions directly (stable references) to avoid infinite loops in Zustand selectors
  const getDomainStatus = useAppStore(state => state.getDomainStatus);
  const getWeakestDomain = useAppStore(state => state.getWeakestDomain);
  
  // Calculate derived state during render
  const { score, trend, status } = getDomainStatus(domain);
  const weakest = getWeakestDomain();
  
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
      className={`relative overflow-hidden cursor-pointer transition-all active:scale-[0.98] ${isWeakest ? 'ring-2 ring-primary/50' : 'border-white/5'}`}
      onClick={() => setLocation(`/log?domain=${domain}`)}
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
            <h3 className="font-medium text-lg tracking-tight">{title}</h3>
            <div className="flex items-center gap-2 mt-1">
              <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <span className="font-mono">{score}</span>
                <span>
                  {trend === 'up' && '↗'}
                  {trend === 'down' && '↘'}
                  {trend === 'flat' && '→'}
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

  return (
    <div className="min-h-screen bg-background text-foreground pb-24 font-sans">
      <header className="px-6 py-8 pb-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">SRE-of-Me</h1>
            <p className="text-sm text-muted-foreground mt-1">System Observability</p>
          </div>
          <button 
            onClick={() => setLocation('/decide')}
            className="h-10 px-4 rounded-full bg-primary text-primary-foreground font-medium text-sm flex items-center gap-2 active:scale-95 transition-transform"
            data-testid="button-decide"
          >
            <GitPullRequestDraft className="w-4 h-4" />
            Decide
          </button>
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
            className="flex-1 bg-card border border-white/5 rounded-2xl p-4 flex flex-col items-center justify-center gap-2 active:scale-[0.98] transition-all"
            data-testid="button-quick-log"
          >
            <div className="w-10 h-10 rounded-full bg-primary/10 text-primary flex items-center justify-center">
              <Plus className="w-5 h-5" />
            </div>
            <span className="text-sm font-medium">Quick Log</span>
          </button>
          
          <button 
            onClick={() => setLocation('/history')}
            className="flex-1 bg-card border border-white/5 rounded-2xl p-4 flex flex-col items-center justify-center gap-2 active:scale-[0.98] transition-all"
            data-testid="button-history"
          >
            <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
              <History className="w-5 h-5 text-muted-foreground" />
            </div>
            <span className="text-sm font-medium">History</span>
          </button>
        </div>
      </main>
    </div>
  );
}