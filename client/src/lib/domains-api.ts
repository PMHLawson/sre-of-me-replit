import { z } from "zod";
import { ConfigurationBundleSchema, DomainConfigurationSchema, type DomainConfiguration } from "@shared/domain-config";

const opaqueId = z.string().min(1).max(200).refine(value =>
  value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value) && value !== "__proto__");
const comparisonStatus = z.enum(["meets_reference", "below_reference", "not_comparable", "unknown", "not_applicable"]);
const comparison = z.object({
  referenceId: opaqueId, targetKind: z.enum(["normal", "adapted"]), targetId: opaqueId,
  active: z.boolean(), status: comparisonStatus, message: z.string().min(1),
  conditions: z.array(z.object({ measurementId: opaqueId, status: comparisonStatus }).strict()),
}).strict();
const policyVersion = z.object({ configuration: DomainConfigurationSchema,
  referenceComparisons: z.array(comparison) }).strict();
const domainView = z.object({ domainId: opaqueId, slug: z.string().min(1), displayName: z.string().min(1),
  currentPolicyVersionId: opaqueId.nullable(), policyVersions: z.array(policyVersion),
  scoreAvailability: z.literal("not_calculated") }).strict();
export type PersonalDomain = z.infer<typeof domainView>;
export type PersonalPolicyVersion = PersonalDomain["policyVersions"][number];
export const PERSONAL_DOMAINS_QUERY = "personal-domains";

export class DomainsApiError extends Error {
  constructor(public readonly status: number, message?: string) {
    super(message ?? (status === 401 ? "Sign in to view your domains." :
      status === 403 ? "Your domain access is not available yet." :
      status === 404 ? "This domain is not available to your account." :
      "Your domains could not be loaded. Please try again."));
    this.name = "DomainsApiError";
  }
}
function validatedOwner(ownerId: string): string {
  const parsed = opaqueId.safeParse(ownerId);
  if (!parsed.success) throw new DomainsApiError(401);
  return parsed.data;
}
function validateDomain(value: unknown, ownerId: string): PersonalDomain {
  const parsed = domainView.safeParse(value);
  if (!parsed.success) throw new DomainsApiError(503);
  const domain = parsed.data;
  const configurations = domain.policyVersions.map(version => version.configuration);
  if (configurations.some(configuration => configuration.ownerUserId !== ownerId ||
    configuration.domainId !== domain.domainId) ||
    (configurations.length > 0 && !ConfigurationBundleSchema.safeParse({ schemaVersion: 1, configurations, observations: [] }).success) ||
    (domain.currentPolicyVersionId !== null &&
      !configurations.some(configuration => configuration.policyVersionId === domain.currentPolicyVersionId)))
    throw new DomainsApiError(503);
  for (const version of domain.policyVersions) {
    const c = version.configuration;
    if (version.referenceComparisons.some(item => !c.references.some(reference => reference.referenceId === item.referenceId) ||
      item.targetId !== (item.targetKind === "normal" ? c.targets.normal.targetId : c.targets.adapted?.target.targetId) ||
      item.conditions.some(condition => !c.measurements.some(measurement => measurement.measurementId === condition.measurementId))))
      throw new DomainsApiError(503);
  }
  return domain;
}
export function parsePersonalDomains(value: unknown, ownerId: string): PersonalDomain[] {
  const owner = validatedOwner(ownerId);
  const result = z.object({ domains: z.array(z.unknown()) }).strict().safeParse(value);
  if (!result.success) throw new DomainsApiError(503);
  const domains = result.data.domains.map(domain => validateDomain(domain, owner));
  if (new Set(domains.map(domain => domain.domainId)).size !== domains.length)
    throw new DomainsApiError(503);
  return domains;
}
export function parsePersonalDomain(value: unknown, ownerId: string, domainId: string): PersonalDomain {
  const domain = validateDomain(value, validatedOwner(ownerId));
  if (domain.domainId !== domainId) throw new DomainsApiError(503);
  return domain;
}
async function readJson(path: string, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try { response = await fetch(path, { credentials: "include", signal }); }
  catch (error) {
    if ((error as { name?: string })?.name === "AbortError") throw error;
    throw new DomainsApiError(503);
  }
  if (!response.ok) throw new DomainsApiError(response.status);
  try { return await response.json(); } catch { throw new DomainsApiError(503); }
}
/** The owner partitions local query data; authentication remains entirely server-owned. */
export function personalDomainsQuery(ownerId: string, domainId?: string) {
  const owner = validatedOwner(ownerId);
  if (domainId !== undefined && !opaqueId.safeParse(domainId).success) throw new DomainsApiError(404);
  return {
    queryKey: [PERSONAL_DOMAINS_QUERY, owner, domainId === undefined ? "list" : "domain", domainId ?? null] as const,
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<PersonalDomain[] | PersonalDomain> => {
      const value = await readJson(domainId === undefined ? "/api/v2/domains" :
        `/api/v2/domains/${encodeURIComponent(domainId)}`, signal);
      return domainId === undefined ? parsePersonalDomains(value, owner) : parsePersonalDomain(value, owner, domainId);
    },
    staleTime: 0, gcTime: 0, retry: false as const,
  };
}
/** Select active configuration from the server's identity, never from browser time/latest. */
export function personalPolicySelection(domain: PersonalDomain) {
  const ordered = [...domain.policyVersions].sort((a, b) => a.configuration.revision - b.configuration.revision);
  const current = ordered.find(version => version.configuration.policyVersionId === domain.currentPolicyVersionId) ?? null;
  return { current, latest: ordered.at(-1) ?? null,
    scheduled: current ? ordered.filter(version => version.configuration.revision > current.configuration.revision) : ordered };
}
/** Formatting only. Target/reference comparisons and activity scoring are server-owned. */
export function describeCondition(condition: DomainConfiguration["targets"]["normal"]["conditions"][number],
  configuration: DomainConfiguration): string {
  const measurement = configuration.measurements.find(item => item.measurementId === condition.measurementId);
  const label = measurement?.displayName ?? "Measurement";
  const unit = measurement?.unit.customLabel ?? measurement?.unit.unitId ?? condition.unitId;
  const value = condition.valueType === "boolean" ? (condition.constraint.value ? "completed" : "not completed") :
    condition.constraint.operator === "range" ? `${condition.constraint.min}–${condition.constraint.max} ${unit}` :
      `${condition.constraint.operator === "gte" ? "at least " : condition.constraint.operator === "lte" ? "at most " : "exactly "}${condition.constraint.value} ${unit}`;
  const basis = condition.basis.kind === "per_event" ? "per practice event" : `per ${condition.basis.windowDays} days`;
  return `${label}: ${value}, ${basis}${condition.periodAggregation ? " (sum of practice amounts)" : ""}`;
}
