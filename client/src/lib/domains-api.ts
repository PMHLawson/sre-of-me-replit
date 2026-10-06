import { z } from "zod";
import { ConfigurationBundleSchema, DomainConfigurationSchema, type DomainConfiguration } from "@shared/domain-config";
import { SERVER_POLICY_FIELDS, matchesSubmittedDraft, validationConfiguration, type DomainPolicyDraft, type DraftIssue } from "./domain-policy-draft";

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

/** No mutation variables or private drafts enter a React Query mutation cache. */
export class DomainsMutationError extends DomainsApiError {
  constructor(status: number, public readonly needsReconciliation: boolean,
    public readonly issues: DraftIssue[] = []) {
    const conflict = issues.some(issue => issue.code === "version_conflict");
    super(status, needsReconciliation ? "The save outcome is uncertain. Refresh your domains before trying to save again." :
      conflict ? "A newer configuration exists. Reload this domain before making another change." :
      status === 400 ? "Review the fields listed below." :
      status === 413 ? "This configuration is too large to save." :
      status === 401 ? "Sign in before saving a domain." :
      status === 403 ? "Your domain access is not available yet." :
      status === 404 ? "This domain is not available to your account." : "This configuration could not be saved.");
    this.name = "DomainsMutationError";
  }
}
function safeMutationIssues(value: unknown): DraftIssue[] {
  const parsed = z.object({ issues: z.array(z.object({ path: z.string().max(200), code: z.string().max(80),
    message: z.string() }).passthrough()).max(100).optional() }).passthrough().safeParse(value);
  if (!parsed.success) return [];
  return (parsed.data.issues ?? []).filter(issue => /^[a-zA-Z0-9_.[\]-]*$/.test(issue.path) && /^[a-zA-Z0-9_]+$/.test(issue.code))
    .map(issue => ({ path: issue.path, code: issue.code, message: issue.code === "version_conflict" ?
      "Reload this domain; its latest saved version changed." : issue.path.includes("effectiveFrom") ?
      "Choose a later future start. The server checks its own clock." : "Check this field's value, unit and period." }));
}
function safeWriteDraft(draft: DomainPolicyDraft): DomainPolicyDraft {
  if (SERVER_POLICY_FIELDS.some(field => Object.prototype.hasOwnProperty.call(draft, field)))
    throw new DomainsMutationError(400, false, [{ path: "configuration", code: "server_identity", message: "The server assigns account and version identities." }]);
  const parsed = DomainConfigurationSchema.safeParse(validationConfiguration(draft));
  if (!parsed.success) throw new DomainsMutationError(400, false,
    parsed.error.issues.map(issue => ({ path: issue.path.join("."), code: issue.code, message: "Check this configuration field." })));
  return structuredClone(draft);
}
async function postDomain(ownerId: string, path: string, payload: object, domainId?: string): Promise<PersonalDomain> {
  const owner = validatedOwner(ownerId);
  const { signal, ...body } = payload as object & { signal?: AbortSignal };
  let response: Response;
  try { response = await fetch(path, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body), signal }); }
  catch { throw new DomainsMutationError(503, true); }
  if (response.status !== 201) {
    const failure = await response.json().catch(() => null);
    throw new DomainsMutationError(response.status, response.status >= 500 || response.status === 408 || response.ok, safeMutationIssues(failure));
  }
  try {
    const value = await response.json();
    return domainId ? parsePersonalDomain(value, owner, domainId) : validateDomain(value, owner);
  } catch { throw new DomainsMutationError(503, true); }
}
export async function createPersonalDomain(ownerId: string, input: { slug: string; configuration: DomainPolicyDraft;
  reason: string }, signal?: AbortSignal): Promise<PersonalDomain> {
  validatedOwner(ownerId);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.slug) || input.slug.length > 80 ||
    !input.reason.trim() || input.reason.trim().length > 500) throw new DomainsMutationError(400, false);
  const configuration = safeWriteDraft(input.configuration);
  const saved = await postDomain(ownerId, "/api/v2/domains", { slug: input.slug, configuration, reason: input.reason.trim(), signal });
  const latest = personalPolicySelection(saved).latest?.configuration;
  if (!latest || latest.revision !== 1 || saved.slug !== input.slug || !matchesSubmittedDraft(latest, configuration))
    throw new DomainsMutationError(503, true);
  return saved;
}
export async function configurePersonalDomain(ownerId: string, domainId: string, input: { expectedPolicyVersionId: string;
  configuration: DomainPolicyDraft; reason: string }, signal?: AbortSignal): Promise<PersonalDomain> {
  validatedOwner(ownerId);
  if (!opaqueId.safeParse(domainId).success) throw new DomainsMutationError(404, false);
  if (!opaqueId.safeParse(input.expectedPolicyVersionId).success || !input.reason.trim() || input.reason.trim().length > 500)
    throw new DomainsMutationError(400, false);
  const configuration = safeWriteDraft(input.configuration);
  const saved = await postDomain(ownerId, `/api/v2/domains/${encodeURIComponent(domainId)}/policies`,
    { expectedPolicyVersionId: input.expectedPolicyVersionId, configuration, reason: input.reason.trim(), signal }, domainId);
  const latest = personalPolicySelection(saved).latest?.configuration;
  if (!latest || latest.previousVersionId !== input.expectedPolicyVersionId || !matchesSubmittedDraft(latest, configuration))
    throw new DomainsMutationError(503, true);
  return saved;
}
/** Fresh authenticated boundary read, partitioned independently from the legacy Settings cache. */
export function personalDomainBoundaryQuery(ownerId: string) {
  const owner = validatedOwner(ownerId);
  return { queryKey: [PERSONAL_DOMAINS_QUERY, owner, "boundary", null] as const,
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<DomainPolicyDraft["boundary"]> => {
      const value = await readJson("/api/onboarding/settings", signal);
      const parsed = z.object({ userId: z.literal(owner), dayStartHour: z.number().int().min(0).max(23),
        timezone: z.string().min(1).refine(timezone => {
          try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }); return true; } catch { return false; }
        }) }).passthrough().safeParse(value);
      if (!parsed.success) throw new DomainsApiError(503, "Your day settings could not be verified. Reload them before creating a domain.");
      return { timezone: parsed.data.timezone, dayStartHour: parsed.data.dayStartHour };
    }, staleTime: 0, gcTime: 0, retry: false as const };
}
