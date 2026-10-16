import { z } from "zod";

/**
 * Pure contract slice, schemaVersion 1. No scoring, bucketing, expression
 * execution, ambient clock, authentication, persistence or migration.
 * Referential tenant checks below are NOT authenticated tenant isolation.
 */
const Id = z.string().min(1).max(200).refine(
  s => s.trim() === s && !/[\u0000-\u001f\u007f]/.test(s) && s !== "__proto__",
  "Nonempty opaque identity required; __proto__ is reserved",
);
const Text = z.string().min(1).refine(s => s.trim().length > 0, "Nonblank text required");
const Timestamp = z.string().datetime({ offset: true }).refine(
  s => Number.isFinite(Date.parse(s)), "Valid timestamp with explicit offset required",
);
const Amount = z.number().finite().nonnegative();
const IntegerAmount = Amount.int();
const PositiveDays = z.number().int().positive();
const PerEvent = z.object({ kind: z.literal("per_event") }).strict();
const Period = z.object({ kind: z.literal("period"), windowDays: PositiveDays }).strict();
const Basis = z.discriminatedUnion("kind", [PerEvent, Period]);
const TaskCondition = z.object({ conditionId: Id, description: Text }).strict();
const TaskVariant = z.object({
  variantId: Id, displayName: Text, taskConditions: z.array(TaskCondition),
}).strict();
const Unit = z.object({
  unitId: Id,
  dimension: z.enum(["time", "count", "distance", "quantity", "boolean", "events", "days"]),
  customLabel: Text.optional(),
}).strict();
const measurementFields = {
  measurementId: Id, displayName: Text, meaning: Text,
  role: z.enum(["practice", "outcome", "context"]),
  comparisonDirection: z.enum(["higher_is_better", "lower_is_better", "within_range", "equal"]),
  scope: Basis, taskVariantId: Id.optional(),
};
const Measurement = z.discriminatedUnion("kind", [
  z.object({ ...measurementFields, kind: z.literal("duration"), valueType: z.literal("number"),
    unit: Unit.extend({ dimension: z.literal("time") }),
    aggregation: z.enum(["sum", "mean", "last"]) }).strict(),
  z.object({ ...measurementFields, kind: z.enum(["repetitions", "count"]), valueType: z.literal("integer"),
    unit: Unit.extend({ dimension: z.literal("count") }),
    aggregation: z.enum(["sum", "last"]) }).strict(),
  z.object({ ...measurementFields, kind: z.literal("quantity"), valueType: z.literal("number"),
    unit: Unit.extend({ dimension: z.enum(["distance", "quantity"]) }),
    aggregation: z.enum(["sum", "mean", "last"]) }).strict(),
  z.object({ ...measurementFields, kind: z.literal("completion"), valueType: z.literal("boolean"),
    unit: Unit.extend({ dimension: z.literal("boolean") }),
    aggregation: z.enum(["any", "all", "last"]), comparisonDirection: z.literal("equal") }).strict(),
  z.object({ ...measurementFields, kind: z.literal("frequency"), valueType: z.literal("integer"),
    unit: Unit.extend({ dimension: z.enum(["events", "days"]) }),
    aggregation: z.literal("count"), countBy: z.enum(["events", "distinct_days"]),
    scope: Period }).strict(),
]);
export type MeasurementDefinition = z.infer<typeof Measurement>;

function numericConstraint(numberSchema: typeof Amount) {
  return z.discriminatedUnion("operator", [
    z.object({ operator: z.enum(["eq", "gte", "lte"]), value: numberSchema }).strict(),
    z.object({ operator: z.literal("range"), min: numberSchema, max: numberSchema }).strict(),
  ]).refine(c => c.operator !== "range" || c.min <= c.max, "Range must be ordered");
}
const conditionFields = {
  measurementId: Id, unitId: Id, basis: Basis, taskVariantId: Id.optional(),
  // Explicit declaration only: a cumulative period choice over raw per-event
  // amounts. Does not compute sums, equate thresholds or convert units.
  periodAggregation: z.object({
    sourceBasis: z.literal("per_event"), method: z.literal("sum"),
  }).strict().optional(),
};
const Condition = z.discriminatedUnion("valueType", [
  z.object({ ...conditionFields, valueType: z.literal("number"), constraint: numericConstraint(Amount) }).strict(),
  z.object({ ...conditionFields, valueType: z.literal("integer"), constraint: numericConstraint(IntegerAmount) }).strict(),
  z.object({ ...conditionFields, valueType: z.literal("boolean"),
    constraint: z.object({ operator: z.literal("eq"), value: z.boolean() }).strict() }).strict(),
]);
export type TypedCondition = z.infer<typeof Condition>;
export type QualificationPredicate =
  | { kind: "condition"; condition: TypedCondition }
  | { kind: "all" | "any"; predicates: QualificationPredicate[] };
const Predicate: z.ZodType<QualificationPredicate> = z.lazy(() => z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("condition"), condition: Condition }).strict(),
  z.object({ kind: z.enum(["all", "any"]), predicates: z.array(Predicate).min(1) }).strict(),
]));
const Target = z.object({
  targetId: Id, displayName: Text.optional(),
  // An explicit conjunction, not an executable expression.
  conditions: z.array(Condition).min(1),
}).strict();
const AdaptedTarget = z.object({
  target: Target, effectiveFrom: Timestamp, duration: z.enum(["temporary", "ongoing"]),
  reviewAt: Timestamp.optional(), reason: Text.optional(),
}).strict().refine(a => !a.reviewAt || Date.parse(a.reviewAt) >= Date.parse(a.effectiveFrom),
  "Adaptation review cannot precede its start");
const EvidenceReview = z.discriminatedUnion("status", [
  z.object({ status: z.literal("unreviewed") }).strict(),
  z.object({ status: z.literal("reviewed"), reviewedAt: Timestamp, reviewerId: Id }).strict(),
]);
const Evidence = z.object({
  category: z.enum(["personal", "published", "professional", "community", "unspecified"]),
  source: z.object({ description: Text, url: z.string().url().optional() }).strict().optional(),
  review: EvidenceReview,
  confidence: z.enum(["unknown", "low", "moderate", "high"]),
}).strict();
const referenceFields = {
  referenceId: Id, purpose: z.enum(["maintain", "develop", "general_wellbeing"]),
  applicability: z.object({
    description: Text, taskVariantId: Id.optional(), taskConditions: z.array(TaskCondition).optional(),
  }).strict(),
  evidence: Evidence,
};
const Reference = z.discriminatedUnion("status", [
  z.object({ ...referenceFields, status: z.literal("known"), conditions: z.array(Condition).min(1) }).strict(),
  z.object({ ...referenceFields, status: z.literal("unknown"), note: Text.optional() }).strict(),
  z.object({ ...referenceFields, status: z.literal("not_applicable"), note: Text.optional() }).strict(),
]);
const Review = z.object({
  anchorAt: Timestamp, intervalDays: PositiveDays.default(84),
  lastReviewedAt: Timestamp.optional(), nextReviewAt: Timestamp.optional(),
}).strict().superRefine((r, ctx) => {
  if (r.lastReviewedAt && Date.parse(r.lastReviewedAt) < Date.parse(r.anchorAt))
    issue(ctx, ["lastReviewedAt"], "review_order", "Review precedes anchor");
  if (r.nextReviewAt && Date.parse(r.nextReviewAt) < Date.parse(r.lastReviewedAt ?? r.anchorAt))
    issue(ctx, ["nextReviewAt"], "review_order", "Next review precedes anchor/last review");
});
const ConfigurationObject = z.object({
  schemaVersion: z.literal(1),
  organizationId: Id, ownerUserId: Id, domainId: Id, policyVersionId: Id,
  revision: z.number().int().positive(), effectiveFrom: Timestamp, previousVersionId: Id.optional(),
  templateLineage: z.object({
    templateId: Id, templateVersionId: Id, revision: z.number().int().positive(),
  }).strict().optional(),
  displayName: Text,
  goal: z.object({
    intent: z.enum(["develop", "maintain", "general_wellbeing", "unknown"]),
    desiredCapability: Text, privateMotivation: Text.optional(),
    currentCapability: z.object({ assessedAt: Timestamp, assessment: Text }).strict().optional(),
    taskConditions: z.array(TaskCondition).optional(),
  }).strict(),
  boundary: z.object({
    timezone: Text.refine(tz => {
      try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
    }, "Recognized timezone required"),
    dayStartHour: z.number().int().min(0).max(23),
  }).strict(),
  taskVariants: z.array(TaskVariant),
  measurements: z.array(Measurement).min(1),
  targets: z.object({
    normal: Target, stretch: Target.optional(), adapted: AdaptedTarget.optional(),
    upperRecovery: z.object({ conditions: z.array(Condition).min(1), guidance: Text.optional() }).strict().optional(),
  }).strict(),
  qualification: Predicate.optional(),
  references: z.array(Reference),
  review: Review,
}).strict();
type ConfigurationData = z.infer<typeof ConfigurationObject>;
type Path = (string | number)[];
function issue(ctx: z.RefinementCtx, path: Path, code: string, message: string): void {
  ctx.addIssue({ code: z.ZodIssueCode.custom, path, message, params: { contractCode: code } });
}
function unique(values: string[], path: Path, ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  values.forEach((value, i) => {
    if (seen.has(value)) issue(ctx, [...path, i], "duplicate_identity", "Duplicate identity in this scope");
    seen.add(value);
  });
}
function sameBasis(a: z.infer<typeof Basis>, b: z.infer<typeof Basis>): boolean {
  return a.kind === b.kind && (a.kind !== "period" || (b.kind === "period" && a.windowDays === b.windowDays));
}
function checkCondition(c: ConfigurationData, condition: TypedCondition, path: Path, ctx: z.RefinementCtx): void {
  const m = c.measurements.find(m => m.measurementId === condition.measurementId);
  if (!m) { issue(ctx, [...path, "measurementId"], "unknown_measurement", "Condition must resolve a declared measurement"); return; }
  if (condition.unitId !== m.unit.unitId) issue(ctx, [...path, "unitId"], "unit_mismatch", "No implicit unit conversion");
  if (condition.valueType !== m.valueType) issue(ctx, [...path, "valueType"], "value_type_mismatch", "Condition type must match measurement");
  const declaredPeriodSum = condition.periodAggregation !== undefined &&
    m.scope.kind === "per_event" && condition.basis.kind === "period" &&
    m.valueType !== "boolean" && m.kind !== "frequency" && m.aggregation === "sum";
  if (condition.periodAggregation !== undefined && !declaredPeriodSum)
    issue(ctx, [...path, "periodAggregation"], "invalid_period_aggregation", "Only explicit sum-capable numeric per-event amounts may feed a period sum condition");
  if (!sameBasis(condition.basis, m.scope) && !declaredPeriodSum)
    issue(ctx, [...path, "basis"], "basis_mismatch", "Different bases require permitted explicit aggregation; frequency windows must match exactly");
  if (condition.taskVariantId !== m.taskVariantId) issue(ctx, [...path, "taskVariantId"], "variant_mismatch", "No implicit task-variant conversion");
  if (m.kind === "frequency" && m.countBy === "distinct_days" && condition.valueType !== "boolean") {
    const x = condition.constraint;
    const maximum = x.operator === "range" ? x.max : x.value;
    if (maximum > m.scope.windowDays) issue(ctx, [...path, "constraint"], "frequency_target_exceeds_days", "Distinct-day target cannot exceed period days");
  }
}
function checkPredicate(c: ConfigurationData, p: QualificationPredicate, path: Path, ctx: z.RefinementCtx): void {
  if (p.kind === "condition") checkCondition(c, p.condition, [...path, "condition"], ctx);
  else p.predicates.forEach((child, i) => checkPredicate(c, child, [...path, "predicates", i], ctx));
}
function checkConfiguration(c: ConfigurationData, ctx: z.RefinementCtx): void {
  if ((c.revision === 1) !== (c.previousVersionId === undefined))
    issue(ctx, ["previousVersionId"], "predecessor_required", "Revision one has no predecessor; later revisions require one");
  if (c.previousVersionId === c.policyVersionId)
    issue(ctx, ["previousVersionId"], "version_reuse", "A revision cannot precede itself");
  unique(c.measurements.map(m => m.measurementId), ["measurements"], ctx);
  unique(c.taskVariants.map(v => v.variantId), ["taskVariants"], ctx);
  unique(c.references.map(r => r.referenceId), ["references"], ctx);
  const targetIds = [c.targets.normal.targetId, c.targets.stretch?.targetId, c.targets.adapted?.target.targetId].filter((x): x is string => x !== undefined);
  unique(targetIds, ["targets"], ctx);
  const variants = new Set(c.taskVariants.map(v => v.variantId));
  c.taskVariants.forEach((v, i) => unique(v.taskConditions.map(t => t.conditionId), ["taskVariants", i, "taskConditions"], ctx));
  c.measurements.forEach((m, i) => {
    if (m.taskVariantId && !variants.has(m.taskVariantId)) issue(ctx, ["measurements", i, "taskVariantId"], "unknown_variant", "Variant must be declared");
    if (m.kind === "frequency" && m.unit.dimension !== (m.countBy === "events" ? "events" : "days"))
      issue(ctx, ["measurements", i, "unit"], "frequency_unit_mismatch", "Event/day frequency requires its own unit dimension");
  });
  const lists: Array<[Path, TypedCondition[]]> = [
    [["targets", "normal", "conditions"], c.targets.normal.conditions],
    [["targets", "stretch", "conditions"], c.targets.stretch?.conditions ?? []],
    [["targets", "adapted", "target", "conditions"], c.targets.adapted?.target.conditions ?? []],
    [["targets", "upperRecovery", "conditions"], c.targets.upperRecovery?.conditions ?? []],
  ];
  c.references.forEach((r, i) => {
    if (r.applicability.taskVariantId && !variants.has(r.applicability.taskVariantId))
      issue(ctx, ["references", i, "applicability", "taskVariantId"], "unknown_variant", "Reference variant must be declared");
    if (r.status === "known") {
      lists.push([["references", i, "conditions"], r.conditions]);
      r.conditions.forEach((condition, j) => {
        if (r.applicability.taskVariantId !== undefined && condition.taskVariantId !== r.applicability.taskVariantId)
          issue(ctx, ["references", i, "conditions", j], "variant_mismatch", "Reference applicability must match its conditions");
      });
    }
  });
  lists.forEach(([p, conditions]) => conditions.forEach((condition, i) => checkCondition(c, condition, [...p, i], ctx)));
  if (c.qualification) checkPredicate(c, c.qualification, ["qualification"], ctx);
  // Below-reference and zero targets are intentional choices, not validation failures.
}
export const DomainConfigurationSchema = ConfigurationObject.superRefine(checkConfiguration);
export type DomainConfiguration = z.infer<typeof DomainConfigurationSchema>;

const observationValueFields = { unitId: Id, taskVariantId: Id.optional() };
const ObservationValue = z.discriminatedUnion("valueType", [
  z.object({ ...observationValueFields, valueType: z.literal("number"), value: Amount }).strict(),
  z.object({ ...observationValueFields, valueType: z.literal("integer"), value: IntegerAmount }).strict(),
  z.object({ ...observationValueFields, valueType: z.literal("boolean"), value: z.boolean() }).strict(),
]);
// Check raw own keys BEFORE Zod's record parser can discard __proto__.
// This also rejects a non-enumerable own property without mutating the input.
const ObservationValues = z.unknown().superRefine((value, ctx) => {
  if (value !== null && typeof value === "object" &&
      Object.prototype.hasOwnProperty.call(value, "__proto__"))
    issue(ctx, ["__proto__"], "reserved_record_identity", "__proto__ cannot be a measurement record key");
}).pipe(z.record(Id, ObservationValue));
export const ObservationSchema = z.object({
  schemaVersion: z.literal(1), observationId: Id,
  organizationId: Id, ownerUserId: Id, domainId: Id, policyVersionId: Id,
  observedAt: Timestamp,
  values: ObservationValues,
  notes: z.string().optional(),
  context: z.object({ description: Text.optional(), taskConditions: z.array(TaskCondition).optional() }).strict().optional(),
}).strict();
export type Observation = z.infer<typeof ObservationSchema>;
export type ValidationIssue = { path: string; code: string; message: string };
export type ValidationResult = { success: true } | { success: false; issues: ValidationIssue[] };
function fromIssues(issues: ValidationIssue[]): ValidationResult {
  return issues.length ? { success: false, issues } : { success: true };
}
function zodIssues(error: z.ZodError, prefix: string): ValidationIssue[] {
  return error.issues.map(i => ({
    path: [prefix, ...i.path].filter(x => x !== "").join(".") || "$",
    code: i.code === "custom" && typeof i.params?.contractCode === "string" ? i.params.contractCode : i.code,
    message: i.message,
  }));
}
function contextIssues(c: DomainConfiguration, o: Observation): ValidationIssue[] {
  const errors: ValidationIssue[] = [];
  const add = (path: string, code: string, message: string) => errors.push({ path, code, message });
  for (const key of ["organizationId", "ownerUserId", "domainId", "policyVersionId"] as const)
    if (c[key] !== o[key]) add(`observation.${key}`, "context_mismatch", "Observation identity does not resolve this configuration");
  if (Date.parse(o.observedAt) < Date.parse(c.effectiveFrom))
    add("observation.observedAt", "before_effective", "Observation precedes its referenced version");
  for (const [id, value] of Object.entries(o.values)) {
    const m = c.measurements.find(m => m.measurementId === id);
    if (!m) { add(`observation.values.${id}`, "unknown_measurement", "Unknown supplied measurement"); continue; }
    if (value.unitId !== m.unit.unitId) add(`observation.values.${id}.unitId`, "unit_mismatch", "No implicit unit conversion");
    if (value.valueType !== m.valueType) add(`observation.values.${id}.valueType`, "value_type_mismatch", "Observation type must match definition");
    if (value.taskVariantId !== m.taskVariantId) add(`observation.values.${id}.taskVariantId`, "variant_mismatch", "No implicit task-variant conversion");
  }
  return errors;
}
export function validateObservationContext(configuration: unknown, observation: unknown): ValidationResult {
  const c = DomainConfigurationSchema.safeParse(configuration), o = ObservationSchema.safeParse(observation);
  if (!c.success || !o.success) return fromIssues([
    ...(!c.success ? zodIssues(c.error, "configuration") : []),
    ...(!o.success ? zodIssues(o.error, "observation") : []),
  ]);
  // Two arguments cannot reveal an unavailable future revision/end boundary.
  return fromIssues(contextIssues(c.data, o.data));
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
function meaning(c: DomainConfiguration, m: MeasurementDefinition): string {
  const { displayName: _label, unit, ...definition } = m;
  const { customLabel: _unitLabel, ...unitIdentity } = unit;
  return canonical({ ...definition, unit: unitIdentity,
    taskConditions: m.taskVariantId ? c.taskVariants.find(v => v.variantId === m.taskVariantId)?.taskConditions : undefined });
}
function revisionIssues(previous: DomainConfiguration, next: DomainConfiguration, effectiveAt: string): ValidationIssue[] {
  const errors: ValidationIssue[] = [];
  const add = (path: string, code: string, message: string) => errors.push({ path: `next.${path}`, code, message });
  for (const key of ["organizationId", "ownerUserId", "domainId"] as const)
    if (previous[key] !== next[key]) add(key, "identity_changed", "Revision must preserve immutable domain identity");
  if (next.policyVersionId === previous.policyVersionId) add("policyVersionId", "version_reuse", "New revision requires a new version identity");
  if (next.revision !== previous.revision + 1) add("revision", "revision_sequence", "Revision must increment by one");
  if (next.previousVersionId !== previous.policyVersionId) add("previousVersionId", "predecessor_mismatch", "Predecessor must match previous version");
  if (next.effectiveFrom !== effectiveAt || Date.parse(next.effectiveFrom) <= Date.parse(previous.effectiveFrom))
    add("effectiveFrom", "effective_order", "Exact explicit effectiveAt must be later than previous effectiveFrom");
  for (const m of next.measurements) {
    const old = previous.measurements.find(p => p.measurementId === m.measurementId);
    if (old && meaning(previous, old) !== meaning(next, m)) add(`measurements.${m.measurementId}`, "measurement_redefined", "New measurement meaning requires a new identity");
  }
  return errors;
}
export function validateProspectiveRevision(previous: unknown, next: unknown, effectiveAt: unknown): ValidationResult {
  const p = DomainConfigurationSchema.safeParse(previous), n = DomainConfigurationSchema.safeParse(next), at = Timestamp.safeParse(effectiveAt);
  if (!p.success || !n.success || !at.success) return fromIssues([
    ...(!p.success ? zodIssues(p.error, "previous") : []), ...(!n.success ? zodIssues(n.error, "next") : []),
    ...(!at.success ? zodIssues(at.error, "effectiveAt") : []),
  ]);
  // Caller must later supply actual application effective time. This is not
  // an ambient-clock/runtime backdating guarantee and cannot see unseen IDs.
  return fromIssues(revisionIssues(p.data, n.data, at.data));
}
const BundleObject = z.object({
  schemaVersion: z.literal(1), configurations: z.array(DomainConfigurationSchema).min(1),
  observations: z.array(ObservationSchema),
}).strict();
const domainKey = (c: { organizationId: string; ownerUserId: string; domainId: string }) =>
  JSON.stringify([c.organizationId, c.ownerUserId, c.domainId]);
const versionKey = (c: { organizationId: string; ownerUserId: string; domainId: string; policyVersionId: string }) =>
  JSON.stringify([domainKey(c), c.policyVersionId]);
export const ConfigurationBundleSchema = BundleObject.superRefine((bundle, ctx) => {
  unique(bundle.configurations.map(versionKey), ["configurations"], ctx);
  unique(bundle.observations.map(o => JSON.stringify([o.organizationId, o.ownerUserId, o.observationId])), ["observations"], ctx);
  const groups = new Map<string, Array<{ config: DomainConfiguration; index: number }>>();
  const domainOwners = new Map<string, string>();
  bundle.configurations.forEach((config, index) => {
    // Domain UID is globally immutable, not a reusable tenant-local label.
    const owner = JSON.stringify([config.organizationId, config.ownerUserId]);
    const existing = domainOwners.get(config.domainId);
    if (existing !== undefined && existing !== owner)
      issue(ctx, ["configurations", index, "domainId"], "domain_ownership_conflict", "One domain UID must resolve to one organization/owner across the entire bundle");
    domainOwners.set(config.domainId, owner);
    const key = domainKey(config);
    groups.set(key, [...(groups.get(key) ?? []), { config, index }]);
  });
  for (const group of Array.from(groups.values())) {
    const ordered = [...group].sort((a, b) => a.config.revision - b.config.revision);
    const first = ordered[0];
    if (first.config.revision !== 1) issue(ctx, ["configurations", first.index], "incomplete_history", "Bundle requires a complete version chain from revision one");
    const meanings = new Map<string, string>();
    ordered.forEach(({ config, index }, i) => {
      if (i > 0) for (const e of revisionIssues(ordered[i - 1].config, config, config.effectiveFrom))
        issue(ctx, ["configurations", index, ...e.path.split(".").slice(1)], e.code, e.message);
      config.measurements.forEach(m => {
        const signature = meaning(config, m), known = meanings.get(m.measurementId);
        if (known !== undefined && known !== signature)
          issue(ctx, ["configurations", index, "measurements", m.measurementId], "historical_measurement_reuse", "Identity cannot be reintroduced with changed meaning after removal");
        meanings.set(m.measurementId, signature);
      });
    });
  }
  bundle.observations.forEach((o, index) => {
    const matches = bundle.configurations.filter(c => versionKey(c) === versionKey(o));
    if (matches.length !== 1) { issue(ctx, ["observations", index, "policyVersionId"], "unresolved_version", "Observation requires exactly one matching version"); return; }
    const c = matches[0];
    for (const e of contextIssues(c, o)) issue(ctx, ["observations", index, ...e.path.split(".").slice(1)], e.code, e.message);
    const following = bundle.configurations.filter(n => domainKey(n) === domainKey(c) && n.revision > c.revision)
      .sort((a, b) => a.revision - b.revision)[0];
    if (following && Date.parse(o.observedAt) >= Date.parse(following.effectiveFrom))
      issue(ctx, ["observations", index, "observedAt"], "after_effective_interval", "Observation is outside the referenced half-open version interval");
  });
});
export type ConfigurationBundle = z.infer<typeof ConfigurationBundleSchema>;