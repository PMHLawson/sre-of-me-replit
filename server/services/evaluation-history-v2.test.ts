import { beforeAll,afterAll,beforeEach,describe,it,expect } from "vitest";
import { startFixture } from "../lib/ownership-fixture";
import { createOrgContextResolver,type OrgContext } from "../lib/org-context";
import { createPolicyV2Storage } from "../storage/policy-v2-storage";
import { configurationFor,observationFor,MEASUREMENTS,conditionFor } from "../../shared/fixtures/domain-config-cases";
import type { DomainConfiguration,MeasurementDefinition } from "../../shared/domain-config";
import type { CadenceEpisode } from "../../shared/cadence-derived";
import { createEvaluationHistoryLoader,evaluationHistoryFingerprint,historyBreakFingerprint,
  type HistorySnapshot,type HistoryCoverageReceipt,type HistoryVerification } from "./evaluation-history-v2";

describe("authenticated complete history and exact policy segmentation",()=>{
  let f:Awaited<ReturnType<typeof startFixture>>;
  let context:OrgContext,other:OrgContext,config:DomainConfiguration,episode:CadenceEpisode;
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
        evidenceId:"fixture-created-empty-before-recording",kind:"verified-empty-domain-activation"}))};
  }
  const verifier=(episodes:CadenceEpisode[]=[episode]):HistoryVerification=>({
    // Synthetic fixture genesis is known here; a production callback must read
    // an independent activation/import receipt, not reproduce this test oracle.
    verifyCoverage:async s=>receipt(s,episodes),
  });
  const loader=(verification:HistoryVerification=verifier(),episodes:CadenceEpisode[]=[episode])=>
    createEvaluationHistoryLoader(f.db,context,config.domainId,episodes,verification);
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
    await f.client.query(`DELETE FROM public.audit_events;DELETE FROM public.source_bindings;
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
  });
  afterAll(async()=>{if(f)await f.cleanup();},60000);
  async function add(id:string,at:string,amount=10,c=config){
    const store=createPolicyV2Storage(f.db,context,{clock:()=>new Date("2025-12-31T00:00:00Z")});
    await store.observations.create({observation:{...observationFor(c,id,amount),observedAt:at},idempotencyKey:id},"Synthetic event");
  }
  async function state(){
    return (await f.client.query(`SELECT jsonb_build_object('observations',(SELECT jsonb_agg(to_jsonb(o)) FROM observations o),
      'audit',(SELECT jsonb_agg(to_jsonb(a)) FROM audit_events a),'policy',(SELECT jsonb_agg(to_jsonb(p)) FROM policy_versions p)) AS data`)).rows[0].data;
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
});
