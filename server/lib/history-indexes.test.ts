import { beforeAll,afterAll,it,expect } from "vitest";
import { readFileSync } from "node:fs";
import { startFixture } from "./ownership-fixture";

let fixture:Awaited<ReturnType<typeof startFixture>>;
const expected={
 sessions_owner_active_history_idx:{table:"sessions",columns:["user_id","timestamp","id"],options:[0,3,3],predicate:"deleted_atisnull"},
 sessions_owner_deleted_history_idx:{table:"sessions",columns:["user_id","deleted_at","id"],options:[0,3,3],predicate:"deleted_atisnotnull"},
 deviations_owner_history_idx:{table:"deviations",columns:["user_id","start_at","id"],options:[0,3,3],predicate:"deleted_atisnull"},
 organization_members_user_scope_idx:{table:"organization_members",columns:["user_id","org_id"],options:[0,0],predicate:null},
 audit_events_actor_history_idx:{table:"audit_events",columns:["org_id","actor_user_id","occurred_at","audit_event_id"],options:[0,0,0,0],predicate:null},
};
beforeAll(async()=>{
 fixture=await startFixture("bounded-history-index-evidence");
 await fixture.client.query(readFileSync("script/sql/bounded-history-read-indexes.sql","utf8"));
 await fixture.client.query(`INSERT INTO users(id) VALUES('index-owner');
 INSERT INTO users(id) SELECT 'index-other-'||n FROM generate_series(1,32)n;
 INSERT INTO sessions(id,user_id,domain,duration_minutes,timestamp,deleted_at)
 SELECT 'index-other-'||owner_number||'-'||entry_number,'index-other-'||owner_number,'meditation',10,
  '2020-01-01'::timestamptz+entry_number*interval '1 day',
  CASE WHEN entry_number%7=0 THEN '2020-01-01'::timestamptz+entry_number*interval '1 day'+interval '1 hour' ELSE NULL END
 FROM generate_series(1,32)owner_number CROSS JOIN generate_series(1,2000)entry_number;
 INSERT INTO sessions(id,user_id,domain,duration_minutes,timestamp,deleted_at)
 SELECT 'index-owned-'||entry_number,'index-owner','meditation',10,
  '2020-01-01'::timestamptz+entry_number*interval '1 day',
  CASE WHEN entry_number%7=0 THEN '2020-01-01'::timestamptz+entry_number*interval '1 day'+interval '1 hour' ELSE NULL END
 FROM generate_series(1,6000)entry_number;
 INSERT INTO deviations(id,user_id,domain,reason,start_at)
 SELECT 'index-deviation-other-'||owner_number||'-'||entry_number,'index-other-'||owner_number,'meditation','synthetic',
  '2020-01-01'::timestamptz+entry_number*interval '1 day'
 FROM generate_series(1,32)owner_number CROSS JOIN generate_series(1,120)entry_number;
 INSERT INTO deviations(id,user_id,domain,reason,start_at)
 SELECT 'index-deviation-owned-'||entry_number,'index-owner','meditation','synthetic',
  '2020-01-01'::timestamptz+entry_number*interval '1 day' FROM generate_series(1,1200)entry_number;
 ANALYZE public.sessions; ANALYZE public.deviations;`);
},60000);
afterAll(async()=>{if(fixture)await fixture.cleanup();},60000);

it("proves exact public-table, btree, ordered-key, direction, predicate and valid/ready definitions",async()=>{
 const rows=(await fixture.client.query(`SELECT index_relation.relname AS name,index_namespace.nspname AS index_schema,
  table_namespace.nspname AS table_schema,table_relation.relname AS table_name,access_method.amname AS access_method,
  i.indisvalid,i.indisready,i.indisunique,i.indnkeyatts,i.indnatts,
  ARRAY(SELECT attribute.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum,ordinality)
   JOIN pg_attribute attribute ON attribute.attrelid=i.indrelid AND attribute.attnum=k.attnum ORDER BY k.ordinality) AS columns,
  ARRAY(SELECT option_value::int FROM unnest(i.indoption::smallint[]) WITH ORDINALITY opt(option_value,ordinality)
   ORDER BY opt.ordinality) AS options,
  pg_get_expr(i.indpred,i.indrelid) AS predicate,pg_get_indexdef(i.indexrelid) AS definition
 FROM pg_index i JOIN pg_class index_relation ON index_relation.oid=i.indexrelid
 JOIN pg_namespace index_namespace ON index_namespace.oid=index_relation.relnamespace
 JOIN pg_class table_relation ON table_relation.oid=i.indrelid
 JOIN pg_namespace table_namespace ON table_namespace.oid=table_relation.relnamespace
 JOIN pg_am access_method ON access_method.oid=index_relation.relam
 WHERE index_relation.relname=ANY($1::text[]) ORDER BY index_relation.relname`,[Object.keys(expected)])).rows;
 expect(rows).toHaveLength(5);
 for(const row of rows){
  const definition=expected[row.name as keyof typeof expected];
  expect(row.index_schema).toBe("public");expect(row.table_schema).toBe("public");
  expect(row.table_name).toBe(definition.table);expect(row.access_method).toBe("btree");
  expect(row.indisvalid).toBe(true);expect(row.indisready).toBe(true);expect(row.indisunique).toBe(false);
  expect(row.indnkeyatts).toBe(definition.columns.length);expect(row.indnatts).toBe(definition.columns.length);
  expect(row.columns).toEqual(definition.columns);expect(row.options).toEqual(definition.options);
  expect(row.predicate===null?null:row.predicate.replace(/[()\s]/g,"").toLowerCase()).toBe(definition.predicate);
  expect(row.definition).toContain("CREATE INDEX "+row.name+" ON public."+definition.table+" USING btree");
 }
 console.info("SOMR-467_INDEX_DEFINITION_EVIDENCE",JSON.stringify(rows));
});

type PlanNode={Plans?:PlanNode[];[key:string]:any};
function nodes(node:PlanNode):PlanNode[]{return [node,...(node.Plans??[]).flatMap(nodes)];}
async function explain(name:string,sql:string,values:unknown[],index:string,limit:number){
 // Actual bounded SELECT shape and its normal planner; never force index use.
 const response=await fixture.client.query("EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) "+sql,values);
 const evidence=response.rows[0]["QUERY PLAN"][0],plan=evidence.Plan as PlanNode,all=nodes(plan);
 expect(plan["Node Type"]).toBe("Limit");expect(plan["Actual Rows"]).toBeLessThanOrEqual(limit);
 expect(plan["Plan Rows"]).toBeLessThanOrEqual(limit);
 expect(all.some(node=>node["Index Name"]===index),name).toBe(true);
 console.info("SOMR-467_INDEX_PLAN_EVIDENCE",JSON.stringify({name,limit,index,evidence}));
}
it("uses owner keysets and bounded range limits on large skewed synthetic history without planner overrides",async()=>{
 const before=(await fixture.client.query("SELECT count(*)::int AS n FROM sessions")).rows[0].n;
 expect(before).toBe(70000);
 await explain("active owner page",`SELECT s.id,s.user_id AS "userId",s.domain,s.duration_minutes AS "durationMinutes",s.timestamp,
  s.deleted_at AS "deletedAt",s.is_anomaly AS "isAnomaly",s.notes IS NOT NULL AS "hasNotes",
  COALESCE(octet_length(s.notes),0) AS "notesBytes" FROM public.sessions s
  WHERE s.user_id=$1 AND s.deleted_at IS NULL
  AND ($2::timestamptz IS NULL OR (s.timestamp,s.id)<($2::timestamptz,$3::varchar))
  ORDER BY s.timestamp DESC,s.id DESC LIMIT $4`,
 ["index-owner","2036-01-01T00:00:00.123456Z","index-owned-5900",101],"sessions_owner_active_history_idx",101);
 await explain("owner completed-window range",`SELECT s.id,s.user_id AS "userId",s.domain,s.duration_minutes AS "durationMinutes",s.timestamp,
  s.is_anomaly AS "isAnomaly" FROM public.sessions s WHERE s.user_id=$1 AND s.deleted_at IS NULL
  AND s.timestamp>=$2 AND s.timestamp<$3 ORDER BY s.timestamp DESC,s.id DESC LIMIT $4`,
 ["index-owner","2026-07-01T00:00:00Z","2026-10-15T00:00:00Z",2001],"sessions_owner_active_history_idx",2001);
 await explain("deleted owner page",`SELECT s.id,s.timestamp,s.deleted_at FROM public.sessions s
  WHERE s.user_id=$1 AND s.deleted_at IS NOT NULL
  AND ($2::timestamptz IS NULL OR (s.deleted_at,s.id)<($2::timestamptz,$3::varchar))
  ORDER BY s.deleted_at DESC,s.id DESC LIMIT $4`,
 ["index-owner","2036-01-01T00:00:00.123456Z","index-owned-5900",101],"sessions_owner_deleted_history_idx",101);
 await explain("deviation owner page",`SELECT d.id,d.start_at,d.end_at,d.ended_at,d.exclude_from_composite,
  d.reason IS NOT NULL AS "hasReason",COALESCE(octet_length(d.reason),0) AS "reasonBytes"
  FROM public.deviations d WHERE d.user_id=$1 AND d.deleted_at IS NULL
  AND ($2::timestamptz IS NULL OR (d.start_at,d.id)<($2::timestamptz,$3::varchar))
  ORDER BY d.start_at DESC,d.id DESC LIMIT $4`,
 ["index-owner","2026-01-01T00:00:00.123456Z","index-deviation-owned-1200",101],"deviations_owner_history_idx",101);
 expect((await fixture.client.query("SELECT count(*)::int AS n FROM sessions")).rows[0].n).toBe(before);
},30000);
