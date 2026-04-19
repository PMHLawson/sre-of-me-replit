/**
 * C4.2 — Notification trigger evaluation (transport-agnostic)
 *
 * Pure function that diffs the current policy / escalation state against a
 * previous escalation state and emits a list of typed trigger events. Has
 * no I/O — does not send push, does not call APIs, does not mutate inputs.
 * Transport (push, in-app badge) is layered on in C4.3+.
 *
 * Six trigger TYPES per SOMR-300 acceptance criteria:
 *   1. ESCALATION_CHANGE       — tier moved up OR down (direction in payload)
 *   2. COMPLIANCE_WARNING      — domain crossed into ADVISORY/WARNING
 *   3. DEVIATION_ENDING        — an active deviation has ended
 *   4. RAMP_UP_MILESTONE       — user just exited the post-signup ramp-up window
 *   5. OVERACHIEVEMENT_SUSTAINED — sustained overachievement run hit threshold
 *   6. INACTIVITY              — consecutive zero-session days exceeded threshold
 */

import type {
  Domain,
  EscalationStateResponse,
  EscalationTier,
  NotificationTier,
  PolicyStateResponse,
  UserSettings,
} from "@shared/schema";

// ---------------- Types ----------------

export type TriggerType =
  | "ESCALATION_CHANGE"
  | "COMPLIANCE_WARNING"
  | "DEVIATION_ENDING"
  | "RAMP_UP_MILESTONE"
  | "OVERACHIEVEMENT_SUSTAINED"
  | "INACTIVITY";

export type TriggerDirection = "up" | "down";

export interface TriggerEventBase {
  /** Stable ID derived from type + payload, lets the client de-dupe. */
  id: string;
  type: TriggerType;
  /** Tier severity used for the user's `notificationTier` filter. */
  severity: NotificationTier;
  /** Short headline suitable for a notification title. */
  title: string;
  /** Body copy suitable for a notification body / in-app row. */
  body: string;
  /** Domain this event concerns, when applicable. */
  domain?: Domain;
  /** Logical day the computation was anchored on (for de-dup across renders). */
  logicalDay: string;
}

export interface EscalationChangeEvent extends TriggerEventBase {
  type: "ESCALATION_CHANGE";
  direction: TriggerDirection;
  fromTier: EscalationTier;
  toTier: EscalationTier;
  domain: Domain;
}

export interface ComplianceWarningEvent extends TriggerEventBase {
  type: "COMPLIANCE_WARNING";
  domain: Domain;
  tier: EscalationTier;
}

export interface DeviationEndingEvent extends TriggerEventBase {
  type: "DEVIATION_ENDING";
  domain: Domain;
  deviationId: string;
}

export interface RampUpMilestoneEvent extends TriggerEventBase {
  type: "RAMP_UP_MILESTONE";
}

export interface OverachievementSustainedEvent extends TriggerEventBase {
  type: "OVERACHIEVEMENT_SUSTAINED";
  domain: Domain;
  consecutiveDays: number;
  tier: "COMMITTED" | "PEAK" | "ELITE";
}

export interface InactivityEvent extends TriggerEventBase {
  type: "INACTIVITY";
  domain: Domain;
  consecutiveLowDays: number;
}

export type TriggerEvent =
  | EscalationChangeEvent
  | ComplianceWarningEvent
  | DeviationEndingEvent
  | RampUpMilestoneEvent
  | OverachievementSustainedEvent
  | InactivityEvent;

/**
 * Inputs to the evaluator. `previous` may be null on first run (no prior
 * snapshot to diff against) — in that case purely transitional triggers
 * (ESCALATION_CHANGE, RAMP_UP_MILESTONE) are suppressed to avoid alert
 * floods on initial computation.
 */
export interface EvaluateTriggersInput {
  policy: PolicyStateResponse | null;
  current: EscalationStateResponse | null;
  previous: EscalationStateResponse | null;
  /**
   * Deviations whose `endedAt` falls within this evaluation cycle. Caller
   * is responsible for filtering to "just ended" — typically by tracking
   * which deviation IDs were active in the previous evaluation and ended
   * since. Pass [] when there's no prior snapshot.
   */
  endedDeviations?: Array<{ id: string; domain: Domain }>;
  settings?: Pick<UserSettings, "notificationsEnabled" | "notificationTier"> | null;
}

// ---------------- Constants ----------------

const TIER_RANK: Record<EscalationTier, number> = {
  NOMINAL: 0,
  ADVISORY: 1,
  WARNING: 2,
  BREACH: 3,
  PAGE: 4,
};

/**
 * Map an EscalationTier to the user-configurable NotificationTier used for
 * filtering. PAGE collapses to BREACH for filter purposes (PAGE is always
 * delivered when notifications are enabled at any tier).
 */
const TIER_TO_NOTIFICATION_TIER: Record<EscalationTier, NotificationTier> = {
  NOMINAL: "ADVISORY",
  ADVISORY: "ADVISORY",
  WARNING: "WARNING",
  BREACH: "BREACH",
  PAGE: "PAGE",
};

const NOTIFICATION_TIER_RANK: Record<NotificationTier, number> = {
  ADVISORY: 1,
  WARNING: 2,
  BREACH: 3,
  PAGE: 4,
};

/**
 * Inactivity threshold (consecutive low days) at which we emit an
 * INACTIVITY notification. Picked to match the existing escalation
 * model's "ADVISORY at 3 consecutive low days" rule.
 */
export const INACTIVITY_THRESHOLD_DAYS = 3;

/**
 * Sustained overachievement threshold (consecutive days) at which we
 * emit an OVERACHIEVEMENT_SUSTAINED notification. Mirrors C2.3's intent.
 */
export const OVERACHIEVEMENT_SUSTAINED_THRESHOLD_DAYS = 3;

// ---------------- Helpers ----------------

function formatDomain(d: Domain): string {
  return d
    .split("-")
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

function eventId(parts: Array<string | number>): string {
  return parts.join(":");
}

// ---------------- Main entry ----------------

/**
 * Evaluate all trigger conditions and return a list of events that fired.
 *
 * Never throws — bad inputs return `[]`. Transport-agnostic — caller is
 * responsible for delivery (push, in-app badge, etc.).
 *
 * The returned list is filtered by the user's `notificationTier`: events
 * below the user's configured threshold are dropped. If
 * `notificationsEnabled` is false (or settings is null), `[]` is returned.
 */
export function evaluateTriggers(input: EvaluateTriggersInput): TriggerEvent[] {
  const { policy, current, previous, endedDeviations = [], settings = null } = input;

  // Notifications globally disabled → no events.
  if (!settings || settings.notificationsEnabled === false) return [];
  if (!current) return [];

  const events: TriggerEvent[] = [];
  const logicalDay = current.logical_day;

  // --- 1 + 2. Escalation change (up/down) and compliance warning ---
  if (previous && current) {
    for (const domain of Object.keys(current.perDomain) as Domain[]) {
      const cur = current.perDomain[domain];
      const prev = previous.perDomain?.[domain];
      if (!cur || !prev) continue;

      const fromRank = TIER_RANK[prev.tier];
      const toRank = TIER_RANK[cur.tier];
      if (toRank === fromRank) continue;

      const direction: TriggerDirection = toRank > fromRank ? "up" : "down";
      const name = formatDomain(domain);

      const change: EscalationChangeEvent = {
        id: eventId([
          "ESCALATION_CHANGE",
          domain,
          prev.tier,
          cur.tier,
          logicalDay,
        ]),
        type: "ESCALATION_CHANGE",
        severity: TIER_TO_NOTIFICATION_TIER[cur.tier === "NOMINAL" ? prev.tier : cur.tier],
        title:
          direction === "up"
            ? `${name} escalated to ${cur.tier}`
            : `${name} recovered to ${cur.tier}`,
        body: cur.rationale,
        domain,
        direction,
        fromTier: prev.tier,
        toTier: cur.tier,
        logicalDay,
      };
      events.push(change);

      // 2. Compliance warning — fires when crossing UP into ADVISORY or WARNING
      // (i.e. just left the green/NOMINAL zone but hasn't broken budget yet).
      if (
        direction === "up" &&
        (cur.tier === "ADVISORY" || cur.tier === "WARNING") &&
        prev.tier === "NOMINAL"
      ) {
        const warning: ComplianceWarningEvent = {
          id: eventId(["COMPLIANCE_WARNING", domain, cur.tier, logicalDay]),
          type: "COMPLIANCE_WARNING",
          severity: TIER_TO_NOTIFICATION_TIER[cur.tier],
          title: `${name} compliance ${cur.tier === "WARNING" ? "warning" : "advisory"}`,
          body: cur.rationale,
          domain,
          tier: cur.tier,
          logicalDay,
        };
        events.push(warning);
      }
    }
  }

  // --- 3. Deviation ending ---
  for (const dev of endedDeviations) {
    const name = formatDomain(dev.domain);
    events.push({
      id: eventId(["DEVIATION_ENDING", dev.id, logicalDay]),
      type: "DEVIATION_ENDING",
      severity: "ADVISORY",
      title: `${name} deviation ended`,
      body: `The active deviation on ${name} has ended; this domain is now back in the composite score.`,
      domain: dev.domain,
      deviationId: dev.id,
      logicalDay,
    });
  }

  // --- 4. Ramp-up milestone (transition: previously ramping up, now not) ---
  if (previous && previous.isRampUp && !current.isRampUp) {
    events.push({
      id: eventId(["RAMP_UP_MILESTONE", logicalDay]),
      type: "RAMP_UP_MILESTONE",
      severity: "ADVISORY",
      title: "Ramp-up complete",
      body: "You've finished your post-signup calibration window. Full escalation tracking is now live.",
      logicalDay,
    });
  }

  // --- 5. Overachievement sustained ---
  if (policy?.sustainedOverachievement) {
    for (const domain of Object.keys(policy.sustainedOverachievement) as Domain[]) {
      const entry = policy.sustainedOverachievement[domain];
      if (!entry) continue;
      if (entry.tier === "NONE") continue;
      if (entry.consecutiveDays < OVERACHIEVEMENT_SUSTAINED_THRESHOLD_DAYS) continue;

      const name = formatDomain(domain);
      events.push({
        id: eventId([
          "OVERACHIEVEMENT_SUSTAINED",
          domain,
          entry.tier,
          entry.consecutiveDays,
          logicalDay,
        ]),
        type: "OVERACHIEVEMENT_SUSTAINED",
        severity: "ADVISORY",
        title: `${name} sustained ${entry.tier}`,
        body: `${entry.consecutiveDays} consecutive days at ${entry.tier} on ${name}. Consider whether this pace is sustainable.`,
        domain,
        consecutiveDays: entry.consecutiveDays,
        tier: entry.tier as "COMMITTED" | "PEAK" | "ELITE",
        logicalDay,
      });
    }
  }

  // --- 6. Inactivity ---
  for (const domain of Object.keys(current.perDomain) as Domain[]) {
    const cur = current.perDomain[domain];
    if (!cur) continue;
    if (cur.consecutiveLowDays < INACTIVITY_THRESHOLD_DAYS) continue;

    const name = formatDomain(domain);
    events.push({
      id: eventId([
        "INACTIVITY",
        domain,
        cur.consecutiveLowDays,
        logicalDay,
      ]),
      type: "INACTIVITY",
      severity: cur.consecutiveLowDays >= 5 ? "WARNING" : "ADVISORY",
      title: `${name} inactivity`,
      body: `${cur.consecutiveLowDays} consecutive days without a qualifying ${name} session.`,
      domain,
      consecutiveLowDays: cur.consecutiveLowDays,
      logicalDay,
    });
  }

  // --- Filter by user's configured minimum tier ---
  const minRank = NOTIFICATION_TIER_RANK[settings.notificationTier as NotificationTier] ?? 1;
  return events.filter((ev) => NOTIFICATION_TIER_RANK[ev.severity] >= minRank);
}
