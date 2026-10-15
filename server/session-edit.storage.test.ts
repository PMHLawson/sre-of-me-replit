import {beforeAll,afterAll,beforeEach,describe,expect,it,vi} from "vitest";
import {drizzle} from "drizzle-orm/node-postgres";
import {Pool} from "pg";
import * as schema from "@shared/schema";
import {startFixture} from "./lib/ownership-fixture";
vi.mock("./db",()=>({db:{}}));
import {DatabaseStorage} from "./storage";

describe("actual legacy session edits, bounded responses and durable admission",()=>{
 let f:Awaited<ReturnType<typeof startFixture>>,store:DatabaseStorage,pool:Pool,n=0,owner:string,other:string,id:string;
 beforeAll(async()=>{f=await startFixture("legacy-edit-write-budget");pool=new Pool({host:f.root+"/socket",port:5432,user:"synthetic",database:"postgres",password:"",ssl:false,max:2,connectionTimeoutMillis:5000});store=new DatabaseStorage(drizzle(f.client,{schema}),pool);},60000);
 afterAll(async()=>{try{if(pool)await pool.end();}finally{if(f)await f.cleanup();}},60000);
 beforeEach(async()=>{
  n++;owner="edit-owner-"+n;other="edit-other-"+n;id="edit-session-"+n;
  await f.client.query("INSERT INTO users(id) VALUES($1),($2)",[owner,other]);
  await f.client.query("INSERT INTO sessions(id,user_id,domain,duration_minutes,timestamp,notes,is_anomaly,anomaly_note) VALUES($1,$2,'music',30,'2026-09-20T12:00:00.123456Z','original fixture',false,NULL)",[id,owner]);
 });
 const row=async()=> (await f.client.query("SELECT to_jsonb(s) r FROM sessions s WHERE id=$1",[id])).rows[0].r;
 const edits=async()=> (await f.client.query("SELECT * FROM session_edits WHERE session_id=$1 ORDER BY edited_at,id",[id])).rows;
 const counts=async()=> (await f.client.query("SELECT minute_count,day_count FROM owner_write_resource_budgets WHERE owner_user_id=$1",[owner])).rows;
 it("persists every changed field and exact prior values, with one durable charge and no text in the response",async()=>{
  const result=await store.updateSession(owner,id,{domain:"fitness",durationMinutes:90,timestamp:"2026-09-21T12:00:00.654321Z",
   notes:"new fixture",isAnomaly:true,anomalyNote:"intentional practice",reason:" fixture correction "}) as any;
  expect(await row()).toMatchObject({domain:"fitness",duration_minutes:90,notes:"new fixture",is_anomaly:true,anomaly_note:"intentional practice"});
  expect((await row()).timestamp).toContain(".654321");
  const audit=await edits();expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({session_id:id,user_id:owner,reason:" fixture correction "});
  const prior=JSON.parse(audit[0].changed_fields);
  expect(prior).toMatchObject({domain:"music",durationMinutes:30,notes:"original fixture",isAnomaly:false,anomalyNote:null});
  expect(prior.timestamp).toContain(".123456");
  expect(result).toMatchObject({id,userId:owner,notes:null,anomalyNote:null,hasNotes:true,hasAnomalyNote:true,
   notesBytes:11,anomalyNoteBytes:20,notesAvailability:"not_loaded",anomalyNoteAvailability:"not_loaded"});
  expect(await counts()).toEqual([{minute_count:1,day_count:1}]);
 });
 it("explicitly unflagging clears the explanation even when a stale explanation was submitted",async()=>{
  await f.client.query("UPDATE sessions SET is_anomaly=true,anomaly_note='prior explanation' WHERE id=$1",[id]);
  await store.updateSession(owner,id,{isAnomaly:false,anomalyNote:"stale submitted note",reason:"back to normal"});
  expect(await row()).toMatchObject({is_anomaly:false,anomaly_note:null});
  expect(JSON.parse((await edits())[0].changed_fields)).toEqual({isAnomaly:true,anomalyNote:"prior explanation"});
 });
 it("partial edits preserve omitted identity, quantities, flags and explanation",async()=>{
  await f.client.query("UPDATE sessions SET is_anomaly=true,anomaly_note='prior explanation' WHERE id=$1",[id]);
  const before=await row();await store.updateSession(owner,id,{notes:null,reason:"remove notes"});
  expect(await row()).toEqual({...before,notes:null});
  expect(JSON.parse((await edits())[0].changed_fields)).toEqual({notes:"original fixture"});
 });
 it("note-only edits audit the exact previous anomaly explanation",async()=>{
  await f.client.query("UPDATE sessions SET is_anomaly=true,anomaly_note='prior explanation' WHERE id=$1",[id]);
  await store.updateSession(owner,id,{anomalyNote:"corrected explanation",reason:"clarify"});
  expect((await row()).anomaly_note).toBe("corrected explanation");
  expect(JSON.parse((await edits())[0].changed_fields)).toEqual({anomalyNote:"prior explanation"});
 });
 it("no-op session edits still retain their required reason and empty audit, charging once",async()=>{
  const before=await row();await store.updateSession(owner,id,{durationMinutes:30,reason:"reviewed"});
  expect(await row()).toEqual(before);
  expect((await edits()).map(x=>({reason:x.reason,changed_fields:x.changed_fields}))).toEqual([{reason:"reviewed",changed_fields:"{}"}]);
  expect(await counts()).toEqual([{minute_count:1,day_count:1}]);
 });
 it.each(["different-owner","deleted-row","missing-id"])("does not mutate, audit or charge %s",async mode=>{
  if(mode==="deleted-row")await f.client.query("UPDATE sessions SET deleted_at='2026-09-22T12:00:00Z' WHERE id=$1",[id]);
  const before=await row();
  expect(await store.updateSession(mode==="different-owner"?other:owner,mode==="missing-id"?"missing":id,{isAnomaly:true,anomalyNote:"fixture",reason:"fixture"})).toBeUndefined();
  expect(await row()).toEqual(before);expect(await edits()).toEqual([]);expect(await counts()).toEqual([]);
  expect((await f.client.query("SELECT * FROM owner_write_resource_budgets WHERE owner_user_id=$1",[other])).rows).toEqual([]);
 });
 it.each(["audit","update"])("rolls back data, audit and durable charge on a late %s failure",async target=>{
  const table=target==="audit"?"session_edits":"sessions",event=target==="audit"?"INSERT":"UPDATE";
  await f.client.query("CREATE FUNCTION fail_edit_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic edit failure'; END $$");
  await f.client.query("CREATE TRIGGER fail_edit_write AFTER "+event+" ON "+table+" FOR EACH ROW EXECUTE FUNCTION fail_edit_write()");
  const before=await row();
  try {await expect(store.updateSession(owner,id,{isAnomaly:true,anomalyNote:"fixture",reason:"fixture"})).rejects.toMatchObject({status:503});}
  finally {await f.client.query("DROP TRIGGER fail_edit_write ON "+table);await f.client.query("DROP FUNCTION fail_edit_write()");}
  expect(await row()).toEqual(before);expect(await edits()).toEqual([]);expect(await counts()).toEqual([]);
 });
 it("grandfathers exact Unicode and whitespace in long historical notes while bounding only new or changed text",async()=>{
  const long=" \t🙂 old exact\n".repeat(500),anomaly=" old anomaly 🙂 ".repeat(400);
  await f.client.query("UPDATE sessions SET notes=$2,is_anomaly=true,anomaly_note=$3 WHERE id=$1",[id,long,anomaly]);
  await store.updateSession(owner,id,{durationMinutes:31,notes:long,anomalyNote:anomaly,reason:"retain old text"});
  expect(await row()).toMatchObject({duration_minutes:31,notes:long,anomaly_note:anomaly});
  expect(JSON.parse((await edits())[0].changed_fields)).toEqual({durationMinutes:30});
  for(const patch of [{notes:long+"x"},{anomalyNote:anomaly+"x"}])
   await expect(store.updateSession(owner,id,{...patch,reason:"changed too long"})).rejects.toMatchObject({status:400});
  expect((await row()).notes).toBe(long);expect(await counts()).toEqual([{minute_count:1,day_count:1}]);
  const result=await store.updateSession(owner,id,{notes:"short",reason:"shorten"}) as any;
  expect(JSON.parse((await edits())[1].changed_fields).notes).toBe(long);
  expect(result.notes).toBeNull();expect(result.notesBytes).toBe(5);
 });
 it("an unrelated edit preserves inconsistent historical anomaly metadata instead of cleaning owner data",async()=>{
  await f.client.query("UPDATE sessions SET is_anomaly=false,anomaly_note=' historical exact ' WHERE id=$1",[id]);
  await store.updateSession(owner,id,{durationMinutes:32,reason:"quantity only"});
  expect(await row()).toMatchObject({is_anomaly:false,anomaly_note:" historical exact "});
  expect(JSON.parse((await edits())[0].changed_fields)).toEqual({durationMinutes:30});
 });
 it("rejects blank anomaly explanations, accepts existing nonblank explanation, and never silently clears an anomaly",async()=>{
  await expect(store.updateSession(owner,id,{isAnomaly:true,reason:"missing explanation"})).rejects.toMatchObject({status:400});
  expect(await counts()).toEqual([]);
  await f.client.query("UPDATE sessions SET anomaly_note=' existing ' WHERE id=$1",[id]);
  await store.updateSession(owner,id,{isAnomaly:true,reason:"existing explanation"});
  expect(await row()).toMatchObject({is_anomaly:true,anomaly_note:" existing "});
  await expect(store.updateSession(owner,id,{isAnomaly:true,anomalyNote:" \t",reason:"blank"})).rejects.toMatchObject({status:400});
  expect(await counts()).toEqual([{minute_count:1,day_count:1}]);
 });
 it("rejects a new overlong note before any mutation, including UTF16 surrogate-pair boundaries",async()=>{
  expect(schema.activityTextWithinLimit("x".repeat(4000))).toBe(true);
  expect(schema.activityTextWithinLimit("x".repeat(4001))).toBe(false);
  expect(schema.activityTextWithinLimit("🙂".repeat(2000))).toBe(true);
  expect(schema.activityTextWithinLimit("🙂".repeat(2001))).toBe(false);
  await expect(store.createSession({userId:owner,domain:"music",durationMinutes:1,timestamp:"2026-09-20T12:00:00Z",notes:"x".repeat(4001)})).rejects.toMatchObject({status:400});
  expect(await counts()).toEqual([]);
  expect((await f.client.query("SELECT count(*)::int n FROM sessions WHERE user_id=$1",[owner])).rows[0].n).toBe(1);
 });
 it("a capped owner cannot create or edit; denial leaves old source and audit exact",async()=>{
  await f.client.query("INSERT INTO owner_write_resource_budgets(owner_user_id,minute_started_at,minute_count,day_date,day_count) VALUES($1,date_trunc('minute',clock_timestamp()),30,(clock_timestamp() AT TIME ZONE 'UTC')::date,50)",[owner]);
  const before=await row();
  await expect(store.updateSession(owner,id,{durationMinutes:40,reason:"denied"})).rejects.toMatchObject({status:429,code:"WRITE_RATE_LIMIT_EXCEEDED"});
  await expect(store.createSession({userId:owner,domain:"music",durationMinutes:1,timestamp:"2026-09-20T12:00:00Z"})).rejects.toMatchObject({status:429});
  expect(await row()).toEqual(before);expect(await edits()).toEqual([]);expect(await counts()).toEqual([{minute_count:30,day_count:50}]);
 });
 it("SQL shortening compares UTF16 units and UTF8 bytes independently for supplementary characters",async()=>{
  const old="🙂".repeat(2500),shorter="é".repeat(4500);
  await f.client.query("UPDATE sessions SET notes=$2 WHERE id=$1",[id,old]);
  await store.updateSession(owner,id,{notes:shorter,reason:"less UTF16 and fewer bytes"});
  expect((await row()).notes).toBe(shorter);
  // Fewer bytes alone is insufficient if UTF16 grows.
  await expect(store.updateSession(owner,id,{notes:"a".repeat(5000),reason:"units grew"})).rejects.toMatchObject({status:400});
  await f.client.query("UPDATE sessions SET notes=$2 WHERE id=$1",[id,"a".repeat(6000)]);
  // Fewer UTF16 units alone is insufficient if encoded bytes grow.
  await expect(store.updateSession(owner,id,{notes:"🙂".repeat(2500),reason:"bytes grew"})).rejects.toMatchObject({status:400});
  expect((await row()).notes).toBe("a".repeat(6000));expect(await counts()).toEqual([{minute_count:1,day_count:1}]);
 });

 it.each(["\u00a0","\u2003","\ufeff"])("does not treat historical JavaScript-trim whitespace %s as an anomaly explanation",async space=>{
  const text=" \t"+space+"\n";await f.client.query("UPDATE sessions SET anomaly_note=$2 WHERE id=$1",[id,text]);
  await expect(store.updateSession(owner,id,{isAnomaly:true,reason:"blank historical explanation"})).rejects.toMatchObject({status:400});
  expect(await row()).toMatchObject({is_anomaly:false,anomaly_note:text});expect(await edits()).toEqual([]);expect(await counts()).toEqual([]);
 });

});
