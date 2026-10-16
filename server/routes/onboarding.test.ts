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
async function snapshot(exclude: string[] = []) {
  const state: Record<string, unknown> = {};
  for (const table of ["users", "sessions", "session_edits", "user_settings", "deviations", "http_sessions", "organizations", "organization_members",
    "domains", "policy_versions", "dimension_definitions", "source_bindings", "observations", "audit_events", "deviations_v2", "deviation_domains", "evaluation_results"])
    if (!exclude.includes(table)) state[table] = (await fixture.client.query(`SELECT to_jsonb(t) r FROM public.${table} t ORDER BY to_jsonb(t)::text`)).rows;
  return JSON.stringify(state);
}
beforeAll(async () => {
  fixture = await startFixture("personal-workspaces-router");
  await fixture.client.query(`INSERT INTO users(id) VALUES('setup-route-a'),('setup-route-b'),('settings-route-a'),('settings-route-b'),
    ('settings-route-missing'),('settings-route-none'),('settings-route-ambiguous');
    INSERT INTO organizations(org_id,display_name,rollout_mode) VALUES ('settings-route-org','Synthetic settings','legacy'),
      ('settings-route-other','Synthetic other','shadow');
    INSERT INTO organization_members(org_id,user_id,role) VALUES ('settings-route-org','settings-route-a','owner'),
      ('settings-route-org','settings-route-b','member'),('settings-route-org','settings-route-missing','member'),
      ('settings-route-org','settings-route-ambiguous','owner'),('settings-route-other','settings-route-ambiguous','member');
    INSERT INTO user_settings(user_id,day_start_hour,timezone,window_days,notifications_enabled,notification_tier,updated_at) VALUES
      ('settings-route-a',4,'America/New_York',21,true,'PAGE','2000-01-01T00:00:00Z'),
      ('settings-route-b',6,'Asia/Tokyo',30,false,'ADVISORY','2000-01-01T00:00:00Z');
    INSERT INTO sessions(id,user_id,domain,duration_minutes,timestamp) VALUES
      ('settings-route-history','settings-route-a','music',15,'2026-01-01T00:00:00Z');
    INSERT INTO sessions(id,user_id,domain,duration_minutes,timestamp)
      SELECT 'settings-route-unowned-'||g,NULL,'meditation',10,'2026-01-01T00:00:00Z' FROM generate_series(1,73) g`);
  verifyFixture(fixture.root);
  pool = new Pool({ host: fixture.root + "/socket", port: 5432, user: "synthetic", database: "postgres", password: "", ssl: false,
    max: 3, connectionTimeoutMillis: 5000, options: "-c statement_timeout=10000 -c lock_timeout=5000" });
  const actual = createPersonalWorkspaceService(createAuthenticatedBootstrapUnit({ connect: () => { connects++; return pool.connect(); } }));
  const forwarded = (request: any) => { expect(authenticatedRequests.has(request)).toBe(true); forwardedRequests.push(request); };
  const service: typeof actual = {
    status: request => { forwarded(request); return actual.status(request); },
    ensure: (request, input) => { forwarded(request); return actual.ensure(request, input); },
    readSettings: request => { forwarded(request); return actual.readSettings(request); },
    updateSettings: (request, input) => { forwarded(request); return actual.updateSettings(request, input); },
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
    expect((await call("/settings", actor)).status).toBe(401);
    expect((await call("/workspace", actor, "POST", { orgId: "forged" })).status).toBe(401);
    expect((await call("/settings", actor, "PATCH", { dayStartHour: 3, userId: "setup-route-b" })).status).toBe(401);
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
  for (const path of ["/status", "/settings"]) {
    const read = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const payload = "{}", req = httpRequest(base + path, { method: "GET", headers: { "x-synthetic-fixture-actor": "setup-route-a",
        "content-type": "application/json", "content-length": Buffer.byteLength(payload) } }, response => {
        const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(Buffer.from(chunk)));
        response.on("end", () => resolve({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }));
      }); req.on("error", reject); req.end(payload);
    });
    expect(read).toEqual({ status: 400, body: { message: "Invalid request" } });
  }
  // Standalone router parser to check its own bounded error path, rather than
  // Express's unrelated outer default HTML error serialization.
  const app = express();
  app.use(createOnboardingRouter({ service: createPersonalWorkspaceService(createAuthenticatedBootstrapUnit({ connect: async () => { throw Error("must not connect"); } } as any)),
    authenticate: (request: any, _response, next) => { request.user = { claims: { sub: "setup-route-a" } }; request.isAuthenticated = () => true; next(); } }));
  const standalone = createServer(app); await new Promise<void>(resolve => standalone.listen(0, "127.0.0.1", resolve));
  const address = standalone.address(); if (!address || typeof address === "string") throw Error("Synthetic parser fixture failed");
  try {
    for (const [path, method] of [["/workspace", "POST"], ["/settings", "PATCH"]] as const)
      for (const [body, status] of [["{ invalid JSON", 400], [JSON.stringify({ value: "x".repeat(2000) }), 413]] as const) {
        const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method, headers: { "content-type": "application/json" }, body });
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

it("personal settings validation rejects forged authority and malformed partial values before any connection", async () => {
  const before = connects, state = await snapshot();
  for (const body of [undefined, null, [], {}, { dayStartHour: "4" }, { dayStartHour: -1 }, { dayStartHour: 24 },
    { dayStartHour: 2.5 }, { timezone: "private-invalid-zone" }, { timezone: "x".repeat(65) }, { windowDays: 21 }, { windowDays: 30 },
    { dayStartHour: 4, userId: "settings-route-b" }, { dayStartHour: 4, organizationId: "settings-route-other" },
    { timezone: "UTC", role: "owner" }, { timezone: "UTC", rolloutMode: "v2" },
    { timezone: "UTC", notificationsEnabled: false }, { timezone: "UTC", notificationTier: "WARNING" }]) {
    const result = await call("/settings", "settings-route-a", "PATCH", body);
    expect(result.status).toBe(400); expect(result.body).toEqual({ message: body === null ? "Invalid request body" : "Invalid request" });
  }
  expect((await call("/settings?userId=settings-route-b", "settings-route-a", "PATCH", { dayStartHour: 3 })).status).toBe(400);
  expect((await call("/settings?userId=settings-route-b", "settings-route-a")).status).toBe(400);
  expect((await call("/settings?orgId=settings-route-other", "settings-route-a")).status).toBe(400);
  expect(connects).toBe(before); expect(await snapshot()).toBe(state);
});
it("real HTTP personal boundary reads preserve21/30, exact owned DTO and every row without normalization or audit", async () => {
  const state = await snapshot(), forwarded = forwardedRequests.length;
  expect(await call("/settings", "settings-route-a")).toEqual({ status: 200,
    body: { userId: "settings-route-a", dayStartHour: 4, timezone: "America/New_York", windowDays: 21 }, cache: "no-store" });
  expect(await call("/settings", "settings-route-b")).toEqual({ status: 200,
    body: { userId: "settings-route-b", dayStartHour: 6, timezone: "Asia/Tokyo", windowDays: 30 }, cache: "no-store" });
  expect(await snapshot()).toBe(state); expect(forwardedRequests.length).toBe(forwarded + 2);
  expect(forwardedRequests.every(request => authenticatedRequests.has(request))).toBe(true);
});
it("real HTTP hour and timezone patches preserve omitted21/30-day windows, preferences, same-org peers and historical rows", async () => {
  const otherState = await snapshot(["user_settings", "audit_events"]);
  const peerBefore = (await fixture.client.query("SELECT to_jsonb(t) r FROM user_settings t WHERE user_id='settings-route-b'")).rows;
  const hour = await call("/settings", "settings-route-a", "PATCH", { dayStartHour: 5 });
  expect(hour).toEqual({ status: 200, body: { userId: "settings-route-a", dayStartHour: 5, timezone: "America/New_York", windowDays: 21 }, cache: "no-store" });
  const a = (await fixture.client.query("SELECT * FROM user_settings WHERE user_id='settings-route-a'")).rows[0];
  expect(a).toMatchObject({ day_start_hour: 5, timezone: "America/New_York", window_days: 21, notifications_enabled: true, notification_tier: "PAGE" });
  expect(a.updated_at.toISOString()).not.toBe("2000-01-01T00:00:00.000Z");
  expect((await fixture.client.query("SELECT to_jsonb(t) r FROM user_settings t WHERE user_id='settings-route-b'")).rows).toEqual(peerBefore);
  const aBeforePeer = (await fixture.client.query("SELECT to_jsonb(t) r FROM user_settings t WHERE user_id='settings-route-a'")).rows;
  const zone = await call("/settings", "settings-route-b", "PATCH", { timezone: "Europe/Paris" });
  expect(zone).toEqual({ status: 200, body: { userId: "settings-route-b", dayStartHour: 6, timezone: "Europe/Paris", windowDays: 30 }, cache: "no-store" });
  expect((await fixture.client.query("SELECT * FROM user_settings WHERE user_id='settings-route-b'")).rows[0])
    .toMatchObject({ day_start_hour: 6, timezone: "Europe/Paris", window_days: 30, notifications_enabled: false, notification_tier: "ADVISORY" });
  expect((await fixture.client.query("SELECT to_jsonb(t) r FROM user_settings t WHERE user_id='settings-route-a'")).rows).toEqual(aBeforePeer);
  expect(await snapshot(["user_settings", "audit_events"])).toBe(otherState);
  const audits = (await fixture.client.query(`SELECT actor_user_id,org_id,entity_type,action,"before","after" FROM audit_events
    WHERE actor_user_id IN ('settings-route-a','settings-route-b') ORDER BY actor_user_id`)).rows;
  expect(audits).toHaveLength(2);
  expect(audits[0]).toMatchObject({ actor_user_id: "settings-route-a", org_id: "settings-route-org", entity_type: "user_settings", action: "update",
    before: { day_start_hour: 4, window_days: 21, notifications_enabled: true, notification_tier: "PAGE" },
    after: { day_start_hour: 5, window_days: 21, notifications_enabled: true, notification_tier: "PAGE" } });
  expect(audits[1]).toMatchObject({ actor_user_id: "settings-route-b", org_id: "settings-route-org", entity_type: "user_settings", action: "update",
    before: { timezone: "Asia/Tokyo", window_days: 30, notifications_enabled: false, notification_tier: "ADVISORY" },
    after: { timezone: "Europe/Paris", window_days: 30, notifications_enabled: false, notification_tier: "ADVISORY" } });
  expect((await call("/status", "settings-route-a")).body.settings).toEqual(hour.body);
  expect((await call("/status", "settings-route-b")).body.settings).toEqual(zone.body);
  expect(forwardedRequests.every(request => authenticatedRequests.has(request))).toBe(true);
});
it("equal personal values are a strict HTTP no-op including updatedAt, preferences and audit inventory", async () => {
  const state = await snapshot(), forwarded = forwardedRequests.length;
  const result = await call("/settings", "settings-route-a", "PATCH", { dayStartHour: 5, timezone: "America/New_York" });
  expect(result).toEqual({ status: 200, body: { userId: "settings-route-a", dayStartHour: 5, timezone: "America/New_York", windowDays: 21 }, cache: "no-store" });
  expect(await snapshot()).toBe(state); expect(forwardedRequests.length).toBe(forwarded + 1);
});
it("missing settings, no membership and ambiguous membership fail closed without default repair", async () => {
  const state = await snapshot();
  for (const [actor, status] of [["settings-route-missing", 503], ["settings-route-none", 403], ["settings-route-ambiguous", 403]] as const) {
    const result = await call("/settings", actor, "PATCH", { dayStartHour: 3 });
    expect(result.status).toBe(status); expect(result.body).toEqual({ message: status === 503 ? "Service unavailable" : "Access denied" });
    expect(result.cache).toBe("no-store"); expect(await snapshot()).toBe(state);
    expect(await call("/settings", actor)).toEqual({ status, body: { message: status === 503 ? "Service unavailable" : "Access denied" }, cache: "no-store" });
    expect(await snapshot()).toBe(state);
  }
});
it("a failed settings audit rolls back the real HTTP update and every historical or preference field", async () => {
  await fixture.client.query(`CREATE FUNCTION public.fail_personal_settings_http() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'private synthetic audit failure'; END $$;
    CREATE TRIGGER fail_personal_settings_http AFTER INSERT ON public.audit_events FOR EACH ROW
    WHEN (NEW.entity_type='user_settings' AND NEW.actor_user_id='settings-route-a') EXECUTE FUNCTION public.fail_personal_settings_http()`);
  try {
    const state = await snapshot();
    const result = await call("/settings", "settings-route-a", "PATCH", { dayStartHour: 3, timezone: "Europe/London", windowDays: 14 });
    expect(result).toEqual({ status: 503, body: { message: "Service unavailable" }, cache: "no-store" });
    expect(await snapshot()).toBe(state);
  } finally { await fixture.client.query("DROP TRIGGER fail_personal_settings_http ON public.audit_events; DROP FUNCTION public.fail_personal_settings_http()"); }
});
it("explicit allowed personal windows save without rewriting omitted settings or a same-organization peer", async () => {
  const peer = (await fixture.client.query("SELECT to_jsonb(t) r FROM user_settings t WHERE user_id='settings-route-a'")).rows;
  const otherState = await snapshot(["user_settings", "audit_events"]);
  for (const windowDays of [7, 14, 28, 42]) {
    const result = await call("/settings", "settings-route-b", "PATCH", { windowDays });
    expect(result).toEqual({ status: 200, body: { userId: "settings-route-b", dayStartHour: 6, timezone: "Europe/Paris", windowDays }, cache: "no-store" });
    expect((await fixture.client.query("SELECT * FROM user_settings WHERE user_id='settings-route-b'")).rows[0])
      .toMatchObject({ day_start_hour: 6, timezone: "Europe/Paris", window_days: windowDays, notifications_enabled: false, notification_tier: "ADVISORY" });
    expect((await fixture.client.query("SELECT to_jsonb(t) r FROM user_settings t WHERE user_id='settings-route-a'")).rows).toEqual(peer);
    expect(await snapshot(["user_settings", "audit_events"])).toBe(otherState);
  }
  expect((await fixture.client.query("SELECT count(*)::int n FROM audit_events WHERE actor_user_id='settings-route-b' AND entity_type='user_settings'")).rows[0].n).toBe(5);
});
