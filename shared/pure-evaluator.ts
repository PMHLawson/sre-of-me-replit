import { DomainConfigurationSchema, validateObservationContext, type Observation,
  type QualificationPredicate } from "./domain-config";
import { assembleWindow, instant, logicalDay } from "./evaluator-window";
import { canonical, RecipeShape, type EvaluationInput, type RecipeRegistry } from "./evaluator-recipe";

// Exact decimal-rational comparisons for policy decisions only. Numeric evidence
// remains full-precision Number arithmetic, with no display rounding here.
type Rational = { n: bigint; d: bigint };
const zero=BigInt(0),one=BigInt(1);
function fraction(n:bigint,d:bigint):Rational {
  let a=n<zero?-n:n,b=d;
  while(b!==zero){const remainder=a%b;a=b;b=remainder;}
  return {n:n/a,d:d/a};
}
function decimal(value:number):Rational {
  const [mantissa,exp="0"]=String(value).toLowerCase().split("e");
  const [whole,tail=""]=mantissa.split(".");
  const scale=tail.length-Number(exp),n=BigInt(whole+tail);
  const power=BigInt("1"+"0".repeat(Math.abs(scale)));
  return scale>=0?fraction(n,power):fraction(n*power,one);
}
const add=(a:Rational,b:Rational)=>fraction(a.n*b.d+b.n*a.d,a.d*b.d);
const multiply=(a:Rational,b:Rational)=>fraction(a.n*b.n,a.d*b.d);
const divide=(a:Rational,b:Rational)=>fraction(a.n*b.d,a.d*b.n);
const less=(a:Rational,b:Rational)=>a.n*b.d<b.n*a.d;

export type ComponentResult = {
  measurementId: string; unitId: string; weight: number; mandatory: boolean;
  actual: number; target: number; basisDays: number; expected: number;
  uncappedPercent: number; cappedPercent: number;
  observationIds: string[]; qualifyingDays: string[]; missingObservationIds: string[];
};
export type EvaluationEvidence = {
  rawObservations: Observation[];
  completed: Observation[]; today: Observation[]; future: Observation[];
  excluded: { observationId: string; reason: string }[];
  window?: ReturnType<typeof assembleWindow>;
  provenance: EvaluationInput;
  components: ComponentResult[];
  continuity: "preserved"; sustainedState: "unavailable"; overachievementBadge: "unavailable";
};
export type EvaluationResult = { evidence: EvaluationEvidence } & (
  {status:"unavailable";reason:string} |
  {status:"available";score:number;condition:"Healthy"|"Needs Attention"|"Warning"|"Critical";
    overachievementPercent:number;reasons:string[]});
function qualifies(p: QualificationPredicate, o: Observation): boolean | undefined {
  if (p.kind !== "condition") {
    const children = p.predicates.map(c=>qualifies(c,o));
    if (children.some(c=>c===undefined)) return undefined;
    return p.kind==="all" ? children.every(Boolean) : children.some(Boolean);
  }
  const c=p.condition;
  if(c.basis.kind!=="per_event")return undefined;
  const v=o.values[c.measurementId];
  if(!v)return false;
  if(v.unitId!==c.unitId||v.taskVariantId!==c.taskVariantId||v.valueType!==c.valueType)return undefined;
  if(c.valueType==="boolean")return v.value===c.constraint.value;
  if(typeof v.value!=="number")return undefined;
  const r=c.constraint;
  return r.operator==="range"?v.value>=r.min&&v.value<=r.max:r.operator==="gte"?v.value>=r.value:
    r.operator==="lte"?v.value<=r.value:v.value===r.value;
}
/** A pure factory: snapshot the trusted reviewed registry, never mutate it. */
export function createEvaluator(registry: RecipeRegistry) {
  const approved=structuredClone(registry);
  return (input: EvaluationInput): EvaluationResult => {
    const i=structuredClone(input);
    const evidence: EvaluationEvidence={rawObservations:i.observations,completed:[],today:[],future:[],
      excluded:[],provenance:i,components:[],continuity:"preserved",sustainedState:"unavailable",overachievementBadge:"unavailable"};
    const unavailable=(reason:string):EvaluationResult=>({status:"unavailable",reason,evidence});
    if(!DomainConfigurationSchema.safeParse(i.policy).success)return unavailable("invalid_policy");
    const c=i.policy,r=i.recipe;
    if(!RecipeShape.safeParse(r).success || !approved.some(p=>canonical(p)===canonical(r)))
      return unavailable("recipe_unapproved");
    if(["organizationId","ownerUserId","domainId","policyVersionId"].some(k=>
      r[k as keyof typeof r]!==c[k as keyof typeof c]))return unavailable("recipe_identity_mismatch");
    let now:number, start:number, end:number, onboarding:number;
    try {
      now=instant(i.now);start=instant(i.coverage.policyStart);end=instant(i.coverage.policyEnd);
      onboarding=instant(i.coverage.onboardingAt);
      if(start!==instant(c.effectiveFrom)||end<=start||now<start)return unavailable("policy_coverage_mismatch");
      evidence.window=assembleWindow({now:i.now,windowDays:i.windowDays,boundary:c.boundary,
        coverage:{start:new Date(Math.max(start,onboarding)).toISOString(),end:i.coverage.policyEnd},breaks:i.breaks});
    } catch {return unavailable("window_assembly_unavailable");}
    const w=evidence.window;
    const seen=new Set<string>();
    for(const o of i.observations){
      if(!validateObservationContext(c,o).success || seen.has(o.observationId))
        return unavailable("observation_context_mismatch");
      seen.add(o.observationId);
      let t:number;
      try { t=instant(o.observedAt); } catch { return unavailable("observation_context_mismatch"); }
      if(t<start||t>=end)return unavailable("policy_boundary_unavailable");
      if(t>now){evidence.future.push(o);continue;}
      if(t>=instant(w.end)){evidence.today.push(o);continue;}
      if(t<instant(w.start)){evidence.excluded.push({observationId:o.observationId,reason:"outside_window"});continue;}
      if(t<onboarding){evidence.excluded.push({observationId:o.observationId,reason:"before_onboarding"});continue;}
      evidence.completed.push(o);
    }
    // Missing historical policies cannot be silently treated as exempt history.
    if(Math.max(instant(w.start),onboarding)<start || instant(w.end)>end)
      return unavailable("policy_boundary_unavailable");
    const adapted=c.targets.adapted;
    if(adapted && r.targetSelection==="normal")return unavailable("adaptation_selection_unavailable");
    const target=r.targetSelection==="normal"?c.targets.normal:adapted?.target;
    if(!target || target.targetId!==r.targetId)return unavailable("target_missing");
    if(r.targetSelection==="adapted" && (!adapted || instant(adapted.effectiveFrom)>Math.max(instant(w.start),onboarding)))
      return unavailable("adaptation_boundary_unavailable");
    // Review dates are not expiry dates. Never switch back automatically.
    if(c.targets.stretch||c.targets.upperRecovery)return unavailable("extra_target_conditions_unavailable");
    if(canonical(r.qualification)!==canonical(c.qualification??null))return unavailable("qualification_binding_mismatch");
    if(r.components.length!==target.conditions.length ||
      new Set(r.components.map(p=>p.measurement.measurementId)).size!==r.components.length ||
      canonical(r.components.map(p=>canonical(p.targetCondition)).sort())!==canonical(target.conditions.map(canonical).sort()))
      return unavailable("target_conditions_omitted");
    for(const p of r.components){
      const m=c.measurements.find(m=>m.measurementId===p.measurement.measurementId),t=p.targetCondition;
      if(!m||canonical(m)!==canonical(p.measurement))return unavailable("measurement_binding_mismatch");
      if(t.measurementId!==m.measurementId||t.unitId!==m.unit.unitId||
        t.valueType!==m.valueType||t.taskVariantId!==m.taskVariantId)
        return unavailable("component_target_incompatible");
      if(m.role!=="practice")return unavailable("measurement_role_unavailable");
      if(m.comparisonDirection!=="higher_is_better")return unavailable("direction_unavailable");
      if(t.valueType==="boolean"||t.constraint.operator!=="gte")return unavailable("percentage_recipe_unavailable");
      if(t.basis.kind!=="period")return unavailable("per_event_target_unavailable");
      if(t.constraint.value===0)return unavailable("zero_target");
      if(p.actual==="sum-events"){
        if(m.scope.kind!=="per_event"||m.aggregation!=="sum"||
          t.periodAggregation?.method!=="sum")return unavailable("aggregation_unavailable");
      }else if(m.kind!=="frequency"||m.countBy!=="distinct_days"||!c.qualification)
        return unavailable("qualification_unavailable");
      // Period qualification has no per-practice meaning even in an empty window.
      const checkPredicate=(q:QualificationPredicate):boolean=>q.kind==="condition"?
        q.condition.basis.kind==="per_event":q.predicates.every(checkPredicate);
      if(c.qualification&&!checkPredicate(c.qualification))return unavailable("qualification_unavailable");
    }
    if(w.eligibleDays===0)return unavailable("no_eligible_coverage");
    const exactEligible=w.days.reduce((s,d)=>add(s,divide(decimal(d.coveredMs-d.exemptMs),decimal(d.durationMs))),decimal(0));
    const exactPercents:Rational[]=[];
    for(const p of r.components){
      const t=p.targetCondition;
      if(t.valueType==="boolean"||t.constraint.operator!=="gte"||t.basis.kind!=="period")return unavailable("percentage_recipe_unavailable");
      const days=new Set<string>(),ids:string[]=[],missing:string[]=[];
      let actual=0;
      let exactActual=decimal(0);
      for(const o of evidence.completed){
        if(p.actual==="sum-events"){
          const value=o.values[p.measurement.measurementId];
          if(!value){missing.push(o.observationId);continue;}
          if(typeof value.value!=="number")return unavailable("invalid_numeric_value");
          actual+=value.value;ids.push(o.observationId);
          exactActual=add(exactActual,decimal(value.value));
        }else {
          const q=qualifies(c.qualification!,o);
          if(q===undefined)return unavailable("qualification_unavailable");
          if(q){days.add(logicalDay(o.observedAt,c.boundary));ids.push(o.observationId);}
        }
      }
      if(p.actual==="distinct-qualifying-days"){actual=days.size;exactActual=decimal(actual);}
      const expected=t.constraint.value*w.eligibleDays/t.basis.windowDays,percent=100*actual/expected;
      if(!Number.isFinite(percent)||!Number.isFinite(expected)||expected<=0)return unavailable("arithmetic_unavailable");
      exactPercents.push(divide(multiply(decimal(100),exactActual),
        divide(multiply(decimal(t.constraint.value),exactEligible),decimal(t.basis.windowDays))));
      evidence.components.push({measurementId:p.measurement.measurementId,unitId:p.measurement.unit.unitId,
        weight:p.weight,mandatory:p.mandatory,actual,target:t.constraint.value,basisDays:t.basis.windowDays,
        expected,uncappedPercent:percent,cappedPercent:Math.min(100,percent),observationIds:ids,
        qualifyingDays:Array.from(days).sort(),missingObservationIds:missing});
    }
    const weight=evidence.components.reduce((s,c)=>s+c.weight,0);
    const numerator=evidence.components.reduce((s,c)=>s+c.cappedPercent*c.weight,0);
    if(!Number.isFinite(weight)||weight<=0||!Number.isFinite(numerator))return unavailable("arithmetic_unavailable");
    const score=numerator/weight;
    if(!Number.isFinite(score))return unavailable("arithmetic_unavailable");
    // Enforce the promised presentation range without rounding interior values.
    const boundedScore=Math.max(0,Math.min(100,score));
    const exactWeight=r.components.reduce((s,p)=>add(s,decimal(p.weight)),decimal(0));
    const exactScore=divide(exactPercents.reduce((s,p,j)=>add(s,multiply(
      less(p,decimal(100))?p:decimal(100),decimal(r.components[j].weight))),decimal(0)),exactWeight);
    let condition:"Healthy"|"Needs Attention"|"Warning"|"Critical"=
      !less(exactScore,decimal(90))?"Healthy":!less(exactScore,decimal(70))?"Needs Attention":
      !less(exactScore,decimal(50))?"Warning":"Critical";
    const reasons:string[]=[];
    for(let j=0;j<evidence.components.length;j++){
      const p=evidence.components[j];
      if(!p.mandatory)continue;
      if(exactPercents[j].n===zero){condition="Critical";reasons.push(`mandatory_zero:${p.measurementId}`);}
      else if(less(exactPercents[j],decimal(50))){
        if(condition==="Healthy"||condition==="Needs Attention")condition="Warning";
        reasons.push(`mandatory_below_50:${p.measurementId}`);
      }
    }
    return {status:"available",score:boundedScore,condition,reasons,evidence,
      overachievementPercent:Math.min(...evidence.components.map(c=>c.uncappedPercent))};
  };
}
