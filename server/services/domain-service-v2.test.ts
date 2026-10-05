import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { Pool } from "pg";
import { startFixture, verifyFixture } from "../lib/ownership-fixture";
import { createPinnedOwnershipUnit } from "../lib/pinned-ownership-unit";
import { createDomainServiceV2, referenceComparisonsFor, type DomainConfigurationDraft } from "./domain-service-v2";
import { configurationFor, MEASUREMENTS, ADAPTED, conditionFor, FREQUENCY_CASES, AGGREGATED_TARGET_CASES } from "../../shared/fixtures/domain-config-cases";
import type { DomainConfiguration } from "../../shared/domain-config";

export function draftForTest(c: DomainConfiguration): DomainConfigurationDraft {
  const { organizationId, ownerUserId, domainId, policyVersionId, revision, previousVersionId, ...draft } = structuredClone(c);
  return draft;
}
const request = (actor: string) => ({ isAuthenticated: () => true, user: { claims: { sub: actor } } });
const clock = () => new Date("2026-01-01T00:00:00Z");
const payload = (slug: string, measurement = MEASUREMENTS[2], target: number | boolean = 12) => ({
  slug, configuration: draftForTest(configurationFor(slug, measurement, target)), reason: "Synthetic configuration test",
});
describe("actual management service, pinned ownership and persistence", () => {
  let f: Awaited<ReturnType<typeof startFixture>>, pool: Pool, service: ReturnType<typeof createDomainServiceV2>;
  const created: Record<string, Awaited<ReturnType<typeof service.create>>> = {};
  const tables = ["users", "sessions", "session_edits", "user_settings", "deviations", "http_sessions", "organizations", "organization_members",
    "domains", "policy_versions", "dimension_definitions", "source_bindings", "observations", "audit_events", "deviations_v2", "deviation_domains", "evaluation_results"];
  async function snapshot() {
    const state: Record<string, unknown> = {};
    for (const table of tables) state[table] = (await f.client.query(`SELECT to_jsonb(t) r FROM public.${table} t ORDER BY to_jsonb(t)::text`)).rows;
    return JSON.stringify(state);
  }
  async function unchanged(operation: () => Promise<unknown>, status: number) {
    const before = await snapshot(); await expect(operation()).rejects.toMatchObject({ status }); expect(await snapshot()).toBe(before);
  }
  beforeAll(async () => {
    f = await startFixture("domain-management");
    await f.client.query(`INSERT INTO users(id) VALUES('management-a'),('management-b'),('management-c'),('management-none');
      INSERT INTO organizations(org_id,display_name) VALUES('management-one','One'),('management-two','Two');
      INSERT INTO organization_members(org_id,user_id,role) VALUES('management-one','management-a','owner'),
        ('management-two','management-b','owner'),('management-one','management-c','member')`);
    verifyFixture(f.root);
    pool = new Pool({ host: f.root + "/socket", port: 5432, user: "synthetic", database: "postgres", password: "", ssl: false,
      max: 4, connectionTimeoutMillis: 5000, options: "-c statement_timeout=10000 -c lock_timeout=5000" });
    service = createDomainServiceV2(createPinnedOwnershipUnit(pool), { clock });
  }, 60000);
  afterAll(async () => { if (pool) await pool.end(); if (f) await f.cleanup(); }, 60000);
  it("malformed authentication fails every operation before acquiring a connection", async () => {
    let connects = 0;
    const bad = createDomainServiceV2(createPinnedOwnershipUnit({ connect: async () => { connects++; throw Error("private connection"); } } as any));
    const requests = [{}, request("__proto__"), request(" "), { ...request("management-a"), isAuthenticated: () => false },
      { ...request("management-a"), isAuthenticated: () => { throw Error("private auth"); } }];
    for (const r of requests) for (const operation of [() => bad.list(r), () => bad.read(r, "x"), () => bad.create(r, payload("x")),
      () => bad.configure(r, "x", {})]) await expect(operation()).rejects.toMatchObject({ status: 401 });
    expect(connects).toBe(0);
  });
  it("creates count-only domain, first policy, dimensions and scoped audit in one transaction", async () => {
    const before = await snapshot();
    created.a = await service.create({ ...request("management-a"), body: { ownerUserId: "management-b" }, query: { orgId: "management-two" } }, payload("same-caption"));
    const version = created.a.policyVersions[0].configuration;
    expect(created.a.domainId).toMatch(/^[a-f0-9-]{36}$/); expect(version.policyVersionId).toMatch(/^[a-f0-9-]{36}$/);
    expect(version.organizationId).toBe("management-one"); expect(version.ownerUserId).toBe("management-a");
    expect(version.measurements).toHaveLength(1); expect(version.measurements[0].kind).toBe("count");
    expect(version.measurements.some(m => m.kind === "duration")).toBe(false);
    expect(created.a.scoreAvailability).toBe("not_calculated"); expect(created.a.currentPolicyVersionId).toBe(version.policyVersionId);
    const audits = (await f.client.query("SELECT entity_type,actor_user_id FROM audit_events WHERE actor_user_id='management-a' ORDER BY entity_type")).rows;
    expect(audits).toEqual([{ entity_type: "dimension_definitions", actor_user_id: "management-a" },
      { entity_type: "domains", actor_user_id: "management-a" }, { entity_type: "policy_versions", actor_user_id: "management-a" }]);
    expect(await snapshot()).not.toBe(before); expect(await service.read(request("management-a"), created.a.domainId)).toEqual(created.a);
  });
  it("same captions and slugs across organizations remain isolated; same-org foreign records stay private", async () => {
    created.b = await service.create(request("management-b"), payload("same-caption"));
    created.c = await service.create(request("management-c"), payload("member-caption"));
    expect(created.b.displayName).toBe(created.a.displayName);
    for (const actor of ["a", "b", "c"]) {
      const r = request(`management-${actor}`), list = await service.list(r);
      expect(list.domains.map(d => d.domainId)).toEqual([created[actor].domainId]);
      for (const foreign of ["a", "b", "c"].filter(x => x !== actor)) {
        await unchanged(() => service.read(r, created[foreign].domainId), 404);
        await unchanged(() => service.configure(r, created[foreign].domainId, {
          expectedPolicyVersionId: created[foreign].policyVersions[0].configuration.policyVersionId,
          configuration: payload("foreign").configuration, reason: "Synthetic refusal",
        }), 404);
      }
    }
    await unchanged(() => service.list(request("management-none")), 403);
    await unchanged(() => service.create(request("management-c"), payload("same-caption")), 400);
  });
  it("rejects authority, lifecycle and rollout input, including nested configuration identities, without writes", async () => {
    for (const extra of [{ orgId: "management-two" }, { ownerUserId: "management-b" }, { rolloutMode: "v2" }, { actorKind: "system" },
      { domainId: "chosen" }, { tombstonedAt: null }, { clock: "2020" }])
      await unchanged(() => service.create(request("management-a"), { ...payload("forged"), ...extra }), 400);
    for (const key of ["organizationId", "ownerUserId", "domainId", "policyVersionId", "revision", "previousVersionId"])
      await unchanged(() => service.create(request("management-a"), { ...payload("forged"), configuration: {
        ...payload("forged").configuration, [key]: "forged",
      } }), 400);
    await unchanged(() => service.create(request("management-a"), { ...payload("forged"), configuration: {
      ...payload("forged").configuration, rolloutMode: "v2",
    } }), 400);
  });
  it("invalid policy leaves zero orphan domains, dimensions or audits, even when rejected after domain insertion", async () => {
    for (const displayName of ["", "   ", "\t\n", "x".repeat(501)])
      await unchanged(() => service.create(request("management-a"), { ...payload("bad-name"), configuration: {
        ...payload("bad-name").configuration, displayName,
      } }), 400);
    await unchanged(() => service.create(request("management-a"), { ...payload("bad-unit"), configuration: {
      ...payload("bad-unit").configuration, measurements: [{ ...MEASUREMENTS[2], unit: { unitId: "minute", dimension: "time" } }],
    } }), 400);
    const lateClock = createDomainServiceV2(createPinnedOwnershipUnit(pool), { clock: () => new Date("2026-01-02T00:00:00Z") });
    await unchanged(() => lateClock.create(request("management-a"), payload("past-first-policy")), 400);
    await f.client.query(`CREATE FUNCTION public.fail_management_policy_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.entity_type='policy_versions' THEN RAISE EXCEPTION 'private synthetic audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_management_policy_audit AFTER INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION public.fail_management_policy_audit()`);
    try { await unchanged(() => service.create(request("management-a"), payload("late-audit")), 503); }
    finally { await f.client.query("DROP TRIGGER fail_management_policy_audit ON audit_events; DROP FUNCTION public.fail_management_policy_audit()"); }
  });
  it("supports all accepted amount types and independent event/day frequency, without a minutes prerequisite", async () => {
    const normalized = await service.create(request("management-a"), { ...payload("trim-name"), configuration: {
      ...payload("trim-name").configuration, displayName: "  Cooking  ",
    } });
    expect(normalized.displayName).toBe("Cooking"); expect(normalized.policyVersions[0].configuration.displayName).toBe("Cooking");
    for (const [index, measurement] of MEASUREMENTS.entries()) {
      const amount = measurement.valueType === "boolean" ? true : measurement.kind === "quantity" ? 2.5 : 3;
      const result = await service.create(request("management-a"), payload(`amount-${index}`, measurement, amount));
      expect(result.policyVersions[0].configuration.measurements[0]).toEqual(measurement);
    }
    for (const [index, example] of FREQUENCY_CASES.entries()) {
      const result = await service.create(request("management-a"), { slug: `frequency-${index}`,
        configuration: draftForTest(example.configuration), reason: "Synthetic frequency" });
      expect(result.policyVersions[0].configuration.measurements).toEqual(example.configuration.measurements);
    }
  });
  it("configure creates a new prospective version and rename, preserving the exact first policy and audit history", async () => {
    const first = structuredClone(created.a.policyVersions[0].configuration), auditBefore =
      (await f.client.query("SELECT to_jsonb(t) r FROM audit_events t ORDER BY audit_event_id")).rows;
    const changed = { ...draftForTest(first), displayName: "Renamed Cooking", effectiveFrom: "2026-02-01T00:00:00Z" };
    const next = await service.configure(request("management-a"), created.a.domainId,
      { expectedPolicyVersionId: first.policyVersionId, configuration: changed, reason: "Synthetic prospective revision" });
    expect(next.domainId).toBe(created.a.domainId); expect(next.displayName).toBe("Renamed Cooking"); expect(next.policyVersions).toHaveLength(2);
    expect(next.policyVersions[0].configuration).toEqual(first); expect(next.currentPolicyVersionId).toBe(first.policyVersionId);
    const second = next.policyVersions[1].configuration;
    expect(second.revision).toBe(2); expect(second.previousVersionId).toBe(first.policyVersionId); expect(second.policyVersionId).not.toBe(first.policyVersionId);
    const currentAudits = (await f.client.query("SELECT to_jsonb(t) r FROM audit_events t ORDER BY audit_event_id")).rows;
    expect(currentAudits.filter(x => auditBefore.some(old => old.r.audit_event_id === x.r.audit_event_id))).toEqual(auditBefore);
    await unchanged(() => service.configure(request("management-a"), created.a.domainId,
      { expectedPolicyVersionId: first.policyVersionId, configuration: changed, reason: "Stale save" }), 400);
    await unchanged(() => service.configure(request("management-a"), created.a.domainId,
      { expectedPolicyVersionId: second.policyVersionId, configuration: { ...changed, effectiveFrom: "2025-01-01T00:00:00Z" }, reason: "Past save" }), 400);
    await unchanged(() => service.configure(request("management-a"), created.a.domainId,
      { expectedPolicyVersionId: second.policyVersionId, configuration: { ...changed, effectiveFrom: "2026-03-01T00:00:00Z",
        measurements: [{ ...changed.measurements[0], meaning: "Changed meaning under reused identity" }] }, reason: "Identity reuse" }), 400);
  });
  it("late rename audit failure rolls back the appended version and dimensions too", async () => {
    const view = await service.read(request("management-a"), created.a.domainId), last = view.policyVersions.at(-1)!.configuration;
    await f.client.query(`CREATE FUNCTION public.fail_management_rename_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.entity_type='domains' AND NEW.action='update' THEN RAISE EXCEPTION 'private synthetic rename failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_management_rename_audit AFTER INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION public.fail_management_rename_audit()`);
    try { await unchanged(() => service.configure(request("management-a"), created.a.domainId, { expectedPolicyVersionId: last.policyVersionId,
      configuration: { ...draftForTest(last), displayName: "Failed rename", effectiveFrom: "2026-04-01T00:00:00Z" }, reason: "Synthetic late rollback" }), 503); }
    finally { await f.client.query("DROP TRIGGER fail_management_rename_audit ON audit_events; DROP FUNCTION public.fail_management_rename_audit()"); }
  });
  it("simultaneous same-predecessor saves commit exactly one valid version with no loser dimensions or audits", async () => {
    const initial = await service.create(request("management-a"), payload("concurrent-policy"));
    const first = initial.policyVersions[0].configuration;
    let begun = 0, release!: () => void;
    const bothConnected = new Promise<void>(resolve => { release = resolve; });
    const racing = createDomainServiceV2(createPinnedOwnershipUnit({ connect: async () => {
      const client = await pool.connect();
      return {
        query: async (sql: string, values?: unknown[]) => {
          // Barrier only in this synthetic pool wrapper. Both real clients
          // reach BEGIN before either proceeds. The accepted unit's actor row
          // lock then serializes policy reads; a later list-query barrier would
          // deadlock by waiting for a client intentionally blocked by that lock.
          if (sql === "BEGIN") { begun++; if (begun === 2) release(); await bothConnected; }
          return client.query(sql, values);
        },
        release: (destroy?: boolean) => client.release(destroy),
      } as any;
    } }), { clock });
    const oldAudits = (await f.client.query("SELECT to_jsonb(t) r FROM audit_events t ORDER BY audit_event_id")).rows;
    const operations = ["Winner A", "Winner B"].map(displayName => racing.configure(request("management-a"), initial.domainId, {
      expectedPolicyVersionId: first.policyVersionId,
      configuration: { ...draftForTest(first), displayName, effectiveFrom: "2026-05-01T00:00:00Z" }, reason: `Synthetic race ${displayName}`,
    }));
    const results = await Promise.allSettled(operations);
    expect(begun).toBe(2);
    const fulfilled = results.filter(x => x.status === "fulfilled"), rejected = results.filter(x => x.status === "rejected");
    expect(fulfilled).toHaveLength(1); expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ status: 400 });
    const winner = (fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof service.configure>>>).value;
    const policies = (await f.client.query("SELECT * FROM policy_versions WHERE domain_id=$1 ORDER BY revision", [initial.domainId])).rows;
    expect(policies).toHaveLength(2); expect(policies[0].configuration).toEqual(first);
    expect(policies[1].previous_version_id).toBe(first.policyVersionId); expect(policies[1].revision).toBe(2);
    expect(policies[1].configuration.displayName).toBe(winner.displayName);
    const dimensions = (await f.client.query("SELECT policy_version_id,measurement_id FROM dimension_definitions WHERE domain_id=$1 ORDER BY policy_version_id", [initial.domainId])).rows;
    expect(dimensions).toHaveLength(2); expect(dimensions.map(x => x.policy_version_id).sort()).toEqual(policies.map(x => x.policy_version_id).sort());
    const audits = (await f.client.query("SELECT to_jsonb(t) r FROM audit_events t ORDER BY audit_event_id")).rows;
    expect(audits.filter(x => oldAudits.some(old => old.r.audit_event_id === x.r.audit_event_id))).toEqual(oldAudits);
    const added = audits.filter(x => !oldAudits.some(old => old.r.audit_event_id === x.r.audit_event_id));
    expect(added).toHaveLength(3); expect(added.map(x => x.r.entity_type).sort()).toEqual(["dimension_definitions", "domains", "policy_versions"]);
    expect(added.every(x => x.r.after.domain_id === initial.domainId && x.r.actor_user_id === "management-a")).toBe(true);
    expect((await service.read(request("management-a"), initial.domainId)).displayName).toBe(winner.displayName);
  });
  it("below-reference adapted plans remain saved with purpose, evidence and review unchanged", async () => {
    const result = await service.create(request("management-a"), { slug: "adapted", configuration: draftForTest(ADAPTED), reason: "Synthetic adaptation" });
    const stored = result.policyVersions[0].configuration;
    expect(stored.targets).toEqual(ADAPTED.targets); expect(stored.references).toEqual(ADAPTED.references); expect(stored.goal.intent).toBe("develop");
    const late = createDomainServiceV2(createPinnedOwnershipUnit(pool), { clock: () => new Date("2026-01-20T00:00:00Z") });
    const before = await snapshot(), view = await late.read(request("management-a"), result.domainId);
    expect(view.policyVersions[0].configuration.targets).toEqual(ADAPTED.targets); expect(await snapshot()).toBe(before);
    expect(view.policyVersions[0].referenceComparisons.find(x => x.referenceId === "reference-E-develop" && x.targetKind === "adapted"))
      .toMatchObject({ status: "below_reference", active: true });
    expect(view.policyVersions[0].referenceComparisons.find(x => x.referenceId === "reference-E-maintain")!.status).toBe("unknown");
  });
});

describe("honest typed reference comparison", () => {
  const at = new Date("2026-01-20T00:00:00Z");
  it("distinguishes the normal and adapted targets without calculating a percentage or expiring adaptation on review", () => {
    const before = JSON.stringify(ADAPTED), result = referenceComparisonsFor(ADAPTED, at);
    expect(result.find(x => x.referenceId === "reference-E-develop" && x.targetKind === "normal")).toMatchObject({ status: "meets_reference", active: false });
    expect(result.find(x => x.referenceId === "reference-E-develop" && x.targetKind === "adapted")).toMatchObject({ status: "below_reference", active: true });
    const numericMetrics: string[] = [];
    const inspect = (value: unknown, path = "") => {
      if (Array.isArray(value)) { value.forEach((item, index) => inspect(item, `${path}[${index}]`)); return; }
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        const childPath = path ? `${path}.${key}` : key;
        if (typeof child === "number" && /score|percent/i.test(key)) numericMetrics.push(childPath);
        inspect(child, childPath);
      }
    };
    inspect(result);
    expect(numericMetrics).toEqual([]); expect(JSON.stringify(ADAPTED)).toBe(before);
  });
  it("does not compare differing purposes, task conditions, period bases or incomparable operators", () => {
    const c = structuredClone(ADAPTED); c.goal.intent = "maintain";
    expect(referenceComparisonsFor(c, at)[0].status).toBe("not_comparable");
    const tasks = structuredClone(ADAPTED); tasks.references[0].applicability.taskConditions = [{ conditionId: "unconfirmed", description: "Unconfirmed task" }];
    expect(referenceComparisonsFor(tasks, at)[0].status).toBe("not_comparable");
    for (const example of AGGREGATED_TARGET_CASES) {
      const c = structuredClone(example.configuration); c.goal.intent = "develop";
      expect(referenceComparisonsFor(c, at)[0].status).toBe("not_comparable");
    }
    const operators = structuredClone(ADAPTED); operators.targets.normal.conditions[0] = {
      ...operators.targets.normal.conditions[0], valueType: "integer", constraint: { operator: "lte", value: 20 },
    };
    expect(referenceComparisonsFor(operators, at)[0].status).toBe("not_comparable");
  });
  it("supports lower-is-better and within-range rules only under matching declared direction", () => {
    const low = configurationFor("low", { ...MEASUREMENTS[3], comparisonDirection: "lower_is_better" }, 3);
    low.goal.intent = "develop";
    low.targets.normal.conditions = [{ ...conditionFor(low.measurements[0], 3), valueType: "number", constraint: { operator: "lte", value: 3 } }];
    low.references = [{ ...ADAPTED.references[0], referenceId: "low-reference", status: "known", conditions: [{
      ...conditionFor(low.measurements[0], 2), valueType: "number", constraint: { operator: "lte", value: 2 },
    }] }];
    expect(referenceComparisonsFor(low, at)[0].status).toBe("below_reference");
    const range = structuredClone(low); range.measurements[0].comparisonDirection = "within_range";
    range.targets.normal.conditions[0] = { ...conditionFor(range.measurements[0], 2), valueType: "number", constraint: { operator: "range", min: 1, max: 2 } };
    range.references[0] = { ...range.references[0], status: "known", conditions: [{
      ...conditionFor(range.measurements[0], 2), valueType: "number", constraint: { operator: "range", min: 0, max: 3 },
    }] };
    expect(referenceComparisonsFor(range, at)[0].status).toBe("meets_reference");
  });
  it("does not silently equate units and preserves unknown and not-applicable references", () => {
    const c = structuredClone(ADAPTED); c.targets.normal.conditions[0].unitId = "different-unit";
    expect(referenceComparisonsFor(c, at)[0].status).toBe("not_comparable");
    expect(referenceComparisonsFor(ADAPTED, at).find(x => x.referenceId === "reference-E-maintain")!.status).toBe("unknown");
    const other = structuredClone(ADAPTED); other.references[0] = { ...other.references[0], status: "not_applicable" } as any;
    expect(referenceComparisonsFor(other, at)[0].status).toBe("not_applicable");
  });
  it("preserves exact reference operators for both higher-is-better and lower-is-better measurements", () => {
    for (const direction of ["higher_is_better", "lower_is_better"] as const) {
      const c = configurationFor("exact", { ...MEASUREMENTS[1], comparisonDirection: direction }, 10);
      c.goal.intent = "develop";
      c.references = [{ ...ADAPTED.references[0], referenceId: "exact-reference", status: "known", conditions: [{
        ...conditionFor(c.measurements[0], 10), valueType: "integer", constraint: { operator: "eq", value: 10 },
      }] }];
      for (const [constraint, expected] of [
        [{ operator: "gte", value: 20 }, "not_comparable"],
        [{ operator: "lte", value: 5 }, "not_comparable"],
        [{ operator: "eq", value: 20 }, "below_reference"],
        [{ operator: "eq", value: 5 }, "below_reference"],
        [{ operator: "eq", value: 10 }, "meets_reference"],
      ] as const) {
        c.targets.normal.conditions[0] = { ...conditionFor(c.measurements[0], 10), valueType: "integer", constraint };
        expect(referenceComparisonsFor(c, at)[0].status).toBe(expected);
      }
    }
  });
});
