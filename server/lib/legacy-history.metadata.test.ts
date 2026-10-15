import { beforeAll,beforeEach,afterAll,it,expect } from "vitest";
import { Pool,type PoolClient } from "pg";
import { startFixture,verifyFixture } from "./ownership-fixture";
import { LegacyHistoryReads } from "./legacy-history";
import { MAX_READ_BYTES } from "./transaction-read-budget";
let fixture:Awaited<ReturnType<typeof startFixture>>,pool:Pool;
const now=new Date("2026-10-15T12:00:00Z");
type Witness={queries:string[];admissions:Array<{bytes:number;count:number;idNull:boolean;domainNull:boolean;timezoneNull:boolean;notificationNull:boolean}>;maximumReplyBytes:number;replyBytes:number};
const witness=():Witness=>({queries:[],admissions:[],maximumReplyBytes:0,replyBytes:0});
function reader(seen:Witness){
 return new LegacyHistoryReads({connect:async()=>{
  verifyFixture(fixture.root);const client=await pool.connect();
  return {query:async(input:any,values?:unknown[])=>{
   const sql=typeof input==="string"?input:input.text;seen.queries.push(sql);
   const result=await client.query(input,values);
   if(sql.includes("__read_bytes")){
    const bytes=Buffer.byteLength(JSON.stringify(result.rows),"utf8");
    seen.replyBytes+=bytes;seen.maximumReplyBytes=Math.max(seen.maximumReplyBytes,bytes);
    for(const row of result.rows)seen.admissions.push({bytes:Number(row.__read_bytes),count:Number(row.__read_count),
     idNull:Object.hasOwn(row,"id")&&row.id===null,domainNull:Object.hasOwn(row,"domain")&&row.domain===null,
     timezoneNull:Object.hasOwn(row,"timezone")&&row.timezone===null,
     notificationNull:Object.hasOwn(row,"notificationTier")&&row.notificationTier===null});
   }
   return result;
  },release:(destroy?:boolean)=>client.release(destroy)} as unknown as PoolClient;
 }},()=>now);
}
beforeAll(async()=>{
 fixture=await startFixture("legacy-metadata-byte-admission");
 verifyFixture(fixture.root);
 pool=new Pool({host:fixture.root+"/socket",port:5432,user:"synthetic",database:"postgres",password:"",ssl:false,
  connectionTimeoutMillis:5000,max:2});
 await fixture.client.query("INSERT INTO users(id) VALUES('meta-owner'),('meta-foreign')");
},60000);
beforeEach(async()=>{
 await fixture.client.query("DELETE FROM sessions; DELETE FROM deviations; DELETE FROM user_settings");
 await fixture.client.query("INSERT INTO user_settings(user_id) VALUES('meta-owner'),('meta-foreign')");
});
afterAll(async()=>{try{if(pool)await pool.end();}finally{if(fixture)await fixture.cleanup();}},60000);
async function fingerprint(){
 return (await fixture.client.query(`SELECT
  (SELECT count(*)::int FROM sessions) AS count,
  (SELECT sum(octet_length(id))::text FROM sessions) AS id_bytes,
  (SELECT sum(octet_length(domain))::text FROM sessions) AS domain_bytes,
  (SELECT md5(notification_tier) FROM user_settings WHERE user_id='meta-owner') AS setting_digest`)).rows;
}
it("suppresses oversized preexisting domain metadata in SQL before page payload transfer and retains the original data",async()=>{
 await fixture.client.query(`INSERT INTO sessions(id,user_id,domain,duration_minutes,timestamp,notes)
 VALUES('oversized-domain','meta-owner',repeat('界',3145728),10,'2026-10-01','  exact raw practice note  ')`);
 const before=await fingerprint(),seen=witness();
 await expect(reader(seen).page("meta-owner","sessions",{limit:50})).rejects.toMatchObject(
  {status:503,code:"RESOURCE_LIMIT_EXCEEDED"});
 expect(seen.admissions.some(row=>row.domainNull&&row.bytes>MAX_READ_BYTES)).toBe(true);
 expect(seen.maximumReplyBytes).toBeLessThan(2000);
 expect(seen.queries.some(sql=>/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql))).toBe(false);
 expect(await fingerprint()).toEqual(before);
 const note=(await fixture.client.query("SELECT notes FROM sessions WHERE id='oversized-domain'")).rows[0].notes;
 expect(note).toBe("  exact raw practice note  ");
},15000);
it("suppresses oversized setting metadata before timezone calculation and does not normalize or update stored settings",async()=>{
 await fixture.client.query("UPDATE user_settings SET notification_tier=repeat('界',3145728),window_days=21 WHERE user_id='meta-owner'");
 const before=await fingerprint(),seen=witness();
 await expect(reader(seen).current("meta-owner",14)).rejects.toMatchObject({status:503,code:"RESOURCE_LIMIT_EXCEEDED"});
 expect(seen.admissions.some(row=>row.timezoneNull&&row.notificationNull&&row.bytes>MAX_READ_BYTES)).toBe(true);
 expect(seen.maximumReplyBytes).toBeLessThan(2000);
 expect(seen.queries.some(sql=>/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql))).toBe(false);
 expect(await fingerprint()).toEqual(before);
 expect((await fixture.client.query("SELECT window_days FROM user_settings WHERE user_id='meta-owner'")).rows[0].window_days).toBe(21);
},15000);
it("shares one allowance across complete context and scoring reads containing large exact legacy IDs",async()=>{
 // Each ID is valid at the existing2048-byte input boundary, unique and never
 // normalized. Both individual reads fit8MiB; their combined payload does not.
 await fixture.client.query(`INSERT INTO sessions(id,user_id,domain,duration_minutes,timestamp)
 SELECT lpad(n::text,4,'0')||repeat('x',2044),'meta-owner','meditation',10,'2026-10-01'
 FROM generate_series(1,1900)n`);
 const before=await fingerprint(),seen=witness();
 await expect(reader(seen).current("meta-owner",14)).rejects.toMatchObject({status:503,code:"RESOURCE_LIMIT_EXCEEDED"});
 expect(seen.admissions.some(row=>row.count===1900&&!row.idNull&&row.bytes<MAX_READ_BYTES)).toBe(true);
 expect(seen.admissions.some(row=>row.count===1900&&row.idNull&&row.domainNull&&row.bytes<MAX_READ_BYTES)).toBe(true);
 expect(seen.maximumReplyBytes).toBeLessThan(MAX_READ_BYTES);
 expect(seen.replyBytes).toBeLessThan(MAX_READ_BYTES+300000);
 expect(seen.queries.some(sql=>/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql))).toBe(false);
 expect(await fingerprint()).toEqual(before);
},20000);
it("admits the explicit101st lookahead row and preserves exact microsecond paging completeness",async()=>{
 await fixture.client.query(`INSERT INTO sessions(id,user_id,domain,duration_minutes,timestamp)
 SELECT 'meta-tie-'||lpad(n::text,3,'0'),'meta-owner','meditation',10,
  '2026-10-01T12:00:00Z'::timestamptz+n*interval '1 microsecond' FROM generate_series(1,101)n;
 INSERT INTO sessions(id,user_id,domain,duration_minutes,timestamp)
 VALUES('foreign','meta-foreign','meditation',10,'2030-01-01')`);
 const seen=witness(),reads=reader(seen),first=await reads.page("meta-owner","sessions",{limit:100});
 expect(first.items).toHaveLength(100);expect(first.complete).toBe(false);expect(first.nextCursor).not.toBeNull();
 expect(seen.admissions.some(row=>row.count===101&&!row.idNull)).toBe(true);
 const last=await reads.page("meta-owner","sessions",{limit:100,cursor:first.nextCursor!});
 expect(last.items.map(row=>row.id)).toEqual(["meta-tie-001"]);expect(last.complete).toBe(true);expect(last.nextCursor).toBeNull();
 const ids=[...first.items,...last.items].map(row=>row.id);
 expect(new Set(ids).size).toBe(101);expect(ids).not.toContain("foreign");
 expect((await fingerprint())[0].count).toBe(102);
});
it("normalizes the existing legacy compliance selection only in the readonly snapshot",async()=>{
 await fixture.client.query("UPDATE user_settings SET window_days=21 WHERE user_id='meta-owner'");
 const seen=witness(),input=await reader(seen).current("meta-owner",14);
 expect(input.settings.windowDays).toBe(28);expect(input.opts.windowDays).toBe(28);
 expect((await fixture.client.query("SELECT window_days FROM user_settings WHERE user_id='meta-owner'")).rows[0].window_days).toBe(21);
 expect(seen.queries.some(sql=>/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql))).toBe(false);
});
