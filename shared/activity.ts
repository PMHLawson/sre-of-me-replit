import { z } from "zod";
import { DomainConfigurationSchema, type DomainConfiguration } from "./domain-config";

export const ActivityIdSchema = z.string().min(1).max(200).refine(value => value.trim() === value &&
  !/[\u0000-\u001f\u007f]/.test(value) && !["__proto__", "prototype", "constructor"].includes(value));
export const ActivitySubmissionKeySchema = ActivityIdSchema;
/** This API deliberately supports millisecond precision, never truncated finer instants. */
export const ActivityTimestampSchema = z.string().max(64).datetime({ offset: true }).refine(value =>
  Number.isFinite(Date.parse(value)) && !/\.\d{4,}/.test(value), "Use at most three fractional second digits.")
  .transform(value => new Date(value).toISOString());
const valueBase = { unitId: ActivityIdSchema, taskVariantId: ActivityIdSchema.optional() };
export const ActivityValueSchema = z.discriminatedUnion("valueType", [
  z.object({ ...valueBase, valueType: z.literal("number"), value: z.number().finite().nonnegative() }).strict(),
  z.object({ ...valueBase, valueType: z.literal("integer"), value: z.number().finite().nonnegative().refine(Number.isSafeInteger) }).strict(),
  z.object({ ...valueBase, valueType: z.literal("boolean"), value: z.boolean() }).strict(),
]);
export const ActivityValuesSchema = z.unknown().superRefine((value, ctx) => {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    ["__proto__", "prototype", "constructor"].some(key => Object.hasOwn(value, key)) ||
    Object.keys(value).length > 64 || Object.keys(value).some(key => !ActivityIdSchema.safeParse(key).success))
    ctx.addIssue({ code: "custom", message: "Provide at most 64 declared measurement values." });
}).pipe(z.record(ActivityIdSchema, ActivityValueSchema));
const condition = z.object({ conditionId: ActivityIdSchema, description: z.string().trim().min(1).max(1000) }).strict();
export const ActivityContextSchema = z.object({ description: z.string().trim().min(1).max(2000).optional(),
  taskConditions: z.array(condition).max(32).optional() }).strict();
export const ActivityCreateInputSchema = z.object({
  submissionKey: ActivitySubmissionKeySchema, domainId: ActivityIdSchema, policyVersionId: ActivityIdSchema,
  practiceEvent: z.literal(true), observedAt: ActivityTimestampSchema, values: ActivityValuesSchema,
  notes: z.string().max(4000).optional(), context: ActivityContextSchema.optional(),
}).strict();
export type ActivityCreateInput = z.infer<typeof ActivityCreateInputSchema>;
export const ActivityListInputSchema = z.object({ domainId: ActivityIdSchema.optional(),
  limit: z.number().int().min(1).max(100).default(50), cursor: z.string().min(1).max(1024).optional() }).strict();
export type ActivityListInput = z.infer<typeof ActivityListInputSchema>;
export const ActivityCursorPayloadSchema = z.object({ version: z.literal(1), scope: z.string().regex(/^[a-f0-9]{64}$/),
  observedAt: ActivityTimestampSchema, activityId: ActivityIdSchema }).strict();
export type ActivityCursorPayload = z.infer<typeof ActivityCursorPayloadSchema>;
export const ActivityStateFingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const ActivityMutationOperationSchema = z.enum(["edit", "delete", "restore"]);
const mutationFields = { mutationKey: ActivityIdSchema, expectedStateFingerprint: ActivityStateFingerprintSchema,
  reason: z.string().trim().min(1).max(500) };
export const ActivityEditInputSchema = z.object({ ...mutationFields, policyVersionId: ActivityIdSchema,
  practiceEvent: z.literal(true), observedAt: ActivityTimestampSchema, values: ActivityValuesSchema,
  notes: z.string().max(4000).optional(), context: ActivityContextSchema.optional() }).strict();
export const ActivityLifecycleInputSchema = z.object(mutationFields).strict();
export type ActivityEditInput = z.infer<typeof ActivityEditInputSchema>;
export type ActivityLifecycleInput = z.infer<typeof ActivityLifecycleInputSchema>;

/** Raw occurrences are not computed frequency totals or claims of qualification. */
export function validatePracticeValues(configuration: DomainConfiguration, input: ActivityCreateInput): boolean {
  const supplied = Object.keys(input.values);
  if (!supplied.length) return configuration.measurements.length > 0 &&
    configuration.measurements.every(measurement => measurement.kind === "frequency");
  let practiceAmount = false;
  for (const key of supplied) {
    const m = configuration.measurements.find(measurement => measurement.measurementId === key), value = input.values[key];
    if (!m || m.kind === "frequency" || m.scope.kind !== "per_event" || m.valueType !== value.valueType ||
      m.unit.unitId !== value.unitId || m.taskVariantId !== value.taskVariantId) return false;
    if (m.role === "practice") practiceAmount = true;
  }
  return practiceAmount;
}

export const ActivityViewSchema = z.object({
  activityId: ActivityIdSchema, ownerUserId: ActivityIdSchema, domainId: ActivityIdSchema, policyVersionId: ActivityIdSchema,
  practiceEvent: z.literal(true), observedAt: ActivityTimestampSchema, values: ActivityValuesSchema,
  notes: z.string().max(4000).optional(), context: ActivityContextSchema.optional(),
  deletedAt: ActivityTimestampSchema.nullable(), configuration: DomainConfigurationSchema,
  stateFingerprint: ActivityStateFingerprintSchema,
  scoreAvailability: z.literal("not_calculated"), attainmentAvailability: z.literal("not_calculated"),
}).strict().superRefine((value, ctx) => {
  const c = value.configuration;
  if (c.ownerUserId !== value.ownerUserId || c.domainId !== value.domainId || c.policyVersionId !== value.policyVersionId)
    ctx.addIssue({ code: "custom", message: "Activity and configuration identities must agree." });
});
export type ActivityView = z.infer<typeof ActivityViewSchema>;
export const ActivityMutationResultSchema = z.object({ mutationKey:ActivityIdSchema,changed: z.boolean(), operation: ActivityMutationOperationSchema,
  activity: ActivityViewSchema, appliedStateFingerprint: ActivityStateFingerprintSchema }).strict();
export type ActivityMutationResult = z.infer<typeof ActivityMutationResultSchema>;
export const ActivityCreateResultSchema = z.object({ created: z.boolean(), submissionKey:ActivitySubmissionKeySchema,activity: ActivityViewSchema }).strict();
export const ActivitySubmissionResultSchema = z.object({submissionKey:ActivitySubmissionKeySchema,activity:ActivityViewSchema}).strict();
export type ActivitySubmissionResult = z.infer<typeof ActivitySubmissionResultSchema>;
export const ActivityListResultSchema = z.object({ activities: z.array(ActivityViewSchema).max(100),
  nextCursor: z.string().max(1024).nullable() }).strict();
export const ActivityEligibilitySchema = z.discriminatedUnion("canCreate", [
  z.object({ domainId: ActivityIdSchema, canCreate: z.literal(true), reason: z.null(), effectivePolicyVersionId: ActivityIdSchema }).strict(),
  z.object({ domainId: ActivityIdSchema, canCreate: z.literal(false),
    reason: z.enum(["legacy_writer", "inactive", "no_effective_policy"]) }).strict(),
]);
export type ActivityEligibility = z.infer<typeof ActivityEligibilitySchema>;
