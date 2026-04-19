import type { Session, Domain } from "@shared/schema";
import { domainEnum } from "@shared/schema";
import {
  DOMAIN_POLICY,
  computeServiceState,
  logicalDay,
  groupByLogicalDay,
  filterSessionsInWindow,
  isInRampUp,
  type ServiceState,
  type PolicyEngineOptions,
  type ActiveDeviation,
} from "./policy-engine";

export type { ActiveDeviation } from "./policy-engine";

/**
 * Escalation Stitch Model — derives per-domain incident & escalation state
 * from the policy-fidelity stream produced by `policy-engine.ts`.
 *
 * Vocabulary:
 *  - tier: NOMINAL → ADVISORY → WARNING → BREACH → PAGE (severity rank ascending)
 *  - error budget: minutes of deficit allowed before BREACH (= 60% of targetMinutes)
 *  - burn rate: ratio of actual minutes/day vs the per-domain dailyProRate target
 *  - consecutive low days: trailing days in the completed window with no qualifying session
 *
 * Pure functions only — no I/O or UI concerns.
 */

export type EscalationTier = "NOMINAL" | "ADVISORY" | "WARNING" | "BREACH" | "PAGE";

export const TIER_RANK: Record<EscalationTier, number> = {
  NOMINAL: 0,
  ADVISORY: 1,
  WARNING: 2,
  BREACH: 3,
  PAGE: 4,
};

export interface ErrorBudget {
  /** Minutes consumed against the allowed deficit window (deficit vs target). */
  consumedMinutes: number;
  /** Total allowed deficit before BREACH. = round(targetMinutes * 0.6). */
  allowedMinutes: number;
  /** Minutes still available before BREACH. Negative means budget is exhausted. */
  remainingMinutes: number;
  /** 0–100 — fraction of budget remaining. Clamped at [0, 100]. */
  percentRemaining: number;
}

export interface DomainEscalation {
  domain: Domain;
  tier: EscalationTier;
  /** Pithy headline summarizing why the tier was assigned. */
  rationale: string;
  /** One concrete next-action recommendation for the operator. */
  recommendedAction: string;
  /** Trailing days in the completed window with zero qualifying sessions. */
  consecutiveLowDays: number;
  /** Actual minutes/day in the window divided by dailyProRate target. <1 = under target. */
  burnRate: number;
  errorBudget: ErrorBudget;
}

export interface EscalationHistoryDayDomain {
  tier: EscalationTier;
  percentRemaining: number;
}

export interface EscalationHistoryEntry {
  /** Logical day key for this history slot. */
  logical_day: string;
  /** Per-domain tier + remaining error budget on this day. */
  perDomain: Record<Domain, EscalationHistoryDayDomain>;
  /** Highest-severity tier across all domains for this day. */
  highestTier: EscalationTier;
}

/** Display status used by the System Health banner — PAGE collapses to BREACH. */
export type CompositeDisplayStatus = "NOMINAL" | "ADVISORY" | "WARNING" | "BREACH";

export interface CompositeEscalation {
  /** Highest tier across all domains (mirrors `highestTier`). */
  tier: EscalationTier;
  /** Banner-friendly status; PAGE collapses to BREACH. */
  displayStatus: CompositeDisplayStatus;
  /** Pre-baked rationale string for the System Health banner. */
  rationale: string;
  /** Pre-baked recommended next action for the System Health banner. */
  recommendedAction: string;
  /** Domains grouped by tier — lets surfaces describe membership without recomputing. */
  domainsByTier: Record<EscalationTier, Domain[]>;
}

export interface EscalationStateResponse {
  /** Logical day key the computation is anchored on. */
  logical_day: string;
  /** Per-domain escalation state, keyed by domain. */
  perDomain: Record<Domain, DomainEscalation>;
  /** Highest-severity tier across all domains. */
  highestTier: EscalationTier;
  /**
   * Composite system-level summary derived from the same per-domain escalation
   * model. Surfaces (Dashboard banner, System Health banner) consume this rather
   * than recomputing system status from individual domain scores client-side.
   */
  composite: CompositeEscalation;
  /** Per-day escalation tier history (oldest → newest), one entry per logical day. */
  history: EscalationHistoryEntry[];
  /**
   * True when the requesting user is inside the post-signup ramp-up window
   * (B3.1). When true, all per-domain tiers and `highestTier` are forced to
   * NOMINAL; surfaces should display ramp-up copy instead of escalation copy.
   */
  isRampUp: boolean;
}

/** Default number of days included in escalation history responses. */
export const DEFAULT_ESCALATION_HISTORY_DAYS = 14;

function formatDomainName(d: Domain): string {
  return d.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

/**
 * Count consecutive trailing days (newest → backward) in the window with no qualifying session.
 * A day "qualifies" when at least one session meets or exceeds `sessionFloor` minutes.
 */
export function consecutiveLowDays<T extends Pick<Session, "timestamp" | "durationMinutes">>(
  domainSessionsInWindow: T[],
  window: string[],
  sessionFloor: number,
  opts: PolicyEngineOptions = {}
): number {
  const grouped = groupByLogicalDay(domainSessionsInWindow, opts);
  let n = 0;
  for (let i = window.length - 1; i >= 0; i--) {
    const day = window[i];
    const daySessions = grouped.get(day) ?? [];
    const qualifies = daySessions.some((s) => s.durationMinutes >= sessionFloor);
    if (qualifies) break;
    n++;
  }
  return n;
}

/**
 * Compute the error budget for a service.
 * Allowed deficit = 60% of targetMinutes (red bucket starts when actual_minutes < 0.4*target).
 *
 * Recovery-clock semantics: if the service is under an active deviation
 * (`isDeviated=true`), the error-budget drawdown is held at zero for the
 * deviation window — under-target minutes during the deviation do not
 * consume budget. The service is treated as fully funded until the
 * deviation ends.
 */
export function computeErrorBudget(svc: ServiceState, isDeviated: boolean = false): ErrorBudget {
  const target = svc.policy.targetMinutes;
  const allowedMinutes = Math.round(target * 0.6);
  if (isDeviated) {
    return {
      consumedMinutes: 0,
      allowedMinutes,
      remainingMinutes: allowedMinutes,
      percentRemaining: 100,
    };
  }
  const consumedMinutes = Math.max(0, target - svc.actual_minutes);
  const remainingMinutes = allowedMinutes - consumedMinutes;
  const percentRemaining = allowedMinutes > 0
    ? Math.max(0, Math.min(100, Math.round((remainingMinutes / allowedMinutes) * 100)))
    : 100;
  return { consumedMinutes, allowedMinutes, remainingMinutes, percentRemaining };
}

/** Map (compliance color, consecutive-low-days) → escalation tier. */
export function classifyTier(svc: ServiceState, consecutiveLow: number): EscalationTier {
  const color = svc.compliance_color;
  if (color === "red" && consecutiveLow >= 3) return "PAGE";
  if (color === "red") return "BREACH";
  if (color === "yellow" && consecutiveLow >= 2) return "WARNING";
  if (color === "yellow") return "ADVISORY";
  if (consecutiveLow >= 3) return "ADVISORY";
  return "NOMINAL";
}

function dayWord(n: number): string {
  return `${n} consecutive day${n === 1 ? "" : "s"}`;
}

function buildGuidance(
  domain: Domain,
  tier: EscalationTier,
  svc: ServiceState,
  budget: ErrorBudget,
  consecutiveLow: number
): { rationale: string; recommendedAction: string } {
  const name = formatDomainName(domain);
  const floor = svc.policy.sessionFloor;
  switch (tier) {
    case "PAGE":
      return {
        rationale: `${name} is in BREACH for ${dayWord(consecutiveLow)}; error budget exhausted (${budget.percentRemaining}% remaining).`,
        recommendedAction: `Page yourself: complete a ≥${floor}m ${name.toLowerCase()} session today and decline all P2/P3 commitments until trend reverses.`,
      };
    case "BREACH":
      return {
        rationale: `${name} compliance is critical (score ${svc.service_score}/100, ${budget.percentRemaining}% budget remaining).`,
        recommendedAction: `Cultivation = P1 for ${name}. Complete a ≥${floor}m session today; decline competing P2/P3 demands.`,
      };
    case "WARNING":
      return {
        rationale: `${name} compliance is degraded (score ${svc.service_score}/100) with ${dayWord(consecutiveLow)} of inactivity.`,
        recommendedAction: `Schedule a makeup ${name.toLowerCase()} session within 48 hours; time-box any new P2 commitments.`,
      };
    case "ADVISORY":
      if (svc.compliance_color === "yellow") {
        return {
          rationale: `${name} is below the green threshold but still above the BREACH floor (${budget.percentRemaining}% budget remaining).`,
          recommendedAction: `Note and monitor. Avoid new recurring commitments that compete with ${name.toLowerCase()}.`,
        };
      }
      return {
        rationale: `${name} is above the SLO floor but has logged no qualifying session in ${dayWord(consecutiveLow)}.`,
        recommendedAction: `Re-engage ${name.toLowerCase()} this week to prevent escalation; protect the next available slot.`,
      };
    case "NOMINAL":
    default:
      return {
        rationale: `${name} is meeting SLO with healthy budget headroom (${budget.percentRemaining}% remaining).`,
        recommendedAction: `Maintain current cadence. Eligible to accept additional P2/P3 commitments.`,
      };
  }
}

/** Compute escalation state for a single domain. */
export function computeDomainEscalation<T extends Session>(
  domain: Domain,
  allSessions: T[],
  opts: PolicyEngineOptions = {}
): DomainEscalation {
  const svc = computeServiceState(domain, allSessions, opts);
  const policy = DOMAIN_POLICY[domain];
  const window = svc.window_days;

  const domainSessions = allSessions.filter((s) => s.domain === domain);
  const inWindow = filterSessionsInWindow(domainSessions, window, opts);

  const lowDays = consecutiveLowDays(inWindow, window, policy.sessionFloor, opts);
  const isDeviated = svc.is_deviated === true;
  const tier = classifyTier(svc, lowDays);
  const errorBudget = computeErrorBudget(svc, isDeviated);
  const burnRate = policy.dailyProRate > 0 && window.length > 0
    ? Math.round((svc.actual_minutes / window.length) / policy.dailyProRate * 100) / 100
    : 0;
  const { rationale, recommendedAction } = buildGuidance(domain, tier, svc, errorBudget, lowDays);

  return {
    domain,
    tier,
    rationale,
    recommendedAction,
    consecutiveLowDays: lowDays,
    burnRate,
    errorBudget,
  };
}

function joinDomainNames(domains: Domain[]): string {
  return domains.map(formatDomainName).join(", ");
}

/**
 * Build the composite system-level summary from per-domain escalation results.
 * The displayStatus collapses PAGE → BREACH so consumers can render a single
 * banner with the same status taxonomy used elsewhere in the UI.
 */
export function computeComposite(
  perDomain: Record<Domain, DomainEscalation>,
  highestTier: EscalationTier
): CompositeEscalation {
  const domainsByTier: Record<EscalationTier, Domain[]> = {
    NOMINAL: [], ADVISORY: [], WARNING: [], BREACH: [], PAGE: [],
  };
  for (const d of domainEnum) {
    domainsByTier[perDomain[d].tier].push(d);
  }

  const breachLike = [...domainsByTier.PAGE, ...domainsByTier.BREACH];
  const warning = domainsByTier.WARNING;
  const advisory = domainsByTier.ADVISORY;

  let displayStatus: CompositeDisplayStatus;
  let rationale: string;
  let recommendedAction: string;
  if (highestTier === "BREACH" || highestTier === "PAGE") {
    displayStatus = "BREACH";
    const lead = breachLike.length > 0
      ? `${breachLike.length} domain${breachLike.length === 1 ? "" : "s"} critically below SLO (${joinDomainNames(breachLike)}).`
      : `One or more domains critically below SLO.`;
    rationale = `${lead} Cultivation elevated to P1 priority. Decline all P2/P3 until system recovers.`;
    recommendedAction = "Cultivation = P1. Decline all P2 and P3 demands until the system recovers to WARNING.";
  } else if (highestTier === "WARNING") {
    displayStatus = "WARNING";
    const lead = warning.length > 0
      ? `${warning.length} domain${warning.length === 1 ? "" : "s"} below SLO green threshold (${joinDomainNames(warning)}).`
      : `One or more domains below SLO green threshold.`;
    rationale = `${lead} Decline P3. Time-box any P2. Schedule makeup within 3 days.`;
    recommendedAction = "Decline P3 demands. Time-box any accepted P2 and schedule a makeup session within 3 days.";
  } else if (highestTier === "ADVISORY") {
    displayStatus = "ADVISORY";
    const lead = advisory.length > 0
      ? `${advisory.length} domain${advisory.length === 1 ? "" : "s"} trending low or trailing inactive days (${joinDomainNames(advisory)}).`
      : `Momentum declining or trailing low-effort days detected.`;
    rationale = `All domains above SLO floor, but ${lead.toLowerCase().replace(/\.$/, "")}. Note and monitor — avoid new recurring commitments.`;
    recommendedAction = "Note and monitor. Avoid new recurring commitments until trends stabilize.";
  } else {
    displayStatus = "NOMINAL";
    rationale = "All domains meeting SLO targets. Full flex capacity — eligible to accept P2 and evaluate P3 demands.";
    recommendedAction = "Maintain current cadence. Accept P2 normally and evaluate P3 demands for strategic alignment.";
  }

  return { tier: highestTier, displayStatus, rationale, recommendedAction, domainsByTier };
}

/** Compute escalation state for every known domain. */
export function computeEscalationState<T extends Session>(
  allSessions: T[],
  opts: PolicyEngineOptions = {},
  historyDays: number = DEFAULT_ESCALATION_HISTORY_DAYS
): EscalationStateResponse {
  const now = opts.now ?? new Date();
  const todayKey = logicalDay(now, opts);

  const perDomain = {} as Record<Domain, DomainEscalation>;
  let highestTier: EscalationTier = "NOMINAL";
  for (const d of domainEnum) {
    const esc = computeDomainEscalation(d, allSessions, opts);
    perDomain[d] = esc;
    if (TIER_RANK[esc.tier] > TIER_RANK[highestTier]) highestTier = esc.tier;
  }

  // B3.1 — Ramp-up suppression. During the post-signup runway window, scores
  // still compute normally (they remain on `perDomain[d].errorBudget` and
  // ServiceState), but tier surfacing is forced to NOMINAL across the board
  // so a brand-new user doesn't see BREACH/WARNING banners before they've
  // had a chance to log meaningful activity. History is intentionally NOT
  // rewritten — it represents the authentic per-day classification.
  const rampUp = isInRampUp(opts.userCreatedAt, now);
  if (rampUp) {
    const nominalRationale = "System calibrating — within the 7-day ramp-up window. Escalation tiers are suppressed until enough activity is logged for SLOs to be meaningful.";
    const nominalAction = "Log sessions normally. Escalation will resume once the ramp-up window completes.";
    for (const d of domainEnum) {
      perDomain[d] = {
        ...perDomain[d],
        tier: "NOMINAL",
        rationale: nominalRationale,
        recommendedAction: nominalAction,
      };
    }
    highestTier = "NOMINAL";
  }

  const composite = computeComposite(perDomain, highestTier);
  const history = computeEscalationHistory(allSessions, opts, historyDays);
  return { logical_day: todayKey, perDomain, highestTier, composite, history, isRampUp: rampUp };
}

/**
 * Compute per-day escalation tier history for the trailing `days` logical days
 * (oldest → newest). Each day's entry reflects how `computeEscalationState` would
 * have classified that day, by sliding the `now` override across the range.
 */
export function computeEscalationHistory<T extends Session>(
  allSessions: T[],
  opts: PolicyEngineOptions = {},
  days: number = DEFAULT_ESCALATION_HISTORY_DAYS
): EscalationHistoryEntry[] {
  if (days <= 0) return [];
  const now = opts.now ?? new Date();
  const todayKey = logicalDay(now, opts);
  const [ty, tm, td] = todayKey.split("-").map((n) => parseInt(n, 10));
  const anchorUtc = Date.UTC(ty, tm - 1, td);

  const out: EscalationHistoryEntry[] = [];
  for (let i = days - 1; i >= 0; i--) {
    // Noon UTC on the target calendar day — safely after `dayStartHour` in supported timezones,
    // so the logical day for the slid `now` matches the intended calendar day.
    const slidingNow = new Date(anchorUtc - i * 24 * 60 * 60 * 1000 + 12 * 60 * 60 * 1000);
    const slidOpts: PolicyEngineOptions = { ...opts, now: slidingNow };
    const dayKey = logicalDay(slidingNow, slidOpts);
    const perDomainDay = {} as Record<Domain, EscalationHistoryDayDomain>;
    let highest: EscalationTier = "NOMINAL";
    for (const d of domainEnum) {
      const esc = computeDomainEscalation(d, allSessions, slidOpts);
      perDomainDay[d] = {
        tier: esc.tier,
        percentRemaining: esc.errorBudget.percentRemaining,
      };
      if (TIER_RANK[esc.tier] > TIER_RANK[highest]) highest = esc.tier;
    }
    out.push({ logical_day: dayKey, perDomain: perDomainDay, highestTier: highest });
  }
  return out;
}
