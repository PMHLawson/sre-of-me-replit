import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer } from "node:http";

const mocks = vi.hoisted(() => ({ updateSession: vi.fn(), getSessionsSince: vi.fn() }));
vi.mock("./storage", () => ({ storage: mocks }));
vi.mock("./replit_integrations/auth/storage", () => ({ authStorage: {} }));
// Synthetic principal only: this exercises the real route, not the auth provider.
vi.mock("./replit_integrations/auth", () => ({
  isAuthenticated: (req: any, _res: any, next: any) => {
    req.user = { claims: { sub: "fixture-authenticated-user" } };
    next();
  },
}));
import { registerRoutes } from "./routes";
import { detectAnomaly } from "./lib/anomaly";

const existing = {
  id: "fixture-session", userId: "fixture-authenticated-user", domain: "music",
  durationMinutes: 30, timestamp: new Date("2026-09-20T12:00:00Z"),
  notes: "synthetic original", deletedAt: null, isAnomaly: false, anomalyNote: null,
};
const app = express();
app.use(express.json());
const server = createServer(app);
let base: string;
beforeAll(async () => {
  await registerRoutes(server, app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test listener");
  base = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});
beforeEach(() => {
  mocks.updateSession.mockReset();
  mocks.getSessionsSince.mockReset();
  mocks.updateSession.mockImplementation(async (_user, _id, { reason: _reason, ...patch }) => ({
    ...existing, ...patch,
    timestamp: patch.timestamp ? new Date(patch.timestamp) : existing.timestamp,
  }));
});
async function patch(body: unknown) {
  const response = await fetch(`${base}/api/sessions/${existing.id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

describe("session-edit PATCH behavior", () => {
  it.each([undefined, null, "", "   ", "\n\t"])(
    "rejects flagged edits with blank note %s before storage mutation",
    async anomalyNote => {
      const response = await patch({
        reason: "synthetic edit", durationMinutes: 90, isAnomaly: true, anomalyNote,
      });
      expect(response).toEqual({
        status: 400, body: { message: "Anomaly note is required when isAnomaly is true" },
      });
      expect(mocks.updateSession).not.toHaveBeenCalled();
    },
  );

  it("passes all valid anomaly-edit fields and only the authenticated principal", async () => {
    const fields = {
      reason: "synthetic correction", domain: "fitness", durationMinutes: 90,
      timestamp: "2026-09-21T12:00:00Z", notes: "synthetic new notes",
      isAnomaly: true, anomalyNote: "intentional extended practice",
    };
    const response = await patch({ ...fields, userId: "forged-user", id: "forged-id", deletedAt: "forged" });
    expect(response.status).toBe(200);
    expect(mocks.updateSession).toHaveBeenCalledExactlyOnceWith(
      "fixture-authenticated-user", "fixture-session", fields,
    );
    const { reason: _reason, ...savedFields } = fields;
    expect(response.body).toEqual({
      ...existing, ...savedFields, timestamp: new Date(fields.timestamp).toISOString(),
    });
  });

  it("accepts an ordinary edit without fabricating anomaly fields or changing identity", async () => {
    const fields = { reason: "ordinary correction", durationMinutes: 35, notes: null };
    const response = await patch({ ...fields, userId: "forged-user" });
    expect(response.status).toBe(200);
    expect(mocks.updateSession).toHaveBeenCalledExactlyOnceWith(existing.userId, existing.id, fields);
    expect(response.body).toEqual({
      ...existing, durationMinutes: 35, notes: null, timestamp: existing.timestamp.toISOString(),
    });
  });

  it("forwards and returns explicit false/null metadata for an ordinary edit", async () => {
    const fields = {
      reason: "ordinary correction", durationMinutes: 35, notes: null,
      isAnomaly: false, anomalyNote: null,
    };
    const response = await patch({ ...fields, userId: "forged-user" });
    expect(response.status).toBe(200);
    expect(mocks.updateSession).toHaveBeenCalledExactlyOnceWith(existing.userId, existing.id, fields);
    expect(response.body).toEqual({
      ...existing, durationMinutes: 35, notes: null,
      isAnomaly: false, anomalyNote: null, timestamp: existing.timestamp.toISOString(),
    });
  });

  it.each([
    { durationMinutes: 30 }, { reason: "" }, { reason: "x".repeat(501) },
    { reason: "edit", durationMinutes: 0 }, { reason: "edit", durationMinutes: 1.5 },
    { reason: "edit", domain: "unsupported" }, { reason: "edit", timestamp: "not-a-date" },
    { reason: "edit", isAnomaly: "true" },
  ])("rejects invalid PATCH payload %# without mutation", async body => {
    const response = await patch(body);
    expect(response.status).toBe(400);
    expect(response.body.message).toBe("Invalid session patch");
    expect(mocks.updateSession).not.toHaveBeenCalled();
  });

  it("returns a generic not-found response when storage cannot find an owned active row", async () => {
    mocks.updateSession.mockResolvedValue(undefined);
    expect(await patch({ reason: "synthetic correction" })).toEqual({
      status: 404, body: { message: "Session not found" },
    });
  });

  it("does not leak storage exception details in error responses", async () => {
    mocks.updateSession.mockRejectedValue(new Error("fixture-secret internal-db-host SQL failure"));
    expect(await patch({ reason: "synthetic correction" })).toEqual({
      status: 500, body: { message: "Failed to update session" },
    });
  });
});

describe("mature anomaly-check HTTP serialization", () => {
  it("serializes an actual infinite mature-baseline score as finite sentinel 9999", async () => {
    const now = new Date("2026-10-03T12:00:00Z");
    const samples = Array.from({ length: 8 }, (_, i) => ({
      ...existing, id: `fixture-baseline-${i}`, timestamp: now,
    }));
    // Only Date is faked; real HTTP/fetch timers and the actual detector remain active.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    try {
      expect(detectAnomaly("music", 60, samples, { now }).zScore).toBe(Infinity);
      mocks.getSessionsSince.mockResolvedValue(samples);
      const response = await fetch(`${base}/api/sessions/anomaly-check`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: "music", durationMinutes: 60 }),
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({
        isAnomaly: true, coldStart: false, sampleCount: 8,
        mean: 30, stdDev: 0, zScore: 9999,
      });
      expect(Number.isFinite(body.zScore)).toBe(true);
      expect(mocks.getSessionsSince).toHaveBeenCalledExactlyOnceWith(
        existing.userId, new Date("2026-08-22T12:00:00Z"),
      );
      expect(mocks.updateSession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});