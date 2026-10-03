import { describe, expect, it } from "vitest";
import { updateSessionSchema, insertDeviationSchema, updateDeviationSchema } from "./schema";

// Same 39-case matrix as the retained pre-repair probe; all data invented.
export const explanationInputs = [
  { id: "omitted", present: false, value: undefined },
  { id: "undefined", present: true, value: undefined },
  { id: "null", present: true, value: null },
  { id: "empty", present: true, value: "" },
  { id: "one-space", present: true, value: " " },
  { id: "several-spaces", present: true, value: "    " },
  { id: "tabs-newlines", present: true, value: "\t\n\r" },
  { id: "nbsp", present: true, value: "\u00a0" },
  { id: "em-space", present: true, value: "\u2003" },
  { id: "meaningful", present: true, value: "Invented reason" },
  { id: "padded", present: true, value: " \tInvented reason\n " },
  { id: "500", present: true, value: "x".repeat(500) },
  { id: "501", present: true, value: "x".repeat(501) },
] as const;

const validators = [
  { id: "required-session-edit", schema: updateSessionSchema, base: {}, optional: false },
  { id: "required-deviation-create", schema: insertDeviationSchema,
    base: { domain: "music", startAt: "2026-10-03T12:00:00Z" }, optional: false },
  { id: "optional-deviation-update", schema: updateDeviationSchema, base: {}, optional: true },
] as const;

describe("actual explanation validators: presence, content and original length", () => {
  for (const validator of validators) {
    it.each(explanationInputs)(`${validator.id}/$id`, input => {
      const payload = { ...validator.base, ...(input.present ? { reason: input.value } : {}) };
      expect(Object.hasOwn(payload, "reason")).toBe(input.present);
      const result = validator.schema.safeParse(payload);
      const valid = input.id === "omitted" || input.id === "undefined"
        ? validator.optional : ["meaningful", "padded", "500"].includes(input.id);
      expect(result.success).toBe(valid);
      if (result.success) {
        // Validation must never normalize meaningful input or materialize omission.
        expect(result.data.reason).toBe(input.value);
        expect(Object.hasOwn(result.data, "reason")).toBe(input.present);
      } else {
        expect(result.error.issues.some(issue => issue.path[0] === "reason")).toBe(true);
      }
    });
    it(`${validator.id}/unicode-padding-is-preserved`, () => {
      const reason = "\u00a0\u2003 \tInvented meaningful explanation\r\n\u2003\u00a0";
      const result = validator.schema.parse({ ...validator.base, reason });
      expect(result.reason).toBe(reason);
    });
    it(`${validator.id}/original-501-limit-not-trimmed-away`, () => {
      expect(validator.schema.safeParse({ ...validator.base, reason: ` ${"x".repeat(499)} ` }).success).toBe(false);
    });
  }
});