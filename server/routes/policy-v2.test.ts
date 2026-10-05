import { beforeAll, afterAll, it, expect, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { Pool } from "pg";
import { startFixture, verifyFixture } from "../lib/ownership-fixture";
import { createPinnedOwnershipUnit } from "../lib/pinned-ownership-unit";
import { createDomainServiceV2 } from "../services/domain-service-v2";
import { createPolicyV2Router } from "./policy-v2";
import { configurationFor, MEASUREMENTS } from "../../shared/fixtures/domain-config-cases";

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
  return { pool: { connect: async () => { mountStats.dbConnects++; throw Error("private synthetic database detail"); } } };
});
import { registerRoutes } from "../routes";

let f: Awaited<ReturnType<typeof startFixture>>, pool: Pool, server: Server, base: string, connects = 0;
const authenticatedRequests = new WeakSet<object>(), forwardedRequests: object[] = [];
const created: Record<string, any> = {};
function payload(slug: string) {
  const { organizationId, ownerUserId, domainId, policyVersionId, revision, previousVersionId, ...configuration } =
    configurationFor(slug, MEASUREMENTS[2], 12);
  return { slug, configuration, reason: "Synthetic router test" };
}
async function call(path: string, actor?: string, method = "GET", body?: unknown) {
  const response = await fetch(base + path, { method, headers: { ...(actor ? { "x-synthetic-fixture-actor": actor } : {}),
    ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
async function snapshot() {
  const state: Record<string, unknown> = {};
  for (const table of ["users", "sessions", "session_edits", "user_settings", "deviations", "http_sessions", "organizations", "organization_members",
    "domains", "policy_versions", "dimension_definitions", "source_bindings", "observations", "audit_events", "deviations_v2", "deviation_domains", "evaluation_results"])
    state[table] = (await f.client.query(`SELECT to_jsonb(t) r FROM public.${table} t ORDER BY to_jsonb(t)::text`)).rows;
  return JSON.stringify(state);
}
beforeAll(async () => {
  f = await startFixture("domain-management-router");
  await f.client.query(`INSERT INTO users(id) VALUES('router-a'),('router-b'),('router-c');
    INSERT INTO organizations(org_id,display_name) VALUES('router-one','One'),('router-two','Two');
    INSERT INTO organization_members(org_id,user_id,role) VALUES('router-one','router-a','owner'),
      ('router-two','router-b','owner'),('router-one','router-c','member')`);
  verifyFixture(f.root);
  pool = new Pool({ host: f.root + "/socket", port: 5432, user: "synthetic", database: "postgres", password: "", ssl: false,
    max: 4, connectionTimeoutMillis: 5000, options: "-c statement_timeout=10000 -c lock_timeout=5000" });
  const real = createDomainServiceV2(createPinnedOwnershipUnit({ connect: () => { connects++; return pool.connect(); } }),
    { clock: () => new Date("2026-01-01T00:00:00Z") });
  const forwarded = (request: any) => { expect(authenticatedRequests.has(request)).toBe(true); forwardedRequests.push(request); };
  const service: typeof real = {
    list: request => { forwarded(request); return real.list(request); },
    read: (request, key) => { forwarded(request); return real.read(request, key); },
    create: (request, input) => { forwarded(request); return real.create(request, input); },
    configure: (request, key, input) => { forwarded(request); return real.configure(request, key, input); },
  };
  const app = express();
  app.use("/api/v2/domains", createPolicyV2Router({ service,
    // Test-only identity injection. Production receives its existing Passport
    // authenticate middleware; the router/service never read this fixture header.
    authenticate: (request: any, response, next) => {
      const actor = request.get("x-synthetic-fixture-actor");
      if (!["router-a", "router-b", "router-c"].includes(actor)) { response.status(401).json({ message: "Authentication required" }); return; }
      request.isAuthenticated = () => true; request.user = { claims: { sub: actor } };
      authenticatedRequests.add(request); next();
    },
  }));
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw Error("Synthetic HTTP fixture failed");
  base = `http://127.0.0.1:${address.port}/api/v2/domains`;
}, 60000);
afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (pool) await pool.end(); if (f) await f.cleanup();
}, 60000);

it("real HTTP authentication rejects unauthenticated/malformed requests before all database access", async () => {
  const before = connects, state = await snapshot();
  for (const [path, method, body] of [["/", "GET", undefined], ["/", "POST", payload("unauthorized")],
    ["/missing", "GET", undefined], ["/missing/policies", "POST", {}]] as const) {
    expect((await call(path, undefined, method, body)).status).toBe(401);
    expect((await call(path, "__proto__", method, body)).status).toBe(401);
  }
  expect(connects).toBe(before); expect(await snapshot()).toBe(state);
});
it("real router creates and reads count-only domains with server identities, forwarding the original authenticated request", async () => {
  for (const actor of ["router-a", "router-b", "router-c"]) {
    const response = await call("/", actor, "POST", payload(actor === "router-c" ? "member-slug" : "same-slug"));
    expect(response.status).toBe(201); created[actor] = response.body;
    expect(response.body.policyVersions[0].configuration.ownerUserId).toBe(actor);
    expect(response.body.policyVersions[0].configuration.measurements[0].kind).toBe("count");
    expect(response.body.scoreAvailability).toBe("not_calculated");
    expect((await call(`/${response.body.domainId}`, actor)).body).toEqual(response.body);
  }
  expect(forwardedRequests.length).toBeGreaterThan(0);
  expect(forwardedRequests.every(request => authenticatedRequests.has(request))).toBe(true);
});
it("list/read/configure stay isolated across organizations and independent owners in the same organization", async () => {
  const before = await snapshot();
  for (const actor of ["router-a", "router-b", "router-c"]) {
    const list = await call("/", actor); expect(list.status).toBe(200);
    expect(list.body.domains.map((d: any) => d.domainId)).toEqual([created[actor].domainId]);
    for (const foreign of ["router-a", "router-b", "router-c"].filter(x => x !== actor)) {
      expect((await call(`/${created[foreign].domainId}`, actor)).status).toBe(404);
      expect((await call(`/${created[foreign].domainId}/policies`, actor, "POST", {
        configuration: payload("foreign").configuration, expectedPolicyVersionId: created[foreign].policyVersions[0].configuration.policyVersionId,
        reason: "Synthetic isolation refusal",
      })).status).toBe(404);
    }
  }
  expect(await snapshot()).toBe(before);
});
it("strict HTTP bodies and query parameters reject authority and rollout fields without writes", async () => {
  const before = await snapshot();
  for (const extra of [{ organizationId: "router-two" }, { ownerUserId: "router-b" }, { rolloutMode: "v2" }, { domainId: "chosen" }]) {
    const response = await call("/", "router-a", "POST", { ...payload("authority"), ...extra });
    expect(response.status).toBe(400); expect(response.body.issues.length).toBeGreaterThan(0);
  }
  expect((await call("/?ownerUserId=router-b", "router-a")).status).toBe(400);
  const response = await call("/", "router-a", "POST", { ...payload("authority"), configuration: {
    ...payload("authority").configuration, ownerUserId: "router-b",
  } });
  expect(response.status).toBe(400); expect(response.body.issues[0].code).toBe("server_identity");
  expect(await snapshot()).toBe(before);
});
it("server configuration validation is actionable and malformed JSON stays bounded", async () => {
  const before = await snapshot();
  const bad = payload("invalid-unit");
  (bad.configuration.measurements[0] as any).unit = { unitId: "minute", dimension: "time" };
  const response = await call("/", "router-a", "POST", bad);
  expect(response.status).toBe(400); expect(response.body.issues.some((x: any) => x.path.includes("measurements"))).toBe(true);
  const malformed = await fetch(base + "/", { method: "POST", headers: {
    "x-synthetic-fixture-actor": "router-a", "content-type": "application/json",
  }, body: "{ not valid json" });
  expect(malformed.status).toBe(400); expect(await malformed.json()).toEqual({ message: "Invalid request body" });
  expect(await snapshot()).toBe(before);
});
it("real configure route appends a prospective version, keeps original history and rejects stale retries", async () => {
  const original = created["router-a"].policyVersions[0].configuration;
  const next = { ...payload("unused").configuration, effectiveFrom: "2026-02-01T00:00:00Z", displayName: "New caption" };
  const body = { expectedPolicyVersionId: original.policyVersionId, configuration: next, reason: "Synthetic version" };
  const response = await call(`/${created["router-a"].domainId}/policies`, "router-a", "POST", body);
  expect(response.status).toBe(201); expect(response.body.policyVersions).toHaveLength(2);
  expect(response.body.policyVersions[0].configuration).toEqual(original);
  expect(response.body.currentPolicyVersionId).toBe(original.policyVersionId);
  expect(response.body.policyVersions[1].configuration.previousVersionId).toBe(original.policyVersionId);
  const before = await snapshot(), stale = await call(`/${created["router-a"].domainId}/policies`, "router-a", "POST", body);
  expect(stale.status).toBe(400); expect(stale.body.issues[0].code).toBe("version_conflict"); expect(await snapshot()).toBe(before);
});
it("a real late database failure returns a sanitized error and leaves no domain or audit residue", async () => {
  await f.client.query(`CREATE FUNCTION public.fail_router_policy_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.entity_type='policy_versions' THEN RAISE EXCEPTION 'private synthetic connection secret'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_router_policy_audit AFTER INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION public.fail_router_policy_audit()`);
  try {
    const before = await snapshot(), response = await call("/", "router-a", "POST", payload("late-http-failure"));
    expect(response).toEqual({ status: 503, body: { message: "Service unavailable" } }); expect(await snapshot()).toBe(before);
  } finally { await f.client.query("DROP TRIGGER fail_router_policy_audit ON audit_events; DROP FUNCTION public.fail_router_policy_audit()"); }
});

it("the actual registerRoutes management mount preserves lazy database import and original Passport validation", async () => {
  const app = express(), mounted = createServer(app);
  // Avoid invoking the unrelated default legacy adapter's environment reader.
  const legacy: any = { create: vi.fn(), edit: vi.fn(), softDelete: vi.fn(), restore: vi.fn(), respondError: vi.fn() };
  await registerRoutes(mounted, app, legacy);
  expect(mountStats).toEqual({ dbImports: 0, dbConnects: 0 });
  await new Promise<void>(resolve => mounted.listen(0, "127.0.0.1", resolve));
  const address = mounted.address(); if (!address || typeof address === "string") throw Error("Synthetic mounted HTTP fixture failed");
  const url = `http://127.0.0.1:${address.port}/api/v2/domains`;
  try {
    for (const headers of [{}, { "x-synthetic-fixture-actor": "__proto__" },
      { "x-synthetic-fixture-actor": "router-a", "x-synthetic-auth-false": "yes" }]) {
      const response = await fetch(url, { headers });
      expect(response.status).toBe(401); expect(mountStats).toEqual({ dbImports: 0, dbConnects: 0 });
    }
    const valid = await fetch(url, { headers: { "x-synthetic-fixture-actor": "router-a" } });
    expect(valid.status).toBe(503); expect(await valid.json()).toEqual({ message: "Service unavailable" });
    expect(mountStats).toEqual({ dbImports: 1, dbConnects: 1 });
  } finally { await new Promise<void>((resolve, reject) => mounted.close(error => error ? reject(error) : resolve())); }
});
