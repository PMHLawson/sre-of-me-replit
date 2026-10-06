import { beforeAll, afterAll, it, expect, vi } from "vitest";
import express from "express";
import { createServer, request as httpRequest, type Server } from "node:http";
import { Pool } from "pg";
import { startFixture, verifyFixture } from "../lib/ownership-fixture";
import { createAuthenticatedBootstrapUnit } from "../lib/authenticated-bootstrap-unit";
import { createPersonalWorkspaceService } from "../services/personal-workspace-service";
import { createOnboardingRouter } from "./onboarding";

const mountStats = vi.hoisted(() => ({ dbImports: 0, dbConnects: 0 }));
vi.mock("../storage", () => ({ storage: {} }));
vi.mock("../replit_integrations/auth/storage", () => ({ authStorage: {} }));
vi.mock("../replit_integrations/auth", () => ({ isAuthenticated: (request: any, response: any, next: any) => {
  const actor = request.get("x-synthetic-fixture-actor");
  if (!actor) { response.status(401).json({ message: "Authentication required" }); return; }
  request.user = { claims: { sub: actor } };
  request.isAuthenticated = () => request.get("x-synthetic-auth-false") !== "yes";
  next();
} }));
vi.mock("../db", () => {
  mountStats.dbImports++;
  return { pool: { connect: async () => { mountStats.dbConnects++; throw Error("private synthetic connection detail"); } } };
});
import { registerRoutes } from "../routes";

let fixture: Awaited<ReturnType<typeof startFixture>>, pool: Pool, server: Server, base: string, connects = 0;
const authenticatedRequests = new WeakSet<object>(), forwardedRequests: object[] = [];
async function call(path: string, actor?: string, method = "GET", body?: unknown) {
  const response = await fetch(base + path, { method, headers: { ...(actor ? { "x-synthetic-fixture-actor": actor } : {}),
    ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json(), cache: response.headers.get("cache-control") };
}
async function snapshot() {
  const state: Record<string, unknown> = {};
  for (const table of ["users", "user_settings", "organizations", "organization_members", "domains", "policy_versions", "source_bindings", "audit_events", "sessions"])
    state[table] = (await fixture.client.query(`SELECT to_jsonb(t) r FROM public.${table} t ORDER BY to_jsonb(t)::text`)).rows;
  return JSON.stringify(state);
}
beforeAll(async () => {
  fixture = await startFixture("personal-workspaces-router");
  await fixture.client.query("INSERT INTO users(id) VALUES('setup-route-a'),('setup-route-b')");
  verifyFixture(fixture.root);
  pool = new Pool({ host: fixture.root + "/socket", port: 5432, user: "synthetic", database: "postgres", password: "", ssl: false,
    max: 3, connectionTimeoutMillis: 5000, options: "-c statement_timeout=10000 -c lock_timeout=5000" });
  const actual = createPersonalWorkspaceService(createAuthenticatedBootstrapUnit({ connect: () => { connects++; return pool.connect(); } }));
  const forwarded = (request: any) => { expect(authenticatedRequests.has(request)).toBe(true); forwardedRequests.push(request); };
  const service: typeof actual = {
    status: request => { forwarded(request); return actual.status(request); },
    ensure: (request, input) => { forwarded(request); return actual.ensure(request, input); },
  };
  const app = express();
  // Mirrors the existing global parser before the actual mount. An ordinary
  // no-body GET must still reach status rather than become unexpected_body.
  app.use(express.json({ limit: "100kb" }));
  app.use("/api/onboarding", createOnboardingRouter({ service, authenticate: (request: any, response, next) => {
    const actor = request.get("x-synthetic-fixture-actor");
    if (!actor) { response.status(401).json({ message: "Authentication required" }); return; }
    request.user = { claims: { sub: actor } }; request.isAuthenticated = () => true;
    authenticatedRequests.add(request); next();
  } }));
  // The outer parser owns errors raised before the router. Keep fixture errors
  // bounded too; no-body successful GET remains the actual router behavior.
  app.use((error: any, _request: any, response: any, _next: any) => {
    response.status(error?.status === 413 ? 413 : 400).json({ message: "Invalid request body" });
  });
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw Error("Synthetic HTTP fixture failed");
  base = `http://127.0.0.1:${address.port}/api/onboarding`;
}, 60000);
afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (pool) await pool.end(); if (fixture) await fixture.cleanup();
}, 60000);

it("ordinary authenticated no-body GET works with the existing global Express JSON parser and performs no writes", async () => {
  const before = await snapshot(), result = await call("/status", "setup-route-a");
  expect(result).toEqual({ status: 200, body: { schemaVersion: 1, ownerUserId: "setup-route-a", status: "needs_workspace" }, cache: "no-store" });
  expect(await snapshot()).toBe(before);
});
it("authentication and malformed Passport subjects precede every database operation", async () => {
  const before = connects, state = await snapshot();
  for (const actor of [undefined, "__proto__", " ", "x".repeat(201)]) {
    expect((await call("/status", actor)).status).toBe(401);
    expect((await call("/workspace", actor, "POST", { orgId: "forged" })).status).toBe(401);
  }
  expect(connects).toBe(before); expect(await snapshot()).toBe(state);
});
it("strict empty JSON POST and query rejection refuse caller authority without acquiring a connection", async () => {
  const before = connects, state = await snapshot();
  for (const body of [undefined, null, [], { ownerUserId: "setup-route-b" }, { organizationId: "chosen" }, { role: "owner" },
    { rolloutMode: "v2" }, { email: "other@example.invalid" }, { template: "Philip" }])
    expect((await call("/workspace", "setup-route-a", "POST", body)).status).toBe(400);
  expect((await call("/status?userId=setup-route-b", "setup-route-a")).status).toBe(400);
  expect((await call("/workspace?orgId=chosen", "setup-route-a", "POST", {})).status).toBe(400);
  expect(connects).toBe(before); expect(await snapshot()).toBe(state);
});
it("a GET JSON body is refused and malformed POST JSON remains bounded", async () => {
  const before = connects;
  const read = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const payload = "{}", req = httpRequest(base + "/status", { method: "GET", headers: { "x-synthetic-fixture-actor": "setup-route-a",
      "content-type": "application/json", "content-length": Buffer.byteLength(payload) } }, response => {
      const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    }); req.on("error", reject); req.end(payload);
  });
  expect(read).toEqual({ status: 400, body: { message: "Invalid request" } });
  // Standalone router parser to check its own bounded error path, rather than
  // Express's unrelated outer default HTML error serialization.
  const app = express();
  app.use(createOnboardingRouter({ service: createPersonalWorkspaceService(createAuthenticatedBootstrapUnit({ connect: async () => { throw Error("must not connect"); } } as any)),
    authenticate: (request: any, _response, next) => { request.user = { claims: { sub: "setup-route-a" } }; request.isAuthenticated = () => true; next(); } }));
  const standalone = createServer(app); await new Promise<void>(resolve => standalone.listen(0, "127.0.0.1", resolve));
  const address = standalone.address(); if (!address || typeof address === "string") throw Error("Synthetic parser fixture failed");
  try {
    for (const [body, status] of [["{ invalid JSON", 400], [JSON.stringify({ value: "x".repeat(2000) }), 413]] as const) {
      const response = await fetch(`http://127.0.0.1:${address.port}/workspace`, { method: "POST", headers: { "content-type": "application/json" }, body });
      expect(response.status).toBe(status); expect(await response.json()).toEqual({ message: "Invalid request body" });
    }
  } finally { await new Promise<void>((resolve, reject) => standalone.close(error => error ? reject(error) : resolve())); }
  expect(connects).toBe(before);
});
it("real HTTP ensure forwards the original authenticated request and repeats without duplicate workspace or audits", async () => {
  const a = await call("/workspace", "setup-route-a", "POST", {}), b = await call("/workspace", "setup-route-b", "POST", {});
  expect(a.status).toBe(200); expect(b.status).toBe(200); expect(a.cache).toBe("no-store");
  expect(a.body.ownerUserId).toBe("setup-route-a"); expect(b.body.ownerUserId).toBe("setup-route-b");
  expect(a.body.workspace.organizationId).not.toBe(b.body.workspace.organizationId);
  expect(a.body.settings.userId).toBe("setup-route-a"); expect(b.body.settings.userId).toBe("setup-route-b");
  const before = await snapshot();
  expect((await call("/workspace", "setup-route-a", "POST", {})).body).toEqual(a.body);
  expect((await call("/status", "setup-route-b")).body).toEqual(b.body);
  expect(await snapshot()).toBe(before);
  expect((await fixture.client.query("SELECT count(*)::int n FROM audit_events")).rows[0].n).toBe(6);
  expect(forwardedRequests.length).toBeGreaterThan(0); expect(forwardedRequests.every(request => authenticatedRequests.has(request))).toBe(true);
});
it("actual registerRoutes mount uses existing authentication and keeps DB import/connect lazy", async () => {
  const app = express(), mounted = createServer(app);
  app.use(express.json({ limit: "100kb" }));
  const legacy: any = { create: vi.fn(), edit: vi.fn(), softDelete: vi.fn(), restore: vi.fn(), respondError: vi.fn() };
  await registerRoutes(mounted, app, legacy);
  expect(mountStats).toEqual({ dbImports: 0, dbConnects: 0 });
  await new Promise<void>(resolve => mounted.listen(0, "127.0.0.1", resolve));
  const address = mounted.address(); if (!address || typeof address === "string") throw Error("Synthetic mount fixture failed");
  const url = `http://127.0.0.1:${address.port}/api/onboarding`;
  try {
    for (const headers of [{}, { "x-synthetic-fixture-actor": "__proto__" },
      { "x-synthetic-fixture-actor": "setup-route-a", "x-synthetic-auth-false": "yes" }]) {
      const response = await fetch(url + "/status", { headers }); expect(response.status).toBe(401);
      expect(mountStats).toEqual({ dbImports: 0, dbConnects: 0 });
    }
    const valid = await fetch(url + "/status", { headers: { "x-synthetic-fixture-actor": "setup-route-a" } });
    expect(valid.status).toBe(503); expect(await valid.json()).toEqual({ message: "Service unavailable" });
    expect(mountStats).toEqual({ dbImports: 1, dbConnects: 1 });
  } finally { await new Promise<void>((resolve, reject) => mounted.close(error => error ? reject(error) : resolve())); }
});
