import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useEffect } from "react";
import { useAppStore } from "@/store";

import Dashboard from "@/pages/dashboard";
import LogSession from "@/pages/log-session";
import Decide from "@/pages/decide";
import History from "@/pages/history";
import DomainDetail from "@/pages/domain-detail";
import SystemHealth from "@/pages/system-health";
import NotFound from "@/pages/not-found";

function Router() {
  return (
    <Switch>
      <Route path="/" component={Dashboard}/>
      <Route path="/log" component={LogSession}/>
      <Route path="/decide" component={Decide}/>
      <Route path="/history" component={History}/>
      <Route path="/domain/:domain" component={DomainDetail}/>
      <Route path="/system-health" component={SystemHealth}/>
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  const theme = useAppStore(state => state.theme);
  const fetchSessions = useAppStore(state => state.fetchSessions);
  const demoState = useAppStore(state => state.demoState);

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

  // Load real sessions from the server on startup (only when not in a demo state)
  useEffect(() => {
    if (demoState === 'default') {
      fetchSessions();
    }
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Router />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;