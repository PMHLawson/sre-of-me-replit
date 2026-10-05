const {Client}=require('pg');
// PostgreSQL catalog name[] (OID 1003) is not parsed by pg by default.
require('pg').types.setTypeParser(1003,require('pg').types.getTypeParser(1009));
const {crypto,assert,fs,accepted,save}=require('./common.cjs');
const LEGACY=['deviations','http_sessions','session_edits','sessions','user_settings','users'];
const quote=s=>{assert.match(s,/^[A-Za-z_][A-Za-z_0-9]*$/);return '"'+s+'"';};
const QUERIES={
 binding:`SELECT md5(current_database()) AS database_fingerprint,md5(coalesce(inet_server_addr()::text,'unix-socket')||':'||coalesce(inet_server_port()::text,'')) AS endpoint_fingerprint,md5(current_user) AS role_fingerprint,current_setting('transaction_read_only') AS read_only,current_setting('server_version') AS server_version`,
 tables:`SELECT n.nspname AS schema,c.relname AS name,c.relkind,c.relrowsecurity AS rls,c.relforcerowsecurity AS force_rls,md5(pg_get_userbyid(c.relowner)) AS owner,c.relreplident FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast' AND c.relkind IN ('r','p','v','m','f','S') ORDER BY 1,2`,
 columns:`SELECT n.nspname AS schema,c.relname AS table,a.attname AS name,a.attnum AS ordinal,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS not_null,pg_get_expr(d.adbin,d.adrelid) AS default_expr,a.attidentity AS identity,a.attgenerated AS generated,coll.collname AS collation FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum LEFT JOIN pg_collation coll ON coll.oid=a.attcollation WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast' AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped ORDER BY 1,2,a.attnum`,
 constraints:`SELECT n.nspname AS schema,c.relname AS table,co.conname AS name,co.contype AS type,pg_get_constraintdef(co.oid) AS definition,co.convalidated AS validated,co.condeferrable AS deferrable,co.condeferred AS deferred,co.confupdtype AS update_action,co.confdeltype AS delete_action,co.confmatchtype AS match_type,nt.nspname AS target_schema,ct.relname AS target_table,ARRAY(SELECT a.attname FROM unnest(co.conkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.num ORDER BY ord) AS columns,ARRAY(SELECT a.attname FROM unnest(co.confkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid=ct.oid AND a.attnum=k.num ORDER BY ord) AS target_columns FROM pg_constraint co JOIN pg_class c ON c.oid=co.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_class ct ON ct.oid=co.confrelid LEFT JOIN pg_namespace nt ON nt.oid=ct.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast' ORDER BY 1,2,3`,
 indexes:`SELECT n.nspname AS schema,t.relname AS table,c.relname AS name,pg_get_indexdef(i.indexrelid) AS definition,am.amname AS method,i.indisunique AS unique,i.indisprimary AS primary,i.indisvalid AS valid,i.indisready AS ready,i.indislive AS live,i.indnullsnotdistinct AS nulls_not_distinct,pg_get_expr(i.indexprs,i.indrelid) AS expressions,pg_get_expr(i.indpred,i.indrelid) AS predicate,ARRAY(SELECT opc.opcname FROM unnest(i.indclass::oid[]) WITH ORDINALITY o(oid,ord) JOIN pg_opclass opc ON opc.oid=o.oid ORDER BY ord) AS opclasses,i.indoption::text AS options FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace JOIN pg_am am ON am.oid=c.relam WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast' ORDER BY 1,2,3`,
 triggers:`SELECT n.nspname AS schema,c.relname AS table,t.tgname AS name,t.tgenabled AS enabled,t.tgisinternal AS internal,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast' ORDER BY 1,2,3`,
 policies:`SELECT schemaname AS schema,tablename AS table,policyname,permissive,cmd,qual,with_check,ARRAY(SELECT md5(x) FROM unnest(roles::text[]) x) AS role_fingerprints FROM pg_policies ORDER BY 1,2,3`,
 acl:`SELECT n.nspname AS schema,c.relname AS table,CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE md5(pg_get_userbyid(a.grantee)) END AS grantee,a.privilege_type,a.is_grantable FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast' AND c.relkind IN ('r','p') ORDER BY 1,2,3,4`,
 column_acl:`SELECT n.nspname AS schema,c.relname AS table,att.attname AS column,CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE md5(pg_get_userbyid(a.grantee)) END AS grantee,a.privilege_type,a.is_grantable FROM pg_attribute att JOIN pg_class c ON c.oid=att.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(att.attacl) a WHERE n.nspname NOT IN ('pg_catalog','information_schema') ORDER BY 1,2,3,4,5`,
 default_acl:`SELECT coalesce(n.nspname,'ALL') AS schema,md5(pg_get_userbyid(d.defaclrole)) AS owner,d.defaclobjtype,CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE md5(pg_get_userbyid(a.grantee)) END AS grantee,a.privilege_type,a.is_grantable FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace CROSS JOIN LATERAL aclexplode(d.defaclacl) a ORDER BY 1,2,3,4,5`,
 schema_acl:`SELECT n.nspname AS schema,CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE md5(pg_get_userbyid(a.grantee)) END AS grantee,a.privilege_type,a.is_grantable FROM pg_namespace n CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a WHERE n.nspname NOT IN ('pg_catalog','information_schema','pg_toast') ORDER BY 1,2,3`,
 extensions:`SELECT extname,extversion,n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace ORDER BY 1`,
 ledger_locations:`SELECT n.nspname AS schema,c.relname AS name,c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relname ILIKE '%migrat%' OR n.nspname ILIKE '%replit%' ORDER BY 1,2`,
 schemas:`SELECT nspname FROM pg_namespace ORDER BY 1`,
 writers:`SELECT backend_type,state,count(*)::int AS connections FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() GROUP BY backend_type,state ORDER BY 1,2`
};
function norm(v){return String(v??'').replace(/character varying/g,'varchar').replace(/timestamp without time zone/g,'timestamp').replace(/('(?:[^']|'')*')::text/g,'$1').replace(/\s+/g,' ').trim();}
function baselineCheck(cat){
 const snapshot=JSON.parse(fs.readFileSync(accepted+'/migrations/meta/0000_snapshot.json'));
 const issues=[];
 for(const t of Object.values(snapshot.tables)){
  const cols=cat.columns.filter(c=>c.schema==='public'&&c.table===t.name);
  if(cols.length!==Object.keys(t.columns).length)issues.push(t.name+': column count');
  for(const [n,c] of Object.entries(t.columns)){
   const a=cols.find(x=>x.name===n);
   if(!a||norm(a.type)!==norm(c.type)||a.not_null!==c.notNull||norm(a.default_expr)!==norm(c.default)||a.identity||a.generated)issues.push(t.name+'.'+n+': column mismatch');
  }
  const cons=cat.constraints.filter(c=>c.schema==='public'&&c.table===t.name);
  const pk=Object.entries(t.columns).filter(([n,c])=>c.primaryKey).map(([n])=>n);
  assert(pk.length===1);
  if(!cons.some(c=>c.type==='p'&&JSON.stringify(c.columns)===JSON.stringify(pk)))issues.push(t.name+': PK');
  const uniques=Object.values(t.uniqueConstraints);
  for(const u of uniques)if(!cons.some(c=>c.name===u.name&&c.type==='u'&&JSON.stringify(c.columns)===JSON.stringify(u.columns)))issues.push(t.name+': unique');
  if(cons.length!==1+uniques.length||cons.some(c=>!c.validated||c.deferrable||c.deferred))issues.push(t.name+': constraints');
  const ix=cat.indexes.filter(c=>c.schema==='public'&&c.table===t.name);
  const expected=[{name:t.name+'_pkey',cols:pk,unique:true},...uniques.map(u=>({name:u.name,cols:u.columns,unique:true})),...Object.values(t.indexes).map(i=>({name:i.name,cols:i.columns.map(x=>x.expression),unique:i.isUnique}))];
  if(ix.length!==expected.length)issues.push(t.name+': index count');
  for(const e of expected){const i=ix.find(x=>x.name===e.name);const ops=e.cols.map(n=>norm(t.columns[n].type)==='timestamp'?'timestamp_ops':'text_ops');
   if(!i||!i.valid||!i.ready||!i.live||i.unique!==e.unique||i.nulls_not_distinct||i.predicate||i.expressions||i.method!=='btree'||i.options!=='0'||JSON.stringify(i.opclasses)!==JSON.stringify(ops)||!i.definition.endsWith('('+e.cols.join(', ')+')'))issues.push(t.name+': index '+e.name);}
  const table=cat.tables.find(x=>x.schema==='public'&&x.name===t.name);
  if(!table||table.rls||table.force_rls||table.relkind!=='r')issues.push(t.name+': RLS/table');
 }
 if(cat.triggers.some(t=>LEGACY.includes(t.table))||cat.policies.some(t=>LEGACY.includes(t.table)))issues.push('Unexpected legacy trigger/policy');
 if(cat.default_acl.length)issues.push('Unreviewed default ACL');
 return {success:issues.length===0,issues,normalization:'Only varchar/timestamp aliases, string-literal ::text casts, whitespace. ACL/extensions retained separately: snapshot does not specify them.'};
}
function bindingCheck(actual,expected){assert(expected&&actual&&expected.database_fingerprint&&expected.endpoint_fingerprint);for(const k of ['database_fingerprint','endpoint_fingerprint','role_fingerprint'])assert.equal(actual[k],expected[k],'Binding mismatch: '+k);assert.equal(actual.read_only,'on');}
function ledgerCheck(rows,expected,mode){if(mode==='absent'){assert.equal(rows.length,0,'Unexpected ledger');return;}assert.deepEqual(rows.map(r=>({hash:r.hash,created_at:String(r.created_at)})),expected.map(r=>({hash:r.hash,created_at:String(r.created_at)})),'Conflicting ledger');}
const frame=(h,v)=>{const b=Buffer.from(v);const length=Buffer.alloc(8);length.writeBigUInt64BE(BigInt(b.length));h.update(length).update(b);};
async function fingerprints(c,key,tables=LEGACY){
 const result={};
 for(const t of tables){
  const pk=t==='http_sessions'?'sid':t==='user_settings'?'user_id':'id';
  const ids=crypto.createHmac('sha256',key),content=crypto.createHmac('sha256',key);frame(ids,t+':identities:v1');frame(content,t+':content:v1');
  let count=0;await c.query(`DECLARE fp_cursor NO SCROLL CURSOR FOR SELECT jsonb_build_array(t.${quote(pk)})::text AS identity,to_jsonb(t)::text AS content FROM public.${quote(t)} t ORDER BY t.${quote(pk)} COLLATE "C"`);
  try{while(true){const r=await c.query('FETCH FORWARD 100 FROM fp_cursor');if(!r.rows.length)break;for(const row of r.rows){frame(ids,row.identity);frame(content,row.content);count++;}}}finally{await c.query('CLOSE fp_cursor');}
  frame(ids,String(count));frame(content,String(count));result[t]={count,identityHmac:ids.digest('hex'),contentHmac:content.digest('hex')};
 }return result;
}
async function inspect(c){const cat={};for(const [k,q]of Object.entries(QUERIES))cat[k]=(await c.query(q)).rows;return cat;}
const startup='-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=2000 -c idle_in_transaction_session_timeout=15000 -c timezone=UTC -c datestyle=ISO,YMD';
async function readOnly(config,fn){
 const c=new Client({...config,connectionTimeoutMillis:5000,options:startup});const timer=setTimeout(()=>c.end().catch(()=>{}),60000);
 try{await c.connect();await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const r=await c.query("SELECT current_setting('transaction_read_only') AS ro");assert.equal(r.rows[0].ro,'on');return await fn(c);}
 finally{clearTimeout(timer);try{await c.query('ROLLBACK');}catch{}await c.end().catch(()=>{});}
}
module.exports={LEGACY,QUERIES,quote,norm,baselineCheck,bindingCheck,ledgerCheck,fingerprints,inspect,readOnly};