import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { PolicyStateResponse, ComplianceColor, EscalationStateResponse } from '@shared/schema';

export type Domain = 'martial-arts' | 'meditation' | 'fitness' | 'music';

export interface Session {
  id: string;
  domain: Domain;
  durationMinutes: number;
  timestamp: string;
  notes?: string;
}

export interface DomainPolicy {
  targetMinutes: number;
  sessionFloor: number;
  cadence: string;
  sessionsTarget: number;
  dailyProRate: number;
}

export const DOMAIN_POLICY: Record<Domain, DomainPolicy> = {
  'martial-arts': { targetMinutes: 105, sessionFloor: 15, cadence: 'Daily',  sessionsTarget: 5, dailyProRate: 15 },
  'meditation':   { targetMinutes: 70,  sessionFloor: 10, cadence: 'Daily',  sessionsTarget: 5, dailyProRate: 10 },
  'fitness':      { targetMinutes: 90,  sessionFloor: 15, cadence: '6×/week',sessionsTarget: 5, dailyProRate: 13 },
  'music':        { targetMinutes: 45,  sessionFloor: 15, cadence: '3×/week',sessionsTarget: 3, dailyProRate: 6  },
};

export interface DomainStatus {
  score: number;
  trend: 'up' | 'down' | 'flat';
  status: 'healthy' | 'degraded' | 'critical';
  recentMinutes: number;
  targetMinutes: number;
  previousWeekMinutes: number;
  sessionFloor: number;
  cadence: string;
}

interface AppState {
  sessions: Session[];
  sessionsLoaded: boolean;
  policyState: PolicyStateResponse | null;
  policyStateLoaded: boolean;
  escalationState: EscalationStateResponse | null;
  escalationStateLoaded: boolean;
  fetchSessions: () => Promise<void>;
  fetchPolicyState: () => Promise<void>;
  fetchEscalationState: () => Promise<void>;
  addSession: (session: Omit<Session, 'id'>) => Promise<void>;
  getDomainStatus: (domain: Domain) => DomainStatus;
  getWeakestDomain: () => { domain: Domain; isDegradedOrCritical: boolean };
  theme: 'dark' | 'light';
  toggleTheme: () => void;
  demoState: 'default' | 'overperforming' | 'degraded' | 'mixed';
  setDemoState: (state: 'default' | 'overperforming' | 'degraded' | 'mixed') => void;
}

const generateMockSessions = (scenario: 'default' | 'overperforming' | 'degraded' | 'mixed' = 'default'): Session[] => {
  const sessions: Session[] = [];
  const now = new Date();
  const domains: Domain[] = ['martial-arts', 'meditation', 'fitness', 'music'];

  for (let i = 0; i < 42; i++) {
    domains.forEach(domain => {
      let probability = 0.3;
      let baseDuration = 30;

      if (scenario === 'overperforming') {
        probability = 0.8;
        baseDuration = 45;
      } else if (scenario === 'degraded') {
        probability = 0.15;
        baseDuration = 15;
      } else if (scenario === 'mixed') {
        if (domain === 'fitness' || domain === 'music') {
          probability = 0.8;
          baseDuration = 45;
        } else {
          probability = 0.1;
          baseDuration = 15;
        }
      }

      if (Math.random() < probability) {
        const date = new Date(now);
        date.setDate(date.getDate() - i);
        date.setHours(Math.floor(Math.random() * 14) + 6);

        sessions.push({
          id: `mock-${i}-${domain}-${Math.random()}`,
          domain,
          durationMinutes: Math.floor(Math.random() * 30) + baseDuration,
          timestamp: date.toISOString(),
        });
      }
    });
  }
  return sessions;
};

const colorToStatus = (color: ComplianceColor): 'healthy' | 'degraded' | 'critical' => {
  if (color === 'green') return 'healthy';
  if (color === 'yellow') return 'degraded';
  return 'critical';
};

const computeWindowMinutes = (sessions: Session[], domain: Domain) => {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const sevenDaysAgo = new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000);
  const fourteenDaysAgo = new Date(today.getTime() - 13 * 24 * 60 * 60 * 1000);

  const domainSessions = sessions.filter(s => s.domain === domain);
  const recentMinutes = domainSessions
    .filter(s => new Date(s.timestamp) >= sevenDaysAgo)
    .reduce((sum, s) => sum + s.durationMinutes, 0);
  const previousWeekMinutes = domainSessions
    .filter(s => {
      const d = new Date(s.timestamp);
      return d >= fourteenDaysAgo && d < sevenDaysAgo;
    })
    .reduce((sum, s) => sum + s.durationMinutes, 0);

  return { recentMinutes, previousWeekMinutes };
};

const trendOf = (recent: number, previous: number): 'up' | 'down' | 'flat' => {
  if (recent > previous) return 'up';
  if (recent < previous) return 'down';
  return 'flat';
};

const calculateDomainStatus = (sessions: Session[], domain: Domain): DomainStatus => {
  const policy = DOMAIN_POLICY[domain];
  const { recentMinutes, previousWeekMinutes } = computeWindowMinutes(sessions, domain);

  const score = Math.min(100, Math.round((recentMinutes / policy.targetMinutes) * 100));

  let status: 'healthy' | 'degraded' | 'critical' = 'healthy';
  if (score < 40) status = 'critical';
  else if (score < 70) status = 'degraded';

  return {
    score,
    trend: trendOf(recentMinutes, previousWeekMinutes),
    status,
    recentMinutes,
    targetMinutes: policy.targetMinutes,
    previousWeekMinutes,
    sessionFloor: policy.sessionFloor,
    cadence: policy.cadence,
  };
};

const apiBackedDomainStatus = (
  policyState: PolicyStateResponse,
  sessions: Session[],
  domain: Domain
): DomainStatus => {
  const svc = policyState.services[domain];
  if (!svc) {
    // Defensive fallback if API omits a domain
    return calculateDomainStatus(sessions, domain);
  }
  // Use API actual_minutes as the displayed "current 7d" total, and pair it with
  // the locally computed previous-window total for trend. This keeps the trend
  // arrow consistent with the displayed (recentMinutes - previousWeekMinutes) delta.
  const { previousWeekMinutes } = computeWindowMinutes(sessions, domain);
  const recentMinutes = svc.actual_minutes;
  return {
    score: Math.round(svc.service_score),
    trend: trendOf(recentMinutes, previousWeekMinutes),
    status: colorToStatus(svc.compliance_color),
    recentMinutes,
    targetMinutes: svc.policy.targetMinutes,
    previousWeekMinutes,
    sessionFloor: svc.policy.sessionFloor,
    cadence: svc.policy.cadence,
  };
};

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      sessions: [],
      sessionsLoaded: false,
      policyState: null,
      policyStateLoaded: false,
      escalationState: null,
      escalationStateLoaded: false,
      theme: 'dark',
      demoState: 'default',

      fetchSessions: async () => {
        try {
          const res = await fetch('/api/sessions');
          if (!res.ok) throw new Error('Failed to fetch sessions');
          const data: Session[] = await res.json();
          set({ sessions: data, sessionsLoaded: true });
        } catch (err) {
          console.error('fetchSessions error:', err);
          set({ sessionsLoaded: true });
        }
      },

      fetchPolicyState: async () => {
        try {
          const res = await fetch('/api/policy-state');
          if (!res.ok) throw new Error('Failed to fetch policy state');
          const data: PolicyStateResponse = await res.json();
          set({ policyState: data, policyStateLoaded: true });
        } catch (err) {
          console.error('fetchPolicyState error:', err);
          set({ policyStateLoaded: true });
        }
      },

      fetchEscalationState: async () => {
        try {
          const res = await fetch('/api/escalation-state');
          if (!res.ok) throw new Error('Failed to fetch escalation state');
          const data: EscalationStateResponse = await res.json();
          set({ escalationState: data, escalationStateLoaded: true });
        } catch (err) {
          console.error('fetchEscalationState error:', err);
          set({ escalationStateLoaded: true });
        }
      },

      setDemoState: (demoState) => {
        if (demoState === 'default') {
          Promise.all([
            get().fetchSessions(),
            get().fetchPolicyState(),
            get().fetchEscalationState(),
          ]).then(() => {
            set({ demoState });
          });
        } else {
          set({
            demoState,
            sessions: generateMockSessions(demoState),
            sessionsLoaded: true,
            policyState: null,
            policyStateLoaded: true,
            escalationState: null,
            escalationStateLoaded: true,
          });
        }
      },

      toggleTheme: () => {
        set((state) => {
          const newTheme = state.theme === 'dark' ? 'light' : 'dark';
          const root = window.document.documentElement;
          root.classList.remove('light', 'dark');
          root.classList.add(newTheme);
          return { theme: newTheme };
        });
      },

      addSession: async (session) => {
        const { demoState } = get();
        if (demoState !== 'default') {
          set((state) => ({
            sessions: [{ ...session, id: crypto.randomUUID() }, ...state.sessions]
          }));
          return;
        }
        try {
          const res = await fetch('/api/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(session),
          });
          if (!res.ok) throw new Error('Failed to save session');
          const saved: Session = await res.json();
          set((state) => ({ sessions: [saved, ...state.sessions] }));
          // Refresh API-backed policy + escalation state so server-computed surfaces reflect the new session.
          get().fetchPolicyState();
          get().fetchEscalationState();
        } catch (err) {
          console.error('addSession error:', err);
          set((state) => ({
            sessions: [{ ...session, id: crypto.randomUUID() }, ...state.sessions]
          }));
        }
      },

      getDomainStatus: (domain: Domain) => {
        const { sessions, policyState, demoState } = get();
        if (demoState === 'default' && policyState) {
          return apiBackedDomainStatus(policyState, sessions, domain);
        }
        return calculateDomainStatus(sessions, domain);
      },

      getWeakestDomain: () => {
        const { sessions, policyState, demoState } = get();
        const domains: Domain[] = ['martial-arts', 'meditation', 'fitness', 'music'];
        let weakest: Domain = 'fitness';
        let lowestScore = 101;
        let isDegradedOrCritical = false;

        const useApi = demoState === 'default' && policyState;

        domains.forEach(d => {
          const ds = useApi
            ? apiBackedDomainStatus(policyState!, sessions, d)
            : calculateDomainStatus(sessions, d);
          if (ds.score < lowestScore) {
            lowestScore = ds.score;
            weakest = d;
          }
          if (ds.status === 'critical' || ds.status === 'degraded') {
            isDegradedOrCritical = true;
          }
        });

        return { domain: weakest, isDegradedOrCritical };
      },
    }),
    {
      name: 'sre-of-me-v2',
      partialize: (state) => ({ theme: state.theme }),
    }
  )
);
