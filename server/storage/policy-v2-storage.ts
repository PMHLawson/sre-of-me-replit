import { z } from "zod";
import { createHash } from "node:crypto";
import { ConfigurationBundleSchema, DomainConfigurationSchema, ObservationSchema,
  validateProspectiveRevision, validateObservationContext } from "../../shared/domain-config";
import { createAuditService } from "../lib/audit-service";
import { ActivityCreateInputSchema, ActivityIdSchema, ActivitySubmissionKeySchema, ActivityListInputSchema,
  ActivityCursorPayloadSchema, ActivityTimestampSchema, ActivityViewSchema, validatePracticeValues,
  ActivityEditInputSchema,ActivityLifecycleInputSchema,
  type ActivityEditInput,type ActivityLifecycleInput,type ActivityView, type ActivityCursorPayload } from "../../shared/activity";
import { assertContext, revalidate, bounded, BoundaryError, type OrgContext, type OwnershipDatabase, type Transaction } from "../lib/org-context";

const id = z.string().min(1).max(200).refine(x => x.trim() === x && !/[\u0000-\u001f\u007f]/.test(x) && x !== "__proto__");
const text = z.string().trim().min(1).max(500);
const at = z.string().datetime({ offset: true });
const reasonSchema = text;
function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
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
  async function appendPolicy(tx:Transaction,input:unknown,reason:unknown) {
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
  const practicePrefix="personal-practice:v1:";
  const practiceColumns=["observation_id","org_id","owner_user_id","domain_id","policy_version_id","idempotency_key","observed_at",
    "observation","is_anomaly","anomaly_note","deleted_at","legacy_source_type","legacy_source_id"] as const;
  function practiceSnapshot(row:any) {
    if(!row||typeof row!=="object"||practiceColumns.some(column=>!Object.hasOwn(row,column)))throw new BoundaryError(503);
    return Object.fromEntries(practiceColumns.map(column=>[column,column==="observed_at"?persistedTime(row[column]):
      column==="deleted_at"&&row[column]!==null?persistedTime(row[column]):row[column]]));
  }
  function canonical(value:unknown):string {
    if(Array.isArray(value))return "["+value.map(canonical).join(",")+"]";
    if(value!==null&&typeof value==="object")return "{"+Object.keys(value).sort().map(key=>JSON.stringify(key)+":"+canonical((value as Record<string,unknown>)[key])).join(",")+"}";
    const result=JSON.stringify(value);if(result===undefined)throw new BoundaryError(503);return result;
  }
  const fingerprint=(row:any)=>createHash("sha256").update("personal-practice-state:v1:"+canonical(practiceSnapshot(row))).digest("hex");
  const practiceIdentity=(key:string)=>{
    const digest=createHash("sha256").update(JSON.stringify([...scope,key])).digest("hex");
    return {storageKey:practicePrefix+digest,activityId:"practice-v1-"+digest};
  };
  function persistedTime(value:unknown):string {
    const candidate=value instanceof Date?value.toISOString():value;
    const result=ActivityTimestampSchema.safeParse(candidate);
    if(!result.success)throw new BoundaryError(503);return result.data;
  }
  async function practiceHistory(tx:Transaction,domainId:string) {
    const domain=await get(tx,"domain",[domainId],true);
    const versions=(await tx.query(`SELECT *,effective_from=date_trunc('milliseconds',effective_from) AS __personal_millisecond_time
      FROM public.policy_versions WHERE org_id=$1 AND owner_user_id=$2
      AND domain_id=$3 ORDER BY revision FOR SHARE`,[...scope,domainId])).rows;
    if(!versions.length)return {domain,configurations:[] as import("../../shared/domain-config").DomainConfiguration[]};
    const bundle=ConfigurationBundleSchema.safeParse({schemaVersion:1,configurations:versions.map(p=>p.configuration),observations:[]});
    if(!bundle.success)throw new BoundaryError(503);
    for(let index=0;index<versions.length;index++) {
      const row=versions[index];
      const c=bundle.data.configurations[index];
      if(row.__personal_millisecond_time!==true||c.organizationId!==scope[0]||c.ownerUserId!==scope[1]||c.domainId!==domainId||c.policyVersionId!==row.policy_version_id||
        c.revision!==row.revision||(c.previousVersionId??null)!==row.previous_version_id||
        persistedTime(c.effectiveFrom)!==persistedTime(row.effective_from))throw new BoundaryError(503);
    }
    return {domain,configurations:bundle.data.configurations};
  }
  async function practicePolicy(tx:Transaction,domainId:string,policyId:string) {
    const {domain,configurations}=await practiceHistory(tx,domainId);
    const index=configurations.findIndex(p=>p.policyVersionId===policyId);
    if(index<0)throw new BoundaryError(404);
    const configuration=configurations[index];
    const dimensions=(await tx.query(`SELECT * FROM public.dimension_definitions WHERE org_id=$1 AND owner_user_id=$2
      AND domain_id=$3 AND policy_version_id=$4 ORDER BY measurement_id FOR SHARE`,[...scope,domainId,policyId])).rows;
    if(dimensions.length!==configuration.measurements.length||configuration.measurements.some(m=>
      dimensions.filter(d=>d.measurement_id===m.measurementId&&semanticEqual(d.definition,m)).length!==1))throw new BoundaryError(503);
    return {domain,configuration,next:configurations[index+1]};
  }
  function practiceRow(row:any,sqlPrecision=false) {
    if(sqlPrecision&&(row.__personal_millisecond_time!==true||row.__personal_deleted_millisecond_time!==true))throw new BoundaryError(503);
    if(row.org_id!==scope[0]||row.owner_user_id!==scope[1]||row.legacy_source_type!==null||row.legacy_source_id!==null||
      typeof row.idempotency_key!=="string"||!/^personal-practice:v1:[a-f0-9]{64}$/.test(row.idempotency_key)||
      row.observation_id!=="practice-v1-"+row.idempotency_key.slice(practicePrefix.length))throw new BoundaryError(503);
    const result=ObservationSchema.safeParse(row.observation);
    if(!result.success)throw new BoundaryError(503);
    const o=result.data;
    if(o.organizationId!==scope[0]||o.ownerUserId!==scope[1]||o.observationId!==row.observation_id||
      o.domainId!==row.domain_id||o.policyVersionId!==row.policy_version_id||persistedTime(o.observedAt)!==persistedTime(row.observed_at))
      throw new BoundaryError(503);
    return o;
  }
  async function originalPractice(tx:Transaction,row:any) {
    const audits=(await tx.query(`SELECT "after" FROM public.audit_events WHERE org_id=$1 AND actor_kind='user' AND actor_user_id=$2
      AND entity_type='observations' AND entity_id=$3 AND action='create' ORDER BY audit_event_id`,[...scope,JSON.stringify([row.observation_id])])).rows;
    if(audits.length!==1)throw new BoundaryError(503);
    const original=audits[0].after;
    if(!original||original.deleted_at!==null||original.idempotency_key!==row.idempotency_key||
      original.observation_id!==row.observation_id||original.domain_id!==row.domain_id)throw new BoundaryError(503);
    if(Object.keys(original).length!==practiceColumns.length)throw new BoundaryError(503);
    practiceSnapshot(original);
    const observation=practiceRow(original),{configuration,next}=await practicePolicy(tx,observation.domainId,observation.policyVersionId);
    const input=ActivityCreateInputSchema.safeParse({submissionKey:"audit-validation",domainId:observation.domainId,
      policyVersionId:observation.policyVersionId,practiceEvent:true,observedAt:observation.observedAt,values:observation.values,
      ...(observation.notes!==undefined?{notes:observation.notes}:{}),...(observation.context!==undefined?{context:observation.context}:{})});
    if(!input.success||!validatePracticeValues(configuration,input.data)||!validateObservationContext(configuration,observation).success||
      (next&&Date.parse(observation.observedAt)>=Date.parse(next.effectiveFrom)))throw new BoundaryError(503);
    return observation;
  }
  async function practiceView(tx:Transaction,row:any):Promise<ActivityView> {
    const o=practiceRow(row,true);await originalPractice(tx,row);
    const {configuration,next}=await practicePolicy(tx,o.domainId,o.policyVersionId);
    const input=ActivityCreateInputSchema.safeParse({submissionKey:"read-validation",domainId:o.domainId,
      policyVersionId:o.policyVersionId,practiceEvent:true,observedAt:o.observedAt,values:o.values,
      ...(o.notes!==undefined?{notes:o.notes}:{}),...(o.context!==undefined?{context:o.context}:{})});
    if(!input.success||!validatePracticeValues(configuration,input.data)||!validateObservationContext(configuration,o).success||
      (next&&Date.parse(o.observedAt)>=Date.parse(next.effectiveFrom)))throw new BoundaryError(503);
    const view=ActivityViewSchema.safeParse({activityId:o.observationId,ownerUserId:o.ownerUserId,domainId:o.domainId,
      policyVersionId:o.policyVersionId,practiceEvent:true,observedAt:o.observedAt,values:o.values,
      ...(o.notes!==undefined?{notes:o.notes}:{}),...(o.context!==undefined?{context:o.context}:{}),
      deletedAt:row.deleted_at===null?null:persistedTime(row.deleted_at),configuration,
      stateFingerprint:fingerprint(row),
      scoreAvailability:"not_calculated",attainmentAvailability:"not_calculated"});
    if(!view.success)throw new BoundaryError(503);return view.data;
  }
  async function manualRows(tx:Transaction,extra:string,args:unknown[],lock=false) {
    return (await tx.query(`SELECT *,observed_at=date_trunc('milliseconds',observed_at) AS __personal_millisecond_time,
      (deleted_at IS NULL OR deleted_at=date_trunc('milliseconds',deleted_at)) AS __personal_deleted_millisecond_time
      FROM public.observations WHERE org_id=$1 AND owner_user_id=$2
      AND idempotency_key LIKE 'personal-practice:v1:%' AND legacy_source_type IS NULL AND legacy_source_id IS NULL${extra}${lock?" FOR UPDATE":""}`,
      [...scope,...args])).rows;
  }
  type MutationOperation="edit"|"delete"|"restore";
  function mutationIdentities(activityId:string,key:string) {
    const digest="personal-practice-mutation:v1:"+createHash("sha256").update(JSON.stringify([...scope,activityId,key])).digest("hex");
    return (["edit","delete","restore"] as const).map(operation=>({operation,identity:[activityId,digest,operation]}));
  }
  async function validatedSnapshot(tx:Transaction,row:any) {
    if(!row||Object.keys(row).length!==practiceColumns.length)throw new BoundaryError(503);
    practiceSnapshot(row);const o=practiceRow(row),{configuration,next}=await practicePolicy(tx,o.domainId,o.policyVersionId);
    const input=ActivityCreateInputSchema.safeParse({submissionKey:"mutation-lineage",domainId:o.domainId,policyVersionId:o.policyVersionId,
      practiceEvent:true,observedAt:o.observedAt,values:o.values,...(o.notes!==undefined?{notes:o.notes}:{}),...(o.context!==undefined?{context:o.context}:{})});
    if(!input.success||!validatePracticeValues(configuration,input.data)||!validateObservationContext(configuration,o).success||
      (next&&Date.parse(o.observedAt)>=Date.parse(next.effectiveFrom)))throw new BoundaryError(503);
  }
  async function savedMutation(tx:Transaction,row:any,key:string) {
    const identities=mutationIdentities(row.observation_id,key);
    const audits=(await tx.query(`SELECT entity_id,reason,"before","after" FROM public.audit_events
      WHERE org_id=$1 AND actor_kind='user' AND actor_user_id=$2 AND entity_type='observations' AND action='update'
      AND entity_id=ANY($3::text[]) ORDER BY audit_event_id`,[...scope,identities.map(value=>JSON.stringify(value.identity))])).rows;
    if(audits.length>1)throw new BoundaryError(503);if(!audits.length)return null;
    const audit=audits[0],identity=identities.find(value=>JSON.stringify(value.identity)===audit.entity_id);
    if(!identity||!reasonSchema.safeParse(audit.reason).success||audit.reason!==audit.reason.trim())throw new BoundaryError(503);
    await validatedSnapshot(tx,audit.before);await validatedSnapshot(tx,audit.after);
    const before=practiceSnapshot(audit.before),after=practiceSnapshot(audit.after);
    if(before.observation_id!==row.observation_id||after.observation_id!==row.observation_id||
      ["observation_id","org_id","owner_user_id","domain_id","idempotency_key","is_anomaly","anomaly_note","legacy_source_type","legacy_source_id"]
        .some(column=>!semanticEqual(before[column],after[column])||!semanticEqual(before[column],row[column])))throw new BoundaryError(503);
    if(identity.operation==="edit") {
      if(before.deleted_at!==null||after.deleted_at!==null||semanticEqual(before.observation,after.observation))throw new BoundaryError(503);
    } else {
      if(!semanticEqual({...before,deleted_at:null},{...after,deleted_at:null})||
        (identity.operation==="delete"?(before.deleted_at!==null||after.deleted_at===null):(before.deleted_at===null||after.deleted_at!==null)))
        throw new BoundaryError(503);
    }
    return {operation:identity.operation,reason:audit.reason,before,after};
  }
  function proposedObservation(row:any,p:ActivityEditInput) {
    return {schemaVersion:1 as const,observationId:row.observation_id,organizationId:scope[0],ownerUserId:scope[1],domainId:row.domain_id,
      policyVersionId:p.policyVersionId,observedAt:p.observedAt,values:p.values,
      ...(p.notes!==undefined?{notes:p.notes}:{}),...(p.context!==undefined?{context:p.context}:{})};
  }
  async function activePractice(tx:Transaction,row:any,observation:any) {
    const policy=await practicePolicy(tx,row.domain_id,observation.policyVersionId);
    if(policy.domain.deactivated_at!==null||policy.domain.tombstoned_at!==null)throw new BoundaryError(400);
    const legacy=(await tx.query(`SELECT binding_id FROM public.source_bindings WHERE org_id=$1 AND owner_user_id=$2
      AND domain_id=$3 AND source_kind='manual-legacy' FOR SHARE`,[...scope,row.domain_id])).rows;
    if(legacy.length)throw new BoundaryError(400);
    const now=clock();if(!(now instanceof Date)||!Number.isFinite(now.getTime()))throw new BoundaryError(503);
    const p=parse(ActivityCreateInputSchema,{submissionKey:"mutation-validation",domainId:row.domain_id,policyVersionId:observation.policyVersionId,
      practiceEvent:true,observedAt:observation.observedAt,values:observation.values,
      ...(observation.notes!==undefined?{notes:observation.notes}:{}),...(observation.context!==undefined?{context:observation.context}:{})});
    if(Date.parse(p.observedAt)>now.getTime()||Date.parse(policy.configuration.effectiveFrom)>now.getTime()||
      Date.parse(p.observedAt)<Date.parse(policy.configuration.effectiveFrom)||
      (policy.next&&Date.parse(p.observedAt)>=Date.parse(policy.next.effectiveFrom))||
      !validatePracticeValues(policy.configuration,p)||!validateObservationContext(policy.configuration,observation).success)throw new BoundaryError(400);
  }
  async function mutatePractice(tx:Transaction,activityId:string,p:ActivityEditInput|ActivityLifecycleInput,operation:MutationOperation) {
    const rows=await manualRows(tx," AND observation_id=$3",[activityId],true);
    if(rows.length!==1)throw new BoundaryError(404);
    const row=rows[0];practiceRow(row,true);await originalPractice(tx,row);
    // Reconciliation happens before new-operation fingerprint, clock or active-state checks.
    const previous=await savedMutation(tx,row,p.mutationKey);
    if(previous) {
      if(previous.operation!==operation||previous.reason!==p.reason||fingerprint(previous.before)!==p.expectedStateFingerprint||
        (operation==="edit"&&!semanticEqual(previous.after.observation,proposedObservation(previous.before,p as ActivityEditInput))))
        throw new BoundaryError(400);
      return {mutationKey:p.mutationKey,changed:false,operation,activity:await practiceView(tx,row),appliedStateFingerprint:fingerprint(previous.after)};
    }
    const before=practiceSnapshot(row);
    if(fingerprint(row)!==p.expectedStateFingerprint)throw new BoundaryError(400);
    // Also validate the current saved raw state before deriving a new audited state.
    await validatedSnapshot(tx,before);
    let changed:any;
    if(operation==="edit") {
      if(row.deleted_at!==null)throw new BoundaryError(400);
      const observation=proposedObservation(row,p as ActivityEditInput);
      if(semanticEqual(observation,row.observation))throw new BoundaryError(400);
      await activePractice(tx,row,observation);
      changed=(await tx.query(`UPDATE public.observations SET policy_version_id=$4,observed_at=$5,observation=$6::jsonb
        WHERE org_id=$1 AND owner_user_id=$2 AND observation_id=$3 RETURNING *`,[...scope,activityId,observation.policyVersionId,
        observation.observedAt,JSON.stringify(observation)])).rows;
    } else if(operation==="delete") {
      if(row.deleted_at!==null)throw new BoundaryError(400);
      const now=clock();if(!(now instanceof Date)||!Number.isFinite(now.getTime()))throw new BoundaryError(503);
      changed=(await tx.query(`UPDATE public.observations SET deleted_at=$4 WHERE org_id=$1 AND owner_user_id=$2
        AND observation_id=$3 RETURNING *`,[...scope,activityId,now.toISOString()])).rows;
    } else {
      if(row.deleted_at===null)throw new BoundaryError(400);
      await activePractice(tx,row,row.observation);
      changed=(await tx.query(`UPDATE public.observations SET deleted_at=NULL WHERE org_id=$1 AND owner_user_id=$2
        AND observation_id=$3 RETURNING *`,[...scope,activityId])).rows;
    }
    if(changed.length!==1)throw new BoundaryError(404);
    const after=practiceSnapshot(changed[0]),identity=mutationIdentities(activityId,p.mutationKey).find(value=>value.operation===operation)!;
    await createAuditService(tx,db,context).append("observations",identity.identity,"update",p.reason,before,after);
    const updated=await manualRows(tx," AND observation_id=$3",[activityId]);
    if(updated.length!==1)throw new BoundaryError(503);
    return {mutationKey:p.mutationKey,changed:true,operation,activity:await practiceView(tx,updated[0]),appliedStateFingerprint:fingerprint(after)};
  }
  const personalPractice=Object.freeze({
    edit:(key:unknown,input:unknown)=>run(tx=>mutatePractice(tx,parse(ActivityIdSchema,key),parse(ActivityEditInputSchema,input),"edit")),
    delete:(key:unknown,input:unknown)=>run(tx=>mutatePractice(tx,parse(ActivityIdSchema,key),parse(ActivityLifecycleInputSchema,input),"delete")),
    restore:(key:unknown,input:unknown)=>run(tx=>mutatePractice(tx,parse(ActivityIdSchema,key),parse(ActivityLifecycleInputSchema,input),"restore")),
    mutation:(key:unknown,mutationKey:unknown)=>run(async tx=>{
      const activityId=parse(ActivityIdSchema,key),k=parse(ActivityIdSchema,mutationKey),rows=await manualRows(tx," AND observation_id=$3",[activityId]);
      if(rows.length!==1)throw new BoundaryError(404);const row=rows[0];practiceRow(row,true);await originalPractice(tx,row);
      const saved=await savedMutation(tx,row,k);if(!saved)throw new BoundaryError(404);
      return {mutationKey:k,changed:false,operation:saved.operation,activity:await practiceView(tx,row),appliedStateFingerprint:fingerprint(saved.after)};
    }),
    eligibility:(input:unknown)=>run(async tx=>{
      const domainId=parse(ActivityIdSchema,input),history=await practiceHistory(tx,domainId);
      const legacy=(await tx.query(`SELECT binding_id FROM public.source_bindings WHERE org_id=$1 AND owner_user_id=$2
        AND domain_id=$3 AND source_kind='manual-legacy' FOR SHARE`,[...scope,domainId])).rows;
      const now=clock();if(!(now instanceof Date)||!Number.isFinite(now.getTime()))throw new BoundaryError(503);
      if(history.domain.deactivated_at!==null||history.domain.tombstoned_at!==null)
        return {domainId,canCreate:false as const,reason:"inactive" as const};
      if(legacy.length)return {domainId,canCreate:false as const,reason:"legacy_writer" as const};
      const current=history.configurations.filter(c=>Date.parse(c.effectiveFrom)<=now.getTime()).at(-1);
      if(!current)return {domainId,canCreate:false as const,reason:"no_effective_policy" as const};
      await practicePolicy(tx,domainId,current.policyVersionId);
      return {domainId,canCreate:true as const,reason:null,effectivePolicyVersionId:current.policyVersionId};
    }),
    create:(input:unknown)=>run(async tx=>{
      const p=parse(ActivityCreateInputSchema,input),identity=practiceIdentity(p.submissionKey);
      // Domain, complete version chain and saved dimensions are locked before the trusted clock.
      const policy=await practicePolicy(tx,p.domainId,p.policyVersionId);
      const existing=await manualRows(tx," AND idempotency_key=$3",[identity.storageKey],true);
      if(existing.length>1)throw new BoundaryError(503);
      const observation={schemaVersion:1 as const,observationId:identity.activityId,organizationId:scope[0],ownerUserId:scope[1],
        domainId:p.domainId,policyVersionId:p.policyVersionId,observedAt:p.observedAt,values:p.values,
        ...(p.notes!==undefined?{notes:p.notes}:{}),...(p.context!==undefined?{context:p.context}:{})};
      if(existing.length) {
        const original=await originalPractice(tx,existing[0]);
        // Compare the immutable create snapshot, not a later corrected/deleted row.
        if(!semanticEqual(original,observation))throw new BoundaryError(400);
        return {created:false,submissionKey:p.submissionKey,activity:await practiceView(tx,existing[0])};
      }
      if(policy.domain.deactivated_at!==null||policy.domain.tombstoned_at!==null)throw new BoundaryError(400);
      const legacy=(await tx.query(`SELECT binding_id FROM public.source_bindings WHERE org_id=$1 AND owner_user_id=$2
        AND domain_id=$3 AND source_kind='manual-legacy' FOR SHARE`,[...scope,p.domainId])).rows;
      if(legacy.length)throw new BoundaryError(400);
      const now=clock();if(!(now instanceof Date)||!Number.isFinite(now.getTime()))throw new BoundaryError(503);
      if(Date.parse(p.observedAt)>now.getTime()||Date.parse(policy.configuration.effectiveFrom)>now.getTime()||
        Date.parse(p.observedAt)<Date.parse(policy.configuration.effectiveFrom)||
        (policy.next&&Date.parse(p.observedAt)>=Date.parse(policy.next.effectiveFrom))||
        !validatePracticeValues(policy.configuration,p)||!validateObservationContext(policy.configuration,observation).success)
        throw new BoundaryError(400);
      await insert(tx,"observation",{observation_id:identity.activityId,domain_id:p.domainId,policy_version_id:p.policyVersionId,
        idempotency_key:identity.storageKey,observed_at:p.observedAt,observation,legacy_source_type:null,legacy_source_id:null},"Recorded personal practice");
      const saved=await manualRows(tx," AND observation_id=$3",[identity.activityId]);
      if(saved.length!==1)throw new BoundaryError(503);
      return {created:true,submissionKey:p.submissionKey,activity:await practiceView(tx,saved[0])};
    }),
    read:(input:unknown)=>run(async tx=>{
      const key=parse(ActivityIdSchema,input),rows=await manualRows(tx," AND observation_id=$3",[key]);
      if(rows.length!==1)throw new BoundaryError(404);return practiceView(tx,rows[0]);
    }),
    submission:(input:unknown)=>run(async tx=>{
      const key=parse(ActivitySubmissionKeySchema,input),rows=await manualRows(tx," AND idempotency_key=$3",[practiceIdentity(key).storageKey]);
      if(rows.length!==1)throw new BoundaryError(404);return {submissionKey:key,activity:await practiceView(tx,rows[0])};
    }),
    list:(input:unknown)=>run(async tx=>{
      const p=parse(ActivityListInputSchema,input),cursorScope=createHash("sha256").update(JSON.stringify([...scope,p.domainId??null])).digest("hex");
      let cursor:ActivityCursorPayload|undefined;
      if(p.cursor) {
        try {
          if(!/^[A-Za-z0-9_-]+$/.test(p.cursor))throw 0;
          cursor=parse(ActivityCursorPayloadSchema,JSON.parse(Buffer.from(p.cursor,"base64url").toString("utf8")));
          if(cursor.scope!==cursorScope)throw 0;
        } catch {throw new BoundaryError(400);}
      }
      if(p.domainId)await get(tx,"domain",[p.domainId]);
      const rows=(await tx.query(`SELECT *,observed_at=date_trunc('milliseconds',observed_at) AS __personal_millisecond_time,
        (deleted_at IS NULL OR deleted_at=date_trunc('milliseconds',deleted_at)) AS __personal_deleted_millisecond_time
        FROM public.observations WHERE org_id=$1 AND owner_user_id=$2
        AND idempotency_key LIKE 'personal-practice:v1:%' AND legacy_source_type IS NULL AND legacy_source_id IS NULL
        AND ($3::text IS NULL OR domain_id=$3) AND ($4::timestamptz IS NULL OR (observed_at,observation_id)<($4::timestamptz,$5::text))
        ORDER BY observed_at DESC,observation_id DESC LIMIT $6`,[...scope,p.domainId??null,cursor?.observedAt??null,cursor?.activityId??null,p.limit+1])).rows;
      const selected=rows.slice(0,p.limit),activities:ActivityView[]=[];
      for(const row of selected)activities.push(await practiceView(tx,row));
      const last=activities.at(-1),nextCursor=rows.length>p.limit&&last?Buffer.from(JSON.stringify({version:1,scope:cursorScope,
        observedAt:last.observedAt,activityId:last.activityId})).toString("base64url"):null;
      return {activities,nextCursor};
    }),
  });
  return Object.freeze({
    personalPractice,
    workspace: () => run(async tx => {
      const organization=(await tx.query("SELECT org_id,display_name,rollout_mode FROM public.organizations WHERE org_id=$1",[context.orgId])).rows[0];
      const membership=(await tx.query("SELECT org_id,user_id,role FROM public.organization_members WHERE org_id=$1 AND user_id=$2",scope)).rows[0];
      return {organization,membership};
    }),
    domains:Object.freeze({...reads("domain"),
      create:(input:unknown,reason:unknown)=>run(tx=>{
        const p=parse(domainInput,input);return insert(tx,"domain",{domain_id:p.domainId,slug:p.slug,display_name:p.displayName},parse(reasonSchema,reason));
      }),
      // One transaction covers the domain, its first version, dimensions and all audits.
      // Used by the management service only after injecting authenticated identities.
      createWithPolicy:(input:unknown,configuration:unknown,reason:unknown)=>run(async tx=>{
        const p=parse(domainInput,input),c=parse(DomainConfigurationSchema,configuration),r=parse(reasonSchema,reason);owned(c);
        if(c.domainId!==p.domainId||c.displayName!==p.displayName||c.revision!==1||c.previousVersionId!==undefined)
          throw new BoundaryError(400);
        let domain;
        try { domain=await insert(tx,"domain",{domain_id:p.domainId,slug:p.slug,display_name:p.displayName},r); }
        catch(error) {
          // Do not expose another owner's row or PostgreSQL error details.
          // A reused org slug is a caller validation failure, including races.
          if((error as {code?:unknown;constraint?:unknown})?.code==="23505"&&
            (error as {constraint?:unknown}).constraint==="domains_slug")throw new BoundaryError(400);
          throw error;
        }
        const policy=await appendPolicy(tx,c,r);
        return {domain,policy};
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
      append:(input:unknown,reason:unknown)=>run(tx=>appendPolicy(tx,input,reason)),
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
