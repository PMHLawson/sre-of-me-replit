import { describe,it,expect } from "vitest";
import fs from "node:fs";
import { DomainConfigurationSchema,ConfigurationBundleSchema,ObservationSchema,type DomainConfiguration,type Observation } from "./domain-config";
import { complianceWindowDayOptions } from "./schema";
import { STEP9_RULES,FutureSeedResultSchema,type FutureSeedResult } from "./step9-contract";
import { meditation,practices,MEDITATION_EXAMPLES,approvedSeedParticipation } from "./fixtures/step9-examples";
import { reference,qualifies,logicalDay,completedDays } from "./fixtures/step9-reference-oracle";
import { configurationFor,observationFor,conditionFor,MEASUREMENTS } from "./fixtures/domain-config-cases";

const now="2026-01-15T12:00:00Z";
function input(c=meditation(),observations:Observation[]=practices(c,10,10),window:7|14|28|42=14){
 return {configurations:[c],observations,now,window,participation:approvedSeedParticipation(c),
  scope:{organizationId:c.organizationId,ownerUserId:c.ownerUserId,domainId:c.domainId},
  coverage:Object.fromEntries(completedDays(now,window,c.boundary).map(d=>[d,1]))};
}
function available(result:FutureSeedResult){
 expect(FutureSeedResultSchema.safeParse(result).success).toBe(true);
 expect(result.status).toBe("available");
 if(result.status!=="available")throw Error("Expected available synthetic result");
 expect(Object.hasOwn(result,"budget")).toBe(false);return result;
}
function unavailable(result:FutureSeedResult,reason:string){
 expect(result).toEqual({status:"unavailable",reason});
 expect(FutureSeedResultSchema.safeParse(result).success).toBe(true);
 expect(Object.hasOwn(result,"score")).toBe(false);expect(Object.hasOwn(result,"condition")).toBe(false);
 expect(Object.hasOwn(result,"budget")).toBe(false);
}
describe("Step 9 — approved synthetic acceptance",()=>{
 it("duration-shaped evidence alone never opts a domain into scoring",()=>{
  const i=input();
  unavailable(reference({...i,participation:undefined}).result,"participation_unapproved");
  const r=available(reference(i).result);
  const {participation,...unapproved}=r;
  expect(FutureSeedResultSchema.safeParse(unapproved).success).toBe(false);
 });
 it.each(["approved","recipe","owner","policy","target","measurement","weight","mandatory","extra-component"] as const)(
  "invalid explicit participation %s is unavailable",change=>{
   const i=input(),p=structuredClone(i.participation) as any;
   if(change==="approved")p.approved=false;
   if(change==="recipe")p.recipe="unapproved";
   if(change==="owner")p.ownerUserId="foreign";
   if(change==="policy")p.policyVersionId="other-policy";
   if(change==="target")p.targetId="other-target";
   if(change==="measurement")p.components[0].measurementId="unapproved-measure";
   if(change==="weight")p.components[0].weight=0.75;
   if(change==="mandatory")p.components[1].mandatory=false;
   if(change==="extra-component")p.components.push(p.components[0]);
   unavailable(reference({...i,participation:p}).result,"participation_unapproved");
 });
 it.each([["context",0],["outcome",0],["context",1],["outcome",1]] as const)(
  "%s measurement at component %i cannot participate", (role,index)=>{
   const c=meditation();c.measurements[index].role=role;
   expect(DomainConfigurationSchema.safeParse(c).success).toBe(true);
   unavailable(reference(input(c)).result,"measurement_role_unapproved");
 });
 it.each(["extra-normal","stretch","upper-recovery"] as const)(
  "unsupported %s target conditions are not silently ignored",kind=>{
   const c=meditation();
   if(kind==="extra-normal"){
    const extra=structuredClone(MEASUREMENTS[4]);extra.role="outcome";c.measurements.push(extra);
    c.targets.normal.conditions.push(conditionFor(extra,true));
   }
   if(kind==="stretch")c.targets.stretch={...structuredClone(c.targets.normal),targetId:"stretch"};
   if(kind==="upper-recovery")c.targets.upperRecovery={conditions:structuredClone(c.targets.normal.conditions)};
   expect(DomainConfigurationSchema.safeParse(c).success).toBe(true);
   unavailable(reference(input(c)).result,"target_conditions_unapproved");
 });
 it.each([28,42] as const)("fully exempt %i-day window retains actual raw practices without credited activity",window=>{
  for(const weekly of [50,70] as const){
   const c=meditation(weekly),i=input(c,[],window);
   // Real calendar dates from the completed window, including December for 42 days.
   i.observations=completedDays(i.now,window,c.boundary).map((day,n)=>({
    ...practices(c,1,10)[0],observationId:`exempt-${window}-${n}`,observedAt:day+"T12:00:00Z",
   }));
   const before=JSON.stringify(i),r=reference({...i,exemptions:{...i.coverage}});
   unavailable(r.result,"no_eligible_coverage");
   expect(r.evidence.continuity).toBe("preserved-across-approved-breaks");
   expect(r.evidence.creditedEligibleQuantity).toBe(0);
   expect(r.evidence.creditedQualifyingDays).toBe(0);
   expect(r.evidence.rawCompletedPractices).toEqual(i.observations);
   expect(r.evidence.rawCompletedPractices).toHaveLength(window);
   expect(r.evidence.rawCompletedPractices.reduce((sum,o)=>sum+Number(o.values[c.measurements[0].measurementId].value),0)).toBe(window*10);
   expect(JSON.stringify(i)).toBe(before);
   r.evidence.rawCompletedPractices[0].values[c.measurements[0].measurementId].value=999;
   expect(JSON.stringify(i)).toBe(before);
  }
 });
 it.each([50,70] as const)("hand-computed Meditation table, %i minutes/week",weekly=>{
  for(const e of MEDITATION_EXAMPLES){
   const c=meditation(weekly),observations=practices(c,e.days,e.minutes,e.perDay);
   const original=JSON.stringify({c,observations});
   const {result,evidence}=reference(input(c,observations)),r=available(result);
   expect(r.components[0].expected).toBe(weekly*2);expect(r.components[1].expected).toBe(10);
   expect(evidence.creditedEligibleQuantity).toBe(e.quantity);expect(evidence.creditedQualifyingDays).toBe(e.qualifyingDays);
   expect(r.score,e.label).toBeCloseTo(weekly===50?e.score50:e.score70,12);
   expect(r.condition,e.label).toBe(weekly===50?e.condition50:e.condition70);
   expect(JSON.stringify({c,observations})).toBe(original);
  }
 });
 it.each([
  ["martial-arts",105,15,5],["meditation",70,10,5],["fitness",90,15,5],["music",45,15,3],
 ] as const)("all seed profiles: %s, still arbitrary identities",(_label,weekly,floor,days)=>{
  const c=meditation(70);c.domainId=`not-a-legacy-slug-${_label}`;c.displayName="An owner's custom name";
  const q=c.qualification!;if(q.kind!=="condition"||q.condition.valueType==="boolean")throw Error("fixture");
  q.condition.constraint={operator:"gte",value:floor};
  const quantity=c.targets.normal.conditions[0],frequency=c.targets.normal.conditions[1];
  if(quantity.valueType==="boolean"||frequency.valueType==="boolean")throw Error("fixture");
  quantity.constraint={operator:"gte",value:weekly};frequency.constraint={operator:"gte",value:days};
  const r=available(reference(input(c,practices(c,days*2,weekly/days))).result);
  expect(r.components.map(c=>c.expected)).toEqual([weekly*2,days*2]);expect(r.score).toBeCloseTo(100,12);
  expect(r.condition).toBe("Healthy");
 });
 it.each([7,14,28,42] as const)("accepted %i-day selected window scales from explicit coverage",window=>{
  expect(STEP9_RULES.windows).toEqual(complianceWindowDayOptions);
  const c=meditation(),r=available(reference(input(c,[],window)).result);
  expect(r.eligibleDays).toBe(window);expect(r.components[0].expected).toBe(50*window/7);
  expect(r.components[1].expected).toBe(5*window/7);expect(r.score).toBe(0);expect(r.condition).toBe("Critical");
 });
 it("two short practices cannot pool qualification, but their minutes remain quantity evidence",()=>{
  const c=meditation(),rows=practices(c,10,5,2),{result,evidence}=reference(input(c,rows));
  const r=available(result);
  expect(evidence.creditedEligibleQuantity).toBe(100);expect(evidence.creditedQualifyingDays).toBe(0);
  expect(r.score).toBe(50);expect(r.condition).toBe("Critical");expect(r.overachievementPercent).toBe(0);
 });
 it("whole conjunction must qualify on one record, never across records",()=>{
  const c=configurationFor("conjunction",MEASUREMENTS[1],20);
  const completion=structuredClone(MEASUREMENTS[4]);c.measurements.push(completion);
  c.qualification={kind:"all",predicates:[
   {kind:"condition",condition:conditionFor(c.measurements[0],10)},
   {kind:"condition",condition:conditionFor(completion,true)},
  ]};
  const a=observationFor(c,"a",12),b=observationFor(c,"b",2);
  a.values[completion.measurementId]={valueType:"boolean",unitId:"completed",value:false};
  b.values[completion.measurementId]={valueType:"boolean",unitId:"completed",value:true};
  expect(qualifies(c.qualification,a)).toBe(false);expect(qualifies(c.qualification,b)).toBe(false);
 });
 it("same-day duplicates affect quantity, never distinct-day frequency",()=>{
  const c=meditation(),r=available(reference(input(c,practices(c,5,10,2))).result);
  expect(r.components.map(c=>c.actual)).toEqual([100,5]);expect(r.score).toBe(75);
  expect(r.overachievementPercent).toBe(50);
 });
 it("current-day practice stays separate, future practice is not counted",()=>{
  const c=meditation(),rows=practices(c,5,10);
  const today={...rows[0],observationId:"today",observedAt:"2026-01-15T10:00:00Z"};
  const future={...today,observationId:"future",observedAt:"2026-01-15T13:00:00Z"};
  const r=reference(input(c,[...rows,today,future]));
  expect(r.evidence.todayPractices).toBe(1);expect(available(r.result).score).toBe(50);
 });
 it("fractional breaks scale eligible expectations without resetting continuity",()=>{
  const c=meditation(),i=input(c,practices(c,5,10));
  const r=reference({...i,exemptions:{"2026-01-14":0.5}});
  const a=available(r.result);
  expect(a.eligibleDays).toBe(13.5);expect(a.components[0].expected).toBeCloseTo(675/7);
  expect(a.components[1].expected).toBeCloseTo(67.5/7);expect(a.score).toBeCloseTo(1400/27);
  expect(r.evidence.continuity).toBe("preserved-across-approved-breaks");
 });
 it("partial onboarding coverage scales expectations, without extending the selected window",()=>{
  const c=meditation(),i=input(c,[]);
  const coverage=Object.fromEntries(Object.keys(i.coverage).map((d,n)=>[d,n<7?0:1]));
  const r=available(reference({...i,coverage}).result);
  expect(r.eligibleDays).toBe(7);expect(r.components.map(c=>c.expected)).toEqual([50,5]);
 });
 it("a completely exempt window preserves continuity and supplies no fabricated score",()=>{
  const i=input(meditation(),[]),r=reference({...i,exemptions:{...i.coverage}});
  unavailable(r.result,"no_eligible_coverage");expect(r.evidence.continuity).toBe("preserved-across-approved-breaks");
 });
 it("unknown coverage and unsettled credit for practice on a break stay unavailable",()=>{
  const i=input();
  unavailable(reference({...i,coverage:undefined}).result,"coverage_unknown");
  unavailable(reference({...i,exemptions:{"2026-01-01":0.5}}).result,"break_activity_credit_unsettled");
  unavailable(reference({...i,exemptions:{"2026-01-14":1.5}}).result,"coverage_unknown");
 });
 it("components cap before averaging, while overachievement retains the lowest uncapped evidence",()=>{
  const c=meditation(),r=available(reference(input(c,practices(c,5,40))).result);
  expect(r.components.map(c=>c.uncappedPercent)).toEqual([200,50]);
  expect(r.components.map(c=>c.cappedPercent)).toEqual([100,50]);expect(r.score).toBe(75);
  expect(r.overachievementPercent).toBe(50);
  const both=available(reference(input(c,practices(c,12,20))).result);
  expect(both.score).toBe(100);expect(both.overachievementPercent).toBe(120);
 });
});

describe("Step 9 — boundaries, types and unapproved rules",()=>{
 it.each([
  ["2026-01-15T08:59:59Z","America/New_York",4,"2026-01-14"],
  ["2026-01-15T09:00:00Z","America/New_York",4,"2026-01-15"],
  ["2026-01-01T18:29:59Z","Asia/Kolkata",0,"2026-01-01"],
  ["2026-01-01T18:30:00Z","Asia/Kolkata",0,"2026-01-02"],
  ["2026-03-08T06:59:59Z","America/New_York",2,"2026-03-07"],
  ["2026-03-08T07:00:00Z","America/New_York",2,"2026-03-08"],
  ["2026-11-01T05:30:00Z","America/New_York",1,"2026-11-01"],
  ["2026-11-01T06:30:00Z","America/New_York",1,"2026-11-01"],
 ] as const)("civil logical day %s / %s / %i", (at,timezone,dayStartHour,expected)=>{
  expect(logicalDay(at,{timezone,dayStartHour})).toBe(expected);
 });
 it("DST windows are fourteen civil dates, not fourteen fixed 24-hour offsets",()=>{
  for(const now of ["2026-03-15T12:00:00Z","2026-11-08T12:00:00Z"]){
   const days=completedDays(now,14,{timezone:"America/New_York",dayStartHour:4});
   expect(days).toHaveLength(14);expect(new Set(days).size).toBe(14);
   expect(days).not.toContain(logicalDay(now,{timezone:"America/New_York",dayStartHour:4}));
  }
 });
 it.each(MEASUREMENTS)("typed $kind is representable, with no invented duration",m=>{
  const value=m.valueType==="boolean"?false:m.valueType==="integer"?12:2.5;
  const c=configurationFor("custom-"+m.kind,m,value),o=observationFor(c,"typed-event",value);
  expect(ConfigurationBundleSchema.safeParse({schemaVersion:1,configurations:[c],observations:[o]}).success).toBe(true);
  expect(Object.keys(o.values)).toEqual([m.measurementId]);
  if(m.kind!=="duration")expect(Object.values(o.values).some(v=>v.unitId==="minute")).toBe(false);
 });
 it("recorded false is preserved and evaluated distinctly from missing",()=>{
  const c=configurationFor("false",MEASUREMENTS[4],false),o=observationFor(c,"false-event",false);
  const predicate={kind:"condition" as const,condition:conditionFor(c.measurements[0],false)};
  expect(ObservationSchema.parse(o).values[c.measurements[0].measurementId].value).toBe(false);
  expect(qualifies(predicate,o)).toBe(true);expect(qualifies(predicate,{...o,values:{}})).toBe(false);
  expect(qualifies({kind:"condition",condition:conditionFor(c.measurements[0],true)},o)).toBe(false);
 });
 it("count-only qualifying days are evidence, but have no invented minute percentage recipe",()=>{
  const c=configurationFor("custom-cupcake",MEASUREMENTS[2],12);
  c.qualification={kind:"condition",condition:conditionFor(c.measurements[0],6)};
  const o=observationFor(c,"cupcakes",12),r=reference(input(c,[o]));
  expect(r.evidence.creditedQualifyingDays).toBe(1);expect(Object.keys(o.values)).toEqual(["m-cupcakes"]);
  unavailable(r.result,"percentage_rule_unapproved");
 });
 it("typed frequency declares events versus days explicitly; events are not substituted for days",()=>{
  const c=meditation(),frequency=c.measurements[1];
  expect(frequency.kind).toBe("frequency");
  const o=practices(c,1,10)[0];
  o.values[frequency.measurementId]={unitId:"day",valueType:"integer",value:0};
  expect(ObservationSchema.safeParse(o).success).toBe(true);
  // Raw event observations should not manufacture this derived value.
  expect(Object.keys(practices(c,1,10)[0].values)).toEqual([c.measurements[0].measurementId]);
 });
 it("unit, value type, task variant, owner and version cannot be silently substituted",()=>{
  const c=meditation(),base=practices(c,1,10)[0],m=c.measurements[0].measurementId;
  for(const changed of [
   {...base,policyVersionId:"foreign-version"},
   {...base,values:{[m]:{valueType:"number",unitId:"hour",value:10}}},
   {...base,values:{[m]:{valueType:"integer",unitId:"minute",value:10}}},
   {...base,values:{[m]:{valueType:"number",unitId:"minute",taskVariantId:"undeclared",value:10}}},
  ]){
   unavailable(reference(input(c,[changed as Observation])).result,"invalid_context");
  }
  c.taskVariants=[{variantId:"standard",displayName:"Standard task",taskConditions:[]}];
  c.measurements[0].taskVariantId="standard";
  for(const t of c.targets.normal.conditions)if(t.measurementId===m)t.taskVariantId="standard";
  if(c.qualification?.kind==="condition")c.qualification.condition.taskVariantId="standard";
  const good=structuredClone(base);good.values[m].taskVariantId="standard";
  expect(ConfigurationBundleSchema.safeParse({schemaVersion:1,configurations:[c],observations:[good]}).success).toBe(true);
  expect(ConfigurationBundleSchema.safeParse({schemaVersion:1,configurations:[c],observations:[base]}).success).toBe(false);
 });
 it("arbitrary domain AND measurement identities work; names never confer ownership",()=>{
  const a=meditation(),b=meditation();
  b.organizationId="other-org";b.ownerUserId="other-person";b.domainId="another-domain";b.policyVersionId="another-policy";
  const renamed=JSON.parse(JSON.stringify(a).replaceAll("m-duration","opaque-measurement-f829"));
  const i=input(renamed,practices(renamed,5,10)),expected=reference(i);
  const foreign=practices(b,14,100);
  expect(reference({...i,configurations:[renamed,b],observations:[...i.observations,...foreign]})).toEqual(expected);
  expect(available(expected.result).score).toBe(50);
  const forged={...foreign[0],ownerUserId:a.ownerUserId,organizationId:a.organizationId,domainId:a.domainId};
  unavailable(reference({...i,observations:[forged]}).result,"invalid_context");
 });
 it("qualification and reference floors do not silently track a lower adapted target",()=>{
  const c=meditation(),before=JSON.stringify(practices(c,5,5)),predicate=structuredClone(c.qualification);
  const adapted=structuredClone(c.targets.normal);adapted.targetId="temporary-adaptation";
  const t=adapted.conditions[0];if(t.valueType!=="boolean")t.constraint={operator:"gte",value:25};
  c.targets.adapted={target:adapted,duration:"temporary",effectiveFrom:"2026-01-08T00:00:00Z",reviewAt:"2026-01-22T00:00:00Z"};
  expect(DomainConfigurationSchema.safeParse(c).success).toBe(true);expect(c.qualification).toEqual(predicate);
  expect(qualifies(c.qualification,practices(c,1,5)[0])).toBe(false);
  unavailable(reference(input(c,practices(c,5,5))).result,"adaptation_selection_unsettled");
  expect(JSON.stringify(practices(c,5,5))).toBe(before);
 });
 it("a declared reference is not the personal denominator or a rewritten qualification",()=>{
  const c=meditation(),baseline=reference(input(c));
  if(c.qualification?.kind!=="condition")throw Error("fixture");
  const ref=structuredClone(c.qualification.condition);
  if(ref.valueType!=="boolean")ref.constraint={operator:"gte",value:100};
  c.references=[{referenceId:"reference-only",purpose:"develop",status:"known",conditions:[ref],
   applicability:{description:"Synthetic only"},evidence:{category:"personal",confidence:"unknown",review:{status:"unreviewed"}}}];
  expect(reference(input(c))).toEqual(baseline);
 });
 it("policy intervals are half-open and historical mixed-target aggregation stays unavailable",()=>{
  const c=meditation(),next=structuredClone(c);
  next.policyVersionId="revision-two";next.previousVersionId=c.policyVersionId;next.revision=2;next.effectiveFrom="2026-01-08T00:00:00Z";
  const old=practices(c,7,10),edge={...practices(next,1,10)[0],observationId:"edge",observedAt:next.effectiveFrom};
  const before={...old[0],observationId:"before",observedAt:"2026-01-07T23:59:59.999Z"};
  expect(ConfigurationBundleSchema.safeParse({schemaVersion:1,configurations:[next,c],observations:[before,edge]}).success).toBe(true);
  const i={...input(c,[...old,edge]),configurations:[c,next]};
  unavailable(reference(i).result,"policy_boundary_unsettled");
  unavailable(reference({...i,observations:[{...edge,policyVersionId:c.policyVersionId}]}).result,"invalid_context");
  next.effectiveFrom="2026-01-20T00:00:00Z";
  expect(reference({...input(c),configurations:[c,next]})).toEqual(reference(input(c)));
 });
 it.each(["lower_is_better","within_range","equal"] as const)("unapproved %s percentages remain unavailable",direction=>{
  const c=meditation();c.measurements[0].comparisonDirection=direction;
  unavailable(reference(input(c)).result,"direction_unapproved");
 });
 it("missing or zero targets and unknown qualification are unavailable, not healthy",()=>{
  const missing=meditation();missing.targets.normal.conditions.pop();
  unavailable(reference(input(missing)).result,"target_missing");
  const zero=meditation(),t=zero.targets.normal.conditions[0];if(t.valueType!=="boolean")t.constraint={operator:"gte",value:0};
  unavailable(reference(input(zero)).result,"target_zero");
  const unknown=meditation();delete unknown.qualification;
  unavailable(reference(input(unknown)).result,"qualification_unspecified");
 });
});

describe("Step 9 — result invariants and integration boundary",()=>{
 function result(q:number,f:number,condition:string){
  return {status:"available",participation:approvedSeedParticipation(meditation()),eligibleDays:14,score:(Math.min(q,100)+Math.min(f,100))/2,condition,
   overachievementPercent:Math.min(q,f),components:[
    {kind:"quantity",actual:q,expected:100,uncappedPercent:q,cappedPercent:Math.min(q,100),weight:0.5,mandatory:true},
    {kind:"frequency",actual:f,expected:100,uncappedPercent:f,cappedPercent:Math.min(f,100),weight:0.5,mandatory:true},
   ]};
 }
 it.each([
  [90,90,"Healthy"],[89.9999,89.9999,"Needs Attention"],[70,70,"Needs Attention"],[69.9999,69.9999,"Warning"],
  [50,50,"Warning"],[49.9999,49.9999,"Critical"],[100,40,"Warning"],[100,50,"Needs Attention"],[100,0,"Critical"],
 ] as const)("precise guardrails q=%s f=%s => %s",(q,f,condition)=>{
  expect(FutureSeedResultSchema.safeParse(result(q,f,condition)).success).toBe(true);
  expect(FutureSeedResultSchema.safeParse({...result(q,f,condition),condition:condition==="Healthy"?"Critical":"Healthy"}).success).toBe(false);
 });
 it("rounding is presentation-only; fabricated budget, healthy exemptions and early rounding are rejected",()=>{
  const r=result(89.9999,89.9999,"Needs Attention");
  expect(Math.round(r.score)).toBe(90);
  expect(FutureSeedResultSchema.safeParse({...r,score:90}).success).toBe(false);
  expect(FutureSeedResultSchema.safeParse({...r,budget:{remaining:0}}).success).toBe(false);
  expect(FutureSeedResultSchema.safeParse({status:"unavailable",reason:"no_eligible_coverage",score:100,condition:"Healthy"}).success).toBe(false);
 });
 it("nonfinite division evidence cannot pass by an infinite comparison tolerance",()=>{
  const r=result(90,90,"Healthy");
  r.components[0].actual=Number.MAX_VALUE;r.components[0].expected=Number.MIN_VALUE;
  expect(FutureSeedResultSchema.safeParse(r).success).toBe(false);
 });
 it("runtime code never imports the test-only reference calculator or the not-yet-adopted contract",()=>{
  const files:string[]=[];
  function walk(dir:string){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
   const p=dir+"/"+entry.name;if(entry.isDirectory())walk(p);
   else if(/\.[cm]?[jt]sx?$/.test(p)&&!p.includes(".test."))files.push(p);
  }}
  for(const dir of ["server","client","script"])walk(dir);
  for(const file of files)expect(fs.readFileSync(file,"utf8"),file).not.toMatch(/(?:from\s*|import\s*\()["'][^"']*step9-(?:contract|reference-oracle|examples)/);
 });
});
