import { create } from 'zustand';
import { persist } from 'zustand/middleware';

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

interface AppState {
  sessions: Session[];
  sessionsLoaded: boolean;
  fetchSessions: () => Promise<void>;
  addSession: (session: Omit<Session, 'id'>) => Promise<void>;
  getDomainStatus: (domain: Domain) => { score: number; trend: 'up' | 'down' | 'flat'; status: 'healthy' | 'degraded' | 'critical'; recentMinutes: number; targetMinutes: number; previousWeekMinutes: number; sessionFloor: number; cadence: string; };
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

const calculateDomainStatus = (sessions: Session[], domain: Domain) => {
  const policy = DOMAIN_POLICY[domain];
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const sevenDaysAgo = new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000);
  const fourteenDaysAgo = new Date(today.getTime() - 13 * 24 * 60 * 60 * 1000);

  const domainSessions = sessions.filter(s => s.domain === domain);

  const recentSessions = domainSessions.filter(s => new Date(s.timestamp) >= sevenDaysAgo);
  const previousWeekSessions = domainSessions.filter(s => {
    const d = new Date(s.timestamp);
    return d >= fourteenDaysAgo && d < sevenDaysAgo;
  });

  const targetMinutes = policy.targetMinutes;
  const recentMinutes = recentSessions.reduce((sum, s) => sum + s.durationMinutes, 0);
  const previousWeekMinutes = previousWeekSessions.reduce((sum, s) => sum + s.durationMinutes, 0);

  const score = Math.min(100, Math.round((recentMinutes / targetMinutes) * 100));

  let trend: 'up' | 'down' | 'flat' = 'flat';
  if (recentMinutes > previousWeekMinutes) trend = 'up';
  else if (recentMinutes < previousWeekMinutes) trend = 'down';

  let status: 'healthy' | 'degraded' | 'critical' = 'healthy';
  if (score < 40) status = 'critical';
  else if (score < 70) status = 'degraded';

  return {
    score,
    trend,
    status,
    recentMinutes,
    targetMinutes,
    previousWeekMinutes,
    sessionFloor: policy.sessionFloor,
    cadence: policy.cadence,
  };
};

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      sessions: [],
      sessionsLoaded: false,
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

      setDemoState: (demoState) => {
        if (demoState === 'default') {
          get().fetchSessions().then(() => {
            set({ demoState });
          });
        } else {
          set({ demoState, sessions: generateMockSessions(demoState), sessionsLoaded: true });
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
        } catch (err) {
          console.error('addSession error:', err);
          set((state) => ({
            sessions: [{ ...session, id: crypto.randomUUID() }, ...state.sessions]
          }));
        }
      },

      getDomainStatus: (domain: Domain) => {
        return calculateDomainStatus(get().sessions, domain);
      },

      getWeakestDomain: () => {
        const { sessions } = get();
        const domains: Domain[] = ['martial-arts', 'meditation', 'fitness', 'music'];
        let weakest: Domain = 'fitness';
        let lowestScore = 101;
        let isDegradedOrCritical = false;

        domains.forEach(d => {
          const { score, status } = calculateDomainStatus(sessions, d);
          if (score < lowestScore) {
            lowestScore = score;
            weakest = d;
          }
          if (status === 'critical' || status === 'degraded') {
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
