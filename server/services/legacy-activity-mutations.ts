import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual as equal } from "node:util";
import { z } from "zod";
import { domainEnum, updateSessionSchema } from "../../shared/schema";
import { ConfigurationBundleSchema, DomainConfigurationSchema, ObservationSchema } from "../../shared/domain-config";
import { BoundaryError, revalidate } from "../lib/org-context";
import { createAuditService } from "../lib/audit-service";
import { createPinnedOwnershipUnit, type OwnershipUnit } from "../lib/pinned-ownership-unit";

type Request = Parameters<ReturnType<typeof createPinnedOwnershipUnit>["run"]>[0];
type Row = Record<string, any>;
type State = { legacy: Row; canonical: Row };
const version = "legacy-activity-mutation-v1";
const entity = "legacy_session_mutation";
const id = z.string().min(1).max(200).refine(x => x.trim() === x && !/[\u0000-\u001f\u007f]/.test(x) && x !== "__proto__");
const createSchema = z.object({ domain: z.enum(domainEnum), durationMinutes: z.number().int().positive(),
  timestamp: z.string().datetime({offset:true}), notes: z.string().optional(),
  isAnomaly: z.boolean().optional(), anomalyNote: z.string().nullable().optional() }).strict();
const editSchema = updateSessionSchema.strict();
function parse<T>(schema:z.ZodType<T>,input:unknown):T {
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
async function mapping(u:OwnershipUnit,source:Row):Promise<Row> {
  const {orgId:org,actorUserId:actor}=u.context;
  requireValid(source.user_id===actor&&typeof source.id==="string"&&domainEnum.includes(source.domain)&&
    Number.isInteger(source.duration_minutes)&&source.duration_minutes>0&&typeof source.is_anomaly==="boolean"&&
    (source.notes===null||typeof source.notes==="string")&&(source.anomaly_note===null||typeof source.anomaly_note==="string"));
  if(source.deleted_at!==null)ticks(source.deleted_at);
  const ds=(await u.tx.query("SELECT * FROM public.domains WHERE org_id=$1 AND owner_user_id=$2 AND slug=$3 FOR SHARE",[org,actor,source.domain])).rows;
  requireValid(ds.length===1&&ds[0].deactivated_at===null&&ds[0].tombstoned_at===null);const d=ds[0];
  const ps=(await u.tx.query("SELECT p.*,to_jsonb(p) raw FROM public.policy_versions p WHERE org_id=$1 AND owner_user_id=$2 AND domain_id=$3 ORDER BY revision FOR SHARE",[org,actor,d.domain_id])).rows;
  const dimensions=(await u.tx.query("SELECT * FROM public.dimension_definitions WHERE org_id=$1 AND owner_user_id=$2 AND domain_id=$3 FOR SHARE",[org,actor,d.domain_id])).rows;
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
  const c=configurations.filter(c=>ticks(c.effectiveFrom)<=ticks(source.timestamp)).at(-1);requireValid(c);
  const ms=c.measurements.filter(m=>m.kind==="duration");requireValid(ms.length===1);
  const m=ms[0];requireValid(m.valueType==="number"&&m.unit.unitId==="minute"&&m.unit.dimension==="time"&&
    m.scope.kind==="per_event"&&m.taskVariantId===undefined);
  const bs=(await u.tx.query("SELECT * FROM public.source_bindings WHERE org_id=$1 AND owner_user_id=$2 AND domain_id=$3 AND source_kind='manual-legacy' AND external_id=$4 FOR SHARE",[org,actor,d.domain_id,source.domain])).rows;
  requireValid(bs.length===1&&equal(bs[0].metadata,{description:"existing-owner-seed-v1"}));
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
async function canonical(u:OwnershipUnit,source:Row) {
  const expected=await mapping(u,source),r=(await u.tx.query(`SELECT to_jsonb(o) raw FROM public.observations o
    WHERE org_id=$1 AND owner_user_id=$2 AND (legacy_source_id=$3 OR observation_id=$4 OR idempotency_key=$5) FOR UPDATE`,
    [u.context.orgId,u.context.actorUserId,source.id,expected.observation_id,expected.idempotency_key])).rows;
  requireValid(r.length===1&&equal(r[0].raw,expected));return r[0].raw as Row;
}
async function lineage(u:OwnershipUnit,current:State):Promise<number> {
  const {orgId:org,actorUserId:actor}=u.context,sourceId=current.legacy.id;
  const audits=(await u.tx.query(`SELECT to_jsonb(a) raw FROM public.audit_events a WHERE org_id=$1 AND entity_id=$2
    AND entity_type IN ('legacy_session_import','legacy_session_mutation') FOR SHARE`,[org,JSON.stringify([sourceId])])).rows.map(r=>r.raw);
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
    if(next.operation==="edit"){
      const e=next.legacyEdit;requireValid(e?.session_id===sourceId&&e.user_id===actor&&e.reason===a.reason&&typeof e.changed_fields==="string");
      const edits=(await u.tx.query("SELECT to_jsonb(e) raw FROM public.session_edits e WHERE id=$1 AND session_id=$2 AND user_id=$3 FOR SHARE",[e.id,sourceId,actor])).rows;
      requireValid(edits.length===1&&equal(edits[0].raw,e));
    } else requireValid(!Object.hasOwn(next,"legacyEdit"));
    previous=next.state;
  }
  requireValid(previous!==null&&equal(previous,current));return mutations.length;
}
async function get(u:OwnershipUnit,key:string):Promise<State> {
  const r=(await u.tx.query("SELECT to_jsonb(s) raw FROM public.sessions s WHERE id=$1 AND user_id=$2 FOR UPDATE",[key,u.context.actorUserId])).rows;
  if(r.length!==1)throw new BoundaryError(404);const legacy=r[0].raw as Row;
  return {legacy,canonical:await canonical(u,legacy)};
}
async function writeCanonical(u:OwnershipUnit,legacy:Row,creating:boolean){
  const row=await mapping(u,legacy),columns=Object.keys(row),values=Object.values(row);
  const result=creating?await u.tx.query(`INSERT INTO public.observations (${columns.join(",")})
    VALUES (${columns.map((_,i)=>`$${i+1}`).join(",")}) RETURNING to_jsonb(observations) raw`,values):
    await u.tx.query(`UPDATE public.observations SET ${columns.filter(k=>!["observation_id","org_id","owner_user_id"].includes(k)).map(k=>`${k}=$${columns.indexOf(k)+1}`).join(",")}
    WHERE observation_id=$1 AND org_id=$2 AND owner_user_id=$3 RETURNING to_jsonb(observations) raw`,values);
  requireValid(result.rows.length===1&&equal(result.rows[0].raw,row));return row;
}
async function append(u:OwnershipUnit,operation:string,sequence:number,reason:string,before:State|null,after:State,edit?:Row){
  await createAuditService(u.tx,u.db,u.context).append(entity,[after.legacy.id],operation==="create"?"create":"update",reason,before,
    {version,operation,sequence,state:after,...(edit?{legacyEdit:edit}:{})});
}
/** Private mutation service only. No routes, ambient connection, seed/import, purge or startup hooks. */
export function createLegacyActivityMutations(unit:ReturnType<typeof createPinnedOwnershipUnit>){
  const run=<T>(request:Request,operation:(u:OwnershipUnit)=>Promise<T>)=>unit.run(request,async u=>{
    if(u.context.role!=="owner"||u.context.rolloutMode!=="legacy")throw new BoundaryError(403);
    await revalidate(u.tx,u.db,u.context);
    // Transaction-local canonical timestamp serialization, preserving microseconds.
    await u.tx.query("SELECT set_config('TimeZone','UTC',true)");return operation(u);
  });
  const transition=(request:Request,input:unknown,restore:boolean)=>run(request,async u=>{
    const key=parse(id,input),before=await get(u,key),sequence=await lineage(u,before);
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
      const r=await u.tx.query(`INSERT INTO public.sessions(id,user_id,domain,duration_minutes,timestamp,notes,is_anomaly,anomaly_note)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING to_jsonb(sessions) raw`,
        [randomUUID(),u.context.actorUserId,p.domain,p.durationMinutes,p.timestamp,p.notes??null,anomaly,anomaly?p.anomalyNote:null]);
      requireValid(r.rows.length===1);const after={legacy:r.rows[0].raw,canonical:await writeCanonical(u,r.rows[0].raw,true)};
      await append(u,"create",1,"Record activity",null,after);await lineage(u,after);return after.legacy;
    }),
    edit:(request:Request,input:unknown,patch:unknown)=>run(request,async u=>{
      const key=parse(id,input),p=parse(editSchema,patch),before=await get(u,key),sequence=await lineage(u,before);
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
    verify:(request:Request,input:unknown)=>run(request,async u=>{
      const state=await get(u,parse(id,input));return {clean:true,mutations:await lineage(u,state)};
    }),
  });
}
