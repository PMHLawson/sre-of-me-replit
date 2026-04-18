import { useState, useMemo, useRef, useEffect } from 'react';
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
  LogOut,
  User,
} from 'lucide-react';
import { useAppStore, Domain } from '@/store';
import { Card, CardContent } from '@/components/ui/card';
import { ThemeToggle } from '@/components/theme-toggle';
import { EscalationStrip } from '@/components/escalation-surface';
import { useAuth } from '@/hooks/use-auth';

// Documented domain accent palette (ADR-014 / 40.30.OCMP.915) — hardcoded for Tailwind/inline use
const DOMAIN_ACCENT: Record<Domain, string> = {
  'martial-arts': '#C8743A',
  'meditation':   '#6B8EC4',
  'fitness':      '#5FAE6E',
  'music':        '#7A6FD6',
};

const DomainIcon = ({ domain, className, style }: { domain: Domain, className?: string, style?: React.CSSProperties }) => {
  switch (domain) {
    case 'martial-arts': return <Activity className={className} style={style} />;
    case 'meditation': return <BrainCircuit className={className} style={style} />;
    case 'fitness': return <Dumbbell className={className} style={style} />;
    case 'music': return <Music className={className} style={style} />;
  }
};

const DomainCard = ({ domain, title }: { domain: Domain, title: string }) => {
  const [_, setLocation] = useLocation();
  const sessions = useAppStore(state => state.sessions);
  
  // Use stable references
  const getDomainStatus = useAppStore(state => state.getDomainStatus);
  const getWeakestDomain = useAppStore(state => state.getWeakestDomain);
  // Subscribe to policyState so the component re-renders when API-backed
  // policy data arrives or refreshes; getDomainStatus reads it under the hood.
  useAppStore(state => state.policyState);
  
  const domainStatus = getDomainStatus(domain);
  const { domain: weakestDomain, isDegradedOrCritical } = getWeakestDomain();
  
  const { score, trend, status, recentMinutes, targetMinutes, previousWeekMinutes } = domainStatus;
  
  // Only apply aggressive visual signaling if the domain is ACTUALLY in trouble
  // Just being the "lowest score" among 4 perfectly healthy domains shouldn't trigger red alerts.
  const isTargetForRecovery = weakestDomain === domain && isDegradedOrCritical;
  
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
      className={`relative overflow-hidden cursor-pointer transition-all active:scale-[0.98] bg-card border-border hover:bg-accent/50 shadow-sm ${isTargetForRecovery ? 'ring-1 ring-status-critical/50' : ''}`}
      onClick={() => setLocation(`/domain/${domain}`)}
      data-testid={`card-domain-${domain}`}
    >
      <div className={`absolute top-0 left-0 w-1.5 h-full ${getStatusColor()} opacity-90`} />
      
      {isTargetForRecovery && (
        <div className="absolute top-3 right-3 flex h-2 w-2" title="Priority Recovery Target">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-status-critical opacity-60"></span>
          <span className="relative inline-flex rounded-full h-2 w-2 bg-status-critical"></span>
        </div>
      )}

      <CardContent className="p-4 pl-6 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="p-3 rounded-xl" style={{ backgroundColor: `${DOMAIN_ACCENT[domain]}18` }}>
            <DomainIcon domain={domain} className="w-5 h-5" style={{ color: DOMAIN_ACCENT[domain] } as React.CSSProperties} />
          </div>
          <div>
            <h3 className="font-semibold text-base tracking-tight text-foreground">{title}</h3>
            <div className="flex flex-col mt-0.5 gap-1">
              <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <span className="font-mono text-foreground/80">{score}/100</span>
                <span className="opacity-40 text-[10px]">•</span>
                <span>{recentMinutes}m / {targetMinutes}m goal</span>
              </div>
              <div className="flex items-center text-[11px] font-bold">
                {trend === 'up' && <span className="text-status-healthy flex items-center gap-1" title="Trending up vs history">↗ {recentMinutes}m vs {previousWeekMinutes}m (+{recentMinutes - previousWeekMinutes}m)</span>}
                {trend === 'down' && <span className="text-status-critical flex items-center gap-1" title="Trending down vs history">↘ {recentMinutes}m vs {previousWeekMinutes}m ({recentMinutes - previousWeekMinutes}m)</span>}
                {trend === 'flat' && <span className="text-foreground/50 flex items-center gap-1" title="Holding steady">→ {recentMinutes}m vs {previousWeekMinutes}m (0m)</span>}
              </div>
            </div>
          </div>
        </div>
        
        <div className="text-muted-foreground/30 pr-2">
          <ChevronRight className="w-4 h-4" />
        </div>
      </CardContent>
    </Card>
  );
};

export default function Dashboard() {
  const [_, setLocation] = useLocation();
  const getDomainStatus = useAppStore(state => state.getDomainStatus);
  const sessions = useAppStore(state => state.sessions);
  const sessionsLoaded = useAppStore(state => state.sessionsLoaded);
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

  // Calculate overall composite health score using Notion escalation states
  const systemHealth = useMemo(() => {
    const domains: Domain[] = ['martial-arts', 'meditation', 'fitness', 'music'];
    let totalScore = 0;
    let criticalCount = 0;
    let degradedCount = 0;
    let trendingDownCount = 0;

    domains.forEach(d => {
      const { score, status, trend } = getDomainStatus(d);
      totalScore += score;
      if (status === 'critical') criticalCount++;
      if (status === 'degraded') degradedCount++;
      if (trend === 'down') trendingDownCount++;
    });

    const average = Math.round(totalScore / 4);

    let sysStatus = 'NOMINAL';
    let sysColor = 'text-status-healthy';
    let sysBg = 'bg-status-healthy/10';
    let rationale = 'All domains meeting SLO targets. Full flex capacity — eligible to accept P2 and evaluate P3 demands.';

    if (criticalCount > 0) {
      sysStatus = 'BREACH';
      sysColor = 'text-status-critical';
      sysBg = 'bg-status-critical/10';
      rationale = `${criticalCount} domain(s) critically below SLO. Cultivation elevated to P1 priority. Decline all P2/P3 until system recovers.`;
    } else if (degradedCount > 0) {
      sysStatus = 'WARNING';
      sysColor = 'text-status-degraded';
      sysBg = 'bg-status-degraded/10';
      rationale = `${degradedCount} domain(s) below SLO green threshold. Decline P3. Time-box any P2. Schedule makeup within 3 days.`;
    } else if (trendingDownCount > 1) {
      sysStatus = 'ADVISORY';
      sysColor = 'text-status-advisory';
      sysBg = 'bg-status-advisory/10';
      rationale = 'All domains above SLO floor, but momentum declining across multiple areas. Note and monitor — avoid new recurring commitments.';
    }

    return { score: average, status: sysStatus, color: sysColor, bg: sysBg, rationale };
  }, [sessions, policyState]);

  const demoState = useAppStore(state => state.demoState);
  const setDemoState = useAppStore(state => state.setDemoState);

  return (
    <div className="min-h-screen bg-background text-foreground pb-24 font-sans transition-colors duration-300">
      <header className="px-6 py-8 pb-6">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-foreground">SRE-of-Me</h1>
            <p className="text-sm font-medium text-muted-foreground mt-1 tracking-wide">SYSTEM OBSERVABILITY</p>
          </div>
          <div className="flex items-center gap-3">
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
                      {user?.firstName ? `${user.firstName}${user.lastName ? ' ' + user.lastName : ''}` : 'Account'}
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
        
        {/* Composite Health Overview */}
        <div 
          className="bg-card border border-border/50 rounded-3xl p-6 shadow-sm relative overflow-hidden cursor-pointer hover:bg-accent/30 transition-all active:scale-[0.98]"
          onClick={() => setLocation('/system-health')}
          data-testid="card-system-health"
        >
          <div className="absolute -right-6 -top-6 w-32 h-32 bg-primary/5 rounded-full blur-3xl"></div>
          <div className="flex flex-col relative z-10">
            <div className="flex items-center justify-between mb-4">
              <div>
                <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-2 flex items-center gap-2">
                  System Health
                  <ChevronRight className="w-3 h-3" />
                </div>
                <div className="flex items-center gap-3">
                  {!sessionsLoaded ? (
                    <span className="text-5xl font-extrabold tracking-tighter text-muted-foreground/30">—</span>
                  ) : (
                    <span className={`text-5xl font-extrabold tracking-tighter ${systemHealth.color}`}>
                      {systemHealth.score}
                    </span>
                  )}
                </div>
              </div>
              {!sessionsLoaded ? (
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
                {!sessionsLoaded ? 'Syncing session data…' : systemHealth.rationale}
              </p>
            </div>
          </div>
        </div>
      </header>

      <main className="px-4 space-y-4">
        {escalationState && (
          <section className="space-y-3">
            <div className="flex items-center justify-between px-2">
              <h2 className="text-sm font-bold text-muted-foreground uppercase tracking-widest">Escalation</h2>
              <span className="text-[10px] font-bold tracking-widest text-muted-foreground" data-testid="text-highest-tier">
                Highest: {escalationState.highestTier}
              </span>
            </div>
            <EscalationStrip
              perDomain={escalationState.perDomain}
              onSelect={(d) => setLocation(`/domain/${d}`)}
            />
          </section>
        )}

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