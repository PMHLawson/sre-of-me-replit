import { useState } from 'react';
import { useLocation } from 'wouter';
import { ArrowLeft, AlertTriangle, ShieldCheck, HelpCircle } from 'lucide-react';
import { useAppStore } from '@/store';

type Priority = 'P1' | 'P2' | 'P3' | null;

export default function Decide() {
  const [_, setLocation] = useLocation();
  const [priority, setPriority] = useState<Priority>(null);
  
  const getWeakestDomain = useAppStore(state => state.getWeakestDomain);
  const getDomainStatus = useAppStore(state => state.getDomainStatus);
  
  const weakest = getWeakestDomain();
  const { status, score } = getDomainStatus(weakest);
  
  // Logic engine for decisions
  const evaluate = () => {
    if (!priority) return null;
    
    const isSystemCritical = status === 'critical' || score < 50;
    const isSystemDegraded = status === 'degraded' || score < 75;
    
    if (priority === 'P1') {
      return {
        recommendation: 'Accept',
        action: 'Accept and Execute',
        state: 'Override',
        reason: 'P1 demands bypass normal system protection policies.',
        color: 'text-rose-500',
        bg: 'bg-rose-500/10'
      };
    }
    
    if (priority === 'P2') {
      if (isSystemCritical) {
        return {
          recommendation: 'Decline / Defer',
          action: `Prioritize ${weakest.replace('-', ' ')} recovery`,
          state: 'Critical Protection',
          reason: `System is critically degraded (${weakest}). P2 demands cannot be safely absorbed.`,
          color: 'text-amber-500',
          bg: 'bg-amber-500/10'
        };
      }
      return {
        recommendation: 'Accept',
        action: 'Accept with monitoring',
        state: 'Safe to absorb',
        reason: 'System health is adequate to absorb P2 demands.',
        color: 'text-emerald-500',
        bg: 'bg-emerald-500/10'
      };
    }
    
    // P3 Logic
    if (isSystemCritical || isSystemDegraded) {
      return {
        recommendation: 'Decline',
        action: 'Reject immediately',
        state: 'Active Shedding',
        reason: 'System is degraded. Load shedding all P3 demands.',
        color: 'text-rose-500',
        bg: 'bg-rose-500/10'
      };
    }
    
    return {
      recommendation: 'Evaluate',
      action: 'Evaluate vs Optional',
      state: 'Healthy',
      reason: 'System is healthy. Accept only if it aligns with goals.',
      color: 'text-blue-500',
      bg: 'bg-blue-500/10'
    };
  };

  const result = evaluate();

  return (
    <div className="min-h-screen bg-background text-foreground font-sans">
      <header className="px-4 py-4 flex items-center gap-4 sticky top-0 bg-background/80 backdrop-blur-md">
        <button 
          onClick={() => setLocation('/')}
          className="p-2 -ml-2 rounded-full active:bg-white/5"
        >
          <ArrowLeft className="w-6 h-6" />
        </button>
        <div>
          <h1 className="text-xl font-medium tracking-tight">Decide</h1>
          <p className="text-xs text-muted-foreground font-mono">INCIDENT RESPONSE</p>
        </div>
      </header>

      <main className="px-4 py-6 space-y-8">
        <section>
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-4">Classify Demand</h2>
          <div className="space-y-3">
            {[
              { id: 'P1', label: 'Priority 1', desc: 'Critical, unmovable, severe consequence' },
              { id: 'P2', label: 'Priority 2', desc: 'Important, time-sensitive' },
              { id: 'P3', label: 'Priority 3', desc: 'Optional, deferrable, favors' }
            ].map(p => (
              <button
                key={p.id}
                onClick={() => setPriority(p.id as Priority)}
                className={`w-full p-4 rounded-xl border text-left transition-all flex items-center justify-between ${
                  priority === p.id 
                    ? 'border-primary bg-primary/5 text-foreground ring-1 ring-primary/20' 
                    : 'border-white/5 bg-card text-muted-foreground'
                }`}
                data-testid={`button-priority-${p.id}`}
              >
                <div>
                  <div className="font-semibold text-lg">{p.id}</div>
                  <div className="text-sm opacity-80 mt-0.5">{p.desc}</div>
                </div>
                {priority === p.id && <Check className="w-5 h-5 text-primary" />}
              </button>
            ))}
          </div>
        </section>

        {result && (
          <section className="animate-in fade-in slide-in-from-bottom-4 duration-300">
            <div className={`rounded-2xl border border-white/5 p-6 space-y-6 ${result.bg} bg-opacity-50`}>
              <div className="flex items-start justify-between border-b border-white/10 pb-4">
                <div>
                  <div className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-1">Recommendation</div>
                  <div className={`text-3xl font-bold tracking-tight ${result.color}`}>
                    {result.recommendation}
                  </div>
                </div>
                {result.recommendation === 'Accept' && <ShieldCheck className={`w-8 h-8 ${result.color}`} />}
                {result.recommendation.includes('Decline') && <AlertTriangle className={`w-8 h-8 ${result.color}`} />}
                {result.recommendation === 'Evaluate' && <HelpCircle className={`w-8 h-8 ${result.color}`} />}
              </div>
              
              <div className="space-y-4">
                <div>
                  <div className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-1">System State</div>
                  <div className="font-medium">{result.state}</div>
                </div>
                
                <div>
                  <div className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-1">Rationale</div>
                  <div className="text-sm leading-relaxed">{result.reason}</div>
                </div>
                
                <div className="pt-2">
                  <div className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-1">Next Action</div>
                  <div className="font-medium bg-black/20 p-3 rounded-lg border border-white/5">
                    {result.action}
                  </div>
                </div>
              </div>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}