import {createHash} from "node:crypto";
import {z} from "zod";
import {canonical,type EvaluationInput,type RecipeRegistry} from "../../shared/evaluator-recipe";
import {createEvaluator,type EvaluationResult} from "../../shared/pure-evaluator";
import {assembleWindow,instant} from "../../shared/evaluator-window";
import {CADENCE_VERSION} from "../../shared/cadence-derived";
import {computeServiceState,filterSessionsInWindow} from "../lib/policy-engine";
import {computeDomainEscalation} from "../lib/escalation";
import {BoundaryError} from "../lib/org-context";
import {ResourceLimitError} from "../lib/read-budget";
import {issuePolicyShadowService,type PolicyShadowService} from "./policy-shadow-capability";
export type {PolicyShadowService} from "./policy-shadow-capability";
import {createEvaluationPersistence} from "./evaluation-persistence-v2";
import {isVerifiedEvaluationHistoryLoader,type EvaluationHistoryLoader,type EvaluationHistoryAssembly,type HistorySnapshot,type HistoryCoverageReceipt} from "./evaluation-history-v2";
import {isLegacyComparisonUnit,type LegacyComparisonUnit,type LegacyComparisonBatch,type LegacyComparisonRequest} from "./legacy-activity-mutations";

const id=z.string().min(1).max(200).refine(v=>v.trim()===v&&!/[\u0000-\u001f\u007f]/.test(v)&&v!=="__proto__");
const hash=z.string().regex(/^[a-f0-9]{64}$/);
const timestamp=z.string().datetime({offset:true});
const boundary=z.object({timezone:id,dayStartHour:z.number().int().min(0).max(23)}).strict();
const scalar=z.union([z.number().finite(),z.string(),z.boolean(),z.null()]);
const metric=z.enum(["actual_qualifying_days","actual_minutes","health_score"]);
const scope=z.object({organizationId:id,ownerUserId:id,domainId:id,policyVersionId:id,
  policyFingerprint:hash,recipeId:id,recipeVersion:id,recipeFingerprint:hash,
  sourceFingerprint:hash,asOf:timestamp,windowStart:timestamp,windowEnd:timestamp,
  windowDays:z.number().int().positive(),boundary}).strict();
export const ExpectedDifferenceRuleSchema=z.object({ruleId:id,version:id,decisionCitation:id,
  scope,metric,legacy:scalar,next:scalar}).strict();
export type ExpectedDifferenceRule=z.infer<typeof ExpectedDifferenceRuleSchema>;
export type ComparisonScope=z.infer<typeof scope>;
const difference=z.object({metric,legacy:scalar,next:scalar,
  outcome:z.enum(["EXPECTED-DESIGN-CHANGE","DEFECT"]),ruleId:id.nullable(),ruleVersion:id.nullable(),
  decisionCitation:id.nullable(),reason:z.enum(["exact_reviewed_rule","unclassified_difference","ambiguous_rules"])}).strict();
export type ShadowDifference=z.infer<typeof difference>;
/** No tolerance/rounding: changed numeric health is a real difference. */
export function classifyPolicyShadowDifferences(s:ComparisonScope,values:readonly {
  metric:z.infer<typeof metric>;legacy:number;next:number}[],rules:readonly ExpectedDifferenceRule[]):ShadowDifference[]{
  return values.filter(v=>!Object.is(v.legacy,v.next)).map(v=>{
    const matches=rules.filter(r=>canonical(r.scope)===canonical(s)&&r.metric===v.metric&&
      canonical(r.legacy)===canonical(v.legacy)&&canonical(r.next)===canonical(v.next));
    const approved=matches.length===1?matches[0]:null;
    return {...v,outcome:approved?"EXPECTED-DESIGN-CHANGE" as const:"DEFECT" as const,
      ruleId:approved?.ruleId??null,ruleVersion:approved?.version??null,
      decisionCitation:approved?.decisionCitation??null,
      reason:approved?"exact_reviewed_rule" as const:matches.length?"ambiguous_rules" as const:"unclassified_difference" as const};
  });
}
const digest=(v:unknown)=>createHash("sha256").update("policy-shadow-v1:"+canonical(v)).digest("hex");
type Source=LegacyComparisonBatch["sources"][number];
export function policyShadowSourceFingerprint(batch:LegacyComparisonBatch,source:Source):string{
  const options=batch.legacyOptions;
  // JSON serialization normalizes Date instants; request-local memo symbols are irrelevant.
  return digest(JSON.parse(JSON.stringify({snapshotFingerprint:batch.snapshotFingerprint,
    legacyOptions:{windowDays:options.windowDays,dayStartHour:options.dayStartHour,timezone:options.timezone,
      excludeToday:options.excludeToday??true,userCreatedAt:options.userCreatedAt??null,deviations:options.deviations??[]},
    asOf:batch.asOf,source})));
}
const derived=z.object({condition:id.nullable(),cadence:id.nullable(),persistence:id.nullable(),
  attention:z.number().finite().nullable(),trendStatus:z.enum(["available","unavailable"]),trendReason:id.nullable()}).strict();
const provenance=z.object({scope,snapshotId:id,snapshotFingerprint:hash,batchSnapshotFingerprint:hash,
  sourceSessionIds:z.array(id),canonicalObservationIds:z.array(id),nativeObservationIds:z.array(id),completedSessionIds:z.array(id),
  completedObservationIds:z.array(id),deletedSessionIds:z.array(id),anomalySessionIds:z.array(id),
  eligibleDays:z.number().finite().nonnegative(),coverageReceiptId:id,
  originEvidenceIds:z.array(id),breakEvidenceIds:z.array(id),
  inputFingerprint:hash,calculationVersion:id,
  engineVersions:z.object({legacy:z.literal("served-policy-engine-v1"),evaluator:z.literal("pure-evaluator-v1"),
    cadence:z.literal(CADENCE_VERSION),report:z.literal("policy-shadow-v1")}).strict()}).strict();
const sourceEvidence=z.object({sourceFingerprint:hash,sourceSessionIds:z.array(id),canonicalObservationIds:z.array(id),nativeObservationIds:z.array(id),
  deletedSessionIds:z.array(id),anomalySessionIds:z.array(id),snapshotId:id.nullable(),snapshotFingerprint:hash.nullable(),
  policyVersionIds:z.array(id)}).strict();
const windowConfiguration=z.object({
  legacy:z.object({windowDays:z.number().int().positive(),boundary}).strict(),
  next:z.object({windowDays:z.number().int().positive(),boundary}).strict(),
}).strict();
const row=z.object({domainId:id,slug:id,sourceEvidence:sourceEvidence.nullable(),windowConfiguration:windowConfiguration.nullable(),outcome:z.enum(["match","EXPECTED-DESIGN-CHANGE","DEFECT","unavailable","legacy-unsupported"]),
  reason:id.nullable(),provenance:provenance.nullable(),
  legacy:z.object({actualQualifyingDays:z.number().finite(),actualMinutes:z.number().finite(),healthScore:z.number().finite(),
    escalationTier:id,retiredErrorBudget:z.object({consumedMinutes:z.number().finite(),allowedMinutes:z.number().finite(),
      remainingMinutes:z.number().finite(),percentRemaining:z.number().finite()}).strict()}).strict().nullable(),
  next:z.object({actualQualifyingDays:z.number().finite(),actualMinutes:z.number().finite(),healthScore:z.number().finite(),
    derived,resultId:id,persistenceAction:id}).strict().nullable(),differences:z.array(difference)}).strict();
const comparisonCoverage=z.object({
  comparedMetrics:z.tuple([z.literal("actual_qualifying_days"),z.literal("actual_minutes"),z.literal("health_score")]),
  derivedStatusContracts:z.literal("retained_as_evidence_not_compared_for_equivalence"),
  retiredBudgetContract:z.literal("legacy_error_budget_retired_without_health_score_equivalence"),
}).strict();
const summarySchema=z.object({totalRows:z.number().int().nonnegative(),supportedComparisons:z.number().int().nonnegative(),
  matches:z.number().int().nonnegative(),expectedDesignChanges:z.number().int().nonnegative(),defects:z.number().int().nonnegative(),
  unavailable:z.number().int().nonnegative(),legacyUnsupported:z.number().int().nonnegative()}).strict();
function summarize(rows:readonly z.infer<typeof row>[]){
  return {totalRows:rows.length,supportedComparisons:rows.filter(r=>r.legacy!==null&&r.next!==null&&r.provenance!==null).length,
    matches:rows.filter(r=>r.outcome==="match").length,
    expectedDesignChanges:rows.filter(r=>r.outcome==="EXPECTED-DESIGN-CHANGE").length,
    defects:rows.filter(r=>r.outcome==="DEFECT").length,unavailable:rows.filter(r=>r.outcome==="unavailable").length,
    legacyUnsupported:rows.filter(r=>r.outcome==="legacy-unsupported").length};
}
function verdict(summary:z.infer<typeof summarySchema>){
  return summary.supportedComparisons>0&&summary.supportedComparisons===summary.totalRows&&
    summary.matches+summary.expectedDesignChanges===summary.totalRows?
    "clear_for_declared_metrics" as const:"review_required" as const;
}
export const PolicyShadowReportSchema=z.object({schemaVersion:z.literal(1),kind:z.literal("private-policy-shadow-report"),
  status:z.literal("completed"),asOf:timestamp,organizationId:id,ownerUserId:id,
  snapshotFingerprint:hash,reconciliation:z.object({clean:z.literal(true),fingerprint:hash}).strict(),
  retiredContracts:z.array(z.literal("legacy-error-budget-has-no-new-health-counterpart")),
  comparisonCoverage,summary:summarySchema,comparisonVerdict:z.enum(["clear_for_declared_metrics","review_required"]),
  rows:z.array(row)}).strict().refine(report=>canonical(report.summary)===canonical(summarize(report.rows))&&
    report.comparisonVerdict===verdict(report.summary),"inconsistent_comparison_summary");
export type PolicyShadowReport=z.infer<typeof PolicyShadowReportSchema>;
export type PolicyShadowRun={status:"disabled"}|{status:"batch-blocked";reason:
  "maintenance_resource_unavailable"|"reconciliation_failed"|"comparison_evidence_changed"}|PolicyShadowReport;
type Disabled={enabled?:false};
type Enabled={enabled:true;unit:LegacyComparisonUnit;history:(batch:LegacyComparisonBatch,source:Source)=>EvaluationHistoryLoader|Promise<EvaluationHistoryLoader>;
  recipes:RecipeRegistry;calculationVersion:string;expectedDifferences:readonly ExpectedDifferenceRule[]};
class EvidenceChanged extends Error{}
const initialEvidence=(batch:LegacyComparisonBatch,source:Source):z.infer<typeof sourceEvidence>=>({
  sourceFingerprint:policyShadowSourceFingerprint(batch,source),sourceSessionIds:source.legacySessions.map(s=>s.id),
  canonicalObservationIds:[...source.canonicalObservationIds],nativeObservationIds:[...source.nativeObservationIds],deletedSessionIds:source.legacySessions.filter(s=>s.deletedAt!==null).map(s=>s.id),
  anomalySessionIds:source.legacySessions.filter(s=>s.isAnomaly).map(s=>s.id),snapshotId:null,snapshotFingerprint:null,policyVersionIds:[]});
const unavailable=(batch:LegacyComparisonBatch,source:Source,reason:string,outcome:"unavailable"|"legacy-unsupported"|"DEFECT"="unavailable"):z.infer<typeof row>=>({
  domainId:source.domainId,slug:source.slug,sourceEvidence:initialEvidence(batch,source),windowConfiguration:null,outcome,reason,provenance:null,legacy:null,next:null,differences:[]});
function selectedInput(a:EvaluationHistoryAssembly,now:string,recipes:RecipeRegistry):EvaluationInput|null{
  const snapshot=a.evidence.snapshot,coverage=a.evidence.coverage;
  if((a.status!=="available"&&a.reason!=="cadence_segment_unavailable")||
    a.completeness.kind!=="verified-by-injected-server-source"||!snapshot||!coverage||
    !snapshot.databaseEvidence||snapshot.databaseEvidence.breakResolution===null)return null;
  const episodes=a.segments.flatMap(s=>s.episode?[s.episode]:[]).sort((x,y)=>instant(x.origin.at)-instant(y.origin.at));
  const origins=coverage.origins.filter(o=>o.kind==="verified-empty-domain-activation");
  if(origins.length!==1||!episodes.length||origins[0].episodeId!==episodes[0].episodeId||
    origins[0].sourceId!==episodes[0].origin.sourceId||instant(origins[0].at)!==instant(episodes[0].origin.at))return null;
  const onboardingAt=origins[0].at;
  const candidates=a.segments.filter(s=>{
    if(s.status!=="assessed"||!s.episode||!s.history||s.cadence.status!=="available")return false;
    const e=s.episode,w=assembleWindow({now,windowDays:e.windowDays,boundary:s.policy.boundary,
      coverage:{start:onboardingAt,end:now},breaks:[]});
    return Math.max(instant(w.start),instant(onboardingAt))>=Math.max(instant(s.policyInterval.start),instant(e.origin.at))&&
      instant(w.end)<=Math.min(s.policyInterval.end===null?Infinity:instant(s.policyInterval.end),
        e.effectiveEnd===null?Infinity:instant(e.effectiveEnd));
  });
  if(candidates.length!==1)return null;
  const s=candidates[0],e=s.episode!;
  const approved=recipes.filter(r=>r.organizationId===s.policy.organizationId&&r.ownerUserId===s.policy.ownerUserId&&
    r.domainId===s.policy.domainId&&r.policyVersionId===s.policy.policyVersionId&&r.targetId===e.targetId);
  if(approved.length!==1)return null;
  return {now,windowDays:e.windowDays,policy:structuredClone(s.policy),observations:structuredClone(s.history!.observations),
    coverage:{onboardingAt,policyStart:s.policyInterval.start,policyEnd:s.policyInterval.end},
    breaks:structuredClone(s.history!.breaks),recipe:structuredClone(approved[0])};
}
function stableSnapshot(s:HistorySnapshot){return {scope:s.scope,configurations:s.configurations,observations:s.observations,
  corrections:s.corrections,breaks:s.breaks,databaseEvidence:s.databaseEvidence};}
function sameIds(a:readonly string[],b:readonly string[]){
  return a.length===b.length&&new Set(a).size===a.length&&new Set(b).size===b.length&&canonical([...a].sort())===canonical([...b].sort());
}
/**
 * Dormant private maintenance capability. No environment defaults, HTTP route,
 * ordinary-read invocation, owner-data rewrite, recipe or decision invention.
 * Every enabled call must enter the authenticated pinned reconciliation unit.
 */
export function createPolicyShadowService(options:Disabled|Enabled={}):PolicyShadowService{
  let run:(request:LegacyComparisonRequest)=>Promise<PolicyShadowRun>;
  if(options.enabled!==true){run=async()=>({status:"disabled"});}
  else{
    const {unit,history:provideHistory,calculationVersion}=options;
    if(!isLegacyComparisonUnit(unit)||typeof provideHistory!=="function"||!id.safeParse(calculationVersion).success||
      !Array.isArray(options.recipes)||!Array.isArray(options.expectedDifferences))throw new BoundaryError(503);
    const recipes=structuredClone(options.recipes);
    const rules=options.expectedDifferences.map(r=>ExpectedDifferenceRuleSchema.parse(structuredClone(r)));
    run=async request=>{
      try{
        const response=await unit.run(request,async original=>{
          const batch={...original,asOf:original.asOf,legacyOptions:structuredClone(original.legacyOptions),
            sources:structuredClone(original.sources),unsupported:structuredClone(original.unsupported),
            reconciliation:structuredClone(original.reconciliation)};
          const evaluate=createEvaluator(recipes),rows:z.infer<typeof row>[]=[];
          for(const source of batch.sources){
            if(source.nativeObservationIds.length>0){
              rows.push(unavailable(batch,source,"native_activity_has_no_reviewed_legacy_projection","legacy-unsupported"));continue;
            }
            const providerView={...batch,legacyOptions:structuredClone(batch.legacyOptions),
              sources:structuredClone(batch.sources),unsupported:structuredClone(batch.unsupported),
              reconciliation:structuredClone(batch.reconciliation)};
            const history=await provideHistory(providerView,structuredClone(source));
            if(!isVerifiedEvaluationHistoryLoader(history,batch.db,batch.context,source.domainId))throw new BoundaryError(503);
            const assembly=await history.load(batch.asOf),snapshot=assembly.evidence.snapshot;
            let configurationFacts:z.infer<typeof windowConfiguration>|null=null;
            const domainUnavailable=(reason:string,outcome:"unavailable"|"legacy-unsupported"|"DEFECT"="unavailable")=>({
              ...unavailable(batch,source,reason,outcome),windowConfiguration:configurationFacts,sourceEvidence:{...initialEvidence(batch,source),
                snapshotId:snapshot?.snapshotId??null,snapshotFingerprint:assembly.snapshotFingerprint,
                policyVersionIds:Array.from(new Set(assembly.segments.map(s=>s.policy.policyVersionId)))}});
            if(!snapshot||!snapshot.databaseEvidence){rows.push(domainUnavailable(assembly.reason??"history_or_exception_proof_unavailable"));continue;}
            const native=snapshot.databaseEvidence.observations as {observation_id:string;legacy_source_id:string|null}[];
            if(!sameIds(native.map(o=>o.observation_id),source.canonicalObservationIds)||
              !sameIds(native.map(o=>o.legacy_source_id??""),source.legacySessions.map(s=>s.id))){
              rows.push(domainUnavailable("source_record_alignment_failed","DEFECT"));continue;
            }
            const input=selectedInput(assembly,batch.asOf,recipes);
            if(!input){rows.push(domainUnavailable(assembly.reason??"approved_recipe_origin_or_single_policy_segment_unavailable"));continue;}
            const opts=batch.legacyOptions;
            configurationFacts=windowConfiguration.parse({
              legacy:{windowDays:opts.windowDays,boundary:{timezone:opts.timezone,dayStartHour:opts.dayStartHour}},
              next:{windowDays:input.windowDays,boundary:input.policy.boundary}});
            if(input.windowDays!==opts.windowDays||input.policy.boundary.dayStartHour!==opts.dayStartHour||
              input.policy.boundary.timezone!==opts.timezone){rows.push(domainUnavailable("legacy_and_new_window_configuration_differ"));continue;}
            const evaluation=evaluate(input),window=evaluation.evidence.window;
            if(evaluation.status!=="available"||!window){
              rows.push(domainUnavailable(evaluation.status==="unavailable"?evaluation.reason:"evaluation_window_unavailable"));continue;
            }
            const active=source.legacySessions.filter(s=>s.deletedAt===null);
            // Served current/history calculations retain anomaly records.
            const legacy=computeServiceState(source.slug,active,{...opts,now:new Date(batch.asOf)});
            const completed=filterSessionsInWindow(active,legacy.window_days,opts);
            const completedNative=native.filter(n=>completed.some(s=>s.id===n.legacy_source_id)).map(n=>n.observation_id);
            if(canonical(legacy.window_days)!==canonical(window.days.map(d=>d.day))||
              !sameIds(completedNative,evaluation.evidence.completed.map(o=>o.observationId))){
              rows.push(domainUnavailable("completed_window_or_source_alignment_failed","DEFECT"));continue;
            }
            const durations=evaluation.evidence.components.filter(c=>input.recipe.components.some(p=>
              p.measurement.measurementId===c.measurementId&&p.actual==="sum-events"&&p.measurement.kind==="duration"&&p.measurement.unit.unitId==="minute"));
            const frequencies=evaluation.evidence.components.filter(c=>input.recipe.components.some(p=>
              p.measurement.measurementId===c.measurementId&&p.actual==="distinct-qualifying-days"));
            if(durations.length!==1||frequencies.length!==1){
              rows.push(domainUnavailable("legacy_metric_counterpart_unavailable","legacy-unsupported"));continue;
            }
            const saved=await createEvaluationPersistence({db:batch.db,context:batch.context,domainId:source.domainId,
              history,recipes,calculationVersion,clock:()=>new Date(batch.asOf)}).calculateAndSave();
            if(saved.status!=="saved"){rows.push(domainUnavailable(saved.reason));continue;}
            const result=saved.result.result as {kind:string;evaluation:EvaluationResult;current:any;cadence:any;persistence:any;attention:any;trend:any;
              provenance:{snapshotId:string;snapshotFingerprint:string;sourceSnapshot:HistorySnapshot;input:EvaluationInput;coverageReceipt:HistoryCoverageReceipt}};
            if(result.kind!=="trusted-evaluation-v1"||canonical(result.evaluation)!==canonical(evaluation)||
              canonical(result.provenance.input)!==canonical(input)||canonical(stableSnapshot(result.provenance.sourceSnapshot))!==canonical(stableSnapshot(snapshot)))
              throw new EvidenceChanged();
            const s:ComparisonScope={organizationId:batch.context.orgId,ownerUserId:batch.context.actorUserId,
              domainId:source.domainId,policyVersionId:input.policy.policyVersionId,policyFingerprint:digest(input.policy),
              recipeId:input.recipe.recipeId,recipeVersion:input.recipe.version,recipeFingerprint:digest(input.recipe),
              sourceFingerprint:policyShadowSourceFingerprint(batch,source),asOf:batch.asOf,
              windowStart:window.start,windowEnd:window.end,windowDays:input.windowDays,boundary:input.policy.boundary};
            const differences=classifyPolicyShadowDifferences(s,[
              {metric:"actual_qualifying_days",legacy:legacy.actual_qualifying_days,next:frequencies[0].actual},
              {metric:"actual_minutes",legacy:legacy.actual_minutes,next:durations[0].actual},
              {metric:"health_score",legacy:legacy.service_score,next:evaluation.score}],rules);
            const escalation=computeDomainEscalation(source.slug,active,{...opts,now:new Date(batch.asOf)});
            rows.push({domainId:source.domainId,slug:source.slug,windowConfiguration:configurationFacts,sourceEvidence:{...initialEvidence(batch,source),snapshotId:result.provenance.snapshotId,
                snapshotFingerprint:result.provenance.snapshotFingerprint,policyVersionIds:assembly.segments.map(v=>v.policy.policyVersionId)},
              outcome:differences.some(d=>d.outcome==="DEFECT")?"DEFECT":differences.length?"EXPECTED-DESIGN-CHANGE":"match",
              reason:null,provenance:{scope:s,snapshotId:result.provenance.snapshotId,snapshotFingerprint:result.provenance.snapshotFingerprint,
                batchSnapshotFingerprint:batch.snapshotFingerprint,sourceSessionIds:source.legacySessions.map(s=>s.id),
                canonicalObservationIds:[...source.canonicalObservationIds],nativeObservationIds:[...source.nativeObservationIds],completedSessionIds:completed.map(s=>s.id),
                completedObservationIds:evaluation.evidence.completed.map(o=>o.observationId),
                deletedSessionIds:source.legacySessions.filter(s=>s.deletedAt!==null).map(s=>s.id),
                anomalySessionIds:source.legacySessions.filter(s=>s.isAnomaly).map(s=>s.id),
                eligibleDays:window.eligibleDays,coverageReceiptId:result.provenance.coverageReceipt.receiptId,
                originEvidenceIds:result.provenance.coverageReceipt.origins.map(o=>o.evidenceId),
                breakEvidenceIds:result.provenance.sourceSnapshot.breaks.map(b=>b.breakId),inputFingerprint:saved.inputFingerprint,calculationVersion,
                engineVersions:{legacy:"served-policy-engine-v1",evaluator:"pure-evaluator-v1",cadence:CADENCE_VERSION,report:"policy-shadow-v1"}},
              legacy:{actualQualifyingDays:legacy.actual_qualifying_days,actualMinutes:legacy.actual_minutes,healthScore:legacy.service_score,
                escalationTier:escalation.tier,retiredErrorBudget:escalation.errorBudget},
              next:{actualQualifyingDays:frequencies[0].actual,actualMinutes:durations[0].actual,healthScore:evaluation.score,
                derived:{condition:result.current.status==="available"?result.current.condition:null,
                  cadence:result.cadence.status==="available"?result.cadence.state:null,
                  persistence:result.persistence.status==="available"?result.persistence.state:null,
                  attention:result.attention.status==="available"?result.attention.rank:null,
                  trendStatus:result.trend.status,trendReason:result.trend.status==="unavailable"?result.trend.reason:null},
                resultId:saved.resultId,persistenceAction:saved.action},differences});
          }
          for(const unsupported of batch.unsupported)rows.push({domainId:unsupported.domainId,slug:unsupported.domainId,sourceEvidence:null,windowConfiguration:null,
            outcome:"legacy-unsupported",reason:unsupported.reason,provenance:null,legacy:null,next:null,differences:[]});
          const report=PolicyShadowReportSchema.parse({schemaVersion:1,kind:"private-policy-shadow-report",status:"completed",
            asOf:batch.asOf,organizationId:batch.context.orgId,ownerUserId:batch.context.actorUserId,
            snapshotFingerprint:batch.snapshotFingerprint,reconciliation:{clean:true,fingerprint:digest(batch.reconciliation)},
            retiredContracts:["legacy-error-budget-has-no-new-health-counterpart"],
            comparisonCoverage:{comparedMetrics:["actual_qualifying_days","actual_minutes","health_score"],
              derivedStatusContracts:"retained_as_evidence_not_compared_for_equivalence",
              retiredBudgetContract:"legacy_error_budget_retired_without_health_score_equivalence"},
            summary:summarize(rows),comparisonVerdict:verdict(summarize(rows)),rows});
          if(Buffer.byteLength(JSON.stringify(report),"utf8")>1000000)throw new ResourceLimitError();
          return report;
        });
        return response.status==="completed"?response.value:{status:"batch-blocked",reason:response.reason};
      }catch(error){if(error instanceof EvidenceChanged)return {status:"batch-blocked",reason:"comparison_evidence_changed"};throw error;}
    };
  }
  return issuePolicyShadowService(run);
}
