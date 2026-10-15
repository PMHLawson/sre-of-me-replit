import { beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ state: vi.fn(), page: vi.fn(), detail: vi.fn() }));
vi.mock("@/lib/legacy-history-api", () => ({
  readSessionState: api.state, readHistoryPage: api.page, readDetailStep: api.detail,
  asSession: (v: any) => ({ ...v, textComplete: false }), asDeviation: (v: any) => ({ ...v, textComplete: false }),
  mergeById: (a: any[], b: any[]) => [...new Map([...a, ...b].map(v => [v.id, v])).values()],
}));
import { bindLegacyOwner, useAppStore } from "./store";
const row = (id: string) => ({ id, userId: "owner", domain: "meditation", durationMinutes: 10,
  timestamp: "2026-01-01T00:00:00Z", deletedAt: null, isAnomaly: false, notes: null, anomalyNote: null });
const bundle = (id = "current") => ({ asOf: "2026-10-15T00:00:00Z", complete: true,
  context: { complete: true, fromInclusive: "2026-07-01T00:00:00Z", sessions: [row(id)], deviations: [] },
  policyState: { services: { meditation: { service_score: 80 } } }, escalationState: { highestTier: "WARNING" } });
beforeEach(() => {
  vi.clearAllMocks(); bindLegacyOwner(null); bindLegacyOwner("owner");
  useAppStore.getState().resetLegacyReads(); useAppStore.setState({ demoState: "default" });
});
describe("coherent current window", () => {
  it("publishes the context, policy and escalation together without requesting archive pages", async () => {
    api.state.mockResolvedValueOnce(bundle());
    await useAppStore.getState().refreshCurrent();
    const state = useAppStore.getState();
    expect(state.sessions[0].id).toBe("current"); expect(state.policyState).toBeTruthy();
    expect(state.escalationState).toBeTruthy(); expect(state.currentAsOf).toBe(bundle().asOf);
    expect(api.page).not.toHaveBeenCalled();
  });
  it("does not turn a failed read into loaded zero-score data", async () => {
    api.state.mockRejectedValueOnce(new Error());
    await useAppStore.getState().refreshCurrent();
    expect(useAppStore.getState().sessionsLoaded).toBe(false);
    expect(useAppStore.getState().sessionsError).toBeTruthy();
    expect(() => useAppStore.getState().getDomainStatus("meditation")).toThrow();
  });
  it("ignores a response for a departed owner", async () => {
    let finish!: (v: any) => void; api.state.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const pending = useAppStore.getState().refreshCurrent();
    bindLegacyOwner("different-owner"); useAppStore.getState().resetLegacyReads();
    finish(bundle("departed")); await pending;
    expect(useAppStore.getState().sessions).toEqual([]); expect(useAppStore.getState().dataOwner).toBeNull();
  });
  it("ignores an older response that completes after a newer one", async () => {
    let finish!: (v: any) => void;
    api.state.mockReturnValueOnce(new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(bundle("new"));
    const old = useAppStore.getState().refreshCurrent(); await useAppStore.getState().refreshCurrent();
    finish(bundle("old")); await old;
    expect(useAppStore.getState().sessions[0].id).toBe("new");
  });
});
describe("archive isolation", () => {
  it("advances one page only on explicit request and never changes current results", async () => {
    api.state.mockResolvedValueOnce(bundle()); await useAppStore.getState().refreshCurrent();
    const policy = useAppStore.getState().policyState;
    api.page.mockResolvedValueOnce({ items: [row("old")], nextCursor: "next", complete: false })
      .mockResolvedValueOnce({ items: [row("future")], nextCursor: null, complete: true });
    await useAppStore.getState().fetchHistory();
    expect(api.page).toHaveBeenCalledTimes(1); expect(useAppStore.getState().historyComplete).toBe(false);
    await useAppStore.getState().fetchHistory(true);
    expect(api.page).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().historySessions.map(v => v.id)).toEqual(["old", "future"]);
    expect(useAppStore.getState().sessions[0].id).toBe("current");
    expect(useAppStore.getState().policyState).toBe(policy);
  });
  it("preserves loaded records and the retry cursor when the next page fails", async () => {
    api.page.mockResolvedValueOnce({ items: [row("old")], nextCursor: "next", complete: false })
      .mockRejectedValueOnce(new Error());
    await useAppStore.getState().fetchHistory(); await useAppStore.getState().fetchHistory(true);
    expect(useAppStore.getState().historySessions[0].id).toBe("old");
    expect(useAppStore.getState().historyCursor).toBe("next");
    expect(useAppStore.getState().historyError).toBeTruthy();
    expect(useAppStore.getState().historyComplete).toBe(false);
  });
  it("rejects a late detail response after account departure", async () => {
    let finish!: (v: any) => void; api.detail.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const pending = useAppStore.getState().fetchSessionDetail("old");
    bindLegacyOwner(null); useAppStore.getState().resetLegacyReads();
    finish({ status: "ready", value: row("old") }); await pending;
    expect(useAppStore.getState().sessionDetails).toEqual({});
  });
});
