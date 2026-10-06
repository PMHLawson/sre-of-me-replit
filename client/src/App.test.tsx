import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OnboardingReady } from "@shared/onboarding";
import { createWorkspaceEntrySession, type WorkspaceEntrySnapshot } from "@/lib/onboarding-api";

const mocks = vi.hoisted(() => ({ legacy: vi.fn(), onboardingProps: vi.fn(), fetchSessions: vi.fn(), fetchPolicyState: vi.fn(), fetchEscalationState: vi.fn(), fetchDeviations: vi.fn(),
  user: { id: "owner-a" } as { id: string } | null, loading: false }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: mocks.user, isLoading: mocks.loading }) }));
vi.mock("@/store", () => ({ useAppStore: Object.assign((select: (state: unknown) => unknown) => select({ theme: "dark", demoState: "default",
  fetchSessions: mocks.fetchSessions, fetchPolicyState: mocks.fetchPolicyState, fetchEscalationState: mocks.fetchEscalationState,
  fetchDeviations: mocks.fetchDeviations, setNotificationPermission: vi.fn() }), { setState: vi.fn() }) }));
vi.mock("@/components/ui/toaster", () => ({ Toaster: () => null }));
vi.mock("@/components/ui/tooltip", () => ({ TooltipProvider: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@/pages/dashboard", () => ({ default: () => { mocks.legacy("dashboard"); return "legacy-dashboard"; } }));
vi.mock("@/pages/log-session", () => ({ default: () => { mocks.legacy("log"); return "legacy-log"; } }));
vi.mock("@/pages/decide", () => ({ default: () => { mocks.legacy("decide"); return "legacy-decide"; } }));
vi.mock("@/pages/history", () => ({ default: () => { mocks.legacy("history"); return "legacy-history"; } }));
vi.mock("@/pages/domain-detail", () => ({ default: () => { mocks.legacy("detail"); return "legacy-detail"; } }));
vi.mock("@/pages/system-health", () => ({ default: () => { mocks.legacy("health"); return "legacy-health"; } }));
vi.mock("@/pages/settings", () => ({ default: () => { mocks.legacy("settings"); return "legacy-settings"; } }));
vi.mock("@/pages/landing", () => ({ default: () => "public-sign-in" }));
vi.mock("@/pages/onboarding", async () => {
  const actual = await vi.importActual<typeof import("@/pages/onboarding")>("@/pages/onboarding");
  const { createElement } = await import("react");
  return { ...actual, default: (props: Parameters<typeof actual.default>[0]) => {
    mocks.onboardingProps(props); return createElement(actual.default, props);
  } };
});
import App, { JourneySurface, workspaceJourney, WorkspaceEntryNotice } from "./App";

const ready = (experience: "personal" | "legacy" = "personal"): OnboardingReady => ({ schemaVersion: 1, ownerUserId: "owner-a", status: "ready",
  workspace: { organizationId: "own-workspace", role: "owner" }, experience, hasConfiguredDomain: false,
  settings: { userId: "owner-a", dayStartHour: 6, timezone: "Europe/London", windowDays: 14 } });
const state = (experience: "personal" | "legacy" = "personal"): WorkspaceEntrySnapshot => ({ ownerId: "owner-a", phase: "ready", status: ready(experience) });
function render(element: React.ReactNode, path = "/") {
  return renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><Router ssrPath={path}>{element}</Router></QueryClientProvider>);
}
beforeEach(() => { vi.clearAllMocks(); mocks.user = { id: "owner-a" }; mocks.loading = false; });

describe("actual app workspace routing boundary", () => {
  it("starts a signed-in shell behind the workspace gate rather than mounting legacy pages", () => {
    const html = render(<App/>);
    expect(html).toContain("Checking your private workspace"); expect(html).not.toContain("legacy-dashboard");
    expect(mocks.legacy).not.toHaveBeenCalled();
  });
  it("keeps public sign-in behavior and pending authentication outside private routes", () => {
    mocks.user = null; expect(render(<App/>)).toContain("public-sign-in");
    mocks.loading = true; expect(render(<App/>)).toContain("Checking your private workspace"); expect(mocks.legacy).not.toHaveBeenCalled();
  });
  it.each(["/", "/log", "/history", "/decide", "/domain/music", "/system-health"])("does not mount a fixed-domain view for a personal owner at %s", path => {
    const html = render(<JourneySurface ownerId="owner-a" state={state()}/>, path);
    expect(html).not.toContain("legacy-"); expect(mocks.legacy).not.toHaveBeenCalled();
    expect(html).not.toContain("Protect what grows you");
    expect(html).toContain(path === "/" ? "Make this yours" : "not part of your personal workspace");
  });
  it("uses own settings and domain routes rather than the legacy settings cache", () => {
    const settings = render(<JourneySurface ownerId="owner-a" state={state()}/>, "/settings");
    expect(settings).toContain("Your day settings"); expect(settings).toContain("Europe/London"); expect(settings).not.toContain("legacy-settings");
    const domains = render(<JourneySurface ownerId="owner-a" state={state()}/>, "/domains");
    expect(domains).toContain("Your domains"); expect(domains).not.toContain("legacy-dashboard");
    expect(mocks.legacy).not.toHaveBeenCalled();
  });
  it.each(["/", "/onboarding", "/settings"])("wires acknowledged owner changes from actual personal %s route to workspace reconciliation", path => {
    const reconcile = vi.fn();
    const html = render(<JourneySurface ownerId="owner-a" state={state()} onOwnedStatusChanged={reconcile}/>, path);
    expect(html).toContain(path === "/settings" ? "Your day settings" : "Make this yours");
    const props = mocks.onboardingProps.mock.calls.at(-1)?.[0];
    expect(props.ownerId).toBe("owner-a"); expect(props.onOwnedStatusChanged).toBe(reconcile);
    props.onOwnedStatusChanged(); expect(reconcile).toHaveBeenCalledTimes(1);
  });
  it.each([["/", "dashboard"], ["/log", "log"], ["/history", "history"], ["/settings", "settings"]])("preserves verified legacy navigation at %s", (path, page) => {
    const html = render(<JourneySurface ownerId="owner-a" state={state("legacy")}/>, path);
    expect(html).toContain(`legacy-${page}`); expect(mocks.legacy).toHaveBeenCalledExactlyOnceWith(page);
    expect(html).toContain("Protect what grows you");
  });
  it.each(["personal", "legacy"] as const)("mounts the real custom activity routes for a verified %s owner without changing the original logger", experience => {
    for (const [path, label] of [["/activities", "Your activity history"], ["/activities/domain/custom-domain", "Your activity history"],
      ["/activities/new/custom-domain", "Record activity"], ["/activities/owned-record", "Saved activity"]]) {
      mocks.legacy.mockClear(); const html = render(<JourneySurface ownerId="owner-a" state={state(experience)}/>, path);
      expect(html).toContain(label); expect(html).not.toContain("not part of your personal workspace"); expect(mocks.legacy).not.toHaveBeenCalled();
    }
    if (experience === "legacy") expect(render(<JourneySurface ownerId="owner-a" state={state(experience)}/>, "/log")).toContain("legacy-log");
    else expect(render(<JourneySurface ownerId="owner-a" state={state(experience)}/>, "/log")).toContain("not part of your personal workspace");
  });
  it("never infers legacy experience from configured domains, workspace roles or a failed response", () => {
    const personal: WorkspaceEntrySnapshot = { ownerId: "owner-a", phase: "ready", status: { ...ready(), hasConfiguredDomain: true,
      workspace: { organizationId: "own-workspace", role: "member" } } };
    expect(workspaceJourney("owner-a", personal)).toBe("personal");
    const html = render(<JourneySurface ownerId="owner-a" state={personal}/>);
    expect(html).toContain("Your domains"); expect(html).not.toContain("legacy-dashboard");
    expect(workspaceJourney("owner-a", { ownerId: "owner-a", phase: "error", message: "Unavailable" })).toBe("pending");
    expect(workspaceJourney("owner-b", state("legacy"))).toBe("pending");
    expect(workspaceJourney("owner-a", { ownerId: "owner-a", phase: "ready", status: { ...ready("legacy"), ownerUserId: "owner-b" } })).toBe("pending");
  });
  it("blocks a foreign cached ready/settings response before any private page renders", () => {
    const foreign: WorkspaceEntrySnapshot = { ownerId: "owner-a", phase: "ready", status: { ...ready("legacy"),
      settings: { ...ready().settings!, userId: "owner-b" } } };
    const html = render(<JourneySurface ownerId="owner-a" state={foreign}/>);
    expect(html).toContain("Checking your private workspace"); expect(html).not.toContain("Europe/London"); expect(mocks.legacy).not.toHaveBeenCalled();
  });
  it("offers a retry only after an explicit saved needs-workspace result", () => {
    const uncertain = render(<WorkspaceEntryNotice state={{ ownerId: "owner-a", phase: "uncertain" }} onReconcile={() => {}} onRetry={() => {}}/>);
    expect(uncertain).toContain("may already have finished"); expect(uncertain).toContain("Check saved workspace status");
    expect(uncertain).not.toContain("Try workspace setup again");
    const retry = render(<WorkspaceEntryNotice state={{ ownerId: "owner-a", phase: "retry_ready" }} onReconcile={() => {}} onRetry={() => {}}/>);
    expect(retry).toContain("Try workspace setup again");
  });
  it("uses fresh owned first-save status so detail then home presents domains, including a scheduled first policy", async () => {
    const read = vi.fn().mockResolvedValueOnce(ready()).mockResolvedValueOnce({ ...ready(), hasConfiguredDomain: true });
    const entry = createWorkspaceEntrySession("owner-a", { read, ensure: vi.fn() });
    await entry.start(); expect(render(<JourneySurface ownerId="owner-a" state={entry.getSnapshot()}/>)).toContain("Make this yours");
    // The real page's accepted first-domain callback invokes this actual entry read.
    await entry.reconcile(); expect(read).toHaveBeenCalledTimes(2);
    expect(render(<JourneySurface ownerId="owner-a" state={entry.getSnapshot()}/>, "/domains/scheduled-first")).toContain("Your domains");
    const home = render(<JourneySurface ownerId="owner-a" state={entry.getSnapshot()}/>);
    expect(home).toContain("Your domains"); expect(home).not.toContain("Make this yours"); expect(mocks.legacy).not.toHaveBeenCalled();
  });
});
