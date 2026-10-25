import { createHash } from "node:crypto";
import { createEvaluator, type EvaluationResult } from "../../shared/pure-evaluator";
import { canonical, type EvaluationInput, type RecipeRegistry } from "../../shared/evaluator-recipe";
import { createDeriver, type PersistenceAvailable, type PreparedHistory } from "../../shared/pure-derived";
import { same, scopeOf, type Comparability, type PersistenceProfile, type ProfileRegistry } from "../../shared/derived-profile";
import type { EvaluationHistoryAssembly, EvaluationHistoryLoader } from "./evaluation-history-v2";
import { isVerifiedEvaluationHistoryLoader } from "./evaluation-history-v2";
import { assertContext, BoundaryError, type OrgContext, type OwnershipDatabase } from "../lib/org-context";
import { createPolicyV2Storage } from "../storage/policy-v2-storage";

type PreparedPersistence={profile:PersistenceProfile;history:PreparedHistory};
type TrendEvidence=ReturnType<ReturnType<typeof createDeriver>["trend"]>|{status:"unavailable";reason:string};
type Options={
  db:OwnershipDatabase;
  context:OrgContext;
  domainId:string;
  history:EvaluationHistoryLoader;
  recipes:RecipeRegistry;
  calculationVersion:string;
  clock:()=>Date;
  profiles?:ProfileRegistry;
  comparability?:readonly Comparability[];
  preparePersistence?:(result:EvaluationResult,assembly:EvaluationHistoryAssembly)=>PreparedPersistence|null|Promise<PreparedPersistence|null>;
};
const unavailable=(reason:string)=>({status:"unavailable" as const,reason});
const digest=(value:unknown)=>createHash("sha256").update("trusted-evaluation-persistence-v1:"+canonical(value)).digest("hex");
const id=(value:unknown):value is string=>typeof value==="string"&&value.length>0&&value.length<=200&&
  value.trim()===value&&!/[\u0000-\u001f\u007f]/.test(value)&&value!=="__proto__";
const exactKeys=(value:object,allowed:readonly string[])=>Object.keys(value).every(k=>allowed.includes(k));

/**
 * Dormant server-only calculation/write operation. It is intentionally not
 * imported by routes or runtime readers. The branded loader is bound to the
 * same database, owner capability and domain; recipes/profiles are injected
 * from reviewed server registries. No request body or score is accepted.
 */
export function createEvaluationPersistence(options:Options){
  if(!options||typeof options!=="object"||!exactKeys(options,
    ["db","context","domainId","history","recipes","calculationVersion","clock","profiles","comparability","preparePersistence"])||
    !id(options.domainId)||!id(options.calculationVersion)||typeof options.clock!=="function"||
    !Array.isArray(options.recipes)||!Array.isArray(options.profiles??[])||
    !Array.isArray(options.comparability??[])||
    (options.preparePersistence!==undefined&&typeof options.preparePersistence!=="function"))
    throw new BoundaryError(503);
  assertContext(options.db,options.context);
  if(!isVerifiedEvaluationHistoryLoader(options.history,options.db,options.context,options.domainId))
    throw new BoundaryError(503);

  const recipes=structuredClone(options.recipes),profiles=structuredClone(options.profiles??[]);
  const comparability=structuredClone(options.comparability??[]);
  const evaluate=createEvaluator(recipes);
  const derive=createDeriver({recipes,profiles,comparability});
  const store=createPolicyV2Storage(options.db,options.context,{clock:options.clock});
  const prepare=options.preparePersistence;

  return Object.freeze({calculateAndSave:async()=>{
    const clockValue=options.clock();
    if(!(clockValue instanceof Date)||!Number.isFinite(clockValue.getTime()))throw new BoundaryError(503);
    const now=clockValue.toISOString();
    const assembly=await options.history.load(now);
    const snapshot=assembly.evidence.snapshot,coverage=assembly.evidence.coverage;
    if(assembly.status!=="available"||assembly.completeness.kind!=="verified-by-injected-server-source"||
      !snapshot||!coverage||!snapshot.databaseEvidence||snapshot.databaseEvidence.breakResolution===null||
      coverage.snapshotId!==snapshot.snapshotId||coverage.snapshotFingerprint!==assembly.snapshotFingerprint)
      return unavailable(assembly.reason??"history_or_exception_proof_unavailable");
    if(assembly.segments.length!==1)
      return unavailable(assembly.segments.length>1?"cross_version_aggregate_not_approved":"no_assessed_history_segment");
    const segment=assembly.segments[0],episode=segment.episode,history=segment.history;
    if(segment.status!=="assessed"||!episode||!history||segment.cadence.status!=="available"||
      episode.policy.domainId!==options.domainId||episode.policy.organizationId!==options.context.orgId||
      episode.policy.ownerUserId!==options.context.actorUserId||
      episode.policy.policyVersionId!==segment.policy.policyVersionId)
      return unavailable("complete_policy_segment_or_cadence_unavailable");
    const candidates=recipes.filter(recipe=>recipe.organizationId===options.context.orgId&&
      recipe.ownerUserId===options.context.actorUserId&&recipe.domainId===options.domainId&&
      recipe.policyVersionId===segment.policy.policyVersionId&&recipe.targetId===episode.targetId);
    if(candidates.length!==1)return unavailable(candidates.length?"recipe_registry_ambiguous":"recipe_not_approved");
    const recipe=candidates[0];
    const input:EvaluationInput={
      now,windowDays:episode.windowDays,policy:structuredClone(segment.policy),
      observations:structuredClone(history.observations),
      coverage:{onboardingAt:episode.origin.at,policyStart:segment.policyInterval.start,policyEnd:segment.policyInterval.end},
      breaks:structuredClone(history.breaks),recipe:structuredClone(recipe),
    };
    const evaluation=evaluate(input),window=evaluation.evidence.window;
    if(!window)return unavailable(evaluation.status==="unavailable"?evaluation.reason:"evaluation_window_unavailable");
    const current=derive.current(evaluation);
    let persistence:ReturnType<typeof unavailable>|PersistenceAvailable=unavailable("approved_persistence_profile_or_history_missing");
    let prepared:PreparedPersistence|null=null;
    if(prepare){
      try{
        prepared=await prepare(structuredClone(evaluation),structuredClone(assembly));
        if(prepared)persistence=derive.persistence(evaluation,prepared.profile,prepared.history);
      }catch{persistence=unavailable("prepared_persistence_history_unavailable");}
    }
    const attention=current.status==="available"&&persistence.status==="available"?
      derive.attention(current.condition,persistence.state):
      unavailable("attention_requires_approved_condition_and_persistence");

    const previous=await store.evaluations.previous(options.domainId,window.start,segment.policy.policyVersionId,options.calculationVersion);
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
    const stableCoverage={receiptId:coverage.receiptId,scope:coverage.scope,completeFrom:coverage.completeFrom,
      counts:coverage.counts,origins:coverage.origins};
    const fingerprint=digest({calculationVersion:options.calculationVersion,input,evaluation,cadence:segment.cadence,persistence,attention,trend,
      source:stableSnapshot,coverage:stableCoverage});
    const result={
      schemaVersion:1 as const,kind:"trusted-evaluation-v1" as const,status,evaluation,current:currentEvidence,
      cadence:structuredClone(segment.cadence),persistence:structuredClone(persistence),
      attention:structuredClone(attention),trend:structuredClone(trend),
      provenance:{inputFingerprint:fingerprint,input:structuredClone(input),snapshotId:snapshot.snapshotId,
        snapshotFingerprint:assembly.snapshotFingerprint,coverageReceipt:structuredClone(coverage),
        sourceSnapshot:structuredClone(snapshot),dispositions:structuredClone(assembly.evidence.dispositions),
        completeness:structuredClone(assembly.completeness)},
    };
    const explanation={
      schemaVersion:1 as const,status,
      summary:status==="available"?
        `Condition ${current.status==="available"?current.condition:"unavailable"}; cadence ${segment.cadence.state}; persistence ${persistence.status}; trend ${trend.status}.`:
        `Evaluation unavailable: ${evaluation.status==="unavailable"?evaluation.reason:"evidence_unavailable"}.`,
      reason:status==="unavailable"?(evaluation.status==="unavailable"?evaluation.reason:"evidence_unavailable"):null,
      details:{condition:currentEvidence,cadence:{status:segment.cadence.status,
        ...(segment.cadence.status==="available"?{state:segment.cadence.state,label:segment.cadence.label}:{reason:segment.cadence.reason})},
        persistence:structuredClone(persistence),attention:structuredClone(attention),trend:structuredClone(trend)},
    };
    const save=await store.evaluations.persistTrusted({
      domainId:options.domainId,policyVersionId:segment.policy.policyVersionId,windowStart:window.start,windowEnd:window.end,
      timezone:segment.policy.boundary.timezone,dayStartHour:segment.policy.boundary.dayStartHour,
      calculationVersion:options.calculationVersion,inputFingerprint:fingerprint,eligibleDays:window.eligibleDays,
      result,components:evaluation.evidence.components,explanation,
    });
    if(save.action==="legacy-summary-preserved")return unavailable("legacy_summary_collision_preserved");
    return {status:"saved" as const,action:save.action,resultId:save.row.result_id,
      inputFingerprint:save.row.input_fingerprint,result:save.row};
  }});
}
