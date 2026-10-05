import {beforeAll,afterAll,it,expect} from "vitest";
import {Pool} from "pg";
import {randomUUID} from "node:crypto";
import {startFixture,verifyFixture} from "../lib/ownership-fixture";
import {createPinnedOwnershipUnit} from "../lib/pinned-ownership-unit";
import {createLegacyActivityMutations} from "./legacy-activity-mutations";
import {seedPolicyV2} from "../lib/seed-policy-v2";
import {importLegacyObservations,reconcileLegacyObservations} from "./legacy-observation-sync";

let f:Awaited<ReturnType<typeof startFixture>>,pool:Pool,service:ReturnType<typeof createLegacyActivityMutations>;
const request=(actor:string)=>({isAuthenticated:()=>true,user:{claims:{sub:actor}}});
const slugs=["martial-arts","meditation","fitness","music"];
const tables=["users","sessions","session_edits","user_settings","deviations","http_sessions","organizations","organization_members",
 "domains","policy_versions","dimension_definitions","source_bindings","observations","audit_events","deviations_v2","deviation_domains","evaluation_results"];
const payload={domain:"music",durationMinutes:1,timestamp:"2026-01-01T01:02:03.123456Z"};
async function snapshot(){const state:Record<string,unknown>={};for(const t of tables)
 state[t]=(await f.client.query(`SELECT to_jsonb(t) r FROM public.${t} t ORDER BY to_jsonb(t)::text`)).rows;return JSON.stringify(state);}
async function raw(table:string,where:string,values:unknown[]=[]){return(await f.client.query(`SELECT to_jsonb(t) r FROM public.${table} t WHERE ${where} ORDER BY to_jsonb(t)::text`,values)).rows.map(x=>x.r);}
async function owner(actor:string,empty=false){
 await f.client.query("INSERT INTO users(id) VALUES($1)",[actor]);
 await f.client.query("INSERT INTO user_settings(user_id,timezone,day_start_hour,window_days) VALUES($1,'America/New_York',6,14)",[actor]);
 // The preservation seed requires pre-existing owned history. Remove only this
 // invented fixture history after seeding, before testing an empty import.
 {
  for(const slug of slugs)await f.client.query(`INSERT INTO sessions(id,user_id,domain,duration_minutes,timestamp,notes,is_anomaly,anomaly_note)
   VALUES($1,$2,$3,1,'2020-01-01T00:00:00.123456Z',NULL,false,'retained anomaly note')`,[`${actor}-${slug}`,actor,slug]);
  await f.client.query("INSERT INTO session_edits(id,session_id,user_id,edited_at,reason,changed_fields) VALUES($1,$2,$3,'2020-02-01T01:02:03.654321Z',$4,'not historical full state')",
   [`${actor}-old-edit`,`${actor}-music`,actor," retained original explanation "]);
 }
 await seedPolicyV2(f.db,request(actor));
 if(empty){
  await f.client.query("DELETE FROM session_edits WHERE user_id=$1",[actor]);
  await f.client.query("DELETE FROM sessions WHERE user_id=$1",[actor]);
 }
 await importLegacyObservations(f.db,request(actor));return actor;
}
async function refused(actor:string,status=400){const before=await snapshot();await expect(service.reconcile(request(actor))).rejects.toMatchObject({status});expect(await snapshot()).toBe(before);}
beforeAll(async()=>{
 f=await startFixture("legacy-collection-reconciliation");verifyFixture(f.root);
 pool=new Pool({host:f.root+"/socket",port:5432,user:"synthetic",database:"postgres",password:"",ssl:false,
  max:4,connectionTimeoutMillis:5000,options:"-c statement_timeout=10000 -c lock_timeout=5000"});
 service=createLegacyActivityMutations(createPinnedOwnershipUnit(pool));
},60000);
afterAll(async()=>{try{if(pool)await pool.end();}finally{if(f)await f.cleanup();}},60000);

it("rejects malformed authentication and all request-supplied scope before any connection",async()=>{
 let connects=0;const s=createLegacyActivityMutations(createPinnedOwnershipUnit({connect:async()=>{connects++;throw Error("private");}}as any));
 for(const req of [{},request("__proto__"),{...request("x"),isAuthenticated:()=>false},{headers:{"x-user-id":"x"}}])
  await expect(Promise.resolve().then(()=>s.reconcile(req))).rejects.toMatchObject({status:401});
 for(const field of ["body","query","params"])for(const value of [{ownerUserId:"other"},[],{enabled:true}])
  await expect(Promise.resolve().then(()=>s.reconcile({...request("x"),[field]:value}))).rejects.toMatchObject({status:400});
 expect(connects).toBe(0);
});
it("verifies unchanged import twice without altering any table or disclosing row contents",async()=>{
 const actor=await owner("recon-pristine"),before=await snapshot();
 const result=await service.reconcile(request(actor));expect(result.counts).toEqual({ownedSessions:4,canonicalSessions:4,legacyEdits:1,importedSessions:4,importedEdits:1,mutationEvents:0,unownedSessions:0});
 expect(result.domains).toHaveLength(4);expect(result.clean).toBe(true);expect(await service.reconcile(request(actor))).toEqual(result);
 expect(JSON.stringify(result)).not.toContain(actor);expect(JSON.stringify(result)).not.toContain("retained original explanation");expect(await snapshot()).toBe(before);
});
it("accepts create/edit/no-op/delete/restore lineage while retaining immutable import evidence",async()=>{
 const actor=await owner("recon-legitimate"),req=request(actor),imports=await raw("audit_events","actor_user_id=$1 AND entity_type IN ('legacy_session_import','legacy_edit_import')",[actor]);
 await service.create(req,{...payload,notes:""});
 await service.edit(req,actor+"-music",{domain:"fitness",durationMinutes:7,timestamp:"2026-02-01T03:04:05.654321Z",notes:"new",reason:" exact edit "});
 await service.edit(req,actor+"-music",{reason:"No-op"});await service.softDelete(req,actor+"-meditation");await service.restore(req,actor+"-meditation");
 expect((await reconcileLegacyObservations(f.db,req)).clean).toBe(false);
 const before=await snapshot(),result=await service.reconcile(req);expect(result.counts).toMatchObject({ownedSessions:5,canonicalSessions:5,legacyEdits:3,importedSessions:4,importedEdits:1,mutationEvents:5});
 expect(result.domains.every(d=>JSON.stringify(d.legacy)===JSON.stringify(d.canonical))).toBe(true);
 expect(await raw("audit_events","actor_user_id=$1 AND entity_type IN ('legacy_session_import','legacy_edit_import')",[actor])).toEqual(imports);expect(await snapshot()).toBe(before);
});
it("supports a clean empty imported set and later mutation-created records",async()=>{
 const actor=await owner("recon-empty",true),req=request(actor);expect((await service.reconcile(req)).counts).toMatchObject({ownedSessions:0,legacyEdits:0,importedSessions:0,mutationEvents:0});
 await service.create(req,payload);const before=await snapshot();expect((await service.reconcile(req)).counts).toMatchObject({ownedSessions:1,canonicalSessions:1,importedSessions:0,mutationEvents:1});expect(await snapshot()).toBe(before);
});
it("keeps other owners and unassigned history outside the reconciliation scope",async()=>{
 const actor=await owner("recon-scope-a"),other=await owner("recon-scope-b");
 await f.client.query("UPDATE sessions SET notes='other owner drift' WHERE id=$1",[other+"-music"]);
 await f.client.query("INSERT INTO sessions(id,domain,duration_minutes,timestamp,notes) VALUES('recon-unassigned','music',1,now(),'unassigned record')");
 const before=await snapshot(),scopedRequest={...request(actor),headers:{"x-owner-id":other}};expect((await service.reconcile(scopedRequest)).counts).toMatchObject({ownedSessions:4,unownedSessions:1});expect(await snapshot()).toBe(before);
 await refused(other);
});
it("rejects coordinated legacy/canonical drift even when current values match one another",async()=>{
 const actor=await owner("recon-coordinated"),id=actor+"-music";
 await f.client.query("UPDATE sessions SET notes='rewritten' WHERE id=$1",[id]);
 await f.client.query("UPDATE observations SET observation=jsonb_set(observation,'{notes}','\"rewritten\"'::jsonb) WHERE legacy_source_id=$1",[id]);await refused(actor);
});
it("rejects a missing canonical row without recreating it",async()=>{
 const actor=await owner("recon-missing");await f.client.query("DELETE FROM observations WHERE legacy_source_id=$1",[actor+"-music"]);await refused(actor);
});
it("rejects extra canonical rows even when all expected records still match",async()=>{
 const actor=await owner("recon-extra");
 await f.client.query(`INSERT INTO observations(observation_id,org_id,owner_user_id,domain_id,policy_version_id,idempotency_key,observed_at,observation,is_anomaly,anomaly_note,deleted_at,legacy_source_type,legacy_source_id)
  SELECT $1,org_id,owner_user_id,domain_id,policy_version_id,$2,observed_at,jsonb_set(observation,'{observationId}',to_jsonb($1::text)),is_anomaly,anomaly_note,deleted_at,legacy_source_type,$3 FROM observations WHERE legacy_source_id=$4`,
  [randomUUID(),"extra-reconciliation-key","extra-source",actor+"-music"]);await refused(actor);
});
it("rejects removal of both current formats while original import evidence remains",async()=>{
 const actor=await owner("recon-removed"),id=actor+"-fitness";
 await f.client.query("DELETE FROM observations WHERE legacy_source_id=$1",[id]);await f.client.query("DELETE FROM sessions WHERE id=$1",[id]);await refused(actor);
});
it("rejects changed historical edit rows rather than rewriting imported provenance",async()=>{
 const actor=await owner("recon-old-edit");await f.client.query("UPDATE session_edits SET changed_fields='{}' WHERE id=$1",[actor+"-old-edit"]);await refused(actor);
});
it("rejects altered import envelopes, event identities and historical-after claims",async()=>{
 for(const [n,field]of ["importBatchId","sourceType","sourceSnapshot"].entries()){
  const actor=await owner("recon-envelope-"+n);
  await f.client.query("UPDATE audit_events SET after=jsonb_set(after,ARRAY[$1],$2::jsonb) WHERE entity_type='legacy_session_import' AND entity_id=$3",[field,JSON.stringify(field==="sourceSnapshot"?{kind:"invented historical-after"}:"tampered"),JSON.stringify([actor+"-music"])]);await refused(actor);
 }
});
it("rejects orphan legacy edits and edits owned by a different account",async()=>{
 for(const foreign of [false,true]){
  const actor=await owner("recon-orphan-"+foreign);
  await f.client.query("INSERT INTO session_edits(id,session_id,user_id,reason,changed_fields) VALUES($1,$2,$3,'orphan','{}')",[randomUUID(),actor+"-music",foreign?"recon-scope-b":actor]);await refused(actor);
 }
});
it("rejects mutation sequence gaps and mismatched source identity",async()=>{
 for(const [n,field]of ["sequence","state"].entries()){
  const actor=await owner("recon-sequence-"+n);await service.edit(request(actor),actor+"-music",{notes:"legitimate",reason:"edit"});
  await f.client.query("UPDATE audit_events SET after=jsonb_set(after,ARRAY[$1],$2::jsonb) WHERE actor_user_id=$3 AND entity_type='legacy_session_mutation'",[field,JSON.stringify(field==="sequence"?2:{legacy:{id:"missing"}}),actor]);await refused(actor);
 }
});
it("rejects coordinated changes to both a mutation's prior delta and its legacy edit row",async()=>{
 const actor=await owner("recon-prior-delta");await service.edit(request(actor),actor+"-music",{notes:"legitimate",reason:"edit"});
 const audit=(await raw("audit_events","actor_user_id=$1 AND entity_type='legacy_session_mutation'",[actor]))[0],editId=audit.after.legacyEdit.id;
 await f.client.query("UPDATE session_edits SET changed_fields='{}' WHERE id=$1",[editId]);
 await f.client.query("UPDATE audit_events SET after=jsonb_set(after,'{legacyEdit,changed_fields}','\"{}\"'::jsonb) WHERE audit_event_id=$1",[audit.audit_event_id]);await refused(actor);
});
it("rejects configuration-definition drift before declaring a collection clean",async()=>{
 const actor=await owner("recon-definition");await f.client.query("UPDATE dimension_definitions SET definition=jsonb_set(definition,'{meaning}','\"forged meaning\"'::jsonb) WHERE owner_user_id=$1",[actor]);await refused(actor);
});
it("refuses unmigrated or changed membership without seeding or importing",async()=>{
 await f.client.query("INSERT INTO users(id) VALUES('recon-unmigrated')");await refused("recon-unmigrated",403);
 const actor=await owner("recon-member");await f.client.query("UPDATE organization_members SET role='member' WHERE user_id=$1",[actor]);await refused(actor,403);
});
it("uses one transaction and stable collection locks, with no DML or nested connection",async()=>{
 const actor=await owner("recon-transaction"),before=await snapshot(),queries:string[]=[];let connects=0,releases=0;
 const scoped=createLegacyActivityMutations(createPinnedOwnershipUnit({connect:async()=>{
  connects++;const client=await pool.connect();return {query:(sql:string,values?:unknown[])=>{queries.push(sql);return client.query(sql,values);},
   release:(destroy?:boolean)=>{releases++;client.release(destroy);}} as any;
 }}));
 expect((await scoped.reconcile(request(actor))).clean).toBe(true);expect(connects).toBe(1);expect(releases).toBe(1);
 expect(queries[0]).toBe("BEGIN");expect(queries.at(-1)).toBe("COMMIT");expect(queries.filter(q=>q==="BEGIN")).toHaveLength(1);
 expect(queries.some(q=>q==="LOCK TABLE public.sessions, public.session_edits, public.observations, public.audit_events IN SHARE MODE")).toBe(true);
 expect(queries.some(q=>/^\s*(INSERT|UPDATE|DELETE)\b/i.test(q))).toBe(false);expect(await snapshot()).toBe(before);
});
