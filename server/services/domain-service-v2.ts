import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DomainConfigurationSchema, type DomainConfiguration, type TypedCondition } from "../../shared/domain-config";
import { BoundaryError } from "../lib/org-context";
import type { createPinnedOwnershipUnit, OwnershipUnit } from "../lib/pinned-ownership-unit";
import { createPolicyV2Storage } from "../storage/policy-v2-storage";

type Unit = ReturnType<typeof createPinnedOwnershipUnit>;
type Request = Parameters<Unit["run"]>[0];
type Store = ReturnType<typeof createPolicyV2Storage>;
export type DomainConfigurationDraft = Omit<DomainConfiguration,
  "organizationId" | "ownerUserId" | "domainId" | "policyVersionId" | "revision" | "previousVersionId">;
const id = z.string().min(1).max(200).refine(x => x.trim() === x && !/[\u0000-\u001f\u007f]/.test(x) && x !== "__proto__");
const reason = z.string().trim().min(1).max(500);
const createInput = z.object({ slug: z.string().min(1).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  configuration: z.unknown(), reason }).strict();
const configureInput = z.object({ expectedPolicyVersionId: id, configuration: z.unknown(), reason }).strict();
const serverFields = new Set(["organizationId", "ownerUserId", "domainId", "policyVersionId", "revision", "previousVersionId"]);
export class DomainInputError extends BoundaryError {
  constructor(public readonly issues: readonly { path: string; code: string; message: string }[]) { super(400); }
}
function invalid(path: string, code: string, message: string): never {
  throw new DomainInputError([{ path, code, message }]);
}
function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new DomainInputError(result.error.issues.map(issue => ({
    path: issue.path.join("."), code: issue.code, message: issue.message,
  })));
  return result.data;
}
function draft(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid("configuration", "invalid_configuration", "Provide a domain configuration.");
  // Do not strip or silently accept caller-supplied authority/lineage fields.
  const copied = { ...value } as Record<string, unknown>;
  if (Object.keys(copied).some(key => serverFields.has(key)))
    return invalid("configuration", "server_identity", "Organization, owner and version identities are assigned by the server.");
  return copied;
}
function configuration(value: unknown, unit: OwnershipUnit, domainId: string,
  revision: number, previousVersionId?: string): DomainConfiguration {
  const supplied = draft(value);
  const result = parse(DomainConfigurationSchema, { ...supplied, organizationId: unit.context.orgId,
    ownerUserId: unit.context.actorUserId, domainId, policyVersionId: randomUUID(), revision,
    ...(previousVersionId ? { previousVersionId } : {}) });
  const displayName = result.displayName.trim();
  if (!displayName) return invalid("configuration.displayName", "empty_name", "Provide a nonblank domain name.");
  if (displayName.length > 500)
    return invalid("configuration.displayName", "name_length", "Use a name of at most 500 characters.");
  return { ...result, displayName };
}
const same = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b))
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => same(v, b[i]));
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
  return Object.keys(x).length === Object.keys(y).length && Object.keys(x).every(k => Object.hasOwn(y, k) && same(x[k], y[k]));
};
type ComparisonStatus = "meets_reference" | "below_reference" | "not_comparable" | "unknown" | "not_applicable";
export interface ReferenceComparison {
  referenceId: string; targetKind: "normal" | "adapted"; targetId: string;
  active: boolean; status: ComparisonStatus; message: string;
  conditions: { measurementId: string; status: ComparisonStatus }[];
}
function compareCondition(c: DomainConfiguration, reference: TypedCondition, selected: TypedCondition): ComparisonStatus {
  if (reference.measurementId !== selected.measurementId || reference.unitId !== selected.unitId ||
    reference.valueType !== selected.valueType || reference.taskVariantId !== selected.taskVariantId ||
    !same(reference.basis, selected.basis) || !same(reference.periodAggregation, selected.periodAggregation)) return "not_comparable";
  const measurement = c.measurements.find(m => m.measurementId === reference.measurementId);
  if (!measurement) return "not_comparable";
  if (reference.valueType === "boolean" && selected.valueType === "boolean") {
    if (measurement.comparisonDirection !== "equal") return "not_comparable";
    return reference.constraint.value === selected.constraint.value ? "meets_reference" : "below_reference";
  }
  if (reference.valueType === "boolean" || selected.valueType === "boolean") return "not_comparable";
  const numericR = reference.constraint, numericT = selected.constraint;
  // A declared exact reference remains exact under every direction. It is
  // never silently widened into a minimum/maximum or overachievement target.
  if (numericR.operator === "eq") {
    if (numericT.operator !== "eq") return "not_comparable";
    return numericT.value === numericR.value ? "meets_reference" : "below_reference";
  }
  if (measurement.comparisonDirection === "higher_is_better" &&
    numericR.operator === "gte" && ["gte", "eq"].includes(numericT.operator) && numericT.operator !== "range")
    return numericT.value >= numericR.value ? "meets_reference" : "below_reference";
  if (measurement.comparisonDirection === "lower_is_better" &&
    numericR.operator === "lte" && ["lte", "eq"].includes(numericT.operator) && numericT.operator !== "range")
    return numericT.value <= numericR.value ? "meets_reference" : "below_reference";
  if (measurement.comparisonDirection === "within_range" && numericR.operator === "range") {
    if (numericT.operator === "range")
      return numericT.min >= numericR.min && numericT.max <= numericR.max ? "meets_reference" : "below_reference";
    if (numericT.operator === "eq") return numericT.value >= numericR.min && numericT.value <= numericR.max ? "meets_reference" : "below_reference";
  }
  return "not_comparable";
}
/** Compares declared configuration targets, not activity, scientific benefit or a score. */
export function referenceComparisonsFor(c: DomainConfiguration, asOf: Date): ReferenceComparison[] {
  if (!(asOf instanceof Date) || !Number.isFinite(asOf.getTime())) throw new BoundaryError(503);
  const adaptationActive = !!c.targets.adapted && Date.parse(c.targets.adapted.effectiveFrom) <= asOf.getTime();
  const selected: { kind: "normal" | "adapted"; target: DomainConfiguration["targets"]["normal"]; active: boolean }[] =
    [{ kind: "normal", target: c.targets.normal, active: !adaptationActive }];
  if (c.targets.adapted) selected.push({ kind: "adapted", target: c.targets.adapted.target,
    active: Date.parse(c.targets.adapted.effectiveFrom) <= asOf.getTime() });
  return c.references.flatMap(reference => selected.map(selection => {
    let status: ComparisonStatus;
    const conditions: ReferenceComparison["conditions"] = [];
    const declaredTaskConditions = reference.applicability.taskVariantId ?
      c.taskVariants.find(v => v.variantId === reference.applicability.taskVariantId)?.taskConditions : c.goal.taskConditions;
    if (reference.status === "unknown") status = "unknown";
    else if (reference.status === "not_applicable") status = "not_applicable";
    else if (reference.purpose !== c.goal.intent ||
      (reference.applicability.taskConditions !== undefined && !same(reference.applicability.taskConditions, declaredTaskConditions))) status = "not_comparable";
    else {
      for (const condition of reference.conditions) {
        const matches = selection.target.conditions.filter(t => t.measurementId === condition.measurementId && t.unitId === condition.unitId &&
          t.taskVariantId === condition.taskVariantId && same(t.basis, condition.basis) && same(t.periodAggregation, condition.periodAggregation));
        conditions.push({ measurementId: condition.measurementId,
          status: matches.length === 1 ? compareCondition(c, condition, matches[0]) : "not_comparable" });
      }
      status = conditions.some(x => x.status === "not_comparable") ? "not_comparable" :
        conditions.some(x => x.status === "below_reference") ? "below_reference" : "meets_reference";
    }
    const messages: Record<ComparisonStatus, string> = {
      below_reference: "The selected target does not meet this declared reference. You may keep it; this does not mean the activity has no value.",
      meets_reference: "The selected target meets this declared reference; this is not an activity score.",
      not_comparable: "These targets and reference cannot be compared without matching purpose, units, basis and conditions.",
      unknown: "This reference is unknown. No minimum or percentage has been inferred.",
      not_applicable: "This reference is marked not applicable.",
    };
    return { referenceId: reference.referenceId, targetKind: selection.kind, targetId: selection.target.targetId,
      active: selection.active, status, message: messages[status], conditions };
  }));
}
function serverClock(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new BoundaryError(503);
  return value;
}
async function view(store: Store, domain: Record<string, any>, asOf: Date) {
  const policies = (await store.policies.list()).filter(p => p.domain_id === domain.domain_id).sort((a, b) => a.revision - b.revision);
  const versions = policies.map(p => {
    const parsed = DomainConfigurationSchema.safeParse(p.configuration);
    if (!parsed.success) throw new BoundaryError(503);
    return { configuration: parsed.data, referenceComparisons: referenceComparisonsFor(parsed.data, asOf) };
  });
  const current = versions.filter(p => Date.parse(p.configuration.effectiveFrom) <= asOf.getTime()).at(-1);
  return { domainId: domain.domain_id as string, slug: domain.slug as string, displayName: domain.display_name as string,
    currentPolicyVersionId: current?.configuration.policyVersionId ?? null,
    policyVersions: versions, scoreAvailability: "not_calculated" as const };
}
/** Existing Passport request and checked-out transaction are retained end-to-end. */
export function createDomainServiceV2(unit: Unit, options: { clock?: () => Date } = {}) {
  if (!unit || typeof unit.run !== "function" || !options || typeof options !== "object" ||
    Object.keys(options).some(key => key !== "clock") || (Object.hasOwn(options, "clock") && typeof options.clock !== "function"))
    throw new BoundaryError(503);
  const clock = options.clock ?? (() => new Date());
  return Object.freeze({
    list: (request: Request) => unit.run(request, async ownership => {
      const store = createPolicyV2Storage(ownership.db, ownership.context, { clock });
      const at = serverClock(clock), result = [];
      for (const domain of await store.domains.list()) result.push(await view(store, domain, at));
      return { domains: result };
    }),
    read: (request: Request, key: unknown) => unit.run(request, async ownership => {
      const domainId = parse(id, key), store = createPolicyV2Storage(ownership.db, ownership.context, { clock });
      return view(store, await store.domains.get([domainId]), serverClock(clock));
    }),
    create: (request: Request, input: unknown) => unit.run(request, async ownership => {
      const p = parse(createInput, input), domainId = randomUUID(), c = configuration(p.configuration, ownership, domainId, 1);
      const store = createPolicyV2Storage(ownership.db, ownership.context, { clock });
      const created = await store.domains.createWithPolicy({ domainId, slug: p.slug, displayName: c.displayName }, c, p.reason);
      return view(store, created.domain, serverClock(clock));
    }),
    configure: (request: Request, key: unknown, input: unknown) => unit.run(request, async ownership => {
      const domainId = parse(id, key), p = parse(configureInput, input), store = createPolicyV2Storage(ownership.db, ownership.context, { clock });
      const domain = await store.domains.get([domainId]);
      const previous = (await store.policies.list()).filter(policy => policy.domain_id === domainId).sort((a, b) => a.revision - b.revision).at(-1);
      if (!previous || previous.policy_version_id !== p.expectedPolicyVersionId)
        return invalid("expectedPolicyVersionId", "version_conflict", "Reload this domain before saving a new policy version.");
      const c = configuration(p.configuration, ownership, domainId, previous.revision + 1, previous.policy_version_id);
      await store.policies.append(c, p.reason);
      const renamed = c.displayName === domain.display_name ? domain : await store.domains.update([domainId], { displayName: c.displayName }, p.reason);
      return view(store, renamed, serverClock(clock));
    }),
  });
}
