import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DomainConfigurationSchema } from "@shared/domain-config";
import DomainPolicyForm, { chooseCapabilityLater, DomainPolicyEditor, DomainPolicyFormNotice, DomainPolicyReview, policyIssueLabel,
  UNSPECIFIED_CAPABILITY } from "./domain-policy-form";
import { conditionFor, draftIdentities, newPolicyDraft, newReference, prospectivePolicyDraft, validationConfiguration,
  withPracticeFrequency } from "@/lib/domain-policy-draft";

const now = Date.parse("2026-10-06T03:00:00Z");
const ids = (() => { let n = 0; return draftIdentities(() => `id-${++n}`); })();
function draft() {
  const value = withPracticeFrequency(newPolicyDraft({ timezone: "America/New_York", dayStartHour: 6 }, ids, now, "count"), ids, true);
  value.displayName = "Cooking <carefully>";
  value.goal = { intent: "develop", desiredCapability: "Bake evenly", privateMotivation: "My <private> reason" };
  const amount = value.measurements[0]; amount.displayName = "Cupcakes"; amount.unit.customLabel = "cupcakes";
  const normal = value.targets.normal.conditions[0], upper = conditionFor(amount, true);
  if (amount.kind !== "count" || normal.valueType !== "integer" || upper.valueType !== "integer")
    throw new Error("This fixture requires the creator's count measurement and integer conditions.");
  normal.constraint = { operator: "gte", value: 12 };
  value.targets.adapted = { target: { targetId: ids.adapted, conditions: [{ ...normal, constraint: { operator: "gte", value: 3 } }] },
    effectiveFrom: value.effectiveFrom, duration: "ongoing", reviewAt: "2026-12-01T00:00:00Z", reason: "Recovery <gently>" };
  value.targets.upperRecovery = { conditions: [{ ...upper, constraint: { operator: "lte", value: 48 } }], guidance: "Leave room" };
  value.references = [{ ...newReference("reference", "develop"), applicability: { description: "My kitchen" }, status: "known",
    conditions: [{ ...normal, constraint: { operator: "gte", value: 20 } }] }];
  return value;
}
describe("personal domain form presentation", () => {
  it("supports an explicit capability skip without inventing intent, motivation or a minimum", () => {
    const value = newPolicyDraft({ timezone: "Europe/London", dayStartHour: 4 }, ids, now, "repetitions");
    value.displayName = "Cooking";
    value.goal = chooseCapabilityLater(value.goal, true);
    expect(value.goal).toEqual({ intent: "unknown", desiredCapability: UNSPECIFIED_CAPABILITY });
    expect(value.references).toEqual([]); expect(value.review.intervalDays).toBe(84);
    expect(DomainConfigurationSchema.safeParse(validationConfiguration(value)).success).toBe(true);
    const html = renderToStaticMarkup(<DomainPolicyEditor draft={value} ids={ids} onChange={() => {}}/>);
    expect(html).toContain("I&#x27;ll define this later"); expect(html).toContain("Capability is explicitly unspecified");
    expect(html).toMatch(/<textarea[^>]*disabled=""/); expect(html).toContain("Not yet decided");
    expect(html).not.toContain("science-based"); expect(html).not.toContain("minimum to develop");
    const specified = chooseCapabilityLater({ ...value.goal, privateMotivation: "Only mine" }, false);
    expect(specified).toMatchObject({ intent: "unknown", desiredCapability: "", privateMotivation: "Only mine" });
    expect(DomainConfigurationSchema.safeParse(validationConfiguration({ ...value, goal: specified })).success).toBe(false);
  });
  it("labels amount, independent frequency and future scheduling without inventing duration or scoring", () => {
    const html = renderToStaticMarkup(<DomainPolicyEditor draft={draft()} ids={ids} onChange={() => {}} />);
    for (const label of ["Domain name", "Desired capability", "Your private motivation", "Primary measurement", "Cupcakes (cupcakes) target",
      "Frequency counts", "Any logged practice events", "Normal target", "Adapted target", "Upper recovery guidance", "Reference purpose",
      "Configuration starts", "at least 15 minutes", "every 84 days", "America/New_York"])
      expect(html).toContain(label);
    expect(html).toContain("My &lt;private&gt; reason");
    expect(html).not.toContain("My <private> reason");
    expect(html).not.toContain("Log session"); expect(html).not.toContain("100%");
  });
  it("shows all changed target amounts and reference basis honestly before a future save", () => {
    const html = renderToStaticMarkup(<DomainPolicyReview draft={draft()} />);
    for (const text of ["at least 12 cupcakes", "at least 3 cupcakes", "at most 48 cupcakes", "at least 20 cupcakes", "My kitchen",
      "Adaptation starts", "Adaptation review", "Recovery &lt;gently&gt;", "Below-reference targets are allowed", "Comparisons will be returned after saving"])
      expect(html).toContain(text);
    expect(html).not.toContain("meets_reference"); expect(html).not.toContain("healthy"); expect(html).not.toContain("100%");
  });
  it("keeps copied measurement definitions read-only while retaining every imported condition", () => {
    const previous = DomainConfigurationSchema.parse(validationConfiguration(draft()));
    previous.targets.stretch = { targetId: "stretch", conditions: structuredClone(previous.targets.normal.conditions) };
    const value = prospectivePolicyDraft(previous, now);
    const html = renderToStaticMarkup(<DomainPolicyEditor draft={value} ids={ids} previous={previous} onChange={() => {}} />);
    expect(html).toContain('readOnly=""');
    expect(html).toContain("Saved measurement definitions, units, task variants");
    expect(html).toContain("Saved stretch target (preserved)");
    expect(html).toContain("Cupcakes (cupcakes) target"); expect(html).toContain("Practice events (events) target");
    expect(html).not.toContain("Primary measurement</span>");
    expect(html).not.toContain("Frequency counts</span>");
  });
  it("requires an explicit purpose before adding a new reference", () => {
    const value = draft(); value.goal.intent = "unknown"; value.references = [];
    const html = renderToStaticMarkup(<DomainPolicyEditor draft={value} ids={ids} onChange={() => {}} />);
    expect(html).toContain('value="" selected=""');
    expect(html).toContain("Choose the reference purpose");
    expect(html).toMatch(/disabled=""[^>]*>Add reference benchmark/);
  });
  it("does not offer a numeric recovery limit for completion-only domains", () => {
    const value = newPolicyDraft({ timezone: "America/New_York", dayStartHour: 6 }, ids, now, "completion");
    const html = renderToStaticMarkup(<DomainPolicyEditor draft={value} ids={ids} onChange={() => {}} />);
    expect(html).toContain("No numeric upper limit applies");
    expect(html).not.toContain("Include declared recovery guidance");
  });
  it("presents field errors, pending work and uncertain-save gating separately", () => {
    const html = renderToStaticMarkup(<DomainPolicyFormNotice issues={[{ path: "targets.normal.conditions.0", code: "invalid", message: "Use a whole number" }]}
      error="Refresh before another save" pending needsReconciliation />);
    expect(html).toContain('role="status"'); expect(html).toContain('role="alert"');
    expect(html).toContain("Use a whole number"); expect(html).toContain("first request may already have been saved");
    expect(html).toContain("Normal target:"); expect(html).not.toContain("targets.normal.conditions.0");
    expect(policyIssueLabel("configuration.references.2.conditions.0")).toBe("Reference 3");
    expect(policyIssueLabel("next.effectiveFrom")).toBe("Configuration start");
  });
  it("uses a memory-only inline form with explicit save and discard actions", () => {
    const previous = DomainConfigurationSchema.parse(validationConfiguration(draft()));
    const html = renderToStaticMarkup(<DomainPolicyForm ownerId="owner-a" boundary={previous.boundary} previous={previous}
      domainId="owned-domain" onSaved={() => {}} onCancel={() => {}} onReconcile={async () => null} />);
    expect(html).toContain("Schedule a new configuration"); expect(html).toContain("Reason for this change");
    expect(html).toContain("Save future configuration"); expect(html).toContain("Cancel and discard draft");
    expect(html).toContain("Private drafts stay here");
    expect(html).not.toContain("Immediately active"); expect(html).not.toContain("data-mutation-cache");
  });
});
