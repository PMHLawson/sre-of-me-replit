import { createHash } from "node:crypto";
import { isDeepStrictEqual as equal } from "node:util";
import { ConfigurationBundleSchema, DomainConfigurationSchema, ObservationSchema } from "../../shared/domain-config";
import { BoundaryError, bounded, createOrgContextResolver, revalidate,
  type OwnershipDatabase, type Transaction, type OrgContext } from "../lib/org-context";

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
async function rows(tx: Transaction, table: string, where: string, values: unknown[], order: string) {
  return (await tx.query(`SELECT t.*,to_jsonb(t) AS raw FROM public.${table} t WHERE ${where} ORDER BY ${order} FOR SHARE`, values)).rows as Row[];
}
type State = Awaited<ReturnType<typeof read>>;
async function read(tx: Transaction, db: OwnershipDatabase, context: OrgContext) {
  await revalidate(tx,db,context);
  const { orgId: org, actorUserId: actor } = context, scope = [org,actor];
  if (context.role !== "owner" || context.rolloutMode !== "legacy") throw new BoundaryError(403);
  const organization = (await tx.query("SELECT * FROM public.organizations WHERE org_id=$1 FOR UPDATE",[org])).rows[0];
  const members = await rows(tx,"organization_members","t.org_id=$1",[org],"t.user_id");
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
function plan(s: State): Planned[] {
  requireValid(s.domains.length === 4 && s.bindings.length === 4);
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
  for (const slug of slugs) {
    const ds = s.domains.filter(d => d.slug === slug), bs = s.bindings.filter(b => b.external_id === slug);
    requireValid(ds.length === 1 && bs.length === 1);
    const d = ds[0], b = bs[0];
    requireValid(d.deactivated_at === null && d.tombstoned_at === null && b.domain_id === d.domain_id &&
      b.source_kind === "manual-legacy" && equal(b.metadata,{description:"existing-owner-seed-v1"}) &&
      configurations.some(c => c.domainId === d.domain_id));
    for (const [type,row,key] of [["domains",d,d.domain_id],["source_bindings",b,b.binding_id]] as const) {
      const a = s.audits.filter(a => a.entity_type === type && a.entity_id === JSON.stringify([key]));
      requireValid(a.length === 1 && a[0].actor_kind === "user" && a[0].actor_user_id === s.actor &&
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
  return bounded(() => db.transaction(async tx => {
    // Canonical SQL JSON date strings without sacrificing microseconds.
    await tx.query("SET LOCAL TIME ZONE 'UTC'");
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
  }));
}
/** Internal server-only seams. Never connected to routes, hooks, startup or CLI. */
export async function importLegacyObservations(db: OwnershipDatabase,request: Request) { return run(db,request,true); }
export async function reconcileLegacyObservations(db: OwnershipDatabase,request: Request) {
  return (await run(db,request,false)).reconciliation;
}