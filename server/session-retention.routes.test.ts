import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Request, type Response, type NextFunction } from "express";
import { createServer } from "node:http";
import type { Session } from "@shared/schema";

// All application boundaries are replaced BEFORE importing registered handlers.
const fake = vi.hoisted(() => ({
  owner: "synthetic-retention-owner-ALPHA" as string | null,
  storage: {
    getSessions: vi.fn(), getDeletedSessions: vi.fn(),
    softDeleteSession: vi.fn(), restoreSession: vi.fn(),
    purgeExpiredDeletedSessions: vi.fn(),
  },
}));
vi.mock("./db", () => { throw new Error("FORBIDDEN: real database module import"); });
vi.mock("./storage", () => ({ storage: fake.storage }));
vi.mock("./replit_integrations/auth/storage", () => ({ authStorage: {} }));
vi.mock("./replit_integrations/auth", () => ({
  isAuthenticated: (req: Request, res: Response, next: NextFunction) => {
    if (!fake.owner) return res.status(401).json({ message: "synthetic unauthenticated" });
    (req as Request & { user: unknown }).user = { claims: { sub: fake.owner } };
    next();
  },
}));
import { registerRoutes } from "./routes";

const OWNERS = ["synthetic-retention-owner-ALPHA", "synthetic-retention-owner-BETA"];
const ID = "opaque:/synthetic retention?#%";
const NOW = new Date("2026-10-03T12:00:00Z");
const app = express(); app.use(express.json());
const listener = createServer(app);
let base: string;
function row(owner: string, deletedAt: Date | null, id = ID): Session {
  return {
    id, userId: owner, domain: "music", timestamp: new Date("2020-01-11T09:17:00Z"),
    durationMinutes: 47, notes: "invented original note", deletedAt,
    isAnomaly: true, anomalyNote: "invented original anomaly explanation",
  };
}
function serialized(r: Session) {
  return { ...r, timestamp: r.timestamp.toISOString(), deletedAt: r.deletedAt?.toISOString() ?? null };
}
const cases = [
  { name: "active", method: "GET", path: "/api/sessions", storage: "getSessions",
    error: "Failed to fetch sessions" },
  { name: "deleted", method: "GET", path: "/api/sessions/deleted", storage: "getDeletedSessions",
    error: "Failed to fetch deleted sessions" },
  { name: "delete", method: "DELETE", path: `/api/sessions/${encodeURIComponent(ID)}`,
    storage: "softDeleteSession", error: "Failed to delete session", missing: "Session not found" },
  { name: "restore", method: "POST", path: `/api/sessions/${encodeURIComponent(ID)}/restore`,
    storage: "restoreSession", error: "Failed to restore session", missing: "Deleted session not found" },
] as const;
async function request(c: typeof cases[number]) {
  const response = await fetch(`${base}${c.path}?userId=forged-query-owner&owner=forged-query-owner`, {
    method: c.method, headers: { "Content-Type": "application/json" },
    ...(c.method === "GET" ? {} : {
      body: JSON.stringify({ userId: "forged-body-owner", owner: "forged-body-owner", id: "forged-body-id" }),
    }),
  });
  return { status: response.status, body: await response.json() };
}
beforeAll(async () => {
  // No server/index import, setupAuth, startup purge, real session or app lifecycle.
  await registerRoutes(listener, app);
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => { listener.removeListener("error", reject); resolve(); });
  });
  const address = listener.address();
  if (!address || typeof address === "string" || address.address !== "127.0.0.1") {
    throw new Error("Missing exclusively owned loopback listener");
  }
  base = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  listener.closeAllConnections();
  if (listener.listening) {
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  }
  expect(listener.listening).toBe(false);
  expect(listener.address()).toBeNull();
});
beforeEach(() => {
  vi.resetAllMocks(); fake.owner = OWNERS[0];
});
afterEach(() => vi.useRealTimers());

describe("actual registered retention handlers with synthetic auth/storage only", () => {
  for (const owner of OWNERS) {
    it.each(cases)(`${owner}: $name derives owner from the authenticated claim, never query/body`, async c => {
      fake.owner = owner;
      const deleted = row(owner, NOW);
      const active = row(owner, null);
      const rows = [deleted, row(owner, new Date("2020-01-01T00:00:00Z"), "opaque old unpurged")];
      const value = c.name === "deleted" ? rows : c.name === "active" ? [active] :
        c.name === "delete" ? deleted : active;
      fake.storage[c.storage].mockResolvedValue(value);
      expect(await request(c)).toEqual({
        status: 200, body: Array.isArray(value) ? value.map(serialized) : serialized(value),
      });
      // Independently verify actual handler arguments, not only programmed output.
      expect(fake.storage[c.storage]).toHaveBeenCalledExactlyOnceWith(
        owner, ...(c.method === "GET" ? [] : [ID]),
      );
      for (const [name, method] of Object.entries(fake.storage)) {
        if (name !== c.storage) expect(method).not.toHaveBeenCalled();
      }
    });
  }
  it.each(cases.filter(c => c.method !== "GET"))("$name retains its action-specific404", async c => {
    fake.storage[c.storage].mockResolvedValue(undefined);
    expect(await request(c)).toEqual({ status: 404, body: { message: "missing" in c ? c.missing : "" } });
    expect(fake.storage[c.storage]).toHaveBeenCalledExactlyOnceWith(OWNERS[0], ID);
  });
  it.each(cases)("$name returns generic500 without synthetic secret details", async c => {
    const secret = "SYNTHETIC_RETENTION_SECRET_SENTINEL";
    fake.storage[c.storage].mockRejectedValue(new Error(secret));
    const response = await request(c);
    expect(response).toEqual({ status: 500, body: { message: c.error } });
    expect(JSON.stringify(response)).not.toContain(secret);
  });
  it.each(cases)("$name rejects mocked unauthenticated requests before all storage", async c => {
    fake.owner = null;
    expect(await request(c)).toEqual({ status: 401, body: { message: "synthetic unauthenticated" } });
    for (const method of Object.values(fake.storage)) expect(method).not.toHaveBeenCalled();
  });
  it.each(cases.filter(c => c.method === "GET"))("$name serializes an empty collection", async c => {
    fake.storage[c.storage].mockResolvedValue([]);
    expect(await request(c)).toEqual({ status: 200, body: [] });
  });
  it("has no registered public maintenance purge handler", () => {
    // Inspect the actual Express registrations, not source-string assertions.
    const router = (app as typeof app & { router: { stack: Array<{ route?: { path: string } }> } }).router;
    const paths = router.stack.filter(layer => layer.route).map(layer => layer.route!.path);
    expect(paths).toContain("/api/sessions/deleted");
    expect(paths.some(path => /purge|retention/i.test(path))).toBe(false);
    expect(fake.storage.purgeExpiredDeletedSessions).not.toHaveBeenCalled();
  });
});