import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DomainConfigurationSchema } from "@shared/domain-config";
import { ActivityViewSchema, type ActivityView, type ActivityMutationResult } from "@shared/activity";
import { parsePersonalDomain, personalDomainsQuery } from "@/lib/domains-api";
import { ActivitiesApiError, activityEditInput, activityInput, bindActivityOwner, createActivitySubmissionSession, createActivityMutationSession,
  personalActivitiesQuery, personalActivityEligibilityQuery, personalActivityQuery, type ActivityEntryMemory, type ActivityMutationMemory } from "@/lib/activities-api";
const auth = vi.hoisted(() => ({ user: { id: "owner-a" } as { id: string } | null }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: auth.user }) }));
import ActivitiesPage, { ActivityAvailability, ActivityCorrectionForm, ActivityEntryForm, ActivityHistory, ActivityRawView } from "./activities";

function fixture(kind: "count" | "duration" | "quantity" | "completion" | "frequency" = "count") {
  const perEvent = { kind: "per_event" as const }, period = { kind: "period" as const, windowDays: 7 };
  const common = { measurementId: "amount", displayName: "My raw work", meaning: "Own declared measure", role: "practice",
    comparisonDirection: "higher_is_better", scope: perEvent };
  const measurement = kind === "completion" ? { ...common, kind, valueType: "boolean", comparisonDirection: "equal",
    unit: { unitId: "done", dimension: "boolean" }, aggregation: "any" } : kind === "frequency" ? { ...common, kind,
    valueType: "integer", scope: period, unit: { unitId: "days", dimension: "days" }, aggregation: "count", countBy: "distinct_days" } :
    kind === "duration" ? { ...common, kind, valueType: "number", unit: { unitId: "minutes", dimension: "time" }, aggregation: "sum" } :
      kind === "quantity" ? { ...common, kind, valueType: "number", unit: { unitId: "custom-bag", dimension: "quantity", customLabel: "bags <own>" }, aggregation: "sum" } :
        { ...common, kind, valueType: "integer", unit: { unitId: "cupcake", dimension: "count", customLabel: "cupcakes" }, aggregation: "sum" };
  const condition = { measurementId: "amount", unitId: measurement.unit.unitId, basis: measurement.scope,
    valueType: measurement.valueType, constraint: kind === "completion" ? { operator: "eq", value: true } :
      { operator: "gte", value: kind === "frequency" ? 3 : 20 } };
  const configuration = DomainConfigurationSchema.parse({ schemaVersion: 1, organizationId: "org-a", ownerUserId: "owner-a", domainId: "own-domain",
    policyVersionId: "saved-v1", revision: 1, effectiveFrom: "2026-01-01T00:00:00Z", displayName: "Cooking <own>",
    goal: { intent: "unknown", desiredCapability: "Define later", privateMotivation: "Private <why>" },
    boundary: { timezone: "America/New_York", dayStartHour: 6 }, taskVariants: [], measurements: [measurement],
    targets: { normal: { targetId: "normal", conditions: [condition] } }, references: [], review: { anchorAt: "2026-01-01T00:00:00Z", intervalDays: 84 } });
  const input = activityInput(configuration, "stable-submission", "2026-02-01T12:00:00Z", kind === "frequency" ? {} : {
    amount: { unitId: configuration.measurements[0].unit.unitId, valueType: configuration.measurements[0].valueType,
      raw: kind === "completion" ? "false" : kind === "quantity" ? "1.25" : "0" } }, "Private <notes>", "Own <context>");
  const activity = ActivityViewSchema.parse({ activityId: "own-activity", ownerUserId: "owner-a", domainId: configuration.domainId,
    policyVersionId: configuration.policyVersionId, practiceEvent: true, observedAt: input.observedAt, values: input.values,
    notes: input.notes, context: input.context, deletedAt: null, configuration, stateFingerprint: "1".repeat(64), scoreAvailability: "not_calculated", attainmentAvailability: "not_calculated" });
  const domain = parsePersonalDomain({ domainId: configuration.domainId, displayName: configuration.displayName, slug: "cooking",
    currentPolicyVersionId: configuration.policyVersionId, policyVersions: [{ configuration, referenceComparisons: [] }], scoreAvailability: "not_calculated" }, "owner-a", configuration.domainId);
  return { configuration, input, activity, domain };
}
function render(element: React.ReactNode, path = "/activities", client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })) {
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><Router ssrPath={path}>{element}</Router></QueryClientProvider>);
  client.clear(); return html;
}
beforeEach(() => { auth.user = { id: "owner-a" }; bindActivityOwner("owner-a"); });
afterEach(() => { bindActivityOwner(null); vi.unstubAllGlobals(); });

describe("raw activity and typed entry surfaces", () => {
  it("renders only saved raw values, historical units and boundary, escaping private content", () => {
    const { activity } = fixture(); const html = render(<ActivityRawView activity={activity}/>);
    expect(html).toContain("0 cupcakes"); expect(html).toContain("saved configuration and references");
    expect(html).toContain("Saved version 1"); expect(html).toContain("day begins 06:00 in America/New_York");
    expect(html).toContain("Private &lt;notes&gt;"); expect(html).toContain("Own &lt;context&gt;"); expect(html).toContain("Private &lt;why&gt;");
    expect(html).toContain("No activity score"); expect(html).toContain("below a declared target or reference");
    expect(html).not.toMatch(/\b100%\b|healthy|duration_minutes/); expect(html).not.toContain("0 minutes");
  });
  it("keeps false, missing and decimal custom quantities distinct rather than converting them to minutes", () => {
    expect(render(<ActivityRawView activity={fixture("completion").activity}/>)).toContain("No done");
    expect(render(<ActivityRawView activity={fixture("quantity").activity}/>)).toContain("1.25 bags &lt;own&gt;");
    const { activity } = fixture(); const missing = { ...activity, configuration: DomainConfigurationSchema.parse({ ...activity.configuration,
      measurements: [...activity.configuration.measurements, { ...activity.configuration.measurements[0], measurementId: "optional", displayName: "Optional result", role: "context" }] }) };
    expect(render(<ActivityRawView activity={missing}/>)).toContain("Not recorded");
    const event = render(<ActivityRawView activity={fixture("frequency").activity}/>);
    expect(event).toContain("Practice event recorded"); expect(event).toContain("Frequency and qualification not calculated");
    expect(event).not.toContain("0 days"); expect(event).not.toContain("0 minutes");
  });
  it.each(["count", "duration", "quantity", "completion", "frequency"] as const)("renders declared %s controls with no invented raw target value", kind => {
    const { domain, configuration } = fixture(kind);
    const html = render(<ActivityEntryForm ownerId="owner-a" domain={domain} effectivePolicyVersionId={configuration.policyVersionId}
      reload={() => {}} initialAt="2026-02-01T12:00:00.125Z" initialKey="draft" initialTimezone="America/New_York"/>);
    expect(html).toContain("When did this happen? (America/New_York)"); expect(html).toContain('value="2026-02-01T07:00:00.125"');
    expect(html).toContain("Selected saved version 1"); expect(html).toContain("Below-reference work can be saved");
    expect(html).not.toContain('value="20"');
    if (kind === "completion") expect(html).toContain('<option value="false">No</option>');
    else if (kind === "frequency") { expect(html).toContain("Record one practice event"); expect(html).not.toContain('type="number"'); expect(html).not.toContain('value="3"'); }
    else expect(html).toContain(kind === "count" ? 'step="1"' : 'step="any"');
  });
  it("disables entry for a time before the saved chain and explains scheduled policy prohibition", () => {
    const { domain, configuration } = fixture();
    const html = render(<ActivityEntryForm ownerId="owner-a" domain={domain} effectivePolicyVersionId={configuration.policyVersionId}
      reload={() => {}} initialAt="2025-01-01T12:00:00Z" initialKey="draft" initialTimezone="UTC"/>);
    expect(html).toContain("Scheduled configurations cannot be used"); expect(html).toContain('type="submit" disabled=""');
  });
  it.each(["legacy_writer", "inactive", "no_effective_policy"] as const)("uses server-owned %s availability without a caption-based permission", reason => {
    const html = render(<ActivityAvailability domainId="own-domain" availability={{ domainId: "own-domain", canCreate: false, reason }}/>);
    expect(html).not.toContain("Save activity"); expect(html).toContain('href="/domains/own-domain"');
    expect(html.includes('href="/log"')).toBe(reason === "legacy_writer");
  });
  it("keeps an uncertain draft visible and disabled with manual saved read, including after failed read", async () => {
    const { domain, configuration, input } = fixture();
    const read = vi.fn().mockRejectedValue(new ActivitiesApiError(503));
    const session = createActivitySubmissionSession("owner-a", { create: vi.fn().mockRejectedValue(new ActivitiesApiError(503)), read });
    const entry: ActivityEntryMemory = { domain, effectivePolicyVersionId: configuration.policyVersionId, session };
    await session.submit(input); await session.reconcile();
    const html = render(<ActivityEntryForm ownerId="owner-a" domain={domain} effectivePolicyVersionId={configuration.policyVersionId}
      entry={entry} availableNow={false} reload={() => {}} initialTimezone="UTC"/>);
    expect(html).toContain("This save was not acknowledged"); expect(html).toContain("Check saved activity");
    expect(html).toContain('fieldset disabled=""'); expect(html).toContain('value="0"'); expect(html).toContain("Private &lt;notes&gt;");
    expect(html).toContain("draft stays here"); expect(html).toContain("not saved across a reload");
    expect(html).not.toContain("Retry this same activity"); expect(html).not.toContain("Discard draft");
    expect(html).not.toContain("Cancel and return"); expect(html).not.toContain("Navigation and further saves are paused");
    expect(session.getSnapshot().draft?.submissionKey).toBe("stable-submission"); session.dispose();
  });
  it("offers an explicit identical retry only after the owned submission read returns404", async () => {
    const { domain, configuration, input } = fixture(); const session = createActivitySubmissionSession("owner-a", {
      create: vi.fn().mockRejectedValue(new ActivitiesApiError(503)), read: vi.fn().mockRejectedValue(new ActivitiesApiError(404)) });
    await session.submit(input); await session.reconcile();
    const html = render(<ActivityEntryForm ownerId="owner-a" domain={domain} effectivePolicyVersionId={configuration.policyVersionId}
      entry={{ domain, effectivePolicyVersionId: configuration.policyVersionId, session }} reload={() => {}} initialTimezone="UTC"/>);
    expect(html).toContain("Retry this same activity"); expect(html).toContain("Discard draft and refresh"); expect(html).toContain('fieldset disabled=""'); session.dispose();
  });
  it("does not paint a retained A draft for B even if a stale caller hands over the old entry", async () => {
    const { domain, configuration, input } = fixture(); const session = createActivitySubmissionSession("owner-a", {
      create: vi.fn().mockRejectedValue(new ActivitiesApiError(503)), read: vi.fn() }); await session.submit(input);
    const html = render(<ActivityEntryForm ownerId="owner-b" domain={domain} effectivePolicyVersionId={configuration.policyVersionId}
      entry={{ domain, effectivePolicyVersionId: configuration.policyVersionId, session }} reload={() => {}} initialTimezone="UTC"/>);
    expect(html).toBe(""); session.dispose();
  });
  it("history links use activity identity and each saved version, preserving a deleted record", () => {
    const { activity } = fixture(); const deleted: ActivityView = { ...activity, deletedAt: "2026-02-02T12:00:00.000Z" };
    const html = render(<ActivityHistory activities={[deleted]}/>);
    expect(html).toContain('href="/activities/own-activity"'); expect(html).toContain("saved version 1 · deleted");
    expect(html).toContain("0 cupcakes"); expect(html).not.toContain("at least 20"); expect(html).not.toContain("minutes");
  });
});
describe("reasoned correction, deletion and restoration surfaces", () => {
  function memory(operation: "edit" | "delete" | "restore", base = fixture().activity): ActivityMutationMemory {
    const { domain } = fixture();
    return { base, domain, effectivePolicyVersionId: base.policyVersionId, operation,
      session: createActivityMutationSession("owner-a", base, operation) };
  }
  it("starts a correction from the saved raw snapshot, including zero, selected historical version and private context", () => {
    const draft = memory("edit"), html = render(<ActivityCorrectionForm ownerId="owner-a" memory={draft} availableNow close={() => {}} initialTimezone="UTC"/>);
    expect(html).toContain("Correct this activity"); expect(html).toContain("Reason for this correction"); expect(html).toContain('value="0"');
    expect(html).toContain("Selected saved version 1"); expect(html).toContain("day begins 06:00 in America/New_York");
    expect(html).toContain("Private &lt;notes&gt;"); expect(html).toContain("Own &lt;context&gt;"); expect(html).toContain("Changing domains requires a separate new event");
    expect(html).toContain("Cancel without changing activity"); expect(html).not.toContain(draft.base.stateFingerprint); draft.session.dispose();
  });
  it.each(["delete", "restore"] as const)("requires a reason before confirming %s and explains reversible saved identity", operation => {
    const draft = memory(operation, { ...fixture().activity, deletedAt: operation === "restore" ? "2026-02-03T12:00:00.000Z" : null });
    const html = render(<ActivityCorrectionForm ownerId="owner-a" memory={draft} availableNow close={() => {}} initialTimezone="UTC"/>);
    expect(html).toContain(operation === "delete" ? "Confirm deletion" : "Confirm restoration");
    expect(html).toContain(operation === "delete" ? "Deletion keeps the saved record" : "Restoration keeps the original saved time");
    expect(html).toContain("Reason for this"); expect(html).not.toContain('type="datetime-local"'); expect(html).not.toContain("Save correction"); draft.session.dispose();
  });
  it("keeps uncertain reason/key/raw state after failed reconciliation and never offers cancellation or rebase", async () => {
    const { activity, domain, configuration } = fixture(); const edit = activityEditInput(activity, configuration, "change-key", "Typo <own>", activity.observedAt,
      { amount: { unitId: "cupcake", valueType: "integer", raw: "8" } }, "Changed notes", "Original context");
    const session = createActivityMutationSession("owner-a", activity, "edit", { mutate: vi.fn().mockRejectedValue(new ActivitiesApiError(503)),
      read: vi.fn().mockRejectedValue(new ActivitiesApiError(503)) });
    await session.submit({ operation: "edit", input: edit }); await session.reconcile();
    const html = render(<ActivityCorrectionForm ownerId="owner-a" memory={{ base: activity, domain, effectivePolicyVersionId: configuration.policyVersionId, operation: "edit", session }}
      availableNow={false} close={() => {}} initialTimezone="UTC"/>);
    expect(html).toContain("Check saved change"); expect(html).toContain('fieldset disabled=""'); expect(html).toContain("Typo &lt;own&gt;"); expect(html).toContain('value="8"');
    expect(html).toContain("captured draft remains here"); expect(html).not.toContain("Cancel without changing"); expect(html).not.toContain("Discard change");
    expect(html).not.toContain("Retry this same change"); expect(session.getSnapshot().draft?.input.mutationKey).toBe("change-key"); session.dispose();
  });
  it("shows current saved state after an earlier change was acknowledged without claiming it reapplied", async () => {
    const { activity, domain } = fixture(), current = { ...activity, stateFingerprint: "3".repeat(64), deletedAt: "2026-02-04T12:00:00.000Z" };
    const result: ActivityMutationResult = { changed: false, operation: "delete", mutationKey: "delete-key", activity: current, appliedStateFingerprint: "2".repeat(64) };
    const session = createActivityMutationSession("owner-a", activity, "delete", { mutate: vi.fn().mockResolvedValue(result), read: vi.fn() });
    await session.submit({ operation: "delete", input: { mutationKey: "delete-key", expectedStateFingerprint: activity.stateFingerprint, reason: "Duplicate" } });
    const html = render(<ActivityCorrectionForm ownerId="owner-a" memory={{ base: activity, domain, effectivePolicyVersionId: activity.policyVersionId, operation: "delete", session }}
      availableNow close={() => {}} initialTimezone="UTC"/>);
    expect(html).toContain("Change acknowledged"); expect(html).toContain("later changes may also be present"); expect(html).toContain("This activity is deleted");
    expect(html).not.toContain("Confirm deletion"); session.dispose();
  });
  it("never renders A's correction snapshot for B", () => {
    const draft = memory("edit"); const html = render(<ActivityCorrectionForm ownerId="owner-b" memory={draft} availableNow close={() => {}} initialTimezone="UTC"/>);
    expect(html).toBe(""); draft.session.dispose();
  });
  it("lets an inactive domain's existing manual event be deleted while disabling correction", () => {
    const { activity, domain } = fixture(), client = new QueryClient();
    client.setQueryData(personalActivityQuery("owner-a", activity.activityId).queryKey, activity);
    client.setQueryData(personalDomainsQuery("owner-a", activity.domainId).queryKey, domain);
    client.setQueryData(personalActivityEligibilityQuery("owner-a", activity.domainId).queryKey, { domainId: activity.domainId, canCreate: false, reason: "inactive" });
    const html = render(<ActivitiesPage/>, "/activities/own-activity", client);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Correct activity<\/button>/);
    const deleteButton = html.match(/<button([^>]*)>Delete activity<\/button>/);
    expect(deleteButton).not.toBeNull(); expect(deleteButton![1]).not.toMatch(/(?:^|\s)disabled(?:\s|=|$)/);
    expect(html).not.toContain("Restore activity");
  });
  it("offers restoration only for a saved deleted record with verified active custom-domain availability", () => {
    const { activity, domain } = fixture(), client = new QueryClient(), deleted = { ...activity, deletedAt: "2026-02-04T12:00:00.000Z" };
    client.setQueryData(personalActivityQuery("owner-a", activity.activityId).queryKey, deleted);
    client.setQueryData(personalDomainsQuery("owner-a", activity.domainId).queryKey, domain);
    client.setQueryData(personalActivityEligibilityQuery("owner-a", activity.domainId).queryKey, { domainId: activity.domainId, canCreate: true, reason: null, effectivePolicyVersionId: activity.policyVersionId });
    const html = render(<ActivitiesPage/>, "/activities/own-activity", client); expect(html).toContain("Restore activity");
    expect(html).not.toContain("Correct activity"); expect(html).not.toContain("Delete activity");
  });
});
describe("actual activity page owner-query routes (SSR; mounted journeys are a separate browser gate)", () => {
  it("reads own raw history without fetching the legacy session store or current settings", () => {
    const { activity } = fixture(), client = new QueryClient();
    client.setQueryData(personalActivitiesQuery("owner-a", { limit: 25 }).queryKey, { activities: [activity], nextCursor: null });
    const html = render(<ActivitiesPage/>, "/activities", client);
    expect(html).toContain("Your activity history"); expect(html).toContain("0 cupcakes"); expect(html).toContain("Original sessions remain in the original history");
  });
  it("uses activity identity for the own saved detail route", () => {
    const { activity } = fixture(), client = new QueryClient(); client.setQueryData(personalActivityQuery("owner-a", activity.activityId).queryKey, activity);
    const html = render(<ActivitiesPage/>, "/activities/own-activity", client);
    expect(html).toContain("Saved activity"); expect(html).toContain("Private &lt;notes&gt;"); expect(html).toContain("day begins 06:00");
  });
  it("does not borrow another owner's history cache on account change", () => {
    const { activity } = fixture(), client = new QueryClient(); client.setQueryData(personalActivitiesQuery("owner-a", { limit: 25 }).queryKey, { activities: [activity], nextCursor: null });
    auth.user = { id: "owner-b" }; bindActivityOwner("owner-b"); const html = render(<ActivitiesPage/>, "/activities", client);
    expect(html).toContain("Loading your activity history"); expect(html).not.toContain("Cooking &lt;own&gt;"); expect(html).not.toContain("Private");
  });
  it("starts entry behind verified owned domain and availability reads, with no default configuration", () => {
    const html = render(<ActivitiesPage/>, "/activities/new/own-domain"); expect(html).toContain("Loading your domain");
    expect(html).not.toContain('data-testid="activity-entry-form"'); expect(html).not.toContain("America/New_York");
    auth.user = null; const publicHtml = render(<ActivitiesPage/>, "/activities"); expect(publicHtml).toContain("Sign in with a valid owned activity path");
    expect(publicHtml).not.toContain("No custom activities");
  });
});
