import { beforeAll, afterAll, it, expect, vi } from "vitest";
import express from "express";
import { createServer, request as httpRequest, type Server } from "node:http";
import { Pool } from "pg";
import { startFixture, verifyFixture } from "../lib/ownership-fixture";
import { createOrgContextResolver } from "../lib/org-context";
import { createPinnedOwnershipUnit } from "../lib/pinned-ownership-unit";
import { createPolicyV2Storage } from "../storage/policy-v2-storage";
import { createActivityServiceV2 } from "../services/activity-service-v2";
import { createActivityV2Router } from "./activity-v2";
import { ActivityCreateInputSchema } from "../../shared/activity";
import { configurationFor, conditionFor, MEASUREMENTS } from "../../shared/fixtures/domain-config-cases";
import type { DomainConfiguration } from "../../shared/domain-config";

// Only the real root mount's lazy pool is mocked. The main HTTP fixture below
// uses real service/storage transactions in its owned Unix PostgreSQL fixture.
const mountStats = vi.hoisted(() => ({ imports: 0, connects: 0 }));
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
  mountStats.imports++;
  return { pool: { connect: async () => { mountStats.connects++; throw Error("private synthetic database detail"); } } };
});
import { registerRoutes } from "../routes";

let fixture: Awaited<ReturnType<typeof startFixture>>, pool: Pool, server: Server, base: string, connects = 0;
const configs: Record<string, DomainConfiguration> = {};
const originalRequests = new WeakSet<object>(), forwarded: object[] = [];
const now = "2026-06-15T12:00:00.000Z";
const actors = ["route-practice-a", "route-practice-b", "route-practice-c"];
const orgFor = (actor: string) => actor === actors[2] ? "route-practice-other" : "route-practice-shared";
const authRequest = (actor: string) => ({ isAuthenticated: () => true, user: { claims: { sub: actor } } });
async function call(path: string, actor?: string, method = "GET", body?: unknown, extraHeaders: Record<string, string> = {}) {
  const response = await fetch(base + path, { method, headers: {
    ...(actor === undefined ? {} : { "x-synthetic-fixture-actor": actor }),
    ...(body === undefined ? {} : { "content-type": "application/json" }), ...extraHeaders,
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json(), cache: response.headers.get("cache-control") };
}
function entry(actor: string, key: string, amount = 12) {
  const c = configs[actor], m = c.measurements[0];
  return { submissionKey: key, domainId: c.domainId, policyVersionId: c.policyVersionId,
    practiceEvent: true, observedAt: "2026-06-10T12:00:00Z",
    values: { [m.measurementId]: { valueType: "integer", unitId: m.unit.unitId, taskVariantId: m.taskVariantId, value: amount } } };
}
async function snapshot(exclude: string[] = []) {
  const state: Record<string, unknown> = {};
  for (const table of ["users", "sessions", "session_edits", "user_settings", "deviations", "http_sessions", "organizations", "organization_members",
    "domains", "policy_versions", "dimension_definitions", "source_bindings", "observations", "audit_events", "deviations_v2", "deviation_domains", "evaluation_results"])
    if (!exclude.includes(table)) state[table] = (await fixture.client.query(`SELECT to_jsonb(t) r FROM public.${table} t ORDER BY to_jsonb(t)::text`)).rows;
  return JSON.stringify(state);
}
async function noMutation(operation: () => Promise<{ status: number }>, status: number) {
  const before = await snapshot(); expect((await operation()).status).toBe(status); expect(await snapshot()).toBe(before);
}
beforeAll(async () => {
  fixture = await startFixture("activity-v2-router");
  await fixture.client.query(`INSERT INTO users(id) VALUES ('route-practice-a'),('route-practice-b'),('route-practice-c'),
    ('route-practice-none'),('route-practice-ambiguous'),('route-practice-revoked');
    INSERT INTO organizations(org_id,display_name,rollout_mode) VALUES
      ('route-practice-shared','Invented shared','legacy'),('route-practice-other','Invented other','v2');
    INSERT INTO organization_members(org_id,user_id,role) VALUES ('route-practice-shared','route-practice-a','owner'),
      ('route-practice-shared','route-practice-b','member'),('route-practice-other','route-practice-c','owner'),
      ('route-practice-shared','route-practice-ambiguous','owner'),('route-practice-other','route-practice-ambiguous','member'),
      ('route-practice-shared','route-practice-revoked','member');
    INSERT INTO user_settings(user_id,day_start_hour,timezone,window_days,notifications_enabled,notification_tier)
      VALUES('route-practice-a',4,'America/New_York',21,true,'PAGE'),('route-practice-b',6,'Asia/Tokyo',30,false,'ADVISORY');
    INSERT INTO sessions(id,user_id,domain,duration_minutes,timestamp)
      VALUES('route-practice-history','route-practice-a','music',15,'2026-01-01T00:00:00Z');
    INSERT INTO sessions(id,user_id,domain,duration_minutes,timestamp)
      SELECT 'route-practice-unowned-'||g,NULL,'meditation',10,'2026-01-01T00:00:00Z' FROM generate_series(1,73) g`);
  for (const actor of actors) {
    const context = await createOrgContextResolver(fixture.db)(authRequest(actor));
    const store = createPolicyV2Storage(fixture.db, context, { clock: () => new Date("2026-01-01T00:00:00Z") });
    const measurement = { ...structuredClone(MEASUREMENTS[2]), measurementId: "cups-" + actor, taskVariantId: "task-" + actor };
    const c: DomainConfiguration = { ...configurationFor(actor, measurement, actor === actors[1] ? 18 : 12),
      organizationId: orgFor(actor), ownerUserId: actor, displayName: "Cooking",
      taskVariants: [{ variantId: measurement.taskVariantId, displayName: "Invented recipe", taskConditions: [] }],
      targets: { normal: { targetId: "target-" + actor, conditions: [conditionFor(measurement, actor === actors[1] ? 18 : 12)] } } };
    configs[actor] = c;
    await store.domains.createWithPolicy({ domainId: c.domainId, slug: "cooking-" + actor, displayName: c.displayName }, c, "Synthetic HTTP fixture setup");
    if (actor === actors[0]) {
      for (const kind of ["legacy", "legacy-other", "inactive", "scheduled"] as const) {
        const other: DomainConfiguration = { ...structuredClone(c), domainId: "route-" + kind,
          policyVersionId: "route-" + kind + "-v1", effectiveFrom: kind === "scheduled" ? "2026-07-01T00:00:00Z" : c.effectiveFrom };
        await store.domains.createWithPolicy({ domainId: other.domainId, slug: "route-" + kind, displayName: other.displayName }, other, "Synthetic HTTP fixture setup");
        if (kind === "legacy" || kind === "legacy-other") await store.bindings.create({ bindingId: "binding-" + kind, domainId: other.domainId,
          sourceKind: "manual-legacy", externalId: "external-" + kind,
          metadata: { description: kind === "legacy" ? "existing-owner-seed-v1" : "Different invented legacy description" } }, "Synthetic legacy marker");
        if (kind === "inactive") await store.domains.update([other.domainId], { deactivatedAt: "2026-06-01T00:00:00Z" }, "Synthetic inactive domain");
      }
    }
  }
  verifyFixture(fixture.root);
  pool = new Pool({ host: fixture.root + "/socket", port: 5432, user: "synthetic", database: "postgres", password: "", ssl: false,
    max: 5, connectionTimeoutMillis: 5000, options: "-c statement_timeout=10000 -c lock_timeout=5000" });
  const actual = createActivityServiceV2(createPinnedOwnershipUnit({ connect: () => { connects++; return pool.connect(); } }), { clock: () => new Date(now) });
  const pin = (request: object) => { expect(originalRequests.has(request)).toBe(true); forwarded.push(request); };
  const service: typeof actual = {
    create: (request, input) => { pin(request); return actual.create(request, input); },
    read: (request, input) => { pin(request); return actual.read(request, input); },
    submission: (request, input) => { pin(request); return actual.submission(request, input); },
    list: (request, input) => { pin(request); return actual.list(request, input); },
    eligibility: (request, input) => { pin(request); return actual.eligibility(request, input); },
  };
  const app = express();
  // Actual root parser ordering: local16KB encoded semantic payload enforcement
  // must still work after this inherited100KB transport parser consumed input.
  app.use(express.json({ limit: "100kb" }));
  app.use("/api/v2/activities", createActivityV2Router({ service, authenticate: (request: any, response, next) => {
    const actor = request.get("x-synthetic-fixture-actor");
    if (actor === undefined) { response.status(401).json({ message: "Authentication required" }); return; }
    request.user = { claims: { sub: actor } };
    if (request.get("x-synthetic-auth-throws") === "yes") request.isAuthenticated = () => { throw Error("private synthetic auth detail"); };
    else request.isAuthenticated = () => request.get("x-synthetic-auth-false") !== "yes";
    originalRequests.add(request); next();
  } }));
  app.use((error: any, _request: any, response: any, _next: any) => {
    response.status(error?.status === 413 ? 413 : 400).json({ message: "Invalid request body" });
  });
  server = createServer(app); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw Error("Synthetic HTTP fixture failed");
  base = `http://127.0.0.1:${address.port}/api/v2/activities`;
}, 60000);
afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (pool) await pool.end(); if (fixture) await fixture.cleanup();
}, 60000);

it("ordinary owned no-body history GET is empty/read-only and original authentication requests reach the real service", async () => {
  const state = await snapshot();
  for (const actor of actors) expect(await call("/", actor)).toEqual({ status: 200, body: { activities: [], nextCursor: null }, cache: "no-store" });
  expect(await snapshot()).toBe(state); expect(forwarded.length).toBeGreaterThan(0);
  expect(forwarded.every(request => originalRequests.has(request))).toBe(true);
});
it("missing, malformed, throwing and false Passport authentication have zero pool connections across all route shapes", async () => {
  const count = connects, state = await snapshot();
  for (const actor of [undefined, "__proto__", " ", "x".repeat(201)]) {
    for (const path of ["/", "/missing", "/submissions/missing", "/eligibility/route-legacy"]) expect((await call(path, actor)).status).toBe(401);
    expect((await call("/", actor, "POST", entry(actors[0], "unauthorized"))).status).toBe(401);
  }
  for (const extra of [{ "x-synthetic-auth-false": "yes" }, { "x-synthetic-auth-throws": "yes" }])
    expect((await call("/", actors[0], "POST", entry(actors[0], "unauthorized"), extra)).status).toBe(401);
  expect(connects).toBe(count); expect(await snapshot()).toBe(state);
});
it("strict unsupported authority and malformed list/path/query inputs fail before acquiring a pool connection", async () => {
  const count = connects, state = await snapshot(), input = entry(actors[0], "bad-shape");
  for (const field of ["ownerUserId", "organizationId", "actorUserId", "role", "rolloutMode", "observationId", "sourceBindingId", "deletedAt", "isAnomaly", "score"])
    expect((await call("/", actors[0], "POST", { ...input, [field]: actors[1] })).status).toBe(400);
  for (const body of [undefined, null, [], {}, { ...input, practiceEvent: false }, { ...input, observedAt: "2026-06-10T12:00:00.0001Z" }])
    expect((await call("/", actors[0], "POST", body)).status).toBe(400);
  for (const path of ["/?ownerUserId=other", "/?limit=0", "/?limit=101", "/?limit=1.5", "/?limit=01", "/?limit=2&limit=3",
    "/?domainId[owner]=other", "/?cursor=", "/constructor", "/submissions/__proto__", "/eligibility/prototype",
    "/missing?domainId=other", "/submissions/missing?owner=other", "/eligibility/route-legacy?owner=other"])
    expect((await call(path, actors[0])).status).toBe(400);
  expect((await call("/?organizationId=other", actors[0], "POST", input)).status).toBe(400);
  expect(connects).toBe(count); expect(await snapshot()).toBe(state);
});
it("the encoded semantic payload16KB bound still rejects valid-shaped input after the real outer100KB parser", async () => {
  const count = connects, state = await snapshot();
  const values = Object.fromEntries(Array.from({ length: 64 }, (_, i) => ["m" + i + "x".repeat(170), {
    valueType: "integer", value: 1, unitId: "u".repeat(170), taskVariantId: "v".repeat(170),
  }]));
  const body = { ...entry(actors[0], "oversized"), values };
  expect(ActivityCreateInputSchema.safeParse(body).success).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(16384);
  expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(100 * 1024);
  const result = await call("/", actors[0], "POST", body);
  expect(result).toEqual({ status: 413, body: { message: "Invalid request body" }, cache: "no-store" });
  expect(connects).toBe(count); expect(await snapshot()).toBe(state);
});
it("standalone bounded parser rejects malformed JSON and oversize input with safe errors, and a GET body never reaches storage", async () => {
  const count = connects, state = await snapshot();
  const bodyGet = await new Promise<{ status: number; body: any }>((resolve, reject) => {
    const payload = "{}", request = httpRequest(base + "/submissions/missing", { method: "GET", headers: {
      "x-synthetic-fixture-actor": actors[0], "content-type": "application/json", "content-length": Buffer.byteLength(payload),
    } }, response => {
      const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    }); request.on("error", reject); request.end(payload);
  });
  expect(bodyGet.status).toBe(400); expect(bodyGet.body.issues).toEqual([{ path: "body", code: "unexpected_body" }]);
  const actual = createActivityServiceV2(createPinnedOwnershipUnit({ connect: async () => { throw Error("must not connect"); } }));
  const app = express(); app.use(createActivityV2Router({ service: actual, authenticate: (request: any, _response, next) => {
    request.user = { claims: { sub: actors[0] } }; request.isAuthenticated = () => true; next();
  } }));
  const standalone = createServer(app); await new Promise<void>(resolve => standalone.listen(0, "127.0.0.1", resolve));
  const address = standalone.address(); if (!address || typeof address === "string") throw Error("Synthetic standalone parser failed");
  try {
    for (const [body, status] of [["{ invalid JSON", 400], [JSON.stringify({ notes: "x".repeat(20000) }), 413]] as const) {
      const response = await fetch(`http://127.0.0.1:${address.port}/`, { method: "POST", headers: { "content-type": "application/json" }, body });
      expect(response.status).toBe(status); expect(await response.json()).toEqual({ message: "Invalid request body" });
    }
  } finally { await new Promise<void>((resolve, reject) => standalone.close(error => error ? reject(error) : resolve())); }
  expect(connects).toBe(count); expect(await snapshot()).toBe(state);
});
it("own eligibility is read-only, distinguishes legacy/inactive/scheduled without binding leakage, and cannot project another owner", async () => {
  const state = await snapshot();
  expect((await call("/eligibility/" + configs[actors[0]].domainId, actors[0])).body).toEqual({
    domainId: configs[actors[0]].domainId, canCreate: true, reason: null, effectivePolicyVersionId: configs[actors[0]].policyVersionId,
  });
  for (const [domainId, reason] of [["route-legacy", "legacy_writer"], ["route-legacy-other", "legacy_writer"], ["route-inactive", "inactive"], ["route-scheduled", "no_effective_policy"]])
    expect((await call("/eligibility/" + domainId, actors[0])).body).toEqual({ domainId, canCreate: false, reason });
  for (const foreign of [actors[1], actors[2]]) expect((await call("/eligibility/" + configs[foreign].domainId, actors[0])).status).toBe(404);
  for (const domainId of ["route-legacy", "route-legacy-other", "route-inactive", "route-scheduled"])
    await noMutation(() => call("/", actors[0], "POST", { ...entry(actors[0], "blocked-" + domainId), domainId, policyVersionId: domainId + "-v1" }), 400);
  expect(await snapshot()).toBe(state);
});
it("same-caption domains and equal submission keys across both same-org and different-org owners remain independent typed records", async () => {
  const legacy = await snapshot(["observations", "audit_events"]), saved: any[] = [];
  for (let i = 0; i < actors.length; i++) {
    const actor = actors[i];
    const result = await call("/", actor, "POST", entry(actor, "same-client-key", i === 1 ? 18 : 12));
    expect(result.status).toBe(201); expect(result.cache).toBe("no-store"); expect(result.body.created).toBe(true);
    const activity = result.body.activity; saved.push(activity);
    expect(activity.ownerUserId).toBe(actor); expect(activity.configuration.displayName).toBe("Cooking");
    expect(activity.values[configs[actor].measurements[0].measurementId].value).toBe(i === 1 ? 18 : 12);
    expect(activity.configuration).toEqual(configs[actor]); expect(activity.scoreAvailability).toBe("not_calculated");
    expect(activity.attainmentAvailability).toBe("not_calculated");
    for (const field of ["idempotencyKey", "idempotency_key", "legacySourceId", "legacy_source_id", "audit", "score", "attainment", "durationMinutes"])
      expect(Object.hasOwn(activity, field)).toBe(false);
    expect((await call("/submissions/same-client-key", actor)).body).toEqual(activity);
    expect((await call("/" + activity.activityId, actor)).body).toEqual(activity);
  }
  expect(new Set(saved.map(activity => activity.activityId)).size).toBe(3);
  for (const actor of actors) for (const other of saved.filter(activity => activity.ownerUserId !== actor))
    await noMutation(() => call("/" + other.activityId, actor), 404);
  expect(await snapshot(["observations", "audit_events"])).toBe(legacy);
  expect((await fixture.client.query("SELECT count(*)::int n FROM sessions WHERE user_id IS NULL")).rows[0].n).toBe(73);
});
it("actual HTTP simultaneous equal retries converge, changed-content conflicts and stable submission reconciliation makes no second commit", async () => {
  const input = entry(actors[0], "http-race", 0), beforeAudits = (await fixture.client.query("SELECT count(*)::int n FROM audit_events")).rows[0].n;
  const results = await Promise.all(Array.from({ length: 3 }, () => call("/", actors[0], "POST", input)));
  expect(results.map(result => result.status).sort()).toEqual([200, 200, 201]);
  expect(new Set(results.map(result => result.body.activity.activityId)).size).toBe(1);
  const activity = results[0].body.activity;
  expect(activity.values[configs[actors[0]].measurements[0].measurementId].value).toBe(0);
  expect((await fixture.client.query("SELECT count(*)::int n FROM observations WHERE observation_id=$1", [activity.activityId])).rows[0].n).toBe(1);
  expect((await fixture.client.query("SELECT count(*)::int n FROM audit_events")).rows[0].n).toBe(beforeAudits + 1);
  const state = await snapshot();
  expect((await call("/", actors[0], "POST", entry(actors[0], "http-race", 1))).status).toBe(400);
  expect((await call("/submissions/http-race", actors[0])).body).toEqual(activity);
  const reordered = { ...input, values: { [configs[actors[0]].measurements[0].measurementId]: {
    value: 0, taskVariantId: configs[actors[0]].measurements[0].taskVariantId, unitId: "cupcake", valueType: "integer",
  } } };
  expect((await call("/", actors[0], "POST", reordered)).status).toBe(200);
  expect(await snapshot()).toBe(state);
});
it("owned history uses bounded stable tie ordering, manual namespace only, and rejects a cursor reused for another owner or filter", async () => {
  for (const key of ["tie-a", "tie-b", "tie-c"]) expect((await call("/", actors[0], "POST", entry(actors[0], key))).status).toBe(201);
  const context = await createOrgContextResolver(fixture.db)(authRequest(actors[0]));
  const store = createPolicyV2Storage(fixture.db, context);
  const c = configs[actors[0]], m = c.measurements[0];
  await store.observations.create({ observation: { schemaVersion: 1, observationId: "route-old-raw-namespace", organizationId: c.organizationId,
    ownerUserId: c.ownerUserId, domainId: c.domainId, policyVersionId: c.policyVersionId, observedAt: "2026-06-10T12:00:00Z",
    values: { [m.measurementId]: { valueType: "integer", unitId: m.unit.unitId, taskVariantId: m.taskVariantId, value: 2 } } },
    idempotencyKey: "route-old-key" }, "Synthetic existing raw repository entry");
  const state = await snapshot(), seen: string[] = [], domain = encodeURIComponent(c.domainId);
  let cursor: string | null = null, firstCursor: string | null = null;
  for (let page = 0; page < 20; page++) {
    const result = await call(`/?domainId=${domain}&limit=2${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`, actors[0]);
    expect(result.status).toBe(200); expect(result.body.activities.length).toBeLessThanOrEqual(2);
    for (const item of result.body.activities) { expect(item.ownerUserId).toBe(actors[0]); expect(item.domainId).toBe(c.domainId); seen.push(item.activityId); }
    cursor = result.body.nextCursor; if (page === 0) firstCursor = cursor; if (cursor === null) break;
    expect(page).toBeLessThan(19);
  }
  const actual = (await fixture.client.query(`SELECT observation_id FROM observations WHERE org_id=$1 AND owner_user_id=$2 AND domain_id=$3
    AND idempotency_key LIKE 'personal-practice:v1:%' ORDER BY observed_at DESC,observation_id DESC`, [c.organizationId, c.ownerUserId, c.domainId])).rows.map(row => row.observation_id);
  expect(seen).toEqual(actual); expect(new Set(seen).size).toBe(seen.length); expect(seen).not.toContain("route-old-raw-namespace");
  expect(firstCursor).not.toBeNull();
  expect((await call(`/?domainId=${encodeURIComponent(configs[actors[1]].domainId)}&cursor=${encodeURIComponent(firstCursor!)}`, actors[1])).status).toBe(400);
  expect((await call(`/?domainId=route-inactive&cursor=${encodeURIComponent(firstCursor!)}`, actors[0])).status).toBe(400);
  expect((await call("/?domainId=" + encodeURIComponent(configs[actors[1]].domainId), actors[0])).status).toBe(404);
  expect((await call("/route-old-raw-namespace", actors[0])).status).toBe(404);
  expect((await call("/submissions/route-old-key", actors[0])).status).toBe(404);
  expect(await snapshot()).toBe(state);
});
it("missing, ambiguous and revoked membership fail closed without record or settings mutation", async () => {
  for (const actor of ["route-practice-none", "route-practice-ambiguous"])
    await noMutation(() => call("/", actor, "POST", entry(actors[0], "membership-" + actor)), 403);
  // An owner with persisted domain children cannot have its FK-backed member
  // row removed. Revoke a genuinely persisted authorized empty member instead.
  expect((await call("/", "route-practice-revoked")).body).toEqual({ activities: [], nextCursor: null });
  await fixture.client.query("DELETE FROM organization_members WHERE user_id=$1", ["route-practice-revoked"]);
  const state = await snapshot();
  expect((await call("/", "route-practice-revoked")).status).toBe(403);
  expect((await call("/eligibility/" + configs[actors[0]].domainId, "route-practice-revoked")).status).toBe(403);
  expect(await snapshot()).toBe(state);
});
it("real registerRoutes activity mount authenticates and validates before its lazy DB import, preserving existing mounts", async () => {
  const app = express(), mounted = createServer(app), legacy: any = { create: vi.fn(), edit: vi.fn(), softDelete: vi.fn(), restore: vi.fn(), respondError: vi.fn() };
  app.use(express.json({ limit: "100kb" })); await registerRoutes(mounted, app, legacy);
  expect(mountStats).toEqual({ imports: 0, connects: 0 });
  await new Promise<void>(resolve => mounted.listen(0, "127.0.0.1", resolve));
  const address = mounted.address(); if (!address || typeof address === "string") throw Error("Synthetic root mount failed");
  const origin = `http://127.0.0.1:${address.port}`, url = origin + "/api/v2/activities";
  try {
    for (const path of ["", "/missing", "/submissions/missing", "/eligibility/missing"])
      expect((await fetch(url + path)).status).toBe(401);
    for (const actor of ["__proto__", "x".repeat(201)])
      expect((await fetch(url, { headers: { "x-synthetic-fixture-actor": actor } })).status).toBe(401);
    expect((await fetch(url + "?userId=forged", { headers: { "x-synthetic-fixture-actor": actors[0] } })).status).toBe(400);
    expect((await fetch(url, { method: "POST", headers: { "x-synthetic-fixture-actor": actors[0], "content-type": "application/json" },
      body: JSON.stringify({ ...entry(actors[0], "forged-root"), ownerUserId: actors[1] }) })).status).toBe(400);
    expect((await fetch(origin + "/api/v2/domains")).status).toBe(401);
    expect((await fetch(origin + "/api/onboarding/status")).status).toBe(401);
    expect((await fetch(origin + "/api/sessions")).status).toBe(401);
    expect(mountStats).toEqual({ imports: 0, connects: 0 });
    const response = await fetch(url + "/eligibility/missing", { headers: { "x-synthetic-fixture-actor": actors[0] } });
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ message: "Service unavailable" });
    expect(mountStats.imports).toBe(1); expect(mountStats.connects).toBe(1);
    expect(legacy.create).not.toHaveBeenCalled(); expect(legacy.edit).not.toHaveBeenCalled();
    expect(legacy.softDelete).not.toHaveBeenCalled(); expect(legacy.restore).not.toHaveBeenCalled();
  } finally { await new Promise<void>((resolve, reject) => mounted.close(error => error ? reject(error) : resolve())); }
});
