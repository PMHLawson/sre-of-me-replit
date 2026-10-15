import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import { Pool, type PoolClient } from "pg";
import { startFixture } from "../lib/ownership-fixture";
import { createOrgContextResolver, type OwnershipDatabase, type OrgContext } from "../lib/org-context";
import { createPinnedOwnershipUnit } from "../lib/pinned-ownership-unit";
import { createAuthenticatedBootstrapUnit } from "../lib/authenticated-bootstrap-unit";
import { createPersonalWorkspaceService } from "../services/personal-workspace-service";
import { createPolicyV2Storage } from "./policy-v2-storage";
import { ResourceLimitError, MAX_READ_ROWS, MAX_COLLECTION_ROWS, READ_TIMEOUT_MS } from "../lib/read-budget";
import { MAX_READ_BYTES, readComplete, withTransactionReadBudget } from "../lib/transaction-read-budget";
import { configurationFor, observationFor, MEASUREMENTS } from "../../shared/fixtures/domain-config-cases";
import type { DomainConfiguration } from "../../shared/domain-config";

describe("generic repositories complete their bounded evidence or fail without writes",()=>{
  let fixture:Awaited<ReturnType<typeof startFixture>>,pool:Pool;
  type Store=ReturnType<typeof createPolicyV2Storage>;
  const stores:Record<string,Store>={},contexts:Record<string,OrgContext>={},configs:Record<string,DomainConfiguration>={};
  const request=(user="bounds-a")=>({isAuthenticated:()=>true,user:{claims:{sub:user}}});
  const clock=()=>new Date("2026-01-20T00:00:00Z");
  const next=(user="bounds-a")=>({...configs[user],policyVersionId:"next-"+user,revision:2,
    previousVersionId:configs[user].policyVersionId,effectiveFrom:"2026-02-01T00:00:00Z"});
  async function state(){
    const result:Record<string,unknown>={};
    for(const table of ["domains","policy_versions","dimension_definitions","observations","audit_events","organization_members"])
      result[table]=(await fixture.client.query("SELECT to_jsonb(t) row FROM public."+table+" t ORDER BY to_jsonb(t)::text")).rows;
    return JSON.stringify(result);
  }
  async function observations(user:string,count:number,prefix="bulk"){
    const c=configs[user],sample=observationFor(c,"replaced",2);
    await fixture.client.query(
      "INSERT INTO public.observations(observation_id,org_id,owner_user_id,domain_id,policy_version_id,idempotency_key,observed_at,observation) "+
      "SELECT $1||'-'||n,$2,$3,$4,$5,$1||'-key-'||n,$6::timestamptz,"+
      "jsonb_set($7::jsonb,'{observationId}',to_jsonb($1||'-'||n)) FROM generate_series(1,$8::integer) n",
      [prefix+"-"+user,c.organizationId,user,c.domainId,c.policyVersionId,sample.observedAt,JSON.stringify(sample),count]);
  }
  async function noChange(operation:()=>Promise<unknown>,resource=true){
    const before=await state();
    const result=operation();
    if(resource)await expect(result).rejects.toMatchObject({status:503,code:"RESOURCE_LIMIT_EXCEEDED"});
    else await expect(result).rejects.toMatchObject({status:403});
    expect(await state()).toBe(before);
  }
  beforeAll(async()=>{
    for(const key of ["DATABASE_URL","SESSION_SECRET","OAUTH_TOKEN_ENCRYPTION_KEYRING"])
      if(process.env[key])throw Error("Synthetic repository tests must not inherit owner credentials");
    fixture=await startFixture("somr467-generic-bounds");
    pool=new Pool({host:fixture.root+"/socket",port:5432,user:"synthetic",database:"postgres",password:"",ssl:false,
      max:4,connectionTimeoutMillis:5000,options:"-c statement_timeout=10000 -c lock_timeout=5000"});
  },60000);
  beforeEach(async()=>{
    await fixture.client.query("TRUNCATE public.users, public.organizations CASCADE");
    await fixture.client.query("INSERT INTO public.users(id) VALUES('bounds-a'),('bounds-b'),('bounds-c');"+
      "INSERT INTO public.organizations(org_id,display_name) VALUES('bounds-one','One'),('bounds-two','Two');"+
      "INSERT INTO public.organization_members(org_id,user_id,role) VALUES"+
      "('bounds-one','bounds-a','owner'),('bounds-two','bounds-b','owner'),('bounds-one','bounds-c','member')");
    for(const user of ["bounds-a","bounds-b","bounds-c"]){
      const context=contexts[user]=await createOrgContextResolver(fixture.db)(request(user));
      const config=configs[user]={...configurationFor(user,MEASUREMENTS[1],10),
        organizationId:context.orgId,ownerUserId:user};
      const store=stores[user]=createPolicyV2Storage(fixture.db,context,{clock});
      await createPolicyV2Storage(fixture.db,context,{clock:()=>new Date(config.effectiveFrom)})
        .domains.createWithPolicy({domainId:config.domainId,slug:user,displayName:config.displayName},config,"Synthetic setup");
    }
  });
  afterAll(async()=>{try{if(pool)await pool.end();}finally{if(fixture)await fixture.cleanup();}},60000);

  it("validates every observation at the exact budget and preserves the complete history",async()=>{
    await observations("bounds-a",MAX_READ_ROWS);
    const before=(await fixture.client.query("SELECT observation_id,observation FROM observations ORDER BY observation_id")).rows;
    const appended=await stores["bounds-a"].policies.append(next(),"Synthetic prospective change");
    expect(appended.revision).toBe(2);
    expect((await stores["bounds-a"].observations.list())).toHaveLength(MAX_READ_ROWS);
    expect((await fixture.client.query("SELECT observation_id,observation FROM observations ORDER BY observation_id")).rows).toEqual(before);
    const q=fixture.queries.filter(q=>q.sql.includes("SELECT observation FROM public.observations")).at(-1)!;
    expect(q.sql).toContain("org_id=$1 AND owner_user_id=$2");
    expect(q.sql).toContain("LIMIT $4");
    expect(q.parameters.slice(0,-2)).toEqual(["bounds-one","bounds-a",configs["bounds-a"].domainId,MAX_READ_ROWS+1]);
  },15000);

  it("overflow is detected before any policy, dimension or audit insert",async()=>{
    await observations("bounds-a",MAX_READ_ROWS+1);
    const from=fixture.queries.length;
    await noChange(()=>stores["bounds-a"].policies.append(next(),"Synthetic overflow refusal"));
    expect(fixture.queries.slice(from).some(q=>/^\s*(INSERT|UPDATE|DELETE)\b/.test(q.sql))).toBe(false);
    await noChange(()=>stores["bounds-a"].observations.list());
  });

  it("does not spend one owner's budget on a same-org colleague or another organization",async()=>{
    await observations("bounds-a",1);
    await observations("bounds-b",MAX_READ_ROWS+1);
    await observations("bounds-c",MAX_READ_ROWS+1);
    expect((await stores["bounds-a"].policies.append(next(),"Synthetic isolated append")).owner_user_id).toBe("bounds-a");
    expect(await stores["bounds-a"].observations.list()).toHaveLength(1);
    await noChange(()=>stores["bounds-b"].observations.list());
    await noChange(()=>stores["bounds-c"].observations.list());
  });

  it("two concurrent over-budget policy changes leave the entire state unchanged",async()=>{
    await observations("bounds-a",MAX_READ_ROWS+1);
    const before=await state(),unit=createPinnedOwnershipUnit(pool);
    const results=await Promise.allSettled([1,2].map(n=>unit.run(request(),async owned=>{
      const store=createPolicyV2Storage(owned.db,owned.context,{clock});
      return store.policies.append({...next(),policyVersionId:"concurrent-"+n},"Synthetic concurrent overflow");
    })));
    expect(results.every(r=>r.status==="rejected"&&r.reason instanceof ResourceLimitError)).toBe(true);
    expect(await state()).toBe(before);
  });

  it("rejects oversized version evidence and saved dimensions without partial validation",async()=>{
    const c=configs["bounds-a"],from=fixture.queries.length;
    await fixture.client.query(
      "INSERT INTO public.policy_versions(policy_version_id,org_id,owner_user_id,domain_id,revision,effective_from,previous_version_id,configuration) "+
      "SELECT 'many-policy-'||n,$1,$2,$3,n+1,'2026-01-01T00:00:00Z'::timestamptz+n*interval '1 second',"+
      "CASE WHEN n=1 THEN $4 ELSE 'many-policy-'||(n-1) END,"+
      "$5::jsonb||jsonb_build_object('policyVersionId','many-policy-'||n,'revision',n+1,"+
      "'previousVersionId',CASE WHEN n=1 THEN $4 ELSE 'many-policy-'||(n-1) END,"+
      "'effectiveFrom',to_char('2026-01-01T00:00:00Z'::timestamptz+n*interval '1 second','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')) "+
      "FROM generate_series(1,$6::integer) n",
      [c.organizationId,c.ownerUserId,c.domainId,c.policyVersionId,JSON.stringify(c),MAX_READ_ROWS]);
    await noChange(()=>stores["bounds-a"].personalPractice.eligibility(c.domainId));
    await noChange(()=>stores["bounds-a"].policies.list(c.domainId));
    const reads=fixture.queries.slice(from).filter(q=>q.sql.includes("FROM public.policy_versions"));
    expect(reads.some(q=>q.sql.includes("LIMIT $4")&&q.parameters.at(-3)===MAX_READ_ROWS+1)).toBe(true);
    // Reset only this synthetic domain's extra policy rows, then independently
    // prove the saved-dimension budget, rather than a version-count failure.
    await fixture.client.query("DELETE FROM public.policy_versions WHERE policy_version_id LIKE 'many-policy-%'");
    await fixture.client.query(
      "INSERT INTO public.dimension_definitions(org_id,owner_user_id,domain_id,policy_version_id,measurement_id,definition) "+
      "SELECT $1,$2,$3,$4,'extra-'||n,jsonb_set($5::jsonb,'{measurementId}',to_jsonb('extra-'||n)) FROM generate_series(1,$6::integer) n",
      [c.organizationId,c.ownerUserId,c.domainId,c.policyVersionId,JSON.stringify(c.measurements[0]),MAX_COLLECTION_ROWS]);
    await noChange(()=>stores["bounds-a"].personalPractice.eligibility(c.domainId));
    await noChange(()=>stores["bounds-a"].dimensions.list());
  });

  it("preserves activity keysets and reuses locked policy evidence only within one operation",async()=>{
    const c=configs["bounds-a"];
    for(const key of ["one","two","three"])await stores["bounds-a"].personalPractice.create({
      submissionKey:key,domainId:c.domainId,policyVersionId:c.policyVersionId,practiceEvent:true,
      observedAt:"2026-01-10T12:00:00Z",values:{"m-repetitions":{valueType:"integer",value:2,unitId:"rep"}}});
    const from=fixture.queries.length,first=await stores["bounds-a"].personalPractice.list({limit:2});
    expect(first.activities).toHaveLength(2);expect(first.nextCursor).toBeTypeOf("string");
    const reads=fixture.queries.slice(from);
    expect(reads.filter(q=>q.sql.includes("FROM public.policy_versions"))).toHaveLength(1);
    expect(reads.filter(q=>q.sql.includes("FROM public.dimension_definitions"))).toHaveLength(1);
    const rest=await stores["bounds-a"].personalPractice.list({limit:2,cursor:first.nextCursor!});
    expect(rest.activities).toHaveLength(1);expect(rest.nextCursor).toBeNull();
    expect(new Set([...first.activities,...rest.activities].map(x=>x.activityId)).size).toBe(3);
    await expect(stores["bounds-c"].personalPractice.list({limit:2,cursor:first.nextCursor!})).rejects.toMatchObject({status:400});
    await expect(stores["bounds-a"].personalPractice.list({limit:101})).rejects.toMatchObject({status:400});
    const offset=fixture.queries.length;
    expect((await stores["bounds-a"].personalPractice.list({})).activities).toHaveLength(3);
    const page=fixture.queries.slice(offset).find(q=>q.sql.includes("ORDER BY observed_at DESC,observation_id DESC LIMIT $6"))!;
    expect(page.parameters.at(-3)).toBe(51); // existing default50 + lookahead
    // A later transaction sees changed saved evidence; the page cache cannot
    // conceal corruption or cross a request/owner boundary.
    await fixture.client.query("UPDATE dimension_definitions SET definition=jsonb_set(definition,'{meaning}','\"Changed\"') WHERE policy_version_id=$1",[c.policyVersionId]);
    await expect(stores["bounds-a"].personalPractice.list({})).rejects.toMatchObject({status:503});
  });

  it("binds dynamic generic collection limits as native PostgreSQL parameters",async()=>{
    const from=fixture.queries.length;
    expect((await stores["bounds-a"].observations.list())).toEqual([]);
    const all=fixture.queries.slice(from).find(q=>q.sql.includes("SELECT * FROM public.observations"))!;
    expect(all.sql).toContain("LIMIT $3");
    expect(all.parameters.slice(0,-2)).toEqual([configs["bounds-a"].organizationId,configs["bounds-a"].ownerUserId,MAX_READ_ROWS+1]);
    const scopedFrom=fixture.queries.length;
    expect((await stores["bounds-a"].policies.list(configs["bounds-a"].domainId))).toHaveLength(1);
    const scoped=fixture.queries.slice(scopedFrom).find(q=>q.sql.includes("SELECT * FROM public.policy_versions"))!;
    expect(scoped.sql).toContain("domain_id=$3");expect(scoped.sql).toContain("LIMIT $4");
    expect(scoped.parameters.at(-3)).toBe(MAX_READ_ROWS+1);
  });

  it("bounds every generic owner list and actor audit list without deleting or truncating",async()=>{
    const c=configs["bounds-a"];
    await fixture.client.query(
      "INSERT INTO public.domains(domain_id,org_id,owner_user_id,slug,display_name) "+
      "SELECT 'extra-domain-'||n,$1,$2,'extra-slug-'||n,'Extra' FROM generate_series(1,$3::integer) n",
      [c.organizationId,c.ownerUserId,MAX_COLLECTION_ROWS]);
    await noChange(()=>stores["bounds-a"].domains.list());
    await fixture.client.query(
      "INSERT INTO public.audit_events(audit_event_id,org_id,actor_kind,actor_user_id,entity_type,entity_id,action,occurred_at,reason,\"before\",\"after\") "+
      "SELECT 'extra-audit-'||n,$1,'user',$2,'domains','[\"synthetic\"]','create',now(),'Synthetic audit',NULL,'{}'::jsonb "+
      "FROM generate_series(1,$3::integer) n",[c.organizationId,c.ownerUserId,MAX_COLLECTION_ROWS]);
    await noChange(()=>stores["bounds-a"].audit.list());
    expect((await stores["bounds-c"].domains.list())).toHaveLength(1);
  });

  it("PostgreSQL withholds an oversized existing JSON payload before pg decodes it or any policy write starts",async()=>{
    await observations("bounds-a",1,"large-existing");
    const huge="界".repeat(Math.ceil(MAX_READ_BYTES/3)+100);
    await fixture.client.query("UPDATE observations SET observation=jsonb_set(observation,'{notes}',to_jsonb($2::text)) WHERE owner_user_id=$1",["bounds-a",huge]);
    const digest=async()=>(await fixture.client.query("SELECT encode(sha256(convert_to(observation::text,'UTF8')),'hex') digest FROM observations WHERE owner_user_id=$1",["bounds-a"])).rows;
    const before=await digest(),witness:any[]=[];
    const monitored:OwnershipDatabase={transaction:fn=>fixture.db.transaction(tx=>fn({query:async(sql,values)=>{
      const result=await tx.query(sql,values);
      if(sql.includes("SELECT observation FROM public.observations"))witness.push(...result.rows);
      return result;
    }}))};
    const context=await createOrgContextResolver(monitored)(request());
    const store=createPolicyV2Storage(monitored,context,{clock}),from=fixture.queries.length;
    await expect(store.policies.append(next(),"Synthetic byte refusal")).rejects.toMatchObject({status:503,code:"RESOURCE_LIMIT_EXCEEDED"});
    expect(witness).toHaveLength(1);expect(Number(witness[0].__read_bytes)).toBeGreaterThan(MAX_READ_BYTES);
    expect(witness[0].observation).toBeNull();
    expect(fixture.queries.slice(from).some(q=>/^\s*(INSERT|UPDATE|DELETE)\b/.test(q.sql))).toBe(false);
    expect(await digest()).toEqual(before);expect(await stores["bounds-c"].observations.list()).toEqual([]);
  },20000);

  it("shares one byte allowance across repeated complete reads and nested guards",async()=>{
    await observations("bounds-a",1,"shared-bytes");
    await fixture.client.query("UPDATE observations SET observation=jsonb_set(observation,'{notes}',to_jsonb($2::text)) WHERE owner_user_id=$1",["bounds-a","é".repeat(1572864)]);
    const witness:any[]=[];
    await expect(fixture.db.transaction(raw=>withTransactionReadBudget({query:async(sql,values)=>{
      const result=await raw.query(sql,values);if(sql.includes("__admitted"))witness.push(...result.rows);return result;
    }},async tx=>{
      const source="SELECT observation FROM public.observations WHERE org_id=$1 AND owner_user_id=$2 ORDER BY observation_id LIMIT $3 FOR SHARE";
      const values=["bounds-one","bounds-a",2];
      expect(await readComplete(tx,source,values,["observation"],1)).toHaveLength(1);
      await withTransactionReadBudget(tx,async nested=>{expect(await readComplete(nested,source,values,["observation"],1)).toHaveLength(1);});
      return readComplete(tx,source,values,["observation"],1);
    }))).rejects.toMatchObject({status:503,code:"RESOURCE_LIMIT_EXCEEDED"});
    expect(witness).toHaveLength(3);expect(witness[0].observation.notes.length).toBe(1572864);
    expect(witness[1].observation.notes.length).toBe(1572864);expect(witness[2].observation).toBeNull();
  },20000);

  it("PostgreSQL actually cancels a slow bounded read and restores the prior session settings",async()=>{
    const wrapped:OwnershipDatabase={transaction:fn=>fixture.db.transaction(tx=>fn({
      query:(sql,values)=>sql.includes("SELECT observation FROM public.observations")
        ?tx.query("SELECT pg_sleep($1)",[(READ_TIMEOUT_MS+1000)/1000]):tx.query(sql,values),
    }))};
    const context=await createOrgContextResolver(wrapped)(request());
    const store=createPolicyV2Storage(wrapped,context,{clock}),before=await state();
    await expect(store.policies.append(next(),"Synthetic timeout")).rejects.toMatchObject({status:503,code:"RESOURCE_LIMIT_EXCEEDED"});
    expect(await state()).toBe(before);
    expect((await fixture.client.query("SHOW statement_timeout")).rows[0].statement_timeout).toBe("10s");
    expect((await fixture.client.query("SHOW lock_timeout")).rows[0].lock_timeout).toBe("2s");
  },10000);

  it("many memberships keep the existing403 rejection while fetching only two",async()=>{
    await fixture.client.query(
      "INSERT INTO organizations(org_id,display_name) SELECT 'extra-org-'||n,'Extra' FROM generate_series(1,500) n;"+
      "INSERT INTO organization_members(org_id,user_id,role) SELECT 'extra-org-'||n,'bounds-a','member' FROM generate_series(1,500) n");
    const seen:number[]=[];
    const monitored:OwnershipDatabase={transaction:fn=>fixture.db.transaction(tx=>fn({query:async(sql,values)=>{
      const result=await tx.query(sql,values);
      if(sql.includes("FROM public.organization_members WHERE user_id=$1"))seen.push(result.rows.length);
      return result;
    }}))};
    await expect(createOrgContextResolver(monitored)(request())).rejects.toMatchObject({status:403});
    expect(seen).toEqual([2]);
    const bootstrapReads:number[]=[];
    const connect=async()=>{
      const client=await pool.connect();
      return {query:async(sql:string,values?:unknown[])=>{
        const result=await client.query(sql,values);
        if(sql.includes("FROM public.organization_members WHERE user_id=$1"))bootstrapReads.push(result.rows.length);
        return result;
      },release:(destroy?:boolean)=>client.release(destroy)} as unknown as PoolClient;
    };
    const units=createAuthenticatedBootstrapUnit({connect:connect as Pool["connect"]});
    const service=createPersonalWorkspaceService(units),before=await state();
    await expect(service.status(request())).rejects.toMatchObject({status:403});
    await expect(service.ensure(request(),{})).rejects.toMatchObject({status:403});
    expect(bootstrapReads).toEqual([2,2]);expect(await state()).toBe(before);
  });
});
