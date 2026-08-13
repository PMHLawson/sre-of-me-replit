/**
 * SOMR-327 — Deterministic tests for server-authoritative logical-day window
 * semantics used by Domain Detail chart buckets, selected-range totals, and
 * the fixed Current/Previous 7-day summary windows.
 *
 * Fixed "now": 2026-08-12T12:00:00Z = 08:00 EDT (America/New_York, UTC-4 in Aug).
 * 08:00 > 04:00 (dayStartHour) → logical day for "now" is 2026-08-12.
 *
 * Expected completed windows (excludeToday=true, default):
 *   w7    = 2026-08-05 .. 2026-08-11   (7 days)
 *   w14   = 2026-07-29 .. 2026-08-11  (14 days)
 *   prev7 = 2026-07-29 .. 2026-08-04   (7 days — first half of w14)
 *   w28   = 2026-07-15 .. 2026-08-11  (28 days)
 *   w42   = 2026-07-01 .. 2026-08-11  (42 days)
 */

import { describe, it, expect } from "vitest";
import type { Domain, Session } from "@shared/schema";
import {
  completedWindowDays,
  logicalDay,
  logicalDayStartUtc,
  filterSessionsInWindow,
  actualMinutes,
  type PolicyEngineOptions,
} from "./policy-engine";

const NOW = new Date("2026-08-12T12:00:00Z");

// Explicit New York options so tests don't rely on the compiled-in defaults.
const NY_OPTS: PolicyEngineOptions = {
  now:          NOW,
  timezone:     "America/New_York",
  dayStartHour: 4,
};

let seq = 0;

/**
 * Build a minimal Session whose logical day equals `dayKey` (YYYY-MM-DD).
 * The timestamp is noon UTC on that date; noon UTC = 08:00 EDT which is
 * safely past the 04:00 dayStartHour, so logical-day assignment is
 * unambiguous regardless of DST.
 */
function makeSession(domain: Domain, dayKey: string, minutes: number): Session {
  return {
    id:              `s-${++seq}`,
    userId:          "u",
    domain,
    durationMinutes: minutes,
    timestamp:       new Date(`${dayKey}T12:00:00Z`),
    notes:           null,
  };
}

// ── Range boundaries ──────────────────────────────────────────────────────────

describe("completedWindowDays — all four chart ranges", () => {
  it("7-day range returns exactly 7 completed logical-day keys", () => {
    const days = completedWindowDays({ ...NY_OPTS, windowDays: 7 });
    expect(days).toHaveLength(7);
    expect(days[0]).toBe("2026-08-05"); // today (Aug 12) − 7 = Aug 5
    expect(days[6]).toBe("2026-08-11"); // yesterday
  });

  it("14-day range returns exactly 14 completed logical-day keys", () => {
    const days = completedWindowDays({ ...NY_OPTS, windowDays: 14 });
    expect(days).toHaveLength(14);
    expect(days[0]).toBe("2026-07-29"); // Aug 12 − 14 = Jul 29
    expect(days[13]).toBe("2026-08-11");
  });

  it("28-day range returns exactly 28 completed logical-day keys", () => {
    const days = completedWindowDays({ ...NY_OPTS, windowDays: 28 });
    expect(days).toHaveLength(28);
    expect(days[0]).toBe("2026-07-15"); // Aug 12 − 28 = Jul 15
    expect(days[27]).toBe("2026-08-11");
  });

  it("42-day range returns exactly 42 completed logical-day keys", () => {
    const days = completedWindowDays({ ...NY_OPTS, windowDays: 42 });
    expect(days).toHaveLength(42);
    expect(days[0]).toBe("2026-07-01"); // Aug 12 − 42 = Jul 1
    expect(days[41]).toBe("2026-08-11");
  });

  it("keys are ordered oldest → newest with no duplicates", () => {
    for (const wd of [7, 14, 28, 42]) {
      const days = completedWindowDays({ ...NY_OPTS, windowDays: wd });
      for (let i = 1; i < days.length; i++) {
        expect(days[i] > days[i - 1]).toBe(true);
      }
      expect(new Set(days).size).toBe(wd);
    }
  });
});

// ── Current-day exclusion ─────────────────────────────────────────────────────

describe("current-day exclusion", () => {
  it("today's logical day does not appear in any window", () => {
    const todayKey = logicalDay(NOW, NY_OPTS);
    expect(todayKey).toBe("2026-08-12");
    for (const wd of [7, 14, 28, 42]) {
      const days = completedWindowDays({ ...NY_OPTS, windowDays: wd });
      expect(days).not.toContain(todayKey);
    }
  });

  it("the most-recent completed day is always yesterday for all ranges", () => {
    for (const wd of [7, 14, 28, 42]) {
      const days = completedWindowDays({ ...NY_OPTS, windowDays: wd });
      expect(days[days.length - 1]).toBe("2026-08-11");
    }
  });
});

// ── Logical-day boundary at 03:59 / 04:00 EDT ─────────────────────────────────

describe("logicalDay — 03:59 / 04:00 EDT boundary (America/New_York, dayStartHour=4)", () => {
  // In August, New York is EDT = UTC-4.
  // 04:00 EDT = 08:00 UTC  |  03:59 EDT = 07:59 UTC

  it("session at 03:59 EDT is assigned to the PREVIOUS calendar day", () => {
    const ts = new Date("2026-08-12T07:59:00Z"); // 03:59 EDT on Aug 12
    const day = logicalDay(ts, { timezone: "America/New_York", dayStartHour: 4 });
    expect(day).toBe("2026-08-11");
  });

  it("session at 04:00 EDT is assigned to the CURRENT calendar day", () => {
    const ts = new Date("2026-08-12T08:00:00Z"); // 04:00 EDT on Aug 12
    const day = logicalDay(ts, { timezone: "America/New_York", dayStartHour: 4 });
    expect(day).toBe("2026-08-12");
  });

  it("session at 03:59 is NOT included in any completed window even as prev-day when prev-day is today", () => {
    // This edge: if "now" is just after midnight but before dayStartHour,
    // the logical day is still yesterday, so the completed window still
    // excludes that (now-logical) day.
    const earlyNow = new Date("2026-08-12T07:00:00Z"); // 03:00 EDT → logical day = Aug 11
    const todayKey = logicalDay(earlyNow, { timezone: "America/New_York", dayStartHour: 4 });
    expect(todayKey).toBe("2026-08-11"); // logical today is Aug 11
    const days = completedWindowDays({
      now: earlyNow,
      timezone: "America/New_York",
      dayStartHour: 4,
      windowDays: 7,
    });
    expect(days).not.toContain("2026-08-11"); // logical today excluded
    expect(days[days.length - 1]).toBe("2026-08-10"); // most-recent completed = Aug 10
  });
});

// ── Adjacent fixed 7-day windows — no gap, no overlap ────────────────────────

describe("adjacent fixed 7-day windows (current + previous)", () => {
  it("prev7 and w7 share no days", () => {
    const w14  = completedWindowDays({ ...NY_OPTS, windowDays: 14 });
    const w7   = completedWindowDays({ ...NY_OPTS, windowDays: 7 });
    const prev7 = w14.slice(0, 7);
    const w7Set    = new Set(w7);
    const prev7Set = new Set(prev7);
    for (const d of prev7) expect(w7Set.has(d)).toBe(false);
    for (const d of w7)    expect(prev7Set.has(d)).toBe(false);
  });

  it("newest of prev7 is immediately before oldest of w7 (contiguous, no gap)", () => {
    const w14  = completedWindowDays({ ...NY_OPTS, windowDays: 14 });
    const w7   = completedWindowDays({ ...NY_OPTS, windowDays: 7 });
    const prev7 = w14.slice(0, 7);
    expect(prev7[6]).toBe("2026-08-04"); // last of prev7
    expect(w7[0]).toBe("2026-08-05");    // first of w7  → consecutive days
    const gap = (new Date(w7[0]).getTime() - new Date(prev7[6]).getTime())
                / (24 * 60 * 60 * 1000);
    expect(gap).toBe(1);
  });

  it("w7 + prev7 together cover exactly the same 14 days as w14", () => {
    const w14  = completedWindowDays({ ...NY_OPTS, windowDays: 14 });
    const w7   = completedWindowDays({ ...NY_OPTS, windowDays: 7 });
    const prev7 = w14.slice(0, 7);
    const combined = new Set([...w7, ...prev7]);
    expect(combined.size).toBe(14);
    for (const d of w14) expect(combined.has(d)).toBe(true);
  });
});

// ── Multiple sessions per day ─────────────────────────────────────────────────

describe("multiple sessions on the same logical day", () => {
  it("sums all session durations for that day", () => {
    const w7 = completedWindowDays({ ...NY_OPTS, windowDays: 7 });
    // Two sessions on Aug 8 (inside w7: Aug 5–11)
    const sessions = [
      makeSession("martial-arts", "2026-08-08", 30),
      makeSession("martial-arts", "2026-08-08", 45),
    ];
    const inWindow = filterSessionsInWindow(sessions, w7, NY_OPTS);
    expect(inWindow).toHaveLength(2);
    expect(actualMinutes(inWindow)).toBe(75);
  });

  it("sessions from different days are bucketed independently", () => {
    const w7 = completedWindowDays({ ...NY_OPTS, windowDays: 7 });
    const sessions = [
      makeSession("martial-arts", "2026-08-07", 20),
      makeSession("martial-arts", "2026-08-08", 30),
      makeSession("martial-arts", "2026-08-09", 10),
    ];
    const inWindow = filterSessionsInWindow(sessions, w7, NY_OPTS);
    expect(inWindow).toHaveLength(3);
    expect(actualMinutes(inWindow)).toBe(60);
  });

  it("sessions outside the window are excluded", () => {
    const w7 = completedWindowDays({ ...NY_OPTS, windowDays: 7 }); // Aug 5–11
    const sessions = [
      makeSession("martial-arts", "2026-08-10", 30), // inside w7
      makeSession("martial-arts", "2026-08-12", 25), // today — excluded
      makeSession("martial-arts", "2026-08-04", 20), // day before w7 starts
    ];
    const inWindow = filterSessionsInWindow(sessions, w7, NY_OPTS);
    expect(inWindow).toHaveLength(1);
    expect(actualMinutes(inWindow)).toBe(30);
  });
});

// ── Below-floor minutes included in duration totals ───────────────────────────

describe("below-floor minutes included in duration totals", () => {
  // Policy: martial-arts sessionFloor = 15m. Below-floor sessions count toward
  // actual_minutes (duration SLO input) but NOT toward qualifying days.
  // SOMR-327 requires below-floor minutes are kept in duration totals.

  it("session below sessionFloor still contributes to actual_minutes", () => {
    const w7 = completedWindowDays({ ...NY_OPTS, windowDays: 7 });
    const belowFloor = makeSession("martial-arts", "2026-08-10",  8); // < 15m floor
    const aboveFloor = makeSession("martial-arts", "2026-08-11", 20); // ≥ 15m floor
    const inWindow = filterSessionsInWindow([belowFloor, aboveFloor], w7, NY_OPTS);
    expect(inWindow).toHaveLength(2);
    // 8 + 20 = 28; below-floor session is NOT stripped from the total
    expect(actualMinutes(inWindow)).toBe(28);
  });

  it("two below-floor sessions on the same day both count toward minutes", () => {
    const w7 = completedWindowDays({ ...NY_OPTS, windowDays: 7 });
    const s1 = makeSession("martial-arts", "2026-08-09",  5);
    const s2 = makeSession("martial-arts", "2026-08-09", 10);
    const inWindow = filterSessionsInWindow([s1, s2], w7, NY_OPTS);
    expect(actualMinutes(inWindow)).toBe(15); // 5 + 10, not 0
  });
});

// ── Range-total reconciliation ────────────────────────────────────────────────

describe("range-total reconciliation", () => {
  it("current7 + prev7 == combined14, with no overlap or gap", () => {
    const domain: Domain = "martial-arts";
    const sessions = [
      makeSession(domain, "2026-08-05", 30), // w7 day 1
      makeSession(domain, "2026-08-08", 45), // w7 day 4
      makeSession(domain, "2026-08-11", 20), // w7 day 7 (yesterday)
      makeSession(domain, "2026-07-29", 15), // prev7 day 1
      makeSession(domain, "2026-08-03", 10), // prev7 day 6
    ];

    const w7   = completedWindowDays({ ...NY_OPTS, windowDays: 7  });
    const w14  = completedWindowDays({ ...NY_OPTS, windowDays: 14 });
    const prev7 = w14.slice(0, 7);

    const current7  = actualMinutes(filterSessionsInWindow(sessions, w7,    NY_OPTS));
    const previous7 = actualMinutes(filterSessionsInWindow(sessions, prev7,  NY_OPTS));
    const combined  = actualMinutes(filterSessionsInWindow(sessions, w14,   NY_OPTS));

    expect(current7).toBe(95);           // 30 + 45 + 20
    expect(previous7).toBe(25);          // 15 + 10
    expect(current7 + previous7).toBe(combined); // no overlap, no gap
  });

  it("28-day total equals sum of four consecutive 7-day windows", () => {
    const domain: Domain = "meditation";
    // One session per week, each exactly 7 days apart
    const sessions = [
      makeSession(domain, "2026-07-15", 40), // week 1 (oldest)
      makeSession(domain, "2026-07-22", 50), // week 2
      makeSession(domain, "2026-07-29", 60), // week 3 (= prev7)
      makeSession(domain, "2026-08-05", 70), // week 4 (= w7)
    ];

    const w28 = completedWindowDays({ ...NY_OPTS, windowDays: 28 });
    const total28 = actualMinutes(filterSessionsInWindow(sessions, w28, NY_OPTS));
    expect(total28).toBe(220); // 40 + 50 + 60 + 70

    // Also confirm w7 alone picks up only week 4
    const w7 = completedWindowDays({ ...NY_OPTS, windowDays: 7 });
    expect(actualMinutes(filterSessionsInWindow(sessions, w7, NY_OPTS))).toBe(70);
  });

  it("42-day window total includes all sessions in the 42-day range", () => {
    const domain: Domain = "fitness";
    const sessions = [
      makeSession(domain, "2026-07-01", 30), // first day of w42
      makeSession(domain, "2026-07-15", 20), // mid-range
      makeSession(domain, "2026-08-11", 25), // last day of w42 (yesterday)
      makeSession(domain, "2026-06-30", 99), // before w42 — excluded
      makeSession(domain, "2026-08-12", 88), // today — excluded
    ];
    const w42 = completedWindowDays({ ...NY_OPTS, windowDays: 42 });
    const total = actualMinutes(filterSessionsInWindow(sessions, w42, NY_OPTS));
    expect(total).toBe(75); // 30 + 20 + 25; the 99 and 88 are excluded
  });
});

// ── DST-correct logical-day boundaries (SOMR-327 correction) ─────────────────
//
// Validates logicalDayStartUtc for spring-forward (23-hour day) and fall-back
// (25-hour day) transitions in America/New_York so the deviation-overlap test
// below has authoritative millisecond values to check against.

describe("logicalDayStartUtc — DST-transition boundaries (America/New_York, dayStartHour=4)", () => {
  const opts = { timezone: "America/New_York", dayStartHour: 4 } as PolicyEngineOptions;

  // ── Spring-forward: 2026-03-08, clocks jump 02:00 EST → 03:00 EDT ──────────
  it("2026-03-07 (day before spring-forward) starts at 09:00 UTC (4am EST)", () => {
    const start = logicalDayStartUtc("2026-03-07", opts);
    expect(start.toISOString()).toBe("2026-03-07T09:00:00.000Z");
  });

  it("2026-03-08 (spring-forward day) starts at 08:00 UTC (4am EDT)", () => {
    // EST = UTC-5 → 4+5 = 09:00 UTC before DST; EDT = UTC-4 → 4+4 = 08:00 UTC after.
    const start = logicalDayStartUtc("2026-03-08", opts);
    expect(start.toISOString()).toBe("2026-03-08T08:00:00.000Z");
  });

  it("spring-forward: logical day 2026-03-07 is exactly 23 hours long", () => {
    const dayStart = logicalDayStartUtc("2026-03-07", opts).getTime();
    const dayEnd   = logicalDayStartUtc("2026-03-08", opts).getTime();
    expect(dayEnd - dayStart).toBe(23 * 3_600_000);
  });

  // ── Fall-back: 2026-11-01, clocks fall 02:00 EDT → 01:00 EST ───────────────
  it("2026-10-31 (day before fall-back) starts at 08:00 UTC (4am EDT)", () => {
    const start = logicalDayStartUtc("2026-10-31", opts);
    expect(start.toISOString()).toBe("2026-10-31T08:00:00.000Z");
  });

  it("2026-11-01 (fall-back day) starts at 09:00 UTC (4am EST)", () => {
    // Fall-back happens at 2am; dayStart is 4am which is after the transition → EST.
    const start = logicalDayStartUtc("2026-11-01", opts);
    expect(start.toISOString()).toBe("2026-11-01T09:00:00.000Z");
  });

  it("fall-back: logical day 2026-10-31 is exactly 25 hours long", () => {
    const dayStart = logicalDayStartUtc("2026-10-31", opts).getTime();
    const dayEnd   = logicalDayStartUtc("2026-11-01", opts).getTime();
    expect(dayEnd - dayStart).toBe(25 * 3_600_000);
  });
});

// ── Deviation overlap correctness at DST boundaries ──────────────────────────
//
// These tests demonstrate that using `logicalDayStartUtc(nextDayKey)` as the
// end of a logical day gives the correct deviation-overlap answer, whereas the
// naive `dayStartMs + 24 * 3_600_000` approach gives the wrong answer on
// spring-forward and fall-back days.

describe("deviation overlap at DST-transition boundaries", () => {
  const opts = { timezone: "America/New_York", dayStartHour: 4 } as PolicyEngineOptions;
  const overlaps = (devStart: number, devEnd: number, dayStart: number, dayEnd: number) =>
    devStart < dayEnd && devEnd > dayStart;

  it("spring-forward: deviation entirely within the 08:00–08:30 UTC gap overlaps only 2026-03-08", () => {
    // "2026-03-07" ends at 08:00 UTC Mar 8 (23-hour day); "2026-03-08" starts at 08:00 UTC Mar 8.
    // A deviation from 08:10–08:30 UTC Mar 8 sits entirely in "2026-03-08".
    const day07Start = logicalDayStartUtc("2026-03-07", opts).getTime(); // 09:00 UTC Mar 7
    const day07End   = logicalDayStartUtc("2026-03-08", opts).getTime(); // 08:00 UTC Mar 8
    const day08Start = logicalDayStartUtc("2026-03-08", opts).getTime(); // 08:00 UTC Mar 8
    const day08End   = logicalDayStartUtc("2026-03-09", opts).getTime(); // 08:00 UTC Mar 9

    const devStart = new Date("2026-03-08T08:10:00Z").getTime();
    const devEnd   = new Date("2026-03-08T08:30:00Z").getTime();

    expect(overlaps(devStart, devEnd, day07Start, day07End)).toBe(false); // correct: not in Mar 7
    expect(overlaps(devStart, devEnd, day08Start, day08End)).toBe(true);  // correct: is in Mar 8

    // Wrong approach: dayEnd for "2026-03-07" = dayStart + 24 h = 09:00 UTC Mar 8
    // That extra hour would erroneously absorb the deviation into "2026-03-07".
    const wrongDay07End = day07Start + 24 * 3_600_000; // 09:00 UTC Mar 8 — WRONG
    expect(overlaps(devStart, devEnd, day07Start, wrongDay07End)).toBe(true); // proves the bug
  });

  it("fall-back: deviation in 08:30–09:30 UTC Nov 1 straddles boundary → overlaps both days", () => {
    // "2026-10-31" ends at 09:00 UTC Nov 1 (25-hour day); "2026-11-01" starts at 09:00 UTC Nov 1.
    // A deviation from 08:30–09:30 UTC Nov 1 overlaps the tail of Oct 31 AND the head of Nov 1.
    const day31Start = logicalDayStartUtc("2026-10-31", opts).getTime(); // 08:00 UTC Oct 31
    const day31End   = logicalDayStartUtc("2026-11-01", opts).getTime(); // 09:00 UTC Nov 1
    const day01Start = logicalDayStartUtc("2026-11-01", opts).getTime(); // 09:00 UTC Nov 1
    const day01End   = logicalDayStartUtc("2026-11-02", opts).getTime(); // 09:00 UTC Nov 2

    const devStart = new Date("2026-11-01T08:30:00Z").getTime();
    const devEnd   = new Date("2026-11-01T09:30:00Z").getTime();

    expect(overlaps(devStart, devEnd, day31Start, day31End)).toBe(true);  // correct: tail of Oct 31
    expect(overlaps(devStart, devEnd, day01Start, day01End)).toBe(true);  // correct: head of Nov 1

    // Wrong approach: dayEnd for "2026-10-31" = dayStart + 24 h = 08:00 UTC Nov 1
    // That truncated end misses the 08:30 deviation entirely.
    const wrongDay31End = day31Start + 24 * 3_600_000; // 08:00 UTC Nov 1 — WRONG
    expect(overlaps(devStart, devEnd, day31Start, wrongDay31End)).toBe(false); // proves the bug
  });
});
