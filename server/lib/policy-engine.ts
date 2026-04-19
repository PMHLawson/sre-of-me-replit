import type { Session, Domain, Deviation } from "@shared/schema";
import { domainEnum } from "@shared/schema";

/**
 * Subset of a Deviation needed by the engine. Accepting a structural type
 * keeps the engine pure (no DB dependency) while still letting routes pass
 * full DB rows directly.
 */
export type ActiveDeviation = Pick<
  Deviation,
  "domain" | "startAt" | "endAt" | "endedAt" | "excludeFromComposite"
>;

/**
 * Policy engine — `.910`-aligned computations.
 *
 * Single source of truth for: logical-day boundary, completed-window filtering,
 * qualifying-day count, session/duration/service/composite scores, and
 * compliance color. Pure functions only — no I/O, no UI concerns.
 */

// ----- Constants & policy specs -----

export const DEFAULT_DAY_START_HOUR = 4;
export const DEFAULT_COMPLIANCE_WINDOW_DAYS = 7;
/** Default timezone for logical-day boundary evaluation. */
export const DEFAULT_TIMEZONE = "America/New_York";

/**
 * Number of days from account creation during which the system is in
 * "ramp-up" mode: scores still compute normally, but escalation tiers are
 * suppressed to NOMINAL so a brand-new user doesn't see BREACH/WARNING
 * banners before they've had a chance to log meaningful activity.
 */
export const RAMP_UP_DAYS = 7;
const RAMP_UP_MS = RAMP_UP_DAYS * 24 * 60 * 60 * 1000;

/**
 * True when `now` is strictly less than `RAMP_UP_DAYS` after `createdAt`.
 * Pure function — safe to call from anywhere with no I/O.
 */
export function isInRampUp(createdAt: Date | null | undefined, now: Date = new Date()): boolean {
  if (!createdAt) return false;
  return now.getTime() - createdAt.getTime() < RAMP_UP_MS;
}

export interface DomainPolicySpec {
  /** Cumulative minutes target across the compliance window. */
  targetMinutes: number;
  /** Minimum minutes for a single session to count toward qualifying days. */
  sessionFloor: number;
  /** Target number of qualifying days within the compliance window. */
  sessionsTarget: number;
  /** Human cadence label (e.g. "Daily", "3×/week"). */
  cadence: string;
  /** Per-day pro-rate target minutes (for visual reference lines). */
  dailyProRate: number;
}

export const DOMAIN_POLICY: Record<Domain, DomainPolicySpec> = {
  "martial-arts": { targetMinutes: 105, sessionFloor: 15, cadence: "Daily",   sessionsTarget: 5, dailyProRate: 15 },
  "meditation":   { targetMinutes: 70,  sessionFloor: 10, cadence: "Daily",   sessionsTarget: 5, dailyProRate: 10 },
  "fitness":      { targetMinutes: 90,  sessionFloor: 15, cadence: "6×/week", sessionsTarget: 5, dailyProRate: 13 },
  "music":        { targetMinutes: 45,  sessionFloor: 15, cadence: "3×/week", sessionsTarget: 3, dailyProRate: 6  },
};

/** Per-service weight in the composite score. Equal weighting until `.910` specifies otherwise. */
export const SERVICE_WEIGHT: Record<Domain, number> = {
  "martial-arts": 0.25,
  "meditation":   0.25,
  "fitness":      0.25,
  "music":        0.25,
};

export type ComplianceColor = "green" | "yellow" | "red";

export interface PolicyEngineOptions {
  /** Hour-of-day boundary for "logical day" assignment. Sessions logged before this hour count as the previous calendar day. Default 4. */
  dayStartHour?: number;
  /** Length of the compliance window in days. Default 7. */
  windowDays?: number;
  /** "Now" override for deterministic testing. Default = current time. */
  now?: Date;
  /** Whether to exclude today's logical day from the window. Default true. */
  excludeToday?: boolean;
  /** IANA timezone in which the day-start-hour boundary is evaluated. Default `America/New_York`. */
  timezone?: string;
  /**
   * Active deviations for the requesting user. Domains whose deviation has
   * `excludeFromComposite=true` are excluded from the composite weighted
   * average (recovery-clock semantics: the service is held steady, not
   * pulled down by under-target activity during the deviation window).
   */
  deviations?: ActiveDeviation[];
  /**
   * Account creation timestamp for the requesting user. When provided and
   * `now - userCreatedAt < RAMP_UP_DAYS`, escalation tiers are suppressed
   * (forced to NOMINAL) by `computeEscalationState`. Score computation is
   * unaffected — only tier surfacing is suppressed.
   */
  userCreatedAt?: Date;
}

/** True if the deviation is currently active at `now`. */
function isDeviationActiveNow(d: ActiveDeviation, now: Date): boolean {
  if (d.endedAt) return false;
  if (d.startAt > now) return false;
  if (d.endAt && d.endAt < now) return false;
  return true;
}

/** Build a per-domain map of "is currently deviated" + "excluded from composite". */
function buildDeviationMap(
  deviations: ActiveDeviation[] | undefined,
  now: Date,
): Record<Domain, { active: boolean; excludeFromComposite: boolean }> {
  const map = {} as Record<Domain, { active: boolean; excludeFromComposite: boolean }>;
  for (const d of domainEnum) map[d] = { active: false, excludeFromComposite: false };
  if (!deviations) return map;
  for (const dv of deviations) {
    if (!isDeviationActiveNow(dv, now)) continue;
    const dom = dv.domain as Domain;
    if (!(dom in map)) continue;
    map[dom].active = true;
    if (dv.excludeFromComposite) map[dom].excludeFromComposite = true;
  }
  return map;
}

/** Extract the calendar parts of a Date in a given IANA timezone. */
function partsInTimezone(d: Date, timezone: string): { year: number; month: number; day: number; hour: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  let hour = parseInt(get("hour"), 10);
  // Intl can emit "24" for midnight in some locales; normalize.
  if (hour === 24) hour = 0;
  return {
    year: parseInt(get("year"), 10),
    month: parseInt(get("month"), 10),
    day: parseInt(get("day"), 10),
    hour,
  };
}

// ----- Pure helpers -----

/**
 * Compute the logical day for a timestamp as a `YYYY-MM-DD` string.
 * Sessions whose hour is before `dayStartHour` are assigned to the previous calendar day.
 */
export function logicalDay(timestamp: Date | string, opts: PolicyEngineOptions = {}): string {
  const startHour = opts.dayStartHour ?? DEFAULT_DAY_START_HOUR;
  const tz = opts.timezone ?? DEFAULT_TIMEZONE;
  const d = typeof timestamp === "string" ? new Date(timestamp) : new Date(timestamp);
  const local = partsInTimezone(d, tz);
  // If the local hour is before the boundary, the session belongs to the previous calendar day.
  // Construct the local calendar date and subtract a day if needed.
  const calendarUtc = Date.UTC(local.year, local.month - 1, local.day);
  const adjusted = local.hour < startHour ? calendarUtc - 24 * 60 * 60 * 1000 : calendarUtc;
  const a = new Date(adjusted);
  const y = a.getUTCFullYear();
  const m = String(a.getUTCMonth() + 1).padStart(2, "0");
  const day = String(a.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Compute the completed compliance window as an ordered list of logical-day keys (oldest → newest).
 * By default excludes today's logical day; the window therefore covers
 * days `(today - windowDays)` through `(today - 1)`, inclusive.
 */
export function completedWindowDays(opts: PolicyEngineOptions = {}): string[] {
  const windowDays = opts.windowDays ?? DEFAULT_COMPLIANCE_WINDOW_DAYS;
  const excludeToday = opts.excludeToday ?? true;
  const now = opts.now ?? new Date();

  // Anchor on today's logical day (in target timezone, with day-start-hour applied),
  // then step backward by calendar days. UTC arithmetic on YYYY-MM-DD avoids DST drift
  // because we are not crossing wall-clock hours — only date integers.
  const todayKey = logicalDay(now, opts);
  const [ty, tm, td] = todayKey.split("-").map((n) => parseInt(n, 10));
  const anchorUtc = Date.UTC(ty, tm - 1, td);

  const offsetEnd = excludeToday ? 1 : 0;
  const days: string[] = [];
  for (let i = windowDays - 1 + offsetEnd; i >= offsetEnd; i--) {
    const a = new Date(anchorUtc - i * 24 * 60 * 60 * 1000);
    const y = a.getUTCFullYear();
    const m = String(a.getUTCMonth() + 1).padStart(2, "0");
    const day = String(a.getUTCDate()).padStart(2, "0");
    days.push(`${y}-${m}-${day}`);
  }
  return days;
}

/**
 * Filter sessions to those whose logical day falls within `windowDays`.
 */
export function filterSessionsInWindow<T extends Pick<Session, "timestamp">>(
  sessions: T[],
  windowDays: string[],
  opts: PolicyEngineOptions = {}
): T[] {
  const set = new Set(windowDays);
  return sessions.filter((s) => set.has(logicalDay(s.timestamp, opts)));
}

/**
 * Group sessions by logical day. Returns map of day → minutes-per-session list.
 */
export function groupByLogicalDay<T extends Pick<Session, "timestamp" | "durationMinutes">>(
  sessions: T[],
  opts: PolicyEngineOptions = {}
): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const s of sessions) {
    const day = logicalDay(s.timestamp, opts);
    const arr = map.get(day) ?? [];
    arr.push(s);
    map.set(day, arr);
  }
  return map;
}

/**
 * Count distinct qualifying days. A day qualifies when it contains at least one
 * session whose duration meets or exceeds `sessionFloor`.
 */
export function qualifyingDays<T extends Pick<Session, "timestamp" | "durationMinutes">>(
  sessions: T[],
  sessionFloor: number,
  opts: PolicyEngineOptions = {}
): number {
  const grouped = groupByLogicalDay(sessions, opts);
  let count = 0;
  Array.from(grouped.values()).forEach((daySessions) => {
    if (daySessions.some((s) => s.durationMinutes >= sessionFloor)) {
      count++;
    }
  });
  return count;
}

/** Sum of duration minutes across the supplied sessions (pre-filtered to the window). */
export function actualMinutes<T extends Pick<Session, "durationMinutes">>(sessions: T[]): number {
  return sessions.reduce((sum, s) => sum + s.durationMinutes, 0);
}

/** Score 0-100 representing qualifying-day attainment vs target. */
export function sessionScore(qualifying: number, sessionsTarget: number): number {
  if (sessionsTarget <= 0) return 100;
  return Math.min(100, Math.round((qualifying / sessionsTarget) * 100));
}

/** Score 0-100 representing actual-minutes attainment vs target. */
export function durationScore(minutes: number, targetMinutes: number): number {
  if (targetMinutes <= 0) return 100;
  return Math.min(100, Math.round((minutes / targetMinutes) * 100));
}

/**
 * C2.1 — Uncapped raw session score. Mirrors `sessionScore` but does not
 * clamp at 100 so overachievement can be detected. The capped value still
 * feeds composite/escalation paths; only overachievement surfaces use this.
 */
export function rawSessionScore(qualifying: number, sessionsTarget: number): number {
  if (sessionsTarget <= 0) return 100;
  return Math.round((qualifying / sessionsTarget) * 100);
}

/** C2.1 — Uncapped raw duration score. Sibling of `rawSessionScore`. */
export function rawDurationScore(minutes: number, targetMinutes: number): number {
  if (targetMinutes <= 0) return 100;
  return Math.round((minutes / targetMinutes) * 100);
}

/**
 * C2.1 — Overachievement tier ladder. Active when both the session and
 * duration dimensions exceed the SLO target (we take MIN of the two raw
 * scores so a user must be overachieving on both axes).
 *
 * - NONE       ≤ 100  (no overachievement)
 * - COMMITTED  101-149  (consistently above target)
 * - PEAK       150-199  (well above target — substantial surplus)
 * - ELITE      200+     (double-target or more — sustained excellence)
 */
export const overachievementTierEnum = ["NONE", "COMMITTED", "PEAK", "ELITE"] as const;
export type OverachievementTier = typeof overachievementTierEnum[number];

/** Map an uncapped raw score to its overachievement tier. */
export function overachievementTier(rawScore: number): OverachievementTier {
  if (rawScore >= 200) return "ELITE";
  if (rawScore >= 150) return "PEAK";
  if (rawScore >= 101) return "COMMITTED";
  return "NONE";
}

/** Per-service score = mean of session and duration scores. */
export function serviceScore(sessionScoreValue: number, durationScoreValue: number): number {
  return Math.round((sessionScoreValue + durationScoreValue) / 2);
}

/** Look up the per-service weight; defaults to equal weighting if not specified. */
export function serviceWeight(domain: Domain): number {
  return SERVICE_WEIGHT[domain] ?? 1 / domainEnum.length;
}

/**
 * Composite score across services using `serviceWeight` per domain.
 * `perServiceScores` may omit domains; absent domains contribute 0 with their weight.
 */
export function compositeScore(perServiceScores: Partial<Record<Domain, number>>): number {
  let total = 0;
  let weightSum = 0;
  for (const d of domainEnum) {
    const w = serviceWeight(d);
    const s = perServiceScores[d] ?? 0;
    total += s * w;
    weightSum += w;
  }
  if (weightSum === 0) return 0;
  return Math.round(total / weightSum);
}

/**
 * Map a 0-100 score to compliance color.
 * `< 40` → red (BREACH), `< 70` → yellow (WARNING), else → green.
 * Matches existing escalation logic in store.ts so additive surfaces stay coherent.
 */
export function complianceColor(score: number): ComplianceColor {
  if (score < 40) return "red";
  if (score < 70) return "yellow";
  return "green";
}

// ----- Top-level computations -----

export interface ServiceState {
  domain: Domain;
  /** Logical day key for "today" (the day excluded from the window when default opts). */
  logical_day: string;
  /** Number of distinct qualifying days within the completed window. */
  actual_qualifying_days: number;
  /** Total minutes within the completed window (includes below-floor sessions). */
  actual_minutes: number;
  /** 0-100 — qualifying days vs sessionsTarget. */
  session_score: number;
  /** 0-100 — actual minutes vs targetMinutes. */
  duration_score: number;
  /** 0-100 — composite of session & duration. */
  service_score: number;
  /** Weight contributed by this service to the composite. */
  service_weight: number;
  /** green / yellow / red bucket. */
  compliance_color: ComplianceColor;
  /** Echo of the domain's policy specification for transparency. */
  policy: DomainPolicySpec;
  /** Logical-day keys spanned by this computation (oldest → newest). */
  window_days: string[];
  /** True if an active deviation covers this domain at the time of compute. */
  is_deviated?: boolean;
  /** True if the active deviation excludes this domain from the composite. */
  excluded_from_composite?: boolean;
  /**
   * C2.1 — Uncapped MIN(raw_session_score, raw_duration_score). Both axes
   * must be over target before this exceeds 100. Surfaces use this for the
   * per-card overachievement display; composite/escalation paths still use
   * the capped `service_score`.
   */
  overachievement_raw: number;
  /** C2.1 — Tier derived from `overachievement_raw`. */
  overachievement_tier: OverachievementTier;
}

/** Compute full per-service state for a single domain. */
export function computeServiceState<T extends Session>(
  domain: Domain,
  allSessions: T[],
  opts: PolicyEngineOptions = {}
): ServiceState {
  const policy = DOMAIN_POLICY[domain];
  const now = opts.now ?? new Date();
  const window = completedWindowDays(opts);
  const todayKey = logicalDay(now, opts);

  const domainSessions = allSessions.filter((s) => s.domain === domain);
  const inWindow = filterSessionsInWindow(domainSessions, window, opts);

  const minutes = actualMinutes(inWindow);
  const qDays = qualifyingDays(inWindow, policy.sessionFloor, opts);
  const sScore = sessionScore(qDays, policy.sessionsTarget);
  const dScore = durationScore(minutes, policy.targetMinutes);
  const svcScore = serviceScore(sScore, dScore);

  // C2.1 — Overachievement uses uncapped raw scores. MIN ensures both axes
  // (frequency + duration) must be above target before the tier activates.
  const rawSession = rawSessionScore(qDays, policy.sessionsTarget);
  const rawDuration = rawDurationScore(minutes, policy.targetMinutes);
  const oaRaw = Math.min(rawSession, rawDuration);
  const oaTier = overachievementTier(oaRaw);

  const devMap = buildDeviationMap(opts.deviations, now);
  const dev = devMap[domain];

  return {
    domain,
    logical_day: todayKey,
    actual_qualifying_days: qDays,
    actual_minutes: minutes,
    session_score: sScore,
    duration_score: dScore,
    service_score: svcScore,
    service_weight: serviceWeight(domain),
    compliance_color: complianceColor(svcScore),
    policy,
    window_days: window,
    is_deviated: dev.active,
    excluded_from_composite: dev.excludeFromComposite,
    overachievement_raw: oaRaw,
    overachievement_tier: oaTier,
  };
}

export interface CompositeState {
  /** Logical day key for the current "today". */
  logical_day: string;
  /** Window days (oldest → newest). */
  window_days: string[];
  /** Per-service computed state, keyed by domain. */
  services: Record<Domain, ServiceState>;
  /** Weighted composite score 0-100. */
  composite_score: number;
  /** Composite compliance color. */
  composite_color: ComplianceColor;
  /** Domains excluded from the composite due to an active deviation. */
  excluded_domains?: Domain[];
}

/**
 * Composite score across services using `serviceWeight` per domain, but
 * excluding any domains in `excluded`. Excluded domains' weights are
 * dropped (denominator renormalised), so composite reflects only the
 * services the user is currently committed to.
 */
function compositeScoreExcluding(
  perServiceScores: Partial<Record<Domain, number>>,
  excluded: Set<Domain>,
): number {
  let total = 0;
  let weightSum = 0;
  for (const d of domainEnum) {
    if (excluded.has(d)) continue;
    const w = serviceWeight(d);
    const s = perServiceScores[d] ?? 0;
    total += s * w;
    weightSum += w;
  }
  if (weightSum === 0) return 100; // every service deviated → nothing to drag the score
  return Math.round(total / weightSum);
}

/** Compute composite state across all known domains. */
export function computeCompositeState<T extends Session>(
  allSessions: T[],
  opts: PolicyEngineOptions = {}
): CompositeState {
  const now = opts.now ?? new Date();
  const window = completedWindowDays(opts);
  const todayKey = logicalDay(now, opts);
  const devMap = buildDeviationMap(opts.deviations, now);

  const services = {} as Record<Domain, ServiceState>;
  const scores: Partial<Record<Domain, number>> = {};
  const excluded = new Set<Domain>();
  for (const d of domainEnum) {
    const state = computeServiceState(d, allSessions, opts);
    services[d] = state;
    scores[d] = state.service_score;
    if (devMap[d].excludeFromComposite) excluded.add(d);
  }
  const comp = compositeScoreExcluding(scores, excluded);
  return {
    logical_day: todayKey,
    window_days: window,
    services,
    composite_score: comp,
    composite_color: complianceColor(comp),
    excluded_domains: Array.from(excluded),
  };
}
