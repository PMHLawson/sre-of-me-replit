import {
  logicalDay,
  completedWindowDays,
  computeServiceState,
  computeCompositeState,
} from "../server/lib/policy-engine";

const NOW = new Date("2026-04-18T15:00:00.000-04:00");

const seed = [
  // Today (2026-04-18) — should be EXCLUDED from window by default
  { id: "x1", userId: "u", domain: "fitness",      durationMinutes: 60, timestamp: new Date("2026-04-18T10:00:00-04:00"), notes: null },
  // 02:30 < dayStartHour=4 → counts as 2026-04-17
  { id: "x2", userId: "u", domain: "meditation",   durationMinutes: 20, timestamp: new Date("2026-04-18T02:30:00-04:00"), notes: null },
  // Same logical day 2026-04-17 → only 1 qualifying day
  { id: "x3", userId: "u", domain: "meditation",   durationMinutes: 15, timestamp: new Date("2026-04-17T08:00:00-04:00"), notes: null },
  // Below floor → minutes-only
  { id: "x4", userId: "u", domain: "music",        durationMinutes: 5,  timestamp: new Date("2026-04-15T12:00:00-04:00"), notes: null },
  // Martial arts on 4 distinct logical days
  { id: "x5", userId: "u", domain: "martial-arts", durationMinutes: 30, timestamp: new Date("2026-04-12T09:00:00-04:00"), notes: null },
  { id: "x6", userId: "u", domain: "martial-arts", durationMinutes: 30, timestamp: new Date("2026-04-13T09:00:00-04:00"), notes: null },
  { id: "x7", userId: "u", domain: "martial-arts", durationMinutes: 30, timestamp: new Date("2026-04-14T09:00:00-04:00"), notes: null },
  { id: "x8", userId: "u", domain: "martial-arts", durationMinutes: 30, timestamp: new Date("2026-04-16T09:00:00-04:00"), notes: null },
] as any[];

const opts = { now: NOW };

console.log("today logical_day  =", logicalDay(NOW, opts));
console.log("logicalDay 02:30   =", logicalDay(new Date("2026-04-18T02:30:00-04:00"), opts), "(expect 2026-04-17)");
console.log("logicalDay 04:00   =", logicalDay(new Date("2026-04-18T04:00:00-04:00"), opts), "(expect 2026-04-18)");
console.log("window_days        =", completedWindowDays(opts).join(", "));

const meditation = computeServiceState("meditation", seed, opts);
console.log("\n[meditation]");
console.log("  qualifying_days =", meditation.actual_qualifying_days, "(2 sessions on 04-17 → expect 1)");
console.log("  actual_minutes  =", meditation.actual_minutes);
console.log("  scores (sess/dur/svc) =", meditation.session_score, meditation.duration_score, meditation.service_score, "color=" + meditation.compliance_color);

const music = computeServiceState("music", seed, opts);
console.log("\n[music]");
console.log("  qualifying_days =", music.actual_qualifying_days, "(below-floor → expect 0)");
console.log("  actual_minutes  =", music.actual_minutes, "(expect 5)");

const ma = computeServiceState("martial-arts", seed, opts);
console.log("\n[martial-arts]");
console.log("  qualifying_days =", ma.actual_qualifying_days, "(expect 4)");
console.log("  service_score   =", ma.service_score, "color=" + ma.compliance_color);

const fitness = computeServiceState("fitness", seed, opts);
console.log("\n[fitness]");
console.log("  qualifying_days =", fitness.actual_qualifying_days, "(today excluded → expect 0)");
console.log("  actual_minutes  =", fitness.actual_minutes, "(today excluded → expect 0)");

const composite = computeCompositeState(seed, opts);
console.log("\n[composite]");
console.log("  composite_score =", composite.composite_score, "color=" + composite.composite_color);
console.log("  weights         =",
  Object.fromEntries(Object.entries(composite.services).map(([d, s]) => [d, s.service_weight])));
