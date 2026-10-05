import { beforeAll,afterAll,it,expect,vi } from "vitest";
import { randomUUID } from "node:crypto";
import { startFixture,connectFixture } from "../lib/ownership-fixture";
import { seedPolicyV2 } from "../lib/seed-policy-v2";
import { importLegacyObservations,reconcileLegacyObservations } from "./legacy-observation-sync";
import { reconcileObservationsV2 } from "../../script/reconcile-observations-v2";
import { backfillPolicyV2 } from "../../script/backfill-policy-v2";
import { ObservationSchema,ConfigurationBundleSchema } from "../../shared/domain-config";
import type { OwnershipDatabase } from "../lib/org-context";
let f:Awaited<ReturnType<typeof startFixture>>;
const request=(actor:string)=>({isAuthenticated:()=>true,user:{claims:{sub:actor}}});
const slugs=["martial-arts","meditation","fitness","music"];
const legacy=["users","sessions","user_settings","deviations","session_edits","http_sessions"];
const seed=["organizations","organization_members","domains","policy_versions","dimension_definitions","source_bindings"];
async function snapshot(tables=[...legacy,...seed,"observations","deviations_v2","deviation_domains","evaluation_results","audit_events"]){
 const state:Record<string,unknown>={};
 for(const table of tables)state[table]=(await f.client.query(`SELECT to_jsonb(t) r FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
 return JSON.stringify(state);
}
async function owner(actor:string){
 await f.client.query("INSERT INTO users(id) VALUES($1)",[actor]);
 await f.client.query("INSERT INTO user_settings(user_id,timezone,day_start_hour,window_days) VALUES($1,'America/New_York',3,14)",[actor]);
 for(const [i,slug] of slugs.entries()){
  await f.client.query(`INSERT INTO sessions(id,user_id,domain,duration_minutes,timestamp,notes,is_anomaly,anomaly_note,deleted_at)
   VALUES($1,$2,$3,1,'2020-01-01T12:00:00.123456Z',NULL,false,'contradictory retained','2021-01-01T01:02:03.123456Z'),
   ($4,$2,$3,30,'2026-01-01T00:00:00Z','',true,NULL,NULL)`,
   [`${actor}-${slug}-old`,actor,slug,`${actor}-${slug}-new`]);
  await f.client.query(`INSERT INTO session_edits(id,session_id,user_id,edited_at,reason,changed_fields)
   VALUES($1,$2,$3,'2022-02-01T03:04:05.654321Z',$4,$5)`,
   [`${actor}-edit-${i}`,`${actor}-${slug}-new`,actor,i===0?"long ".repeat(600):"synthetic reason",
    i===0?JSON.stringify({notes:"x".repeat(10000),isAnomaly:false,anomalyNote:null}):
    i===1?"malformed ".repeat(800):i===2?'{"durationMinutes":0}':'{"notes":null,"isAnomaly":false}']);
 }
 await f.client.query("INSERT INTO deviations(id,user_id,domain,reason,start_at) VALUES($1,$2,'music','synthetic',now())",[`deviation-${actor}`,actor]);
 await f.client.query("INSERT INTO http_sessions(sid,sess,expire) VALUES($1,$2,'2030-01-01')",[`synthetic-${actor}`,{synthetic:true}]);
 return seedPolicyV2(f.db,request(actor));
}
async function reject(actor:string,status=400,db=f.db){
 const before=await snapshot();
 await expect(importLegacyObservations(db,request(actor))).rejects.toMatchObject({status});
 expect(await snapshot()).toBe(before);
}
async function mutate(sql:string,args:unknown[],fn:()=>Promise<void>){
 // Only this owned synthetic fixture. Roll back the test mutation too.
 await f.client.query("BEGIN");await f.client.query(sql,args);
 const nested:OwnershipDatabase={transaction:async cb=>{
  await f.client.query("SAVEPOINT attempt");
  try{const r=await cb(f.client);await f.client.query("RELEASE SAVEPOINT attempt");return r;}
  catch(e){await f.client.query("ROLLBACK TO SAVEPOINT attempt");throw e;}
 }};
 const original=f.db;f.db=nested;
 try{await fn();}finally{f.db=original;await f.client.query("ROLLBACK");}
}
beforeAll(async()=>{f=await startFixture("legacy-observation-import");},60000);
afterAll(async()=>{if(f)await f.cleanup();},60000);

it("both wrappers are inert; malformed/auth/body/header authority fails before database access",async()=>{
 expect(()=>reconcileObservationsV2()).toThrow();expect(()=>backfillPolicyV2()).toThrow();
 const transaction=vi.fn(async()=>{throw Error("NO DATABASE ACCESS");}),db={transaction} as OwnershipDatabase;
 for(const operation of [importLegacyObservations,reconcileLegacyObservations]){
  for(const r of [
   undefined,{}, {isAuthenticated:true},{isAuthenticated:()=>false,user:{claims:{sub:"a"}}},
   ...[null,undefined,{}, {sub:null},{sub:42},{sub:""},{sub:" x"},{sub:"x "},{sub:"\u0000"},{sub:"x".repeat(201)},{sub:"__proto__"}]
    .map(claims=>({isAuthenticated:()=>true,user:{claims}})),
   {headers:{"x-user-id":"a","x-owner-id":"a",authorization:"synthetic"}},
   {isAuthenticated:()=>true,headers:{"x-user-id":"a"}},
  ])await expect(operation(db,r as any)).rejects.toMatchObject({status:401});
  for(const field of ["body","query","params"])for(const v of [{owner:{id:"b"}},{clock:0,batch:"fake",mapping:{}},[],1])
   await expect(operation(db,{...request("a"),[field]:v} as any)).rejects.toMatchObject({status:400});
 }
 expect(transaction).not.toHaveBeenCalled();
});
it("imports two owners, preserving all six legacy tables, seed rows, raw flags, dates, notes and every edit",async()=>{
 const maps=await Promise.resolve([await owner("a"),await owner("b")]);
 await f.client.query("INSERT INTO sessions(id,domain,duration_minutes,timestamp) VALUES('unowned','music',5,now())");
 const legacyBefore=await snapshot([...legacy,...seed]);
 const seedAudits=(await f.client.query("SELECT to_jsonb(t) r FROM audit_events t ORDER BY audit_event_id")).rows;
 for(const actor of ["a","b"]){
  const pre=await reconcileLegacyObservations(f.db,request(actor));
  expect(pre.clean).toBe(false);expect(pre.drift.missing).toBe(8);expect(pre.unownedSessions).toBe(1);
  const imported=await importLegacyObservations(f.db,request(actor));
  expect(imported.reconciliation.clean).toBe(true);
  expect(Object.keys(imported.mapping!)).toHaveLength(8);
  const observations=(await f.client.query("SELECT * FROM observations WHERE owner_user_id=$1",[actor])).rows;
  expect(observations).toHaveLength(8);
  const configurations=(await f.client.query("SELECT configuration FROM policy_versions WHERE owner_user_id=$1",[actor])).rows.map(r=>r.configuration);
  expect(ConfigurationBundleSchema.safeParse({schemaVersion:1,configurations,observations:observations.map(r=>r.observation)}).success).toBe(true);
  for(const row of observations){
   const o=ObservationSchema.parse(row.observation),old=row.legacy_source_id.endsWith("-old");
   expect(Object.values(o.values)).toEqual([{unitId:"minute",valueType:"number",value:old?1:30}]);
   expect(Object.hasOwn(o,"notes")).toBe(!old);if(!old)expect(o.notes).toBe("");
   expect(o.observedAt).toBe(old?"2020-01-01T12:00:00.123456+00:00":"2026-01-01T00:00:00+00:00");
   expect(row.is_anomaly).toBe(!old);expect(row.anomaly_note).toBe(old?"contradictory retained":null);
   expect(row.observation_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }
  const audits=(await f.client.query("SELECT *,to_jsonb(t) raw FROM audit_events t WHERE actor_user_id=$1 AND entity_type LIKE 'legacy_%' ORDER BY entity_id",[actor])).rows;
  expect(audits).toHaveLength(12);
  for(const a of audits){
   expect(a.after.importBatchId).toBe(imported.importBatchId);
   expect(a.after.binding.binding_id).toBe(maps[actor==="a"?0:1][a.after.sourceSnapshot.row.domain].bindingId);
   expect(a.after.sourceSnapshot.kind).toBe("current-row-at-import-not-historical-after");
   if(a.entity_type==="legacy_edit_import"){
    expect(a.after.historicalAfterEvidence).toEqual({status:"unknown"});
    const edit=(await f.client.query("SELECT to_jsonb(e) raw FROM session_edits e WHERE id=$1",[a.after.sourceEditId])).rows[0].raw;
    expect(a.before.sourceEdit).toEqual(edit);expect(a.raw.occurred_at).toBe(edit.edited_at);expect(a.reason).toBe(edit.reason);
    expect(a.before.priorEvidence.status).toBe(edit.id.endsWith("-0")||edit.id.endsWith("-3")?"known":"unknown");
   }
  }
  const before=await snapshot(),again=await importLegacyObservations(f.db,request(actor));
  expect(again).toEqual(imported);expect(await snapshot()).toBe(before);
  expect((await reconcileLegacyObservations(f.db,request(actor))).clean).toBe(true);
  expect(await snapshot()).toBe(before);
 }
 expect(await snapshot([...legacy,...seed])).toBe(legacyBefore);
 expect((await f.client.query("SELECT to_jsonb(t) r FROM audit_events t WHERE entity_type NOT LIKE 'legacy_%' ORDER BY audit_event_id")).rows).toEqual(seedAudits);
 expect((await f.client.query("SELECT * FROM observations WHERE legacy_source_id='unowned'")).rows).toEqual([]);
 for(const table of ["deviations_v2","evaluation_results"])expect((await f.client.query(`SELECT * FROM ${table}`)).rows).toEqual([]);
});
it("rejects changed source, payload, mapping and provenance; reconciliation reports drift without repair",async()=>{
 for(const sql of [
  "UPDATE sessions SET duration_minutes=duration_minutes+1 WHERE id='a-music-old'",
  "UPDATE sessions SET notes='' WHERE id='a-music-old'",
  "UPDATE sessions SET timestamp=timestamp+interval '1 microsecond' WHERE id='a-music-old'",
  "UPDATE sessions SET is_anomaly=NOT is_anomaly WHERE id='a-music-old'",
  "UPDATE sessions SET anomaly_note='' WHERE id='a-music-new'",
  "UPDATE sessions SET deleted_at=NULL WHERE id='a-music-old'",
  "UPDATE session_edits SET changed_fields=changed_fields||' ' WHERE id='a-edit-0'",
  "UPDATE session_edits SET reason=reason||'!' WHERE id='a-edit-0'",
  "UPDATE observations SET observation=jsonb_set(observation,'{notes}','null') WHERE legacy_source_id='a-music-new'",
  "UPDATE observations SET anomaly_note='altered' WHERE legacy_source_id='a-music-new'",
  "UPDATE observations SET idempotency_key='altered' WHERE legacy_source_id='a-music-new'",
  "UPDATE source_bindings SET metadata='{}' WHERE owner_user_id='a' AND external_id='music'",
  "UPDATE audit_events SET occurred_at=occurred_at+interval '1 microsecond' WHERE actor_user_id='a' AND entity_type='legacy_session_import'",
  "UPDATE audit_events SET reason='altered' WHERE actor_user_id='a' AND entity_type='legacy_edit_import'",
  "UPDATE audit_events SET \"after\"=jsonb_set(\"after\",'{importBatchId}','\"forged\"') WHERE actor_user_id='a' AND entity_type='legacy_session_import'",
  "DELETE FROM observations WHERE legacy_source_id='a-music-new'",
  "DELETE FROM audit_events WHERE actor_user_id='a' AND entity_type='legacy_edit_import'",
 ]){
  await mutate(sql,[],async()=>{
   const before=await snapshot();const result=await reconcileLegacyObservations(f.db,request("a"));
   expect(result.clean,sql).toBe(false);expect(await snapshot()).toBe(before);
   expect(JSON.stringify(result)).not.toContain("contradictory");expect(JSON.stringify(result)).not.toContain("long long");
   await reject("a");
  });
 }
});
it("validates complete future-version bundles, selects half-open interval edges and ignores ordinary observations",async()=>{
 const mapping=await owner("versions"),id=mapping.music.policyVersionId;
 const p=(await f.client.query("SELECT * FROM policy_versions WHERE policy_version_id=$1",[id])).rows[0];
 const c=structuredClone(p.configuration),nextId=randomUUID();
 c.policyVersionId=nextId;c.previousVersionId=id;c.revision=2;c.effectiveFrom="2025-01-01T00:00:00.000Z";
 await f.client.query(`INSERT INTO policy_versions(policy_version_id,org_id,owner_user_id,domain_id,revision,effective_from,previous_version_id,configuration,evaluation_policy)
  VALUES($1,$2,$3,$4,2,$5,$6,$7,$8)`,[nextId,p.org_id,p.owner_user_id,p.domain_id,c.effectiveFrom,id,c,p.evaluation_policy]);
 for(const m of c.measurements)await f.client.query("INSERT INTO dimension_definitions VALUES($1,$2,$3,$4,$5,$6)",[p.org_id,p.owner_user_id,p.domain_id,nextId,m.measurementId,m]);
 for(const [label,at] of [["before","2024-12-31T23:59:59.999999Z"],["edge",c.effectiveFrom],["after","2025-01-01T00:00:00.000001Z"]])
  await f.client.query("INSERT INTO sessions(id,user_id,domain,duration_minutes,timestamp) VALUES($1,'versions','music',2,$2)",[label,at]);
 const result=await importLegacyObservations(f.db,request("versions"));expect(result.reconciliation.clean).toBe(true);
 const obs=(await f.client.query("SELECT legacy_source_id,policy_version_id FROM observations WHERE owner_user_id='versions'")).rows;
 expect(obs.find(o=>o.legacy_source_id==="before").policy_version_id).toBe(id);
 for(const label of ["edge","after","versions-music-new"])expect(obs.find(o=>o.legacy_source_id===label).policy_version_id).toBe(nextId);
 const ordinary=randomUUID();
 await f.client.query(`INSERT INTO observations
  SELECT $1,org_id,owner_user_id,domain_id,policy_version_id,$1,observed_at,jsonb_set(observation,'{observationId}',to_jsonb($1::text)),
  is_anomaly,anomaly_note,deleted_at,NULL,NULL FROM observations WHERE legacy_source_id='edge'`,[ordinary]);
 const before=await snapshot();expect((await importLegacyObservations(f.db,request("versions"))).mapping).toEqual(result.mapping);
 expect(await snapshot()).toBe(before);
});
it("fails closed on edit ownership/link conflicts, invalid history/settings of scope and typed bundles",async()=>{
 await owner("invalid");
 for(const sql of [
  "UPDATE session_edits SET user_id='b' WHERE id='invalid-edit-0'",
  "UPDATE session_edits SET session_id='a-music-new' WHERE id='invalid-edit-0'",
  "UPDATE session_edits SET session_id='dangling' WHERE id='invalid-edit-0'",
  "UPDATE session_edits SET session_id='unowned' WHERE id='invalid-edit-0'",
  "UPDATE sessions SET domain='unknown' WHERE id='invalid-music-new'",
  "UPDATE sessions SET duration_minutes=0 WHERE id='invalid-music-new'",
  "UPDATE sessions SET duration_minutes=-1 WHERE id='invalid-music-new'",
  "UPDATE sessions SET timestamp='infinity' WHERE id='invalid-music-new'",
  "UPDATE sessions SET timestamp='-infinity' WHERE id='invalid-music-new'",
  "UPDATE sessions SET deleted_at='infinity' WHERE id='invalid-music-old'",
  "UPDATE session_edits SET edited_at='infinity' WHERE id='invalid-edit-0'",
  "UPDATE source_bindings SET source_kind='other' WHERE owner_user_id='invalid' AND external_id='music'",
  "UPDATE source_bindings SET external_id='wrong' WHERE owner_user_id='invalid' AND external_id='music'",
  "UPDATE policy_versions SET configuration=jsonb_set(configuration,'{measurements,0,unit,unitId}','\"hour\"') WHERE owner_user_id='invalid'",
  "UPDATE policy_versions SET configuration=jsonb_set(configuration,'{measurements,0,valueType}','\"integer\"') WHERE owner_user_id='invalid'",
  "DELETE FROM dimension_definitions WHERE owner_user_id='invalid'",
  "DELETE FROM policy_versions WHERE owner_user_id='invalid' AND domain_id=(SELECT domain_id FROM domains WHERE owner_user_id='invalid' AND slug='music')",
 ]){
  // The last FK-backed mutation needs its dimensions removed in the same fixture transaction.
  const mutation=sql.startsWith("DELETE FROM policy_versions")?"DELETE FROM dimension_definitions WHERE owner_user_id='invalid';"+sql:sql;
  await mutate(mutation,[],()=>reject("invalid"));
 }
 for(const sql of [
  "UPDATE organization_members SET role='member' WHERE user_id='invalid'",
  "UPDATE organizations SET rollout_mode='shadow' WHERE org_id=(SELECT org_id FROM organization_members WHERE user_id='invalid')",
  "INSERT INTO organization_members(org_id,user_id,role) SELECT org_id,'b','member' FROM organization_members WHERE user_id='invalid'",
 ])await mutate(sql,[],()=>reject("invalid",403));
 const invalidDate:OwnershipDatabase={transaction:fn=>f.db.transaction(tx=>fn({query:async(sql,args)=>{
  const result=await tx.query(sql,args);
  if(sql.includes("FROM public.sessions t"))result.rows=result.rows.map((r,i)=>i===0?{...r,timestamp:new Date(NaN)}:r);
  return result;
 }}))};
 await reject("invalid",400,invalidDate);
});
it("real concurrent clients serialize imports with identical maps and no new rows/audits on rerun",async()=>{
 await owner("concurrent-import");const clients=await Promise.all([connectFixture(f.root),connectFixture(f.root)]);
 try{
  const dbs=clients.map(client=>({transaction:async(fn:any)=>{
   await client.query("BEGIN");try{const value=await fn(client);await client.query("COMMIT");return value;}
   catch(e){await client.query("ROLLBACK");throw e;}
  }}) as OwnershipDatabase);
  const values=await Promise.all(dbs.map(db=>importLegacyObservations(db,request("concurrent-import"))));
  expect(values[0]).toEqual(values[1]);
  expect((await f.client.query("SELECT count(*)::int n FROM observations WHERE owner_user_id='concurrent-import'")).rows[0].n).toBe(8);
  expect((await f.client.query("SELECT count(*)::int n FROM audit_events WHERE actor_user_id='concurrent-import' AND entity_type LIKE 'legacy_%'")).rows[0].n).toBe(12);
  const before=await snapshot();
  await Promise.all(dbs.map(db=>importLegacyObservations(db,request("concurrent-import"))));expect(await snapshot()).toBe(before);
 }finally{await Promise.all(clients.map(c=>c.end()));}
});
it("semantic object order is irrelevant while arrays, zero, false, missing and null remain distinct",async()=>{
 const original=await importLegacyObservations(f.db,request("a"));
 const reverse=(v:any):any=>Array.isArray(v)?v.map(reverse):v&&typeof v==="object"?
  Object.fromEntries(Object.entries(v).reverse().map(([k,x])=>[k,reverse(x)])):v;
 const reordered:OwnershipDatabase={transaction:fn=>f.db.transaction(tx=>fn({query:async(sql,args)=>{
  const result=await tx.query(sql,args);
  result.rows=result.rows.map(r=>({...r,...(r.raw?{raw:reverse(r.raw)}:{}),
   ...(r.configuration?{configuration:reverse(r.configuration)}:{}),
   ...(r.definition?{definition:reverse(r.definition)}:{})}));
  return result;
 }}))};
 const before=await snapshot();
 expect(await importLegacyObservations(reordered,request("a"))).toEqual(original);expect(await snapshot()).toBe(before);
 for(const sql of [
  `UPDATE audit_events SET "after"=jsonb_set("after",'{policy,configuration,references}',
   (SELECT jsonb_agg(v ORDER BY i DESC) FROM jsonb_array_elements("after"->'policy'->'configuration'->'references') WITH ORDINALITY a(v,i)))
   WHERE actor_user_id='a' AND entity_type='legacy_session_import'`,
  `UPDATE audit_events SET "before"=jsonb_set("before",'{priorEvidence,values,isAnomaly}','0')
   WHERE entity_type='legacy_edit_import' AND entity_id='["a-edit-3"]'`,
  `UPDATE audit_events SET "before"="before"#-'{priorEvidence,values,notes}'
   WHERE entity_type='legacy_edit_import' AND entity_id='["a-edit-3"]'`,
  `UPDATE observations SET observation=observation-'notes' WHERE legacy_source_id='a-music-new'`,
 ])await mutate(sql,[],()=>reject("a"));
});
it("ambiguous mappings, coherent wrong units and invalid future chains fail before importing any rows",async()=>{
 const mapping=await owner("strict"),id=mapping.music.policyVersionId;
 const p=(await f.client.query("SELECT * FROM policy_versions WHERE policy_version_id=$1",[id])).rows[0];
 await mutate(`INSERT INTO source_bindings SELECT 'ambiguous',org_id,owner_user_id,domain_id,'other-kind',external_id,metadata
  FROM source_bindings WHERE binding_id=$1`,[mapping.music.bindingId],()=>reject("strict"));
 await mutate(`UPDATE source_bindings SET domain_id=$1 WHERE binding_id=$2`,
  [mapping.fitness.domainId,mapping.music.bindingId],()=>reject("strict"));
 // A structurally valid configuration with dimensions updated to match still
 // cannot silently convert the legacy minute value to hours.
 const hours=JSON.parse(JSON.stringify(p.configuration).replaceAll('"minute"','"hour"'));
 expect(ConfigurationBundleSchema.safeParse({schemaVersion:1,configurations:[hours],observations:[]}).success).toBe(true);
 await mutate("UPDATE policy_versions SET configuration=$1 WHERE policy_version_id=$2",[hours,id],async()=>{
  for(const m of hours.measurements)await f.client.query("UPDATE dimension_definitions SET definition=$1 WHERE policy_version_id=$2 AND measurement_id=$3",[m,id,m.measurementId]);
  await reject("strict");
 });
 const future=structuredClone(p.configuration),futureId=randomUUID();
 future.policyVersionId=futureId;future.previousVersionId=id;future.revision=3;future.effectiveFrom="2035-01-01T00:00:00.000Z";
 await mutate(`INSERT INTO policy_versions(policy_version_id,org_id,owner_user_id,domain_id,revision,effective_from,previous_version_id,configuration,evaluation_policy)
  VALUES($1,$2,$3,$4,3,$5,$6,$7,$8)`,[futureId,p.org_id,p.owner_user_id,p.domain_id,future.effectiveFrom,id,future,p.evaluation_policy],async()=>{
  for(const m of future.measurements)await f.client.query("INSERT INTO dimension_definitions VALUES($1,$2,$3,$4,$5,$6)",[p.org_id,p.owner_user_id,p.domain_id,futureId,m.measurementId,m]);
  await reject("strict");
 });
 // A foreign caller never receives another owner's map; unknown and fresh
 // authenticated users cannot bootstrap membership through this seam.
 await reject("absent",403);await f.client.query("INSERT INTO users(id) VALUES('fresh-import')");
 await reject("fresh-import",403);
});
it("early and late observation/create-audit/edit-audit failures roll back all rows with a reached-branch witness",async()=>{
 await owner("rollback-import");
 for(const late of [false,true])for(const boundary of ["observations","legacy_session_import","legacy_edit_import"]){
  const table=boundary==="observations"?"observations":"audit_events";
  const condition=table==="observations"?`NEW.owner_user_id='rollback-import' ${late?"AND NEW.legacy_source_id='rollback-import-music-old'":""}`:
   `NEW.actor_user_id='rollback-import' AND NEW.entity_type='${boundary}' ${late?"AND NEW.\"after\"->'sourceSnapshot'->'row'->>'domain'='music'":""}`;
  await f.client.query(`CREATE SEQUENCE import_failure_witness;
   CREATE FUNCTION fail_import() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
   IF ${condition} THEN
    ${late?`IF (SELECT count(*) FROM observations WHERE owner_user_id='rollback-import' AND
     legacy_source_id NOT LIKE 'rollback-import-music-%')<>6 OR
     (SELECT count(*) FROM audit_events WHERE actor_user_id='rollback-import' AND entity_type LIKE 'legacy_%' AND
     "after"->'sourceSnapshot'->'row'->>'domain'<>'music')<>9 THEN RAISE EXCEPTION 'not late'; END IF;`:""}
    PERFORM nextval('import_failure_witness');RAISE EXCEPTION 'synthetic boundary'; END IF;RETURN NEW;END $$;
   CREATE TRIGGER fail_import BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_import()`);
  try{
   await reject("rollback-import",503);
   expect((await f.client.query("SELECT is_called FROM import_failure_witness")).rows[0].is_called).toBe(true);
  }finally{await f.client.query(`DROP TRIGGER fail_import ON ${table};DROP FUNCTION fail_import();DROP SEQUENCE import_failure_witness`);}
 }
});
it("post-insert reconciliation mismatch rolls back and extra/duplicate/conflicting imports or audits are read-only drift",async()=>{
 await owner("post-validation");
 await f.client.query(`CREATE FUNCTION corrupt_import() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  NEW.anomaly_note='changed by fixture trigger'; RETURN NEW;END $$;
  CREATE TRIGGER corrupt_import BEFORE INSERT ON observations FOR EACH ROW EXECUTE FUNCTION corrupt_import()`);
 try{await reject("post-validation");}finally{await f.client.query("DROP TRIGGER corrupt_import ON observations;DROP FUNCTION corrupt_import()");}
 const sql=`INSERT INTO observations
  SELECT 'extra',org_id,owner_user_id,domain_id,policy_version_id,'extra',observed_at,jsonb_set(observation,'{observationId}','"extra"'),
  is_anomaly,anomaly_note,deleted_at,legacy_source_type,'extra-source' FROM observations WHERE legacy_source_id='a-music-new'`;
 await mutate(sql,[],async()=>{const before=await snapshot();expect((await reconcileLegacyObservations(f.db,request("a"))).drift.extra).toBe(1);await reject("a");expect(await snapshot()).toBe(before);});
 await mutate(`INSERT INTO audit_events SELECT 'extra-audit',org_id,actor_kind,actor_user_id,entity_type,entity_id,action,occurred_at,reason,"before","after"
  FROM audit_events WHERE actor_user_id='a' AND entity_type='legacy_edit_import' LIMIT 1`,[],async()=>{
  expect((await reconcileLegacyObservations(f.db,request("a"))).drift.audit).toBeGreaterThan(0);await reject("a");
 });
 const other=(await f.client.query("SELECT domain_id,policy_version_id FROM observations WHERE legacy_source_id='a-fitness-new'")).rows[0];
 await mutate(`INSERT INTO observations
  SELECT 'duplicate',org_id,owner_user_id,$1,$2,'duplicate',observed_at,
  observation||jsonb_build_object('observationId','duplicate','domainId',$1::text,'policyVersionId',$2::text),
  is_anomaly,anomaly_note,deleted_at,legacy_source_type,legacy_source_id FROM observations WHERE legacy_source_id='a-music-new'`,
 [other.domain_id,other.policy_version_id],async()=>{
  expect((await reconcileLegacyObservations(f.db,request("a"))).drift.duplicate).toBe(1);await reject("a");
 });
});