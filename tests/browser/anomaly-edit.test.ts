// Actual routes/detector + synthetic scoped storage, never server/index or owner DB.
// Run with an external Vitest config providing a new build/evidence directory.
import { afterAll, beforeAll, expect, inject, it, vi } from "vitest";
import express from "express";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { Session } from "../../shared/schema";

declare module "vitest" {
  export interface ProvidedContext {
    reviewPhase: "before" | "after";
    reviewEvidence: string;
    reviewBuild: string;
  }
}
const mocks = vi.hoisted(() => ({
  getSessions: vi.fn(), getSessionsSince: vi.fn(), updateSession: vi.fn(), createSession: vi.fn(),
}));
vi.mock("../../server/storage", () => ({ storage: mocks }));
vi.mock("../../server/replit_integrations/auth/storage", () => ({ authStorage: {} }));
vi.mock("../../server/replit_integrations/auth", () => ({
  isAuthenticated: (req: any, _res: any, next: any) => { req.user = { claims: { sub: "synthetic-viewer" } }; next(); },
}));
import { registerRoutes } from "../../server/routes";
const { runReview } = createRequire(import.meta.url)("./anomaly-edit.cjs");
const now = new Date("2026-10-03T12:00:00Z"), uid = "synthetic-viewer";
let rows: Session[] = [], mode = "", writes: unknown[] = [], audits: unknown[] = [];
const trace: unknown[] = [];
function reset(nextMode: string) {
  mode = nextMode; writes = []; audits = []; trace.length = 0;
  const initial: Session = {
    id: "synthetic-edit", userId: uid, domain: "music", durationMinutes: 51,
    timestamp: new Date("2026-10-02T12:00:00Z"), notes: "synthetic original notes",
    deletedAt: null, isAnomaly: true, anomalyNote: "intentional practice",
  };
  rows = Array.from({ length: 8 }, (_, i): Session => ({
    ...initial, id: `synthetic-peer-${i}`, durationMinutes: i % 2 ? 40 : 20,
    timestamp: new Date(mode.includes("ack") && i === 0 ? "2026-10-02T13:00:00Z" : `2026-09-${21+i}T12:00:00Z`),
    isAnomaly: false, anomalyNote: null,
  })).concat(initial);
}
const app = express(), server = createServer(app);
let origin: string;
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now);
  app.use(express.json());
  app.use((req, res, next) => {
    if (req.path.startsWith("/api/")) res.on("finish", () => trace.push({
      method: req.method, path: req.path, body: req.body, status: res.statusCode,
    }));
    next();
  });
  mocks.getSessions.mockImplementation(async (userId: string) => rows.filter(s => s.userId === userId && !s.deletedAt));
  mocks.getSessionsSince.mockImplementation(async (userId: string, cutoff: Date) =>
    rows.filter(s => s.userId === userId && !s.deletedAt && s.timestamp >= cutoff));
  mocks.updateSession.mockImplementation(async (userId: string, id: string, patch: Record<string, any>) => {
    writes.push({ method: "PATCH", id, patch });
    if (mode === "save-failure") throw new Error("Synthetic rejected save");
    const i = rows.findIndex(s => s.userId === userId && s.id === id && !s.deletedAt);
    if (i === -1) return undefined;
    const before = structuredClone(rows[i]), { reason, ...fields } = patch;
    rows[i] = { ...rows[i], ...fields, timestamp: fields.timestamp ? new Date(fields.timestamp) : rows[i].timestamp };
    audits.push({ before, after: structuredClone(rows[i]), reason });
    return rows[i];
  });
  mocks.createSession.mockImplementation(async (fields: Session) => {
    writes.push({ method: "POST", fields });
    const row = { ...fields, id: "synthetic-created", timestamp: new Date(fields.timestamp), deletedAt: null };
    rows.push(row); return row;
  });
  await registerRoutes(server, app);
  // Only the retained fresh frontend build is served. All unrelated APIs are
  // intercepted by the owned browser; no owner server is ever started.
  app.use(express.static(inject("reviewBuild"), { dotfiles: "allow" }));
  app.get("/{*path}", (_req, res) => res.sendFile(inject("reviewBuild") + "/index.html", { dotfiles: "allow" }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const a = server.address();
  if (!a || typeof a === "string") throw new Error("No owned loopback listener");
  origin = `http://127.0.0.1:${a.port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  vi.useRealTimers();
  const fs = await import("node:fs");
  fs.writeFileSync(inject("reviewEvidence") + "/route-listener-cleanup.json", JSON.stringify({ ownedListenerClosed: !server.listening, origin, ownerBackendStarted: false }));
});
it("drives both edit screens with real classification routes and owned synthetic rows", async () => {
  const result = await runReview({
    origin, phase: inject("reviewPhase"), evidence: inject("reviewEvidence"), reset,
    state: () => ({ rows, writes, audits, trace }),
  });
  expect(result.runtimeExceptions).toEqual([]);
  expect(result.cleanup.errors).toEqual([]);
  expect(result.validation.ok).toBe(true);
  expect(result.validation.complete).toBe(true);
  expect(result.validation.expectedCount).toBe(inject("reviewPhase") === "before" ? 40 : 109);
  expect(result.results).toHaveLength(result.validation.expectedCount);
  expect(result.harnessErrors).toEqual([]);
  expect(result.unexpectedConsoleErrors).toEqual([]);
  expect(result.cleanup.browser.processExitConfirmed).toBe(true);
  expect(result.cleanup.browser.temporaryResourcesRemoved).toBe(true);
  expect(result.checks).toHaveLength(inject("reviewPhase") === "before" ? 10 : 25);
  expect(result.results.some((r: { id: string }) => r.id.endsWith("-harness"))).toBe(false);
  if (inject("reviewPhase") === "before") expect(result.failing).toBeGreaterThan(0);
  else expect(result.failing).toBe(0);
});