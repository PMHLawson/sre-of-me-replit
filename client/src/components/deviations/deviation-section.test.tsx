import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { bindActivityOwner, personalActivityEligibilityQuery } from "@/lib/activities-api";
import { personalDomainBoundaryQuery, personalDomainsQuery } from "@/lib/domains-api";
import { personalDeviationsQuery } from "@/lib/deviation-v2-api";
import { useAppStore } from "@/store";
import { DeviationSection, legacyDeviationPresentationKey, verifiedPersonalDeviationOwner } from "./deviation-section";
import { PersonalDeviationSection } from "./personal-deviation-section";

afterEach(() => {
  bindActivityOwner(null);
  useAppStore.setState({ dataOwner: null, demoState: "default" });
});

describe("personal break entry points", () => {
  it("keeps the Your domains shortcut and saved timezone on the same shared section", () => {
    bindActivityOwner("owner-a");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const domains = ["martial-arts", "meditation", "fitness", "music", "custom-cooking"].map((domainId, index) => ({
      domainId, displayName: index === 4 ? "Cooking" : domainId, scoreAvailability: "not_calculated",
      currentPolicyVersionId: null, policyVersions: [],
    }));
    client.setQueryData(personalDomainsQuery("owner-a").queryKey, domains);
    client.setQueryData(personalDomainBoundaryQuery("owner-a").queryKey, { timezone: "America/New_York", dayStartHour: 6 });
    client.setQueryData(personalDeviationsQuery("owner-a").queryKey, []);
    for (const domain of domains) client.setQueryData(personalActivityEligibilityQuery("owner-a", domain.domainId).queryKey, {
      domainId: domain.domainId, canCreate: true, reason: null, effectivePolicyVersionId: null,
    });
    const html = renderToStaticMarkup(<QueryClientProvider client={client}>
      <PersonalDeviationSection ownerId="owner-a" />
    </QueryClientProvider>);
    expect(html).toContain('data-testid="section-personal-breaks"');
    expect(html).toContain("America/New_York");
    expect(html).toContain("Record break");
    client.clear();
  });

  it("keeps declared deviations beside a lazy personal-break entry in the expanded history", () => {
    bindActivityOwner("owner-a");
    useAppStore.setState({ dataOwner: "owner-a", demoState: "default" });
    const html = renderToStaticMarkup(<DeviationSection entryPoint="dashboard" />);
    expect(html).toContain('data-testid="section-deviations"');
    expect(html).toContain('data-entry-point="dashboard"');
    expect(html).toContain('data-testid="button-declare-deviation"');
    expect(html).toContain("Browse saved deviation history");
    expect(html).not.toContain('data-testid="section-personal-breaks"');
    expect(html).not.toContain('data-testid="personal-break-entry"');
  });

  it("only resolves the currently bound owner outside demo mode", () => {
    bindActivityOwner("owner-a");
    expect(verifiedPersonalDeviationOwner("owner-a", false)).toBe("owner-a");
    expect(verifiedPersonalDeviationOwner("owner-b", false)).toBeUndefined();
    expect(verifiedPersonalDeviationOwner("owner-a", true)).toBeUndefined();
    expect(verifiedPersonalDeviationOwner("owner-a", false, "owner-b")).toBeUndefined();

    bindActivityOwner("owner-b");
    expect(verifiedPersonalDeviationOwner("owner-a", false)).toBeUndefined();
    expect(verifiedPersonalDeviationOwner("owner-b", false)).toBe("owner-b");

    bindActivityOwner(null);
    expect(verifiedPersonalDeviationOwner("owner-b", false)).toBeUndefined();
  });

  it("resets the legacy browse presentation when the account or demo scope changes", () => {
    expect(legacyDeviationPresentationKey("dashboard", "owner-a", false))
      .not.toBe(legacyDeviationPresentationKey("dashboard", "owner-b", false));
    expect(legacyDeviationPresentationKey("history", "owner-a", false))
      .not.toBe(legacyDeviationPresentationKey("history", "owner-a", true));
  });

  it("keeps ordinary historical entries unlabelled and offers deletion rather than End now for a future break", () => {
    bindActivityOwner("owner-a");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const domains = ["fitness"].map(domainId => ({
      domainId, displayName: "Fitness", scoreAvailability: "not_calculated" as const,
      currentPolicyVersionId: null, policyVersions: [],
    }));
    client.setQueryData(personalDomainsQuery("owner-a").queryKey, domains);
    client.setQueryData(personalDomainBoundaryQuery("owner-a").queryKey, { timezone: "America/New_York", dayStartHour: 6 });
    client.setQueryData(personalActivityEligibilityQuery("owner-a", "fitness").queryKey, {
      domainId: "fitness", canCreate: true, reason: null, effectivePolicyVersionId: null,
    });
    client.setQueryData(personalDeviationsQuery("owner-a").queryKey, [
      {
        deviationId: "ordinary-past", startAt: "2025-01-01T12:00:00.000Z", endAt: "2025-01-02T12:00:00.000Z",
        endedAt: null, deletedAt: null, scope: "selected", type: "stitch", reason: "Ordinary past break",
        policy: {}, provenance: {}, practiceIds: ["fitness"],
      },
      {
        deviationId: "scheduled-future", startAt: "2035-01-01T12:00:00.000Z", endAt: "2035-01-02T12:00:00.000Z",
        endedAt: null, deletedAt: null, scope: "selected", type: "stitch", reason: "Scheduled break",
        policy: {}, provenance: {}, practiceIds: ["fitness"],
      },
    ]);
    const html = renderToStaticMarkup(<QueryClientProvider client={client}>
      <PersonalDeviationSection ownerId="owner-a" />
    </QueryClientProvider>);
    expect(html).not.toContain("Retroactive");
    expect(html).not.toContain('data-testid="button-end-personal-break-scheduled-future"');
    expect(html).toContain('data-testid="button-delete-personal-break-scheduled-future"');
    client.clear();
  });

  it("shows actual ended time separately from a different planned end and labels active and future plans", () => {
    bindActivityOwner("owner-a");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const domains = [{ domainId: "fitness", displayName: "Fitness", scoreAvailability: "not_calculated" as const,
      currentPolicyVersionId: null, policyVersions: [] }];
    client.setQueryData(personalDomainsQuery("owner-a").queryKey, domains);
    client.setQueryData(personalDomainBoundaryQuery("owner-a").queryKey, { timezone: "America/New_York", dayStartHour: 6 });
    client.setQueryData(personalActivityEligibilityQuery("owner-a", "fitness").queryKey, {
      domainId: "fitness", canCreate: true, reason: null, effectivePolicyVersionId: null,
    });
    client.setQueryData(personalDeviationsQuery("owner-a").queryKey, [
      {
        deviationId: "ended-early", startAt: "2026-11-01T05:00:00Z", endAt: "2027-01-05T15:00:00Z",
        endedAt: "2026-11-10T15:00:00Z", deletedAt: null, scope: "selected", type: "stitch", reason: "Ended early",
        policy: {}, provenance: {}, practiceIds: ["fitness"],
      },
      {
        deviationId: "active-planned", startAt: "2026-11-01T05:00:00Z", endAt: "2026-12-10T15:00:00Z",
        endedAt: null, deletedAt: null, scope: "selected", type: "stitch", reason: "Active",
        policy: {}, provenance: {}, practiceIds: ["fitness"],
      },
      {
        deviationId: "future-planned", startAt: "2035-01-01T12:00:00Z", endAt: "2035-01-05T15:00:00Z",
        endedAt: null, deletedAt: null, scope: "selected", type: "stitch", reason: "Future",
        policy: {}, provenance: {}, practiceIds: ["fitness"],
      },
      {
        deviationId: "active-open-ended", startAt: "2020-01-01T12:00:00Z", endAt: null,
        endedAt: null, deletedAt: null, scope: "selected", type: "stitch", reason: "Open ended",
        policy: {}, provenance: {}, practiceIds: ["fitness"],
      },
    ]);
    const html = renderToStaticMarkup(<QueryClientProvider client={client}>
      <PersonalDeviationSection ownerId="owner-a" />
    </QueryClientProvider>);
    expect(html).toContain("Actual end: 2026-11-10T10:00:00.000 (America/New_York)");
    expect(html).toContain("Planned end: 2027-01-05T10:00:00.000 (America/New_York)");
    expect(html).toContain("Planned end: 2026-12-10T10:00:00.000 (America/New_York)");
    expect(html).toContain("Scheduled end: 2035-01-05T10:00:00.000 (America/New_York)");
    expect(html).toContain("No planned end.");
    client.clear();
  });
});
