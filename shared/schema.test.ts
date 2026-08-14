import { describe, expect, it } from "vitest";
import {
  complianceWindowDayOptions,
  insertUserSettingsSchema,
  normalizeComplianceWindowDays,
} from "./schema";

describe("compliance-window settings standard (SOMR-328)", () => {
  it("exposes exactly the approved 7/14/28/42-day choices", () => {
    expect([...complianceWindowDayOptions]).toEqual([7, 14, 28, 42]);
  });

  it.each([7, 14, 28, 42])("preserves supported value %i", (windowDays) => {
    expect(normalizeComplianceWindowDays(windowDays)).toBe(windowDays);
    expect(insertUserSettingsSchema.safeParse({ windowDays }).success).toBe(true);
  });

  it.each([
    [21, 28],
    [30, 28],
  ])("migrates legacy value %i to %i", (legacy, expected) => {
    expect(normalizeComplianceWindowDays(legacy)).toBe(expected);
  });

  it.each([21, 30])("rejects legacy value %i on new settings writes", (windowDays) => {
    expect(insertUserSettingsSchema.safeParse({ windowDays }).success).toBe(false);
  });

  it("coerces a supported form value without broadening the accepted set", () => {
    const parsed = insertUserSettingsSchema.safeParse({ windowDays: "28" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.windowDays).toBe(28);
  });
});
