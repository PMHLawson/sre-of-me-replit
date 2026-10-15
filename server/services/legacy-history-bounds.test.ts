import { beforeAll,beforeEach,afterAll,describe,it,expect,vi } from "vitest";
import { Pool,type PoolClient } from "pg";
import { startFixture } from "../lib/ownership-fixture";
import { createPinnedOwnershipUnit } from "../lib/pinned-ownership-unit";
import { seedPolicyV2 } from "../lib/seed-policy-v2";
import { createLegacyActivityMutations } from "./legacy-activity-mutations";
import { importLegacyObservations,reconcileLegacyObservations,verifyLegacyImportProvenance } from "./legacy-observation-sync";
import { ResourceLimitError,MAX_READ_ROWS,READ_TIMEOUT_MS } from "../lib/read-budget";
import { withTransactionReadBudget } from "../lib/transaction-read-budget";

const timer=vi.hoisted(()=>({at:0}));
vi.mock("node:perf_hooks",()=>({performance:{now:()=>timer.at}}));

describe("legacy write-through and provenance keep complete bounded evidence",()=>{
  let f:Awaited<ReturnType<typeof startFixture>>,pool:Pool,service:ReturnType<typeof createLegacyActivityMutations>;
  const request=(actor="legacy-bound-a")=>({isAuthenticated:()=>true,user:{claims:{sub:actor}}});
  const slugs=["martial-arts","meditation","fitness","music"];
  const statements:Array<{sql:string;values:unknown[];rows:number}>=[];
  const payload={domain:"music",durationMinutes:1,timestamp:"2026-01-01T01:02:03.123456Z"};
  async function state(){
    const result:Record<string,unknown>={};
    for(const table of ["users","organizations","organization_members","sessions","session_edits","domains","policy_versions",
      "dimension_definitions","source_bindings","observations","audit_events","user_settings"])
      result[table]=(await f.client.query("SELECT to_jsonb(t) r FROM public."+table+" t ORDER BY to_jsonb(t)::text")).rows;
    return JSON.stringify(result);
  }
  async function owner(actor:string){
    await f.client.query("INSERT INTO users(id) VALUES($1)",[actor]);
    await f.client.query("INSERT INTO user_settings(user_id,timezone,day_start_hour,window_days) VALUES($1,'America/New_York',6,14)",[actor]);
    for(const slug of slugs)await f.client.query(
      "INSERT INTO sessions(id,user_id,domain,duration_minutes,timestamp,notes,is_anomaly,anomaly_note) "+
      "VALUES($1,$2,$3,1,'2020-01-01T00:00:00.123456Z',NULL,false,'retained old anomaly note')",[actor+"-"+slug,actor,slug]);
    await seedPolicyV2(f.db,request(actor));await importLegacyObservations(f.db,request(actor));
  }
  async function refused(operation:()=>Promise<unknown>){
    const before=await state(),from=statements.length;
    await expect(operation()).rejects.toMatchObject({status:503,code:"RESOURCE_LIMIT_EXCEEDED"});
    expect(await state()).toBe(before);
    expect(statements.slice(from).some(q=>/^\s*(INSERT|UPDATE|DELETE)\b/.test(q.sql))).toBe(false);
  }
  async function addSessions(actor:string,count:number){
    await f.client.query(
      "INSERT INTO sessions(id,user_id,domain,duration_minutes,timestamp) "+
      "SELECT $1||'-extra-'||n,$1,'music',1,'2020-02-01T00:00:00Z'::timestamptz FROM generate_series(1,$2::integer) n",[actor,count]);
  }
  async function addLineage(actor:string,count:number,start=1){
    // Genuine no-op edit lineage: identical before/after raw state, an exact
    // retained legacy edit row and monotonically increasing mutation sequence.
    const key=actor+"-music";
    await f.client.query(
      "INSERT INTO session_edits(id,session_id,user_id,edited_at,reason,changed_fields) "+
      "SELECT $1||'-lineage-'||n,$2,$1,'2026-01-02T00:00:00Z'::timestamptz+n*interval '1 microsecond','Synthetic no-op edit','{}' "+
      "FROM generate_series($3::integer,$4::integer) n",[actor,key,start,start+count-1]);
    await f.client.query(
      "INSERT INTO audit_events(audit_event_id,org_id,actor_kind,actor_user_id,entity_type,entity_id,action,occurred_at,reason,\"before\",\"after\") "+
      "SELECT $1||'-lineage-audit-'||n,a.org_id,'user',$1,'legacy_session_mutation',$2,'update',e.edited_at,e.reason,"+
      "jsonb_build_object('legacy',a.after->'sourceSnapshot'->'row','canonical',a.after->'importedObservation'),"+
      "jsonb_build_object('version','legacy-activity-mutation-v1','operation','edit','sequence',n,"+
      "'state',jsonb_build_object('legacy',a.after->'sourceSnapshot'->'row','canonical',a.after->'importedObservation'),"+
      "'legacyEdit',to_jsonb(e)) "+
      "FROM generate_series($3::integer,$4::integer) n JOIN session_edits e ON e.id=$1||'-lineage-'||n "+
      "CROSS JOIN audit_events a WHERE a.actor_user_id=$1 AND a.entity_type='legacy_session_import' AND a.entity_id=$2",
      [actor,JSON.stringify([key]),start,start+count-1]);
  }
  beforeAll(async()=>{
    for(const name of ["DATABASE_URL","SESSION_SECRET","OAUTH_TOKEN_ENCRYPTION_KEYRING"])
      if(process.env[name])throw Error("Synthetic legacy bounds must not inherit owner credentials");
    f=await startFixture("somr467-legacy-evidence-bounds");
    pool=new Pool({host:f.root+"/socket",port:5432,user:"synthetic",database:"postgres",password:"",ssl:false,
      max:4,connectionTimeoutMillis:5000,options:"-c statement_timeout=10000 -c lock_timeout=5000"});
    const connect=async()=>{
      const client=await pool.connect();
      return {query:async(sql:string,values:unknown[]=[])=>{
        const result=await client.query(sql,values);
        statements.push({sql,values:structuredClone(values),rows:result.rows.length});
        return result;
      },release:(destroy?:boolean)=>client.release(destroy)} as unknown as PoolClient;
    };
    service=createLegacyActivityMutations(createPinnedOwnershipUnit({connect:connect as Pool["connect"]}));
  },60000);
  beforeEach(async()=>{
    timer.at=0;statements.length=0;
    await f.client.query("TRUNCATE users,organizations CASCADE");
    await owner("legacy-bound-a");await owner("legacy-bound-b");
  });
  afterAll(async()=>{try{if(pool)await pool.end();}finally{if(f)await f.cleanup();}},60000);

  it("retains exact small-history write-through, import provenance and owner isolation",async()=>{
    const other=(await f.client.query("SELECT to_jsonb(s) r FROM sessions s WHERE user_id='legacy-bound-b' ORDER BY id")).rows;
    const imports=(await f.client.query("SELECT to_jsonb(a) r FROM audit_events a WHERE entity_type='legacy_session_import' ORDER BY audit_event_id")).rows;
    const saved=await service.create(request(),{...payload,notes:"preserved synthetic practice"});
    await service.edit(request(),saved.id,{notes:"updated synthetic practice",reason:"Synthetic correction"});
    await service.softDelete(request(),saved.id);await service.restore(request(),saved.id);
    expect(await service.verify(request(),saved.id)).toEqual({clean:true,mutations:4});
    const before=await state(),reconciled=await service.reconcile(request());
    expect(reconciled.clean).toBe(true);expect(reconciled.counts).toMatchObject({ownedSessions:5,canonicalSessions:5,mutationEvents:4});
    expect(await state()).toBe(before);
    expect((await f.client.query("SELECT to_jsonb(s) r FROM sessions s WHERE user_id='legacy-bound-b' ORDER BY id")).rows).toEqual(other);
    expect((await f.client.query("SELECT to_jsonb(a) r FROM audit_events a WHERE entity_type='legacy_session_import' ORDER BY audit_event_id")).rows).toEqual(imports);
    expect((await service.create(request("legacy-bound-b"),payload)).user_id).toBe("legacy-bound-b");
  });

  it("reports all rows at the collection boundary, then rejects overflow without a partial reconciliation",async()=>{
    await addSessions("legacy-bound-a",MAX_READ_ROWS-4);
    const before=await state(),report=await reconcileLegacyObservations(f.db,request());
    expect(report.clean).toBe(false);expect(report.counts.ownedSessions).toBe(MAX_READ_ROWS);
    expect(report.drift.missing).toBe(MAX_READ_ROWS-4);expect(await state()).toBe(before);
    await f.client.query("INSERT INTO sessions(id,user_id,domain,duration_minutes,timestamp) VALUES('one-over','legacy-bound-a','music',1,'2020-02-01')");
    await refused(()=>service.reconcile(request()));
    const count=await f.client.query("SELECT count(*)::integer n FROM sessions WHERE user_id='legacy-bound-a'");
    expect(count.rows[0].n).toBe(MAX_READ_ROWS+1);
    await expect(reconcileLegacyObservations(f.db,request())).rejects.toBeInstanceOf(ResourceLimitError);
    await expect(verifyLegacyImportProvenance(f.db,request())).rejects.toBeInstanceOf(ResourceLimitError);
    expect((await service.reconcile(request("legacy-bound-b"))).clean).toBe(true);
  },30000);

  it("validates complete lineage at the exact audit budget and refuses another edit before any write",async()=>{
    await addLineage("legacy-bound-a",MAX_READ_ROWS-1);
    const before=await state();
    expect(await service.verify(request(),"legacy-bound-a-music")).toEqual({clean:true,mutations:MAX_READ_ROWS-1});
    expect(await state()).toBe(before);
    await refused(()=>service.edit(request(),"legacy-bound-a-music",{notes:"must not be stored",reason:"Synthetic audit-cap refusal"}));
    const auditRead=statements.filter(q=>q.sql.includes("entity_type IN ('legacy_session_import','legacy_session_mutation')")).at(-1)!;
    expect(auditRead.values.at(-1)).toBe(MAX_READ_ROWS+1);expect(auditRead.rows).toBe(MAX_READ_ROWS);
    await addLineage("legacy-bound-a",1,MAX_READ_ROWS);
    await refused(()=>service.verify(request(),"legacy-bound-a-music"));
    await refused(()=>service.softDelete(request(),"legacy-bound-a-music"));
  },30000);

  it("bounded policy mapping refuses both creation and editing before the first legacy insert",async()=>{
    const p=(await f.client.query(
      "SELECT * FROM policy_versions WHERE owner_user_id='legacy-bound-a' AND domain_id IN (SELECT domain_id FROM domains WHERE slug='music' AND owner_user_id='legacy-bound-a')")).rows[0];
    await f.client.query(
      "INSERT INTO policy_versions(policy_version_id,org_id,owner_user_id,domain_id,revision,effective_from,previous_version_id,configuration) "+
      "SELECT 'mapping-policy-'||n,$1,$2,$3,n+1,$6::timestamptz+n*interval '1 second',"+
      "CASE WHEN n=1 THEN $4 ELSE 'mapping-policy-'||(n-1) END,"+
      "$5::jsonb||jsonb_build_object('policyVersionId','mapping-policy-'||n,'revision',n+1,"+
      "'previousVersionId',CASE WHEN n=1 THEN $4 ELSE 'mapping-policy-'||(n-1) END,"+
      "'effectiveFrom',to_char($6::timestamptz+n*interval '1 second','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')) "+
      "FROM generate_series(1,$7::integer) n",
      [p.org_id,p.owner_user_id,p.domain_id,p.policy_version_id,JSON.stringify(p.configuration),p.configuration.effectiveFrom,MAX_READ_ROWS]);
    await refused(()=>service.create(request(),payload));
    await refused(()=>service.edit(request(),"legacy-bound-a-music",{notes:"blocked mapping",reason:"Synthetic mapping refusal"}));
    const read=statements.filter(q=>q.sql.includes("SELECT p.*,to_jsonb(p) raw FROM public.policy_versions")).at(-1)!;
    expect(read.values.at(-1)).toBe(MAX_READ_ROWS+1);expect(read.rows).toBe(MAX_READ_ROWS+1);
    expect((await service.create(request("legacy-bound-b"),payload)).user_id).toBe("legacy-bound-b");
  });

  it("a target-domain overflow is checked before writing an otherwise valid cross-domain edit",async()=>{
    const p=(await f.client.query(
      "SELECT p.* FROM policy_versions p JOIN domains d USING(domain_id) WHERE p.owner_user_id='legacy-bound-a' AND d.slug='fitness'")).rows[0];
    await f.client.query(
      "INSERT INTO dimension_definitions(org_id,owner_user_id,domain_id,policy_version_id,measurement_id,definition) "+
      "SELECT $1,$2,$3,$4,'extra-dimension-'||n,jsonb_build_object('measurementId','extra-dimension-'||n) "+
      "FROM generate_series(1,$5::integer) n",[p.org_id,p.owner_user_id,p.domain_id,p.policy_version_id,MAX_READ_ROWS]);
    await refused(()=>service.edit(request(),"legacy-bound-a-music",{domain:"fitness",reason:"Synthetic target-overflow refusal"}));
  });

  it("an oversized complete audit collection cannot be declared clean or automatically repaired",async()=>{
    const org=(await f.client.query("SELECT org_id FROM organization_members WHERE user_id='legacy-bound-a'")).rows[0].org_id;
    await f.client.query(
      "INSERT INTO audit_events(audit_event_id,org_id,actor_kind,actor_user_id,entity_type,entity_id,action,occurred_at,reason,\"after\") "+
      "SELECT 'collection-audit-'||n,$1,'user','legacy-bound-a','synthetic-extra','[\"synthetic\"]','create',now(),'Synthetic retained event','{}' "+
      "FROM generate_series(1,$2::integer) n",[org,MAX_READ_ROWS]);
    await refused(()=>service.reconcile(request()));
    const before=await state();
    await expect(importLegacyObservations(f.db,request())).rejects.toBeInstanceOf(ResourceLimitError);
    expect(await state()).toBe(before);
  });

  it("nested provenance work inherits the original monotonic deadline and remaining SQL timeout",async()=>{
    const before=await state(),from=f.queries.length;
    await expect(f.db.transaction(raw=>withTransactionReadBudget(raw,async tx=>{
      await tx.query("SELECT 1");
      timer.at=READ_TIMEOUT_MS*6-100;
      await withTransactionReadBudget(tx,async nested=>{
        await nested.query("SELECT 1");
        timer.at=READ_TIMEOUT_MS*6+1;
        await nested.query("SELECT 1");
      });
    }))).rejects.toBeInstanceOf(ResourceLimitError);
    timer.at=0;
    const settings=f.queries.slice(from).filter(q=>q.sql.includes("set_config('statement_timeout'"));
    expect(settings.at(-1)!.parameters).toEqual(["100","100"]);
    expect(await state()).toBe(before);
  });
});
