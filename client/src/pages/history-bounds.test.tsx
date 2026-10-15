import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import { beforeEach, describe, expect, it } from "vitest";
import { bindLegacyOwner, useAppStore, type Session } from "@/store";
import History from "./history";
const row = (id: string, timestamp: string, durationMinutes: number): Session => ({
  id, timestamp, durationMinutes, domain: "meditation", deletedAt: null,
  isAnomaly: false, anomalyNote: null, notes: null, textComplete: false, hasNotes: false, hasAnomalyNote: false });
beforeEach(() => {
  bindLegacyOwner(null); bindLegacyOwner("owner"); useAppStore.getState().resetLegacyReads();
  const recent = new Date(); recent.setDate(recent.getDate() - 10);
  useAppStore.setState({ demoState: "default", sessions: [row("context", recent.toISOString(), 80)],
    sessionsLoaded: true, deviationsLoaded: true, historyLoaded: true, historyComplete: false,
    historySessions: [row("archive", "2020-01-01T12:00:00Z", 10)] });
});
const html = () => renderToStaticMarkup(<Router ssrPath="/history"><History /></Router>);
describe("history presentation completeness", () => {
  it("labels page counts and weekly values as shown-record subtotals", () => {
    const output = html();
    expect(output).toContain("shown practice records"); expect(output).toContain("Shown subtotal:");
    expect(output).toContain("not complete weekly totals"); expect(output).toContain("Load older practice records");
  });
  it("uses the complete calendar context rather than the loaded archive page", () => {
    const output = html();
    expect(output).toContain("80m"); expect(output).toContain("active day");
    expect(output).toContain("archive");
  });
  it("keeps raw future-dated records reachable in browsing", () => {
    useAppStore.setState({ historySessions: [row("future-record", "2030-01-01T12:00:00Z", 15)] });
    expect(html()).toContain("session-item-future-record");
  });
  it("shows a history read failure without claiming no activity", () => {
    useAppStore.setState({ historyLoaded: false, historySessions: [], historyError: "Could not load practice history." });
    const output = html();
    expect(output).toContain("Could not load practice history"); expect(output).not.toContain("No active practice records.");
  });
});
