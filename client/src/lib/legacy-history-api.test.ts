import { afterEach, describe, expect, it, vi } from "vitest";
import { mergeById, readHistoryPage, readSessionState, readDetailStep } from "./legacy-history-api";
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
    const page = await readHistoryPage("sessions", null);
    expect(page.nextCursor).toBe("opaque"); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects an ambiguous page-end flag", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok({ items: [], nextCursor: "more", complete: true })));
    await expect(readHistoryPage("sessions", null)).rejects.toThrow();
  });
  it("distinguishes failure from an empty successful collection", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce(ok({ items: [], nextCursor: null, complete: true }));
    vi.stubGlobal("fetch", fetcher);
    await expect(readHistoryPage("deleted", null)).rejects.toThrow();
    await expect(readHistoryPage("deleted", null)).resolves.toMatchObject({ items: [], complete: true });
  });
  it("deduplicates IDs while retaining distinct records at the same instant", () => {
    expect(mergeById([{ id: "one", n: 1 }, { id: "two", n: 2 }],
      [{ id: "one", n: 3 }, { id: "three", n: 4 }])).toEqual([
        { id: "one", n: 3 }, { id: "two", n: 2 }, { id: "three", n: 4 }]);
  });
  it("refuses a partial current window instead of treating it as no activity", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok({ asOf: new Date().toISOString(), complete: false,
      context: { complete: false, sessions: [], deviations: [], fromInclusive: "2026-01-01T00:00:00Z" } })));
    await expect(readSessionState(14)).rejects.toThrow();
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
    const first = await readDetailStep("sessions", "old");
    expect(first.status).toBe("incomplete");
    expect(first.value).toMatchObject({ notes: "A😀", textComplete: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
    const last = await readDetailStep("sessions", "old", first);
    expect(last.status).toBe("ready");
    expect(last.value).toMatchObject({ notes: "A😀é ", anomalyNote: null, textComplete: true });
    expect(fetcher.mock.calls[3][0]).toContain("offset=2");
  });
  it("rejects changed versions without joining text from two records", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(ok({ ...summary, textVersion: version }))
      .mockResolvedValueOnce(ok({ text: "changed", offset: 0, nextOffset: null, textVersion: "b".repeat(64), bytes: 8 })));
    await expect(readDetailStep("sessions", "old")).rejects.toThrow();
  });
  it("rejects a final chunk that silently omits bytes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(ok({ ...summary, textVersion: version }))
      .mockResolvedValueOnce(ok({ text: "A", offset: 0, nextOffset: null, textVersion: version, bytes: 8 })));
    await expect(readDetailStep("sessions", "old")).rejects.toThrow();
  });
  it("preserves an oversized historical note without applying new-write limits", async () => {
    const text = "😀".repeat(2048), bytes = new TextEncoder().encode(text).byteLength;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(ok({ ...summary, notesBytes: bytes, textVersion: version }))
      .mockResolvedValueOnce(ok({ text, offset: 0, nextOffset: null, textVersion: version, bytes }))
      .mockResolvedValueOnce(ok({ text: null, offset: 0, nextOffset: null, textVersion: version, bytes: 0 })));
    const result = await readDetailStep("sessions", "old");
    expect((result.value as any).notes).toBe(text); expect(result.status).toBe("ready");
  });
});
