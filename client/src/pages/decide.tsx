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
  // Re-render when API-backed policy/escalation state arrives or refreshes.
  useAppStore(state => state.policyState);
  const escalationState = useAppStore(state => state.escalationState);

  const { domain: weakestDomain } = getWeakestDomain();
  const weakestStatus = getDomainStatus(weakestDomain);

  // B3.3 — During the post-signup ramp-up window the SLO model isn't yet
  // meaningful, so escalation tier mapping (BREACH/WARNING/ADVISORY) would
  // produce misleading recommendations. We force systemState to NOMINAL so
  // the P2/P3 decision logic falls through cleanly, and override the
  // rationale copy below to explain the runway model instead of citing
  // tier language.
  const isRampUp = escalationState?.isRampUp ?? false;

  const domains: ('martial-arts' | 'meditation' | 'fitness' | 'music')[] = ['martial-arts', 'meditation', 'fitness', 'music'];
  const allStatuses = domains.map(d => ({ domain: d, ...getDomainStatus(d) }));

  // Per-tier domain lists: when API escalation state is available we cite tier membership
  // directly so the rationale text matches the System Health and Dashboard surfaces.
  // When it's not (demo modes / pre-fetch), fall back to the existing score-band heuristic.
  const apiBreachDomains = escalationState
    ? allStatuses.filter(s => {
        const t = escalationState.perDomain[s.domain]?.tier;
        return t === 'BREACH' || t === 'PAGE';
      })
    : [];
  const apiWarningDomains = escalationState
    ? allStatuses.filter(s => escalationState.perDomain[s.domain]?.tier === 'WARNING')
    : [];
  const apiAdvisoryDomains = escalationState
    ? allStatuses.filter(s => escalationState.perDomain[s.domain]?.tier === 'ADVISORY')
    : [];

  const localCritical = allStatuses.filter(s => s.status === 'critical');
  const localDegraded = allStatuses.filter(s => s.status === 'degraded');
  const localTrendingDown = allStatuses.filter(s => s.trend === 'down');

  // Derive system escalation state from the API tier when available; otherwise use the
  // pre-existing local heuristic so demo modes and the loading window still produce a verdict.
  const tierToSystemState = (tier: 'NOMINAL' | 'ADVISORY' | 'WARNING' | 'BREACH' | 'PAGE'): 'NOMINAL' | 'ADVISORY' | 'WARNING' | 'BREACH' =>
    tier === 'PAGE' ? 'BREACH' : tier;

  const systemState: 'NOMINAL' | 'ADVISORY' | 'WARNING' | 'BREACH' = isRampUp
    ? 'NOMINAL'
    : escalationState
      ? tierToSystemState(escalationState.highestTier)
      : (localCritical.length > 0
          ? 'BREACH'
          : localDegraded.length > 0
            ? 'WARNING'
            : localTrendingDown.length > 1
              ? 'ADVISORY'
              : 'NOMINAL');

  const isSystemBreach = systemState === 'BREACH';
  const isSystemWarning = systemState === 'WARNING';
  const isSystemAdvisory = systemState === 'ADVISORY';

  // Citation lists used in rationale text, kept aligned with whichever source decided systemState.
  const criticalDomains = escalationState ? apiBreachDomains : localCritical;
  const degradedDomains = escalationState ? apiWarningDomains : localDegraded;
  const trendingDownDomains = escalationState ? apiAdvisoryDomains : localTrendingDown;

  const formatDomainsList = (doms: typeof allStatuses) =>
    (doms.length > 0
      ? doms.map(d => d.domain.replace('-', ' ')).join(', ')
      : 'one or more domains');

  const evaluate = () => {
    if (!priority) return null;

    if (priority === 'P1') {
      return {
        recommendation: 'Accept',
        action: 'Execute immediately. P1 is non-negotiable.',
        state: 'P1 Override',
        reason: isRampUp
          ? 'All P1 demands bypass system state — by definition, immediate harm occurs if you do not act, you are the only person who can, and it is irreversible within 24 hours. Accept regardless. Note: this still consumes recovery capacity, even during ramp-up. Log the session cost.'
          : `All P1 demands bypass system state — by definition, immediate harm occurs if you do not act, you are the only person who can, and it is irreversible within 24 hours. Accept regardless of current escalation state (${systemState}). Note: this consumes recovery capacity. Log the session cost.`,
        color: 'text-status-critical',
        bg: 'bg-status-critical/10'
      };
    }

    // B3.3 — Ramp-up branch for P2/P3. systemState is already forced to
    // NOMINAL above, but we replace the rationale copy entirely so no
    // BREACH/WARNING/ADVISORY language leaks into ramp-up output.
    if (isRampUp) {
      if (priority === 'P2') {
        return {
          recommendation: 'Accept',
          action: 'Execute normally. Use this to seed real cadence data.',
          state: 'RAMP-UP — System Calibrating',
          reason: 'You are inside the 7-day post-signup runway window. Escalation tiers are suppressed because the SLO model needs more history to make meaningful judgements. P2 demands are accepted normally during ramp-up — taking action now also helps the system learn your real cadence. Once the runway completes, P2 evaluation will follow normal escalation logic.',
          color: 'text-primary',
          bg: 'bg-primary/10'
        };
      }
      // P3
      return {
        recommendation: 'Evaluate',
        action: 'Only accept if it provides genuine high value or strategic leverage.',
        state: 'RAMP-UP — System Calibrating',
        reason: 'You are inside the 7-day post-signup runway window. The system is still calibrating, so evaluate this P3 on its own merits — accept only if it provides real value, joy, or strategic alignment, not out of obligation or social pressure. Normal P3 evaluation rules resume once the runway completes.',
        color: 'text-primary',
        bg: 'bg-primary/10'
      };
    }

    if (priority === 'P2') {
      if (isSystemBreach) {
        return {
          recommendation: 'Decline / Defer',
          action: `Protect your schedule. Recover ${weakestDomain ? weakestDomain.replace('-', ' ') : 'critical domains'} first.`,
          state: `BREACH — Active Load Shedding`,
          reason: `System is in BREACH state. Cultivation has fallen critically below SLO in ${formatDomainsList(criticalDomains)}. Per policy: when in BREACH, cultivation is elevated to P1 priority and only true emergencies (P1) are accepted. This P2 must be declined or deferred until the system recovers to at least WARNING.`,
          color: 'text-status-degraded',
          bg: 'bg-status-degraded/10'
        };
      }
      if (isSystemWarning) {
        return {
          recommendation: 'Accept with Constraints',
          action: 'Strictly time-box. Do not let it cannibalize scheduled cultivation.',
          state: `WARNING — Constrained Capacity`,
          reason: `System is in WARNING state due to routine slippage in ${formatDomainsList(degradedDomains)}. Per policy: decline P3 at WARNING. P2 is absorbable but must be strictly time-boxed to prevent escalating to BREACH. Set a hard stop time before accepting.`,
          color: 'text-status-degraded',
          bg: 'bg-status-degraded/10'
        };
      }
      if (isSystemAdvisory) {
        return {
          recommendation: 'Accept but Monitor',
          action: 'Execute, but watch for compounding load.',
          state: `ADVISORY — Declining Momentum`,
          reason: `System is in ADVISORY state: all domains are above SLO floor, but momentum is declining in ${formatDomainsList(trendingDownDomains)}. Per policy: note and monitor. You can accept this P2, but avoid making it a recurring commitment until trends stabilize.`,
          color: 'text-status-healthy',
          bg: 'bg-status-healthy/10'
        };
      }
      return {
        recommendation: 'Accept',
        action: 'Execute normally.',
        state: `NOMINAL — Full Flex Capacity`,
        reason: 'System is NOMINAL: all domains are meeting SLO targets and momentum is stable or improving. You have full flex capacity to absorb P2 demands without risk to baseline cultivation.',
        color: 'text-status-healthy',
        bg: 'bg-status-healthy/10'
      };
    }

    // P3 logic
    if (isSystemBreach || isSystemWarning) {
      return {
        recommendation: 'Decline',
        action: 'Reject without guilt. Protect baseline recovery.',
        state: `${systemState} — Load Shedding`,
        reason: `System state is ${systemState}. Per policy, P3 demands are shed at WARNING and BREACH states. The current cultivation deficit (primary: ${weakestDomain ? weakestDomain.replace('-', ' ') : 'maintenance'}) takes precedence. All optional commitments must be declined until the system reaches NOMINAL.`,
        color: 'text-status-critical',
        bg: 'bg-status-critical/10'
      };
    }

    if (isSystemAdvisory) {
      return {
        recommendation: 'Decline / Defer',
        action: 'Defer until momentum stabilizes.',
        state: `ADVISORY — Preserve Momentum`,
        reason: `System is ADVISORY. Downward trends in ${formatDomainsList(trendingDownDomains)} indicate declining momentum. Per policy, P3 tasks are best deferred when system is not fully NOMINAL. The cost of accepting P3 now is likely further drift.`,
        color: 'text-status-degraded',
        bg: 'bg-status-degraded/10'
      };
    }

    return {
      recommendation: 'Evaluate',
      action: 'Only accept if it provides genuine high value or strategic leverage.',
      state: `NOMINAL — Surplus Capacity`,
      reason: 'System is fully NOMINAL with stable positive momentum. You have surplus capacity. Per policy: Evaluate P3 in a NOMINAL state — accept only if it provides real value, joy, or strategic alignment. Do not accept out of obligation or social pressure.',
      color: 'text-primary',
      bg: 'bg-primary/10'
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
            <p className="text-xs font-bold text-muted-foreground uppercase tracking-widest mt-0.5">TRIAGE ENGINE</p>
          </div>
        </div>
        <ThemeToggle />
      </header>

      <main className="px-4 py-6 space-y-8">

        {/* Current System State Banner — ramp-up gets a distinct teal
            treatment so the user understands escalation tier mapping is
            paused, even though P2/P3 fall through NOMINAL logic (B3.3). */}
        {isRampUp ? (
          <div
            className="rounded-2xl p-4 border flex items-center justify-between bg-primary/10 border-primary/30 text-primary"
            data-testid="banner-decide-rampup"
          >
            <div>
              <div className="text-[10px] font-bold uppercase tracking-widest opacity-70 mb-0.5">Current System State</div>
              <div className="font-bold text-lg tracking-tight">RAMP-UP</div>
            </div>
            <div className="text-right text-xs opacity-70 font-medium">
              7-day runway active. Escalation suppressed.
            </div>
          </div>
        ) : (
          <div className={`rounded-2xl p-4 border flex items-center justify-between ${
            systemState === 'BREACH' ? 'bg-status-critical/10 border-status-critical/20 text-status-critical' :
            systemState === 'WARNING' ? 'bg-status-degraded/10 border-status-degraded/20 text-status-degraded' :
            systemState === 'ADVISORY' ? 'bg-status-advisory/10 border-status-advisory/20 text-status-advisory' :
            'bg-status-healthy/10 border-status-healthy/20 text-status-healthy'
          }`}>
            <div>
              <div className="text-[10px] font-bold uppercase tracking-widest opacity-70 mb-0.5">Current System State</div>
              <div className="font-bold text-lg tracking-tight">{systemState}</div>
            </div>
            <div className="text-right text-xs opacity-70 font-medium">
              {systemState === 'BREACH' && 'Cultivation = P1. Emergencies only.'}
              {systemState === 'WARNING' && 'Decline P3. Time-box P2.'}
              {systemState === 'ADVISORY' && 'Note & monitor. No action change.'}
              {systemState === 'NOMINAL' && 'Full flex capacity.'}
            </div>
          </div>
        )}

        {/* Context */}
        <div className="bg-muted/50 rounded-2xl p-4 border border-border/50 flex gap-3 text-sm text-muted-foreground">
          <Info className="w-5 h-5 shrink-0 text-foreground/50" />
          <p className="leading-relaxed">
            Classify the incoming demand below. The engine evaluates it against your current system state and the operative capacity policy to produce a clear recommendation.
          </p>
        </div>

        {/* Priority Selector */}
        <section>
          <div className="space-y-3">
            {[
              {
                id: 'P1',
                label: 'P1 — Emergency',
                shortDesc: 'All three must be true: immediate harm, only you can act, irreversible within 24h.',
                fullDesc: 'P1 qualifiers (all three must be true):\n1. Immediate harm occurs if you do not act right now?\n2. You are literally the only person who can handle this?\n3. It is irreversible if it waits 24 hours?\n\nAny "no" → it is not a P1. P1 demands bypass all system capacity limits and are accepted regardless of escalation state. Reserve strictly for true emergencies.'
              },
              {
                id: 'P2',
                label: 'P2 — Urgent',
                shortDesc: 'All three must be true: real consequence ≤48h, your involvement changes outcome, not someone else\'s planning failure.',
                fullDesc: 'P2 qualifiers (all three must be true):\n1. Real consequence occurs within 48 hours?\n2. Your direct involvement significantly changes the outcome?\n3. This is NOT caused by someone else\'s failure to plan?\n\nAny "no" → it is not a P2 (likely P3). P2 demands are evaluated against system state — accepted at NOMINAL, constrained at WARNING, declined at BREACH.'
              },
              {
                id: 'P3',
                label: 'P3 — Everything Else',
                shortDesc: 'Deferrable requests, favors, optional projects, social obligations, speculative work.',
                fullDesc: 'P3 is the default classification for anything that does not meet P1 or P2 criteria. This includes: favors, optional projects, "nice to have" deliverables, speculative research, and social obligations. P3 demands are the first to be shed when the system is strained. Only evaluated for acceptance at NOMINAL state with surplus capacity.'
              }
            ].map(p => (
              <button
                key={p.id}
                onClick={() => setPriority(p.id as Priority)}
                className={`w-full p-5 rounded-3xl border text-left transition-all flex items-start justify-between shadow-sm active:scale-[0.98] ${
                  priority === p.id
                    ? 'border-primary bg-primary/5 text-foreground ring-1 ring-primary/30'
                    : 'border-border/50 bg-card text-muted-foreground hover:bg-accent/30'
                }`}
                data-testid={`button-priority-${p.id}`}
              >
                <div className="pr-4 flex-1">
                  <div className={`font-bold text-lg ${priority === p.id ? 'text-foreground' : 'text-foreground/80'}`}>{p.label}</div>
                  <div className={`text-sm mt-1.5 leading-relaxed whitespace-pre-line ${priority === p.id ? 'text-foreground/90' : 'text-muted-foreground'}`}>
                    {priority === p.id ? p.fullDesc : p.shortDesc}
                  </div>
                </div>
                {priority === p.id && (
                  <div className="w-6 h-6 shrink-0 rounded-full bg-primary/10 flex items-center justify-center mt-1">
                    <Check className="w-4 h-4 text-primary" />
                  </div>
                )}
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
                {result.recommendation.startsWith('Accept with') && <ShieldCheck className="w-10 h-10 opacity-90" />}
                {result.recommendation.startsWith('Accept but') && <ShieldCheck className="w-10 h-10 opacity-90" />}
                {result.recommendation.startsWith('Decline') && <AlertTriangle className="w-10 h-10 opacity-90" />}
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
