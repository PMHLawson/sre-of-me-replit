import type { Session, Domain } from "@shared/schema";
import { domainEnum } from "@shared/schema";
import {
  DOMAIN_POLICY,
  computeServiceState,
  logicalDay,
  groupByLogicalDay,
  filterSessionsInWindow,
  type ServiceState,
  type PolicyEngineOptions,
} from "./policy-engine";

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

export interface EscalationStateResponse {
  /** Logical day key the computation is anchored on. */
  logical_day: string;
  /** Per-domain escalation state, keyed by domain. */
  perDomain: Record<Domain, DomainEscalation>;
  /** Highest-severity tier across all domains. */
  highestTier: EscalationTier;
}

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
 */
export function computeErrorBudget(svc: ServiceState): ErrorBudget {
  const target = svc.policy.targetMinutes;
  const allowedMinutes = Math.round(target * 0.6);
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
  const tier = classifyTier(svc, lowDays);
  const errorBudget = computeErrorBudget(svc);
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

/** Compute escalation state for every known domain. */
export function computeEscalationState<T extends Session>(
  allSessions: T[],
  opts: PolicyEngineOptions = {}
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
  return { logical_day: todayKey, perDomain, highestTier };
}
