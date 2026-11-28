import { describe, expect, it } from "vitest";
import {
  allSelection, compareBreakInstants, formatBreakTime, orderedSelection,
  sameInstant, wallTimeCandidates,
} from "./deviation-time";

describe("saved-timezone break time conversion", () => {
  it("rejects a nonexistent local time and requires explicit choices for a repeated hour", () => {
    expect(wallTimeCandidates("2026-03-08T02:30", "America/New_York")).toEqual([]);
    const repeated = wallTimeCandidates("2026-11-01T01:30", "America/New_York");
    expect(repeated.map(candidate => candidate.instant)).toEqual([
      "2026-11-01T05:30:00.000Z",
      "2026-11-01T06:30:00.000Z",
    ]);
    expect(wallTimeCandidates("2026-11-02T09:30", "America/New_York").map(candidate => candidate.instant))
      .toEqual(["2026-11-02T14:30:00.000Z"]);
  });

  it("round-trips a saved microsecond instant without rounding", () => {
    const original = "2026-11-01T06:30:12.123456Z";
    const local = formatBreakTime(original, "America/New_York");
    expect(local).toBe("2026-11-01T01:30:12.123456");
    const candidates = wallTimeCandidates(local, "America/New_York");
    expect(candidates[1].instant).toBe(original);
    expect(sameInstant(candidates[1].instant, original)).toBe(true);
  });

  it("compares equivalent offset representations at microsecond precision", () => {
    expect(sameInstant("2026-11-01T06:30:12.123456Z", "2026-11-01T01:30:12.123456-05:00")).toBe(true);
    expect(compareBreakInstants("2026-11-01T06:30:12.123457Z", "2026-11-01T06:30:12.123456Z")).toBe(1);
  });

  it("selects and clears practices by stable domain ID without reordering existing choices", () => {
    const one = orderedSelection(["fitness"], "cooking", true);
    expect(one).toEqual(["fitness", "cooking"]);
    expect(orderedSelection(one, "fitness", false)).toEqual(["cooking"]);
    expect(allSelection(["legacy"], ["fitness", "cooking"], true)).toEqual(["legacy", "fitness", "cooking"]);
    expect(allSelection(["legacy", "fitness"], ["fitness", "cooking"], false)).toEqual(["legacy"]);
  });
});
