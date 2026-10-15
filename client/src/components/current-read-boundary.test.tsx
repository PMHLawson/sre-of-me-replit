import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { bindLegacyOwner, useAppStore } from "@/store";
import { CurrentReadBoundary } from "./current-read-boundary";
beforeEach(() => {
  bindLegacyOwner(null); bindLegacyOwner("owner"); useAppStore.getState().resetLegacyReads();
  useAppStore.setState({ demoState: "default" });
});
const html = () => renderToStaticMarkup(<CurrentReadBoundary><p>HEALTHY VERIFIED VERDICT</p></CurrentReadBoundary>);
describe("current result rendering", () => {
  it("does not present a verdict while loading", () => {
    expect(html()).toContain("Current results unavailable");
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
  it("keeps explicit demo behavior separate", () => {
    useAppStore.setState({ demoState: "mixed" });
    expect(html()).toContain("HEALTHY VERIFIED VERDICT");
  });
});
