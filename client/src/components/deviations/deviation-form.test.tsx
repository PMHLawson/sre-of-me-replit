import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindActivityOwner } from "@/lib/activities-api";
import type { PersonalDeviation } from "@/lib/deviation-v2-api";
import { PersonalDeviationForm, PersonalDeviationPracticePicker, type PersonalDeviationPracticeOption } from "./deviation-form";

vi.mock("@/components/ui/dialog", async () => {
  const { createElement, Fragment } = await import("react");
  type DialogProps = { open?: boolean; children?: React.ReactNode; [key: string]: unknown };
  const wrapper = (tag: string) => ({ children, ...props }: DialogProps) =>
    createElement(tag, props as React.HTMLAttributes<HTMLElement>, children);
  return {
    Dialog: ({ open, children }: DialogProps) => open ? createElement(Fragment, null, children) : null,
    DialogContent: wrapper("div"),
    DialogHeader: wrapper("header"),
    DialogTitle: wrapper("h2"),
    DialogFooter: wrapper("footer"),
    DialogDescription: wrapper("p"),
  };
});

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

  it("shows an over-limit selection count without trimming the selection", () => {
    const savedSelections = [...practices.map(practice => practice.domainId),
      ...Array.from({ length: 96 }, (_, index) => `saved-practice-${index}`)];
    const html = renderToStaticMarkup(<PersonalDeviationPracticePicker practices={practices}
      selectedIds={savedSelections} onChange={() => {}} />);
    expect(savedSelections).toHaveLength(101);
    expect(html).toContain("Selected: 101 practices (limit 100).");
    expect(html).toContain("Choose which 100 or fewer practices to keep. This selection has not been trimmed.");
  });

  it("renders millisecond browser controls and does not label the default current-time entry retroactive", () => {
    bindActivityOwner("owner-a");
    const html = renderToStaticMarkup(<PersonalDeviationForm open onOpenChange={() => {}} ownerId="owner-a"
      timezone="America/New_York" practices={practices} onSubmit={async () => null} />);
    const inputTag = (testId: string) =>
      html.match(new RegExp(`<input\\b(?=[^>]*data-testid="${testId}")[^>]*>`))?.[0] ?? "";
    const attribute = (tag: string, name: string) =>
      tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? "";
    const startInput = inputTag("input-personal-break-start");
    const endInput = inputTag("input-personal-break-end");
    expect(startInput).not.toBe("");
    expect(endInput).not.toBe("");
    expect(attribute(startInput, "step")).toBe("0.001");
    expect(attribute(endInput, "step")).toBe("0.001");
    expect(attribute(startInput, "value")).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/);
    expect(attribute(endInput, "value")).toBe("");
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
    const browserValues = Array.from(html.matchAll(
      /<input\b[^>]*type="datetime-local"[^>]*value="([^"]*)"/g,
    ), match => match[1]);
    expect(browserValues).toEqual(["2026-11-01T01:30:12.123", "2026-11-01T02:30:12.654"]);
    expect(html).toContain("Saved exact time: 2026-11-01T01:30:12.123456 (America/New_York)");
    expect(html).toContain("Saved exact time: 2026-11-01T02:30:12.654321 (America/New_York)");
  });
});
