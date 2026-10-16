import { describe, it, expect } from "vitest";
import { OnboardingReadySchema, OnboardingStatusSchema, WorkspaceEnsureInputSchema, OnboardingSettingsPatchSchema } from "./onboarding";

const ready = { schemaVersion: 1, ownerUserId: "owner-a", status: "ready", workspace: { organizationId: "private-a", role: "owner" },
  experience: "personal", hasConfiguredDomain: false, settings: { userId: "owner-a", dayStartHour: 4, timezone: "America/New_York", windowDays: 7 } };
describe("owner-validated onboarding transport contract", () => {
  it("has an explicit missing-workspace state with no guessed boundary", () => {
    expect(OnboardingStatusSchema.parse({ schemaVersion: 1, ownerUserId: "owner-a", status: "needs_workspace" }))
      .toEqual({ schemaVersion: 1, ownerUserId: "owner-a", status: "needs_workspace" });
    expect(OnboardingStatusSchema.safeParse({ schemaVersion: 1, ownerUserId: "owner-a", status: "needs_workspace", settings: ready.settings }).success).toBe(false);
  });
  it("rejects cross-owner settings, forged authority and ambiguous state", () => {
    for (const value of [{ ...ready, settings: { ...ready.settings, userId: "owner-b" } }, { ...ready, actorKind: "system" },
      { ...ready, workspace: { ...ready.workspace, rolloutMode: "v2" } }, { ...ready, status: "unknown" }, { ...ready, ownerUserId: " owner-a " }])
      expect(OnboardingStatusSchema.safeParse(value).success).toBe(false);
    expect(OnboardingReadySchema.safeParse({ ...ready, settings: null }).success).toBe(true);
  });
  it("preserves valid persisted boundary values without adding or normalizing choices", () => {
    const persisted = { ...ready, settings: { ...ready.settings, dayStartHour: 15, windowDays: 21 } };
    expect(OnboardingReadySchema.parse(persisted)).toEqual(persisted);
    for (const patch of [{ timezone: "private-invalid-zone" }, { dayStartHour: 24 }, { windowDays: 0 }, { windowDays: 9007199254740992 }])
      expect(OnboardingReadySchema.safeParse({ ...ready, settings: { ...ready.settings, ...patch } }).success).toBe(false);
  });
  it("only accepts an explicit empty object for workspace setup", () => {
    expect(WorkspaceEnsureInputSchema.parse({})).toEqual({});
    for (const input of [undefined, null, [], "", { orgId: "private-b" }, { userId: "owner-b" }, { email: "other@example.invalid" },
      { role: "owner" }, { rolloutMode: "v2" }, { template: "Philip" }]) expect(WorkspaceEnsureInputSchema.safeParse(input).success).toBe(false);
  });
  it("accepts only nonempty personal day patches, with no coercion or caller authority", () => {
    for (const input of [{ dayStartHour: 0 }, { dayStartHour: 23 }, { timezone: "Europe/Paris" },
      ...[7, 14, 28, 42].map(windowDays => ({ windowDays })),
      { dayStartHour: 15, timezone: "Europe/London", windowDays: 14 }])
      expect(OnboardingSettingsPatchSchema.parse(input)).toEqual(input);
    for (const input of [undefined, null, [], "", {}, { dayStartHour: undefined }, { dayStartHour: null },
      { dayStartHour: "4" }, { dayStartHour: -1 }, { dayStartHour: 24 }, { dayStartHour: 2.5 },
      { timezone: "" }, { timezone: "private-invalid-zone" }, { timezone: "x".repeat(65) },
      { windowDays: "7" }, { windowDays: 0 }, { windowDays: 21 }, { windowDays: 30 }, { windowDays: 9007199254740992 },
      { dayStartHour: 4, userId: "owner-b" }, { timezone: "UTC", organizationId: "private-b" },
      { windowDays: 7, role: "owner" }, { dayStartHour: 4, rolloutMode: "v2" },
      { timezone: "UTC", notificationsEnabled: false }, { timezone: "UTC", notificationTier: null }])
      expect(OnboardingSettingsPatchSchema.safeParse(input).success).toBe(false);
  });
  it("keeps persisted nonpreset windows readable while refusing to submit them as a new choice", () => {
    for (const windowDays of [21, 30]) {
      expect(OnboardingReadySchema.parse({ ...ready, settings: { ...ready.settings, windowDays } }).settings?.windowDays).toBe(windowDays);
      expect(OnboardingSettingsPatchSchema.parse({ dayStartHour: 3 })).toEqual({ dayStartHour: 3 });
      expect(OnboardingSettingsPatchSchema.safeParse({ windowDays }).success).toBe(false);
    }
  });
});
