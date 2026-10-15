import { describe, expect, it } from "vitest";
import { sessionEditFields } from "./legacy-session-edit";
import type { Session } from "@/store";
const saved: Session = { id: "old", domain: "meditation", durationMinutes: 10, timestamp: "2020-01-01T00:00:00.123Z",
  isAnomaly: true, anomalyNote: "  old explanation\n", notes: "  😀\n".repeat(2000) };
describe("historical edit fields", () => {
  it("omits an untouched oversized note and exact saved timestamp", () => {
    const patch = sessionEditFields(saved, { domain: saved.domain, durationMinutes: 15 });
    expect(patch).toEqual({ durationMinutes: 15 });
    expect(saved.notes).toBe("  😀\n".repeat(2000));
  });
  it("preserves explicitly changed whitespace and Unicode", () => {
    expect(sessionEditFields(saved, { domain: saved.domain, durationMinutes: 10, notes: "  é 😀\n" }))
      .toEqual({ notes: "  é 😀\n" });
  });
  it("distinguishes clearing from an untouched field", () => {
    expect(sessionEditFields(saved, { domain: saved.domain, durationMinutes: 10, notes: "" }))
      .toEqual({ notes: null });
    expect(sessionEditFields(saved, { domain: saved.domain, durationMinutes: 10 })).toEqual({});
  });
  it("omits a note changed back to its exact saved text", () => {
    expect(sessionEditFields(saved, { domain: saved.domain, durationMinutes: 10, notes: saved.notes! })).toEqual({});
  });
  it("does not impose new goal or practice quantity restrictions", () => {
    expect(sessionEditFields(saved, { domain: "music", durationMinutes: 1000000 }))
      .toEqual({ domain: "music", durationMinutes: 1000000 });
  });
});
