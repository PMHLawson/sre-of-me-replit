import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type NextFunction, type Request, type Response } from "express";
import { createServer } from "node:http";

const fake = vi.hoisted(() => ({
  owner: "invented-explanation-owner-ALPHA" as string | null,
  storage: {
    updateSession: vi.fn(), createDeviation: vi.fn(), updateDeviation: vi.fn(),
    endDeviation: vi.fn(), softDeleteDeviation: vi.fn(),
  },
}));
vi.mock("./db", () => { throw new Error("FORBIDDEN: real database import"); });
vi.mock("./storage", () => ({ storage: fake.storage }));
vi.mock("./replit_integrations/auth/storage", () => ({ authStorage: {} }));
vi.mock("./replit_integrations/auth", () => ({
  isAuthenticated: (req: Request, res: Response, next: NextFunction) => {
    if (!fake.owner) return res.status(401).json({ message: "invented unauthenticated" });
    (req as Request & { user: unknown }).user = { claims: { sub: fake.owner } };
    next();
  },
}));
import { registerRoutes } from "./routes";

// Kept local rather than importing a .test file (which would register its tests twice).
const inputs = [
  { id: "omitted", present: false, value: undefined },
  { id: "undefined", present: true, value: undefined },
  { id: "null", present: true, value: null },
  { id: "empty", present: true, value: "" },
  { id: "one-space", present: true, value: " " },
  { id: "several-spaces", present: true, value: "    " },
  { id: "tabs-newlines", present: true, value: "\t\n\r" },
  { id: "nbsp", present: true, value: "\u00a0" },
  { id: "em-space", present: true, value: "\u2003" },
  { id: "meaningful", present: true, value: "Invented reason" },
  { id: "padded", present: true, value: " \tInvented reason\n " },
  { id: "500", present: true, value: "x".repeat(500) },
  { id: "501", present: true, value: "x".repeat(501) },
] as const;
const owners = ["invented-explanation-owner-ALPHA", "invented-explanation-owner-BETA"];
const id = "opaque:/invented explanation?#%";
const at = "2026-10-03T12:00:00Z";
const cases = [
  { name: "session-edit", method: "PATCH", path: `/api/sessions/${encodeURIComponent(id)}`,
    storage: "updateSession", base: { notes: "Invented replacement note" }, optional: false, status: 200 },
  { name: "deviation-create", method: "POST", path: "/api/deviations",
    storage: "createDeviation", base: { domain: "music", startAt: at }, optional: false, status: 201 },
  { name: "deviation-update", method: "PATCH", path: `/api/deviations/${encodeURIComponent(id)}`,
    storage: "updateDeviation", base: { excludeFromComposite: false }, optional: true, status: 200 },
] as const;
const app = express();
app.use(express.json());
// JSON cannot encode explicit undefined. This test-only boundary injects it after
// decoding, so the REAL registered validator receives an own undefined property.
// Ordinary omission is tested separately over the wire without this header.
app.use((req, _res, next) => {
  if (req.headers["x-invented-explicit-undefined"] === "yes") req.body.reason = undefined;
  next();
});
const listener = createServer(app);
let origin: string;
beforeAll(async () => {
  await registerRoutes(listener, app); // No index/setupAuth/startup lifecycle.
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => { listener.removeListener("error", reject); resolve(); });
  });
  const address = listener.address();
  if (!address || typeof address === "string" || address.address !== "127.0.0.1") throw Error("Not an owned loopback listener");
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  listener.closeAllConnections();
  if (listener.listening) await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  expect(listener.listening).toBe(false);
  expect(listener.address()).toBeNull();
});
beforeEach(() => { vi.resetAllMocks(); fake.owner = owners[0]; });

function row(kind: string, owner: string, reason: unknown) {
  return kind === "session-edit"
    ? { id, userId: owner, domain: "music", durationMinutes: 47, timestamp: new Date(at),
      notes: "Invented replacement note", isAnomaly: false, anomalyNote: null, deletedAt: null }
    : { id, userId: owner, domain: "music", reason: reason ?? "Invented original reason",
      startAt: new Date(at), endAt: null, endedAt: null, deletedAt: null, excludeFromComposite: false };
}
const noStorage = () => Object.values(fake.storage).forEach(method => expect(method).not.toHaveBeenCalled());

describe("real explanation request handlers with invented auth/storage boundaries", () => {
  for (const owner of owners) for (const c of cases) {
    it.each(inputs)(`${owner}/${c.name}/$id`, async input => {
      fake.owner = owner;
      const expectedPatch = { ...c.base, ...(input.present ? { reason: input.value } : {}) };
      const value = row(c.name, owner, input.value);
      fake.storage[c.storage].mockResolvedValue(value);
      const response = await fetch(origin + c.path + "?userId=forged-query-owner", {
        method: c.method, headers: { "Content-Type": "application/json",
          ...(input.id === "undefined" ? { "x-invented-explicit-undefined": "yes" } : {}) },
        body: JSON.stringify({ ...expectedPatch, userId: "forged-body-owner", id: "forged-body-id" }),
      });
      const valid = input.id === "omitted" || input.id === "undefined"
        ? c.optional : ["meaningful", "padded", "500"].includes(input.id);
      const body = await response.json();
      expect(response.status).toBe(valid ? c.status : 400);
      if (!valid) {
        expect(body.errors.fieldErrors.reason.length).toBeGreaterThan(0);
        noStorage();
      } else {
        expect(body).toEqual(JSON.parse(JSON.stringify(value)));
        if (c.name === "deviation-create")
          expect(fake.storage.createDeviation).toHaveBeenCalledExactlyOnceWith({ ...expectedPatch, userId: owner });
        else
          expect(fake.storage[c.storage]).toHaveBeenCalledExactlyOnceWith(owner, id, expectedPatch);
        for (const [name, method] of Object.entries(fake.storage)) if (name !== c.storage) expect(method).not.toHaveBeenCalled();
      }
    });
  }
  it.each(cases)("$name mocked unauthenticated rejection precedes all storage", async c => {
    fake.owner = null;
    const response = await fetch(origin + c.path, { method: c.method,
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...c.base, reason: "Invented valid reason" }) });
    expect(response.status).toBe(401); noStorage();
  });
  for (const owner of owners) for (const action of ["end", "delete"] as const) {
    it(`${owner}/${action} has no new action-reason requirement`, async () => {
      fake.owner = owner;
      const method = action === "end" ? "endDeviation" : "softDeleteDeviation";
      const value = row("deviation-update", owner, "Invented retained reason");
      fake.storage[method].mockResolvedValue(value);
      const response = await fetch(origin + `/api/deviations/${encodeURIComponent(id)}` + (action === "end" ? "/end" : ""),
        { method: action === "end" ? "POST" : "DELETE" });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(JSON.parse(JSON.stringify(value)));
      expect(fake.storage[method]).toHaveBeenCalledExactlyOnceWith(owner, id);
    });
  }
});