const assert=require('assert/strict'),crypto=require('crypto');
const {quote,LEGACY}=require('./catalog.cjs');
const KEYS=Object.freeze({
 audit_events:['audit_event_id'],deviation_domains:['deviation_id','domain_id'],
 deviations_v2:['deviation_id'],dimension_definitions:['policy_version_id','measurement_id'],
 domains:['domain_id'],evaluation_results:['result_id'],observations:['observation_id'],
 organization_members:['org_id','user_id'],organizations:['org_id'],
 policy_versions:['policy_version_id'],source_bindings:['binding_id'],__drizzle_migrations:['id']
});
function plans(oracle){
 const tables=[...oracle.catalog.tables,...oracle.ledger.tables];
 const columns=[...oracle.catalog.columns,...oracle.ledger.columns];
 const constraints=[...oracle.catalog.constraints,...oracle.ledger.constraints];
 const allowed=[...LEGACY,...Object.keys(KEYS),'__drizzle_migrations_id_seq'].sort();
 assert.deepEqual(tables.map(t=>t.name).sort(),allowed,'Unknown/missing/duplicate table');
 assert(tables.every(t=>t.schema==='public'));
 assert(columns.every(c=>c.schema==='public'&&allowed.includes(c.table)));
 assert(constraints.every(c=>c.schema==='public'&&allowed.includes(c.table)));
 return Object.entries(KEYS).map(([table,keys])=>{
 assert.equal(tables.filter(t=>t.schema==='public'&&t.name===table&&t.relkind==='r').length,1,'Table mismatch');
 const primary=constraints.filter(c=>c.schema==='public'&&c.table===table&&c.type==='p');
 assert.equal(primary.length,1,'PK missing/duplicate');assert.deepEqual(primary[0].columns,keys,'PK mismatch');
 const fields=keys.map(name=>{
 const matches=columns.filter(c=>c.schema==='public'&&c.table===table&&c.name===name);
 assert.equal(matches.length,1,'Column missing/duplicate');const c=matches[0];
 assert.equal(c.type,table==='__drizzle_migrations'?'integer':'text','Key type mismatch');assert.equal(c.not_null,true);
 return{expr:'t.'+quote(name),type:c.type};
 });
 return{table,sql:`DECLARE keyed_fp_cursor NO SCROLL CURSOR FOR SELECT jsonb_build_array(${fields.map(f=>f.expr).join(',')})::text AS identity,to_jsonb(t)::text AS content FROM public.${quote(table)} t ORDER BY ${fields.map(f=>f.expr+(f.type==='text'?' COLLATE "C"':'')).join(',')}`};
 });
}
const frame=(h,v)=>{const b=Buffer.from(v),n=Buffer.alloc(8);n.writeBigUInt64BE(BigInt(b.length));h.update(n).update(b);};
async function keyedFingerprints(c,key,oracle){
 const prepared=plans(oracle); // Validate ALL twelve shapes before any query.
 assert(Buffer.isBuffer(key)&&key.length===32);
 const result={};
 for(const {table,sql}of prepared){
 const ids=crypto.createHmac('sha256',key),content=crypto.createHmac('sha256',key);
 frame(ids,table+':identities:v1');frame(content,table+':content:v1');
 let count=0;await c.query(sql);
 try{while(true){const r=await c.query('FETCH FORWARD 100 FROM keyed_fp_cursor');if(!r.rows.length)break;
 for(const row of r.rows){frame(ids,row.identity);frame(content,row.content);count++;}}}
 finally{await c.query('CLOSE keyed_fp_cursor');}
 frame(ids,String(count));frame(content,String(count));result[table]={count,identityHmac:ids.digest('hex'),contentHmac:content.digest('hex')};
 }
 return result;
}
module.exports={keyedFingerprints};