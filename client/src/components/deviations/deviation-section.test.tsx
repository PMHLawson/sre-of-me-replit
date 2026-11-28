import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { bindActivityOwner, personalActivityEligibilityQuery } from "@/lib/activities-api";
import { personalDomainBoundaryQuery, personalDomainsQuery } from "@/lib/domains-api";
import { personalDeviationsQuery } from "@/lib/deviation-v2-api";
import { DeviationSection } from "./deviation-section";

afterEach(() => bindActivityOwner(null));

describe("personal break section", () => {
  it("mounts only for the verified personal route and uses the saved account timezone", () => {
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
      <DeviationSection personalOwnerId="owner-a" />
    </QueryClientProvider>);
    expect(html).toContain('data-testid="section-personal-breaks"');
    expect(html).toContain("America/New_York");
    expect(html).toContain("Record break");
    expect(html).not.toContain('data-testid="section-deviations"');
    client.clear();
  });
});
