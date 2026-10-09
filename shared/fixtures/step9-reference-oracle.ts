/**
 * TEST-ONLY reference arithmetic, not the later runtime scoring engine.
 * Imported only by Step 9 tests. All time/coverage/policy inputs are synthetic.
 */
import { ConfigurationBundleSchema, type DomainConfiguration, type Observation, type QualificationPredicate } from "../domain-config";
import type { FutureSeedResult, UnavailableReason } from "../step9-contract";
import { SeedParticipationSchema } from "../step9-contract";

const unavailable=(reason:UnavailableReason):FutureSeedResult=>({status:"unavailable",reason});
function shift(day:string,n:number) { const d=new Date(day+"T12:00:00Z");d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10); }
export function logicalDay(at:string,boundary:DomainConfiguration["boundary"]) {
  const f=new Intl.DateTimeFormat("en-CA",{timeZone:boundary.timezone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",hourCycle:"h23"});
  const p=Object.fromEntries(f.formatToParts(new Date(at)).map(p=>[p.type,p.value]));
  const day=`${p.year}-${p.month}-${p.day}`;
  return Number(p.hour)<boundary.dayStartHour ? shift(day,-1) : day;
}
export function completedDays(now:string,window:7|14|28|42,boundary:DomainConfiguration["boundary"]) {
  const today=logicalDay(now,boundary);
  return Array.from({length:window},(_,i)=>shift(today,i-window));
}
/** One predicate is tested against ONE event; missing and recorded false differ. */
export function qualifies(predicate:QualificationPredicate | undefined,o:Observation):boolean|undefined {
  if(!predicate)return undefined;
  if(predicate.kind!=="condition"){
    const results=predicate.predicates.map(p=>qualifies(p,o));
    if(results.some(r=>r===undefined))return undefined;
    return predicate.kind==="all"?results.every(Boolean):results.some(Boolean);
  }
  const c=predicate.condition,v=o.values[c.measurementId];
  if(c.basis.kind!=="per_event")return undefined;
  if(!v)return false;
  if(v.unitId!==c.unitId || v.valueType!==c.valueType || v.taskVariantId!==c.taskVariantId)return undefined;
  if(c.valueType==="boolean")return v.value===c.constraint.value;
  if(typeof v.value!=="number")return undefined;
  const rule=c.constraint;
  if(rule.operator==="range")return v.value>=rule.min&&v.value<=rule.max;
  return rule.operator==="gte"?v.value>=rule.value:rule.operator==="lte"?v.value<=rule.value:
    v.value===rule.value;
}
export function reference(input:{
  configurations:DomainConfiguration[];observations:Observation[];now:string;window:7|14|28|42;
  scope:{organizationId:string;ownerUserId:string;domainId:string};
  /** Fraction of day covered since onboarding, BEFORE approved exemption. */
  coverage?:Record<string,number>;exemptions?:Record<string,number>;
  participation?:unknown;
}) {
  const configs=input.configurations.filter(c=>c.organizationId===input.scope.organizationId&&c.ownerUserId===input.scope.ownerUserId&&c.domainId===input.scope.domainId);
  const observations=input.observations.filter(o=>o.organizationId===input.scope.organizationId&&o.ownerUserId===input.scope.ownerUserId&&o.domainId===input.scope.domainId);
  const evidence={creditedEligibleQuantity:0,creditedQualifyingDays:0,todayPractices:0,
    rawCompletedPractices:[] as Observation[],
    continuity:"preserved-across-approved-breaks" as const};
  const finish=(result:FutureSeedResult)=>({result,evidence});
  if(!ConfigurationBundleSchema.safeParse({schemaVersion:1,configurations:configs,observations}).success)return finish(unavailable("invalid_context"));
  const c=configs.filter(c=>Date.parse(c.effectiveFrom)<=Date.parse(input.now)).sort((a,b)=>b.revision-a.revision)[0];
  if(!c)return finish(unavailable("invalid_context"));
  const today=logicalDay(input.now,c.boundary),days=completedDays(input.now,input.window,c.boundary);
  const eligible:Record<string,number>={};
  for(const day of days) {
    const covered=input.coverage?.[day] ?? NaN,exempt=input.exemptions?.[day]??0;
    if(!Number.isFinite(covered)||covered<0||covered>1||!Number.isFinite(exempt)||exempt<0||exempt>covered)return finish(unavailable("coverage_unknown"));
    eligible[day]=covered-exempt;
  }
  const active=observations.filter(o=>Date.parse(o.observedAt)<=Date.parse(input.now));
  evidence.todayPractices=active.filter(o=>logicalDay(o.observedAt,c.boundary)===today).length;
  const rows=active.filter(o=>days.includes(logicalDay(o.observedAt,c.boundary)));
  // Preserve typed raw evidence independently of credit, including full exemption.
  // Detached copies ensure consumers cannot mutate caller-owned practices.
  evidence.rawCompletedPractices=structuredClone(rows);
  const eligibleDays=Object.values(eligible).reduce((n,v)=>n+v,0);
  if(eligibleDays===0)return finish(unavailable("no_eligible_coverage"));
  if(rows.some(o=>(input.exemptions?.[logicalDay(o.observedAt,c.boundary)]??0)>0))
    return finish(unavailable("break_activity_credit_unsettled"));
  // Per-version evidence stays valid, but a mixed-version scalar needs an
  // approved weighting rule. Do not apply the latest target retroactively.
  if(configs.some(p=>p.revision!==c.revision&&Date.parse(p.effectiveFrom)<Date.parse(input.now)) &&
    (rows.some(o=>o.policyVersionId!==c.policyVersionId)||days.some(day=>day<logicalDay(c.effectiveFrom,c.boundary))))
    return finish(unavailable("policy_boundary_unsettled"));
  if(c.targets.adapted)return finish(unavailable("adaptation_selection_unsettled"));
  if(!c.qualification)return finish(unavailable("qualification_unspecified"));
  const qualified=new Set<string>();
  for(const o of rows) {
    const q=qualifies(c.qualification,o);
    if(q===undefined)return finish(unavailable("qualification_unspecified"));
    const day=logicalDay(o.observedAt,c.boundary);
    if(q&&eligible[day]>0)qualified.add(day);
  }
  evidence.creditedQualifyingDays=qualified.size;
  const quantities=c.measurements.filter(m=>m.kind==="duration");
  if(quantities.length!==1)return finish(unavailable("percentage_rule_unapproved"));
  const approved=SeedParticipationSchema.safeParse(input.participation);
  if(!approved.success)return finish(unavailable("participation_unapproved"));
  const participation=approved.data;
  if(participation.organizationId!==c.organizationId||participation.ownerUserId!==c.ownerUserId||
    participation.domainId!==c.domainId||participation.policyVersionId!==c.policyVersionId||
    participation.targetId!==c.targets.normal.targetId)return finish(unavailable("participation_unapproved"));
  const m=c.measurements.find(m=>m.measurementId===participation.components[0].measurementId);
  const frequency=c.measurements.find(m=>m.measurementId===participation.components[1].measurementId);
  if(!m||m.kind!=="duration"||!frequency||frequency.kind!=="frequency"||frequency.countBy!=="distinct_days")
    return finish(unavailable("participation_unapproved"));
  if(m.role!=="practice"||frequency.role!=="practice")return finish(unavailable("measurement_role_unapproved"));
  if(m.comparisonDirection!=="higher_is_better"||frequency?.comparisonDirection!=="higher_is_better")return finish(unavailable("direction_unapproved"));
  if(m.aggregation!=="sum"||m.scope.kind!=="per_event")return finish(unavailable("aggregation_unapproved"));
  if(m.unit.unitId!=="minute")return finish(unavailable("percentage_rule_unapproved"));
  const qt=c.targets.normal.conditions.find(t=>t.measurementId===m.measurementId);
  const ft=c.targets.normal.conditions.find(t=>t.measurementId===frequency?.measurementId);
  if(!qt||!ft)return finish(unavailable("target_missing"));
  if(c.targets.normal.conditions.length!==2||c.targets.stretch||c.targets.upperRecovery)
    return finish(unavailable("target_conditions_unapproved"));
  if(qt.valueType==="boolean"||ft.valueType==="boolean"||qt.constraint.operator!=="gte"||ft.constraint.operator!=="gte"||
    qt.basis.kind!=="period"||ft.basis.kind!=="period"||qt.periodAggregation?.method!=="sum")
    return finish(unavailable("percentage_rule_unapproved"));
  if(qt.constraint.value===0||ft.constraint.value===0)return finish(unavailable("target_zero"));
  for(const o of rows)if(eligible[logicalDay(o.observedAt,c.boundary)]>0){
    const v=o.values[m.measurementId];
    if(v&&typeof v.value==="number")evidence.creditedEligibleQuantity+=v.value;
  }
  const quantitiesExpected=qt.constraint.value*eligibleDays/qt.basis.windowDays;
  const frequencyExpected=ft.constraint.value*eligibleDays/ft.basis.windowDays;
  const q=100*evidence.creditedEligibleQuantity/quantitiesExpected,f=100*evidence.creditedQualifyingDays/frequencyExpected;
  const score=(Math.min(q,100)+Math.min(f,100))/2,lowest=Math.min(q,f);
  let condition:"Healthy"|"Needs Attention"|"Warning"|"Critical"=score>=90?"Healthy":score>=70?"Needs Attention":score>=50?"Warning":"Critical";
  if(lowest===0)condition="Critical";
  else if(lowest<50&&(condition==="Healthy"||condition==="Needs Attention"))condition="Warning";
  return finish({status:"available",participation,eligibleDays,score,condition,overachievementPercent:lowest,
    components:[
      {kind:"quantity",actual:evidence.creditedEligibleQuantity,expected:quantitiesExpected,uncappedPercent:q,cappedPercent:Math.min(q,100),weight:0.5,mandatory:true},
      {kind:"frequency",actual:evidence.creditedQualifyingDays,expected:frequencyExpected,uncappedPercent:f,cappedPercent:Math.min(f,100),weight:0.5,mandatory:true},
    ]});
}
