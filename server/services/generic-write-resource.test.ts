import { beforeAll,afterAll,it,expect } from "vitest";
import { Pool } from "pg";
import { startFixture,verifyFixture } from "../lib/ownership-fixture";
import { createPinnedOwnershipUnit } from "../lib/pinned-ownership-unit";
import { createAuthenticatedBootstrapUnit } from "../lib/authenticated-bootstrap-unit";
import { createOrgContextResolver } from "../lib/org-context";
import { createPolicyV2Storage } from "../storage/policy-v2-storage";
import { createActivityServiceV2 } from "./activity-service-v2";
import { createDomainServiceV2 } from "./domain-service-v2";
import { createPersonalWorkspaceService } from "./personal-workspace-service";
import { configurationFor,MEASUREMENTS } from "../../shared/fixtures/domain-config-cases";
import type { ActivityView } from "../../shared/activity";

const request=(actor:string)=>({isAuthenticated:()=>true,user:{claims:{sub:actor}}});
const policyClock=()=>new Date("2026-01-01T00:00:00.000Z");
const practiceClock=()=>new Date("2026-03-01T00:00:00.000Z");
let fixture:Awaited<ReturnType<typeof startFixture>>,pool:Pool;
let activities:ReturnType<typeof createActivityServiceV2>,domains:ReturnType<typeof createDomainServiceV2>;
const payload=(slug:string)=>{
  const {organizationId,ownerUserId,domainId,policyVersionId,revision,previousVersionId,...configuration}=configurationFor(slug,MEASUREMENTS[2],12);
  return {slug,configuration,reason:"Synthetic write-resource integration"};
};
async function owner(name:string,organization="write-resource-shared"){
  await fixture.client.query("INSERT INTO users(id) VALUES ($1)",[name]);
  await fixture.client.query("INSERT INTO organization_members(org_id,user_id,role) VALUES ($1,$2,'owner')",[organization,name]);
  const domain=await domains.create(request(name),payload(name));
  // Test-only reset: seeding is not the mutation under inspection. Production
  // limits remain exactly30/min and500/day in the actual shared helper.
  await fixture.client.query("DELETE FROM owner_write_resource_budgets WHERE owner_user_id=$1",[name]);
  return {name,domain,configuration:domain.policyVersions[0].configuration};
}
function entry(o:Awaited<ReturnType<typeof owner>>,key:string){
  const m=o.configuration.measurements.find(m=>m.kind!=="frequency")!;
  return {submissionKey:key,domainId:o.domain.domainId,policyVersionId:o.configuration.policyVersionId,practiceEvent:true as const,
    observedAt:"2026-01-10T12:00:00.000Z",values:{[m.measurementId]:{valueType:"integer" as const,value:12,unitId:m.unit.unitId}}};
}
function correction(a:ActivityView,key:string){
  return {mutationKey:key,expectedStateFingerprint:a.stateFingerprint,reason:"Synthetic correction",policyVersionId:a.policyVersionId,
    practiceEvent:true as const,observedAt:a.observedAt,values:Object.fromEntries(Object.entries(a.values).map(([id,v])=>[id,{...v,value:15}]))};
}
const lifecycle=(a:ActivityView,key:string)=>({mutationKey:key,expectedStateFingerprint:a.stateFingerprint,reason:"Synthetic lifecycle"});
async function counters(actor:string){
  const rows=(await fixture.client.query("SELECT minute_count,day_count FROM owner_write_resource_budgets WHERE owner_user_id=$1",[actor])).rows;
  return rows.length?{minute:rows[0].minute_count,day:rows[0].day_count}:null;
}
async function limits(actor:string,minute:number,day:number){
  // Avoid a real UTC minute rollover between administrative seeding and the
  // two-client boundary probe, while retaining the helper's trusted DB clock.
  const second=Number((await fixture.client.query("SELECT extract(second FROM clock_timestamp()) AS second")).rows[0].second);
  if(second>=55)await new Promise(resolve=>setTimeout(resolve,(60-second)*1000+25));
  await fixture.client.query("INSERT INTO owner_write_resource_budgets(owner_user_id,minute_started_at,minute_count,day_date,day_count) "+
    "VALUES ($1,date_trunc('minute',clock_timestamp()),$2,(clock_timestamp() AT TIME ZONE 'UTC')::date,$3) "+
    "ON CONFLICT(owner_user_id) DO UPDATE SET minute_started_at=EXCLUDED.minute_started_at,minute_count=EXCLUDED.minute_count,day_date=EXCLUDED.day_date,day_count=EXCLUDED.day_count",
    [actor,minute,day]);
}
async function ownedState(actor:string){
  const state:Record<string,unknown>={};
  for(const table of ["domains","policy_versions","dimension_definitions","observations","source_bindings","deviations_v2","deviation_domains","evaluation_results"])
    state[table]=(await fixture.client.query("SELECT to_jsonb(t) row FROM public."+table+" t WHERE owner_user_id=$1 ORDER BY to_jsonb(t)::text",[actor])).rows;
  state.audit=(await fixture.client.query("SELECT to_jsonb(a) row FROM audit_events a WHERE actor_user_id=$1 ORDER BY to_jsonb(a)::text",[actor])).rows;
  return JSON.stringify(state);
}
beforeAll(async()=>{
  fixture=await startFixture("generic-write-resource");verifyFixture(fixture.root);
  await fixture.client.query("INSERT INTO organizations(org_id,display_name) VALUES ('write-resource-shared','Shared'),('write-resource-other','Other')");
  pool=new Pool({host:fixture.root+"/socket",port:5432,user:"synthetic",database:"postgres",password:"",ssl:false,max:6,
    connectionTimeoutMillis:5000,options:"-c statement_timeout=10000 -c lock_timeout=5000"});
  activities=createActivityServiceV2(createPinnedOwnershipUnit(pool),{clock:practiceClock});
  domains=createDomainServiceV2(createPinnedOwnershipUnit(pool),{clock:policyClock});
},60000);
afterAll(async()=>{if(pool)await pool.end();if(fixture)await fixture.cleanup();},60000);

it("one domain+first-policy+dimensions+audits costs one admission, and append+rename costs one more",async()=>{
  const actor="quota-domain";
  await fixture.client.query("INSERT INTO users(id) VALUES ($1)",[actor]);
  await fixture.client.query("INSERT INTO organization_members(org_id,user_id,role) VALUES ('write-resource-shared',$1,'owner')",[actor]);
  const created=await domains.create(request(actor),payload("quota-domain"));
  expect(await counters(actor)).toEqual({minute:1,day:1});
  const configuration={...payload("unused").configuration,displayName:"Renamed cooking",effectiveFrom:"2026-01-02T00:00:00.000Z"};
  const updated=await domains.configure(request(actor),created.domainId,{expectedPolicyVersionId:created.currentPolicyVersionId,configuration,reason:"Rename with revision"});
  expect(updated.displayName).toBe("Renamed cooking");expect(updated.policyVersions).toHaveLength(2);
  expect(await counters(actor)).toEqual({minute:2,day:2});
  await domains.read(request(actor),created.domainId);await domains.list(request(actor));
  const context=await createOrgContextResolver(fixture.db)(request(actor));
  await createPolicyV2Storage(fixture.db,context,{clock:policyClock}).domains.update([created.domainId],{displayName:"Renamed cooking"},"Unchanged name");
  expect(await counters(actor)).toEqual({minute:2,day:2});
},15000);

it("personal create/edit/delete/restore retries reconcile without extra charges or duplicate audits, even at the cap",async()=>{
  const o=await owner("quota-retries"),p=entry(o,"stable");
  const first=await activities.create(request(o.name),p);
  expect(await counters(o.name)).toEqual({minute:1,day:1});
  expect((await activities.create(request(o.name),p)).created).toBe(false);
  const noOp={...correction(first.activity,"unused-noop"),values:first.activity.values};
  await expect(activities.edit(request(o.name),first.activity.activityId,noOp)).rejects.toMatchObject({status:400});
  expect(await counters(o.name)).toEqual({minute:1,day:1});
  const edit=correction(first.activity,"edit"),edited=await activities.edit(request(o.name),first.activity.activityId,edit);
  expect((await activities.edit(request(o.name),first.activity.activityId,edit)).changed).toBe(false);
  const remove=lifecycle(edited.activity,"delete"),deleted=await activities.delete(request(o.name),first.activity.activityId,remove);
  expect((await activities.delete(request(o.name),first.activity.activityId,remove)).changed).toBe(false);
  const restore=lifecycle(deleted.activity,"restore"),restored=await activities.restore(request(o.name),first.activity.activityId,restore);
  expect((await activities.restore(request(o.name),first.activity.activityId,restore)).changed).toBe(false);
  expect(await counters(o.name)).toEqual({minute:4,day:4});
  await limits(o.name,30,500);
  expect((await activities.create(request(o.name),p)).created).toBe(false);
  expect((await activities.restore(request(o.name),first.activity.activityId,restore)).activity.stateFingerprint).toBe(restored.activity.stateFingerprint);
  expect(await counters(o.name)).toEqual({minute:30,day:500});
  expect(Number((await fixture.client.query("SELECT count(*) n FROM audit_events WHERE actor_user_id=$1 AND entity_type='observations'",[o.name])).rows[0].n)).toBe(4);
},15000);

it("two real pinned clients competing for the last minute slot admit exactly one and isolate other owners",async()=>{
  const a=await owner("quota-race-a"),b=await owner("quota-race-b"),c=await owner("quota-race-c","write-resource-other");
  await limits(a.name,29,29);
  const attempts=await Promise.allSettled([activities.create(request(a.name),entry(a,"one")),activities.create(request(a.name),entry(a,"two"))]);
  expect(attempts.filter(r=>r.status==="fulfilled")).toHaveLength(1);
  const rejected=attempts.find(r=>r.status==="rejected") as PromiseRejectedResult;
  expect(rejected.reason).toMatchObject({status:429,code:"WRITE_RATE_LIMIT_EXCEEDED"});
  expect(await counters(a.name)).toEqual({minute:30,day:30});
  expect((await fixture.client.query("SELECT observation_id FROM observations WHERE owner_user_id=$1",[a.name])).rows).toHaveLength(1);
  expect(Number((await fixture.client.query("SELECT count(*) n FROM audit_events WHERE actor_user_id=$1 AND entity_type='observations'",[a.name])).rows[0].n)).toBe(1);
  expect((await activities.create(request(b.name),entry(b,"one"))).created).toBe(true);
  expect((await activities.create(request(c.name),entry(c,"one"))).created).toBe(true);
  expect(await counters(b.name)).toEqual({minute:1,day:1});expect(await counters(c.name)).toEqual({minute:1,day:1});
},15000);

it("the500th daily mutation wins once, the501st changes neither owned rows nor audits, and foreign references never charge",async()=>{
  const o=await owner("quota-daily"),foreign=await owner("quota-daily-other");
  await limits(o.name,0,499);
  const saved=await activities.create(request(o.name),entry(o,"last-day"));
  const before=await ownedState(o.name);
  await expect(activities.create(request(o.name),entry(o,"too-many"))).rejects.toMatchObject({status:429,code:"WRITE_RATE_LIMIT_EXCEEDED"});
  expect(await ownedState(o.name)).toBe(before);expect(await counters(o.name)).toEqual({minute:1,day:500});
  expect((await activities.create(request(o.name),entry(o,"last-day"))).activity.activityId).toBe(saved.activity.activityId);
  await expect(activities.create(request(foreign.name),entry(o,"foreign"))).rejects.toMatchObject({status:404});
  expect(await counters(foreign.name)).toBeNull();
},15000);

it("an audit failure after admission rolls back the counter and source row, then an explicit retry succeeds once",async()=>{
  const o=await owner("quota-rollback"),p=entry(o,"rollback");
  const before=await ownedState(o.name);
  await fixture.client.query("CREATE FUNCTION quota_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.actor_user_id='quota-rollback' THEN RAISE EXCEPTION 'synthetic audit refusal'; END IF; RETURN NEW; END $$");
  await fixture.client.query("CREATE TRIGGER quota_reject_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION quota_reject_audit()");
  try {await expect(activities.create(request(o.name),p)).rejects.toMatchObject({status:503});}
  finally {await fixture.client.query("DROP TRIGGER quota_reject_audit ON audit_events");await fixture.client.query("DROP FUNCTION quota_reject_audit()");}
  expect(await ownedState(o.name)).toBe(before);expect(await counters(o.name)).toBeNull();
  expect((await activities.create(request(o.name),p)).created).toBe(true);
  expect(await counters(o.name)).toEqual({minute:1,day:1});
},15000);

it("first workspace setup costs one; repeated setup and unchanged day settings remain usable at the cap",async()=>{
  const actor="quota-onboard";await fixture.client.query("INSERT INTO users(id) VALUES ($1)",[actor]);
  const service=createPersonalWorkspaceService(createAuthenticatedBootstrapUnit(pool));
  const created=await service.ensure(request(actor),{});
  expect(await counters(actor)).toEqual({minute:1,day:1});
  expect(await service.ensure(request(actor),{})).toEqual(created);
  await service.updateSettings(request(actor),{dayStartHour:15});
  expect(await counters(actor)).toEqual({minute:2,day:2});
  await limits(actor,30,500);
  expect((await service.updateSettings(request(actor),{dayStartHour:15})).dayStartHour).toBe(15);
  expect((await service.ensure(request(actor),{})).workspace.organizationId).toBe(created.workspace.organizationId);
  await expect(service.updateSettings(request(actor),{dayStartHour:16})).rejects.toMatchObject({status:429,code:"WRITE_RATE_LIMIT_EXCEEDED"});
  expect((await service.readSettings(request(actor))).dayStartHour).toBe(15);
  expect(await counters(actor)).toEqual({minute:30,day:500});
},15000);

it("new oversized raw notes/context and policy envelopes fail before any write or quota charge",async()=>{
  const o=await owner("quota-envelope"),before=await ownedState(o.name);
  const context=await createOrgContextResolver(fixture.db)(request(o.name));
  const store=createPolicyV2Storage(fixture.db,context,{clock:policyClock});
  const raw={schemaVersion:1 as const,observationId:"oversized",organizationId:context.orgId,ownerUserId:o.name,domainId:o.domain.domainId,
    policyVersionId:o.configuration.policyVersionId,observedAt:"2026-01-10T00:00:00.000Z",values:entry(o,"unused").values};
  await expect(store.observations.create({observation:{...raw,notes:"n".repeat(4001)},idempotencyKey:"oversized"},"Too large")).rejects.toMatchObject({status:400});
  await expect(store.observations.create({observation:{...raw,context:{description:"c".repeat(2001)}},idempotencyKey:"context"},"Too large")).rejects.toMatchObject({status:400});
  const big=payload("quota-large-policy");
  big.configuration.goal={...big.configuration.goal,desiredCapability:"x".repeat(102401)};
  await expect(domains.create(request(o.name),big)).rejects.toMatchObject({status:400});
  expect(await ownedState(o.name)).toBe(before);expect(await counters(o.name)).toBeNull();
},15000);
