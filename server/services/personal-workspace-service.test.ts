import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { Pool } from "pg";
import { startFixture, verifyFixture } from "../lib/ownership-fixture";
import { createAuthenticatedBootstrapUnit } from "../lib/authenticated-bootstrap-unit";
import { createPinnedOwnershipUnit } from "../lib/pinned-ownership-unit";
import { createOrgContextResolver } from "../lib/org-context";
import { createPersonalWorkspaceService } from "./personal-workspace-service";
import { createDomainServiceV2 } from "./domain-service-v2";
import { configurationFor, MEASUREMENTS } from "../../shared/fixtures/domain-config-cases";

const request = (actor: string) => ({ isAuthenticated: () => true, user: { claims: { sub: actor } } });
const tables = ["users", "sessions", "session_edits", "user_settings", "deviations", "http_sessions", "organizations", "organization_members",
  "domains", "policy_versions", "dimension_definitions", "source_bindings", "observations", "audit_events", "deviations_v2", "deviation_domains", "evaluation_results"];
function domainPayload(target: number) {
  const { organizationId, ownerUserId, domainId, policyVersionId, revision, previousVersionId, ...configuration } = configurationFor("Cooking", MEASUREMENTS[2], target);
  return { slug: "cooking", configuration, reason: "Synthetic first-domain isolation test" };
}
describe("personal workspace provision/status: accepted PostgreSQL schema and actual ownership services", () => {
  let f: Awaited<ReturnType<typeof startFixture>>, pool: Pool, service: ReturnType<typeof createPersonalWorkspaceService>;
  async function snapshot() {
    const state: Record<string, unknown> = {};
    for (const table of tables) state[table] = (await f.client.query(`SELECT to_jsonb(t) r FROM public.${table} t ORDER BY to_jsonb(t)::text`)).rows;
    return JSON.stringify(state);
  }
  async function unchanged(operation: () => Promise<unknown>, status: number) {
    const before = await snapshot(); await expect(operation()).rejects.toMatchObject({ status }); expect(await snapshot()).toBe(before);
  }
  beforeAll(async () => {
    f = await startFixture("personal-workspaces");
    await f.client.query(`INSERT INTO users(id,email) VALUES ('onboard-a','a@example.invalid'),('onboard-b','b@example.invalid'),
      ('preserved-settings',NULL),('existing-owner',NULL),('same-org-member',NULL),('blank-member',NULL),('ambiguous-owner',NULL),('failure-owner',NULL),('commit-owner',NULL);
      INSERT INTO organizations(org_id,display_name,rollout_mode) VALUES ('established-org','Established','shadow'),('other-org','Other','legacy');
      INSERT INTO organization_members(org_id,user_id,role) VALUES ('established-org','existing-owner','owner'),
        ('established-org','same-org-member','member'),('other-org','blank-member','member'),
        ('established-org','ambiguous-owner','member'),('other-org','ambiguous-owner','owner');
      INSERT INTO user_settings(user_id,day_start_hour,timezone,window_days,notifications_enabled) VALUES
        ('existing-owner',6,'Asia/Tokyo',21,true),('preserved-settings',5,'Europe/London',14,true);
      INSERT INTO sessions(id,user_id,domain,duration_minutes,timestamp) SELECT 'unassigned-'||g,NULL,'music',1,'2026-01-01T00:00:00Z' FROM generate_series(1,73) g;
      INSERT INTO sessions(id,user_id,domain,duration_minutes,timestamp) VALUES ('historical-owned','existing-owner','meditation',10,'2026-01-01T00:00:00Z')`);
    verifyFixture(f.root);
    pool = new Pool({ host: f.root + "/socket", port: 5432, user: "synthetic", database: "postgres", password: "", ssl: false,
      max: 8, connectionTimeoutMillis: 10000, options: "-c statement_timeout=20000 -c lock_timeout=15000" });
    service = createPersonalWorkspaceService(createAuthenticatedBootstrapUnit(pool));
    const domains = createDomainServiceV2(createPinnedOwnershipUnit(pool), { clock: () => new Date("2026-01-01T00:00:00Z") });
    const seeded = await domains.create(request("existing-owner"), { ...domainPayload(12), slug: "established-cooking" });
    await f.client.query(`INSERT INTO source_bindings(binding_id,org_id,owner_user_id,domain_id,source_kind,external_id,metadata)
      VALUES ('established-binding','established-org','existing-owner',$1,'manual-legacy','synthetic-old-id',$2::jsonb)`,
      [seeded.domainId, JSON.stringify({ description: "existing-owner-seed-v1" })]);
  }, 60000);
  afterAll(async () => { if (pool) await pool.end(); if (f) await f.cleanup(); }, 60000);

  it("status is read-only for a missing workspace; ordinary432 remains forbidden", async () => {
    const before = await snapshot();
    expect(await service.status(request("onboard-a"))).toEqual({ schemaVersion: 1, ownerUserId: "onboard-a", status: "needs_workspace" });
    await expect(createOrgContextResolver(f.db)(request("onboard-a"))).rejects.toMatchObject({ status: 403 });
    expect(await snapshot()).toBe(before);
  });
  it("auth precedes body validation/connection; authority fields are rejected before any DB access", async () => {
    let connects = 0;
    const safe = createPersonalWorkspaceService(createAuthenticatedBootstrapUnit({ connect: async () => { connects++; throw Error("private target"); } } as any));
    for (const actor of [{}, request(" "), request("__proto__"), { ...request("onboard-a"), isAuthenticated: () => false }]) {
      await expect(safe.status(actor)).rejects.toMatchObject({ status: 401 });
      await expect(safe.ensure(actor, { orgId: "forged" })).rejects.toMatchObject({ status: 401 });
    }
    for (const input of [undefined, null, [], { orgId: "established-org" }, { ownerUserId: "existing-owner" }, { email: "a@example.invalid" },
      { role: "owner" }, { rolloutMode: "v2" }, { template: "Philip" }])
      await expect(safe.ensure(request("onboard-a"), input)).rejects.toMatchObject({ status: 400 });
    expect(connects).toBe(0);
  });
  it("32 concurrent/repeated ensures converge on one workspace/settings and one three-audit set", async () => {
    const results = await Promise.all(Array.from({ length: 32 }, () => service.ensure({ ...request("onboard-a"),
      body: { userId: "onboard-b", email: "b@example.invalid" }, query: { orgId: "established-org" } }, {})));
    expect(new Set(results.map(result => result.workspace.organizationId)).size).toBe(1);
    const first = results[0];
    expect(first).toMatchObject({ schemaVersion: 1, ownerUserId: "onboard-a", status: "ready", experience: "personal", hasConfiguredDomain: false,
      workspace: { role: "owner" }, settings: { userId: "onboard-a", dayStartHour: 4, timezone: "America/New_York", windowDays: 7 } });
    expect(first.workspace.organizationId).toMatch(/^[a-f0-9-]{36}$/);
    expect((await f.client.query("SELECT org_id,rollout_mode FROM organizations WHERE org_id=$1", [first.workspace.organizationId])).rows)
      .toEqual([{ org_id: first.workspace.organizationId, rollout_mode: "legacy" }]);
    expect((await f.client.query("SELECT count(*)::int n FROM organization_members WHERE user_id='onboard-a'")).rows[0].n).toBe(1);
    expect((await f.client.query("SELECT count(*)::int n FROM user_settings WHERE user_id='onboard-a'")).rows[0].n).toBe(1);
    const audits = (await f.client.query("SELECT entity_type,actor_user_id,org_id,\"before\",\"after\" FROM audit_events WHERE actor_user_id='onboard-a' ORDER BY entity_type")).rows;
    expect(audits.map(row => row.entity_type)).toEqual(["organization_members", "organizations", "user_settings"]);
    expect(audits.every(row => row.actor_user_id === "onboard-a" && row.org_id === first.workspace.organizationId && row.before === null)).toBe(true);
    const before = await snapshot(); expect(await service.ensure(request("onboard-a"), {})).toEqual(first);
    expect(await service.status(request("onboard-a"))).toEqual(first); expect(await snapshot()).toBe(before);
  }, 60000);
  it("preserves existing membership, role, rollout, settings, history and all73 unassigned rows byte-for-byte", async () => {
    const before = await snapshot();
    const existing = await service.ensure(request("existing-owner"), {});
    expect(existing).toMatchObject({ experience: "legacy", hasConfiguredDomain: true,
      workspace: { organizationId: "established-org", role: "owner" }, settings: { userId: "existing-owner", dayStartHour: 6, timezone: "Asia/Tokyo", windowDays: 21 } });
    const member = await service.ensure(request("blank-member"), {});
    expect(member).toMatchObject({ experience: "personal", hasConfiguredDomain: false, workspace: { role: "member" }, settings: null });
    expect(await snapshot()).toBe(before);
    expect((await f.client.query("SELECT count(*)::int n FROM sessions WHERE user_id IS NULL")).rows[0].n).toBe(73);
  });
  it("reuses prior own settings for a newly created membership, without rewriting or duplicate settings audit", async () => {
    const before = (await f.client.query("SELECT to_jsonb(t) r FROM user_settings t WHERE user_id='preserved-settings'")).rows;
    const result = await service.ensure(request("preserved-settings"), {});
    expect(result.settings).toEqual({ userId: "preserved-settings", dayStartHour: 5, timezone: "Europe/London", windowDays: 14 });
    expect((await f.client.query("SELECT to_jsonb(t) r FROM user_settings t WHERE user_id='preserved-settings'")).rows).toEqual(before);
    expect((await f.client.query("SELECT entity_type FROM audit_events WHERE actor_user_id='preserved-settings' ORDER BY entity_type")).rows)
      .toEqual([{ entity_type: "organization_members" }, { entity_type: "organizations" }]);
  });
  it("does not expose a same-organization colleague's seed marker or configuration; ambiguity fails closed", async () => {
    const before = await snapshot();
    const member = await service.status({ ...request("same-org-member"), body: { actorUserId: "existing-owner" }, query: { orgId: "other-org" } });
    expect(member).toMatchObject({ ownerUserId: "same-org-member", experience: "personal", hasConfiguredDomain: false, settings: null });
    expect(await snapshot()).toBe(before);
    await unchanged(() => service.status(request("ambiguous-owner")), 403);
    await unchanged(() => service.ensure(request("ambiguous-owner"), {}), 403);
    await unchanged(() => service.ensure(request("missing-persisted-user"), {}), 403);
  });
  it("two persisted SSO subjects create same-caption domains with different private targets and no foreign reads/configures", async () => {
    const a = await service.status(request("onboard-a")), b = await service.ensure(request("onboard-b"), {});
    expect(a.status).toBe("ready"); if (a.status !== "ready") throw Error("Synthetic prerequisite");
    expect(b.workspace.organizationId).not.toBe(a.workspace.organizationId);
    const domains = createDomainServiceV2(createPinnedOwnershipUnit(pool), { clock: () => new Date("2026-01-01T00:00:00Z") });
    const first = await domains.create(request("onboard-a"), domainPayload(12)), second = await domains.create(request("onboard-b"), domainPayload(18));
    expect(first.displayName).toBe(second.displayName); expect(first.domainId).not.toBe(second.domainId);
    expect(first.policyVersions[0].configuration.targets).not.toEqual(second.policyVersions[0].configuration.targets);
    for (const [actor, owned, foreign] of [["onboard-a", first, second], ["onboard-b", second, first]] as const) {
      expect((await domains.list(request(actor))).domains.map(domain => domain.domainId)).toEqual([owned.domainId]);
      expect(await service.status(request(actor))).toMatchObject({ hasConfiguredDomain: true, experience: "personal" });
      await unchanged(() => domains.read(request(actor), foreign.domainId), 404);
      await unchanged(() => domains.configure(request(actor), foreign.domainId, { expectedPolicyVersionId: foreign.policyVersions[0].configuration.policyVersionId,
        configuration: domainPayload(99).configuration, reason: "Synthetic refused foreign policy" }), 404);
    }
  });
  it("failure after each organization/member/settings insert or any setup audit rolls back the whole transaction", async () => {
    const failures = [["organizations", null], ["organization_members", null], ["user_settings", null],
      ["audit_events", "organizations"], ["audit_events", "organization_members"], ["audit_events", "user_settings"]] as const;
    for (const [table, entity] of failures) {
      await f.client.query(`CREATE FUNCTION public.fail_personal_setup() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'private synthetic failure'; END $$;
        CREATE TRIGGER fail_personal_setup AFTER INSERT ON public.${table} FOR EACH ROW
        ${entity ? `WHEN (NEW.entity_type='${entity}')` : ""} EXECUTE FUNCTION public.fail_personal_setup()`);
      try { await unchanged(() => service.ensure(request("failure-owner"), {}), 503); }
      finally { await f.client.query(`DROP TRIGGER fail_personal_setup ON public.${table}; DROP FUNCTION public.fail_personal_setup()`); }
    }
  });
  it("lost COMMIT acknowledgement is uncertain, destroys its client and converges on owned status/retry without duplicate audits", async () => {
    const releases: boolean[] = [];
    const uncertain = createPersonalWorkspaceService(createAuthenticatedBootstrapUnit({ connect: async () => {
      const client = await pool.connect(); return { query: async (sql: string, values?: any[]) => {
        const result = await client.query(sql, values); if (sql === "COMMIT") throw Error("private lost commit acknowledgement"); return result;
      }, release: (destroy: boolean) => { releases.push(destroy); client.release(destroy); } } as any;
    } }));
    await expect(uncertain.ensure(request("commit-owner"), {})).rejects.toMatchObject({ status: 503, message: "Service unavailable" });
    expect(releases).toEqual([true]);
    const resolved = await service.status(request("commit-owner")); expect(resolved.status).toBe("ready");
    const before = await snapshot(); expect(await service.ensure(request("commit-owner"), {})).toEqual(resolved); expect(await snapshot()).toBe(before);
    expect((await f.client.query("SELECT count(*)::int n FROM organization_members WHERE user_id='commit-owner'")).rows[0].n).toBe(1);
    expect((await f.client.query("SELECT count(*)::int n FROM audit_events WHERE actor_user_id='commit-owner'")).rows[0].n).toBe(3);
  });
});
