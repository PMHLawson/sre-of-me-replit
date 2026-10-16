import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { DomainsApiError, parsePersonalDomain, personalDomainBoundaryQuery, personalDomainsQuery } from "@/lib/domains-api";
import DomainSettingsPage, { openPersonalDomainDraft, PersonalDomainDraftSlot, PersonalConfigurationView, PersonalDomainActions,
  PersonalDomainActivityLinks, PersonalDomainDetail, PersonalDomainsBackLink, PersonalDomainsList, PersonalDomainsNotice } from "./domain-settings";

function fixture() {
  const amount = { measurementId: "amount", unitId: "cupcake", basis: { kind: "per_event" }, valueType: "integer", constraint: { operator: "gte", value: 12 } };
  const frequency = { measurementId: "frequency", unitId: "days", basis: { kind: "period", windowDays: 7 }, valueType: "integer", constraint: { operator: "gte", value: 3 } };
  const configuration = {
    schemaVersion: 1, organizationId: "org-a", ownerUserId: "owner-a", domainId: "custom-five",
    policyVersionId: "version-one", revision: 1, effectiveFrom: "2026-01-01T00:00:00Z", displayName: "Cooking <carefully>",
    goal: { intent: "develop", desiredCapability: "Bake consistently", privateMotivation: "My own <private> reason",
      currentCapability: { assessedAt: "2026-01-02T00:00:00Z", assessment: "Learning even batches" },
      taskConditions: [{ conditionId: "kitchen", description: "Home kitchen" }] },
    boundary: { timezone: "America/New_York", dayStartHour: 6 },
    taskVariants: [{ variantId: "icing", displayName: "Iced cupcakes", taskConditions: [{ conditionId: "temperature", description: "Cool before icing" }] }],
    measurements: [
      { measurementId: "amount", displayName: "Cupcakes baked", meaning: "Finished cupcakes per practice event", role: "practice",
        comparisonDirection: "higher_is_better", scope: { kind: "per_event" }, kind: "count", valueType: "integer",
        unit: { unitId: "cupcake", dimension: "count", customLabel: "cupcakes" }, aggregation: "sum" },
      { measurementId: "frequency", displayName: "Practice days", meaning: "Distinct local days with qualifying practice", role: "practice",
        comparisonDirection: "higher_is_better", scope: { kind: "period", windowDays: 7 }, kind: "frequency", valueType: "integer",
        unit: { unitId: "days", dimension: "days" }, aggregation: "count", countBy: "distinct_days" },
    ],
    targets: { normal: { targetId: "normal", conditions: [amount, frequency] },
      stretch: { targetId: "stretch", displayName: "Larger batches", conditions: [{ ...amount, constraint: { operator: "gte", value: 24 } }] },
      adapted: { target: { targetId: "adapted", conditions: [{ ...amount, constraint: { operator: "gte", value: 6 } }] },
        effectiveFrom: "2026-01-01T00:00:00Z", duration: "ongoing", reason: "A smaller current plan", reviewAt: "2026-04-01T00:00:00Z" },
      upperRecovery: { conditions: [{ ...amount, constraint: { operator: "lte", value: 48 } }], guidance: "Keep room for recovery" } },
    qualification: { kind: "all", predicates: [{ kind: "condition", condition: amount }, { kind: "condition", condition: frequency }] },
    references: [{ referenceId: "reference", purpose: "develop", status: "unknown", note: "No researched threshold available",
      applicability: { description: "Home baking skill", taskConditions: [{ conditionId: "reference-condition", description: "Equipment matters" }] },
      evidence: { category: "personal", review: { status: "unreviewed" }, confidence: "unknown", source: { description: "Personal note", url: "https://example.org/reference" } } }],
    review: { anchorAt: "2026-01-01T00:00:00Z", intervalDays: 84, lastReviewedAt: "2026-01-02T00:00:00Z", nextReviewAt: "2026-04-01T00:00:00Z" },
  };
  return { domainId: "custom-five", slug: "cooking", displayName: "Cooking <carefully>", currentPolicyVersionId: "version-one",
    scoreAvailability: "not_calculated", policyVersions: [{ configuration, referenceComparisons: [{ referenceId: "reference", targetKind: "adapted", targetId: "adapted",
      active: true, status: "unknown", message: "Reference is unknown; no minimum or percentage inferred.", conditions: [] }] }] };
}
const parsed = () => parsePersonalDomain(fixture(), "owner-a", "custom-five");
describe("personal domain configuration rendering", () => {
  it("offers custom activity entry and raw history only through the exact owned domain availability", () => {
    const html = renderToStaticMarkup(<Router ssrPath="/domains/custom-five"><PersonalDomainActivityLinks domainId="custom-five"
      availability={{ domainId: "custom-five", canCreate: true, reason: null, effectivePolicyVersionId: "version-one" }}/></Router>);
    expect(html).toContain('href="/activities/new/custom-five"'); expect(html).toContain('href="/activities/domain/custom-five"');
    expect(html).not.toContain('href="/log"');
    const foreign = renderToStaticMarkup(<Router ssrPath="/domains/custom-five"><PersonalDomainActivityLinks domainId="custom-five"
      availability={{ domainId: "other-domain", canCreate: true, reason: null, effectivePolicyVersionId: "version-one" }}/></Router>);
    expect(foreign).toContain("could not be verified"); expect(foreign).not.toContain('href="/activities/new/custom-five"');
  });
  it.each(["legacy_writer", "inactive", "no_effective_policy"] as const)("uses per-domain %s refusal while retaining own raw history access", reason => {
    const html = renderToStaticMarkup(<Router ssrPath="/domains/custom-five"><PersonalDomainActivityLinks domainId="custom-five"
      availability={{ domainId: "custom-five", canCreate: false, reason }}/></Router>);
    expect(html).toContain('href="/activities/domain/custom-five"'); expect(html).not.toContain("Record activity");
    expect(html.includes('href="/log"')).toBe(reason === "legacy_writer");
  });
  it.each([{ loading: true }, { error: true }])("never invents activity permission from loading or failed availability %j", flags => {
    const html = renderToStaticMarkup(<Router ssrPath="/domains/custom-five"><PersonalDomainActivityLinks domainId="custom-five" {...flags}
      availability={{ domainId: "custom-five", canCreate: true, reason: null, effectivePolicyVersionId: "version-one" }} retry={() => {}}/></Router>);
    expect(html).not.toContain("Record activity"); expect(html).toContain(flags.loading ? "Checking activity availability" : "could not be verified");
  });
  it("renders a custom fifth domain by immutable UID and escaped display name", () => {
    const view = parsed();
    const html = renderToStaticMarkup(<Router ssrPath="/domains"><PersonalDomainsList domains={[view, { ...view, domainId: "other-cooking" }]} /></Router>);
    expect(html).toContain('href="/domains/custom-five"');
    expect(html).toContain('href="/domains/other-cooking"');
    expect(html).toContain("Cooking &lt;carefully&gt;");
    expect(html).not.toContain('href="/domain/cooking"');
    expect(html).not.toContain("100%");
    expect(personalDomainsQuery("owner-a").queryKey).not.toEqual(personalDomainsQuery("owner-a", "list").queryKey);
  });
  it("renders a mixed configured and empty-policy list without hiding either domain", () => {
    const empty = parsePersonalDomain({ ...fixture(), domainId: "empty-domain", displayName: "New practice",
      currentPolicyVersionId: null, policyVersions: [] }, "owner-a", "empty-domain");
    const html = renderToStaticMarkup(<Router ssrPath="/domains"><PersonalDomainsList domains={[parsed(), empty]} /></Router>);
    expect(html).toContain('href="/domains/custom-five"');
    expect(html).toContain('href="/domains/empty-domain"');
    expect(html).toContain("New practice");
    expect(html).toContain("No configuration yet");
    expect(html).not.toContain("could not be loaded");
  });
  it("renders an empty-policy domain with no invented scheduled or active configuration", () => {
    const empty = parsePersonalDomain({ ...fixture(), currentPolicyVersionId: null, policyVersions: [] }, "owner-a", "custom-five");
    const html = renderToStaticMarkup(<PersonalDomainDetail domain={empty} />);
    expect(html).toContain('data-testid="domain-no-configuration"');
    expect(html).toContain("No configuration yet");
    expect(html).toContain("no saved goals or measurements");
    expect(html).toContain("Score not calculated");
    expect(html).not.toContain("Scheduled version");
    expect(html).not.toContain("Active configuration</h3>");
    expect(html).not.toContain("has not taken effect");
    expect(html).not.toContain("Bake consistently");
  });
  it("keeps multiple typed measures, independent frequency, goals and provenance readable", () => {
    const html = renderToStaticMarkup(<PersonalConfigurationView version={parsed().policyVersions[0]} />);
    for (const text of ["Bake consistently", "Learning even batches", "Home kitchen", "Iced cupcakes", "Cool before icing", "Finished cupcakes per practice event",
      "at least 12 cupcakes, per practice event", "at least 3 days, per 7 days", "distinct practice days", "Larger batches",
      "Adapted target", "at least 6 cupcakes", "Ongoing", "A smaller current plan", "Keep room for recovery", "All of these conditions",
      "Reference unknown; no minimum inferred", "No researched threshold available", "Equipment matters", "Personal note", "confidence unknown", "not yet reviewed", "every 84 days"])
      expect(html).toContain(text);
    expect(html).toContain("My own &lt;private&gt; reason");
    expect(html).toContain("does not change your target automatically");
    expect(html).not.toMatch(/\bminutes\b|100%/);
    expect(html).not.toContain("Log session");
  });
  it("shows server reference notices without treating below reference as failure", () => {
    const view = parsed();
    view.policyVersions[0].referenceComparisons[0].status = "below_reference";
    view.policyVersions[0].referenceComparisons[0].message = "Below the declared reference. You may keep this target; this does not mean the activity has no value.";
    const html = renderToStaticMarkup(<PersonalConfigurationView version={view.policyVersions[0]} />);
    expect(html).toContain('data-testid="reference-below_reference"');
    expect(html).toContain("You may keep this target");
    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain("0%");
  });
  it("shows scheduled configurations separately from the server-designated active configuration", () => {
    const view = parsed();
    const scheduled = structuredClone(view.policyVersions[0]);
    Object.assign(scheduled.configuration, { policyVersionId: "version-two", previousVersionId: "version-one", revision: 2, effectiveFrom: "2099-01-01T00:00:00Z" });
    scheduled.configuration.goal.desiredCapability = "Future baking goal";
    view.policyVersions.unshift(scheduled);
    const html = renderToStaticMarkup(<PersonalDomainDetail domain={view} />);
    expect(html).toContain("Active configuration");
    expect(html).toContain("Version 1");
    expect(html).toContain("Scheduled version 2");
    expect(html).toContain("Future baking goal");
    expect(html).toContain("Score not calculated");
    expect(html).not.toMatch(/href="\/log/);
  });
  it("never promotes future-only configuration to active or a healthy score", () => {
    const view = parsed(); view.currentPolicyVersionId = null;
    const html = renderToStaticMarkup(<PersonalDomainDetail domain={view} />);
    expect(html).toContain("No active configuration yet");
    expect(html).toContain("has not taken effect");
    expect(html).toContain("Scheduled version 1");
    expect(html).not.toContain("Active configuration</h3>");
    expect(html).not.toMatch(/healthy|100%/i);
  });
  it("escapes source text and does not execute non-web reference URLs", () => {
    const view = parsed();
    const reference = view.policyVersions[0].configuration.references[0];
    reference.evidence.source = { description: "<img src=x onerror=alert(1)>", url: "javascript:alert(1)" };
    const html = renderToStaticMarkup(<PersonalConfigurationView version={view.policyVersions[0]} />);
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img");
    expect(html).not.toContain('href="javascript:');
  });
});
describe("availability rendering", () => {
  it("shows empty/loading states without inventing domains or scores", () => {
    expect(renderToStaticMarkup(<PersonalDomainsList domains={[]} />)).toContain("no personal domains yet");
    const html = renderToStaticMarkup(<PersonalDomainsNotice loading />);
    expect(html).toContain('role="status"');
    expect(html).toContain("Loading your domains");
    expect(html).not.toContain("healthy");
  });
  it.each([401, 403, 404, 503])("renders %i access/unavailable state with retry", status => {
    const html = renderToStaticMarkup(<PersonalDomainsNotice error={new DomainsApiError(status)} retry={() => {}} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Try again");
    expect(html).not.toContain("healthy");
    if (status === 404) expect(html).toContain("not available to your account");
  });
});
describe("personal domain form entry points", () => {
  const actions = { onSaved: () => {}, onCancel: () => {}, onReconcile: async () => null };
  it("captures the latest scheduled owner configuration separately from mutable read data", () => {
    const view = parsed(), scheduled = structuredClone(view.policyVersions[0]);
    Object.assign(scheduled.configuration, { policyVersionId: "version-two", previousVersionId: "version-one", revision: 2, effectiveFrom: "2099-01-01T00:00:00Z" });
    view.policyVersions.push(scheduled);
    const session = openPersonalDomainDraft("owner-a", view);
    if (session.kind !== "configure") throw new Error("Expected an owned prospective draft.");
    expect(session.openingConfiguration.policyVersionId).toBe("version-two");
    scheduled.configuration.goal.privateMotivation = "Changed incoming private goal";
    scheduled.configuration.boundary.dayStartHour = 14;
    expect(session.openingConfiguration.goal.privateMotivation).toBe("My own <private> reason");
    expect(session.openingConfiguration.boundary.dayStartHour).toBe(6);
    expect(() => openPersonalDomainDraft("owner-b", view)).toThrow(DomainsApiError);
    const empty = { ...view, currentPolicyVersionId: null, policyVersions: [] };
    expect(() => openPersonalDomainDraft("owner-a", empty)).toThrow(DomainsApiError);
  });
  it.each(["503 refetch", "loading", "query reset"])("keeps the opening configuration rendered during a same-owner %s", state => {
    const session = openPersonalDomainDraft("owner-a", parsed());
    const html = renderToStaticMarkup(<><PersonalDomainDraftSlot session={session} ownerId="owner-a" domainId="custom-five"
      latestPolicyVersionId={undefined} {...actions} /><PersonalDomainsNotice loading={state !== "503 refetch"} error={new DomainsApiError(503)} /></>);
    expect(html).toContain('data-testid="domain-policy-form"'); expect(html).toContain("My own &lt;private&gt; reason");
    expect(html).toContain("Bake consistently"); expect(html).not.toContain("A newer saved version was loaded");
    expect(html).not.toContain("saved configuration is no longer available");
  });
  it.each(["version-two", null])("retains the opening draft but blocks save when a successful latest read is %s", latest => {
    const session = openPersonalDomainDraft("owner-a", parsed());
    const html = renderToStaticMarkup(<PersonalDomainDraftSlot session={session} ownerId="owner-a" domainId="custom-five"
      latestPolicyVersionId={latest} {...actions} />);
    expect(html).toContain('data-testid="domain-policy-form"'); expect(html).toContain("My own &lt;private&gt; reason");
    expect(html).toContain('fieldset disabled=""');
    expect(html).toContain(latest ? "A newer saved version was loaded" : "saved configuration is no longer available");
  });
  it.each([["owner-b", "custom-five"], [undefined, "custom-five"], ["owner-a", "other-domain"]] as const)(
    "never renders a pinned private draft for owner %s on route %s", (ownerId, domainId) => {
      const html = renderToStaticMarkup(<PersonalDomainDraftSlot session={openPersonalDomainDraft("owner-a", parsed())}
        ownerId={ownerId} domainId={domainId} {...actions} />);
      expect(html).toBe("");
    });
  it("does not mount a new private draft before the first owner-verified boundary read", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const html = renderToStaticMarkup(<QueryClientProvider client={client}><PersonalDomainDraftSlot
      session={openPersonalDomainDraft("owner-a")} ownerId="owner-a" {...actions} /></QueryClientProvider>);
    expect(html).toContain("Loading your day settings"); expect(html).not.toContain('data-testid="domain-policy-form"');
    expect(html).not.toContain("America/New_York"); client.clear();
  });
  it("opens a new draft with that owner's verified boundary and never borrows another owner's cache", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    client.setQueryData(personalDomainBoundaryQuery("owner-a").queryKey, { timezone: "America/New_York", dayStartHour: 14 });
    const render = (ownerId: string) => renderToStaticMarkup(<QueryClientProvider client={client}><PersonalDomainDraftSlot
      session={openPersonalDomainDraft(ownerId)} ownerId={ownerId} {...actions} /></QueryClientProvider>);
    expect(render("owner-a")).toContain('data-testid="domain-policy-form"'); expect(render("owner-a")).toContain("Day starts at 14:00");
    expect(render("owner-b")).not.toContain('data-testid="domain-policy-form"'); expect(render("owner-b")).not.toContain("14:00"); client.clear();
  });
  it("does not dereference a null draft when both form and authenticated owner are absent", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const html = renderToStaticMarkup(<QueryClientProvider client={client}><Router ssrPath="/domains"><DomainSettingsPage /></Router></QueryClientProvider>);
    expect(html).toContain("Sign in to view your domains");
    expect(html).not.toContain('data-testid="domain-policy-form"');
    expect(html).not.toContain("Add domain"); client.clear();
  });
  it("keeps in-page navigation from bypassing the pending or uncertain form gate", () => {
    const html = renderToStaticMarkup(<Router ssrPath="/domains"><PersonalDomainsBackLink editing /><PersonalDomainsList domains={[parsed()]} navigationPaused /></Router>);
    expect(html).toContain("finish this draft to return"); expect(html).toContain("Finish or discard this draft");
    expect(html).not.toContain('href="/settings"'); expect(html).not.toContain('href="/domains/custom-five"');
    const normal = renderToStaticMarkup(<Router ssrPath="/domains"><PersonalDomainsBackLink editing={false} /></Router>);
    expect(normal).toContain('href="/settings"');
  });
  it("offers creation only from the authenticated successful list entry", () => {
    const html = renderToStaticMarkup(<PersonalDomainActions onAdd={() => {}} onConfigure={() => {}} />);
    expect(html).toContain("Add domain"); expect(html).not.toContain("Schedule a new configuration");
  });
  it("explains that edits start from the latest scheduled version rather than the current active version", () => {
    const view = parsed(), scheduled = structuredClone(view.policyVersions[0]);
    Object.assign(scheduled.configuration, { policyVersionId: "version-two", previousVersionId: "version-one", revision: 2, effectiveFrom: "2099-01-01T00:00:00Z" });
    view.policyVersions.push(scheduled);
    const html = renderToStaticMarkup(<PersonalDomainActions domain={view} onAdd={() => {}} onConfigure={() => {}} />);
    expect(html).toContain("Schedule a new configuration"); expect(html).toContain("latest saved version 2");
    expect(html).toContain("including any scheduled changes"); expect(html).not.toContain("latest saved version 1");
  });
  it("does not expose a configure form for a valid owned domain with no policy", () => {
    const view = parsed(); view.policyVersions = []; view.currentPolicyVersionId = null;
    const html = renderToStaticMarkup(<PersonalDomainActions domain={view} onAdd={() => {}} onConfigure={() => {}} />);
    expect(html).toContain("not available for a domain with no saved policy");
    expect(html).not.toContain("<button");
  });
});
