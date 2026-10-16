import { beforeAll,afterAll,it,expect } from "vitest";
import { startFixture } from "../lib/ownership-fixture";
import { seedPolicyV2 } from "../lib/seed-policy-v2";
import { MAX_READ_BYTES } from "../lib/transaction-read-budget";
import { importLegacyObservations,reconcileLegacyObservations } from "./legacy-observation-sync";
import type { OwnershipDatabase } from "../lib/org-context";

let fixture:Awaited<ReturnType<typeof startFixture>>;
const request=(actor:string)=>({isAuthenticated:()=>true,user:{claims:{sub:actor}}});
const slugs=["martial-arts","meditation","fitness","music"];
beforeAll(async()=>{fixture=await startFixture("legacy-byte-admission");},60000);
afterAll(async()=>{if(fixture)await fixture.cleanup();},60000);

async function owner(actor:string){
 await fixture.client.query("INSERT INTO users(id) VALUES($1)",[actor]);
 await fixture.client.query("INSERT INTO user_settings(user_id) VALUES($1)",[actor]);
 for(const [index,slug] of slugs.entries())await fixture.client.query(
  "INSERT INTO sessions(id,user_id,domain,duration_minutes,timestamp,notes,anomaly_note,deleted_at) VALUES($1,$2,$3,10,'2020-01-01T12:00:00.123456Z',$4,$5,$6)",
  [actor+"-"+slug,actor,slug,index===0?null:index===1?"":" \t🙂界e\u0301\n ".repeat(20),
   index===2?" \tretained anomaly detail🙂\n ":null,index===3?"2021-01-01T01:02:03.654321Z":null]);
 await seedPolicyV2(fixture.db,request(actor));
}
type Witness={writes:number;admissions:number;suppressed:number;maximumReplyBytes:number;replyBytes:number};
const witness=():Witness=>({writes:0,admissions:0,suppressed:0,maximumReplyBytes:0,replyBytes:0});
function observedDatabase(seen:Witness):OwnershipDatabase{
 return {transaction:operation=>fixture.db.transaction(tx=>operation({query:async(sql,values)=>{
  if(/^\s*(?:INSERT|UPDATE|DELETE)\b/i.test(sql))seen.writes++;
  const result=await tx.query(sql,values);
  if(sql.includes("__read_bytes")){
   seen.admissions++;
   const bytes=Buffer.byteLength(JSON.stringify(result.rows),"utf8");
   seen.replyBytes+=bytes;seen.maximumReplyBytes=Math.max(seen.maximumReplyBytes,bytes);
   seen.suppressed+=result.rows.filter((row:any)=>Object.hasOwn(row,"raw")&&row.raw===null).length;
  }
  return result;
 }}))};
}
// Compare only sizes/digests/counts in this owned synthetic database. The test
// never exports the large historical text or needs it in the runner heap.
async function fingerprint(actor:string){
 const result=await fixture.client.query(`
 SELECT jsonb_build_object(
  'sessions',(SELECT jsonb_agg(jsonb_build_object('id',id,'notesBytes',octet_length(notes),'notesDigest',md5(notes),
   'anomalyBytes',octet_length(anomaly_note),'anomalyDigest',md5(anomaly_note),
   'at',timestamp,'deletedAt',deleted_at) ORDER BY id) FROM sessions WHERE user_id=$1),
  'edits',(SELECT jsonb_agg(jsonb_build_object('id',id,'bytes',octet_length(changed_fields),'digest',md5(changed_fields)) ORDER BY id)
   FROM session_edits WHERE user_id=$1),
  'observations',(SELECT count(*) FROM observations WHERE owner_user_id=$1),
  'audits',(SELECT count(*) FROM audit_events WHERE actor_user_id=$1)) AS state`,[actor]);
 return JSON.stringify(result.rows[0].state);
}
it("admits exact Unicode/null/empty values and native/raw microsecond provenance below the allowance",async()=>{
 const actor="byte-small";await owner(actor);
 const before=await fingerprint(actor),seen=witness();
 const result=await importLegacyObservations(observedDatabase(seen),request(actor));
 expect(result.reconciliation.clean).toBe(true);expect(seen.admissions).toBeGreaterThan(8);
 expect(seen.suppressed).toBe(0);expect(seen.replyBytes).toBeLessThan(MAX_READ_BYTES);
 const pairs=(await fixture.client.query(`SELECT to_jsonb(s) AS source,o.observation,o.deleted_at,
  a."after"->'sourceSnapshot'->'row' AS audit_source FROM sessions s
  JOIN observations o ON o.legacy_source_id=s.id
  JOIN audit_events a ON a."after"->'importedObservation'->>'observation_id'=o.observation_id
  WHERE s.user_id=$1 ORDER BY s.id`,[actor])).rows;
 expect(pairs).toHaveLength(4);
 for(const pair of pairs){
  expect(pair.audit_source).toEqual(pair.source);
  expect(pair.observation.observedAt).toBe("2020-01-01T12:00:00.123456+00:00");
  expect(Object.hasOwn(pair.observation,"notes")).toBe(pair.source.notes!==null);
  if(pair.source.notes!==null)expect(pair.observation.notes).toBe(pair.source.notes);
 }
 const after=await fingerprint(actor);
 expect(JSON.parse(after).sessions).toEqual(JSON.parse(before).sessions);
 const repeated=witness();
 expect((await reconcileLegacyObservations(observedDatabase(repeated),request(actor))).clean).toBe(true);
 expect(repeated.writes).toBe(0);
});
it("rejects one compressible historic Unicode record in SQL before transferring its payload or writing",async()=>{
 const actor="byte-single";await owner(actor);
 await fixture.client.query("UPDATE sessions SET notes=repeat('界',3145728) WHERE id=$1",[actor+"-music"]);
 const before=await fingerprint(actor),seen=witness();
 await expect(importLegacyObservations(observedDatabase(seen),request(actor))).rejects.toMatchObject(
  {status:503,code:"RESOURCE_LIMIT_EXCEEDED"});
 expect(seen.suppressed).toBeGreaterThan(0);expect(seen.maximumReplyBytes).toBeLessThan(100000);
 expect(seen.writes).toBe(0);expect(await fingerprint(actor)).toBe(before);
 const bytes=(await fixture.client.query("SELECT octet_length(notes) AS bytes FROM sessions WHERE id=$1",[actor+"-music"])).rows[0].bytes;
 expect(bytes).toBe(9*1024*1024);
});
it("shares admission across collections so individually admissible session and edit reads cannot exceed the operation allowance",async()=>{
 const actor="byte-combined";await owner(actor);
 await fixture.client.query("UPDATE sessions SET notes=repeat('界',2097152) WHERE id=$1",[actor+"-music"]);
 await fixture.client.query(`INSERT INTO session_edits(id,session_id,user_id,edited_at,reason,changed_fields)
 VALUES($1,$2,$3,'2022-01-01T00:00:00.654321Z','synthetic',jsonb_build_object('notes',repeat('ß',1572864))::text)`,
 [actor+"-edit",actor+"-music",actor]);
 const before=await fingerprint(actor),seen=witness();
 await expect(importLegacyObservations(observedDatabase(seen),request(actor))).rejects.toMatchObject(
  {status:503,code:"RESOURCE_LIMIT_EXCEEDED"});
 expect(seen.maximumReplyBytes).toBeGreaterThan(6*1024*1024);
 expect(seen.maximumReplyBytes).toBeLessThan(MAX_READ_BYTES);
 expect(seen.suppressed).toBeGreaterThan(0);expect(seen.replyBytes).toBeLessThan(MAX_READ_BYTES+100000);
 expect(seen.writes).toBe(0);expect(await fingerprint(actor)).toBe(before);
});
it("reserves expansion of imported observations and repeated audit snapshots before the first insert",async()=>{
 const actor="byte-projected";await owner(actor);
 await fixture.client.query("UPDATE sessions SET notes=repeat('界',349526) WHERE id=$1",[actor+"-music"]);
 for(let index=0;index<6;index++)await fixture.client.query(`INSERT INTO session_edits(id,session_id,user_id,edited_at,reason,changed_fields)
 VALUES($1,$2,$3,'2022-01-01T00:00:00.654321Z','synthetic','{}')`,[actor+"-edit-"+index,actor+"-music",actor]);
 const before=await fingerprint(actor),seen=witness();
 await expect(importLegacyObservations(observedDatabase(seen),request(actor))).rejects.toMatchObject(
  {status:503,code:"RESOURCE_LIMIT_EXCEEDED"});
 expect(seen.admissions).toBeGreaterThan(8);expect(seen.suppressed).toBe(0);
 expect(seen.replyBytes).toBeLessThan(2*1024*1024);
 expect(seen.writes).toBe(0);expect(await fingerprint(actor)).toBe(before);
});
