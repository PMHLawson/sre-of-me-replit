import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PersonalDeviationPracticePicker, type PersonalDeviationPracticeOption } from "./deviation-form";

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
});
