import { describe, expect, it } from "vitest";
import { DomainConfigurationSchema } from "@shared/domain-config";
import { conditionFor, domainSlug, draftIdentities, editReference, fromLocalInput, matchesSubmittedDraft,
  newPolicyDraft, newReference, numericInput, policyDraft, prospectivePolicyDraft, SERVER_POLICY_FIELDS,
  suggestedStart, toLocalInput, validatePolicyDraft, validationConfiguration, withPracticeFrequency,
  type DomainPolicyDraft, type MeasurementKind } from "./domain-policy-draft";

const now = Date.parse("2026-10-06T03:00:00Z");
const boundary = { timezone: "America/New_York", dayStartHour: 6 };
const identities = () => { let sequence = 0; return draftIdentities(() => `identity-${++sequence}`); };
function draft(kind: MeasurementKind = "count") {
  const value = newPolicyDraft(boundary, identities(), now, kind);
  value.displayName = "Cooking"; value.goal = { intent: "develop", desiredCapability: "Bake consistently", privateMotivation: "My <private> goal" };
  return value;
}
function imported() {
  const ids = identities(), value = withPracticeFrequency(draft(), ids, true);
  const primary = value.measurements[0]; primary.taskVariantId = "variant";
  value.targets.normal.conditions[0].taskVariantId = "variant";
  value.taskVariants = [{ variantId: "variant", displayName: "Home kitchen", taskConditions: [{ conditionId: "oven", description: "Own oven" }] }];
  value.templateLineage = { templateId: "template", templateVersionId: "template-v1", revision: 1 };
  value.qualification = { kind: "any", predicates: value.targets.normal.conditions.map(condition => ({ kind: "condition", condition })) };
  value.targets.stretch = { targetId: "stretch", displayName: "Larger batches", conditions: structuredClone(value.targets.normal.conditions) };
  value.references = [{ ...newReference("reference", "maintain"), status: "known", conditions: structuredClone(value.targets.normal.conditions),
    applicability: { description: "Own oven", taskConditions: [{ conditionId: "equipment", description: "Equipment matters" }] },
    evidence: { category: "professional", source: { description: "Personal guidance", url: "https://example.org" },
      confidence: "moderate", review: { status: "reviewed", reviewerId: "reviewer", reviewedAt: "2026-10-01T00:00:00Z" } } }];
  value.review = { anchorAt: "2026-01-01T00:00:00Z", intervalDays: 101, lastReviewedAt: "2026-09-01T00:00:00Z", nextReviewAt: "2026-12-01T00:00:00Z" };
  value.measurements[1].scope = { kind: "period", windowDays: 13 };
  value.targets.normal.conditions[1].basis = { kind: "period", windowDays: 13 };
  value.targets.stretch.conditions[1].basis = { kind: "period", windowDays: 13 };
  if (value.qualification.kind !== "condition") value.qualification.predicates[1] = { kind: "condition", condition: value.targets.normal.conditions[1] };
  if (value.references[0].status === "known") value.references[0].conditions[1].basis = { kind: "period", windowDays: 13 };
  return DomainConfigurationSchema.parse(validationConfiguration(value));
}
describe("typed personal domain draft", () => {
  it("offers editing time without silently retiming the explicit start or relaxing its minimum", () => {
    const value = draft(), chosen = value.effectiveFrom;
    expect(Date.parse(chosen) - now).toBeGreaterThanOrEqual(30 * 60 * 1000);
    expect(validatePolicyDraft(value, "Initial setup", now + 14 * 60 * 1000)).toEqual([]);
    expect(validatePolicyDraft(value, "Initial setup", now + 17 * 60 * 1000).some(issue => issue.code === "future_start")).toBe(true);
    expect(value.effectiveFrom).toBe(chosen);
    const explicit = { ...value, effectiveFrom: new Date(now + 15 * 60 * 1000).toISOString() };
    expect(validatePolicyDraft(explicit, "Explicit start", now)).toEqual([]);
  });
  it.each(["duration", "repetitions", "count", "quantity", "completion", "frequency"] as const)("constructs a schema-valid %s domain without invented measure types", kind => {
    const value = draft(kind);
    expect(validatePolicyDraft(value, "Initial setup", now)).toEqual([]);
    const parsed = DomainConfigurationSchema.parse(validationConfiguration(value));
    expect(parsed.measurements[0].kind).toBe(kind);
    expect(parsed.measurements).toHaveLength(1);
    expect(parsed.review.intervalDays).toBe(84);
    expect(parsed.references).toEqual([]);
    for (const field of SERVER_POLICY_FIELDS) expect(Object.hasOwn(value, field)).toBe(false);
    if (kind === "completion") expect(parsed.targets.normal.conditions[0].valueType).toBe("boolean");
    if (kind === "count") expect(parsed.measurements[0].unit.dimension).toBe("count");
  });
  it("keeps decimal distance, integer counts and independent frequency distinct", () => {
    const distance = draft("quantity"); const m = distance.measurements[0];
    if (m.kind !== "quantity") throw new Error("Expected quantity");
    m.unit = { ...m.unit, dimension: "distance", customLabel: "kilometres" };
    distance.targets.normal.conditions[0].constraint = { operator: "gte", value: 2.5 };
    expect(validatePolicyDraft(distance, "Distance goal", now)).toEqual([]);
    const ids = identities(), value = withPracticeFrequency(draft(), ids, true);
    expect(value.measurements.map(item => item.kind)).toEqual(["count", "frequency"]);
    expect(value.targets.normal.conditions.map(item => item.basis.kind)).toEqual(["per_event", "period"]);
    expect(validatePolicyDraft(value, "Amount and frequency", now)).toEqual([]);
    const frequency = value.measurements[1];
    if (frequency.kind !== "frequency") throw new Error("Expected frequency");
    frequency.countBy = "distinct_days"; frequency.unit = { ...frequency.unit, dimension: "days", customLabel: "days" };
    value.targets.normal.conditions[1].constraint = { operator: "gte", value: 8 };
    expect(validatePolicyDraft(value, "Days", now).some(i => i.path.includes("constraint"))).toBe(true);
  });
  it("permits zero and below-reference targets but rejects lossy whole-number input", () => {
    const value = draft(); value.targets.normal.conditions[0].constraint = { operator: "gte", value: 0 };
    value.references = [{ ...newReference("reference", "develop"), applicability: { description: "Declared personal benchmark" },
      status: "known", conditions: [{ ...value.targets.normal.conditions[0], constraint: { operator: "gte", value: 50 } }] }];
    expect(validatePolicyDraft(value, "Recovery plan", now)).toEqual([]);
    expect(numericInput("0", true)).toBe(0);
    expect(numericInput("2.5", false)).toBe(2.5);
    for (const input of ["", "-1", "2.5", "9007199254740993", "Infinity"])
      expect(() => numericInput(input, true)).toThrow();
  });
  it("requires declared period sums and exact units, types and frequency windows", () => {
    const value = draft("duration"); const c = value.targets.normal.conditions[0];
    c.basis = { kind: "period", windowDays: 14 };
    expect(validatePolicyDraft(value, "Sum", now).length).toBeGreaterThan(0);
    c.periodAggregation = { sourceBasis: "per_event", method: "sum" };
    expect(validatePolicyDraft(value, "Sum", now)).toEqual([]);
    c.unitId = "other-unit";
    expect(validatePolicyDraft(value, "Wrong unit", now).some(i => i.path.includes("unitId"))).toBe(true);
  });
  it("generates safe distinct stable slugs from names without making a name unique", () => {
    expect(domainSlug("料理", "abc123")).toBe("domain-abc123");
    expect(domainSlug("Crème & Cooking", "abc123")).toBe("creme-cooking-abc123");
    expect(domainSlug("a".repeat(200), "abc123").length).toBeLessThanOrEqual(80);
    expect(domainSlug("Cooking", "aaa")).not.toBe(domainSlug("Cooking", "bbb"));
    expect(() => domainSlug("Cooking", "!!!")).toThrow();
  });
});
describe("prospective edits and saved history", () => {
  it("copies every imported field without flattening two measures or mutating the previous version", () => {
    const previous = imported(), original = structuredClone(previous);
    const next = prospectivePolicyDraft(previous, now);
    next.goal.desiredCapability = "More even batches";
    next.targets.normal.conditions[0].constraint = { operator: "gte", value: 0 };
    expect(previous).toEqual(original);
    for (const field of ["measurements", "boundary", "taskVariants", "qualification", "references", "review", "templateLineage"] as const)
      expect(next[field]).toEqual(previous[field]);
    expect(next.targets.stretch).toEqual(previous.targets.stretch);
    expect(next.targets.normal.conditions).toHaveLength(2);
    expect(validatePolicyDraft(next, "New goal", now, previous)).toEqual([]);
    for (const field of SERVER_POLICY_FIELDS) expect(Object.hasOwn(next, field)).toBe(false);
  });
  it("starts after the latest scheduled version and rejects stale/start or meaning/name changes", () => {
    const previous = imported(); previous.effectiveFrom = "2099-01-01T00:00:00Z";
    const next = prospectivePolicyDraft(previous, now);
    expect(Date.parse(next.effectiveFrom)).toBeGreaterThan(Date.parse(previous.effectiveFrom));
    next.effectiveFrom = previous.effectiveFrom;
    expect(validatePolicyDraft(next, "Change", now, previous).length).toBeGreaterThan(0);
    next.effectiveFrom = suggestedStart(now, previous); next.measurements[0].meaning = "Changed meaning";
    expect(validatePolicyDraft(next, "Change", now, previous).some(i => i.code === "measurement_redefined")).toBe(true);
    next.measurements = structuredClone(previous.measurements); next.displayName = "Renamed";
    expect(validatePolicyDraft(next, "Change", now, previous).some(i => i.code === "name_readonly")).toBe(true);
    const elapsed = draft(); expect(validatePolicyDraft(elapsed, "Change", now + 17 * 60000).some(i => i.code === "future_start")).toBe(true);
  });
  it("preserves reviewed references unchanged but invalidates evidence review after an edit", () => {
    const reference = imported().references[0];
    expect(editReference(reference, structuredClone(reference)).evidence.review.status).toBe("reviewed");
    const changed = editReference(reference, { ...reference, applicability: { ...reference.applicability, description: "Other situation" } });
    expect(changed.evidence.review).toEqual({ status: "unreviewed" });
    expect(reference.evidence.review.status).toBe("reviewed");
    expect(changed.applicability.taskConditions).toEqual(reference.applicability.taskConditions);
  });
  it("requires explicit reference purpose and never invents an evidence minimum", () => {
    const reference = newReference("reference", "maintain");
    expect(reference.purpose).toBe("maintain"); expect(reference.status).toBe("unknown");
    expect(reference.evidence).toEqual({ category: "personal", review: { status: "unreviewed" }, confidence: "unknown" });
    expect(Object.hasOwn(reference, "conditions")).toBe(false);
  });
  it("does not end adaptation at a review or turn recovery guidance into a score", () => {
    const value = draft(); value.targets.adapted = { target: { targetId: "adapted", conditions: structuredClone(value.targets.normal.conditions) },
      effectiveFrom: value.effectiveFrom, duration: "temporary", reviewAt: "2026-10-07T00:00:00Z", reason: "Recovery" };
    value.targets.upperRecovery = { conditions: [conditionFor(value.measurements[0], true)], guidance: "Leave room to recover" };
    const previous = DomainConfigurationSchema.parse(validationConfiguration(value));
    const next = prospectivePolicyDraft(previous, now + 86400000);
    expect(next.targets.adapted).toEqual(value.targets.adapted);
    expect(next.targets.upperRecovery).toEqual(value.targets.upperRecovery);
    expect(Object.hasOwn(next, "score")).toBe(false);
    expect(validatePolicyDraft(next, "Continue", now + 86400000, previous)).toEqual([]);
  });
  it("matches only the submitted draft, allowing the server's name trimming but no unrelated successful response", () => {
    const value = draft(); value.displayName = " Cooking ";
    const saved = DomainConfigurationSchema.parse(validationConfiguration({ ...value, displayName: "Cooking" }));
    expect(matchesSubmittedDraft(saved, value)).toBe(true);
    saved.goal.desiredCapability = "Different private goal";
    expect(matchesSubmittedDraft(saved, value)).toBe(false);
  });
  it("round trips explicit instants through browser-local inputs and rejects normalized invalid calendar dates", () => {
    const selected = "2026-10-07T03:14:00Z";
    const roundTrip = fromLocalInput(toLocalInput(selected));
    expect(Date.parse(roundTrip)).toBe(Date.parse(selected));
    expect(roundTrip).toBe(new Date(selected).toISOString());
    expect(() => fromLocalInput("2026-02-30T12:00")).toThrow();
    expect(() => fromLocalInput("2026-10-07T03:14:00")).toThrow();
  });
});
