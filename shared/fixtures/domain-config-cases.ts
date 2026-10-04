import type { DomainConfiguration, Observation, MeasurementDefinition, TypedCondition } from "../domain-config";

/** Invented contract data only. No owners/records are fetched or migrated. */
const perEvent = { kind: "per_event" } as const;
export const MEASUREMENTS: MeasurementDefinition[] = [
  { measurementId: "m-duration", displayName: "Practice time", meaning: "Elapsed practice minutes",
    kind: "duration", role: "practice", unit: { unitId: "minute", dimension: "time" },
    valueType: "number", aggregation: "sum", comparisonDirection: "higher_is_better", scope: perEvent },
  { measurementId: "m-repetitions", displayName: "Repetitions", meaning: "Completed standard repetitions",
    kind: "repetitions", role: "practice", unit: { unitId: "rep", dimension: "count" },
    valueType: "integer", aggregation: "sum", comparisonDirection: "higher_is_better", scope: perEvent },
  { measurementId: "m-cupcakes", displayName: "Cupcakes", meaning: "Completed cupcakes",
    kind: "count", role: "practice", unit: { unitId: "cupcake", dimension: "count", customLabel: "cupcakes" },
    valueType: "integer", aggregation: "sum", comparisonDirection: "higher_is_better", scope: perEvent },
  { measurementId: "m-distance", displayName: "Distance", meaning: "Distance travelled in kilometres",
    kind: "quantity", role: "practice", unit: { unitId: "kilometre", dimension: "distance" },
    valueType: "number", aggregation: "sum", comparisonDirection: "higher_is_better", scope: perEvent },
  { measurementId: "m-completion", displayName: "Completed", meaning: "Whether the declared task was completed",
    kind: "completion", role: "practice", unit: { unitId: "completed", dimension: "boolean" },
    valueType: "boolean", aggregation: "last", comparisonDirection: "equal", scope: perEvent },
];
export function conditionFor(m: MeasurementDefinition, value: number | boolean): TypedCondition {
  const common = { measurementId: m.measurementId, unitId: m.unit.unitId,
    basis: structuredClone(m.scope), ...(m.taskVariantId ? { taskVariantId: m.taskVariantId } : {}) };
  if (m.valueType === "boolean") return { ...common, valueType: "boolean", constraint: { operator: "eq", value: Boolean(value) } };
  return { ...common, valueType: m.valueType, constraint: { operator: "gte", value: Number(value) } };
}
export function configurationFor(id: string, measurement: MeasurementDefinition, chosen: number | boolean): DomainConfiguration {
  const m = structuredClone(measurement);
  return {
    schemaVersion: 1, organizationId: "org-fixture-A", ownerUserId: "owner-fixture-A",
    domainId: `domain-${id}`, policyVersionId: `policy-${id}-v1`, revision: 1,
    effectiveFrom: "2026-01-01T00:00:00Z", displayName: "Practice",
    templateLineage: { templateId: "template-fixture", templateVersionId: "template-v1", revision: 1 },
    goal: { intent: "unknown", desiredCapability: "Chosen practice capability" },
    boundary: { timezone: "America/New_York", dayStartHour: 4 },
    taskVariants: [], measurements: [m],
    targets: { normal: { targetId: `target-${id}-normal`, conditions: [conditionFor(m, chosen)] } },
    references: [], review: { anchorAt: "2026-01-01T00:00:00Z", intervalDays: 84 },
  };
}
export function observationFor(c: DomainConfiguration, id: string, value: number | boolean): Observation {
  const m = c.measurements[0], common = { unitId: m.unit.unitId, ...(m.taskVariantId ? { taskVariantId: m.taskVariantId } : {}) };
  const supplied = m.valueType === "boolean"
    ? { ...common, valueType: "boolean" as const, value: Boolean(value) }
    : { ...common, valueType: m.valueType, value: Number(value) };
  return { schemaVersion: 1, observationId: id, organizationId: c.organizationId, ownerUserId: c.ownerUserId,
    domainId: c.domainId, policyVersionId: c.policyVersionId, observedAt: "2026-01-10T12:00:00Z",
    values: { [m.measurementId]: supplied } };
}
export const MEASUREMENT_CASES = MEASUREMENTS.map((m, i) => {
  const chosen = [20, 20, 12, 2.5, true][i], configuration = configurationFor(`B-${i}`, m, chosen);
  return { id: `B-${m.kind}`, configuration, observation: observationFor(configuration, `observation-B-${i}`, chosen) };
});
export const COOKING_A = configurationFor("A-01", MEASUREMENTS[2], 12);
COOKING_A.displayName = "Cooking";
export const COOKING_B = configurationFor("A-02", MEASUREMENTS[0], 30);
COOKING_B.displayName = "Cooking";
COOKING_B.organizationId = "org-fixture-B";
COOKING_B.ownerUserId = "owner-fixture-B";
export const COOKING_OBSERVATIONS = [observationFor(COOKING_A, "event-A", 12), observationFor(COOKING_B, "event-B", 30)];

export const FREQUENCY_CASES = (["events", "distinct_days"] as const).map((countBy, index) => {
  const config = configurationFor(`C-${index}`, MEASUREMENTS[4], true);
  const frequency: MeasurementDefinition = {
    measurementId: `m-frequency-${index}`, displayName: "Practice frequency", meaning: `Frequency of ${countBy}`,
    kind: "frequency", role: "practice", unit: { unitId: countBy === "events" ? "event" : "day", dimension: countBy === "events" ? "events" : "days" },
    valueType: "integer", aggregation: "count", comparisonDirection: "higher_is_better",
    countBy, scope: { kind: "period", windowDays: 7 },
  };
  config.measurements.push(frequency);
  config.targets.normal.conditions = [conditionFor(frequency, countBy === "events" ? 3 : 1)];
  const observations = ["2026-08-01T13:00:00Z", "2026-08-01T16:00:00Z", "2026-08-01T20:00:00Z"].map((timestamp, n) => ({
    ...observationFor(config, `C-${index}-event-${n}`, true), observedAt: timestamp,
  }));
  return { id: `C-${countBy}`, configuration: config, observations,
    futureExpectation: { status: "future-evaluator-only", events: 3, distinctDays: 1,
      localDay: "2026-08-01", note: "Declared oracle only; bucketing is neither implemented nor tested by this contract slice." } };
});
export const ADAPTED = configurationFor("E", MEASUREMENTS[1], 20);
ADAPTED.goal = { intent: "develop", desiredCapability: "Complete twenty standard repetitions",
  currentCapability: { assessedAt: "2026-01-04T12:00:00Z", assessment: "Eight repetitions in the synthetic scenario" } };
ADAPTED.references = [
  { referenceId: "reference-E-develop", purpose: "develop", status: "known",
    applicability: { description: "Standard task under the declared conditions" },
    evidence: { category: "published", source: { description: "Invented example, not verified evidence", url: "https://example.invalid/reference" },
      review: { status: "unreviewed" }, confidence: "unknown" },
    conditions: [conditionFor(ADAPTED.measurements[0], 20)] },
  { referenceId: "reference-E-maintain", purpose: "maintain", status: "unknown",
    applicability: { description: "Maintenance threshold is unknown" },
    evidence: { category: "unspecified", review: { status: "unreviewed" }, confidence: "unknown" } },
];
ADAPTED.targets.adapted = {
  target: { targetId: "target-E-adapted", conditions: [conditionFor(ADAPTED.measurements[0], 8)] },
  effectiveFrom: "2026-01-05T00:00:00Z", duration: "temporary", reviewAt: "2026-01-08T00:00:00Z",
};
ADAPTED.targets.stretch = { targetId: "target-E-stretch", conditions: [conditionFor(ADAPTED.measurements[0], 25)] };
ADAPTED.targets.upperRecovery = { conditions: [{ ...conditionFor(ADAPTED.measurements[0], 30), valueType: "integer", constraint: { operator: "lte", value: 30 } }],
  guidance: "Synthetic practice guidance, not a medical inference" };
ADAPTED.qualification = { kind: "all", predicates: [
  { kind: "condition", condition: conditionFor(ADAPTED.measurements[0], 1) },
  { kind: "any", predicates: [{ kind: "condition", condition: conditionFor(ADAPTED.measurements[0], 2) }] },
] };
export const ADAPTED_OBSERVATION = observationFor(ADAPTED, "observation-E-eight", 8);
export const ADAPTED_FUTURE_EXPECTATION = {
  status: "future-evaluator-only", personalPercent: 100, referencePercent: 40,
  advisory: "The chosen current target is below the declared reference.",
  asOf: "2026-01-20T00:00:00Z",
  note: "No percentages, health conclusions, advisory rendering or review scheduling are computed here.",
};
export const MAINTAIN = structuredClone(ADAPTED);
MAINTAIN.domainId = "domain-D-maintain";
MAINTAIN.policyVersionId = "policy-D-maintain-v1";
MAINTAIN.goal.intent = "maintain";
export const PERIOD = configurationFor("F-period", { ...MEASUREMENTS[0], scope: { kind: "period", windowDays: 7 } }, 100);
export const AGGREGATED_TARGET_CASES = [
  { id: "session-minutes-weekly-target", measurement: MEASUREMENTS[0], perEvent: 15, weekly: 105 },
  { id: "session-cupcakes-weekly-target", measurement: MEASUREMENTS[2], perEvent: 2, weekly: 12 },
].map(example => {
  const configuration = configurationFor(`F-${example.id}`, example.measurement, example.perEvent);
  const perSession = conditionFor(configuration.measurements[0], example.perEvent);
  configuration.qualification = { kind: "condition", condition: perSession };
  configuration.references = [{
    referenceId: `reference-${example.id}`, purpose: "develop", status: "known",
    applicability: { description: "Per-session reference, distinct from the cumulative weekly choice" },
    evidence: { category: "personal", review: { status: "unreviewed" }, confidence: "unknown" },
    conditions: [structuredClone(perSession)],
  }];
  configuration.targets.normal.conditions = [{
    ...conditionFor(configuration.measurements[0], example.weekly),
    basis: { kind: "period", windowDays: 7 },
    periodAggregation: { sourceBasis: "per_event", method: "sum" },
  }];
  return { id: example.id, configuration, perEventThreshold: example.perEvent, weeklyTarget: example.weekly,
    observation: observationFor(configuration, `event-${example.id}`, example.perEvent),
    note: "Declared permissible aggregation metadata only; no aggregation or bucketing is executed." };
});
export const VARIANT = configurationFor("F-variant", { ...MEASUREMENTS[1], taskVariantId: "variant-assisted" }, 10);
VARIANT.taskVariants = [{ variantId: "variant-assisted", displayName: "Assisted",
  taskConditions: [{ conditionId: "support", description: "Declared assistance is used" }] }];
export const LOWER_RANGE = configurationFor("F-lower", { ...MEASUREMENTS[3],
  kind: "quantity", valueType: "number",
  measurementId: "m-errors", meaning: "Nonnegative measured error", unit: { unitId: "error-unit", dimension: "quantity" },
  comparisonDirection: "lower_is_better", aggregation: "mean" }, 2);
LOWER_RANGE.targets.normal.conditions = [{ ...conditionFor(LOWER_RANGE.measurements[0], 2),
  valueType: "number", constraint: { operator: "range", min: 0.5, max: 2 } }];
export const REVISION_1 = structuredClone(MEASUREMENT_CASES[0].configuration);
export const REVISION_2: DomainConfiguration = { ...structuredClone(REVISION_1),
  policyVersionId: "policy-G-v2", previousVersionId: REVISION_1.policyVersionId, revision: 2,
  effectiveFrom: "2026-02-01T00:00:00Z", displayName: "Updated mutable label" };
export const HISTORICAL_OBSERVATION = observationFor(REVISION_1, "observation-G-historical", 0);
export const UNOWNED_LEGACY = {
  id: "G-unowned-legacy-evidence", legacySlug: "music", ownerUserId: null, durationMinutes: 15,
  migrationStatus: "unresolved", note: "No owner is inferred; this is not a valid owned configuration or observation.",
};
export const LEGACY_MAPPINGS = (["martial-arts", "meditation", "fitness", "music"] as const).map((legacySlug, i) => {
  const configuration = configurationFor(`H-${i}`, { ...MEASUREMENTS[0], measurementId: `legacy-duration-${i}` }, 20);
  configuration.ownerUserId = "synthetic-legacy-owner";
  configuration.goal.intent = "develop";
  return { id: `H-${i}`, legacySlug, legacyField: "durationMinutes", mappingStatus: "synthetic-proposal-only",
    configuration, note: "Owner-specific legacy intent; no user-wide default and no real migration." };
});
export const EARLY_REVIEW = structuredClone(MEASUREMENT_CASES[0].configuration);
EARLY_REVIEW.review.nextReviewAt = "2026-01-15T00:00:00Z";