import { DomainConfigurationSchema, validateProspectiveRevision,
  type DomainConfiguration, type MeasurementDefinition, type TypedCondition } from "@shared/domain-config";

export type DomainPolicyDraft = Omit<DomainConfiguration,
  "organizationId" | "ownerUserId" | "domainId" | "policyVersionId" | "revision" | "previousVersionId">;
export type ReferenceDraft = DomainPolicyDraft["references"][number];
export type MeasurementKind = MeasurementDefinition["kind"];
export type DraftIssue = { path: string; message: string; code: string };
export const MINIMUM_START_LEAD_MS = 15 * 60 * 1000;
export const SUGGESTED_START_LEAD_MS = 30 * 60 * 1000;
export const WINDOW_PRESETS = [7, 14, 28, 42] as const;
export const SERVER_POLICY_FIELDS = ["organizationId", "ownerUserId", "domainId", "policyVersionId", "revision", "previousVersionId"] as const;
export type DraftIdentities = { slugSuffix: string; amount: string; amountUnit: string; frequency: string;
  frequencyUnit: string; normal: string; adapted: string };
export function draftIdentities(makeId: () => string = () => crypto.randomUUID()): DraftIdentities {
  return { slugSuffix: makeId().replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 20),
    amount: makeId(), amountUnit: makeId(), frequency: makeId(), frequencyUnit: makeId(), normal: makeId(), adapted: makeId() };
}
export function domainSlug(name: string, suffix: string): string {
  const stem = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "domain";
  const safeSuffix = suffix.replace(/[^a-z0-9]/g, "").slice(0, 20);
  if (!safeSuffix) throw new Error("A stable draft identity is required.");
  return `${stem.slice(0, 79 - safeSuffix.length).replace(/-$/g, "")}-${safeSuffix}`;
}
export function policyDraft(configuration: DomainConfiguration): DomainPolicyDraft {
  const copy = structuredClone(configuration);
  const { organizationId: _org, ownerUserId: _owner, domainId: _domain, policyVersionId: _version,
    revision: _revision, previousVersionId: _previous, ...draft } = copy;
  return draft;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
export function matchesSubmittedDraft(configuration: DomainConfiguration, draft: DomainPolicyDraft): boolean {
  return canonical(policyDraft(configuration)) === canonical({ ...draft, displayName: draft.displayName.trim() });
}
export function validationConfiguration(draft: DomainPolicyDraft, previous?: DomainConfiguration): DomainConfiguration {
  return { ...structuredClone(draft), organizationId: previous?.organizationId ?? "validation-organization",
    ownerUserId: previous?.ownerUserId ?? "validation-owner", domainId: previous?.domainId ?? "validation-domain",
    policyVersionId: `validation-next-${previous?.revision ?? 0}`, revision: (previous?.revision ?? 0) + 1,
    ...(previous ? { previousVersionId: previous.policyVersionId } : {}) };
}
/** Explicit future selection; it never makes a draft active or silently retimes a submission. */
export function suggestedStart(now: number, previous?: DomainConfiguration): string {
  const after = Math.max(now + SUGGESTED_START_LEAD_MS, previous ? Date.parse(previous.effectiveFrom) : 0);
  return new Date((Math.floor(after / 60000) + 1) * 60000).toISOString();
}
export function toLocalInput(instant: string): string {
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
export function fromLocalInput(input: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(input)) throw new Error("Choose a valid date and time.");
  const date = new Date(input);
  if (!Number.isFinite(date.getTime()) || toLocalInput(date.toISOString()) !== input)
    throw new Error("This local time does not exist. Choose another time.");
  return date.toISOString();
}
export function numericInput(value: string, integer: boolean): number {
  if (value.trim() === "" || !/^\d+(?:\.\d+)?$/.test(value)) throw new Error("Enter a nonnegative amount.");
  const number = Number(value);
  if (!Number.isFinite(number) || (integer && !Number.isSafeInteger(number)))
    throw new Error(integer ? "Use a whole number within the supported exact range." : "Use a finite nonnegative number.");
  return number;
}
export function measurementFor(kind: MeasurementKind, ids: DraftIdentities): MeasurementDefinition {
  const common = { measurementId: ids.amount, displayName: "Practice amount", meaning: "Amount recorded for each practice event",
    role: "practice" as const, comparisonDirection: "higher_is_better" as const, scope: { kind: "per_event" as const } };
  if (kind === "frequency") return { ...common, displayName: "Practice events", meaning: "Any logged practice events in the chosen period",
    kind, valueType: "integer", unit: { unitId: ids.amountUnit, dimension: "events", customLabel: "events" },
    scope: { kind: "period", windowDays: 7 }, aggregation: "count", countBy: "events" };
  if (kind === "completion") return { ...common, displayName: "Practice completed", meaning: "Whether this practice was completed",
    kind, valueType: "boolean", comparisonDirection: "equal", unit: { unitId: ids.amountUnit, dimension: "boolean", customLabel: "completion" }, aggregation: "any" };
  if (kind === "duration") return { ...common, displayName: "Practice duration", kind, valueType: "number",
    unit: { unitId: ids.amountUnit, dimension: "time", customLabel: "minutes" }, aggregation: "sum" };
  if (kind === "quantity") return { ...common, kind, valueType: "number",
    unit: { unitId: ids.amountUnit, dimension: "quantity", customLabel: "items" }, aggregation: "sum" };
  return { ...common, kind, valueType: "integer",
    unit: { unitId: ids.amountUnit, dimension: "count", customLabel: kind === "repetitions" ? "repetitions" : "items" }, aggregation: "sum" };
}
export function conditionFor(measurement: MeasurementDefinition, upper = false): TypedCondition {
  const common = { measurementId: measurement.measurementId, unitId: measurement.unit.unitId,
    basis: structuredClone(measurement.scope), ...(measurement.taskVariantId ? { taskVariantId: measurement.taskVariantId } : {}) };
  return measurement.valueType === "boolean" ? { ...common, valueType: "boolean", constraint: { operator: "eq", value: true } } :
    { ...common, valueType: measurement.valueType, constraint: { operator: upper ? "lte" : "gte", value: 1 } };
}
export function newPolicyDraft(boundary: DomainPolicyDraft["boundary"], ids: DraftIdentities,
  now: number, kind: MeasurementKind = "duration"): DomainPolicyDraft {
  const measurement = measurementFor(kind, ids), effectiveFrom = suggestedStart(now);
  return { schemaVersion: 1, displayName: "", effectiveFrom, goal: { intent: "unknown", desiredCapability: "" },
    boundary: structuredClone(boundary), taskVariants: [], measurements: [measurement],
    targets: { normal: { targetId: ids.normal, conditions: [conditionFor(measurement)] } }, references: [],
    review: { anchorAt: effectiveFrom, intervalDays: 84 } };
}
export function prospectivePolicyDraft(previous: DomainConfiguration, now: number): DomainPolicyDraft {
  return { ...policyDraft(previous), effectiveFrom: suggestedStart(now, previous) };
}
/** The first creator can replace its unsaved measure; stored measurement meaning is never edited. */
export function replaceUnsavedMeasurement(draft: DomainPolicyDraft, kind: MeasurementKind, ids: DraftIdentities): DomainPolicyDraft {
  const measurement = measurementFor(kind, ids);
  return { ...draft, measurements: [measurement], targets: { normal: { targetId: ids.normal,
    conditions: [conditionFor(measurement)] } }, references: [], qualification: undefined };
}
export function withPracticeFrequency(draft: DomainPolicyDraft, ids: DraftIdentities, enabled: boolean): DomainPolicyDraft {
  const next = structuredClone(draft);
  const without = (conditions: TypedCondition[]) => conditions.filter(c => c.measurementId !== ids.frequency);
  next.measurements = next.measurements.filter(m => m.measurementId !== ids.frequency);
  next.targets.normal.conditions = without(next.targets.normal.conditions);
  if (next.targets.adapted) next.targets.adapted.target.conditions = without(next.targets.adapted.target.conditions);
  if (next.targets.upperRecovery) next.targets.upperRecovery.conditions = without(next.targets.upperRecovery.conditions);
  next.references = next.references.map(r => r.status === "known" ? { ...r, conditions: without(r.conditions), evidence: { ...r.evidence, review: { status: "unreviewed" } } } : r);
  // Empty secondary structures are removed only when their sole measure was explicitly removed.
  next.references = next.references.filter(r => r.status !== "known" || r.conditions.length > 0);
  if (next.targets.upperRecovery?.conditions.length === 0) delete next.targets.upperRecovery;
  if (enabled) {
    const frequency: MeasurementDefinition = { measurementId: ids.frequency, displayName: "Practice events",
      meaning: "Any logged practice events in the chosen period", role: "practice", comparisonDirection: "higher_is_better",
      scope: { kind: "period", windowDays: 7 }, kind: "frequency", valueType: "integer",
      unit: { unitId: ids.frequencyUnit, dimension: "events", customLabel: "events" }, aggregation: "count", countBy: "events" };
    next.measurements.push(frequency); next.targets.normal.conditions.push(conditionFor(frequency));
  }
  return next;
}
export function editReference(previous: ReferenceDraft, next: ReferenceDraft): ReferenceDraft {
  const result = structuredClone(next);
  if (JSON.stringify(previous) !== JSON.stringify(next)) result.evidence.review = { status: "unreviewed" };
  return result;
}
export function newReference(referenceId: string, purpose: ReferenceDraft["purpose"]): ReferenceDraft {
  return { referenceId, purpose, status: "unknown", applicability: { description: "" },
    evidence: { category: "personal", review: { status: "unreviewed" }, confidence: "unknown" } };
}
export function validatePolicyDraft(draft: DomainPolicyDraft, reason: string, now: number,
  previous?: DomainConfiguration): DraftIssue[] {
  const issues: DraftIssue[] = [];
  if (!reason.trim() || reason.trim().length > 500) issues.push({ path: "reason", code: "reason", message: "Give a change reason of 1 to 500 characters." });
  if (!Number.isFinite(Date.parse(draft.effectiveFrom)) || Date.parse(draft.effectiveFrom) < now + MINIMUM_START_LEAD_MS)
    issues.push({ path: "effectiveFrom", code: "future_start", message: "Choose a start at least 15 minutes from now. The server will check the time again." });
  if (draft.displayName.trim().length > 500) issues.push({ path: "displayName", code: "name_length", message: "Use a name of at most 500 characters." });
  const configuration = validationConfiguration(draft, previous);
  const parsed = DomainConfigurationSchema.safeParse(configuration);
  if (!parsed.success) issues.push(...parsed.error.issues.map(i => ({ path: i.path.join("."), code: i.code, message: i.message })));
  else if (previous) {
    const result = validateProspectiveRevision(previous, parsed.data, draft.effectiveFrom);
    if (!result.success) issues.push(...result.issues);
    if (draft.displayName !== previous.displayName) issues.push({ path: "displayName", code: "name_readonly", message: "This future configuration must keep the saved domain name." });
  }
  return issues;
}
