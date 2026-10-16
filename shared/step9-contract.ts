import { z } from "zod";

/**
 * Step 9: declarative future-scoring contract. Not a runtime evaluator.
 * No storage, database, wall clock, routes or UI imports.
 */
export const STEP9_RULES = Object.freeze({
  version: "completed-logical-days-v1",
  windows: [7, 14, 28, 42] as const,
  dayBoundary: "user-timezone-and-civil-day-start",
  currentDay: "separate-not-in-score",
  coverage: "completed-eligible-day-equivalents",
  expected: "period-target * eligible-day-equivalents / target-period-days",
  qualification: "one-individual-event-must-satisfy-entire-predicate",
  frequency: "distinct-qualified-logical-days",
  quantity: "all-in-scope-amounts-including-below-qualification",
  health: "mean-of-individually-capped-components",
  seedWeights: { quantity: 0.5, frequency: 0.5 },
  healthyAt: 90, needsAttentionAt: 70, warningAt: 50,
  mandatoryBelow: 50,
  mandatoryZero: "critical",
  overachievement: "minimum-uncapped-component-percent",
  rounding: "display-only",
  budget: "absent",
  approvedBreaks: "reduce-eligible-expectations-preserve-continuity",
  identity: "organization-owner-domain-policy-measurement-unit-task-variant",
  units: "no-implicit-conversion",
  adaptedTargets: "never-rewrite-qualification-or-history",
  references: "not-personal-target-denominators",
  participation: "explicit-policy-scoped-approval-never-inferred-from-measurement-shape",
} as const);

export const UnavailableReasonSchema = z.enum([
  "no_eligible_coverage", "coverage_unknown", "qualification_unspecified",
  "target_missing", "target_zero", "direction_unapproved", "aggregation_unapproved",
  "percentage_rule_unapproved", "policy_boundary_unsettled", "adaptation_selection_unsettled",
  "break_activity_credit_unsettled", "invalid_context",
  "participation_unapproved", "measurement_role_unapproved", "target_conditions_unapproved",
]);
export type UnavailableReason = z.infer<typeof UnavailableReasonSchema>;
/** Separate future-only approval, not a mutation of stored domain configuration. */
export const SeedParticipationSchema = z.object({
  recipe: z.literal("duration-plus-distinct-qualifying-days-v1"),
  approved: z.literal(true),
  organizationId: z.string().min(1), ownerUserId: z.string().min(1),
  domainId: z.string().min(1), policyVersionId: z.string().min(1),
  targetId: z.string().min(1),
  components: z.tuple([
    z.object({kind:z.literal("quantity"),measurementId:z.string().min(1),weight:z.literal(0.5),mandatory:z.literal(true)}).strict(),
    z.object({kind:z.literal("frequency"),measurementId:z.string().min(1),weight:z.literal(0.5),mandatory:z.literal(true)}).strict(),
  ]),
}).strict().refine(p=>p.components[0].measurementId!==p.components[1].measurementId,
  "Recipe requires two distinct explicitly participating measurements");
export type SeedParticipation = z.infer<typeof SeedParticipationSchema>;
const amount = z.number().finite().nonnegative();
const Component = z.object({
  kind: z.enum(["quantity", "frequency"]),
  actual: amount, expected: z.number().finite().positive(),
  uncappedPercent: amount, cappedPercent: amount.max(100),
  weight: z.literal(0.5), mandatory: z.literal(true),
}).strict();
export const ConditionSchema = z.enum(["Healthy", "Needs Attention", "Warning", "Critical"]);
/**
 * Validates independently supplied future results; never calculates a user's
 * score. Unavailable has no numeric score/condition/budget masquerading as zero.
 * These approved two-component weights do not silently apply to custom measures.
 */
export const FutureSeedResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("available"), eligibleDays: z.number().finite().positive(),
    participation: SeedParticipationSchema,
    components: z.tuple([Component.extend({kind:z.literal("quantity")}), Component.extend({kind:z.literal("frequency")})]),
    score: amount.max(100), condition: ConditionSchema,
    overachievementPercent: amount,
  }).strict(),
  z.object({ status:z.literal("unavailable"), reason:UnavailableReasonSchema }).strict(),
]).superRefine((result,ctx) => {
  if (result.status !== "available") return;
  const fail = (path:string) => ctx.addIssue({code:z.ZodIssueCode.custom,path:[path],message:"Contradicts approved Step 9 arithmetic"});
  const close = (a:number,b:number) => Number.isFinite(a) && Number.isFinite(b) &&
    Math.abs(a-b) <= 1e-9 * Math.max(1,Math.abs(a),Math.abs(b));
  for (const c of result.components) {
    if (!close(c.uncappedPercent,100*c.actual/c.expected) ||
        !close(c.cappedPercent,Math.min(100,c.uncappedPercent))) fail("components");
  }
  if (!close(result.score,(result.components[0].cappedPercent+result.components[1].cappedPercent)/2)) fail("score");
  if (!close(result.overachievementPercent,Math.min(...result.components.map(c=>c.uncappedPercent)))) fail("overachievementPercent");
  const minimum = Math.min(...result.components.map(c=>c.uncappedPercent));
  const base = result.score >= 90 ? "Healthy" : result.score >= 70 ? "Needs Attention" : result.score >= 50 ? "Warning" : "Critical";
  const guarded = minimum === 0 ? "Critical" : minimum < 50 && (base === "Healthy" || base === "Needs Attention") ? "Warning" : base;
  if (result.condition !== guarded) fail("condition");
});
export type FutureSeedResult = z.infer<typeof FutureSeedResultSchema>;
