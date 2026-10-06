import { Switch, Route, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import React, { useEffect, useMemo, useState } from "react";
import { useAppStore } from "@/store";
import { useAuth } from "@/hooks/use-auth";
import { sanitizeDeepLinkPath } from "@/lib/notification-deeplink";
import { createWorkspaceEntrySession, parseOnboardingStatus, type WorkspaceEntrySnapshot } from "@/lib/onboarding-api";
import type { OnboardingReady } from "@shared/onboarding";

import Dashboard from "@/pages/dashboard";
import LogSession from "@/pages/log-session";
import Decide from "@/pages/decide";
import History from "@/pages/history";
import DomainDetail from "@/pages/domain-detail";
import SystemHealth from "@/pages/system-health";
import SettingsPage from "@/pages/settings";
import DomainSettingsPage from "@/pages/domain-settings";
import OnboardingPage from "@/pages/onboarding";
import NotFound from "@/pages/not-found";
import Landing from "@/pages/landing";

function LegacyRouter() {
  return <Switch>
    <Route path="/" component={Dashboard}/><Route path="/log" component={LogSession}/>
    <Route path="/decide" component={Decide}/><Route path="/history" component={History}/>
    <Route path="/domain/:domain" component={DomainDetail}/><Route path="/system-health" component={SystemHealth}/>
    <Route path="/domains/:domainId" component={DomainSettingsPage}/><Route path="/domains" component={DomainSettingsPage}/>
    <Route path="/settings" component={SettingsPage}/><Route component={NotFound}/>
  </Switch>;
}
export function PersonalJourneyRoutes({ ownerId, status, onOwnedStatusChanged }: { ownerId: string; status: OnboardingReady; onOwnedStatusChanged?: () => void }) {
  return <Switch>
    <Route path="/"><>{status.hasConfiguredDomain ? <DomainSettingsPage/> : <OnboardingPage ownerId={ownerId} status={status} onOwnedStatusChanged={onOwnedStatusChanged}/>}</></Route>
    <Route path="/onboarding"><OnboardingPage ownerId={ownerId} status={status} onOwnedStatusChanged={onOwnedStatusChanged}/></Route>
    <Route path="/domains/:domainId" component={DomainSettingsPage}/><Route path="/domains" component={DomainSettingsPage}/>
    <Route path="/settings"><OnboardingPage ownerId={ownerId} status={status} settingsOnly onOwnedStatusChanged={onOwnedStatusChanged}/></Route>
    <Route><div className="p-6 space-y-4"><p>This page is not part of your personal workspace.</p>
      <a className="underline" href="/domains">Your domains</a></div></Route>
  </Switch>;
}
export function workspaceJourney(ownerId: string, state: WorkspaceEntrySnapshot): "pending" | "personal" | "legacy" {
  if (state.ownerId !== ownerId || state.phase !== "ready") return "pending";
  try {
    const verified = parseOnboardingStatus(state.status, ownerId);
    return verified.status === "ready" ? verified.experience : "pending";
  } catch { return "pending"; }
}
export function WorkspaceEntryNotice({ state, onReconcile, onRetry }: { state: WorkspaceEntrySnapshot;
  onReconcile: () => void; onRetry: () => void }) {
  return <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-6"><section className="max-w-xl space-y-4">
    {state.phase === "checking" || state.phase === "provisioning" ? <p role="status">{state.phase === "checking" ?
      "Checking your private workspace…" : "Preparing your private workspace…"}</p> : <>
      <h1 className="text-xl font-semibold">Your private workspace</h1>
      <p role="alert">{state.phase === "uncertain" ? "Workspace setup may already have finished. Check its saved status before trying again." :
        state.phase === "retry_ready" ? "Your saved status confirms that no workspace is ready. You may deliberately try setup again." :
        state.phase === "error" ? state.message : "Your own workspace must be verified before continuing."}</p>
      <button type="button" className="rounded-lg border p-3" onClick={onReconcile}>Check saved workspace status</button>
      {state.phase === "retry_ready" && <button type="button" className="rounded-lg border p-3 ml-3" onClick={onRetry}>Try workspace setup again</button>}
    </>}
  </section></div>;
}
export function JourneySurface({ ownerId, state, onOwnedStatusChanged }: { ownerId: string; state: WorkspaceEntrySnapshot; onOwnedStatusChanged?: () => void }) {
  const journey = workspaceJourney(ownerId, state);
  if (journey === "pending" || state.phase !== "ready") return <WorkspaceEntryNotice state={{ ownerId, phase: "checking" }} onReconcile={() => {}} onRetry={() => {}}/>;
  return <><Toaster/>{journey === "legacy" ? <LegacyShell ownerId={ownerId}/> : <PersonalJourneyRoutes ownerId={ownerId} status={state.status} onOwnedStatusChanged={onOwnedStatusChanged}/>}</>;
}
function WorkspaceGate({ ownerId }: { ownerId: string }) {
  const entry = useMemo(() => { try { return createWorkspaceEntrySession(ownerId); } catch { return null; } }, [ownerId]);
  const [state, setState] = useState<WorkspaceEntrySnapshot>(() => entry?.getSnapshot() ?? { ownerId, phase: "error", message: "Sign in to continue." });
  useEffect(() => {
    if (!entry) return;
    const leave = entry.subscribe(setState); void entry.start();
    return leave;
  }, [entry]);
  const current = state.ownerId === ownerId ? state : { ownerId, phase: "checking" as const };
  if (current.phase !== "ready") return <WorkspaceEntryNotice state={current} onReconcile={() => { void entry?.reconcile(); }} onRetry={() => { void entry?.retryEnsure(); }}/>
  return <JourneySurface ownerId={ownerId} state={current} onOwnedStatusChanged={() => { void entry?.reconcile(); }}/>
}
/** The fixed-domain store, effects and routes mount only after the owned legacy discriminator. */
function LegacyShell({ ownerId }: { ownerId: string }) {
  const fetchSessions = useAppStore(state => state.fetchSessions);
  const fetchPolicyState = useAppStore(state => state.fetchPolicyState);
  const fetchEscalationState = useAppStore(state => state.fetchEscalationState);
  const fetchDeviations = useAppStore(state => state.fetchDeviations);
  const demoState = useAppStore(state => state.demoState);
  const setNotificationPermission = useAppStore(state => state.setNotificationPermission);
  const [, setLocation] = useLocation();
  useEffect(() => {
    if (typeof window === "undefined") return;
    setNotificationPermission("Notification" in window ? window.Notification.permission as "default" | "granted" | "denied" : "unsupported");
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/service-worker.js").catch(error => console.warn("Service worker registration failed:", error));
      const handler = (event: MessageEvent) => {
        const data = event.data;
        if (data && data.type === "notification-click" && typeof data.path === "string") setLocation(sanitizeDeepLinkPath(data.path));
      };
      navigator.serviceWorker.addEventListener("message", handler);
      return () => navigator.serviceWorker.removeEventListener("message", handler);
    }
  }, [setNotificationPermission, setLocation]);
  useEffect(() => {
    if (demoState === "default") { void fetchSessions(); void fetchPolicyState(); void fetchEscalationState(); void fetchDeviations(); }
  }, [ownerId, demoState, fetchSessions, fetchPolicyState, fetchEscalationState, fetchDeviations]);
  return <><LegacyRouter/><p className="fixed bottom-2 left-1/2 -translate-x-1/2 text-[10px] italic text-muted-foreground/50 pointer-events-none select-none z-50"
    data-testid="text-anchor-shell">Protect what grows you.</p></>;
}
function AuthGate() {
  const { user, isLoading } = useAuth();
  const ownerId = user?.id;
  const queries = useQueryClient();
  useEffect(() => {
    // Reset visible legacy state on owner departure. Personal routes never read it.
    // A complete legacy mutation/read generation refactor is separate work.
    useAppStore.setState({ sessions: [], sessionsLoaded: false, policyState: null, policyStateLoaded: false,
      escalationState: null, escalationStateLoaded: false, deviations: [], deviationsLoaded: false,
      deletedSessions: [], deletedSessionsLoaded: false, deletedSessionsError: null, pendingNotifications: [], snoozeUntil: null, demoState: "default" });
    void queries.cancelQueries({ predicate: query => query.queryKey[0] !== "/api/auth/user" });
    queries.removeQueries({ predicate: query => query.queryKey[0] !== "/api/auth/user" });
  }, [ownerId, queries]);
  if (isLoading) return <WorkspaceEntryNotice state={{ ownerId: "loading", phase: "checking" }} onReconcile={() => {}} onRetry={() => {}}/>;
  if (!user) return <Landing/>;
  return <WorkspaceGate key={ownerId} ownerId={user.id}/>;
}
function App() {
  const theme = useAppStore(state => state.theme);
  useEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove("light", "dark"); root.classList.add(theme);
  }, [theme]);
  return <QueryClientProvider client={queryClient}><TooltipProvider><AuthGate/></TooltipProvider></QueryClientProvider>;
}
export default App;
