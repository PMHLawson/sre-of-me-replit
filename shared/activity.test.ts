import { describe, it, expect } from "vitest";
import { ActivityCreateInputSchema, ActivityTimestampSchema, ActivityViewSchema, ActivityListInputSchema,
  ActivityEligibilitySchema,ActivityCreateResultSchema,ActivitySubmissionResultSchema, ActivityEditInputSchema,ActivityLifecycleInputSchema,ActivityMutationResultSchema, validatePracticeValues } from "./activity";
import { configurationFor, MEASUREMENTS, FREQUENCY_CASES } from "./fixtures/domain-config-cases";

const configuration = configurationFor("raw", MEASUREMENTS[2], 12);
const input = { submissionKey: "deliberate-save", domainId: configuration.domainId, policyVersionId: configuration.policyVersionId,
  practiceEvent: true as const, observedAt: "2026-01-10T12:00:00Z", values: {
    "m-cupcakes": { valueType: "integer" as const, unitId: "cupcake", value: 0 },
  } };
describe("typed personal practice HTTP contract", () => {
  it("preserves zero, false, omitted fields and declared units without creating duration", () => {
    const parsed = ActivityCreateInputSchema.parse(input);
    expect(parsed.values["m-cupcakes"].value).toBe(0); expect(parsed.values).not.toHaveProperty("m-duration");
    expect(parsed).not.toHaveProperty("notes"); expect(parsed).not.toHaveProperty("context");
    expect(ActivityCreateInputSchema.parse({ ...input, notes: "", values: {
      completed: { valueType: "boolean", unitId: "completed", value: false },
    } }).values.completed.value).toBe(false);
  });
  it("accepts finite raw numbers, safe integer amounts and booleans only", () => {
    for (const [type, value] of [["integer", -1], ["integer", 1.5], ["integer", 9007199254740992],
      ["integer", "12"], ["number", NaN], ["number", Infinity], ["number", -1], ["boolean", 0]])
      expect(ActivityCreateInputSchema.safeParse({ ...input, values: { amount: { valueType: type, value, unitId: "declared" } } }).success).toBe(false);
    expect(ActivityCreateInputSchema.safeParse({ ...input, values: { amount: { valueType: "number", value: 2.5, unitId: "kilometre" } } }).success).toBe(true);
  });
  it("rejects caller authority, lifecycle, provenance, unbounded text and undeclared value shape", () => {
    for (const key of ["organizationId", "ownerUserId", "actorUserId", "observationId", "sourceBindingId", "deletedAt", "isAnomaly", "score", "rolloutMode"])
      expect(ActivityCreateInputSchema.safeParse({ ...input, [key]: "forged" }).success).toBe(false);
    for (const patch of [{ practiceEvent: false }, { submissionKey: " " }, { notes: "x".repeat(4001) },
      { context: { actor: "forged" } }, { context: { description: "x".repeat(2001) } },
      { values: { amount: { valueType: "integer", value: 1, unitId: "rep", aggregate: "sum" } } }])
      expect(ActivityCreateInputSchema.safeParse({ ...input, ...patch }).success).toBe(false);
    expect(ActivityCreateInputSchema.safeParse({ ...input, values: Object.fromEntries(Array.from({ length: 65 }, (_, n) =>
      ["m" + n, { valueType: "integer", value: 1, unitId: "rep" }])) }).success).toBe(false);
  });
  it("rejects reserved keys even when non-enumerable instead of dropping them", () => {
    for (const key of ["__proto__", "prototype", "constructor"]) {
      const values = { ...input.values }; Object.defineProperty(values, key, { value: {}, enumerable: false });
      expect(ActivityCreateInputSchema.safeParse({ ...input, values }).success).toBe(false);
      expect(ActivityCreateInputSchema.safeParse({ ...input, submissionKey: key }).success).toBe(false);
    }
  });
  it("uses exact millisecond-supported instants and rejects finer precision before rounding", () => {
    expect(ActivityTimestampSchema.parse("2026-01-10T07:00:00.125-05:00")).toBe("2026-01-10T12:00:00.125Z");
    for (const time of ["2026-01-10T12:00:00.0001Z", "2026-01-10T12:00:00.1250Z", "not-a-time", "2026-01-10T12:00:00"])
      expect(ActivityTimestampSchema.safeParse(time).success).toBe(false);
  });
  it("requires a raw practice value for mixed domains, with context/outcome/frequency totals never substituting", () => {
    expect(validatePracticeValues(configuration, ActivityCreateInputSchema.parse(input))).toBe(true);
    for (const values of [{}, { unknown: { valueType: "integer", unitId: "cupcake", value: 2 } },
      { "m-cupcakes": { valueType: "integer", unitId: "rep", value: 2 } },
      { "m-cupcakes": { valueType: "number", unitId: "cupcake", value: 2 } },
      { "m-cupcakes": { valueType: "integer", unitId: "cupcake", value: 2, taskVariantId: "unmatched" } }])
      expect(validatePracticeValues(configuration, ActivityCreateInputSchema.parse({ ...input, values }))).toBe(false);
    for (const role of ["context", "outcome"] as const)
      expect(validatePracticeValues({ ...configuration, measurements: [{ ...configuration.measurements[0], role }] },
        ActivityCreateInputSchema.parse(input))).toBe(false);
    expect(validatePracticeValues({ ...configuration, measurements: [{ ...configuration.measurements[0], scope: { kind: "period", windowDays: 7 } }] },
      ActivityCreateInputSchema.parse(input))).toBe(false);
  });
  it("allows one explicit occurrence for all-frequency domains, never supplied frequency aggregates or mixed empty events", () => {
    for (const example of FREQUENCY_CASES) {
      const frequency = example.configuration.measurements.find(m => m.kind === "frequency")!;
      const c = { ...example.configuration, measurements: [frequency] };
      const empty = ActivityCreateInputSchema.parse({ ...input, domainId: c.domainId, policyVersionId: c.policyVersionId, values: {} });
      expect(validatePracticeValues(c, empty)).toBe(true);
      expect(validatePracticeValues(example.configuration, empty)).toBe(false);
      expect(validatePracticeValues(c, { ...empty, values: { [frequency.measurementId]: {
        valueType: "integer", unitId: frequency.unit.unitId, value: 3,
      } } })).toBe(false);
    }
  });
  it("binds a read DTO to its exact owned configuration and never permits calculated scores", () => {
    const view = { activityId: "saved", ownerUserId: configuration.ownerUserId, domainId: configuration.domainId,
      policyVersionId: configuration.policyVersionId, practiceEvent: true, observedAt: input.observedAt, values: input.values,
      deletedAt: null, stateFingerprint:"a".repeat(64),configuration, scoreAvailability: "not_calculated", attainmentAvailability: "not_calculated" };
    expect(ActivityViewSchema.safeParse(view).success).toBe(true);
    for (const patch of [{ ownerUserId: "other" }, { domainId: "foreign" }, { policyVersionId: "foreign" },
      { scoreAvailability: "calculated" }, { idempotencyKey: "storage-key" }])
      expect(ActivityViewSchema.safeParse({ ...view, ...patch }).success).toBe(false);
  });
  it("acknowledgements require explicit logical keys without leaking raw persistence authority",()=>{
    const activity={activityId:"saved",ownerUserId:configuration.ownerUserId,domainId:configuration.domainId,policyVersionId:configuration.policyVersionId,
      practiceEvent:true,observedAt:input.observedAt,values:input.values,deletedAt:null,stateFingerprint:"a".repeat(64),configuration,
      scoreAvailability:"not_calculated",attainmentAvailability:"not_calculated"};
    expect(ActivityCreateResultSchema.safeParse({created:false,submissionKey:input.submissionKey,activity}).success).toBe(true);
    expect(ActivitySubmissionResultSchema.safeParse({submissionKey:input.submissionKey,activity}).success).toBe(true);
    expect(ActivityMutationResultSchema.safeParse({changed:false,operation:"edit",mutationKey:"known-mutation",activity,appliedStateFingerprint:"b".repeat(64)}).success).toBe(true);
    for(const envelope of [{created:false,activity},{created:false,submissionKey:input.submissionKey,activity,idempotencyKey:"raw-storage-authority"}])
      expect(ActivityCreateResultSchema.safeParse(envelope).success).toBe(false);
    expect(ActivitySubmissionResultSchema.safeParse({activity}).success).toBe(false);
    expect(ActivityMutationResultSchema.safeParse({changed:false,operation:"edit",activity,appliedStateFingerprint:"b".repeat(64)}).success).toBe(false);
  });
  it("requires reasoned fingerprinted strict correction/lifecycle requests without accepting mutable authority",()=>{
    const lifecycle={mutationKey:"deliberate-change",expectedStateFingerprint:"b".repeat(64),reason:"  Clarify the original entry  "};
    expect(ActivityLifecycleInputSchema.parse(lifecycle).reason).toBe("Clarify the original entry");
    const edit={...lifecycle,policyVersionId:input.policyVersionId,practiceEvent:true,observedAt:input.observedAt,values:input.values};
    expect(ActivityEditInputSchema.safeParse(edit).success).toBe(true);
    for(const patch of [{reason:" "},{expectedStateFingerprint:"stale-text"},{mutationKey:"__proto__"},{deletedAt:null},{ownerUserId:"foreign"},
      {domainId:"new-domain"},{submissionKey:"new-submission"},{isAnomaly:true},{operation:"restore"}]) {
      expect(ActivityLifecycleInputSchema.safeParse({...lifecycle,...patch}).success).toBe(false);
      expect(ActivityEditInputSchema.safeParse({...edit,...patch}).success).toBe(false);
    }
    expect(ActivityMutationResultSchema.safeParse({changed:false,operation:"delete",activity:{},appliedStateFingerprint:"a".repeat(64)}).success).toBe(false);
  });
  it("bounds paging without coercing authority or accepting contradictory eligibility", () => {
    expect(ActivityListInputSchema.parse({})).toEqual({ limit: 50 });
    for (const input of [{ limit: "50" }, { limit: 101 }, { limit: 0 }, { ownerUserId: "other" }, { cursor: "x".repeat(1025) }])
      expect(ActivityListInputSchema.safeParse(input).success).toBe(false);
    expect(ActivityEligibilitySchema.safeParse({ domainId: "own", canCreate: true, reason: null, effectivePolicyVersionId: "own-policy" }).success).toBe(true);
    for (const value of [{ domainId: "own", canCreate: true, reason: "legacy_writer", effectivePolicyVersionId: "p" },
      { domainId: "own", canCreate: true, reason: null }, { domainId: "own", canCreate: false, reason: null },
      { domainId: "own", canCreate: false, reason: "inactive", effectivePolicyVersionId: "p" }])
      expect(ActivityEligibilitySchema.safeParse(value).success).toBe(false);
  });
});
