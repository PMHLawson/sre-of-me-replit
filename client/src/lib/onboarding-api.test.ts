import { afterEach, describe, expect, it, vi } from "vitest";
import type { OnboardingReady, OnboardingStatus } from "@shared/onboarding";
import { createWorkspaceEntrySession, ensurePersonalWorkspace, OnboardingApiError, onboardingStatusQuery,
  parseOnboardingStatus, parsePersonalDaySettings, savePersonalDaySettings } from "./onboarding-api";

const needs = (owner = "owner-a"): OnboardingStatus => ({ schemaVersion: 1, ownerUserId: owner, status: "needs_workspace" });
const ready = (owner = "owner-a"): OnboardingReady => ({ schemaVersion: 1, ownerUserId: owner, status: "ready",
  workspace: { organizationId: `private-${owner}`, role: "owner" }, experience: "personal", hasConfiguredDomain: false,
  settings: { userId: owner, dayStartHour: 4, timezone: "America/New_York", windowDays: 7 } });
const signal = () => new AbortController().signal;
function delayed<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
afterEach(() => vi.unstubAllGlobals());

describe("owned onboarding transport", () => {
  it("strictly validates both subject identities and never fabricates missing settings", () => {
    expect(parseOnboardingStatus(needs(), "owner-a")).toEqual(needs());
    expect(parseOnboardingStatus({ ...ready(), settings: null }, "owner-a")).toMatchObject({ settings: null });
    expect(() => parseOnboardingStatus(ready("owner-b"), "owner-a")).toThrow(OnboardingApiError);
    expect(() => parseOnboardingStatus({ ...ready(), settings: ready("owner-b").settings }, "owner-a")).toThrow();
    expect(() => parseOnboardingStatus({ ...needs(), settings: ready().settings }, "owner-a")).toThrow();
    expect(() => parseOnboardingStatus({ ...ready(), rolloutMode: "v2" }, "owner-a")).toThrow();
    expect(() => parsePersonalDaySettings({ ...ready().settings, userId: "owner-b" }, "owner-a")).toThrow();
    expect(() => parsePersonalDaySettings({ ...ready().settings, timezone: "Not/A-Timezone" }, "owner-a")).toThrow();
    expect(() => parsePersonalDaySettings({ ...ready().settings, windowDays: Number.MAX_SAFE_INTEGER + 1 }, "owner-a")).toThrow();
  });
  it("partitions keys by owner, disables query retries and sends no actor authority", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(needs()), { status: 200 })); vi.stubGlobal("fetch", fetcher);
    const a = onboardingStatusQuery("owner-a"), b = onboardingStatusQuery("owner-b"), abort = signal();
    expect(a.queryKey).not.toEqual(b.queryKey); expect(a.retry).toBe(false); expect(a.gcTime).toBe(0);
    await a.queryFn({ signal: abort });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith("/api/onboarding/status", { method: "GET", credentials: "include", signal: abort });
    expect(() => onboardingStatusQuery(" owner-a")).toThrow(); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("uses one strict empty POST and validates its owner response", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(ready()), { status: 200 })); vi.stubGlobal("fetch", fetcher);
    const abort = signal(); expect(await ensurePersonalWorkspace("owner-a", abort)).toEqual(ready());
    expect(fetcher).toHaveBeenCalledExactlyOnceWith("/api/onboarding/workspace", { method: "POST", credentials: "include", signal: abort,
      headers: { "Content-Type": "application/json" }, body: "{}" });
    fetcher.mockResolvedValue(new Response(JSON.stringify(ready("owner-b")), { status: 200 }));
    await expect(ensurePersonalWorkspace("owner-a", signal())).rejects.toMatchObject({ needsReconciliation: true });
  });
  it.each(["network", "malformed", "server", "not-ready"])("does not retry an uncertain %s ensure", async failure => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    if (failure === "network") fetcher.mockRejectedValue(new Error("private internal failure"));
    else fetcher.mockResolvedValue(new Response(failure === "malformed" ? "{" : JSON.stringify(needs()), { status: failure === "server" ? 503 : 200 }));
    await expect(ensurePersonalWorkspace("owner-a", signal())).rejects.toMatchObject({ status: 503, needsReconciliation: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("keeps definite auth rejection separate from an uncertain write", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("{}", { status: 403 })); vi.stubGlobal("fetch", fetcher);
    await expect(ensurePersonalWorkspace("owner-a", signal())).rejects.toMatchObject({ status: 403, needsReconciliation: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([21, 30])("uses the personal settings route and retains omitted saved window %i", async windowDays => {
    const acknowledged = { ...ready().settings, dayStartHour: 6, timezone: "Europe/London", windowDays };
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...acknowledged, notificationsEnabled: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const abort = signal(), saved = await savePersonalDaySettings("owner-a", { dayStartHour: 6, timezone: "Europe/London" }, abort);
    expect(saved).toEqual(acknowledged);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith("/api/onboarding/settings", { method: "PATCH", credentials: "include", signal: abort,
      headers: { "Content-Type": "application/json" }, body: '{"dayStartHour":6,"timezone":"Europe/London"}' });
    fetcher.mockResolvedValue(new Response(JSON.stringify(ready().settings), { status: 200 }));
    await expect(savePersonalDaySettings("owner-a", { dayStartHour: 6 }, signal())).rejects.toMatchObject({ needsReconciliation: true });
  });
  it("rejects empty settings, foreign authority and unsupported windows before transport", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    for (const input of [{}, { userId: "owner-b" }, { windowDays: 9 }, { timezone: "Not/A-Zone" }])
      await expect(savePersonalDaySettings("owner-a", input as never, signal())).rejects.toMatchObject({ status: 400, needsReconciliation: false });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("actual workspace entry state machine", () => {
  it("converges effect replay and concurrent start into a single ensure", async () => {
    const wait = delayed<OnboardingReady>(), read = vi.fn().mockResolvedValue(needs()), ensure = vi.fn().mockReturnValue(wait.promise);
    const session = createWorkspaceEntrySession("owner-a", { read, ensure });
    const states: string[] = [], leave = session.subscribe(state => states.push(state.phase));
    const first = session.start(); await Promise.resolve();
    leave(); const leaveAgain = session.subscribe(state => states.push(state.phase));
    await session.start(); await session.retryEnsure();
    expect(ensure).toHaveBeenCalledTimes(1); expect(read).toHaveBeenCalledTimes(1);
    wait.resolve(ready()); await first;
    expect(session.getSnapshot()).toMatchObject({ phase: "ready", status: ready() });
    expect(states).toContain("provisioning"); leaveAgain();
  });
  it("holds uncertain setup until explicit status reconciliation; a committed workspace causes no second POST", async () => {
    const read = vi.fn().mockResolvedValueOnce(needs()).mockResolvedValueOnce(ready());
    const ensure = vi.fn().mockRejectedValue(new OnboardingApiError(503, true));
    const session = createWorkspaceEntrySession("owner-a", { read, ensure });
    await session.start(); expect(session.getSnapshot().phase).toBe("uncertain");
    await session.retryEnsure(); await session.start(); expect(ensure).toHaveBeenCalledTimes(1);
    await session.reconcile(); expect(session.getSnapshot()).toMatchObject({ phase: "ready" });
    expect(ensure).toHaveBeenCalledTimes(1); expect(read).toHaveBeenCalledTimes(2);
  });
  it("permits a deliberate retry only after a successful needs-workspace read", async () => {
    const read = vi.fn().mockResolvedValue(needs()), ensure = vi.fn().mockRejectedValueOnce(new OnboardingApiError(503, true)).mockResolvedValueOnce(ready());
    const session = createWorkspaceEntrySession("owner-a", { read, ensure });
    await session.start(); await session.retryEnsure(); expect(ensure).toHaveBeenCalledTimes(1);
    await session.reconcile(); expect(session.getSnapshot().phase).toBe("retry_ready"); expect(ensure).toHaveBeenCalledTimes(1);
    await session.retryEnsure(); expect(ensure).toHaveBeenCalledTimes(2); expect(session.getSnapshot().phase).toBe("ready");
  });
  it("a failed or foreign reconciliation never enables ensure or legacy fallback", async () => {
    const read = vi.fn().mockResolvedValueOnce(needs()).mockRejectedValueOnce(new OnboardingApiError(503)).mockResolvedValueOnce(ready("owner-b"));
    const ensure = vi.fn().mockRejectedValue(new OnboardingApiError(503, true));
    const session = createWorkspaceEntrySession("owner-a", { read, ensure }); await session.start();
    await session.reconcile(); await session.retryEnsure(); expect(session.getSnapshot().phase).toBe("error");
    await session.reconcile(); await session.retryEnsure(); expect(session.getSnapshot().phase).toBe("error");
    expect(ensure).toHaveBeenCalledTimes(1);
  });
  it("keeps retry absent through a failed uncertainty read, then requires a deliberate retry after owned absence", async () => {
    const read = vi.fn().mockResolvedValueOnce(needs()).mockRejectedValueOnce(new OnboardingApiError(503)).mockResolvedValueOnce(needs());
    const ensure = vi.fn().mockRejectedValueOnce(new OnboardingApiError(503, true)).mockResolvedValueOnce(ready());
    const session = createWorkspaceEntrySession("owner-a", { read, ensure }); await session.start();
    await session.reconcile(); await session.retryEnsure(); expect(session.getSnapshot().phase).toBe("error"); expect(ensure).toHaveBeenCalledTimes(1);
    await session.reconcile(); expect(session.getSnapshot().phase).toBe("retry_ready"); expect(ensure).toHaveBeenCalledTimes(1);
    await session.retryEnsure(); expect(session.getSnapshot().phase).toBe("ready"); expect(ensure).toHaveBeenCalledTimes(2);
  });
  it("never ensures or exposes defaults after an initial read failure", async () => {
    const ensure = vi.fn(), read = vi.fn().mockRejectedValueOnce(new OnboardingApiError(503)).mockResolvedValueOnce(needs());
    const session = createWorkspaceEntrySession("owner-a", { read, ensure }); await session.start();
    expect(session.getSnapshot()).toMatchObject({ phase: "error" }); expect(ensure).not.toHaveBeenCalled();
    await session.start(); await session.retryEnsure(); expect(read).toHaveBeenCalledTimes(1); expect(ensure).not.toHaveBeenCalled();
    await session.reconcile(); expect(session.getSnapshot().phase).toBe("retry_ready"); expect(ensure).not.toHaveBeenCalled();
  });
  it("never provisions a known owner or repairs that owner's missing settings", async () => {
    const ensure = vi.fn(), known = { ...ready(), experience: "legacy" as const, settings: null };
    const session = createWorkspaceEntrySession("owner-a", { read: vi.fn().mockResolvedValue(known), ensure });
    await session.start(); expect(ensure).not.toHaveBeenCalled(); expect(session.getSnapshot()).toMatchObject({ phase: "ready", status: known });
  });
  it("disposes an owner before a delayed status can initiate a write", async () => {
    const wait = delayed<OnboardingStatus>(), ensure = vi.fn(), read = vi.fn().mockReturnValue(wait.promise);
    const session = createWorkspaceEntrySession("owner-a", { read, ensure }); const update = vi.fn();
    session.subscribe(update); const pending = session.start(); const last = update.mock.calls.length;
    session.dispose(); expect(read.mock.calls[0][1].aborted).toBe(true);
    wait.resolve(needs()); await pending; expect(ensure).not.toHaveBeenCalled(); expect(update).toHaveBeenCalledTimes(last);
  });
  it("ignores a delayed old-owner ensure and separates two equal-caption owners' entry state", async () => {
    const wait = delayed<OnboardingReady>(), first = createWorkspaceEntrySession("owner-a", {
      read: vi.fn().mockResolvedValue(needs()), ensure: vi.fn().mockReturnValue(wait.promise) });
    const oldUpdate = vi.fn(); first.subscribe(oldUpdate); const pending = first.start(); await Promise.resolve();
    first.dispose(); const second = createWorkspaceEntrySession("owner-b", { read: vi.fn().mockResolvedValue(ready("owner-b")), ensure: vi.fn() });
    await second.start(); const priorCalls = oldUpdate.mock.calls.length;
    wait.resolve(ready()); await pending;
    expect(oldUpdate).toHaveBeenCalledTimes(priorCalls); expect(first.getSnapshot().phase).toBe("checking");
    expect(second.getSnapshot()).toMatchObject({ ownerId: "owner-b", phase: "ready", status: ready("owner-b") });
  });
});
