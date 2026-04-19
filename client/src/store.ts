import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  PolicyStateResponse,
  ComplianceColor,
  EscalationStateResponse,
  Deviation as ServerDeviation,
} from '@shared/schema';

export type Domain = 'martial-arts' | 'meditation' | 'fitness' | 'music';

export interface Session {
  id: string;
  domain: Domain;
  durationMinutes: number;
  timestamp: string;
  notes?: string | null;
  /** Non-null when soft-deleted; cleared on restore. */
  deletedAt?: string | null;
}

/**
 * Partial update for a session row. The audit reason is passed as a separate
 * argument to `updateSession(id, patch, reason)` and merged into the PATCH
 * body, mirroring the server-side updateSessionSchema (B2.1).
 */
export interface SessionPatch {
  domain?: Domain;
  durationMinutes?: number;
  timestamp?: string;
  notes?: string | null;
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

/**
 * Client-side deviation: server `Deviation` row with timestamp fields
 * serialized to ISO strings (matches the wire format from /api/deviations).
 */
export interface Deviation extends Omit<ServerDeviation, 'startAt' | 'endAt' | 'endedAt' | 'deletedAt'> {
  startAt: string;
  endAt: string | null;
  endedAt: string | null;
  deletedAt: string | null;
}

export interface DeviationDraft {
  domain: Domain;
  reason: string;
  startAt: string; // ISO with offset
  endAt?: string | null;
  excludeFromComposite?: boolean;
}

export interface DeviationPatch {
  reason?: string;
  startAt?: string;
  endAt?: string | null;
  excludeFromComposite?: boolean;
}

interface AppState {
  sessions: Session[];
  sessionsLoaded: boolean;
  policyState: PolicyStateResponse | null;
  policyStateLoaded: boolean;
  escalationState: EscalationStateResponse | null;
  escalationStateLoaded: boolean;
  deviations: Deviation[];
  deviationsLoaded: boolean;
  fetchSessions: () => Promise<void>;
  fetchPolicyState: () => Promise<void>;
  fetchEscalationState: () => Promise<void>;
  updateSession: (id: string, patch: SessionPatch, reason: string) => Promise<Session | null>;
  deleteSession: (id: string) => Promise<boolean>;
  /** Soft-deleted sessions still within retention window. Lazy-loaded. */
  deletedSessions: Session[];
  deletedSessionsLoaded: boolean;
  /** Non-null when the last fetchDeletedSessions call failed. */
  deletedSessionsError: string | null;
  fetchDeletedSessions: () => Promise<void>;
  restoreSession: (id: string) => Promise<boolean>;
  fetchDeviations: () => Promise<void>;
  createDeviation: (draft: DeviationDraft) => Promise<Deviation | null>;
  updateDeviation: (id: string, patch: DeviationPatch) => Promise<Deviation | null>;
  endDeviation: (id: string) => Promise<Deviation | null>;
  deleteDeviation: (id: string) => Promise<boolean>;
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

export const calculateDomainStatus = (sessions: Session[], domain: Domain): DomainStatus => {
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

export const apiBackedDomainStatus = (
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

/**
 * True if the deviation covers `at` for `domain`. Mirrors the server-side
 * predicate in `server/lib/policy-engine.ts` so client-rendered deviation
 * markers match what /api/policy-state and /api/escalation-state apply.
 */
export function isDeviationActiveAt(
  d: Pick<Deviation, 'domain' | 'startAt' | 'endAt' | 'endedAt' | 'deletedAt'>,
  domain: Domain,
  at: Date,
): boolean {
  if (d.domain !== domain) return false;
  if (d.deletedAt) return false;
  if (d.endedAt && new Date(d.endedAt) <= at) return false;
  if (new Date(d.startAt) > at) return false;
  if (d.endAt && new Date(d.endAt) < at) return false;
  return true;
}

/** Find the first deviation in `deviations` that covers `domain` at `at`. */
export function findActiveDeviationAt(
  deviations: Deviation[],
  domain: Domain,
  at: Date,
): Deviation | undefined {
  return deviations.find((d) => isDeviationActiveAt(d, domain, at));
}

let policyStateRequestCounter = 0;
let policyStateAbortController: AbortController | null = null;

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      sessions: [],
      sessionsLoaded: false,
      policyState: null,
      policyStateLoaded: false,
      escalationState: null,
      escalationStateLoaded: false,
      deviations: [],
      deviationsLoaded: false,
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
        const requestId = ++policyStateRequestCounter;
        if (policyStateAbortController) {
          policyStateAbortController.abort();
        }
        const controller = new AbortController();
        policyStateAbortController = controller;
        try {
          const res = await fetch('/api/policy-state', { signal: controller.signal });
          if (!res.ok) throw new Error('Failed to fetch policy state');
          const data: PolicyStateResponse = await res.json();
          if (requestId !== policyStateRequestCounter) return;
          set({ policyState: data, policyStateLoaded: true });
        } catch (err) {
          if ((err as { name?: string })?.name === 'AbortError') return;
          if (requestId !== policyStateRequestCounter) return;
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

      updateSession: async (id, patch, reason) => {
        try {
          const res = await fetch(`/api/sessions/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...patch, reason }),
          });
          if (!res.ok) throw new Error('Failed to update session');
          const saved: Session = await res.json();
          // Refresh server-authoritative session list + derived state so the
          // dashboard, policy, and escalation surfaces all reflect the edit
          // (ordering, filters, and computed fields stay consistent).
          await Promise.all([
            get().fetchSessions(),
            get().fetchPolicyState(),
            get().fetchEscalationState(),
          ]);
          return saved;
        } catch (err) {
          console.error('updateSession error:', err);
          return null;
        }
      },

      deleteSession: async (id) => {
        try {
          const res = await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
          if (!res.ok) throw new Error('Failed to delete session');
          await Promise.all([
            get().fetchSessions(),
            get().fetchPolicyState(),
            get().fetchEscalationState(),
          ]);
          // If the deleted-sessions list was already loaded, refresh it so the
          // newly-deleted row appears in Recently Deleted without a manual reopen.
          if (get().deletedSessionsLoaded) {
            await get().fetchDeletedSessions();
          }
          return true;
        } catch (err) {
          console.error('deleteSession error:', err);
          return false;
        }
      },

      deletedSessions: [],
      deletedSessionsLoaded: false,
      deletedSessionsError: null,

      fetchDeletedSessions: async () => {
        // Reset loaded + error so the panel returns to its loading state on
        // the initial fetch and on every explicit retry.
        set({ deletedSessionsLoaded: false, deletedSessionsError: null });
        try {
          const res = await fetch('/api/sessions/deleted');
          if (!res.ok) throw new Error('Failed to fetch deleted sessions');
          const data: Session[] = await res.json();
          set({ deletedSessions: data, deletedSessionsLoaded: true });
        } catch (err) {
          console.error('fetchDeletedSessions error:', err);
          set({
            deletedSessionsLoaded: true,
            deletedSessionsError: 'Could not load deleted sessions.',
          });
        }
      },

      restoreSession: async (id) => {
        try {
          const res = await fetch(`/api/sessions/${id}/restore`, { method: 'POST' });
          if (!res.ok) throw new Error('Failed to restore session');
          // Refresh active + deleted lists and derived state so the restored
          // row is back in History and the SLO/escalation surfaces re-include it.
          await Promise.all([
            get().fetchSessions(),
            get().fetchDeletedSessions(),
            get().fetchPolicyState(),
            get().fetchEscalationState(),
          ]);
          return true;
        } catch (err) {
          console.error('restoreSession error:', err);
          return false;
        }
      },

      fetchDeviations: async () => {
        try {
          const res = await fetch('/api/deviations');
          if (!res.ok) throw new Error('Failed to fetch deviations');
          const data: Deviation[] = await res.json();
          set({ deviations: data, deviationsLoaded: true });
        } catch (err) {
          console.error('fetchDeviations error:', err);
          set({ deviationsLoaded: true });
        }
      },

      createDeviation: async (draft) => {
        try {
          const res = await fetch('/api/deviations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(draft),
          });
          if (!res.ok) throw new Error('Failed to create deviation');
          const saved: Deviation = await res.json();
          await Promise.all([
            get().fetchDeviations(),
            get().fetchPolicyState(),
            get().fetchEscalationState(),
          ]);
          return saved;
        } catch (err) {
          console.error('createDeviation error:', err);
          return null;
        }
      },

      updateDeviation: async (id, patch) => {
        try {
          const res = await fetch(`/api/deviations/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch),
          });
          if (!res.ok) throw new Error('Failed to update deviation');
          const saved: Deviation = await res.json();
          await Promise.all([
            get().fetchDeviations(),
            get().fetchPolicyState(),
            get().fetchEscalationState(),
          ]);
          return saved;
        } catch (err) {
          console.error('updateDeviation error:', err);
          return null;
        }
      },

      endDeviation: async (id) => {
        try {
          const res = await fetch(`/api/deviations/${id}/end`, { method: 'POST' });
          if (!res.ok) throw new Error('Failed to end deviation');
          const saved: Deviation = await res.json();
          await Promise.all([
            get().fetchDeviations(),
            get().fetchPolicyState(),
            get().fetchEscalationState(),
          ]);
          return saved;
        } catch (err) {
          console.error('endDeviation error:', err);
          return null;
        }
      },

      deleteDeviation: async (id) => {
        try {
          const res = await fetch(`/api/deviations/${id}`, { method: 'DELETE' });
          if (!res.ok) throw new Error('Failed to delete deviation');
          await Promise.all([
            get().fetchDeviations(),
            get().fetchPolicyState(),
            get().fetchEscalationState(),
          ]);
          return true;
        } catch (err) {
          console.error('deleteDeviation error:', err);
          return false;
        }
      },

      setDemoState: (demoState) => {
        if (demoState === 'default') {
          Promise.all([
            get().fetchSessions(),
            get().fetchPolicyState(),
            get().fetchEscalationState(),
            get().fetchDeviations(),
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
            deviations: [],
            deviationsLoaded: true,
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
