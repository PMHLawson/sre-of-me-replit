import { beforeAll,afterAll,describe,it,expect } from "vitest";
import { createOrgContextResolver,createOrgContextMiddleware,assertContext,revalidate,BoundaryError } from "./org-context";
import { startFixture,verifyFixture,connectFixture } from "./ownership-fixture";

describe("authenticated context on owned PostgreSQL",()=>{
  let f:Awaited<ReturnType<typeof startFixture>>;
  beforeAll(async()=>{f=await startFixture("context");await f.client.query(`
    INSERT INTO users(id) VALUES ('a'),('b'),('none'),('ambiguous');
    INSERT INTO organizations(org_id,display_name) VALUES ('one','One'),('two','Two');
    INSERT INTO organization_members(org_id,user_id,role) VALUES ('one','a','owner'),('two','b','member'),('one','ambiguous','member'),('two','ambiguous','member');`);},60000);
  afterAll(async()=>{if(f)await f.cleanup();},60000);
  const req=(sub:string)=>({isAuthenticated:()=>true,user:{claims:{sub}}});
  it("refuses non-owned/non-local fixture BEFORE connecting",async()=>{
    expect(()=>verifyFixture("/tmp")).toThrow();await expect(connectFixture("localhost")).rejects.toThrow();
  });
  it("ignores request-selected org/actor and mints immutable, database-bound capabilities",async()=>{
    const resolve=createOrgContextResolver(f.db);
    const c=await resolve({...req("a"),...{body:{orgId:"two",actor:"b"},query:{userId:"b"}}});
    expect(c).toEqual({orgId:"one",actorUserId:"a",role:"owner",rolloutMode:"legacy"});
    expect(Object.isFrozen(c)).toBe(true);
    expect(()=>assertContext(f.db,{...c})).toThrow(BoundaryError);
    expect(()=>assertContext({transaction:f.db.transaction},c)).toThrow(BoundaryError);
    await f.db.transaction(tx=>revalidate(tx,f.db,c));
  });
  it("rejects unauthenticated/malformed actors, missing, ambiguous and absent memberships",async()=>{
    const r=createOrgContextResolver(f.db);
    for(const request of [{}, {user:{claims:{sub:"a"}}},{...req("a"),isAuthenticated:()=>false},req(" "),req("__proto__")])
      await expect(r(request)).rejects.toMatchObject({status:401});
    for(const user of ["none","ambiguous","unknown"])await expect(r(req(user))).rejects.toMatchObject({status:403});
  });
  it("rejects changed, invalid and revoked memberships and invalid rollout",async()=>{
    const r=createOrgContextResolver(f.db),c=await r(req("a"));
    await f.client.query("UPDATE organization_members SET role='member' WHERE user_id='a'");
    await expect(f.db.transaction(tx=>revalidate(tx,f.db,c))).rejects.toMatchObject({status:403});
    await f.client.query("ALTER TABLE organization_members DROP CONSTRAINT members_role");
    await f.client.query("UPDATE organization_members SET role='invalid' WHERE user_id='a'");
    await expect(r(req("a"))).rejects.toMatchObject({status:403});
    await f.client.query("UPDATE organization_members SET role='owner' WHERE user_id='a'");
    await f.client.query("ALTER TABLE organizations DROP CONSTRAINT organizations_rollout");
    await f.client.query("UPDATE organizations SET rollout_mode='invalid' WHERE org_id='one'");
    await expect(r(req("a"))).rejects.toMatchObject({status:403});
    await f.client.query("UPDATE organizations SET rollout_mode='legacy' WHERE org_id='one'");
    const current=await r(req("a"));
    await f.client.query("DELETE FROM organization_members WHERE user_id='a'");
    await expect(f.db.transaction(tx=>revalidate(tx,f.db,current))).rejects.toMatchObject({status:403});
  });
  it("bounds database failures and middleware responds without exposing errors",async()=>{
    const bad={transaction:async()=>{throw Error("sensitive connection details");}};
    await expect(createOrgContextResolver(bad)(req("a"))).rejects.toMatchObject({status:503,message:"Service unavailable"});
    const middleware=createOrgContextMiddleware(f.db);
    const answer=await new Promise<any>(resolve=>{
      const res:any={locals:{},status:(status:number)=>({json:(body:unknown)=>resolve({status,body})})};
      middleware({} as any,res,()=>resolve("unexpected"));
    });
    expect(answer).toEqual({status:401,body:{message:"Authentication required"}});
    const success=await new Promise<any>(resolve=>{
      const res:any={locals:{},status:()=>({json:resolve})};
      middleware(req("b") as any,res,()=>resolve(res.locals.orgContext));
    });
    expect(success.actorUserId).toBe("b");
  });
});