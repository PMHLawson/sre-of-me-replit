import { createHash } from "node:crypto";
import { ConfigurationBundleSchema, DomainConfigurationSchema, ObservationSchema,
  validateObservationContext, type DomainConfiguration, type Observation } from "../../shared/domain-config";
import { assembleWindow, instant, type Interval } from "../../shared/evaluator-window";
import { canonical } from "../../shared/evaluator-recipe";
import { createCadenceDeriver, type CadenceEpisode } from "../../shared/cadence-derived";
import { assertContext, revalidate, bounded, BoundaryError, type OwnershipDatabase, type OrgContext } from "../lib/org-context";
import { readComplete, withTransactionReadBudget, chargeReadBytes } from "../lib/transaction-read-budget";
import { MAX_READ_ROWS, ResourceLimitError } from "../lib/read-budget";

/**
 * Server assembly and read-only loader only: no route, configuration change or write.
 * A production source must authenticate/revalidate its owner and prove a complete
 * bounded read in its own pinned transaction. This module cannot establish those
 * facts from an array, a sourceId, or a caller's boolean.
 */
export type HistoryScope = { organizationId:string; ownerUserId:string; domainId:string };
export type HistoryObservation = { observation:unknown; deletedAt:string|null };
export type HistoryBreak = { breakId:string; scope:HistoryScope; interval:Interval };
export type HistorySnapshot = {
  snapshotId:string; capturedAt:string; scope:HistoryScope;
  configurations:unknown[]; observations:HistoryObservation[]; corrections:unknown[]; breaks:HistoryBreak[];
  databaseEvidence?:DatabaseHistoryEvidence;
};
export type CoverageOriginEvidence = {
  episodeId:string; at:string; sourceId:string; evidenceId:string;
  kind:"verified-empty-domain-activation"|"verified-source-reconciliation";
};
export type HistoryCoverageReceipt = {
  receiptId:string; snapshotId:string; snapshotFingerprint:string; scope:HistoryScope;
  completeFrom:string; completeThrough:string;
  counts:{configurations:number;observations:number;corrections:number;breaks:number};
  origins:CoverageOriginEvidence[];
};
export type EvaluationHistorySource = {
  load(scope:HistoryScope, now:string):Promise<HistorySnapshot>;
  /**
   * Must inspect independent activation/import/read receipts, not merely echo
   * the supplied snapshot or compute its hash. null means proof unavailable.
   * Never implement this by accepting a request-supplied approval flag.
   */
  verifyCoverage(snapshot:HistorySnapshot):Promise<HistoryCoverageReceipt|null>;
};
type Disposition = {
  index:number; observationId:string|null; fingerprint:string; episodeId:string|null;
  kind:"completed"|"today"|"future"|"deleted"|"other-policy-segment"|"invalid";
  reason?:string;
};
type Segment = {
  status:"assessed"|"pending"; policy:DomainConfiguration;
  episode:CadenceEpisode|null; policyInterval:{start:string;end:string|null};
  history:{sourceId:string;coveredFrom:string;coveredThrough:string;observations:Observation[];breaks:Interval[]}|null;
  cadence:ReturnType<ReturnType<typeof createCadenceDeriver>["evaluate"]>|{status:"unavailable";reason:string};
};
export type EvaluationHistoryAssembly = {
  status:"available"|"unavailable"; reason?:string; snapshotFingerprint:string|null;
  evidence:{snapshot:HistorySnapshot|null;coverage:HistoryCoverageReceipt|null;dispositions:Disposition[]};
  segments:Segment[];
  aggregate:{status:"unavailable";reason:"cross-version-aggregate-not-approved"|"scoring-recipe-not-supplied"};
  completeness:{kind:"verified-by-injected-server-source"|"unverified";databaseIntegration:"scoped-read-loader"};
};
const validId=(v:unknown):v is string=>typeof v==="string"&&v.length>0&&v.length<=200&&v.trim()===v&&
  !/[\u0000-\u001f\u007f]/.test(v)&&v!=="__proto__";
const validScope=(v:unknown):v is HistoryScope=>!!v&&typeof v==="object"&&
  ["organizationId","ownerUserId","domainId"].every(k=>validId((v as Record<string,unknown>)[k]))&&Object.keys(v).length===3;
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
const digest=(value:unknown)=>createHash("sha256").update("evaluation-history-v2:"+canonical(value)).digest("hex");
/** Stable source identity binds raw records, tombstones, corrections and breaks. */
export const evaluationHistoryFingerprint=(snapshot:HistorySnapshot)=>digest(snapshot);
const unsupportedPrecision=(value:unknown)=>typeof value==="string"&&
  /\.\d{3}(\d+)/.test(value)&&/[1-9]/.test(/\.\d{3}(\d+)/.exec(value)![1]);
const iso=(at:number)=>new Date(at).toISOString();
const inside=(at:number,start:string,end:string|null)=>at>=instant(start)&&(end===null||at<instant(end));

/**
 * Inject only trusted server construction. No request object, default source,
 * current-target fallback, floor/weight invention or whole-window score exists.
 * Registries are snapshotted so later caller mutation cannot change history.
 */
function createHistoryAssembler(source:EvaluationHistorySource,
  scope:HistoryScope, episodes:readonly CadenceEpisode[]) {
  if(!source||typeof source.load!=="function"||typeof source.verifyCoverage!=="function"||!validScope(scope))
    throw Error("invalid_history_source");
  const bound=structuredClone(scope),registered=structuredClone(episodes);
  return Object.freeze({async load(now:string):Promise<EvaluationHistoryAssembly> {
    const output:EvaluationHistoryAssembly={status:"unavailable",snapshotFingerprint:null,
      evidence:{snapshot:null,coverage:null,dispositions:[]},segments:[],
      aggregate:{status:"unavailable",reason:"scoring-recipe-not-supplied"},
      completeness:{kind:"unverified",databaseIntegration:"scoped-read-loader"}};
    const fail=(reason:string)=>{output.status="unavailable";output.reason=reason;return output;};
    let snapshot:HistorySnapshot;
    try {
      instant(now);
      if(unsupportedPrecision(now))return fail("unsupported_timestamp_precision");
      snapshot=structuredClone(await source.load(structuredClone(bound),now));
      output.evidence.snapshot=snapshot;
      output.snapshotFingerprint=evaluationHistoryFingerprint(snapshot);
    }catch{return fail("history_source_unavailable");}
    if(!snapshot||!validId(snapshot.snapshotId)||!validScope(snapshot.scope)||!same(snapshot.scope,bound)||
      !Array.isArray(snapshot.configurations)||!Array.isArray(snapshot.observations)||
      !Array.isArray(snapshot.corrections)||!Array.isArray(snapshot.breaks))return fail("history_snapshot_invalid");
    try{if(instant(snapshot.capturedAt)<instant(now))return fail("snapshot_precedes_evaluation");}
    catch{return fail("history_snapshot_invalid");}
    // Preserve one disposition for EVERY input row, even on a failed assembly.
    let invalid=false;
    const observations:Array<{observation:Observation;deletedAt:string|null;index:number}>=[];
    const seen=new Set<string>();
    const parsedPolicies=snapshot.configurations.map(c=>DomainConfigurationSchema.safeParse(c));
    const policies=parsedPolicies.flatMap(p=>p.success?[p.data]:[]);
    if(parsedPolicies.some(p=>!p.success)||policies.some(p=>!same(scopeOf(p),bound))||
      !ConfigurationBundleSchema.safeParse({schemaVersion:1,configurations:policies,observations:[]}).success)
      invalid=true;
    const precisionValues:unknown[]=[
      ...policies.flatMap(p=>[p.effectiveFrom,p.targets.adapted?.effectiveFrom]),
      ...registered.flatMap(e=>[e.origin?.at,e.effectiveEnd,e.policy?.effectiveFrom,e.policy?.targets?.adapted?.effectiveFrom]),
      ...snapshot.observations.flatMap(row=>[(row?.observation as {observedAt?:unknown})?.observedAt,row?.deletedAt]),
      ...snapshot.breaks.flatMap(b=>[b?.interval?.start,b?.interval?.end])];
    const precisionDetected=precisionValues.some(unsupportedPrecision);
    const ordered=[...policies].sort((a,b)=>a.revision-b.revision);
    const intervals=new Map(ordered.map((p,i)=>[p.policyVersionId,{start:p.effectiveFrom,end:ordered[i+1]?.effectiveFrom??null}]));
    for(let index=0;index<snapshot.observations.length;index++){
      const row=snapshot.observations[index],p=ObservationSchema.safeParse(row?.observation);
      const d:Disposition={index,observationId:p.success?p.data.observationId:null,fingerprint:digest(row),
        episodeId:null,kind:"invalid",reason:"observation_invalid"};
      output.evidence.dispositions.push(d);
      if(!p.success){invalid=true;continue;}
      const o=p.data,policy=ordered.find(c=>c.policyVersionId===o.policyVersionId),interval=intervals.get(o.policyVersionId);
      d.observationId=o.observationId;
      try{
        if(!row||typeof row!=="object"||Object.keys(row).some(k=>!["observation","deletedAt"].includes(k))||
          !Object.hasOwn(row,"deletedAt")||(row.deletedAt!==null&&!Number.isFinite(instant(row.deletedAt)))||
          !same(scopeOf(o),bound)||seen.has(o.observationId)||!policy||!interval||
          !validateObservationContext(policy,o).success||!inside(instant(o.observedAt),interval.start,interval.end))
          throw Error("observation_context_or_boundary_invalid");
        seen.add(o.observationId);
        observations.push({observation:o,deletedAt:row.deletedAt,index});
        d.kind=row.deletedAt!==null?"deleted":"other-policy-segment";delete d.reason;
      }catch{d.reason="observation_context_or_boundary_invalid";invalid=true;}
    }
    if(precisionDetected){
      for(const d of output.evidence.dispositions){d.kind="invalid";d.reason="unsupported_timestamp_precision";}
      return fail("unsupported_timestamp_precision");
    }
    if(registered.length===0||new Set(registered.map(e=>e.episodeId)).size!==registered.length)invalid=true;
    for(const episode of registered){
      const policy=ordered.find(p=>p.policyVersionId===episode.policy.policyVersionId),
        interval=intervals.get(episode.policy.policyVersionId);
      try{
        if(!validId(episode.episodeId)||!policy||!interval||!same(policy,episode.policy)||
          !same(scopeOf(episode.policy),bound)||instant(episode.origin.at)<instant(interval.start)||
          (interval.end!==null&&(episode.effectiveEnd===null||instant(episode.effectiveEnd)>instant(interval.end)))||
          (episode.effectiveEnd!==null&&instant(episode.effectiveEnd)<=instant(episode.origin.at)))throw Error();
      }catch{invalid=true;}
    }
    // No event may ambiguously belong to two episodes. Registered episode
    // coverage must also be contiguous across each effective policy interval.
    for(const policy of ordered){
      const interval=intervals.get(policy.policyVersionId)!;
      const group=registered.filter(e=>e.policy.policyVersionId===policy.policyVersionId)
        .sort((a,b)=>instant(a.origin.at)-instant(b.origin.at));
      if(!group.length){if(instant(policy.effectiveFrom)<=instant(now))invalid=true;continue;}
      if(instant(group[0].origin.at)!==instant(interval.start))invalid=true;
      for(let i=0;i<group.length;i++){
        const end=group[i+1]?.origin.at??interval.end;
        if((end===null)!==(group[i].effectiveEnd===null)||
          (end!==null&&group[i].effectiveEnd!==null&&instant(end)!==instant(group[i].effectiveEnd)))invalid=true;
      }
    }
    // Break interpretation belongs to the source's separately verified adapter.
    // Unknown/wrong-scope or malformed exceptions cannot quietly disappear.
    const breaks:HistoryBreak[]=[];const breakIds=new Set<string>();
    for(const b of snapshot.breaks){
      try{
        if(!b||!validId(b.breakId)||breakIds.has(b.breakId)||!same(b.scope,bound)||
          Object.keys(b).some(k=>!["breakId","scope","interval"].includes(k))||
          instant(b.interval.end)<=instant(b.interval.start))throw Error();
        breakIds.add(b.breakId);breaks.push(b);
      }catch{invalid=true;}
    }
    if(invalid)return fail("history_evidence_invalid");
    if(snapshot.databaseEvidence?.breakResolution===null)return fail("exception_adapter_unavailable");
    let receipt:HistoryCoverageReceipt|null;
    try{receipt=structuredClone(await source.verifyCoverage(structuredClone(snapshot)));}
    catch{return fail("history_coverage_unverified");}
    output.evidence.coverage=receipt;
    if(receipt&&[receipt.completeFrom,receipt.completeThrough,...(receipt.origins??[]).map(o=>o.at)].some(unsupportedPrecision))
      return fail("unsupported_timestamp_precision");
    if(!receipt)return fail("history_coverage_unverified");
    const proofEpisodes=registered.filter(e=>instant(e.origin.at)<=instant(now));
    try{
      if(!validId(receipt.receiptId)||receipt.snapshotId!==snapshot.snapshotId||
        receipt.snapshotFingerprint!==output.snapshotFingerprint||!same(receipt.scope,bound)||
        !same(receipt.counts,{configurations:snapshot.configurations.length,observations:snapshot.observations.length,
          corrections:snapshot.corrections.length,breaks:snapshot.breaks.length})||
        instant(receipt.completeThrough)<instant(now)||instant(receipt.completeThrough)>instant(snapshot.capturedAt)||
        instant(receipt.completeFrom)>Math.min(...registered.map(e=>instant(e.origin.at)))||
        !Array.isArray(receipt.origins)||receipt.origins.length>registered.length||
        new Set(receipt.origins.map(o=>o.episodeId)).size!==receipt.origins.length||
        receipt.origins.some(o=>!registered.some(e=>e.episodeId===o.episodeId)))throw Error();
      for(const episode of proofEpisodes){
        const origin=receipt.origins.find(o=>o.episodeId===episode.episodeId);
        if(!origin||!validId(origin.evidenceId)||!["verified-empty-domain-activation","verified-source-reconciliation"].includes(origin.kind)||
          origin.sourceId!==episode.origin.sourceId||instant(origin.at)!==instant(episode.origin.at))throw Error();
      }
    }catch{return fail("history_coverage_receipt_mismatch");}
    output.completeness.kind="verified-by-injected-server-source";
    // Future policies remain visible pending evidence. They are not missed
    // practice and are not assessed using today's policy/target.
    const effective=registered.filter(e=>instant(e.origin.at)<=instant(now));
    const derive=createCadenceDeriver(effective);
    for(const policy of ordered.filter(p=>instant(p.effectiveFrom)>instant(now))){
      const pending=registered.filter(e=>e.policy.policyVersionId===policy.policyVersionId);
      for(const episode of pending.length?pending:[null]){
        output.segments.push({status:"pending",policy:structuredClone(policy),episode:structuredClone(episode),
          policyInterval:intervals.get(policy.policyVersionId)!,history:null,
          cadence:{status:"unavailable",reason:"policy_not_effective"}});
      }
      for(const row of observations.filter(r=>r.observation.policyVersionId===policy.policyVersionId)){
        const d=output.evidence.dispositions[row.index];
        if(row.deletedAt===null){d.kind="future";d.reason="future_policy_not_assessed";}
        const e=pending.find(e=>inside(instant(row.observation.observedAt),e.origin.at,e.effectiveEnd));
        d.episodeId=e?.episodeId??null;
      }
    }
    for(const episode of registered.filter(e=>instant(e.policy.effectiveFrom)<=instant(now)&&instant(e.origin.at)>instant(now))){
      output.segments.push({status:"pending",policy:structuredClone(episode.policy),episode:structuredClone(episode),
        policyInterval:intervals.get(episode.policy.policyVersionId)!,history:null,
        cadence:{status:"unavailable",reason:"episode_not_effective"}});
      for(const row of observations.filter(r=>r.observation.policyVersionId===episode.policy.policyVersionId&&
        inside(instant(r.observation.observedAt),episode.origin.at,episode.effectiveEnd))){
        const d=output.evidence.dispositions[row.index];d.episodeId=episode.episodeId;
        if(row.deletedAt===null){d.kind="future";d.reason="future_episode_not_assessed";}
      }
    }
    for(const episode of effective){
      const policyInterval=intervals.get(episode.policy.policyVersionId)!;
      let through:string;
      try{
        const w=assembleWindow({now,windowDays:1,boundary:episode.policy.boundary,
          coverage:{start:episode.origin.at,end:receipt.completeThrough},breaks:[]});
        through=iso(Math.max(instant(episode.origin.at),Math.min(instant(w.end),
          episode.effectiveEnd===null?Infinity:instant(episode.effectiveEnd))));
      }catch{return fail("history_window_unavailable");}
      const selected:Observation[]=[];
      for(const row of observations){
        const o=row.observation,t=instant(o.observedAt),d=output.evidence.dispositions[row.index];
        if(o.policyVersionId!==episode.policy.policyVersionId||!inside(t,episode.origin.at,episode.effectiveEnd))continue;
        d.episodeId=episode.episodeId;
        if(row.deletedAt!==null)continue;
        selected.push(o);
        d.kind=t>instant(now)?"future":t>=instant(through)?"today":"completed";
      }
      const history={sourceId:episode.origin.sourceId,coveredFrom:episode.origin.at,coveredThrough:through,
        observations:selected,breaks:breaks.map(b=>structuredClone(b.interval))};
      const cadence=derive.evaluate({episodeId:episode.episodeId,now,history});
      output.segments.push({status:"assessed",policy:structuredClone(episode.policy),episode:structuredClone(episode),policyInterval,history,cadence});
    }
    output.segments.sort((a,b)=>instant(a.episode?.origin.at??a.policy.effectiveFrom)-instant(b.episode?.origin.at??b.policy.effectiveFrom));
    output.aggregate.reason=output.segments.length>1?"cross-version-aggregate-not-approved":"scoring-recipe-not-supplied";
    const assessed=output.segments.filter(s=>s.status==="assessed");
    output.status=assessed.length>0&&assessed.every(s=>s.cadence.status==="available")?"available":"unavailable";
    if(output.status==="unavailable")output.reason=assessed.length?"cadence_segment_unavailable":"no_effective_episode";
    return output;
  }});
}
function scopeOf(value:{organizationId:string;ownerUserId:string;domainId:string}):HistoryScope{
  return {organizationId:value.organizationId,ownerUserId:value.ownerUserId,domainId:value.domainId};
}

export type BreakDisposition = { source:"v2"|"legacy"; id:string; fingerprint:string;
  kind:"approved-exempt"|"deleted"|"not-applicable"|"unsupported" };
export type BreakResolution = { breaks:HistoryBreak[]; dispositions:BreakDisposition[]; evidenceId:string };
export type DatabaseHistoryEvidence = {
  kind:"one-statement-owner-domain-snapshot-v1";
  domain:unknown[]; policies:unknown[]; dimensions:unknown[]; observations:unknown[]; corrections:unknown[];
  deviations:unknown[]; legacyDeviations:unknown[]; associations:unknown[]; bindings:unknown[];
  validationErrors:string[]; breakResolution:BreakResolution|null;
};
export type HistoryVerification = {
  verifyCoverage(snapshot:HistorySnapshot):Promise<HistoryCoverageReceipt|null>;
  /** Objective12 must separately review this interpreter; raw declarations are not approval. */
  resolveBreaks?(evidence:DatabaseHistoryEvidence):Promise<BreakResolution|null>;
};
export const historyBreakFingerprint=(row:unknown)=>digest(row);

/**
 * Authenticated source adapter. All collections share ONE PostgreSQL statement
 * snapshot, so concurrent saves cannot create a policy/observation read gap.
 * Every subquery uses lookahead; an overflow refuses the complete operation.
 * readComplete withholds oversized native JSON before driver transfer.
 *
 * This proves the current database row set, NOT that an earlier import was
 * complete. The injected coverage verifier must independently reconcile the
 * source activation/import receipt; missing proof remains unavailable.
 */
export function createEvaluationHistoryLoader(db:OwnershipDatabase, context:OrgContext,
  domainId:string, episodes:readonly CadenceEpisode[], verification:HistoryVerification) {
  assertContext(db,context);
  if(!validId(domainId)||!verification||typeof verification.verifyCoverage!=="function"||
    (verification.resolveBreaks!==undefined&&typeof verification.resolveBreaks!=="function"))
    throw new BoundaryError(503);
  const scope={organizationId:context.orgId,ownerUserId:context.actorUserId,domainId};
  const registered=structuredClone(episodes);
  const verifyCoverage=verification.verifyCoverage,resolveBreaks=verification.resolveBreaks;
  return Object.freeze({load:(now:string)=>bounded(()=>db.transaction(raw=>withTransactionReadBudget(raw,async tx=>{
    await revalidate(tx,db,context);
    const rows=await readComplete(tx,`SELECT jsonb_build_object(
      'capturedAt',date_trunc('milliseconds',clock_timestamp()),
      'domain',(SELECT coalesce(jsonb_agg(to_jsonb(d)),'[]'::jsonb) FROM
        (SELECT * FROM public.domains WHERE org_id=$1 AND owner_user_id=$2 AND domain_id=$3 ORDER BY domain_id LIMIT 2) d),
      'policies',(SELECT coalesce(jsonb_agg(to_jsonb(p)),'[]'::jsonb) FROM
        (SELECT *,effective_from=date_trunc('milliseconds',effective_from) AS __millisecond_time
         FROM public.policy_versions WHERE org_id=$1 AND owner_user_id=$2 AND domain_id=$3 ORDER BY revision LIMIT $4) p),
      'dimensions',(SELECT coalesce(jsonb_agg(to_jsonb(m)),'[]'::jsonb) FROM
        (SELECT * FROM public.dimension_definitions WHERE org_id=$1 AND owner_user_id=$2 AND domain_id=$3
         ORDER BY policy_version_id,measurement_id LIMIT $4) m),
      'observations',(SELECT coalesce(jsonb_agg(to_jsonb(o)),'[]'::jsonb) FROM
        (SELECT *,observed_at=date_trunc('milliseconds',observed_at) AS __millisecond_time,
          (deleted_at IS NULL OR deleted_at=date_trunc('milliseconds',deleted_at)) AS __deleted_millisecond_time
         FROM public.observations WHERE org_id=$1 AND owner_user_id=$2 AND domain_id=$3 ORDER BY observation_id LIMIT $4) o),
      'corrections',(SELECT coalesce(jsonb_agg(to_jsonb(a)),'[]'::jsonb) FROM
        (SELECT * FROM public.audit_events WHERE org_id=$1 AND actor_kind='user' AND actor_user_id=$2 AND (
          (entity_type='domains' AND entity_id=jsonb_build_array($3::text)::text) OR
          (entity_type='policy_versions' AND entity_id IN
            (SELECT jsonb_build_array(policy_version_id)::text FROM public.policy_versions
             WHERE org_id=$1 AND owner_user_id=$2 AND domain_id=$3)) OR
          (entity_type='observations' AND entity_id IN
            (SELECT jsonb_build_array(observation_id)::text FROM public.observations
             WHERE org_id=$1 AND owner_user_id=$2 AND domain_id=$3)))
         ORDER BY occurred_at,audit_event_id LIMIT $4) a),
      'deviations',(SELECT coalesce(jsonb_agg(to_jsonb(v)),'[]'::jsonb) FROM
        (SELECT * FROM public.deviations_v2 WHERE org_id=$1 AND owner_user_id=$2 ORDER BY deviation_id LIMIT $4) v),
      'legacyDeviations',(SELECT coalesce(jsonb_agg(to_jsonb(v)),'[]'::jsonb) FROM
        (SELECT * FROM public.deviations WHERE user_id=$2 ORDER BY id LIMIT $4) v),
      'associations',(SELECT coalesce(jsonb_agg(to_jsonb(a)),'[]'::jsonb) FROM
        (SELECT * FROM public.deviation_domains WHERE org_id=$1 AND owner_user_id=$2 ORDER BY deviation_id,domain_id LIMIT $4) a),
      'bindings',(SELECT coalesce(jsonb_agg(to_jsonb(b)),'[]'::jsonb) FROM
        (SELECT * FROM public.source_bindings WHERE org_id=$1 AND owner_user_id=$2 AND domain_id=$3 ORDER BY binding_id LIMIT $4) b)
    ) AS snapshot`,[scope.organizationId,scope.ownerUserId,domainId,MAX_READ_ROWS+1],["snapshot"],1);
    if(rows.length!==1)throw new BoundaryError(503);
    const payload=rows[0].snapshot;
    if(!payload||typeof payload!=="object")throw new BoundaryError(503);
    const names=["domain","policies","dimensions","observations","corrections","deviations","legacyDeviations","associations","bindings"] as const;
    for(const name of names){
      if(!Array.isArray(payload[name]))throw new BoundaryError(503);
      if(payload[name].length>(name==="domain"?1:MAX_READ_ROWS))throw new ResourceLimitError();
    }
    if(payload.domain.length!==1)throw new BoundaryError(404);
    const evidence:DatabaseHistoryEvidence={kind:"one-statement-owner-domain-snapshot-v1",
      ...(Object.fromEntries(names.map(name=>[name,payload[name]])) as Pick<DatabaseHistoryEvidence,typeof names[number]>),
      validationErrors:[],breakResolution:null};
    const errors=evidence.validationErrors;
    const scoped=(row:any,domain=true)=>row&&row.org_id===scope.organizationId&&row.owner_user_id===scope.ownerUserId&&
      (!domain||row.domain_id===domainId);
    if(!scoped(payload.domain[0]))errors.push("domain_identity_mismatch");
    for(const row of payload.policies){
      const c=DomainConfigurationSchema.safeParse(row.configuration);
      try{
        if(row.__millisecond_time!==true||unsupportedPrecision(row.effective_from))errors.push("unsupported_timestamp_precision");
        if(!scoped(row)||row.__millisecond_time!==true||!c.success||row.policy_version_id!==c.data.policyVersionId||
          row.revision!==c.data.revision||(row.previous_version_id??null)!==(c.data.previousVersionId??null)||
          instant(row.effective_from)!==instant(c.data.effectiveFrom))throw Error();
      }catch{errors.push("persisted_policy_mismatch");}
    }
    // Stored definitions are a second persisted representation. A complete
    // configuration alone cannot conceal a missing, extra or corrupt definition.
    const dimensions=payload.dimensions as any[];
    const expected=payload.policies.flatMap((row:any)=>{
      const c=DomainConfigurationSchema.safeParse(row.configuration);
      return c.success?c.data.measurements.map(m=>({policy:c.data.policyVersionId,definition:m})):[];
    });
    if(dimensions.length!==expected.length||dimensions.some(row=>!scoped(row)))errors.push("persisted_dimension_mismatch");
    for(const measurement of expected){
      const matches=dimensions.filter(row=>row.policy_version_id===measurement.policy&&
        row.measurement_id===measurement.definition.measurementId);
      if(matches.length!==1||!same(matches[0].definition,measurement.definition))errors.push("persisted_dimension_mismatch");
    }
    for(const row of payload.observations){
      const o=ObservationSchema.safeParse(row.observation);
      try{
        if(row.__millisecond_time!==true||row.__deleted_millisecond_time!==true||unsupportedPrecision(row.observed_at)||unsupportedPrecision(row.deleted_at))
          errors.push("unsupported_timestamp_precision");
        if(!scoped(row)||row.__millisecond_time!==true||row.__deleted_millisecond_time!==true||!o.success||
          row.observation_id!==o.data.observationId||row.policy_version_id!==o.data.policyVersionId||
          instant(row.observed_at)!==instant(o.data.observedAt))throw Error();
      }catch{errors.push("persisted_observation_mismatch");}
    }
    for(const row of payload.corrections)
      if(row.org_id!==scope.organizationId||row.actor_user_id!==scope.ownerUserId||row.actor_kind!=="user")
        errors.push("correction_scope_mismatch");
    for(const name of ["deviations","associations"] as const)
      if(payload[name].some((row:any)=>!scoped(row,false)))errors.push("exception_scope_mismatch");
    if(payload.legacyDeviations.some((row:any)=>row.user_id!==scope.ownerUserId))errors.push("legacy_exception_scope_mismatch");
    if(payload.bindings.some((row:any)=>!scoped(row)))errors.push("binding_scope_mismatch");
    let resolution:BreakResolution|null=null;
    if(payload.deviations.length===0&&payload.legacyDeviations.length===0){
      // Verified absence in this same statement, not an assumed empty input.
      resolution={breaks:[],dispositions:[],evidenceId:"database-query:no-exception-rows"};
    }else if(resolveBreaks){
      try{resolution=structuredClone(await resolveBreaks(structuredClone(evidence)));}
      catch{resolution=null;}
    }
    if(resolution){
      const rawBreaks=[...payload.deviations.map((row:any)=>({source:"v2",id:row.deviation_id,row})),
        ...payload.legacyDeviations.map((row:any)=>({source:"legacy",id:row.id,row}))];
      if(!validId(resolution.evidenceId)||!Array.isArray(resolution.breaks)||!Array.isArray(resolution.dispositions)||
        resolution.dispositions.length!==rawBreaks.length||rawBreaks.some(b=>{
          const matches=resolution!.dispositions.filter(d=>d.source===b.source&&d.id===b.id&&d.fingerprint===digest(b.row));
          return matches.length!==1||!["approved-exempt","deleted","not-applicable"].includes(matches[0].kind);
        }))resolution=null;
    }
    evidence.breakResolution=resolution;
    const snapshot:HistorySnapshot={snapshotId:digest({scope,capturedAt:payload.capturedAt,raw:payload}),
      capturedAt:iso(instant(payload.capturedAt)),scope:structuredClone(scope),
      configurations:payload.policies.map((row:any)=>row.configuration),
      observations:payload.observations.map((row:any)=>({observation:row.observation,deletedAt:row.deleted_at})),
      corrections:payload.corrections,breaks:resolution?.breaks??[],databaseEvidence:evidence};
    // Charge retained raw + extracted copies against the same inherited budget.
    await chargeReadBytes(tx,Buffer.byteLength(JSON.stringify(snapshot),"utf8"));
    const assembler=createHistoryAssembler({load:async()=>snapshot,verifyCoverage:async value=>{
      if(errors.length)return null;
      return verifyCoverage(value);
    }},scope,registered);
    const result=await assembler.load(now);
    if(errors.length){result.status="unavailable";result.reason=errors.includes("unsupported_timestamp_precision")?"unsupported_timestamp_precision":"persisted_history_mismatch";}
    return result;
  })))});
}
