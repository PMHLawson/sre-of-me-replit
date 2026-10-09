import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { describe, expect, it } from "vitest";
import type { OnboardingReady, OnboardingSettings } from "@shared/onboarding";
import OnboardingPage, { FIRST_DAY_CHOICES, personalDayIssues, personalDayPatch, PersonalDayEditor, PersonalJourneyIntro } from "./onboarding";

const settings: OnboardingSettings = { userId: "owner-a", dayStartHour: 6, timezone: "Europe/London", windowDays: 14 };
const ready: OnboardingReady = { schemaVersion: 1, ownerUserId: "owner-a", status: "ready", workspace: { organizationId: "workspace-a", role: "owner" },
  experience: "personal", hasConfiguredDomain: false, settings };
function render(element: React.ReactNode) {
  return renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><Router ssrPath="/onboarding">{element}</Router></QueryClientProvider>);
}
describe("owned first personal journey", () => {
  it("shows own persisted boundary before a first form, with optional goal context and no fixed-domain template", () => {
    const html = render(<OnboardingPage ownerId="owner-a" status={ready}/>);
    expect(html).toContain("Make this yours"); expect(html).toContain("These are your saved day settings");
    expect(html).toContain("Europe/London"); expect(html).toContain('value="6" selected=""');
    expect(html).toContain("Define my first domain"); expect(html).not.toMatch(/disabled=""[^>]*>Define my first domain/);
    for (const text of ["can stay undecided", "defined later", "private and optional", "No practice minimum is assumed", "every 84 days",
      "You can log activity for your personal domain. Qualification and scores are not calculated yet."]) expect(html).toContain(text);
    for (const text of ["Martial Arts", "Meditation", "Fitness", "Music", "100%", "Healthy"]) expect(html).not.toContain(text);
    expect(html).not.toContain('data-testid="domain-policy-form"');
  });
  it("does not substitute an initial saved boundary or enable a form when settings are null", () => {
    const html = render(<OnboardingPage ownerId="owner-a" status={{ ...ready, settings: null }}/>);
    expect(html).toContain("suggested defaults, not verified saved settings");
    expect(html).toContain("Save and verify your own day settings first");
    expect(html).toMatch(/disabled=""[^>]*>Define my first domain/);
    expect(html).not.toContain('data-testid="domain-policy-form"');
    expect(FIRST_DAY_CHOICES).toEqual({ dayStartHour: 4, timezone: "America/New_York", windowDays: 7 });
  });
  it("hides every private field immediately for a changed owner or foreign settings", () => {
    for (const status of [ready, { ...ready, ownerUserId: "owner-b", settings }]) {
      const html = render(<OnboardingPage ownerId="owner-b" status={status}/>);
      expect(html).toContain("must be verified"); expect(html).not.toContain("Europe/London");
      expect(html).not.toContain("Define my first domain"); expect(html).not.toContain("Your day boundary");
    }
  });
  it("provides a personal settings surface with no legacy logging or first-create shortcut", () => {
    const html = render(<OnboardingPage ownerId="owner-a" status={{ ...ready, hasConfiguredDomain: true }} settingsOnly/>);
    expect(html).toContain("Your day settings"); expect(html).toContain("Save day settings"); expect(html).toContain("Your domains");
    expect(html).not.toContain("Define my first domain"); expect(html).not.toContain("Log session");
  });
  it("retains valid nonpreset stored choices without offering arbitrary new options", () => {
    const saved = { ...settings, dayStartHour: 18, windowDays: 9 };
    const html = renderToStaticMarkup(<PersonalDayEditor value={saved} saved={saved} disabled={false} onChange={() => {}}/>);
    expect(html).toContain('value="18" selected=""'); expect(html).toContain("6 p.m. (saved value)");
    expect(html).toContain('value="9" selected=""'); expect(html).toContain("9 days (saved value)");
    expect(html).not.toContain('value="17"');
    expect(personalDayPatch(saved, saved)).toBeNull();
    expect(personalDayPatch({ ...saved, timezone: "America/New_York" }, saved)).toEqual({ timezone: "America/New_York" });
    expect(personalDayPatch({ ...saved, windowDays: 28 }, saved)).toEqual({ windowDays: 28 });
    expect(() => personalDayPatch({ ...saved, windowDays: 10 }, saved)).toThrow();
  });
  it("sends only changed fields and requires an explicit persisted choice when no saved settings exist", () => {
    expect(personalDayPatch({ ...settings, dayStartHour: 4 }, settings)).toEqual({ dayStartHour: 4 });
    expect(personalDayPatch(settings, settings)).toBeNull();
    expect(personalDayPatch(FIRST_DAY_CHOICES, null)).toEqual(FIRST_DAY_CHOICES);
    const html = renderToStaticMarkup(<PersonalJourneyIntro settingsOnly={false}/>);
    expect(html).not.toContain("develop by default"); expect(html).not.toContain("diagnosis");
  });
  it("renders invalid timezone/hour/window choices safely and blocks first-form entry", () => {
    const invalid = { ...settings, timezone: "Not/A-Timezone", dayStartHour: 25, windowDays: -1 };
    expect(personalDayIssues(invalid, settings)).toHaveLength(3);
    const html = render(<OnboardingPage ownerId="owner-a" status={{ ...ready, settings: invalid }}/>);
    expect(html).toContain("Choose a valid day-start hour"); expect(html).toContain("Choose a valid timezone");
    expect(html).toContain("Choose an available tracking window");
    expect(html).toMatch(/disabled=""[^>]*>Define my first domain/); expect(html).not.toContain('data-testid="domain-policy-form"');
    expect(() => renderToStaticMarkup(<PersonalDayEditor value={{ ...invalid, dayStartHour: NaN }} saved={settings} disabled={false} onChange={() => {}}/>)).not.toThrow();
  });
});
