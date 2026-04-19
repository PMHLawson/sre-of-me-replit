import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useEffect } from "react";
import { useAppStore } from "@/store";
import { useAuth } from "@/hooks/use-auth";

import Dashboard from "@/pages/dashboard";
import LogSession from "@/pages/log-session";
import Decide from "@/pages/decide";
import History from "@/pages/history";
import DomainDetail from "@/pages/domain-detail";
import SystemHealth from "@/pages/system-health";
import SettingsPage from "@/pages/settings";
import NotFound from "@/pages/not-found";
import Landing from "@/pages/landing";

function Router() {
  return (
    <Switch>
      <Route path="/" component={Dashboard}/>
      <Route path="/log" component={LogSession}/>
      <Route path="/decide" component={Decide}/>
      <Route path="/history" component={History}/>
      <Route path="/domain/:domain" component={DomainDetail}/>
      <Route path="/system-health" component={SystemHealth}/>
      <Route path="/settings" component={SettingsPage}/>
      <Route component={NotFound} />
    </Switch>
  );
}

// AuthGate lives inside QueryClientProvider so it can use useAuth
function AuthGate() {
  const theme = useAppStore(state => state.theme);
  const fetchSessions = useAppStore(state => state.fetchSessions);
  const fetchPolicyState = useAppStore(state => state.fetchPolicyState);
  const fetchEscalationState = useAppStore(state => state.fetchEscalationState);
  const fetchDeviations = useAppStore(state => state.fetchDeviations);
  const demoState = useAppStore(state => state.demoState);
  const { user, isLoading } = useAuth();

  useEffect(() => {
    const root = window.document.documentElement;
    if (theme === 'light') {
      root.classList.remove('dark');
      root.classList.add('light');
    } else {
      root.classList.remove('light');
      root.classList.add('dark');
    }
  }, [theme]);

  // Only fetch real sessions when authenticated and not in a demo state
  useEffect(() => {
    if (user && demoState === 'default') {
      fetchSessions();
      fetchPolicyState();
      fetchEscalationState();
      fetchDeviations();
    }
  }, [user]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="w-8 h-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
      </div>
    );
  }

  if (!user) {
    return <Landing />;
  }

  return (
    <>
      <Toaster />
      <Router />
    </>
  );
}

function App() {
  const theme = useAppStore(state => state.theme);

  useEffect(() => {
    const root = window.document.documentElement;
    if (theme === 'light') {
      root.classList.remove('dark');
      root.classList.add('light');
    } else {
      root.classList.remove('light');
      root.classList.add('dark');
    }
  }, [theme]);

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AuthGate />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
