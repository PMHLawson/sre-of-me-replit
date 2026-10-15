import { readSessionState, readHistoryPage, asSession, asDeviation, mergeById, readDetailStep, type DetailState } from "@/lib/legacy-history-api";
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  PolicyStateResponse,
  ComplianceColor,
  EscalationStateResponse,
  Deviation as ServerDeviation,
  OverachievementTier,
} from '@shared/schema';

export type Domain = 'martial-arts' | 'meditation' | 'fitness' | 'music';

export interface Session {
  textComplete?: boolean;
  hasNotes?: boolean;
  hasAnomalyNote?: boolean;
  notesBytes?: number;
  anomalyNoteBytes?: number;
  id: string;
  domain: Domain;
  durationMinutes: number;
  timestamp: string;
  notes?: string | null;
  /** Non-null when soft-deleted; cleared on restore. */
  deletedAt?: string | null;
  /** True when the user confirmed a 2-sigma duration anomaly at save time. */
  isAnomaly: boolean;
  /** Required note when isAnomaly is true; null otherwise. */
  anomalyNote: string | null;
}

// Mirrors the server's updateSessionSchema. The audit `reason` is a
// separate arg to updateSession() and merged into the PATCH body.
export interface SessionPatch {
  domain?: Domain;
  durationMinutes?: number;
  timestamp?: string;
  notes?: string | null;
  // C1.1 — Anomaly fields so the edit path can persist a re-evaluated flag.
  isAnomaly?: boolean;
  anomalyNote?: string | null;
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
  /** C2.1 — Uncapped MIN(raw_session_score, raw_duration_score). */
  overachievementRaw: number;
  /** C2.1 — Tier derived from overachievementRaw. */
  overachievementTier: OverachievementTier;
}

/**
 * Client-side deviation: server `Deviation` row with timestamp fields
 * serialized to ISO strings (matches the wire format from /api/deviations).
 */
export interface Deviation extends Omit<ServerDeviation, 'startAt' | 'endAt' | 'endedAt' | 'deletedAt'> {
  textComplete?: boolean;
  hasReason?: boolean;
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
  dataOwner: string | null;
  currentAsOf: string | null;
  escalationRangeDays: number;
  contextFrom: string | null;
  sessionsError: string | null;
  policyStateError: string | null;
  escalationStateError: string | null;
  deviationsError: string | null;
  historySessions: Session[];
  historyLoaded: boolean;
  historyLoading: boolean;
  historyError: string | null;
  historyCursor: string | null;
  historyComplete: boolean;
  deletedLoading: boolean;
  deletedCursor: string | null;
  deletedComplete: boolean;
  deviationPages: Deviation[];
  deviationPagesLoaded: boolean;
  deviationPagesLoading: boolean;
  deviationPagesError: string | null;
  deviationPagesCursor: string | null;
  deviationPagesComplete: boolean;
  sessionDetails: Record<string, DetailState<Session>>;
  deviationDetails: Record<string, DetailState<Deviation>>;
  unsavedSessionDraft: Omit<Session, 'id'> | null;
  refreshCurrent: (days?: number) => Promise<void>;
  fetchHistory: (more?: boolean) => Promise<void>;
  fetchDeviationPages: (more?: boolean) => Promise<void>;
  fetchSessionDetail: (id: string, more?: boolean) => Promise<void>;
  fetchDeviationDetail: (id: string, more?: boolean) => Promise<void>;
  invalidateAfterMutation: () => Promise<void>;
  resetLegacyReads: () => void;
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
  fetchEscalationState: (days?: number) => Promise<void>;
  updateSession: (id: string, patch: SessionPatch, reason: string) => Promise<Session | null>;
  deleteSession: (id: string) => Promise<boolean>;
  /** Soft-deleted sessions still within retention window. Lazy-loaded. */
  deletedSessions: Session[];
  deletedSessionsLoaded: boolean;
  /** Non-null when the last fetchDeletedSessions call failed. */
  deletedSessionsError: string | null;
  fetchDeletedSessions: (more?: boolean) => Promise<void>;
  restoreSession: (id: string) => Promise<boolean>;
  fetchDeviations: () => Promise<void>;
  createDeviation: (draft: DeviationDraft) => Promise<Deviation | null>;
  updateDeviation: (id: string, patch: DeviationPatch) => Promise<Deviation | null>;
  endDeviation: (id: string) => Promise<Deviation | null>;
  deleteDeviation: (id: string) => Promise<boolean>;
  // Returns the saved row (or a local stand-in in demo mode) so callers
  // can act on the new id; null on network/server failure.
  addSession: (session: Omit<Session, 'id'>) => Promise<Session | null>;
  getDomainStatus: (domain: Domain) => DomainStatus;
  getWeakestDomain: () => { domain: Domain; isDegradedOrCritical: boolean };
  theme: 'dark' | 'light';
  toggleTheme: () => void;
  demoState: 'default' | 'overperforming' | 'degraded' | 'mixed';
  setDemoState: (state: 'default' | 'overperforming' | 'degraded' | 'mixed') => void;
  /**
   * Transient client-only notification snooze. ISO timestamp until which
   * in-app notification toasts/badges should be suppressed. Never persisted
   * to the database — wiped on full reload (zustand persist whitelist
   * excludes it). null = not snoozed.
   */
  snoozeUntil: string | null;
  setSnoozeUntil: (until: string | null) => void;
  isSnoozed: () => boolean;

  /**
   * Cached browser Notification permission state. Mirrors
   * `window.Notification?.permission` so components can render without
   * touching the global. Updated when the user requests permission.
   */
  notificationPermission: 'default' | 'granted' | 'denied' | 'unsupported';
  setNotificationPermission: (
    p: 'default' | 'granted' | 'denied' | 'unsupported'
  ) => void;
  requestNotificationPermission: () => Promise<'default' | 'granted' | 'denied' | 'unsupported'>;

  /**
   * In-app notification queue. Populated by the trigger evaluator (C4.2)
   * and drained as the user reads them. Never persisted — wiped on
   * reload along with snoozeUntil.
   */
  pendingNotifications: Array<{
    id: string;
    type: string;
    severity: 'ADVISORY' | 'WARNING' | 'BREACH' | 'PAGE';
    title: string;
    body: string;
    domain?: Domain;
    deepLink: string;
    receivedAt: string;
    read: boolean;
  }>;
  addPendingNotification: (
    n: Omit<
      {
        id: string;
        type: string;
        severity: 'ADVISORY' | 'WARNING' | 'BREACH' | 'PAGE';
        title: string;
        body: string;
        domain?: Domain;
        deepLink: string;
        receivedAt: string;
        read: boolean;
      },
      'receivedAt' | 'read'
    >
  ) => void;
  markNotificationRead: (id: string) => void;
  clearPendingNotifications: () => void;
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
          isAnomaly: false,
          anomalyNote: null,
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
    // Demo / fallback path: overachievement requires the per-domain
    // qualifying-day signal that the API computes; we don't replicate it
    // client-side. Use a neutral baseline (100 = exactly at target) so the
    // value is semantically truthful, and force tier to NONE so no badge
    // renders in demo mode.
    overachievementRaw: 100,
    overachievementTier: 'NONE',
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
    throw new Error('Current domain result unavailable');
  }
  // Use API actual_minutes as the displayed "current 7d" total, and pair it with
  // the locally computed previous-window total for trend. This keeps the trend
  // arrow consistent with the displayed (recentMinutes - previousWeekMinutes) delta.
  const keys = policyState.windowSets?.prev7;
  const mapping = policyState.sessionDays;
  if (!keys || !mapping) throw new Error('Current window metadata unavailable');
  const previous = new Set(keys);
  const previousWeekMinutes = sessions.filter(row => row.domain === domain && previous.has(mapping[row.id]))
    .reduce((total, row) => total + row.durationMinutes, 0);
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
    overachievementRaw: svc.overachievement_raw,
    overachievementTier: svc.overachievement_tier,
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

let legacyOwner: string | null = null;
let ownerGeneration = 0;
let selectedHistoryDays = 14;
const requests = new Map<string, { id: symbol; controller: AbortController }>();
function cancelReads() { for (const r of Array.from(requests.values())) r.controller.abort(); requests.clear(); }
export function bindLegacyOwner(owner: string | null) {
  if (owner === legacyOwner) return;
  legacyOwner = owner; ownerGeneration += 1; selectedHistoryDays = 14; cancelReads();
}
export const boundLegacyOwner = () => legacyOwner;
function requestScope(key: string) {
  requests.get(key)?.controller.abort();
  const id = Symbol(key), controller = new AbortController(), generation = ownerGeneration, owner = legacyOwner;
  requests.set(key, { id, controller });
  return { signal: controller.signal, owner,
    current: () => owner !== null && owner === legacyOwner && generation === ownerGeneration &&
      requests.get(key)?.id === id && !controller.signal.aborted };
}
const initialReads = () => ({
  dataOwner: null as string | null, currentAsOf: null as string | null, contextFrom: null as string | null, escalationRangeDays: 14,
  sessions: [] as Session[], sessionsLoaded: false, sessionsError: null as string | null,
  policyState: null as PolicyStateResponse | null, policyStateLoaded: false, policyStateError: null as string | null,
  escalationState: null as EscalationStateResponse | null, escalationStateLoaded: false, escalationStateError: null as string | null,
  deviations: [] as Deviation[], deviationsLoaded: false, deviationsError: null as string | null,
  historySessions: [] as Session[], historyLoaded: false, historyLoading: false, historyError: null as string | null,
  historyCursor: null as string | null, historyComplete: false,
  deletedSessions: [] as Session[], deletedSessionsLoaded: false, deletedSessionsError: null as string | null,
  deletedLoading: false, deletedCursor: null as string | null, deletedComplete: false,
  deviationPages: [] as Deviation[], deviationPagesLoaded: false, deviationPagesLoading: false,
  deviationPagesError: null as string | null, deviationPagesCursor: null as string | null, deviationPagesComplete: false,
  sessionDetails: {} as Record<string, DetailState<Session>>, deviationDetails: {} as Record<string, DetailState<Deviation>>,
  unsavedSessionDraft: null as Omit<Session, "id"> | null,
});

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      ...initialReads(),
      theme: 'dark',
      demoState: 'default',

      resetLegacyReads: () => set(initialReads()),
      refreshCurrent: async (days?: number) => {
        if (get().demoState !== "default") return;
        if (days !== undefined && days === selectedHistoryDays && get().sessionsLoaded && !get().sessionsError) return;
        if (days !== undefined) { selectedHistoryDays = days; set({ escalationRangeDays: days }); }
        const scope = requestScope("current");
        if (!scope.owner) return;
        set({ sessionsLoaded: false, policyStateLoaded: false, escalationStateLoaded: false, deviationsLoaded: false,
          sessionsError: null, policyStateError: null, escalationStateError: null, deviationsError: null });
        try {
          const bundle = await readSessionState(selectedHistoryDays, scope.signal, scope.owner);
          if (!scope.current()) return;
          set({ dataOwner: scope.owner, currentAsOf: bundle.asOf, contextFrom: bundle.context.fromInclusive,
            sessions: bundle.context.sessions.map(asSession), deviations: bundle.context.deviations.map(asDeviation),
            policyState: bundle.policyState, escalationState: bundle.escalationState,
            sessionsLoaded: true, policyStateLoaded: true, escalationStateLoaded: true, deviationsLoaded: true });
        } catch {
          if (!scope.current()) return;
          const message = "The complete current window could not be verified. Please retry.";
          set({ sessionsLoaded: false, policyStateLoaded: false, escalationStateLoaded: false, deviationsLoaded: false,
            sessionsError: message, policyStateError: message, escalationStateError: message, deviationsError: message });
        }
      },
      fetchSessions: async () => get().refreshCurrent(),
      fetchPolicyState: async () => get().refreshCurrent(),
      fetchEscalationState: async (days) => get().refreshCurrent(days),
      fetchDeviations: async () => get().refreshCurrent(),

      fetchHistory: async (more = false) => {
        if (get().demoState !== "default") return;
        if (get().historyLoading || (more && (!get().historyLoaded || get().historyComplete))) return;
        const scope = requestScope("history"), cursor = more ? get().historyCursor : null;
        if (!scope.owner) return;
        set({ historyLoading: true, historyError: null });
        try {
          const page = await readHistoryPage("sessions", cursor, scope.signal, scope.owner);
          if (!scope.current()) return;
          const rows = page.items.map(row => asSession(row as Parameters<typeof asSession>[0]));
          set({ historySessions: more ? mergeById(get().historySessions, rows) : rows, historyLoading: false,
            historyLoaded: true, historyCursor: page.nextCursor, historyComplete: page.complete });
        } catch {
          if (scope.current()) set({ historyLoading: false, historyError: "Could not load practice history." });
        }
      },
      fetchDeletedSessions: async (more = false) => {
        if (get().deletedLoading || (more && (!get().deletedSessionsLoaded || get().deletedComplete))) return;
        const scope = requestScope("deleted"), cursor = more ? get().deletedCursor : null;
        if (!scope.owner) return;
        set({ deletedLoading: true, deletedSessionsError: null });
        try {
          const page = await readHistoryPage("deleted", cursor, scope.signal, scope.owner);
          if (!scope.current()) return;
          const rows = page.items.map(row => asSession(row as Parameters<typeof asSession>[0]));
          set({ deletedSessions: more ? mergeById(get().deletedSessions, rows) : rows, deletedLoading: false,
            deletedSessionsLoaded: true, deletedCursor: page.nextCursor, deletedComplete: page.complete });
        } catch {
          if (scope.current()) set({ deletedLoading: false, deletedSessionsError: "Could not load deleted practices." });
        }
      },
      fetchDeviationPages: async (more = false) => {
        if (get().deviationPagesLoading || (more && (!get().deviationPagesLoaded || get().deviationPagesComplete))) return;
        const scope = requestScope("deviationPages"), cursor = more ? get().deviationPagesCursor : null;
        if (!scope.owner) return;
        set({ deviationPagesLoading: true, deviationPagesError: null });
        try {
          const page = await readHistoryPage("deviations", cursor, scope.signal, scope.owner);
          if (!scope.current()) return;
          const rows = page.items.map(row => asDeviation(row as Parameters<typeof asDeviation>[0]));
          set({ deviationPages: more ? mergeById(get().deviationPages, rows) : rows, deviationPagesLoading: false,
            deviationPagesLoaded: true, deviationPagesCursor: page.nextCursor, deviationPagesComplete: page.complete });
        } catch {
          if (scope.current()) set({ deviationPagesLoading: false, deviationPagesError: "Could not load deviation history." });
        }
      },
      fetchSessionDetail: async (id, more = false) => {
        const previous = more ? get().sessionDetails[id] : undefined;
        if (more && get().sessionDetails[id]?.status === "loading") return;
        const scope = requestScope("sessionDetail:" + id);
        if (!scope.owner) return;
        set(state => ({ sessionDetails: { ...state.sessionDetails, [id]: { ...previous, status: "loading" } } }));
        try {
          const result = await readDetailStep("sessions", id, previous, scope.signal, scope.owner) as DetailState<Session>;
          if (scope.current()) set(state => ({ sessionDetails: { ...state.sessionDetails, [id]: result } }));
        } catch {
          if (scope.current()) set(state => ({ sessionDetails: { ...state.sessionDetails,
            [id]: { status: "error", error: "Could not verify this saved text. Restart loading." } } }));
        }
      },
      fetchDeviationDetail: async (id, more = false) => {
        const previous = more ? get().deviationDetails[id] : undefined;
        if (more && get().deviationDetails[id]?.status === "loading") return;
        const scope = requestScope("deviationDetail:" + id);
        if (!scope.owner) return;
        set(state => ({ deviationDetails: { ...state.deviationDetails, [id]: { ...previous, status: "loading" } } }));
        try {
          const result = await readDetailStep("deviations", id, previous, scope.signal, scope.owner) as DetailState<Deviation>;
          if (scope.current()) set(state => ({ deviationDetails: { ...state.deviationDetails, [id]: result } }));
        } catch {
          if (scope.current()) set(state => ({ deviationDetails: { ...state.deviationDetails,
            [id]: { status: "error", error: "Could not verify this saved reason. Restart loading." } } }));
        }
      },
      invalidateAfterMutation: async () => {
        const historyWasLoaded = get().historyLoaded, deletedWasLoaded = get().deletedSessionsLoaded,
          deviationsWereLoaded = get().deviationPagesLoaded;
        cancelReads();
        set({ sessionDetails: {}, deviationDetails: {}, historyLoading: false, deletedLoading: false,
          deviationPagesLoading: false, historyComplete: false, deletedComplete: false, deviationPagesComplete: false,
          historyLoaded: false, historyCursor: null, historySessions: [],
          deletedSessionsLoaded: false, deletedCursor: null, deletedSessions: [],
          deviationPagesLoaded: false, deviationPagesCursor: null, deviationPages: [] });
        await Promise.all([get().refreshCurrent(),
          ...(historyWasLoaded ? [get().fetchHistory()] : []),
          ...(deletedWasLoaded ? [get().fetchDeletedSessions()] : []),
          ...(deviationsWereLoaded ? [get().fetchDeviationPages()] : [])]);
      },
      updateSession: async (id, patch, reason) => {
        const owner = legacyOwner, generation = ownerGeneration;
        try {
          const res = await fetch("/api/sessions/" + encodeURIComponent(id), { method: "PATCH",
            headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...patch, reason }) });
          if (!res.ok) return null;
          const saved: Session = await res.json();
          if (owner !== legacyOwner || generation !== ownerGeneration) return null;
          await get().invalidateAfterMutation(); return saved;
        } catch { return null; }
      },
      deleteSession: async (id) => {
        const owner = legacyOwner, generation = ownerGeneration;
        try {
          const res = await fetch("/api/sessions/" + encodeURIComponent(id), { method: "DELETE" });
          if (!res.ok || owner !== legacyOwner || generation !== ownerGeneration) return false;
          await get().invalidateAfterMutation(); return true;
        } catch { return false; }
      },
      restoreSession: async (id) => {
        const owner = legacyOwner, generation = ownerGeneration;
        try {
          const res = await fetch("/api/sessions/" + encodeURIComponent(id) + "/restore", { method: "POST" });
          if (!res.ok || owner !== legacyOwner || generation !== ownerGeneration) return false;
          await get().invalidateAfterMutation(); return true;
        } catch { return false; }
      },
      createDeviation: async (draft) => {
        const owner = legacyOwner, generation = ownerGeneration;
        try {
          const res = await fetch("/api/deviations", { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(draft) });
          if (!res.ok) return null;
          const saved: Deviation = await res.json();
          if (owner !== legacyOwner || generation !== ownerGeneration) return null;
          await get().invalidateAfterMutation(); return saved;
        } catch { return null; }
      },
      updateDeviation: async (id, patch) => {
        const owner = legacyOwner, generation = ownerGeneration;
        try {
          const res = await fetch("/api/deviations/" + encodeURIComponent(id), { method: "PATCH",
            headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
          if (!res.ok) return null;
          const saved: Deviation = await res.json();
          if (owner !== legacyOwner || generation !== ownerGeneration) return null;
          await get().invalidateAfterMutation(); return saved;
        } catch { return null; }
      },
      endDeviation: async (id) => {
        const owner = legacyOwner, generation = ownerGeneration;
        try {
          const res = await fetch("/api/deviations/" + encodeURIComponent(id) + "/end", { method: "POST" });
          if (!res.ok) return null;
          const saved: Deviation = await res.json();
          if (owner !== legacyOwner || generation !== ownerGeneration) return null;
          await get().invalidateAfterMutation(); return saved;
        } catch { return null; }
      },
      deleteDeviation: async (id) => {
        const owner = legacyOwner, generation = ownerGeneration;
        try {
          const res = await fetch("/api/deviations/" + encodeURIComponent(id), { method: "DELETE" });
          if (!res.ok || owner !== legacyOwner || generation !== ownerGeneration) return false;
          await get().invalidateAfterMutation(); return true;
        } catch { return false; }
      },

      snoozeUntil: null,
      setSnoozeUntil: (until) => set({ snoozeUntil: until }),
      isSnoozed: () => {
        const until = get().snoozeUntil;
        if (!until) return false;
        const t = Date.parse(until);
        return Number.isFinite(t) && t > Date.now();
      },

      notificationPermission:
        typeof window !== 'undefined' && 'Notification' in window
          ? (window.Notification.permission as 'default' | 'granted' | 'denied')
          : 'unsupported',
      setNotificationPermission: (p) => set({ notificationPermission: p }),
      requestNotificationPermission: async () => {
        if (typeof window === 'undefined' || !('Notification' in window)) {
          set({ notificationPermission: 'unsupported' });
          return 'unsupported';
        }
        try {
          const result = await window.Notification.requestPermission();
          const next = result as 'default' | 'granted' | 'denied';
          set({ notificationPermission: next });
          return next;
        } catch {
          return get().notificationPermission;
        }
      },

      pendingNotifications: [],
      addPendingNotification: (n) => {
        if (get().isSnoozed()) return;
        set((state) => {
          // De-dup by id — engine emits stable ids per logicalDay.
          if (state.pendingNotifications.some((x) => x.id === n.id)) return state;
          return {
            pendingNotifications: [
              { ...n, receivedAt: new Date().toISOString(), read: false },
              ...state.pendingNotifications,
            ].slice(0, 50),
          };
        });
      },
      markNotificationRead: (id) =>
        set((state) => ({
          pendingNotifications: state.pendingNotifications.map((n) =>
            n.id === id ? { ...n, read: true } : n
          ),
        })),
      clearPendingNotifications: () => set({ pendingNotifications: [] }),

      setDemoState: (demoState) => {
        if (demoState === 'default') {
          set({ demoState });
          void get().refreshCurrent();
        } else {
          cancelReads();
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
        if (get().demoState !== "default") {
          const local = { ...session, id: crypto.randomUUID() } as Session;
          set(state => ({ sessions: [local, ...state.sessions] })); return local;
        }
        const owner = legacyOwner, generation = ownerGeneration;
        try {
          const res = await fetch("/api/sessions", { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(session) });
          if (!res.ok) throw new Error();
          const saved: Session = await res.json();
          if (owner !== legacyOwner || generation !== ownerGeneration) return null;
          set({ unsavedSessionDraft: null }); await get().invalidateAfterMutation(); return saved;
        } catch {
          if (owner === legacyOwner && generation === ownerGeneration) set({ unsavedSessionDraft: session });
          return null;
        }
      },

      getDomainStatus: (domain: Domain) => {
        const { sessions, policyState, demoState } = get();
        if (demoState === 'default' && policyState && get().sessionsLoaded && !get().sessionsError &&
            get().dataOwner === legacyOwner && get().escalationStateLoaded && get().deviationsLoaded) {
          return apiBackedDomainStatus(policyState, sessions, domain);
        }
        if (demoState !== 'default') return calculateDomainStatus(sessions, domain);
        throw new Error('Current results unavailable');
      },

      getWeakestDomain: () => {
        const { sessions, policyState, demoState } = get();
        const domains: Domain[] = ['martial-arts', 'meditation', 'fitness', 'music'];
        let weakest: Domain = 'fitness';
        let lowestScore = 101;
        let isDegradedOrCritical = false;

        const useApi = demoState === 'default' && policyState;
        if (demoState === 'default' && (!useApi || !get().sessionsLoaded || get().sessionsError ||
          get().dataOwner !== legacyOwner || !get().escalationStateLoaded || !get().deviationsLoaded)) throw new Error('Current results unavailable');

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
