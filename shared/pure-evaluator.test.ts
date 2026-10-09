import { describe,it,expect } from "vitest";
import fs from "node:fs";
import { createEvaluator, type EvaluationResult } from "./pure-evaluator";
import { assembleWindow, logicalDay } from "./evaluator-window";
import type { EvaluationInput, EvaluationRecipe } from "./evaluator-recipe";
import type { DomainConfiguration, Observation } from "./domain-config";
import { meditation, practices, MEDITATION_EXAMPLES } from "./fixtures/step9-examples";
import { MEASUREMENTS } from "./fixtures/domain-config-cases";

function recipe(c:DomainConfiguration):EvaluationRecipe {
  const target=c.targets.adapted?.target??c.targets.normal;
  return {recipeId:"synthetic-reviewed-profile",version:"1",organizationId:c.organizationId,
    ownerUserId:c.ownerUserId,domainId:c.domainId,policyVersionId:c.policyVersionId,
    targetId:target.targetId,targetSelection:c.targets.adapted?"adapted":"normal",
    qualification:c.qualification??null,
    components:target.conditions.map(t=>({
      measurement:structuredClone(c.measurements.find(m=>m.measurementId===t.measurementId)!),
      targetCondition:structuredClone(t),weight:1,mandatory:true,
      actual:t.measurementId==="qualifying-days"?"distinct-qualifying-days":"sum-events",
      percentage:"positive-linear-ratio-v1",
    }))};
}
function input(c=meditation(),observations:Observation[]=practices(c,10,10)):EvaluationInput {
  return {now:"2026-01-15T12:00:00Z",windowDays:14,policy:c,observations,
    coverage:{onboardingAt:"2025-01-01T00:00:00Z",policyStart:c.effectiveFrom,policyEnd:"2027-01-01T00:00:00Z"},
    breaks:[],recipe:recipe(c)};
}
function run(i:EvaluationInput){return createEvaluator([i.recipe])(i);}
function available(r:EvaluationResult){
  expect(r.status, r.status==="unavailable"?r.reason:"").toBe("available");
  if(r.status!=="available")throw Error(r.reason);return r;
}
function unavailable(r:EvaluationResult,reason:string){
  expect(r.status).toBe("unavailable");if(r.status!=="unavailable")throw Error("available");
  expect(r.reason).toBe(reason);expect(r).not.toHaveProperty("score");expect(r).not.toHaveProperty("condition");
}
function counts(n=1):EvaluationInput {
  const c=meditation();delete c.qualification;
  c.measurements=Array.from({length:n},(_,j)=>({...structuredClone(MEASUREMENTS[2]),measurementId:`opaque-count-${j}`}));
  c.targets.normal.conditions=c.measurements.map(m=>({measurementId:m.measurementId,unitId:m.unit.unitId,
    valueType:"integer",basis:{kind:"period",windowDays:7},periodAggregation:{sourceBasis:"per_event",method:"sum"},
    constraint:{operator:"gte",value:20}}));
  const o:Observation={...practices(meditation(),1,1)[0],values:Object.fromEntries(c.measurements.map(m=>[
    m.measurementId,{unitId:"cupcake",valueType:"integer",value:40}]))};
  return input(c,[o]);
}
describe("pure evaluator: independent arithmetic",()=>{
  function numeric(actuals:number[],targets:number[],weights:number[]):EvaluationInput {
    const i=counts(actuals.length);
    i.policy.measurements=actuals.map((_,j)=>({...structuredClone(MEASUREMENTS[3]),measurementId:`numeric-${j}`}));
    i.policy.targets.normal.conditions=i.policy.measurements.map((m,j)=>({
      measurementId:m.measurementId,unitId:m.unit.unitId,valueType:"number",basis:{kind:"period",windowDays:7},
      periodAggregation:{sourceBasis:"per_event",method:"sum"},constraint:{operator:"gte",value:targets[j]}}));
    i.windowDays=7;i.observations[0].observedAt="2026-01-08T12:00:00Z";
    i.observations[0].values=Object.fromEntries(i.policy.measurements.map((m,j)=>[
      m.measurementId,{unitId:m.unit.unitId,valueType:"number",value:actuals[j]}]));
    i.recipe=recipe(i.policy);i.recipe.components.forEach((p,j)=>p.weight=weights[j]);return i;
  }
  it("fully attained decimal-weight components export exactly the capped health maximum",()=>{
    const r=available(run(numeric([1,1,1],[1,1,1],[0.3,0.6,0.1])));
    expect(r.score).toBe(100);
    expect(r.condition).toBe("Healthy");expect(r.reasons).toEqual([]);
    expect(r.overachievementPercent).toBe(100);
  });
  it("positive underflow is not a mandatory zero and interior presentation is unrounded",()=>{
    const r=available(run(numeric([Number.MIN_VALUE,1],[1e300,1],[1,1])));
    expect(r.evidence.components[0].uncappedPercent).toBe(0);
    expect(r.score).toBe(50);expect(r.condition).toBe("Warning");
    expect(r.reasons).toEqual(["mandatory_below_50:numeric-0"]);
    const interior=available(run(numeric([1],[3],[1])));
    expect(interior.score).toBe(100/3);
    const zero=available(run(numeric([0],[1],[0.3])));
    expect(zero.score).toBe(0);expect(zero.reasons).toEqual(["mandatory_zero:numeric-0"]);
  });
  it("component-local binding rejects swapped duration/repetition targets even if the set matches",()=>{
    const i=counts(2);i.windowDays=7;
    i.policy.measurements=structuredClone([MEASUREMENTS[0],MEASUREMENTS[1]]);
    i.policy.targets.normal.conditions=i.policy.measurements.map((m,j)=>({
      measurementId:m.measurementId,unitId:m.unit.unitId,valueType:j===0?"number":"integer",
      basis:{kind:"period",windowDays:7},periodAggregation:{sourceBasis:"per_event",method:"sum"},
      constraint:{operator:"gte",value:j===0?70:35}}));
    i.observations[0].observedAt="2026-01-08T12:00:00Z";
    i.observations[0].values={
      [i.policy.measurements[0].measurementId]:{unitId:"minute",valueType:"number",value:70},
      [i.policy.measurements[1].measurementId]:{unitId:"rep",valueType:"integer",value:35}};
    i.recipe=recipe(i.policy);
    const r=available(run(i));expect(r.score).toBe(100);expect(r.condition).toBe("Healthy");expect(r.overachievementPercent).toBe(100);
    const a=i.recipe.components[0],b=i.recipe.components[1];
    [a.targetCondition,b.targetCondition]=[b.targetCondition,a.targetCondition];
    unavailable(run(i),"component_target_incompatible");
  });
  it("policy end is validated before future separation, retaining raw evidence",()=>{
    const i=counts();i.coverage.policyEnd="2026-01-16T00:00:00Z";
    for(const observedAt of ["2026-01-16T00:00:00Z","2026-01-17T00:00:00Z"]){
      i.observations[0].observedAt=observedAt;
      const r=run(i);unavailable(r,"policy_boundary_unavailable");
      expect(r.evidence.rawObservations).toEqual(i.observations);
    }
    i.observations[0].observedAt="2026-01-15T23:59:59.999Z";
    const r=available(run(i));expect(r.evidence.future).toEqual(i.observations);
    expect(r.evidence.completed).toHaveLength(0);
  });
  it("finite individual weights cannot overflow their aggregate into a fake zero health",()=>{
    unavailable(run(numeric([0,0],[1,1],[Number.MAX_VALUE,Number.MAX_VALUE])),"arithmetic_unavailable");
    unavailable(run(numeric([1,1],[1,1],[1e307,1e307])),"arithmetic_unavailable");
  });
  it.each([50,70,90])("exact %s band with decimal weights remains in that band",percent=>{
    for(const weights of [[0.1,0.2,0.7],[0.1,0.2],[0.1+0.2,0.7]]){
      const r=available(run(numeric(weights.map(()=>percent),weights.map(()=>100),weights)));
      expect(r.score).toBeCloseTo(percent,12);
      expect(r.condition).toBe(percent===90?"Healthy":percent===70?"Needs Attention":"Warning");
      // Preserve the arithmetic result, not a rounded display value.
      const cs=r.evidence.components;
      expect(r.score).toBe(cs.reduce((s,c)=>s+c.cappedPercent*c.weight,0)/cs.reduce((s,c)=>s+c.weight,0));
    }
  });
  it("0.29 / 0.58 is a mandatory half, not a below-half shortfall",()=>{
    const r=available(run(numeric([0.29,1],[0.58,1],[1,1])));
    expect(r.score).toBeCloseTo(75,12);expect(r.condition).toBe("Needs Attention");
    expect(r.reasons).toEqual([]);
  });
  it("exact decimal comparisons do not promote even representable sub-display shortfalls",()=>{
    const r=available(run(numeric([89.99999999999999],[100],[1])));
    expect(r.condition).toBe("Needs Attention");
    const guarded=available(run(numeric([49.99999999999999,100],[100,100],[1,1])));
    expect(guarded.condition).toBe("Warning");expect(guarded.reasons).toHaveLength(1);
  });
  it("individual decimal quantities are accumulated exactly for threshold decisions",()=>{
    const i=numeric([0.1],[1.6],[1]);
    i.observations.push({...structuredClone(i.observations[0]),observationId:"second-decimal",
      values:{[i.policy.measurements[0].measurementId]:{unitId:"kilometre",valueType:"number",value:0.7}}});
    const r=available(run(i));expect(r.condition).toBe("Warning");expect(r.reasons).toEqual([]);
  });
  it.each([50,70,90])("real shortfall below %s is never erased",threshold=>{
    const r=available(run(numeric([threshold-0.0001],[100],[0.1+0.2])));
    expect(r.score).toBeLessThan(threshold);
    expect(r.condition).toBe(threshold===90?"Needs Attention":threshold===70?"Warning":"Critical");
    const guarded=available(run(numeric([49.9999,100],[100,100],[1,1])));
    expect(guarded.condition).toBe("Warning");expect(guarded.reasons).toHaveLength(1);
  });
  it.each([50,70] as const)("Meditation %s weekly, hand-computed sealed examples",weekly=>{
    for(const e of MEDITATION_EXAMPLES){
      const c=meditation(weekly),r=available(run(input(c,practices(c,e.days,e.minutes,e.perDay))));
      expect(r.evidence.components.map(c=>c.expected)).toEqual([weekly*2,10]);
      expect(r.score).toBeCloseTo(weekly===50?e.score50:e.score70,12);
      expect(r.condition).toBe(weekly===50?e.condition50:e.condition70);
      expect(r.evidence.provenance.policy.targets.normal).toEqual(c.targets.normal);
    }
  });
  it.each([["martial",105,15,5],["meditation",70,10,5],["fitness",90,15,5],["music",45,15,3]] as const)(
    "seed %s",(_,weekly,floor,days)=>{
      const c=meditation(70);c.domainId=`opaque-${_}`;
      if(c.qualification?.kind!=="condition"||c.qualification.condition.valueType==="boolean")throw Error("fixture");
      c.qualification.condition.constraint={operator:"gte",value:floor};
      c.targets.normal.conditions.forEach((t,j)=>{if(t.valueType!=="boolean")t.constraint={operator:"gte",value:j?days:weekly};});
      const r=available(run(input(c,practices(c,days*2,weekly/days))));
      expect(r.score).toBeCloseTo(100,12);expect(r.condition).toBe("Healthy");
      expect(r.evidence.components.map(c=>c.expected)).toEqual([weekly*2,days*2]);
    });
  it("one-component cupcake recipe needs no minutes or qualification",()=>{
    const r=available(run(counts()));expect(r.score).toBe(100);
    expect(r.evidence.components[0]).toMatchObject({unitId:"cupcake",actual:40,expected:40});
    expect(r).not.toHaveProperty("budget");
  });
  it("arbitrary repetitions and quantities use only their exact units",()=>{
    for(const definition of [MEASUREMENTS[1],MEASUREMENTS[3]]){
      const i=counts(),m=structuredClone(definition);
      i.policy.measurements=[m];i.policy.targets.normal.conditions=[{
        measurementId:m.measurementId,unitId:m.unit.unitId,
        valueType:m.valueType==="integer"?"integer":"number",basis:{kind:"period",windowDays:7},
        periodAggregation:{sourceBasis:"per_event",method:"sum"},constraint:{operator:"gte",value:20}}];
      i.observations[0].values={[m.measurementId]:{unitId:m.unit.unitId,
        valueType:m.valueType==="integer"?"integer":"number",value:30}};
      i.recipe=recipe(i.policy);
      const r=available(run(i));expect(r.score).toBe(75);
      expect(r.evidence.components[0].unitId).toBe(m.unit.unitId);
    }
  });
  it("three components: explicit weights, individual caps, uncapped minimum",()=>{
    const i=counts(3);i.recipe.components.forEach((p,j)=>p.weight=[1,2,1][j]);
    i.observations[0].values["opaque-count-0"].value=80;
    i.observations[0].values["opaque-count-1"].value=20;
    i.observations[0].values["opaque-count-2"].value=40;
    const r=available(run(i));expect(r.score).toBe(75);expect(r.overachievementPercent).toBe(50);
    expect(r.evidence.components.map(c=>c.uncappedPercent)).toEqual([200,50,100]);
  });
  it("zero mandatory guards condition, not numeric score or sustained state",()=>{
    const i=counts(3);i.observations[0].values["opaque-count-2"].value=0;
    i.recipe.components.forEach((p,j)=>p.weight=j===2?1:10);
    const r=available(run(i));expect(r.score).toBeCloseTo(2000/21,12);
    expect(r.condition).toBe("Critical");expect(r.reasons).toEqual(["mandatory_zero:opaque-count-2"]);
    expect(r.evidence.sustainedState).toBe("unavailable");
    i.recipe.components[2].mandatory=false;
    expect(available(run(i)).condition).toBe("Healthy");
  });
  it("mandatory 40% limits high weighted score to Warning",()=>{
    const i=counts(3);i.observations[0].values["opaque-count-2"].value=16;
    i.recipe.components.forEach((p,j)=>p.weight=j===2?1:10);
    const r=available(run(i));expect(r.score).toBeCloseTo(2040/21,12);expect(r.condition).toBe("Warning");
  });
  it.each([[90,"Healthy"],[89.9999,"Needs Attention"],[70,"Needs Attention"],[69.9999,"Warning"],[50,"Warning"],[49.9999,"Critical"]] as const)(
    "unrounded threshold %s", (percent,condition)=>{
      const i=input();i.policy.measurements=i.policy.measurements.slice(0,1);
      i.policy.targets.normal.conditions=i.policy.targets.normal.conditions.slice(0,1);
      i.observations=practices(i.policy,1,percent);i.recipe=recipe(i.policy);
      const r=available(run(i));expect(r.score).toBeCloseTo(percent,12);expect(r.condition).toBe(condition);
    });
  it("overachievement 112.5 retained with unavailable badge",()=>{
    const i=counts();i.observations[0].values["opaque-count-0"].value=45;
    const r=available(run(i));expect(r.score).toBe(100);expect(r.overachievementPercent).toBe(112.5);
    expect(r.evidence.overachievementBadge).toBe("unavailable");
  });
  it("two short events do not pool qualification; below-floor amounts still count",()=>{
    const c=meditation(),r=available(run(input(c,practices(c,5,5,2))));
    expect(r.evidence.components.map(c=>c.actual)).toEqual([50,0]);
    expect(r.score).toBe(25);expect(r.condition).toBe("Critical");
  });
  it("whole all/any predicates apply to each event; false is recorded, not missing",()=>{
    const c=meditation(),completion=structuredClone(MEASUREMENTS.find(m=>m.kind==="completion")!);
    c.measurements.push(completion);
    const numeric=c.qualification!;
    const boolean={kind:"condition" as const,condition:{measurementId:completion.measurementId,
      unitId:completion.unit.unitId,valueType:"boolean" as const,basis:{kind:"per_event" as const},constraint:{operator:"eq" as const,value:false}}};
    c.qualification={kind:"all",predicates:[numeric,boolean]};
    const obs=practices(c,1,10,2);
    obs[0].values[completion.measurementId]={unitId:completion.unit.unitId,valueType:"boolean",value:false};
    const r=available(run(input(c,obs)));expect(r.evidence.components[1].actual).toBe(1);
    expect(r.evidence.completed[0].values[completion.measurementId].value).toBe(false);
    delete obs[0].values[completion.measurementId];
    expect(available(run(input(c,obs))).evidence.components[1].actual).toBe(0);
    c.qualification={kind:"any",predicates:[numeric,boolean]};
    expect(available(run(input(c,obs))).evidence.components[1].actual).toBe(1);
  });
});
describe("coverage and completed civil days",()=>{
  it.each([
    ["2026-10-24T23:59:59.999Z","2026-10-24"],
    ["2026-10-25T00:00:00Z","2026-10-25"],
    ["2026-10-25T00:30:00Z","2026-10-25"],
    ["2026-10-25T01:00:00Z","2026-10-25"],
    ["2026-10-25T01:30:00Z","2026-10-25"],
    ["2026-10-25T02:00:00Z","2026-10-25"],
    ["2026-10-26T01:59:59.999Z","2026-10-25"],
    ["2026-10-26T02:00:00Z","2026-10-26"],
  ])("Troll fold logical interval at %s is %s",(now,day)=>{
    const boundary={timezone:"Antarctica/Troll",dayStartHour:2};
    expect(logicalDay(now,boundary)).toBe(day);
    const w=assembleWindow({now,windowDays:1,boundary,breaks:[],
      coverage:{start:"2025-01-01T00:00:00Z",end:"2027-01-01T00:00:00Z"}});
    expect(w.today).toBe(day);
    if(day==="2026-10-25")expect(w.end).toBe("2026-10-25T00:00:00.000Z");
    if(day==="2026-10-26"){
      expect(w.start).toBe("2026-10-25T00:00:00.000Z");
      expect(w.end).toBe("2026-10-26T02:00:00.000Z");
      expect(w.days[0].durationMs).toBe(26*3600000);
    }
  });
  it("bundled Troll fold crosses hour two; bucketing is monotonic at every minute",()=>{
    const boundary={timezone:"Antarctica/Troll",dayStartHour:2};
    const localHour=(at:string)=>new Intl.DateTimeFormat("en-GB",{timeZone:boundary.timezone,hour:"2-digit",hourCycle:"h23"}).format(new Date(at));
    expect(localHour("2026-10-25T00:30:00Z")).toBe("02");
    expect(localHour("2026-10-25T01:30:00Z")).toBe("01");
    for(let minute=0;minute<26*60;minute++){
      const at=new Date(Date.parse("2026-10-25T00:00:00Z")+minute*60000).toISOString();
      expect(logicalDay(at,boundary),at).toBe("2026-10-25");
    }
  });
  it("Troll practices stay Today across rollback, then count as one completed qualifying day",()=>{
    const c=meditation();c.boundary={timezone:"Antarctica/Troll",dayStartHour:2};
    const obs=practices(c,2,10);
    obs[0].observedAt="2026-10-25T00:30:00Z";obs[1].observedAt="2026-10-25T01:30:00Z";
    const i=input(c,obs);i.windowDays=1;
    i.now="2026-10-25T00:45:00Z";
    const before=available(run(i));expect(before.evidence.today).toHaveLength(1);expect(before.evidence.future).toHaveLength(1);
    i.now="2026-10-25T01:45:00Z";
    const after=available(run(i));expect(after.evidence.today).toHaveLength(2);expect(after.evidence.completed).toHaveLength(0);
    expect(after.evidence.window!.end).toBe(before.evidence.window!.end);
    i.now="2026-10-26T02:00:00Z";
    const closed=available(run(i));expect(closed.evidence.components.map(c=>c.actual)).toEqual([20,1]);
    expect(closed.evidence.components[1].qualifyingDays).toEqual(["2026-10-25"]);
  });
  it.each([
    ["2026-11-01T04:59:59.999Z",1,"2026-10-31","2026-10-31T05:00:00.000Z"],
    ["2026-11-01T05:00:00Z",1,"2026-11-01","2026-11-01T05:00:00.000Z"],
    ["2026-11-01T06:30:00Z",1,"2026-11-01","2026-11-01T05:00:00.000Z"],
    ["2026-03-08T06:59:59.999Z",2,"2026-03-07","2026-03-07T07:00:00.000Z"],
    ["2026-03-08T07:00:00Z",2,"2026-03-08","2026-03-08T07:00:00.000Z"],
    ["2026-03-08T07:30:00Z",2,"2026-03-08","2026-03-08T07:00:00.000Z"],
  ] as const)("NY repeated/skipped start instant %s",(now,dayStartHour,day,end)=>{
    const boundary={timezone:"America/New_York",dayStartHour};
    expect(logicalDay(now,boundary)).toBe(day);
    const w=assembleWindow({now,windowDays:1,boundary,breaks:[],
      coverage:{start:"2025-01-01T00:00:00Z",end:"2027-01-01T00:00:00Z"}});
    expect(w.today).toBe(day);expect(w.end).toBe(end);
  });
  it.each([7,10,14,28,30,42])("internal window %s",n=>{
    const i=counts();i.windowDays=n;
    const r=available(run(i));expect(r.evidence.window!.days).toHaveLength(n);
    expect(r.evidence.components[0].expected).toBe(20*n/7);
  });
  it("full practice credit during entirely exempt days whenever total E positive",()=>{
    const i=input();i.breaks=[{start:"2026-01-01T00:00:00Z",end:"2026-01-08T00:00:00Z"}];
    const r=available(run(i));expect(r.evidence.window!.eligibleDays).toBe(7);
    expect(r.evidence.components.map(c=>c.actual)).toEqual([100,10]);
    expect(r.evidence.components.map(c=>c.expected)).toEqual([50,5]);
    expect(r.overachievementPercent).toBe(200);
  });
  it.each([14,28,42])("E0 %s days retains actual work, no health or reset",windowDays=>{
    const i=input();i.windowDays=windowDays;
    i.breaks=[{start:"2025-11-01T00:00:00Z",end:"2026-02-01T00:00:00Z"}];
    const before=structuredClone(i),r=run(i);unavailable(r,"no_eligible_coverage");
    expect(r.evidence.completed).toHaveLength(10);expect(r.evidence.rawObservations).toEqual(i.observations);
    expect(r.evidence.continuity).toBe("preserved");expect(i).toEqual(before);
  });
  it.each([
    ["spring","2026-03-09T16:00:00Z","2026-03-08T05:00:00Z","2026-03-09T04:00:00Z",23],
    ["fall","2026-11-02T16:00:00Z","2026-11-01T04:00:00Z","2026-11-02T05:00:00Z",25],
  ] as const)("overlapping and clipped partial breaks on %s DST day",(_,now,start,end,hours)=>{
    const startMs=Date.parse(start),iso=(h:number)=>new Date(startMs+h*3600000).toISOString();
    const w=assembleWindow({now,windowDays:1,boundary:{timezone:"America/New_York",dayStartHour:0},
      coverage:{start:iso(1),end},breaks:[{start:iso(-3),end:iso(3)},{start:iso(2),end:iso(4)}]});
    expect(w.start).toBe(new Date(start).toISOString());expect(w.end).toBe(new Date(end).toISOString());
    expect(w.days[0].durationMs).toBe(hours*3600000);
    expect(w.days[0].coveredMs).toBe((hours-1)*3600000);
    expect(w.days[0].exemptMs).toBe(3*3600000);
    expect(w.eligibleDays).toBe((hours-4)/hours);
    const i=counts();i.now=now;i.windowDays=1;i.policy.boundary={timezone:"America/New_York",dayStartHour:0};
    i.coverage.onboardingAt=iso(1);i.breaks=[{start:iso(-3),end:iso(3)},{start:iso(2),end:iso(4)}];
    i.observations[0].observedAt=iso(2);i.recipe=recipe(i.policy);
    const r=available(run(i));expect(r.evidence.components[0].actual).toBe(40);
    expect(r.evidence.components[0].expected).toBeCloseTo(20*(hours-4)/hours/7,12);
  });
  it("onboarding clips coverage and excludes pre-onboarding work",()=>{
    const i=counts();i.coverage.onboardingAt="2026-01-01T12:00:00Z";
    i.observations.push({...structuredClone(i.observations[0]),observationId:"earlier",observedAt:"2026-01-01T11:59:59Z"});
    const r=available(run(i));expect(r.evidence.window!.eligibleDays).toBe(13.5);
    expect(r.evidence.components[0].actual).toBe(40);
    expect(r.evidence.excluded).toEqual([{observationId:"earlier",reason:"before_onboarding"}]);
  });
  it("half-open start/end, Today and future separated in non-UTC day-start",()=>{
    const i=counts();i.policy.boundary={timezone:"Asia/Kolkata",dayStartHour:4};i.windowDays=1;
    i.now="2026-01-15T02:00:00Z";
    const base=i.observations[0];
    i.observations=["2026-01-13T22:29:59.999Z","2026-01-13T22:30:00Z","2026-01-14T22:29:59.999Z",
      "2026-01-14T22:30:00Z",i.now,"2026-01-15T02:00:00.001Z"].map((observedAt,j)=>({...structuredClone(base),observationId:String(j),observedAt}));
    const r=available(run(i));expect(r.evidence.completed.map(o=>o.observationId)).toEqual(["1","2"]);
    expect(r.evidence.today.map(o=>o.observationId)).toEqual(["3","4"]);
    expect(r.evidence.future.map(o=>o.observationId)).toEqual(["5"]);
  });
  it.each(Array.from({length:24},(_,h)=>h))("day-start hour %s",dayStartHour=>{
    const w=assembleWindow({now:"2026-01-15T23:59:59Z",windowDays:1,boundary:{timezone:"UTC",dayStartHour},
      coverage:{start:"2025-01-01T00:00:00Z",end:"2027-01-01T00:00:00Z"},breaks:[]});
    expect(w.start).toBe(`2026-01-14T${String(dayStartHour).padStart(2,"0")}:00:00.000Z`);
    expect(w.eligibleDays).toBe(1);
  });
  it("repeated/gap start disambiguation is explicit",()=>{
    const base={windowDays:1,coverage:{start:"2025-01-01T00:00:00Z",end:"2027-01-01T00:00:00Z"},breaks:[]};
    const gap=assembleWindow({...base,now:"2026-03-09T16:00:00Z",boundary:{timezone:"America/New_York",dayStartHour:2}});
    expect(gap.start).toBe("2026-03-08T07:00:00.000Z");expect(gap.days[0].durationMs).toBe(23*3600000);
    const fold=assembleWindow({...base,now:"2026-11-02T16:00:00Z",boundary:{timezone:"America/New_York",dayStartHour:1}});
    expect(fold.start).toBe("2026-11-01T05:00:00.000Z");expect(fold.days[0].durationMs).toBe(25*3600000);
  });
});
describe("unavailable policy edges, provenance and isolation",()=>{
  it("per-event twenty cupcakes is never twenty per week",()=>{
    const i=counts(),t=i.policy.targets.normal.conditions[0];t.basis={kind:"per_event"};delete t.periodAggregation;
    i.recipe=recipe(i.policy);unavailable(run(i),"per_event_target_unavailable");
  });
  it.each(["lower_is_better","within_range","equal"] as const)("unsupported direction %s",direction=>{
    const i=counts();i.policy.measurements[0].comparisonDirection=direction;i.recipe=recipe(i.policy);
    unavailable(run(i),"direction_unavailable");
  });
  it("zero target and omitted active condition never produce Healthy",()=>{
    const i=counts();const t=i.policy.targets.normal.conditions[0];if(t.valueType!=="boolean")t.constraint={operator:"gte",value:0};
    i.recipe=recipe(i.policy);unavailable(run(i),"zero_target");
    const j=counts(3);j.recipe.components.pop();unavailable(run(j),"target_conditions_omitted");
    const k=counts();k.recipe.targetId="unknown";unavailable(run(k),"target_missing");
  });
  it.each(["context","outcome"] as const)("raw %s measurement retained but cannot participate",role=>{
    const i=counts();i.policy.measurements[0].role=role;i.recipe=recipe(i.policy);
    const r=run(i);unavailable(r,"measurement_role_unavailable");expect(r.evidence.rawObservations).toEqual(i.observations);
  });
  it("context, zero and optional omission remain raw without changing participation",()=>{
    const i=counts(),m=structuredClone(MEASUREMENTS[1]);m.role="context";i.policy.measurements.push(m);
    i.observations[0].values[m.measurementId]={unitId:m.unit.unitId,valueType:"integer",value:0};
    i.observations.push({...structuredClone(i.observations[0]),observationId:"missing",values:{}});
    const r=available(run(i));expect(r.score).toBe(100);
    expect(r.evidence.completed[0].values[m.measurementId].value).toBe(0);
    expect(r.evidence.components[0].missingObservationIds).toEqual(["missing"]);
  });
  it.each(["ownerUserId","organizationId","domainId","policyVersionId"] as const)("observation %s isolation",key=>{
    const i=counts();i.observations[0][key]="foreign";unavailable(run(i),"observation_context_mismatch");
    const j=counts();j.recipe[key]="foreign";unavailable(run(j),"recipe_identity_mismatch");
  });
  it("unit/type/task variant and duplicate record identities rejected",()=>{
    for(const mode of ["unit","type","variant","duplicate"]){
      const i=counts(),v=i.observations[0].values["opaque-count-0"];
      if(mode==="unit")v.unitId="minute";
      if(mode==="type")v.valueType="number";
      if(mode==="variant")v.taskVariantId="other";
      if(mode==="duplicate")i.observations.push(structuredClone(i.observations[0]));
      unavailable(run(i),"observation_context_mismatch");
    }
  });
  it("registry is exact, versioned and detached; approved=true is not authority",()=>{
    const i=counts(),e=createEvaluator([i.recipe]);
    i.recipe.version="2";unavailable(e(i),"recipe_unapproved");
    const j=counts();(j.recipe as EvaluationRecipe & {approved:boolean}).approved=true;
    unavailable(run(j),"recipe_unapproved");unavailable(createEvaluator([])(counts()),"recipe_unapproved");
    const k=counts(),e2=createEvaluator([k.recipe]);k.recipe.components[0].weight=5;
    unavailable(e2(k),"recipe_unapproved");
  });
  it("recipe directions, exact target values and measurement semantics must match policy",()=>{
    const i=counts();i.recipe.components[0].measurement.unit.unitId="other";
    unavailable(run(i),"measurement_binding_mismatch");
    const j=counts();const t=j.recipe.components[0].targetCondition;
    if(t.valueType!=="boolean")t.constraint={operator:"gte",value:1};
    unavailable(run(j),"target_conditions_omitted");
    const k=counts();k.recipe.components[0].weight=0;unavailable(run(k),"recipe_unapproved");
    const l=counts();
    (l.recipe.components[0] as unknown as {percentage:string}).percentage="borrowed-duration";
    unavailable(run(l),"recipe_unapproved");
    const malformed=counts();
    (malformed.recipe.components[0] as unknown as {measurement:null}).measurement=null;
    unavailable(run(malformed),"recipe_unapproved");
  });
  it("invalid windows, timestamps, coverage and exceptions cannot generate health",()=>{
    for(const mutate of [
      (i:EvaluationInput)=>{i.windowDays=0;},
      (i:EvaluationInput)=>{i.windowDays=1.5;},
      (i:EvaluationInput)=>{i.now="2026-02-30T00:00:00Z";},
      (i:EvaluationInput)=>{i.now="2026-01-15T00:00:00";},
      (i:EvaluationInput)=>{i.breaks=[{start:"2026-01-02T00:00:00Z",end:"2026-01-01T00:00:00Z"}];},
    ]){
      const i=counts();mutate(i);unavailable(run(i),"window_assembly_unavailable");
    }
    const j=counts();j.coverage.policyStart="2026-01-01T00:00:00Z";
    unavailable(run(j),"policy_coverage_mismatch");
    const k=counts();k.policy.boundary.timezone="Not/A_Zone";unavailable(run(k),"invalid_policy");
    const l=counts();l.policy.boundary.dayStartHour=24;unavailable(run(l),"invalid_policy");
  });
  it("arithmetic overflow explicitly unavailable",()=>{
    const i=counts(),m=i.policy.measurements[0];
    if(m.kind==="count"){m.kind="repetitions";} // still typed integer count, not duration
    i.observations[0].values["opaque-count-0"].value=Number.MAX_VALUE;
    i.recipe=recipe(i.policy);unavailable(run(i),"arithmetic_unavailable");
  });
  it("adapted target review date does not expire, lower qualification or change reference",()=>{
    const c=meditation(),target=structuredClone(c.targets.normal);target.targetId="adapted";
    const t=target.conditions[0];if(t.valueType!=="boolean")t.constraint={operator:"gte",value:25};
    c.targets.adapted={target,effectiveFrom:"2025-12-01T00:00:00Z",duration:"temporary",reviewAt:"2025-12-08T00:00:00Z"};
    c.references=[{referenceId:"minimum",purpose:"develop",status:"known",
      applicability:{description:"synthetic"},evidence:{category:"personal",confidence:"unknown",review:{status:"unreviewed"}},
      conditions:[{measurementId:c.measurements[0].measurementId,unitId:"minute",valueType:"number",
        basis:{kind:"per_event"},constraint:{operator:"gte",value:100}}]}];
    const i=input(c,practices(c,5,5,2)),before=structuredClone(i),r=available(run(i));
    expect(r.evidence.components.map(c=>c.expected)).toEqual([50,10]);
    expect(r.evidence.components.map(c=>c.actual)).toEqual([50,0]);expect(r.score).toBe(50);
    expect(r.condition).toBe("Critical");expect(i).toEqual(before);
    i.recipe.qualification=null;unavailable(run(i),"qualification_binding_mismatch");
  });
  it("mid-window adaptation and unknown historical policy assembly unavailable",()=>{
    const i=input();i.policy.targets.adapted={target:{...structuredClone(i.policy.targets.normal),targetId:"adapted"},
      effectiveFrom:"2026-01-08T00:00:00Z",duration:"ongoing"};i.recipe=recipe(i.policy);
    unavailable(run(i),"adaptation_boundary_unavailable");
    const j=counts();j.policy.effectiveFrom="2026-01-08T00:00:00Z";j.coverage.policyStart=j.policy.effectiveFrom;
    j.observations=[];unavailable(run(j),"policy_boundary_unavailable");
    j.coverage.onboardingAt=j.policy.effectiveFrom;
    expect(available(run(j)).evidence.window!.eligibleDays).toBe(7);
  });
  it("normal cannot silently override adaptation; extra targets and period qualification unavailable",()=>{
    const i=input();i.policy.targets.adapted={target:{...structuredClone(i.policy.targets.normal),targetId:"adapted"},
      effectiveFrom:"2025-12-01T00:00:00Z",duration:"ongoing"};
    unavailable(run(i),"adaptation_selection_unavailable");
    const j=input();j.policy.targets.stretch={...structuredClone(j.policy.targets.normal),targetId:"stretch"};
    unavailable(run(j),"extra_target_conditions_unavailable");
    const k=input();k.policy.qualification={kind:"condition",condition:structuredClone(k.policy.targets.normal.conditions[0])};
    k.recipe=recipe(k.policy);unavailable(run(k),"qualification_unavailable");
  });
  it("immutable inputs, detached outputs and repeatable evaluations",()=>{
    const i=counts(),before=structuredClone(i),e=createEvaluator([i.recipe]);
    function freeze(x:unknown){if(x&&typeof x==="object"){Object.freeze(x);Object.values(x).forEach(freeze);}}
    freeze(i);const a=e(i),b=e(i);expect(a).toEqual(b);expect(i).toEqual(before);
    a.evidence.rawObservations[0].values["opaque-count-0"].value=0;
    a.evidence.provenance.policy.displayName="changed output";
    expect(i).toEqual(before);expect(e(i)).toEqual(b);
  });
  it("runtime source does not import the isolated evaluator",()=>{
    function walk(dir:string){for(const e of fs.readdirSync(dir,{withFileTypes:true})){
      const p=`${dir}/${e.name}`;if(e.isDirectory())walk(p);
      else if(/\.[cm]?[jt]sx?$/.test(p)&&!p.includes(".test."))
        expect(fs.readFileSync(p,"utf8"),p).not.toMatch(/(?:from\s*|import\s*\()["'][^"']*(?:pure-evaluator|evaluator-recipe|evaluator-window)/);
    }}
    ["server","client","script"].forEach(walk);
  });
});
