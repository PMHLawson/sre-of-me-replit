/** Isolated SOMR-427. No clock, IO, storage, runtime or UI integration. */
import { createEvaluator, type EvaluationResult } from "./pure-evaluator";
import type { RecipeRegistry } from "./evaluator-recipe";
import { instant } from "./evaluator-window";
import { sub,decimal,compare,eligible,reconstruct,numericEvidence } from "./derived-exact";
import { CONDITIONS,STATES,conditionRanks,persistenceRanks,scopeOf,same,semanticScope,validProfile,
  ComparabilityShape,type Condition,type Persistence,type PersistenceProfile,type ProfileRegistry,
  type Comparability } from "./derived-profile";

type Unavailable = {status:"unavailable";reason:string};
const no=(reason:string):Unavailable=>({status:"unavailable",reason});
const conditionOf=(r:Extract<EvaluationResult,{status:"available"}>):Condition=>
  r.condition==="Needs Attention"?"NeedsAttention":r.condition;
/** Legacy import adapter only; no fresh derivation emits PAGE. */
export function migrateLegacyPersistence(value:unknown) {
  if(value==="PAGE")return {status:"available" as const,state:"Critical" as Persistence,
    rank:4,origin:"legacy-migration",legacyValue:"PAGE"};
  return no("unsupported_legacy_state");
}
/** Pure rank combination; factory.status supplies validated inputs. */
export function attention(condition:Condition,persistence:Persistence) {
  if(!CONDITIONS.includes(condition)||!STATES.includes(persistence))return no("invalid_attention_state");
  const c=conditionRanks[condition],p=persistenceRanks[persistence],rank=Math.max(c,p);
  return {status:"available" as const,rank,
    origins:[...(c===rank?["condition" as const]:[]),...(p===rank?["persistence" as const]:[])],
    condition,persistence};
}
export type PreparedBlock = {
  result:EvaluationResult;
  preparation:{assemblyId:string;assemblyVersion:string;sourceId:string;
    from:string;through:string;activeDays:number;kind:"active"|"exempt"|"pending"};
};
export type PreparedHistory = {
  origin:{kind:"known-nominal";at:string;sourceId:string};
  completeThrough:string;blocks:PreparedBlock[];
};
export type PersistenceAvailable = {
  status:"available";state:Persistence;rank:number;profileId:string;profileVersion:string;
  approval:PersistenceProfile["approval"];completedActiveBlocks:number;
  consecutive:{subAcceptable:number;severe:number;acceptable:number};
  trigger:{ruleId:string;selector:string;completedBlocks:number};
  label:string;history:PreparedHistory;
};
export function createDeriver(registries:{
  recipes:RecipeRegistry;profiles:ProfileRegistry;comparability?:readonly Comparability[];
}) {
  const trusted=structuredClone(registries),evaluate=createEvaluator(trusted.recipes);
  /** Complete result + original provenance replay, not an approval flag or caller's score. */
  function validate(value:EvaluationResult):EvaluationResult|Unavailable {
    try {
      const v=structuredClone(value),replayed=evaluate(v.evidence.provenance);
      if(!same(v,replayed))return no("result_provenance_mismatch");
      return replayed;
    } catch {return no("invalid_result_provenance");}
  }
  function current(value:EvaluationResult) {
    const r=validate(value);
    if(r.status!=="available")return {...no(r.reason),result:structuredClone(value)};
    return {status:"available" as const,condition:conditionOf(r),authoritativeCondition:r.condition,
      reasons:structuredClone(r.reasons),score:r.score,result:r,
      label:`Current condition: ${r.condition}; ${r.reasons.join(", ")||"validated health bands"}; recipe ${r.evidence.provenance.recipe.recipeId}@${r.evidence.provenance.recipe.version}`};
  }
  function trend(previous:EvaluationResult,currentValue:EvaluationResult,strategy?:Comparability) {
    const retained={previous:structuredClone(previous),current:structuredClone(currentValue)};
    const fail=(reason:string)=>({...no(reason),...retained});
    try {
      const p=validate(previous),c=validate(currentValue);
      if(p.status!=="available"||c.status!=="available")return fail("comparison_result_unavailable");
      const pi=p.evidence.provenance,ci=c.evidence.provenance,pw=p.evidence.window!,cw=c.evidence.window!;
      if(pw.end!==cw.start||pi.windowDays!==ci.windowDays)return fail("windows_not_adjacent_equal_logical_days");
      const ps=scopeOf(pi),cs=scopeOf(ci);
      if(strategy){
        if(!ComparabilityShape.safeParse(strategy).success||
          !trusted.comparability?.some(s=>same(s,strategy))||
          trusted.comparability.some(s=>s.strategyId===strategy.strategyId&&s.version===strategy.version&&!same(s,strategy)))
          return fail("comparability_strategy_unapproved");
        if(!same(strategy.from,ps)||!same(strategy.to,cs)||!same(semanticScope(ps),semanticScope(cs)))
          return fail("comparison_scope_incompatible");
        if(instant(strategy.effective.start)>instant(pw.start)||instant(strategy.effective.end)<instant(cw.end))
          return fail("comparison_strategy_interval");
      }else if(!same(ps,cs))return fail("comparability_strategy_unapproved");
      if(same(ps,cs)&&!same(pi.coverage,ci.coverage))return fail("comparison_policy_interval_incompatible");
      const a=reconstruct(p),b=reconstruct(c),delta=sub(b.score,a.score);
      const direction=compare(delta,decimal(2))>0?"Improving":compare(delta,decimal(-2))<0?"Declining":"Stable";
      const components=b.components.map((v,j)=>{
        const u=a.components[j];
        return {measurement:v.measurement,target:v.target,weight:v.weight,mandatory:v.mandatory,
          previous:{actual:numericEvidence(u.actual),expected:numericEvidence(u.expected),
            capped:numericEvidence(u.capped),uncapped:numericEvidence(u.uncapped),weightedContribution:numericEvidence(u.contribution)},
          current:{actual:numericEvidence(v.actual),expected:numericEvidence(v.expected),
            capped:numericEvidence(v.capped),uncapped:numericEvidence(v.uncapped),weightedContribution:numericEvidence(v.contribution)},
          changes:{actual:numericEvidence(sub(v.actual,u.actual)),capped:numericEvidence(sub(v.capped,u.capped)),
            uncapped:numericEvidence(sub(v.uncapped,u.uncapped)),weightedContribution:numericEvidence(sub(v.contribution,u.contribution))}};
      });
      return {status:"available" as const,direction,delta:numericEvidence(delta),components,
        priorExactHealth:numericEvidence(a.score),currentExactHealth:numericEvidence(b.score),
        comparison:strategy?structuredClone(strategy):"identical-scope-v1",...retained};
    }catch{return fail("comparison_arithmetic_or_provenance_unavailable");}
  }
  function persistence(value:EvaluationResult,profile:PersistenceProfile,history:PreparedHistory):
    PersistenceAvailable|Unavailable {
    try {
      if(!validProfile(profile)||!trusted.profiles.some(p=>same(p,profile))||
        trusted.profiles.some(p=>p.profileId===profile.profileId&&p.version===profile.version&&!same(p,profile)))
        return no("persistence_profile_unapproved_or_incomplete");
      const c=validate(value);
      // E0 has no current numeric health or invented Nominal; caller retains raw input.
      if(c.status!=="available")return no(c.reason);
      const scope=scopeOf(c.evidence.provenance),end=c.evidence.window!.end;
      if(!same(scope,profile.scope))return no("persistence_scope_incompatible");
      if(instant(c.evidence.window!.start)<instant(profile.effective.start))return no("profile_effective_interval");
      if(!history||!same(history.origin,profile.initial)||
        !Array.isArray(history.blocks)||history.completeThrough!==end)return no("history_incomplete");
      let cursor=instant(history.origin.at);
      if(cursor<instant(profile.effective.start)||instant(end)>instant(profile.effective.end)||cursor>instant(end))
        return no("profile_effective_interval");
      let state:Persistence="Nominal",total=0;
      const streak={subAcceptable:0,severe:0,acceptable:0};
      let trigger={ruleId:"known-nominal-origin",selector:"origin",completedBlocks:0};
      const observations=new Map(c.evidence.rawObservations.map(o=>[o.observationId,o]));
      // Replay and collect every same-scope snapshot before inspecting any block.
      // A later snapshot can contain an earlier practice absent from that block.
      const results=history.blocks.map(block=>validate(block.result));
      for(const r of results){
        if(!("evidence" in r)||!r.evidence.window)return no("block_result_invalid");
        if(!same(scopeOf(r.evidence.provenance),scope))return no("block_scope_incompatible");
        if(!same(r.evidence.provenance.coverage,c.evidence.provenance.coverage))
          return no("block_policy_interval_incompatible");
        for(const o of r.evidence.rawObservations){
          if(observations.has(o.observationId)&&!same(observations.get(o.observationId),o))
            return no("conflicting_observation_provenance");
          observations.set(o.observationId,o);
        }
      }
      for(const r of [c,...results]){
        if(!("evidence" in r)||!r.evidence.window)return no("block_result_invalid");
        const w=r.evidence.window,raw=new Map(r.evidence.rawObservations.map(o=>[o.observationId,o]));
        for(const o of Array.from(observations.values())){
          const at=instant(o.observedAt);
          if(at>=instant(w.start)&&at<instant(w.end)&&!same(raw.get(o.observationId),o))
            return no("conflicting_observation_provenance");
        }
      }
      for(let blockIndex=0;blockIndex<history.blocks.length;blockIndex++){
        const block=history.blocks[blockIndex];
        const r=results[blockIndex],prep=block.preparation;
        if(!("evidence" in r)||!r.evidence.window)return no("block_result_invalid");
        const w=r.evidence.window;
        if(!same(scopeOf(r.evidence.provenance),scope))return no("block_scope_incompatible");
        if(!same(r.evidence.provenance.coverage,c.evidence.provenance.coverage))
          return no("block_policy_interval_incompatible");
        for(const o of r.evidence.rawObservations){
          if(observations.has(o.observationId)&&!same(observations.get(o.observationId),o))
            return no("conflicting_observation_provenance");
          observations.set(o.observationId,o);
        }
        const currentWindow=c.evidence.window!;
        for(const d of w.days){
          const other=currentWindow.days.find(day=>day.day===d.day);
          if(other&&!same(other,d))return no("conflicting_coverage_provenance");
        }
        const lo=Math.max(instant(w.start),instant(currentWindow.start)),hi=Math.min(instant(w.end),instant(currentWindow.end));
        const overlap=(v:EvaluationResult)=>v.evidence.completed
          .filter(o=>instant(o.observedAt)>=lo&&instant(o.observedAt)<hi)
          .sort((a,b)=>a.observationId<b.observationId?-1:a.observationId>b.observationId?1:0);
        if(lo<hi&&!same(overlap(r),overlap(c)))return no("conflicting_observation_provenance");
        if(!prep||prep.assemblyId!==profile.assembly.id||prep.assemblyVersion!==profile.assembly.version||
          typeof prep.sourceId!=="string"||!prep.sourceId||prep.from!==w.start||prep.through!==w.end)
          return no("block_preparation_incomplete");
        if(instant(w.start)!==cursor||instant(w.end)<=cursor||instant(w.end)>instant(end))
          return no("history_gap_overlap_or_future");
        if(w.days.some(d=>d.coveredMs!==d.durationMs))return no("block_coverage_incomplete");
        const e=eligible(r);
        if(prep.kind==="exempt"){
          if(prep.activeDays!==0||compare(e,decimal(0))!==0||r.status!=="unavailable"||r.reason!=="no_eligible_coverage")
            return no("invalid_exempt_marker");
          // Explicit E0 markers neither increment nor reset any streak or state.
        }else if(prep.kind==="pending"){
          if(blockIndex!==history.blocks.length-1||r.status!=="available"||compare(e,decimal(0))<=0||
            compare(e,decimal(7))>=0||compare(e,decimal(prep.activeDays))!==0)
            return no("invalid_pending_tail");
          // Explicitly evidenced completed days, but not a complete active block.
          // Never promotes, recovers, resets or joins unknown history.
        }else if(prep.kind==="active"){
          if(prep.activeDays!==7||compare(e,decimal(7))!==0||r.status!=="available")
            return no("active_block_not_seven_complete_active_days");
          total++;
          const condition=conditionOf(r);
          for(const selector of ["subAcceptable","severe","acceptable"] as const)
            streak[selector]=profile.selectors[selector].includes(condition)?streak[selector]+1:0;
          if(streak.acceptable>=profile.recovery.blocks){
            state="Nominal";trigger={ruleId:profile.recovery.ruleId,selector:"acceptable",completedBlocks:streak.acceptable};
          }else {
            const rule=profile.promotions.filter(rule=>streak[rule.selector]>=rule.blocks)
              .sort((a,b)=>b.priority-a.priority)[0];
            if(rule&&persistenceRanks[rule.state]>=persistenceRanks[state]){
              state=rule.state;trigger={ruleId:rule.ruleId,selector:rule.selector,completedBlocks:streak[rule.selector]};
            }
          }
        }else return no("block_preparation_incomplete");
        cursor=instant(w.end);
      }
      if(cursor!==instant(end)||total===0)return no("history_incomplete");
      return {status:"available",state,rank:persistenceRanks[state],profileId:profile.profileId,profileVersion:profile.version,
        approval:structuredClone(profile.approval),completedActiveBlocks:total,consecutive:streak,trigger,
        label:`Sustained trouble: ${state}; profile ${profile.profileId}@${profile.version}; rule ${trigger.ruleId}; ${trigger.completedBlocks} completed ${trigger.selector} blocks; ${profile.approval.kind}`,
        history:structuredClone(history)};
    }catch{return no("invalid_persistence_provenance");}
  }
  function status(value:EvaluationResult,profile?:PersistenceProfile,history?:PreparedHistory) {
    const condition=current(value);
    const sustained=profile&&history?persistence(value,profile,history):no("persistence_profile_or_history_missing");
    const notice=condition.status==="available"&&sustained.status==="available"?
      {...attention(condition.condition!,sustained.state),label:`${condition.label}; ${sustained.label}`}:
      no("attention_requires_condition_and_persistence");
    return {condition,persistence:sustained,attention:notice};
  }
  return {current,trend,persistence,status};
}
