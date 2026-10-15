import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { startFixture } from "./ownership-fixture";
import { BoundaryError, type Transaction } from "./org-context";
import { OWNER_WRITE_LIMITS, WriteResourceLimitError, withOwnerWriteBudget, readOwnerWriteBudgetStatus } from "./write-resource-budget";

describe("durable owner write admission in actual disposable PostgreSQL", () => {
  let f: Awaited<ReturnType<typeof startFixture>>, pool: Pool;
  beforeAll(async () => {
    f = await startFixture("write-resource-budget");
    await f.client.query("CREATE TABLE public.write_budget_probe(id text PRIMARY KEY,owner_id text NOT NULL)");
    pool = new Pool({host:f.root+"/socket",port:5432,user:"synthetic",database:"postgres",password:"",ssl:false,
      max:4,connectionTimeoutMillis:5000,options:"-c statement_timeout=10000 -c lock_timeout=2000"});
  },60000);
  afterAll(async () => { try { if(pool)await pool.end(); } finally { if(f)await f.cleanup(); } },60000);
  async function owner(id:string) { await f.client.query("INSERT INTO public.users(id) VALUES($1)",[id]); return id; }
  async function transaction<T>(operation:(tx:Transaction)=>Promise<T>):Promise<T> {
    const client=await pool.connect();
    try {
      await client.query("BEGIN");
      const tx:Transaction={query:(text,values=[])=>client.query(text,values)};
      const value=await operation(tx);
      const result=await client.query("COMMIT");
      if(result.command!=="COMMIT")throw new BoundaryError(503);
      return value;
    } catch(error) { try { await client.query("ROLLBACK"); } catch {} throw error; }
    finally { client.release(); }
  }
  const counts=async(id:string)=>(await f.client.query("SELECT minute_count,day_count FROM public.owner_write_resource_budgets WHERE owner_user_id=$1",[id])).rows;
  async function seedCounts(id:string,minute:number,day:number,old=false) {
    await f.client.query(`INSERT INTO public.owner_write_resource_budgets(owner_user_id,minute_started_at,minute_count,day_date,day_count)
      VALUES($1,date_trunc('minute',clock_timestamp())-CASE WHEN $4 THEN interval '2 minutes' ELSE interval '0' END,$2,
        (clock_timestamp() AT TIME ZONE 'UTC')::date-CASE WHEN $4 THEN 1 ELSE 0 END,$3)
      ON CONFLICT(owner_user_id) DO UPDATE SET minute_started_at=EXCLUDED.minute_started_at,minute_count=EXCLUDED.minute_count,
        day_date=EXCLUDED.day_date,day_count=EXCLUDED.day_count`,[id,minute,day,old]);
  }
  async function record(tx:Transaction,id:string,key:string) {
    return withOwnerWriteBudget(tx,id,async budget=>{
      await budget.admitMutation();
      await tx.query("INSERT INTO public.write_budget_probe VALUES($1,$2)",[key,id]);
    });
  }
  it("adds owner-leading measurement indexes without payload storage or partial-history filters",async()=>{
    const columns=(await f.client.query("SELECT column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='owner_write_resource_budgets' ORDER BY ordinal_position")).rows;
    expect(columns.map(row=>[row.column_name,row.data_type,row.is_nullable])).toEqual([
      ["owner_user_id","text","NO"],["minute_started_at","timestamp with time zone","NO"],["minute_count","integer","NO"],
      ["day_date","date","NO"],["day_count","integer","NO"],["observed_bytes","bigint","NO"],
      ["observed_at","timestamp with time zone","YES"],["updated_at","timestamp with time zone","NO"]]);
    const constraints=(await f.client.query("SELECT contype,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='public.owner_write_resource_budgets'::regclass")).rows;
    expect(constraints.filter(row=>row.contype==="p").map(row=>row.definition)).toEqual(["PRIMARY KEY (owner_user_id)"]);
    expect(constraints.filter(row=>row.contype==="f")).toHaveLength(1);
    expect(constraints.find(row=>row.contype==="f").definition).toContain("FOREIGN KEY (owner_user_id)");
    expect(constraints.filter(row=>row.contype==="c")).toHaveLength(3);
    const indexes=(await f.client.query("SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND indexname LIKE 'somr468_%_owner_bytes_idx' ORDER BY indexname")).rows;
    expect(indexes).toHaveLength(12);
    for(const row of indexes){
      if(row.indexname==="somr468_audit_events_owner_bytes_idx"){
        expect(row.indexdef).toContain("(actor_user_id)");expect(row.indexdef).toContain("actor_kind");
      }else{
        expect(row.indexdef).toMatch(/\((?:user_id|owner_user_id)\)/);
        expect(row.indexdef).not.toContain(" WHERE ");
      }
      expect(row.indexdef).not.toContain(" INCLUDE ");
    }
  });
  it("no-op and exact idempotent replay do not create or increment a counter",async()=>{
    const id=await owner("write-noop");
    expect(await transaction(tx=>withOwnerWriteBudget(tx,id,async()=>"unchanged"))).toBe("unchanged");
    expect(await counts(id)).toEqual([]);
    await transaction(tx=>record(tx,id,"replay-key"));
    await transaction(tx=>withOwnerWriteBudget(tx,id,async budget=>{
      const found=await tx.query("SELECT id FROM public.write_budget_probe WHERE id=$1",["replay-key"]);
      if(found.rows.length)return "replayed";
      await budget.admitMutation();throw Error("not reached");
    }));
    expect(await counts(id)).toEqual([{minute_count:1,day_count:1}]);
  });
  it("nested and sequential scopes use one durable charge for the same transaction",async()=>{
    const id=await owner("write-nested");
    await transaction(async tx=>{
      await withOwnerWriteBudget(tx,id,async outer=>{
        await outer.admitMutation();
        await withOwnerWriteBudget(tx,id,async inner=>{await inner.admitMutation();});
        await tx.query("INSERT INTO public.write_budget_probe VALUES('nested-a',$1)",[id]);
      });
      await withOwnerWriteBudget(tx,id,async next=>{
        await next.admitMutation();
        await tx.query("INSERT INTO public.write_budget_probe VALUES('nested-b',$1)",[id]);
      });
    });
    expect(await counts(id)).toEqual([{minute_count:1,day_count:1}]);
  });
  it("two independent connections cannot both spend the final minute allowance",async()=>{
    const id=await owner("write-race");await seedCounts(id,29,41);
    const settled=await Promise.allSettled([0,1].map(n=>transaction(tx=>record(tx,id,"race-"+n))));
    expect(settled.filter(r=>r.status==="fulfilled")).toHaveLength(1);
    const denied=settled.find(r=>r.status==="rejected") as PromiseRejectedResult;
    expect(denied.reason).toBeInstanceOf(WriteResourceLimitError);
    expect(denied.reason).toMatchObject({status:429,code:"WRITE_RATE_LIMIT_EXCEEDED"});
    expect(denied.reason.retryAfterSeconds).toBeGreaterThan(0);
    expect(await counts(id)).toEqual([{minute_count:30,day_count:42}]);
    expect((await f.client.query("SELECT count(*)::int n FROM public.write_budget_probe WHERE owner_id=$1",[id])).rows[0].n).toBe(1);
  });
  it("enforces the UTC daily allowance independently of the minute bucket and resets elapsed buckets",async()=>{
    const id=await owner("write-daily");await seedCounts(id,0,500);
    await expect(transaction(tx=>record(tx,id,"daily-denied"))).rejects.toMatchObject({status:429,code:"WRITE_RATE_LIMIT_EXCEEDED"});
    expect(await counts(id)).toEqual([{minute_count:0,day_count:500}]);
    await seedCounts(id,30,500,true);
    await transaction(tx=>record(tx,id,"daily-reset"));
    expect(await counts(id)).toEqual([{minute_count:1,day_count:1}]);
  });
  it("a late audit/business SQL failure rolls back the counter and prior writes",async()=>{
    const id=await owner("write-rollback");
    await expect(transaction(tx=>withOwnerWriteBudget(tx,id,async budget=>{
      await budget.admitMutation();
      await tx.query("INSERT INTO public.write_budget_probe VALUES('rollback-before',$1)",[id]);
      await tx.query("INSERT INTO public.write_budget_probe VALUES('rollback-before',$1)",[id]);
    }))).rejects.toMatchObject({status:503});
    expect(await counts(id)).toEqual([]);
    expect((await f.client.query("SELECT count(*)::int n FROM public.write_budget_probe WHERE id='rollback-before'")).rows[0].n).toBe(0);
  });
  it("caught admission refusal still returns the original429 and aborts earlier writes",async()=>{
    const id=await owner("write-caught");await seedCounts(id,30,40);
    await expect(transaction(tx=>withOwnerWriteBudget(tx,id,async budget=>{
      await tx.query("INSERT INTO public.write_budget_probe VALUES('caught-before',$1)",[id]);
      try { await budget.admitMutation(); } catch(error) { expect(error).toMatchObject({status:429}); }
      return "cannot commit";
    }))).rejects.toMatchObject({status:429,code:"WRITE_RATE_LIMIT_EXCEEDED"});
    expect(await counts(id)).toEqual([{minute_count:30,day_count:40}]);
    expect((await f.client.query("SELECT count(*)::int n FROM public.write_budget_probe WHERE id='caught-before'")).rows[0].n).toBe(0);
  });
  it("even catching the entire helper rejection leaves the SQL transaction aborted",async()=>{
    const id=await owner("write-swallowed");await seedCounts(id,30,40);
    await expect(transaction(async tx=>{
      await tx.query("INSERT INTO public.write_budget_probe VALUES('swallowed-before',$1)",[id]);
      try { await record(tx,id,"swallowed-after"); } catch(error) { expect(error).toMatchObject({status:429}); }
      return "ignored";
    })).rejects.toMatchObject({status:503});
    expect(await counts(id)).toEqual([{minute_count:30,day_count:40}]);
    expect((await f.client.query("SELECT count(*)::int n FROM public.write_budget_probe WHERE owner_id=$1",[id])).rows[0].n).toBe(0);
  });
  it("refuses another owner in a shared transaction and rolls back the first owner's charge",async()=>{
    const a=await owner("write-owner-a"),b=await owner("write-owner-b");
    await expect(transaction(tx=>withOwnerWriteBudget(tx,a,async first=>{
      await first.admitMutation();
      await tx.query("INSERT INTO public.write_budget_probe VALUES('mixed-owner',$1)",[a]);
      try { await withOwnerWriteBudget(tx,b,async second=>second.admitMutation()); } catch {}
    }))).rejects.toMatchObject({status:403});
    expect(await counts(a)).toEqual([]);expect(await counts(b)).toEqual([]);
  });
  it("monitoring is owner-scoped, scalar-only, and includes exact UTF8 logical growth",async()=>{
    const a=await owner("write-measure-a"),b=await owner("write-measure-b");
    await f.client.query("INSERT INTO public.sessions(id,user_id,domain,duration_minutes,timestamp,notes) VALUES('measure-a',$1,'meditation',10,clock_timestamp(),'small'),('measure-b',$2,'meditation',10,clock_timestamp(),repeat('private-other-owner',10000))",[a,b]);
    const before=await transaction(tx=>readOwnerWriteBudgetStatus(tx,a));
    expect(before.storage.enforcement).toBe("monitor_only");expect(before.storage.limitBytes).toBe(100*1024*1024);
    expect(before.minute).toMatchObject({used:0,limit:30,remaining:30});expect(await counts(a)).toEqual([]);
    await f.client.query("UPDATE public.sessions SET notes=repeat('ß',512) WHERE id='measure-a'");
    const after=await transaction(tx=>readOwnerWriteBudgetStatus(tx,a));
    expect(after.storage.usedBytes-before.storage.usedBytes).toBe(1024-5);
    expect(JSON.stringify(after)).not.toContain("private-other-owner");
    expect(Object.keys(after).sort()).toEqual(["asOf","day","minute","ownerUserId","storage"]);
  });
  it("a proposed cap only monitors by default; explicit growth enforcement rolls back above-cap expansion",async()=>{
    const id=await owner("write-cap");
    await f.client.query("INSERT INTO public.sessions(id,user_id,domain,duration_minutes,timestamp,notes) VALUES('cap-prior',$1,'meditation',10,clock_timestamp(),repeat('old exact 🙂 ',500))",[id]);
    await transaction(tx=>withOwnerWriteBudget(tx,id,async budget=>{
      await budget.admitMutation();await tx.query("INSERT INTO public.write_budget_probe VALUES('monitor-accepted',$1)",[id]);
    },{capacityBytes:1}));
    const before=(await f.client.query("SELECT md5(notes) digest,octet_length(notes) bytes FROM sessions WHERE id='cap-prior'")).rows[0];
    await expect(transaction(tx=>withOwnerWriteBudget(tx,id,async budget=>{
      await budget.admitMutation();
      await tx.query("INSERT INTO public.sessions(id,user_id,domain,duration_minutes,timestamp,notes) VALUES('cap-growth',$1,'meditation',10,clock_timestamp(),'new')",[id]);
    },{capacityBytes:1,enforceCapacity:true}))).rejects.toMatchObject({status:429,code:"OWNER_CAPACITY_EXCEEDED",retryAfterSeconds:null});
    expect((await f.client.query("SELECT md5(notes) digest,octet_length(notes) bytes FROM sessions WHERE id='cap-prior'")).rows[0]).toEqual(before);
    expect((await f.client.query("SELECT count(*)::int n FROM sessions WHERE id='cap-growth'")).rows[0].n).toBe(0);
    expect(await counts(id)).toEqual([{minute_count:1,day_count:1}]);
    // Existing above-cap records remain readable; a net reduction is permitted.
    await transaction(tx=>withOwnerWriteBudget(tx,id,async budget=>{
      await budget.admitMutation();await tx.query("UPDATE sessions SET notes='shortened' WHERE id='cap-prior'");
    },{capacityBytes:1,enforceCapacity:true}));
    expect(await counts(id)).toEqual([{minute_count:2,day_count:2}]);
  });
  it("monitor-only save work stays constant as retained owner history grows and never calls optional measurement",async()=>{
    const small=await owner("write-small-history"),large=await owner("write-large-history");
    await f.client.query("INSERT INTO public.sessions(id,user_id,domain,duration_minutes,timestamp,notes,deleted_at) "+
      "SELECT 'large-history-'||n,$1,'meditation',10,'2026-01-01T12:00:00Z',repeat('retained 🙂 ',128),"+
      "CASE WHEN n%2=0 THEN '2026-01-02T12:00:00Z'::timestamptz ELSE NULL END FROM generate_series(1,2048) n",[large]);
    const trace:Record<string,string[]>={};
    for(const id of [small,large]){
      trace[id]=[];
      await transaction(raw=>{
        const tx:Transaction={query:(text,values=[])=>{
          trace[id].push(text);
          // A monitor failure would be fatal if it were accidentally coupled
          // to this business transaction. Neither full-count nor observation
          // metadata writes may occur on the monitor-only save path.
          if(text.includes("to_jsonb(")||text.includes("observed_bytes"))
            throw Error("Optional measurement must not run during a save");
          return raw.query(text,values);
        }};
        return record(tx,id,id+"-saved");
      });
      expect(await counts(id)).toEqual([{minute_count:1,day_count:1}]);
      expect((await f.client.query("SELECT count(*)::int n FROM public.write_budget_probe WHERE owner_id=$1",[id])).rows[0].n).toBe(1);
    }
    expect(trace[large]).toEqual(trace[small]);
    expect((await f.client.query("SELECT count(*)::int n FROM public.sessions WHERE user_id=$1",[large])).rows[0].n).toBe(2048);
    // Never label an old/default byte value as a newly measured observation.
    expect((await f.client.query("SELECT observed_at FROM public.owner_write_resource_budgets WHERE owner_user_id IN ($1,$2)",[small,large])).rows)
      .toEqual([{observed_at:null},{observed_at:null}]);
  });
  it("a failed explicit standalone measurement does not consume admission or prevent a later valid save",async()=>{
    const id=await owner("write-monitor-timeout");
    await expect(transaction(raw=>{
      const tx:Transaction={query:(text,values=[])=>text.includes(" AS used_bytes ")?raw.query("SELECT pg_sleep(3)"):raw.query(text,values)};
      return readOwnerWriteBudgetStatus(tx,id);
    })).rejects.toMatchObject({status:503});
    expect(await counts(id)).toEqual([]);
    await transaction(tx=>record(tx,id,"after-monitor-failure"));
    expect(await counts(id)).toEqual([{minute_count:1,day_count:1}]);
    expect((await f.client.query("SELECT count(*)::int n FROM public.write_budget_probe WHERE id='after-monitor-failure'")).rows[0].n).toBe(1);
    const measured=await transaction(tx=>readOwnerWriteBudgetStatus(tx,id));
    expect(measured.ownerUserId).toBe(id);
    expect(measured.storage.enforcement).toBe("monitor_only");
    expect(measured.storage.usedBytes).toBeGreaterThan(0);
  },10000);
  it("explicit capacity enforcement retains a real finite PostgreSQL statement deadline",async()=>{
    const id=await owner("write-timeout");
    await expect(transaction(raw=>{
      const tx:Transaction={query:(text,values)=>text.startsWith("SELECT (")?raw.query("SELECT pg_sleep(3)"):raw.query(text,values)};
      return withOwnerWriteBudget(tx,id,async budget=>budget.admitMutation(),{enforceCapacity:true});
    })).rejects.toMatchObject({status:503});
    expect(await counts(id)).toEqual([]);
  },10000);
  it("publishes the fixed rate defaults without imposing practice quantity or goal limits",()=>{
    expect(OWNER_WRITE_LIMITS).toEqual({minute:30,day:500,capacityBytes:100*1024*1024});
  });
});
