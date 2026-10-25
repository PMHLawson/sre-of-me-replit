import { beforeAll,afterAll,beforeEach,describe,it,expect } from "vitest";
import { startFixture,verifyFixture } from "../lib/ownership-fixture";
import { Pool,type PoolClient } from "pg";
import { createPinnedOwnershipUnit } from "../lib/pinned-ownership-unit";
import { createOrgContextResolver,type OrgContext } from "../lib/org-context";
import { createPolicyV2Storage } from "../storage/policy-v2-storage";
import { configurationFor,observationFor,MEASUREMENTS,conditionFor } from "../../shared/fixtures/domain-config-cases";
import type { DomainConfiguration,MeasurementDefinition } from "../../shared/domain-config";
import type { CadenceEpisode } from "../../shared/cadence-derived";
import { createEvaluationHistoryLoader,evaluationHistoryFingerprint,historyBreakFingerprint,
  type HistorySnapshot,type HistoryCoverageReceipt,type HistoryVerification } from "./evaluation-history-v2";
import { createEvaluationPersistence } from "./evaluation-persistence-v2";
import type { EvaluationRecipe } from "../../shared/evaluator-recipe";
import { createEvaluator } from "../../shared/pure-evaluator";
import { CADENCE_VERSION } from "../../shared/cadence-derived";

describe("authenticated complete history and exact policy segmentation",()=>{
  let f:Awaited<ReturnType<typeof startFixture>>;
  let context:OrgContext,other:OrgContext,config:DomainConfiguration,episode:CadenceEpisode;
  let scoringConfig:DomainConfiguration,scoringEpisode:CadenceEpisode;
  const now="2026-01-15T12:00:00Z";
  const frequency:MeasurementDefinition={measurementId:"frequency",displayName:"Qualifying days",meaning:"Days with qualifying practice",
    role:"practice",comparisonDirection:"higher_is_better",kind:"frequency",valueType:"integer",
    unit:{unitId:"day",dimension:"days"},aggregation:"count",countBy:"distinct_days",scope:{kind:"period",windowDays:7}};
  function receipt(snapshot:HistorySnapshot,episodes:CadenceEpisode[]=[episode]):HistoryCoverageReceipt{
    return {receiptId:"synthetic-independent-fixture-origin",snapshotId:snapshot.snapshotId,
      snapshotFingerprint:evaluationHistoryFingerprint(snapshot),scope:snapshot.scope,
      completeFrom:"2026-01-01T00:00:00Z",completeThrough:snapshot.capturedAt,
      counts:{configurations:snapshot.configurations.length,observations:snapshot.observations.length,
        corrections:snapshot.corrections.length,breaks:snapshot.breaks.length},
      origins:episodes.map(e=>({episodeId:e.episodeId,at:e.origin.at,sourceId:e.origin.sourceId,
        evidenceId:e.origin.at==="2026-01-01T00:00:00Z"?"fixture-created-empty-before-recording":"fixture-policy-source-reconciled",
        kind:e.origin.at==="2026-01-01T00:00:00Z"?"verified-empty-domain-activation":"verified-source-reconciliation"}))};
  }
  const verifier=(episodes:CadenceEpisode[]=[episode]):HistoryVerification=>({
    // Synthetic fixture genesis is known here; a production callback must read
    // an independent activation/import receipt, not reproduce this test oracle.
    verifyCoverage:async s=>receipt(s,episodes),
  });
  const loader=(verification:HistoryVerification=verifier(),episodes:CadenceEpisode[]=[episode])=>
    createEvaluationHistoryLoader(f.db,context,config.domainId,episodes,verification);
  const scoringLoader=(verification:HistoryVerification=verifier([scoringEpisode]))=>
    createEvaluationHistoryLoader(f.db,context,scoringConfig.domainId,[scoringEpisode],verification);
  beforeAll(async()=>{
    f=await startFixture("evaluation-history");
    await f.client.query(`INSERT INTO users(id) VALUES ('history-owner'),('history-other'),('history-peer');
      INSERT INTO organizations(org_id,display_name) VALUES ('history-org','History'),('history-other-org','Other');
      INSERT INTO organization_members(org_id,user_id,role) VALUES
        ('history-org','history-owner','owner'),('history-other-org','history-other','owner'),('history-org','history-peer','member');`);
    context=await createOrgContextResolver(f.db)({isAuthenticated:()=>true,user:{claims:{sub:"history-owner"}}});
    other=await createOrgContextResolver(f.db)({isAuthenticated:()=>true,user:{claims:{sub:"history-other"}}});
  },60000);
  beforeEach(async()=>{
    await f.client.query(`DELETE FROM public.audit_events;DELETE FROM public.evaluation_results;DELETE FROM public.source_bindings;
      DELETE FROM public.deviation_domains;DELETE FROM public.deviations_v2;DELETE FROM public.deviations;
      DELETE FROM public.observations;DELETE FROM public.dimension_definitions;DELETE FROM public.policy_versions;
      DELETE FROM public.domains;DELETE FROM public.owner_write_resource_budgets;`);
    config=configurationFor("history",MEASUREMENTS[0],10);
    Object.assign(config,{organizationId:context.orgId,ownerUserId:context.actorUserId,
      domainId:"history-domain",policyVersionId:"history-policy",effectiveFrom:"2026-01-01T00:00:00Z",
      boundary:{timezone:"UTC",dayStartHour:0}});
    config.measurements.push(frequency);
    config.targets.normal.conditions.push(conditionFor(frequency,5));
    config.qualification={kind:"condition",condition:conditionFor(config.measurements[0],10)};
    episode={episodeId:"history-episode",policy:structuredClone(config),windowDays:14,targetId:config.targets.normal.targetId,
      frequencyMeasurementId:frequency.measurementId,origin:{at:config.effectiveFrom,sourceId:"fixture-complete-source",
        kind:"verified-effective-policy-origin"},effectiveEnd:null};
    const store=createPolicyV2Storage(f.db,context,{clock:()=>new Date("2025-12-31T00:00:00Z")});
    await store.domains.createWithPolicy({domainId:config.domainId,slug:"history",displayName:config.displayName},config,"Synthetic setup");
    scoringConfig=configurationFor("history-scoring",structuredClone(MEASUREMENTS[0]),50);
    Object.assign(scoringConfig,{organizationId:context.orgId,ownerUserId:context.actorUserId,
      domainId:"history-scoring-domain",policyVersionId:"history-scoring-policy",effectiveFrom:"2026-01-01T00:00:00Z",
      boundary:{timezone:"UTC",dayStartHour:0}});
    const durationTarget=scoringConfig.targets.normal.conditions[0];
    durationTarget.basis={kind:"period",windowDays:7};
    durationTarget.periodAggregation={sourceBasis:"per_event",method:"sum"};
    scoringConfig.measurements.push(frequency);
    scoringConfig.targets.normal.conditions.push(conditionFor(frequency,5));
    scoringConfig.qualification={kind:"condition",condition:conditionFor(MEASUREMENTS[0],10)};
    scoringEpisode={episodeId:"history-scoring-episode",policy:structuredClone(scoringConfig),windowDays:14,
      targetId:scoringConfig.targets.normal.targetId,frequencyMeasurementId:frequency.measurementId,
      origin:{at:scoringConfig.effectiveFrom,sourceId:"fixture-scoring-source",kind:"verified-effective-policy-origin"},
      effectiveEnd:null};
    await store.domains.createWithPolicy({domainId:scoringConfig.domainId,slug:"history-scoring",
      displayName:scoringConfig.displayName},scoringConfig,"Synthetic scoring setup");
  });
  afterAll(async()=>{if(f)await f.cleanup();},60000);
  async function add(id:string,at:string,amount=10,c=config){
    const store=createPolicyV2Storage(f.db,context,{clock:()=>new Date("2025-12-31T00:00:00Z")});
    await store.observations.create({observation:{...observationFor(c,id,amount),observedAt:at},idempotencyKey:id},"Synthetic event");
  }
  async function addScoring(id:string,at:string,amount=10){
    const store=createPolicyV2Storage(f.db,context,{clock:()=>new Date("2025-12-31T00:00:00Z")});
    await store.observations.create({observation:{...observationFor(scoringConfig,id,amount),observedAt:at},
      idempotencyKey:id},"Synthetic scoring event");
  }
  function scoringRecipe(c:DomainConfiguration=scoringConfig):EvaluationRecipe{
    return {recipeId:"synthetic-reviewed-history-recipe",version:"1",organizationId:context.orgId,
      ownerUserId:context.actorUserId,domainId:c.domainId,policyVersionId:c.policyVersionId,
      targetId:c.targets.normal.targetId,targetSelection:"normal",qualification:c.qualification??null,
      components:c.targets.normal.conditions.map(target=>{
        const measurement=c.measurements.find(m=>m.measurementId===target.measurementId)!;
        return {measurement:structuredClone(measurement),targetCondition:structuredClone(target),weight:0.5,mandatory:true,
          percentage:"positive-linear-ratio-v1" as const,
          actual:measurement.kind==="frequency"?"distinct-qualifying-days" as const:"sum-events" as const};
      })};
  }
  function persistenceWriter(recipe=scoringRecipe(),history=scoringLoader()){
    return createEvaluationPersistence({db:f.db,context,domainId:scoringConfig.domainId,history,
      recipes:[recipe],calculationVersion:"somr433-persist-v1",clock:()=>new Date(now)});
  }

  async function concurrentPersistenceSaves(){
    verifyFixture(f.root); // before constructing this synthetic Unix-socket-only pool
    const pool=new Pool({host:f.root+"/socket",port:5432,user:"synthetic",database:"postgres",password:"",ssl:false,
      max:2,connectionTimeoutMillis:5000,options:"-c statement_timeout=10000 -c lock_timeout=2000"});
    const clients:PoolClient[]=[],handedOff=new Set<PoolClient>();
    try{
      // Hold both leases before either operation starts: a shared fixture client
      // cannot interleave BEGIN/COMMIT, and the pool cannot reuse one backend.
      clients.push(await pool.connect());clients.push(await pool.connect());
      const pids=await Promise.all(clients.map(async client=>
        (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number));
      expect(new Set(pids).size).toBe(2);
      const request={isAuthenticated:()=>true,user:{claims:{sub:context.actorUserId}}};
      const attempts=await Promise.allSettled(clients.map(async(client,index)=>{
        const unit=createPinnedOwnershipUnit({connect:async()=>{handedOff.add(client);return client;}});
        return unit.run(request,async current=>{
          expect((await current.tx.query("SELECT pg_backend_pid() AS pid")).rows[0].pid).toBe(pids[index]);
          // Every run resolves its own authenticated capability and binds a fresh
          // history loader and writer to that operation's database/transaction.
          const history=createEvaluationHistoryLoader(current.db,current.context,scoringConfig.domainId,
            [scoringEpisode],verifier([scoringEpisode]));
          const writer=createEvaluationPersistence({db:current.db,context:current.context,
            domainId:scoringConfig.domainId,history,recipes:[scoringRecipe()],
            calculationVersion:"somr433-persist-v1",clock:()=>new Date(now)});
          return writer.calculateAndSave();
        });
      }));
      expect(attempts.filter(result=>result.status==="fulfilled")).toHaveLength(2);
      return attempts.map(result=>{
        if(result.status!=="fulfilled")throw result.reason;
        return result.value;
      });
    }finally{
      // Pinned units release handed-off leases on success and failure. If setup
      // failed before handoff, release its leases here, then close this pool
      // before the fixture's existing owned-Postgres cleanup runs.
      for(const client of clients)if(!handedOff.has(client))client.release();
      await pool.end();
      expect(pool.totalCount).toBe(0);
    }
  }
  async function state(){
    return (await f.client.query(`SELECT jsonb_build_object('observations',(SELECT jsonb_agg(to_jsonb(o)) FROM observations o),
      'audit',(SELECT jsonb_agg(to_jsonb(a)) FROM audit_events a),'policy',(SELECT jsonb_agg(to_jsonb(p)) FROM policy_versions p),
      'evaluations',(SELECT jsonb_agg(to_jsonb(e)) FROM evaluation_results e),
      'budgets',(SELECT jsonb_agg(to_jsonb(b)) FROM owner_write_resource_budgets b)) AS data`)).rows[0].data;
  }
  it("requires the authentic capability, never a copied owner identity",()=>{
    expect(()=>createEvaluationHistoryLoader(f.db,{...context},config.domainId,[episode],verifier())).toThrow();
  });
  it("reads the complete scoped database snapshot without changing rows",async()=>{
    await add("event-a","2026-01-10T12:00:00Z");
    const before=await state(),result=await loader().load(now);
    expect(await state()).toEqual(before);
    expect(result.status).toBe("available");
    expect(result.completeness).toEqual({kind:"verified-by-injected-server-source",databaseIntegration:"scoped-read-loader"});
    expect(result.evidence.snapshot?.databaseEvidence?.kind).toBe("one-statement-owner-domain-snapshot-v1");
    expect(result.evidence.dispositions).toHaveLength(1);
    expect(result.segments[0].history?.coveredFrom).toBe(config.effectiveFrom);
    expect(result.segments[0].history?.coveredThrough).toBe("2026-01-15T00:00:00.000Z");
    expect(result.evidence.snapshot?.corrections.length).toBeGreaterThan(0);
  });
  it("does not let another authenticated account read the domain",async()=>{
    await expect(createEvaluationHistoryLoader(f.db,other,config.domainId,[episode],verifier()).load(now)).rejects.toMatchObject({status:404});
  });
  it("revalidates membership within the same database operation",async()=>{
    const read=loader();
    await f.client.query("UPDATE organization_members SET role='member' WHERE org_id=$1 AND user_id=$2",[context.orgId,context.actorUserId]);
    await expect(read.load(now)).rejects.toMatchObject({status:403});
    await f.client.query("UPDATE organization_members SET role='owner' WHERE org_id=$1 AND user_id=$2",[context.orgId,context.actorUserId]);
    context=await createOrgContextResolver(f.db)({isAuthenticated:()=>true,user:{claims:{sub:context.actorUserId}}});
  });
  it("does not infer an origin from review dates, first practice or a sourceId",async()=>{
    await add("late-first-event","2026-01-10T12:00:00Z");
    const result=await loader({verifyCoverage:async()=>null}).load(now);
    expect(result).toMatchObject({status:"unavailable",reason:"history_coverage_unverified"});
    expect(result.evidence.dispositions).toHaveLength(1);
    expect(result.segments).toEqual([]);
  });
  it.each(["fingerprint","count","origin","through"] as const)("refuses a mismatched %s receipt",async(field)=>{
    const result=await loader({verifyCoverage:async s=>{
      const r=receipt(s);
      if(field==="fingerprint")r.snapshotFingerprint="0".repeat(64);
      if(field==="count")r.counts.observations++;
      if(field==="origin")r.origins[0].at="2026-01-02T00:00:00Z";
      if(field==="through")r.completeThrough="2026-01-14T00:00:00Z";
      return r;
    }}).load(now);
    expect(result).toMatchObject({status:"unavailable",reason:"history_coverage_receipt_mismatch"});
  });
  it("retains below-floor, Today and future records, without pooling qualification",async()=>{
    await add("small-one","2026-01-10T12:00:00Z",5);
    await add("small-two","2026-01-10T16:00:00Z",5);
    await add("today","2026-01-15T10:00:00Z");
    await add("future","2026-01-16T10:00:00Z");
    const result=await loader().load(now);
    expect(result.evidence.dispositions.map(d=>d.kind)).toEqual(["future","completed","completed","today"]);
    expect(result.segments[0].history?.observations).toHaveLength(4);
    expect(result.segments[0].cadence.status).toBe("available");
    if(result.segments[0].cadence.status==="available"){
      expect(result.segments[0].cadence.inspection.qualifyingDays).toBe(1);
      expect(result.segments[0].cadence.evidence.futureObservationIds).toEqual(["future"]);
    }
  });
  it("preserves a deleted record and its correction history, without day credit",async()=>{
    await add("deleted-event","2026-01-10T12:00:00Z");
    const store=createPolicyV2Storage(f.db,context);
    await store.observations.delete(["deleted-event"],"Synthetic delete");
    const result=await loader().load(now);
    expect(result.evidence.dispositions).toMatchObject([{observationId:"deleted-event",kind:"deleted",episodeId:episode.episodeId}]);
    expect(result.segments[0].history?.observations).toHaveLength(0);
    expect(result.evidence.snapshot?.corrections.length).toBeGreaterThanOrEqual(3);
    expect(result.evidence.snapshot?.observations[0].observation).toMatchObject({observationId:"deleted-event"});
  });
  it("malformed or wrong-scope JSON cannot disappear to produce an available score",async()=>{
    await add("bad-context","2026-01-10T12:00:00Z");
    // This unknown measurement is legal JSON/storage identity but fails the
    // effective configuration; no weakening of database tenant constraints.
    await f.client.query(`UPDATE observations SET observation=jsonb_set(observation,'{values}',
      '{"unknown":{"valueType":"number","unitId":"minute","value":10}}'::jsonb) WHERE observation_id='bad-context'`);
    const result=await loader().load(now);
    expect(result.status).toBe("unavailable");
    expect(result.evidence.dispositions).toMatchObject([{observationId:"bad-context",kind:"invalid"}]);
    expect(result.evidence.snapshot?.observations).toHaveLength(1);
    expect(result.evidence.snapshot?.databaseEvidence?.observations).toHaveLength(1);
  });
  it("exact effective boundaries assign a practice to one version and never average versions",async()=>{
    const next=structuredClone(config);
    Object.assign(next,{policyVersionId:"history-policy-v2",revision:2,previousVersionId:config.policyVersionId,
      effectiveFrom:"2026-01-08T00:00:00Z"});
    const store=createPolicyV2Storage(f.db,context,{clock:()=>new Date("2025-12-31T00:00:00Z")});
    await store.policies.append(next,"Synthetic prospective change");
    const old={...episode,effectiveEnd:next.effectiveFrom};
    const second:CadenceEpisode={...episode,episodeId:"history-episode-v2",policy:next,
      origin:{...episode.origin,at:next.effectiveFrom}};
    await add("just-before","2026-01-07T23:59:59.999Z",10,config);
    await add("exact-start","2026-01-08T00:00:00Z",10,next);
    const result=await loader(verifier([old,second]),[old,second]).load(now);
    expect(result.evidence.dispositions.map(d=>[d.observationId,d.episodeId])).toEqual([
      ["exact-start",second.episodeId],["just-before",old.episodeId]]);
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0].history?.coveredThrough).toBe("2026-01-08T00:00:00.000Z");
    expect(result.segments[1].history?.coveredFrom).toBe(next.effectiveFrom);
    expect(result.aggregate).toEqual({status:"unavailable",reason:"cross-version-aggregate-not-approved"});
  });
  it("refuses a record assigned to the old policy at the next policy's exact start",async()=>{
    await add("wrong-version-boundary","2026-01-10T12:00:00Z");
    const next=structuredClone(config);
    Object.assign(next,{policyVersionId:"history-policy-v2",revision:2,previousVersionId:config.policyVersionId,
      effectiveFrom:"2026-01-08T00:00:00Z"});
    // Synthetic corrupted lineage bypasses the application prospective bundle
    // check, while retaining all native row identity constraints.
    await f.client.query(`INSERT INTO policy_versions(policy_version_id,org_id,owner_user_id,domain_id,revision,
      effective_from,previous_version_id,configuration) VALUES($1,$2,$3,$4,2,$5,$6,$7)`,
      [next.policyVersionId,context.orgId,context.actorUserId,config.domainId,next.effectiveFrom,config.policyVersionId,next]);
    // Complete the persisted measurement representation so this fixture isolates
    // its intended boundary/precision failure rather than a missing definition.
    for(const measurement of next.measurements)await f.client.query(`INSERT INTO dimension_definitions
      (org_id,owner_user_id,domain_id,policy_version_id,measurement_id,definition)
      VALUES($1,$2,$3,$4,$5,$6)`,[context.orgId,context.actorUserId,config.domainId,
        next.policyVersionId,measurement.measurementId,measurement]);
    const old={...episode,effectiveEnd:next.effectiveFrom},second:CadenceEpisode={...episode,
      episodeId:"second",policy:next,origin:{...episode.origin,at:next.effectiveFrom}};
    const result=await loader(verifier([old,second]),[old,second]).load(now);
    expect(result).toMatchObject({status:"unavailable",reason:"history_evidence_invalid"});
    expect(result.evidence.dispositions).toMatchObject([{observationId:"wrong-version-boundary",kind:"invalid"}]);
  });
  it("does not guess approval or silently assume the absence of declared breaks",async()=>{
    await f.client.query(`INSERT INTO deviations(id,user_id,domain,reason,start_at,end_at)
      VALUES('legacy-break',$1,'meditation','Synthetic declaration','2026-01-03T00:00:00Z','2026-01-04T00:00:00Z')`,[context.actorUserId]);
    const result=await loader().load(now);
    expect(result).toMatchObject({status:"unavailable",reason:"exception_adapter_unavailable"});
    expect(result.evidence.snapshot?.databaseEvidence?.legacyDeviations).toHaveLength(1);
  });
  it("retains every raw break with a fingerprinted disposition from the trusted adapter",async()=>{
    await f.client.query(`INSERT INTO deviations(id,user_id,domain,reason,start_at,end_at)
      VALUES('legacy-break',$1,'meditation','Synthetic declaration','2026-01-03T00:00:00Z','2026-01-04T00:00:00Z')`,[context.actorUserId]);
    const verification=verifier();
    verification.resolveBreaks=async evidence=>({evidenceId:"synthetic-approved-exception-receipt",
      breaks:[{breakId:"legacy-break",scope:{organizationId:context.orgId,ownerUserId:context.actorUserId,domainId:config.domainId},
        interval:{start:"2026-01-03T00:00:00Z",end:"2026-01-04T00:00:00Z"},
        source:{kind:"legacy",id:"legacy-break",fingerprint:historyBreakFingerprint(evidence.legacyDeviations[0])}}],
      dispositions:evidence.legacyDeviations.map((row:any)=>({source:"legacy",id:row.id,
        fingerprint:historyBreakFingerprint(row),kind:"approved-exempt"}))});
    const result=await loader(verification).load(now);
    expect(result.status).toBe("available");
    expect(result.segments[0].history?.breaks).toHaveLength(1);
    expect(result.evidence.snapshot?.databaseEvidence?.breakResolution?.dispositions).toHaveLength(1);
  });
  it("cannot use a trusted break adapter to omit a source declaration",async()=>{
    await f.client.query(`INSERT INTO deviations(id,user_id,domain,reason,start_at,end_at)
      VALUES('unresolved-break',$1,'meditation','Synthetic declaration','2026-01-03T00:00:00Z','2026-01-04T00:00:00Z')`,[context.actorUserId]);
    const verification=verifier();
    verification.resolveBreaks=async()=>({evidenceId:"wrong-empty-resolution",breaks:[],dispositions:[]});
    expect(await loader(verification).load(now)).toMatchObject({status:"unavailable",reason:"exception_adapter_unavailable"});
  });

  it.each(["column","payload"] as const)("preserves and refuses unsupported microsecond %s precision",async(kind)=>{
    await add("precision-event","2026-01-10T12:00:00.000Z");
    if(kind==="column")await f.client.query(
      "UPDATE observations SET observed_at=observed_at+interval '1 microsecond' WHERE observation_id='precision-event'");
    else await f.client.query(`UPDATE observations SET observation=jsonb_set(observation,'{observedAt}',
      to_jsonb('2026-01-10T12:00:00.000001Z'::text)) WHERE observation_id='precision-event'`);
    const result=await loader().load(now);
    expect(result).toMatchObject({status:"unavailable",reason:"unsupported_timestamp_precision"});
    expect(result.evidence.snapshot?.databaseEvidence?.observations).toHaveLength(1);
    expect(result.evidence.dispositions).toHaveLength(1);
  });
  it("does not collapse a microsecond policy boundary onto a preceding observation",async()=>{
    await add("preceding-micro-boundary","2026-01-08T00:00:00.000000Z");
    const next=structuredClone(config);
    Object.assign(next,{policyVersionId:"micro-policy",revision:2,previousVersionId:config.policyVersionId,
      effectiveFrom:"2026-01-08T00:00:00.000001Z"});
    await f.client.query(`INSERT INTO policy_versions(policy_version_id,org_id,owner_user_id,domain_id,revision,
      effective_from,previous_version_id,configuration) VALUES($1,$2,$3,$4,2,$5,$6,$7)`,
      [next.policyVersionId,context.orgId,context.actorUserId,config.domainId,next.effectiveFrom,config.policyVersionId,next]);
    // Complete the persisted measurement representation so this fixture isolates
    // its intended boundary/precision failure rather than a missing definition.
    for(const measurement of next.measurements)await f.client.query(`INSERT INTO dimension_definitions
      (org_id,owner_user_id,domain_id,policy_version_id,measurement_id,definition)
      VALUES($1,$2,$3,$4,$5,$6)`,[context.orgId,context.actorUserId,config.domainId,
        next.policyVersionId,measurement.measurementId,measurement]);
    const old={...episode,effectiveEnd:next.effectiveFrom},second:CadenceEpisode={...episode,
      episodeId:"micro-second",policy:next,origin:{...episode.origin,at:next.effectiveFrom}};
    const result=await loader(verifier([old,second]),[old,second]).load(now);
    expect(result).toMatchObject({status:"unavailable",reason:"unsupported_timestamp_precision"});
    expect(result.evidence.snapshot?.databaseEvidence?.policies).toHaveLength(2);
    expect(result.evidence.snapshot?.observations).toHaveLength(1);
  });
  it("refuses an oversized complete row set instead of silently truncating history",async()=>{
    const base={...observationFor(config,"placeholder",10),observedAt:"2026-01-10T12:00:00Z"};
    await f.client.query(`INSERT INTO observations(observation_id,org_id,owner_user_id,domain_id,policy_version_id,
      idempotency_key,observed_at,observation)
      SELECT 'overflow-'||n,$1,$2,$3,$4,'overflow-idem-'||n,$5,
        jsonb_set($6::jsonb,'{observationId}',to_jsonb('overflow-'||n))
      FROM generate_series(1,2001) n`,[context.orgId,context.actorUserId,config.domainId,config.policyVersionId,base.observedAt,base]);
    await expect(loader().load(now)).rejects.toMatchObject({status:503,code:"RESOURCE_LIMIT_EXCEEDED"});
    expect((await f.client.query("SELECT count(*)::int AS count FROM observations")).rows[0].count).toBe(2001);
  });

  it.each(["missing","extra","changed"] as const)("refuses %s stored measurement definitions with raw evidence retained",async(kind)=>{
    if(kind==="missing")await f.client.query("DELETE FROM dimension_definitions WHERE policy_version_id=$1 AND measurement_id=$2",
      [config.policyVersionId,frequency.measurementId]);
    if(kind==="extra")await f.client.query(`INSERT INTO dimension_definitions(org_id,owner_user_id,domain_id,
      policy_version_id,measurement_id,definition) VALUES($1,$2,$3,$4,'extra-definition',$5)`,
      [context.orgId,context.actorUserId,config.domainId,config.policyVersionId,{...frequency,measurementId:"extra-definition"}]);
    if(kind==="changed")await f.client.query(`UPDATE dimension_definitions SET definition=jsonb_set(definition,
      '{meaning}',to_jsonb('Corrupted stored definition'::text)) WHERE policy_version_id=$1 AND measurement_id=$2`,
      [config.policyVersionId,frequency.measurementId]);
    const result=await loader().load(now);
    expect(result).toMatchObject({status:"unavailable",reason:"persisted_history_mismatch"});
    expect(result.evidence.snapshot?.databaseEvidence?.validationErrors).toContain("persisted_dimension_mismatch");
    expect(result.evidence.snapshot?.databaseEvidence?.dimensions).toHaveLength(kind==="missing"?1:kind==="extra"?3:2);
    expect(result.evidence.snapshot?.configurations).toHaveLength(1);
  });
  it.each([false,true])("keeps a future policy pending without invalidating current assessment (registered=%s)",async(registerFuture)=>{
    await add("current-event","2026-01-10T12:00:00Z");
    const next=structuredClone(config);
    Object.assign(next,{policyVersionId:"future-policy",revision:2,previousVersionId:config.policyVersionId,
      effectiveFrom:"2026-01-20T00:00:00Z"});
    next.targets.normal.conditions=next.targets.normal.conditions.map(c=>
      c.measurementId===frequency.measurementId?conditionFor(frequency,3):c);
    const store=createPolicyV2Storage(f.db,context,{clock:()=>new Date("2025-12-31T00:00:00Z")});
    await store.policies.append(next,"Synthetic future policy");
    await add("future-policy-event","2026-01-20T12:00:00Z",10,next);
    const current={...episode,effectiveEnd:next.effectiveFrom};
    const future:CadenceEpisode={...episode,episodeId:"future-episode",policy:next,
      origin:{...episode.origin,at:next.effectiveFrom}};
    const registered=registerFuture?[current,future]:[current];
    // Future activation evidence does not exist yet and is not fabricated.
    const result=await loader(verifier([current]),registered).load(now);
    expect(result.status).toBe("available");
    expect(result.reason).toBeUndefined();
    expect(result.segments.map(s=>s.status)).toEqual(["assessed","pending"]);
    expect(result.segments[0].cadence.status).toBe("available");
    expect(result.segments[0].history?.coveredThrough).toBe("2026-01-15T00:00:00.000Z");
    expect(result.segments[1]).toMatchObject({status:"pending",policy:next,history:null,
      cadence:{status:"unavailable",reason:"policy_not_effective"}});
    expect(result.segments[1].episode?.episodeId??null).toBe(registerFuture?future.episodeId:null);
    expect(result.evidence.dispositions.find(d=>d.observationId==="future-policy-event")).toMatchObject({
      kind:"future",reason:"future_policy_not_assessed"});
    expect(result.aggregate).toEqual({status:"unavailable",reason:"cross-version-aggregate-not-approved"});
  });

  it("retains system and other-member corrections for owned entities, while excluding foreign entities",async()=>{
    await add("owned-audited-event","2026-01-10T12:00:00Z");
    await f.client.query(`INSERT INTO domains(domain_id,org_id,owner_user_id,slug,display_name)
      VALUES('peer-domain','history-org','history-peer','peer-domain','Peer'),
        ('foreign-org-domain','history-other-org','history-other','foreign-domain','Foreign')`);
    const entries=[
      ["system-owned",context.orgId,"system",null,"observations",JSON.stringify(["owned-audited-event"])],
      ["peer-owned",context.orgId,"user","history-peer","observations",JSON.stringify(["owned-audited-event"])],
      ["owner-foreign",context.orgId,"user",context.actorUserId,"domains",JSON.stringify(["peer-domain"])],
      ["system-foreign",context.orgId,"system",null,"domains",JSON.stringify(["peer-domain"])],
      ["system-foreign-org","history-other-org","system",null,"domains",JSON.stringify(["foreign-org-domain"])],
    ];
    for(const entry of entries)await f.client.query(`INSERT INTO audit_events
      (audit_event_id,org_id,actor_kind,actor_user_id,entity_type,entity_id,action,occurred_at,reason,"before","after")
      VALUES($1,$2,$3,$4,$5,$6,'update',clock_timestamp(),'Synthetic correction',null,'{}'::jsonb)`,entry);
    const result=await loader().load(now),corrections=result.evidence.snapshot?.corrections as any[];
    expect(result.status).toBe("available");
    expect(corrections.find(row=>row.audit_event_id==="system-owned")).toMatchObject({actor_kind:"system",actor_user_id:null});
    expect(corrections.find(row=>row.audit_event_id==="peer-owned")).toMatchObject({actor_kind:"user",actor_user_id:"history-peer"});
    const ids=corrections.map(row=>row.audit_event_id);
    for(const excluded of ["owner-foreign","system-foreign","system-foreign-org"])expect(ids).not.toContain(excluded);
    expect(result.evidence.snapshot?.databaseEvidence?.validationErrors).toEqual([]);
  });
  it.each(["not-applicable","deleted","unlinked","unknown-source","unsupported-source-kind","wrong-fingerprint","approved-without-interval"] as const)(
    "refuses contradictory or unproven emitted exception intervals: %s",async(kind)=>{
    await f.client.query(`INSERT INTO deviations(id,user_id,domain,reason,start_at,end_at)
      VALUES('linked-source',$1,'meditation','Synthetic declaration','2026-01-03T00:00:00Z','2026-01-04T00:00:00Z')`,[context.actorUserId]);
    const verification=verifier();
    verification.resolveBreaks=async evidence=>{
      const fingerprint=historyBreakFingerprint(evidence.legacyDeviations[0]);
      const emitted:any={breakId:"emitted-break",scope:{organizationId:context.orgId,ownerUserId:context.actorUserId,domainId:config.domainId},
        interval:{start:"2026-01-03T00:00:00Z",end:"2026-01-04T00:00:00Z"},
        source:{kind:"legacy",id:"linked-source",fingerprint}};
      if(kind==="unlinked")delete emitted.source;
      if(kind==="unknown-source")emitted.source.id="invented-source";
      if(kind==="unsupported-source-kind")emitted.source.kind="ad-hoc";
      if(kind==="wrong-fingerprint")emitted.source.fingerprint="0".repeat(64);
      return {evidenceId:"synthetic-exception-receipt",
        breaks:kind==="approved-without-interval"?[]:[emitted],
        dispositions:[{source:"legacy",id:"linked-source",fingerprint,
          kind:kind==="not-applicable"?"not-applicable":kind==="deleted"?"deleted":"approved-exempt"}]};
    };
    const result=await loader(verification).load(now);
    expect(result).toMatchObject({status:"unavailable",reason:"exception_adapter_unavailable"});
    expect(result.evidence.snapshot?.databaseEvidence?.legacyDeviations).toHaveLength(1);
    expect(result.segments).toEqual([]);
  });
  it("saves a reproducible trusted result once, preserves same-day qualification and audits changed evidence",async()=>{
    for(const [id,at] of [["score-a","2026-01-10T09:00:00Z"],["score-b","2026-01-10T13:00:00Z"],
      ["score-c","2026-01-10T18:00:00Z"]] as const)await addScoring(id,at,10);
    const writer=persistenceWriter(),first=await writer.calculateAndSave();
    expect(first).toMatchObject({status:"saved",action:"created"});
    if(first.status!=="saved")throw Error("trusted source did not produce a saved synthetic result");
    const row=first.result as any,trusted=row.result;
    expect(row).toMatchObject({budget_enabled_snapshot:false,budget_snapshot:null,
      calculation_version:"somr433-persist-v1",input_fingerprint:first.inputFingerprint});
    expect(trusted).toMatchObject({kind:"trusted-evaluation-v1",schemaVersion:1,status:"available",
      current:{status:"available"},cadence:{status:"available"},persistence:{status:"available"},
      attention:{status:"available"},trend:{status:"unavailable"}});
    expect(trusted.persistence).toEqual(trusted.cadence);
    expect(trusted.persistence.evidence.calculationVersion).toBe(CADENCE_VERSION);
    expect(trusted.evaluation.evidence.components.find((c:any)=>c.measurementId==="frequency").qualifyingDays)
      .toEqual(["2026-01-10"]);
    expect(trusted.provenance.input.observations).toHaveLength(3);
    expect(trusted.provenance.input.recipe.recipeId).toBe("synthetic-reviewed-history-recipe");
    expect(trusted.provenance.input.policy.targets.normal.conditions).toHaveLength(2);
    const afterInsert=await state();
    const retry=await writer.calculateAndSave();
    const concurrent=await concurrentPersistenceSaves();
    expect(retry).toMatchObject({status:"saved",action:"unchanged",resultId:first.resultId,inputFingerprint:first.inputFingerprint});
    expect(concurrent.every(result=>result.status==="saved"&&result.action==="unchanged")).toBe(true);
    expect(await state()).toEqual(afterInsert);
    await addScoring("score-d","2026-01-11T10:00:00Z",10);
    const revised=await writer.calculateAndSave();
    expect(revised).toMatchObject({status:"saved",action:"updated",resultId:first.resultId});
    if(revised.status!=="saved")throw Error("changed synthetic evidence was not saved");
    expect(revised.inputFingerprint).not.toBe(first.inputFingerprint);
    expect((revised.result as any).result.provenance.sourceSnapshot.observations).toHaveLength(4);
    const audit=(await f.client.query(`SELECT action,"before","after" FROM audit_events
      WHERE entity_type='evaluation_results' AND entity_id=$1 ORDER BY occurred_at,audit_event_id`,
      [JSON.stringify([first.resultId])])).rows;
    expect(audit.map((entry:any)=>entry.action)).toEqual(["create","update"]);
    expect(audit[1].before.input_fingerprint).toBe(first.inputFingerprint);
    expect(audit[1].after.input_fingerprint).toBe(revised.inputFingerprint);
    expect((await f.client.query("SELECT count(*)::int AS count FROM evaluation_results")).rows[0].count).toBe(1);
  });
  it("keeps unapproved recipes, missing coverage proof and reference comparisons unavailable",async()=>{
    await addScoring("score-unavailable","2026-01-10T12:00:00Z",10);
    const noRecipe=createEvaluationPersistence({db:f.db,context,domainId:scoringConfig.domainId,
      history:scoringLoader(),recipes:[],calculationVersion:"somr433-persist-v1",clock:()=>new Date(now)});
    expect(await noRecipe.calculateAndSave()).toEqual({status:"unavailable",reason:"recipe_not_approved"});
    const missingProof=verifier([scoringEpisode]);missingProof.verifyCoverage=async()=>null;
    const noCoverage=createEvaluationPersistence({db:f.db,context,domainId:scoringConfig.domainId,
      history:scoringLoader(missingProof),recipes:[scoringRecipe()],calculationVersion:"somr433-persist-v1",
      clock:()=>new Date(now)});
    const result=await noCoverage.calculateAndSave();
    expect(result).toMatchObject({status:"unavailable"});
    expect((await f.client.query("SELECT count(*)::int AS count FROM evaluation_results")).rows[0].count).toBe(0);
    // Reference percentages are not computed by this foundation; a fixture's
    // hand-written future expectation is deliberately not acceptance evidence.

  });
  it("does not persist an unapproved mixed-policy window",async()=>{
    await addScoring("score-before-policy-change","2026-01-10T12:00:00Z",10);
    const next=structuredClone(scoringConfig);
    Object.assign(next,{policyVersionId:"history-scoring-policy-v2",revision:2,
      previousVersionId:scoringConfig.policyVersionId,effectiveFrom:"2026-01-12T00:00:00Z"});
    const store=createPolicyV2Storage(f.db,context,{clock:()=>new Date("2025-12-31T00:00:00Z")});
    await store.policies.append(next,"Synthetic policy transition");
    const observation={...observationFor(next,"score-after-policy-change",10),observedAt:"2026-01-12T12:00:00Z"};
    await store.observations.create({observation,idempotencyKey:"score-after-policy-change"},"Synthetic scoring event");
    const before={...scoringEpisode,effectiveEnd:next.effectiveFrom};
    const after:CadenceEpisode={...scoringEpisode,episodeId:"history-scoring-episode-v2",policy:next,
      origin:{...scoringEpisode.origin,at:next.effectiveFrom}};
    const history=createEvaluationHistoryLoader(f.db,context,scoringConfig.domainId,[before,after],verifier([before,after]));
    const writer=createEvaluationPersistence({db:f.db,context,domainId:scoringConfig.domainId,history,
      recipes:[scoringRecipe()],calculationVersion:"somr433-persist-v1",clock:()=>new Date(now)});
    expect(await writer.calculateAndSave()).toMatchObject({status:"unavailable",reason:"cross_version_aggregate_not_approved"});
    expect((await f.client.query("SELECT count(*)::int AS count FROM evaluation_results")).rows[0].count).toBe(0);
  });
  it("treats an equivalent refreshed receipt as an unchanged retry, but retains changed authority",async()=>{
    await addScoring("receipt-event","2026-01-10T12:00:00Z",10);
    let issuance=0,proof="fixture-created-empty-before-recording";
    const verification:HistoryVerification={verifyCoverage:async snapshot=>{
      const value=receipt(snapshot,[scoringEpisode]);
      value.receiptId="synthetic-reissued-"+(++issuance);
      value.origins[0].evidenceId=proof;
      return value;
    }};
    const writer=persistenceWriter(scoringRecipe(),scoringLoader(verification));
    const first=await writer.calculateAndSave();
    expect(first).toMatchObject({status:"saved",action:"created"});
    if(first.status!=="saved")throw Error("receipt test did not create result");
    const firstReceipt=(first.result as any).result.provenance.coverageReceipt;
    expect(firstReceipt.receiptId).toBe("synthetic-reissued-1");
    const afterFirst=await state(),second=await writer.calculateAndSave();
    expect(second).toMatchObject({status:"saved",action:"unchanged",resultId:first.resultId,
      inputFingerprint:first.inputFingerprint});
    if(second.status!=="saved")throw Error("receipt retry did not return existing result");
    expect((second.result as any).result.provenance.coverageReceipt).toEqual(firstReceipt);
    expect(await state()).toEqual(afterFirst);
    proof="fixture-independent-activation-proof-revision-2";
    const changed=await writer.calculateAndSave();
    expect(changed).toMatchObject({status:"saved",action:"updated",resultId:first.resultId});
    if(changed.status!=="saved")throw Error("changed authority did not update");
    expect(changed.inputFingerprint).not.toBe(first.inputFingerprint);
    expect((changed.result as any).result.provenance.coverageReceipt.origins[0].evidenceId).toBe(proof);
  });
  it("admits one concurrent first save on independent pinned clients with one result and create audit",async()=>{
    await addScoring("concurrent-first-event","2026-01-10T12:00:00Z",10);
    const admitted=async()=>Number((await f.client.query(
      "SELECT coalesce(sum(day_count),0)::int AS count FROM owner_write_resource_budgets WHERE owner_user_id=$1",
      [context.actorUserId])).rows[0].count);
    const before=await admitted(),results=await concurrentPersistenceSaves();
    expect(results.map(r=>r.status==="saved"?r.action:r.status).sort()).toEqual(["created","unchanged"]);
    const ids=results.map(r=>r.status==="saved"?r.resultId:null);
    expect(ids[0]).toBeTruthy();expect(ids[1]).toBe(ids[0]);
    expect((await f.client.query("SELECT count(*)::int AS count FROM evaluation_results")).rows[0].count).toBe(1);
    const audits=(await f.client.query(
      "SELECT action FROM audit_events WHERE entity_type='evaluation_results' AND entity_id=$1",
      [JSON.stringify([ids[0]])])).rows;
    expect(audits.map(r=>r.action)).toEqual(["create"]);
    expect(await admitted()).toBe(before+1);
  });
  it("binds the validated dependencies and scalar identity before options are replaced",async()=>{
    await addScoring("bound-dependency-event","2026-01-10T12:00:00Z",10);
    let foreignHistoryReads=0;
    const options:any={db:f.db,context,domainId:scoringConfig.domainId,history:scoringLoader(),
      recipes:[scoringRecipe()],calculationVersion:"somr433-persist-v1",clock:()=>new Date(now)};
    const writer=createEvaluationPersistence(options);
    options.db={};options.context=other;options.domainId=config.domainId;
    options.history={load:async()=>{foreignHistoryReads++;throw Error("unbranded replacement must not run");}};
    options.clock=()=>{throw Error("replacement clock must not run");};
    options.calculationVersion="replacement-calculation";options.recipes=[];
    const saved=await writer.calculateAndSave();
    expect(saved).toMatchObject({status:"saved",action:"created"});
    expect(foreignHistoryReads).toBe(0);
    if(saved.status!=="saved")throw Error("bound operation did not save");
    expect(saved.result).toMatchObject({domain_id:scoringConfig.domainId,org_id:context.orgId,
      owner_user_id:context.actorUserId,calculation_version:"somr433-persist-v1"});
    expect((saved.result as any).result.provenance.input.now).toBe(new Date(now).toISOString());
  });
  it("keeps a future policy and its raw records pending while saving the current policy",async()=>{
    await addScoring("persist-current-event","2026-01-10T12:00:00Z",10);
    const next=structuredClone(scoringConfig);
    Object.assign(next,{policyVersionId:"persist-future-policy",revision:2,
      previousVersionId:scoringConfig.policyVersionId,effectiveFrom:"2026-01-20T00:00:00Z"});
    const store=createPolicyV2Storage(f.db,context,{clock:()=>new Date("2025-12-31T00:00:00Z")});
    await store.policies.append(next,"Synthetic pending policy");
    await add("persist-future-event","2026-01-20T12:00:00Z",10,next);
    const current={...scoringEpisode,effectiveEnd:next.effectiveFrom};
    const future:CadenceEpisode={...scoringEpisode,episodeId:"persist-future-episode",policy:next,
      origin:{...scoringEpisode.origin,at:next.effectiveFrom}};
    // No fabricated activation receipt is supplied for the future episode.
    const history=createEvaluationHistoryLoader(f.db,context,scoringConfig.domainId,[current,future],verifier([current]));
    const saved=await persistenceWriter(scoringRecipe(),history).calculateAndSave();
    expect(saved).toMatchObject({status:"saved",action:"created"});
    if(saved.status!=="saved")throw Error("pending policy blocked a valid current save");
    const trusted=(saved.result as any).result;
    expect(trusted.provenance.input.policy.policyVersionId).toBe(scoringConfig.policyVersionId);
    expect(trusted.provenance.sourceSnapshot.configurations).toHaveLength(2);
    expect(trusted.provenance.sourceSnapshot.observations).toHaveLength(2);
    expect(trusted.provenance.dispositions.find((d:any)=>d.observationId==="persist-future-event"))
      .toMatchObject({kind:"future",reason:"future_policy_not_assessed"});
  });
  it("saves a full revised-policy window with original activation and replays the earlier saved result",async()=>{
    await addScoring("historical-before-change","2026-01-03T12:00:00Z",10);
    const oldRecipe=scoringRecipe();
    const initialWriter=createEvaluationPersistence({db:f.db,context,domainId:scoringConfig.domainId,
      history:scoringLoader(),recipes:[oldRecipe],calculationVersion:"somr433-persist-v1",
      clock:()=>new Date("2026-01-08T12:00:00Z")});
    const earlier=await initialWriter.calculateAndSave();
    expect(earlier).toMatchObject({status:"saved",action:"created"});
    if(earlier.status!=="saved")throw Error("earlier result unavailable");
    const original=structuredClone((earlier.result as any).result);
    const next=structuredClone(scoringConfig);
    Object.assign(next,{policyVersionId:"persist-revised-policy",revision:2,
      previousVersionId:scoringConfig.policyVersionId,effectiveFrom:"2026-01-10T00:00:00Z"});
    next.targets.normal.conditions=next.targets.normal.conditions.map(c=>
      c.measurementId===frequency.measurementId?conditionFor(frequency,3):c);
    const store=createPolicyV2Storage(f.db,context,{clock:()=>new Date("2025-12-31T00:00:00Z")});
    await store.policies.append(next,"Synthetic prospective revised frequency");
    for(const day of [11,13,18,21,24])await add("revised-day-"+day,"2026-01-"+day+"T12:00:00Z",10,next);
    const retired={...scoringEpisode,effectiveEnd:next.effectiveFrom};
    const revised:CadenceEpisode={...scoringEpisode,episodeId:"persist-revised-episode",policy:next,
      origin:{...scoringEpisode.origin,at:next.effectiveFrom}};
    const history=createEvaluationHistoryLoader(f.db,context,scoringConfig.domainId,[retired,revised],
      verifier([retired,revised]));
    const laterWriter=createEvaluationPersistence({db:f.db,context,domainId:scoringConfig.domainId,history,
      recipes:[oldRecipe,scoringRecipe(next)],calculationVersion:"somr433-persist-v1",
      clock:()=>new Date("2026-01-25T12:00:00Z")});
    const later=await laterWriter.calculateAndSave();
    expect(later).toMatchObject({status:"saved",action:"created"});
    if(later.status!=="saved")throw Error("retired policy blocked full revised window");
    const trusted=(later.result as any).result;
    expect(trusted.status).toBe("available");
    expect(trusted.provenance.input.coverage.onboardingAt).toBe(scoringConfig.effectiveFrom);
    expect(trusted.provenance.input.policy.policyVersionId).toBe(next.policyVersionId);
    expect(trusted.evaluation.evidence.window).toMatchObject({
      start:"2026-01-11T00:00:00.000Z",end:"2026-01-25T00:00:00.000Z",eligibleDays:14});
    expect(trusted.persistence).toEqual(trusted.cadence);
    expect(trusted.provenance.coverageReceipt.origins.find((o:any)=>o.episodeId===revised.episodeId))
      .toMatchObject({kind:"verified-source-reconciliation",at:next.effectiveFrom});
    const reloaded=(await f.client.query(
      "SELECT result FROM evaluation_results WHERE result_id=$1 AND org_id=$2 AND owner_user_id=$3 AND domain_id=$4",
      [earlier.resultId,context.orgId,context.actorUserId,scoringConfig.domainId])).rows[0].result;
    expect(reloaded).toEqual(original);
    expect(createEvaluator([oldRecipe])(reloaded.provenance.input)).toEqual(reloaded.evaluation);
    expect(reloaded.provenance.input.policy.policyVersionId).toBe(scoringConfig.policyVersionId);
    expect(reloaded.provenance.input.policy.targets.normal.conditions.find((c:any)=>c.measurementId==="frequency").constraint.value).toBe(5);
  });
  it("does not turn reconciliation-only history proof into new domain onboarding",async()=>{
    await addScoring("no-domain-activation-event","2026-01-10T12:00:00Z",10);
    const verification:HistoryVerification={verifyCoverage:async snapshot=>{
      const value=receipt(snapshot,[scoringEpisode]);
      value.origins[0].kind="verified-source-reconciliation";
      value.origins[0].evidenceId="independent-import-reconciliation-without-activation";
      return value;
    }};
    const before=await state();
    expect(await persistenceWriter(scoringRecipe(),scoringLoader(verification)).calculateAndSave())
      .toMatchObject({status:"unavailable"});
    expect(await state()).toEqual(before);
  });

  it("updates the saved result when a known future record becomes actual Today practice",async()=>{
    await addScoring("time-classified-event","2026-01-15T10:00:00Z",10);
    let evaluationTime="2026-01-15T09:00:00Z";
    const writer=createEvaluationPersistence({db:f.db,context,domainId:scoringConfig.domainId,
      history:scoringLoader(),recipes:[scoringRecipe()],calculationVersion:"somr433-persist-v1",
      clock:()=>new Date(evaluationTime)});
    const before=await writer.calculateAndSave();
    expect(before).toMatchObject({status:"saved",action:"created"});
    if(before.status!=="saved")throw Error("initial time-classified result unavailable");
    expect((before.result as any).result.evaluation.evidence.future.map((o:any)=>o.observationId)).toEqual(["time-classified-event"]);
    evaluationTime=now;
    const after=await writer.calculateAndSave();
    expect(after).toMatchObject({status:"saved",action:"updated",resultId:before.resultId});
    if(after.status!=="saved")throw Error("actual Today transition was not saved");
    expect(after.inputFingerprint).not.toBe(before.inputFingerprint);
    const trusted=(after.result as any).result;
    expect(trusted.evaluation.evidence.today.map((o:any)=>o.observationId)).toEqual(["time-classified-event"]);
    expect(trusted.cadence.evidence.pendingObservationIds).toEqual(["time-classified-event"]);
    expect(trusted.provenance.sourceSnapshot.observations).toHaveLength(1);
  });

});
