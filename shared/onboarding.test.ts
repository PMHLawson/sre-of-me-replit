import { describe, it, expect } from "vitest";
import { OnboardingReadySchema, OnboardingStatusSchema, WorkspaceEnsureInputSchema } from "./onboarding";

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
});
