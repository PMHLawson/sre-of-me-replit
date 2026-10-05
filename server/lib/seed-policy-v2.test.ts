import { beforeAll,afterAll,it,expect,vi } from "vitest";
import { startFixture,connectFixture } from "./ownership-fixture";
import { seedPolicyV2 } from "./seed-policy-v2";
import { backfillPolicyV2 } from "../../script/backfill-policy-v2";
import { DomainConfigurationSchema } from "../../shared/domain-config";
import { DOMAIN_POLICY } from "./policy-engine";
import type { OwnershipDatabase } from "./org-context";
let f:Awaited<ReturnType<typeof startFixture>>;
const request=(actor:string)=>({isAuthenticated:()=>true,user:{claims:{sub:actor}}});
const slugs=["martial-arts","meditation","fitness","music"] as const;
async function owner(id:string){
 await f.client.query("INSERT INTO users(id) VALUES($1)",[id]);
 await f.client.query("INSERT INTO user_settings(user_id,timezone,day_start_hour,window_days) VALUES($1,'Europe/London',3,14)",[id]);
 for(const slug of slugs)await f.client.query(`INSERT INTO sessions(id,user_id,domain,duration_minutes,timestamp,deleted_at)
 VALUES($1,$2,$3,1,'2020-01-01T00:00:00Z','2020-02-01T00:00:00Z'),($4,$2,$3,30,'2026-01-01T00:00:00Z',NULL)`,
 [`${id}-${slug}-old`,id,slug,`${id}-${slug}-new`]);
}
async function snapshot(){
 const state:any={};
 for(const table of ["users","sessions","user_settings","deviations","session_edits","http_sessions","organizations","organization_members","domains","policy_versions",
 "dimension_definitions","source_bindings","observations","deviations_v2","deviation_domains","evaluation_results","audit_events"])
 state[table]=(await f.client.query(`SELECT to_jsonb(t) AS value FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
 return JSON.stringify(state);
}
async function rejected(fn:()=>Promise<unknown>,status?:number){
 const before=await snapshot();
 if(status)await expect(fn()).rejects.toMatchObject({status});else await expect(fn()).rejects.toThrow();
 expect(await snapshot()).toBe(before);
}
beforeAll(async()=>{
 f=await startFixture("seed");
 await owner("a");await owner("b");
 await f.client.query("INSERT INTO sessions(id,domain,duration_minutes,timestamp) VALUES('unowned','music',5,now())");
 for(const actor of ["a","b"]){
  await f.client.query("INSERT INTO deviations(id,user_id,domain,reason,start_at) VALUES($1,$2,'music','synthetic',now())",[`legacy-${actor}`,actor]);
  await f.client.query("INSERT INTO session_edits(id,session_id,user_id,reason,changed_fields) VALUES($1,$2,$3,'synthetic','durationMinutes')",
   [`edit-${actor}`,`${actor}-music-new`,actor]);
  await f.client.query("INSERT INTO http_sessions(sid,sess,expire) VALUES($1,$2,'2030-01-01')",
   [`synthetic-${actor}`,{synthetic:true,actor}]);
 }
},60000);
afterAll(async()=>{if(f)await f.cleanup();},60000);
it("inert wrapper and missing authentication refuse before any database operation",async()=>{
 expect(()=>backfillPolicyV2()).toThrow();
 const never:OwnershipDatabase={transaction:async()=>{throw Error("MUST NOT CONNECT");}};
 await expect(seedPolicyV2(never,{})).rejects.toMatchObject({status:401});
 await expect(seedPolicyV2(never,{isAuthenticated:()=>false,user:{claims:{sub:"a"}}})).rejects.toMatchObject({status:401});
 await expect(seedPolicyV2(never,{...request("a"),body:{owner:{id:"b"}}} as any)).rejects.toMatchObject({status:400});
});
it("malformed/missing authenticated claims and header-only authority fail before DB access",async()=>{
 const transaction=vi.fn(async()=>{throw Error("MUST NOT ACCESS DB");});
 const db:OwnershipDatabase={transaction};
 const attempts:any[]=[
  {isAuthenticated:()=>true},
  {isAuthenticated:()=>true,user:null},
  ...[undefined,null,{}, {sub:null},{sub:42},{sub:{}},{sub:""},{sub:" a"},{sub:"a "},{sub:"\u0000"},{sub:"x".repeat(201)}]
   .map(claims=>({isAuthenticated:()=>true,user:{claims}})),
  {headers:{"x-user-id":"a","x-owner-id":"a",authorization:"synthetic"}},
  {isAuthenticated:()=>true,headers:{"x-user-id":"a","x-owner-id":"a",authorization:"synthetic"}},
  {isAuthenticated:()=>false,user:{claims:{sub:"a"}},headers:{"x-owner-id":"a"}},
 ];
 for(const attempt of attempts)await expect(seedPolicyV2(db,attempt)).rejects.toMatchObject({status:401});
 await expect(seedPolicyV2(db,{...request("a"),body:{nested:{actor:"b"}}} as any)).rejects.toMatchObject({status:400});
 expect(transaction).not.toHaveBeenCalled();
});
it("infinite PostgreSQL timestamps and invalid Date decoding reject with 400 and unchanged rows",async()=>{
 for(const [i,value] of ["infinity","-infinity"].entries()){
  const actor=`infinite-${i}`;await owner(actor);
  await f.client.query("UPDATE sessions SET timestamp=$1::timestamptz WHERE id=$2",[value,`${actor}-music-old`]);
  await rejected(()=>seedPolicyV2(f.db,request(actor)),400);
 }
 await owner("invalid-date");
 // PostgreSQL refuses literal invalid dates. Exercise an invalid JS Date at the
 // decoder boundary while every query/transaction still executes on real PG.
 let injected=0;
 const decoding:OwnershipDatabase={transaction:fn=>f.db.transaction(tx=>fn({
  query:async(sql,values)=>{
   const result=await tx.query(sql,values);
   if(sql.startsWith("SELECT * FROM public.sessions")){
    result.rows=result.rows.map((r,i)=>i===0?{...r,timestamp:new Date(NaN)}:r);injected++;
   }
   return result;
  },
 }))};
 await rejected(()=>seedPolicyV2(decoding,request("invalid-date")),400);
 expect(injected).toBe(1);
});
it("seeds two independent existing owners with correct semantics, historical dates and exact reruns",async()=>{
 const legacy=(await f.client.query("SELECT to_jsonb(s) AS v FROM sessions s ORDER BY id")).rows;
 for(const user of ["a","b"]){
  const start=Date.now(),mapping=await seedPolicyV2(f.db,request(user));
  expect(Object.keys(mapping)).toEqual(slugs);
  const before=await snapshot();expect(await seedPolicyV2(f.db,request(user))).toEqual(mapping);expect(await snapshot()).toBe(before);
  const policies=(await f.client.query("SELECT * FROM policy_versions WHERE owner_user_id=$1",[user])).rows;
  for(const p of policies){
   const c=DomainConfigurationSchema.parse(p.configuration),spec=DOMAIN_POLICY[c.displayName as typeof slugs[number]];
   expect(c.effectiveFrom).toBe("2020-01-01T00:00:00.000Z");
   expect(Date.parse(c.review.anchorAt)).toBeGreaterThanOrEqual(start);expect(c.review.intervalDays).toBe(84);
   expect(c.boundary).toEqual({timezone:"Europe/London",dayStartHour:3});
   expect(c.measurements[1]).toMatchObject({countBy:"distinct_days",unit:{unitId:"day"},scope:{kind:"period",windowDays:7}});
   expect(c.targets.normal.conditions[0]).toMatchObject({constraint:{value:spec.targetMinutes},periodAggregation:{method:"sum"}});
   expect(c.targets.normal.conditions[1]).toMatchObject({constraint:{value:spec.sessionsTarget}});
   expect(c.qualification).toMatchObject({condition:{constraint:{value:spec.sessionFloor},basis:{kind:"per_event"}}});
   expect(c.references[0]).toMatchObject({purpose:"develop",status:"known",evidence:{category:"personal",confidence:"unknown",review:{status:"unreviewed"}}});
   expect(c.references.slice(1).every(r=>r.status==="unknown")).toBe(true);
   expect(c.goal.privateMotivation).toBeUndefined();expect(c.goal.currentCapability).toBeUndefined();
   expect(p.evaluation_policy).toMatchObject({version:1,trendStabilityEpsilon:2,guardrail:{mandatoryCapBand:"WARNING"}});
  }
 }
 expect((await f.client.query("SELECT count(DISTINCT org_id)::int n FROM organization_members")).rows[0].n).toBe(2);
 expect((await f.client.query("SELECT count(*)::int n FROM audit_events")).rows[0].n).toBe(44);
 expect((await f.client.query("SELECT to_jsonb(s) AS v FROM sessions s ORDER BY id")).rows).toEqual(legacy);
 expect((await f.client.query("SELECT window_days FROM user_settings")).rows.every(r=>r.window_days===14)).toBe(true);
 for(const table of ["observations","deviations_v2","evaluation_results"])expect((await f.client.query(`SELECT * FROM ${table}`)).rows).toEqual([]);
});
it("rejects unknown/fresh users, missing/invalid settings, invalid/unmapped history and forged inputs unchanged",async()=>{
 await rejected(()=>seedPolicyV2(f.db,request("unknown")));
 await f.client.query("INSERT INTO users(id) VALUES('fresh')");
 await rejected(()=>seedPolicyV2(f.db,request("fresh")));
 for(const [i,sql] of [
 "DELETE FROM user_settings WHERE user_id=$1",
 "UPDATE user_settings SET timezone='bad/zone' WHERE user_id=$1",
 "UPDATE user_settings SET day_start_hour=25 WHERE user_id=$1",
 "UPDATE user_settings SET window_days=0 WHERE user_id=$1",
 "UPDATE user_settings SET window_days=13 WHERE user_id=$1",
 "UPDATE sessions SET domain='unknown' WHERE user_id=$1",
 "UPDATE sessions SET duration_minutes=-1 WHERE user_id=$1",
 "DELETE FROM sessions WHERE user_id=$1 AND domain='music'",
 ].entries()){
  const id=`bad-${i}`;await owner(id);await f.client.query(sql,[id]);await rejected(()=>seedPolicyV2(f.db,request(id)));
 }
 for(const field of ["body","query","params"])await rejected(()=>seedPolicyV2(f.db,{...request("a"),[field]:{clock:0,owner:{id:"b"}}} as any));
});
it("rejects ambiguous/shared/member/nonlegacy/partial and conflicting reruns without changing other owners",async()=>{
 for(const [i,sql] of [
 "UPDATE organization_members SET role='member' WHERE user_id=$1",
 "UPDATE organizations SET rollout_mode='shadow' WHERE org_id=(SELECT org_id FROM organization_members WHERE user_id=$1)",
 "UPDATE policy_versions SET evaluation_policy='{}' WHERE owner_user_id=$1",
 "DELETE FROM source_bindings WHERE owner_user_id=$1",
 "UPDATE source_bindings SET metadata='{}' WHERE owner_user_id=$1",
 "UPDATE policy_versions SET configuration=jsonb_set(configuration,'{displayName}','\"Changed\"') WHERE owner_user_id=$1",
 "DELETE FROM audit_events WHERE actor_user_id=$1",
 ].entries()){
  const id=`conflict-${i}`;await owner(id);await seedPolicyV2(f.db,request(id));await f.client.query(sql,[id]);await rejected(()=>seedPolicyV2(f.db,request(id)));
 }
 await owner("partial");
 await f.client.query(`INSERT INTO organizations(org_id,display_name) VALUES('partial','Personal legacy workspace');
 INSERT INTO organization_members VALUES('partial','partial','owner',now(),now())`);
 await rejected(()=>seedPolicyV2(f.db,request("partial")));
 await f.client.query("INSERT INTO organization_members VALUES('partial','a','owner',now(),now())");
 await rejected(()=>seedPolicyV2(f.db,request("a")));await rejected(()=>seedPolicyV2(f.db,request("partial")));
});
it("actual concurrent connections serialize initial seed and exact rerun with one mapping",async()=>{
 await owner("concurrent");
 const clients=await Promise.all([connectFixture(f.root),connectFixture(f.root)]);
 try{
  const adapters=clients.map(client=>({transaction:async(fn:any)=>{
   await client.query("BEGIN");try{const r=await fn(client);await client.query("COMMIT");return r;}
   catch(e){await client.query("ROLLBACK");throw e;}
  }}) as OwnershipDatabase);
  const [a,b]=await Promise.all(adapters.map(db=>seedPolicyV2(db,request("concurrent"))));
  expect(a).toEqual(b);
  expect((await f.client.query("SELECT count(*)::int n FROM audit_events WHERE actor_user_id='concurrent'")).rows[0].n).toBe(22);
 }finally{await Promise.all(clients.map(c=>c.end()));}
});
it("every entity and audit boundary failure rolls back all bootstrap and subsequent data",async()=>{
 await owner("rollback");
 for(const table of ["organizations","organization_members","domains","policy_versions","dimension_definitions","source_bindings"]){
  await f.client.query(`CREATE FUNCTION seed_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic'; END $$;
  CREATE TRIGGER seed_fail BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION seed_fail();`);
  try{await rejected(()=>seedPolicyV2(f.db,request("rollback")));}
  finally{await f.client.query(`DROP TRIGGER seed_fail ON ${table}; DROP FUNCTION seed_fail()`);}
  await f.client.query(`CREATE FUNCTION seed_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.entity_type='${table}' THEN RAISE EXCEPTION 'synthetic'; END IF; RETURN NEW; END $$;
  CREATE TRIGGER seed_fail BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION seed_fail();`);
  try{await rejected(()=>seedPolicyV2(f.db,request("rollback")));}
  finally{await f.client.query("DROP TRIGGER seed_fail ON audit_events; DROP FUNCTION seed_fail()");}
 }
});
it("late music failures in all repeated entity/audit types roll back earlier domains",async()=>{
 await owner("late-rollback");
 for(const table of ["domains","policy_versions","dimension_definitions","source_bindings"]){
  for(const audit of [false,true]){
   // A sequence is deliberately nontransactional: it proves the late trigger
   // fired only after all three earlier domains and their audits existed.
   await f.client.query("CREATE SEQUENCE late_failure_witness");
   const target=audit?"audit_events":table;
   const condition=audit
    ?`NEW.entity_type='${table}' AND NEW."after"->>'owner_user_id'='late-rollback' AND
      ${table==="domains"?'NEW."after"->>\'slug\'=\'music\'':`EXISTS(SELECT 1 FROM domains d WHERE d.domain_id=NEW."after"->>'domain_id' AND d.slug='music')`}`
    :`NEW.owner_user_id='late-rollback' AND ${table==="domains"?"NEW.slug='music'": "EXISTS(SELECT 1 FROM domains d WHERE d.domain_id=NEW.domain_id AND d.slug='music')"}`;
   await f.client.query(`CREATE FUNCTION late_seed_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF ${condition} THEN
     IF (SELECT count(*) FROM domains WHERE owner_user_id='late-rollback' AND slug<>'music')<>3
      OR (SELECT count(*) FROM policy_versions p JOIN domains d ON d.domain_id=p.domain_id WHERE p.owner_user_id='late-rollback' AND d.slug<>'music')<>3
      OR (SELECT count(*) FROM dimension_definitions p JOIN domains d ON d.domain_id=p.domain_id WHERE p.owner_user_id='late-rollback' AND d.slug<>'music')<>6
      OR (SELECT count(*) FROM source_bindings p JOIN domains d ON d.domain_id=p.domain_id WHERE p.owner_user_id='late-rollback' AND d.slug<>'music')<>3
      OR (SELECT count(*) FROM audit_events WHERE actor_user_id='late-rollback')<17
     THEN RAISE EXCEPTION 'earlier domains not complete'; END IF;
     PERFORM nextval('late_failure_witness');RAISE EXCEPTION 'synthetic late failure';
    END IF; RETURN NEW; END $$;
    CREATE TRIGGER late_seed_fail BEFORE INSERT ON ${target} FOR EACH ROW EXECUTE FUNCTION late_seed_fail();`);
   try{
    await rejected(()=>seedPolicyV2(f.db,request("late-rollback")),503);
    expect((await f.client.query("SELECT is_called FROM late_failure_witness")).rows[0].is_called).toBe(true);
   }finally{
    await f.client.query(`DROP TRIGGER late_seed_fail ON ${target}; DROP FUNCTION late_seed_fail(); DROP SEQUENCE late_failure_witness`);
   }
  }
 }
});