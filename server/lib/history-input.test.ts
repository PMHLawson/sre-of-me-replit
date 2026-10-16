import {describe,it,expect,vi} from "vitest";
import {planHistoryInput} from "./history-input";
import {completedWindowDays,logicalDay,computeCompositeState,computeSustainedOverachievement,sustainedWindowAnchor,withLogicalDayMemo} from "./policy-engine";
import {computeEscalationState,escalationHistoryAnchors} from "./escalation";
import type {Session} from "../../shared/schema";
const now=new Date("2026-11-03T12:00:00Z");
function row(id:string,at:string,minutes=20):Session{return {id,userId:"synthetic",domain:"meditation",
  timestamp:new Date(at),durationMinutes:minutes,deletedAt:null,notes:null,isAnomaly:false,anomalyNote:null};}
describe("bounded input preserves the existing per-anchor evaluator",()=>{
  it.each([7,14,28,42])("unions every actual anchor for compliance%d and longest history",windowDays=>{
    const opts={now,windowDays,timezone:"America/New_York",dayStartHour:4},plan=planHistoryInput(opts,60);
    const expected=new Set(completedWindowDays({...opts,windowDays:90}));
    expected.add(logicalDay(now,opts));
    for(const day of completedWindowDays(opts))for(const key of completedWindowDays({...opts,now:sustainedWindowAnchor(day)}))expected.add(key);
    for(const at of escalationHistoryAnchors(opts,60))for(const key of completedWindowDays({...opts,now:at}))expected.add(key);
    expect(Array.from(plan.logicalDays).sort()).toEqual(Array.from(expected).sort());
    const earliest=Array.from(expected).sort()[0];
    expect(plan.fromInclusive.getTime()).toBeLessThan(Date.parse(earliest+"T00:00:00Z"));
  });
  it.each(["America/New_York","Australia/Lord_Howe","Pacific/Kiritimati","Etc/GMT+12"])("bounded/full parity across DST and offsets: %s",timezone=>{
    const opts=withLogicalDayMemo({now,windowDays:42,timezone,dayStartHour:23}),plan=planHistoryInput(opts,60);
    const rows=Array.from({length:145},(_,i)=>row("s"+i,new Date(now.getTime()-i*86400000).toISOString(),i%3?20:5));
    rows.push(row("years-old","2016-01-01T00:00:00Z"),row("future","2027-01-01T00:00:00Z"));
    const relevant=rows.filter(r=>r.timestamp>=plan.fromInclusive&&r.timestamp<plan.untilExclusive&&plan.logicalDays.has(logicalDay(r.timestamp,opts)));
    expect(computeCompositeState(relevant,opts)).toEqual(computeCompositeState(rows,opts));
    expect(computeSustainedOverachievement(relevant,opts)).toEqual(computeSustainedOverachievement(rows,opts));
    expect(computeEscalationState(relevant,opts,60)).toEqual(computeEscalationState(rows,opts,60));
  });
  it("the earliest sixty-day-history result needs a practice beyond a ninety-day shortcut",()=>{
    const opts=withLogicalDayMemo({now,windowDays:42,timezone:"America/New_York",dayStartHour:4});
    const oldest=escalationHistoryAnchors(opts,60)[0],key=completedWindowDays({...opts,now:oldest})[0];
    const practice=row("decisive-old",key+"T12:00:00Z",200);
    const full=computeEscalationState([practice],opts,60);
    expect(full.history[0].perDomain.meditation.percentRemaining).toBe(100);
    expect(computeEscalationState([],opts,60).history[0].perDomain.meditation.percentRemaining).toBe(0);
    expect(planHistoryInput(opts,60).logicalDays.has(key)).toBe(true);
  });
  it("request memo reduces repeated timezone conversions without global state",()=>{
    const opts=withLogicalDayMemo({now,timezone:"America/New_York",dayStartHour:4});
    const OriginalDateTimeFormat=Intl.DateTimeFormat;
    const spy=vi.spyOn(Intl,"DateTimeFormat").mockImplementation(function(locales,options){
      return new OriginalDateTimeFormat(locales,options);
    });try{
      const first=logicalDay(now,opts);
      for(let i=0;i<100;i++)expect(logicalDay(now,{...opts,now:new Date(now.getTime()+i)})).toBe(first);
      expect(spy).toHaveBeenCalledTimes(1);
      logicalDay(now,withLogicalDayMemo(opts));expect(spy).toHaveBeenCalledTimes(2);
      logicalDay(now,{...opts,timezone:"Pacific/Kiritimati"});expect(spy).toHaveBeenCalledTimes(3);
    }finally{spy.mockRestore();}
  });
});
