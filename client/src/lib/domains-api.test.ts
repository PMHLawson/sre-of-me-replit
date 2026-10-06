import { afterEach, describe, expect, it, vi } from "vitest";
import { configurePersonalDomain, createPersonalDomain, describeCondition, DomainsApiError, DomainsMutationError,
  parsePersonalDomain, parsePersonalDomains, personalDomainBoundaryQuery, personalDomainsQuery, personalPolicySelection } from "./domains-api";
import { policyDraft, SERVER_POLICY_FIELDS } from "./domain-policy-draft";

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
describe("explicit private domain writes", () => {
  const input = () => ({ slug: "cooking", reason: "Initial setup", configuration: policyDraft(
    parsePersonalDomain(domain(), "owner-a", "domain-a").policyVersions[0].configuration) });
  it("creates once with credentials, typed amounts and no client account/version authority", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(domain()), { status: 201 })); vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    expect((await createPersonalDomain("owner-a", input(), controller.signal)).domainId).toBe("domain-a");
    expect(fetch).toHaveBeenCalledTimes(1);
    const [path, request] = fetch.mock.calls[0]; expect(path).toBe("/api/v2/domains");
    expect(request).toMatchObject({ method: "POST", credentials: "include", signal: controller.signal,
      headers: { "Content-Type": "application/json" } });
    const body = JSON.parse(request.body);
    expect(Object.keys(body).sort()).toEqual(["configuration", "reason", "slug"]);
    expect(body.configuration.measurements[0].valueType).toBe("integer");
    expect(body.configuration.goal.privateMotivation).toBe("Private reason");
    for (const field of SERVER_POLICY_FIELDS) expect(Object.hasOwn(body.configuration, field)).toBe(false);
    expect(body.configuration).toEqual(input().configuration);
  });
  it("appends after the expected latest scheduled predecessor using only the owned UID route", async () => {
    const fixture: any = domain("owner-a", "domain/with space");
    const second = structuredClone(fixture.policyVersions[0]);
    Object.assign(second.configuration, { policyVersionId: "policy-2", previousVersionId: "policy-1", revision: 2,
      effectiveFrom: "2099-01-01T00:00:00Z" }); fixture.policyVersions.push(second);
    const third = structuredClone(second);
    Object.assign(third.configuration, { policyVersionId: "policy-3", previousVersionId: "policy-2", revision: 3,
      effectiveFrom: "2099-01-02T00:00:00Z" }); fixture.policyVersions.push(third);
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 201 })); vi.stubGlobal("fetch", fetch);
    const configuration = policyDraft(parsePersonalDomain(fixture, "owner-a", "domain/with space").policyVersions[2].configuration);
    await configurePersonalDomain("owner-a", "domain/with space", { expectedPolicyVersionId: "policy-2", configuration, reason: "Future target" });
    expect(fetch.mock.calls[0][0]).toBe("/api/v2/domains/domain%2Fwith%20space/policies");
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.expectedPolicyVersionId).toBe("policy-2");
    for (const field of SERVER_POLICY_FIELDS) expect(Object.hasOwn(body.configuration, field)).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([401, 403, 404, 413])("keeps a %i rejection distinct without repeating private server text", async status => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: "PRIVATE server failure" }), { status })); vi.stubGlobal("fetch", fetch);
    await expect(createPersonalDomain("owner-a", input())).rejects.toMatchObject({ status, needsReconciliation: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("surfaces a safe 400 version conflict and never copies arbitrary upstream text", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ issues: [
      { path: "expectedPolicyVersionId", code: "version_conflict", message: "PRIVATE reason in failure" },
      { path: "configuration.effectiveFrom", code: "backdated", message: "PRIVATE timestamp" },
    ] }), { status: 400 })));
    try { await createPersonalDomain("owner-a", input()); throw new Error("Expected failure"); }
    catch (failure) {
      expect(failure).toBeInstanceOf(DomainsMutationError);
      expect((failure as DomainsMutationError).issues.map(i => i.code)).toEqual(["version_conflict", "backdated"]);
      expect(JSON.stringify(failure)).not.toContain("PRIVATE");
      expect((failure as Error).message).toContain("newer configuration");
    }
  });
  it.each([408, 503])("requires reconciliation for HTTP %i without automatic retry", async status => {
    const fetch = vi.fn().mockResolvedValue(new Response("unavailable", { status })); vi.stubGlobal("fetch", fetch);
    await expect(createPersonalDomain("owner-a", input())).rejects.toMatchObject({ needsReconciliation: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([new Error("network lost"), new DOMException("aborted", "AbortError")])("treats post-send transport/cancellation as uncertain", async failure => {
    const fetch = vi.fn().mockRejectedValue(failure); vi.stubGlobal("fetch", fetch);
    await expect(createPersonalDomain("owner-a", input())).rejects.toMatchObject({ needsReconciliation: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("refuses malformed, foreign-owner, empty or unrelated 201 responses rather than claiming a save", async () => {
    const wrongGoal = domain(); wrongGoal.policyVersions[0].configuration.goal.desiredCapability = "Other goal";
    const cases = ["not JSON", JSON.stringify(domain("owner-b")), JSON.stringify({ ...domain(), policyVersions: [], currentPolicyVersionId: null }),
      JSON.stringify({ ...domain(), slug: "different" }), JSON.stringify(wrongGoal)];
    for (const response of cases) {
      const fetch = vi.fn().mockResolvedValue(new Response(response, { status: 201 })); vi.stubGlobal("fetch", fetch);
      await expect(createPersonalDomain("owner-a", input())).rejects.toMatchObject({ needsReconciliation: true });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });
  it("rejects authority fields and invalid input before sending any request", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const hostile: any = input(); hostile.configuration.ownerUserId = "owner-b";
    await expect(createPersonalDomain("owner-a", hostile)).rejects.toMatchObject({ status: 400 });
    await expect(createPersonalDomain("owner-a", { ...input(), reason: " " })).rejects.toMatchObject({ status: 400 });
    await expect(configurePersonalDomain("owner-a", "__proto__", { configuration: input().configuration, reason: "Change", expectedPolicyVersionId: "policy-1" }))
      .rejects.toMatchObject({ status: 404 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects an append response that omits its promised successor", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(domain()), { status: 201 })); vi.stubGlobal("fetch", fetch);
    await expect(configurePersonalDomain("owner-a", "domain-a", { expectedPolicyVersionId: "policy-1",
      configuration: input().configuration, reason: "Change" })).rejects.toMatchObject({ needsReconciliation: true });
  });
});
describe("new-domain day settings", () => {
  it("reads the owned personal settings path without legacy normalization or identity disclosure", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ userId: "owner-a", timezone: "Asia/Tokyo", dayStartHour: 15,
      windowDays: 13, notificationsEnabled: true }), { status: 200 })); vi.stubGlobal("fetch", fetch);
    const query = personalDomainBoundaryQuery("owner-a"), signal = new AbortController().signal;
    expect(await query.queryFn({ signal })).toEqual({ timezone: "Asia/Tokyo", dayStartHour: 15 });
    expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/onboarding/settings", { credentials: "include", signal });
    expect(query.queryKey).not.toEqual(personalDomainBoundaryQuery("owner-b").queryKey);
    expect(query.gcTime).toBe(0); expect(query.retry).toBe(false);
    await expect(personalDomainBoundaryQuery("owner-b").queryFn({ signal })).rejects.toBeInstanceOf(DomainsApiError);
    expect(fetch.mock.calls.map(([requestPath]) => requestPath)).toEqual(["/api/onboarding/settings", "/api/onboarding/settings"]);
  });
  it.each([{ timezone: "America/New_York", dayStartHour: 4 }, { userId: "owner-a", timezone: "fake/timezone", dayStartHour: 4 },
    { userId: "owner-a", timezone: "America/New_York", dayStartHour: 24 }])("never substitutes a boundary for malformed or unowned settings", async value => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(value), { status: 200 })));
    await expect(personalDomainBoundaryQuery("owner-a").queryFn({ signal: new AbortController().signal })).rejects.toBeInstanceOf(DomainsApiError);
  });
});
