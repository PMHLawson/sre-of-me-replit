import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual as equal } from "node:util";
import { z } from "zod";
import { domainEnum, updateSessionSchema } from "../../shared/schema";
import { ConfigurationBundleSchema, DomainConfigurationSchema, ObservationSchema } from "../../shared/domain-config";
import { BoundaryError, revalidate, createOrgContextResolver, type OwnershipDatabase } from "../lib/org-context";
import { ResourceLimitError, MAX_READ_ROWS, MAX_COLLECTION_ROWS } from "../lib/read-budget";
import { withTransactionReadBudget, readComplete } from "../lib/transaction-read-budget";
import { createAuditService } from "../lib/audit-service";
import { verifyLegacyImportProvenance } from "./legacy-observation-sync";
import { createPinnedOwnershipUnit, type OwnershipUnit } from "../lib/pinned-ownership-unit";

type Request = Parameters<ReturnType<typeof createPinnedOwnershipUnit>["run"]>[0];
type Row = Record<string, any>;
type State = { legacy: Row; canonical: Row };
type MappingEvidence={domain:Row;configurations:import("../../shared/domain-config").DomainConfiguration[]};
type MutationUnit=OwnershipUnit & {readonly mappingEvidence:Map<string,Promise<MappingEvidence>>};
const readColumns={"domain":["domain_id","org_id","owner_user_id","slug","display_name","deactivated_at","tombstoned_at"],"policy":["policy_version_id","org_id","owner_user_id","domain_id","revision","effective_from","previous_version_id","configuration","evaluation_policy","raw"],"dimension":["org_id","owner_user_id","domain_id","policy_version_id","measurement_id","definition"],"binding":["binding_id","org_id","owner_user_id","domain_id","source_kind","external_id","metadata"]} as const;
const version = "legacy-activity-mutation-v1";
const entity = "legacy_session_mutation";
const id = z.string().min(1).max(200).refine(x => x.trim() === x && !/[\u0000-\u001f\u007f]/.test(x) && x !== "__proto__");
const createSchema = z.object({ domain: z.enum(domainEnum), durationMinutes: z.number().int().positive(),
  timestamp: z.string().datetime({offset:true}), notes: z.string().optional(),
  isAnomaly: z.boolean().optional(), anomalyNote: z.string().nullable().optional() }).strict();
const editSchema = updateSessionSchema.strict();
function parse<S extends z.ZodTypeAny>(schema:S,input:unknown):z.infer<S> {
  const r=schema.safeParse(input);if(!r.success)throw new BoundaryError(400);return r.data;
}
function requireValid(value:unknown):asserts value {if(!value)throw new BoundaryError(400);}
const hash=(...parts:string[])=>createHash("sha256").update(JSON.stringify(parts)).digest("hex");
function observationId(org:string,actor:string,source:string){
  const h=hash("observation-v1",org,actor,source);
  return `${h.slice(0,8)}-${h.slice(8,12)}-8${h.slice(13,16)}-${((parseInt(h[16],16)&3)|8).toString(16)}${h.slice(17,20)}-${h.slice(20,32)}`;
}
function ticks(value:unknown):bigint {
  requireValid(typeof value==="string"&&ObservationSchema.shape.observedAt.safeParse(value).success);
  const fraction=value.match(/\.(\d+)/)?.[1]??"";requireValid(fraction.length<=6);
  return BigInt(Date.parse(value))*BigInt(1000)+BigInt(fraction.padEnd(6,"0").slice(3));
}
async function loadMappingEvidence(u:MutationUnit,slug:string):Promise<MappingEvidence> {
  const {orgId:org,actorUserId:actor}=u.context;
  const ds=await readComplete(u.tx,"SELECT * FROM public.domains WHERE org_id=$1 AND owner_user_id=$2 AND slug=$3 LIMIT 2 FOR SHARE",[org,actor,slug],readColumns.domain,2);
  requireValid(ds.length===1&&ds[0].deactivated_at===null&&ds[0].tombstoned_at===null);const d=ds[0];
  const ps=await readComplete(u.tx,"SELECT p.*,to_jsonb(p) raw FROM public.policy_versions p WHERE org_id=$1 AND owner_user_id=$2 AND domain_id=$3 ORDER BY revision LIMIT $4 FOR SHARE",[org,actor,d.domain_id,MAX_READ_ROWS+1],readColumns.policy);
  const dimensions=await readComplete(u.tx,"SELECT * FROM public.dimension_definitions WHERE org_id=$1 AND owner_user_id=$2 AND domain_id=$3 ORDER BY policy_version_id,measurement_id LIMIT $4 FOR SHARE",[org,actor,d.domain_id,MAX_READ_ROWS+1],readColumns.dimension);
  const configurations=ps.map(p=>{
    const c=parse(DomainConfigurationSchema,p.configuration);
    requireValid(c.organizationId===org&&c.ownerUserId===actor&&c.domainId===d.domain_id&&c.policyVersionId===p.policy_version_id&&
      c.revision===p.revision&&(c.previousVersionId??null)===p.previous_version_id&&ticks(c.effectiveFrom)===ticks(p.raw.effective_from));
    const defs=dimensions.filter(x=>x.policy_version_id===p.policy_version_id);
    requireValid(defs.length===c.measurements.length&&c.measurements.every(m=>defs.some(x=>x.measurement_id===m.measurementId&&equal(x.definition,m))));
    return c;
  });
  requireValid(configurations.length>0&&ConfigurationBundleSchema.safeParse({schemaVersion:1,configurations,observations:[]}).success&&
    dimensions.length===configurations.reduce((n,c)=>n+c.measurements.length,0));
  const bs=await readComplete(u.tx,"SELECT * FROM public.source_bindings WHERE org_id=$1 AND owner_user_id=$2 AND domain_id=$3 AND source_kind='manual-legacy' AND external_id=$4 LIMIT 2 FOR SHARE",[org,actor,d.domain_id,slug],readColumns.binding,2);
  requireValid(bs.length===1&&equal(bs[0].metadata,{description:"existing-owner-seed-v1"}));
  return {domain:d,configurations};
}
async function mappingEvidence(u:MutationUnit,slug:string) {
  let pending=u.mappingEvidence.get(slug);
  if(!pending){pending=loadMappingEvidence(u,slug);u.mappingEvidence.set(slug,pending);}
  return pending;
}
async function mapping(u:MutationUnit,source:Row):Promise<Row> {
  const {orgId:org,actorUserId:actor}=u.context;
  requireValid(source.user_id===actor&&typeof source.id==="string"&&domainEnum.includes(source.domain)&&
    Number.isInteger(source.duration_minutes)&&source.duration_minutes>0&&typeof source.is_anomaly==="boolean"&&
    (source.notes===null||typeof source.notes==="string")&&(source.anomaly_note===null||typeof source.anomaly_note==="string"));
  if(source.deleted_at!==null)ticks(source.deleted_at);
  const {domain:d,configurations}=await mappingEvidence(u,source.domain);
  const c=configurations.filter(c=>ticks(c.effectiveFrom)<=ticks(source.timestamp)).at(-1);requireValid(c);
  const ms=c.measurements.filter(m=>m.kind==="duration");requireValid(ms.length===1);
  const m=ms[0];requireValid(m.valueType==="number"&&m.unit.unitId==="minute"&&m.unit.dimension==="time"&&
    m.scope.kind==="per_event"&&m.taskVariantId===undefined);
  const oid=observationId(org,actor,source.id);
  const observation=parse(ObservationSchema,{schemaVersion:1,observationId:oid,organizationId:org,ownerUserId:actor,domainId:d.domain_id,
    policyVersionId:c.policyVersionId,observedAt:source.timestamp,
    values:{[m.measurementId]:{valueType:"number",unitId:"minute",value:source.duration_minutes}},
    ...(source.notes===null?{}:{notes:source.notes})});
  requireValid(ConfigurationBundleSchema.safeParse({schemaVersion:1,configurations,observations:[observation]}).success);
  return {observation_id:oid,org_id:org,owner_user_id:actor,domain_id:d.domain_id,policy_version_id:c.policyVersionId,
    idempotency_key:`legacy-sessions-v1:${hash(org,actor,source.id)}`,observed_at:source.timestamp,observation,
    is_anomaly:source.is_anomaly,anomaly_note:source.anomaly_note,deleted_at:source.deleted_at,legacy_source_type:"sessions",legacy_source_id:source.id};
}
async function canonical(u:MutationUnit,source:Row) {
  const expected=await mapping(u,source),r=await readComplete(u.tx,`SELECT to_jsonb(o) raw FROM public.observations o
    WHERE org_id=$1 AND owner_user_id=$2 AND (legacy_source_id=$3 OR observation_id=$4 OR idempotency_key=$5) LIMIT 2 FOR UPDATE`,
    [u.context.orgId,u.context.actorUserId,source.id,expected.observation_id,expected.idempotency_key],["raw"],2);
  requireValid(r.length===1&&equal(r[0].raw,expected));return r[0].raw as Row;
}
async function lineage(u:MutationUnit,current:State,writeIntent=false):Promise<number> {
  const {orgId:org,actorUserId:actor}=u.context,sourceId=current.legacy.id;
  const audits=(await readComplete(u.tx,`SELECT to_jsonb(a) raw FROM public.audit_events a WHERE org_id=$1 AND entity_id=$2
    AND entity_type IN ('legacy_session_import','legacy_session_mutation') ORDER BY audit_event_id LIMIT $3 FOR SHARE`,
    [org,JSON.stringify([sourceId]),MAX_READ_ROWS+1],["raw"])).map(r=>r.raw);
  if(writeIntent&&audits.length>=MAX_READ_ROWS)throw new ResourceLimitError();
  requireValid(audits.every(a=>a.org_id===org&&a.actor_kind==="user"&&a.actor_user_id===actor));
  const imports=audits.filter(a=>a.entity_type==="legacy_session_import"),mutations=audits.filter(a=>a.entity_type===entity);
  requireValid(imports.length<=1);
  let previous:State|null=null;
  if(imports.length){
    const a=imports[0],after=a.after;
    requireValid(a.action==="create"&&a.before===null&&after?.version==="legacy-history-import-v1"&&
      after.sourceType==="sessions"&&after.sourceId===sourceId&&after.importedAt===a.occurred_at&&
      after.sourceSnapshot?.kind==="current-row-at-import-not-historical-after");
    previous={legacy:after.sourceSnapshot.row,canonical:after.importedObservation};
    requireValid(previous.legacy.id===sourceId&&equal(await mapping(u,previous.legacy),previous.canonical));
  }
  mutations.sort((a,b)=>(a.after?.sequence??0)-(b.after?.sequence??0));
  for(let i=0;i<mutations.length;i++){
    const a=mutations[i];
    const next=a.after;requireValid(next?.version===version&&next.sequence===i+1&&
      ["create","edit","soft-delete","restore"].includes(next.operation)&&equal(a.before,previous)&&
      typeof a.reason==="string"&&!!a.reason.trim()&&next.state?.legacy?.id===sourceId&&
      equal(await mapping(u,next.state.legacy),next.state.canonical));
    if(next.operation==="create")requireValid(i===0&&previous===null&&imports.length===0&&a.action==="create");
    else requireValid(previous!==null&&a.action==="update");
    if(next.operation==="create")requireValid(next.state.legacy.deleted_at===null);
    else {
      const expected={...previous!.legacy},prior:Row={};
      if(next.operation==="edit"){
        requireValid(previous!.legacy.deleted_at===null&&next.state.legacy.deleted_at===null&&updateSessionSchema.shape.reason.safeParse(a.reason).success);
        for(const [field,column]of [["domain","domain"],["durationMinutes","duration_minutes"],["timestamp","timestamp"],
          ["notes","notes"],["isAnomaly","is_anomaly"],["anomalyNote","anomaly_note"]]as const){
          const value=next.state.legacy[column],old=previous!.legacy[column];
          const same=field==="timestamp"?ticks(value)===ticks(old):equal(value,old);
          if(!same){expected[column]=value;prior[field]=old;}
        }
        let delta:unknown;try{delta=JSON.parse(next.legacyEdit?.changed_fields);}catch{throw new BoundaryError(400);}
        requireValid(equal(delta,prior));
      }else{
        const after=next.state.legacy.deleted_at,before=previous!.legacy.deleted_at;
        requireValid(next.operation==="restore"?before!==null&&after===null:before===null&&after!==null);
        expected.deleted_at=after;
      }
      requireValid(equal(expected,next.state.legacy));
    }
    if(next.operation==="edit"){
      const e=next.legacyEdit;requireValid(e?.session_id===sourceId&&e.user_id===actor&&e.reason===a.reason&&typeof e.changed_fields==="string");
      const edits=await readComplete(u.tx,"SELECT to_jsonb(e) raw FROM public.session_edits e WHERE id=$1 AND session_id=$2 AND user_id=$3 LIMIT 2 FOR SHARE",[e.id,sourceId,actor],["raw"],1);
      requireValid(edits.length===1&&equal(edits[0].raw,e));
    } else requireValid(!Object.hasOwn(next,"legacyEdit"));
    previous=next.state;
  }
  requireValid(previous!==null&&equal(previous,current));return mutations.length;
}
async function get(u:MutationUnit,key:string):Promise<State> {
  const r=await readComplete(u.tx,"SELECT to_jsonb(s) raw FROM public.sessions s WHERE id=$1 AND user_id=$2 LIMIT 2 FOR UPDATE",[key,u.context.actorUserId],["raw"],1);
  if(r.length!==1)throw new BoundaryError(404);const legacy=r[0].raw as Row;
  return {legacy,canonical:await canonical(u,legacy)};
}
async function writeCanonical(u:MutationUnit,legacy:Row,creating:boolean){
  const row=await mapping(u,legacy),columns=Object.keys(row),values=Object.values(row);
  const result=creating?await u.tx.query(`INSERT INTO public.observations (${columns.join(",")})
    VALUES (${columns.map((_,i)=>`$${i+1}`).join(",")}) RETURNING to_jsonb(observations) raw`,values):
    await u.tx.query(`UPDATE public.observations SET ${columns.filter(k=>!["observation_id","org_id","owner_user_id"].includes(k)).map(k=>`${k}=$${columns.indexOf(k)+1}`).join(",")}
    WHERE observation_id=$1 AND org_id=$2 AND owner_user_id=$3 RETURNING to_jsonb(observations) raw`,values);
  requireValid(result.rows.length===1&&equal(result.rows[0].raw,row));return row;
}
async function append(u:MutationUnit,operation:string,sequence:number,reason:string,before:State|null,after:State,edit?:Row){
  await createAuditService(u.tx,u.db,u.context).append(entity,[after.legacy.id],operation==="create"?"create":"update",reason,before,
    {version,operation,sequence,state:after,...(edit?{legacyEdit:edit}:{})});
}
/** Private mutation service only. No routes, ambient connection, seed/import, purge or startup hooks. */
export function createLegacyActivityMutations(unit:ReturnType<typeof createPinnedOwnershipUnit>){
  const run=<T>(request:Request,operation:(u:MutationUnit)=>Promise<T>)=>unit.run(request,async original=>{
    if(original.context.role!=="owner"||original.context.rolloutMode!=="legacy")throw new BoundaryError(403);
    return withTransactionReadBudget(original.tx,async tx=>{
      // Preserve the original pinned unit's nested-failure tracking while
      // making nested provenance reads inherit this exact guarded handle.
      const db:OwnershipDatabase={transaction:fn=>original.db.transaction(()=>fn(tx))};
      const context=await createOrgContextResolver(db)(request);
      if(context.orgId!==original.context.orgId||context.actorUserId!==original.context.actorUserId||
        context.role!==original.context.role||context.rolloutMode!==original.context.rolloutMode)throw new BoundaryError(403);
      const u:MutationUnit={tx,db,context,mappingEvidence:new Map()};
      await revalidate(tx,db,context);
      // Transaction-local canonical timestamp serialization, preserving microseconds.
      await tx.query("SELECT set_config('TimeZone','UTC',true)");
      return operation(u);
    });
  });
  const transition=(request:Request,input:unknown,restore:boolean)=>run(request,async u=>{
    const key=parse(id,input),before=await get(u,key),sequence=await lineage(u,before,true);
    if(restore?before.legacy.deleted_at===null:before.legacy.deleted_at!==null)throw new BoundaryError(404);
    const r=await u.tx.query(`UPDATE public.sessions SET deleted_at=${restore?"NULL":"clock_timestamp()"}
      WHERE id=$1 AND user_id=$2 RETURNING to_jsonb(sessions) raw`,[key,u.context.actorUserId]);
    requireValid(r.rows.length===1);const after={legacy:r.rows[0].raw,canonical:await writeCanonical(u,r.rows[0].raw,false)};
    await append(u,restore?"restore":"soft-delete",sequence+1,restore?"Restore recorded activity":"Soft-delete recorded activity",before,after);
    await lineage(u,after);return after.legacy;
  });
  return Object.freeze({
    create:(request:Request,input:unknown)=>run(request,async u=>{
      const p=parse(createSchema,input),anomaly=p.isAnomaly??false;
      requireValid(!anomaly||!!p.anomalyNote?.trim());
      const prospective={id:randomUUID(),user_id:u.context.actorUserId,domain:p.domain,duration_minutes:p.durationMinutes,
        timestamp:p.timestamp,notes:p.notes??null,is_anomaly:anomaly,anomaly_note:anomaly?p.anomalyNote:null,deleted_at:null};
      await mapping(u,prospective); // Complete target metadata before the first INSERT.
      const r=await u.tx.query(`INSERT INTO public.sessions(id,user_id,domain,duration_minutes,timestamp,notes,is_anomaly,anomaly_note)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING to_jsonb(sessions) raw`,
        [prospective.id,u.context.actorUserId,p.domain,p.durationMinutes,p.timestamp,p.notes??null,anomaly,anomaly?p.anomalyNote:null]);
      requireValid(r.rows.length===1);const after={legacy:r.rows[0].raw,canonical:await writeCanonical(u,r.rows[0].raw,true)};
      await append(u,"create",1,"Record activity",null,after);await lineage(u,after);return after.legacy;
    }),
    edit:(request:Request,input:unknown,patch:unknown)=>run(request,async u=>{
      const key=parse(id,input),p=parse(editSchema,patch),before=await get(u,key),sequence=await lineage(u,before,true);
      if(before.legacy.deleted_at!==null)throw new BoundaryError(404);
      const columns:Record<string,unknown>={},prior:Record<string,unknown>={};
      for(const [field,column]of [["domain","domain"],["durationMinutes","duration_minutes"],["timestamp","timestamp"],
        ["notes","notes"],["isAnomaly","is_anomaly"]]as const){
        const value=p[field];if(value===undefined)continue;
        const same=field==="timestamp"?ticks(value)===ticks(before.legacy[column]):equal(value,before.legacy[column]);
        if(!same){columns[column]=value;prior[field]=before.legacy[column];}
      }
      const anomaly=p.isAnomaly??before.legacy.is_anomaly;
      const note=anomaly?(p.anomalyNote??before.legacy.anomaly_note??null):null;
      if(p.isAnomaly===true)requireValid(typeof note==="string"&&!!note.trim());
      if(note!==before.legacy.anomaly_note){columns.anomaly_note=note;prior.anomalyNote=before.legacy.anomaly_note;}
      await mapping(u,{...before.legacy,...columns}); // Target policy overflow must precede any edit/audit insert.
      const e=await u.tx.query(`INSERT INTO public.session_edits(id,session_id,user_id,edited_at,reason,changed_fields)
        VALUES($1,$2,$3,clock_timestamp(),$4,$5) RETURNING to_jsonb(session_edits) raw`,[randomUUID(),key,u.context.actorUserId,p.reason,JSON.stringify(prior)]);
      requireValid(e.rows.length===1);
      let legacy=before.legacy;const names=Object.keys(columns);
      if(names.length){const r=await u.tx.query(`UPDATE public.sessions SET ${names.map((k,i)=>`${k}=$${i+3}`).join(",")}
        WHERE id=$1 AND user_id=$2 RETURNING to_jsonb(sessions) raw`,[key,u.context.actorUserId,...Object.values(columns)]);
        requireValid(r.rows.length===1);legacy=r.rows[0].raw;}
      const after={legacy,canonical:await writeCanonical(u,legacy,false)};
      await append(u,"edit",sequence+1,p.reason,before,after,e.rows[0].raw);await lineage(u,after);return legacy;
    }),
    softDelete:(request:Request,key:unknown)=>transition(request,key,false),
    restore:(request:Request,key:unknown)=>transition(request,key,true),
    /** Quiet, server-only collection gate. Locks prevent phantoms; no row is written or repaired. */
    reconcile:(request:Request)=>{
      try {
        const actor = (request?.user as {claims?:{sub?:unknown}} | undefined)?.claims?.sub;
        if (typeof request?.isAuthenticated !== "function" || request.isAuthenticated() !== true || !id.safeParse(actor).success)
          throw new BoundaryError(401);
      } catch { throw new BoundaryError(401); }
      for (const key of ["body","query","params"]) {
        const v = (request as any)[key];
        requireValid(v == null || (typeof v === "object" && !Array.isArray(v) && Reflect.ownKeys(v).length === 0));
      }
      return run(request,async u=>{
        // This is a bounded maintenance gate, not a request-path background task.
        await u.tx.query("LOCK TABLE public.sessions, public.session_edits, public.observations, public.audit_events IN SHARE MODE");
        const provenance = await verifyLegacyImportProvenance(u.db,request);
        const {orgId:org,actorUserId:actor} = u.context;
        const sessions = (await readComplete(u.tx,"SELECT to_jsonb(s) raw FROM public.sessions s WHERE user_id=$1 ORDER BY id LIMIT $2 FOR SHARE",[actor,MAX_READ_ROWS+1],["raw"])).map(r=>r.raw as Row);
        const observations = (await readComplete(u.tx,"SELECT to_jsonb(o) raw FROM public.observations o WHERE org_id=$1 AND owner_user_id=$2 ORDER BY observation_id LIMIT $3 FOR SHARE",[org,actor,MAX_READ_ROWS+1],["raw"])).map(r=>r.raw as Row);
        const edits = (await readComplete(u.tx,"SELECT to_jsonb(e) raw FROM public.session_edits e WHERE user_id=$1 OR session_id IN (SELECT id FROM public.sessions WHERE user_id=$1) ORDER BY id LIMIT $2 FOR SHARE",[actor,MAX_READ_ROWS+1],["raw"])).map(r=>r.raw as Row);
        const audits = (await readComplete(u.tx,"SELECT to_jsonb(a) raw FROM public.audit_events a WHERE org_id=$1 ORDER BY audit_event_id LIMIT $2 FOR SHARE",[org,MAX_READ_ROWS+1],["raw"])).map(r=>r.raw as Row);
        const relevant = audits.filter(a=>["legacy_session_import","legacy_edit_import",entity].includes(a.entity_type) ||
          [version,"legacy-history-import-v1"].includes(a.after?.version) || [version,"legacy-history-import-v1"].includes(a.before?.version));
        requireValid(relevant.every(a=>["legacy_session_import","legacy_edit_import",entity].includes(a.entity_type) &&
          a.actor_kind === "user" && a.actor_user_id === actor));
        const mutations = relevant.filter(a=>a.entity_type === entity);
        requireValid(mutations.every(a=>sessions.some(s=>s.id === a.after?.state?.legacy?.id) &&
          a.entity_id === JSON.stringify([a.after.state.legacy.id])));
        const editIds = relevant.filter(a=>a.entity_type === "legacy_edit_import").map(a=>a.before?.sourceEdit?.id);
        editIds.push(...mutations.filter(a=>a.after?.operation === "edit").map(a=>a.after?.legacyEdit?.id));
        requireValid(editIds.every(x=>typeof x === "string") && new Set(editIds).size === editIds.length &&
          edits.length === editIds.length && edits.every(e=>e.user_id === actor && editIds.includes(e.id) && sessions.some(s=>s.id === e.session_id)));
        let totalMutations = 0; const canonicalIds = new Set<string>();
        for (const s of sessions) {
          const state = await get(u,parse(id,s.id));
          requireValid(equal(state.legacy,s)); totalMutations += await lineage(u,state);
          canonicalIds.add(state.canonical.observation_id);
        }
        requireValid(canonicalIds.size === sessions.length && observations.length === sessions.length &&
          observations.every(o=>canonicalIds.has(o.observation_id)) && totalMutations === mutations.length);
        const domains = await readComplete(u.tx,"SELECT domain_id,slug FROM public.domains WHERE org_id=$1 AND owner_user_id=$2 ORDER BY slug LIMIT $3 FOR SHARE",[org,actor,MAX_COLLECTION_ROWS+1],["domain_id","slug"],MAX_COLLECTION_ROWS);
        const summaries = domains.map(d=>{
          const legacy = sessions.filter(s=>s.domain === d.slug), canonical = observations.filter(o=>o.domain_id === d.domain_id);
          const count = (rows:Row[],old:boolean)=>({total:rows.length,active:rows.filter(r=>r.deleted_at === null).length,
            deleted:rows.filter(r=>r.deleted_at !== null).length,anomaly:rows.filter(r=>r.is_anomaly).length,
            durationMinutes:rows.reduce((n,r)=>n+(old?r.duration_minutes:Object.values(r.observation.values).reduce((m:number,v:any)=>m+v.value,0)),0)});
          const a=count(legacy,true), b=count(canonical,false); requireValid(equal(a,b));
          return {slug:d.slug,legacy:a,canonical:b};
        });
        const unowned = Number((await u.tx.query("SELECT count(*)::int n FROM public.sessions WHERE user_id IS NULL")).rows[0].n);
        return {clean:true,counts:{ownedSessions:sessions.length,canonicalSessions:observations.length,legacyEdits:edits.length,
          ...provenance,mutationEvents:totalMutations,unownedSessions:unowned},domains:summaries};
      });
    },
    verify:(request:Request,input:unknown)=>run(request,async u=>{
      const state=await get(u,parse(id,input));return {clean:true,mutations:await lineage(u,state)};
    }),
  });
}
