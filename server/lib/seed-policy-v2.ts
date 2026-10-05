import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { DomainConfigurationSchema } from "../../shared/domain-config";
import { complianceWindowDaysSchema } from "../../shared/schema";
import { DOMAIN_POLICY } from "./policy-engine";
import { BoundaryError, bounded, createOrgContextResolver, type OwnershipDatabase, type Transaction } from "./org-context";
import { createAuditService } from "./audit-service";
import { createPolicyV2Storage } from "../storage/policy-v2-storage";

type Request = Parameters<ReturnType<typeof createOrgContextResolver>>[0];
const names=["martial-arts","meditation","fitness","music"] as const;
const marker="existing-owner-seed-v1";
const reason="Preserve authenticated owner's established legacy policy";
const canonicalOrg="Personal legacy workspace";
// Server-owned literal provenance, not an executable evaluator or request shape.
const provenance=Object.freeze({
  version:1,seed:marker,template:{id:"somr425-proposed",version:"2.0.0",calculationVersion:1},
  bands:[{band:"HEALTHY",minScore:90,attention:0},{band:"NEEDS_ATTENTION",minScore:70,attention:1},
    {band:"WARNING",minScore:50,attention:2},{band:"CRITICAL",minScore:0,attention:4}],
  guardrail:{zeroMandatoryForcesCritical:true,mandatoryCapThreshold:0.5,mandatoryCapBand:"WARNING"},
  trendStabilityEpsilon:2,weights:{duration:0.5,frequency:0.5},
  attention:{condition:{HEALTHY:0,NEEDS_ATTENTION:1,WARNING:2,CRITICAL:4},
    persistence:{NOMINAL:0,ADVISORY:1,WARNING:2,BREACH:3,CRITICAL:4},resolution:"maximum",inputAlias:{PAGE:"CRITICAL"}},
  differences:["Live v1 qualifying distinct logical days, not older draft event counts",
    "All minutes retained including subfloor events; no scoring activation",
    "Weekly basis fixed at seven; selected legacy window untouched"],
});
function deny():never{throw new BoundaryError(403);}
function iso(v:unknown):string{
  if(!(v instanceof Date)||!Number.isFinite(v.getTime()))throw new BoundaryError(400);
  return v.toISOString();
}
function config(org:string,actor:string,slug:typeof names[number],boundary:unknown,effective:string,anchor:string,
  ids:{domain:string;policy:string;duration:string;frequency:string;target:string;references:string[]}){
  const spec=DOMAIN_POLICY[slug];
  const floor={measurementId:ids.duration,unitId:"minute",valueType:"number",basis:{kind:"per_event"},
    constraint:{operator:"gte",value:spec.sessionFloor}};
  const evidence={category:"personal",source:{description:"Unreviewed existing-owner legacy practice floor; not a scientific or health minimum"},
    review:{status:"unreviewed"},confidence:"unknown"};
  return DomainConfigurationSchema.parse({
    schemaVersion:1,organizationId:org,ownerUserId:actor,domainId:ids.domain,policyVersionId:ids.policy,
    revision:1,effectiveFrom:effective,displayName:slug,
    templateLineage:{templateId:"somr425-proposed",templateVersionId:"2.0.0",revision:1},
    goal:{intent:"develop",desiredCapability:"Preserve the existing chosen practice target; capability details unspecified"},
    boundary,taskVariants:[],
    measurements:[
      {measurementId:ids.duration,displayName:"Duration",meaning:"All recorded practice minutes including subfloor events",
        kind:"duration",role:"practice",unit:{unitId:"minute",dimension:"time"},valueType:"number",aggregation:"sum",
        comparisonDirection:"higher_is_better",scope:{kind:"per_event"}},
      {measurementId:ids.frequency,displayName:"Qualifying days",meaning:"Distinct logical days with at least one individually qualifying event",
        kind:"frequency",role:"practice",unit:{unitId:"day",dimension:"days"},valueType:"integer",aggregation:"count",
        comparisonDirection:"higher_is_better",countBy:"distinct_days",scope:{kind:"period",windowDays:7}}],
    targets:{normal:{targetId:ids.target,conditions:[
      {...floor,basis:{kind:"period",windowDays:7},periodAggregation:{sourceBasis:"per_event",method:"sum"},
        constraint:{operator:"gte",value:spec.targetMinutes}},
      {measurementId:ids.frequency,unitId:"day",valueType:"integer",basis:{kind:"period",windowDays:7},
        constraint:{operator:"gte",value:spec.sessionsTarget}}]}},
    qualification:{kind:"condition",condition:floor},
    references:["develop","maintain","general_wellbeing"].map((purpose,i)=>({
      referenceId:ids.references[i],purpose,applicability:{description:"Personal existing-owner practice only"},evidence,
      ...(purpose==="develop"?{status:"known",conditions:[floor]}:{status:"unknown",note:"No minimum asserted"})})),
    review:{anchorAt:anchor,intervalDays:84},
  });
}
type SeedIds=Parameters<typeof config>[6];
/** Internal authenticated server seam. No connection, environment, clock or owner input. */
export async function seedPolicyV2(db:OwnershipDatabase,request:Request) {
  if(request?.isAuthenticated?.()!==true)throw new BoundaryError(401);
  const actor=(request.user as any)?.claims?.sub;
  if(typeof actor!=="string"||!actor.trim()||actor.trim()!==actor||actor.length>200||/[\u0000-\u001f\u007f]/.test(actor))
    throw new BoundaryError(401);
  // No request payload is a seed API. Pass the original authenticated request.
  for(const key of ["body","query","params"]){
    const value=(request as any)[key];
    if(value!=null&&(typeof value!=="object"||Object.keys(value).length))throw new BoundaryError(400);
  }
  return bounded(()=>db.transaction(async tx=>{
    if((await tx.query("SELECT id FROM public.users WHERE id=$1 FOR UPDATE",[actor])).rows.length!==1)deny();
    const members=(await tx.query("SELECT * FROM public.organization_members WHERE user_id=$1 ORDER BY org_id FOR UPDATE",[actor])).rows;
    if(members.length>1)deny();
    const history=(await tx.query("SELECT * FROM public.sessions WHERE user_id=$1 ORDER BY timestamp,id FOR SHARE",[actor])).rows;
    if(!history.length)deny();
    const earliest=new Map<string,string>();
    for(const row of history){
      if(!names.includes(row.domain)||!Number.isInteger(row.duration_minutes)||row.duration_minutes<=0)deny();
      const time=iso(row.timestamp);
      if(!earliest.has(row.domain))earliest.set(row.domain,time);
    }
    // Without activity for a domain there is no authorized historical date.
    if(earliest.size!==4)deny();
    const settings=(await tx.query("SELECT * FROM public.user_settings WHERE user_id=$1 FOR SHARE",[actor])).rows;
    if(settings.length!==1)deny();
    const setting=settings[0];
    if(!Number.isInteger(setting.day_start_hour)||setting.day_start_hour<0||setting.day_start_hour>23||
      typeof setting.timezone!=="string"||!setting.timezone.length||setting.timezone.length>64||
      !complianceWindowDaysSchema.safeParse(setting.window_days).success)deny();
    try{new Intl.DateTimeFormat("en-US",{timeZone:setting.timezone});}catch{deny();}
    const boundary={timezone:setting.timezone,dayStartHour:setting.day_start_hour};
    const fresh=members.length===0,org=fresh?randomUUID():members[0].org_id;
    let organization:any,membership:any;
    if(fresh){
      organization=(await tx.query("INSERT INTO public.organizations(org_id,display_name,rollout_mode) VALUES($1,$2,'legacy') RETURNING *",[org,canonicalOrg])).rows[0];
      membership=(await tx.query("INSERT INTO public.organization_members(org_id,user_id,role) VALUES($1,$2,'owner') RETURNING *",[org,actor])).rows[0];
    }else{
      organization=(await tx.query("SELECT * FROM public.organizations WHERE org_id=$1 FOR UPDATE",[org])).rows[0];
      if(!organization||organization.rollout_mode!=="legacy"||organization.display_name!==canonicalOrg||members[0].role!=="owner")deny();
      const all=(await tx.query("SELECT * FROM public.organization_members WHERE org_id=$1 FOR SHARE",[org])).rows;
      if(all.length!==1||all[0].user_id!==actor)deny();
    }
    // Exact same transaction throughout: no nested BEGIN/COMMIT or forged request.
    const pinned:OwnershipDatabase={transaction:async fn=>fn(tx)};
    const context=await createOrgContextResolver(pinned)(request);
    if(context.actorUserId!==actor||context.orgId!==org)deny();
    const audit=createAuditService(tx,pinned,context),storage=createPolicyV2Storage(pinned,context);
    const [domains,policies,dimensions,bindings]=await Promise.all([
      storage.domains.list(),storage.policies.list(),storage.dimensions.list(),storage.bindings.list()]);
    for(const table of ["observations","evaluation_results","deviations_v2","deviation_domains"]){
      if((await tx.query(`SELECT 1 FROM public.${table} WHERE org_id=$1 AND owner_user_id=$2 LIMIT 1`,[org,actor])).rows.length)deny();
    }
    const mapping:Record<string,{domainId:string;policyVersionId:string;bindingId:string}>={};
    if(!fresh){
      if(domains.length!==4||policies.length!==4||dimensions.length!==8||bindings.length!==4)deny();
      const anchors=new Set<string>(),allIds:string[]=[];
      for(const slug of names){
        const d=domains.find(d=>d.slug===slug),b=bindings.find(b=>b.external_id===slug);
        if(!d||!b||d.deactivated_at||d.tombstoned_at||d.display_name!==slug||b.domain_id!==d.domain_id||
          b.source_kind!=="manual-legacy"||!isDeepStrictEqual(b.metadata,{description:marker}))deny();
        const p=policies.find(p=>p.domain_id===d.domain_id);
        if(!p||p.revision!==1||p.previous_version_id!==null||!isDeepStrictEqual(p.evaluation_policy,provenance))deny();
        const c=DomainConfigurationSchema.parse(p.configuration);
        const ids:SeedIds={domain:d.domain_id,policy:p.policy_version_id,duration:c.measurements[0]?.measurementId,
          frequency:c.measurements[1]?.measurementId,target:c.targets.normal.targetId,references:c.references.map(r=>r.referenceId)};
        if(ids.references.length!==3)deny();
        allIds.push(ids.domain,ids.policy,ids.duration,ids.frequency,ids.target,...ids.references,b.binding_id);
        anchors.add(c.review.anchorAt);
        if(!isDeepStrictEqual(c,config(org,actor,slug,boundary,earliest.get(slug)!,c.review.anchorAt,ids))||
          iso(p.effective_from)!==earliest.get(slug))deny();
        for(const m of c.measurements){
          const dd=dimensions.find(x=>x.policy_version_id===p.policy_version_id&&x.measurement_id===m.measurementId);
          if(!dd||dd.domain_id!==d.domain_id||!isDeepStrictEqual(dd.definition,m))deny();
        }
        mapping[slug]={domainId:d.domain_id,policyVersionId:p.policy_version_id,bindingId:b.binding_id};
      }
      if(anchors.size!==1||new Set(allIds).size!==allIds.length||allIds.some(x=>!/^[0-9a-f-]{36}$/.test(x)))deny();
      const events=await storage.audit.list();
      const expected=[
        {type:"organizations",keys:[org],row:organization},
        {type:"organization_members",keys:[org,actor],row:members[0]},
        ...domains.map(row=>({type:"domains",keys:[row.domain_id],row})),
        ...policies.map(row=>({type:"policy_versions",keys:[row.policy_version_id],row})),
        ...dimensions.map(row=>({type:"dimension_definitions",keys:[row.policy_version_id,row.measurement_id],row})),
        ...bindings.map(row=>({type:"source_bindings",keys:[row.binding_id],row})),
      ];
      if(events.length!==expected.length)deny();
      for(const e of expected){
        const matching=events.filter(a=>a.entity_type===e.type&&a.entity_id===JSON.stringify(e.keys));
        if(matching.length!==1||matching[0].action!=="create"||matching[0].reason!==reason||matching[0].before!==null||
          !isDeepStrictEqual(matching[0].after,JSON.parse(JSON.stringify(e.row))))deny();
      }
      return mapping;
    }
    if(domains.length||policies.length||dimensions.length||bindings.length)deny();
    await audit.append("organizations",[org],"create",reason,null,organization);
    await audit.append("organization_members",[org,actor],"create",reason,null,membership);
    const anchor=new Date().toISOString();
    // Private historical insertion: only fresh, validated revision-one chains.
    async function historical(c:ReturnType<typeof config>){
      const p=(await tx.query(`INSERT INTO public.policy_versions
        (policy_version_id,org_id,owner_user_id,domain_id,revision,effective_from,configuration,evaluation_policy)
        VALUES($1,$2,$3,$4,1,$5,$6,$7) RETURNING *`,
      [c.policyVersionId,org,actor,c.domainId,c.effectiveFrom,c,provenance])).rows[0];
      await audit.append("policy_versions",[c.policyVersionId],"create",reason,null,p);
      for(const m of c.measurements){
        const dd=(await tx.query(`INSERT INTO public.dimension_definitions
          (org_id,owner_user_id,domain_id,policy_version_id,measurement_id,definition)
          VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[org,actor,c.domainId,c.policyVersionId,m.measurementId,m])).rows[0];
        await audit.append("dimension_definitions",[c.policyVersionId,m.measurementId],"create",reason,null,dd);
      }
    }
    for(const slug of names){
      const ids:SeedIds={domain:randomUUID(),policy:randomUUID(),duration:randomUUID(),frequency:randomUUID(),target:randomUUID(),
        references:[randomUUID(),randomUUID(),randomUUID()]},bindingId=randomUUID();
      const c=config(org,actor,slug,boundary,earliest.get(slug)!,anchor,ids);
      await storage.domains.create({domainId:ids.domain,slug,displayName:slug},reason);
      await historical(c);
      await storage.bindings.create({bindingId,domainId:ids.domain,sourceKind:"manual-legacy",externalId:slug,metadata:{description:marker}},reason);
      mapping[slug]={domainId:ids.domain,policyVersionId:ids.policy,bindingId};
    }
    return mapping;
  }));
}