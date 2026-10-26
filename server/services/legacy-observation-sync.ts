import { createHash } from "node:crypto";
import { isDeepStrictEqual as equal } from "node:util";
import { ResourceLimitError, MAX_READ_ROWS } from "../lib/read-budget";
import { withTransactionReadBudget, readComplete, assertReadBytesAvailable } from "../lib/transaction-read-budget";
import { ConfigurationBundleSchema, DomainConfigurationSchema, ObservationSchema } from "../../shared/domain-config";
import { BoundaryError, bounded, createOrgContextResolver, revalidate,
  assertContext, type OwnershipDatabase, type Transaction, type OrgContext } from "../lib/org-context";

type Request = Parameters<ReturnType<typeof createOrgContextResolver>>[0];
type Row = Record<string, any>;
const slugs = ["martial-arts", "meditation", "fitness", "music"] as const;
const version = "legacy-history-import-v1";
const types = ["legacy_session_import", "legacy_edit_import"] as const;
const reason = "Import authenticated owned legacy history";
const hash = (...parts: string[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
function uid(...parts: string[]) {
  const h = hash(...parts);
  return `${h.slice(0,8)}-${h.slice(8,12)}-8${h.slice(13,16)}-${((parseInt(h[16],16)&3)|8).toString(16)}${h.slice(17,20)}-${h.slice(20,32)}`;
}
function requireValid(value: unknown): asserts value { if (!value) throw new BoundaryError(400); }
function authenticate(request: Request) {
  let actor: unknown;
  try {
    if (typeof request?.isAuthenticated !== "function" || request.isAuthenticated() !== true) throw 0;
    actor = (request.user as any)?.claims?.sub;
    if (typeof actor !== "string" || !actor.length || actor.trim() !== actor || actor.length > 200 ||
      /[\u0000-\u001f\u007f]/.test(actor) || actor === "__proto__") throw 0;
  } catch { throw new BoundaryError(401); }
  for (const key of ["body", "query", "params"]) {
    const v = (request as any)[key];
    requireValid(v == null || (typeof v === "object" && !Array.isArray(v) && Reflect.ownKeys(v).length === 0));
  }
}
// Preserve PostgreSQL microseconds, not the rounded JS Date serialization.
function instant(decoded: unknown, raw: unknown): string {
  requireValid(decoded instanceof Date && Number.isFinite(decoded.getTime()) &&
    typeof raw === "string" && Number.isFinite(Date.parse(raw)) && Date.parse(raw) === decoded.getTime());
  return raw as string;
}
function ticks(value: string): bigint {
  const ms = Date.parse(value); requireValid(Number.isFinite(ms));
  const fraction = value.match(/\.(\d+)/)?.[1] ?? "";
  requireValid(fraction.length <= 6);
  return BigInt(ms) * BigInt(1000) + BigInt(fraction.padEnd(6,"0").slice(3));
}
const json = (v: unknown) => JSON.parse(JSON.stringify(v));
// Transfer large text/JSON once. Only these native Date values are additionally
// selected, because instant() independently checks the decoded PG timestamp
// against the exact microsecond string in raw. Other columns come from raw.
const nativeDates: Record<string, readonly string[]> = {
  policy_versions:["effective_from"],sessions:["timestamp","deleted_at"],session_edits:["edited_at"],
};
async function rows(tx: Transaction, table: string, where: string, values: unknown[], order: string) {
  const dates=nativeDates[table]??[],columns=["raw",...dates];
  const projection=["to_jsonb(t) AS raw",...dates.map(column=>`t."${column}"`)].join(",");
  const result=await readComplete(tx,
    `SELECT ${projection} FROM public.${table} t WHERE ${where} ORDER BY ${order} LIMIT $${values.length+1} FOR SHARE`,
    [...values,MAX_READ_ROWS+1],columns);
  return result.map(row=>({...row.raw,...row,raw:row.raw})) as Row[];
}
type State = Awaited<ReturnType<typeof read>>;
async function read(tx: Transaction, db: OwnershipDatabase, context: OrgContext) {
  await revalidate(tx,db,context);
  const { orgId: org, actorUserId: actor } = context, scope = [org,actor];
  if (context.role !== "owner" || context.rolloutMode !== "legacy") throw new BoundaryError(403);
  const organization = (await readComplete(tx,
    "SELECT display_name,rollout_mode FROM public.organizations WHERE org_id=$1 FOR UPDATE",
    [org],["display_name","rollout_mode"],1))[0];
  const members = await readComplete(tx,
    "SELECT user_id,role FROM public.organization_members WHERE org_id=$1 ORDER BY user_id LIMIT 2 FOR SHARE",
    [org],["user_id","role"],2);
  if (organization?.display_name !== "Personal legacy workspace" || organization.rollout_mode !== "legacy" ||
    members.length !== 1 || members[0].user_id !== actor || members[0].role !== "owner") throw new BoundaryError(403);
  const scoped = (table: string, order: string) => rows(tx,table,"t.org_id=$1 AND t.owner_user_id=$2",scope,order);
  const domains = await scoped("domains","t.domain_id");
  const policies = await scoped("policy_versions","t.domain_id,t.revision");
  const dimensions = await scoped("dimension_definitions","t.policy_version_id,t.measurement_id");
  const bindings = await scoped("source_bindings","t.binding_id");
  // Import/reconciliation must see a stable complete legacy set, including new
  // inserts. Row locks alone cannot prevent legacy-table phantoms.
  await tx.query("LOCK TABLE public.sessions, public.session_edits IN SHARE MODE");
  const sessions = await rows(tx,"sessions","t.user_id=$1",[actor],"t.domain,t.timestamp,t.id");
  const edits = await rows(tx,"session_edits",
    "t.user_id=$1 OR t.session_id IN (SELECT id FROM public.sessions WHERE user_id=$1)",[actor],"t.edited_at,t.id");
  const observations = await scoped("observations","t.observation_id");
  const audits = await rows(tx,"audit_events","t.org_id=$1",[org],"t.audit_event_id");
  const unowned = Number((await tx.query("SELECT count(*)::int n FROM public.sessions WHERE user_id IS NULL")).rows[0].n);
  return { org,actor,domains,policies,dimensions,bindings,sessions,edits,observations,audits,unowned,
    batch: `${version}:${hash(org,actor)}` };
}
type Planned = { source: Row; binding: Row; policy: Row; row: Row; edits: Row[] };
function plan(s: State, comparison = false): Planned[] {
  requireValid(comparison ? s.bindings.length <= 4 && s.domains.length === s.bindings.length :
    s.domains.length === 4 && s.bindings.length === 4);
  const configurations = s.policies.map(p => {
    const parsed = DomainConfigurationSchema.safeParse(p.configuration); requireValid(parsed.success);
    const c = parsed.data;
    requireValid(c.organizationId === s.org && c.ownerUserId === s.actor && c.domainId === p.domain_id &&
      c.policyVersionId === p.policy_version_id && c.revision === p.revision &&
      (c.previousVersionId ?? null) === p.previous_version_id &&
      ticks(c.effectiveFrom) === ticks(instant(p.effective_from,p.raw.effective_from)));
    const dimensions = s.dimensions.filter(d => d.policy_version_id === p.policy_version_id);
    requireValid(dimensions.length === c.measurements.length && c.measurements.every(m =>
      dimensions.some(d => d.domain_id === c.domainId && d.measurement_id === m.measurementId && equal(d.definition,m))));
    return c;
  });
  requireValid(ConfigurationBundleSchema.safeParse({schemaVersion:1,configurations,observations:[]}).success);
  requireValid(s.dimensions.length === configurations.reduce((n,c) => n+c.measurements.length,0));
  for (const slug of comparison ? s.bindings.map(b => String(b.external_id)) : slugs) {
    const ds = s.domains.filter(d => d.slug === slug), bs = s.bindings.filter(b => b.external_id === slug);
    requireValid(ds.length === 1 && bs.length === 1);
    const d = ds[0], b = bs[0];
    requireValid(d.deactivated_at === null && d.tombstoned_at === null && b.domain_id === d.domain_id &&
      b.source_kind === "manual-legacy" && equal(b.metadata,{description:"existing-owner-seed-v1"}) &&
      configurations.some(c => c.domainId === d.domain_id));
    for (const [type,row,key] of [["domains",d,d.domain_id],["source_bindings",b,b.binding_id]] as const) {
      const a = s.audits.filter(a => a.entity_type === type && a.entity_id === JSON.stringify([key]));
      if(comparison&&type==="domains")verifyComparisonDomainLineage(s,row,a);
      else requireValid(a.length === 1 && a[0].actor_kind === "user" && a[0].actor_user_id === s.actor &&
        a[0].action === "create" && a[0].before === null && equal(a[0].after,row.raw) &&
        a[0].reason === "Preserve authenticated owner's established legacy policy");
    }
  }
  requireValid(configurations.every(c => s.domains.some(d => d.domain_id === c.domainId)));
  for (const e of s.edits) {
    requireValid(e.user_id === s.actor && s.sessions.some(r => r.id === e.session_id) &&
      typeof e.reason === "string" && typeof e.changed_fields === "string");
    instant(e.edited_at,e.raw.edited_at);
  }
  const planned = s.sessions.map(source => {
    const d = s.domains.find(d => d.slug === source.domain);
    requireValid(d && Number.isInteger(source.duration_minutes) && source.duration_minutes > 0 &&
      (source.notes === null || typeof source.notes === "string") && typeof source.is_anomaly === "boolean" &&
      (source.anomaly_note === null || typeof source.anomaly_note === "string"));
    const at = instant(source.timestamp,source.raw.timestamp);
    if (source.deleted_at !== null) instant(source.deleted_at,source.raw.deleted_at);
    const chain = configurations.filter(c => c.domainId === d.domain_id).sort((a,b) => a.revision-b.revision);
    const c = chain.filter(c => ticks(c.effectiveFrom) <= ticks(at)).at(-1); requireValid(c);
    const duration = c.measurements.filter(m => m.kind === "duration");
    requireValid(duration.length === 1);
    const m = duration[0];
    requireValid(m.valueType === "number" && m.unit.unitId === "minute" && m.unit.dimension === "time" &&
      m.scope.kind === "per_event" && m.taskVariantId === undefined);
    const observationId = uid("observation-v1",s.org,s.actor,source.id);
    const parsed = ObservationSchema.safeParse({
      schemaVersion:1,observationId,organizationId:s.org,ownerUserId:s.actor,domainId:d.domain_id,
      policyVersionId:c.policyVersionId,observedAt:at,
      values:{[m.measurementId]:{valueType:"number",unitId:"minute",value:source.duration_minutes}},
      ...(source.notes === null ? {} : {notes:source.notes}),
    });
    requireValid(parsed.success);
    const binding = s.bindings.find(b => b.domain_id === d.domain_id)!;
    return {source,binding,policy:s.policies.find(p => p.policy_version_id === c.policyVersionId)!,
      edits:s.edits.filter(e => e.session_id === source.id),
      row:{observation_id:observationId,org_id:s.org,owner_user_id:s.actor,domain_id:d.domain_id,
        policy_version_id:c.policyVersionId,idempotency_key:`legacy-sessions-v1:${hash(s.org,s.actor,source.id)}`,
        observed_at:at,observation:parsed.data,is_anomaly:source.is_anomaly,anomaly_note:source.anomaly_note,
        deleted_at:source.raw.deleted_at,legacy_source_type:"sessions",legacy_source_id:source.id},
    };
  });
  requireValid(ConfigurationBundleSchema.safeParse({schemaVersion:1,configurations,observations:planned.map(p => p.row.observation)}).success);
  return planned;
}
// Only a validated *prior-value delta*, never a full historical state.
function priorDelta(raw: string): unknown {
  let v: any; try { v = JSON.parse(raw); } catch { return {status:"unknown"}; }
  if (!v || Array.isArray(v) || typeof v !== "object") return {status:"unknown"};
  const validators: Record<string,(v:any)=>boolean> = {
    domain:v => slugs.includes(v),durationMinutes:v => Number.isInteger(v) && v > 0,
    timestamp:v => ObservationSchema.shape.observedAt.safeParse(v).success,
    notes:v => v === null || typeof v === "string",isAnomaly:v => typeof v === "boolean",
    anomalyNote:v => v === null || typeof v === "string",
  };
  return Object.entries(v).every(([k,x]) => Object.hasOwn(validators,k) && validators[k](x))
    ? {status:"known",kind:"prior-value-delta",values:v} : {status:"unknown"};
}
function envelope(s: State,p: Planned) {
  return {version,importBatchId:s.batch,sourceType:"sessions",sourceId:p.source.id,
    binding:p.binding.raw,policy:p.policy.raw,sourceSnapshot:{kind:"current-row-at-import-not-historical-after",row:p.source.raw}};
}
function event(s: State,p: Planned,edit?: Row): Row {
  const type = edit ? types[1] : types[0], id = edit?.id ?? p.source.id;
  return {audit_event_id:uid(type,s.org,s.actor,id),org_id:s.org,actor_kind:"user",actor_user_id:s.actor,
    entity_type:type,entity_id:JSON.stringify([id]),action:edit ? "update" : "create",
    reason:edit ? edit.reason : reason,
    before:edit ? {version,importBatchId:s.batch,sourceType:"session_edits",sourceEdit:edit.raw,
      priorEvidence:priorDelta(edit.changed_fields)} : null,
    after:edit ? {...envelope(s,p),historicalAfterEvidence:{status:"unknown"},sourceEditId:edit.id,
      observationId:p.row.observation_id}
      : {...envelope(s,p),importedObservation:p.row},
    ...(edit ? {occurred_at:edit.raw.edited_at} : {}),
  };
}
/**
 * Reserve, without consuming, the complete post-import reread before the first
 * insert. JSONB formatting/timestamp metadata are conservatively covered by 2x
 * UTF-8 canonical JSON plus 512 bytes per row. The SQL admission remains the
 * authoritative check on every actual read; no rows are truncated or deleted.
 * Check each expansion immediately instead of retaining a second audit set.
 */
function reserveImportReread(tx:Transaction,s:State,planned:Planned[]) {
  let bytes=4096; // organization, singleton membership and scalar result metadata
  const add=(value:unknown)=>{
    bytes+=2*Buffer.byteLength(JSON.stringify(value),"utf8")+512;
    assertReadBytesAvailable(tx,bytes);
  };
  for(const collection of [s.domains,s.policies,s.dimensions,s.bindings,s.sessions,s.edits,s.observations,s.audits])
    for(const row of collection)add(row.raw);
  for(const p of planned){
    add(p.row);
    const importedEvent=event(s,p);
    // The actual server timestamp has at most six fractional digits.
    importedEvent.after.importedAt="9999-12-31T23:59:59.999999+00:00";
    importedEvent.occurred_at="9999-12-31T23:59:59.999999+00:00";
    add(importedEvent);
    for(const edit of p.edits)add(event(s,p,edit));
  }
}
function matchesEvent(actual: Row | undefined, expected: Row, historical: boolean) {
  if (!actual) return false;
  const raw = json(actual.raw);
  if (!historical) {
    // Occurrence is server time, captured in the envelope too. Tampering with
    // either representation alone is drift; reruns never assign a new time.
    if (raw.after?.importedAt !== raw.occurred_at) return false;
    delete raw.after.importedAt; delete raw.occurred_at;
  }
  return equal(raw,expected);
}
function imported(s: State) {
  const ids = new Set(s.sessions.map(r => uid("observation-v1",s.org,s.actor,r.id)));
  return s.observations.filter(o => o.legacy_source_type === "sessions" ||
    o.idempotency_key.startsWith("legacy-sessions-v1:") || ids.has(o.observation_id));
}
function report(s: State,planned?: Planned[]) {
  const actual = imported(s), importAudits = s.audits.filter(a =>
    types.includes(a.entity_type) || a.after?.version === version || a.before?.version === version);
  const drift = {validation:planned ? 0 : 1,missing:0,extra:0,duplicate:0,payload:0,audit:0};
  const domains = slugs.map(slug => {
    const sources = s.sessions.filter(r => r.domain === slug);
    const expected = (planned ?? []).filter(p => p.source.domain === slug);
    const id = s.domains.find(d => d.slug === slug)?.domain_id;
    const found = actual.filter(o => o.domain_id === id);
    const counts = (items: Row[], source: boolean) => ({
      total:items.length,active:items.filter(r => r.deleted_at === null).length,
      deleted:items.filter(r => r.deleted_at !== null).length,anomaly:items.filter(r => r.is_anomaly === true).length,
      anomalyNotes:items.filter(r => r.anomaly_note !== null).length,
      durationMinutes:items.reduce((n,r) => n+(source ? (Number.isFinite(r.duration_minutes) ? r.duration_minutes : 0) :
        Object.values(r.observation?.values ?? {}).reduce((sum:number,v:any) => sum+(v?.unitId === "minute" && typeof v.value === "number" ? v.value : 0),0)),0),
    });
    const differences = {duration:0,timestamp:0,note:0,mapping:0,anomaly:0,anomalyNote:0,deleted:0,editAudit:0};
    for (const p of expected) {
      const candidates = actual.filter(o => o.legacy_source_id === p.source.id || o.observation_id === p.row.observation_id ||
        o.idempotency_key === p.row.idempotency_key);
      if (candidates.length === 0) drift.missing++;
      if (candidates.length > 1) drift.duplicate += candidates.length-1;
      const a = candidates[0]?.raw;
      if (!equal(a,p.row)) drift.payload++;
      for (const [field,same] of Object.entries({
        duration:equal(a?.observation?.values,p.row.observation.values),
        timestamp:a?.observed_at === p.row.observed_at && a?.observation?.observedAt === p.row.observation.observedAt,
        note:equal(a?.observation && {has:Object.hasOwn(a.observation,"notes"),value:a.observation.notes},
          {has:Object.hasOwn(p.row.observation,"notes"),value:p.row.observation.notes}),
        mapping:["observation_id","org_id","owner_user_id","domain_id","policy_version_id","idempotency_key","legacy_source_type","legacy_source_id"]
          .every(k => a?.[k] === p.row[k]),
        anomaly:a?.is_anomaly === p.row.is_anomaly,anomalyNote:a?.anomaly_note === p.row.anomaly_note,
        deleted:a?.deleted_at === p.row.deleted_at,
      })) if (!same) differences[field as keyof typeof differences]++;
      for (const edit of [undefined,...p.edits]) {
        const e = event(s,p,edit), matches = importAudits.filter(a => a.audit_event_id === e.audit_event_id);
        if (matches.length !== 1 || !matchesEvent(matches[0],e,!!edit)) { drift.audit++; if (edit) differences.editAudit++; }
      }
    }
    return {slug,legacy:counts(sources,true),imported:counts(found,false),
      legacyEdits:s.edits.filter(e => sources.some(r => r.id === e.session_id)).length,differences};
  });
  if (planned) {
    drift.extra = actual.filter(a => !planned.some(p => p.row.observation_id === a.observation_id)).length;
    const ids = new Set(planned.flatMap(p => [event(s,p).audit_event_id,...p.edits.map(e => event(s,p,e).audit_event_id)]));
    drift.audit += importAudits.filter(a => !ids.has(a.audit_event_id)).length;
  }
  return {clean:Object.values(drift).every(n => n === 0),unownedSessions:s.unowned,
    counts:{ownedSessions:s.sessions.length,imported:actual.length,legacyEdits:s.edits.length,importAudits:importAudits.length},
    drift,domains};
}
/** Private historical writer: original validated owned edit only; same tx/capability. */
async function historicalAudit(tx: Transaction,db: OwnershipDatabase,context: OrgContext,s: State,p: Planned,edit: Row) {
  requireValid(s.edits.includes(edit) && edit.user_id === context.actorUserId && edit.session_id === p.source.id);
  await revalidate(tx,db,context);
  await insertAudit(tx,event(s,p,edit),instant(edit.edited_at,edit.raw.edited_at));
}
async function insertAudit(tx: Transaction,e: Row,at: string) {
  await tx.query(`INSERT INTO public.audit_events
    (audit_event_id,org_id,actor_kind,actor_user_id,entity_type,entity_id,action,occurred_at,reason,"before","after")
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
  [e.audit_event_id,e.org_id,e.actor_kind,e.actor_user_id,e.entity_type,e.entity_id,e.action,at,e.reason,e.before,e.after]);
}
async function run(db: OwnershipDatabase,request: Request,write: boolean) {
  authenticate(request); // before ANY access to injected database
  return bounded(() => db.transaction(raw => withTransactionReadBudget(raw,async tx => {
    // Canonical SQL JSON date strings without sacrificing microseconds.
    await tx.query("SELECT set_config('TimeZone','UTC',true)");
    const pinned: OwnershipDatabase = {transaction:async fn => fn(tx)};
    const context = await createOrgContextResolver(pinned)(request);
    let state = await read(tx,pinned,context), planned: Planned[];
    try { planned = plan(state); }
    catch (e) {
      if (!write && e instanceof BoundaryError && e.status === 400) return {reconciliation:report(state)};
      throw e;
    }
    const before = report(state,planned);
    if (!write) return {reconciliation:before};
    if (!before.clean) {
      // A partly imported or altered history is never repaired automatically.
      requireValid(imported(state).length === 0 && !state.audits.some(a =>
        types.includes(a.entity_type) || a.after?.version === version || a.before?.version === version));
      // Check projected complete collections before the first insert. A later
      // full read must not discover a self-created resource overflow.
      if(state.observations.length+planned.length>MAX_READ_ROWS||
        state.audits.length+planned.length+state.edits.length>MAX_READ_ROWS)throw new ResourceLimitError();
      reserveImportReread(tx,state,planned);
      for (const p of planned) {
        await revalidate(tx,pinned,context);
        const r = p.row;
        await tx.query(`INSERT INTO public.observations
          (observation_id,org_id,owner_user_id,domain_id,policy_version_id,idempotency_key,observed_at,observation,
           is_anomaly,anomaly_note,deleted_at,legacy_source_type,legacy_source_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,Object.values(r));
        const clock = (await tx.query("SELECT to_jsonb(clock_timestamp()) AS at")).rows[0].at as string;
        const e = event(state,p);e.after.importedAt = clock;
        await insertAudit(tx,e,clock);
        for (const edit of p.edits) await historicalAudit(tx,pinned,context,state,p,edit);
      }
    }
    state = await read(tx,pinned,context);
    const final = report(state,plan(state));requireValid(final.clean);
    return {importBatchId:state.batch,mapping:Object.fromEntries(planned.map(p => [p.source.id,p.row.observation_id])),
      reconciliation:final};
  })));
}
/** Internal server-only seams. Never connected to routes, hooks, startup or CLI. */
export async function importLegacyObservations(db: OwnershipDatabase,request: Request) { return run(db,request,true); }
export async function reconcileLegacyObservations(db: OwnershipDatabase,request: Request) {
  return (await run(db,request,false)).reconciliation;
}
/**
 * Private, read-only provenance gate. Reconstruct only the immutable import-time
 * set, so later legitimate mutations cannot rewrite the meaning of the import.
 * Call inside the same quiet collection transaction; never seed or repair here.
 */
export async function verifyLegacyImportProvenance(db: OwnershipDatabase, request: Request) {
  authenticate(request);
  return bounded(() => db.transaction(raw => withTransactionReadBudget(raw,async tx => {
    await tx.query("SELECT set_config('TimeZone','UTC',true)");
    const pinned:OwnershipDatabase={transaction:async operation=>operation(tx)};
    const context = await createOrgContextResolver(pinned)(request);
    const current = await read(tx,pinned,context);
    return preservedImportProof(current);
  })));
}


/** Shared arithmetic/provenance checks; only the comparison reader opts into a
 * scoped binding set. Existing import/reconciliation entry points stay legacy-only. */
function preservedImportProof(current: State, comparison = false) {
  const sessions = current.audits.filter(a => a.entity_type === types[0]).map(a => {
    const r = a.after?.sourceSnapshot?.row;
    requireValid(r && typeof r.id === "string" && r.user_id === current.actor &&
      current.sessions.some(s => s.id === r.id));
    return {...r,timestamp:new Date(r.timestamp),deleted_at:r.deleted_at === null ? null : new Date(r.deleted_at),raw:r};
  });
  const edits = current.audits.filter(a => a.entity_type === types[1]).map(a => {
    const r = a.before?.sourceEdit;
    requireValid(r && typeof r.id === "string" && r.user_id === current.actor &&
      current.edits.some(e => e.id === r.id && equal(e.raw,r)));
    return {...r,edited_at:new Date(r.edited_at),raw:r};
  });
  requireValid(new Set(sessions.map(s => s.id)).size === sessions.length &&
    new Set(edits.map(e => e.id)).size === edits.length);
  const observations = current.audits.filter(a => a.entity_type === types[0]).map(a => {
    const r = a.after?.importedObservation; requireValid(r && typeof r.observation_id === "string");
    return {...r,raw:r};
  });
  const preserved = {...current,sessions,edits,observations};
  requireValid(report(preserved,plan(preserved,comparison)).clean);
  return {importedSessions:sessions.length,importedEdits:edits.length};
}

export type LegacyComparisonEvidence = {
  proof: { importedSessions: number; importedEdits: number };
  all: State;
  scoped: State;
  nativeObservations: Row[];
};

/**
 * Internal read-only entry for the comparison unit. The caller owns the pinned
 * maintenance transaction and its NOWAIT table locks. This does not import,
 * repair, approve a recipe, or forge a legacy context for shadow mode.
 */
export async function verifyLegacyComparisonProvenance(
  db: OwnershipDatabase, context: OrgContext, request: Request,
): Promise<LegacyComparisonEvidence> {
  authenticate(request);
  assertContext(db,context);
  if((request.user as any)?.claims?.sub!==context.actorUserId||context.role!=="owner"||
    !["legacy","shadow"].includes(context.rolloutMode))throw new BoundaryError(403);
  return bounded(()=>db.transaction(raw=>withTransactionReadBudget(raw,async tx=>{
    await revalidate(tx,db,context);
    const org=context.orgId,actor=context.actorUserId,scope=[org,actor];
    const scopedRows=(table:string,order:string)=>rows(tx,table,"t.org_id=$1 AND t.owner_user_id=$2",scope,order);
    const domains=await scopedRows("domains","t.domain_id");
    const policies=await scopedRows("policy_versions","t.domain_id,t.revision");
    const dimensions=await scopedRows("dimension_definitions","t.policy_version_id,t.measurement_id");
    const bindings=await scopedRows("source_bindings","t.binding_id");
    const sessions=await rows(tx,"sessions","t.user_id=$1",[actor],"t.domain,t.timestamp,t.id");
    const edits=await rows(tx,"session_edits",
      "t.user_id=$1 OR t.session_id IN (SELECT id FROM public.sessions WHERE user_id=$1)",[actor],"t.edited_at,t.id");
    const observations=await scopedRows("observations","t.observation_id");
    const legacyDeviationIds=await readComplete(tx,"SELECT id FROM public.deviations WHERE user_id=$1 ORDER BY id LIMIT $2 FOR SHARE",
      [actor,MAX_READ_ROWS+1],["id"],MAX_READ_ROWS);
    const deviationIds=await readComplete(tx,"SELECT deviation_id FROM public.deviations_v2 WHERE org_id=$1 AND owner_user_id=$2 ORDER BY deviation_id LIMIT $3 FOR SHARE",
      [org,actor,MAX_READ_ROWS+1],["deviation_id"],MAX_READ_ROWS);
    const associations=await readComplete(tx,"SELECT deviation_id,domain_id FROM public.deviation_domains WHERE org_id=$1 AND owner_user_id=$2 ORDER BY deviation_id,domain_id LIMIT $3 FOR SHARE",
      [org,actor,MAX_READ_ROWS+1],["deviation_id","domain_id"],MAX_READ_ROWS);
    // Audit identities are typed. A session ID must never authorize a foreign
    // observation/domain audit merely because its untyped ID happens to collide.
    const single=(items:Row[],key:string)=>items.map(row=>JSON.stringify([row[key]]));
    const sessionKeys=single(sessions,"id"),editKeys=single(edits,"id");
    const ownedAuditKeys:Record<string,string[]>={
      users:[JSON.stringify([actor])],organizations:[JSON.stringify([org])],
      organization_members:[JSON.stringify([org,actor])],user_settings:[JSON.stringify([actor])],
      domains:single(domains,"domain_id"),policy_versions:single(policies,"policy_version_id"),
      dimension_definitions:dimensions.map(row=>JSON.stringify([row.policy_version_id,row.measurement_id])),
      source_bindings:single(bindings,"binding_id"),observations:single(observations,"observation_id"),
      sessions:sessionKeys,legacy_session_import:sessionKeys,legacy_session_mutation:sessionKeys,
      session_edits:editKeys,legacy_edit_import:editKeys,
      deviations:single(legacyDeviationIds,"id"),legacy_deviation:single(legacyDeviationIds,"id"),
      deviations_v2:single(deviationIds,"deviation_id"),
      deviation_domains:associations.map(row=>JSON.stringify([row.deviation_id,row.domain_id])),
    };
    const currentOwnedAudit="EXISTS (SELECT 1 FROM jsonb_each($3::jsonb) AS owned(entity_type,identities) WHERE owned.entity_type=t.entity_type AND owned.identities ? t.entity_id)";
    // A removed source has no current key. Retain its historical protocol only
    // when stored payload scope AND the typed event key independently bind it.
    // Actor identity alone never grants access to another entity's audit JSON.
    const historicalOwnedAudit=`(
      (t.entity_type='source_bindings' AND (
        (t."after"->>'org_id'=$1 AND t."after"->>'owner_user_id'=$2 AND t."after"->>'binding_id' IS NOT NULL
          AND t.entity_id=jsonb_build_array(t."after"->>'binding_id')::text
          AND (t."after"->>'source_kind'='manual-legacy' OR t."after"#>>'{metadata,description}'='existing-owner-seed-v1'))
        OR (t."before"->>'org_id'=$1 AND t."before"->>'owner_user_id'=$2 AND t."before"->>'binding_id' IS NOT NULL
          AND t.entity_id=jsonb_build_array(t."before"->>'binding_id')::text
          AND (t."before"->>'source_kind'='manual-legacy' OR t."before"#>>'{metadata,description}'='existing-owner-seed-v1'))))
      OR (t.entity_type='legacy_session_import'
        AND t."after"#>>'{sourceSnapshot,row,user_id}'=$2
        AND t."after"#>>'{binding,org_id}'=$1 AND t."after"#>>'{binding,owner_user_id}'=$2
        AND t."after"#>>'{importedObservation,org_id}'=$1 AND t."after"#>>'{importedObservation,owner_user_id}'=$2
        AND t."after"->>'sourceId' IS NOT NULL AND t."after"->>'sourceId'=t."after"#>>'{sourceSnapshot,row,id}'
        AND t.entity_id=jsonb_build_array(t."after"->>'sourceId')::text)
      OR (t.entity_type='legacy_session_mutation'
        AND t."after"#>>'{state,legacy,user_id}'=$2
        AND t."after"#>>'{state,canonical,org_id}'=$1 AND t."after"#>>'{state,canonical,owner_user_id}'=$2
        AND t."after"#>>'{state,legacy,id}' IS NOT NULL
        AND t.entity_id=jsonb_build_array(t."after"#>>'{state,legacy,id}')::text)
      OR (t.entity_type='legacy_edit_import'
        AND t."before"#>>'{sourceEdit,user_id}'=$2 AND t."after"#>>'{sourceSnapshot,row,user_id}'=$2
        AND t."after"#>>'{binding,org_id}'=$1 AND t."after"#>>'{binding,owner_user_id}'=$2
        AND t."before"#>>'{sourceEdit,id}' IS NOT NULL
        AND t."after"->>'sourceEditId'=t."before"#>>'{sourceEdit,id}'
        AND t.entity_id=jsonb_build_array(t."before"#>>'{sourceEdit,id}')::text)
    )`;
    const partialHistoricalClaim=`(
      (t.entity_type='source_bindings' AND (
        (t."after"->>'org_id'=$1 AND t."after"->>'owner_user_id'=$2
          AND (t."after"->>'source_kind'='manual-legacy' OR t."after"#>>'{metadata,description}'='existing-owner-seed-v1'))
        OR (t."before"->>'org_id'=$1 AND t."before"->>'owner_user_id'=$2
          AND (t."before"->>'source_kind'='manual-legacy' OR t."before"#>>'{metadata,description}'='existing-owner-seed-v1'))))
      OR (t.entity_type='legacy_session_import' AND (
        t."after"#>>'{sourceSnapshot,row,user_id}'=$2 OR
        (t."after"#>>'{importedObservation,org_id}'=$1 AND t."after"#>>'{importedObservation,owner_user_id}'=$2)))
      OR (t.entity_type='legacy_session_mutation' AND (
        t."after"#>>'{state,legacy,user_id}'=$2 OR
        (t."after"#>>'{state,canonical,org_id}'=$1 AND t."after"#>>'{state,canonical,owner_user_id}'=$2)))
      OR (t.entity_type='legacy_edit_import' AND (
        t."before"#>>'{sourceEdit,user_id}'=$2 OR t."after"#>>'{sourceSnapshot,row,user_id}'=$2))
    )`;
    const present=(object:string)=>`coalesce(jsonb_typeof(${object}),'null')<>'null'`;
    const compactKey=(object:string,keys:string[])=>"('[' || "+keys.map(key=>`to_jsonb(${object}->>'${key}')::text`).join(" || ',' || ")+" || ']')";
    const scopedRow=(object:string,keys:string[],eventKey=false)=>`coalesce((jsonb_typeof(${object})='object'
      AND ${object}->>'org_id'=$1 AND ${object}->>'owner_user_id'=$2
      AND ${keys.map(key=>`${object}->>'${key}' IS NOT NULL`).join(" AND ")}
      ${eventKey?`AND t.entity_id=${compactKey(object,keys)}`:""}),false)`;
    const legacyRow=(object:string)=>`coalesce((jsonb_typeof(${object})='object' AND ${object}->>'user_id'=$2
      AND ${object}->>'id' IS NOT NULL),false)`;
    const bindingRow=(object:string,eventKey=false)=>`(${scopedRow(object,["binding_id","domain_id"],false)}
      ${eventKey?`AND t.entity_id=${compactKey(object,["binding_id"])}`:""})`;
    const canonicalRow=(object:string)=>`(${scopedRow(object,["observation_id","domain_id","policy_version_id"])}
      AND coalesce((${object}#>>'{observation,organizationId}'=$1 AND ${object}#>>'{observation,ownerUserId}'=$2
        AND ${object}#>>'{observation,observationId}'=${object}->>'observation_id'
        AND ${object}#>>'{observation,domainId}'=${object}->>'domain_id'
        AND ${object}#>>'{observation,policyVersionId}'=${object}->>'policy_version_id'),false))`;
    const policyRow=(object:string)=>`(${scopedRow(object,["policy_version_id","domain_id"])}
      AND coalesce((${object}#>>'{configuration,organizationId}'=$1 AND ${object}#>>'{configuration,ownerUserId}'=$2
        AND ${object}#>>'{configuration,policyVersionId}'=${object}->>'policy_version_id'
        AND ${object}#>>'{configuration,domainId}'=${object}->>'domain_id'),false))`;
    const envelope=`(${legacyRow("t.\"after\"#>'{sourceSnapshot,row}'")}
      AND ${bindingRow("t.\"after\"->'binding'")} AND ${policyRow("t.\"after\"->'policy'")}
      AND coalesce((t."after"->>'sourceId'=t."after"#>>'{sourceSnapshot,row,id}'
        AND t."after"#>>'{binding,domain_id}'=t."after"#>>'{policy,domain_id}'),false))`;
    const mutationState=(object:string)=>`(${legacyRow(`${object}->'legacy'`)} AND ${canonicalRow(`${object}->'canonical'`)}
      AND coalesce((${object}#>>'{canonical,legacy_source_id}'=${object}#>>'{legacy,id}'
        AND ${object}#>>'{canonical,legacy_source_type}'='sessions'),false))`;
    // Coherence qualifies BOTH current-key and historical inclusion. One owned
    // side cannot authorize a contradictory foreign before/after snapshot.
    const optionalPayloadScope=(object:string)=>{
      const checks:[string,(value:string)=>string][]=[
        [`(${object})->'binding'`,value=>bindingRow(value)],
        [`(${object})->'policy'`,value=>policyRow(value)],
        [`(${object})#>'{sourceSnapshot,row}'`,value=>legacyRow(value)],
        [`(${object})->'importedObservation'`,value=>canonicalRow(value)],
        [`(${object})->'sourceEdit'`,value=>legacyRow(value)],
        [`(${object})->'legacyEdit'`,value=>legacyRow(value)],
        [`(${object})->'legacy'`,value=>legacyRow(value)],
        [`(${object})->'canonical'`,value=>canonicalRow(value)],
        [`(${object})->'state'`,value=>mutationState(value)],
      ];
      return checks.map(([value,validate])=>`(NOT (${present(value)}) OR ${validate(value)})`).join(" AND ");
    };
    const partialProtocolClaim=`(t.entity_type IN ('source_bindings','legacy_session_import','legacy_session_mutation','legacy_edit_import') AND (
      ${['t."before"','t."after"'].map(object=>{
        const scoped=[object,...["binding","policy","importedObservation","canonical"].map(key=>`(${object})->'${key}'`),`(${object})#>'{state,canonical}'`];
        const legacy=["legacy","sourceEdit","legacyEdit"].map(key=>`(${object})->'${key}'`).concat([`(${object})#>'{sourceSnapshot,row}'`,`(${object})#>'{state,legacy}'`]);
        return scoped.map(value=>`(${value}->>'org_id'=$1 AND ${value}->>'owner_user_id'=$2)`)
          .concat(legacy.map(value=>`${value}->>'user_id'=$2`)).join(" OR ");
      }).join(" OR ")}))`;
    const partialOwnedClaim=`((${partialHistoricalClaim}) OR (${partialProtocolClaim}))`;
    const protocolPayloadScope=`(t.entity_type NOT IN ('source_bindings','legacy_session_import','legacy_session_mutation','legacy_edit_import') OR
      ((${optionalPayloadScope('t."before"')}) AND (${optionalPayloadScope('t."after"')})))`;
    const knownProtocolCoherence=`(
      (t.entity_type<>'source_bindings' OR
        (t.action='create' AND NOT (${present('t."before"')}) AND ${bindingRow('t."after"',true)}) OR
        (t.action='delete' AND ${bindingRow('t."before"',true)} AND NOT (${present('t."after"')})) OR
        (t.action='update' AND ${bindingRow('t."before"',true)} AND ${bindingRow('t."after"',true)}))
      AND (t.entity_type<>'legacy_session_import' OR (t.action='create' AND NOT (${present('t."before"')})
        AND ${envelope} AND ${canonicalRow("t.\"after\"->'importedObservation'")}
        AND coalesce((t.entity_id=jsonb_build_array(t."after"->>'sourceId')::text
          AND t."after"#>>'{importedObservation,legacy_source_id}'=t."after"->>'sourceId'
          AND t."after"#>>'{importedObservation,legacy_source_type}'='sessions'
          AND t."after"#>>'{importedObservation,domain_id}'=t."after"#>>'{binding,domain_id}'
          AND t."after"#>>'{importedObservation,policy_version_id}'=t."after"#>>'{policy,policy_version_id}'),false)))
      AND (t.entity_type<>'legacy_session_mutation' OR (
        ${mutationState("t.\"after\"->'state'")}
        AND coalesce((t.entity_id=jsonb_build_array(t."after"#>>'{state,legacy,id}')::text),false)
        AND ((t.action='create' AND NOT (${present('t."before"')})) OR
          (t.action='update' AND ${mutationState('t."before"')}
            AND coalesce((t."before"#>>'{legacy,id}'=t."after"#>>'{state,legacy,id}'
              AND t."before"#>>'{canonical,observation_id}'=t."after"#>>'{state,canonical,observation_id}'),false)))))
      AND (t.entity_type<>'legacy_edit_import' OR (t.action='update'
        AND ${legacyRow("t.\"before\"->'sourceEdit'")} AND ${envelope}
        AND coalesce((t.entity_id=jsonb_build_array(t."before"#>>'{sourceEdit,id}')::text
          AND t."after"->>'sourceEditId'=t."before"#>>'{sourceEdit,id}'),false)))
    )`;
    const rowKinds:[string,string[]][]=[
      ["domains",["domain_id"]],["policy_versions",["policy_version_id"]],
      ["dimension_definitions",["policy_version_id","measurement_id"]],
      ["observations",["observation_id"]],["deviations_v2",["deviation_id"]],
      ["deviation_domains",["deviation_id","domain_id"]],
    ];
    // Generic correction notes stay notes. Only recognized scoped row objects
    // are checked here; no arbitrary text is interpreted as an ownership claim.
    const typedSnapshot=(kind:string,object:string,keys:string[])=>{
      const rowScope=scopedRow(object,keys,true);
      return kind==="observations"?`(${rowScope} AND ${canonicalRow(object)})`:
        kind==="policy_versions"?`(${rowScope} AND ${policyRow(object)})`:rowScope;
    };
    const scopedRowCoherence=rowKinds.map(([kind,keys])=>`(t.entity_type<>'${kind}' OR (${['t."before"','t."after"'].map(object=>
      `(NOT (${present(object)}) OR NOT (coalesce(${object} ? 'org_id',false) OR coalesce(${object} ? 'owner_user_id',false) OR coalesce(${object} ? '${keys[0]}',false))
        OR ${typedSnapshot(kind,object,keys)})`).join(" AND ")}))`).join(" AND ");
    const legacyRowCoherence=["sessions","session_edits","deviations","legacy_deviation"].map(kind=>
      `(t.entity_type<>'${kind}' OR (${['t."before"','t."after"'].map(object=>
        `(NOT (${present(object)}) OR NOT (coalesce(${object} ? 'user_id',false) OR coalesce(${object} ? 'id',false))
          OR (${legacyRow(object)} AND coalesce(t.entity_id=${compactKey(object,["id"])},false)))`).join(" AND ")}))`).join(" AND ");
    const coherentAudit=`coalesce((${knownProtocolCoherence}) AND (${protocolPayloadScope}) AND (${scopedRowCoherence}) AND (${legacyRowCoherence}),false)`;
    const auditParameters=[org,actor,JSON.stringify(ownedAuditKeys)];
    // Only a count crosses the boundary for contradictory historical scope.
    // Such data cannot establish clean coverage, but its private JSON is withheld.
    const ambiguous=await readComplete(tx,`SELECT count(*)::int AS count FROM public.audit_events t WHERE t.org_id=$1 AND (
      ((${partialOwnedClaim}) IS TRUE AND NOT coalesce((${currentOwnedAudit}),false) AND NOT coalesce((${historicalOwnedAudit}),false))
      OR ((coalesce((${currentOwnedAudit}),false) OR coalesce((${historicalOwnedAudit}),false) OR coalesce((${partialOwnedClaim}),false))
        AND NOT (${coherentAudit})))`,
      auditParameters,["count"],1);
    requireValid(ambiguous.length===1&&ambiguous[0].count===0);
    const audits=await rows(tx,"audit_events",
      `t.org_id=$1 AND ((${currentOwnedAudit}) OR (${historicalOwnedAudit})) AND (${coherentAudit})`,auditParameters,"t.audit_event_id");
    // Unassigned rows are outside this authenticated comparison; zero is an
    // internal report placeholder, never a claim that global unowned data is absent.
    const all:State={org,actor,domains,policies,dimensions,bindings,sessions,edits,observations,audits,
      unowned:0,batch:`${version}:${hash(org,actor)}`};
    const claimsLegacyBinding=(binding:Row|undefined)=>binding?.source_kind==="manual-legacy"||
      binding?.metadata?.description==="existing-owner-seed-v1";
    // Explanation text is user-authored. Only semantic binding snapshots or a
    // real import envelope can claim a legacy root, never that text by itself.
    const semanticBindingSnapshots=audits.filter(a=>a.entity_type==="source_bindings").flatMap(a=>
      [a.before,a.after].filter(claimsLegacyBinding).map(binding=>({audit:a,binding})));
    requireValid(semanticBindingSnapshots.every(({audit,binding})=>binding&&typeof binding.binding_id==="string"&&
      binding.org_id===org&&binding.owner_user_id===actor&&audit.entity_id===JSON.stringify([binding.binding_id])&&
      bindings.some(row=>row.binding_id===binding.binding_id)));
    const importedBindingClaims=audits.filter(a=>types.includes(a.entity_type)||
      a.after?.version===version||a.before?.version===version).map(a=>a.after?.binding);
    requireValid(importedBindingClaims.every(binding=>binding&&typeof binding.binding_id==="string"&&
      bindings.some(row=>row.binding_id===binding.binding_id)));
    const legacyBindings=bindings.filter(binding=>claimsLegacyBinding(binding)||
      semanticBindingSnapshots.some(claim=>claim.binding.binding_id===binding.binding_id)||
      importedBindingClaims.some(claim=>claim.binding_id===binding.binding_id));
    requireValid(legacyBindings.every(b=>b.source_kind==="manual-legacy"&&equal(b.metadata,{description:"existing-owner-seed-v1"}))&&
      legacyBindings.length<=4&&
      new Set(legacyBindings.map(b=>b.domain_id)).size===legacyBindings.length&&
      new Set(legacyBindings.map(b=>b.external_id)).size===legacyBindings.length&&
      legacyBindings.every(b=>slugs.includes(b.external_id)));
    const domainIds=new Set(legacyBindings.map(b=>b.domain_id));
    const legacyDomains=domains.filter(d=>domainIds.has(d.domain_id));
    requireValid(legacyDomains.length===legacyBindings.length);
    const expectedIds=new Set(sessions.map(row=>uid("observation-v1",org,actor,row.id)));
    const legacyMarked=(row:Row)=>row.legacy_source_type!=null||row.legacy_source_id!=null||
      typeof row.idempotency_key==="string"&&row.idempotency_key.startsWith("legacy-sessions-v1:")||
      ["legacy-history-import-v1","legacy-activity-mutation-v1"].includes(row.version)||
      ["legacy-history-import-v1","legacy-activity-mutation-v1"].includes(row.observation?.version)||
      expectedIds.has(row.observation_id);
    const legacyObservations=observations.filter(legacyMarked);
    const scoped:State={...all,domains:legacyDomains,bindings:legacyBindings,
      policies:policies.filter(row=>domainIds.has(row.domain_id)),
      dimensions:dimensions.filter(row=>domainIds.has(row.domain_id)),observations:legacyObservations};
    let proof:LegacyComparisonEvidence["proof"];
    if(legacyBindings.length===0){
      // A native-only owner has no legacy bundle to validate. This private
      // projection is empty only after all missing/contradictory claim checks.
      // Retain native evidence as unsupported; never invent a legacy policy.
      requireValid([scoped.domains,scoped.bindings,scoped.policies,scoped.dimensions,
        scoped.sessions,scoped.edits,scoped.observations].every(collection=>collection.length===0)&&
        semanticBindingSnapshots.length===0&&importedBindingClaims.length===0&&
        !audits.some(a=>["legacy_session_import","legacy_edit_import","legacy_session_mutation"].includes(a.entity_type)||
          [version,"legacy-activity-mutation-v1"].includes(a.after?.version)||
          [version,"legacy-activity-mutation-v1"].includes(a.before?.version)));
      proof={importedSessions:0,importedEdits:0};
    }else proof=preservedImportProof(scoped,true);
    return {proof,all,scoped,nativeObservations:observations.filter(row=>!legacyMarked(row))};
  })));
}


/** Comparison-only metadata replay. Immutable identity/slug and active lifecycle
 * remain exact; unsupported lifecycle edits are refused rather than reanimated. */
function verifyComparisonDomainLineage(state:State,row:Row,audits:Row[]) {
  const creates=audits.filter(a=>a.action==="create");
  requireValid(creates.length===1);
  const first=creates[0];
  requireValid(first.actor_kind==="user"&&first.actor_user_id===state.actor&&first.before===null&&
    first.reason==="Preserve authenticated owner's established legacy policy"&&first.after&&typeof first.after==="object");
  let current=first.after as Row;
  requireValid(current.domain_id===row.domain_id&&current.org_id===state.org&&current.owner_user_id===state.actor&&
    current.slug===row.slug&&current.deactivated_at===null&&current.tombstoned_at===null);
  // Exact database microseconds order real audit events. Tied instants remain
  // ambiguous; random audit IDs must never invent their chronological order.
  const ordered=audits.map(event=>({event,at:ticks(event.occurred_at)}))
    .sort((left,right)=>left.at<right.at?-1:left.at>right.at?1:0);
  requireValid(ordered[0].event===first);
  for(let index=1;index<ordered.length;index++){
    requireValid(ordered[index-1].at<ordered[index].at);
    const event=ordered[index].event,after=event.after;
    requireValid(equal(event.before,current)&&event.action==="update"&&event.actor_kind==="user"&&event.actor_user_id===state.actor&&
      typeof event.reason==="string"&&!!event.reason.trim()&&after&&typeof after==="object"&&
      typeof after.display_name==="string"&&!!after.display_name.trim()&&after.display_name.length<=500&&
      !equal(after,current)&&equal(after,{...current,display_name:after.display_name}));
    current=after;
  }
  requireValid(equal(current,row.raw)&&row.deactivated_at===null&&row.tombstoned_at===null);
}
