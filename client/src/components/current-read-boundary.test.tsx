import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bindLegacyOwner, useAppStore } from "@/store";
import { CurrentReadBoundary } from "./current-read-boundary";

// Zustand's SSR hook deliberately reads its creation snapshot. These fixtures
// prepare state with setState, so select that exact snapshot explicitly while
// preserving the real store and all of its mutation/request methods.
vi.mock("@/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/store")>();
  type State = ReturnType<typeof actual.useAppStore.getState>;
  const useAppStore = Object.assign(
    (selector: (state: State) => unknown) => selector(actual.useAppStore.getState()),
    actual.useAppStore,
  );
  return { ...actual, useAppStore };
});

beforeEach(() => {
  bindLegacyOwner(null); bindLegacyOwner("owner"); useAppStore.getState().resetLegacyReads();
  useAppStore.setState({ demoState: "default" });
});
const html = () => renderToStaticMarkup(<CurrentReadBoundary><p>HEALTHY VERIFIED VERDICT</p></CurrentReadBoundary>);
describe("current result rendering", () => {
  it("does not present a verdict while loading", () => {
    expect(html()).toContain("Current results unavailable");
    expect(html()).toContain("Loading your complete current window");
    expect(html()).not.toContain("HEALTHY VERIFIED VERDICT");
  });
  it("does not present a verdict on fetch failure", () => {
    useAppStore.setState({ sessionsError: "Failure" });
    expect(html()).toContain("No score or recommendation is being inferred");
    expect(html()).not.toContain("HEALTHY VERIFIED VERDICT");
  });
  it("does not reuse another owner's successful snapshot", () => {
    useAppStore.setState({ dataOwner: "departed", sessionsLoaded: true, policyStateLoaded: true,
      escalationStateLoaded: true, deviationsLoaded: true, policyState: {} as any, escalationState: {} as any });
    expect(html()).not.toContain("HEALTHY VERIFIED VERDICT");
  });
  it("shows a verified snapshot belonging to the current owner", () => {
    useAppStore.setState({ dataOwner: "owner", sessionsLoaded: true, policyStateLoaded: true,
      escalationStateLoaded: true, deviationsLoaded: true, policyState: {} as any, escalationState: {} as any });
    expect(html()).toContain("HEALTHY VERIFIED VERDICT");
    expect(html()).not.toContain("Current results unavailable");
  });
  it("keeps explicit demo behavior separate", () => {
    useAppStore.setState({ demoState: "mixed" });
    expect(html()).toContain("HEALTHY VERIFIED VERDICT");
  });
});
