import { afterEach, describe, expect, it, vi } from "vitest";
import { describeCondition, DomainsApiError, parsePersonalDomain, parsePersonalDomains,
  personalDomainsQuery, personalPolicySelection } from "./domains-api";

function domain(owner = "owner-a", uid = "domain-a") {
  const amount = { measurementId: "reps", unitId: "rep", basis: { kind: "per_event" },
    valueType: "integer", constraint: { operator: "gte", value: 20 } };
  return { domainId: uid, slug: "cooking", displayName: "Cooking", currentPolicyVersionId: "policy-1",
    scoreAvailability: "not_calculated", policyVersions: [{ configuration: {
      schemaVersion: 1, organizationId: "org-a", ownerUserId: owner, domainId: uid,
      policyVersionId: "policy-1", revision: 1, effectiveFrom: "2026-01-01T00:00:00Z", displayName: "Cooking",
      goal: { intent: "develop", desiredCapability: "Bake consistently", privateMotivation: "Private reason" },
      boundary: { timezone: "America/New_York", dayStartHour: 6 }, taskVariants: [],
      measurements: [{ measurementId: "reps", displayName: "Cupcakes", meaning: "Cupcakes baked per practice",
        role: "practice", comparisonDirection: "higher_is_better", scope: { kind: "per_event" },
        kind: "count", valueType: "integer", unit: { unitId: "rep", dimension: "count", customLabel: "cupcakes" }, aggregation: "sum" }],
      targets: { normal: { targetId: "normal", conditions: [amount] } },
      references: [{ referenceId: "reference", purpose: "develop", status: "known", conditions: [amount],
        applicability: { description: "Personal baking practice" },
        evidence: { category: "personal", review: { status: "unreviewed" }, confidence: "unknown" } }],
      review: { anchorAt: "2026-01-01T00:00:00Z", intervalDays: 84 },
    }, referenceComparisons: [{ referenceId: "reference", targetKind: "normal", targetId: "normal",
      active: true, status: "meets_reference", message: "Saved target meets this reference; no activity score.",
      conditions: [{ measurementId: "reps", status: "meets_reference" }] }] }] };
}
afterEach(() => vi.unstubAllGlobals());
describe("private domain read boundary", () => {
  it("keeps a fifth custom domain and same-name domains distinct by UID", () => {
    const result = parsePersonalDomains({ domains: [domain("owner-a", "fifth"), domain("owner-a", "sixth")] }, "owner-a");
    expect(result.map(item => item.domainId)).toEqual(["fifth", "sixth"]);
    expect(result.map(item => item.displayName)).toEqual(["Cooking", "Cooking"]);
  });
  it("accepts an owned domain without a policy alongside configured domains", () => {
    const empty = { ...domain("owner-a", "empty-domain"), displayName: "Not configured", currentPolicyVersionId: null, policyVersions: [] };
    const result = parsePersonalDomains({ domains: [domain(), empty] }, "owner-a");
    expect(result.map(item => item.domainId)).toEqual(["domain-a", "empty-domain"]);
    expect(result[1].policyVersions).toEqual([]);
    expect(personalPolicySelection(result[1])).toEqual({ current: null, latest: null, scheduled: [] });
    expect(parsePersonalDomain(empty, "owner-a", "empty-domain").currentPolicyVersionId).toBeNull();
    expect(() => parsePersonalDomain({ ...empty, currentPolicyVersionId: "missing" }, "owner-a", "empty-domain")).toThrow(DomainsApiError);
  });
  it("rejects another owner's cached or server-provided private configuration as one whole response", () => {
    expect(() => parsePersonalDomains({ domains: [domain(), domain("owner-b", "other")] }, "owner-a")).toThrow(DomainsApiError);
    expect(() => parsePersonalDomain(domain("owner-b"), "owner-a", "domain-a")).toThrow(DomainsApiError);
  });
  it("rejects a substituted route identity, invented score, and incomplete version history", () => {
    expect(() => parsePersonalDomain(domain(), "owner-a", "different")).toThrow(DomainsApiError);
    expect(() => parsePersonalDomains({ domains: [{ ...domain(), scoreAvailability: "healthy" }] }, "owner-a")).toThrow(DomainsApiError);
    const incomplete = domain();
    incomplete.policyVersions[0].configuration.revision = 2;
    expect(() => parsePersonalDomains({ domains: [incomplete] }, "owner-a")).toThrow(DomainsApiError);
    const unsupported: any = domain();
    unsupported.policyVersions[0].configuration.schemaVersion = 2;
    expect(() => parsePersonalDomain(unsupported, "owner-a", "domain-a")).toThrow(DomainsApiError);
  });
  it("rejects duplicate UID and unresolved current/comparison identities", () => {
    expect(() => parsePersonalDomains({ domains: [domain(), domain()] }, "owner-a")).toThrow(DomainsApiError);
    expect(() => parsePersonalDomain({ ...domain(), currentPolicyVersionId: "missing" }, "owner-a", "domain-a")).toThrow(DomainsApiError);
    const wrong = domain(); wrong.policyVersions[0].referenceComparisons[0].targetId = "absent";
    expect(() => parsePersonalDomain(wrong, "owner-a", "domain-a")).toThrow(DomainsApiError);
  });
  it("accepts unknown references without creating conditions or a numerical minimum", () => {
    const unknown: any = domain();
    unknown.policyVersions[0].configuration.references[0].status = "unknown";
    delete unknown.policyVersions[0].configuration.references[0].conditions;
    unknown.policyVersions[0].referenceComparisons[0] = { referenceId: "reference", targetKind: "normal", targetId: "normal",
      active: true, status: "unknown", message: "Reference unknown; no minimum inferred.", conditions: [] };
    const parsed = parsePersonalDomain(unknown, "owner-a", "domain-a");
    expect(parsed.policyVersions[0].configuration.references[0].status).toBe("unknown");
    expect(parsed.policyVersions[0].referenceComparisons[0].status).toBe("unknown");
    expect(parsed.scoreAvailability).toBe("not_calculated");
  });
});
describe("authenticated query lifecycle", () => {
  it("partitions accounts while requesting only the same authenticated endpoint", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ domains: [domain()] }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const a = personalDomainsQuery("owner-a"), b = personalDomainsQuery("owner-b");
    expect(a.queryKey).not.toEqual(b.queryKey);
    const controller = new AbortController();
    await a.queryFn({ signal: controller.signal });
    expect(fetch).toHaveBeenCalledWith("/api/v2/domains", { credentials: "include", signal: controller.signal });
    expect(a.gcTime).toBe(0);
    expect(a.staleTime).toBe(0);
    await expect(b.queryFn({ signal: controller.signal })).rejects.toBeInstanceOf(DomainsApiError);
  });
  it("encodes opaque route IDs and never sends owner authority in the URL", async () => {
    const fixture = domain("owner-a", "domain/with-space x");
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await personalDomainsQuery("owner-a", "domain/with-space x").queryFn({ signal: new AbortController().signal });
    expect(fetch.mock.calls[0][0]).toBe("/api/v2/domains/domain%2Fwith-space%20x");
    expect(() => personalDomainsQuery("owner-a", "__proto__")).toThrow(DomainsApiError);
  });
  it.each([401, 403, 404, 503])("preserves %i availability without displaying upstream private text", async status => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("private failure details", { status })));
    try { await personalDomainsQuery("owner-a").queryFn({ signal: new AbortController().signal }); throw new Error("Expected rejection"); }
    catch (error) {
      expect(error).toBeInstanceOf(DomainsApiError);
      expect((error as DomainsApiError).status).toBe(status);
      expect((error as Error).message).not.toContain("private failure details");
    }
  });
  it("rejects malformed responses and preserves cancellation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not JSON", { status: 200 })));
    await expect(personalDomainsQuery("owner-a").queryFn({ signal: new AbortController().signal })).rejects.toBeInstanceOf(DomainsApiError);
    const aborted = new DOMException("cancelled", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(aborted));
    await expect(personalDomainsQuery("owner-a").queryFn({ signal: new AbortController().signal })).rejects.toBe(aborted);
  });
});
describe("configuration availability and typed amounts", () => {
  it("selects server-designated active version while latest remains scheduled, independently of browser clock", () => {
    const fixture: any = domain();
    const scheduled = structuredClone(fixture.policyVersions[0]);
    Object.assign(scheduled.configuration, { policyVersionId: "policy-2", previousVersionId: "policy-1", revision: 2, effectiveFrom: "2099-01-01T00:00:00Z" });
    fixture.policyVersions.unshift(scheduled);
    const parsed = parsePersonalDomain(fixture, "owner-a", "domain-a");
    const selected = personalPolicySelection(parsed);
    expect(selected.current?.configuration.policyVersionId).toBe("policy-1");
    expect(selected.latest?.configuration.policyVersionId).toBe("policy-2");
    expect(selected.scheduled.map(item => item.configuration.policyVersionId)).toEqual(["policy-2"]);
    parsed.currentPolicyVersionId = null;
    expect(personalPolicySelection(parsed).current).toBeNull();
    expect(personalPolicySelection(parsed).scheduled).toHaveLength(2);
  });
  it("renders count units without inventing minutes or performing a score calculation", () => {
    const c = parsePersonalDomain(domain(), "owner-a", "domain-a").policyVersions[0].configuration;
    expect(describeCondition(c.targets.normal.conditions[0], c)).toBe("Cupcakes: at least 20 cupcakes, per practice event");
    expect(describeCondition(c.targets.normal.conditions[0], c)).not.toMatch(/minutes|%/);
  });
});
