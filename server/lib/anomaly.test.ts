import { describe, expect, it } from "vitest";
import { computeBaseline, detectAnomaly } from "./anomaly";

// Eight valid samples avoid either disputed cold-start threshold.
// No small-sample/fallback expectations are asserted here.
const now = new Date("2026-10-03T12:00:00Z");
const sample = (durationMinutes: number, timestamp = now, domain = "music" as const) =>
  ({ domain, durationMinutes, timestamp });
const mature = Array.from({ length: 8 }, (_, i) => sample(i % 2 ? 40 : 20));

describe("mature-baseline anomaly detection", () => {
  it("uses the population mean and standard deviation of eight valid samples", () => {
    expect(computeBaseline("music", mature, { now })).toEqual({
      coldStart: false, sampleCount: 8, mean: 30, stdDev: 10,
    });
  });

  it.each([
    [11, false, 1.9], [49, false, 1.9],
    [10, false, 2], [50, false, 2],
    [9, true, 2.1], [51, true, 2.1],
  ])("duration %s respects strict two-sigma comparison", (duration, isAnomaly, zScore) => {
    expect(detectAnomaly("music", duration, mature, { now })).toEqual({
      coldStart: false, sampleCount: 8, mean: 30, stdDev: 10, isAnomaly, zScore,
    });
  });

  it("excludes other domains without changing a mature same-domain baseline", () => {
    const otherDomain = Array.from({ length: 8 }, () => ({
      domain: "fitness" as const, durationMinutes: 900, timestamp: now,
    }));
    const mixed = [...mature, ...otherDomain];
    expect(computeBaseline("music", mixed, { now })).toEqual(computeBaseline("music", mature, { now }));
    expect(detectAnomaly("music", 51, mixed, { now })).toEqual(detectAnomaly("music", 51, mature, { now }));
  });

  it("uses the golden 42-day cutoff inclusively, excluding older and future samples", () => {
    // Independent golden date: 42 days before 2026-10-03T12:00:00Z.
    // Do not derive this expectation from the implementation's window constant.
    const cutoff = new Date("2026-08-22T12:00:00Z");
    const valid = Array.from({ length: 8 }, (_, i) =>
      sample(i % 2 ? 40 : 20, i < 4 ? cutoff : now));
    const mixed = [...valid,
      sample(900, new Date(cutoff.getTime() - 1)),
      sample(900, new Date(now.getTime() + 1)),
    ];
    expect(computeBaseline("music", mixed, { now })).toEqual({
      coldStart: false, sampleCount: 8, mean: 30, stdDev: 10,
    });
    expect(detectAnomaly("music", 50, mixed, { now }).isAnomaly).toBe(false);
    expect(detectAnomaly("music", 51, mixed, { now }).isAnomaly).toBe(true);
  });

  it.each([[30, false, 0], [29, true, Infinity], [31, true, Infinity]])(
    "zero-variance mature baseline compares duration %s without NaN",
    (duration, isAnomaly, zScore) => {
      const result = detectAnomaly("music", duration, Array.from({ length: 8 }, () => sample(30)), { now });
      expect(result).toEqual({
        coldStart: false, sampleCount: 8, mean: 30, stdDev: 0, isAnomaly, zScore,
      });
    },
  );
});