/**
 * Tests for the notification trigger evaluator (server/lib/notifications.ts).
 *
 * Locks in the trigger semantics so threshold or transition logic can't
 * silently drift. Covers each of the seven trigger TYPES the engine emits
 * (ESCALATION_CHANGE, ESCALATION_RECOVERY, COMPLIANCE_WARNING,
 * DEVIATION_ENDING, RAMP_UP_MILESTONE, OVERACHIEVEMENT_SUSTAINED,
 * INACTIVITY) plus the three global gates (settings null,
 * notificationsEnabled=false, tier filter).
 */

import { describe, expect, it } from "vitest";
import {
  evaluateTriggers,
  INACTIVITY_THRESHOLD_DAYS,
  OVERACHIEVEMENT_SUSTAINED_THRESHOLD_DAYS,
} from "./notifications";
import type {
  Domain,
  DomainEscalation,
  EscalationStateResponse,
  EscalationTier,
  NotificationTier,
  PolicyStateResponse,
  SustainedOverachievementEntry,
  UserSettings,
} from "@shared/schema";

// ---------------- Fixture builders ----------------

function makeDomainEscalation(
  domain: Domain,
  overrides: Partial<DomainEscalation> = {},
): DomainEscalation {
  return {
    domain,
    tier: "NOMINAL",
    rationale: "All systems nominal.",
    recommendedAction: "Maintain current cadence.",
    consecutiveLowDays: 0,
    burnRate: 0,
    errorBudget: {
      consumedMinutes: 0,
      allowedMinutes: 100,
      remainingMinutes: 100,
      percentRemaining: 1,
    },
    ...overrides,
  };
}

function makeEscalationState(
  perDomainOverrides: Partial<Record<Domain, Partial<DomainEscalation>>> = {},
  rest: Partial<EscalationStateResponse> = {},
): EscalationStateResponse {
  const domains: Domain[] = ["martial-arts", "meditation", "fitness", "music"];
  const perDomain = Object.fromEntries(
    domains.map((d) => [d, makeDomainEscalation(d, perDomainOverrides[d] ?? {})]),
  ) as Record<Domain, DomainEscalation>;
  return {
    logical_day: "2026-04-19",
    perDomain,
    highestTier: "NOMINAL",
    composite: {
      tier: "NOMINAL",
      displayStatus: "NOMINAL",
      rationale: "All systems nominal.",
      recommendedAction: "Maintain.",
      domainsByTier: { NOMINAL: domains, ADVISORY: [], WARNING: [], BREACH: [], PAGE: [] },
    },
    history: [],
    isRampUp: false,
    ...rest,
  };
}

function makeSustainedEntry(
  consecutiveDays: number,
  tier: SustainedOverachievementEntry["tier"] = "COMMITTED",
): SustainedOverachievementEntry {
  return { consecutiveDays, tier };
}

function makePolicyState(
  sustained: Partial<Record<Domain, SustainedOverachievementEntry>> = {},
): PolicyStateResponse {
  const domains: Domain[] = ["martial-arts", "meditation", "fitness", "music"];
  const sustainedOverachievement = Object.fromEntries(
    domains.map((d) => [
      d,
      sustained[d] ?? makeSustainedEntry(0, "NONE" as SustainedOverachievementEntry["tier"]),
    ]),
  ) as Record<Domain, SustainedOverachievementEntry>;
  return {
    logical_day: "2026-04-19",
    window_days: [],
    services: {} as PolicyStateResponse["services"],
    composite_score: 1,
    composite_color: "GREEN",
    isRampUp: false,
    sustainedOverachievement,
  };
}

function makeSettings(
  enabled = true,
  tier: NotificationTier = "ADVISORY",
): Pick<UserSettings, "notificationsEnabled" | "notificationTier"> {
  return { notificationsEnabled: enabled, notificationTier: tier };
}

// ---------------- Global gates ----------------

describe("evaluateTriggers — global gates", () => {
  it("returns [] when settings is null", () => {
    expect(
      evaluateTriggers({
        policy: null,
        current: makeEscalationState(),
        previous: makeEscalationState(),
        settings: null,
      }),
    ).toEqual([]);
  });

  it("returns [] when notificationsEnabled is false", () => {
    expect(
      evaluateTriggers({
        policy: null,
        current: makeEscalationState(),
        previous: makeEscalationState(),
        settings: makeSettings(false, "ADVISORY"),
      }),
    ).toEqual([]);
  });

  it("returns [] when current escalation state is null", () => {
    expect(
      evaluateTriggers({
        policy: null,
        current: null,
        previous: makeEscalationState(),
        settings: makeSettings(),
      }),
    ).toEqual([]);
  });

  it("drops events whose severity is below the user's notificationTier", () => {
    // Escalation NOMINAL→ADVISORY produces ADVISORY-tier ESCALATION_CHANGE +
    // COMPLIANCE_WARNING. With a WARNING+ filter both should be dropped.
    const previous = makeEscalationState({});
    const current = makeEscalationState({
      "martial-arts": { tier: "ADVISORY", rationale: "Slipping." },
    });
    const events = evaluateTriggers({
      policy: null,
      current,
      previous,
      settings: makeSettings(true, "WARNING"),
    });
    expect(events).toEqual([]);
  });

  it("keeps WARNING-tier events when filter is WARNING", () => {
    const previous = makeEscalationState({});
    const current = makeEscalationState({
      "martial-arts": { tier: "WARNING", rationale: "Burn-rate high." },
    });
    const events = evaluateTriggers({
      policy: null,
      current,
      previous,
      settings: makeSettings(true, "WARNING"),
    });
    // ESCALATION_CHANGE + COMPLIANCE_WARNING both at WARNING severity.
    expect(events.map((e) => e.type).sort()).toEqual([
      "COMPLIANCE_WARNING",
      "ESCALATION_CHANGE",
    ]);
  });
});

// ---------------- Escalation change / recovery ----------------

describe("evaluateTriggers — ESCALATION_CHANGE / ESCALATION_RECOVERY", () => {
  it("emits ESCALATION_CHANGE with direction='up' on a worsening transition", () => {
    const previous = makeEscalationState({});
    const current = makeEscalationState({
      fitness: { tier: "BREACH", rationale: "Budget exhausted." },
    });
    const events = evaluateTriggers({
      policy: null,
      current,
      previous,
      settings: makeSettings(true, "ADVISORY"),
    });
    const change = events.find((e) => e.type === "ESCALATION_CHANGE");
    expect(change).toBeDefined();
    if (change?.type === "ESCALATION_CHANGE") {
      expect(change.direction).toBe("up");
      expect(change.fromTier).toBe("NOMINAL");
      expect(change.toTier).toBe("BREACH");
      expect(change.domain).toBe("fitness");
      expect(change.severity).toBe("BREACH");
    }
  });

  it("emits ESCALATION_RECOVERY with direction='down' on an improving transition", () => {
    const previous = makeEscalationState({
      music: { tier: "WARNING", rationale: "Was warned." },
    });
    const current = makeEscalationState({});
    const events = evaluateTriggers({
      policy: null,
      current,
      previous,
      settings: makeSettings(true, "ADVISORY"),
    });
    const recovery = events.find((e) => e.type === "ESCALATION_RECOVERY");
    expect(recovery).toBeDefined();
    if (recovery?.type === "ESCALATION_RECOVERY") {
      expect(recovery.direction).toBe("down");
      expect(recovery.fromTier).toBe("WARNING");
      expect(recovery.toTier).toBe("NOMINAL");
      expect(recovery.domain).toBe("music");
      // Severity reflects the tier we LEFT.
      expect(recovery.severity).toBe("WARNING");
    }
    // Must NOT also emit a COMPLIANCE_WARNING on a downward transition.
    expect(events.some((e) => e.type === "COMPLIANCE_WARNING")).toBe(false);
  });

  it("does not emit any escalation event when tier is unchanged", () => {
    const previous = makeEscalationState({
      music: { tier: "ADVISORY", rationale: "Soft alert." },
    });
    const current = makeEscalationState({
      music: { tier: "ADVISORY", rationale: "Still soft." },
    });
    const events = evaluateTriggers({
      policy: null,
      current,
      previous,
      settings: makeSettings(true, "ADVISORY"),
    });
    expect(events.some((e) => e.type === "ESCALATION_CHANGE")).toBe(false);
    expect(events.some((e) => e.type === "ESCALATION_RECOVERY")).toBe(false);
  });

  it("suppresses escalation events when previous snapshot is null", () => {
    const events = evaluateTriggers({
      policy: null,
      current: makeEscalationState({
        fitness: { tier: "BREACH", rationale: "Out of budget." },
      }),
      previous: null,
      settings: makeSettings(true, "ADVISORY"),
    });
    expect(events.some((e) => e.type === "ESCALATION_CHANGE")).toBe(false);
  });
});

// ---------------- Compliance warning ----------------

describe("evaluateTriggers — COMPLIANCE_WARNING", () => {
  it("fires on NOMINAL → ADVISORY", () => {
    const previous = makeEscalationState({});
    const current = makeEscalationState({
      meditation: { tier: "ADVISORY", rationale: "Slipping." },
    });
    const events = evaluateTriggers({
      policy: null,
      current,
      previous,
      settings: makeSettings(true, "ADVISORY"),
    });
    const warning = events.find((e) => e.type === "COMPLIANCE_WARNING");
    expect(warning).toBeDefined();
    if (warning?.type === "COMPLIANCE_WARNING") {
      expect(warning.tier).toBe("ADVISORY");
      expect(warning.severity).toBe("ADVISORY");
    }
  });

  it("fires on NOMINAL → WARNING", () => {
    const previous = makeEscalationState({});
    const current = makeEscalationState({
      meditation: { tier: "WARNING", rationale: "Burn-rate high." },
    });
    const events = evaluateTriggers({
      policy: null,
      current,
      previous,
      settings: makeSettings(true, "ADVISORY"),
    });
    const warning = events.find((e) => e.type === "COMPLIANCE_WARNING");
    expect(warning).toBeDefined();
    if (warning?.type === "COMPLIANCE_WARNING") {
      expect(warning.tier).toBe("WARNING");
      expect(warning.severity).toBe("WARNING");
    }
  });

  it("fires on ADVISORY → WARNING", () => {
    const previous = makeEscalationState({
      meditation: { tier: "ADVISORY", rationale: "Soft." },
    });
    const current = makeEscalationState({
      meditation: { tier: "WARNING", rationale: "Worse." },
    });
    const events = evaluateTriggers({
      policy: null,
      current,
      previous,
      settings: makeSettings(true, "ADVISORY"),
    });
    const warning = events.find((e) => e.type === "COMPLIANCE_WARNING");
    expect(warning).toBeDefined();
    if (warning?.type === "COMPLIANCE_WARNING") {
      expect(warning.tier).toBe("WARNING");
    }
  });

  it("does NOT fire when transitioning UP into BREACH (not an ADVISORY/WARNING tier)", () => {
    const previous = makeEscalationState({});
    const current = makeEscalationState({
      meditation: { tier: "BREACH", rationale: "Out of budget." },
    });
    const events = evaluateTriggers({
      policy: null,
      current,
      previous,
      settings: makeSettings(true, "ADVISORY"),
    });
    expect(events.some((e) => e.type === "COMPLIANCE_WARNING")).toBe(false);
  });
});

// ---------------- Overachievement sustained ----------------

describe("evaluateTriggers — OVERACHIEVEMENT_SUSTAINED", () => {
  const T = OVERACHIEVEMENT_SUSTAINED_THRESHOLD_DAYS;

  it("fires only on the threshold-crossing day", () => {
    const events = evaluateTriggers({
      policy: makePolicyState({ fitness: makeSustainedEntry(T, "PEAK") }),
      previousPolicy: makePolicyState({ fitness: makeSustainedEntry(T - 1, "PEAK") }),
      current: makeEscalationState(),
      previous: makeEscalationState(),
      settings: makeSettings(true, "ADVISORY"),
    });
    const o = events.find((e) => e.type === "OVERACHIEVEMENT_SUSTAINED");
    expect(o).toBeDefined();
    if (o?.type === "OVERACHIEVEMENT_SUSTAINED") {
      expect(o.domain).toBe("fitness");
      expect(o.consecutiveDays).toBe(T);
      expect(o.tier).toBe("PEAK");
    }
  });

  it("does NOT fire when consecutiveDays was already at threshold yesterday", () => {
    const events = evaluateTriggers({
      policy: makePolicyState({ fitness: makeSustainedEntry(T + 1, "PEAK") }),
      previousPolicy: makePolicyState({ fitness: makeSustainedEntry(T, "PEAK") }),
      current: makeEscalationState(),
      previous: makeEscalationState(),
      settings: makeSettings(true, "ADVISORY"),
    });
    expect(events.some((e) => e.type === "OVERACHIEVEMENT_SUSTAINED")).toBe(false);
  });

  it("does NOT fire when consecutiveDays is below threshold", () => {
    const events = evaluateTriggers({
      policy: makePolicyState({ fitness: makeSustainedEntry(T - 1, "PEAK") }),
      previousPolicy: makePolicyState({ fitness: makeSustainedEntry(T - 2, "PEAK") }),
      current: makeEscalationState(),
      previous: makeEscalationState(),
      settings: makeSettings(true, "ADVISORY"),
    });
    expect(events.some((e) => e.type === "OVERACHIEVEMENT_SUSTAINED")).toBe(false);
  });

  it("does NOT fire when tier is NONE", () => {
    const events = evaluateTriggers({
      policy: makePolicyState({
        fitness: makeSustainedEntry(T, "NONE" as SustainedOverachievementEntry["tier"]),
      }),
      previousPolicy: makePolicyState({
        fitness: makeSustainedEntry(0, "NONE" as SustainedOverachievementEntry["tier"]),
      }),
      current: makeEscalationState(),
      previous: makeEscalationState(),
      settings: makeSettings(true, "ADVISORY"),
    });
    expect(events.some((e) => e.type === "OVERACHIEVEMENT_SUSTAINED")).toBe(false);
  });

  it("is suppressed when previousPolicy is null (no transition detectable)", () => {
    const events = evaluateTriggers({
      policy: makePolicyState({ fitness: makeSustainedEntry(T, "PEAK") }),
      previousPolicy: null,
      current: makeEscalationState(),
      previous: makeEscalationState(),
      settings: makeSettings(true, "ADVISORY"),
    });
    expect(events.some((e) => e.type === "OVERACHIEVEMENT_SUSTAINED")).toBe(false);
  });
});

// ---------------- Inactivity ----------------

describe("evaluateTriggers — INACTIVITY", () => {
  const T = INACTIVITY_THRESHOLD_DAYS;

  it(`fires when consecutiveLowDays >= ${T}`, () => {
    const current = makeEscalationState({
      music: { consecutiveLowDays: T },
    });
    const events = evaluateTriggers({
      policy: null,
      current,
      previous: makeEscalationState(),
      settings: makeSettings(true, "ADVISORY"),
    });
    const i = events.find((e) => e.type === "INACTIVITY");
    expect(i).toBeDefined();
    if (i?.type === "INACTIVITY") {
      expect(i.domain).toBe("music");
      expect(i.consecutiveLowDays).toBe(T);
      expect(i.severity).toBe("ADVISORY");
    }
  });

  it(`does NOT fire when consecutiveLowDays < ${T}`, () => {
    const current = makeEscalationState({
      music: { consecutiveLowDays: T - 1 },
    });
    const events = evaluateTriggers({
      policy: null,
      current,
      previous: makeEscalationState(),
      settings: makeSettings(true, "ADVISORY"),
    });
    expect(events.some((e) => e.type === "INACTIVITY")).toBe(false);
  });

  it("escalates severity to WARNING at >=5 consecutive low days", () => {
    const current = makeEscalationState({
      music: { consecutiveLowDays: 5 },
    });
    const events = evaluateTriggers({
      policy: null,
      current,
      previous: makeEscalationState(),
      settings: makeSettings(true, "ADVISORY"),
    });
    const i = events.find((e) => e.type === "INACTIVITY");
    expect(i?.severity).toBe("WARNING");
  });
});

// ---------------- Ramp-up milestone ----------------

describe("evaluateTriggers — RAMP_UP_MILESTONE", () => {
  it("fires on isRampUp true → false transition", () => {
    const previous = makeEscalationState({}, { isRampUp: true });
    const current = makeEscalationState({}, { isRampUp: false });
    const events = evaluateTriggers({
      policy: null,
      current,
      previous,
      settings: makeSettings(true, "ADVISORY"),
    });
    expect(events.some((e) => e.type === "RAMP_UP_MILESTONE")).toBe(true);
  });

  it("does NOT fire when still ramping up", () => {
    const previous = makeEscalationState({}, { isRampUp: true });
    const current = makeEscalationState({}, { isRampUp: true });
    const events = evaluateTriggers({
      policy: null,
      current,
      previous,
      settings: makeSettings(true, "ADVISORY"),
    });
    expect(events.some((e) => e.type === "RAMP_UP_MILESTONE")).toBe(false);
  });

  it("does NOT fire when ramp-up was already complete in previous snapshot", () => {
    const previous = makeEscalationState({}, { isRampUp: false });
    const current = makeEscalationState({}, { isRampUp: false });
    const events = evaluateTriggers({
      policy: null,
      current,
      previous,
      settings: makeSettings(true, "ADVISORY"),
    });
    expect(events.some((e) => e.type === "RAMP_UP_MILESTONE")).toBe(false);
  });

  it("is suppressed when previous snapshot is null", () => {
    const events = evaluateTriggers({
      policy: null,
      current: makeEscalationState({}, { isRampUp: false }),
      previous: null,
      settings: makeSettings(true, "ADVISORY"),
    });
    expect(events.some((e) => e.type === "RAMP_UP_MILESTONE")).toBe(false);
  });
});

// ---------------- Deviation ending ----------------

describe("evaluateTriggers — DEVIATION_ENDING", () => {
  it("fires once per entry in endedDeviations", () => {
    const events = evaluateTriggers({
      policy: null,
      current: makeEscalationState(),
      previous: makeEscalationState(),
      endedDeviations: [
        { id: "dev-1", domain: "martial-arts" },
        { id: "dev-2", domain: "music" },
      ],
      settings: makeSettings(true, "ADVISORY"),
    });
    const ending = events.filter((e) => e.type === "DEVIATION_ENDING");
    expect(ending).toHaveLength(2);
    expect(ending.map((e) => (e.type === "DEVIATION_ENDING" ? e.deviationId : null)).sort()).toEqual([
      "dev-1",
      "dev-2",
    ]);
  });

  it("does NOT fire when endedDeviations is empty or omitted", () => {
    const events = evaluateTriggers({
      policy: null,
      current: makeEscalationState(),
      previous: makeEscalationState(),
      settings: makeSettings(true, "ADVISORY"),
    });
    expect(events.some((e) => e.type === "DEVIATION_ENDING")).toBe(false);
  });
});
