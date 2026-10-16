import { describe, expect, it, vi } from "vitest";
import {
  DomainConfigurationSchema, ObservationSchema, ConfigurationBundleSchema,
  validateObservationContext, validateProspectiveRevision,
  type DomainConfiguration, type Observation, type ConfigurationBundle, type ValidationResult,
} from "./domain-config";
import {
  MEASUREMENTS, MEASUREMENT_CASES, COOKING_A, COOKING_B, COOKING_OBSERVATIONS,
  FREQUENCY_CASES, ADAPTED, ADAPTED_OBSERVATION, ADAPTED_FUTURE_EXPECTATION,
  MAINTAIN, PERIOD, AGGREGATED_TARGET_CASES, VARIANT, LOWER_RANGE, REVISION_1, REVISION_2, HISTORICAL_OBSERVATION,
  UNOWNED_LEGACY, LEGACY_MAPPINGS, EARLY_REVIEW, observationFor, conditionFor,
} from "./fixtures/domain-config-cases";

// Deliberately untyped mutation callback creates invalid boundary inputs.
function edited<T>(source: T, change: (draft: any) => void): T {
  const draft = structuredClone(source); change(draft); return draft;
}
function fails(result: ValidationResult, code?: string) {
  expect(result.success).toBe(false);
  if (result.success) throw new Error("Expected structured failure");
  expect(result.issues.length).toBeGreaterThan(0);
  for (const i of result.issues) {
    expect(Object.keys(i).sort()).toEqual(["code", "message", "path"]);
    expect(i.path.length).toBeGreaterThan(0); expect(i.code.length).toBeGreaterThan(0); expect(i.message.length).toBeGreaterThan(0);
  }
  if (code) expect(result.issues.some(i => i.code === code)).toBe(true);
}
function bundle(configurations: DomainConfiguration[], observations: Observation[] = []): ConfigurationBundle {
  return { schemaVersion: 1, configurations, observations };
}
function freeze(value: unknown): void {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
}
const allValid = [
  COOKING_A, COOKING_B, ...MEASUREMENT_CASES.map(c => c.configuration),
  ...FREQUENCY_CASES.map(c => c.configuration), ADAPTED, MAINTAIN, PERIOD, VARIANT, LOWER_RANGE,
  REVISION_1, REVISION_2, ...LEGACY_MAPPINGS.map(c => c.configuration), EARLY_REVIEW,
];
describe("A — independent same-name domains; referential consistency, not authentication", () => {
  it("accepts two Cooking labels with separate immutable IDs, owners and targets", () => {
    expect(COOKING_A.displayName).toBe(COOKING_B.displayName);
    expect(COOKING_A.domainId).not.toBe(COOKING_B.domainId);
    expect(COOKING_A.targets.normal).not.toEqual(COOKING_B.targets.normal);
    expect(ConfigurationBundleSchema.safeParse(bundle([COOKING_A, COOKING_B], COOKING_OBSERVATIONS)).success).toBe(true);
    expect(validateObservationContext(COOKING_A, COOKING_OBSERVATIONS[0])).toEqual({ success: true });
  });
  it.each(["organizationId", "ownerUserId", "domainId", "policyVersionId"])("rejects substitution of %s", key => {
    fails(validateObservationContext(COOKING_A, edited(COOKING_OBSERVATIONS[0], o => { o[key] = (COOKING_B as any)[key]; })), "context_mismatch");
  });
  it("cannot resolve cross-tenant observation by merely reusing another tenant's version ID", () => {
    expect(ConfigurationBundleSchema.safeParse(bundle([COOKING_A], [COOKING_OBSERVATIONS[1]])).success).toBe(false);
  });
});

describe("B — first executable measurement types and cross-product rejection", () => {
  it.each(MEASUREMENT_CASES)("$id round-trips without invented duration", ({ configuration, observation }) => {
    const c: DomainConfiguration = DomainConfigurationSchema.parse(JSON.parse(JSON.stringify(configuration)));
    const o: Observation = ObservationSchema.parse(JSON.parse(JSON.stringify(observation)));
    expect(c).toEqual(configuration); expect(o).toEqual(observation);
    expect(validateObservationContext(c, o)).toEqual({ success: true });
    expect(Object.keys(o.values)).toEqual([c.measurements[0].measurementId]);
    if (c.measurements[0].kind !== "duration") {
      expect(o).not.toHaveProperty("durationMinutes");
      expect(c.measurements.some(m => m.kind === "duration")).toBe(false);
    }
  });
  it("retains decimal distance and a custom cupcake count unit", () => {
    expect(MEASUREMENT_CASES[3].observation.values["m-distance"].value).toBe(2.5);
    expect(MEASUREMENT_CASES[2].configuration.measurements[0].unit.customLabel).toBe("cupcakes");
  });
  it.each([-1, -0.01, NaN, Infinity, -Infinity])("rejects numeric practice amount %s", value => {
    for (const c of MEASUREMENT_CASES.filter(c => c.configuration.measurements[0].valueType !== "boolean")) {
      fails(validateObservationContext(c.configuration, edited(c.observation, o => { o.values[c.configuration.measurements[0].measurementId].value = value; })));
    }
  });
  it.each([0.1, 1.5, 12.01])("rejects fractional reps/count %s", value => {
    for (const c of [MEASUREMENT_CASES[1], MEASUREMENT_CASES[2]])
      fails(validateObservationContext(c.configuration, edited(c.observation, o => { o.values[c.configuration.measurements[0].measurementId].value = value; })));
  });
  for (const a of MEASUREMENT_CASES) for (const b of MEASUREMENT_CASES) if (a.id !== b.id) {
    it(`rejects supplied ${b.id} type/unit under ${a.id} identity`, () => {
      const o = edited(a.observation, o => { o.values[a.configuration.measurements[0].measurementId] = Object.values(b.observation.values)[0]; });
      fails(validateObservationContext(a.configuration, o));
    });
  }
  it("rejects unknown observation keys even when their value shape is otherwise valid", () => {
    fails(validateObservationContext(REVISION_1, edited(HISTORICAL_OBSERVATION, o => { o.values.unknown = Object.values(o.values)[0]; })), "unknown_measurement");
  });
});

describe("C — declared future frequency expectations, NOT a bucketing test", () => {
  it.each(FREQUENCY_CASES)("$id retains separate positive-window frequency semantics", c => {
    expect(DomainConfigurationSchema.safeParse(c.configuration).success).toBe(true);
    expect(c.configuration.boundary).toEqual({ timezone: "America/New_York", dayStartHour: 4 });
    expect(c.observations.map(o => o.observedAt)).toEqual(["2026-08-01T13:00:00Z", "2026-08-01T16:00:00Z", "2026-08-01T20:00:00Z"]);
    c.observations.forEach(o => expect(validateObservationContext(c.configuration, o)).toEqual({ success: true }));
    expect(c.futureExpectation).toMatchObject({ status: "future-evaluator-only", events: 3, distinctDays: 1 });
    expect(c.futureExpectation.note).toContain("neither implemented nor tested");
  });
  it.each([0, -1, 1.5, Infinity])("rejects frequency window %s", windowDays => {
    expect(DomainConfigurationSchema.safeParse(edited(FREQUENCY_CASES[0].configuration, c => {
      c.measurements[1].scope.windowDays = windowDays; c.targets.normal.conditions[0].basis.windowDays = windowDays;
    })).success).toBe(false);
  });
  it("rejects fractional frequency targets and distinct-day targets/ranges exceeding days", () => {
    for (const c of FREQUENCY_CASES) expect(DomainConfigurationSchema.safeParse(edited(c.configuration, x => { x.targets.normal.conditions[0].constraint.value = 1.5; })).success).toBe(false);
    const day = FREQUENCY_CASES[1].configuration;
    for (const constraint of [{ operator: "gte", value: 8 }, { operator: "range", min: 1, max: 8 }])
      expect(DomainConfigurationSchema.safeParse(edited(day, c => { c.targets.normal.conditions[0].constraint = constraint; })).success).toBe(false);
    expect(DomainConfigurationSchema.safeParse(edited(day, c => { c.targets.normal.conditions[0].constraint.value = 7; })).success).toBe(true);
    expect(DomainConfigurationSchema.safeParse(edited(FREQUENCY_CASES[0].configuration, c => { c.targets.normal.conditions[0].constraint.value = 20; })).success).toBe(true);
  });
});

describe("D/E — intent, references and independent adapted choice", () => {
  it("round-trips develop and maintain distinctly, unknown and general wellbeing without inferred goals", () => {
    expect(DomainConfigurationSchema.parse(ADAPTED).goal.intent).toBe("develop");
    expect(DomainConfigurationSchema.parse(MAINTAIN).goal.intent).toBe("maintain");
    for (const intent of ["unknown", "general_wellbeing"])
      expect(DomainConfigurationSchema.parse(edited(ADAPTED, c => { c.goal.intent = intent; })).goal.intent).toBe(intent);
    expect(ADAPTED.goal).not.toHaveProperty("privateMotivation");
    expect(DomainConfigurationSchema.safeParse(edited(ADAPTED, c => { c.goal.privateMotivation = "Invented personal reason"; })).success).toBe(true);
  });
  it("retains known develop and unknown maintenance, without treating URL as verified evidence", () => {
    const c = DomainConfigurationSchema.parse(ADAPTED);
    expect(c.references.map(r => [r.purpose, r.status])).toEqual([["develop", "known"], ["maintain", "unknown"]]);
    expect(c.references[0].evidence.source?.url).toBe("https://example.invalid/reference");
    expect(c.references[0].evidence.review).toEqual({ status: "unreviewed" });
    expect(c.references[0].evidence.confidence).toBe("unknown");
    expect(DomainConfigurationSchema.safeParse(edited(ADAPTED, x => { x.references[0].evidence.review = { status: "reviewed" }; })).success).toBe(false);
    expect(DomainConfigurationSchema.safeParse(edited(ADAPTED, x => { x.references[0].evidence.review = {
      status: "reviewed", reviewerId: "synthetic-reviewer", reviewedAt: "2026-01-02T00:00:00Z",
    }; })).success).toBe(true);
  });
  it("rejects invented unknown/not-applicable thresholds while accepting no-threshold metadata", () => {
    for (const status of ["unknown", "not_applicable"]) {
      const c = edited(ADAPTED, c => { c.references[1].status = status; });
      expect(DomainConfigurationSchema.safeParse(c).success).toBe(true);
      expect(DomainConfigurationSchema.safeParse(edited(c, c => { c.references[1].conditions = c.targets.normal.conditions; })).success).toBe(false);
    }
  });
  it("retains reference20/normal20/adapted8/actual8, intent, stretch and recovery independently", () => {
    const before = JSON.stringify([ADAPTED, ADAPTED_OBSERVATION]);
    expect(validateObservationContext(ADAPTED, ADAPTED_OBSERVATION)).toEqual({ success: true });
    const c = DomainConfigurationSchema.parse(ADAPTED);
    expect(c.targets.normal.conditions[0].constraint).toEqual({ operator: "gte", value: 20 });
    expect(c.references[0]).toMatchObject({ conditions: [{ constraint: { value: 20 } }] });
    expect(c.targets.adapted?.target.conditions[0].constraint).toEqual({ operator: "gte", value: 8 });
    expect(ADAPTED_OBSERVATION.values["m-repetitions"].value).toBe(8);
    expect(c.targets.stretch?.conditions[0].constraint).toEqual({ operator: "gte", value: 25 });
    expect(c.targets.upperRecovery?.conditions[0].constraint).toEqual({ operator: "lte", value: 30 });
    expect(c.goal.intent).toBe("develop");
    expect(ADAPTED_FUTURE_EXPECTATION).toMatchObject({ status: "future-evaluator-only", personalPercent: 100, referencePercent: 40 });
    expect(ADAPTED_FUTURE_EXPECTATION.advisory).toContain("below");
    expect(JSON.stringify([ADAPTED, ADAPTED_OBSERVATION])).toBe(before);
  });
});

describe("F — basis, task variants, direction/ranges and typed composition", () => {
  it.each(AGGREGATED_TARGET_CASES)("review F1 $id: SAME per-event measurement with distinct weekly sum target", c => {
    const parsed = DomainConfigurationSchema.parse(c.configuration);
    expect(parsed.measurements).toHaveLength(1);
    expect(parsed.measurements[0].scope).toEqual({ kind: "per_event" });
    expect(parsed.qualification).toMatchObject({ kind: "condition", condition: {
      measurementId: parsed.measurements[0].measurementId, basis: { kind: "per_event" },
      constraint: { value: c.perEventThreshold },
    } });
    expect(parsed.references[0]).toMatchObject({ conditions: [{
      measurementId: parsed.measurements[0].measurementId, basis: { kind: "per_event" },
      constraint: { value: c.perEventThreshold },
    }] });
    expect(parsed.targets.normal.conditions[0]).toMatchObject({
      measurementId: parsed.measurements[0].measurementId, basis: { kind: "period", windowDays: 7 },
      constraint: { value: c.weeklyTarget }, periodAggregation: { sourceBasis: "per_event", method: "sum" },
    });
    expect(validateObservationContext(parsed, c.observation)).toEqual({ success: true });
    expect(parsed.targets.normal.conditions[0].unitId).toBe(parsed.measurements[0].unit.unitId);
  });
  it.each([
    (c: any) => { delete c.targets.normal.conditions[0].periodAggregation; },
    (c: any) => { c.targets.normal.conditions[0].periodAggregation.method = "mean"; },
    (c: any) => { c.targets.normal.conditions[0].periodAggregation.sourceBasis = "period"; },
    (c: any) => { c.targets.normal.conditions[0].periodAggregation.expression = "sum(x)"; },
    (c: any) => { c.targets.normal.conditions[0].unitId = "hour"; },
    (c: any) => { c.targets.normal.conditions[0].basis = { kind: "per_event" }; },
    (c: any) => { c.targets.normal.conditions[0].basis.windowDays = 0; },
    (c: any) => { c.measurements[0].aggregation = "mean"; },
    (c: any) => { c.measurements[0].scope = { kind: "period", windowDays: 7 }; },
  ])("review F1 rejects unsupported aggregation/basis/unit combination %#", change => {
    expect(DomainConfigurationSchema.safeParse(edited(AGGREGATED_TARGET_CASES[0].configuration, change)).success).toBe(false);
  });
  it("review F1 does not grant aggregation to booleans or mismatched frequency windows", () => {
    const bool = edited(MEASUREMENT_CASES[4].configuration, c => {
      c.targets.normal.conditions[0].basis = { kind: "period", windowDays: 7 };
      c.targets.normal.conditions[0].periodAggregation = { sourceBasis: "per_event", method: "sum" };
    });
    expect(DomainConfigurationSchema.safeParse(bool).success).toBe(false);
    for (const c of FREQUENCY_CASES) for (const windowDays of [7, 14]) {
      const invalid = edited(c.configuration, x => {
        x.targets.normal.conditions[0].basis.windowDays = windowDays;
        x.targets.normal.conditions[0].periodAggregation = { sourceBasis: "per_event", method: "sum" };
      });
      expect(DomainConfigurationSchema.safeParse(invalid).success).toBe(false);
    }
  });
  it.each([PERIOD, VARIANT, LOWER_RANGE])("round-trips $domainId without implicit comparison", c => {
    expect(DomainConfigurationSchema.parse(c)).toEqual(c);
  });
  it.each(["normal", "stretch", "adapted", "upperRecovery", "reference", "qualification"])(
    "resolves every %s condition against compatible definitions", location => {
      const change = (c: any): any => location === "normal" ? c.targets.normal.conditions[0]
        : location === "stretch" ? c.targets.stretch.conditions[0]
        : location === "adapted" ? c.targets.adapted.target.conditions[0]
        : location === "upperRecovery" ? c.targets.upperRecovery.conditions[0]
        : location === "reference" ? c.references[0].conditions[0]
        : c.qualification.predicates[0].condition;
      for (const [key, value] of [["measurementId", "absent"], ["unitId", "other-unit"],
        ["basis", { kind: "period", windowDays: 7 }], ["taskVariantId", "other-variant"],
        ["valueType", "number"]] as const) {
        expect(DomainConfigurationSchema.safeParse(edited(ADAPTED, c => { change(c)[key] = value; })).success).toBe(false);
      }
    },
  );
  it("keeps lower-is-better/range metadata and rejects reversed bounds", () => {
    expect(LOWER_RANGE.measurements[0].comparisonDirection).toBe("lower_is_better");
    expect(LOWER_RANGE.targets.normal.conditions[0].constraint).toEqual({ operator: "range", min: 0.5, max: 2 });
    expect(DomainConfigurationSchema.safeParse(edited(LOWER_RANGE, c => { c.targets.normal.conditions[0].constraint.min = 3; })).success).toBe(false);
  });
  it("rejects different period windows and task variants in observations/references", () => {
    expect(DomainConfigurationSchema.safeParse(edited(PERIOD, c => { c.targets.normal.conditions[0].basis.windowDays = 14; })).success).toBe(false);
    const o = observationFor(VARIANT, "variant-observation", 10);
    expect(validateObservationContext(VARIANT, o)).toEqual({ success: true });
    fails(validateObservationContext(VARIANT, edited(o, o => { delete o.values["m-repetitions"].taskVariantId; })), "variant_mismatch");
    expect(DomainConfigurationSchema.safeParse(edited(ADAPTED, c => { c.references[0].applicability.taskVariantId = "absent"; })).success).toBe(false);
  });
  it("accepts nested all/any predicates but rejects expression strings/empty groups", () => {
    expect(DomainConfigurationSchema.safeParse(ADAPTED).success).toBe(true);
    for (const qualification of ["x >= 1", { kind: "expression", expression: "x >= 1" },
      { kind: "all", predicates: [] }, { kind: "any", predicates: [] },
      { kind: "condition", condition: ADAPTED.targets.normal.conditions[0], expression: "secret()" }])
      expect(DomainConfigurationSchema.safeParse(edited(ADAPTED, c => { c.qualification = qualification; })).success).toBe(false);
  });
});

describe("G — prospective revisions and complete version history", () => {
  it.each(["ownerUserId", "organizationId"])("review F2: same immutable domain UID cannot restart under different %s", key => {
    const substituted = edited(COOKING_A, c => { c[key] = "different-identity"; });
    const result = ConfigurationBundleSchema.safeParse(bundle([COOKING_A, substituted]));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.some(i =>
      i.code === "custom" && i.params?.contractCode === "domain_ownership_conflict")).toBe(true);
  });
  it("preserves serialized historical links/values and permits mutable display labels", () => {
    const before = JSON.stringify([REVISION_1, REVISION_2, HISTORICAL_OBSERVATION]);
    expect(validateProspectiveRevision(REVISION_1, REVISION_2, REVISION_2.effectiveFrom)).toEqual({ success: true });
    expect(validateObservationContext(REVISION_1, HISTORICAL_OBSERVATION)).toEqual({ success: true });
    expect(ConfigurationBundleSchema.safeParse(bundle([REVISION_2, REVISION_1], [HISTORICAL_OBSERVATION])).success).toBe(true);
    expect(JSON.stringify([REVISION_1, REVISION_2, HISTORICAL_OBSERVATION])).toBe(before);
    const labels = edited(REVISION_2, c => { c.measurements[0].displayName = "New label"; c.measurements[0].unit.customLabel = "mins"; });
    expect(validateProspectiveRevision(REVISION_1, labels, labels.effectiveFrom)).toEqual({ success: true });
  });
  it.each(["organizationId", "ownerUserId", "domainId"])("rejects revision ownership/identity change %s", key => {
    fails(validateProspectiveRevision(REVISION_1, edited(REVISION_2, c => { c[key] = "other"; }), REVISION_2.effectiveFrom), "identity_changed");
  });
  it.each([
    ["policyVersionId", REVISION_1.policyVersionId], ["revision", 3], ["previousVersionId", "other"],
    ["effectiveFrom", REVISION_1.effectiveFrom], ["effectiveFrom", "2025-12-31T00:00:00Z"],
  ])("rejects broken version chain %s=%s", (key, value) => {
    fails(validateProspectiveRevision(REVISION_1, edited(REVISION_2, c => { c[key] = value; }), value === REVISION_1.effectiveFrom ? value : REVISION_2.effectiveFrom));
  });
  it("requires exact explicitly supplied effectiveAt, without claiming real-time backdating protection", () => {
    fails(validateProspectiveRevision(REVISION_1, REVISION_2, "2026-02-02T00:00:00Z"), "effective_order");
    fails(validateProspectiveRevision(REVISION_1, REVISION_2, "2026-01-31T19:00:00-05:00"), "effective_order");
    fails(validateProspectiveRevision(REVISION_1, REVISION_2, undefined));
    // Both fixed timestamps are historical; no wall clock is consulted.
    expect(validateProspectiveRevision(REVISION_1, REVISION_2, REVISION_2.effectiveFrom)).toEqual({ success: true });
  });
  it.each(["meaning", "role", "aggregation", "comparisonDirection"])("rejects semantic redefinition of %s under existing ID", key => {
    const alternatives: Record<string, string> = { meaning: "Different practice amount", role: "outcome", aggregation: "mean", comparisonDirection: "lower_is_better" };
    fails(validateProspectiveRevision(REVISION_1, edited(REVISION_2, c => { c.measurements[0][key] = alternatives[key]; }), REVISION_2.effectiveFrom), "measurement_redefined");
  });
  it("rejects coherent unit/type/scope changes under an old identity; accepts a new measurement ID", () => {
    for (const change of [
      (c: any) => { c.measurements[0].unit.unitId = "hour"; c.targets.normal.conditions[0].unitId = "hour"; },
      (c: any) => { c.measurements[0] = { ...MEASUREMENTS[1], measurementId: REVISION_1.measurements[0].measurementId }; c.targets.normal.conditions = [conditionFor(c.measurements[0], 20)]; },
      (c: any) => { c.measurements[0].scope = { kind: "period", windowDays: 7 }; c.targets.normal.conditions[0].basis = c.measurements[0].scope; },
    ]) fails(validateProspectiveRevision(REVISION_1, edited(REVISION_2, change), REVISION_2.effectiveFrom), "measurement_redefined");
    const next = edited(REVISION_2, c => { c.measurements[0] = structuredClone(MEASUREMENTS[1]); c.targets.normal.conditions = [conditionFor(c.measurements[0], 20)]; });
    expect(validateProspectiveRevision(REVISION_1, next, next.effectiveFrom)).toEqual({ success: true });
  });
  it("checks half-open effective intervals only when next revision is available", () => {
    const atBoundary = edited(HISTORICAL_OBSERVATION, o => { o.observedAt = REVISION_2.effectiveFrom; });
    expect(validateObservationContext(REVISION_1, atBoundary)).toEqual({ success: true });
    expect(ConfigurationBundleSchema.safeParse(bundle([REVISION_1, REVISION_2], [atBoundary])).success).toBe(false);
    const before = edited(atBoundary, o => { o.observedAt = "2026-01-31T23:59:59.999Z"; });
    expect(ConfigurationBundleSchema.safeParse(bundle([REVISION_1, REVISION_2], [before])).success).toBe(true);
    const next = edited(atBoundary, o => { o.policyVersionId = REVISION_2.policyVersionId; });
    expect(ConfigurationBundleSchema.safeParse(bundle([REVISION_1, REVISION_2], [next])).success).toBe(true);
    fails(validateObservationContext(REVISION_1, edited(before, o => { o.observedAt = "2025-12-31T23:59:59Z"; })), "before_effective");
  });
  it("detects ID reuse across a removed measurement and across nonadjacent policy versions", () => {
    const second = edited(REVISION_2, c => {
      c.measurements[0].measurementId = "new-measurement"; c.targets.normal.conditions[0].measurementId = "new-measurement";
    });
    const third = edited(second, c => {
      c.revision = 3; c.previousVersionId = second.policyVersionId; c.policyVersionId = "policy-G-v3"; c.effectiveFrom = "2026-03-01T00:00:00Z";
      c.measurements[0].measurementId = REVISION_1.measurements[0].measurementId;
      c.measurements[0].meaning = "A newly defined meaning"; c.targets.normal.conditions[0].measurementId = c.measurements[0].measurementId;
    });
    expect(validateProspectiveRevision(second, third, third.effectiveFrom)).toEqual({ success: true });
    expect(ConfigurationBundleSchema.safeParse(bundle([REVISION_1, second, third])).success).toBe(false);
    const reused = edited(third, c => { c.policyVersionId = REVISION_1.policyVersionId; c.measurements = structuredClone(second.measurements); c.targets = structuredClone(second.targets); });
    expect(validateProspectiveRevision(second, reused, reused.effectiveFrom)).toEqual({ success: true });
    expect(ConfigurationBundleSchema.safeParse(bundle([REVISION_1, second, reused])).success).toBe(false);
  });
  it("keeps unowned legacy evidence unresolved, never inferring an owner", () => {
    expect(UNOWNED_LEGACY).toMatchObject({ ownerUserId: null, migrationStatus: "unresolved" });
    expect(ObservationSchema.safeParse(UNOWNED_LEGACY).success).toBe(false);
    expect(DomainConfigurationSchema.safeParse(edited(REVISION_1, c => { c.ownerUserId = null; })).success).toBe(false);
  });
});

describe("H/I — owner-specific legacy mappings and explicit review metadata", () => {
  it("preserves four supplied legacy slugs and duration meaning without defaulting other users to develop", () => {
    expect(LEGACY_MAPPINGS.map(m => m.legacySlug)).toEqual(["martial-arts", "meditation", "fitness", "music"]);
    for (const m of LEGACY_MAPPINGS) {
      expect(m.legacyField).toBe("durationMinutes"); expect(m.mappingStatus).toBe("synthetic-proposal-only");
      expect(DomainConfigurationSchema.parse(m.configuration).goal.intent).toBe("develop");
      expect(m.configuration.measurements[0]).toMatchObject({ kind: "duration", meaning: "Elapsed practice minutes", unit: { unitId: "minute" } });
    }
    expect(COOKING_B.goal.intent).toBe("unknown");
  });
  it("defaults to 84 days but accepts earlier explicit review without scheduling changes", () => {
    const input = edited(EARLY_REVIEW, c => { delete c.review.intervalDays; });
    const original = JSON.stringify(input);
    expect(DomainConfigurationSchema.parse(input).review).toEqual({ anchorAt: "2026-01-01T00:00:00Z", intervalDays: 84, nextReviewAt: "2026-01-15T00:00:00Z" });
    expect(JSON.stringify(input)).toBe(original);
  });
  it("overdue adaptation remains unchanged without a clock or automatic target increase", () => {
    expect(ADAPTED_FUTURE_EXPECTATION.asOf > ADAPTED.targets.adapted!.reviewAt!).toBe(true);
    const clock = vi.spyOn(Date, "now").mockImplementation(() => { throw new Error("Ambient time forbidden"); });
    try {
      const result = DomainConfigurationSchema.parse(ADAPTED);
      expect(result.targets.adapted).toEqual(ADAPTED.targets.adapted);
      expect(validateProspectiveRevision(REVISION_1, REVISION_2, REVISION_2.effectiveFrom)).toEqual({ success: true });
      expect(validateObservationContext(ADAPTED, ADAPTED_OBSERVATION)).toEqual({ success: true });
    } finally { clock.mockRestore(); }
    expect(ADAPTED.targets.adapted).not.toHaveProperty("reason");
    expect(DomainConfigurationSchema.safeParse(edited(ADAPTED, c => { c.targets.adapted.duration = "ongoing"; delete c.targets.adapted.reviewAt; })).success).toBe(true);
  });
});

describe("J — strict objects, malformed inputs, duplicates and zero/missing/false", () => {
  it.each(["JSON.parse", "defineProperty", "non-enumerable own property"])("review F3 rejects OWN __proto__ raw value via %s", construction => {
    const values = construction === "JSON.parse"
      ? JSON.parse('{"__proto__":{"unitId":"minute","valueType":"number","value":0}}')
      : Object.defineProperty({}, "__proto__", {
        value: { unitId: "minute", valueType: "number", value: 0 }, enumerable: construction === "defineProperty",
      });
    expect(Object.prototype.hasOwnProperty.call(values, "__proto__")).toBe(true);
    const inputKeys = construction === "non-enumerable own property" ? [] : ["__proto__"];
    expect(Object.keys(values)).toEqual(inputKeys);
    const observation = { ...HISTORICAL_OBSERVATION, values };
    const before = JSON.stringify(observation);
    expect(ObservationSchema.safeParse(observation).success).toBe(false);
    const context = validateObservationContext(REVISION_1, observation);
    fails(context, "reserved_record_identity");
    if (!context.success) expect(context.issues).toContainEqual({
      path: "observation.values.__proto__", code: "reserved_record_identity",
      message: "__proto__ cannot be a measurement record key",
    });
    expect(ConfigurationBundleSchema.safeParse(bundle([REVISION_1], [observation])).success).toBe(false);
    expect(JSON.stringify(observation)).toBe(before);
    expect(Object.keys(values)).toEqual(inputKeys);
    expect(Object.prototype.hasOwnProperty.call(values, "__proto__")).toBe(true);
  });
  it("review F3 forbids __proto__ as a declared measurement identity", () => {
    const configuration = edited(REVISION_1, c => {
      c.measurements[0].measurementId = "__proto__";
      c.targets.normal.conditions[0].measurementId = "__proto__";
    });
    expect(DomainConfigurationSchema.safeParse(configuration).success).toBe(false);
  });
  it.each(allValid.map((configuration, index) => ({ configuration, index })))("valid fixture $index is an executable strict contract", ({ configuration }) => {
    expect(DomainConfigurationSchema.parse(configuration)).toEqual(configuration);
  });
  it("distinguishes zero, missing and boolean false; zero chosen targets are valid", () => {
    const zero = observationFor(REVISION_1, "zero-observation", 0);
    const missing = edited(zero, o => { o.values = {}; });
    const completed = MEASUREMENT_CASES[4].configuration, falseValue = observationFor(completed, "false-observation", false);
    expect(validateObservationContext(REVISION_1, zero)).toEqual({ success: true });
    expect(validateObservationContext(REVISION_1, missing)).toEqual({ success: true });
    expect(validateObservationContext(completed, falseValue)).toEqual({ success: true });
    expect(zero.values["m-duration"].value).toBe(0); expect(Object.keys(missing.values)).toEqual([]);
    expect(falseValue.values["m-completion"].value).toBe(false);
    expect(JSON.stringify(zero.values)).not.toBe(JSON.stringify(missing.values));
    for (const c of MEASUREMENT_CASES.filter(c => c.configuration.measurements[0].valueType !== "boolean"))
      expect(DomainConfigurationSchema.safeParse(edited(c.configuration, c => { c.targets.normal.conditions[0].constraint.value = 0; })).success).toBe(true);
    expect(ObservationSchema.safeParse({ ...missing, status: "missed" }).success).toBe(false);
  });
  it.each(["", " ", " leading", "trailing ", "bad\nid"])("rejects malformed opaque ID %j across identity fields", value => {
    for (const key of ["organizationId", "ownerUserId", "domainId", "policyVersionId"])
      expect(DomainConfigurationSchema.safeParse(edited(REVISION_1, c => { c[key] = value; })).success).toBe(false);
    expect(ObservationSchema.safeParse(edited(HISTORICAL_OBSERVATION, o => { o.observationId = value; })).success).toBe(false);
    expect(DomainConfigurationSchema.safeParse(edited(REVISION_1, c => { c.measurements[0].measurementId = value; })).success).toBe(false);
  });
  it.each(["2026-01-01", "2026-01-01T12:00:00", "2026-02-30T12:00:00Z", "2026-01-01T12:00:00+99:99", "bad"])("rejects invalid or offsetless time %s", value => {
    expect(DomainConfigurationSchema.safeParse(edited(REVISION_1, c => { c.effectiveFrom = value; })).success).toBe(false);
    expect(ObservationSchema.safeParse(edited(HISTORICAL_OBSERVATION, o => { o.observedAt = value; })).success).toBe(false);
  });
  it("accepts a valid explicit offset without converting units or rewriting serialized timestamps", () => {
    const o = edited(HISTORICAL_OBSERVATION, o => { o.observedAt = "2026-01-10T07:00:00-05:00"; });
    expect(ObservationSchema.parse(o).observedAt).toBe(o.observedAt);
    expect(validateObservationContext(REVISION_1, o)).toEqual({ success: true });
  });
  it.each([
    (c: any) => { c.measurements.push(structuredClone(c.measurements[0])); },
    (c: any) => { c.references.push(structuredClone(c.references[0])); },
    (c: any) => { c.targets.stretch.targetId = c.targets.normal.targetId; },
    (c: any) => { c.revision = 2; },
    (c: any) => { c.previousVersionId = "predecessor"; },
    (c: any) => { c.targets.normal.conditions[0].measurementId = "absent"; },
    (c: any) => { c.targets.normal.conditions[0].constraint.value = -1; },
    (c: any) => { c.measurements[0].unit.dimension = "time"; },
    (c: any) => { c.targets.adapted.reviewAt = "2026-01-04T00:00:00Z"; },
    (c: any) => { c.review.intervalDays = 0; },
    (c: any) => { c.review.nextReviewAt = "2025-12-01T00:00:00Z"; },
    (c: any) => { c.review.lastReviewedAt = "2025-12-01T00:00:00Z"; },
    (c: any) => { c.boundary.dayStartHour = 24; },
    (c: any) => { c.boundary.timezone = "Not/AZone"; },
    (c: any) => { delete c.templateLineage.templateVersionId; },
  ])("rejects contradictory/malformed configuration case %#", change => {
    expect(DomainConfigurationSchema.safeParse(edited(ADAPTED, change)).success).toBe(false);
  });
  it.each([
    "", "goal", "goal.currentCapability", "boundary", "measurements.0", "measurements.0.unit",
    "targets", "targets.normal", "targets.normal.conditions.0", "targets.normal.conditions.0.basis",
    "targets.normal.conditions.0.constraint", "targets.adapted", "targets.upperRecovery",
    "references.0", "references.0.applicability", "references.0.evidence", "references.0.evidence.source",
    "references.0.evidence.review", "review", "templateLineage", "qualification",
  ])("rejects unsupported configuration field at %s", location => {
    const invalid = edited(ADAPTED, c => {
      const target = location ? location.split(".").reduce((v: any, key) => v[key], c) : c;
      target.unsupported = true;
    });
    expect(DomainConfigurationSchema.safeParse(invalid).success).toBe(false);
  });
  it("rejects unsupported nested task variants, conditions and observation/context fields", () => {
    for (const location of ["taskVariants.0", "taskVariants.0.taskConditions.0"])
      expect(DomainConfigurationSchema.safeParse(edited(VARIANT, c => { location.split(".").reduce((v: any, k) => v[k], c).unsupported = true; })).success).toBe(false);
    for (const location of ["", "values.m-duration", "context", "context.taskConditions.0"]) {
      const invalid = edited(HISTORICAL_OBSERVATION, o => {
        o.context = { taskConditions: [{ conditionId: "synthetic", description: "Synthetic context" }] };
        (location ? location.split(".").reduce((v: any, k) => v[k], o) : o).unsupported = true;
      });
      expect(ObservationSchema.safeParse(invalid).success).toBe(false);
    }
  });
  it("rejects duplicate/ambiguous versions, duplicate observations, broken history and extra bundle fields", () => {
    for (const b of [
      bundle([REVISION_1, REVISION_1]), bundle([REVISION_2]), bundle([REVISION_1], [HISTORICAL_OBSERVATION, HISTORICAL_OBSERVATION]),
      bundle([REVISION_1, edited(REVISION_2, c => { c.effectiveFrom = REVISION_1.effectiveFrom; })]),
      bundle([REVISION_1], [edited(HISTORICAL_OBSERVATION, o => { o.policyVersionId = "unresolved"; })]),
      { ...bundle([REVISION_1]), unsupported: true },
    ]) expect(ConfigurationBundleSchema.safeParse(b).success).toBe(false);
  });
  it("does not mutate frozen inputs and emits structured issues for malformed arguments", () => {
    const c = structuredClone(REVISION_1), n = structuredClone(REVISION_2), o = structuredClone(HISTORICAL_OBSERVATION);
    const before = JSON.stringify([c, n, o]); [c, n, o].forEach(freeze);
    expect(validateObservationContext(c, o)).toEqual({ success: true });
    expect(validateProspectiveRevision(c, n, n.effectiveFrom)).toEqual({ success: true });
    expect(ConfigurationBundleSchema.safeParse(bundle([c, n], [o])).success).toBe(true);
    expect(JSON.stringify([c, n, o])).toBe(before);
    for (const invalid of [undefined, null, {}, "not-an-object", []]) {
      fails(validateObservationContext(invalid, invalid));
      fails(validateProspectiveRevision(invalid, invalid, invalid));
    }
  });
});