import { createHash } from "node:crypto";
import { createEvaluator, type EvaluationResult } from "../../shared/pure-evaluator";
import { canonical, type EvaluationInput, type RecipeRegistry } from "../../shared/evaluator-recipe";
import { createDeriver, attention as combineAttention } from "../../shared/pure-derived";
import { same, scopeOf, type Comparability } from "../../shared/derived-profile";
import { assembleWindow, instant } from "../../shared/evaluator-window";
import type { EvaluationHistoryAssembly, EvaluationHistoryLoader } from "./evaluation-history-v2";
import { isVerifiedEvaluationHistoryLoader } from "./evaluation-history-v2";
import { assertContext, BoundaryError, type OrgContext, type OwnershipDatabase } from "../lib/org-context";
import { createPolicyV2Storage } from "../storage/policy-v2-storage";

type TrendEvidence=ReturnType<ReturnType<typeof createDeriver>["trend"]>|{status:"unavailable";reason:string};
type Options={
  db:OwnershipDatabase;
  context:OrgContext;
  domainId:string;
  history:EvaluationHistoryLoader;
  recipes:RecipeRegistry;
  calculationVersion:string;
  clock:()=>Date;
  comparability?:readonly Comparability[];
};
const unavailable=(reason:string)=>({status:"unavailable" as const,reason});
const digest=(value:unknown)=>createHash("sha256").update("trusted-evaluation-persistence-v1:"+canonical(value)).digest("hex");
const id=(value:unknown):value is string=>typeof value==="string"&&value.length>0&&value.length<=200&&
  value.trim()===value&&!/[\u0000-\u001f\u007f]/.test(value)&&value!=="__proto__";
const exactKeys=(value:object,allowed:readonly string[])=>Object.keys(value).every(k=>allowed.includes(k));

/**
 * The coverage verifier independently establishes domain activation. A later
 * policy/target origin is reconciliation, never a new onboarding exemption.
 */
function domainActivation(assembly:EvaluationHistoryAssembly):string|null {
  const coverage=assembly.evidence.coverage;
  const episodes=assembly.segments.flatMap(segment=>segment.episode?[segment.episode]:[])
    .sort((a,b)=>instant(a.origin.at)-instant(b.origin.at));
  const origins=coverage?.origins.filter(origin=>origin.kind==="verified-empty-domain-activation")??[];
  if(!episodes.length||origins.length!==1)return null;
  const first=episodes[0],origin=origins[0];
  return origin.episodeId===first.episodeId&&origin.sourceId===first.origin.sourceId&&
    instant(origin.at)===instant(first.origin.at)?origin.at:null;
}

/** Choose by covered assessment window, not by the number of lifetime policies. */
function assessmentSegments(assembly:EvaluationHistoryAssembly,now:string,onboardingAt:string) {
  return assembly.segments.filter(segment=>{
    if(segment.status!=="assessed"||!segment.episode||!segment.history)return false;
    const episode=segment.episode;
    try{
      const window=assembleWindow({now,windowDays:episode.windowDays,boundary:segment.policy.boundary,
        coverage:{start:onboardingAt,end:now},breaks:[]});
      const from=Math.max(instant(window.start),instant(onboardingAt));
      const start=Math.max(instant(segment.policyInterval.start),instant(episode.origin.at));
      const end=Math.min(segment.policyInterval.end===null?Infinity:instant(segment.policyInterval.end),
        episode.effectiveEnd===null?Infinity:instant(episode.effectiveEnd));
      return from>=start&&instant(window.end)<=end;
    }catch{return false;}
  });
}

/**
 * Dormant server-only calculation/write operation, with no runtime importer.
 * Validated capabilities and dependencies are captured once; later mutation of
 * the construction options cannot replace their database/owner/domain binding.
 * Reviewed recipes, history origins and exception proof remain injected.
 */
export function createEvaluationPersistence(options:Options){
  if(!options||typeof options!=="object"||Array.isArray(options)||!exactKeys(options,
    ["db","context","domainId","history","recipes","calculationVersion","clock","comparability"]))
    throw new BoundaryError(503);
  const {db,context,domainId,history:historyLoader,recipes:recipeInput,
    calculationVersion,clock,comparability:comparisonInput}=options;
  if(!id(domainId)||!id(calculationVersion)||typeof clock!=="function"||
    !Array.isArray(recipeInput)||!Array.isArray(comparisonInput??[]))
    throw new BoundaryError(503);
  assertContext(db,context);
  if(!isVerifiedEvaluationHistoryLoader(historyLoader,db,context,domainId))
    throw new BoundaryError(503);

  const organizationId=context.orgId,ownerUserId=context.actorUserId;
  const recipes=structuredClone(recipeInput),comparability=structuredClone(comparisonInput??[]);
  const evaluate=createEvaluator(recipes);
  // The former seven-day profile path is fixture-only. This operation uses
  // production qualifying-day cadence, and only current/trend from this deriver.
  const derive=createDeriver({recipes,profiles:[],comparability});
  const store=createPolicyV2Storage(db,context,{clock});

  return Object.freeze({calculateAndSave:async()=>{
    const clockValue=clock();
    if(!(clockValue instanceof Date)||!Number.isFinite(clockValue.getTime()))throw new BoundaryError(503);
    const now=clockValue.toISOString();
    const assembly=await historyLoader.load(now);
    const snapshot=assembly.evidence.snapshot,coverage=assembly.evidence.coverage;
    if((assembly.status!=="available"&&assembly.reason!=="cadence_segment_unavailable")||
      assembly.completeness.kind!=="verified-by-injected-server-source"||
      !snapshot||!coverage||!snapshot.databaseEvidence||snapshot.databaseEvidence.breakResolution===null||
      coverage.snapshotId!==snapshot.snapshotId||coverage.snapshotFingerprint!==assembly.snapshotFingerprint)
      return unavailable(assembly.reason??"history_or_exception_proof_unavailable");
    const onboardingAt=domainActivation(assembly);
    if(onboardingAt===null)return unavailable("domain_activation_proof_unavailable");
    const supported=assessmentSegments(assembly,now,onboardingAt);
    if(supported.length!==1)
      return unavailable(supported.length||assembly.segments.some(segment=>segment.status==="assessed")?
        "cross_version_aggregate_not_approved":"no_assessed_history_segment");
    const segment=supported[0],episode=segment.episode,history=segment.history;
    if(!episode||!history||segment.cadence.status!=="available"||
      episode.policy.domainId!==domainId||episode.policy.organizationId!==organizationId||
      episode.policy.ownerUserId!==ownerUserId||
      episode.policy.policyVersionId!==segment.policy.policyVersionId)
      return unavailable("complete_policy_segment_or_cadence_unavailable");
    const candidates=recipes.filter(recipe=>recipe.organizationId===organizationId&&
      recipe.ownerUserId===ownerUserId&&recipe.domainId===domainId&&
      recipe.policyVersionId===segment.policy.policyVersionId&&recipe.targetId===episode.targetId);
    if(candidates.length!==1)return unavailable(candidates.length?"recipe_registry_ambiguous":"recipe_not_approved");
    const recipe=candidates[0];
    const input:EvaluationInput={
      now,windowDays:episode.windowDays,policy:structuredClone(segment.policy),
      observations:structuredClone(history.observations),
      coverage:{onboardingAt,policyStart:segment.policyInterval.start,policyEnd:segment.policyInterval.end},
      breaks:structuredClone(history.breaks),recipe:structuredClone(recipe),
    };
    const evaluation=evaluate(input),window=evaluation.evidence.window;
    if(!window)return unavailable(evaluation.status==="unavailable"?evaluation.reason:"evaluation_window_unavailable");
    const current=derive.current(evaluation);
    const persistence=structuredClone(segment.cadence);
    let attention:ReturnType<typeof combineAttention>=unavailable("attention_requires_approved_condition_and_persistence");
    if(current.status==="available"){
      switch(persistence.state){
        case "Nominal":case "Advisory":case "Warning":case "Breach":case "Critical":
          attention=combineAttention(current.condition,persistence.state);break;
        default:attention=unavailable("cadence_attention_mapping_not_approved");
      }
    }

    const previous=await store.evaluations.previous(domainId,window.start,segment.policy.policyVersionId,calculationVersion);
    let trend:TrendEvidence=unavailable("adjacent_saved_result_unavailable");
    if(previous?.result?.kind==="trusted-evaluation-v1"&&previous.result.evaluation){
      const previousEvaluation=previous.result.evaluation as EvaluationResult;
      const priorScope=scopeOf(previousEvaluation.evidence.provenance),currentScope=scopeOf(evaluation.evidence.provenance);
      const approved=comparability.filter(strategy=>same(strategy.to,currentScope)&&same(strategy.from,priorScope));
      trend=derive.trend(previousEvaluation,evaluation,approved.length===1?approved[0]:undefined);
    }
    const currentEvidence=current.status==="available"?{
      status:"available",condition:current.condition,authoritativeCondition:current.authoritativeCondition,
      reasons:current.reasons,label:current.label,
    }:unavailable(current.reason);
    const status=evaluation.status;
    const stableSnapshot={
      scope:snapshot.scope,configurations:snapshot.configurations,observations:snapshot.observations,
      corrections:snapshot.corrections,breaks:snapshot.breaks,databaseEvidence:snapshot.databaseEvidence,
    };
    // Issuance IDs/timestamps remain in the saved full receipt, but reissuing an
    // equivalent proof does not change the semantic evidence or consume a write.
    const stableCoverage={scope:coverage.scope,completeFrom:coverage.completeFrom,counts:coverage.counts,
      origins:[...coverage.origins].sort((a,b)=>a.episodeId<b.episodeId?-1:a.episodeId>b.episodeId?1:0)};
    const fingerprint=digest({calculationVersion,input,evaluation,cadence:segment.cadence,persistence,attention,trend,
      source:stableSnapshot,coverage:stableCoverage});
    const result={
      schemaVersion:1 as const,kind:"trusted-evaluation-v1" as const,status,evaluation,current:currentEvidence,
      cadence:structuredClone(segment.cadence),persistence,attention:structuredClone(attention),trend:structuredClone(trend),
      provenance:{inputFingerprint:fingerprint,input:structuredClone(input),snapshotId:snapshot.snapshotId,
        snapshotFingerprint:assembly.snapshotFingerprint,coverageReceipt:structuredClone(coverage),
        sourceSnapshot:structuredClone(snapshot),dispositions:structuredClone(assembly.evidence.dispositions),
        completeness:structuredClone(assembly.completeness)},
    };
    const explanation={
      schemaVersion:1 as const,status,
      summary:status==="available"?
        `Condition ${current.status==="available"?current.condition:"unavailable"}; cadence ${segment.cadence.state}; persistence ${persistence.state}; trend ${trend.status}.`:
        `Evaluation unavailable: ${evaluation.status==="unavailable"?evaluation.reason:"evidence_unavailable"}.`,
      reason:evaluation.status==="unavailable"?evaluation.reason:null,
      details:{condition:currentEvidence,cadence:{status:segment.cadence.status,state:segment.cadence.state,label:segment.cadence.label},
        persistence:structuredClone(persistence),attention:structuredClone(attention),trend:structuredClone(trend)},
    };
    const save=await store.evaluations.persistTrusted({
      domainId,policyVersionId:segment.policy.policyVersionId,windowStart:window.start,windowEnd:window.end,
      timezone:segment.policy.boundary.timezone,dayStartHour:segment.policy.boundary.dayStartHour,
      calculationVersion,inputFingerprint:fingerprint,eligibleDays:window.eligibleDays,
      result,components:evaluation.evidence.components,explanation,
    });
    if(save.action==="legacy-summary-preserved")return unavailable("legacy_summary_collision_preserved");
    return {status:"saved" as const,action:save.action,resultId:save.row.result_id,
      inputFingerprint:save.row.input_fingerprint,result:save.row};
  }});
}
