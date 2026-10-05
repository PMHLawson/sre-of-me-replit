import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createPinnedOwnershipUnit, type OwnershipUnit } from "./pinned-ownership-unit";
import { BoundaryError, createOrgContextResolver, revalidate } from "./org-context";
import { startFixture, verifyFixture } from "./ownership-fixture";

const request = (sub: string) => ({ isAuthenticated: () => true, user: { claims: { sub } } });
describe("pinned ownership unit: actual owned PostgreSQL", () => {
  let fixture: Awaited<ReturnType<typeof startFixture>>, pool: Pool;
  beforeAll(async () => {
    fixture = await startFixture("pinned-unit");
    await fixture.client.query(`INSERT INTO users(id) VALUES ('unit-a'),('unit-b');
      INSERT INTO organizations(org_id,display_name) VALUES ('unit-one','One'),('unit-two','Two');
      INSERT INTO organization_members(org_id,user_id,role) VALUES ('unit-one','unit-a','owner'),('unit-two','unit-b','owner');
      CREATE TABLE public.unit_probe(id text PRIMARY KEY, value integer NOT NULL);
      CREATE TABLE public.unit_audit(id text PRIMARY KEY, value integer NOT NULL);`);
    verifyFixture(fixture.root); // before creating the test-only pool
    pool = new Pool({host:fixture.root+"/socket",port:5432,user:"synthetic",database:"postgres",password:"",ssl:false,
      max:3,connectionTimeoutMillis:5000,options:"-c statement_timeout=10000 -c lock_timeout=2000"});
  },60000);
  afterAll(async () => { if(pool) await pool.end(); if(fixture) await fixture.cleanup(); },60000);

  it("authenticates before any connection and bounds malformed/throwing claims", async () => {
    let connections = 0;
    const unit = createPinnedOwnershipUnit({connect:async()=>{connections++;throw Error("private URL");}} as any);
    const invalid:any[] = [{},request(" "),request("__proto__"),request("x".repeat(201)),request("x\u0000"),
      {...request("unit-a"),isAuthenticated:()=>false},{...request("unit-a"),isAuthenticated:()=>{throw Error("secret");}}];
    invalid.push({get user(){throw Error("private token");},isAuthenticated:()=>true});
    for(const req of invalid) await expect(unit.run(req,async()=>"unexpected")).rejects.toMatchObject({status:401,message:"Authentication required"});
    expect(connections).toBe(0);
    await expect(unit.run(request("unit-a"),async()=>0)).rejects.toMatchObject({status:503,message:"Service unavailable"});
    expect(connections).toBe(1);
  });

  it("uses the original authenticated actor and the SAME PostgreSQL transaction for nested repositories", async () => {
    let connects = 0, escaped:OwnershipUnit|undefined;
    const unit = createPinnedOwnershipUnit({connect:async()=>{connects++;return pool.connect();}} as any);
    const req = {...request("unit-a"),body:{orgId:"unit-two",userId:"unit-b"},query:{orgId:"unit-two"}};
    const result = await unit.run(req,async u=>{
      escaped=u; expect(u.context.actorUserId).toBe("unit-a"); expect(u.context.orgId).toBe("unit-one");
      const before=(await u.tx.query("SELECT pg_backend_pid() pid,txid_current() tx")).rows[0];
      const nested=await u.db.transaction(async tx=>{
        await revalidate(tx,u.db,u.context);
        await tx.query("INSERT INTO public.unit_probe VALUES ($1,$2)",["commit",7]);
        await tx.query("INSERT INTO public.unit_audit VALUES ($1,$2)",["commit",7]);
        return (await tx.query("SELECT pg_backend_pid() pid,txid_current() tx")).rows[0];
      });
      expect(nested).toEqual(before);
      expect(Object.isFrozen(u)).toBe(true);
      return "committed";
    });
    expect(result).toBe("committed");expect(connects).toBe(1);
    expect((await fixture.client.query("SELECT value FROM public.unit_probe WHERE id='commit'")).rows[0]).toEqual({value:7});
    expect((await fixture.client.query("SELECT value FROM public.unit_audit WHERE id='commit'")).rows[0]).toEqual({value:7});
    await expect(escaped!.tx.query("INSERT INTO public.unit_probe VALUES ('escaped',99)")).rejects.toMatchObject({status:503});
    await expect(escaped!.db.transaction(async()=>0)).rejects.toMatchObject({status:503});
    expect((await fixture.client.query("SELECT count(*)::int n FROM public.unit_probe WHERE id='escaped'")).rows[0].n).toBe(0);
  });

  it("rolls back legacy and canonical writes when a late audit fails, even if the callback catches the SQL error", async () => {
    const unit=createPinnedOwnershipUnit(pool);
    await expect(unit.run(request("unit-a"),async u=>{
      await u.tx.query("INSERT INTO public.unit_probe VALUES ('late-failure',9)");
      await u.tx.query("INSERT INTO public.unit_audit VALUES ('late-failure',9)");
      try{await u.db.transaction(tx=>tx.query("INSERT INTO public.unit_audit VALUES ('late-failure',10)"));}catch{/* cannot turn partial success into a commit */}
      return "not committed";
    })).rejects.toMatchObject({status:503});
    for(const table of ["unit_probe","unit_audit"])
      expect((await fixture.client.query(`SELECT count(*)::int n FROM public.${table} WHERE id='late-failure'`)).rows[0].n).toBe(0);
  });

  it("rolls back caught nested validation failures and callback failures with no leaked private error",async()=>{
    const unit=createPinnedOwnershipUnit(pool);
    await expect(unit.run(request("unit-a"),async u=>{
      await u.tx.query("INSERT INTO public.unit_probe VALUES ('validation',1)");
      try{await u.db.transaction(async()=>{throw new BoundaryError(400);});}catch{}
      return 1;
    })).rejects.toMatchObject({status:503});
    await expect(unit.run(request("unit-a"),async u=>{
      await u.tx.query("INSERT INTO public.unit_probe VALUES ('callback',1)");throw Error("private connection value");
    })).rejects.toMatchObject({status:503,message:"Service unavailable"});
    expect((await fixture.client.query("SELECT count(*)::int n FROM public.unit_probe WHERE id IN ('validation','callback')")).rows[0].n).toBe(0);
  });

  it("awaits pending database writes and refuses transaction escape",async()=>{
    const unit=createPinnedOwnershipUnit(pool);
    await unit.run(request("unit-a"),async u=>{
      void u.tx.query("INSERT INTO public.unit_probe VALUES ('pending',1)");
      void u.tx.query("INSERT INTO public.unit_audit VALUES ('pending',1)");
    });
    expect((await fixture.client.query("SELECT count(*)::int n FROM public.unit_audit WHERE id='pending'")).rows[0].n).toBe(1);
    for(const sql of ["COMMIT","ROLLBACK","BEGIN","SELECT 1; COMMIT","SAVEPOINT bad"]){
      await expect(unit.run(request("unit-a"),async u=>{
        await u.tx.query("INSERT INTO public.unit_probe VALUES ('control',1)");
        try{await u.tx.query(sql);}catch{}
      })).rejects.toMatchObject({status:503});
    }
    expect((await fixture.client.query("SELECT count(*)::int n FROM public.unit_probe WHERE id='control'")).rows[0].n).toBe(0);
    await expect(unit.run(request("unit-a"),async u=>{
      await u.tx.query("INSERT INTO public.unit_probe VALUES ('unawaited-control',1)");
      void u.tx.query("COMMIT");
    })).rejects.toMatchObject({status:503});
    expect((await fixture.client.query("SELECT count(*)::int n FROM public.unit_probe WHERE id='unawaited-control'")).rows[0].n).toBe(0);
  });

  it("isolates concurrent owners and expires capabilities across units",async()=>{
    const unit=createPinnedOwnershipUnit(pool), pids:number[]=[];
    let arrive=0, release!:()=>void;
    const barrier=new Promise<void>(resolve=>{release=resolve;});
    let old:OwnershipUnit|undefined;
    await Promise.all(["unit-a","unit-b"].map(actor=>unit.run(request(actor),async u=>{
      pids.push((await u.tx.query("SELECT pg_backend_pid() pid")).rows[0].pid);
      if(actor==="unit-a")old=u;
      arrive++;if(arrive===2)release();await barrier;
      await u.tx.query("INSERT INTO public.unit_probe VALUES ($1,$2)",[actor,1]);
    })));
    expect(new Set(pids).size).toBe(2);
    await expect(unit.run(request("unit-a"),u=>revalidate(u.tx,u.db,old!.context))).rejects.toMatchObject({status:403});
    expect((await fixture.client.query("SELECT count(*)::int n FROM public.unit_probe WHERE id IN ('unit-a','unit-b')")).rows[0].n).toBe(2);
  });

  it("refuses ambiguous/revoked ownership without running mutation callbacks",async()=>{
    const unit=createPinnedOwnershipUnit(pool);let called=false;
    await fixture.client.query("INSERT INTO organization_members(org_id,user_id,role) VALUES ('unit-two','unit-a','member')");
    await expect(unit.run(request("unit-a"),async()=>{called=true;})).rejects.toMatchObject({status:403});
    expect(called).toBe(false);
    await fixture.client.query("DELETE FROM organization_members WHERE user_id='unit-a'");
    await expect(unit.run(request("unit-a"),async()=>{called=true;})).rejects.toMatchObject({status:403});
    expect(called).toBe(false);
  });
});

describe("pinned unit connection failure cleanup (injected transport only)",()=>{
  it("destroys uncertain BEGIN/COMMIT and failed rollback clients exactly once without ending the caller's pool",async()=>{
    for(const failure of ["BEGIN","COMMIT","ROLLBACK"]){
      const releases:boolean[]=[],calls:string[]=[];
      const client:any={query:async(sql:string)=>{
        calls.push(sql);if(sql===failure)throw Error("private transport");
        if(sql.startsWith("SELECT id FROM"))return {rows:[{id:"test"}],rowCount:1};
        if(sql.includes("FROM public.organization_members"))return {rows:[{org_id:"org",user_id:"test",role:"owner",created_at:0,updated_at:0}],rowCount:1};
        if(sql.includes("FROM public.organizations"))return {rows:[{org_id:"org",rollout_mode:"legacy"}],rowCount:1};
        return {rows:[],rowCount:0,command:sql};
      },release:(destroy:boolean)=>releases.push(destroy)};
      const unit=createPinnedOwnershipUnit({connect:async()=>client} as any);
      await expect(unit.run(request("test"),async()=>{if(failure==="ROLLBACK")throw new BoundaryError(400);return 1;})).rejects.toMatchObject({status:503,message:"Service unavailable"});
      expect(releases).toEqual([true]);
      expect(calls.filter(c=>c==="COMMIT").length).toBe(failure==="COMMIT"?1:0);
    }
  });
  it("never treats PostgreSQL's ROLLBACK response to COMMIT as a successful write",async()=>{
    const releases:boolean[]=[],client:any={query:async(sql:string)=>{
      if(sql.startsWith("SELECT id FROM"))return {rows:[{id:"test"}]};
      if(sql.includes("FROM public.organization_members"))return {rows:[{org_id:"org",user_id:"test",role:"owner",created_at:0,updated_at:0}]};
      if(sql.includes("FROM public.organizations"))return {rows:[{org_id:"org",rollout_mode:"legacy"}]};
      return {rows:[],rowCount:0,command:sql==="COMMIT"?"ROLLBACK":sql};
    },release:(v:boolean)=>releases.push(v)};
    await expect(createPinnedOwnershipUnit({connect:async()=>client} as any).run(request("test"),async()=>1)).rejects.toMatchObject({status:503});
    expect(releases).toEqual([true]);
  });
});
