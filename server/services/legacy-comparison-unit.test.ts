import { beforeAll, afterAll, beforeEach, it, expect, vi } from "vitest";
import { Pool } from "pg";
import { startFixture, verifyFixture } from "../lib/ownership-fixture";
import { createPinnedOwnershipUnit } from "../lib/pinned-ownership-unit";
import { createOrgContextResolver, BoundaryError, assertContext } from "../lib/org-context";
import { seedPolicyV2 } from "../lib/seed-policy-v2";
import { importLegacyObservations } from "./legacy-observation-sync";
import { createLegacyActivityMutations, createLegacyComparisonUnit, isLegacyComparisonUnit, type LegacyComparisonBatch } from "./legacy-activity-mutations";
import { createPolicyV2Storage } from "../storage/policy-v2-storage";
import { configurationFor, observationFor, MEASUREMENTS } from "../../shared/fixtures/domain-config-cases";
import type { DomainConfiguration } from "../../shared/domain-config";

let f: Awaited<ReturnType<typeof startFixture>>, pool: Pool;
const asOf = "2026-01-15T12:00:00.000Z";
const clock = () => new Date(asOf);
const request = (actor: string) => ({ isAuthenticated: () => true, user: { claims: { sub: actor } } });
const slugs = ["martial-arts", "meditation", "fitness", "music"];
const tables = ["users", "sessions", "session_edits", "user_settings", "deviations", "http_sessions",
  "organizations", "organization_members", "domains", "policy_versions", "dimension_definitions",
  "source_bindings", "observations", "audit_events", "deviations_v2", "deviation_domains",
  "evaluation_results", "owner_write_resource_budgets"];
async function snapshot() {
  const result: Record<string, unknown> = {};
  for (const table of tables)
    result[table] = (await f.client.query("SELECT to_jsonb(t) row FROM public." + table + " t ORDER BY to_jsonb(t)::text")).rows;
  return JSON.stringify(result);
}
async function owner(actor: string) {
  await f.client.query("INSERT INTO users(id,created_at) VALUES($1,'2025-12-01T00:00:00Z')", [actor]);
  await f.client.query("INSERT INTO user_settings(user_id,timezone,day_start_hour,window_days) VALUES($1,'America/New_York',6,14)", [actor]);
  for (const slug of slugs)
    await f.client.query("INSERT INTO sessions(id,user_id,domain,duration_minutes,timestamp,notes,is_anomaly,anomaly_note) " +
      "VALUES($1,$2,$3,10,'2026-01-03T12:00:00.000Z',$4,$5,$6)",
    [actor + "-" + slug, actor, slug, "Private synthetic practice " + actor, slug === "fitness",
      slug === "fitness" ? "Private synthetic anomaly " + actor : null]);
  await seedPolicyV2(f.db, request(actor));
  await importLegacyObservations(f.db, request(actor));
  return actor;
}
function comparison() { return createLegacyComparisonUnit(createPinnedOwnershipUnit(pool), { clock }); }
async function addNative(actor: string, observationId: string, domainId?: string) {
  const context = await createOrgContextResolver(f.db)(request(actor));
  const store = createPolicyV2Storage(f.db, context, { clock: () => new Date("2025-12-31T00:00:00Z") });
  let configuration: DomainConfiguration;
  if (domainId) {
    const policies = await store.policies.list();
    const policy = policies.filter(row => row.domain_id === domainId).sort((a,b) => a.revision - b.revision).at(-1);
    if (!policy) throw Error("Missing synthetic legacy policy");
    configuration = policy.configuration;
  } else {
    configuration = { ...configurationFor(observationId, MEASUREMENTS[1], 10),
      organizationId: context.orgId, ownerUserId: actor };
    await store.domains.create({ domainId: configuration.domainId, slug: "custom-" + observationId, displayName: "Synthetic custom practice" }, "Synthetic custom domain");
    await store.policies.append(configuration, "Synthetic custom policy");
  }
  const observation = { ...observationFor(configuration, observationId, 7), observedAt: "2026-01-04T12:00:00.000Z" };
  await store.observations.create({ observation, idempotencyKey: observationId }, "Synthetic native practice");
  return { domainId: configuration.domainId, observationId };
}
beforeAll(async () => {
  f = await startFixture("legacy-comparison-unit"); verifyFixture(f.root);
  pool = new Pool({ host: f.root + "/socket", port: 5432, user: "synthetic", database: "postgres", password: "", ssl: false,
    max: 4, connectionTimeoutMillis: 5000, options: "-c statement_timeout=10000 -c lock_timeout=5000" });
}, 60000);
afterAll(async () => { try { if (pool) await pool.end(); } finally { if (f) await f.cleanup(); } }, 60000);
beforeEach(async () => { if (f) await f.client.query("DELETE FROM public.owner_write_resource_budgets"); });

it("rejects malformed authentication and request-supplied authority before connecting, and brands only genuine units", async () => {
  let connects = 0;
  const unit = createLegacyComparisonUnit(createPinnedOwnershipUnit({
    connect: async () => { connects++; throw Error("Forbidden synthetic connection"); },
  } as any), { clock });
  expect(isLegacyComparisonUnit(unit)).toBe(true);
  expect(isLegacyComparisonUnit({ ...unit })).toBe(false);
  expect(isLegacyComparisonUnit(null)).toBe(false);
  for (const req of [{}, request("__proto__"), { ...request("synthetic"), isAuthenticated: () => false },
    { headers: { "x-user-id": "synthetic" } }])
    await expect(Promise.resolve().then(() => unit.run(req as any, async () => true))).rejects.toMatchObject({ status: 401 });
  for (const field of ["body", "query", "params"])
    await expect(Promise.resolve().then(() => unit.run({ ...request("synthetic"), [field]: { ownerUserId: "foreign" } } as any,
      async () => true))).rejects.toMatchObject({ status: 400 });
  expect(connects).toBe(0);
});

it("captures real legacy and shadow ownership, actual legacy settings, deleted rows and anomalies without writing", async () => {
  const actor = await owner("comparison-legacy-shadow");
  const mutations = createLegacyActivityMutations(createPinnedOwnershipUnit(pool));
  await mutations.softDelete(request(actor), actor + "-music");
  const options = { clock };
  const unit = createLegacyComparisonUnit(createPinnedOwnershipUnit(pool), options), before = await snapshot();
  options.clock = () => new Date("2026-02-15T12:00:00.000Z");
  let org = "", firstFingerprint = "";
  const result = await unit.run(request(actor), async batch => {
    assertContext(batch.db, batch.context);
    expect(batch.context).toMatchObject({ actorUserId: actor, role: "owner", rolloutMode: "legacy" });
    org = batch.context.orgId;
    expect(batch.asOf).toBe(asOf);
    expect(batch.legacyOptions).toMatchObject({ dayStartHour: 6, timezone: "America/New_York", windowDays: 14 });
    expect(batch.legacyOptions.now?.toISOString()).toBe(asOf);
    expect(batch.legacyOptions.userCreatedAt?.toISOString()).toBe("2025-12-01T00:00:00.000Z");
    expect(batch.reconciliation.clean).toBe(true);
    expect(batch.sources.map(source => source.slug).sort()).toEqual([...slugs].sort());
    expect(batch.sources.every(source => source.legacySessions.every(row => row.userId === actor))).toBe(true);
    expect(batch.sources.find(source => source.slug === "music")!.legacySessions[0].deletedAt).not.toBeNull();
    expect(batch.sources.find(source => source.slug === "fitness")!.legacySessions[0].isAnomaly).toBe(true);
    expect(batch.sources.every(source => source.canonicalObservationIds.length === 1 && source.nativeObservationIds.length === 0)).toBe(true);
    expect(batch.snapshotFingerprint).toMatch(/^[a-f0-9]{64}$/);
    firstFingerprint = batch.snapshotFingerprint;
    return "captured";
  });
  expect(result).toEqual({ status: "completed", value: "captured" });
  expect(await snapshot()).toBe(before);
  expect(await unit.run(request(actor), async batch => batch.snapshotFingerprint))
    .toEqual({ status: "completed", value: firstFingerprint });
  await f.client.query("UPDATE organizations SET rollout_mode='shadow' WHERE org_id=$1", [org]);
  const shadowBefore = await snapshot();
  expect(await unit.run(request(actor), async batch => ({ mode: batch.context.rolloutMode, count: batch.sources.length })))
    .toEqual({ status: "completed", value: { mode: "shadow", count: 4 } });
  await expect(mutations.create(request(actor), { domain: "music", durationMinutes: 1, timestamp: asOf }))
    .rejects.toMatchObject({ status: 403 });
  await expect(importLegacyObservations(f.db, request(actor))).rejects.toMatchObject({ status: 403 });
  expect(await snapshot()).toBe(shadowBefore);
  await f.client.query("UPDATE organizations SET rollout_mode='v2' WHERE org_id=$1", [org]);
  const v2Before = await snapshot(), v2Operation = vi.fn(async () => true);
  await expect(unit.run(request(actor), v2Operation)).rejects.toMatchObject({ status: 403 });
  expect(v2Operation).not.toHaveBeenCalled(); expect(await snapshot()).toBe(v2Before);
  await f.client.query("UPDATE organizations SET rollout_mode='legacy' WHERE org_id=$1", [org]);
  await f.client.query("UPDATE organization_members SET role='member' WHERE user_id=$1", [actor]);
  const memberBefore = await snapshot(), operation = vi.fn(async () => true);
  await expect(unit.run(request(actor), operation)).rejects.toMatchObject({ status: 403 });
  expect(operation).not.toHaveBeenCalled(); expect(await snapshot()).toBe(memberBefore);
});

it("blocks unexplained legacy drift before the callback, result audit or admission and does not repair records", async () => {
  const actor = await owner("comparison-drift"), unit = comparison(), operation = vi.fn(async () => true);
  await f.client.query("UPDATE sessions SET notes='Deliberate synthetic drift' WHERE id=$1", [actor + "-music"]);
  const before = await snapshot();
  expect(await unit.run(request(actor), operation)).toEqual({ status: "unavailable", reason: "reconciliation_failed" });
  expect(operation).not.toHaveBeenCalled(); expect(await snapshot()).toBe(before);
});

it("retains native/custom evidence honestly and never relabels malformed legacy provenance as native", async () => {
  const actor = await owner("comparison-native"), unit = comparison();
  const original = await unit.run(request(actor), async batch => ({ fingerprint: batch.snapshotFingerprint,
    music: batch.sources.find(source => source.slug === "music")!.domainId }));
  if (original.status !== "completed") throw Error("Synthetic initial comparison unavailable");
  const custom = await addNative(actor, "comparison-custom-native");
  const mixed = await addNative(actor, "comparison-native-in-legacy", original.value.music);
  const before = await snapshot();
  const result = await unit.run(request(actor), async batch => {
    expect(batch.snapshotFingerprint).not.toBe(original.value.fingerprint);
    expect(batch.unsupported.some(row => row.domainId === custom.domainId && typeof row.reason === "string" && row.reason.length > 0)).toBe(true);
    const music = batch.sources.find(source => source.domainId === mixed.domainId)!;
    expect(music.canonicalObservationIds).not.toContain(mixed.observationId);
    expect(music.nativeObservationIds).toContain(mixed.observationId);
    expect(batch.canonicalRows.some((row:any) => row.observation_id === custom.observationId)).toBe(true);
    expect(batch.nativeEvidence.some((row:any) => row.observation_id === mixed.observationId)).toBe(true);
    return true;
  });
  expect(result).toEqual({ status: "completed", value: true }); expect(await snapshot()).toBe(before);
  await f.client.query("UPDATE observations SET legacy_source_type='sessions',legacy_source_id='unknown-synthetic-source' WHERE observation_id=$1",
    [mixed.observationId]);
  const corrupted = await snapshot(), operation = vi.fn(async () => true);
  expect(await unit.run(request(actor), operation)).toEqual({ status: "unavailable", reason: "reconciliation_failed" });
  expect(operation).not.toHaveBeenCalled(); expect(await snapshot()).toBe(corrupted);
});

it("does not treat a free-form preservation reason on an ordinary native domain or binding as legacy proof", async () => {
  const actor = await owner("comparison-reason-is-not-proof"), unit = comparison();
  const initial = await unit.run(request(actor), async batch => ({ domainIds: batch.sources.map(source => source.domainId).sort(),
    fingerprint: batch.snapshotFingerprint }));
  if (initial.status !== "completed") throw Error("Synthetic initial comparison unavailable");
  const context = await createOrgContextResolver(f.db)(request(actor));
  const store = createPolicyV2Storage(f.db, context, { clock: () => new Date("2025-12-31T00:00:00Z") });
  const configuration = { ...configurationFor("comparison-reason-native", MEASUREMENTS[2], 12),
    organizationId: context.orgId, ownerUserId: actor };
  const reason = "Preserve authenticated owner's established legacy policy";
  await store.domains.create({ domainId: configuration.domainId, slug: "ordinary-native-cupcakes", displayName: "Ordinary native practice" }, reason);
  await store.policies.append(configuration, reason);
  const bindingId = "comparison-reason-native-binding";
  await store.bindings.create({ bindingId, domainId: configuration.domainId, sourceKind: "manual-native",
    externalId: "ordinary-native-cupcakes", metadata: { description: "ordinary" } }, reason);
  const observation = { ...observationFor(configuration, "comparison-reason-native-observation", 6),
    observedAt: "2026-01-04T12:00:00.000Z" };
  await store.observations.create({ observation, idempotencyKey: observation.observationId, sourceBindingId: bindingId }, reason);
  const before = await snapshot();
  expect(await unit.run(request(actor), async batch => {
    expect(batch.sources.map(source => source.domainId).sort()).toEqual(initial.value.domainIds);
    expect(batch.sources).toHaveLength(4);
    expect(batch.snapshotFingerprint).not.toBe(initial.value.fingerprint);
    expect(batch.unsupported.some(row => row.domainId === configuration.domainId && typeof row.reason === "string" && row.reason.length > 0)).toBe(true);
    expect(batch.canonicalRows.some((row:any) => row.observation_id === observation.observationId)).toBe(true);
    expect(batch.nativeEvidence.some((row:any) => row.observation_id === observation.observationId)).toBe(true);
    return true;
  })).toEqual({ status: "completed", value: true });
  expect(await snapshot()).toBe(before);
});

it("accepts an audited display-name cycle in chronological order without treating a repeated caption as drift", async () => {
  const actor = await owner("comparison-caption-cycle"), unit = comparison();
  const context = await createOrgContextResolver(f.db)(request(actor));
  const store = createPolicyV2Storage(f.db, context), domain = (await store.domains.list()).find(row => row.slug === "music")!;
  const originalCaption = domain.display_name;
  await store.domains.update([domain.domain_id], { displayName: "Synthetic caption B" }, "Synthetic caption A to B");
  await store.domains.update([domain.domain_id], { displayName: originalCaption }, "Synthetic caption B to A");
  await store.domains.update([domain.domain_id], { displayName: "Synthetic caption C" }, "Synthetic caption A to C");
  const audit = (await f.client.query("SELECT count(*)::int count,count(DISTINCT occurred_at)::int instants " +
    "FROM audit_events WHERE actor_user_id=$1 AND entity_type='domains' AND entity_id=$2 AND action='update'",
  [actor, JSON.stringify([domain.domain_id])])).rows[0];
  // The fixture has a real, strictly ordered microsecond audit sequence.
  expect(audit).toEqual({ count: 3, instants: 3 });
  const before = await snapshot();
  expect(await unit.run(request(actor), async batch => {
    expect(batch.reconciliation.clean).toBe(true);
    expect(batch.sources.some(source => source.domainId === domain.domain_id)).toBe(true);
    return true;
  })).toEqual({ status: "completed", value: true });
  expect(await snapshot()).toBe(before);
});

it("reports a missing genuine legacy mirror as reconciliation failure without invoking the callback or repairing data", async () => {
  const actor = await owner("comparison-missing-mirror"), unit = comparison();
  const removed = await f.client.query("DELETE FROM observations WHERE owner_user_id=$1 AND legacy_source_type='sessions' AND legacy_source_id=$2",
    [actor, actor + "-music"]);
  expect(removed.rowCount).toBe(1);
  const before = await snapshot(), operation = vi.fn(async () => true);
  expect(await unit.run(request(actor), operation)).toEqual({ status: "unavailable", reason: "reconciliation_failed" });
  expect(operation).not.toHaveBeenCalled();
  expect(await snapshot()).toBe(before);
});

it("captures a genuine native-only owner without seeding legacy bindings or inventing a legacy counterpart", async () => {
  const actor = "comparison-native-only";
  await f.client.query("INSERT INTO users(id,created_at) VALUES($1,'2025-12-01T00:00:00Z')", [actor]);
  await f.client.query("INSERT INTO organizations(org_id,display_name) VALUES('comparison-native-only-org','Synthetic native workspace')");
  await f.client.query("INSERT INTO organization_members(org_id,user_id,role) VALUES('comparison-native-only-org',$1,'owner')", [actor]);
  // This owner never invokes the preservation seed or legacy import.
  const native = await addNative(actor, "comparison-only-native"), unit = comparison(), before = await snapshot();
  expect(await unit.run(request(actor), async batch => {
    expect(batch.context).toMatchObject({ actorUserId: actor, orgId: "comparison-native-only-org", role: "owner" });
    expect(batch.sources).toEqual([]);
    expect(batch.reconciliation.clean).toBe(true);
    expect(batch.reconciliation.counts).toMatchObject({ ownedSessions: 0, canonicalSessions: 0,
      importedSessions: 0, importedEdits: 0, mutationEvents: 0 });
    expect(batch.unsupported.some(row => row.domainId === native.domainId && typeof row.reason === "string" && row.reason.length > 0)).toBe(true);
    expect(batch.canonicalRows.map((row:any) => row.observation_id)).toEqual([native.observationId]);
    expect(batch.nativeEvidence.map((row:any) => row.observation_id)).toEqual([native.observationId]);
    return true;
  })).toEqual({ status: "completed", value: true });
  // Includes the write-budget table: capture neither admits a write nor seeds,
  // imports, repairs, drops native evidence or modifies any existing record.
  expect(await snapshot()).toBe(before);
});

it("binds settings and declaration changes to the source fingerprint without changing saved practices", async () => {
  const actor = await owner("comparison-settings"), unit = comparison();
  const first = await unit.run(request(actor), async batch => batch.snapshotFingerprint);
  if (first.status !== "completed") throw Error("Synthetic initial comparison unavailable");
  await f.client.query("UPDATE user_settings SET window_days=28,day_start_hour=3 WHERE user_id=$1", [actor]);
  await f.client.query("INSERT INTO deviations(id,user_id,domain,reason,start_at,end_at,exclude_from_composite) " +
    "VALUES('comparison-settings-break',$1,'music','Synthetic declared break','2026-01-14T00:00:00Z','2026-01-16T00:00:00Z',true)", [actor]);
  const before = await snapshot();
  expect(await unit.run(request(actor), async batch => {
    expect(batch.legacyOptions).toMatchObject({ windowDays: 28, dayStartHour: 3 });
    expect(batch.legacyOptions.deviations?.some(row => row.id === "comparison-settings-break")).toBe(true);
    expect(batch.snapshotFingerprint).not.toBe(first.value);
    return true;
  })).toEqual({ status: "completed", value: true });
  expect(await snapshot()).toBe(before);
});

it("rolls back derived results, audit and admission on callback failure, then permits a clean write without source fingerprint churn", async () => {
  const actor = await owner("comparison-rollback"), unit = comparison(), before = await snapshot();
  async function write(batch: LegacyComparisonBatch) {
    const store = createPolicyV2Storage(batch.db, batch.context);
    const source = batch.sources[0], policy = (await store.policies.list()).find(row => row.domain_id === source.domainId)!;
    const configuration = policy.configuration as DomainConfiguration;
    await store.evaluations.create({ resultId: "comparison-derived-rollback", domainId: source.domainId,
      policyVersionId: configuration.policyVersionId, windowStart: "2026-01-04T00:00:00Z", windowEnd: "2026-01-11T00:00:00Z",
      timezone: configuration.boundary.timezone, dayStartHour: configuration.boundary.dayStartHour,
      calculationVersion: "synthetic-comparison-write", inputFingerprint: "synthetic-comparison-input", eligibleDays: 7,
      result: { summary: "Synthetic derived output" }, components: [], explanation: { summary: "Synthetic output only" } },
    "Synthetic comparison result");
  }
  await expect(unit.run(request(actor), async batch => {
    await write(batch); throw new BoundaryError(400);
  })).rejects.toMatchObject({ status: 400 });
  expect(await snapshot()).toBe(before);
  // A callback's not-found result is not a missing mirror in the collection gate.
  await expect(unit.run(request(actor), async () => { throw new BoundaryError(404); })).rejects.toMatchObject({ status: 404 });
  expect(await snapshot()).toBe(before);
  const committed = await unit.run(request(actor), async batch => { await write(batch); return batch.snapshotFingerprint; });
  if (committed.status !== "completed") throw Error("Synthetic derived write unavailable");
  expect(await unit.run(request(actor), async batch => batch.snapshotFingerprint))
    .toEqual({ status: "completed", value: committed.value });
  expect((await f.client.query("SELECT count(*)::int count FROM evaluation_results WHERE result_id='comparison-derived-rollback'")).rows[0].count).toBe(1);
  expect((await f.client.query("SELECT count(*)::int count FROM audit_events WHERE entity_type='evaluation_results' AND actor_user_id=$1", [actor])).rows[0].count).toBe(1);
});

it("uses one NOWAIT lock set and rolls back partially acquired locks when another owner's writer already holds policy locks", async () => {
  const actor = await owner("comparison-nowait-a"), other = await owner("comparison-nowait-b");
  const otherDomain = (await f.client.query("SELECT domain_id FROM domains WHERE owner_user_id=$1 ORDER BY domain_id LIMIT 1", [other])).rows[0].domain_id;
  const writer = await pool.connect(), trace: string[] = [], afterLocksClock = vi.fn(clock);
  const unit = createLegacyComparisonUnit(createPinnedOwnershipUnit({
    connect: async () => {
      const client = await pool.connect();
      return { query: (input:any, values?:unknown[]) => {
        trace.push(typeof input === "string" ? input : input.text); return client.query(input, values);
      }, release: (destroy?:boolean) => client.release(destroy) } as any;
    },
  } as any), { clock: afterLocksClock });
  await writer.query("BEGIN");
  try {
    await writer.query("SELECT domain_id FROM domains WHERE domain_id=$1 FOR UPDATE", [otherDomain]);
    await writer.query("LOCK TABLE policy_versions IN ROW EXCLUSIVE MODE");
    const before = await snapshot(), operation = vi.fn(async () => true);
    expect(await unit.run(request(actor), operation)).toEqual({ status: "unavailable", reason: "maintenance_resource_unavailable" });
    expect(operation).not.toHaveBeenCalled(); expect(afterLocksClock).not.toHaveBeenCalled();
    const locks = trace.filter(sql => /^LOCK TABLE/.test(sql));
    expect(locks).toHaveLength(1);
    expect(locks[0]).toContain("IN SHARE ROW EXCLUSIVE MODE NOWAIT");
    expect(trace).toContain("ROLLBACK"); expect(trace).not.toContain("COMMIT");
    expect(await snapshot()).toBe(before);
    // Regression: the comparator must not retain its partial domains lock
    // while this writer keeps the conflicting policy lock.
    expect((await writer.query("UPDATE domains SET display_name=display_name WHERE domain_id=$1", [otherDomain])).rowCount).toBe(1);
  } finally { await writer.query("ROLLBACK"); writer.release(); }
  expect(await unit.run(request(actor), async () => "resumed")).toEqual({ status: "completed", value: "resumed" });
  expect(afterLocksClock).toHaveBeenCalledTimes(1);
});

it("serializes concurrent owners without blocking unrelated readers, and releases maintenance locks after completion", async () => {
  const actor = await owner("comparison-concurrent-a"), other = await owner("comparison-concurrent-b"), unit = comparison();
  let release!: () => void, entered!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const first = unit.run(request(actor), async batch => {
    expect(batch.context.actorUserId).toBe(actor); entered(); await hold; return "first";
  });
  try {
    await Promise.race([ready, first.then(() => { throw Error("Synthetic first batch never entered callback"); })]);
    const reader = await pool.connect();
    try { expect((await reader.query("SELECT count(*)::int count FROM domains")).rows[0].count).toBeGreaterThan(0); }
    finally { reader.release(); }
    const operation = vi.fn(async () => true);
    expect(await unit.run(request(other), operation)).toEqual({ status: "unavailable", reason: "maintenance_resource_unavailable" });
    expect(operation).not.toHaveBeenCalled();
  } finally { release(); await first; }
  expect(await first).toEqual({ status: "completed", value: "first" });
  expect(await unit.run(request(other), async batch => {
    expect(batch.sources.every(source => source.legacySessions.every(row => row.userId === other))).toBe(true);
    return "second";
  })).toEqual({ status: "completed", value: "second" });
});
