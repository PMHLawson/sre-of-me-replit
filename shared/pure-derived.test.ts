import {describe,it,expect} from "vitest";
import {createEvaluator,type EvaluationResult} from "./pure-evaluator";
import {createDeriver,attention,migrateLegacyPersistence,type PreparedHistory,type PreparedBlock} from "./pure-derived";
import {scopeOf,STATES,CONDITIONS,conditionRanks,persistenceRanks,validProfile,same,ASSEMBLY,type PersistenceProfile,type Comparability} from "./derived-profile";
import {decimal,sub,exact,approximate,rational} from "./derived-exact";
import type {EvaluationInput,EvaluationRecipe} from "./evaluator-recipe";
import type {DomainConfiguration,Observation} from "./domain-config";
import {meditation,practices} from "./fixtures/step9-examples";
import {MEASUREMENTS} from "./fixtures/domain-config-cases";
import {shiftDay} from "./evaluator-window";

// Every registration below is a fixture capability, never approval for an owner.
function recipe(c:DomainConfiguration):EvaluationRecipe {
  const target=c.targets.adapted?.target??c.targets.normal;
  return {recipeId:"fixture-derived",version:"1",organizationId:c.organizationId,ownerUserId:c.ownerUserId,
    domainId:c.domainId,policyVersionId:c.policyVersionId,targetId:target.targetId,
    targetSelection:c.targets.adapted?"adapted":"normal",qualification:c.qualification??null,
    components:target.conditions.map(t=>({measurement:structuredClone(c.measurements.find(m=>m.measurementId===t.measurementId)!),
      targetCondition:structuredClone(t),weight:1,mandatory:true,percentage:"positive-linear-ratio-v1",
      actual:t.measurementId==="qualifying-days"?"distinct-qualifying-days":"sum-events"}))};
}
function input(c:DomainConfiguration,obs:Observation[],end="2026-01-15",days=7):EvaluationInput {
  return {now:end+"T12:00:00Z",windowDays:days,policy:c,recipe:recipe(c),observations:obs,breaks:[],
    coverage:{onboardingAt:"2025-01-01T00:00:00Z",policyStart:c.effectiveFrom,policyEnd:"2027-01-01T00:00:00Z"}};
}
function numeric(values:number[],end="2026-01-15",targets=values.map(()=>100),weights=values.map(()=>1),days=7) {
  const c=meditation(70);delete c.qualification;
  c.measurements=values.map((_,j)=>({...structuredClone(MEASUREMENTS[3]),measurementId:`opaque-${j}`}));
  c.targets.normal.conditions=c.measurements.map((m,j)=>({measurementId:m.measurementId,unitId:m.unit.unitId,
    valueType:"number",basis:{kind:"period",windowDays:7},periodAggregation:{sourceBasis:"per_event",method:"sum"},
    constraint:{operator:"gte",value:targets[j]}}));
  const o:Observation={...practices(c,1,1)[0],observationId:`event-${end}`,observedAt:shiftDay(end,-days)+"T12:00:00Z",
    values:Object.fromEntries(c.measurements.map((m,j)=>[m.measurementId,{unitId:m.unit.unitId,valueType:"number",value:values[j]}]))};
  const i=input(c,[o],end,days);i.recipe.components.forEach((p,j)=>p.weight=weights[j]);return i;
}
function run(i:EvaluationInput){return createEvaluator([i.recipe])(i);}
function available<T extends {status:string}>(r:T):Extract<T,{status:"available"}> {
  expect(r.status,JSON.stringify(r)).toBe("available");
  if(r.status!=="available")throw Error(JSON.stringify(r));
  return r as Extract<T,{status:"available"}>;
}
function unavailable(r:{status:string;reason?:string},reason?:string) {
  expect(r.status).toBe("unavailable");if(reason)expect(r.reason).toBe(reason);
}
function deriver(inputs:EvaluationInput[],profiles:PersistenceProfile[]=[],comparability:Comparability[]=[]){
  return createDeriver({recipes:inputs.map(i=>i.recipe),profiles,comparability});
}
function profile(i:EvaluationInput,critical=4):PersistenceProfile {
  return {profileId:"fixture-only-persistence",version:`critical-${critical}`,scope:scopeOf(i),
    effective:{start:"2025-01-01T00:00:00Z",end:"2027-01-01T00:00:00Z"},
    approval:{sourceId:"synthetic-not-owner-consent",sourceRevision:"1",reviewId:"fixture-review",kind:"fixture-only"},
    assembly:{id:"fixture-prepared-blocks",version:"1",method:ASSEMBLY,activeDays:7},
    states:STATES.map((state,rank)=>({state,rank})),
    selectors:{acceptable:["Healthy"],subAcceptable:["NeedsAttention","Warning","Critical"],severe:["Critical"]},
    promotions:[
      {ruleId:"bad-one",state:"Advisory",selector:"subAcceptable",blocks:1,priority:1},
      {ruleId:"bad-two",state:"Warning",selector:"subAcceptable",blocks:2,priority:2},
      {ruleId:"bad-three",state:"Breach",selector:"subAcceptable",blocks:3,priority:3},
      {ruleId:"severe-two",state:"Breach",selector:"severe",blocks:2,priority:4},
      {ruleId:"fixture-critical",state:"Critical",selector:"subAcceptable",blocks:critical,priority:5}],
    recovery:{ruleId:"green-one",selector:"acceptable",blocks:1,state:"Nominal"},
    initial:{kind:"known-nominal",at:"2026-01-01T00:00:00Z",sourceId:"fixture-origin"},
    tiePolicy:"retain-both"};
}
function block(i:EvaluationInput,p:PersistenceProfile,kind:PreparedBlock["preparation"]["kind"]="active"):PreparedBlock {
  const result=run(i),w=result.evidence.window!;
  return {result,preparation:{assemblyId:p.assembly.id,assemblyVersion:p.assembly.version,sourceId:`prepared-${w.start}`,
    from:w.start,through:w.end,activeDays:kind==="exempt"?0:kind==="pending"?w.eligibleDays:7,kind}};
}
function history(inputs:EvaluationInput[],p:PersistenceProfile,kinds:PreparedBlock["preparation"]["kind"][]=[]):PreparedHistory {
  return {origin:structuredClone(p.initial),completeThrough:inputs.length?run(inputs.at(-1)!).evidence.window!.end:p.initial.at,
    blocks:inputs.map((i,j)=>block(i,p,kinds[j]??"active"))};
}
function series(scores:number[]) {return scores.map((score,j)=>numeric([score],shiftDay("2026-01-01",7*(j+1))));}

describe("immutable canonical policy exports",()=>{
  it("whole-result equality rejects sparse length alterations and nonfinite primitives",()=>{
    expect(same([],new Array(1))).toBe(false);
    expect(same([1],Object.assign(new Array(2),{0:1}))).toBe(false);
    for(const n of [NaN,Infinity,-Infinity])expect(same(n,n)).toBe(false);
    expect(same({nested:NaN},{nested:NaN})).toBe(false);
    const i=numeric([100]),r=available(run(i));
    r.reasons.length=1;
    unavailable(deriver([i]).current(r),"result_provenance_mismatch");
  });
  it.each(["current","later","earlier","exempt"] as const)("rejects omitted known older practice from %s snapshot",source=>{
    const ins=series([80,80,80]),extra=structuredClone(ins[0].observations[0]);
    extra.observationId="older-extra";extra.values["opaque-0"].value=20;
    const complete=structuredClone(ins);complete[0].observations.push(extra);
    const p=profile(ins[2]);
    const current=structuredClone(ins[2]);
    const hInputs=structuredClone(ins);
    if(source==="current")current.observations.push(extra);
    else if(source==="earlier"){
      // First snapshot knows a practice omitted by the second, proving symmetric checking.
      extra.observedAt=ins[1].observations[0].observedAt;
      hInputs[0].observations.push(extra);
    }else hInputs[2].observations.push(extra);
    if(source==="exempt"){
      const w=run(ins[0]).evidence.window!;
      hInputs[0].breaks=[{start:w.start,end:w.end}];
    }
    const h=history(hInputs,p,source==="exempt"?["exempt","active","active"]:[]);
    unavailable(deriver([...hInputs,current],[p]).persistence(run(current),p,h),"conflicting_observation_provenance");
    if(source==="current"||source==="later"){
      expect(available(run(complete[0])).condition).toBe("Healthy");
      const good=history(complete,p);
      expect(available(deriver([...complete,current],[p]).persistence(run(current),p,good)).state).toBe("Warning");
    }
    if(source==="exempt"){
      hInputs[0].observations.push(extra);
      const good=history(hInputs,p,["exempt","active","active"]);
      expect(available(deriver([...hInputs,current],[p]).persistence(run(current),p,good)).state).toBe("Warning");
    }
  });
  it("exposes readonly TypeScript collections and rank maps",()=>{
    // Checked by strict test typing, deliberately never executed as runtime assignments.
    const compileOnly=()=>{
      // @ts-expect-error canonical ranks cannot be assigned
      conditionRanks.Critical=0;
      // @ts-expect-error canonical ranks cannot be assigned
      persistenceRanks.Critical=0;
      // @ts-expect-error canonical condition tuple cannot be assigned
      CONDITIONS[3]="Critical";
      // @ts-expect-error canonical state tuple cannot be assigned
      STATES[4]="Critical";
      // @ts-expect-error canonical collections cannot grow
      CONDITIONS.push("Healthy");
      // @ts-expect-error canonical collections cannot shrink
      STATES.pop();
    };
    expect(typeof compileOnly).toBe("function");
  });
  it.each([
    ["condition ranks",conditionRanks,"Critical",0],
    ["persistence ranks",persistenceRanks,"Critical",0],
    ["conditions",CONDITIONS,"3","Healthy"],
    ["states",STATES,"4","Nominal"],
  ] as const)("%s rejects writes, deletion, extension and redefinition",(_name,value,key,replacement)=>{
    const before=structuredClone(value);
    try {
      expect(Reflect.set(value,key,replacement)).toBe(false);
      expect(Reflect.deleteProperty(value,key)).toBe(false);
      expect(Reflect.defineProperty(value,key,{value:replacement})).toBe(false);
      expect(Reflect.set(value,"injected",0)).toBe(false);
      expect(Object.isFrozen(value)).toBe(true);
      expect(value).toEqual(before);
    } finally {
      // Restore vulnerable pre-fix exports so failing regression runs cannot poison other tests.
      if(!Object.isFrozen(value)){
        Object.assign(value,before);Reflect.deleteProperty(value,"injected");
      }
    }
  });
  it("attempted Critical demotion cannot change attention, profile validation or promotion",()=>{
    const oldCondition=conditionRanks.Critical,oldPersistence=persistenceRanks.Critical;
    try {
      Reflect.set(conditionRanks,"Critical",0);Reflect.set(persistenceRanks,"Critical",0);
      expect(available(attention("Critical","Nominal")).rank).toBe(4);
      expect(available(attention("Healthy","Critical")).rank).toBe(4);
      expect(available(attention("Critical","Critical")).origins).toEqual(["condition","persistence"]);
      const ins=series([80,80,80,80]),i=ins[3],p=profile(i);
      expect(validProfile(p)).toBe(true);
      const invalid=structuredClone(p);invalid.states[4].rank=0;
      expect(validProfile(invalid)).toBe(false);
      const r=available(deriver(ins,[p]).persistence(run(i),p,history(ins,p)));
      expect(r.state).toBe("Critical");expect(r.rank).toBe(4);
      expect(r.trigger?.ruleId).toBe("fixture-critical");
      unavailable(deriver(ins,[invalid]).persistence(run(i),invalid,history(ins,invalid)));
    } finally {
      Reflect.set(conditionRanks,"Critical",oldCondition);Reflect.set(persistenceRanks,"Critical",oldPersistence);
    }
  });
});

describe("authoritative current condition and attention",()=>{
  const cr=[0,1,2,4],pr=[0,1,2,3,4];
  for(const [ci,c] of CONDITIONS.entries())for(const [pi,p] of STATES.entries()){
    it(`${c}/${p} takes maximum and retains all tied origins`,()=>{
      const a=available(attention(c,p)),rank=Math.max(cr[ci],pr[pi]);
      expect(a.rank).toBe(rank);
      expect(a.origins).toEqual([...(cr[ci]===rank?["condition"]:[]),...(pr[pi]===rank?["persistence"]:[])]);
    });
  }
  it("exact 90 keeps Healthy even when Number health is below 90",()=>{
    // Hand math: (90*.1 + 90*.2)/(.1+.2) = 90 exactly.
    // Number denominator is 0.30000000000000004, giving 89.99999999999999.
    const i=numeric([90,90],"2026-01-15",[100,100],[0.1,0.2]),r=available(run(i));
    expect(r.score).toBeLessThan(90);
    const c=available(deriver([i]).current(r));
    expect(c.condition).toBe("Healthy");expect(c.authoritativeCondition).toBe("Healthy");
  });
  it("exact mandatory half is not below half, and positive underflow is not zero",()=>{
    const i=numeric([0.29,1],"2026-01-15",[0.58,1]),r=available(run(i));
    const c=available(deriver([i]).current(r));expect(c.condition).toBe("NeedsAttention");expect(c.reasons).toEqual([]);
    const u=numeric([Number.MIN_VALUE,1],"2026-01-15",[1e300,1]),ur=available(run(u));
    expect(ur.evidence.components[0].uncappedPercent).toBe(0);
    const uc=available(deriver([u]).current(ur));
    expect(uc.condition).toBe("Warning");expect(uc.reasons).toEqual(["mandatory_below_50:opaque-0"]);
    expect(uc.label).toContain("mandatory_below_50:opaque-0");
  });
  it.each([49.9999,50,69.9999,70,89.9999,90])("preserves exact band %s",score=>{
    const i=numeric([score]),r=available(run(i)),c=available(deriver([i]).current(r));
    expect(c.authoritativeCondition).toBe(r.condition);expect(c.reasons).toEqual(r.reasons);
  });
  it("zero stays instantaneous Critical, not sustained Critical",()=>{
    const i=numeric([0]),d=deriver([i]),s=d.status(run(i));
    expect(available(s.condition).condition).toBe("Critical");unavailable(s.persistence);unavailable(s.attention);
  });
  it("PAGE exists only in explicit migration output, never fresh state",()=>{
    expect(migrateLegacyPersistence("PAGE")).toEqual({status:"available",state:"Critical",rank:4,origin:"legacy-migration",legacyValue:"PAGE"});
    unavailable(migrateLegacyPersistence("CRITICAL"));
  });
  it("rejects unregistered recipes and mutated complete results",()=>{
    const i=numeric([90]),r=available(run(i));
    unavailable(createDeriver({recipes:[],profiles:[]}).current(r));
    for(const edit of [
      (x:typeof r)=>{x.score=100;},(x:typeof r)=>{x.condition="Warning";},
      (x:typeof r)=>{x.reasons=["invented"];},(x:typeof r)=>{x.evidence.rawObservations=[];},
      (x:typeof r)=>{x.evidence.components[0].actual=100;},
      (x:typeof r)=>{x.evidence.provenance.observations[0].values["opaque-0"].value=100;},
      (x:typeof r)=>{x.evidence.window!.days[0].eligible=0.5;},
      (x:typeof r)=>{x.evidence.provenance.recipe.version="unregistered";}]){
      const v=structuredClone(r);edit(v);unavailable(deriver([i]).current(v));
    }
  });
});
describe("exact compatible trend from individual decimals and daily coverage",()=>{
  it.each([
    [[90,70],"Stable",0,[10,-10]],
    [[84,70],"Declining",-3,[4,-10]],
  ] as const)("independent offsetting 80/80 to %s", (next,direction,delta,movements)=>{
    const a=numeric([80,80],"2026-01-08"),b=numeric([...next]),t=available(deriver([a,b]).trend(run(a),run(b)));
    expect(t.direction).toBe(direction);expect(t.delta.approximate).toBe(delta);
    expect(t.components.map(c=>c.changes.capped.approximate)).toEqual(movements);
    expect(t.components.map(c=>c.changes.weightedContribution.approximate)).toEqual(movements.map(v=>v/2));
    expect(t.components[0].measurement.unit.unitId).toBe("kilometre");
    expect(t.components[0].target.basis).toEqual({kind:"period",windowDays:7});
  });
  function med(end:string,pattern:"80"|"82"|"82.0001") {
    const c=meditation(70),start=shiftDay(end,-14),n=pattern==="80"?8:9;
    const obs=practices(c,n,14).map((o,j)=>({...o,observationId:`${end}-${j}`,
      observedAt:shiftDay(start,j)+"T12:00:00Z",
      values:{[c.measurements[0].measurementId]:{unitId:"minute",valueType:"number" as const,
        value:pattern==="80"?14:j<8?11.2:pattern==="82"?14:14.00028}}}));
    return input(c,obs,end,14);
  }
  it.each([
    ["80","82","Stable",2,"2","1"],
    ["82","80","Stable",-2,"-2","1"],
    ["80","82.0001","Improving",2.0001,"20001","10000"],
    ["82.0001","80","Declining",-2.0001,"-20001","10000"],
  ] as const)("Meditation70 %s to %s exact boundary", (from,to,direction,delta,n,d)=>{
    const a=med("2026-01-15",from),b=med("2026-01-29",to);
    const t=available(deriver([a,b]).trend(run(a),run(b)));
    expect(t.direction).toBe(direction);expect(t.delta).toEqual({numerator:n,denominator:d,approximate:delta});
    const eighty=from==="80"?t.previous:t.current;
    expect(available(eighty).evidence.components.map(c=>c.actual)).toEqual([112,8]);
    expect(t.components[0].measurement.valueType).toBe("number");
    expect(t.components[0].target).toMatchObject({constraint:{value:70}});
  });
  it.each([1,3])("arbitrary %s-component count recipes retain units and all drivers",n=>{
    function counts(end:string,value:number){
      const i=numeric(Array(n).fill(value),end);
      i.policy.measurements=i.policy.measurements.map(m=>({...structuredClone(MEASUREMENTS[2]),measurementId:m.measurementId}));
      i.policy.targets.normal.conditions=i.policy.measurements.map(m=>({measurementId:m.measurementId,unitId:m.unit.unitId,
        valueType:"integer",basis:{kind:"period",windowDays:7},periodAggregation:{sourceBasis:"per_event",method:"sum"},
        constraint:{operator:"gte",value:100}}));
      i.observations[0].values=Object.fromEntries(i.policy.measurements.map(m=>[m.measurementId,
        {unitId:"cupcake",valueType:"integer",value}]));
      i.recipe=recipe(i.policy);return i;
    }
    const a=counts("2026-01-08",80),b=counts("2026-01-15",85),t=available(deriver([a,b]).trend(run(a),run(b)));
    expect(t.direction).toBe("Improving");expect(t.delta.approximate).toBe(5);expect(t.components).toHaveLength(n);
    expect(t.components.every(c=>c.measurement.unit.unitId==="cupcake")).toBe(true);
    expect(t.components.every(c=>c.current.actual.approximate===85)).toBe(true);
  });
  it("uncapped movement is visible even when health caps hide it",()=>{
    const a=numeric([120],"2026-01-08"),b=numeric([140]),t=available(deriver([a,b]).trend(run(a),run(b)));
    expect(t.direction).toBe("Stable");expect(t.components[0].changes.capped.approximate).toBe(0);
    expect(t.components[0].changes.uncapped.approximate).toBe(20);
  });
  it.each(["2026-03-08","2026-11-01"])("DST adjacent days may differ in milliseconds and break coverage: %s",day=>{
    const next=shiftDay(day,1);
    const a=numeric([10],day,[70],[1],1),b=numeric([10],next,[70],[1],1);
    for(const i of [a,b]){
      i.policy.boundary={timezone:"America/New_York",dayStartHour:0};
      i.now=i.now.slice(0,10)+"T18:00:00Z";
      i.observations[0].observedAt=shiftDay(i.now.slice(0,10),-1)+"T18:00:00Z";
      i.recipe=recipe(i.policy);
    }
    const w=run(b).evidence.window!,start=Date.parse(w.start),duration=Date.parse(w.end)-start;
    b.breaks=[{start:new Date(start).toISOString(),end:new Date(start+3600000).toISOString()}];
    // prior quantity=100%; current expectation reduced => quantity>100%; both capped100.
    const t=available(deriver([a,b]).trend(run(a),run(b)));
    expect(duration/3600000).toBe(day.includes("03-")?23:25);
    expect(t.direction).toBe("Stable");
    expect(t.components[0].changes.uncapped.approximate).toBeCloseTo(100/(duration/3600000-1),10);
    expect(t.currentExactHealth.approximate).toBe(100);
  });
  it("integer daily fractions, not rounded eligible aggregate, determine exact trend",()=>{
    const a=numeric([2],"2026-01-08",[7],[1],2),b=numeric([2],"2026-01-10",[7],[1],2);
    // Each of two ordinary days has one third exempt; E=4/3 exactly, actual2 => capped100.
    for(const i of [a,b]){
      const w=run(i).evidence.window!;
      i.breaks=w.days.map(d=>({start:d.start,end:new Date(Date.parse(d.start)+28800000).toISOString()}));
    }
    const t=available(deriver([a,b]).trend(run(a),run(b)));expect(t.delta.numerator).toBe("0");
    expect(t.components[0].current.expected).toMatchObject({numerator:"4",denominator:"3"});
    expect(t.components[0].current.uncapped).toMatchObject({numerator:"150",denominator:"1"});
  });
  it("incompatible scope or missing provenance is unavailable and retains both results",()=>{
    const a=numeric([80],"2026-01-08");
    const mutations:((i:EvaluationInput)=>void)[]=[
      i=>{i.policy.ownerUserId="different";i.observations[0].ownerUserId="different";},
      i=>{i.policy.organizationId="different";i.observations[0].organizationId="different";},
      i=>{i.policy.domainId="different";i.observations[0].domainId="different";},
      i=>{i.policy.targets.normal.targetId="other-target";},
      i=>{i.policy.measurements[0].unit.unitId="mile";i.policy.targets.normal.conditions[0].unitId="mile";i.observations[0].values["opaque-0"].unitId="mile";},
      i=>{i.policy.boundary.dayStartHour=1;},
      i=>{i.coverage.onboardingAt="2025-02-01T00:00:00Z";},
      i=>{i.policy.targets.normal.conditions[0].basis={kind:"period",windowDays:14};},
    ];
    for(const mutate of mutations){
      const b=numeric([80]);mutate(b);b.recipe=recipe(b.policy);
      const ra=run(a),rb=run(b),t=deriver([a,b]).trend(ra,rb);
      unavailable(t);expect(t.previous).toEqual(ra);expect(t.current).toEqual(rb);
    }
    const b=numeric([80]),rb=run(b);delete (rb.evidence as Partial<typeof rb.evidence>).provenance;
    unavailable(deriver([a,b]).trend(run(a),rb));
  });
  it("rejects mismatched weights, roles, types, qualification and variants even if recipes are registered",()=>{
    const a=numeric([80,80],"2026-01-08");
    const b=numeric([80,80]);b.recipe.components[0].weight=2;
    unavailable(deriver([a,b]).trend(run(a),run(b)),"comparability_strategy_unapproved");
    b.recipe.components[0].weight=1;b.recipe.components[0].mandatory=false;
    unavailable(deriver([a,b]).trend(run(a),run(b)));
    for(const key of ["role","valueType","taskVariantId"]){
      const v=structuredClone(run(a)) as EvaluationResult;
      (v.evidence.provenance.policy.measurements[0] as unknown as Record<string,unknown>)[key]="tampered";
      unavailable(deriver([a]).trend(v,run(b)));
    }
    const v=structuredClone(run(a));v.evidence.provenance.policy.qualification={kind:"condition",
      condition:{measurementId:"opaque-0",unitId:"km",valueType:"number",basis:{kind:"per_event"},constraint:{operator:"gte",value:1}}};
    unavailable(deriver([a]).current(v));
  });
  it("registered version transition retains both originals; flags and arbitrary conversions are insufficient",()=>{
    const a=numeric([80],"2026-01-08"),b=numeric([85]);
    a.coverage.policyEnd="2026-01-08T00:00:00Z";
    a.now="2026-01-08T00:00:00Z";
    b.policy.previousVersionId=a.policy.policyVersionId;b.policy.policyVersionId="next-policy";
    b.policy.revision++;b.policy.effectiveFrom="2026-01-08T00:00:00Z";
    b.coverage.policyStart=b.policy.effectiveFrom;b.observations[0].policyVersionId=b.policy.policyVersionId;b.recipe=recipe(b.policy);
    const s:Comparability={strategyId:"fixture-version-transition",version:"1",from:scopeOf(a),to:scopeOf(b),
      effective:{start:"2026-01-01T00:00:00Z",end:"2026-01-15T00:00:00Z"},
      approval:profile(a).approval,method:"same-semantics-version-transition-v1"};
    unavailable(deriver([a,b]).trend(run(a),run(b),s));
    const t=available(deriver([a,b],[],[s]).trend(run(a),run(b),s));
    expect(t.direction).toBe("Improving");expect(t.previous).toEqual(run(a));expect(t.current).toEqual(run(b));
    b.policy.targets.normal.targetId="new-target";b.recipe=recipe(b.policy);s.to=scopeOf(b);
    unavailable(deriver([a,b],[],[s]).trend(run(a),run(b),s),"comparison_scope_incompatible");
  });
  it("nonadjacent, unequal logical windows and wholly exempt windows never fabricate trend",()=>{
    const a=numeric([80],"2026-01-08"),b=numeric([80],"2026-01-16");
    unavailable(deriver([a,b]).trend(run(a),run(b)));
    b.now="2026-01-15T12:00:00Z";b.windowDays=6;
    unavailable(deriver([a,b]).trend(run(a),run(b)));
    b.windowDays=7;const w=run(b).evidence.window!;b.breaks=[{start:w.start,end:w.end}];
    const r=run(b);expect(r.evidence.rawObservations).toHaveLength(1);
    unavailable(deriver([a,b]).trend(run(a),r));
  });
  it("same-scope strategy claims and inconsistent policy intervals are rejected",()=>{
    const a=numeric([80],"2026-01-08"),b=numeric([85]);
    const strategy:Comparability={strategyId:"not-approved",version:"1",from:scopeOf(a),to:scopeOf(b),
      effective:{start:"2026-01-01T00:00:00Z",end:"2026-01-15T00:00:00Z"},
      approval:profile(a).approval,method:"same-semantics-version-transition-v1"};
    unavailable(deriver([a,b]).trend(run(a),run(b),strategy),"comparability_strategy_unapproved");
    const conflicting=structuredClone(strategy);conflicting.approval.reviewId="different-approval";
    unavailable(deriver([a,b],[],[strategy,conflicting]).trend(run(a),run(b),strategy));
    b.coverage.policyEnd="2026-12-01T00:00:00Z";
    unavailable(deriver([a,b]).trend(run(a),run(b)),"comparison_policy_interval_incompatible");
  });
});
describe("explicit complete versioned persistence profiles and prepared blocks",()=>{
  it.each([0,1,2,3,4,5])("%s bad blocks follow fixture-only four-block Critical profile",n=>{
    // Zero adverse blocks means known completed acceptable history, not empty history.
    const ins=series(n?Array(n).fill(80):[100]),i=ins.at(-1)!;
    const p=profile(i),h=history(ins,p),r=available(deriver([i,...ins],[p]).persistence(run(i),p,h));
    expect(r.state).toBe(["Nominal","Advisory","Warning","Breach","Critical","Critical"][n]);
    expect(r.completedActiveBlocks).toBe(n||1);expect(r.approval.kind).toBe("fixture-only");expect(r.label).toContain("fixture-only");
    expect(r.label).toContain(`${n||1} completed`);
    if(!n)expect(r.consecutive.subAcceptable).toBe(0);
  });
  it("four versus five Critical blocks are explicitly different fixture profiles, not defaults",()=>{
    const ins=series([80,80,80,80]),i=ins[3],p4=profile(i),p5=profile(i,5);
    const d=deriver(ins,[p4,p5]);
    expect(available(d.persistence(run(i),p4,history(ins,p4))).state).toBe("Critical");
    expect(available(d.persistence(run(i),p5,history(ins,p5))).state).toBe("Breach");
    unavailable(deriver(ins).persistence(run(i),p4,history(ins,p4)));
    unavailable(d.status(run(i)).persistence);
  });
  it("two severe blocks alternatively trigger Breach with explicit rule/count label",()=>{
    const ins=series([40,40]),p=profile(ins[1]),s=deriver(ins,[p]).status(run(ins[1]),p,history(ins,p));
    const r=available(s.persistence);expect(r.state).toBe("Breach");
    expect(r.trigger).toEqual({ruleId:"severe-two",selector:"severe",completedBlocks:2});
    expect(available(s.attention).rank).toBe(4);expect(available(s.attention).origins).toEqual(["condition"]);
    expect(available(s.attention).label).toContain("Current condition: Critical");
    expect(available(s.attention).label).toContain("2 completed severe blocks");
  });
  it("exempt gaps retain raw practices and continuity between bad blocks",()=>{
    const ins=series([80,99,80]),p=profile(ins[2]),w=run(ins[1]).evidence.window!;
    ins[1].breaks=[{start:w.start,end:w.end}];
    const h=history(ins,p,["active","exempt","active"]),before=structuredClone(h);
    const r=available(deriver(ins,[p]).persistence(run(ins[2]),p,h));
    expect(r.state).toBe("Warning");expect(r.completedActiveBlocks).toBe(2);expect(r.consecutive.subAcceptable).toBe(2);
    expect(r.history.blocks[1].result.evidence.rawObservations).toHaveLength(1);expect(h).toEqual(before);
    const s=deriver(ins,[p]).status(run(ins[1]),p,history(ins.slice(0,2),p,["active","exempt"]));
    unavailable(s.condition,"no_eligible_coverage");unavailable(s.persistence);unavailable(s.attention);
  });
  it("one complete green block recovers Breach; a current green pending day/Today cannot",()=>{
    const bad=series([80,80,80]),tail=numeric([100/7],"2026-01-23",[100],[1],1),p=profile(tail);
    const ins=[...bad,tail],h=history(ins,p,["active","active","active","pending"]);
    const d=deriver(ins,[p]),s=d.status(run(tail),p,h);
    expect(available(s.condition).condition).toBe("Healthy");
    expect(available(s.persistence).state).toBe("Breach");expect(available(s.attention).origins).toEqual(["persistence"]);
    const today={...structuredClone(tail.observations[0]),observationId:"today-improvement",observedAt:"2026-01-23T10:00:00Z"};
    tail.observations.push(today);
    expect(available(d.persistence(run(tail),p,history([...bad,tail],p,["active","active","active","pending"]))).state).toBe("Breach");
    const green=series([80,80,80,100]),pg=profile(green[3]);
    const r=available(deriver(green,[pg]).persistence(run(green[3]),pg,history(green,pg)));
    expect(r.state).toBe("Nominal");expect(r.trigger).toEqual({ruleId:"green-one",selector:"acceptable",completedBlocks:1});
  });
  it("instantaneous zero Critical alone promotes only Advisory",()=>{
    const ins=series([0]),p=profile(ins[0]),s=deriver(ins,[p]).status(run(ins[0]),p,history(ins,p));
    expect(available(s.condition).condition).toBe("Critical");expect(available(s.persistence).state).toBe("Advisory");
  });
  it("partial breaks are not secretly seven calendar-day active blocks",()=>{
    const ins=series([80]),p=profile(ins[0]),w=run(ins[0]).evidence.window!;
    ins[0].breaks=[{start:w.start,end:new Date(Date.parse(w.start)+43200000).toISOString()}];
    unavailable(deriver(ins,[p]).persistence(run(ins[0]),p,history(ins,p)),"active_block_not_seven_complete_active_days");
    // Explicit prepared eight-day span, with exactly one day exempt, is 7 active days.
    const i=numeric([80],"2026-01-09",[100],[1],8),pi=profile(i);
    i.breaks=[{start:"2026-01-01T00:00:00Z",end:"2026-01-02T00:00:00Z"}];
    const r=available(deriver([i],[pi]).persistence(run(i),pi,history([i],pi)));
    expect(r.state).toBe("Advisory");expect(r.completedActiveBlocks).toBe(1);
  });
  const invalidProfiles:((p:PersistenceProfile)=>void)[]=[
    p=>{p.promotions=p.promotions.filter(r=>r.state!=="Critical");},
    p=>{p.promotions[0].blocks=0;},p=>{p.promotions[0].blocks=1.5;},
    p=>{p.recovery.blocks=0;},p=>{p.recovery.blocks=Infinity;},
    p=>{p.states[4].rank=3;},p=>{p.states.pop();},
    p=>{p.promotions[4].priority=1;},
    p=>{p.selectors.severe=["Healthy"];},
    p=>{p.selectors.subAcceptable=["Warning","Critical"];},
    p=>{p.effective.end=p.effective.start;},
    p=>{p.approval.sourceRevision="";},
    p=>{delete (p as Partial<PersistenceProfile>).approval;},
    p=>{(p as unknown as {approved:boolean}).approved=true;},
    p=>{p.scope.calculationVersion="wrong" as typeof p.scope.calculationVersion;},
    p=>{p.scope.boundaryVersion="wrong" as typeof p.scope.boundaryVersion;},
  ];
  it.each(invalidProfiles.map((_,i)=>i))("invalid profile %s remains unavailable even registered",index=>{
    const ins=series([80]),p=profile(ins[0]);invalidProfiles[index](p);
    unavailable(deriver(ins,[p]).persistence(run(ins[0]),p,history(ins,p)));
  });
  it("profile approval claims, same-ID ambiguity and missing Critical recipe are not implicit approval",()=>{
    const ins=series([80]),p=profile(ins[0]),h=history(ins,p),other=structuredClone(p);
    other.promotions[4].blocks=5;
    unavailable(deriver(ins,[p,other]).persistence(run(ins[0]),p,h));
    unavailable(deriver(ins).persistence(run(ins[0]),p,h));
  });
  it("empty history at a trusted nominal origin still cannot fabricate Nominal",()=>{
    const i=numeric([100],"2026-01-01"),p=profile(i),h=history([],p);
    // Match canonical boundary text so this exercises the no-complete-block rule.
    h.completeThrough=run(i).evidence.window!.end;
    unavailable(deriver([i],[p]).persistence(run(i),p,h),"history_incomplete");
  });
  it("exempt-only or pending-only history cannot establish Nominal",()=>{
    const i=numeric([100/7],"2026-01-02",[100],[1],1),p=profile(i);
    unavailable(deriver([i],[p]).persistence(run(i),p,history([i],p,["pending"])),"history_incomplete");
    const prior=series([80])[0],w=run(prior).evidence.window!;
    prior.breaks=[{start:w.start,end:w.end}];
    const h=history([prior,i],p,["exempt","pending"]);
    unavailable(deriver([prior,i],[p]).persistence(run(i),p,h));
  });
  it("profiles outside their effective interval and block policy-interval disagreement are unavailable",()=>{
    const ins=series([80]),p=profile(ins[0]);
    p.effective.start="2026-01-02T00:00:00Z";p.initial.at=p.effective.start;
    unavailable(deriver(ins,[p]).persistence(run(ins[0]),p,history(ins,p)),"profile_effective_interval");
    const q=profile(ins[0]),h=history(ins,q),changed=structuredClone(ins[0]);
    changed.coverage.policyEnd="2026-12-01T00:00:00Z";h.blocks[0].result=run(changed);
    unavailable(deriver(ins,[q]).persistence(run(ins[0]),q,h),"block_policy_interval_incompatible");
  });
  it("missing, overlapped, altered-origin, future or incomplete history is unavailable",()=>{
    const ins=series([80,80]),p=profile(ins[1]),d=deriver(ins,[p]);
    const edits:((h:PreparedHistory)=>void)[]=[
      h=>{h.blocks.shift();},h=>{h.blocks.push(h.blocks[1]);},
      h=>{h.origin.at=h.completeThrough;h.blocks=[];},
      h=>{h.blocks[0].preparation.sourceId="";},
      h=>{h.completeThrough="2026-01-16T00:00:00Z";},
      h=>{h.blocks[0].preparation.assemblyVersion="unknown";},
      h=>{h.blocks[0].preparation.kind="exempt";},
      h=>{h.blocks[0].preparation.kind="pending";},
      h=>{h.blocks[0].result.evidence.window!.days[0].coveredMs=1;},
    ];
    for(const edit of edits){const h=history(ins,p);edit(h);unavailable(d.persistence(run(ins[1]),p,h));}
    const later=series([80,80,80]);unavailable(d.persistence(run(ins[1]),p,history(later,p)));
  });
  it("onboarding clipped blocks and inconsistent same-window raw activity are rejected",()=>{
    const i=series([80])[0];i.coverage.onboardingAt="2026-01-01T12:00:00Z";
    const p=profile(i);unavailable(deriver([i],[p]).persistence(run(i),p,history([i],p)),"block_coverage_incomplete");
    const ins=series([80]),q=profile(ins[0]),h=history(ins,q);
    const other=structuredClone(ins[0]);other.observations[0].values["opaque-0"].value=100;
    unavailable(deriver(ins,[q]).persistence(run(other),q,h),"conflicting_observation_provenance");
  });
  it("full registry, inputs and outputs are detached; factories snapshot trusted profiles",()=>{
    const ins=series([80,80]),p=profile(ins[1]),h=history(ins,p),r=run(ins[1]);
    const before=structuredClone({ins,p,h,r}),d=deriver(ins,[p]);
    const result=available(d.persistence(r,p,h));result.history.blocks[0].result.evidence.rawObservations.length=0;
    expect({ins,p,h,r}).toEqual(before);
    p.promotions[4].blocks=1;unavailable(d.persistence(r,p,h));
    const a=numeric([80],"2026-01-08"),b=numeric([85]),t=available(deriver([a,b]).trend(run(a),run(b)));
    t.components[0].measurement.displayName="changed";expect(b.policy.measurements[0].displayName).not.toBe("changed");
  });
});
describe("exact evidence helpers",()=>{
  it("does not re-rationalize rounded decimal sums",()=>{
    expect(exact(sub(decimal(0.3),decimal(0.1+0.2)))).toEqual({numerator:"-1",denominator:"25000000000000000"});
  });
  it("huge rational presentation cannot feed policy decisions",()=>{
    const n=BigInt("1"+"0".repeat(400)),d=BigInt("1"+"0".repeat(401));
    expect(approximate(rational(n,d))).toBeCloseTo(0.1);
    expect(approximate(rational(-n,d))).toBeCloseTo(-0.1);
  });
});
