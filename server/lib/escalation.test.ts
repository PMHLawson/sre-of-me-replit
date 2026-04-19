import { describe, it, expect } from "vitest";
import type { Session, Domain } from "@shared/schema";
import {
  classifyTier,
  computeErrorBudget,
  consecutiveLowDays,
  computeDomainEscalation,
  type EscalationTier,
} from "./escalation";
import {
  DOMAIN_POLICY,
  computeServiceState,
  type ServiceState,
  type ComplianceColor,
  type PolicyEngineOptions,
} from "./policy-engine";

/**
 * Fixed "now" for all tests below. 12:00 UTC = 08:00 America/New_York,
 * which is comfortably past the 04:00 dayStartHour boundary, so the logical
 * day for `now` is the calendar date 2026-04-15.
 *
 * With default options (windowDays=7, excludeToday=true) this gives:
 *   today      = 2026-04-15
 *   window     = 2026-04-08 .. 2026-04-14   (oldest -> newest)
 *   day index    1            2            3            4            5            6            7
 */
const NOW = new Date("2026-04-15T12:00:00Z");
const WINDOW_DAYS = [
  "2026-04-08",
  "2026-04-09",
  "2026-04-10",
  "2026-04-11",
  "2026-04-12",
  "2026-04-13",
  "2026-04-14",
];
const OPTS: PolicyEngineOptions = { now: NOW };

let seq = 0;
function makeSession(domain: Domain, day: string, minutes: number): Session {
  return {
    id: `s-${++seq}`,
    userId: "u",
    domain,
    durationMinutes: minutes,
    // Noon UTC = 08:00 NY, after the 04:00 dayStart boundary, so the logical
    // day equals the calendar date provided.
    timestamp: new Date(`${day}T12:00:00Z`),
    notes: null,
  };
}

/**
 * Build a minimal ServiceState shaped just enough for the unit-under-test.
 * Only `policy.targetMinutes`, `actual_minutes`, and `compliance_color` are
 * read by classifyTier / computeErrorBudget.
 */
function fakeServiceState(
  color: ComplianceColor,
  actualMinutes: number,
  targetMinutes = 100
): ServiceState {
  return {
    domain: "martial-arts",
    logical_day: "2026-04-15",
    actual_qualifying_days: 0,
    actual_minutes: actualMinutes,
    session_score: 0,
    duration_score: 0,
    service_score: 0,
    service_weight: 0.25,
    compliance_color: color,
    policy: {
      targetMinutes,
      sessionFloor: 15,
      sessionsTarget: 5,
      cadence: "Daily",
      dailyProRate: 15,
    },
    window_days: WINDOW_DAYS,
  };
}

describe("classifyTier — full (color × consecutive low days) matrix", () => {
  // Each row pins down one cell of the tier matrix. These are the boundary
  // conditions that downstream UI ("Cultivation = P1, decline P2/P3") relies
  // on; refactors that shift any cell should fail loudly here.
  const cases: Array<{ color: ComplianceColor; low: number; tier: EscalationTier }> = [
    // RED: BREACH at <3 trailing low days, PAGE at >=3.
    { color: "red", low: 0, tier: "BREACH" },
    { color: "red", low: 1, tier: "BREACH" },
    { color: "red", low: 2, tier: "BREACH" },
    { color: "red", low: 3, tier: "PAGE" },
    { color: "red", low: 7, tier: "PAGE" },
    // YELLOW: ADVISORY at <2 trailing low days, WARNING at >=2.
    { color: "yellow", low: 0, tier: "ADVISORY" },
    { color: "yellow", low: 1, tier: "ADVISORY" },
    { color: "yellow", low: 2, tier: "WARNING" },
    { color: "yellow", low: 5, tier: "WARNING" },
    // GREEN: NOMINAL until the trailing-low-days fence at 3, then ADVISORY.
    { color: "green", low: 0, tier: "NOMINAL" },
    { color: "green", low: 1, tier: "NOMINAL" },
    { color: "green", low: 2, tier: "NOMINAL" },
    { color: "green", low: 3, tier: "ADVISORY" },
    { color: "green", low: 6, tier: "ADVISORY" },
  ];

  for (const c of cases) {
    it(`color=${c.color}, consecutiveLowDays=${c.low} -> ${c.tier}`, () => {
      const svc = fakeServiceState(c.color, /*actualMinutes*/ 0);
      expect(classifyTier(svc, c.low)).toBe(c.tier);
    });
  }
});

describe("computeErrorBudget — math at 0% / 50% / 100% remaining", () => {
  it("100% remaining: actual >= target, no consumption", () => {
    // target=100 -> allowed = round(100*0.6) = 60
    const svc = fakeServiceState("green", /*actual*/ 100, /*target*/ 100);
    const b = computeErrorBudget(svc);
    expect(b.allowedMinutes).toBe(60);
    expect(b.consumedMinutes).toBe(0);
    expect(b.remainingMinutes).toBe(60);
    expect(b.percentRemaining).toBe(100);
  });

  it("100% remaining is clamped even when actual exceeds target", () => {
    const svc = fakeServiceState("green", /*actual*/ 250, /*target*/ 100);
    const b = computeErrorBudget(svc);
    // consumed = max(0, 100-250) = 0; remaining still pinned at allowed
    expect(b.consumedMinutes).toBe(0);
    expect(b.remainingMinutes).toBe(60);
    expect(b.percentRemaining).toBe(100);
  });

  it("50% remaining: half the allowed deficit consumed", () => {
    // target=100, allowed=60, half-consumed = 30 -> actual = 100-30 = 70
    const svc = fakeServiceState("yellow", /*actual*/ 70, /*target*/ 100);
    const b = computeErrorBudget(svc);
    expect(b.allowedMinutes).toBe(60);
    expect(b.consumedMinutes).toBe(30);
    expect(b.remainingMinutes).toBe(30);
    expect(b.percentRemaining).toBe(50);
  });

  it("0% remaining: deficit equals the allowed budget exactly", () => {
    // target=100, allowed=60, fully-consumed = 60 -> actual = 40
    const svc = fakeServiceState("red", /*actual*/ 40, /*target*/ 100);
    const b = computeErrorBudget(svc);
    expect(b.consumedMinutes).toBe(60);
    expect(b.remainingMinutes).toBe(0);
    expect(b.percentRemaining).toBe(0);
  });

  it("0% remaining is clamped to non-negative percent when budget is overshot", () => {
    // actual=0 -> consumed=100, remaining=-40, percent clamped to 0
    const svc = fakeServiceState("red", /*actual*/ 0, /*target*/ 100);
    const b = computeErrorBudget(svc);
    expect(b.consumedMinutes).toBe(100);
    expect(b.remainingMinutes).toBe(-40);
    expect(b.percentRemaining).toBe(0);
  });
});

describe("consecutiveLowDays — trailing inactive days within the window", () => {
  it("returns full window length when there are no qualifying sessions", () => {
    const n = consecutiveLowDays<Session>([], WINDOW_DAYS, 15, OPTS);
    expect(n).toBe(7);
  });

  it("returns 0 when the most recent window day has a qualifying session", () => {
    const sessions = [makeSession("martial-arts", "2026-04-14", 30)];
    const n = consecutiveLowDays(sessions, WINDOW_DAYS, 15, OPTS);
    expect(n).toBe(0);
  });

  it("counts only trailing low days (gaps in the middle don't count)", () => {
    const sessions = [
      makeSession("martial-arts", "2026-04-08", 30), // qualifies
      makeSession("martial-arts", "2026-04-12", 30), // qualifies
      // 2026-04-13, 2026-04-14 = no qualifying session -> 2 trailing low days
    ];
    const n = consecutiveLowDays(sessions, WINDOW_DAYS, 15, OPTS);
    expect(n).toBe(2);
  });

  it("below-floor sessions don't make a day qualify", () => {
    const sessions = [
      makeSession("martial-arts", "2026-04-14", 10), // below sessionFloor=15
    ];
    const n = consecutiveLowDays(sessions, WINDOW_DAYS, 15, OPTS);
    expect(n).toBe(7);
  });
});

describe("computeServiceState — burn rate inputs for a known window", () => {
  // Burn rate = (actual_minutes / window.length) / dailyProRate, rounded to 2dp.
  // For martial-arts: dailyProRate=15, window.length=7.
  it("burn rate is exactly 1.0 when actual = dailyProRate * windowDays", () => {
    // 7 days x 15min = 105 minutes -> 105/7/15 = 1.00
    const sessions = WINDOW_DAYS.map((d) => makeSession("martial-arts", d, 15));
    const esc = computeDomainEscalation("martial-arts", sessions, OPTS);
    expect(esc.burnRate).toBe(1);
  });

  it("burn rate is below 1.0 when the window is under target", () => {
    // 1 session x 30 minutes -> 30/7/15 = 0.2857... -> rounded to 0.29
    const sessions = [makeSession("martial-arts", "2026-04-10", 30)];
    const esc = computeDomainEscalation("martial-arts", sessions, OPTS);
    expect(esc.burnRate).toBe(0.29);
  });
});

describe("computeDomainEscalation — boundary scenarios called out in the spec", () => {
  // Sanity: the policy we model against. If these change, several cases below
  // need re-derivation (we keep the math explicit in the comments).
  it("uses the expected martial-arts policy", () => {
    expect(DOMAIN_POLICY["martial-arts"]).toMatchObject({
      targetMinutes: 105,
      sessionFloor: 15,
      sessionsTarget: 5,
      dailyProRate: 15,
    });
  });

  it("red + 2 trailing low days -> BREACH", () => {
    // Single 30-min session on day 5 (2026-04-12): qualifies (1 day),
    // total minutes = 30. session=20, duration=29 -> svc=25 -> red.
    // Trailing low days: 2026-04-13 + 2026-04-14 -> 2.
    const sessions = [makeSession("martial-arts", "2026-04-12", 30)];
    const svc = computeServiceState("martial-arts", sessions, OPTS);
    expect(svc.compliance_color).toBe("red");

    const esc = computeDomainEscalation("martial-arts", sessions, OPTS);
    expect(esc.consecutiveLowDays).toBe(2);
    expect(esc.tier).toBe("BREACH");
  });

  it("red + 3 trailing low days -> PAGE", () => {
    // Single 30-min session on day 4 (2026-04-11). Same red color as above
    // but trailing low days = 3 (2026-04-12..14).
    const sessions = [makeSession("martial-arts", "2026-04-11", 30)];
    const svc = computeServiceState("martial-arts", sessions, OPTS);
    expect(svc.compliance_color).toBe("red");

    const esc = computeDomainEscalation("martial-arts", sessions, OPTS);
    expect(esc.consecutiveLowDays).toBe(3);
    expect(esc.tier).toBe("PAGE");
  });

  it("yellow + 2 trailing low days -> WARNING", () => {
    // 3 qualifying days x 15 min on days 3-5 (2026-04-10..12).
    // qDays=3 -> session=60. minutes=45 -> duration=43. svc=round(51.5)=52 -> yellow.
    // Trailing low days: 2026-04-13 + 2026-04-14 -> 2.
    const sessions = [
      makeSession("martial-arts", "2026-04-10", 15),
      makeSession("martial-arts", "2026-04-11", 15),
      makeSession("martial-arts", "2026-04-12", 15),
    ];
    const svc = computeServiceState("martial-arts", sessions, OPTS);
    expect(svc.compliance_color).toBe("yellow");

    const esc = computeDomainEscalation("martial-arts", sessions, OPTS);
    expect(esc.consecutiveLowDays).toBe(2);
    expect(esc.tier).toBe("WARNING");
  });

  it("yellow + 0 trailing low days -> ADVISORY", () => {
    // 3 qualifying days x 15min on the trailing days 5-7 (no trailing gap).
    const sessions = [
      makeSession("martial-arts", "2026-04-12", 15),
      makeSession("martial-arts", "2026-04-13", 15),
      makeSession("martial-arts", "2026-04-14", 15),
    ];
    const svc = computeServiceState("martial-arts", sessions, OPTS);
    expect(svc.compliance_color).toBe("yellow");

    const esc = computeDomainEscalation("martial-arts", sessions, OPTS);
    expect(esc.consecutiveLowDays).toBe(0);
    expect(esc.tier).toBe("ADVISORY");
  });

  it("green + 0 trailing low days -> NOMINAL", () => {
    // 5 qualifying days x 15min on days 3-7 (2026-04-10..14).
    // session=100, duration=71, svc=86 -> green. trailing low=0.
    const sessions = [
      makeSession("martial-arts", "2026-04-10", 15),
      makeSession("martial-arts", "2026-04-11", 15),
      makeSession("martial-arts", "2026-04-12", 15),
      makeSession("martial-arts", "2026-04-13", 15),
      makeSession("martial-arts", "2026-04-14", 15),
    ];
    const svc = computeServiceState("martial-arts", sessions, OPTS);
    expect(svc.compliance_color).toBe("green");

    const esc = computeDomainEscalation("martial-arts", sessions, OPTS);
    expect(esc.consecutiveLowDays).toBe(0);
    expect(esc.tier).toBe("NOMINAL");
  });

  it("green + 3 trailing low days -> ADVISORY (the green+inactivity escape hatch)", () => {
    // 4 qualifying days x 25min on days 1-4 (2026-04-08..11).
    // qDays=4 -> session=80. minutes=100 -> duration=95. svc=round(87.5)=88 -> green.
    // Trailing low days: 2026-04-12..14 -> 3.
    const sessions = [
      makeSession("martial-arts", "2026-04-08", 25),
      makeSession("martial-arts", "2026-04-09", 25),
      makeSession("martial-arts", "2026-04-10", 25),
      makeSession("martial-arts", "2026-04-11", 25),
    ];
    const svc = computeServiceState("martial-arts", sessions, OPTS);
    expect(svc.compliance_color).toBe("green");

    const esc = computeDomainEscalation("martial-arts", sessions, OPTS);
    expect(esc.consecutiveLowDays).toBe(3);
    expect(esc.tier).toBe("ADVISORY");
  });
});
