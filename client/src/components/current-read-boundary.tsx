import React, { type ReactNode } from "react";
import { useAppStore, boundLegacyOwner } from "@/store";

/** A real account never derives a verdict from an archive page or failed read. */
export function CurrentReadBoundary({ children }: { children: ReactNode }) {
  const demo = useAppStore(s => s.demoState !== "default");
  const ready = useAppStore(s => s.dataOwner === boundLegacyOwner() && !!s.dataOwner && s.sessionsLoaded && s.policyStateLoaded &&
    s.escalationStateLoaded && s.deviationsLoaded && !!s.policyState && !!s.escalationState &&
    !s.sessionsError && !s.policyStateError && !s.escalationStateError && !s.deviationsError);
  const error = useAppStore(s => s.sessionsError || s.policyStateError ||
    s.escalationStateError || s.deviationsError);
  const refresh = useAppStore(s => s.refreshCurrent);
  if (demo || ready) return <>{children}</>;
  return <main className="min-h-screen bg-background text-foreground p-6" role="status"
    data-testid="current-read-unavailable">
    <h1 className="text-xl font-bold">Current results unavailable</h1>
    <p className="mt-3">{error ? "Your current records could not be verified. No score or recommendation is being inferred." :
      "Loading your complete current window…"}</p>
    {error && <button className="mt-4 underline" onClick={() => void refresh()}>Try again</button>}
    <a className="block mt-6 underline" href="/history">Open practice history</a>
  </main>;
}
