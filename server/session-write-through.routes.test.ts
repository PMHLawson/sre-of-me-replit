import { beforeAll, afterAll, beforeEach, it, expect, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { Pool } from "pg";
import { startFixture, verifyFixture } from "./lib/ownership-fixture";
import { seedPolicyV2 } from "./lib/seed-policy-v2";
import { importLegacyObservations } from "./services/legacy-observation-sync";
import { createLegacySessionAdapter, readLegacyWriteThroughConfig } from "./services/legacy-session-adapter";

const fake = vi.hoisted(() => ({ owner: "api-a" as string | null, legacy: {
  createSession: vi.fn(), updateSession: vi.fn(), softDeleteSession: vi.fn(), restoreSession: vi.fn(),
} }));
vi.mock("./db", () => { throw Error("FORBIDDEN: ambient database module"); });
vi.mock("./storage", () => ({ storage: fake.legacy }));
vi.mock("./replit_integrations/auth/storage", () => ({ authStorage: {} }));
vi.mock("./replit_integrations/auth", () => ({ isAuthenticated: (req: any, res: any, next: any) => {
  if (!fake.owner) return res.status(401).json({ message: "Authentication required" });
  req.user = { claims: { sub: fake.owner } }; req.isAuthenticated = () => true; next();
} }));
import { registerRoutes } from "./routes";

let f: Awaited<ReturnType<typeof startFixture>>, pool: Pool, enabledOrigin: string, disabledOrigin: string;
let poolRequests = 0;
const listeners: Server[] = [];
const request = (actor: string) => ({ isAuthenticated: () => true, user: { claims: { sub: actor } } });
const slugs = ["martial-arts", "meditation", "fitness", "music"];
const payload = { domain: "music", durationMinutes: 1, timestamp: "2026-01-01T01:02:03.123456Z" };
const tables = ["users", "sessions", "session_edits", "user_settings", "deviations", "http_sessions", "organizations", "organization_members",
  "domains", "policy_versions", "dimension_definitions", "source_bindings", "observations", "audit_events", "deviations_v2", "deviation_domains", "evaluation_results"];
async function raw(table: string, where: string, values: unknown[] = []) {
  return (await f.client.query(`SELECT to_jsonb(t) r FROM public.${table} t WHERE ${where} ORDER BY to_jsonb(t)::text`, values)).rows.map(x => x.r);
}
async function snapshot() {
  const state: Record<string, unknown> = {};
  for (const t of tables) state[t] = (await f.client.query(`SELECT to_jsonb(t) r FROM public.${t} t ORDER BY to_jsonb(t)::text`)).rows;
  return JSON.stringify(state);
}
function legacyRow(actor: string, id: string) {
  return { id, userId: actor, domain: "music", durationMinutes: 1, timestamp: new Date(payload.timestamp), notes: null,
    isAnomaly: false, anomalyNote: null, deletedAt: null };
}
async function listen(adapter: ReturnType<typeof createLegacySessionAdapter>) {
  const app = express(); app.use(express.json()); const server = createServer(app); listeners.push(server);
  await registerRoutes(server, app, adapter);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => {
    server.removeListener("error", reject); resolve();
  }); });
  const address = server.address();
  if (!address || typeof address === "string" || address.address !== "127.0.0.1") throw Error("Not an owned loopback listener");
  return `http://127.0.0.1:${address.port}`;
}
async function http(method: string, path: string, body?: unknown, origin = enabledOrigin) {
  const r = await fetch(origin + path, { method, headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: r.status, body: await r.json() };
}
const keyPath = (id: string) => "/api/sessions/" + encodeURIComponent(id);
function noLegacy() { for (const fn of Object.values(fake.legacy)) expect(fn).not.toHaveBeenCalled(); }
beforeAll(async () => {
  f = await startFixture("session-api-adapter");
  for (const actor of ["api-a", "api-b"]) {
    await f.client.query("INSERT INTO users(id) VALUES($1)", [actor]);
    await f.client.query("INSERT INTO user_settings(user_id,timezone,day_start_hour,window_days) VALUES($1,'America/New_York',6,14)", [actor]);
    for (const slug of slugs) await f.client.query("INSERT INTO sessions(id,user_id,domain,duration_minutes,timestamp,notes) VALUES($1,$2,$3,1,'2020-01-01T00:00:00.123456Z',NULL)", [`${actor}-${slug}`, actor, slug]);
    await seedPolicyV2(f.db, request(actor)); await importLegacyObservations(f.db, request(actor));
  }
  await f.client.query("INSERT INTO users(id) VALUES('api-unmigrated')");
  await f.client.query("INSERT INTO sessions(id,domain,duration_minutes,timestamp) VALUES('api-unowned','music',1,now())");
  verifyFixture(f.root);
  pool = new Pool({ host: f.root + "/socket", port: 5432, user: "synthetic", database: "postgres", password: "", ssl: false,
    max: 4, connectionTimeoutMillis: 5000, options: "-c statement_timeout=10000 -c lock_timeout=5000" });
  const config = readLegacyWriteThroughConfig({ SOMR_LEGACY_WRITE_THROUGH: "enabled", SOMR_LEGACY_WRITE_THROUGH_OWNER_IDS: '["api-a","api-unmigrated"]' });
  enabledOrigin = await listen(createLegacySessionAdapter({ config, getPool: async () => { poolRequests++; return pool; } }));
  disabledOrigin = await listen(createLegacySessionAdapter({ config: readLegacyWriteThroughConfig({}), getPool: async () => { throw Error("Disabled bridge requested pool"); } }));
}, 60000);
afterAll(async () => {
  try {
    for (const server of listeners) { server.closeAllConnections(); if (server.listening) await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
      expect(server.listening).toBe(false); expect(server.address()).toBeNull(); }
  } finally { try { if (pool) await pool.end(); } finally { if (f) await f.cleanup(); } }
}, 60000);
beforeEach(() => {
  fake.owner = "api-a"; vi.resetAllMocks();
  fake.legacy.createSession.mockImplementation(async input => legacyRow(input.userId, "legacy-created"));
  fake.legacy.updateSession.mockImplementation(async (actor, id) => legacyRow(actor, id));
  fake.legacy.softDeleteSession.mockImplementation(async (actor, id) => ({ ...legacyRow(actor, id), deletedAt: new Date("2026-01-02T00:00:00Z") }));
  fake.legacy.restoreSession.mockImplementation(async (actor, id) => legacyRow(actor, id));
});

it("requires an explicit flag and bounded exact owner list; disabled config does not interpret an owner list", () => {
  expect(readLegacyWriteThroughConfig({ SOMR_LEGACY_WRITE_THROUGH_OWNER_IDS: "invalid" })).toEqual({ enabled: false, owners: [] });
  for (const env of [{ SOMR_LEGACY_WRITE_THROUGH: "yes" }, { SOMR_LEGACY_WRITE_THROUGH: "enabled" },
    { SOMR_LEGACY_WRITE_THROUGH: "enabled", SOMR_LEGACY_WRITE_THROUGH_OWNER_IDS: '["api-a"]', SESSION_RETENTION_PURGE_ENABLED: "true" },
    ...['[]', '["*"]', '["api-a","api-a"]', '[" padded "]', '["__proto__"]', '{"actor":"api-a"}'].map(owners =>
      ({ SOMR_LEGACY_WRITE_THROUGH: "enabled", SOMR_LEGACY_WRITE_THROUGH_OWNER_IDS: owners }))])
    expect(() => readLegacyWriteThroughConfig(env)).toThrow("Service unavailable");
});
it("snapshots server configuration and rejects malformed authentication before pool lookup", async () => {
  const config = { enabled: true, owners: ["api-a"] }; let calls = 0;
  const adapter = createLegacySessionAdapter({ config, getPool: async () => { calls++; throw Error("synthetic private"); } });
  config.owners.push("api-b"); config.enabled = false;
  expect(await adapter.create(request("api-b"), payload)).toBeUndefined(); expect(calls).toBe(0);
  for (const req of [{}, { ...request("api-a"), isAuthenticated: () => false }, request("__proto__")])
    await expect(adapter.create(req, payload)).rejects.toMatchObject({ status: 401 });
  expect(calls).toBe(0);
  await expect(adapter.create(request("api-a"), payload)).rejects.toMatchObject({ status: 503 }); expect(calls).toBe(1);
});
it("keeps all four disabled routes on the existing storage path, with original authenticated ownership", async () => {
  const before = await snapshot(); const patch = { reason: " \tOriginal explanation\n ", notes: null };
  expect((await http("POST", "/api/sessions?enable=true&userId=api-b", { ...payload, userId: "api-b" }, disabledOrigin)).status).toBe(201);
  expect((await http("PATCH", keyPath("opaque:/api?#%"), { ...patch, userId: "api-b" }, disabledOrigin)).status).toBe(200);
  expect((await http("DELETE", keyPath("opaque:/api?#%"), { owner: "api-b" }, disabledOrigin)).status).toBe(200);
  expect((await http("POST", keyPath("opaque:/api?#%") + "/restore", { owner: "api-b" }, disabledOrigin)).status).toBe(200);
  expect(fake.legacy.createSession).toHaveBeenCalledExactlyOnceWith({ ...payload, userId: "api-a", isAnomaly: false, anomalyNote: null });
  expect(fake.legacy.updateSession).toHaveBeenCalledExactlyOnceWith("api-a", "opaque:/api?#%", patch);
  expect(fake.legacy.softDeleteSession).toHaveBeenCalledExactlyOnceWith("api-a", "opaque:/api?#%");
  expect(fake.legacy.restoreSession).toHaveBeenCalledExactlyOnceWith("api-a", "opaque:/api?#%");
  expect(await snapshot()).toBe(before); expect(poolRequests).toBe(0);
});
it("an excluded owner cannot enable adoption through body/query and retains the existing route path", async () => {
  fake.owner = "api-b"; const before = await snapshot();
  const r = await http("POST", "/api/sessions?owner=api-a&SOMR_LEGACY_WRITE_THROUGH=enabled", { ...payload, userId: "api-a", enabled: true });
  expect(r.status).toBe(201); expect(r.body.userId).toBe("api-b"); expect(fake.legacy.createSession.mock.calls[0][0].userId).toBe("api-b");
  expect(await snapshot()).toBe(before); expect(poolRequests).toBe(0);
});
it("creates actual synchronized rows through the registered route and emits only the established public response", async () => {
  const other = await raw("sessions", "user_id='api-b' OR user_id IS NULL");
  const r = await http("POST", "/api/sessions?owner=api-b", { ...payload, userId: "api-b", organizationId: "forged", notes: "" });
  expect(r.status).toBe(201); expect(r.body).toMatchObject({ userId: "api-a", domain: "music", durationMinutes: 1,
    timestamp: "2026-01-01T01:02:03.123Z", notes: "", isAnomaly: false, anomalyNote: null, deletedAt: null });
  expect(Object.keys(r.body).sort()).toEqual(["id", "userId", "domain", "durationMinutes", "timestamp", "notes", "isAnomaly", "anomalyNote", "deletedAt"].sort());
  expect((await raw("sessions", "id=$1", [r.body.id]))[0].timestamp).toContain(".123456");
  expect(await raw("observations", "legacy_source_id=$1", [r.body.id])).toHaveLength(1);
  expect(await raw("audit_events", "entity_type='legacy_session_mutation' AND entity_id=$1", [JSON.stringify([r.body.id])])).toHaveLength(1);
  expect(await raw("sessions", "user_id='api-b' OR user_id IS NULL")).toEqual(other); noLegacy(); expect(poolRequests).toBe(1);
});
it("preserves exact edit explanation and database microseconds while keeping the existing JSON contract", async () => {
  const imports = await raw("audit_events", "entity_type='legacy_session_import'");
  const reason = " \tOriginal explanation\n "; const key = "api-a-music";
  const r = await http("PATCH", keyPath(key), { reason, timestamp: "2026-01-02T03:04:05.654321Z", notes: null, durationMinutes: 2, userId: "api-b" });
  expect(r.status).toBe(200); expect(r.body.timestamp).toBe("2026-01-02T03:04:05.654Z"); expect(r.body.userId).toBe("api-a");
  const edits = await raw("session_edits", "session_id=$1", [key]); expect(edits).toHaveLength(1); expect(edits[0].reason).toBe(reason);
  expect(JSON.parse(edits[0].changed_fields).timestamp).toContain(".123456");
  expect((await raw("sessions", "id=$1", [key]))[0].timestamp).toContain(".654321");
  expect((await raw("audit_events", "entity_type='legacy_session_mutation' AND entity_id=$1", [JSON.stringify([key])]))[0].reason).toBe(reason);
  expect(await raw("audit_events", "entity_type='legacy_session_import'")).toEqual(imports); noLegacy();
});
it("soft-deletes/restores actual mirrored rows and preserves action-specific not-found responses", async () => {
  const key = "api-a-meditation", original = (await raw("sessions", "id=$1", [key]))[0];
  expect((await http("DELETE", keyPath(key), { userId: "api-b" })).status).toBe(200);
  const deleted = (await raw("sessions", "id=$1", [key]))[0].deleted_at;
  expect((await raw("observations", "legacy_source_id=$1", [key]))[0].deleted_at).toBe(deleted);
  expect(await http("DELETE", keyPath(key))).toEqual({ status: 404, body: { message: "Session not found" } });
  expect((await http("POST", keyPath(key) + "/restore")).status).toBe(200);
  expect((await raw("sessions", "id=$1", [key]))[0]).toEqual(original);
  expect(await http("POST", keyPath(key) + "/restore")).toEqual({ status: 404, body: { message: "Deleted session not found" } }); noLegacy();
});
it("rejects invalid payloads and overlong padded explanations before any data change", async () => {
  const before = await snapshot();
  for (const body of [{ reason: " " }, { reason: " ".repeat(500) + "x" }, { reason: "x", durationMinutes: 0 }, { reason: "x", isAnomaly: true, anomalyNote: " " }])
    expect((await http("PATCH", keyPath("api-a-fitness"), body)).status).toBe(400);
  expect((await http("POST", "/api/sessions", { ...payload, isAnomaly: true, anomalyNote: " " })).status).toBe(400);
  expect(await snapshot()).toBe(before); noLegacy();
});
it("keeps cross-owner/unowned/missing route IDs indistinguishable without changing any application table", async () => {
  const before = await snapshot();
  for (const key of ["api-b-music", "api-unowned", "missing"])
    for (const [method, suffix, body] of [["PATCH", "", { reason: "denied" }], ["DELETE", "", undefined], ["POST", "/restore", undefined]] as const) {
      const r = await http(method, keyPath(key) + suffix, body); expect(r.status).toBe(404);
      expect(r.body.message).toBe(suffix ? "Deleted session not found" : "Session not found");
    }
  expect(await snapshot()).toBe(before); noLegacy();
});
it("returns bounded503 on late audit failure for all four real handlers, without legacy fallback or partial writes", async () => {
  const key = "api-a-fitness"; expect((await http("DELETE", keyPath(key))).status).toBe(200);
  await f.client.query(`CREATE FUNCTION public.fail_api_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.entity_type='legacy_session_mutation' THEN RAISE EXCEPTION 'synthetic PRIVATE_DATABASE_SENTINEL'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_api_audit AFTER INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION public.fail_api_audit()`);
  try {
    const before = await snapshot();
    for (const [method, path, body] of [["POST", "/api/sessions", payload], ["PATCH", keyPath("api-a-martial-arts"), { reason: "rollback", notes: "changed" }],
      ["DELETE", keyPath("api-a-martial-arts"), undefined], ["POST", keyPath(key) + "/restore", undefined]] as const) {
      expect(await http(method, path, body)).toEqual({ status: 503, body: { message: "Service unavailable" } }); expect(await snapshot()).toBe(before); noLegacy();
    }
  } finally { await f.client.query("DROP TRIGGER fail_api_audit ON public.audit_events; DROP FUNCTION public.fail_api_audit()"); }
  expect((await http("POST", keyPath(key) + "/restore")).status).toBe(200);
});
it("refuses an opted-in owner without migrated membership instead of seeding, importing or falling back", async () => {
  fake.owner = "api-unmigrated"; const before = await snapshot();
  expect(await http("POST", "/api/sessions", payload)).toEqual({ status: 403, body: { message: "Access denied" } });
  expect(await snapshot()).toBe(before); noLegacy();
});
it("the existing auth guard rejects unauthenticated requests before either write path", async () => {
  fake.owner = null; const before = await snapshot();
  expect(await http("POST", "/api/sessions", payload)).toEqual({ status: 401, body: { message: "Authentication required" } });
  expect(await snapshot()).toBe(before); noLegacy();
});
