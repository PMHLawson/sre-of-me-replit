import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { generateDrizzleJson, generateMigration, type DrizzleSnapshotJSON } from "drizzle-kit/api";
import * as declarations from "../shared/schema";

export const LEGACY = ["users","http_sessions","sessions","session_edits","deviations","user_settings"];
export const ADDED = ["organizations","organization_members","domains","policy_versions","dimension_definitions",
  "observations","evaluation_results","deviations_v2","deviation_domains","audit_events","source_bindings"];
type Snapshot = ReturnType<typeof generateDrizzleJson>;
type Journal = {version:string;dialect:string;entries:Array<{idx:number;version:string;when:number;tag:string;breakpoints:boolean}>};
export type MigrationArtifacts = {
  baselineSql:string; deltaSql:string; baseline:Snapshot; final:Snapshot; journal:Journal; files:string[];
};
export function loadArtifacts(root = resolve("migrations")): MigrationArtifacts {
  return {
    baselineSql:readFileSync(resolve(root,"0000_legacy_baseline.sql"),"utf8"),
    deltaSql:readFileSync(resolve(root,"0001_generalized_policy_engine_foundation.sql"),"utf8"),
    baseline:JSON.parse(readFileSync(resolve(root,"meta/0000_snapshot.json"),"utf8")),
    final:JSON.parse(readFileSync(resolve(root,"meta/0001_snapshot.json"),"utf8")),
    journal:JSON.parse(readFileSync(resolve(root,"meta/_journal.json"),"utf8")),
    files:[...readdirSync(root).filter(x=>x.endsWith(".sql")),...readdirSync(resolve(root,"meta")).map(x=>"meta/"+x)].sort(),
  };
}
const canonical = (v: unknown): string => {
  if(Array.isArray(v))return `[${v.map(canonical).join(",")}]`;
  if(v && typeof v==="object")return `{${Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>JSON.stringify(k)+":"+canonical(x)).join(",")}}`;
  return JSON.stringify(v) ?? "undefined";
};
/** Small SQL lexer: comments are ignored, quoted strings/identifiers preserved.
 * It is not a general PostgreSQL parser. Unknown statement forms fail closed,
 * and accepted text must also equal independently regenerated DDL. */
export function statements(sql: string): string[] {
  let i=0,token="",result:string[]=[];
  while(i<sql.length){
    if(sql.startsWith("--",i)){const end=sql.indexOf("\n",i);i=end<0?sql.length:end;token+=" ";continue;}
    if(sql.startsWith("/*",i)){
      let depth=1;i+=2;
      while(i<sql.length&&depth){if(sql.startsWith("/*",i)){depth++;i+=2;}else if(sql.startsWith("*/",i)){depth--;i+=2;}else i++;}
      if(depth)throw new Error("Unclosed SQL comment");token+=" ";continue;
    }
    const c=sql[i++];
    if(c==="'"||c==='"'){
      token+=c;let closed=false;
      while(i<sql.length){const q=sql[i++];token+=q;if(q===c){if(sql[i]===c){token+=sql[i++];}else{closed=true;break;}}}
      if(!closed)throw new Error("Unclosed SQL quote");continue;
    }
    if(c===";"){if(token.trim())result.push(token.trim());token="";}else token+=c;
  }
  if(token.trim())result.push(token.trim());
  return result;
}
const normalize = (s:string) => s.replace(/\s+/g," ").trim();
const scope=["org_id","owner_user_id","domain_id"],policy=[...scope,"policy_version_id"];
export async function validateArtifacts(a: MigrationArtifacts): Promise<{success:boolean;issues:string[]}> {
  const issues:string[]=[];
  const require=(ok:unknown,message:string)=>{if(!ok)issues.push(message);};
  try {
    // Kit's in-memory serializer includes undefined optional properties; its
    // disk writer uses JSON.stringify, which omits them. Compare disk shapes.
    const live: Snapshot=JSON.parse(JSON.stringify(generateDrizzleJson(declarations)));
    require(canonical(a.files)===canonical(["0000_legacy_baseline.sql","0001_generalized_policy_engine_foundation.sql","meta/0000_snapshot.json","meta/0001_snapshot.json","meta/_journal.json"].sort()),"Unexpected/missing SQL or metadata files");
    require(statements(a.baselineSql).length===0 && a.baselineSql.includes("EXISTING"),"Baseline must explicitly acknowledge existing installation and contain comments only");
    require(a.baseline.version==="7" && a.final.version==="7" && a.baseline.dialect==="postgresql" && a.final.dialect==="postgresql","Snapshot format/dialect mismatch");
    const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    require(uuid.test(a.baseline.id)&&uuid.test(a.final.id)&&a.baseline.id!==a.final.id&&a.baseline.prevId==="00000000-0000-0000-0000-000000000000"&&a.final.prevId===a.baseline.id,"Broken snapshot parent chain");
    require(a.journal.version==="7"&&a.journal.dialect==="postgresql"&&a.journal.entries.length===2,"Journal shape mismatch");
    const tags=["0000_legacy_baseline","0001_generalized_policy_engine_foundation"];
    a.journal.entries.forEach((e,i)=>require(e.idx===i&&e.tag===tags[i]&&e.version==="7"&&e.breakpoints===true&&Number.isSafeInteger(e.when)&&e.when>0&&(i===0||e.when>a.journal.entries[i-1].when),"Journal entry order/name/version/time mismatch"));
    require(canonical(Object.keys(a.baseline.tables).sort())===canonical(LEGACY.map(n=>"public."+n).sort()),"Baseline must contain exactly six legacy tables");
    require(canonical(Object.keys(a.final.tables).sort())===canonical([...LEGACY,...ADDED].map(n=>"public."+n).sort()),"Final must contain exactly seventeen tables");
    for(const n of LEGACY)require(canonical(a.baseline.tables["public."+n])===canonical(a.final.tables["public."+n])&&canonical(a.baseline.tables["public."+n])===canonical(live.tables["public."+n]),`Legacy definition changed: ${n}`);
    // Compare every stored structural field against actual typed declarations,
    // not an independently maintained hardcoded SQL fixture.
    for(const [key,value] of Object.entries(live)){
      if(["id","prevId","_meta"].includes(key))continue;
      require(canonical((a.final as unknown as Record<string,unknown>)[key])===canonical(value),`Snapshot/source mismatch: ${key}`);
      if(key!=="tables")require(canonical((a.baseline as unknown as Record<string,unknown>)[key])===canonical(value),`Unexpected non-table baseline change: ${key}`);
    }
    for(const n of ADDED){
      const t=a.final.tables["public."+n];if(!t){issues.push(`Missing table ${n}`);continue;}
      const fks=Object.values(t.foreignKeys);
      require(t.columns.org_id?.notNull,`${n}: org_id must be NOT NULL`);
      if(n!=="organizations")require(fks.some(f=>f.tableTo==="organizations"&&canonical(f.columnsFrom)==='["org_id"]'&&canonical(f.columnsTo)==='["org_id"]'),`${n}: missing direct organization FK`);
      for(const f of fks)require(f.tableFrom===n&&f.onDelete==="no action"&&f.onUpdate==="no action",`${n}: destructive/mismatched FK action`);
    }
    const fk=(table:string,target:string,from:string[],to=from)=>require(Object.values(a.final.tables["public."+table]?.foreignKeys??{}).some(f=>f.tableTo===target&&canonical(f.columnsFrom)===canonical(from)&&canonical(f.columnsTo)===canonical(to)),`${table}: missing/mis-scoped FK to ${target}`);
    fk("organization_members","users",["user_id"],["id"]);
    fk("domains","organization_members",scope.slice(0,2),["org_id","user_id"]);
    fk("policy_versions","domains",scope);
    fk("policy_versions","policy_versions",[...scope,"previous_version_id"],policy);
    for(const n of ["dimension_definitions","observations","evaluation_results"])fk(n,"policy_versions",policy);
    fk("deviations_v2","organization_members",scope.slice(0,2),["org_id","user_id"]);
    fk("deviation_domains","deviations_v2",["org_id","owner_user_id","deviation_id"]);
    fk("deviation_domains","domains",scope);fk("source_bindings","domains",scope);
    fk("audit_events","organization_members",["org_id","actor_user_id"],["org_id","user_id"]);
    const uniq=(n:string,cols:string[])=>require(Object.values(a.final.tables["public."+n]?.uniqueConstraints??{}).some(u=>canonical(u.columns)===canonical(cols)),`${n}: missing required uniqueness ${cols}`);
    uniq("domains",scope);uniq("domains",["org_id","slug"]);uniq("policy_versions",policy);uniq("policy_versions",["org_id","domain_id","revision"]);
    uniq("observations",["idempotency_key"]);uniq("observations",[...scope,"legacy_source_type","legacy_source_id"]);
    uniq("evaluation_results",["org_id","domain_id","window_start","window_end","policy_version_id","calculation_version"]);
    uniq("deviations_v2",["org_id","owner_user_id","deviation_id"]);uniq("source_bindings",["org_id","source_kind","external_id"]);
    require(a.final.tables["public.organizations"]?.columns.rollout_mode.default==="'legacy'","Missing legacy rollout default");
    const evaluation=a.final.tables["public.evaluation_results"];
    require(evaluation?.columns.eligible_days.type==="numeric","Eligibility must be unconstrained numeric, never integer or fixed-scale");
    require(evaluation?.checkConstraints.evaluation_eligible?.value ===
      `"evaluation_results"."eligible_days">=0 AND "evaluation_results"."eligible_days"::text NOT IN ('NaN','Infinity','-Infinity')`,
      "Eligibility requires finite nonnegative numeric CHECK");
    require(a.final.tables["public.observations"]?.columns.is_anomaly.default===false,"Missing anomaly default");
    require(a.final.tables["public.evaluation_results"]?.columns.budget_enabled_snapshot.default===false,"Missing disabled budget default");
    // SQL is separately inspected; a valid snapshot cannot mask dangerous SQL.
    const actual=statements(a.deltaSql),created:string[]=[];
    for(const s of actual){
      const create=s.match(/^CREATE TABLE "([a-z_][a-z_0-9]*)" \([\s\S]*\)$/);
      const alter=s.match(/^ALTER TABLE "([a-z_][a-z_0-9]*)" ADD CONSTRAINT "[a-z_0-9]+" FOREIGN KEY \([\s\S]*\) REFERENCES "public"\."[a-z_0-9]+"[\s\S]* ON DELETE no action ON UPDATE no action$/);
      const index=s.match(/^CREATE (?:UNIQUE )?INDEX "[a-z_0-9]+" ON "([a-z_][a-z_0-9]*)" USING btree \([\s\S]*\)$/);
      const target=create?.[1]??alter?.[1]??index?.[1];
      require(target&&ADDED.includes(target),"Non-allowlisted/legacy SQL statement: "+s.slice(0,110));
      if(create)created.push(create[1]);
    }
    require(canonical(created.sort())===canonical([...ADDED].sort()),"SQL must create exactly eleven new tables once");
    if(issues.length)return {success:false,issues};
    const expected=await generateMigration(a.baseline as DrizzleSnapshotJSON,a.final as DrizzleSnapshotJSON);
    require(canonical(actual.map(normalize))===canonical(statements(expected.join(";\n")+";").map(normalize)),"SQL differs from snapshot-generated DDL (columns/checks/defaults/FKs/indexes)");
    const delta=await generateMigration(a.final as DrizzleSnapshotJSON,live as DrizzleSnapshotJSON);
    require(delta.length===0,"Subsequent schema delta is not empty");
  }catch(e){issues.push(`Malformed artifacts: ${e instanceof Error?e.message:String(e)}`);}
  return {success:issues.length===0,issues};
}

export const QUERY_TEMPLATES = `-- PRINT ONLY: never executed by this tool.
-- SOMR-429: compare ALL catalog fields to the captured six-table baseline;
-- inspect both existing Replit-managed ledger and public.__drizzle_migrations.
SELECT table_schema,table_name,column_name,data_type,is_nullable,column_default
FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position;
SELECT ns.nspname,cl.relname,co.conname,pg_get_constraintdef(co.oid)
FROM pg_constraint co JOIN pg_class cl ON cl.oid=co.conrelid
JOIN pg_namespace ns ON ns.oid=cl.relnamespace WHERE ns.nspname='public';
SELECT schemaname,tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public';
SELECT schemaname,tablename FROM pg_tables WHERE tablename='__drizzle_migrations';
-- Only after locating and validating each ledger: SELECT * FROM <verified ledger>;
-- SOMR-431 canonical backfill/owner mapping is FUTURE, NOT implemented here.
-- Reject unowned or unknown-user rows; never infer an owner or organization.
SELECT s.id,s.user_id,s.domain FROM sessions s LEFT JOIN users u ON u.id=s.user_id
WHERE s.user_id IS NULL OR u.id IS NULL;
SELECT user_id,domain,
 count(*) FILTER(WHERE deleted_at IS NULL) AS active_count,
 count(*) FILTER(WHERE deleted_at IS NOT NULL) AS deleted_count,
 count(*) FILTER(WHERE is_anomaly) AS anomaly_count,
 count(*) FILTER(WHERE anomaly_note IS NOT NULL) AS anomaly_note_count,
 count(*) FILTER(WHERE notes IS NOT NULL) AS note_count,
 sum(duration_minutes) AS duration_total,
 sum(duration_minutes) FILTER(WHERE deleted_at IS NULL) AS active_duration_total,
 sum(duration_minutes) FILTER(WHERE deleted_at IS NOT NULL) AS deleted_duration_total
FROM sessions GROUP BY user_id,domain ORDER BY user_id,domain;
SELECT s.domain,e.user_id,count(*) AS edit_count FROM session_edits e
LEFT JOIN sessions s ON s.id=e.session_id GROUP BY s.domain,e.user_id;
SELECT e.id,e.session_id,e.user_id FROM session_edits e
LEFT JOIN sessions s ON s.id=e.session_id
WHERE s.id IS NULL OR s.user_id IS NULL OR e.user_id<>s.user_id;
-- After APPROVED explicit mapping only; parameters are never guessed:
-- mapping(legacy_user_id,org_id,owner_user_id,legacy_domain,domain_id)
-- must be complete, unambiguous and agree with membership and domain ownership.
-- $1 is an EXPLICIT externally reviewed mapping array, not generated defaults.
WITH approved_mapping AS (
 SELECT * FROM jsonb_to_recordset($1::jsonb) AS m(legacy_user_id text,
 org_id text,owner_user_id text,legacy_domain text,domain_id text)
)
SELECT m.* FROM approved_mapping m
LEFT JOIN organization_members om ON om.org_id=m.org_id AND om.user_id=m.owner_user_id
LEFT JOIN domains d ON d.domain_id=m.domain_id AND d.org_id=m.org_id AND d.owner_user_id=m.owner_user_id
WHERE om.user_id IS NULL OR d.domain_id IS NULL OR m.legacy_user_id IS NULL;
WITH approved_mapping AS (
 SELECT * FROM jsonb_to_recordset($1::jsonb) AS m(legacy_user_id text,
 org_id text,owner_user_id text,legacy_domain text,domain_id text)
)
SELECT s.user_id,s.domain,count(DISTINCT s.id) AS source_rows,count(m.domain_id) AS mapping_matches
FROM sessions s LEFT JOIN approved_mapping m
ON m.legacy_user_id=s.user_id AND m.legacy_domain=s.domain
GROUP BY s.user_id,s.domain
HAVING count(m.domain_id)<>count(DISTINCT s.id);
-- Compare per-domain edit IDs with audit_events using approved entity_type/action
-- and approved provenance rules; no assumed action names or invented audit events.
-- $2 is the separately approved explicit edit-to-audit mapping, FUTURE431.
WITH approved_edit_audit AS (
 SELECT * FROM jsonb_to_recordset($2::jsonb)
 AS m(legacy_edit_id text,audit_event_id text)
)
SELECT s.domain,e.user_id,count(DISTINCT e.id) AS legacy_edits,
count(DISTINCT a.audit_event_id) AS mapped_audit_events
FROM session_edits e LEFT JOIN sessions s ON s.id=e.session_id
LEFT JOIN approved_edit_audit m ON m.legacy_edit_id=e.id
LEFT JOIN audit_events a ON a.audit_event_id=m.audit_event_id
GROUP BY s.domain,e.user_id;
SELECT org_id,entity_type,entity_id,action,count(*) FROM audit_events
GROUP BY org_id,entity_type,entity_id,action;
SELECT org_id,owner_user_id,domain_id,legacy_source_type,count(*)
FROM observations GROUP BY org_id,owner_user_id,domain_id,legacy_source_type;
`;
async function main(){
  const args=process.argv.slice(2);
  if(args.length!==2||args[0]!=="--mode"||!["static","queries"].includes(args[1]))throw new Error("Use --mode static or --mode queries; no application mode exists");
  if(args[1]==="queries"){console.log(QUERY_TEMPLATES);return;}
  const result=await validateArtifacts(loadArtifacts());console.log(JSON.stringify(result,null,2));
  if(!result.success)process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  main().catch(e=>{console.error(e instanceof Error?e.message:String(e));process.exitCode=1;});