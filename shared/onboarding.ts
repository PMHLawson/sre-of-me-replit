import { z } from "zod";

const identity = z.string().min(1).max(200).refine(value => value.trim() === value &&
  !/[\u0000-\u001f\u007f]/.test(value) && value !== "__proto__");
const timezone = z.string().min(1).max(64).refine(value => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
});

/** Persisted owner boundary only; this read never normalizes existing settings. */
export const OnboardingSettingsSchema = z.object({
  userId: identity,
  dayStartHour: z.number().int().min(0).max(23),
  timezone,
  windowDays: z.number().int().positive().refine(Number.isSafeInteger),
}).strict();

const ready = z.object({
  schemaVersion: z.literal(1), ownerUserId: identity, status: z.literal("ready"),
  workspace: z.object({ organizationId: identity, role: z.enum(["owner", "member"]) }).strict(),
  experience: z.enum(["legacy", "personal"]),
  hasConfiguredDomain: z.boolean(),
  // A valid existing membership is never repaired or rewritten by ensure.
  settings: OnboardingSettingsSchema.nullable(),
}).strict();
const needsWorkspace = z.object({
  schemaVersion: z.literal(1), ownerUserId: identity, status: z.literal("needs_workspace"),
}).strict();
const ownsSettings = (value: z.infer<typeof ready>) => value.settings === null || value.settings.userId === value.ownerUserId;
export const OnboardingReadySchema = ready.refine(ownsSettings, { message: "Settings must belong to the authenticated owner", path: ["settings", "userId"] });
export const OnboardingStatusSchema = z.discriminatedUnion("status", [needsWorkspace, ready]).superRefine((value, context) => {
  if (value.status === "ready" && !ownsSettings(value)) context.addIssue({ code: z.ZodIssueCode.custom,
    message: "Settings must belong to the authenticated owner", path: ["settings", "userId"] });
});

/** This operation has no caller-selected identities, roles, mode or template. */
export const WorkspaceEnsureInputSchema = z.object({}).strict();
/** Personal day edits never normalize an omitted persisted setting. */
export const OnboardingSettingsPatchSchema = z.object({
  dayStartHour: OnboardingSettingsSchema.shape.dayStartHour.optional(),
  timezone: OnboardingSettingsSchema.shape.timezone.optional(),
  windowDays: z.union([z.literal(7), z.literal(14), z.literal(28), z.literal(42)]).optional(),
}).strict().refine(value => Object.values(value).some(field => field !== undefined), {
  message: "Supply at least one day setting",
});
export type OnboardingSettings = z.infer<typeof OnboardingSettingsSchema>;
export type OnboardingSettingsPatch = z.infer<typeof OnboardingSettingsPatchSchema>;
export type OnboardingReady = z.infer<typeof OnboardingReadySchema>;
export type OnboardingStatus = z.infer<typeof OnboardingStatusSchema>;
