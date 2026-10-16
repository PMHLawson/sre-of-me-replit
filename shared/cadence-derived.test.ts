import { describe, it, expect } from "vitest";
import { createCadenceDeriver, CADENCE_VERSION, MAX_CADENCE_HISTORY_DAYS, MAX_CADENCE_OBSERVATIONS, type CadenceEpisode, type CadenceInput,
  type CadenceResult } from "./cadence-derived";
import { DomainConfigurationSchema, type Observation } from "./domain-config";

const origin="2026-01-01T04:00:00.000Z";
const at=(n:number)=>new Date(Date.parse(origin)+n*86400000).toISOString();
const midday=(n:number)=>new Date(Date.parse(at(n))+12*3600000).toISOString();
function episode(required=5,basis=7,windowDays=14):CadenceEpisode {
  const floor={measurementId:"duration",unitId:"minute",valueType:"number" as const,
    basis:{kind:"per_event" as const},constraint:{operator:"gte" as const,value:10}};
  return {episodeId:"episode-1",windowDays,targetId:"target",frequencyMeasurementId:"frequency",
    origin:{at:origin,sourceId:"verified-history-receipt",kind:"verified-effective-policy-origin"},effectiveEnd:null,
    policy:DomainConfigurationSchema.parse({
      schemaVersion:1,organizationId:"org",ownerUserId:"owner",domainId:"domain",policyVersionId:"policy",
      revision:1,effectiveFrom:origin,displayName:"Meditation",
      goal:{intent:"develop",desiredCapability:"Regular personal meditation"},
      boundary:{timezone:"UTC",dayStartHour:4},taskVariants:[],
      measurements:[
        {measurementId:"duration",displayName:"Minutes",meaning:"Raw practice duration",role:"practice",
          kind:"duration",valueType:"number",unit:{unitId:"minute",dimension:"time"},
          aggregation:"sum",comparisonDirection:"higher_is_better",scope:{kind:"per_event"}},
        {measurementId:"frequency",displayName:"Qualifying days",meaning:"Individually qualified days",
          role:"practice",kind:"frequency",valueType:"integer",unit:{unitId:"day",dimension:"days"},
          aggregation:"count",comparisonDirection:"higher_is_better",countBy:"distinct_days",
          scope:{kind:"period",windowDays:basis}}],
      targets:{normal:{targetId:"target",conditions:[
        {...floor,basis:{kind:"period",windowDays:basis},
          periodAggregation:{sourceBasis:"per_event",method:"sum"},constraint:{operator:"gte",value:50}},
        {measurementId:"frequency",unitId:"day",valueType:"integer",basis:{kind:"period",windowDays:basis},
          constraint:{operator:"gte",value:required}}]}},
      qualification:{kind:"condition",condition:floor},references:[],review:{anchorAt:origin,intervalDays:84},
    })};
}
function observation(e:CadenceEpisode,id:string,time:string,value=10):Observation {
  return {schemaVersion:1,observationId:id,organizationId:e.policy.organizationId,ownerUserId:e.policy.ownerUserId,
    domainId:e.policy.domainId,policyVersionId:e.policy.policyVersionId,observedAt:time,
    values:{duration:{unitId:"minute",valueType:"number",value}}};
}
function input(e:CadenceEpisode,n:number,observations:Observation[]=[],breaks:CadenceInput["history"]["breaks"]=[]):CadenceInput {
  return {episodeId:e.episodeId,now:midday(n),history:{sourceId:e.origin.sourceId,coveredFrom:e.origin.at,
    coveredThrough:e.effectiveEnd&&Date.parse(e.effectiveEnd)<Date.parse(at(n))?e.effectiveEnd:at(n),observations,breaks}};
}
function available(r:CadenceResult) {
  expect(r.status).toBe("available");
  if(r.status!=="available")throw Error(r.reason);
  return r;
}
const fraction=(n:string|number,d:string|number=1)=>({numerator:String(n),denominator:String(d)});

describe("approved eligible-day cadence arithmetic",()=>{
  it("5/7 opens a rhythm slip after two missed days, below the proportional Advisory threshold",()=>{
    const e=episode(),r=available(createCadenceDeriver([e]).evaluate(input(e,2)));
    expect(r.interval).toMatchObject(fraction(7,5));
    expect(r.gap).toMatchObject(fraction(2));
    expect(r.lateness).toMatchObject(fraction(3,5));
    expect(r.state).toBe("RhythmSlipping");
    expect(r.evidence.calculationVersion).toBe(CADENCE_VERSION);
  });
  it("sparse 1/7 practice gets its ordinary interval before an overdue notice",()=>{
    const e=episode(1),derive=createCadenceDeriver([e]);
    expect(available(derive.evaluate(input(e,7)))).toMatchObject({state:"Nominal",episodeOpen:false});
    const r=available(derive.evaluate(input(e,8)));
    expect(r.state).toBe("RhythmSlipping");expect(r.lateness).toMatchObject(fraction(1));
  });
  it("reproduces 3/7,W7 seven misses followed by gradual Breach, Warning, clear",()=>{
    const e=episode(3,7,7),derive=createCadenceDeriver([e]);
    const expected=[[7,14,3,"Critical"],[8,10,3,"Breach"],[9,2,1,"Warning"],[10,0,1,"Nominal"]] as const;
    for(const [n,late,denominator,state] of expected) {
      const os=[7,8,9].filter(d=>d<n).map(d=>observation(e,"q"+d,midday(d)));
      const r=available(derive.evaluate(input(e,n,os)));
      expect(r.lateness).toMatchObject(fraction(late,denominator));expect(r.state).toBe(state);
    }
  });
  it.each([[1,"Nominal"],[2,"Advisory"],[3,"Warning"],[4,"Breach"],[5,"Critical"]] as const)(
    "promotes at exact proportional thresholds for completed day %i", (days,state)=>{
      const e=episode(1,1,8),r=available(createCadenceDeriver([e]).evaluate(input(e,days)));
      expect(r.state).toBe(state);
      if(state==="Critical")expect(r.label).toBe("Sustained Critical");
    });
  it("scales thresholds with an arbitrary configured window instead of a fixed chart",()=>{
    const e=episode(1,1,16),r=available(createCadenceDeriver([e]).evaluate(input(e,2)));
    expect(r.lateness).toMatchObject(fraction(1));expect(r.state).toBe("RhythmSlipping");
  });
  it("retains quantity observations without pooling several below-floor events into a qualifying day",()=>{
    const e=episode(3,7,7),os=[observation(e,"short-1",midday(2),5),observation(e,"short-2",midday(2),5)];
    const a=available(createCadenceDeriver([e]).evaluate(input(e,7,os)));
    const b=available(createCadenceDeriver([e]).evaluate(input(e,7)));
    expect(a.evidence.rawObservations).toEqual(os);
    expect(a.inspection.qualifyingDays).toBe(0);expect(a.gap).toEqual(b.gap);expect(a.lateness).toEqual(b.lateness);
  });
  it("three individually qualifying events earn one qualifying-day credit",()=>{
    const e=episode(3,7,7),os=[1,2,3].map(n=>observation(e,"q"+n,midday(7)));
    const a=available(createCadenceDeriver([e]).evaluate(input(e,8,os)));
    const b=available(createCadenceDeriver([e]).evaluate(input(e,8,[os[0]])));
    expect(a.inspection.qualifyingDays).toBe(1);expect(a.lateness).toEqual(b.lateness);
    expect(a.evidence.ledger.at(-1)).toMatchObject({dayCredit:1,qualifyingObservationIds:["q1","q2","q3"]});
  });
  it("full qualifying Today actuals recover once without treating unfinished Today as a miss",()=>{
    const e=episode(3,7,7),os=[1,2,3].map(n=>observation(e,"today"+n,new Date(Date.parse(at(7))+n*3600000).toISOString()));
    const r=available(createCadenceDeriver([e]).evaluate(input(e,7,os)));
    expect(r.inspection.eligible).toMatchObject(fraction(7));expect(r.inspection.qualifyingDays).toBe(1);
    expect(r.lateness).toMatchObject(fraction(7,3));expect(r.gap).toMatchObject(fraction(0));
    expect(r.evidence.ledger.at(-1)).toMatchObject({kind:"today-pending",dayCredit:1,exposure:fraction(0)});
    expect(r.evidence.pendingObservationIds).toEqual(["today1","today2","today3"]);
  });
  it("unmet Today, below-floor Today, and future practice add no miss or recovery credit",()=>{
    const e=episode(3,7,7),os=[observation(e,"short",midday(7),9),observation(e,"future",midday(8),1000)];
    const r=available(createCadenceDeriver([e]).evaluate(input(e,7,os)));
    expect(r.lateness).toMatchObject(fraction(14,3));expect(r.inspection.qualifyingDays).toBe(0);
    expect(r.evidence.pendingObservationIds).toEqual(["short"]);expect(r.evidence.futureObservationIds).toEqual(["future"]);
    expect(r.evidence.ledger).toHaveLength(7);
  });
  it("zero lateness with residual frequency shortfall is Recovering, not on pace",()=>{
    const e=episode(),os=[2,3].map(n=>observation(e,"q"+n,midday(n)));
    const r=available(createCadenceDeriver([e]).evaluate(input(e,4,os)));
    expect(r.lateness).toMatchObject(fraction(0));expect(r.inspection.deficit).toMatchObject(fraction(6,5));
    expect(r.state).toBe("Recovering");expect(r.episodeOpen).toBe(true);
  });
});
describe("exemptions and exact civil-day exposure",()=>{
  it("a long full break freezes gap/lateness and preserves eligible recovery history",()=>{
    const e=episode(),derive=createCadenceDeriver([e]),baseline=available(derive.evaluate(input(e,3)));
    const r=available(derive.evaluate(input(e,30,[],[{start:at(3),end:at(30)}])));
    expect(r.gap).toEqual(baseline.gap);expect(r.lateness).toEqual(baseline.lateness);
    expect(r.inspection).toEqual(baseline.inspection);expect(r.state).toBe(baseline.state);
    expect(r.evidence.ledger.slice(3).every(d=>d.kind==="fully-exempt")).toBe(true);
  });
  it("actual qualifying practice during a full break earns full credit; aging alone does not",()=>{
    const e=episode(),r=available(createCadenceDeriver([e]).evaluate(
      input(e,10,[observation(e,"practice-in-break",midday(5))],[{start:at(3),end:at(10)}])));
    expect(r.inspection.eligible).toMatchObject(fraction(3));expect(r.inspection.qualifyingDays).toBe(1);
    expect(r.gap).toMatchObject(fraction(0));expect(r.lateness).toMatchObject(fraction(1,5));
  });
  it("an entirely exempt new history is not an invented Nominal or score",()=>{
    const e=episode(),r=createCadenceDeriver([e]).evaluate(input(e,14,[],[{start:at(0),end:at(14)}]));
    expect(r).toMatchObject({status:"unavailable",reason:"no_eligible_coverage"});
    expect(r).not.toHaveProperty("score");
  });
  it("overlapping breaks are unioned, not double-subtracted",()=>{
    const e=episode(),r=available(createCadenceDeriver([e]).evaluate(input(e,1,[],[
      {start:at(0),end:new Date(Date.parse(at(0))+6*3600000).toISOString()},
      {start:new Date(Date.parse(at(0))+3*3600000).toISOString(),end:new Date(Date.parse(at(0))+12*3600000).toISOString()}])));
    expect(r.gap).toMatchObject(fraction(1,2));
  });
  it.each([
    ["America/New_York","2026-03-08T05:00:00.000Z","2026-03-09T04:00:00.000Z","2026-03-09T16:00:00.000Z",
      "2026-03-08T06:00:00.000Z","2026-03-08T07:00:00.000Z",22,23],
    ["Antarctica/Troll","2026-10-24T22:00:00.000Z","2026-10-26T00:00:00.000Z","2026-10-26T12:00:00.000Z",
      "2026-10-25T00:00:00.000Z","2026-10-25T01:00:00.000Z",25,26],
  ] as const)("uses actual %s day duration for partial exemption",(tz,start,end,now,breakStart,breakEnd,n,d)=>{
    const e=episode();e.policy.boundary={timezone:tz,dayStartHour:0};e.policy.effectiveFrom=start;e.origin.at=start;
    const r=available(createCadenceDeriver([e]).evaluate({episodeId:e.episodeId,now,history:{
      sourceId:e.origin.sourceId,coveredFrom:start,coveredThrough:end,observations:[],breaks:[{start:breakStart,end:breakEnd}]}}));
    expect(r.gap).toMatchObject(fraction(n,d));
  });
  it("a partially covered first civil day contributes its exact fraction",()=>{
    const e=episode();e.origin.at="2026-01-01T12:00:00.000Z";e.policy.effectiveFrom=e.origin.at;
    const r=available(createCadenceDeriver([e]).evaluate(input(e,1)));
    expect(r.gap).toMatchObject(fraction(2,3));
  });
});
describe("trusted effective episodes and hostile evidence",()=>{
  it("an old episode stops at its effective end rather than accruing misses under new settings",()=>{
    const e=episode();e.effectiveEnd=at(3);
    const r=available(createCadenceDeriver([e]).evaluate(input(e,20)));
    expect(r.through).toBe(at(3));expect(r.gap).toMatchObject(fraction(3));expect(r.evidence.ledger).toHaveLength(3);
  });
  it("keeps changed-frequency policy episodes separate, without announcing old-episode recovery",()=>{
    const old=episode();old.effectiveEnd=at(3);
    const next=episode(1);next.episodeId="next";next.policy.policyVersionId="policy-next";next.policy.revision=2;
    next.policy.previousVersionId="policy";next.policy.effectiveFrom=at(3);next.origin={...next.origin,at:at(3),sourceId:"next-receipt"};
    const derive=createCadenceDeriver([old,next]);
    expect(available(derive.evaluate(input(old,4))).state).toBe("RhythmSlipping");
    const r=available(derive.evaluate(input(next,4)));expect(r.state).toBe("Nominal");expect(r.gap).toMatchObject(fraction(1));
    expect(r.policyVersionId).toBe("policy-next");
  });
  it("requires explicit target selection across an adapted target boundary",()=>{
    const e=episode();e.policy.targets.adapted={target:{...structuredClone(e.policy.targets.normal),targetId:"adapted"},
      effectiveFrom:at(3),duration:"ongoing"};
    expect(createCadenceDeriver([e]).evaluate(input(e,4))).toMatchObject({status:"unavailable",reason:"adaptation_boundary_unavailable"});
    e.effectiveEnd=at(3);
    expect(createCadenceDeriver([e]).evaluate(input(e,3)).status).toBe("available");
    const adapted=structuredClone(e);adapted.episodeId="adapted-episode";adapted.targetId="adapted";
    adapted.origin={...adapted.origin,at:at(3),sourceId:"adaptation-receipt"};adapted.effectiveEnd=null;
    expect(createCadenceDeriver([e,adapted]).evaluate(input(adapted,4)).status).toBe("available");
  });
  it.each(["sourceId","coveredFrom","coveredThrough"] as const)("refuses missing or mismatched %s",field=>{
    const e=episode(),i=input(e,7);(i.history as any)[field]=field==="sourceId"?"unverified":at(1);
    expect(createCadenceDeriver([e]).evaluate(i).status).toBe("unavailable");
    delete (i.history as any)[field];expect(createCadenceDeriver([e]).evaluate(i).status).toBe("unavailable");
  });
  it.each(["organizationId","ownerUserId","domainId","policyVersionId"] as const)("refuses wrong-scope %s rather than dropping the record",field=>{
    const e=episode(),o=observation(e,"wrong",midday(0));(o as any)[field]="other";
    expect(createCadenceDeriver([e]).evaluate(input(e,7,[o]))).toMatchObject({status:"unavailable",reason:"observation_context_unavailable"});
  });
  it("rejects malformed, duplicate and out-of-episode evidence even if it would improve the result",()=>{
    const e=episode(),o=observation(e,"duplicate",midday(0));
    for(const os of [[o,o],[{...o,observedAt:"2026-02-30T12:00:00Z"}],
      [{...o,observedAt:"2025-12-31T12:00:00Z"}]])expect(createCadenceDeriver([e]).evaluate(input(e,7,os)).status).toBe("unavailable");
    e.effectiveEnd=at(3);
    expect(createCadenceDeriver([e]).evaluate(input(e,7,[observation(e,"at-end",at(3))])))
      .toMatchObject({status:"unavailable",reason:"observation_outside_episode"});
  });
  it("requires the entire compound floor in one event, never pooling predicates across events",()=>{
    const e=episode();
    const duration=e.policy.qualification!;
    e.policy.measurements.push({measurementId:"repetitions",displayName:"Reps",meaning:"Practice repetitions",role:"practice",
      kind:"repetitions",valueType:"integer",unit:{unitId:"rep",dimension:"count"},aggregation:"sum",
      comparisonDirection:"higher_is_better",scope:{kind:"per_event"}});
    e.policy.qualification={kind:"all",predicates:[duration,{kind:"condition",condition:{
      measurementId:"repetitions",unitId:"rep",valueType:"integer",basis:{kind:"per_event"},
      constraint:{operator:"gte",value:5}}}]};
    const a=observation(e,"duration-only",midday(1),10);
    const b=observation(e,"reps-only",midday(1),1);b.values.repetitions={unitId:"rep",valueType:"integer",value:5};
    const both=observation(e,"both",midday(2),10);both.values.repetitions={unitId:"rep",valueType:"integer",value:5};
    const r=available(createCadenceDeriver([e]).evaluate(input(e,7,[a,b,both])));
    expect(r.inspection.qualifyingDays).toBe(1);
    expect(r.evidence.ledger.filter(d=>d.dayCredit).map(d=>d.qualifyingObservationIds)).toEqual([["both"]]);
  });
  it("does not invent a qualifier for a policy without an event floor",()=>{
    const e=episode();delete e.policy.qualification;
    expect(createCadenceDeriver([e]).evaluate(input(e,2))).toMatchObject({status:"unavailable",reason:"qualification_unavailable"});
  });
  it("refuses unregistered or overlapping episodes and unsupported qualification semantics",()=>{
    const e=episode();
    expect(createCadenceDeriver([]).evaluate(input(e,2))).toMatchObject({status:"unavailable",reason:"episode_unregistered"});
    const other={...structuredClone(e),episodeId:"overlap"};
    expect(createCadenceDeriver([e,other]).evaluate(input(e,2))).toMatchObject({status:"unavailable",reason:"episode_registry_overlap"});
    if(e.policy.qualification?.kind==="condition")e.policy.qualification.condition.basis={kind:"period",windowDays:7};
    expect(createCadenceDeriver([e]).evaluate(input(e,2)).status).toBe("unavailable");
  });
  it("retains finer timestamp evidence and refuses instead of aliasing different boundaries",()=>{
    const e=episode(),o=observation(e,"microsecond","2026-01-01T04:00:00.000001Z");
    const i=input(e,7,[o]),before=structuredClone(i),r=createCadenceDeriver([e]).evaluate(i);
    expect(r).toMatchObject({status:"unavailable",reason:"unsupported_precision"});
    expect(r.evidence.rawObservations).toEqual([o]);expect(i).toEqual(before);
    const badThrough=input(e,7);badThrough.history.coveredThrough="2026-01-08T04:00:00.000001Z";
    expect(createCadenceDeriver([e]).evaluate(badThrough)).toMatchObject({status:"unavailable",reason:"unsupported_precision"});
    const lossless=observation(e,"lossless","2026-01-01T04:00:00.000000Z");
    expect(createCadenceDeriver([e]).evaluate(input(e,7,[lossless])).status).toBe("available");
  });
  it("refuses excessive work as unavailable without retaining or deleting a shortened history",()=>{
    const e=episode(),far=input(e,MAX_CADENCE_HISTORY_DAYS+1);
    expect(createCadenceDeriver([e]).evaluate(far)).toMatchObject({status:"unavailable",reason:"history_resource_limit"});
    const huge=episode();huge.windowDays=MAX_CADENCE_HISTORY_DAYS+1;
    expect(createCadenceDeriver([huge]).evaluate(input(huge,1))).toMatchObject({status:"unavailable",reason:"history_resource_limit"});
    const crowded=input(e,1,Array.from({length:MAX_CADENCE_OBSERVATIONS+1},(_,n)=>observation(e,"q"+n,midday(0))));
    const originalLength=crowded.history.observations.length;
    expect(createCadenceDeriver([e]).evaluate(crowded)).toMatchObject({status:"unavailable",reason:"history_resource_limit"});
    expect(crowded.history.observations).toHaveLength(originalLength);
  });
  it("replays deterministically under reordered raw events and reports unavailable for invalid break intervals",()=>{
    const e=episode(),os=[observation(e,"later",midday(2)),observation(e,"earlier",midday(1))],derive=createCadenceDeriver([e]);
    const a=available(derive.evaluate(input(e,7,os))),b=available(derive.evaluate(input(e,7,[...os].reverse())));
    expect(a.evidence.ledger).toEqual(b.evidence.ledger);expect(a.lateness).toEqual(b.lateness);
    expect(derive.evaluate(input(e,7,os,[{start:at(2),end:at(1)}]))).toMatchObject({status:"unavailable",reason:"break_interval_unavailable"});
  });
  it("snapshots the trusted registry and never mutates input or returned prior history",()=>{
    const e=episode(),derive=createCadenceDeriver([e]),i=input(e,7),before=structuredClone(i);
    e.windowDays=1;
    const first=available(derive.evaluate(i));first.evidence.ledger[0].state="Critical";
    const again=available(derive.evaluate(i));
    expect(i).toEqual(before);expect(again.state).toBe("Breach");expect(again.evidence.ledger[0].state).toBe("Nominal");
  });
});
