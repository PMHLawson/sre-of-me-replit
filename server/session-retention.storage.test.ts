import {beforeAll,afterAll,beforeEach,describe,expect,it,vi} from "vitest";
import {drizzle} from "drizzle-orm/node-postgres";
import {Pool} from "pg";
import * as schema from "@shared/schema";
import {startFixture} from "./lib/ownership-fixture";
vi.mock("./db",()=>({db:{}}));
import {DatabaseStorage} from "./storage";

describe("actual retention, deviation and settings writes with owner admission",()=>{
 let f:Awaited<ReturnType<typeof startFixture>>,pool:Pool,store:DatabaseStorage,n=0,owner:string,other:string,id:string;
 beforeAll(async()=>{
  f=await startFixture("legacy-retention-write-budget");
  pool=new Pool({host:f.root+"/socket",port:5432,user:"synthetic",database:"postgres",password:"",ssl:false,max:2,connectionTimeoutMillis:5000});
  store=new DatabaseStorage(drizzle(f.client,{schema}),pool);
 },60000);
 afterAll(async()=>{try{if(pool)await pool.end();}finally{if(f)await f.cleanup();}},60000);
 beforeEach(async()=>{
  n++;owner="retention-owner-"+n;other="retention-other-"+n;id="retention-session-"+n;
  await f.client.query("INSERT INTO users(id) VALUES($1),($2)",[owner,other]);
  await f.client.query("INSERT INTO sessions(id,user_id,domain,duration_minutes,timestamp,notes,is_anomaly,anomaly_note) VALUES($1,$2,'music',900,'2020-01-01T01:02:03.123456Z',$3,true,$4)",
   [id,owner," exact old note 🙂 ".repeat(500)," exact old explanation ".repeat(300)]);
 });
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
 it("global maintenance deletes only deletion times strictly older than cutoff and is idempotent",async()=>{
  const cutoff=new Date("2026-08-01T12:00:00Z");
  for(const [suffix,who,deleted] of [["expired-a",owner,"2026-08-01T11:59:59.999999Z"],["expired-b",other,"2020-01-01T00:00:00Z"],
   ["boundary",owner,"2026-08-01T12:00:00Z"],["newer",owner,"2026-08-01T12:00:00.000001Z"]] as const)
   await f.client.query("INSERT INTO sessions(id,user_id,domain,duration_minutes,timestamp,deleted_at) VALUES($1,$2,'music',1,'2030-01-01T00:00:00Z',$3)",[id+"-"+suffix,who,deleted]);
  expect(await store.purgeExpiredDeletedSessions(cutoff)).toBe(2);
  const left=(await f.client.query("SELECT id FROM sessions WHERE id LIKE $1 ORDER BY id",[id+"%"])).rows.map(x=>x.id);
  expect(left).toEqual([id,id+"-boundary",id+"-newer"]);expect(await store.purgeExpiredDeletedSessions(cutoff)).toBe(0);
  expect(await counts()).toEqual([]);expect(await counts(other)).toEqual([]);
 });
 it("maintenance propagates a real database error instead of reporting zero removals",async()=>{
  await f.client.query("UPDATE sessions SET deleted_at='2020-01-01T00:00:00Z' WHERE id=$1",[id]);
  await f.client.query("CREATE FUNCTION fail_retention() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic retention failure'; END $$");
  await f.client.query("CREATE TRIGGER fail_retention AFTER DELETE ON sessions FOR EACH ROW EXECUTE FUNCTION fail_retention()");
  try{await expect(store.purgeExpiredDeletedSessions(new Date("2026-01-01T00:00:00Z"))).rejects.toThrow();}
  finally{await f.client.query("DROP TRIGGER fail_retention ON sessions");await f.client.query("DROP FUNCTION fail_retention()");}
  expect(await raw()).toBeDefined();expect(await counts()).toEqual([]);
 });
 it("active and deleted listings remain owner scoped, exclude opposite states, and use their respective time ordering",async()=>{
  await f.client.query("INSERT INTO sessions(id,user_id,domain,duration_minutes,timestamp,deleted_at) VALUES($1,$2,'music',1,'2010-01-01T00:00:00Z','2026-10-02T00:00:00Z'),($3,$2,'music',1,'2030-01-01T00:00:00Z','2026-08-01T00:00:00Z'),($4,$5,'music',1,now(),NULL)",
   [id+"-recent",owner,id+"-old",id+"-foreign",other]);
  expect((await store.getSessions(owner)).map(x=>x.id)).toEqual([id]);
  expect((await store.getDeletedSessions(owner)).map(x=>x.id)).toEqual([id+"-recent",id+"-old"]);
 });
 it("deviation create/update/end/delete charge only real changes and omit reason payloads",async()=>{
  const created=await store.createDeviation({userId:owner,domain:"music",reason:" valid reason ",startAt:"2026-01-01T00:00:00Z"}) as any;
  expect(created.reason).toBe("");expect(created.reasonBytes).toBe(14);expect(created.hasReason).toBe(true);
  const key=created.id;
  expect(await store.updateDeviation(other,key,{excludeFromComposite:false})).toBeUndefined();
  await store.updateDeviation(owner,key,{reason:" valid reason "});
  expect(await counts()).toEqual([{minute_count:1,day_count:1}]);
  await store.updateDeviation(owner,key,{excludeFromComposite:false});
  await store.endDeviation(owner,key,new Date("2026-01-02T00:00:00Z"));expect(await store.endDeviation(owner,key)).toBeUndefined();
  const gone=await store.softDeleteDeviation(owner,key);expect(gone?.deletedAt).toBeInstanceOf(Date);
  expect(await store.softDeleteDeviation(owner,key)).toBeUndefined();expect(await counts()).toEqual([{minute_count:4,day_count:4}]);
  expect((await f.client.query("SELECT reason FROM deviations WHERE id=$1",[key])).rows[0].reason).toBe(" valid reason ");
 });
 it("historical long deviation reasons survive exact unchanged or omitted updates; changed/new over500 reasons fail",async()=>{
  const reason=" \told reason 🙂\n".repeat(200),key=id+"-deviation";
  await f.client.query("INSERT INTO deviations(id,user_id,domain,reason,start_at) VALUES($1,$2,'music',$3,'2026-01-01T00:00:00Z')",[key,owner,reason]);
  await store.updateDeviation(owner,key,{reason,excludeFromComposite:false});
  await store.updateDeviation(owner,key,{endAt:"2026-01-03T00:00:00Z"});
  await expect(store.updateDeviation(owner,key,{reason:reason+"x"})).rejects.toMatchObject({status:400});
  await expect(store.createDeviation({userId:owner,domain:"music",startAt:"2026-01-01T00:00:00Z",reason:"x".repeat(501)})).rejects.toMatchObject({status:400});
  const shorter=reason.slice(0,-20);await store.updateDeviation(owner,key,{reason:shorter});
  expect((await f.client.query("SELECT reason FROM deviations WHERE id=$1",[key])).rows[0].reason).toBe(shorter);
  expect(await counts()).toEqual([{minute_count:3,day_count:3}]);
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
  await f.client.query("INSERT INTO deviations(id,user_id,domain,reason,start_at) VALUES($1,$2,'music','old','2026-01-01T00:00:00Z')",[id+"-dev",owner]);
  await f.client.query("INSERT INTO user_settings(user_id) VALUES($1)",[owner]);
  await f.client.query("INSERT INTO owner_write_resource_budgets(owner_user_id,minute_started_at,minute_count,day_date,day_count) VALUES($1,date_trunc('minute',clock_timestamp()),30,(clock_timestamp() AT TIME ZONE 'UTC')::date,50)",[owner]);
  const before=await raw();
  for(const op of [()=>store.softDeleteSession(owner,id),()=>store.endDeviation(owner,id+"-dev"),()=>store.softDeleteDeviation(owner,id+"-dev"),
   ()=>store.updateDeviation(owner,id+"-dev",{reason:"new"}),()=>store.upsertUserSettings(owner,{windowDays:14})])
   await expect(op()).rejects.toMatchObject({status:429,code:"WRITE_RATE_LIMIT_EXCEEDED"});
  expect(await raw()).toEqual(before);
  expect((await f.client.query("SELECT reason,ended_at,deleted_at FROM deviations WHERE id=$1",[id+"-dev"])).rows[0]).toEqual({reason:"old",ended_at:null,deleted_at:null});
  expect((await store.getUserSettings(owner)).windowDays).toBe(7);
  expect(await counts()).toEqual([{minute_count:30,day_count:50}]);
 });
});
