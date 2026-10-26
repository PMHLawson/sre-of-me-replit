import {beforeAll,afterAll,it,expect,vi} from "vitest";
import {Pool} from "pg";
import {startFixture,verifyFixture} from "../lib/ownership-fixture";
import {createPinnedOwnershipUnit} from "../lib/pinned-ownership-unit";
import {createLegacyComparisonUnit} from "./legacy-activity-mutations";
import {createLegacyActivityMutations} from "./legacy-activity-mutations";
import {seedPolicyV2} from "../lib/seed-policy-v2";
import {importLegacyObservations} from "./legacy-observation-sync";
import {createOrgContextResolver} from "../lib/org-context";
import {createPolicyV2Storage} from "../storage/policy-v2-storage";
import {LegacyHistoryReads} from "../lib/legacy-history";
import {policyResponse} from "../lib/history-state";
import {createEvaluationHistoryLoader,evaluationHistoryFingerprint,historyBreakFingerprint,type HistorySnapshot,
  type HistoryCoverageReceipt,type HistoryVerification} from "./evaluation-history-v2";
import {createPolicyShadowService,PolicyShadowReportSchema,type PolicyShadowReport,type ExpectedDifferenceRule} from "./policy-shadow-service";
import type {DomainConfiguration} from "../../shared/domain-config";
import type {CadenceEpisode} from "../../shared/cadence-derived";
import type {EvaluationRecipe} from "../../shared/evaluator-recipe";
let f:Awaited<ReturnType<typeof startFixture>>,pool:Pool;
const now="2026-01-15T12:00:00.000Z";
const request=(actor:string)=>({isAuthenticated:()=>true,user:{claims:{sub:actor}}});
const slugs=["martial-arts","meditation","fitness","music"];
let serial=0;
beforeAll(async()=>{
 f=await startFixture("policy-shadow");verifyFixture(f.root);
 pool=new Pool({host:f.root+"/socket",port:5432,user:"synthetic",database:"postgres",password:"",ssl:false,
  max:4,connectionTimeoutMillis:5000,options:"-c statement_timeout=10000 -c lock_timeout=5000"});
},60000);
afterAll(async()=>{if(pool)await pool.end();if(f)await f.cleanup();},60000);
type Practice={id:string;domain?:string;minutes:number;at:string;deleted?:boolean;anomaly?:boolean};
async function setup(events:Practice[]=[],settings={timezone:"UTC",hour:0,days:7},asOf=now){
 const actor="shadow-fixture-"+(++serial),req=request(actor);
 await f.client.query("INSERT INTO users(id,created_at) VALUES($1,'2025-12-01T00:00:00Z')",[actor]);
 await f.client.query("INSERT INTO user_settings(user_id,timezone,day_start_hour,window_days) VALUES($1,$2,$3,$4)",
  [actor,settings.timezone,settings.hour,settings.days]);
 for(const slug of slugs)await f.client.query(`INSERT INTO sessions(id,user_id,domain,duration_minutes,timestamp)
  VALUES($1,$2,$3,1,'2026-01-01T00:00:00Z')`,[actor+"-"+slug,actor,slug]);
 for(const e of events)await f.client.query(`INSERT INTO sessions(id,user_id,domain,duration_minutes,timestamp,notes,is_anomaly,anomaly_note,deleted_at)
  VALUES($1,$2,$3,$4,$5,'synthetic private note must never enter report',$6,$7,$8)`,
  [actor+"-"+e.id,actor,e.domain??"meditation",e.minutes,e.at,e.anomaly??false,
   e.anomaly?"synthetic private anomaly":null,e.deleted?"2026-01-14T20:00:00Z":null]);
 await seedPolicyV2(f.db,req);await importLegacyObservations(f.db,req);
 const context=await createOrgContextResolver(f.db)(req);
 const configurations=(await f.client.query("SELECT configuration FROM policy_versions WHERE org_id=$1 ORDER BY policy_version_id",[context.orgId]))
  .rows.map(r=>r.configuration as DomainConfiguration);
 const episodes=configurations.map(c=>({episodeId:"synthetic-episode-"+c.domainId,policy:structuredClone(c),windowDays:settings.days,
  targetId:c.targets.normal.targetId,frequencyMeasurementId:c.measurements.find(m=>m.kind==="frequency")!.measurementId,
  origin:{at:c.effectiveFrom,sourceId:"synthetic-genesis-"+c.domainId,kind:"verified-effective-policy-origin" as const},effectiveEnd:null} satisfies CadenceEpisode));
 const recipes:EvaluationRecipe[]=configurations.map(c=>({recipeId:"synthetic-reviewed-"+c.domainId,version:"1",
  organizationId:c.organizationId,ownerUserId:c.ownerUserId,domainId:c.domainId,policyVersionId:c.policyVersionId,
  targetId:c.targets.normal.targetId,targetSelection:"normal",qualification:c.qualification??null,
  components:c.targets.normal.conditions.map(target=>({measurement:structuredClone(c.measurements.find(m=>m.measurementId===target.measurementId)!),
   targetCondition:structuredClone(target),weight:0.5,mandatory:true,percentage:"positive-linear-ratio-v1",
   actual:c.measurements.find(m=>m.measurementId===target.measurementId)!.kind==="frequency"?"distinct-qualifying-days":"sum-events"}))}));
 const coverage=(s:HistorySnapshot,es:CadenceEpisode[]):HistoryCoverageReceipt=>({
  receiptId:"synthetic-independent-genesis-proof",snapshotId:s.snapshotId,snapshotFingerprint:evaluationHistoryFingerprint(s),scope:s.scope,
  completeFrom:"2026-01-01T00:00:00Z",completeThrough:s.capturedAt,
  counts:{configurations:s.configurations.length,observations:s.observations.length,corrections:s.corrections.length,breaks:s.breaks.length},
  // This fixture establishes genesis independently before its synthetic events.
  // A production adapter must inspect independent activation/import evidence.
  origins:es.map(e=>({episodeId:e.episodeId,at:e.origin.at,sourceId:e.origin.sourceId,evidenceId:"fixture-created-empty-before-recording",
    kind:e.policy.revision===1?"verified-empty-domain-activation":"verified-source-reconciliation"}))});
 const unit=createLegacyComparisonUnit(createPinnedOwnershipUnit(pool),{clock:()=>new Date(asOf)});
 const make=(rules:ExpectedDifferenceRule[]=[],recipeInput:EvaluationRecipe[]=recipes,verification?:HistoryVerification)=>createPolicyShadowService({
  enabled:true,unit,recipes:recipeInput,expectedDifferences:rules,calculationVersion:"synthetic-shadow-v1",
  history:(batch,source)=>{
   const es=episodes.filter(e=>e.policy.domainId===source.domainId);
   return createEvaluationHistoryLoader(batch.db,batch.context,source.domainId,es,verification??{verifyCoverage:async s=>coverage(s,es)});
  }});
 return {actor,req,context,configurations,episodes,recipes,unit,make,asOf,coverage};
}
async function run(x:Awaited<ReturnType<typeof setup>>,service=x.make()):Promise<PolicyShadowReport>{
 const report=await service.run(x.req);expect(report.status).toBe("completed");
 return PolicyShadowReportSchema.parse(report);
}
const meditation=(r:PolicyShadowReport)=>r.rows.find(r=>r.slug==="meditation")!;
async function rawSources(org:string){
 const state:Record<string,unknown>={};
 for(const table of ["sessions","session_edits","user_settings","deviations"])
  state[table]=(await f.client.query(`SELECT to_jsonb(t) r FROM public.${table} t WHERE user_id IN
   (SELECT user_id FROM organization_members WHERE org_id=$1) ORDER BY to_jsonb(t)::text`,[org])).rows;
 for(const table of ["domains","policy_versions","dimension_definitions","source_bindings","observations","deviations_v2","deviation_domains"])
  state[table]=(await f.client.query(`SELECT to_jsonb(t) r FROM public.${table} t WHERE org_id=$1 ORDER BY to_jsonb(t)::text`,[org])).rows;
 return state;
}
it("runs actual legacy/new engines and existing writer, keeps private raw data out, and replays idempotently",async()=>{
 const x=await setup([8,10,14].map(d=>({id:"day-"+d,minutes:10,at:`2026-01-${d}T12:00:00Z`})));
 const read=new LegacyHistoryReads(pool,()=>new Date(now)),before=policyResponse(await read.current(x.actor,14));
 const raw=await rawSources(x.context.orgId),first=await run(x),m=meditation(first);
 expect(m.legacy).toMatchObject({actualMinutes:30,actualQualifyingDays:3,healthScore:52});
 // (60 + 300/7) / 2 = 360/7; legacy rounds duration first.
 expect(m.next?.healthScore).toBeCloseTo(360/7,12);
 expect(first.comparisonVerdict).toBe("review_required");
 expect(first.summary).toMatchObject({totalRows:4,supportedComparisons:4,matches:3,defects:1,unavailable:0,legacyUnsupported:0});
 expect(first.comparisonCoverage).toEqual({comparedMetrics:["actual_qualifying_days","actual_minutes","health_score"],
  derivedStatusContracts:"retained_as_evidence_not_compared_for_equivalence",
  retiredBudgetContract:"legacy_error_budget_retired_without_health_score_equivalence"});
 expect(PolicyShadowReportSchema.safeParse({...first,comparisonVerdict:"clear_for_declared_metrics"}).success).toBe(false);
 expect(m.outcome).toBe("DEFECT");expect(m.differences).toMatchObject([{metric:"health_score",outcome:"DEFECT"}]);
 expect(m.provenance?.completedSessionIds).toHaveLength(3);
 expect(JSON.stringify(first)).not.toContain("private note");expect(JSON.stringify(first)).not.toContain("private anomaly");
 expect(await rawSources(x.context.orgId)).toEqual(raw);
 expect(policyResponse(await read.current(x.actor,14))).toEqual(before);
 const saved=(await f.client.query("SELECT result_id,input_fingerprint,result FROM evaluation_results WHERE org_id=$1 ORDER BY domain_id",[x.context.orgId])).rows;
 expect(saved).toHaveLength(4);expect(saved.every(r=>r.result.kind==="trusted-evaluation-v1")).toBe(true);
 const second=await run(x);
 expect(second.rows.every(r=>r.next?.persistenceAction==="unchanged")).toBe(true);
 expect((await f.client.query("SELECT result_id,input_fingerprint,result FROM evaluation_results WHERE org_id=$1 ORDER BY domain_id",[x.context.orgId])).rows).toEqual(saved);
});
it("applies one finite exact reviewed rule, clones registries, and rejects unrelated or ambiguous differences",async()=>{
 const x=await setup([8,10,14].map(d=>({id:"day-"+d,minutes:10,at:`2026-01-${d}T12:00:00Z`})));
 const first=await run(x),s=meditation(first).provenance!.scope;
 // Expected values are independent literal arithmetic above, not copied from output.
 const rules:ExpectedDifferenceRule[]=[{ruleId:"fixture-step9-full-precision",version:"1",
  decisionCitation:"docs/step9-measurement-rules.md#approved-health-and-overachievement-arithmetic",
  scope:s,metric:"health_score",legacy:52,next:360/7}];
 const originalVersion=x.recipes[0].version,service=x.make(rules);rules[0].next=0;x.recipes[0].version="later unreviewed";
 expect(meditation(await run(x,service)).outcome).toBe("EXPECTED-DESIGN-CHANGE");
 x.recipes[0].version=originalVersion;
 const duplicated={...rules[0],next:360/7};
 const ambiguous=x.make([duplicated,{...duplicated,ruleId:"second-fixture-decision"}]);
 expect(meditation(await run(x,ambiguous)).differences[0]).toMatchObject({outcome:"DEFECT",reason:"ambiguous_rules"});
});
it("every run reconciles before provider/engine/write and stops drift",async()=>{
 const x=await setup(),provider=vi.fn();
 const service=createPolicyShadowService({enabled:true,unit:x.unit,history:provider,recipes:x.recipes,
  calculationVersion:"synthetic-shadow-v1",expectedDifferences:[]});
 await f.client.query("UPDATE observations SET observation=jsonb_set(observation,'{notes}','\"unverified drift\"') WHERE owner_user_id=$1",[x.actor]);
 const before=(await f.client.query("SELECT count(*)::int n FROM evaluation_results WHERE org_id=$1",[x.context.orgId])).rows[0].n;
 expect(await service.run(x.req)).toMatchObject({status:"batch-blocked",reason:"reconciliation_failed"});
 expect(provider).not.toHaveBeenCalled();
 expect((await f.client.query("SELECT count(*)::int n FROM evaluation_results WHERE org_id=$1",[x.context.orgId])).rows[0].n).toBe(before);
});
it("a forged history provider is rejected and missing origin/recipe proof remains unavailable",async()=>{
 const x=await setup();
 const forged=createPolicyShadowService({enabled:true,unit:x.unit,history:()=>({load:async()=>({})}) as any,
  recipes:x.recipes,calculationVersion:"synthetic-shadow-v1",expectedDifferences:[]});
 await expect(forged.run(x.req)).rejects.toMatchObject({status:503});
 const noProof=await run(x,x.make([],x.recipes,{verifyCoverage:async()=>null}));
 expect(noProof.rows.every(r=>r.outcome==="unavailable"&&r.next===null)).toBe(true);
 expect(noProof.comparisonVerdict).toBe("review_required");expect(noProof.summary).toMatchObject({unavailable:4,supportedComparisons:0});
 const noRecipe=await run(x,x.make([],[]));
 expect(noRecipe.rows.every(r=>r.outcome==="unavailable"&&r.next===null)).toBe(true);
 expect((await f.client.query("SELECT count(*)::int n FROM evaluation_results WHERE org_id=$1",[x.context.orgId])).rows[0].n).toBe(0);
});
it("uses actual served settings and refuses an aligned-looking new-policy substitute",async()=>{
 const x=await setup();await f.client.query("UPDATE user_settings SET day_start_hour=4 WHERE user_id=$1",[x.actor]);
 const report=await run(x);
 expect(report.rows.every(r=>r.outcome==="unavailable"&&r.reason==="legacy_and_new_window_configuration_differ")).toBe(true);
 expect(report.rows[0].windowConfiguration).toEqual({legacy:{windowDays:7,boundary:{timezone:"UTC",dayStartHour:4}},
  next:{windowDays:7,boundary:{timezone:"UTC",dayStartHour:0}}});
 expect(report.comparisonVerdict).toBe("review_required");
 expect(report.summary).toMatchObject({supportedComparisons:0,unavailable:4,defects:0});
 expect((await f.client.query("SELECT count(*)::int n FROM evaluation_results WHERE org_id=$1",[x.context.orgId])).rows[0].n).toBe(0);
});
it("retains subfloor minutes without pooling qualification, deleted evidence, Today/future and served anomaly semantics",async()=>{
 const x=await setup([{id:"small-a",minutes:5,at:"2026-01-08T12:00:00Z"},
  {id:"small-b",minutes:5,at:"2026-01-08T16:00:00Z"},{id:"anomaly",minutes:10,at:"2026-01-10T12:00:00Z",anomaly:true},
  {id:"deleted",minutes:10,at:"2026-01-11T12:00:00Z",deleted:true},
  {id:"today",minutes:10,at:"2026-01-15T10:00:00Z"},{id:"future",minutes:10,at:"2026-01-16T10:00:00Z"}]);
 const m=meditation(await run(x));
 expect(m.legacy).toMatchObject({actualMinutes:20,actualQualifyingDays:1});
 expect(m.next).toMatchObject({actualMinutes:20,actualQualifyingDays:1});
 expect(m.provenance?.sourceSessionIds).toHaveLength(7);
 expect(m.provenance?.deletedSessionIds).toEqual([x.actor+"-deleted"]);
 expect(m.provenance?.anomalySessionIds).toEqual([x.actor+"-anomaly"]);
 expect(m.provenance?.completedSessionIds).toHaveLength(3);
});
it("custom/native domain evidence is explicitly unsupported without inventing a legacy score",async()=>{
 const x=await setup(),c=structuredClone(x.configurations[0]);
 Object.assign(c,{domainId:"synthetic-custom-"+x.actor,policyVersionId:"synthetic-custom-policy-"+x.actor,displayName:"Custom"});
 c.targets.normal.targetId="custom-target";c.effectiveFrom="2026-01-01T00:00:00Z";
 await createPolicyV2Storage(f.db,x.context,{clock:()=>new Date("2025-12-31T00:00:00Z")}).domains
  .createWithPolicy({domainId:c.domainId,slug:"synthetic-custom",displayName:"Custom"},c,"Synthetic custom domain");
 const report=await run(x),custom=report.rows.find(r=>r.domainId===c.domainId)!;
 expect(custom).toMatchObject({outcome:"legacy-unsupported",legacy:null,next:null});
 expect(report.comparisonVerdict).toBe("review_required");expect(report.summary).toMatchObject({totalRows:5,legacyUnsupported:1});
});
it("late source drift after a previously successful batch cannot replay prior reconciliation",async()=>{
 const x=await setup();await run(x);
 const provider=vi.fn(),service=createPolicyShadowService({enabled:true,unit:x.unit,history:provider,recipes:x.recipes,
  calculationVersion:"synthetic-shadow-v1",expectedDifferences:[]});
 await f.client.query("UPDATE sessions SET duration_minutes=2 WHERE user_id=$1 AND domain='music'",[x.actor]);
 expect(await service.run(x.req)).toMatchObject({status:"batch-blocked",reason:"reconciliation_failed"});
 expect(provider).not.toHaveBeenCalled();
});

async function frequencyRevision(x:Awaited<ReturnType<typeof setup>>,required:number,events:Practice[]=[]){
 const old=x.configurations.find(c=>c.displayName==="meditation")!,c=structuredClone(old);
 Object.assign(c,{policyVersionId:old.policyVersionId+"-revision-2",previousVersionId:old.policyVersionId,revision:2,
  effectiveFrom:"2026-01-08T00:00:00Z"});
 const target=c.targets.normal.conditions.find(t=>c.measurements.find(m=>m.measurementId===t.measurementId)?.kind==="frequency")!;
 if(target.valueType==="boolean"||target.constraint.operator!=="gte")throw Error("fixture target");
 target.constraint.value=required;
 await createPolicyV2Storage(f.db,x.context,{clock:()=>new Date("2026-01-07T00:00:00Z")}).policies.append(c,"Synthetic reviewed frequency revision");
 x.episodes.find(e=>e.policy.domainId===old.domainId)!.effectiveEnd=c.effectiveFrom;
 x.episodes.push({episodeId:"synthetic-revision-episode-"+c.domainId,policy:c,windowDays:7,targetId:c.targets.normal.targetId,
  frequencyMeasurementId:c.measurements.find(m=>m.kind==="frequency")!.measurementId,
  origin:{at:c.effectiveFrom,sourceId:"synthetic-reconciled-revision-"+c.domainId,kind:"verified-effective-policy-origin"},effectiveEnd:null});
 const prior=x.recipes.find(r=>r.domainId===c.domainId)!;
 x.recipes.push({...structuredClone(prior),recipeId:prior.recipeId+"-revision-2",policyVersionId:c.policyVersionId,
  components:c.targets.normal.conditions.map(t=>({...structuredClone(prior.components.find(p=>p.measurement.measurementId===t.measurementId)!),
   targetCondition:structuredClone(t)}))});
 const mutations=createLegacyActivityMutations(createPinnedOwnershipUnit(pool));
 for(const event of events)await mutations.create(x.req,{domain:"meditation",durationMinutes:event.minutes,timestamp:event.at});
 return c;
}
it.each([
 {required:1,asOf:"2026-01-15T12:00:00Z",days:[],cadence:"Nominal"},
 {required:1,asOf:"2026-01-16T12:00:00Z",days:[],cadence:"RhythmSlipping"},
 {required:3,asOf:"2026-01-16T12:00:00Z",days:[15],cadence:"Breach"},
 {required:3,asOf:"2026-01-17T12:00:00Z",days:[15,16],cadence:"Warning"},
 {required:3,asOf:"2026-01-18T12:00:00Z",days:[15,16,17],cadence:"Nominal"},
 {required:5,asOf:"2026-01-15T12:00:00Z",days:[8,9,10,11,12],cadence:"RhythmSlipping"},
])("actual pinned comparison preserves $required/7 cadence at $asOf: $cadence",async c=>{
 const x=await setup([],undefined,c.asOf);
 await frequencyRevision(x,c.required,c.days.map(d=>({id:"q"+d,minutes:10,at:`2026-01-${d}T12:00:00Z`})));
 const m=meditation(await run(x));
 expect(m.next?.derived.cadence).toBe(c.cadence);
 expect(m.next?.actualQualifyingDays).toBe(c.days.filter(d=>Date.parse(`2026-01-${d}T12:00:00Z`)<
  Date.parse(c.asOf.slice(0,10)+"T00:00:00Z")&&Date.parse(`2026-01-${d}T12:00:00Z`)>=
  Date.parse(c.asOf.slice(0,10)+"T00:00:00Z")-7*86400000).length);
 expect(m.provenance?.scope.policyVersionId).toContain("revision-2");
 expect(m.provenance?.originEvidenceIds).toHaveLength(2);
});
it("historical policies remain visible and a window crossing versions has no fabricated aggregate",async()=>{
 const x=await setup([],undefined,"2026-01-12T12:00:00Z");await frequencyRevision(x,3);
 const m=meditation(await run(x));
 expect(m).toMatchObject({outcome:"unavailable",legacy:null,next:null});
 expect(m.sourceEvidence?.policyVersionIds).toHaveLength(2);
 expect((await f.client.query("SELECT count(*)::int n FROM evaluation_results WHERE org_id=$1 AND domain_id=$2",
  [x.context.orgId,x.configurations.find(c=>c.displayName==="meditation")!.domainId])).rows[0].n).toBe(0);
});
it("an exception without separately reviewed interpretation stays unavailable",async()=>{
 const x=await setup();
 await f.client.query(`INSERT INTO deviations(id,user_id,domain,reason,start_at,end_at,exclude_from_composite)
  VALUES($1,$2,'meditation','Synthetic unapproved interpretation','2026-01-10T00:00:00Z','2026-01-10T12:00:00Z',false)`,
  [x.actor+"-break",x.actor]);
 const m=meditation(await run(x));expect(m).toMatchObject({outcome:"unavailable",next:null});
});
it("a separately verified DST exemption preserves fractional eligible-day arithmetic",async()=>{
 const x=await setup([{id:"march-4",minutes:10,at:"2026-03-04T17:00:00Z"},
  {id:"march-6",minutes:10,at:"2026-03-06T17:00:00Z"},{id:"march-9",minutes:10,at:"2026-03-09T16:00:00Z"}],
  {timezone:"America/New_York",hour:0,days:7},"2026-03-10T12:00:00Z");
 await f.client.query(`INSERT INTO deviations(id,user_id,domain,reason,start_at,end_at,exclude_from_composite)
  VALUES($1,$2,'meditation','Synthetic independently reviewed break','2026-03-08T05:00:00Z','2026-03-08T16:00:00Z',false)`,
  [x.actor+"-dst-break",x.actor]);
 const unit=x.unit,service=createPolicyShadowService({enabled:true,unit,recipes:x.recipes,expectedDifferences:[],
  calculationVersion:"synthetic-shadow-v1",history:(batch,source)=>{
   const es=x.episodes.filter(e=>e.policy.domainId===source.domainId);
   return createEvaluationHistoryLoader(batch.db,batch.context,source.domainId,es,{
    verifyCoverage:async s=>({receiptId:"fixture-dst-genesis",snapshotId:s.snapshotId,
     snapshotFingerprint:evaluationHistoryFingerprint(s),scope:s.scope,completeFrom:"2026-01-01T00:00:00Z",
     completeThrough:s.capturedAt,counts:{configurations:s.configurations.length,observations:s.observations.length,
      corrections:s.corrections.length,breaks:s.breaks.length},
     origins:es.map(e=>({episodeId:e.episodeId,at:e.origin.at,sourceId:e.origin.sourceId,evidenceId:"fixture-dst-created-empty",
      kind:"verified-empty-domain-activation"}))}),
    resolveBreaks:async evidence=>({evidenceId:"fixture-reviewed-DST-interpretation",
     dispositions:evidence.legacyDeviations.map((d:any)=>({source:"legacy",id:d.id,fingerprint:historyBreakFingerprint(d),
      kind:d.domain===source.slug?"approved-exempt":"not-applicable"})),
     breaks:evidence.legacyDeviations.filter((d:any)=>d.domain===source.slug).map((d:any)=>({breakId:d.id,
      scope:{organizationId:batch.context.orgId,ownerUserId:batch.context.actorUserId,domainId:source.domainId},
      interval:{start:"2026-03-08T05:00:00Z",end:"2026-03-08T16:00:00Z"},
      source:{kind:"legacy",id:d.id,fingerprint:historyBreakFingerprint(d)}}))}),
   });
  }});
 const m=meditation(await run(x,service));
 // Spring-forward Sunday has 23 hours; 11 exempt hours leave E=7-11/23=150/23.
 expect(m.provenance?.eligibleDays).toBeCloseTo(150/23,12);
 expect(m.next).toMatchObject({actualMinutes:30,actualQualifyingDays:3});
 // Quantity expected=70*(150/23)/7 and frequency expected=5*(150/23)/7.
 expect(m.next?.healthScore).toBeCloseTo(((30/(1500/23))+(3/(750/161)))*50,12);
 expect(m.provenance?.breakEvidenceIds).toEqual([x.actor+"-dst-break"]);
});
it("legitimate native activity in a legacy-bound domain is explicit unsupported comparison",async()=>{
 const x=await setup(),c=x.configurations.find(c=>c.displayName==="meditation")!;
 const measurement=c.measurements.find(m=>m.kind==="duration")!;
 await createPolicyV2Storage(f.db,x.context,{clock:()=>new Date(now)}).observations.create({
  observation:{schemaVersion:1,observationId:x.actor+"-native",organizationId:c.organizationId,ownerUserId:c.ownerUserId,
   domainId:c.domainId,policyVersionId:c.policyVersionId,observedAt:"2026-01-10T12:00:00Z",
   values:{[measurement.measurementId]:{valueType:"number",unitId:"minute",value:10}}},idempotencyKey:"fixture-native"},
  "Synthetic legitimate native evidence");
 const m=meditation(await run(x));
 expect(m).toMatchObject({outcome:"legacy-unsupported",legacy:null,next:null});
 expect(m.sourceEvidence?.nativeObservationIds).toEqual([x.actor+"-native"]);
});

it("trusted provider receives detached metadata and cannot accidentally replace the captured comparison inputs",async()=>{
 const x=await setup([{id:"unchanged-practice",minutes:10,at:"2026-01-10T12:00:00Z"}]);
 const service=createPolicyShadowService({enabled:true,unit:x.unit,recipes:x.recipes,expectedDifferences:[],
  calculationVersion:"synthetic-shadow-v1",history:(view,source)=>{
   const domainId=source.domainId,es=x.episodes.filter(e=>e.policy.domainId===domainId);
   view.asOf="2026-02-01T12:00:00Z";view.legacyOptions.windowDays=42;view.legacyOptions.timezone="America/New_York";
   if(source.legacySessions.length)source.legacySessions[0].durationMinutes=999;
   view.sources.splice(0,view.sources.length);
   return createEvaluationHistoryLoader(view.db,view.context,domainId,es,{verifyCoverage:async s=>x.coverage(s,es)});
  }});
 const report=await run(x,service),m=meditation(report);
 expect(report.asOf).toBe(now);expect(m.legacy?.actualMinutes).toBe(10);
 expect(m.next?.actualMinutes).toBe(10);expect(m.provenance?.scope.windowDays).toBe(7);
 expect(m.provenance?.scope.boundary).toEqual({timezone:"UTC",dayStartHour:0});
 expect(report.rows).toHaveLength(4);
});

it("a completed report is clear only for its declared metrics when every domain has a supported comparison",async()=>{
 const x=await setup(),report=await run(x);
 expect(report.status).toBe("completed");expect(report.comparisonVerdict).toBe("clear_for_declared_metrics");
 expect(report.summary).toEqual({totalRows:4,supportedComparisons:4,matches:4,expectedDesignChanges:0,defects:0,unavailable:0,legacyUnsupported:0});
 expect(report.comparisonCoverage.derivedStatusContracts).toBe("retained_as_evidence_not_compared_for_equivalence");
});
it("a legitimate reviewed new window retains both actual configurations and makes comparison unavailable",async()=>{
 const x=await setup(),c=x.configurations.find(c=>c.displayName==="meditation")!;
 x.episodes.find(e=>e.policy.domainId===c.domainId)!.windowDays=14;
 const report=await run(x),m=meditation(report);
 expect(m).toMatchObject({outcome:"unavailable",reason:"legacy_and_new_window_configuration_differ",legacy:null,next:null,
  windowConfiguration:{legacy:{windowDays:7,boundary:{timezone:"UTC",dayStartHour:0}},
   next:{windowDays:14,boundary:{timezone:"UTC",dayStartHour:0}}}});
 expect(report.summary).toMatchObject({totalRows:4,supportedComparisons:3,unavailable:1,defects:0});
 expect(report.comparisonVerdict).toBe("review_required");
});
