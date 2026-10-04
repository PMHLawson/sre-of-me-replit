/**
 * A1.1 contract only. No evaluator, persistence derivation, policy selection,
 * trend classifier, routes, storage or migrations are implemented here.
 * A1.2 produces ScoredEvaluation; A1.3 may enrich it with sustained state.
 */
import { z } from "zod";

export const dimensionIds = ["duration", "frequency"] as const;
export type DimensionId = typeof dimensionIds[number];
export const conditionBandEnum = ["HEALTHY", "NEEDS_ATTENTION", "WARNING", "CRITICAL"] as const;
export type ConditionBand = typeof conditionBandEnum[number];
export const conditionBandInputEnum = [...conditionBandEnum, "PAGE"] as const;
export type ConditionBandInput = typeof conditionBandInputEnum[number];
export const persistenceStateEnum = ["NOMINAL", "ADVISORY", "WARNING", "BREACH", "CRITICAL"] as const;
export type PersistenceState = typeof persistenceStateEnum[number];
export const overachievementTierV2Enum = ["NONE", "COMMITTED", "PEAK", "ELITE"] as const;
export type OverachievementTierV2 = typeof overachievementTierV2Enum[number];
export type Attention = 0 | 1 | 2 | 3 | 4;
export const ATTENTION_MAP = {
  HEALTHY: 0, NEEDS_ATTENTION: 1, WARNING: 2, CRITICAL: 4,
} as const satisfies Record<ConditionBand, Attention>;
export const PERSISTENCE_ATTENTION_MAP = {
  NOMINAL: 0, ADVISORY: 1, WARNING: 2, BREACH: 3, CRITICAL: 4,
} as const satisfies Record<PersistenceState, Attention>;

// Pure cross-ladder contract operations; they do not derive sustained state.
export function normalizeConditionBand(band: ConditionBandInput): ConditionBand {
  return band === "PAGE" ? "CRITICAL" : band;
}
export function resolveAttention(condition: ConditionBand, persistence?: PersistenceState): Attention {
  return Math.max(ATTENTION_MAP[condition], persistence === undefined ? 0 : PERSISTENCE_ATTENTION_MAP[persistence]) as Attention;
}
export const TREND_STABILITY_EPSILON = 2;
export const trendDirectionEnum = ["improving", "stable", "declining"] as const;
// Includes joint and opposing component movement, not just a single dimension.
export const trendDriverEnum = ["frequency", "duration", "both", "offsetting"] as const;
export const DEFAULT_CONDITION_BANDS = [
  { band: "HEALTHY", minScore: 90, attentionLevel: 0 },
  { band: "NEEDS_ATTENTION", minScore: 70, attentionLevel: 1 },
  { band: "WARNING", minScore: 50, attentionLevel: 2 },
  { band: "CRITICAL", minScore: 0, attentionLevel: 4 },
] as const;
export const DEFAULT_GUARDRAIL = {
  zeroMandatoryForcesCritical: true,
  mandatoryCapThreshold: 0.5,
  mandatoryCapBand: "WARNING",
} as const;

export const policyVersionSchema = z.object({
  id: z.string().min(1),
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  calculationVersion: z.number().int().positive(),
}).strict();
export type PolicyVersion = z.infer<typeof policyVersionSchema>;
// Retained historical proposal; not used on pre-effective synthetic windows.
export const POLICY_V2: PolicyVersion = { id: "2.0.0", effectiveDate: "2026-08-16", calculationVersion: 1 };
export const boundaryParamsSchema = z.object({
  timezone: z.string().min(1),
  dayStartHour: z.number().int().min(0).max(23),
  includeCurrentDay: z.boolean().default(false),
}).strict();
export type BoundaryParams = z.infer<typeof boundaryParamsSchema>;
export const DEFAULT_BOUNDARY: BoundaryParams = {
  timezone: "America/New_York", dayStartHour: 4, includeCurrentDay: false,
};
export const dimensionDefinitionSchema = z.object({
  id: z.enum(dimensionIds),
  unit: z.enum(["minutes", "logical-blocks"]),
  aggregation: z.enum(["sum", "distinct-qualified-blocks"]),
  floor: z.number().finite().nonnegative(),
  weight: z.number().finite().min(0).max(1),
  mandatory: z.boolean(),
}).strict();
export type DimensionDefinition = z.infer<typeof dimensionDefinitionSchema>;
export const SEED_DIMENSIONS = {
  // Sum ALL included minutes, even subfloor and deviation-time observations.
  duration: { id: "duration", unit: "minutes", aggregation: "sum", floor: 0, weight: 0.5, mandatory: true },
  // One distinct completed block with at least one individually qualifying
  // observation. Two subfloor observations NEVER combine to qualify.
  frequency: { id: "frequency", unit: "logical-blocks", aggregation: "distinct-qualified-blocks", floor: 1, weight: 0.5, mandatory: true },
} as const satisfies Record<DimensionId, DimensionDefinition>;
export const dimensionValuesSchema = z.object({
  duration: z.number().finite().nonnegative(),
  frequency: z.number().finite().nonnegative(),
}).strict();
export type DimensionValues = z.infer<typeof dimensionValuesSchema>;

/** Single algebra: B>0, W>0, 0<=E<=W; expected=baseTarget*E/B.
 * E may exceed B and may be fractional. No intermediate rounding.
 * E=0 is a valid INPUT/proration contract, but its scoring is UNRESOLVED.
 */
export const prorationBasisSchema = z.object({
  baseDays: z.number().finite().positive(),
  windowDays: z.number().finite().positive(),
  eligibleDays: z.number().finite().nonnegative(),
}).strict().refine(x => x.eligibleDays <= x.windowDays, "E must not exceed W");
export type ProrationBasis = z.infer<typeof prorationBasisSchema>;
const instant = z.string().datetime({ offset: true });
export const deviationIntervalSchema = z.object({
  id: z.string().min(1), startAt: instant, endAt: instant,
}).strict().refine(x => Date.parse(x.endAt) > Date.parse(x.startAt), "Positive interval required");
export const blockProrationSchema = z.object({
  blockId: z.string(), startAt: instant, endAt: instant,
  // Union coverage within this logical block; overlaps must not double count.
  deviatedFraction: z.number().finite().min(0).max(1),
}).strict();
export const observationSchema = z.object({
  id: z.string().min(1), timestamp: instant,
  durationMinutes: z.number().finite().nonnegative(),
}).strict();
export const observationSourceBindingSchema = z.object({
  kind: z.literal("observations"),
  sourceType: z.enum(["fixture", "synthetic", "sessions-db"]),
  fixtureId: z.string().min(1), observationIds: z.array(z.string()),
  fetchedAt: instant,
}).strict();
export const sourceBindingSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("abstract"), sourceType: z.literal("fixture"),
    fixtureId: z.string().min(1),
    // No fabricated observation IDs in abstract algebra examples.
  }).strict(),
  observationSourceBindingSchema,
]);
export type SourceBinding = z.infer<typeof sourceBindingSchema>;
export const policyInputSchema = z.object({
  version: policyVersionSchema,
  baseDays: z.number().finite().positive(),
  baseTargets: dimensionValuesSchema,
  sessionFloor: z.number().finite().positive(),
  dimensions: z.tuple([dimensionDefinitionSchema, dimensionDefinitionSchema]),
}).strict().superRefine((p, ctx) => {
  dimensionIds.forEach((id, index) => {
    const d = p.dimensions[index], seed = SEED_DIMENSIONS[id];
    if (d.id !== id || d.unit !== seed.unit || d.aggregation !== seed.aggregation ||
        d.weight !== seed.weight || d.mandatory !== seed.mandatory ||
        d.floor !== (id === "frequency" ? p.sessionFloor : 0))
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["dimensions", index], message: "Settled seed dimension semantics required" });
  });
});
/** Raw input has NO actuals, eligible total or prorated targets.
 * A1.2 derives those from timestamps and exact deviation interval evidence.
 * The supplied version is already selected; service-level selection is not A1.2.
 */
export const rawEvaluationInputSchema = z.object({
  domain: z.string().min(1), evaluatedAt: instant,
  windowDays: z.number().int().positive(),
  boundary: boundaryParamsSchema, policy: policyInputSchema,
  observations: z.array(observationSchema),
  deviations: z.array(deviationIntervalSchema),
  provenance: observationSourceBindingSchema,
}).strict().superRefine((input, ctx) => {
  const ids = input.observations.map(o => o.id);
  if (new Set(ids).size !== ids.length ||
      input.provenance.observationIds.length !== ids.length ||
      new Set(input.provenance.observationIds).size !== ids.length ||
      input.provenance.observationIds.some(id => !ids.includes(id)))
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["provenance"], message: "Provenance must identify exactly the supplied unique observations" });
});
export type RawEvaluationInput = z.infer<typeof rawEvaluationInputSchema>;
export const componentEvidenceSchema = z.object({
  dimensionId: z.enum(dimensionIds), actual: z.number().finite().nonnegative(),
  expected: z.number().finite().positive(),
  // 100*actual/expected, uncapped and UNROUNDED.
  rawScore: z.number().finite().nonnegative(),
  cappedScore: z.number().finite().min(0).max(100),
  weight: z.number().finite().min(0).max(1), isMandatory: z.boolean(), isZero: z.boolean(),
}).strict();
export const scoredEvaluationSchema = z.object({
  domain: z.string(), windowDays: z.number().int().positive(),
  actual: dimensionValuesSchema, expected: dimensionValuesSchema,
  // No scored result for E=0 until that policy question is answered.
  eligibleWindowBasis: z.number().finite().positive(),
  policyVersion: policyVersionSchema, calculationVersion: z.number().int().positive(),
  boundary: boundaryParamsSchema,
  componentEvidence: z.array(componentEvidenceSchema).length(2),
  // Sum(weight*capped component); guardrails NEVER change numeric score.
  domainScore: z.number().finite().min(0).max(100),
  conditionBand: z.enum(conditionBandEnum),
  // Condition-only attention. Cross-ladder resolved attention is A1.3 enrichment.
  attentionLevel: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(4)]),
  // Triggered even when condition was already WARNING/CRITICAL.
  guardrailFired: z.boolean(), guardrailDimensions: z.array(z.enum(dimensionIds)),
  guardrailReason: z.string().optional(),
  overachievementRaw: z.number().finite().nonnegative(),
  overachievementTier: z.enum(overachievementTierV2Enum),
  sourceBinding: sourceBindingSchema,
  consumedObservationIds: z.array(z.string()),
  excludedObservationIds: z.array(z.string()),
  today: z.object({ observationIds: z.array(z.string()), durationMinutes: z.number().nonnegative() }).strict(),
  proration: prorationBasisSchema,
  blockProration: z.array(blockProrationSchema),
}).strict().refine(x => !(x.overachievementRaw > 100 && x.overachievementRaw < 101),
  "OA 100<x<101 is unresolved; do not fabricate a scored result");
export type ScoredEvaluation = z.infer<typeof scoredEvaluationSchema>;
export const trendEvidenceSchema = z.object({
  direction: z.enum(trendDirectionEnum), driver: z.enum(trendDriverEnum),
  deltaPercentagePoints: z.number().finite(),
  explanation: z.string().min(1),
}).strict();
// A1.3 sustained-condition state; NOT a storage lifecycle.
export type EvaluationResult = ScoredEvaluation & {
  persistenceState?: PersistenceState;
  resolvedAttention?: Attention;
  trend?: z.infer<typeof trendEvidenceSchema>;
};
export const invalidBackdateEvidenceSchema = z.object({
  kind: z.literal("invalid-backdate"), reason: z.literal("EFFECTIVE_DATE_BEFORE_REQUEST"),
  requestedAt: instant, proposedEffectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  existingVersion: policyVersionSchema,
}).strict().refine(x => x.proposedEffectiveDate < x.requestedAt.slice(0, 10), "Backdate evidence must really precede request");
export type InvalidBackdateEvidence = z.infer<typeof invalidBackdateEvidenceSchema>;
export const UNRESOLVED_POLICY_QUESTIONS = ["OA 100<x<101", "E=0 scoring"] as const;