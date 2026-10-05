// Newly implemented review candidate. No enabled development entrypoint.
const {Client}=require('pg');
const {fs,path,crypto,assert,cleanEnv,save,out}=require('./common.cjs');
const {inspect,fingerprints,bindingCheck}=require('./catalog.cjs');
const {sourceGate,gate}=require('./gates.cjs');
const {fanout}=require('./stream.cjs');
const {spawnSync,spawn}=require('child_process');
const {createReadStream}=require('fs');
const PEM='f9064adb752e271d904eec55973a044426339b8eb03a5e189bf5a2f88ae64031';
const DER='3b0296e6d3d4dab4fd5234747618b654c903f8e6bb69787ed18ec8dfc1c39619';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function publishReceipt(receipt,staged,final,owned){
 const bytes=Buffer.from(JSON.stringify(receipt,null,2)+'\n');
 const fd=fs.openSync(staged,'wx',0o600);owned.push(staged);
 try{
  let offset=0;
  while(offset<bytes.length){
   const n=fs.writeSync(fd,bytes,offset,bytes.length-offset);
   assert(Number.isInteger(n)&&n>0&&n<=bytes.length-offset,'Incomplete receipt write');
   offset+=n;
  }
  assert.equal(fs.fstatSync(fd).size,bytes.length,'Receipt length mismatch');
  fs.fsyncSync(fd);
 }finally{fs.closeSync(fd);}
 // Same-directory hard link atomically publishes a complete inode, without
 // replacing any preexisting release marker. Track only paths we actually own.
 fs.linkSync(staged,final);owned.push(final);
 fs.unlinkSync(staged);
}
function cleanupArtifacts(owned){
 // Remove release markers before ciphertexts, even if later cleanup fails.
 for(const p of [...owned].reverse())if(fs.existsSync(p))fs.unlinkSync(p);
}
async function verifyEnvelope(file){
 const expected=['id-smime-ct-authEnvelopedData','aes-256-gcm','rsaesOaep','sha256','mgf1'],seen=new Set();
 const child=spawn('openssl',['cms','-cmsout','-print','-inform','DER','-in',file],{env:cleanEnv(),stdio:['ignore','pipe','ignore']});
 const timer=setTimeout(()=>child.kill('SIGKILL'),10000);let tail='',header='';
 try{await new Promise((resolve,reject)=>{
 child.on('error',reject);child.stdout.on('data',b=>{const text=tail+b.toString();for(const x of expected)if(text.includes(x))seen.add(x);tail=text.slice(-100);if(header.length<8000)header=(header+b.toString()).slice(0,8000);});
 child.on('close',code=>code===0?resolve():reject(new Error('CMS finalization parse')));
 });assert.equal(seen.size,expected.length,'CMS algorithms');
 const oaep=header.split('parameter: SEQUENCE:')[1]?.split('encryptedKey:')[0];assert(oaep);
 assert.match(oaep,/cont \[ 0 \][\s\S]*?d=3[^\n]*OBJECT\s*:sha256/);
 assert.match(oaep,/cont \[ 1 \][\s\S]*?d=3[^\n]*OBJECT\s*:mgf1[\s\S]*?d=4[^\n]*OBJECT\s*:sha256/);
 assert(!/:sha1\b/.test(oaep));
 }finally{clearTimeout(timer);}
}
async function digest(p){const h=crypto.createHash('sha256');let bytes=0;for await(const b of createReadStream(p)){bytes+=b.length;assert(bytes<=130*1024*1024);h.update(b);}return{bytes,sha256:h.digest('hex')};}
function certificate(){
 const cert=out+'/recipient-public.pem';assert.equal(hash(fs.readFileSync(cert)),PEM);
 const r=spawnSync('openssl',['x509','-in',cert,'-outform','DER'],{env:cleanEnv(),maxBuffer:1048576});assert.equal(r.status,0);assert.equal(hash(r.stdout),DER);return cert;
}
function validateFixture(cfg,job){
 assert.match(job,/^\/tmp\/somr429-v2-fixture-[A-Za-z0-9]+$/);
 assert.equal(fs.realpathSync(job),job);assert.equal(fs.statSync(job).uid,process.getuid());assert.equal(fs.statSync(job).mode&511,448);
 assert.equal(fs.readFileSync(job+'/job-marker','utf8'),out);
 assert.equal(cfg.host,job+'/socket');assert.equal(cfg.user,'synthetic');assert.equal(cfg.database,'synthetic');assert.equal(cfg.port,5432);
 assert.deepEqual(Object.keys(cfg).sort(),['connectionTimeoutMillis','database','host','port','user'].sort());
}
async function captureDevelopment(){
 // Unconditional, before all connection or export work. No runtime override.
 throw new Error('DISABLED: independent Codex review/release required for owner capture');
 return preparedDevelopmentContext();
}
async function captureSynthetic({config,job,signal,fault,phase='post'}){
 validateFixture(config,job);assert(['pre','post'].includes(phase));
 return engine({config,signal,fault,post:phase==='post',prefix:'synthetic-'+phase,development:false});
}
async function preparedDevelopmentContext(){
 const {workspace}=require('./config.cjs');
 const cfg=workspace();
 await require('./preflight.cjs').preflight();
 return engine({config:cfg.config,post:false,prefix:'development',development:true});
}
// preparedDevelopmentContext is deliberately private and unreachable externally.
async function engine({config,signal,fault,post,prefix,development}){
 sourceGate();const cert=certificate();
 const privateRoot=fs.mkdtempSync('/home/runner/.local/state/somr429-v2-recovery-');fs.chmodSync(privateRoot,0o700);
 assert.equal(fs.realpathSync(privateRoot),privateRoot);assert.equal(fs.statSync(privateRoot).uid,process.getuid());
 const key=crypto.randomBytes(32);fs.writeFileSync(privateRoot+'/comparison.key',key,{mode:0o600,flag:'wx'});
 const controller=new AbortController(),start=new Date().toISOString(),t=performance.now();
 const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 const timer=setTimeout(abort,120000);
 const c=new Client({...config,options:'-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=2000 -c idle_in_transaction_session_timeout=180000 -c timezone=UTC -c datestyle=ISO,YMD'});
 const partial=privateRoot+'/'+prefix+'.dump.cms.partial',invPartial=privateRoot+'/'+prefix+'.inventory.cms.partial';
 const final=privateRoot+'/'+prefix+'.dump.cms',invFinal=privateRoot+'/'+prefix+'.inventory.cms';
 const files=[partial,invPartial];let promoted=false;
 const cms=p=>({label:'CMS',bin:'openssl',args:['cms','-encrypt','-binary','-stream','-aes-256-gcm','-outform','DER','-out',p,'-recip',cert,'-keyopt','rsa_padding_mode:oaep','-keyopt','rsa_oaep_md:sha256','-keyopt','rsa_mgf1_md:sha256']});
 try{
 await c.connect();await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 assert.equal((await c.query("SELECT current_setting('transaction_read_only') AS ro")).rows[0].ro,'on');
 if(development)await require('./preflight.cjs').verify(c);
 const snapshot=(await c.query('SELECT pg_export_snapshot() AS id')).rows[0].id;
 const catalog=await inspect(c),inventory=await fingerprints(c,key);
 gate(catalog,post);const snapshotAt=new Date().toISOString();
 for(const p of files)fs.writeFileSync(p,'',{mode:0o600,flag:'wx'});
 // Only validated config supplies libpq identity; no inherited PG variables.
 const env={...require('./config.cjs').libpq(config),PGOPTIONS:'-c default_transaction_read_only=on -c statement_timeout=90000 -c timezone=UTC -c datestyle=ISO,YMD'};
 const node=(label,code)=>({label,bin:process.execPath,args:['-e',code]});
 let source={label:'pg_dump',bin:'pg_dump',args:['-Fc','--no-password','--snapshot='+snapshot],env};
 let sinks=[cms(partial),{label:'full-decode',bin:'pg_restore',args:['--file=/dev/null']}];
 if(fault==='producer')source=node('producer','process.exit(3)');
 if(fault==='spawn')source={label:'missing',bin:'/missing-somr429-v2',args:[]};
 if(fault==='decoder')sinks[1]=node('decoder','process.exit(4)');
 if(fault==='encryptor')sinks[0]=node('encryptor','process.exit(5)');
 if(['timeout','cancellation'].includes(fault))source=node('stall','setInterval(()=>{},1000)');
 if(fault==='cancellation')setTimeout(abort,100);
 const dump=await fanout({source,sinks,signal:controller.signal,timeoutMs:fault==='timeout'?100:90000,maxBytes:fault==='oversize'?1:128*1024*1024});
 assert(dump.bytes>0);
 assert.equal((await c.query('SELECT 1 AS alive')).rows[0].alive,1);
 // Complete synthetic inventory only; encrypted from memory, never a plaintext file.
 const payload=JSON.stringify({catalog,inventory,snapshotAt,snapshot,dump});
 const inventoryStream=await fanout({source:{...node('inventory','process.stdin.pipe(process.stdout)'),input:Buffer.from(payload)},sinks:[cms(invPartial)],signal:controller.signal});
 if(fault==='finalization')fs.truncateSync(partial,12);
 // Print is bounded by input cap; inspect just algorithm metadata, never persist raw output.
 const algorithms=[];
 for(const p of files){
 await verifyEnvelope(p);
 algorithms.push({artifact:path.basename(p),authEnvelopedData:true,aes256gcm:true,oaepSha256Mgf1Sha256:true});
 }
 const ciphertext=await digest(partial),encryptedInventory=await digest(invPartial);assert(ciphertext.bytes>0&&encryptedInventory.bytes>0);
 assert(!controller.signal.aborted);
 const receipt={complete:true,syntheticOnly:!development,phase:post?'post':'pre',start,end:new Date().toISOString(),durationMs:performance.now()-t,snapshotShared:true,snapshotAt,keeperAliveAfterDump:true,format:'CMS streaming BER encoded with -outform DER -stream; decode as ASN.1 DER/BER',dump,inventoryStream,ciphertext,encryptedInventory,algorithms,certificate:{pem:PEM,der:DER},locallyAuthenticated:false,restoreTest:false};
 fs.linkSync(partial,final);files.push(final);fs.linkSync(invPartial,invFinal);files.push(invFinal);
 fs.unlinkSync(partial);fs.unlinkSync(invPartial);
 publishReceipt(receipt,privateRoot+'/'+prefix+'.COMPLETE.json.partial',privateRoot+'/'+prefix+'.COMPLETE.json',files);promoted=true;
 return {receipt,final,invFinal};
 }catch(e){
 // All fanout children are already reaped before control reaches here.
 cleanupArtifacts(files);
 const failure={syntheticOnly:!development,fault:fault||null,start,end:new Date().toISOString(),durationMs:performance.now()-t,failed:true,reason:e.code||e.name,downloadReady:false,remainingArtifacts:fs.readdirSync(privateRoot).filter(n=>n!=='comparison.key')};
 save('capture-failure-'+(fault||'unexpected')+'.json',failure);throw e;
 }finally{
 clearTimeout(timer);signal?.removeEventListener('abort',abort);
 try{await c.query('ROLLBACK');}catch{}await c.end().catch(()=>{});key.fill(0);
 }
}
module.exports={captureSynthetic,captureDevelopment,validateFixture};