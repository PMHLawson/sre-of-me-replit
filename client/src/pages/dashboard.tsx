import React, { useState, useMemo, useRef, useEffect } from 'react';
import { useLocation } from 'wouter';
import {
  Activity,
  BrainCircuit,
  Dumbbell,
  Music,
  Plus,
  Check,
  History,
  GitPullRequestDraft,
  ChevronRight,
  LogOut,
  User,
  Settings as SettingsIcon,
} from 'lucide-react';
import { useAppStore, Domain, DomainStatus } from '@/store';
import { ThemeToggle } from '@/components/theme-toggle';
import { NotificationBell } from '@/components/NotificationBell';
import { TIER_STYLE, TIER_RANK, EscalationTimeline } from '@/components/escalation-surface';
import { OverachievementBadge } from '@/components/overachievement-badge';
import { DeviationSection } from '@/components/deviations/deviation-section';
import { useAuth } from '@/hooks/use-auth';
import type { DomainEscalation, EscalationTier } from '@shared/schema';

// Documented domain accent palette (ADR-014 / 40.30.OCMP.915) — hardcoded for Tailwind/inline use
const DOMAIN_ACCENT: Record<Domain, string> = {
  'martial-arts': '#C8743A',
  'meditation':   '#6B8EC4',
  'fitness':      '#5FAE6E',
  'music':        '#7A6FD6',
};

const DOMAIN_TITLE: Record<Domain, string> = {
  'martial-arts': 'Martial Arts',
  'meditation':   'Meditation',
  'fitness':      'Fitness',
  'music':        'Music',
};

const DomainIcon = ({
  domain,
  className,
  style,
}: {
  domain: Domain;
  className?: string;
  style?: React.CSSProperties;
}) => {
  switch (domain) {
    case 'martial-arts': return <Activity className={className} style={style} />;
    case 'meditation':   return <BrainCircuit className={className} style={style} />;
    case 'fitness':      return <Dumbbell className={className} style={style} />;
    case 'music':        return <Music className={className} style={style} />;
  }
};

/**
 * Canonical display order for domains — used as sort tie-breaker so that
 * equal-severity domains always appear in this configured sequence.
 */
export const CONFIGURED_DOMAIN_ORDER = [
  'martial-arts',
  'meditation',
  'fitness',
  'music',
] as const;

/**
 * Sort domains most-severe-first by server escalation tier, with configured
 * display order as the stable tie-breaker.
 *
 * Missing perDomain entries (e.g. a deviating domain not included in the
 * server response) are treated as NOMINAL — the safest assumption.
 *
 * JS Array.prototype.sort is stable, so starting from the configured array
 * and returning 0 for equal ranks naturally preserves configured order.
 */
export function sortedDomains(
  domains: readonly Domain[],
  perDomain: Partial<Record<Domain, { tier: EscalationTier }>> | undefined,
): Domain[] {
  return [...domains].sort((a, b) => {
    const ra = TIER_RANK[perDomain?.[a]?.tier ?? 'NOMINAL'];
    const rb = TIER_RANK[perDomain?.[b]?.tier ?? 'NOMINAL'];
    return rb - ra; // descending severity
  });
}

/**
 * Purely presentational consolidated domain card.
 *
 * Receives all display data as props — no hooks, no store access — so it can
 * be rendered in server-side tests (renderToStaticMarkup) without mocking.
 *
 * Combines:
 *   • domain status / progress / thresholds  (from getDomainStatus via store)
 *   • escalation tier, error-budget %, rationale, recommended action  (from server)
 *
 * Card background and border are driven exclusively by the server-computed
 * escalation tier via TIER_STYLE. The budget percentage is displayed as-is from
 * the server; it is never used to determine color or order.
 */
export function ConsolidatedDomainCard({
  domain,
  domainStatus,
  esc,
  isRampUp,
  onClick,
}: {
  domain: Domain;
  domainStatus: DomainStatus;
  esc: DomainEscalation | undefined;
  isRampUp: boolean;
  onClick: () => void;
}) {
  const tier: EscalationTier = esc?.tier ?? 'NOMINAL';
  const style = TIER_STYLE[tier];
  const Icon = style.Icon;
  const title = DOMAIN_TITLE[domain];
  const accent = DOMAIN_ACCENT[domain];

  const {
    score,
    trend,
    recentMinutes,
    targetMinutes,
    sessionFloor,
    cadence,
    previousWeekMinutes,
    overachievementTier,
    overachievementRaw,
  } = domainStatus;

  const showOverachievement = overachievementTier !== 'NONE';

  return (
    <div
      className={`rounded-2xl border shadow-sm overflow-hidden cursor-pointer transition-all active:scale-[0.99] ${
        esc ? `${style.bg} ${style.border}` : 'bg-card border-border/50'
      }`}
      onClick={onClick}
      data-testid={`card-domain-${domain}`}
    >
      <div className="p-4 space-y-3">
        {/* Row 1: icon + name + thresholds | tier badge + budget */}
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3 min-w-0">
            <div
              className="p-2.5 rounded-xl shrink-0"
              style={{ backgroundColor: `${accent}18` }}
            >
              <DomainIcon
                domain={domain}
                className="w-5 h-5"
                style={{ color: accent } as React.CSSProperties}
              />
            </div>
            <div className="min-w-0">
              <h3 className="font-semibold text-base tracking-tight text-foreground">
                {title}
              </h3>
              <div className="text-[11px] text-muted-foreground mt-0.5 flex flex-wrap gap-x-1.5 items-center">
                <span className="font-mono text-foreground/80 font-bold">{score}/100</span>
                <span className="opacity-40">·</span>
                <span>{recentMinutes}m / {targetMinutes}m</span>
                <span className="opacity-40">·</span>
                <span data-testid={`card-domain-${domain}-cadence`}>{cadence}</span>
                <span className="opacity-40">·</span>
                <span data-testid={`card-domain-${domain}-floor`}>Floor {sessionFloor}m</span>
              </div>
            </div>
          </div>

          {/* Tier badge + error budget — shrink-0 so it never collapses; wraps below on narrow viewports */}
          <div className="flex flex-col items-end gap-1 shrink-0">
            <div
              className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-[10px] font-bold uppercase tracking-widest border ${
                esc
                  ? `${style.bg} ${style.text} ${style.border}`
                  : 'bg-muted border-border text-muted-foreground'
              }`}
              data-testid={`card-domain-${domain}-tier`}
            >
              <Icon className="w-3 h-3" />
              {tier}
            </div>
            {esc && (
              <div className="text-right">
                <div
                  className={`text-lg font-extrabold leading-none ${style.text}`}
                  data-testid={`card-domain-${domain}-budget`}
                >
                  {esc.errorBudget.percentRemaining}%
                </div>
                <div className="text-[10px] text-muted-foreground">budget</div>
              </div>
            )}
          </div>
        </div>

        {/* Row 2: trend arrow + overachievement badge */}
        <div
          className="text-[11px] font-bold flex items-center gap-2 flex-wrap"
          data-testid={`card-domain-${domain}-trend`}
        >
          {trend === 'up' && (
            <span className="text-status-healthy">
              ↗ {recentMinutes}m vs {previousWeekMinutes}m (+{recentMinutes - previousWeekMinutes}m)
            </span>
          )}
          {trend === 'down' && (
            <span className="text-status-critical">
              ↘ {recentMinutes}m vs {previousWeekMinutes}m ({recentMinutes - previousWeekMinutes}m)
            </span>
          )}
          {trend === 'flat' && (
            <span className="text-foreground/50">
              → {recentMinutes}m vs {previousWeekMinutes}m (0m)
            </span>
          )}
          {showOverachievement && (
            <OverachievementBadge
              tier={overachievementTier}
              rawScore={overachievementRaw}
              compact
              testIdSuffix={domain}
            />
          )}
        </div>

        {/* Row 3: rationale + recommended action — shown whenever escalation data is present */}
        {esc && (
          <div className="pt-2 border-t border-current/10 space-y-1">
            <p
              className="text-xs text-foreground/80 leading-relaxed"
              data-testid={`card-domain-${domain}-rationale`}
            >
              {esc.rationale}
            </p>
            <div
              className={`text-xs font-semibold ${style.text}`}
              data-testid={`card-domain-${domain}-action`}
            >
              → {esc.recommendedAction}
            </div>
          </div>
        )}

        {/* Ramp-up annotation — escalation data is present but tiers are NOMINAL by server override */}
        {isRampUp && (
          <div
            className="text-[10px] text-primary/80 font-medium"
            data-testid={`card-domain-${domain}-rampup`}
          >
            Escalation suppressed during 7-day ramp-up.
          </div>
        )}
      </div>
    </div>
  );
}

/** Store-connected wrapper — reads state, delegates all rendering to ConsolidatedDomainCard. */
function ConnectedDomainCard({ domain }: { domain: Domain }) {
  const [_, setLocation] = useLocation();
  const getDomainStatus = useAppStore(state => state.getDomainStatus);
  // Subscribe to policyState so the card re-renders when API data arrives.
  useAppStore(state => state.policyState);
  const escalationState = useAppStore(state => state.escalationState);
  const isRampUp = escalationState?.isRampUp ?? false;
  const domainStatus = getDomainStatus(domain);
  const esc = escalationState?.perDomain[domain];

  return (
    <ConsolidatedDomainCard
      domain={domain}
      domainStatus={domainStatus}
      esc={esc}
      isRampUp={isRampUp}
      onClick={() => setLocation(`/domain/${domain}`)}
    />
  );
}

export default function Dashboard() {
  const [_, setLocation] = useLocation();
  const getDomainStatus = useAppStore(state => state.getDomainStatus);
  const sessions = useAppStore(state => state.sessions);
  const sessionsLoaded = useAppStore(state => state.sessionsLoaded);
  const escalationStateLoaded = useAppStore(state => state.escalationStateLoaded);
  const dataReady = sessionsLoaded && escalationStateLoaded;
  // Re-render when API-backed policy state arrives or refreshes.
  const policyState = useAppStore(state => state.policyState);
  const escalationState = useAppStore(state => state.escalationState);
  const { user, logout } = useAuth();
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!userMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [userMenuOpen]);

  const isRampUp = escalationState?.isRampUp ?? false;

  // Composite numeric score is still an average of per-domain scores. The
  // status banner (NOMINAL/ADVISORY/WARNING/BREACH) is sourced exclusively
  // from escalationState.composite — the same model that drives the
  // per-domain escalation — so the two surfaces never disagree.
  const systemHealth = useMemo(() => {
    const domains: Domain[] = ['martial-arts', 'meditation', 'fitness', 'music'];
    const totalScore = domains.reduce((acc, d) => acc + getDomainStatus(d).score, 0);
    const average = Math.round(totalScore / 4);

    const composite = escalationState?.composite;
    const status = composite?.displayStatus ?? 'NOMINAL';
    const colorByStatus: Record<string, { color: string; bg: string }> = {
      NOMINAL:  { color: 'text-status-healthy',   bg: 'bg-status-healthy/10' },
      ADVISORY: { color: 'text-status-advisory',  bg: 'bg-status-advisory/10' },
      WARNING:  { color: 'text-status-degraded',  bg: 'bg-status-degraded/10' },
      BREACH:   { color: 'text-status-critical',  bg: 'bg-status-critical/10' },
    };
    const { color, bg } = colorByStatus[status] ?? colorByStatus['NOMINAL'];
    const rationale =
      composite?.rationale ??
      'All domains meeting SLO targets. Full flex capacity — eligible to accept P2 and evaluate P3 demands.';

    return { score: average, status, color, bg, rationale };
  }, [sessions, policyState, escalationState, getDomainStatus]);

  const demoState = useAppStore(state => state.demoState);
  const setDemoState = useAppStore(state => state.setDemoState);

  // Sort domains most-severe-first; configured order is the stable tie-breaker.
  const orderedDomains = useMemo(
    () => sortedDomains(CONFIGURED_DOMAIN_ORDER, escalationState?.perDomain),
    [escalationState],
  );

  return (
    <div className="min-h-screen bg-background text-foreground pb-24 font-sans transition-colors duration-300">
      <header className="px-6 py-8 pb-6">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-foreground">SRE-of-Me</h1>
            <p className="text-sm font-medium text-muted-foreground mt-1 tracking-wide">SYSTEM OBSERVABILITY</p>
            <p
              className="text-xs italic text-muted-foreground/70 mt-2"
              data-testid="text-anchor-dashboard"
            >
              Capacity is built, not found.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <NotificationBell />
            <button
              onClick={() => setLocation('/settings')}
              className="w-10 h-10 rounded-full hover:bg-muted/60 flex items-center justify-center transition-colors text-muted-foreground hover:text-foreground"
              aria-label="Settings"
              data-testid="button-settings"
            >
              <SettingsIcon className="w-4 h-4" />
            </button>
            <ThemeToggle />
            <button
              onClick={() => setLocation('/decide')}
              className="h-10 px-5 rounded-full bg-primary text-primary-foreground font-medium text-sm flex items-center gap-2 active:scale-95 transition-transform shadow-md shadow-primary/20"
              data-testid="button-decide"
            >
              <GitPullRequestDraft className="w-4 h-4" />
              Decide
            </button>
            {/* User avatar + dropdown */}
            <div className="relative" ref={menuRef}>
              <button
                onClick={() => setUserMenuOpen(v => !v)}
                className="w-10 h-10 rounded-full overflow-hidden border-2 border-border/60 hover:border-primary/60 transition-colors flex items-center justify-center bg-muted"
                data-testid="button-user-menu"
                aria-label="User menu"
              >
                {user?.profileImageUrl ? (
                  <img src={user.profileImageUrl} alt="Profile" className="w-full h-full object-cover" />
                ) : (
                  <User className="w-5 h-5 text-muted-foreground" />
                )}
              </button>
              {userMenuOpen && (
                <div className="absolute right-0 top-12 w-56 bg-card border border-border/60 rounded-2xl shadow-xl z-50 overflow-hidden">
                  <div className="px-4 py-3 border-b border-border/40">
                    <p className="text-sm font-semibold text-foreground truncate" data-testid="text-user-name">
                      {user?.firstName
                        ? `${user.firstName}${user.lastName ? ' ' + user.lastName : ''}`
                        : 'Account'}
                    </p>
                    {user?.email && (
                      <p className="text-xs text-muted-foreground truncate mt-0.5" data-testid="text-user-email">
                        {user.email}
                      </p>
                    )}
                  </div>
                  <button
                    onClick={() => logout()}
                    className="w-full flex items-center gap-3 px-4 py-3 text-sm text-foreground hover:bg-muted/60 transition-colors"
                    data-testid="button-logout"
                  >
                    <LogOut className="w-4 h-4 text-muted-foreground" />
                    Sign out
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Composite Health Overview — ramp-up takes a distinct teal/cyan
            treatment so a brand-new user understands why their dashboard reads
            NOMINAL even with little or no logged activity (B3.2). */}
        {isRampUp ? (
          <div
            className="bg-primary/10 border border-primary/30 rounded-3xl p-6 shadow-sm relative overflow-hidden cursor-pointer hover:bg-primary/15 transition-all active:scale-[0.98]"
            onClick={() => setLocation('/system-health')}
            data-testid="card-system-health-rampup"
          >
            <div className="absolute -right-6 -top-6 w-32 h-32 bg-primary/20 rounded-full blur-3xl" />
            <div className="flex flex-col relative z-10">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <div className="text-xs font-bold uppercase tracking-widest text-primary/80 mb-2 flex items-center gap-2">
                    System Health
                    <ChevronRight className="w-3 h-3" />
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-3xl font-extrabold tracking-tight text-primary" data-testid="text-rampup-headline">
                      System Calibrating
                    </span>
                  </div>
                </div>
                <div
                  className="px-4 py-2 rounded-2xl text-sm font-bold tracking-wide bg-primary/20 text-primary"
                  data-testid="badge-rampup"
                >
                  RAMP-UP
                </div>
              </div>
              <div className="pt-4 border-t border-primary/20">
                <p className="text-sm text-foreground/80 leading-relaxed font-medium" data-testid="text-rampup-rationale">
                  7-day runway active. Escalation tiers are suppressed while the system learns your
                  cadence — log sessions normally and SLO surfacing will resume once the window
                  completes.
                </p>
              </div>
            </div>
          </div>
        ) : (
          <div
            className="bg-card border border-border/50 rounded-3xl p-6 shadow-sm relative overflow-hidden cursor-pointer hover:bg-accent/30 transition-all active:scale-[0.98]"
            onClick={() => setLocation('/system-health')}
            data-testid="card-system-health"
          >
            <div className="absolute -right-6 -top-6 w-32 h-32 bg-primary/5 rounded-full blur-3xl" />
            <div className="flex flex-col relative z-10">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-2 flex items-center gap-2">
                    System Health
                    <ChevronRight className="w-3 h-3" />
                  </div>
                  <div className="flex items-center gap-3">
                    {!dataReady ? (
                      <span className="text-5xl font-extrabold tracking-tighter text-muted-foreground/30">—</span>
                    ) : (
                      <span className={`text-5xl font-extrabold tracking-tighter ${systemHealth.color}`}>
                        {systemHealth.score}
                      </span>
                    )}
                  </div>
                </div>
                {!dataReady ? (
                  <div className="px-4 py-2 rounded-2xl text-sm font-bold tracking-wide bg-muted text-muted-foreground/50">
                    Loading…
                  </div>
                ) : (
                  <div className={`px-4 py-2 rounded-2xl text-sm font-bold tracking-wide ${systemHealth.bg} ${systemHealth.color}`}>
                    {systemHealth.status}
                  </div>
                )}
              </div>
              <div className="pt-4 border-t border-border/40">
                <p className="text-sm text-foreground/80 leading-relaxed font-medium">
                  {!dataReady ? 'Syncing session data…' : systemHealth.rationale}
                </p>
              </div>
            </div>
          </div>
        )}
      </header>

      <main className="px-4 space-y-4">
        {/* Single consolidated Domains section — replaces the separate
            Escalation list and duplicate Domain list. Each card combines live
            domain progress with the server-computed escalation tier and
            error-budget from /api/escalation-state. Cards are sorted
            most-severe-first; configured display order is the stable tie-breaker. */}
        <div className="px-2 mb-2 flex items-center justify-between">
          <h2 className="text-sm font-bold text-muted-foreground uppercase tracking-widest">Domains</h2>
          {/* Validation Data Control */}
          <div className="flex items-center gap-1 bg-muted/50 p-1 rounded-lg border border-border/50">
            <select
              value={demoState}
              onChange={(e) => setDemoState(e.target.value as any)}
              className="text-[10px] font-mono uppercase bg-transparent text-muted-foreground font-bold focus:outline-none cursor-pointer py-1 px-2"
            >
              <option value="default">Data: Standard</option>
              <option value="overperforming">Data: Healthy</option>
              <option value="degraded">Data: Degraded</option>
              <option value="mixed">Data: Mixed</option>
            </select>
          </div>
        </div>

        {/* Ramp-up info callout — tiers are NOMINAL by server override; cards
            still render with ramp-up annotations. */}
        {isRampUp && (
          <div
            className="bg-primary/5 border border-primary/20 rounded-2xl p-4 mx-2"
            data-testid="section-rampup-escalation-suppressed"
          >
            <div className="flex items-start gap-3">
              <div className="w-2 h-2 rounded-full bg-primary mt-1.5 shrink-0" />
              <div>
                <h3 className="text-xs font-bold uppercase tracking-widest text-primary/90 mb-1">
                  Escalation Suppressed
                </h3>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Per-domain escalation tiers are paused during the 7-day ramp-up. Domain scores
                  below remain real — they show your actual cadence as the system calibrates.
                </p>
              </div>
            </div>
          </div>
        )}

        <div className="grid gap-3" data-testid="domains-grid">
          {orderedDomains.map(domain => (
            <ConnectedDomainCard key={domain} domain={domain} />
          ))}
        </div>

        {/* Composite tier-history timeline — read-only historical reference.
            Shown only when escalation data is loaded, ramp-up is not active,
            and there is at least one day of history to display.
            No domain prop → composite (highest-tier-per-day) view. */}
        {escalationState && !isRampUp && escalationState.history.length > 0 && (
          <div data-testid="dashboard-tier-timeline">
            <EscalationTimeline history={escalationState.history} />
          </div>
        )}

        <DeviationSection />

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

      {/* .910 §20 per-tab FAB — Dashboard uses checkmark icon. Routes to
          /log so it composes with the existing in-body Quick Log card
          rather than replacing it (preserves current Replit strength). */}
      <button
        onClick={() => setLocation('/log')}
        className="fixed bottom-6 right-6 w-14 h-14 rounded-full bg-primary text-primary-foreground shadow-lg shadow-primary/30 flex items-center justify-center active:scale-95 transition-transform z-40"
        aria-label="Log session"
        data-testid="fab-dashboard-log"
      >
        <Check className="w-6 h-6" strokeWidth={3} />
      </button>
    </div>
  );
}
