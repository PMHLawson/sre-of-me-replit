import {beforeAll,afterAll,it,expect} from "vitest";
import {Pool} from "pg";
import {randomUUID} from "node:crypto";
import {startFixture,verifyFixture} from "../lib/ownership-fixture";
import {createPinnedOwnershipUnit} from "../lib/pinned-ownership-unit";
import {createLegacyActivityMutations} from "./legacy-activity-mutations";
import {seedPolicyV2} from "../lib/seed-policy-v2";
import {importLegacyObservations} from "./legacy-observation-sync";
import {createOrgContextResolver} from "../lib/org-context";
import {createPolicyV2Storage} from "../storage/policy-v2-storage";
let f:Awaited<ReturnType<typeof startFixture>>,pool:Pool,service:ReturnType<typeof createLegacyActivityMutations>;
const request=(actor:string)=>({isAuthenticated:()=>true,user:{claims:{sub:actor}}});
const slugs=["martial-arts","meditation","fitness","music"];
const tables=["users","sessions","session_edits","user_settings","deviations","http_sessions","organizations","organization_members",
 "domains","policy_versions","dimension_definitions","source_bindings","observations","audit_events","deviations_v2","deviation_domains","evaluation_results"];
async function snapshot(){const state:Record<string,unknown>={};for(const t of tables)
 state[t]=(await f.client.query(`SELECT to_jsonb(t) r FROM public.${t} t ORDER BY to_jsonb(t)::text`)).rows;return JSON.stringify(state);}
async function raw(table:string,where:string,values:unknown[]=[]){return(await f.client.query(`SELECT to_jsonb(t) r FROM public.${table} t WHERE ${where} ORDER BY to_jsonb(t)::text`,values)).rows.map(x=>x.r);}
async function owner(actor:string){
 await f.client.query("INSERT INTO users(id) VALUES($1)",[actor]);
 await f.client.query("INSERT INTO user_settings(user_id,timezone,day_start_hour,window_days) VALUES($1,'America/New_York',6,14)",[actor]);
 for(const slug of slugs)await f.client.query(`INSERT INTO sessions(id,user_id,domain,duration_minutes,timestamp,notes,is_anomaly,anomaly_note)
  VALUES($1,$2,$3,1,'2020-01-01T00:00:00.123456Z',NULL,false,'historical inconsistent note')`,[`${actor}-${slug}`,actor,slug]);
 await f.client.query("INSERT INTO session_edits(id,session_id,user_id,edited_at,reason,changed_fields) VALUES($1,$2,$3,'2020-02-01T01:02:03.654321Z','historical reason',$4)",
  [`${actor}-old-edit`,`${actor}-music`,actor,'{"notes":null}']);
 await seedPolicyV2(f.db,request(actor));await importLegacyObservations(f.db,request(actor));
}
beforeAll(async()=>{
 f=await startFixture("legacy-mutations");await owner("mutation-a");await owner("mutation-b");
 await f.client.query("INSERT INTO sessions(id,domain,duration_minutes,timestamp) VALUES('unowned-mutation','music',1,now())");
 verifyFixture(f.root);pool=new Pool({host:f.root+"/socket",port:5432,user:"synthetic",database:"postgres",password:"",ssl:false,
  max:4,connectionTimeoutMillis:5000,options:"-c statement_timeout=10000 -c lock_timeout=5000"});
 service=createLegacyActivityMutations(createPinnedOwnershipUnit(pool));
},60000);
afterAll(async()=>{if(pool)await pool.end();if(f)await f.cleanup();},60000);
const payload={domain:"music",durationMinutes:1,timestamp:"2026-01-01T01:02:03.123456Z"};

it("rejects malformed authentication before a connection; payload identifiers never authorize another owner",async()=>{
 let connects=0;const s=createLegacyActivityMutations(createPinnedOwnershipUnit({connect:async()=>{connects++;throw Error("private");}}as any));
 for(const req of [{},request("__proto__"),{...request("mutation-a"),isAuthenticated:()=>false}])
  await expect(s.create(req,payload)).rejects.toMatchObject({status:401});expect(connects).toBe(0);
 const before=await snapshot();
 await expect(service.create(request("mutation-a"),{...payload,userId:"mutation-b"})).rejects.toMatchObject({status:400});
 expect(await snapshot()).toBe(before);
});
it("creates actual legacy/canonical/audit rows together; subfloor minutes remain recorded with exact time",async()=>{
 const other=await raw("sessions","user_id='mutation-b' OR user_id IS NULL");
 const req={...request("mutation-a"),body:{ownerUserId:"mutation-b",organizationId:"fake"},query:{userId:"mutation-b"}};
 const row=await service.create(req,{...payload,notes:"",isAnomaly:true,anomalyNote:"synthetic test"});
 expect(row.user_id).toBe("mutation-a");expect(row.timestamp).toContain(".123456");expect(row.duration_minutes).toBe(1);
 const observations=await raw("observations","legacy_source_id=$1",[row.id]);expect(observations).toHaveLength(1);
 expect(observations[0].observation.notes).toBe("");expect(Object.values(observations[0].observation.values)).toEqual([{valueType:"number",unitId:"minute",value:1}]);
 expect(observations[0].anomaly_note).toBe("synthetic test");expect(await service.verify(request("mutation-a"),row.id)).toEqual({clean:true,mutations:1});
 expect(await raw("sessions","user_id='mutation-b' OR user_id IS NULL")).toEqual(other);
});
it("edits imported history without rewriting provenance; domain/time/note/flags and prior delta stay exact",async()=>{
 const imports=await raw("audit_events","entity_type IN ('legacy_session_import','legacy_edit_import')");
 const oldEdits=await raw("session_edits","id LIKE '%-old-edit'");const key="mutation-a-music";
 const row=await service.edit(request("mutation-a"),key,{domain:"fitness",durationMinutes:4,timestamp:"2026-01-02T03:04:05.654321Z",notes:"new",reason:" synthetic change "});
 expect(row.domain).toBe("fitness");expect(row.timestamp).toContain(".654321");expect(row.anomaly_note).toBeNull();
 const edits=await raw("session_edits","session_id=$1 AND id NOT LIKE '%-old-edit'",[key]);expect(edits).toHaveLength(1);
 const prior=JSON.parse(edits[0].changed_fields);expect(prior).toMatchObject({domain:"music",durationMinutes:1,notes:null,anomalyNote:"historical inconsistent note"});
 expect(prior.timestamp).toContain(".123456");expect(edits[0].reason).toBe(" synthetic change ");
 expect(await raw("audit_events","entity_type IN ('legacy_session_import','legacy_edit_import')")).toEqual(imports);
 expect(await raw("session_edits","id LIKE '%-old-edit'")).toEqual(oldEdits);expect(await service.verify(request("mutation-a"),key)).toEqual({clean:true,mutations:1});
 await service.edit(request("mutation-a"),key,{reason:"No-op explanation"});
 const next=await raw("session_edits","session_id=$1 AND reason='No-op explanation'",[key]);expect(next).toHaveLength(1);expect(next[0].changed_fields).toBe("{}");
 expect(await service.verify(request("mutation-a"),key)).toEqual({clean:true,mutations:2});
});
it("soft-deletes and restores both rows together, preserving imported flags and exact original timestamps",async()=>{
 const key="mutation-a-meditation",original=(await raw("sessions","id=$1",[key]))[0],imports=await raw("audit_events","entity_type='legacy_session_import'");
 const deleted=await service.softDelete(request("mutation-a"),key);expect(deleted.deleted_at).not.toBeNull();
 expect((await raw("observations","legacy_source_id=$1",[key]))[0].deleted_at).toBe(deleted.deleted_at);
 await expect(service.softDelete(request("mutation-a"),key)).rejects.toMatchObject({status:404});
 await expect(service.edit(request("mutation-a"),key,{reason:"deleted edit"})).rejects.toMatchObject({status:404});
 const restored=await service.restore(request("mutation-a"),key);expect(restored).toEqual(original);
 expect((await raw("observations","legacy_source_id=$1",[key]))[0].deleted_at).toBeNull();
 await expect(service.restore(request("mutation-a"),key)).rejects.toMatchObject({status:404});
 expect(await service.verify(request("mutation-a"),key)).toEqual({clean:true,mutations:2});
 expect(await raw("audit_events","entity_type='legacy_session_import'")).toEqual(imports);
});
it("rejects cross-owner and unowned IDs without changing any application table",async()=>{
 const before=await snapshot();for(const key of ["mutation-b-music","unowned-mutation","missing"]){
  await expect(service.edit(request("mutation-a"),key,{notes:"not allowed",reason:"synthetic"})).rejects.toMatchObject({status:404});
  await expect(service.softDelete(request("mutation-a"),key)).rejects.toMatchObject({status:404});
  await expect(service.restore(request("mutation-a"),key)).rejects.toMatchObject({status:404});
 }expect(await snapshot()).toBe(before);
});
it("rolls back every actual table on a late audit INSERT failure for all four mutation paths",async()=>{
 const key="mutation-a-fitness";await service.softDelete(request("mutation-a"),key);
 await f.client.query(`CREATE FUNCTION public.fail_mutation_audit() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN IF NEW.entity_type='legacy_session_mutation' THEN RAISE EXCEPTION 'synthetic late audit'; END IF; RETURN NEW; END $$;
  CREATE TRIGGER fail_mutation_audit AFTER INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION public.fail_mutation_audit()`);
 try{
  const before=await snapshot();for(const op of [()=>service.create(request("mutation-a"),payload),
   ()=>service.edit(request("mutation-a"),"mutation-a-martial-arts",{durationMinutes:9,reason:"rollback edit"}),
   ()=>service.softDelete(request("mutation-a"),"mutation-a-martial-arts"),()=>service.restore(request("mutation-a"),key)]){
   await expect(op()).rejects.toMatchObject({status:503,message:"Service unavailable"});expect(await snapshot()).toBe(before);
  }
 }finally{await f.client.query("DROP TRIGGER fail_mutation_audit ON public.audit_events; DROP FUNCTION public.fail_mutation_audit()");}
 await service.restore(request("mutation-a"),key);
});
it("rejects early mapping errors after a legacy insert, invalid reasons and anomalies without leaving partial rows",async()=>{
 const before=await snapshot();for(const p of [{...payload,timestamp:"1900-01-01T00:00:00Z"},{...payload,isAnomaly:true,anomalyNote:" "},
  {...payload,durationMinutes:0},{...payload,organizationId:"fake"}])await expect(service.create(request("mutation-a"),p)).rejects.toMatchObject({status:400});
 await expect(service.edit(request("mutation-a"),"mutation-a-martial-arts",{reason:"   "})).rejects.toMatchObject({status:400});
 await expect(service.edit(request("mutation-a"),"mutation-a-martial-arts",{reason:" ".repeat(500)+"x"})).rejects.toMatchObject({status:400});
 expect(await snapshot()).toBe(before);
});
it("serializes concurrent changes to one owner without losing either field or sequence; other owners remain separate",async()=>{
 const key="mutation-a-martial-arts";
 await Promise.all([service.edit(request("mutation-a"),key,{durationMinutes:11,reason:"duration"}),
  service.edit(request("mutation-a"),key,{notes:"concurrent",reason:"notes"}),service.verify(request("mutation-b"),"mutation-b-martial-arts")]);
 expect((await raw("sessions","id=$1",[key]))[0]).toMatchObject({duration_minutes:11,notes:"concurrent"});
 expect(await service.verify(request("mutation-a"),key)).toEqual({clean:true,mutations:2});
});
it("detects current-row, canonical and audit drift rather than silently repairing historical evidence",async()=>{
 const key="mutation-b-fitness";
 const original=(await raw("sessions","id=$1",[key]))[0];
 for(const mode of ["legacy","canonical","audit"]){
  if(mode==="legacy")await f.client.query("UPDATE sessions SET notes='tampered' WHERE id=$1",[key]);
  if(mode==="canonical")await f.client.query("UPDATE observations SET anomaly_note='tampered' WHERE legacy_source_id=$1",[key]);
  if(mode==="audit")await f.client.query("UPDATE audit_events SET after=jsonb_set(after,'{sourceSnapshot,row,notes}','\"tampered\"'::jsonb) WHERE entity_type='legacy_session_import' AND entity_id=$1",[JSON.stringify([key])]);
  const before=await snapshot();await expect(service.edit(request("mutation-b"),key,{reason:"drift"})).rejects.toMatchObject({status:400});expect(await snapshot()).toBe(before);
  if(mode==="legacy")await f.client.query("UPDATE sessions SET notes=$2 WHERE id=$1",[key,original.notes]);
  if(mode==="canonical")await f.client.query("UPDATE observations SET anomaly_note=$2 WHERE legacy_source_id=$1",[key,original.anomaly_note]);
  if(mode==="audit")await f.client.query("UPDATE audit_events SET after=jsonb_set(after,'{sourceSnapshot,row,notes}','null'::jsonb) WHERE entity_type='legacy_session_import' AND entity_id=$1",[JSON.stringify([key])]);
 }expect(await service.verify(request("mutation-b"),key)).toEqual({clean:true,mutations:0});
});
it("uses the effective policy at the observation instant and supports later revisions without changing earlier records",async()=>{
 const policies=(await f.client.query("SELECT * FROM policy_versions WHERE owner_user_id='mutation-b' ORDER BY revision")).rows;
 const policy=policies.find(x=>x.configuration.displayName==="music");
 const next=structuredClone(policy.configuration);next.previousVersionId=next.policyVersionId;next.policyVersionId=randomUUID();next.revision=2;next.effectiveFrom="2030-01-01T00:00:00Z";
 const context=await createOrgContextResolver(f.db)(request("mutation-b"));
 await createPolicyV2Storage(f.db,context,{clock:()=>new Date("2026-01-01T00:00:00Z")}).policies.append(next,"synthetic future revision");
 const before=await service.create(request("mutation-b"),{...payload,timestamp:"2029-12-31T23:59:59.999999Z"});
 const after=await service.create(request("mutation-b"),{...payload,timestamp:"2030-01-01T00:00:00Z"});
 expect((await raw("observations","legacy_source_id=$1",[before.id]))[0].policy_version_id).toBe(policy.policy_version_id);
 expect((await raw("observations","legacy_source_id=$1",[after.id]))[0].policy_version_id).toBe(next.policyVersionId);
 expect(await service.verify(request("mutation-b"),"mutation-b-music")).toEqual({clean:true,mutations:0});
});
