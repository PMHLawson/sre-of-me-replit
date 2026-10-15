import { afterAll, beforeAll, expect, it, vi } from "vitest";
import express, { type Request, type Response, type NextFunction } from "express";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { startFixture, verifyFixture } from "./lib/ownership-fixture";
import { createAuthenticatedBootstrapUnit } from "./lib/authenticated-bootstrap-unit";
import { createLegacyDeviationMutations } from "./services/legacy-deviation-mutations";
import { createAuditService } from "./lib/audit-service";
import { withOwnerWriteBudget } from "./lib/write-resource-budget";

const auth = vi.hoisted(() => ({ actor: null as string | null }));
vi.mock("./db", () => { throw Error("FORBIDDEN: application database import"); });
vi.mock("./storage", () => ({ storage: {}, historyReads: {} }));
vi.mock("./replit_integrations/auth/storage", () => ({ authStorage: {} }));
vi.mock("./replit_integrations/auth", () => ({
  isAuthenticated: (req: Request, res: Response, next: NextFunction) => {
    if (!auth.actor) return res.status(401).json({ message: "Synthetic authentication required" });
    (req as any).user = { claims: { sub: auth.actor } };
    (req as any).isAuthenticated = () => true;
    next();
  },
}));
import { registerRoutes } from "./routes";

let f: Awaited<ReturnType<typeof startFixture>>, pool: Pool;
let service: ReturnType<typeof createLegacyDeviationMutations>;
const app = express(); app.use(express.json());
const listener = createServer(app);
let origin: string, serial = 0;
const request = (actor: string) => ({ isAuthenticated: () => true, user: { claims: { sub: actor } } });
const tables = ["users","sessions","session_edits","user_settings","deviations","http_sessions","organizations","organization_members",
  "domains","policy_versions","dimension_definitions","observations","evaluation_results","deviations_v2","deviation_domains","source_bindings","audit_events","owner_write_resource_budgets"];
const payload = { domain: "meditation", reason: "Synthetic recovery break", startAt: "2020-01-01T01:02:03.123456Z", endAt: null };
async function owner(provisioned = true) {
  const actor = "deviation-audit-" + (++serial), org = randomUUID();
  await f.client.query("INSERT INTO users(id) VALUES($1)",[actor]);
  await f.client.query("INSERT INTO user_settings(user_id,timezone,day_start_hour,window_days) VALUES($1,'America/New_York',6,14)",[actor]);
  if (provisioned) {
    await f.client.query("INSERT INTO organizations(org_id,display_name) VALUES($1,'Synthetic private workspace')",[org]);
    await f.client.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')",[org,actor]);
  }
  return { actor, org, req: request(actor) };
}
async function snapshot() {
  const result: Record<string, unknown> = {};
  for (const table of tables) result[table] = (await f.client.query("SELECT to_jsonb(t) r FROM public." + table + " t ORDER BY to_jsonb(t)::text")).rows;
  return JSON.stringify(result);
}
async function row(id: string) { return (await f.client.query("SELECT to_jsonb(d) r FROM deviations d WHERE id=$1",[id])).rows[0]?.r; }
async function events(actor: string) {
  return (await f.client.query("SELECT * FROM audit_events WHERE actor_user_id=$1 AND entity_type='legacy_deviation' ORDER BY occurred_at,audit_event_id",[actor])).rows;
}
async function used(actor: string) {
  const rows = (await f.client.query("SELECT minute_count n FROM owner_write_resource_budgets WHERE owner_user_id=$1",[actor])).rows;
  return rows.length ? rows[0].n : 0;
}
beforeAll(async () => {
  f = await startFixture("legacy-deviation-audit"); verifyFixture(f.root);
  pool = new Pool({ host: f.root+"/socket",port:5432,user:"synthetic",database:"postgres",password:"",ssl:false,
    max:4,connectionTimeoutMillis:5000,options:"-c statement_timeout=10000 -c lock_timeout=5000" });
  service = createLegacyDeviationMutations(createAuthenticatedBootstrapUnit(pool));
  await registerRoutes(listener,app,undefined,service);
  await new Promise<void>((resolve,reject) => {
    listener.once("error",reject); listener.listen(0,"127.0.0.1",() => { listener.removeListener("error",reject); resolve(); });
  });
  const address = listener.address();
  if (!address || typeof address === "string" || address.address !== "127.0.0.1") throw Error("Owned cloud loopback listener required");
  origin = "http://127.0.0.1:"+address.port;
},60000);
afterAll(async () => {
  auth.actor = null; listener.closeAllConnections();
  if (listener.listening) await new Promise<void>((resolve,reject) => listener.close(error => error ? reject(error) : resolve()));
  expect(listener.listening).toBe(false); expect(listener.address()).toBeNull();
  if (pool) await pool.end(); if (f) await f.cleanup();
},60000);

it("rejects malformed authentication without a connection or accepting payload authority",async () => {
  let connects = 0;
  const isolated = createLegacyDeviationMutations(createAuthenticatedBootstrapUnit({
    connect: async () => { connects++; throw Error("No connection permitted"); },
  } as any));
  for (const req of [{},request("__proto__"),{...request("synthetic"),isAuthenticated:()=>false}])
    await expect(isolated.create(req,payload)).rejects.toMatchObject({ status:401 });
  expect(connects).toBe(0);
  const a = await owner(), b = await owner();
  const created = await service.create(a.req,{...payload,userId:b.actor,actorUserId:b.actor,orgId:b.org});
  expect(created.userId).toBe(a.actor);
  expect((await events(a.actor))[0]).toMatchObject({org_id:a.org,actor_kind:"user",actor_user_id:a.actor});
  expect(await events(b.actor)).toHaveLength(0);
});

it("audits actual create/edit/end/delete with exact SQL snapshots and separate trimmed change explanations",async () => {
  const a = await owner();
  const created = await service.create(a.req,payload), original = await row(created.id);
  await service.edit(a.req,created.id,{endAt:"2020-02-01T03:04:05.654321Z",changeReason:"  Synthetic schedule correction  "});
  const edited = await row(created.id);
  await service.end(a.req,created.id,{changeReason:"Synthetic early ending"});
  const ended = await row(created.id);
  await service.softDelete(a.req,created.id,{changeReason:"Synthetic duplicate removal"});
  const deleted = await row(created.id), audit = await events(a.actor);
  expect(audit).toHaveLength(4);
  expect(audit.map(e=>e.action)).toEqual(["create","update","update","delete"]);
  expect(audit.map(e=>e.reason)).toEqual([payload.reason,"Synthetic schedule correction","Synthetic early ending","Synthetic duplicate removal"]);
  expect(audit.map(e=>e.before)).toEqual([null,original,edited,ended]);
  expect(audit.map(e=>e.after)).toEqual([original,edited,ended,deleted]);
  expect(audit.every(e=>e.actor_user_id===a.actor&&e.org_id===a.org&&e.entity_id===JSON.stringify([created.id]))).toBe(true);
  expect(original.start_at).toContain(".123456");
  expect(edited.end_at).toContain(".654321");
  expect(deleted.reason).toBe(payload.reason);
  expect(await used(a.actor)).toBe(4);
});

it("preserves availability for a valid legacy user through the same private bootstrap, with one total charge",async () => {
  const a = await owner(false);
  const settingsBefore = (await f.client.query("SELECT to_jsonb(s) r FROM user_settings s WHERE user_id=$1",[a.actor])).rows;
  const saved = await service.create(a.req,payload);
  const memberships = (await f.client.query("SELECT * FROM organization_members WHERE user_id=$1",[a.actor])).rows;
  expect(memberships).toHaveLength(1); expect(memberships[0].role).toBe("owner");
  expect((await events(a.actor))[0].org_id).toBe(memberships[0].org_id);
  expect((await f.client.query("SELECT to_jsonb(s) r FROM user_settings s WHERE user_id=$1",[a.actor])).rows).toEqual(settingsBefore);
  expect((await f.client.query("SELECT entity_type FROM audit_events WHERE actor_user_id=$1 ORDER BY entity_type",[a.actor])).rows)
    .toEqual([{entity_type:"legacy_deviation"},{entity_type:"organization_members"},{entity_type:"organizations"}]);
  expect(await used(a.actor)).toBe(1);
  await service.edit(a.req,saved.id,{excludeFromComposite:false,changeReason:"Synthetic correction"});
  expect((await f.client.query("SELECT * FROM organization_members WHERE user_id=$1",[a.actor])).rows).toEqual(memberships);
  expect(await used(a.actor)).toBe(2);
});

it("missing/foreign records and genuine no-ops cause no bootstrap, event or quota write",async () => {
  const a = await owner(false), b = await owner();
  const id = randomUUID(), foreign = await service.create(b.req,payload);
  await f.client.query("INSERT INTO deviations(id,user_id,domain,reason,start_at) VALUES($1,$2,'meditation',$3,$4)",[id,a.actor,payload.reason,payload.startAt]);
  const before = await snapshot();
  expect(await service.edit(a.req,id,{})).toMatchObject({id,userId:a.actor});
  expect(await service.edit(a.req,id,{reason:payload.reason})).toMatchObject({id});
  for (const key of ["missing-synthetic-deviation",foreign.id]) {
    expect(await service.edit(a.req,key,{excludeFromComposite:false,changeReason:"Synthetic rejected change"})).toBeUndefined();
    expect(await service.end(a.req,key,{changeReason:"Synthetic rejected end"})).toBeUndefined();
    expect(await service.softDelete(a.req,key,{changeReason:"Synthetic rejected delete"})).toBeUndefined();
  }
  expect(await snapshot()).toBe(before);
});

it("requires actual change reasons without overwriting the declaration reason",async () => {
  const a = await owner(), saved = await service.create(a.req,payload);
  const before = await snapshot();
  for (const changeReason of [undefined,null,""," \t\n ","\u00a0","\u2003","x".repeat(501)]) {
    await expect(service.edit(a.req,saved.id,{excludeFromComposite:false,changeReason})).rejects.toMatchObject({status:400});
    await expect(service.end(a.req,saved.id,{changeReason})).rejects.toMatchObject({status:400});
    await expect(service.softDelete(a.req,saved.id,{changeReason})).rejects.toMatchObject({status:400});
  }
  expect(await snapshot()).toBe(before);
  await service.edit(a.req,saved.id,{reason:"Changed business context",changeReason:"Why that context changed"});
  expect((await row(saved.id)).reason).toBe("Changed business context");
  expect((await events(a.actor)).at(-1).reason).toBe("Why that context changed");
});

it("serializes concurrent changes with consecutive immediate before/after images",async () => {
  const a = await owner(), saved = await service.create(a.req,payload);
  await Promise.all([
    service.edit(a.req,saved.id,{excludeFromComposite:false,changeReason:"Synthetic flag correction"}),
    service.edit(a.req,saved.id,{endAt:"2020-04-01T00:00:00Z",changeReason:"Synthetic date correction"}),
  ]);
  const audit = await events(a.actor);
  expect(audit).toHaveLength(3); expect(audit[1].before).toEqual(audit[0].after); expect(audit[2].before).toEqual(audit[1].after);
  expect(audit[2].after).toEqual(await row(saved.id)); expect(audit[2].after.exclude_from_composite).toBe(false);
  expect(audit[2].after.end_at).toBe("2020-04-01T00:00:00+00:00");
  expect(await used(a.actor)).toBe(3);
});

it.each(["create","edit","end","delete"] as const)("late audit failure rolls back the %s business change, staged event, quota and new workspace metadata",async action => {
  const a = await owner(action !== "create");
  const saved = action === "create" ? undefined : await service.create(a.req,payload);
  const before = await snapshot();
  await f.client.query("CREATE FUNCTION fail_legacy_deviation_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.entity_type='legacy_deviation' THEN RAISE EXCEPTION 'synthetic final audit refusal'; END IF; RETURN NEW; END $$");
  await f.client.query("CREATE TRIGGER fail_legacy_deviation_audit BEFORE UPDATE ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_legacy_deviation_audit()");
  try {
    const call = action === "create" ? service.create(a.req,payload) :
      action === "edit" ? service.edit(a.req,saved!.id,{excludeFromComposite:false,changeReason:"Synthetic rollback edit"}) :
      action === "end" ? service.end(a.req,saved!.id,{changeReason:"Synthetic rollback ending"}) :
      service.softDelete(a.req,saved!.id,{changeReason:"Synthetic rollback deletion"});
    await expect(call).rejects.toMatchObject({status:503});
  }
  finally { await f.client.query("DROP TRIGGER fail_legacy_deviation_audit ON audit_events"); await f.client.query("DROP FUNCTION fail_legacy_deviation_audit()"); }
  expect(await snapshot()).toBe(before);
});

it("a caught callback failure cannot commit a partial event or its business change",async () => {
  const a = await owner(), saved = await service.create(a.req,payload), before = await snapshot();
  const units = createAuthenticatedBootstrapUnit(pool);
  await expect(units.run(a.req,unit=>withOwnerWriteBudget(unit.tx,a.actor,async ({admitMutation})=>{
    const context = await unit.resolveContext(); await admitMutation();
    try {
      await createAuditService(unit.tx,unit.db,context).captureLegacyDeviation(saved.id,"update","Synthetic callback failure",async ()=>{
        await unit.tx.query("UPDATE deviations SET exclude_from_composite=false WHERE user_id=$1 AND id=$2",[a.actor,saved.id]);
        throw Error("Synthetic application failure after write");
      });
    } catch {}
    return "caught";
  }))).rejects.toMatchObject({status:503});
  expect(await snapshot()).toBe(before);
});

it("rate denial and ambiguous memberships leave every table unchanged",async () => {
  const a = await owner(), saved = await service.create(a.req,payload);
  await f.client.query("UPDATE owner_write_resource_budgets SET minute_started_at=date_trunc('minute',clock_timestamp()),minute_count=30 WHERE owner_user_id=$1",[a.actor]);
  let before = await snapshot();
  await expect(service.edit(a.req,saved.id,{excludeFromComposite:false,changeReason:"Synthetic capped change"}))
    .rejects.toMatchObject({status:429,code:"WRITE_RATE_LIMIT_EXCEEDED"});
  expect(await snapshot()).toBe(before);
  await f.client.query("UPDATE owner_write_resource_budgets SET minute_count=0 WHERE owner_user_id=$1",[a.actor]);
  const extra = randomUUID(); await f.client.query("INSERT INTO organizations(org_id,display_name) VALUES($1,'Other synthetic organization')",[extra]);
  await f.client.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')",[extra,a.actor]); before = await snapshot();
  await expect(service.softDelete(a.req,saved.id,{changeReason:"Synthetic ambiguous change"})).rejects.toMatchObject({status:403});
  expect(await snapshot()).toBe(before);
});

it("preserves oversized historical reasons inside SQL snapshots without transferring the old text through service results",async () => {
  const a = await owner(), id = randomUUID(), old = "Synthetic exact old text🙂".repeat(400000);
  await f.client.query("INSERT INTO deviations(id,user_id,domain,reason,start_at) VALUES($1,$2,'meditation',$3,$4)",[id,a.actor,old,payload.startAt]);
  let largest = 0;
  const tracked = { connect: async () => {
    const client = await pool.connect(), original = client.query.bind(client);
    (client as any).query = async (...args: any[]) => {
      const result = await (original as any)(...args); largest = Math.max(largest,JSON.stringify(result.rows).length); return result;
    };
    const release = client.release.bind(client);
    client.release = ((destroy?: boolean) => { (client as any).query = original; release(destroy); }) as typeof client.release;
    return client;
  }};
  const bounded = createLegacyDeviationMutations(createAuthenticatedBootstrapUnit(tracked));
  expect((await bounded.edit(a.req,id,{reason:old}))?.id).toBe(id); expect(await used(a.actor)).toBe(0);
  await bounded.edit(a.req,id,{reason:"Shortened synthetic history",changeReason:"Synthetic deliberate shortening"});
  expect(largest).toBeLessThan(4096);
  const proof = (await f.client.query("SELECT \"before\"->>'reason'=$2 AS exact_before,\"after\"->>'reason'=$3 AS exact_after FROM audit_events WHERE actor_user_id=$1 AND entity_type='legacy_deviation'",
    [a.actor,old,"Shortened synthetic history"])).rows;
  expect(proof).toEqual([{exact_before:true,exact_after:true}]);
  expect(await used(a.actor)).toBe(1);
},30000);

it("actual HTTP routes enforce explanations and use the authenticated actor, not client identifiers",async () => {
  const a = await owner(), b = await owner(); auth.actor = a.actor;
  const call = (path:string,method:string,body:unknown) => fetch(origin+path,{method,headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  let response = await call("/api/deviations","POST",{...payload,userId:b.actor,actorUserId:b.actor});
  expect(response.status).toBe(201); const saved = await response.json();
  const before = await snapshot();
  response = await call("/api/deviations/"+saved.id,"PATCH",{excludeFromComposite:false}); expect(response.status).toBe(400);
  response = await call("/api/deviations/"+saved.id+"/end","POST",{}); expect(response.status).toBe(400);
  response = await call("/api/deviations/"+saved.id,"DELETE",{changeReason:"  "}); expect(response.status).toBe(400);
  expect(await snapshot()).toBe(before);
  response = await call("/api/deviations/"+saved.id,"PATCH",{excludeFromComposite:false,changeReason:"Synthetic HTTP correction"});
  expect(response.status).toBe(200);
  response = await call("/api/deviations/"+saved.id+"/end","POST",{changeReason:"Synthetic HTTP end"}); expect(response.status).toBe(200);
  response = await call("/api/deviations/"+saved.id,"DELETE",{changeReason:"Synthetic HTTP delete"}); expect(response.status).toBe(200);
  expect((await events(a.actor)).map(e=>e.reason)).toEqual([payload.reason,"Synthetic HTTP correction","Synthetic HTTP end","Synthetic HTTP delete"]);
  expect(await events(b.actor)).toHaveLength(0);
  auth.actor = null;
  response = await call("/api/deviations","POST",payload); expect(response.status).toBe(401);
});
