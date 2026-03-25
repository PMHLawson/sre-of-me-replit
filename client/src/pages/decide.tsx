import { useState } from 'react';
import { useLocation } from 'wouter';
import { ArrowLeft, AlertTriangle, ShieldCheck, HelpCircle, Check, Info } from 'lucide-react';
import { useAppStore } from '@/store';
import { ThemeToggle } from '@/components/theme-toggle';

type Priority = 'P1' | 'P2' | 'P3' | null;

export default function Decide() {
  const [_, setLocation] = useLocation();
  const [priority, setPriority] = useState<Priority>(null);
  
  const getWeakestDomain = useAppStore(state => state.getWeakestDomain);
  const getDomainStatus = useAppStore(state => state.getDomainStatus);
  
  const { domain: weakestDomain } = getWeakestDomain();
  const weakestStatus = getDomainStatus(weakestDomain);
  
  // Aggregate data for reasoning engine
  const domains: ('martial-arts' | 'meditation' | 'fitness' | 'music')[] = ['martial-arts', 'meditation', 'fitness', 'music'];
  const allStatuses = domains.map(d => ({ domain: d, ...getDomainStatus(d) }));
  const criticalDomains = allStatuses.filter(s => s.status === 'critical');
  const degradedDomains = allStatuses.filter(s => s.status === 'degraded');
  const trendingDownDomains = allStatuses.filter(s => s.trend === 'down');
  
  const isSystemCritical = criticalDomains.length > 0;
  const isSystemDegraded = degradedDomains.length > 0;
  const isSystemLosingMomentum = trendingDownDomains.length > 1; // 2+ domains dropping
  
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
        reason: `Priority 1 demands override all system protections. Accept the demand immediately. Note that this will consume capacity and further delay recovery of vulnerable domains like ${weakestDomain ? weakestDomain.replace('-',' ') : 'your weakest areas'}.`,
        color: 'text-status-critical',
        bg: 'bg-status-critical/10'
      };
    }
    
    if (priority === 'P2') {
      if (isSystemCritical) {
        return {
          recommendation: 'Decline / Defer',
          action: `Protect schedule. Recover ${weakestDomain ? weakestDomain.replace('-', ' ') : 'critical domains'}.`,
          state: 'Active Load Shedding',
          reason: `System is in a protective state. Core maintenance has failed in ${formatDomainsList(criticalDomains)}. A P2 demand introduces unacceptable risk of systemic failure. You must shed this load to prioritize recovery.`,
          color: 'text-status-degraded',
          bg: 'bg-status-degraded/10'
        };
      }
      if (isSystemDegraded) {
        return {
          recommendation: 'Accept with Constraints',
          action: 'Strictly time-box the execution.',
          state: 'Degraded Capacity',
          reason: `System is currently strained due to slippage in ${formatDomainsList(degradedDomains)}. You can absorb this P2, but you must strictly time-box it to ensure your scheduled recovery tasks aren't cannibalized today.`,
          color: 'text-status-degraded',
          bg: 'bg-status-degraded/10'
        };
      }
      if (isSystemLosingMomentum) {
        return {
          recommendation: 'Accept but Monitor',
          action: 'Execute, but watch energy levels.',
          state: 'Slowing Momentum',
          reason: `System is technically healthy, but momentum is dropping in ${formatDomainsList(trendingDownDomains)}. You can accept this P2, but be aware that systemic fatigue is building. Avoid making this a recurring commitment.`,
          color: 'text-status-healthy',
          bg: 'bg-status-healthy/10'
        };
      }
      return {
        recommendation: 'Accept',
        action: 'Execute normally.',
        state: 'Absorbable Capacity',
        reason: 'System health is strong and stable across all domains. Sufficient baseline resilience exists to comfortably absorb P2 demands without destabilizing your core routines.',
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
        reason: `System is currently running a deficit (primary vulnerability: ${weakestDomain ? weakestDomain.replace('-', ' ') : 'baseline maintenance'}). All P3 (optional) demands must be instantly shed to protect baseline recovery and prevent burnout.`,
        color: 'text-status-critical',
        bg: 'bg-status-critical/10'
      };
    }
    
    if (isSystemLosingMomentum) {
       return {
        recommendation: 'Decline / Defer',
        action: 'Reject to protect momentum.',
        state: 'Preserving Energy',
        reason: `While the system is technically healthy, downward trends in ${formatDomainsList(trendingDownDomains)} indicate dropping energy. P3 tasks should be deferred until momentum stabilizes across the board.`,
        color: 'text-status-degraded',
        bg: 'bg-status-degraded/10'
      };
    }
    
    return {
      recommendation: 'Evaluate',
      action: 'Verify alignment with core goals.',
      state: 'Surplus Capacity',
      reason: 'System is robust and running a surplus. You have the capacity to absorb this. However, because it is a P3, only accept it if it genuinely provides high value, joy, or strategic leverage.',
      color: 'text-blue-500',
      bg: 'bg-blue-500/10'
    };
  };

  const result = evaluate();

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
            <h1 className="text-xl font-bold tracking-tight">Decide</h1>
            <p className="text-xs font-bold text-muted-foreground uppercase tracking-widest mt-0.5">INCIDENT RESPONSE</p>
          </div>
        </div>
        <ThemeToggle />
      </header>

      <main className="px-4 py-6 space-y-8">
        
        {/* Context Hint */}
        <div className="bg-muted/50 rounded-2xl p-4 border border-border/50 flex gap-3 text-sm text-muted-foreground">
          <Info className="w-5 h-5 shrink-0 text-foreground/50" />
          <p className="leading-relaxed">
            Select the priority level of the incoming demand. The engine will evaluate it against your <strong className="text-foreground">current system state, deficits, and trends</strong> to generate a reliable response recommendation.
          </p>
        </div>

        <section>
          <div className="space-y-3">
            {[
              { id: 'P1', label: 'Priority 1', desc: 'Critical, unmovable, severe consequence if dropped' },
              { id: 'P2', label: 'Priority 2', desc: 'Important, time-sensitive, core work' },
              { id: 'P3', label: 'Priority 3', desc: 'Optional, deferrable, favors, "nice to have"' }
            ].map(p => (
              <button
                key={p.id}
                onClick={() => setPriority(p.id as Priority)}
                className={`w-full p-5 rounded-3xl border text-left transition-all flex items-center justify-between shadow-sm active:scale-[0.98] ${
                  priority === p.id 
                    ? 'border-primary bg-primary/5 text-foreground ring-1 ring-primary/30' 
                    : 'border-border/50 bg-card text-muted-foreground hover:bg-accent/30'
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
                {result.recommendation.includes('Accept but') && <ShieldCheck className="w-10 h-10 opacity-90" />}
                {result.recommendation.includes('Decline') && <AlertTriangle className="w-10 h-10 opacity-90" />}
                {result.recommendation === 'Evaluate' && <HelpCircle className="w-10 h-10 opacity-90" />}
              </div>
              
              <div className="space-y-5">
                <div>
                  <div className="text-xs font-bold uppercase tracking-widest opacity-70 mb-1.5">System State Justification</div>
                  <div className="font-semibold text-lg text-foreground mb-1">{result.state}</div>
                  <div className="text-base leading-relaxed text-foreground/80">{result.reason}</div>
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