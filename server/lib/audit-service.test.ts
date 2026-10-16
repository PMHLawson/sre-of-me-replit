import { beforeAll,afterAll,describe,it,expect } from "vitest";
import { startFixture } from "./ownership-fixture";
import { createOrgContextResolver,revalidate } from "./org-context";
import { createAuditService } from "./audit-service";
describe("generic append-only audit on owned PostgreSQL",()=>{
  let f:Awaited<ReturnType<typeof startFixture>>;
  beforeAll(async()=>{f=await startFixture("audit");await f.client.query(`
    INSERT INTO users(id) VALUES ('audit-user');
    INSERT INTO organizations(org_id,display_name) VALUES ('audit-org','Synthetic');
    INSERT INTO organization_members(org_id,user_id,role) VALUES ('audit-org','audit-user','member');`);},60000);
  afterAll(async()=>{if(f)await f.cleanup();},60000);
  it("derives actor/org/time, snapshots values, rejects fabricated context and has no edit/system path",async()=>{
    const c=await createOrgContextResolver(f.db)({isAuthenticated:()=>true,user:{claims:{sub:"audit-user"}}});
    const snapshot={value:"before"};
    await f.db.transaction(async tx=>{
      await revalidate(tx,f.db,c);
      expect(()=>createAuditService(tx,f.db,{...c})).toThrow();
      const service=createAuditService(tx,f.db,c);expect(Object.keys(service)).toEqual(["append"]);
      const result=service.append("example",["id","component"],"update","synthetic reason",snapshot,{value:"after"});
      snapshot.value="mutated";await result;
      for(const reason of ["","x".repeat(501)])await expect(service.append("example",["id"],"create",reason,null,{})).rejects.toMatchObject({status:400});
    });
    const events=(await f.client.query("SELECT * FROM audit_events")).rows;
    expect(events).toHaveLength(1);expect(events[0]).toMatchObject({org_id:"audit-org",actor_kind:"user",actor_user_id:"audit-user",
      entity_id:'["id","component"]',before:{value:"before"},after:{value:"after"}});
    expect(events[0].occurred_at).toBeInstanceOf(Date);
    await f.client.query("UPDATE organization_members SET role='owner' WHERE user_id='audit-user'");
    await expect(f.db.transaction(tx=>createAuditService(tx,f.db,c).append("example",["stale"],"create","reason",null,{})))
      .rejects.toMatchObject({status:403});
    expect((await f.client.query("SELECT count(*)::int AS count FROM audit_events")).rows[0].count).toBe(1);
  });
});