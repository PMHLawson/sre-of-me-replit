import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindActivityOwner } from "./activities-api";
import {
  createPersonalDeviation, deletePersonalDeviation, editPersonalDeviation, endPersonalDeviation,
  PersonalDeviationApiError, personalDeviationsQuery,
} from "./deviation-v2-api";
import type { PersonalDeviation } from "./deviation-v2-api";

function saved(overrides: Partial<PersonalDeviation> = {}): PersonalDeviation {
  return {
    deviationId: "break-1",
    startAt: "2026-11-01T06:30:12.123456Z",
    endAt: null,
    endedAt: null,
    deletedAt: null,
    scope: "selected",
    type: "stitch",
    reason: "Recovery",
    policy: {},
    provenance: {},
    practiceIds: ["fitness"],
    ...overrides,
  };
}
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  bindActivityOwner("owner-a");
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  bindActivityOwner(null);
  vi.unstubAllGlobals();
});

describe("personal break lifecycle client", () => {
  it("sends a single selected-practice v2 create with separate audited explanations", async () => {
    const response = saved({ startAt: "2026-11-02T14:30:00.000Z", endAt: "2026-11-02T15:30:00.000Z",
      reason: "Travel", practiceIds: ["cooking", "fitness"] });
    vi.mocked(fetch).mockResolvedValueOnce(json(response));
    const result = await createPersonalDeviation("owner-a", {
      startAt: "2026-11-02T14:30:00.000Z",
      endAt: "2026-11-02T15:30:00.000Z",
      reason: "Travel",
      changeReason: "Recording a planned break",
      practiceIds: ["fitness", "cooking"],
      type: "stitch",
    });
    expect(result.practiceIds).toEqual(["cooking", "fitness"]);
    expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/v2/deviations", expect.objectContaining({
      method: "POST", credentials: "include", cache: "no-store",
    }));
    const init = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      startAt: "2026-11-02T14:30:00.000Z",
      endAt: "2026-11-02T15:30:00.000Z",
      reason: "Travel",
      changeReason: "Recording a planned break",
      practiceIds: ["fitness", "cooking"],
      type: "stitch",
    });
    expect(body).not.toHaveProperty("domain");
    expect(body).not.toHaveProperty("excludeFromComposite");
  });

  it("rejects an empty reason and an over-limit new selection before making a request", async () => {
    const base = { startAt: "2026-11-02T14:30:00.000Z", endAt: null, changeReason: "Record it",
      practiceIds: ["fitness"], type: "stitch" as const };
    await expect(createPersonalDeviation("owner-a", { ...base, reason: "   " })).rejects.toThrow();
    await expect(createPersonalDeviation("owner-a", { ...base, reason: "Break",
      practiceIds: Array.from({ length: 101 }, (_, index) => `practice-${index}`) })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves exact microseconds and complete selected IDs on edit", async () => {
    const original = saved({ practiceIds: ["cooking", "fitness"] });
    vi.mocked(fetch).mockResolvedValueOnce(json({ ...original, reason: "Travel" }));
    await editPersonalDeviation("owner-a", original, {
      startAt: original.startAt,
      endAt: original.endAt,
      reason: "Travel",
      changeReason: "Added the reason",
      practiceIds: original.practiceIds,
    });
    const [path, init] = vi.mocked(fetch).mock.calls[0];
    expect(path).toBe("/api/v2/deviations/break-1");
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.startAt).toBe(original.startAt);
    expect(body.practiceIds).toEqual(original.practiceIds);
  });

  it("keeps an older 101-practice break readable and endable without trimming", async () => {
    const practiceIds = Array.from({ length: 101 }, (_, index) => `practice-${index}`);
    vi.mocked(fetch).mockResolvedValueOnce(json([saved({ practiceIds })]));
    const list = await personalDeviationsQuery("owner-a").queryFn({ signal: new AbortController().signal });
    expect(list[0].practiceIds).toHaveLength(101);
    vi.mocked(fetch).mockResolvedValueOnce(json(saved({ practiceIds, endedAt: "2026-11-02T14:30:00.000Z" })));
    const ended = await endPersonalDeviation("owner-a", list[0], "Back to regular practice");
    expect(ended.practiceIds).toHaveLength(101);
    expect(JSON.parse(String((vi.mocked(fetch).mock.calls[1][1] as RequestInit).body)))
      .toEqual({ changeReason: "Back to regular practice" });
  });

  it("uses authenticated lifecycle routes and separate audit explanations for ending and deletion", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(json(saved({ endedAt: "2026-11-02T14:30:00.000Z" })))
      .mockResolvedValueOnce(json(saved({ deletedAt: "2026-11-02T14:30:00.000Z" })));
    const current = saved();
    await endPersonalDeviation("owner-a", current, "Break is complete");
    await deletePersonalDeviation("owner-a", current, "Entered by mistake");
    expect(vi.mocked(fetch).mock.calls.map(([path]) => path)).toEqual([
      "/api/v2/deviations/break-1/end",
      "/api/v2/deviations/break-1",
    ]);
    expect(vi.mocked(fetch).mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body))))
      .toEqual([{ changeReason: "Break is complete" }, { changeReason: "Entered by mistake" }]);
  });

  it("does not use cached owner A data after an account switch during a request", async () => {
    let resolveResponse!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValueOnce(new Promise(resolve => { resolveResponse = resolve; }));
    const request = createPersonalDeviation("owner-a", {
      startAt: "2026-11-02T14:30:00.000Z", endAt: null, reason: "Break", changeReason: "Record",
      practiceIds: ["fitness"], type: "stitch",
    });
    bindActivityOwner("owner-b");
    resolveResponse(json(saved({ startAt: "2026-11-02T14:30:00.000Z" })));
    await expect(request).rejects.toBeInstanceOf(PersonalDeviationApiError);
  });

  it("preserves older all-practices rows for history while preventing a selected-set edit", async () => {
    const allPractices = saved({ scope: "all", practiceIds: [] });
    vi.mocked(fetch).mockResolvedValueOnce(json([allPractices]));
    const [row] = await personalDeviationsQuery("owner-a").queryFn({ signal: new AbortController().signal });
    await expect(editPersonalDeviation("owner-a", row, {
      startAt: row.startAt, endAt: row.endAt, reason: row.reason, changeReason: "Change", practiceIds: ["fitness"],
    })).rejects.toBeInstanceOf(PersonalDeviationApiError);
    expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/v2/deviations", expect.anything());
  });
});
