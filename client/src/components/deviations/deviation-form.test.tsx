import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { bindActivityOwner } from "@/lib/activities-api";
import type { PersonalDeviation } from "@/lib/deviation-v2-api";
import { PersonalDeviationForm, PersonalDeviationPracticePicker, type PersonalDeviationPracticeOption } from "./deviation-form";

afterEach(() => bindActivityOwner(null));

const practices: PersonalDeviationPracticeOption[] = [
  { domainId: "martial-arts", displayName: "Martial arts", active: true },
  { domainId: "meditation", displayName: "Meditation", active: true },
  { domainId: "fitness", displayName: "Fitness", active: true },
  { domainId: "music", displayName: "Music", active: true },
  { domainId: "custom-cooking", displayName: "Cooking", active: true },
];

describe("personal break practice picker", () => {
  it("renders every active practice, including a fifth custom practice, by stable ID", () => {
    const html = renderToStaticMarkup(<PersonalDeviationPracticePicker practices={practices}
      selectedIds={["custom-cooking"]} onChange={() => {}} />);
    expect(html).toContain("Select all active");
    expect(html).toContain('data-testid="checkbox-break-practice-custom-cooking"');
    expect(html).toContain("Cooking");
    expect((html.match(/type="checkbox"/g) ?? []).length).toBe(5);
  });

  it("keeps saved inactive selections checked and disables adding inactive practices", () => {
    const html = renderToStaticMarkup(<PersonalDeviationPracticePicker
      practices={[...practices.slice(0, 1), { domainId: "inactive", displayName: "Old practice", active: false },
        { domainId: "newly-inactive", displayName: "Other old practice", active: false }]}
      selectedIds={["inactive"]} onChange={() => {}} />);
    expect(html).toContain("Old practice · saved selection");
    expect(html).toContain('data-testid="checkbox-break-practice-inactive"');
    expect(html).toContain('data-testid="checkbox-break-practice-newly-inactive"');
    expect(html).toContain('type="checkbox" disabled=""');
  });

  it("renders a precise browser step and does not label the default current-time entry retroactive", () => {
    bindActivityOwner("owner-a");
    const html = renderToStaticMarkup(<PersonalDeviationForm open onOpenChange={() => {}} ownerId="owner-a"
      timezone="America/New_York" practices={practices} onSubmit={async () => null} />);
    expect(html.match(/type="datetime-local" step="0\.000001"/g)).toHaveLength(2);
    expect(html).toContain("Saved fractional seconds stay exact unless you change this field.");
    expect(html).not.toContain('data-testid="personal-break-retroactive"');
  });

  it("shows the unchanged saved instants with all fractional digits beside the browser fields", () => {
    bindActivityOwner("owner-a");
    const editing: PersonalDeviation = {
      deviationId: "break-precise",
      startAt: "2026-11-01T06:30:12.123456Z",
      endAt: "2026-11-01T07:30:12.654321Z",
      endedAt: null,
      deletedAt: null,
      scope: "selected",
      type: "stitch",
      reason: "Recovery",
      policy: {},
      provenance: {},
      practiceIds: ["fitness"],
    };
    const html = renderToStaticMarkup(<PersonalDeviationForm open onOpenChange={() => {}} ownerId="owner-a"
      timezone="America/New_York" practices={practices} editing={editing} onSubmit={async () => editing} />);
    expect(html).toContain("Saved exact time: 2026-11-01T01:30:12.123456 (America/New_York)");
    expect(html).toContain("Saved exact time: 2026-11-01T02:30:12.654321 (America/New_York)");
  });
});
