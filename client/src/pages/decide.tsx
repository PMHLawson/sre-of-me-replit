import { useState } from 'react';
import { useLocation } from 'wouter';
import { ArrowLeft, AlertTriangle, ShieldCheck, HelpCircle, Check } from 'lucide-react';
import { useAppStore } from '@/store';

type Priority = 'P1' | 'P2' | 'P3' | null;

export default function Decide() {
  const [_, setLocation] = useLocation();
  const [priority, setPriority] = useState<Priority>(null);
  
  const getWeakestDomain = useAppStore(state => state.getWeakestDomain);
  const getDomainStatus = useAppStore(state => state.getDomainStatus);
  
  const weakest = getWeakestDomain();
  const weakestStatus = getDomainStatus(weakest);
  
  // Aggregate data for reasoning engine
  const domains: ('martial-arts' | 'meditation' | 'fitness' | 'music')[] = ['martial-arts', 'meditation', 'fitness', 'music'];
  const allStatuses = domains.map(d => ({ domain: d, ...getDomainStatus(d) }));
  const criticalDomains = allStatuses.filter(s => s.status === 'critical');
  const degradedDomains = allStatuses.filter(s => s.status === 'degraded');
  
  const isSystemCritical = criticalDomains.length > 0;
  const isSystemDegraded = degradedDomains.length > 0;
  
  const formatDomainsList = (doms: typeof allStatuses) => 
    doms.map(d => d.domain.replace('-', ' ')).join(', ');
  
  // Logic engine for decisions
  const evaluate = () => {
    if (!priority) return null;
    
    if (priority === 'P1') {
      return {
        recommendation: 'Accept',
        action: 'Immediate Execution Required',
        state: 'Override',
        reason: `Priority 1 overrides all current system protections. Accept the demand, but note that this will further delay recovery of ${weakest.replace('-',' ')} which is currently at ${weakestStatus.score}% health.`,
        color: 'text-status-critical',
        bg: 'bg-status-critical/10'
      };
    }
    
    if (priority === 'P2') {
      if (isSystemCritical) {
        return {
          recommendation: 'Decline / Defer',
          action: `Protect schedule. Recover ${weakest.replace('-', ' ')}.`,
          state: 'Active Load Shedding',
          reason: `System is in a protective state. ${criticalDomains.length} domains (including ${weakest.replace('-', ' ')}) are in critical condition. P2 demands introduce an unacceptable risk of systemic failure right now.`,
          color: 'text-status-degraded',
          bg: 'bg-status-degraded/10'
        };
      }
      if (isSystemDegraded) {
        return {
          recommendation: 'Accept with Constraints',
          action: 'Strictly time-box the execution.',
          state: 'Degraded Capacity',
          reason: `System is degraded in ${formatDomainsList(degradedDomains)}. P2 can be absorbed, but strict time-boxing is required to ensure recovery tasks aren't cannibalized.`,
          color: 'text-status-degraded',
          bg: 'bg-status-degraded/10'
        };
      }
      return {
        recommendation: 'Accept',
        action: 'Execute normally.',
        state: 'Absorbable Capacity',
        reason: 'System health is strong across all domains. Sufficient resilience exists to absorb P2 demands without destabilizing core routines.',
        color: 'text-status-healthy',
        bg: 'bg-status-healthy/10'
      };
    }
    
    // P3 Logic
    if (isSystemCritical || isSystemDegraded) {
      return {
        recommendation: 'Decline',
        action: 'Reject immediately without guilt.',
        state: 'Capacity Exhausted',
        reason: `System is currently running a deficit (weakest: ${weakest.replace('-', ' ')}). All P3 (optional) demands must be shed to protect baseline recovery.`,
        color: 'text-status-critical',
        bg: 'bg-status-critical/10'
      };
    }
    
    return {
      recommendation: 'Evaluate',
      action: 'Verify alignment with core goals.',
      state: 'Surplus Capacity',
      reason: 'System is healthy and can absorb this. However, as a P3, only accept if it genuinely provides high value or joy, otherwise preserve the surplus capacity.',
      color: 'text-blue-500',
      bg: 'bg-blue-500/10'
    };
  };

  const result = evaluate();

  return (
    <div className="min-h-screen bg-background text-foreground font-sans transition-colors duration-300">
      <header className="px-4 py-5 flex items-center gap-4 sticky top-0 bg-background/90 backdrop-blur-xl border-b border-border/40 z-10">
        <button 
          onClick={() => setLocation('/')}
          className="p-2 -ml-2 rounded-full active:scale-95 hover:bg-accent/50 text-muted-foreground transition-all"
        >
          <ArrowLeft className="w-6 h-6" />
        </button>
        <div>
          <h1 className="text-xl font-bold tracking-tight">Decide</h1>
          <p className="text-xs font-bold text-muted-foreground uppercase tracking-widest mt-0.5">INCIDENT RESPONSE</p>
        </div>
      </header>

      <main className="px-4 py-8 space-y-10">
        <section>
          <h2 className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-4 pl-1">Classify Demand</h2>
          <div className="space-y-3">
            {[
              { id: 'P1', label: 'Priority 1', desc: 'Critical, unmovable, severe consequence' },
              { id: 'P2', label: 'Priority 2', desc: 'Important, time-sensitive' },
              { id: 'P3', label: 'Priority 3', desc: 'Optional, deferrable, favors' }
            ].map(p => (
              <button
                key={p.id}
                onClick={() => setPriority(p.id as Priority)}
                className={`w-full p-5 rounded-3xl border text-left transition-all flex items-center justify-between shadow-sm active:scale-[0.98] ${
                  priority === p.id 
                    ? 'border-primary bg-primary/5 text-foreground ring-2 ring-primary/20' 
                    : 'border-border/60 bg-card text-muted-foreground hover:bg-accent/30'
                }`}
                data-testid={`button-priority-${p.id}`}
              >
                <div>
                  <div className={`font-bold text-lg ${priority === p.id ? 'text-foreground' : 'text-foreground/80'}`}>{p.id}</div>
                  <div className="text-sm mt-1">{p.desc}</div>
                </div>
                {priority === p.id && <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center"><Check className="w-5 h-5 text-primary" /></div>}
              </button>
            ))}
          </div>
        </section>

        {result && (
          <section className="animate-in fade-in slide-in-from-bottom-4 duration-300">
            <div className={`rounded-3xl border p-7 space-y-6 shadow-sm border-current/10 ${result.bg} ${result.color}`}>
              <div className="flex items-start justify-between border-b border-current/10 pb-5">
                <div>
                  <div className="text-xs font-bold uppercase tracking-widest opacity-70 mb-1.5">Recommendation</div>
                  <div className="text-4xl font-extrabold tracking-tight">
                    {result.recommendation}
                  </div>
                </div>
                {result.recommendation === 'Accept' && <ShieldCheck className="w-10 h-10 opacity-90" />}
                {result.recommendation.includes('Decline') && <AlertTriangle className="w-10 h-10 opacity-90" />}
                {result.recommendation === 'Evaluate' && <HelpCircle className="w-10 h-10 opacity-90" />}
              </div>
              
              <div className="space-y-5">
                <div>
                  <div className="text-xs font-bold uppercase tracking-widest opacity-70 mb-1.5">System State</div>
                  <div className="font-semibold text-lg text-foreground">{result.state}</div>
                </div>
                
                <div>
                  <div className="text-xs font-bold uppercase tracking-widest opacity-70 mb-1.5">Rationale</div>
                  <div className="text-base leading-relaxed text-foreground/90">{result.reason}</div>
                </div>
                
                <div className="pt-2">
                  <div className="text-xs font-bold uppercase tracking-widest opacity-70 mb-1.5">Next Action</div>
                  <div className="font-bold bg-background/50 backdrop-blur-sm p-4 rounded-2xl text-foreground border border-current/10">
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