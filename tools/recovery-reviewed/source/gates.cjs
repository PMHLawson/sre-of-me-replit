const {assert,fs,accepted,save,inventory,sha}=require('./common.cjs');
const base=require('./catalog.cjs');
const triggerSQL=`SELECT t.tgtype::int AS event_type,t.tgenabled AS enabled,t.tgisinternal AS internal,n.nspname AS schema,c.relname AS table,t.tgname AS name,pg_get_triggerdef(t.oid) AS definition,
pn.nspname AS function_schema,p.proname AS function_name,co.conname AS constraint_name,co.contype AS constraint_type,co.confupdtype AS update_action,co.confdeltype AS delete_action,co.confmatchtype AS match_type,co.convalidated AS validated,co.condeferrable AS deferrable,co.condeferred AS deferred,
sn.nspname AS source_schema,sc.relname AS source_table,tn.nspname AS target_schema,tc.relname AS target_table,
ARRAY(SELECT a.attname FROM unnest(co.conkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid=co.conrelid AND a.attnum=k.num ORDER BY ord) AS source_columns,
ARRAY(SELECT a.attname FROM unnest(co.confkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid=co.confrelid AND a.attnum=k.num ORDER BY ord) AS target_columns
FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace pn ON pn.oid=p.pronamespace
LEFT JOIN pg_constraint co ON co.oid=t.tgconstraint
LEFT JOIN pg_class sc ON sc.oid=co.conrelid LEFT JOIN pg_namespace sn ON sn.oid=sc.relnamespace
LEFT JOIN pg_class tc ON tc.oid=co.confrelid LEFT JOIN pg_namespace tn ON tn.oid=tc.relnamespace
WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast' ORDER BY 1,3,4,5,6`;
base.QUERIES.triggers=triggerSQL;
base.QUERIES.dropped=`SELECT n.nspname AS schema,c.relname AS table,a.attnum FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE a.attisdropped AND n.nspname='public' ORDER BY 1,2,3`;
const stable=t=>({...t,name:t.name.replace(/^(RI_ConstraintTrigger_[ac])_\d+$/,'$1_<OID>'),definition:t.definition.replace(/(RI_ConstraintTrigger_[ac])_\d+/g,'$1_<OID>')});
function triggers(cat,post){
 const a=cat.triggers.filter(t=>base.LEGACY.includes(t.table));
 if(!post){assert.equal(a.length,0);return;}
 assert.equal(a.length,2);
 for(const [event,fn,type]of [['DELETE','del',9],['UPDATE','upd',17]]){
 const t=a.find(x=>x.event_type===type);assert(t);
 for(const [k,v]of Object.entries({schema:'public',table:'users',internal:true,enabled:'O',function_schema:'pg_catalog',function_name:'RI_FKey_noaction_'+fn,constraint_name:'organization_members_user_id_users_id_fk',constraint_type:'f',update_action:'a',delete_action:'a',match_type:'s',validated:true,deferrable:false,deferred:false,source_schema:'public',source_table:'organization_members',target_schema:'public',target_table:'users'}))assert.equal(t[k],v,k);
 assert.deepEqual(t.source_columns,['user_id']);assert.deepEqual(t.target_columns,['id']);
 assert.match(t.name,/^RI_ConstraintTrigger_a_\d+$/);
 assert.equal(stable(t).definition,`CREATE CONSTRAINT TRIGGER "RI_ConstraintTrigger_a_<OID>" AFTER ${event} ON public.users FROM organization_members NOT DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION "RI_FKey_noaction_${fn}"()`);
 }
}
function gate(cat,post=false,before){
 triggers(cat,post);
 const adjusted=structuredClone(cat);adjusted.triggers=adjusted.triggers.filter(t=>!base.LEGACY.includes(t.table));
 assert(base.baselineCheck(adjusted).success);
 const snap=JSON.parse(fs.readFileSync(accepted+'/migrations/meta/'+(post?'0001':'0000')+'_snapshot.json'));
 const names=Object.values(snap.tables).map(t=>'public.'+t.name+':r');
 if(post)names.push('public.__drizzle_migrations:r','public.__drizzle_migrations_id_seq:S');
 assert.deepEqual(cat.tables.map(t=>t.schema+'.'+t.name+':'+t.relkind).sort(),names.sort());
 assert.deepEqual(cat.schemas.map(x=>x.nspname).sort(),['information_schema','pg_catalog','pg_toast','public'].sort());
 assert.deepEqual(cat.dropped,[]);
 for(const t of Object.values(snap.tables).filter(t=>base.LEGACY.includes(t.name))){
 const cols=cat.columns.filter(c=>c.schema==='public'&&c.table===t.name);
 assert.deepEqual(cols.map(c=>c.name).sort(),Object.keys(t.columns).sort());
 assert.deepEqual(cols.map(c=>c.ordinal).sort((a,b)=>a-b),cols.map((c,i)=>i+1));
 Object.values(t.columns).forEach(c=>{const actual=cols.find(x=>x.name===c.name);assert.equal(actual.collation,/varchar|text/.test(c.type)?'default':null);});
 const pk=cat.constraints.find(c=>c.schema==='public'&&c.table===t.name&&c.type==='p');assert.equal(pk.name,t.name+'_pkey');
 for(const ix of cat.indexes.filter(x=>x.schema==='public'&&x.table===t.name))assert.equal(ix.primary,ix.name===t.name+'_pkey');
 assert.equal(cat.tables.find(x=>x.name===t.name).relreplident,'d');
 }
 assert.deepEqual(cat.ledger_locations,post?[{schema:'public',name:'__drizzle_migrations',relkind:'r'},{schema:'public',name:'__drizzle_migrations_id_seq',relkind:'S'},{schema:'public',name:'__drizzle_migrations_pkey',relkind:'i'}]:[]);
 assert.deepEqual(cat.extensions.map(x=>x.extname),['plpgsql']);
 if(before){
 for(const f of ['schema_acl','default_acl','extensions'])assert.deepEqual(cat[f],before[f],f);
 for(const f of ['acl','column_acl','tables','columns','constraints','indexes','policies']){
 const filter=a=>a.filter(x=>x.schema==='public'&&base.LEGACY.includes(x.table??x.name));
 assert.deepEqual(filter(cat[f]),filter(before[f]),f);
 }
 }
 return true;
}
function sourceGate(){
 const inv=inventory(),r=inv.repos.find(x=>x.name==='accepted');
 assert.equal(r.head.trim(),'725e1afe67278799c249c1331acded4cc46d4cb2');assert.equal(r.tree.trim(),'a2be3271b687cef5426f7a5ec8c2d45e3bff5152');
 const sealed=JSON.parse(fs.readFileSync('.local/review/somr428-generation/inventory.json'));
 assert.equal(sealed.length,11);for(const f of sealed)assert.equal(sha(fs.readFileSync(accepted+'/'+f.path)),f.sha256);
 return {inv,sealed:sealed.map(({path,sha256,bytes})=>({path,sha256,bytes}))};
}
module.exports={gate,stable,sourceGate};