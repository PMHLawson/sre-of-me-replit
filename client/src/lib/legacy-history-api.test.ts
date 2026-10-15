import { afterEach, describe, expect, it, vi } from "vitest";
import { mergeById, readHistoryPage, readSessionState, readDetailStep, validWindowCoverage } from "./legacy-history-api";
const version = "a".repeat(64);
const summary = { id: "old", userId: "owner", domain: "meditation", durationMinutes: 10,
  timestamp: "2020-01-01T00:00:00.000Z", deletedAt: null, isAnomaly: false, notes: null, anomalyNote: null,
  hasNotes: true, hasAnomalyNote: false, notesBytes: 8, anomalyNoteBytes: 0,
  notesAvailability: "not_loaded", anomalyNoteAvailability: "absent" };
const ok = (value: unknown) => ({ ok: true, status: 200, json: async () => value });
afterEach(() => vi.unstubAllGlobals());
describe("explicit history pages", () => {
  it("does not automatically follow the next cursor", async () => {
    const fetcher = vi.fn().mockResolvedValue(ok({ items: [summary], nextCursor: "opaque", complete: false }));
    vi.stubGlobal("fetch", fetcher);
    const page = await readHistoryPage("sessions", null, undefined, "owner");
    expect(page.nextCursor).toBe("opaque"); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects an ambiguous page-end flag", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok({ items: [], nextCursor: "more", complete: true })));
    await expect(readHistoryPage("sessions", null, undefined, "owner")).rejects.toThrow();
  });
  it("distinguishes failure from an empty successful collection", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce(ok({ items: [], nextCursor: null, complete: true }));
    vi.stubGlobal("fetch", fetcher);
    await expect(readHistoryPage("deleted", null, undefined, "owner")).rejects.toThrow();
    await expect(readHistoryPage("deleted", null, undefined, "owner")).resolves.toMatchObject({ items: [], complete: true });
  });
  it("deduplicates IDs while retaining distinct records at the same instant", () => {
    expect(mergeById([{ id: "one", n: 1 }, { id: "two", n: 2 }],
      [{ id: "one", n: 3 }, { id: "three", n: 4 }])).toEqual([
        { id: "one", n: 3 }, { id: "two", n: 2 }, { id: "three", n: 4 }]);
  });
  it("refuses a partial current window instead of treating it as no activity", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok({ asOf: new Date().toISOString(), complete: false,
      context: { complete: false, sessions: [], deviations: [], fromInclusive: "2026-01-01T00:00:00Z" } })));
    await expect(readSessionState(14, undefined, "owner")).rejects.toThrow();
  });
});
describe("explicit historical text chunks", () => {
  it("loads one chunk per action with Unicode-codepoint offsets and exact whitespace", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(ok({ ...summary, textVersion: version }))
      .mockResolvedValueOnce(ok({ text: "A😀", offset: 0, nextOffset: 2, textVersion: version, bytes: 8 }))
      .mockResolvedValueOnce(ok({ text: null, offset: 0, nextOffset: null, textVersion: version, bytes: 0 }))
      .mockResolvedValueOnce(ok({ text: "é ", offset: 2, nextOffset: null, textVersion: version, bytes: 8 }));
    vi.stubGlobal("fetch", fetcher);
    const first = await readDetailStep("sessions", "old", undefined, undefined, "owner");
    expect(first.status).toBe("incomplete");
    expect(first.value).toMatchObject({ notes: "A😀", textComplete: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
    const last = await readDetailStep("sessions", "old", first, undefined, "owner");
    expect(last.status).toBe("ready");
    expect(last.value).toMatchObject({ notes: "A😀é ", anomalyNote: null, textComplete: true });
    expect(fetcher.mock.calls[3][0]).toContain("offset=2");
  });
  it("rejects changed versions without joining text from two records", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(ok({ ...summary, textVersion: version }))
      .mockResolvedValueOnce(ok({ text: "changed", offset: 0, nextOffset: null, textVersion: "b".repeat(64), bytes: 8 })));
    await expect(readDetailStep("sessions", "old", undefined, undefined, "owner")).rejects.toThrow();
  });
  it("rejects a final chunk that silently omits bytes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(ok({ ...summary, textVersion: version }))
      .mockResolvedValueOnce(ok({ text: "A", offset: 0, nextOffset: null, textVersion: version, bytes: 8 })));
    await expect(readDetailStep("sessions", "old", undefined, undefined, "owner")).rejects.toThrow();
  });
  it("preserves an oversized historical note without applying new-write limits", async () => {
    const text = "😀".repeat(2048), bytes = new TextEncoder().encode(text).byteLength;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(ok({ ...summary, notesBytes: bytes, textVersion: version }))
      .mockResolvedValueOnce(ok({ text, offset: 0, nextOffset: null, textVersion: version, bytes }))
      .mockResolvedValueOnce(ok({ text: null, offset: 0, nextOffset: null, textVersion: version, bytes: 0 })));
    const result = await readDetailStep("sessions", "old", undefined, undefined, "owner");
    expect((result.value as any).notes).toBe(text); expect(result.status).toBe("ready");
  });
});

function metadataBundle(): any {
  const today = "2026-10-15", anchor = Date.parse(today + "T00:00:00Z"), names = ["fitness", "meditation", "music", "martial-arts"];
  const keys = (n: number) => Array.from({ length: n }, (_, i) => new Date(anchor - (n - i) * 86400000).toISOString().slice(0, 10));
  return { ownerUserId: "owner", asOf: "2026-10-15T12:00:00Z", complete: true,
    context: { fromInclusive: "2026-07-14T00:00:00Z", complete: true, sessions: [], deviations: [] },
    policyState: { logical_day: today, window_days: keys(14), sessionDays: {},
      services: Object.fromEntries(names.map(domain => [domain, { domain, logical_day: today, window_days: keys(14) }])),
      windowSets: { w7: keys(7), w14: keys(14), w28: keys(28), w42: keys(42), prev7: keys(14).slice(0, 7), todayKey: today } },
    escalationState: { logical_day: today, history: keys(14).map(logical_day => ({ logical_day,
      perDomain: Object.fromEntries(names.map(name => [name, {}])) })) } };
}
describe("current window metadata coverage", () => {
  it("accepts ordered full windows without inventing an escalation anchor policy", () => {
    expect(validWindowCoverage(metadataBundle(), 14)).toBe(true);
  });
  it.each(["w7", "w14", "w28", "w42", "prev7"])("rejects truncated %s metadata", name => {
    const value = metadataBundle(); value.policyState.windowSets[name].pop();
    expect(validWindowCoverage(value, 14)).toBe(false);
  });
  it("rejects duplicate or impossible logical-day keys", () => {
    const value = metadataBundle(); value.policyState.windowSets.w7[1] = value.policyState.windowSets.w7[0];
    expect(validWindowCoverage(value, 14)).toBe(false);
    value.policyState.logical_day = "2026-02-30";
    expect(validWindowCoverage(value, 14)).toBe(false);
  });
  it("rejects a short or reordered escalation history", () => {
    const value = metadataBundle(); value.escalationState.history.pop();
    expect(validWindowCoverage(value, 14)).toBe(false);
    const reordered = metadataBundle(); reordered.escalationState.history.reverse();
    expect(validWindowCoverage(reordered, 14)).toBe(false);
  });
  it("rejects context too short to populate the 90-day calendar", () => {
    const value = metadataBundle(); value.context.fromInclusive = "2026-10-01T00:00:00Z";
    expect(validWindowCoverage(value, 14)).toBe(false);
  });
  it("rejects another owner's summary in a newly scoped page response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok({ items: [{ ...summary, userId: "other" }], nextCursor: null, complete: true })));
    await expect(readHistoryPage("sessions", null, undefined, "owner")).rejects.toThrow();
  });
  it("rejects detail for a different ID or owner before loading text", async () => {
    const fetcher = vi.fn().mockResolvedValue(ok({ ...summary, id: "different", textVersion: version }));
    vi.stubGlobal("fetch", fetcher);
    await expect(readDetailStep("sessions", "old", undefined, undefined, "owner")).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
