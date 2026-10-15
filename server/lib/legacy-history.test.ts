import {beforeAll,afterAll,beforeEach,describe,it,expect} from "vitest";
import {readFileSync} from "node:fs";
import {Pool} from "pg";
import {startFixture,verifyFixture} from "./ownership-fixture";
import {LegacyHistoryReads,parseHistoryPage,HistoryInputError,HistoryChanged} from "./legacy-history";
import {ResourceLimitError,MAX_READ_ROWS} from "./read-budget";
import {stateBundle} from "./history-state";
import {computeBaseline} from "./anomaly";
describe("real bounded legacy reads against a nonce-owned synthetic database",()=>{
  let fixture:Awaited<ReturnType<typeof startFixture>>,pool:Pool,reads:LegacyHistoryReads;
  const now=new Date("2026-10-15T12:00:00.000Z");
  beforeAll(async()=>{
    fixture=await startFixture("somr467-history");
    verifyFixture(fixture.root);
    pool=new Pool({host:fixture.root+"/socket",port:5432,database:"postgres",user:"synthetic",password:"",ssl:false,
      connectionTimeoutMillis:5000,max:3});
    reads=new LegacyHistoryReads({connect:async()=>{verifyFixture(fixture.root);return pool.connect();}},()=>now);
    await fixture.client.query(readFileSync("migrations/0002_bounded_history_read_indexes.sql","utf8"));
    await fixture.client.query("INSERT INTO users(id) VALUES('history-a'),('history-b'); INSERT INTO user_settings(user_id) VALUES('history-a'),('history-b')");
  },60000);
  afterAll(async()=>{try{if(pool)await pool.end();}finally{if(fixture)await fixture.cleanup();}},60000);
  beforeEach(async()=>{await fixture.client.query("DELETE FROM sessions; DELETE FROM deviations");});
  async function insert(id:string,at:string,notes:string|null=null,owner="history-a",minutes=10){
    await fixture.client.query("INSERT INTO sessions(id,user_id,domain,duration_minutes,timestamp,notes) VALUES($1,$2,'meditation',$3,$4,$5)",[id,owner,minutes,at,notes]);
  }
  it("preserves every unchanged older/future row through explicit microsecond-safe pages",async()=>{
    await fixture.client.query(`INSERT INTO sessions(id,user_id,domain,duration_minutes,timestamp)
      SELECT 'tie-'||lpad(n::text,4,'0'),'history-a','meditation',10,'2026-10-15 12:00:00+00'::timestamptz+n*interval '1 microsecond' FROM generate_series(1,121)n`);
    await insert("old","2016-01-01T00:00:00Z");await insert("future","2031-01-01T00:00:00Z");await insert("foreign","2040-01-01T00:00:00Z",null,"history-b");
    const ids:string[]=[];let cursor:string|undefined;
    do{const p=await reads.page("history-a","sessions",{limit:17,...(cursor?{cursor}:{})});
      ids.push(...p.items.map(x=>x.id));cursor=p.nextCursor??undefined;expect(p.complete).toBe(p.nextCursor===null);
    }while(cursor);
    expect(ids).toHaveLength(123);expect(new Set(ids).size).toBe(123);
    expect(ids[0]).toBe("future");expect(ids.at(-1)).toBe("old");expect(ids).not.toContain("foreign");
  });
  it("scopes cursors and parameterized opaque IDs to owner and collection",async()=>{
    await insert("opaque:/part?#% '\\n"+ "x".repeat(512),"2026-01-02T00:00:00Z");
    await insert("second","2026-01-01T00:00:00Z");
    const p=await reads.page("history-a","sessions",{limit:1});expect(p.nextCursor).not.toBeNull();
    await expect(reads.page("history-b","sessions",{limit:1,cursor:p.nextCursor!})).rejects.toBeInstanceOf(HistoryInputError);
    await expect(reads.page("history-a","deleted",{limit:1,cursor:p.nextCursor!})).rejects.toBeInstanceOf(HistoryInputError);
    const next=await reads.page("history-a","sessions",{limit:1,cursor:p.nextCursor!});expect(next.items[0].id).toBe("second");
  });
  it("keeps huge exact Unicode/whitespace out of lists and reconstructs it only by explicit chunks",async()=>{
    const text="  "+("😀漢字é\r\n\t ".repeat(2000))+"  ";
    await insert("unicode",now.toISOString(),text);
    const page=await reads.page("history-a","sessions",{limit:50}),summary=page.items[0] as any;
    expect(summary.notes).toBeNull();expect(summary.hasNotes).toBe(true);expect(summary.notesBytes).toBe(Buffer.byteLength(text));
    expect(JSON.stringify(page).length).toBeLessThan(2000);
    const detail=await reads.detail("history-a","sessions","unicode");
    let offset=0,combined="",calls=0;
    for(;;){
      const chunk=await reads.text("history-a","sessions","unicode",{field:"notes",version:detail.textVersion,offset:String(offset)});
      expect(Buffer.byteLength(chunk.text??"")).toBeLessThanOrEqual(8192);
      combined+=chunk.text;calls++;if(chunk.nextOffset===null)break;
      expect(chunk.nextOffset).toBe(offset+Array.from(chunk.text!).length);offset=chunk.nextOffset;
      if(calls>100)throw new Error("Nonterminating text fixture");
    }
    expect(combined).toBe(text);
    await fixture.client.query("UPDATE sessions SET notes=notes||'changed' WHERE id='unicode'");
    await expect(reads.text("history-a","sessions","unicode",{field:"notes",version:detail.textVersion,offset:"2048"})).rejects.toBeInstanceOf(HistoryChanged);
    await expect(reads.detail("history-b","sessions","unicode")).rejects.toMatchObject({status:404});
  });
  it("distinguishes empty text from SQL NULL without normalizing either",async()=>{
    await insert("empty",now.toISOString(),"");await insert("absent",now.toISOString());
    for(const id of ["empty","absent"]){
      const d=await reads.detail("history-a","sessions",id);
      const chunk=await reads.text("history-a","sessions",id,{field:"notes",version:d.textVersion,offset:"0"});
      expect(chunk.text).toBe(id==="empty"?"":null);expect(chunk.nextOffset).toBeNull();
    }
  });
  it("uses the closed baseline interval and exclusions BEFORE its row budget",async()=>{
    const cutoff=new Date(now.getTime()-42*86400000).toISOString();
    await insert("at-cutoff",cutoff,null,"history-a",20);await insert("at-now",now.toISOString(),null,"history-a",40);
    await insert("before",new Date(Date.parse(cutoff)-1).toISOString());await insert("after",new Date(now.getTime()+1).toISOString());
    await fixture.client.query(`INSERT INTO sessions(id,user_id,domain,duration_minutes,timestamp)
      SELECT 'future-'||n,'history-a','meditation',900,'2030-01-01' FROM generate_series(1,${MAX_READ_ROWS+1})n`);
    const rows=await reads.baseline("history-a",now,"meditation","at-now");
    expect(rows.map(s=>s.id)).toEqual(["at-cutoff"]);
    expect(computeBaseline("meditation",rows,{now}).sampleCount).toBe(1);
  });
  it("returns no partial context at the exact row-budget boundary",async()=>{
    await fixture.client.query(`INSERT INTO sessions(id,user_id,domain,duration_minutes,timestamp)
      SELECT 'budget-'||n,'history-a','meditation',10,'2026-10-01' FROM generate_series(1,${MAX_READ_ROWS})n`);
    const input=await reads.current("history-a",14);expect(input.context).toHaveLength(MAX_READ_ROWS);
    await insert("one-too-many","2026-10-02T00:00:00Z");
    await expect(reads.current("history-a",14)).rejects.toBeInstanceOf(ResourceLimitError);
    expect((await fixture.client.query("SELECT count(*)::int n FROM sessions")).rows[0].n).toBe(MAX_READ_ROWS+1);
  });
  it("uses the existing first-account defaults without writing inside the snapshot",async()=>{
    await fixture.client.query("DELETE FROM user_settings WHERE user_id='history-b'");
    const input=await reads.current("history-b",14);
    expect(input.settings).toMatchObject({dayStartHour:4,timezone:"America/New_York",windowDays:7,
      notificationsEnabled:false,notificationTier:"WARNING"});
    expect(input.context).toEqual([]);
    expect((await fixture.client.query("SELECT count(*)::int n FROM user_settings WHERE user_id='history-b'")).rows[0].n).toBe(0);
    await fixture.client.query("INSERT INTO user_settings(user_id) VALUES('history-b')");
  });
  it("retains future context and uses one snapshot/clock for all successful state components",async()=>{
    await insert("future","2027-01-01T00:00:00Z");await insert("today",now.toISOString());
    const bundle=stateBundle(await reads.current("history-a",14),14);
    expect(bundle.ownerUserId).toBe("history-a");expect(bundle.asOf).toBe(now.toISOString());expect(bundle.complete).toBe(true);
    expect(bundle.context.sessions.map(s=>s.id)).toContain("future");
    expect(bundle.policyState.sessionDays.future).toBe("2026-12-31");
    expect(bundle.policyState.services.meditation.actual_minutes).toBe(0);
    expect(bundle.escalationState.logical_day).toBe(bundle.policyState.logical_day);
  });
  it("keeps deleted and deviations in their distinct owner-scoped pages",async()=>{
    await insert("deleted",now.toISOString(),"old note");await fixture.client.query("UPDATE sessions SET deleted_at=$1 WHERE id='deleted'",[now]);
    await fixture.client.query(`INSERT INTO deviations(id,user_id,domain,reason,start_at,end_at) VALUES
      ('active','history-a','meditation','  huge reason  ','2020-01-01',NULL),
      ('planned','history-a','music','future','2030-01-01',NULL),
      ('ended','history-a','fitness','past','2020-01-01','2020-02-01')`);
    expect((await reads.page("history-a","sessions",{limit:50})).items).toHaveLength(0);
    expect((await reads.page("history-a","deleted",{limit:50})).items.map(x=>x.id)).toEqual(["deleted"]);
    expect((await reads.page("history-a","deviations",{limit:50,state:"active"})).items.map(x=>x.id)).toEqual(["active"]);
    expect((await reads.current("history-a",14)).contextDeviations.map(x=>x.id).sort()).toEqual(["active","planned"]);
  });
  it.each([{limit:"0"},{limit:"101"},{limit:"1tail"},{cursor:[]},{userId:"forged"}])("rejects malformed page %# before data access",q=>{
    expect(()=>parseHistoryPage(q)).toThrow(HistoryInputError);
  });
  it("times out bounded database work and rolls the owned transaction back",async()=>{
    const c=await pool.connect();let destroyed=false;
    try{
      const slow={connect:async()=>({...c,query:async(sql:any,args?:unknown[])=>{
        const text=typeof sql==="string"?sql:sql.text;
        if(text.includes("SELECT s.id"))return c.query({text:"SELECT pg_sleep(4)",query_timeout:sql.query_timeout});
        return c.query(sql,args);
      },release:(kill:boolean)=>{if(kill){destroyed=true;c.release(true);}}})};
      const slowReads=new LegacyHistoryReads(slow as any,()=>now);
      await expect(slowReads.baseline("history-a",now)).rejects.toBeInstanceOf(ResourceLimitError);
      expect((await (destroyed?pool.query("SELECT 1 AS ok"):c.query("SELECT 1 AS ok"))).rows[0].ok).toBe(1);
    }finally{if(!destroyed)c.release();}
  },10000);
});
