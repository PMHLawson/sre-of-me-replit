import { z } from "zod";
import { createHash } from "node:crypto";
import { ConfigurationBundleSchema, DomainConfigurationSchema, ObservationSchema,
  validateProspectiveRevision, validateObservationContext } from "../../shared/domain-config";
import { createAuditService } from "../lib/audit-service";
import { assertContext, revalidate, bounded, BoundaryError, type OrgContext, type OwnershipDatabase, type Transaction } from "../lib/org-context";

const id = z.string().min(1).max(200).refine(x => x.trim() === x && !/[\u0000-\u001f\u007f]/.test(x) && x !== "__proto__");
const text = z.string().trim().min(1).max(500);
const at = z.string().datetime({ offset: true });
const reasonSchema = text;
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value); if (!r.success) throw new BoundaryError(400); return r.data;
}
const domainInput = z.object({ domainId:id,slug:id,displayName:text }).strict();
const domainPatch = z.object({ displayName:text.optional(),deactivatedAt:at.nullable().optional(),tombstonedAt:at.nullable().optional() }).strict()
  .refine(v => Object.keys(v).length > 0);
const observationInput = z.object({ observation:ObservationSchema,idempotencyKey:id,sourceBindingId:id.optional() }).strict();
const bindingInput = z.object({ bindingId:id,domainId:id,sourceKind:id,externalId:id,
  metadata:z.object({ description:text.optional() }).strict().nullable().optional() }).strict();
const deviationInput = z.object({ deviationId:id,startAt:at,endAt:at.nullable(),scope:z.enum(["all","selected"]),
  type:z.enum(["stitch","substitute_target"]),reason:text,
  // Store declared intent only. Interpretation belongs to a later packet.
  policy:z.object({ note:text.optional() }).strict(),
  provenance:z.object({ description:text.optional() }).strict() }).strict()
  .refine(v => v.endAt === null || Date.parse(v.endAt) > Date.parse(v.startAt));
const evaluationInput = z.object({ resultId:id,domainId:id,policyVersionId:id,windowStart:at,windowEnd:at,
  timezone:text,dayStartHour:z.number().int().min(0).max(23),calculationVersion:id,inputFingerprint:id,
  eligibleDays:z.number().finite().nonnegative(),
  // No user-authored arbitrary scoring/explanation objects or nested identities.
  // This boundary stores a declared summary, not a scoring implementation.
  result:z.object({ summary:text }).strict(),components:z.array(z.object({ measurementId:id,value:z.number().finite() }).strict()),
  explanation:z.object({ summary:text }).strict() }).strict().refine(v => Date.parse(v.windowEnd)>Date.parse(v.windowStart));

const tables = {
  domain:{table:"domains",keys:["domain_id"]},
  policy:{table:"policy_versions",keys:["policy_version_id"]},
  dimension:{table:"dimension_definitions",keys:["policy_version_id","measurement_id"]},
  observation:{table:"observations",keys:["observation_id"]},
  evaluation:{table:"evaluation_results",keys:["result_id"]},
  deviation:{table:"deviations_v2",keys:["deviation_id"]},
  association:{table:"deviation_domains",keys:["deviation_id","domain_id"]},
  binding:{table:"source_bindings",keys:["binding_id"]},
} as const;
type Kind = keyof typeof tables;
function semanticEqual(a:unknown,b:unknown):boolean {
  if(a===b)return true;
  if(Array.isArray(a)||Array.isArray(b))
    return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((v,i)=>semanticEqual(v,b[i]));
  if(a===null||b===null||typeof a!=="object"||typeof b!=="object")return false;
  const x=a as Record<string,unknown>,y=b as Record<string,unknown>;
  return Object.keys(x).length===Object.keys(y).length&&Object.keys(x).every(k=>Object.hasOwn(y,k)&&semanticEqual(x[k],y[k]));
}
// Only constants above and static implementation-owned column names reach SQL.
// No raw table, expression, WHERE, transaction or SQL handle is returned.
export function createPolicyV2Storage(db: OwnershipDatabase, context: OrgContext,
  options:{clock?:()=>Date}={}) {
  assertContext(db,context);
  // Trusted server construction only; never forward request data here.
  if(!options||typeof options!=="object"||Object.keys(options).some(k=>k!=="clock")||
    (Object.hasOwn(options,"clock")&&typeof options.clock!=="function"))throw new BoundaryError(503);
  const clock=options.clock??(()=>new Date());
  const scope=[context.orgId,context.actorUserId];
  const run=<T>(fn:(tx:Transaction)=>Promise<T>) => bounded(() => db.transaction(async tx => {
    await revalidate(tx,db,context); return fn(tx);
  }));
  function identity(kind:Kind, input:unknown): string[] {
    return parse(z.array(id).length(tables[kind].keys.length),input);
  }
  async function get(tx:Transaction,kind:Kind,keys:string[],lock=false) {
    const spec=tables[kind];
    const r=await tx.query(`SELECT * FROM public.${spec.table} WHERE org_id=$1 AND owner_user_id=$2 AND ${
      spec.keys.map((k,i)=>`${k}=$${i+3}`).join(" AND ")}${lock?" FOR UPDATE":""}`,[...scope,...keys]);
    if(r.rows.length!==1)throw new BoundaryError(404);return r.rows[0];
  }
  async function list(tx:Transaction,kind:Kind,extra="",args:unknown[]=[]) {
    return (await tx.query(`SELECT * FROM public.${tables[kind].table} WHERE org_id=$1 AND owner_user_id=$2${extra}
      ORDER BY ${tables[kind].keys.join(",")}`,[...scope,...args])).rows;
  }
  async function insert(tx:Transaction,kind:Kind,values:Record<string,unknown>,reason:string) {
    const row={org_id:scope[0],owner_user_id:scope[1],...values},columns=Object.keys(row);
    const result=await tx.query(`INSERT INTO public.${tables[kind].table} (${columns.join(",")})
      VALUES (${columns.map((_,i)=>`$${i+1}`).join(",")}) RETURNING *`,Object.values(row));
    const after=result.rows[0];
    await createAuditService(tx,db,context).append(tables[kind].table,tables[kind].keys.map(k=>after[k]),"create",reason,null,after);
    return after;
  }
  async function update(tx:Transaction,kind:Kind,keys:string[],patch:Record<string,unknown>,reason:string) {
    const before=await get(tx,kind,keys,true),columns=Object.keys(patch),spec=tables[kind];
    const r=await tx.query(`UPDATE public.${spec.table} SET ${columns.map((k,i)=>`${k}=$${i+3+keys.length}`).join(",")}
      WHERE org_id=$1 AND owner_user_id=$2 AND ${spec.keys.map((k,i)=>`${k}=$${i+3}`).join(" AND ")} RETURNING *`,
    [...scope,...keys,...Object.values(patch)]);
    if(r.rows.length!==1)throw new BoundaryError(404);
    await createAuditService(tx,db,context).append(spec.table,keys,"update",reason,before,r.rows[0]);return r.rows[0];
  }
  async function remove(tx:Transaction,kind:"association"|"binding",keys:string[],reason:string) {
    const before=await get(tx,kind,keys,true),spec=tables[kind];
    await tx.query(`DELETE FROM public.${spec.table} WHERE org_id=$1 AND owner_user_id=$2 AND ${
      spec.keys.map((k,i)=>`${k}=$${i+3}`).join(" AND ")}`,[...scope,...keys]);
    await createAuditService(tx,db,context).append(spec.table,keys,"delete",reason,before,null);
  }
  function owned(payload:{organizationId:string;ownerUserId:string}) {
    if(payload.organizationId!==context.orgId||payload.ownerUserId!==context.actorUserId)throw new BoundaryError(404);
  }
  async function history(tx:Transaction,domainId:string) {
    await get(tx,"domain",[domainId],true);
    return (await list(tx,"policy"," AND domain_id=$3",[domainId])).sort((a,b)=>a.revision-b.revision);
  }
  // Read-only entity surfaces share one strictly constrained implementation.
  const reads = <K extends Kind>(kind:K) => Object.freeze({
    get: (keys:unknown) => run(tx=>get(tx,kind,identity(kind,keys))),
    list: () => run(tx=>list(tx,kind)),
    exists: (keys:unknown) => run(async tx=>{
      try{await get(tx,kind,identity(kind,keys));return true;}
      catch(e){if(e instanceof BoundaryError&&e.status===404)return false;throw e;}
    }),
  });
  return Object.freeze({
    workspace: () => run(async tx => {
      const organization=(await tx.query("SELECT org_id,display_name,rollout_mode FROM public.organizations WHERE org_id=$1",[context.orgId])).rows[0];
      const membership=(await tx.query("SELECT org_id,user_id,role FROM public.organization_members WHERE org_id=$1 AND user_id=$2",scope)).rows[0];
      return {organization,membership};
    }),
    domains:Object.freeze({...reads("domain"),
      create:(input:unknown,reason:unknown)=>run(tx=>{
        const p=parse(domainInput,input);return insert(tx,"domain",{domain_id:p.domainId,slug:p.slug,display_name:p.displayName},parse(reasonSchema,reason));
      }),
      update:(keys:unknown,input:unknown,reason:unknown)=>run(tx=>{
        const p=parse(domainPatch,input),v:Record<string,unknown>={};
        if(p.displayName!==undefined)v.display_name=p.displayName;
        if(p.deactivatedAt!==undefined)v.deactivated_at=p.deactivatedAt;
        if(p.tombstonedAt!==undefined)v.tombstoned_at=p.tombstonedAt;
        return update(tx,"domain",identity("domain",keys),v,parse(reasonSchema,reason));
      }),
    }),
    policies:Object.freeze({...reads("policy"),
      append:(input:unknown,reason:unknown)=>run(async tx=>{
        const c=parse(DomainConfigurationSchema,input),r=parse(reasonSchema,reason);owned(c);
        const previous=await history(tx,c.domainId),last=previous.at(-1);
        // Capture actual server time only AFTER acquiring domain/history locks.
        const now=clock();
        if(!(now instanceof Date)||!Number.isFinite(now.getTime()))throw new BoundaryError(503);
        if(Date.parse(c.effectiveFrom)<now.getTime())throw new BoundaryError(400);
        if(last?!validateProspectiveRevision(last.configuration,c,c.effectiveFrom).success:c.revision!==1)throw new BoundaryError(400);
        const persisted=await list(tx,"observation"," AND domain_id=$3",[c.domainId]);
        if(!ConfigurationBundleSchema.safeParse({schemaVersion:1,configurations:[...previous.map(p=>p.configuration),c],observations:persisted.map(o=>o.observation)}).success)
          throw new BoundaryError(400);
        const result=await insert(tx,"policy",{policy_version_id:c.policyVersionId,domain_id:c.domainId,revision:c.revision,
          effective_from:c.effectiveFrom,previous_version_id:c.previousVersionId??null,configuration:c},r);
        for(const m of c.measurements)await insert(tx,"dimension",{domain_id:c.domainId,policy_version_id:c.policyVersionId,measurement_id:m.measurementId,definition:m},r);
        return result;
      }),
    }),
    dimensions:reads("dimension"),
    observations:Object.freeze({...reads("observation"),
      create:(input:unknown,reason:unknown)=>run(async tx=>{
        const p=parse(observationInput,input),o=p.observation,r=parse(reasonSchema,reason);owned(o);
        const configs=await history(tx,o.domainId),policy=await get(tx,"policy",[o.policyVersionId]);
        if(!validateObservationContext(policy.configuration,o).success ||
          !ConfigurationBundleSchema.safeParse({schemaVersion:1,configurations:configs.map(p=>p.configuration),observations:[o]}).success)throw new BoundaryError(400);
        if(p.sourceBindingId){const b=await get(tx,"binding",[p.sourceBindingId]);if(b.domain_id!==o.domainId)throw new BoundaryError(404);}
        // Versioned, unambiguous authenticated tuple: caller keys are independent
        // across owners/orgs. Scoped lookup only; no legacy raw-key fallback.
        const storageKey="observation:v1:"+createHash("sha256").update(JSON.stringify([context.orgId,context.actorUserId,p.idempotencyKey])).digest("hex");
        const found=await list(tx,"observation"," AND idempotency_key=$3",[storageKey]);
        if(found.length){
          if(found.length!==1||found[0].observation_id!==o.observationId||
            !semanticEqual(parse(ObservationSchema,found[0].observation),o))throw new BoundaryError(400);
          return found[0];
        }
        return insert(tx,"observation",{observation_id:o.observationId,domain_id:o.domainId,policy_version_id:o.policyVersionId,
          idempotency_key:storageKey,observed_at:o.observedAt,observation:o},r);
      }),
      delete:(keys:unknown,reason:unknown)=>run(tx=>update(tx,"observation",identity("observation",keys),{deleted_at:new Date()},parse(reasonSchema,reason))),
    }),
    evaluations:Object.freeze({...reads("evaluation"),
      create:(input:unknown,reason:unknown)=>run(async tx=>{
        const p=parse(evaluationInput,input),r=parse(reasonSchema,reason);
        await get(tx,"domain",[p.domainId]);const policy=await get(tx,"policy",[p.policyVersionId]);
        if(policy.domain_id!==p.domainId)throw new BoundaryError(404);
        const c=parse(DomainConfigurationSchema,policy.configuration);
        if(c.boundary.timezone!==p.timezone||c.boundary.dayStartHour!==p.dayStartHour||
          p.components.some(v=>!c.measurements.some(m=>m.measurementId===v.measurementId)))throw new BoundaryError(400);
        return insert(tx,"evaluation",{result_id:p.resultId,domain_id:p.domainId,policy_version_id:p.policyVersionId,
          window_start:p.windowStart,window_end:p.windowEnd,timezone:p.timezone,day_start_hour:p.dayStartHour,
          calculated_at:new Date(),calculation_version:p.calculationVersion,input_fingerprint:p.inputFingerprint,
          eligible_days:String(p.eligibleDays),result:p.result,components:JSON.stringify(p.components),explanation:p.explanation},r);
      }),
    }),
    deviations:Object.freeze({...reads("deviation"),
      create:(input:unknown,reason:unknown)=>run(tx=>{
        const p=parse(deviationInput,input);return insert(tx,"deviation",{deviation_id:p.deviationId,start_at:p.startAt,
          end_at:p.endAt,scope:p.scope,type:p.type,reason:p.reason,policy:p.policy,provenance:p.provenance},parse(reasonSchema,reason));
      }),
      end:(keys:unknown,endedAt:unknown,reason:unknown)=>run(async tx=>{
        const k=identity("deviation",keys),end=parse(at,endedAt),before=await get(tx,"deviation",k,true);
        if(Date.parse(end)<new Date(before.start_at).getTime())throw new BoundaryError(400);
        return update(tx,"deviation",k,{ended_at:end},parse(reasonSchema,reason));
      }),
      delete:(keys:unknown,reason:unknown)=>run(tx=>update(tx,"deviation",identity("deviation",keys),{deleted_at:new Date()},parse(reasonSchema,reason))),
    }),
    associations:Object.freeze({...reads("association"),
      create:(keys:unknown,reason:unknown)=>run(async tx=>{
        const [deviationId,domainId]=identity("association",keys),r=parse(reasonSchema,reason);
        const d=await get(tx,"deviation",[deviationId]);await get(tx,"domain",[domainId]);
        if(d.scope!=="selected")throw new BoundaryError(400);
        return insert(tx,"association",{deviation_id:deviationId,domain_id:domainId},r);
      }),
      delete:(keys:unknown,reason:unknown)=>run(tx=>remove(tx,"association",identity("association",keys),parse(reasonSchema,reason))),
    }),
    bindings:Object.freeze({...reads("binding"),
      create:(input:unknown,reason:unknown)=>run(async tx=>{
        const p=parse(bindingInput,input),r=parse(reasonSchema,reason);await get(tx,"domain",[p.domainId]);
        return insert(tx,"binding",{binding_id:p.bindingId,domain_id:p.domainId,source_kind:p.sourceKind,external_id:p.externalId,metadata:p.metadata??null},r);
      }),
      delete:(keys:unknown,reason:unknown)=>run(tx=>remove(tx,"binding",identity("binding",keys),parse(reasonSchema,reason))),
    }),
    audit:Object.freeze({
      list:()=>run(async tx=>(await tx.query(
        "SELECT * FROM public.audit_events WHERE org_id=$1 AND actor_kind='user' AND actor_user_id=$2 ORDER BY occurred_at,audit_event_id",scope)).rows),
      get:(input:unknown)=>run(async tx=>{
        const key=parse(id,input),r=await tx.query(
          "SELECT * FROM public.audit_events WHERE org_id=$1 AND actor_kind='user' AND actor_user_id=$2 AND audit_event_id=$3",[...scope,key]);
        if(r.rows.length!==1)throw new BoundaryError(404);return r.rows[0];
      }),
    }),
  });
}