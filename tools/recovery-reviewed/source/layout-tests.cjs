const {assert,fs,accepted}=require('./common.cjs');
const {gate}=require('./gates.cjs');
const {LEGACY}=require('./catalog.cjs');
const fields=['tables','columns','constraints','indexes','policies','acl','column_acl'];
const globalFields=['schemas','schema_acl','default_acl','extensions','dropped'];
const keys={
 tables:['schema','name'],columns:['schema','table','ordinal'],
 constraints:['schema','table','name'],indexes:['schema','table','name'],
 policies:['schema','table','policyname'],acl:['schema','table','grantee','privilege_type'],
 column_acl:['schema','table','column','grantee','privilege_type'],
 triggers:['event_type','internal','schema','table','name'],
 schemas:['nspname'],schema_acl:['schema','grantee','privilege_type'],
 default_acl:['schema','owner','defaclobjtype','grantee','privilege_type'],
 extensions:['extname'],dropped:['schema','table','attnum'],ledger_locations:['schema','name']
};
const cmp=(a,b)=>a===b?0:a==null?1:b==null?-1:a<b?-1:1;
function sort(field,rows){
 assert(keys[field],'Unknown catalog order');
 return [...rows].sort((a,b)=>{
 for(const k of keys[field]){const d=cmp(a[k],b[k]);if(d)return d;}
 // RI OID suffix normalization can collapse names into SQL-order ties.
 // Only ties get a deterministic semantic tiebreaker.
 return cmp(JSON.stringify(a),JSON.stringify(b));
 });
}
function role(cat){
 assert(Array.isArray(cat.binding)&&cat.binding.length===1,'Exactly one binding row required');
 const value=cat.binding[0]?.role_fingerprint;
 assert(typeof value==='string'&&/^[a-f0-9]{32}$/.test(value),'Invalid role fingerprint');
 return value;
}
const legacy=x=>x.schema==='public'&&LEGACY.includes(x.table??x.name);
const ledger=x=>x.schema==='public'&&['__drizzle_migrations','__drizzle_migrations_id_seq'].includes(x.table??x.name);
function mapRoleFields(row,source,target){
 const x=structuredClone(row);
 const mapped=v=>{assert.equal(v,source,'Unresolved synthetic or unreviewed role');return target;};
 if(Object.hasOwn(x,'owner'))x.owner=mapped(x.owner);
 if(Object.hasOwn(x,'grantee')&&x.grantee!=='PUBLIC')x.grantee=mapped(x.grantee);
 if(Object.hasOwn(x,'role_fingerprints'))x.role_fingerprints=x.role_fingerprints.map(mapped);
 return x;
}
function normalizeTrigger(t,after){
 assert(t.internal&&t.enabled==='O'&&t.function_schema==='pg_catalog','Unexpected trigger');
 const con=after.constraints.find(c=>c.schema===t.source_schema&&c.table===t.source_table&&c.name===t.constraint_name);
 assert(con&&con.type==='f'&&con.validated&&!con.deferrable&&!con.deferred);
 assert.equal(t.constraint_type,'f');
 assert.equal(t.target_table,con.target_table);assert.equal(t.target_schema,con.target_schema);
 assert.deepEqual(t.source_columns,con.columns);assert.deepEqual(t.target_columns,con.target_columns);
 for(const k of ['update_action','delete_action','match_type','validated','deferrable','deferred'])assert.equal(t[k],con[k]);
 const spec={RI_FKey_noaction_del:[9,'a'],RI_FKey_noaction_upd:[17,'a'],RI_FKey_check_ins:[5,'c'],RI_FKey_check_upd:[17,'c']};
 const pair=spec[t.function_name];assert(pair);assert.equal(t.event_type,pair[0]);
 assert.equal(t.table,pair[1]==='a'?con.target_table:con.table);
 assert.equal(t.schema,pair[1]==='a'?con.target_schema:con.schema);
 assert.match(t.name,new RegExp('^RI_ConstraintTrigger_'+pair[1]+'_\\d+$'));
 const events={9:'DELETE',17:'UPDATE',5:'INSERT'};
 assert.equal(t.definition,`CREATE CONSTRAINT TRIGGER "${t.name}" AFTER ${events[t.event_type]} ON ${t.schema}.${t.table} FROM ${pair[1]==='a'?con.table:con.target_table} NOT DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION "${t.function_name}"()`);
 return {...t,name:`RI_ConstraintTrigger_${pair[1]}_<OID>`,definition:t.definition.replace('"'+t.name+'"',`"RI_ConstraintTrigger_${pair[1]}_<OID>"`)};
}
function rejectUnresolved(result,source){
 function visit(v){
 if(Array.isArray(v)){v.forEach(visit);return;}
 if(!v||typeof v!=='object')return;
 for(const [k,x]of Object.entries(v)){
 if(['owner','grantee'].includes(k))assert.notEqual(x,source,'Unresolved synthetic role');
 if(k==='role_fingerprints')assert(!x.includes(source),'Unresolved policy role');
 visit(x);
 }
 }
 visit(result);
}
function oracle(after,before,actual,entries){
 const sourceRole=role(after),targetRole=role(actual);assert.notEqual(sourceRole,targetRole,'Role identities must be distinct for this reviewed mapping');
 gate(after,true,before);gate(actual,false);
 const snapshot=JSON.parse(fs.readFileSync(accepted+'/migrations/meta/0001_snapshot.json'));
 const newNames=Object.values(snapshot.tables).map(t=>t.name).filter(n=>!LEGACY.includes(n));
 const catalog={},separate={};
 for(const f of fields){
 const added=after[f].filter(x=>!legacy(x)&&!ledger(x));
 for(const r of added)assert(r.schema==='public'&&newNames.includes(r.table??r.name),'Unknown new object');
 catalog[f]=sort(f,[...structuredClone(actual[f].filter(legacy)),...added.map(r=>mapRoleFields(r,sourceRole,targetRole))]);
 separate[f]=sort(f,after[f].filter(ledger).map(r=>mapRoleFields(r,sourceRole,targetRole)));
 }
 catalog.triggers=sort('triggers',after.triggers.map(t=>normalizeTrigger(t,after)));
 for(const f of globalFields)catalog[f]=structuredClone(actual[f]);
 separate.locations=sort('ledger_locations',structuredClone(after.ledger_locations));
 separate.entries=structuredClone(entries);
 rejectUnresolved({catalog,ledger:separate},sourceRole);
 for(const f of fields)assert.deepEqual(catalog[f].filter(legacy),actual[f].filter(legacy),'Live legacy changed: '+f);
 return {sourceRole,targetRole,sorting:keys,normalization:'Explicit NEW owner/grantee/policy-role fields only; linked expected RI names only; SQL ORDER BY keys plus semantic tie break after RI normalization',catalog,ledger:separate};
}
module.exports={oracle,role,rejectUnresolved,sort,legacy,fields,globalFields};