import {beforeAll,afterAll,beforeEach,describe,expect,it,vi} from "vitest";
import {drizzle} from "drizzle-orm/node-postgres";
import {Pool} from "pg";
import * as schema from "@shared/schema";
import {startFixture} from "./lib/ownership-fixture";
import {seedPolicyV2} from "./lib/seed-policy-v2";
import {importLegacyObservations} from "./services/legacy-observation-sync";
import {runStartupRetention} from "./startup-retention";
import {createAuthenticatedBootstrapUnit} from "./lib/authenticated-bootstrap-unit";
import {createLegacyDeviationMutations} from "./services/legacy-deviation-mutations";
vi.mock("./db",()=>({db:{}}));
import {DatabaseStorage} from "./storage";

describe("actual retention, deviation and settings writes with owner admission",()=>{
 let f:Awaited<ReturnType<typeof startFixture>>,pool:Pool,store:DatabaseStorage,
  deviationStore:ReturnType<typeof createLegacyDeviationMutations>,n=0,owner:string,other:string,id:string;
 beforeAll(async()=>{
  f=await startFixture("legacy-retention-write-budget");
  pool=new Pool({host:f.root+"/socket",port:5432,user:"synthetic",database:"postgres",password:"",ssl:false,max:2,connectionTimeoutMillis:5000});
  store=new DatabaseStorage(drizzle(f.client,{schema}),pool);
  deviationStore=createLegacyDeviationMutations(createAuthenticatedBootstrapUnit(pool));
 },60000);
 afterAll(async()=>{try{if(pool)await pool.end();}finally{if(f)await f.cleanup();}},60000);
 beforeEach(async()=>{
  n++;owner="retention-owner-"+n;other="retention-other-"+n;id="retention-session-"+n;
  await f.client.query("INSERT INTO users(id) VALUES($1),($2)",[owner,other]);
  await f.client.query("INSERT INTO sessions(id,user_id,domain,duration_minutes,timestamp,notes,is_anomaly,anomaly_note) VALUES($1,$2,'music',900,'2020-01-01T01:02:03.123456Z',$3,true,$4)",
   [id,owner," exact old note 🙂 ".repeat(500)," exact old explanation ".repeat(300)]);
 });
 const request=(who=owner)=>({isAuthenticated:()=>true,user:{claims:{sub:who}}});
 const seedExistingContext=async()=>{
  // Fixture metadata only: existing membership avoids charging/bootstrap setup
  // in tests whose contract is the number of accepted deviation mutations.
  const org="retention-org-"+n;
  await f.client.query("INSERT INTO organizations(org_id,display_name) VALUES($1,'Synthetic retention workspace')",[org]);
  await f.client.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')",[org,owner]);
 };
 const deviationAudits=async()=> (await f.client.query("SELECT to_jsonb(a) r FROM audit_events a WHERE actor_user_id=$1 AND entity_type='legacy_deviation' ORDER BY occurred_at,audit_event_id",[owner])).rows.map(row=>row.r);
 const raw=async()=> (await f.client.query("SELECT to_jsonb(s) r FROM sessions s WHERE id=$1",[id])).rows[0]?.r;
 const counts=async(who=owner)=> (await f.client.query("SELECT minute_count,day_count FROM owner_write_resource_budgets WHERE owner_user_id=$1",[who])).rows;
 it("soft deletion and restoration change only deletion state, keep old text exact and return bounded summaries",async()=>{
  const before=await raw(),deleted=await store.softDeleteSession(owner,id) as any;
  expect(deleted.deletedAt).toBeInstanceOf(Date);expect(deleted.notes).toBeNull();expect(deleted.anomalyNote).toBeNull();
  expect(deleted.notesBytes).toBe(Buffer.byteLength(before.notes));expect(await raw()).toEqual({...before,deleted_at:(await raw()).deleted_at});
  expect(await store.softDeleteSession(owner,id)).toBeUndefined();
  const restored=await store.restoreSession(owner,id) as any;
  expect(restored.deletedAt).toBeNull();expect(await raw()).toEqual(before);
  expect(await store.restoreSession(owner,id)).toBeUndefined();expect(await counts()).toEqual([{minute_count:2,day_count:2}]);
 });
 it.each(["softDeleteSession","restoreSession"] as const)("%s refuses foreign, unowned and missing rows without a charge",async method=>{
  await f.client.query("INSERT INTO sessions(id,domain,duration_minutes,timestamp,deleted_at) VALUES($1,'music',1,now(),now())",[id+"-unowned"]);
  await f.client.query("UPDATE sessions SET deleted_at=now() WHERE id=$1",[id]);
  const before=await raw();
  for(const key of [id,id+"-unowned","missing"])expect(await store[method](other,key)).toBeUndefined();
  expect(await raw()).toEqual(before);expect(await counts(other)).toEqual([]);
 });
 it("restores an old unpurged row without an activity-time or 42-day restoration gate",async()=>{
  await f.client.query("UPDATE sessions SET deleted_at='2020-01-02T00:00:00Z' WHERE id=$1",[id]);
  expect((await store.restoreSession(owner,id))?.deletedAt).toBeNull();
  expect((await raw()).timestamp).toContain(".123456");
 });
 it("retired age-based maintenance preserves practices, exact edits, canonical observations and audits even for flag true",async()=>{
  const request={isAuthenticated:()=>true,user:{claims:{sub:owner}}};
  await f.client.query("INSERT INTO user_settings(user_id,timezone,day_start_hour,window_days) VALUES($1,'America/New_York',4,14)",[owner]);
  await f.client.query("UPDATE sessions SET deleted_at='2020-01-02T00:00:00.123456Z' WHERE id=$1",[id]);
  for(const slug of ["fitness","meditation","martial-arts"])
   await f.client.query("INSERT INTO sessions(id,user_id,domain,duration_minutes,timestamp,notes) VALUES($1,$2,$3,10,'2020-01-01T01:02:03.123456Z','exact active note')",[id+"-"+slug,owner,slug]);
  await f.client.query("INSERT INTO session_edits(id,session_id,user_id,edited_at,reason,changed_fields) VALUES($1,$2,$3,'2020-01-01T02:03:04.654321Z','exact edit reason',$4)",
   [id+"-edit",id,owner,JSON.stringify({notes:"exact prior note 🙂".repeat(500)})]);
  await f.client.query("INSERT INTO sessions(id,user_id,domain,duration_minutes,timestamp,notes,deleted_at) VALUES($1,$2,'music',1,'2019-01-01T00:00:00Z','foreign retained','2019-01-02T00:00:00Z'),($3,NULL,'music',1,'2018-01-01T00:00:00Z','unowned retained','2018-01-02T00:00:00Z')",
   [id+"-foreign",other,id+"-unowned"]);
  await seedPolicyV2(f.db,request);
  await importLegacyObservations(f.db,request);
  expect((await f.client.query("SELECT count(*)::int n FROM observations WHERE owner_user_id=$1",[owner])).rows[0].n).toBe(4);
  expect((await f.client.query("SELECT count(*)::int n FROM audit_events WHERE actor_user_id=$1 AND entity_type LIKE 'legacy_%'",[owner])).rows[0].n).toBe(5);
  const tables=["users","user_settings","sessions","session_edits","deviations","http_sessions",
   "organizations","organization_members","domains","policy_versions","dimension_definitions","source_bindings",
   "observations","deviations_v2","deviation_domains","evaluation_results","audit_events","owner_write_resource_budgets"];
  const snapshot=async()=>{
   const rows:Record<string,unknown>={};
   for(const table of tables)rows[table]=(await f.client.query("SELECT to_jsonb(t) r FROM public."+table+" t ORDER BY to_jsonb(t)::text")).rows;
   return JSON.stringify(rows);
  };
  const before=await snapshot(),log=vi.fn(),now=vi.fn(()=>Date.parse("2099-01-01T00:00:00Z"));
  expect(runStartupRetention({optIn:"true",storage:store,now,log})).toBeUndefined();
  expect(now).not.toHaveBeenCalled();expect(log).toHaveBeenCalledOnce();
  for(const cutoff of [new Date("2026-01-01T00:00:00Z"),new Date("2099-01-01T00:00:00Z"),new Date(NaN)])
   await expect(store.purgeExpiredDeletedSessions(cutoff)).rejects.toThrow("Automatic age-based deletion is disabled");
  expect(await snapshot()).toBe(before);
  const forbidden=vi.fn(()=>{throw Error("Database dependency must never be accessed");});
  const noDatabase=new Proxy({} as any,{get:forbidden});
  await expect(new DatabaseStorage(noDatabase,noDatabase).purgeExpiredDeletedSessions(new Date())).rejects.toThrow("Automatic age-based deletion is disabled");
  expect(forbidden).not.toHaveBeenCalled();
 });
 it("active and deleted listings remain owner scoped, exclude opposite states, and use their respective time ordering",async()=>{
  await f.client.query("INSERT INTO sessions(id,user_id,domain,duration_minutes,timestamp,deleted_at) VALUES($1,$2,'music',1,'2010-01-01T00:00:00Z','2026-10-02T00:00:00Z'),($3,$2,'music',1,'2030-01-01T00:00:00Z','2026-08-01T00:00:00Z'),($4,$5,'music',1,now(),NULL)",
   [id+"-recent",owner,id+"-old",id+"-foreign",other]);
  expect((await store.getSessions(owner)).map(x=>x.id)).toEqual([id]);
  expect((await store.getDeletedSessions(owner)).map(x=>x.id)).toEqual([id+"-recent",id+"-old"]);
 });
 it("deviation create/update/end/delete charge only real changes and omit reason payloads",async()=>{
  await seedExistingContext();
  const created=await deviationStore.create(request(),{domain:"music",reason:" valid reason ",startAt:"2026-01-01T00:00:00Z"}) as any;
  expect(created.reason).toBe("");expect(created.reasonBytes).toBe(14);expect(created.hasReason).toBe(true);
  const key=created.id;
  expect(await deviationStore.edit(request(other),key,{excludeFromComposite:false,changeReason:"Synthetic foreign rejection"})).toBeUndefined();
  await deviationStore.edit(request(),key,{reason:" valid reason "});
  expect(await counts()).toEqual([{minute_count:1,day_count:1}]);
  await deviationStore.edit(request(),key,{excludeFromComposite:false,changeReason:"Synthetic weighting correction"});
  await deviationStore.end(request(),key,{changeReason:"Synthetic early ending"});expect(await deviationStore.end(request(),key,{changeReason:"Synthetic repeated ending"})).toBeUndefined();
  const gone=await deviationStore.softDelete(request(),key,{changeReason:"Synthetic recoverable deletion"});expect(gone?.deletedAt).toBeInstanceOf(Date);
  expect(await deviationStore.softDelete(request(),key,{changeReason:"Synthetic repeated deletion"})).toBeUndefined();expect(await counts()).toEqual([{minute_count:4,day_count:4}]);
  const audit=await deviationAudits();expect(audit).toHaveLength(4);
  expect(audit.map(a=>a.action)).toEqual(["create","update","update","delete"]);
  expect(audit.every(a=>a.actor_user_id===owner&&a.after.reason===" valid reason ")).toBe(true);
  expect((await f.client.query("SELECT reason FROM deviations WHERE id=$1",[key])).rows[0].reason).toBe(" valid reason ");
 });
 it("historical long deviation reasons survive exact unchanged or omitted updates; changed/new over500 reasons fail",async()=>{
  await seedExistingContext();
  const reason=" \told reason 🙂\n".repeat(200),key=id+"-deviation";
  await f.client.query("INSERT INTO deviations(id,user_id,domain,reason,start_at) VALUES($1,$2,'music',$3,'2026-01-01T00:00:00Z')",[key,owner,reason]);
  await deviationStore.edit(request(),key,{reason,excludeFromComposite:false,changeReason:"Synthetic old reason retained"});
  await deviationStore.edit(request(),key,{endAt:"2026-01-03T00:00:00Z",changeReason:"Synthetic end date correction"});
  await expect(deviationStore.edit(request(),key,{reason:reason+"x",changeReason:"Synthetic invalid expansion"})).rejects.toMatchObject({status:400});
  await expect(deviationStore.create(request(),{domain:"music",startAt:"2026-01-01T00:00:00Z",reason:"x".repeat(501)})).rejects.toMatchObject({status:400});
  const shorter=reason.slice(0,-20);await deviationStore.edit(request(),key,{reason:shorter,changeReason:"Synthetic deliberate shortening"});
  expect((await f.client.query("SELECT reason FROM deviations WHERE id=$1",[key])).rows[0].reason).toBe(shorter);
  expect(await counts()).toEqual([{minute_count:3,day_count:3}]);
  const audit=await deviationAudits();expect(audit).toHaveLength(3);
  expect(audit[0].before.reason).toBe(reason);expect(audit[0].after.reason).toBe(reason);
  expect(audit[1].before.reason).toBe(reason);expect(audit[1].after.reason).toBe(reason);
  expect(audit[2].before.reason).toBe(reason);expect(audit[2].after.reason).toBe(shorter);
 });
 it("settings creation, normalization and changed saves charge once; canonical reads and equal saves do not",async()=>{
  const initial=await store.getUserSettings(owner);expect(initial).toMatchObject({userId:owner,dayStartHour:4,windowDays:7,timezone:"America/New_York"});
  const read=await store.getUserSettings(owner);expect(read).toEqual(initial);
  const saved=await store.upsertUserSettings(owner,{windowDays:14});expect(saved.windowDays).toBe(14);
  expect(await store.upsertUserSettings(owner,{windowDays:14})).toEqual(saved);
  expect(await counts()).toEqual([{minute_count:2,day_count:2}]);
  await f.client.query("UPDATE user_settings SET window_days=21 WHERE user_id=$1",[owner]);
  expect((await store.upsertUserSettings(owner,{dayStartHour:4})).windowDays).toBe(28);
  expect(await counts()).toEqual([{minute_count:3,day_count:3}]);
  const direct=await store.upsertUserSettings(other,{windowDays:42});
  expect(direct).toMatchObject({userId:other,windowDays:42,dayStartHour:4});
  expect(await counts(other)).toEqual([{minute_count:1,day_count:1}]);
 });
 it("rate denial rolls back deletion, deviation and settings changes without altering source text",async()=>{
  await seedExistingContext();
  await f.client.query("INSERT INTO deviations(id,user_id,domain,reason,start_at) VALUES($1,$2,'music','old','2026-01-01T00:00:00Z')",[id+"-dev",owner]);
  await f.client.query("INSERT INTO user_settings(user_id) VALUES($1)",[owner]);
  await f.client.query("INSERT INTO owner_write_resource_budgets(owner_user_id,minute_started_at,minute_count,day_date,day_count) VALUES($1,date_trunc('minute',clock_timestamp()),30,(clock_timestamp() AT TIME ZONE 'UTC')::date,50)",[owner]);
  const before=await raw(),auditBefore=await deviationAudits();
  for(const op of [()=>store.softDeleteSession(owner,id),()=>deviationStore.end(request(),id+"-dev",{changeReason:"Synthetic rate-denied ending"}),()=>deviationStore.softDelete(request(),id+"-dev",{changeReason:"Synthetic rate-denied deletion"}),
   ()=>deviationStore.edit(request(),id+"-dev",{reason:"new",changeReason:"Synthetic rate-denied correction"}),()=>store.upsertUserSettings(owner,{windowDays:14})])
   await expect(op()).rejects.toMatchObject({status:429,code:"WRITE_RATE_LIMIT_EXCEEDED"});
  expect(await raw()).toEqual(before);
  expect((await f.client.query("SELECT reason,ended_at,deleted_at FROM deviations WHERE id=$1",[id+"-dev"])).rows[0]).toEqual({reason:"old",ended_at:null,deleted_at:null});
  expect((await store.getUserSettings(owner)).windowDays).toBe(7);
  expect(await counts()).toEqual([{minute_count:30,day_count:50}]);
  expect(await deviationAudits()).toEqual(auditBefore);
 });
});
