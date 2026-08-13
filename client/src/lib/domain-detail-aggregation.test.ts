/**
 * Direct deterministic tests for Domain Detail aggregation behavior.
 *
 * Tests operate on the pure functions in domain-detail-aggregation.ts,
 * which contain all chart-bucketing and window-sum logic extracted from the
 * domain-detail.tsx component.  No React component mounting required.
 *
 * Covered behaviors (per SOMR-327 review findings):
 *   (a) One chart entry per authoritative key
 *   (b) Domain filtering via sessionDays Set membership
 *   (c) Selected-range totals via chart slice
 *   (d) Fixed current and previous 7-day sums (sumWindowMinutes)
 *   (e) Missing optional response data (graceful null/empty handling)
 *   (f) Authoritative deviation-day rendering (deviationActiveDays Set)
 *   (g) Display labels — pure algorithmic / timezone-independent (Tomohiko Sakamoto weekday)
 *   (h) HISTORY_RANGE_OPTIONS contains all four 7/14/28/42 values
 */

import { describe, it, expect } from "vitest";
import { buildChartData, buildTodayDatum, sumWindowMinutes, sumTodayMinutes, type DomainSession } from "./domain-detail-aggregation";

// ── Fixtures ──────────────────────────────────────────────────────────────────

// Seven days matching the w7 window from activity-windows.test.ts fixed NOW.
const W7_KEYS = [
  "2026-08-05",
  "2026-08-06",
  "2026-08-07",
  "2026-08-08",
  "2026-08-09",
  "2026-08-10",
  "2026-08-11",
];

// Seven days matching prev7 (immediately before w7).
const PREV7_KEYS = [
  "2026-07-29",
  "2026-07-30",
  "2026-07-31",
  "2026-08-01",
  "2026-08-02",
  "2026-08-03",
  "2026-08-04",
];

// Fourteen days = w14 (prev7 + w7, oldest→newest).
const W14_KEYS = [...PREV7_KEYS, ...W7_KEYS];

// A minimal 14-entry "w42" for tests that only need two tier groups.
const MINI_W42 = W14_KEYS;

const W7_SET    = new Set(W7_KEYS);
const PREV7_SET = new Set(PREV7_KEYS);

// Sessions: one martial-arts session per day for five of the fourteen days.
const SESSIONS: DomainSession[] = [
  { id: "s1", durationMinutes: 30, isAnomaly: false },  // w7
  { id: "s2", durationMinutes: 45, isAnomaly: true  },  // w7 — anomalous
  { id: "s3", durationMinutes: 20, isAnomaly: false },  // w7
  { id: "s4", durationMinutes: 15, isAnomaly: false },  // prev7
  { id: "s5", durationMinutes: 10, isAnomaly: false },  // prev7
];

const SESSION_DAYS: Record<string, string> = {
  s1: "2026-08-06",  // w7 day 2
  s2: "2026-08-08",  // w7 day 4
  s3: "2026-08-11",  // w7 day 7 (yesterday)
  s4: "2026-07-30",  // prev7 day 2
  s5: "2026-08-03",  // prev7 day 6
};

// ── (a) One chart entry per authoritative key ─────────────────────────────────

describe("buildChartData — one entry per authoritative key", () => {
  it("returns exactly as many entries as w42 keys, in order", () => {
    const data = buildChartData(
      MINI_W42,
      SESSION_DAYS,
      SESSIONS,
      new Set(),
      W7_SET,
      PREV7_SET,
    );
    expect(data).toHaveLength(MINI_W42.length);
    expect(data.map((d) => d.dateKey)).toEqual(MINI_W42);
  });

  it("returns an empty array when w42 is empty", () => {
    const data = buildChartData([], SESSION_DAYS, SESSIONS, new Set(), W7_SET, PREV7_SET);
    expect(data).toHaveLength(0);
  });

  it("assigns tier=current to w7 days, tier=previous to prev7 days, tier=older to the rest", () => {
    // Extend MINI_W42 with two extra older days to verify the 'older' tier.
    const w42Extended = ["2026-07-27", "2026-07-28", ...MINI_W42];
    const data = buildChartData(
      w42Extended,
      SESSION_DAYS,
      SESSIONS,
      new Set(),
      W7_SET,
      PREV7_SET,
    );
    expect(data[0].tier).toBe("older");   // 2026-07-27
    expect(data[1].tier).toBe("older");   // 2026-07-28
    expect(data[2].tier).toBe("previous"); // first prev7 day
    expect(data[9].tier).toBe("current"); // first w7 day
  });

  it("isToday is always false (current logical day is excluded from windowSets)", () => {
    const data = buildChartData(MINI_W42, SESSION_DAYS, SESSIONS, new Set(), W7_SET, PREV7_SET);
    expect(data.every((d) => d.isToday === false)).toBe(true);
  });
});

// ── (b) Domain filtering via sessionDays ──────────────────────────────────────

describe("buildChartData — domain filtering", () => {
  it("only counts sessions for days in the w42 window", () => {
    // s1→s3 are in w7, s4→s5 in prev7 — both inside MINI_W42; all five are counted.
    const data = buildChartData(MINI_W42, SESSION_DAYS, SESSIONS, new Set(), W7_SET, PREV7_SET);
    const totalMinutes = data.reduce((sum, d) => sum + d.minutes, 0);
    expect(totalMinutes).toBe(30 + 45 + 20 + 15 + 10); // 120
  });

  it("excludes sessions whose sessionDays key is not in w42", () => {
    // Two sessions whose logical days are NOT in MINI_W42
    const outsideSessions: DomainSession[] = [
      { id: "out1", durationMinutes: 99 },
      { id: "out2", durationMinutes: 77 },
    ];
    const outsideDays: Record<string, string> = {
      out1: "2026-08-12", // today — excluded from windowSets
      out2: "2026-06-01", // before the 42-day window
    };
    const data = buildChartData(
      MINI_W42,
      outsideDays,
      outsideSessions,
      new Set(),
      W7_SET,
      PREV7_SET,
    );
    expect(data.every((d) => d.minutes === 0)).toBe(true);
  });

  it("sums multiple sessions that fall on the same logical day", () => {
    const doubleSessions: DomainSession[] = [
      { id: "d1", durationMinutes: 20 },
      { id: "d2", durationMinutes: 35 },
    ];
    const doubleDays: Record<string, string> = {
      d1: "2026-08-08",
      d2: "2026-08-08",
    };
    const data = buildChartData(MINI_W42, doubleDays, doubleSessions, new Set(), W7_SET, PREV7_SET);
    const aug8 = data.find((d) => d.dateKey === "2026-08-08");
    expect(aug8?.minutes).toBe(55); // 20 + 35
  });

  it("marks anomaly days correctly and keeps non-anomaly days clear", () => {
    const data = buildChartData(MINI_W42, SESSION_DAYS, SESSIONS, new Set(), W7_SET, PREV7_SET);
    // s2 is anomalous on 2026-08-08
    const aug8 = data.find((d) => d.dateKey === "2026-08-08");
    expect(aug8?.hasAnomaly).toBe(true);
    // s1 on 2026-08-06 is not anomalous
    const aug6 = data.find((d) => d.dateKey === "2026-08-06");
    expect(aug6?.hasAnomaly).toBe(false);
  });
});

// ── (c) Selected-range totals ─────────────────────────────────────────────────

describe("buildChartData — selected-range totals via slice", () => {
  it("slicing to the last 7 entries gives only w7 sessions", () => {
    const data = buildChartData(MINI_W42, SESSION_DAYS, SESSIONS, new Set(), W7_SET, PREV7_SET);
    // MINI_W42 has 14 entries; last 7 = w7
    const w7Slice = data.slice(data.length - 7);
    const total = w7Slice.reduce((sum, d) => sum + d.minutes, 0);
    // s1(30) + s2(45) + s3(20) = 95
    expect(total).toBe(95);
  });

  it("slicing to all 14 entries gives w7 + prev7 combined", () => {
    const data = buildChartData(MINI_W42, SESSION_DAYS, SESSIONS, new Set(), W7_SET, PREV7_SET);
    const total = data.reduce((sum, d) => sum + d.minutes, 0);
    // 95 (w7) + 25 (prev7) = 120
    expect(total).toBe(120);
  });
});

// ── (d) Fixed current and previous 7-day sums ────────────────────────────────

describe("sumWindowMinutes — fixed current and previous 7-day sums", () => {
  it("returns the correct sum for the current 7-day window", () => {
    const total = sumWindowMinutes(W7_KEYS, SESSION_DAYS, SESSIONS);
    expect(total).toBe(95); // s1(30) + s2(45) + s3(20)
  });

  it("returns the correct sum for the previous 7-day window", () => {
    const total = sumWindowMinutes(PREV7_KEYS, SESSION_DAYS, SESSIONS);
    expect(total).toBe(25); // s4(15) + s5(10)
  });

  it("current + previous equals the 14-day combined total", () => {
    const current  = sumWindowMinutes(W7_KEYS,    SESSION_DAYS, SESSIONS);
    const previous = sumWindowMinutes(PREV7_KEYS,  SESSION_DAYS, SESSIONS);
    const combined = sumWindowMinutes(W14_KEYS,   SESSION_DAYS, SESSIONS);
    expect(current + previous).toBe(combined);
  });

  it("returns 0 when no sessions fall in the window", () => {
    const emptySessions: DomainSession[] = [];
    expect(sumWindowMinutes(W7_KEYS, SESSION_DAYS, emptySessions)).toBe(0);
  });

  it("returns 0 when windowKeys is empty", () => {
    expect(sumWindowMinutes([], SESSION_DAYS, SESSIONS)).toBe(0);
  });

  it("includes below-floor sessions in the total (qualifying-day rules are separate)", () => {
    const belowFloor: DomainSession[] = [
      { id: "b1", durationMinutes: 5 },  // below typical 15m floor
      { id: "b2", durationMinutes: 8 },
    ];
    const belowFloorDays: Record<string, string> = {
      b1: "2026-08-06",
      b2: "2026-08-09",
    };
    expect(sumWindowMinutes(W7_KEYS, belowFloorDays, belowFloor)).toBe(13); // 5 + 8
  });
});

// ── (e) Missing optional response data ───────────────────────────────────────

describe("graceful handling when server optional data is absent", () => {
  it("buildChartData with empty w42 produces no entries (windowSets not yet loaded)", () => {
    const data = buildChartData([], {}, [], new Set(), new Set(), new Set());
    expect(data).toHaveLength(0);
  });

  it("sumWindowMinutes with empty sessionDays produces 0 (sessionDays not yet loaded)", () => {
    // Sessions exist but their IDs aren't in sessionDays yet.
    const total = sumWindowMinutes(W7_KEYS, {}, SESSIONS);
    expect(total).toBe(0);
  });

  it("sumWindowMinutes with undefined-guarded empty-string key falls through correctly", () => {
    // Simulates the `sessionDays[s.id] ?? ''` guard when a session ID is absent.
    const sessions: DomainSession[] = [{ id: "missing", durationMinutes: 50 }];
    const total = sumWindowMinutes(W7_KEYS, {}, sessions);
    expect(total).toBe(0); // '' is not in W7_KEYS
  });
});

// ── (f) Authoritative deviation-day rendering ─────────────────────────────────

describe("buildChartData — authoritative deviation-day rendering", () => {
  it("marks days in deviationActiveDays as hasDeviation=true", () => {
    const deviationDays = new Set(["2026-08-07", "2026-08-08", "2026-08-09"]);
    const data = buildChartData(MINI_W42, SESSION_DAYS, SESSIONS, deviationDays, W7_SET, PREV7_SET);
    expect(data.find((d) => d.dateKey === "2026-08-07")?.hasDeviation).toBe(true);
    expect(data.find((d) => d.dateKey === "2026-08-08")?.hasDeviation).toBe(true);
    expect(data.find((d) => d.dateKey === "2026-08-09")?.hasDeviation).toBe(true);
  });

  it("does not mark days outside deviationActiveDays as hasDeviation", () => {
    const deviationDays = new Set(["2026-08-07"]);
    const data = buildChartData(MINI_W42, SESSION_DAYS, SESSIONS, deviationDays, W7_SET, PREV7_SET);
    expect(data.find((d) => d.dateKey === "2026-08-06")?.hasDeviation).toBe(false);
    expect(data.find((d) => d.dateKey === "2026-08-08")?.hasDeviation).toBe(false);
  });

  it("hasDeviation=false for all days when deviationActiveDays is empty", () => {
    const data = buildChartData(MINI_W42, SESSION_DAYS, SESSIONS, new Set(), W7_SET, PREV7_SET);
    expect(data.every((d) => d.hasDeviation === false)).toBe(true);
  });

  it("deviationActiveDays spanning prev7 days also marks those days", () => {
    const deviationDays = new Set(["2026-07-30", "2026-07-31"]);
    const data = buildChartData(MINI_W42, SESSION_DAYS, SESSIONS, deviationDays, W7_SET, PREV7_SET);
    expect(data.find((d) => d.dateKey === "2026-07-30")?.hasDeviation).toBe(true);
    expect(data.find((d) => d.dateKey === "2026-07-31")?.hasDeviation).toBe(true);
    expect(data.find((d) => d.dateKey === "2026-08-01")?.hasDeviation).toBe(false);
  });
});

// ── (g) Display labels — pure algorithmic / timezone-independent ──────────────
//
// Labels are derived by Tomohiko Sakamoto's weekday formula applied directly to
// the YYYY-MM-DD integer components.  No Date object is constructed in the label
// path, so the result is identical regardless of the host's system timezone.
// The noon-UTC approach that preceded this (`new Date(key + 'T12:00:00Z')`) was
// susceptible to a UTC+12…+14 shift: e.g. "2026-07-31T12:00:00Z" resolves to
// 2026-08-01T02:00 in UTC+14, rendering "Aug 1" instead of "Jul 31".

describe("buildChartData — display labels pure algorithmic (timezone-independent)", () => {
  it("dayLabel letter and number for Thursday Aug 6", () => {
    // Tomohiko Sakamoto: 2026-08-06 → weekday 4 = Thursday → 'T'; d = 6
    const data = buildChartData(
      ["2026-08-06"],
      {},
      [],
      new Set(),
      new Set(["2026-08-06"]),
      new Set(),
    );
    expect(data[0].dayLabel).toBe("T6");
  });

  it("fullDate month abbreviation and day number for Aug 6", () => {
    const data = buildChartData(["2026-08-06"], {}, [], new Set(), new Set(), new Set());
    expect(data[0].fullDate).toBe("Aug 6");
  });

  it("dayLabel at month boundary July 31 (Friday, multi-digit day)", () => {
    // Tomohiko Sakamoto: 2026-07-31 → weekday 5 = Friday → 'F'; d = 31
    // Old noon-UTC approach: "2026-07-31T12:00:00Z" = 2026-08-01T02:00 in UTC+14
    // → would have yielded "Aug 1" / 'S' (Saturday).  This test proves the fix.
    const data = buildChartData(["2026-07-31"], {}, [], new Set(), new Set(), new Set());
    expect(data[0].dayLabel[0]).toBe("F");
    expect(data[0].dayLabel.slice(1)).toBe("31");
    expect(data[0].fullDate).toBe("Jul 31");
  });

  it("UTC+14 semantics: noon-UTC of July 31 would have been Aug 1 — pure algorithm is correct", () => {
    // Structural proof: buildChartData constructs no Date object in its label
    // path (labelsFromKey uses only integer arithmetic).  Therefore the output
    // is bit-for-bit identical in UTC+14, UTC−12, and every zone in between.
    //
    // We demonstrate the noon-UTC bug explicitly: new Date("2026-07-31T12:00:00Z")
    // resolves to August 1 in UTC+14 (Line Islands, Kiribati).  The algorithm
    // path must yield July 31 regardless — and because no Date is used, it does.
    const data = buildChartData(["2026-07-31"], {}, [], new Set(), new Set(), new Set());
    // Must be Friday the 31st, not Saturday the 1st.
    expect(data[0].dayLabel[0]).toBe("F");   // Friday, not Saturday
    expect(data[0].dayLabel.slice(1)).toBe("31"); // 31, not 1
    expect(data[0].fullDate).toBe("Jul 31");      // July, not August
  });

  it("UTC-12 semantics: noon-UTC of Aug 1 would have been July 31 in reverse — algorithm unaffected", () => {
    // In UTC−12 (Baker Island), "2026-08-01T12:00:00Z" = 2026-08-01T00:00−12:00
    // which is still Aug 1 local — so the noon-UTC bug would not have manifested
    // here.  But confirm the algorithm also gives the correct result for Aug 1.
    // 2026-08-01 = Saturday (Tomohiko Sakamoto → weekday 6 = Saturday → 'S')
    const data = buildChartData(["2026-08-01"], {}, [], new Set(), new Set(), new Set());
    expect(data[0].dayLabel[0]).toBe("S");   // Saturday
    expect(data[0].dayLabel.slice(1)).toBe("1");
    expect(data[0].fullDate).toBe("Aug 1");
  });

  it("Dec 31 year boundary label (Thursday 2026-12-31)", () => {
    // Tomohiko Sakamoto: 2026-12-31 → Thursday → 'T'; fullDate = 'Dec 31'
    const data = buildChartData(["2026-12-31"], {}, [], new Set(), new Set(), new Set());
    expect(data[0].dayLabel[0]).toBe("T");
    expect(data[0].dayLabel.slice(1)).toBe("31");
    expect(data[0].fullDate).toBe("Dec 31");
  });
});

// ── (h) HISTORY_RANGE_OPTIONS contains 7 / 14 / 28 / 42 ─────────────────────

import { HISTORY_RANGE_OPTIONS } from "../pages/domain-detail";

describe("HISTORY_RANGE_OPTIONS — all four range values present", () => {
  it("contains exactly four entries: 7, 14, 28, 42", () => {
    const days = HISTORY_RANGE_OPTIONS.map(o => o.days);
    expect(days).toEqual([7, 14, 28, 42]);
  });

  it("each entry has a matching label string", () => {
    for (const opt of HISTORY_RANGE_OPTIONS) {
      expect(opt.label).toBe(`${opt.days}d`);
    }
  });

  it("includes 42 (the option absent before this correction)", () => {
    expect(HISTORY_RANGE_OPTIONS.some(o => o.days === 42)).toBe(true);
  });
});

// ── sumTodayMinutes — current logical day total ───────────────────────────────
//
// Today is the in-progress logical day.  It MUST appear in sumTodayMinutes and
// MUST NOT appear in sumWindowMinutes for any completed-window key set.

describe("sumTodayMinutes — current logical day total", () => {
  const TODAY_KEY = "2026-08-12";

  const todaySession: DomainSession   = { id: "t1", durationMinutes: 20, isAnomaly: false };
  const w7Session: DomainSession      = { id: "w1", durationMinutes: 30, isAnomaly: false };
  const prev7Session: DomainSession   = { id: "p1", durationMinutes: 15, isAnomaly: false };

  const todaySessionDays: Record<string, string> = {
    t1: TODAY_KEY,
    w1: "2026-08-11",   // last day of w7
    p1: "2026-07-29",   // first day of prev7
  };

  const allSessions = [todaySession, w7Session, prev7Session];

  it("returns the sum for a single session on todayKey", () => {
    expect(sumTodayMinutes(TODAY_KEY, todaySessionDays, allSessions)).toBe(20);
  });

  it("returns 0 when no sessions fall on today", () => {
    expect(sumTodayMinutes(TODAY_KEY, todaySessionDays, [w7Session, prev7Session])).toBe(0);
  });

  it("returns 0 when todayKey is null", () => {
    expect(sumTodayMinutes(null, todaySessionDays, allSessions)).toBe(0);
  });

  it("returns 0 when todayKey is undefined", () => {
    expect(sumTodayMinutes(undefined, todaySessionDays, allSessions)).toBe(0);
  });

  it("aggregates multiple today sessions (sum, not first-only)", () => {
    const s2: DomainSession = { id: "t2", durationMinutes: 35, isAnomaly: false };
    const days = { ...todaySessionDays, t2: TODAY_KEY };
    expect(sumTodayMinutes(TODAY_KEY, days, [...allSessions, s2])).toBe(55); // 20 + 35
  });

  it("includes below-floor sessions in today total", () => {
    // A 3-minute session is below any domain floor but must still count.
    const belowFloor: DomainSession = { id: "t3", durationMinutes: 3, isAnomaly: false };
    const days = { ...todaySessionDays, t3: TODAY_KEY };
    expect(sumTodayMinutes(TODAY_KEY, days, [...allSessions, belowFloor])).toBe(23); // 20 + 3
  });

  it("today session is NOT counted by sumWindowMinutes for w7", () => {
    // todayKey ("2026-08-12") is not in W7_KEYS — sumWindowMinutes must return
    // only the w7 session (30m), never the today session (20m).
    expect(sumWindowMinutes(W7_KEYS, todaySessionDays, allSessions)).toBe(30);
  });

  it("today session is NOT counted by sumWindowMinutes for prev7", () => {
    expect(sumWindowMinutes(PREV7_KEYS, todaySessionDays, allSessions)).toBe(15);
  });

  it("returns 0 when sessionDays is empty (store not yet loaded)", () => {
    expect(sumTodayMinutes(TODAY_KEY, {}, allSessions)).toBe(0);
  });
});

// ── Music acceptance fixture — 140m / 200m / 340m / 20m today ────────────────
//
// Mirrors the verified real-data computation from the read-only DB check
// (2026-08-13 session, America/New_York, dayStartHour=6).  Expressed
// generically as day keys + per-day session amounts; no DB dependency.
//
// Verified values:
//   current7 (2026-08-05 → 2026-08-11) = 140 m
//   prev7    (2026-07-29 → 2026-08-04) = 200 m
//   w14      (prev7 + current7)         = 340 m
//   today    (2026-08-12, in-progress)  =  20 m

describe("sumTodayMinutes / sumWindowMinutes — Music acceptance case (140m/200m/340m/20m)", () => {
  const MUSIC_TODAY_KEY = "2026-08-12";

  // Per-day amounts matching the verified breakdown
  // current7: 25+25+25+0+0+50+15 = 140
  // prev7:    20+0+55+45+50+0+30 = 200
  // today:    20
  const MUSIC_SESSIONS: DomainSession[] = [
    { id: "mw1", durationMinutes: 25 },  // 2026-08-05
    { id: "mw2", durationMinutes: 25 },  // 2026-08-06
    { id: "mw3", durationMinutes: 25 },  // 2026-08-07
    // 2026-08-08, 09: no sessions → 0
    { id: "mw4", durationMinutes: 50 },  // 2026-08-10
    { id: "mw5", durationMinutes: 15 },  // 2026-08-11
    { id: "mp1", durationMinutes: 20 },  // 2026-07-29
    // 2026-07-30: no session → 0
    { id: "mp2", durationMinutes: 55 },  // 2026-07-31
    { id: "mp3", durationMinutes: 45 },  // 2026-08-01
    { id: "mp4", durationMinutes: 50 },  // 2026-08-02
    // 2026-08-03: no session → 0
    { id: "mp5", durationMinutes: 30 },  // 2026-08-04
    { id: "mt1", durationMinutes: 20 },  // 2026-08-12 (today — live)
  ];

  const MUSIC_SESSION_DAYS: Record<string, string> = {
    mw1: "2026-08-05",
    mw2: "2026-08-06",
    mw3: "2026-08-07",
    mw4: "2026-08-10",
    mw5: "2026-08-11",
    mp1: "2026-07-29",
    mp2: "2026-07-31",
    mp3: "2026-08-01",
    mp4: "2026-08-02",
    mp5: "2026-08-04",
    mt1: "2026-08-12",
  };

  it("current 7d total is 140m", () => {
    expect(sumWindowMinutes(W7_KEYS, MUSIC_SESSION_DAYS, MUSIC_SESSIONS)).toBe(140);
  });

  it("previous 7d total is 200m", () => {
    expect(sumWindowMinutes(PREV7_KEYS, MUSIC_SESSION_DAYS, MUSIC_SESSIONS)).toBe(200);
  });

  it("w14 total (current7 + prev7) is 340m", () => {
    expect(sumWindowMinutes(W14_KEYS, MUSIC_SESSION_DAYS, MUSIC_SESSIONS)).toBe(340);
  });

  it("current7 + prev7 === w14 (no gap, no overlap)", () => {
    const c7 = sumWindowMinutes(W7_KEYS,   MUSIC_SESSION_DAYS, MUSIC_SESSIONS);
    const p7 = sumWindowMinutes(PREV7_KEYS, MUSIC_SESSION_DAYS, MUSIC_SESSIONS);
    const w14 = sumWindowMinutes(W14_KEYS, MUSIC_SESSION_DAYS, MUSIC_SESSIONS);
    expect(c7 + p7).toBe(w14);
  });

  it("today total is 20m", () => {
    expect(sumTodayMinutes(MUSIC_TODAY_KEY, MUSIC_SESSION_DAYS, MUSIC_SESSIONS)).toBe(20);
  });

  it("today session does NOT change current7 (still 140m when today is included in session list)", () => {
    // The today session (mt1 → 2026-08-12) is not in W7_KEYS so sumWindowMinutes
    // must ignore it even when the full session list (incl. today) is passed.
    const c7 = sumWindowMinutes(W7_KEYS, MUSIC_SESSION_DAYS, MUSIC_SESSIONS);
    expect(c7).toBe(140);
  });

  it("today session does NOT change prev7 (still 200m)", () => {
    const p7 = sumWindowMinutes(PREV7_KEYS, MUSIC_SESSION_DAYS, MUSIC_SESSIONS);
    expect(p7).toBe(200);
  });

  it("today session does NOT change w14 total (still 340m)", () => {
    const w14 = sumWindowMinutes(W14_KEYS, MUSIC_SESSION_DAYS, MUSIC_SESSIONS);
    expect(w14).toBe(340);
  });

  it("multiple today sessions aggregate — adding a second session gives correct total", () => {
    const s2: DomainSession = { id: "mt2", durationMinutes: 35 };
    const extDays = { ...MUSIC_SESSION_DAYS, mt2: MUSIC_TODAY_KEY };
    expect(sumTodayMinutes(MUSIC_TODAY_KEY, extDays, [...MUSIC_SESSIONS, s2])).toBe(55); // 20 + 35
  });

  it("multiple today sessions do NOT bleed into completed window sums", () => {
    const s2: DomainSession = { id: "mt2", durationMinutes: 35 };
    const extDays = { ...MUSIC_SESSION_DAYS, mt2: MUSIC_TODAY_KEY };
    const allWithExtra = [...MUSIC_SESSIONS, s2];
    expect(sumWindowMinutes(W7_KEYS,   extDays, allWithExtra)).toBe(140);
    expect(sumWindowMinutes(PREV7_KEYS, extDays, allWithExtra)).toBe(200);
  });

  it("zero today sessions correctly returns 0", () => {
    const noToday = MUSIC_SESSIONS.filter((s) => s.id !== "mt1");
    expect(sumTodayMinutes(MUSIC_TODAY_KEY, MUSIC_SESSION_DAYS, noToday)).toBe(0);
  });
});

// ── buildTodayDatum — chart reference column ──────────────────────────────────
//
// `buildTodayDatum` produces the single Today reference ChartDatum that the
// Activity History chart renders as a visually separated column to the right
// of the N completed-day bars.  Tests prove:
//   1. Shape invariants (isToday, dayLabel, dateKey, minutes)
//   2. The completed-day series has N entries; Today adds exactly 1
//   3. Today's minutes aggregate from sumTodayMinutes (multi-session)
//   4. Today is NOT present in the completed-day buildChartData output
//   5. Completed-window sums are unaffected regardless of today's value

describe("buildTodayDatum — chart reference column", () => {
  const TODAY_KEY = "2026-08-12";

  it("returns isToday=true so the renderer distinguishes it from completed days", () => {
    expect(buildTodayDatum(TODAY_KEY, 20).isToday).toBe(true);
  });

  it("returns dayLabel='TODAY' — the fixed x-axis label for the live column", () => {
    expect(buildTodayDatum(TODAY_KEY, 20).dayLabel).toBe("TODAY");
  });

  it("returns fullDate='Today'", () => {
    expect(buildTodayDatum(TODAY_KEY, 20).fullDate).toBe("Today");
  });

  it("preserves the supplied dateKey unchanged", () => {
    expect(buildTodayDatum(TODAY_KEY, 20).dateKey).toBe(TODAY_KEY);
  });

  it("preserves the supplied todayMinutes as .minutes", () => {
    expect(buildTodayDatum(TODAY_KEY, 20).minutes).toBe(20);
  });

  it("zero minutes produces a valid datum (zero/empty baseline, not hidden)", () => {
    const d = buildTodayDatum(TODAY_KEY, 0);
    expect(d.minutes).toBe(0);
    expect(d.isToday).toBe(true);
    expect(d.dayLabel).toBe("TODAY");
  });

  it("hasAnomaly is false — anomaly logic does not apply to the live in-progress day", () => {
    expect(buildTodayDatum(TODAY_KEY, 20).hasAnomaly).toBe(false);
  });

  it("hasDeviation is false — deviation bands apply only to completed days", () => {
    expect(buildTodayDatum(TODAY_KEY, 20).hasDeviation).toBe(false);
  });

  // Chart series length: N completed days + 1 Today reference
  it("appending Today to a 7-day completed series gives a chart series of length 8", () => {
    const completed = buildChartData(W7_KEYS, SESSION_DAYS, SESSIONS, new Set(), W7_SET, PREV7_SET);
    const todayDatum = buildTodayDatum(TODAY_KEY, 20);
    const series = [...completed, todayDatum];
    expect(completed).toHaveLength(7);   // N = 7 completed days
    expect(series).toHaveLength(8);      // N + 1 Today reference
  });

  it("appending Today to a 14-day completed series gives a chart series of length 15", () => {
    const completed = buildChartData(W14_KEYS, SESSION_DAYS, SESSIONS, new Set(), W7_SET, PREV7_SET);
    const series = [...completed, buildTodayDatum(TODAY_KEY, 20)];
    expect(completed).toHaveLength(14);
    expect(series).toHaveLength(15);
  });

  it("the completed series from buildChartData contains NO entry with isToday=true", () => {
    const completed = buildChartData(W7_KEYS, SESSION_DAYS, SESSIONS, new Set(), W7_SET, PREV7_SET);
    expect(completed.every((d) => d.isToday === false)).toBe(true);
  });

  it("TODAY_KEY is not present in the completed-day buildChartData output (excluded from windowSets)", () => {
    // todayKey is deliberately absent from every window set — this prevents
    // the current in-progress day from appearing in completed-period totals.
    const completed = buildChartData(W7_KEYS, SESSION_DAYS, SESSIONS, new Set(), W7_SET, PREV7_SET);
    expect(completed.some((d) => d.dateKey === TODAY_KEY)).toBe(false);
  });

  // Aggregation: todayMinutes passed to buildTodayDatum is the sumTodayMinutes output
  it("multi-session today: sumTodayMinutes aggregates correctly before buildTodayDatum", () => {
    const s1: DomainSession = { id: "ta", durationMinutes: 15 };
    const s2: DomainSession = { id: "tb", durationMinutes: 25 };
    const days: Record<string, string> = { ta: TODAY_KEY, tb: TODAY_KEY };
    const total = sumTodayMinutes(TODAY_KEY, days, [s1, s2]);
    const datum = buildTodayDatum(TODAY_KEY, total);
    expect(total).toBe(40);
    expect(datum.minutes).toBe(40);
  });

  it("today's minutes in buildTodayDatum do NOT change sumWindowMinutes for any completed window", () => {
    // Structural proof: buildTodayDatum receives a pre-computed value and does
    // not call sumWindowMinutes.  sumWindowMinutes uses Set membership to filter,
    // and TODAY_KEY is never in W7_KEYS or PREV7_KEYS.
    const todaySession: DomainSession = { id: "tx", durationMinutes: 999 };
    const daysWithToday = { ...SESSION_DAYS, tx: TODAY_KEY };
    const allSessions   = [...SESSIONS, todaySession];

    const w7Sum   = sumWindowMinutes(W7_KEYS,   daysWithToday, allSessions);
    const p7Sum   = sumWindowMinutes(PREV7_KEYS, daysWithToday, allSessions);
    const w14Sum  = sumWindowMinutes(W14_KEYS,   daysWithToday, allSessions);

    // 999m today session must not appear in any completed window
    expect(w7Sum).toBe(30 + 45 + 20); // s1 + s2 + s3 from SESSION_DAYS
    expect(p7Sum).toBe(15 + 10);       // s4 + s5
    expect(w14Sum).toBe(w7Sum + p7Sum);
  });

  // Music acceptance fixture — today column value (session data inlined here;
  // the full Music fixture lives in the acceptance describe above).
  it("Music today column: buildTodayDatum(todayKey, sumTodayMinutes) gives 20m datum", () => {
    const musicTodaySession: DomainSession = { id: "mt1", durationMinutes: 20 };
    const musicDays: Record<string, string> = { mt1: "2026-08-12" };
    const minutes = sumTodayMinutes("2026-08-12", musicDays, [musicTodaySession]);
    const datum   = buildTodayDatum("2026-08-12", minutes);
    expect(datum.minutes).toBe(20);
    expect(datum.isToday).toBe(true);
    expect(datum.dayLabel).toBe("TODAY");
  });
});
