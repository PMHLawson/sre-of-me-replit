import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { Pool } from "pg";
import { startFixture, verifyFixture } from "../lib/ownership-fixture";
import { createOrgContextResolver } from "../lib/org-context";
import { createPinnedOwnershipUnit } from "../lib/pinned-ownership-unit";
import { createPolicyV2Storage } from "../storage/policy-v2-storage";
import { createActivityServiceV2 } from "./activity-service-v2";
import { configurationFor, MEASUREMENTS, FREQUENCY_CASES, conditionFor } from "../../shared/fixtures/domain-config-cases";
import type { DomainConfiguration, MeasurementDefinition } from "../../shared/domain-config";
import type { ActivityCreateInput, ActivityView, ActivityEditInput, ActivityLifecycleInput } from "../../shared/activity";

const request = (actor: string) => ({ isAuthenticated: () => true, user: { claims: { sub: actor } } });
const now = () => new Date("2026-03-01T00:00:00Z");
const tables = ["users", "sessions", "session_edits", "user_settings", "deviations", "http_sessions", "organizations", "organization_members",
  "domains", "policy_versions", "dimension_definitions", "source_bindings", "observations", "audit_events", "deviations_v2", "deviation_domains", "evaluation_results"];
describe("owned typed manual practice through actual pinned PostgreSQL service", () => {
  let f: Awaited<ReturnType<typeof startFixture>>, pool: Pool, service: ReturnType<typeof createActivityServiceV2>;
  const configs: Record<string, DomainConfiguration> = {};
  async function snapshot() {
    const result: Record<string, unknown> = {};
    for (const table of tables) result[table] = (await f.client.query(`SELECT to_jsonb(t) row FROM public.${table} t ORDER BY to_jsonb(t)::text`)).rows;
    return JSON.stringify(result);
  }
  async function unchanged(operation: () => Promise<unknown>, status: number) {
    const before = await snapshot(); await expect(operation()).rejects.toMatchObject({ status }); expect(await snapshot()).toBe(before);
  }
  async function seed(actor: string, key: string, measurement: MeasurementDefinition = MEASUREMENTS[2], target: number | boolean = 12,
    mutate?: (c: DomainConfiguration) => DomainConfiguration) {
    const context = await createOrgContextResolver(f.db)(request(actor));
    let c: DomainConfiguration = { ...configurationFor(key, measurement, target), organizationId: context.orgId, ownerUserId: actor, displayName: "Cooking",
      goal: { intent: "unknown" as const, desiredCapability: "Synthetic capability", privateMotivation: "Private " + actor } };
    if (mutate) c = mutate(c);
    const store = createPolicyV2Storage(f.db, context, { clock: () => new Date("2026-01-01T00:00:00Z") });
    await store.domains.createWithPolicy({ domainId: c.domainId, slug: key, displayName: c.displayName }, c, "Synthetic domain");
    return configs[key] = c;
  }
  function input(c: DomainConfiguration, key: string, value: number | boolean = 12): ActivityCreateInput {
    const m = c.measurements.find(m => m.kind !== "frequency")!;
    const supplied: ActivityCreateInput["values"][string] = m.valueType === "boolean" ?
      { valueType: "boolean", value: Boolean(value), unitId: m.unit.unitId } : m.valueType === "integer" ?
        { valueType: "integer", value: Number(value), unitId: m.unit.unitId } :
        { valueType: "number", value: Number(value), unitId: m.unit.unitId };
    return { submissionKey: key, domainId: c.domainId, policyVersionId: c.policyVersionId, practiceEvent: true,
      observedAt: "2026-01-10T12:00:00.000Z", values: { [m.measurementId]: { ...supplied, ...(m.taskVariantId ? { taskVariantId: m.taskVariantId } : {}) } } };
  }
  function correction(activity:ActivityView,key:string,amount=9):ActivityEditInput {
    return {mutationKey:key,expectedStateFingerprint:activity.stateFingerprint,reason:"Correct a synthetic transcription",
      policyVersionId:activity.policyVersionId,practiceEvent:true,observedAt:activity.observedAt,
      values:Object.fromEntries(Object.entries(activity.values).map(([id,value])=>{if(value.valueType!=="integer")throw Error("Synthetic count correction requires its declared integer unit");return [id,{...value,value:amount}];}))};
  }
  const lifecycle=(activity:ActivityView,key:string):ActivityLifecycleInput=>({mutationKey:key,
    expectedStateFingerprint:activity.stateFingerprint,reason:"Synthetic lifecycle reason"});
  async function updates(id:string){return (await f.client.query("SELECT * FROM audit_events WHERE entity_type='observations' AND action='update' AND entity_id::jsonb->>0=$1 ORDER BY occurred_at,audit_event_id",[id])).rows;}
  beforeAll(async () => {
    f = await startFixture("activity-service-v2"); verifyFixture(f.root);
    await f.client.query(`INSERT INTO users(id) VALUES ('practice-a'),('practice-b'),('practice-c'),('practice-none');
      INSERT INTO organizations(org_id,display_name) VALUES ('practice-one','One'),('practice-two','Two');
      INSERT INTO organization_members(org_id,user_id,role) VALUES ('practice-one','practice-a','owner'),('practice-two','practice-b','owner'),('practice-one','practice-c','member');
      INSERT INTO sessions(id,user_id,domain,duration_minutes,timestamp) VALUES('unassigned-practice',NULL,'music',12,'2026-01-01');
      INSERT INTO user_settings(user_id,window_days,day_start_hour,timezone) VALUES ('practice-a',21,15,'America/New_York')`);
    pool = new Pool({ host: f.root + "/socket", port: 5432, user: "synthetic", database: "postgres", password: "", ssl: false,
      max: 8, connectionTimeoutMillis: 5000, options: "-c statement_timeout=10000 -c lock_timeout=5000" });
    service = createActivityServiceV2(createPinnedOwnershipUnit(pool), { clock: now });
    await seed("practice-a", "a"); await seed("practice-b", "b", MEASUREMENTS[2], 18); await seed("practice-c", "c", MEASUREMENTS[2], 18);
  }, 60000);
  afterAll(async () => { if (pool) await pool.end(); if (f) await f.cleanup(); }, 60000);

  it("auth and invalid typed requests refuse before any lazy connection", async () => {
    let connects = 0;
    const bad = createActivityServiceV2(createPinnedOwnershipUnit({ connect: async () => { connects++; throw Error("private"); } } as any));
    for (const r of [{}, request("__proto__"), request(" "), { ...request("practice-a"), isAuthenticated: () => false },
      { ...request("practice-a"), isAuthenticated: () => { throw Error("private"); } }])
      for (const call of [() => bad.create(r, {}), () => bad.read(r, "x"), () => bad.submission(r, "x"), () => bad.list(r), () => bad.eligibility(r, "x"),() => bad.edit(r,"x",{}),() => bad.delete(r,"x",{}),() => bad.restore(r,"x",{}),() => bad.mutation(r,"x","x")])
        await expect(call()).rejects.toMatchObject({ status: 401 });
    for (const payload of [{ ...input(configs.a, "invalid"), ownerUserId: "practice-b" }, { ...input(configs.a, "invalid"), values: {} as any, practiceEvent: false },
      { ...input(configs.a, "invalid"), observedAt: "2026-01-10T12:00:00.0001Z" },
      { ...input(configs.a, "invalid"), values: { amount: { unitId: "cupcake", valueType: "integer", value: 9007199254740992 } } }])
      await expect(bad.create(request("practice-a"), payload)).rejects.toMatchObject({ status: 400 });
    expect(connects).toBe(0);
  });
  it("same key and same caption are independent across organizations and same-org colleagues; all foreign lookups stay masked", async () => {
    const rows: Record<string, Awaited<ReturnType<typeof service.create>>> = {};
    for (const key of ["a", "b", "c"]) {
      rows[key] = await service.create(request("practice-" + key), input(configs[key], "same-submission", key === "a" ? 12 : 18));
      expect(rows[key].created).toBe(true); expect(rows[key].activity.ownerUserId).toBe("practice-" + key);
      expect(rows[key].activity.configuration.goal.privateMotivation).toBe("Private practice-" + key);
      expect(rows[key].activity.values["m-cupcakes"].value).toBe(key === "a" ? 12 : 18);
    }
    expect(new Set(Object.values(rows).map(r => r.activity.activityId)).size).toBe(3);
    for (const key of ["a", "b", "c"]) {
      const r = request("practice-" + key);
      expect(await service.submission(r, "same-submission")).toEqual({submissionKey:"same-submission",activity:rows[key].activity});
      for (const foreign of ["a", "b", "c"].filter(k => k !== key)) {
        await unchanged(() => service.read(r, rows[foreign].activity.activityId), 404);
        await unchanged(() => service.eligibility(r, configs[foreign].domainId), 404);
        await unchanged(() => service.list(r, { domainId: configs[foreign].domainId }), 404);
        await unchanged(() => service.create(r, input(configs[foreign], "foreign")), 404);
        await unchanged(() => service.create(r, { ...input(configs[key], "foreign-policy"), policyVersionId: configs[foreign].policyVersionId }), 404);
      }
    }
    await unchanged(() => service.list(request("practice-none")), 403);
    await unchanged(() => service.submission(request("practice-c"), "only-a-key"), 404);
  });
  it("preserves every supported raw kind, zero/false/omission, explicit adapted amount and exact immutable policy without manufactured minutes", async () => {
    for (let i = 0; i < MEASUREMENTS.length; i++) {
      const m = MEASUREMENTS[i];
      const c = await seed("practice-a", "kind-" + i, m, m.valueType === "boolean" ? true : 20), amount = m.valueType === "boolean" ? false : 0;
      const saved = await service.create(request("practice-a"), input(c, "kind-key-" + i, amount));
      expect(saved.activity.values[m.measurementId].value).toBe(amount); expect(saved.activity.configuration).toEqual(c);
      expect(saved.activity).not.toHaveProperty("notes"); expect(saved.activity).not.toHaveProperty("durationMinutes");
      expect(saved.activity.scoreAvailability).toBe("not_calculated"); expect(saved.activity.attainmentAvailability).toBe("not_calculated");
    }
    const c = await seed("practice-a", "adapted", MEASUREMENTS[0], 20, c => ({ ...c, targets: { ...c.targets, adapted: {
      duration: "temporary", effectiveFrom: c.effectiveFrom, reviewAt: "2026-04-01T00:00:00Z", reason: "Synthetic recovery",
      target: { targetId: "adapted-eight", conditions: [conditionFor(c.measurements[0], 8)] },
    } } }));
    const saved = await service.create(request("practice-a"), input(c, "adapted-eight", 8));
    expect(saved.activity.values["m-duration"].value).toBe(8); expect(saved.activity.configuration.targets.normal.conditions[0].constraint).toEqual({ operator: "gte", value: 20 });
  });
  it("rejects missing raw practice, foreign measurements/units/variants, outcome/context-only and supplied frequency totals without writes", async () => {
    const mixed = await seed("practice-a", "mixed", MEASUREMENTS[2], 12, c => ({ ...c,
      measurements: [...c.measurements, { ...MEASUREMENTS[0], measurementId: "context-time", role: "context" },
        { ...MEASUREMENTS[1], measurementId: "outcome-reps", role: "outcome" }] }));
    const invalid = [{}, { "not-declared": { valueType: "integer", value: 2, unitId: "cupcake" } },
      { "m-cupcakes": { valueType: "integer", value: 2, unitId: "rep" } },
      { "m-cupcakes": { valueType: "integer", value: 2, unitId: "cupcake", taskVariantId: "foreign-variant" } },
      { "context-time": { valueType: "number", value: 2, unitId: "minute" } }, { "outcome-reps": { valueType: "integer", value: 2, unitId: "rep" } }];
    for (const values of invalid) await unchanged(() => service.create(request("practice-a"), { ...input(mixed, "invalid-values"), values }), 400);
    for (let i = 0; i < FREQUENCY_CASES.length; i++) {
      const example = FREQUENCY_CASES[i];
      const frequency = example.configuration.measurements.find(m => m.kind === "frequency")!;
      const c = await seed("practice-a", "frequency-" + i, MEASUREMENTS[2], 12, c => ({ ...c, measurements: [frequency],
        targets: { normal: { targetId: "occurrences", conditions: [conditionFor(frequency, 3)] } } }));
      for (let n = 0; n < 3; n++) {
        const saved = await service.create(request("practice-a"), { submissionKey: "occurrence-" + i + "-" + n,
          domainId: c.domainId, policyVersionId: c.policyVersionId, practiceEvent: true, observedAt: "2026-01-10T12:00:00Z", values: {} });
        expect(saved.activity.values).toEqual({}); expect(saved.activity.practiceEvent).toBe(true);
      }
      expect((await service.list(request("practice-a"), { domainId: c.domainId })).activities).toHaveLength(3);
      await unchanged(() => service.create(request("practice-a"), { submissionKey: "aggregate-" + i, domainId: c.domainId,
        policyVersionId: c.policyVersionId, practiceEvent: true, observedAt: "2026-01-10T12:00:00Z", values: {
          [frequency.measurementId]: { unitId: frequency.unit.unitId, valueType: "integer", value: 3 },
        } }), 400);
    }
  });
  it("availability is owner-only, distinguishes own legacy/inactive/unconfigured/scheduled, and never writes settings or bindings", async () => {
    const legacy = await seed("practice-a", "legacy"), inactive = await seed("practice-a", "inactive"), scheduled = await seed("practice-a", "scheduled",
      MEASUREMENTS[2], 12, c => ({ ...c, effectiveFrom: "2026-04-01T00:00:00Z" }));
    await f.client.query(`UPDATE domains SET deactivated_at='2026-02-01' WHERE domain_id=$1`, [inactive.domainId]);
    const context = await createOrgContextResolver(f.db)(request("practice-a")), store = createPolicyV2Storage(f.db, context);
    await store.bindings.create({ bindingId: "legacy-owned", domainId: legacy.domainId, sourceKind: "manual-legacy", externalId: "legacy-owned",
      metadata: { description: "existing-owner-seed-v1" } }, "Synthetic legacy");
    await store.domains.create({ domainId: "no-policy", slug: "no-policy", displayName: "Empty" }, "Synthetic empty");
    const before = await snapshot();
    expect(await service.eligibility(request("practice-a"), configs.a.domainId)).toEqual({ domainId: configs.a.domainId, canCreate: true, reason: null,
      effectivePolicyVersionId: configs.a.policyVersionId });
    for (const [domainId, reason] of [[legacy.domainId, "legacy_writer"], [inactive.domainId, "inactive"], [scheduled.domainId, "no_effective_policy"], ["no-policy", "no_effective_policy"]])
      expect(await service.eligibility(request("practice-a"), domainId)).toEqual({ domainId, canCreate: false, reason });
    expect(await snapshot()).toBe(before);
    for (const c of [legacy, inactive, scheduled]) await unchanged(() => service.create(request("practice-a"), input(c, "blocked-" + c.domainId)), 400);
    // The seed marker is not the authority gate: every owned manual-legacy binding keeps its writer.
    await f.client.query(`UPDATE source_bindings SET metadata='{}'::jsonb WHERE binding_id='legacy-owned'`);
    expect(await service.eligibility(request("practice-a"), legacy.domainId)).toMatchObject({ canCreate: false, reason: "legacy_writer" });
    await unchanged(() => service.create(request("practice-a"), input(legacy, "legacy-without-marker")), 400);
    // A colleague's same-org legacy marker does not block A's unrelated personal domain.
    const colleague = await createOrgContextResolver(f.db)(request("practice-c"));
    await createPolicyV2Storage(f.db, colleague).bindings.create({ bindingId: "colleague-legacy", domainId: configs.c.domainId,
      sourceKind: "manual-legacy", externalId: "colleague-legacy" }, "Synthetic colleague writer");
    expect((await service.eligibility(request("practice-a"), configs.a.domainId)).canCreate).toBe(true);
  });
  it("selects the exact half-open historical version, rejecting future/scheduled/pre-first/wrong-boundary instants", async () => {
    const c = await seed("practice-a", "interval"), context = await createOrgContextResolver(f.db)(request("practice-a"));
    const next = { ...structuredClone(c), policyVersionId: "interval-v2", previousVersionId: c.policyVersionId, revision: 2,
      effectiveFrom: "2026-02-01T00:00:00.125Z", boundary: { timezone: "Europe/London", dayStartHour: 15 },
      targets: { normal: { targetId: "new-eighteen", conditions: [conditionFor(c.measurements[0], 18)] } } };
    await createPolicyV2Storage(f.db, context, { clock: () => new Date(c.effectiveFrom) }).policies.append(next, "Synthetic later policy");
    for (const [policyVersionId, observedAt] of [[c.policyVersionId, "2025-12-31T23:59:59.999Z"], [c.policyVersionId, next.effectiveFrom],
      [next.policyVersionId, "2026-02-01T00:00:00.124Z"], [next.policyVersionId, "2026-03-01T00:00:00.001Z"]])
      await unchanged(() => service.create(request("practice-a"), { ...input(c, "invalid-interval"), policyVersionId, observedAt }), 400);
    const historic = await service.create(request("practice-a"), { ...input(c, "historic"), observedAt: "2026-02-01T00:00:00.124Z" });
    const boundary = await service.create(request("practice-a"), { ...input(next, "boundary", 18), observedAt: next.effectiveFrom });
    expect(historic.activity.configuration).toEqual(c); expect(boundary.activity.configuration).toEqual(next);
    await f.client.query(`UPDATE user_settings SET timezone='Asia/Tokyo',day_start_hour=3,window_days=30 WHERE user_id='practice-a'`);
    expect((await service.read(request("practice-a"), historic.activity.activityId)).configuration.boundary).toEqual(c.boundary);
    expect((await service.eligibility(request("practice-a"), c.domainId))).toMatchObject({ effectivePolicyVersionId: next.policyVersionId });
  });
  it("fails closed on a finer persisted successor instant instead of rounding across the boundary", async () => {
    const c = await seed("practice-a", "precision"), context = await createOrgContextResolver(f.db)(request("practice-a"));
    const successor = { ...c, policyVersionId: "precision-v2", previousVersionId: c.policyVersionId, revision: 2, effectiveFrom: "2026-02-01T00:00:00.0001Z" };
    await createPolicyV2Storage(f.db, context, { clock: () => new Date(c.effectiveFrom) }).policies.append(successor, "Synthetic unsupported precision");
    await unchanged(() => service.create(request("practice-a"), input(c, "precision-fail")), 503);
    await unchanged(() => service.eligibility(request("practice-a"), c.domainId), 503);
  });
  it("equal semantic retries acknowledge corrected/tombstoned current state from immutable original audit and never overwrite or restore it", async () => {
    const c = await seed("practice-a", "retry"), p = { ...input(c, "stable-key", 8), context: {
      description: "Private task", taskConditions: [{ conditionId: "one", description: "One" }, { conditionId: "two", description: "Two" }],
    } }, first = await service.create(request("practice-a"), p);
    const row = (await f.client.query("SELECT * FROM observations WHERE observation_id=$1", [first.activity.activityId])).rows[0];
    const corrected = structuredClone(row.observation); corrected.values["m-cupcakes"].value = 9;
    await f.client.query("UPDATE observations SET observation=$2::jsonb,deleted_at='2026-02-02' WHERE observation_id=$1", [row.observation_id, JSON.stringify(corrected)]);
    await f.client.query("UPDATE domains SET deactivated_at='2026-02-02' WHERE domain_id=$1", [c.domainId]);
    const before = await snapshot(), shuffled = { ...p, values: Object.fromEntries(Object.entries(p.values).reverse()) };
    const replay = await service.create(request("practice-a"), shuffled);
    expect(replay.created).toBe(false); expect(replay.activity.values["m-cupcakes"].value).toBe(9); expect(replay.activity.deletedAt).not.toBeNull();
    expect(await snapshot()).toBe(before);
    await unchanged(() => service.create(request("practice-a"), { ...input(configs.a, "stable-key", 8), context: p.context }), 400);
    for (const altered of [{ ...p, notes: "" }, { ...p, values: {} }, { ...p, context: { ...p.context, taskConditions: [...p.context.taskConditions].reverse() } }, input(c, "stable-key", 9)])
      await unchanged(() => service.create(request("practice-a"), altered), 400);
    await unchanged(() => service.create(request("practice-a"), input(c, "new-after-deactivate")), 400);
    await f.client.query(`UPDATE audit_events SET "after"=jsonb_set("after",'{observation,values,m-cupcakes,value}','999')
      WHERE entity_type='observations' AND action='create' AND entity_id=$1`, [JSON.stringify([row.observation_id])]);
    await unchanged(() => service.create(request("practice-a"), p), 400);
    await f.client.query(`DELETE FROM audit_events WHERE entity_type='observations' AND action='create' AND entity_id=$1`, [JSON.stringify([row.observation_id])]);
    await unchanged(() => service.submission(request("practice-a"), p.submissionKey), 503);
  });
  it("concurrent equal creates converge to one row and one audit without an aborted-transaction recovery query", async () => {
    const c = await seed("practice-a", "race"), p = input(c, "race-key");
    let begun = 0, release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const racing = createActivityServiceV2(createPinnedOwnershipUnit({ connect: async () => {
      const client = await pool.connect(); return { query: async (sql: string, values?: unknown[]) => {
        if (sql === "BEGIN") { begun++; if (begun === 2) release(); await barrier; } return client.query(sql, values);
      }, release: (destroy?: boolean) => client.release(destroy) } as any;
    } }), { clock: now });
    const results = await Promise.all([racing.create(request("practice-a"), p), racing.create(request("practice-a"), p)]);
    expect(results.filter(r => r.created)).toHaveLength(1); expect(results[0].activity).toEqual(results[1].activity);
    const id = results[0].activity.activityId;
    expect((await f.client.query("SELECT observation_id FROM observations WHERE observation_id=$1", [id])).rows).toHaveLength(1);
    expect((await f.client.query("SELECT audit_event_id FROM audit_events WHERE entity_type='observations' AND entity_id=$1", [JSON.stringify([id])])).rows).toHaveLength(1);
  });
  it("actual COMMIT acknowledgement loss destroys the client, then owned lookup and deliberate equal retry reconcile one saved event", async () => {
    const c = await seed("practice-a", "lost-ack"), p = input(c, "lost-ack-key"); let destroyed = false;
    const losing = createActivityServiceV2(createPinnedOwnershipUnit({ connect: async () => {
      const client = await pool.connect(); return { query: async (sql: string, values?: unknown[]) => {
        const result = await client.query(sql, values); if (sql === "COMMIT") throw Error("Synthetic lost acknowledgement"); return result;
      }, release: (destroy?: boolean) => { destroyed = destroy === true; client.release(destroy); } } as any;
    } }), { clock: now });
    await expect(losing.create(request("practice-a"), p)).rejects.toMatchObject({ status: 503 }); expect(destroyed).toBe(true);
    const saved = (await service.submission(request("practice-a"), p.submissionKey)).activity, before = await snapshot();
    expect(await service.create(request("practice-a"), p)).toEqual({ created: false, submissionKey:p.submissionKey,activity: saved }); expect(await snapshot()).toBe(before);
    expect((await f.client.query("SELECT audit_event_id FROM audit_events WHERE entity_type='observations' AND entity_id=$1", [JSON.stringify([saved.activityId])])).rows).toHaveLength(1);
  });
  it("late observation/audit SQL failures roll back all rows, with no attempt to recover in the aborted unit", async () => {
    const c = await seed("practice-a", "rollback");
    for (const table of ["observations", "audit_events"]) {
      await f.client.query(`CREATE FUNCTION reject_practice() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private synthetic failure'; END $$;
        CREATE TRIGGER reject_practice BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_practice()`);
      try { await unchanged(() => service.create(request("practice-a"), input(c, "rollback-" + table)), 503); }
      finally { await f.client.query(`DROP TRIGGER reject_practice ON ${table}; DROP FUNCTION reject_practice()`); }
    }
  });
  it("reasoned corrections replace raw fields atomically, retain immutable identity, and expose key-correlated reconciliation",async()=>{
    const c=await seed("practice-a","correction"),p={...input(c,"correction-create",12),notes:"Original note",context:{description:"Original context"}},first=await service.create(request("practice-a"),p);
    const edit={...correction(first.activity,"edit-one",0),notes:"Corrected note"},saved=await service.edit(request("practice-a"),first.activity.activityId,edit);
    expect(saved).toMatchObject({mutationKey:edit.mutationKey,changed:true,operation:"edit",activity:{activityId:first.activity.activityId,domainId:c.domainId,notes:"Corrected note",deletedAt:null}});
    expect(saved.activity.values["m-cupcakes"].value).toBe(0);expect(saved.activity).not.toHaveProperty("context");expect(saved.activity.configuration).toEqual(c);
    expect(saved.activity.stateFingerprint).not.toBe(first.activity.stateFingerprint);expect(saved.appliedStateFingerprint).toBe(saved.activity.stateFingerprint);
    const audits=await updates(first.activity.activityId);expect(audits).toHaveLength(1);expect(audits[0].reason).toBe(edit.reason);
    for(const snapshot of [audits[0].before,audits[0].after]) {expect(Object.keys(snapshot)).toHaveLength(13);expect(snapshot).not.toHaveProperty("__personal_millisecond_time");expect(snapshot).not.toHaveProperty("__personal_deleted_millisecond_time");}
    expect(audits[0].before.observation.notes).toBe("Original note");expect(audits[0].after.observation.values["m-cupcakes"].value).toBe(0);
    const before=await snapshot();expect(await service.mutation(request("practice-a"),first.activity.activityId,edit.mutationKey)).toEqual({...saved,changed:false});
    expect(await service.edit(request("practice-a"),first.activity.activityId,edit)).toEqual({...saved,changed:false});expect(await snapshot()).toBe(before);
    expect((await service.submission(request("practice-a"),p.submissionKey))).toEqual({submissionKey:p.submissionKey,activity:saved.activity});
    expect((await service.create(request("practice-a"),p))).toEqual({created:false,submissionKey:p.submissionKey,activity:saved.activity});expect(await snapshot()).toBe(before);
  });
  it("edits every declared raw value kind without converting units or manufacturing duration",async()=>{
    for(let i=0;i<MEASUREMENTS.length;i++){
      const m=MEASUREMENTS[i],c=await seed("practice-a","edit-kind-"+i,m,m.valueType==="boolean"?true:20);
      const first=(await service.create(request("practice-a"),input(c,"edit-kind-create-"+i,m.valueType==="boolean"?false:0))).activity;
      const source=input(c,"unused",m.valueType==="boolean"?true:2);
      const edited=await service.edit(request("practice-a"),first.activityId,{mutationKey:"edit-kind-"+i,expectedStateFingerprint:first.stateFingerprint,
        reason:"Correct synthetic typed amount",policyVersionId:c.policyVersionId,practiceEvent:true,observedAt:first.observedAt,values:source.values});
      expect(edited.activity.values[m.measurementId]).toEqual(source.values[m.measurementId]);expect(edited.activity.configuration).toEqual(c);
      expect(edited.activity).not.toHaveProperty("durationMinutes");expect(edited.activity.scoreAvailability).toBe("not_calculated");
    }
  });
  it("first no-ops consume no mutation key, while stale fingerprints and reused changed requests cannot overwrite",async()=>{
    const c=await seed("practice-a","no-op"),first=(await service.create(request("practice-a"),input(c,"no-op-create"))).activity;
    const p=correction(first,"reusable-no-op",12);await unchanged(()=>service.edit(request("practice-a"),first.activityId,p),400);
    await unchanged(()=>service.restore(request("practice-a"),first.activityId,lifecycle(first,"restore-no-op")),400);
    await unchanged(()=>service.mutation(request("practice-a"),first.activityId,p.mutationKey),404);expect(await updates(first.activityId)).toHaveLength(0);
    const saved=await service.edit(request("practice-a"),first.activityId,{...p,values:correction(first,p.mutationKey,9).values});
    for(const altered of [{...p,values:correction(first,p.mutationKey,10).values},{...p,reason:"A changed reason",values:saved.activity.values},
      {...correction(first,"stale-key",10)}, {...correction(saved.activity,p.mutationKey,9)}])
      await unchanged(()=>service.edit(request("practice-a"),first.activityId,altered),400);
    await unchanged(()=>service.delete(request("practice-a"),first.activityId,{...lifecycle(first,p.mutationKey)}),400);
    expect(await updates(first.activityId)).toHaveLength(1);
  });
  it("delete/restore retries retain the persisted delete instant and acknowledge current later state without resurrecting",async()=>{
    const c=await seed("practice-a","lifecycle"),p=input(c,"lifecycle-create"),first=(await service.create(request("practice-a"),p)).activity;
    const del=lifecycle(first,"delete-one"),deleted=await service.delete(request("practice-a"),first.activityId,del);
    expect(deleted.activity.deletedAt).toBe(now().toISOString());expect(deleted.changed).toBe(true);expect(deleted.operation).toBe("delete");
    await unchanged(()=>service.delete(request("practice-a"),first.activityId,lifecycle(deleted.activity,"delete-no-op")),400);
    await unchanged(()=>service.edit(request("practice-a"),first.activityId,correction(deleted.activity,"edit-deleted")),400);
    const replayClock=createActivityServiceV2(createPinnedOwnershipUnit(pool),{clock:()=>{throw Error("Equal committed retry must not read a new clock");}});
    const before=await snapshot();expect(await replayClock.delete(request("practice-a"),first.activityId,del)).toEqual({...deleted,changed:false});
    expect((await service.create(request("practice-a"),p)).activity.deletedAt).toBe(deleted.activity.deletedAt);expect(await snapshot()).toBe(before);
    const restore=lifecycle(deleted.activity,"restore-one"),restored=await service.restore(request("practice-a"),first.activityId,restore);
    expect(restored.activity.deletedAt).toBeNull();expect(restored.appliedStateFingerprint).toBe(first.stateFingerprint);
    const edited=await service.edit(request("practice-a"),first.activityId,correction(restored.activity,"edit-after-restore",10));
    const after=await snapshot(),old=await replayClock.delete(request("practice-a"),first.activityId,del);
    expect(old.activity).toEqual(edited.activity);expect(old.appliedStateFingerprint).toBe(deleted.appliedStateFingerprint);
    expect(await service.restore(request("practice-a"),first.activityId,restore)).toMatchObject({changed:false,activity:edited.activity,appliedStateFingerprint:restored.appliedStateFingerprint});
    expect(await snapshot()).toBe(after);expect(await updates(first.activityId)).toHaveLength(3);
  });
  it("new edit/restore gates active custom history but inactive or subsequently bound manual events can still be deleted",async()=>{
    const c=await seed("practice-a","inactive-correction"),first=(await service.create(request("practice-a"),input(c,"inactive-correction-create"))).activity;
    await f.client.query("UPDATE domains SET deactivated_at='2026-02-01' WHERE domain_id=$1",[c.domainId]);
    await unchanged(()=>service.edit(request("practice-a"),first.activityId,correction(first,"inactive-edit")),400);
    const deleted=await service.delete(request("practice-a"),first.activityId,lifecycle(first,"inactive-delete"));
    await unchanged(()=>service.restore(request("practice-a"),first.activityId,lifecycle(deleted.activity,"inactive-restore")),400);
    await f.client.query("UPDATE domains SET deactivated_at=NULL WHERE domain_id=$1",[c.domainId]);
    const context=await createOrgContextResolver(f.db)(request("practice-a"));await createPolicyV2Storage(f.db,context).bindings.create({bindingId:"after-personal-binding",
      domainId:c.domainId,sourceKind:"manual-legacy",externalId:"after-personal-binding"},"Synthetic later writer binding");
    await unchanged(()=>service.restore(request("practice-a"),first.activityId,lifecycle(deleted.activity,"legacy-restore")),400);
    // An already committed delete still acknowledges even after the writer/state changed.
    expect((await service.delete(request("practice-a"),first.activityId,lifecycle(first,"inactive-delete")))).toMatchObject({changed:false,activity:deleted.activity});
  });
  it("corrections select the exact historical half-open policy and reject wrong successors or manufactured frequency amounts",async()=>{
    const c=await seed("practice-a","correct-history"),context=await createOrgContextResolver(f.db)(request("practice-a"));
    const next={...structuredClone(c),revision:2,previousVersionId:c.policyVersionId,policyVersionId:"correct-history-v2",effectiveFrom:"2026-02-01T00:00:00.125Z"};
    await createPolicyV2Storage(f.db,context,{clock:()=>new Date(c.effectiveFrom)}).policies.append(next,"Synthetic historical successor");
    const first=(await service.create(request("practice-a"),input(c,"correct-history-create"))).activity;
    await unchanged(()=>service.edit(request("practice-a"),first.activityId,{...correction(first,"bad-boundary"),observedAt:next.effectiveFrom}),400);
    const changed=await service.edit(request("practice-a"),first.activityId,{...correction(first,"correct-boundary"),policyVersionId:next.policyVersionId,observedAt:next.effectiveFrom});
    expect(changed.activity.configuration).toEqual(next);expect(changed.activity.observedAt).toBe(next.effectiveFrom);
    await unchanged(()=>service.edit(request("practice-a"),first.activityId,{...correction(changed.activity,"foreign-correction"),policyVersionId:configs.b.policyVersionId}),404);
    const frequency=FREQUENCY_CASES[0].configuration.measurements.find(m=>m.kind==="frequency")!;
    const fc=await seed("practice-a","correct-frequency",MEASUREMENTS[2],12,c=>({...c,measurements:[frequency],targets:{normal:{targetId:"frequency-target",conditions:[conditionFor(frequency,3)]}}}));
    const ffirst=(await service.create(request("practice-a"),{submissionKey:"frequency-correct-create",domainId:fc.domainId,policyVersionId:fc.policyVersionId,practiceEvent:true,observedAt:"2026-01-10T00:00:00Z",values:{}})).activity;
    const fedit={...correction(ffirst,"frequency-edit"),observedAt:"2026-01-11T00:00:00Z",values:{}};
    expect((await service.edit(request("practice-a"),ffirst.activityId,fedit)).activity.values).toEqual({});
    await unchanged(()=>service.edit(request("practice-a"),ffirst.activityId,{...fedit,mutationKey:"frequency-total",values:{[frequency.measurementId]:{valueType:"integer",value:3,unitId:frequency.unit.unitId}}}),400);
  });
  it("parallel equal mutation keys converge; different stale edits admit one winner without losing updates",async()=>{
    const c=await seed("practice-a","mutation-race"),first=(await service.create(request("practice-a"),input(c,"mutation-race-create"))).activity,p=correction(first,"equal-race",9);
    const equal=await Promise.all([service.edit(request("practice-a"),first.activityId,p),service.edit(request("practice-a"),first.activityId,p)]);
    expect(equal.filter(r=>r.changed)).toHaveLength(1);expect(equal[0].activity).toEqual(equal[1].activity);expect(await updates(first.activityId)).toHaveLength(1);
    const results=await Promise.allSettled([service.edit(request("practice-a"),first.activityId,correction(equal[0].activity,"stale-race-one",10)),
      service.edit(request("practice-a"),first.activityId,correction(equal[0].activity,"stale-race-two",11))]);
    expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
    const rejected=results.find(r=>r.status==="rejected") as PromiseRejectedResult;expect(rejected.reason).toMatchObject({status:400});expect(await updates(first.activityId)).toHaveLength(2);
  });
  it("actual COMMIT acknowledgement loss on every mutation disposes its client and reconciles the owned key without a second audit",async()=>{
    const c=await seed("practice-a","mutation-lost-ack");let activity=(await service.create(request("practice-a"),input(c,"mutation-lost-create"))).activity;
    for(const operation of ["edit","delete","restore"] as const){
      let destroyed=false;const losing=createActivityServiceV2(createPinnedOwnershipUnit({connect:async()=>{const client=await pool.connect();return{
        query:async(sql:string,values?:unknown[])=>{const result=await client.query(sql,values);if(sql==="COMMIT")throw Error("Synthetic lost mutation acknowledgement");return result;},
        release:(destroy?:boolean)=>{destroyed=destroy===true;client.release(destroy);}} as any;}}),{clock:now});
      const p=operation==="edit"?correction(activity,"lost-"+operation):lifecycle(activity,"lost-"+operation);
      const apply=(s:typeof service)=>operation==="edit"?s.edit(request("practice-a"),activity.activityId,p):operation==="delete"?
        s.delete(request("practice-a"),activity.activityId,p):s.restore(request("practice-a"),activity.activityId,p);
      await expect(apply(losing)).rejects.toMatchObject({status:503});expect(destroyed).toBe(true);
      const saved=await service.mutation(request("practice-a"),activity.activityId,p.mutationKey),before=await snapshot(),count=(await updates(activity.activityId)).length;
      expect(saved).toMatchObject({mutationKey:p.mutationKey,operation,changed:false});expect(await apply(service)).toEqual(saved);
      expect(await snapshot()).toBe(before);expect(await updates(activity.activityId)).toHaveLength(count);activity=saved.activity;
    }
    expect(await updates(activity.activityId)).toHaveLength(3);
  });
  it("failed correction UPDATE or audit insertion rolls back both state and reasoned lineage",async()=>{
    const c=await seed("practice-a","mutation-rollback"),activity=(await service.create(request("practice-a"),input(c,"mutation-rollback-create"))).activity;
    for(const table of ["observations","audit_events"]){const event=table==="observations"?"UPDATE":"INSERT";
      await f.client.query(`CREATE FUNCTION reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private synthetic mutation failure'; END $$;
        CREATE TRIGGER reject_mutation BEFORE ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_mutation()`);
      try {await unchanged(()=>service.edit(request("practice-a"),activity.activityId,correction(activity,"rollback-"+table)),503);}
      finally {await f.client.query(`DROP TRIGGER reject_mutation ON ${table}; DROP FUNCTION reject_mutation()`);}
      await unchanged(()=>service.mutation(request("practice-a"),activity.activityId,"rollback-"+table),404);
    }
  });
  it("owned mutation lineage masks foreign rows and fails closed on duplicate or malformed scoped audits",async()=>{
    const c=await seed("practice-a","mutation-evidence"),activity=(await service.create(request("practice-a"),input(c,"mutation-evidence-create"))).activity,p=correction(activity,"evidence-edit"),saved=await service.edit(request("practice-a"),activity.activityId,p);
    for(const actor of ["practice-b","practice-c"])for(const call of [()=>service.mutation(request(actor),activity.activityId,p.mutationKey),
      ()=>service.edit(request(actor),activity.activityId,p),()=>service.delete(request(actor),activity.activityId,lifecycle(saved.activity,"foreign-delete")),()=>service.restore(request(actor),activity.activityId,lifecycle(saved.activity,"foreign-restore"))])await unchanged(call,404);
    const audit=(await updates(activity.activityId))[0];await f.client.query(`INSERT INTO audit_events(audit_event_id,org_id,actor_kind,actor_user_id,entity_type,entity_id,action,occurred_at,reason,"before","after")
      SELECT 'mutation-duplicate',org_id,actor_kind,actor_user_id,entity_type,entity_id,action,occurred_at,reason,"before","after" FROM audit_events WHERE audit_event_id=$1`,[audit.audit_event_id]);
    try {await unchanged(()=>service.mutation(request("practice-a"),activity.activityId,p.mutationKey),503);await unchanged(()=>service.edit(request("practice-a"),activity.activityId,p),503);}
    finally {await f.client.query("DELETE FROM audit_events WHERE audit_event_id='mutation-duplicate'");}
    await f.client.query(`UPDATE audit_events SET "after"=jsonb_set("after",'{domain_id}','"foreign-domain"') WHERE audit_event_id=$1`,[audit.audit_event_id]);
    try {await unchanged(()=>service.mutation(request("practice-a"),activity.activityId,p.mutationKey),503);}
    finally {await f.client.query('UPDATE audit_events SET "after"=$2::jsonb WHERE audit_event_id=$1',[audit.audit_event_id,JSON.stringify(audit.after)]);}
    const foreignOwned=await seed("practice-a","mutation-foreign-owned"),move=(snapshot:any)=>({...structuredClone(snapshot),domain_id:foreignOwned.domainId,
      policy_version_id:foreignOwned.policyVersionId,observation:{...structuredClone(snapshot.observation),domainId:foreignOwned.domainId,policyVersionId:foreignOwned.policyVersionId}});
    await f.client.query('UPDATE audit_events SET "before"=$2::jsonb,"after"=$3::jsonb WHERE audit_event_id=$1',[audit.audit_event_id,JSON.stringify(move(audit.before)),JSON.stringify(move(audit.after))]);
    try {await unchanged(()=>service.mutation(request("practice-a"),activity.activityId,p.mutationKey),503);await unchanged(()=>service.edit(request("practice-a"),activity.activityId,p),503);}
    finally {await f.client.query('UPDATE audit_events SET "before"=$2::jsonb,"after"=$3::jsonb WHERE audit_event_id=$1',[audit.audit_event_id,JSON.stringify(audit.before),JSON.stringify(audit.after)]);}
    await unchanged(()=>service.mutation(request("practice-a"),activity.activityId,"not-committed"),404);
  });
  it("bounded stable paging traverses ties exactly once and excludes legacy/old observation namespaces", async () => {
    const c = await seed("practice-a", "paging");
    for (let i = 0; i < 5; i++) await service.create(request("practice-a"), input(c, "page-" + i));
    const all = await service.list(request("practice-a"), { domainId: c.domainId, limit: 100 }), ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await service.list(request("practice-a"), { domainId: c.domainId, limit: 2, ...(cursor ? { cursor } : {}) });
      ids.push(...page.activities.map(a => a.activityId)); cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(ids).toEqual(all.activities.map(a => a.activityId)); expect(new Set(ids).size).toBe(5);
    const page = await service.list(request("practice-a"), { domainId: c.domainId, limit: 1 });
    await unchanged(() => service.list(request("practice-b"), { cursor: page.nextCursor!, limit: 2 }), 400);
    await unchanged(() => service.list(request("practice-a"), { domainId: configs.a.domainId, cursor: page.nextCursor!, limit: 2 }), 400);
    await unchanged(() => service.list(request("practice-a"), { cursor: "malformed" }), 400);
    expect((await f.client.query("SELECT user_id FROM sessions WHERE id='unassigned-practice'")).rows[0].user_id).toBeNull();
  });
});
