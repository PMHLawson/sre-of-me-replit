import { beforeAll,afterAll,describe,it,expect } from "vitest";
import { startFixture } from "../lib/ownership-fixture";
import { createOrgContextResolver,type OrgContext } from "../lib/org-context";
import { createPolicyV2Storage } from "./policy-v2-storage";
import { configurationFor,observationFor,MEASUREMENTS } from "../../shared/fixtures/domain-config-cases";
import type { DomainConfiguration } from "../../shared/domain-config";
import { Pool } from "pg";
import { createPinnedOwnershipUnit } from "../lib/pinned-ownership-unit";

describe("actual scoped repositories and atomic audit",()=>{
  let f:Awaited<ReturnType<typeof startFixture>>;
  type Store=ReturnType<typeof createPolicyV2Storage>;
  const stores:Record<string,Store>={},contexts:Record<string,OrgContext>={},configs:Record<string,DomainConfiguration>={};
  const reason="synthetic test";
  const kinds=["domains","policies","dimensions","observations","evaluations","deviations","associations","bindings"] as const;
  const keys=(k:typeof kinds[number],u:string)=>{
    return ({domains:[`d-${u}`],policies:[`p-${u}`],dimensions:[`p-${u}`,"m-repetitions"],observations:[`o-${u}`],
      evaluations:[`e-${u}`],deviations:[`v-${u}`],associations:[`v-${u}`,`d-${u}`],bindings:[`b-${u}`]})[k];
  };
  const deviation=(u:string)=>({deviationId:`v-${u}`,startAt:"2026-01-01T00:00:00Z",endAt:null,scope:"selected",type:"stitch",
    reason,policy:{},provenance:{}});
  const evaluation=(u:string)=>({resultId:`e-${u}`,domainId:`d-${u}`,policyVersionId:`p-${u}`,windowStart:"2026-01-01T00:00:00Z",
    windowEnd:"2026-01-08T00:00:00Z",timezone:"America/New_York",dayStartHour:4,calculationVersion:"synthetic",
    inputFingerprint:"synthetic",eligibleDays:7,result:{summary:"Synthetic"},components:[{measurementId:"m-repetitions",value:2}],
    explanation:{summary:"Synthetic"}});
  const binding=(u:string)=>({bindingId:`b-${u}`,domainId:`d-${u}`,sourceKind:"manual",externalId:`external-${u}`,metadata:{description:"Synthetic"}});
  async function snapshot(){
    // Test oracle only. No repository method exposes raw reads; these are the
    // explicitly owned synthetic fixture administrator's complete state.
    const result:Record<string,unknown>={};
    for(const t of ["domains","policy_versions","dimension_definitions","observations","evaluation_results","deviations_v2","deviation_domains","source_bindings","audit_events"])
      result[t]=(await f.client.query(`SELECT to_jsonb(t) AS value FROM ${t} t ORDER BY to_jsonb(t)::text`)).rows;
    return JSON.stringify(result);
  }
  async function unchangedOnReject(fn:()=>Promise<unknown>,status?:number){
    const before=await snapshot();
    if(status)await expect(fn()).rejects.toMatchObject({status});
    else await expect(fn()).rejects.toThrow();
    expect(await snapshot()).toBe(before);
  }
  beforeAll(async()=>{
    f=await startFixture("repositories");
    await f.client.query(`INSERT INTO users(id) VALUES ('a'),('b'),('c');
      INSERT INTO organizations(org_id,display_name) VALUES ('one','One'),('two','Two');
      INSERT INTO organization_members(org_id,user_id,role) VALUES ('one','a','owner'),('two','b','owner'),('one','c','member');`);
    for(const user of ["a","b","c"]){
      const org=user==="b"?"two":"one";
      contexts[user]=await createOrgContextResolver(f.db)({isAuthenticated:()=>true,user:{claims:{sub:user}}});
      const s=stores[user]=createPolicyV2Storage(f.db,contexts[user],{clock:()=>new Date("2026-01-01T00:00:00Z")});
      configs[user]={...configurationFor(user,MEASUREMENTS[1],10),organizationId:org,ownerUserId:user,domainId:`d-${user}`,policyVersionId:`p-${user}`};
      await s.domains.create({domainId:`d-${user}`,slug:user==="c"?"other":"same-slug",displayName:"Same caption"},reason);
      await s.policies.append(configs[user],reason);
      await s.bindings.create(binding(user),reason);
      await s.observations.create({observation:observationFor(configs[user],`o-${user}`,2),idempotencyKey:`idem-${user}`,sourceBindingId:`b-${user}`},reason);
      await s.evaluations.create(evaluation(user),reason);
      await s.deviations.create(deviation(user),reason);
      await s.associations.create([`v-${user}`,`d-${user}`],reason);
    }
  },60000);
  afterAll(async()=>{if(f)await f.cleanup();},60000);

  it("requires a real capability and does not expose default connections/raw SQL/system mutations",()=>{
    expect(()=>createPolicyV2Storage(f.db,{...contexts.a})).toThrow();
    expect(Object.keys(stores.a).sort()).toEqual(["workspace","domains","policies","dimensions","observations","evaluations","deviations","associations","bindings","audit","personalPractice"].sort());
    expect(Object.keys(stores.a.policies).sort()).toEqual(["get","list","exists","append"].sort());
    expect(Object.keys(stores.a.dimensions).sort()).toEqual(["get","list","exists"].sort());
    expect(Object.keys(stores.a.audit).sort()).toEqual(["get","list"]);
  });
  it("workspace exposes only resolved organization and current membership",async()=>{
    for(const user of ["a","b","c"]){
      const w=await stores[user].workspace();expect(w.membership.user_id).toBe(user);
      expect(w.organization.org_id).toBe(user==="b"?"two":"one");
      expect(Object.keys(w)).toEqual(["organization","membership"]);
    }
  });
  it.each(kinds)("%s get/list/exists cover same-owner success, both cross-org and same-org denial, exact keys",async(kind)=>{
    for(const user of ["a","b","c"]){
      const s=stores[user][kind];
      expect((await s.get(keys(kind,user))).owner_user_id).toBe(user);
      expect(await s.exists(keys(kind,user))).toBe(true);
      const all=await s.list();expect(all).toHaveLength(1);expect(all.every(r=>r.owner_user_id===user)).toBe(true);
      for(const foreign of ["a","b","c"].filter(x=>x!==user)){
        await unchangedOnReject(()=>s.get(keys(kind,foreign)),404);
        expect(await s.exists(keys(kind,foreign))).toBe(false);
      }
      await unchangedOnReject(()=>s.get([...keys(kind,user),"extra"]),400);
    }
  });
  it("audit reads never reveal another actor's events even to an org owner",async()=>{
    const a=await stores.a.audit.list(),b=await stores.b.audit.list(),c=await stores.c.audit.list();
    expect(a.length).toBeGreaterThan(0);expect(a.every(x=>x.actor_user_id==="a"&&x.org_id==="one")).toBe(true);
    expect(await stores.a.audit.get(a[0].audit_event_id)).toEqual(a[0]);
    for(const foreign of [b[0],c[0]])await unchangedOnReject(()=>stores.a.audit.get(foreign.audit_event_id),404);
    expect(c.every(x=>x.actor_user_id==="c")).toBe(true);
  });
  it("count/repetition-only observations are accepted and idempotent retry creates no extra audit",async()=>{
    const o=observationFor(configs.a,"o-a",2);
    expect(Object.keys(o.values)).toEqual(["m-repetitions"]);
    const before=await snapshot();
    expect((await stores.a.observations.create({observation:o,idempotencyKey:"idem-a",sourceBindingId:"b-a"},reason)).observation_id).toBe("o-a");
    expect(await snapshot()).toBe(before);
    await unchangedOnReject(()=>stores.a.observations.create({observation:observationFor(configs.a,"new-id",2),idempotencyKey:"idem-a"},reason),400);
    for(const foreign of ["b","c"])
      expect((await stores.a.observations.create({observation:observationFor(configs.a,`new-id-${foreign}`,2),idempotencyKey:`idem-${foreign}`},reason)).owner_user_id).toBe("a");
  });
  it("correction: identical caller keys are independent across organizations and owners",async()=>{
    for(const u of ["a","b","c"]){
      const input={observation:observationFor(configs[u],`independent-${u}`,2),idempotencyKey:"shared-caller-key"};
      const row=await stores[u].observations.create(input,reason);
      expect(row.owner_user_id).toBe(u);
      expect(row.idempotency_key).toMatch(/^observation:v1:[a-f0-9]{64}$/);
      const before=await snapshot();
      expect(await stores[u].observations.create(input,reason)).toEqual(row);
      expect(await snapshot()).toBe(before);
      await unchangedOnReject(()=>stores[u].observations.create({...input,observation:observationFor(configs[u],`independent-${u}`,3)},reason),400);
    }
  });
  it("correction: semantic JSON equality ignores object order but preserves arrays and missing values",async()=>{
    const c={...configs.a,domainId:"semantic",policyVersionId:"semantic-policy",measurements:[MEASUREMENTS[1],MEASUREMENTS[2],MEASUREMENTS[4]]};
    await stores.a.domains.create({domainId:c.domainId,slug:"semantic",displayName:"Semantic"},reason);
    await stores.a.policies.append(c,reason);
    const o={...observationFor(c,"semantic-observation",0),values:{
      "m-repetitions":{valueType:"integer",value:0,unitId:"rep"},
      "m-completion":{valueType:"boolean",value:false,unitId:"completed"},
      "m-cupcakes":{valueType:"integer",value:0,unitId:"cupcake"}},
      context:{taskConditions:[{conditionId:"one",description:"One"},{conditionId:"two",description:"Two"}]}};
    const input={observation:o,idempotencyKey:"semantic-key"};
    const row=await stores.a.observations.create(input,reason),before=await snapshot();
    expect(await stores.a.observations.create(input,reason)).toEqual(row);
    const shuffle=(x:any):any=>Array.isArray(x)?x.map(shuffle):x&&typeof x==="object"?Object.fromEntries(Object.entries(x).reverse().map(([k,v])=>[k,shuffle(v)])):x;
    expect(await stores.a.observations.create({...input,observation:shuffle(o)},reason)).toEqual(row);
    expect(await snapshot()).toBe(before);
    for(const change of ["value","zero","false","array"]){
      const altered=structuredClone(o);
      if(change==="value")altered.values["m-repetitions"].value=1;
      if(change==="zero")delete (altered.values as any)["m-cupcakes"];
      if(change==="false")delete (altered.values as any)["m-completion"];
      if(change==="array")altered.context.taskConditions.reverse();
      await unchangedOnReject(()=>stores.a.observations.create({...input,observation:altered},reason),400);
    }
  });
  it("correction: default server clock rejects past first revisions",async()=>{
    await stores.a.domains.create({domainId:"past",slug:"past",displayName:"Past"},reason);
    const real=createPolicyV2Storage(f.db,contexts.a);
    await unchangedOnReject(()=>real.policies.append({...configs.a,domainId:"past",policyVersionId:"past-policy"},reason),400);
    const future={...configs.a,domainId:"past",policyVersionId:"future-first",effectiveFrom:new Date(Date.now()+86400000).toISOString()};
    expect((await real.policies.append(future,reason)).policy_version_id).toBe("future-first");
  });
  it("correction: trusted clock validates source/time after locks and protects persisted history",async()=>{
    for(const [i,options] of [{clock:"request"},{clock:()=>new Date(NaN)},{clock:()=> "2026-01-01T00:00:00Z"},{clock:()=>{throw Error("invalid");}}].entries()){
      const domainId=`invalid-clock-${i}`;
      await stores.a.domains.create({domainId,slug:domainId,displayName:"Invalid clock"},reason);
      await unchangedOnReject(async()=> (createPolicyV2Storage as any)(f.db,contexts.a,options).policies.append({...configs.a,domainId,policyVersionId:domainId},reason),503);
    }
    let now="2026-01-01T00:00:00Z";
    const s=createPolicyV2Storage(f.db,contexts.a,{clock:()=>{
      expect(f.queries.at(-1)?.sql).toContain("domain_id=$3");
      return new Date(now);
    }});
    const c={...configs.a,domainId:"clock",policyVersionId:"clock-policy"};
    await s.domains.create({domainId:"clock",slug:"clock",displayName:"Clock"},reason);
    await s.policies.append(c,reason);
    await s.observations.create({observation:{...observationFor(c,"future-observation",1),observedAt:"2026-03-01T00:00:00Z"},idempotencyKey:"future"},reason);
    const next={...c,revision:2,previousVersionId:c.policyVersionId,policyVersionId:"clock-next",effectiveFrom:"2026-02-01T00:00:00Z"};
    now="2026-02-02T00:00:00Z";
    await unchangedOnReject(()=>s.policies.append(next,reason),400);
    now="2026-01-01T00:00:00Z";
    await unchangedOnReject(()=>s.policies.append(next,reason),400);
    const observations=await s.observations.list();
    await s.policies.append({...next,effectiveFrom:"2026-04-01T00:00:00Z"},reason);
    expect(await s.observations.list()).toEqual(observations);
    await unchangedOnReject(()=>s.policies.append({...next,clock:now},reason),400);
  });
  it("every cross-scope mutation/reference path leaves all tenants and all audits unchanged",async()=>{
    for(const foreign of ["b","c"]){
      const o=observationFor(configs.a,"cross-observation",2);
      const rejected=[
        ()=>stores.a.domains.update([`d-${foreign}`],{displayName:"Denied"},reason),
        ()=>stores.a.policies.append({...configs.a,policyVersionId:"cross-policy",domainId:`d-${foreign}`},reason),
        ()=>stores.a.observations.create({observation:{...o,policyVersionId:`p-${foreign}`},idempotencyKey:"cross"},reason),
        ()=>stores.a.observations.create({observation:o,idempotencyKey:"cross",sourceBindingId:`b-${foreign}`},reason),
        ()=>stores.a.observations.delete([`o-${foreign}`],reason),
        ()=>stores.a.evaluations.create({...evaluation("a"),resultId:"cross",policyVersionId:`p-${foreign}`},reason),
        ()=>stores.a.evaluations.create({...evaluation("a"),resultId:"cross",domainId:`d-${foreign}`},reason),
        ()=>stores.a.deviations.end([`v-${foreign}`],"2026-01-03T00:00:00Z",reason),
        ()=>stores.a.deviations.delete([`v-${foreign}`],reason),
        ()=>stores.a.associations.create(["v-a",`d-${foreign}`],reason),
        ()=>stores.a.associations.create([`v-${foreign}`,"d-a"],reason),
        ()=>stores.a.associations.delete([`v-${foreign}`,`d-${foreign}`],reason),
        ()=>stores.a.associations.delete(["v-a",`d-${foreign}`],reason),
        ()=>stores.a.bindings.create({...binding("a"),bindingId:"cross",domainId:`d-${foreign}`},reason),
        ()=>stores.a.bindings.delete([`b-${foreign}`],reason),
      ];
      for(const fn of rejected)await unchangedOnReject(fn);
    }
  });
  it("rejects both-real but mismatched same-owner domain/policy/source references",async()=>{
    const c={...configs.a,domainId:"d-extra",policyVersionId:"p-extra"};
    await stores.a.domains.create({domainId:"d-extra",slug:"extra",displayName:"Extra"},reason);
    await stores.a.policies.append(c,reason);
    await stores.a.bindings.create({...binding("a"),bindingId:"b-extra",domainId:"d-extra",externalId:"extra"},reason);
    const o=observationFor(configs.a,"bad-pair",2);
    await unchangedOnReject(()=>stores.a.observations.create({observation:{...o,policyVersionId:"p-extra"},idempotencyKey:"pair"},reason));
    await unchangedOnReject(()=>stores.a.observations.create({observation:o,idempotencyKey:"pair",sourceBindingId:"b-extra"},reason),404);
    await unchangedOnReject(()=>stores.a.evaluations.create({...evaluation("a"),resultId:"pair",policyVersionId:"p-extra"},reason),404);
    await unchangedOnReject(()=>stores.a.dimensions.get(["p-a","m-missing"]),404);
    await unchangedOnReject(()=>stores.a.associations.get(["v-a","d-extra"]),404);
  });
  it("strict inputs reject arbitrary fields, identity reassignment, nested actors and system authority",async()=>{
    for(const forged of [{orgId:"two"},{ownerUserId:"c"},{actorUserId:"b"},{actorKind:"system"},{system:true},{rawSql:"DELETE"}]){
      await unchangedOnReject(()=>stores.a.domains.create({domainId:"forged",slug:"forged",displayName:"Forged",...forged},reason),400);
      await unchangedOnReject(()=>stores.a.domains.update(["d-a"],{displayName:"x",...forged},reason),400);
      await unchangedOnReject(()=>stores.a.bindings.create({...binding("a"),bindingId:"forged",metadata:forged},reason),400);
      await unchangedOnReject(()=>stores.a.deviations.create({...deviation("a"),deviationId:"forged",provenance:forged},reason),400);
      await unchangedOnReject(()=>stores.a.evaluations.create({...evaluation("a"),resultId:"forged",result:forged},reason),400);
      await unchangedOnReject(()=>stores.a.observations.create({observation:{...observationFor(configs.a,"forged",1),context:forged},idempotencyKey:"forged"},reason),400);
    }
    for(const key of ["organizationId","ownerUserId"]){
      await unchangedOnReject(()=>stores.a.policies.append({...configs.a,[key]:"other"},reason),404);
      await unchangedOnReject(()=>stores.a.observations.create({observation:{...observationFor(configs.a,"forged",1),[key]:"other"},idempotencyKey:"forged"},reason),404);
    }
    await unchangedOnReject(()=>stores.a.domains.update(["d-a"],{domainId:"d-b"},reason),400);
    await unchangedOnReject(()=>stores.a.policies.append({...configs.a,goal:{...configs.a.goal,actorUserId:"b"}},reason),400);
  });
  it("immutable policy lineage validates full history and half-open observation context",async()=>{
    const next={...structuredClone(configs.a),policyVersionId:"p-a-2",revision:2,previousVersionId:"p-a",effectiveFrom:"2026-02-01T00:00:00Z"};
    for(const patch of [{previousVersionId:"p-b"},{revision:4},{policyVersionId:"p-a"},{effectiveFrom:"2025-01-01T00:00:00Z"},
      {measurements:[{...next.measurements[0],meaning:"changed"}]}])
      await unchangedOnReject(()=>stores.a.policies.append({...next,...patch},reason),400);
    const original=await stores.a.policies.get(["p-a"]);
    await stores.a.policies.append(next,reason);
    expect(await stores.a.policies.get(["p-a"])).toEqual(original);
    expect((await stores.a.dimensions.get(["p-a-2","m-repetitions"])).policy_version_id).toBe("p-a-2");
    await unchangedOnReject(()=>stores.a.policies.append({...next,policyVersionId:"p-a-branch"},reason),400);
    const late={...observationFor(configs.a,"late",1),observedAt:"2026-02-01T00:00:00Z"};
    await unchangedOnReject(()=>stores.a.observations.create({observation:late,idempotencyKey:"late"},reason),400);
    const wrong=observationFor(next,"wrong-values",1);
    await unchangedOnReject(()=>stores.a.observations.create({observation:wrong,idempotencyKey:"wrong-values"},reason),400);
    await unchangedOnReject(()=>stores.a.observations.create({observation:{...late,policyVersionId:"p-a-2",values:{fake:{valueType:"integer",value:2,unitId:"rep"}}},idempotencyKey:"fake"},reason),400);
  });
  it("every update/delete succeeds for the authenticated owner and appends scoped snapshots",async()=>{
    await stores.a.domains.update(["d-extra"],{displayName:"Renamed",deactivatedAt:"2026-01-02T00:00:00Z",tombstonedAt:null},reason);
    await stores.a.observations.delete(["o-a"],reason);
    await stores.a.deviations.end(["v-a"],"2026-01-03T00:00:00Z",reason);
    await stores.a.deviations.delete(["v-a"],reason);
    await stores.a.associations.delete(["v-a","d-a"],reason);
    await stores.a.bindings.delete(["b-extra"],reason);
    const audit=await stores.a.audit.list();
    for(const entity of ["domains","observations","deviations_v2"]){
      expect(audit.some(e=>e.entity_type===entity&&e.action==="update"&&e.before&&e.after)).toBe(true);
    }
    for(const entity of ["deviation_domains","source_bindings"])
      expect(audit.some(e=>e.entity_type===entity&&e.action==="delete"&&e.before&&e.after===null)).toBe(true);
  });
  it("audit insertion failure rolls back every exposed entity mutation using the same actual transaction",async()=>{
    await f.client.query(`CREATE FUNCTION reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$;
      CREATE TRIGGER synthetic_audit_failure BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_audit();`);
    const next={...configs.c,policyVersionId:"p-c-2",revision:2,previousVersionId:"p-c",effectiveFrom:"2026-02-01T00:00:00Z"};
    const operations=[
      ()=>stores.c.domains.create({domainId:"rollback",slug:"rollback",displayName:"rollback"},reason),
      ()=>stores.c.domains.update(["d-c"],{displayName:"rollback"},reason),
      ()=>stores.c.policies.append(next,reason),
      ()=>stores.c.observations.create({observation:observationFor(configs.c,"rollback",1),idempotencyKey:"rollback"},reason),
      ()=>stores.c.observations.delete(["o-c"],reason),
      ()=>stores.c.evaluations.create({...evaluation("c"),resultId:"rollback",calculationVersion:"rollback"},reason),
      ()=>stores.c.deviations.create({...deviation("c"),deviationId:"rollback"},reason),
      ()=>stores.c.deviations.end(["v-c"],"2026-01-03T00:00:00Z",reason),
      ()=>stores.c.deviations.delete(["v-c"],reason),
      ()=>stores.a.associations.create(["v-a","d-a"],reason),
      ()=>stores.c.associations.delete(["v-c","d-c"],reason),
      ()=>stores.c.bindings.create({...binding("c"),bindingId:"rollback",externalId:"rollback"},reason),
      ()=>stores.c.bindings.delete(["b-c"],reason),
    ];
    for(const op of operations)await unchangedOnReject(op,503);
    await f.client.query("DROP TRIGGER synthetic_audit_failure ON audit_events; DROP FUNCTION reject_audit()");
    // Failure after policy and its audit but before the derived dimension audit
    // must roll back the ENTIRE policy/dimensions/audits transaction as well.
    await f.client.query(`CREATE FUNCTION reject_dimension() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$;
      CREATE TRIGGER synthetic_dimension_failure BEFORE INSERT ON dimension_definitions FOR EACH ROW EXECUTE FUNCTION reject_dimension();`);
    await unchangedOnReject(()=>stores.c.policies.append(next,reason),503);
    await f.client.query("DROP TRIGGER synthetic_dimension_failure ON dimension_definitions; DROP FUNCTION reject_dimension()");
    await unchangedOnReject(()=>stores.c.domains.create({domainId:"collision",slug:"same-slug",displayName:"collision"},reason),503);
  });
  it("generated query scope includes both org and owner, and composite keys in complete predicates",()=>{
    for(const {sql,parameters} of f.queries.filter(q=>/^(SELECT \*|UPDATE|DELETE)/.test(q.sql.trim())&&!q.sql.includes("audit_events"))){
      expect(sql).toContain("org_id=$1 AND owner_user_id=$2");expect(parameters[0]).toMatch(/^(one|two)$/);expect(parameters[1]).toMatch(/^[abc]$/);
      if(/FROM public.dimension_definitions.*measurement_id=\$4/s.test(sql))expect(sql).toContain("policy_version_id=$3 AND measurement_id=$4");
      if(/FROM public.deviation_domains.*domain_id=\$4/s.test(sql))expect(sql).toContain("deviation_id=$3 AND domain_id=$4");
    }
  });
  it("every exported read/write operation revalidates changed membership, including audit and idempotent paths",async()=>{
    await f.client.query("UPDATE organization_members SET role='member' WHERE user_id='a'");
    const s=stores.a;
    const operations:Array<()=>Promise<unknown>>=[()=>s.workspace(),()=>s.audit.list(),()=>s.audit.get("any")];
    for(const k of kinds)operations.push(()=>s[k].get(keys(k,"a")),()=>s[k].list(),()=>s[k].exists(keys(k,"a")));
    operations.push(()=>s.domains.create({domainId:"stale",slug:"stale",displayName:"stale"},reason),
      ()=>s.domains.update(["d-a"],{displayName:"stale"},reason),()=>s.policies.append(configs.a,reason),
      ()=>s.observations.create({observation:observationFor(configs.a,"o-a",2),idempotencyKey:"idem-a"},reason),
      ()=>s.observations.delete(["o-a"],reason),()=>s.evaluations.create(evaluation("a"),reason),
      ()=>s.deviations.create(deviation("a"),reason),()=>s.deviations.end(["v-a"],"2026-01-02T00:00:00Z",reason),
      ()=>s.deviations.delete(["v-a"],reason),()=>s.associations.create(["v-a","d-a"],reason),
      ()=>s.associations.delete(["v-a","d-a"],reason),()=>s.bindings.create(binding("a"),reason),()=>s.bindings.delete(["b-a"],reason));
    for(const operation of operations)await unchangedOnReject(operation,403);
  });
});

describe("personal practice repository preserves the legacy surface and fails closed on persisted evidence",()=>{
  let f:Awaited<ReturnType<typeof startFixture>>,pool:Pool,store:ReturnType<typeof createPolicyV2Storage>,c:DomainConfiguration;
  const request={isAuthenticated:()=>true,user:{claims:{sub:"personal-storage-owner"}}};
  const time=()=>new Date("2026-03-01T00:00:00Z");
  const input=(key:string)=>({submissionKey:key,domainId:c.domainId,policyVersionId:c.policyVersionId,practiceEvent:true,
    observedAt:"2026-01-10T12:00:00Z",values:{"m-repetitions":{valueType:"integer",value:2,unitId:"rep"}}});
  async function snapshot(){
    const state:Record<string,unknown>={};
    for(const table of ["domains","policy_versions","dimension_definitions","source_bindings","observations","audit_events","sessions","user_settings"])
      state[table]=(await f.client.query(`SELECT to_jsonb(t) row FROM public.${table} t ORDER BY to_jsonb(t)::text`)).rows;
    return JSON.stringify(state);
  }
  async function unchanged(operation:()=>Promise<unknown>,status:number){
    const before=await snapshot();await expect(operation()).rejects.toMatchObject({status});expect(await snapshot()).toBe(before);
  }
  beforeAll(async()=>{
    f=await startFixture("personal-practice-storage");
    await f.client.query(`INSERT INTO users(id) VALUES('personal-storage-owner');
      INSERT INTO organizations(org_id,display_name) VALUES('personal-storage-org','Synthetic');
      INSERT INTO organization_members(org_id,user_id,role) VALUES('personal-storage-org','personal-storage-owner','owner')`);
    const context=await createOrgContextResolver(f.db)(request);
    c={...configurationFor("personal-storage",MEASUREMENTS[1],10),organizationId:context.orgId,ownerUserId:context.actorUserId};
    store=createPolicyV2Storage(f.db,context,{clock:time});
    await createPolicyV2Storage(f.db,context,{clock:()=>new Date(c.effectiveFrom)}).domains.createWithPolicy({domainId:c.domainId,slug:"personal-storage",displayName:c.displayName},c,"Synthetic setup");
    pool=new Pool({host:f.root+"/socket",port:5432,user:"synthetic",database:"postgres",password:"",ssl:false,
      max:3,connectionTimeoutMillis:5000,options:"-c statement_timeout=10000 -c lock_timeout=5000"});
  },60000);
  afterAll(async()=>{if(pool)await pool.end();if(f)await f.cleanup();},60000);
  it("retains existing observation keys/API and excludes those rows from every personal read",async()=>{
    const old=await store.observations.create({observation:observationFor(c,"existing-raw-id",2),idempotencyKey:"same-caller-key"},"Synthetic old API");
    const saved=await store.personalPractice.create(input("same-caller-key"));
    expect(old.idempotency_key).toMatch(/^observation:v1:[a-f0-9]{64}$/);expect(saved.activity.activityId).not.toBe(old.observation_id);
    const row=(await f.client.query("SELECT * FROM observations WHERE observation_id=$1",[saved.activity.activityId])).rows[0];
    expect(row.idempotency_key).toMatch(/^personal-practice:v1:[a-f0-9]{64}$/);expect(row.legacy_source_type).toBeNull();expect(row.legacy_source_id).toBeNull();
    expect(Object.keys(store.personalPractice).sort()).toEqual(["create","eligibility","list","read","submission"].sort());
    expect((await store.personalPractice.list({})).activities.map(a=>a.activityId)).toEqual([saved.activity.activityId]);
    await unchanged(()=>store.personalPractice.read(old.observation_id),404);
    const before=await snapshot();expect(await store.observations.create({observation:observationFor(c,"existing-raw-id",2),idempotencyKey:"same-caller-key"},"Synthetic equal retry")).toEqual(old);
    expect(await snapshot()).toBe(before);
  });
  it("captures the trusted clock only after locked owned history, dimensions and writer lookup",async()=>{
    const context=await createOrgContextResolver(f.db)(request);let calls=0;
    const checked=createPolicyV2Storage(f.db,context,{clock:()=>{
      calls++;const recent=f.queries.slice(-5).map(q=>q.sql);
      expect(recent.some(sql=>sql.includes("policy_versions")&&sql.includes("FOR SHARE"))).toBe(true);
      expect(recent.some(sql=>sql.includes("dimension_definitions")&&sql.includes("FOR SHARE"))).toBe(true);
      expect(recent.at(-1)).toContain("source_bindings");return time();
    }});
    await checked.personalPractice.create(input("locked-clock"));expect(calls).toBe(1);
    const before=await snapshot();await checked.personalPractice.create(input("locked-clock"));expect(calls).toBe(1);expect(await snapshot()).toBe(before);
  });
  it("missing, duplicate and mismatched original scoped create snapshots fail closed on reads and retries",async()=>{
    const saved=await store.personalPractice.create(input("audit-evidence")),identity=JSON.stringify([saved.activity.activityId]);
    const audit=(await f.client.query("SELECT * FROM audit_events WHERE entity_type='observations' AND action='create' AND entity_id=$1",[identity])).rows[0];
    await f.client.query(`INSERT INTO users(id) VALUES('personal-storage-other');
      INSERT INTO organization_members(org_id,user_id,role) VALUES('personal-storage-org','personal-storage-other','member')`);
    await f.client.query("UPDATE audit_events SET actor_user_id='personal-storage-other' WHERE audit_event_id=$1",[audit.audit_event_id]);
    await unchanged(()=>store.personalPractice.read(saved.activity.activityId),503);
    await unchanged(()=>store.personalPractice.create(input("audit-evidence")),503);
    await f.client.query("UPDATE audit_events SET actor_user_id='personal-storage-owner' WHERE audit_event_id=$1",[audit.audit_event_id]);
    await f.client.query(`INSERT INTO audit_events(audit_event_id,org_id,actor_kind,actor_user_id,entity_type,entity_id,action,occurred_at,reason,"before","after")
      SELECT 'personal-duplicate-audit',org_id,actor_kind,actor_user_id,entity_type,entity_id,action,occurred_at,reason,"before","after"
      FROM audit_events WHERE audit_event_id=$1`,[audit.audit_event_id]);
    await unchanged(()=>store.personalPractice.submission("audit-evidence"),503);
    await unchanged(()=>store.personalPractice.create(input("audit-evidence")),503);
    await f.client.query("DELETE FROM audit_events WHERE audit_event_id='personal-duplicate-audit'");
    await f.client.query(`UPDATE audit_events SET "after"=jsonb_set("after",'{idempotency_key}','"personal-practice:v1:forged"') WHERE audit_event_id=$1`,[audit.audit_event_id]);
    await unchanged(()=>store.personalPractice.read(saved.activity.activityId),503);
    await f.client.query('UPDATE audit_events SET "after"=$2::jsonb WHERE audit_event_id=$1',[audit.audit_event_id,JSON.stringify(audit.after)]);
    await f.client.query("DELETE FROM audit_events WHERE audit_event_id=$1",[audit.audit_event_id]);
    await unchanged(()=>store.personalPractice.create(input("audit-evidence")),503);
    await f.client.query(`INSERT INTO audit_events(audit_event_id,org_id,actor_kind,actor_user_id,entity_type,entity_id,action,occurred_at,reason,"before","after")
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb)`,[audit.audit_event_id,audit.org_id,audit.actor_kind,audit.actor_user_id,
      audit.entity_type,audit.entity_id,audit.action,audit.occurred_at,audit.reason,JSON.stringify(audit.before),JSON.stringify(audit.after)]);
  });
  it("mismatched saved dimension definitions fail without substituting current settings or inferred units",async()=>{
    const definition=(await f.client.query("SELECT definition FROM dimension_definitions WHERE policy_version_id=$1",[c.policyVersionId])).rows[0].definition;
    await f.client.query(`UPDATE dimension_definitions SET definition=jsonb_set(definition,'{unit,unitId}','"invented-unit"') WHERE policy_version_id=$1`,[c.policyVersionId]);
    try {
      await unchanged(()=>store.personalPractice.create(input("dimension-failure")),503);
      await unchanged(()=>store.personalPractice.eligibility(c.domainId),503);
    } finally {await f.client.query("UPDATE dimension_definitions SET definition=$2::jsonb WHERE policy_version_id=$1",[c.policyVersionId,JSON.stringify(definition)]);}
  });
  it("rejects SQL-only microsecond drift even when PG Date decoding and the saved JSON appear identical",async()=>{
    const saved=await store.personalPractice.create(input("raw-sql-precision")),id=saved.activity.activityId;
    await f.client.query("UPDATE policy_versions SET effective_from=effective_from+interval '100 microseconds' WHERE policy_version_id=$1",[c.policyVersionId]);
    try {
      await unchanged(()=>store.personalPractice.eligibility(c.domainId),503);
      await unchanged(()=>store.personalPractice.create(input("raw-sql-precision")),503);
      await unchanged(()=>store.personalPractice.read(id),503);
    } finally {await f.client.query("UPDATE policy_versions SET effective_from=date_trunc('milliseconds',effective_from) WHERE policy_version_id=$1",[c.policyVersionId]);}
    await f.client.query("UPDATE observations SET observed_at=observed_at+interval '100 microseconds' WHERE observation_id=$1",[id]);
    try {
      await unchanged(()=>store.personalPractice.read(id),503);
      await unchanged(()=>store.personalPractice.submission("raw-sql-precision"),503);
      await unchanged(()=>store.personalPractice.create(input("raw-sql-precision")),503);
    } finally {await f.client.query("UPDATE observations SET observed_at=date_trunc('milliseconds',observed_at) WHERE observation_id=$1",[id]);}
    await f.client.query("UPDATE observations SET deleted_at='2026-02-01T00:00:00.0001Z' WHERE observation_id=$1",[id]);
    try {await unchanged(()=>store.personalPractice.read(id),503);}
    finally {await f.client.query("UPDATE observations SET deleted_at=NULL WHERE observation_id=$1",[id]);}
    const page=await store.personalPractice.list({domainId:c.domainId,limit:100});
    expect(page.activities.some(a=>a.activityId===id)).toBe(true);
    expect(Object.keys(await store.personalPractice.read(id)).some(key=>key.startsWith("__personal"))).toBe(false);
    const audit=(await f.client.query(`SELECT "after" FROM audit_events WHERE entity_type='observations' AND action='create' AND entity_id=$1`,[JSON.stringify([id])])).rows[0].after;
    expect(Object.keys(audit).some(key=>key.startsWith("__personal"))).toBe(false);
  });
  it("a caught nested failure poisons the pinned transaction and rolls back an earlier valid practice/audit",async()=>{
    const unit=createPinnedOwnershipUnit(pool);
    await unchanged(()=>unit.run(request,async ownership=>{
      const scoped=createPolicyV2Storage(ownership.db,ownership.context,{clock:time});
      await scoped.personalPractice.create(input("poisoned-unit"));
      await scoped.personalPractice.create({...input("poisoned-invalid"),practiceEvent:false}).catch(()=>{});
      return "Caller tried to ignore failure";
    }),503);
  });
});
