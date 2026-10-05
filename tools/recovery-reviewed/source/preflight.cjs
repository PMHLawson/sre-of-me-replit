const {fs,out,assert,save}=require('./common.cjs');
const {workspace,freshness,fp}=require('./config.cjs');
const {readOnly,inspect,bindingCheck,QUERIES}=require('./catalog.cjs');
const {gate,sourceGate}=require('./gates.cjs');
function evidence(){
 const e=JSON.parse(fs.readFileSync(out+'/native-binding.json'));freshness(e);
 const line=e.result.output.split('\n').find(l=>/,[a-f0-9]{32},[a-f0-9]{32},[a-f0-9]{32},on$/.test(l));assert(line);
 const [at,database_fingerprint,endpoint_fingerprint,role_fingerprint,read_only]=line.split(',');
 return{e,expected:{database_fingerprint,endpoint_fingerprint,role_fingerprint,read_only}};
}
async function verify(c){
 const {e,expected}=evidence(),cfg=workspace();sourceGate();
 assert.equal(cfg.endpoint,JSON.parse(fs.readFileSync(out+'/config-metadata.json')).endpoint,'Configured endpoint changed');
 assert.equal(fp(c.connectionParameters),cfg.endpoint);
 const actual=(await c.query(QUERIES.binding)).rows[0];bindingCheck(actual,expected);
 const cat=await inspect(c);save('development-observed.json',{catalog:cat,binding:actual,configuredEndpoint:cfg.endpoint,platformAt:e.at,tls:cfg.tls,at:new Date().toISOString()});gate(cat,false);assert.equal(cat.ledger_locations.length,0);
 const original=JSON.parse(fs.readFileSync('.local/review/somr429-preparation/live-catalog.json')).catalog;
 for(const field of ['tables','columns','constraints','indexes','policies','acl','column_acl','default_acl','schema_acl','extensions','schemas'])assert.deepEqual(cat[field],original[field],field+' changed from verified original');
 return{catalog:cat,binding:actual,configuredEndpoint:cfg.endpoint,platformAt:e.at,tls:cfg.tls,at:new Date().toISOString(),hiddenHistory:'Not inferred absent'};
}
async function preflight(){const cfg=workspace();evidence();return readOnly(cfg.config,verify);}
module.exports={verify,preflight};
if(require.main===module)preflight().then(r=>save('development-preflight.json',r)).catch(e=>{save('preflight-failure.json',{code:e.code||e.name,message:'Read-only gate rejected; no export attempted'});process.exitCode=1;});