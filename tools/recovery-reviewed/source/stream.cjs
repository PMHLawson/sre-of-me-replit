const {spawn}=require('child_process');
const {once}=require('events');
const {Readable,Writable}=require('stream');
const {fs,crypto,assert,save,cleanEnv}=require('./common.cjs');
/**
 * Bounded fanout: await every sink before reading the next chunk. No plaintext
 * file, stderr output or accumulating byte array. All processes reaped on
 * success, rejection, timeout or cancellation. PG errors may contain data, so
 * only child labels and exit codes leave this boundary.
 */
async function fanout({source,sinks,timeoutMs=30000,signal,maxBytes=128*1024*1024}){
 const children=[],statuses=[],hash=crypto.createHash('sha256');let bytes=0;
 let rejectFailure;
 const failure=new Promise((_,reject)=>{rejectFailure=reject});failure.catch(()=>{});
 const fail=message=>rejectFailure(new Error(message));
 function launch(spec,isSource){
   const child=spawn(spec.bin,spec.args,{env:spec.env||cleanEnv(),stdio:[isSource&&!spec.input?'ignore':'pipe',isSource?'pipe':'ignore','ignore']});
  children.push(child);
  child.on('error',()=>fail(spec.label+': spawn failure'));
  if(child.stdin)child.stdin.on('error',()=>fail(spec.label+': input failure'));
  const closed=new Promise(resolve=>child.once('close',(code,signal)=>{statuses.push({label:spec.label,code,signal});if(code!==0)fail(spec.label+': nonzero exit');resolve();}));
   if(isSource&&spec.input)child.stdin.end(spec.input);
   return {child,closed};
 }
 const timer=setTimeout(()=>fail('bounded timeout'),timeoutMs);
 const abort=()=>fail('cancelled');signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 const src=launch(source,true),dest=sinks.map(s=>launch(s,false));
 const work=(async()=>{
  for await(const chunk of src.child.stdout){
    bytes+=chunk.length;if(bytes>maxBytes)throw new Error('input size cap');hash.update(chunk);
   for(const d of dest)if(!d.child.stdin.write(chunk))await Promise.race([once(d.child.stdin,'drain'),failure]);
  }
  dest.forEach(d=>d.child.stdin.end());
  await Promise.all([src.closed,...dest.map(d=>d.closed)]);
  return {bytes,sha256:hash.digest('hex'),statuses};
 })();work.catch(()=>{});
 try{return await Promise.race([work,failure]);}
 finally{
  clearTimeout(timer);signal?.removeEventListener('abort',abort);
  for(const c of children)if(c.exitCode===null&&c.signalCode===null)c.kill('SIGTERM');
  const kill=setTimeout(()=>{for(const c of children)if(c.exitCode===null&&c.signalCode===null)c.kill('SIGKILL');},1000);
  await Promise.all([src.closed,...dest.map(d=>d.closed)]);clearTimeout(kill);
 }
}
async function syntheticStreamTests(cfg){
 const tests=[];const node=(label,js)=>({label,bin:process.execPath,args:['-e',js]});
 const source=node('binary-producer',"const b=Buffer.alloc(1048576);for(let i=0;i<b.length;i++)b[i]=i%256;process.stdout.write(b)");
 const consumer=node('binary-consumer',"const c=require('crypto').createHash('sha256');let n=0;process.stdin.on('data',b=>{n+=b.length;c.update(b)});process.stdin.on('end',()=>{if(n!==1048576)process.exit(3)})");
 const slow=node('slow-consumer',"let n=0;process.stdin.on('data',b=>{n+=b.length;process.stdin.pause();setTimeout(()=>process.stdin.resume(),2)});process.stdin.on('end',()=>{if(n!==1048576)process.exit(3)})");
 const binary=await fanout({source,sinks:[consumer,slow]});const expected=Buffer.alloc(1048576);for(let i=0;i<expected.length;i++)expected[i]=i%256;
 assert.equal(binary.sha256,crypto.createHash('sha256').update(expected).digest('hex'));tests.push({name:'binary fanout/backpressure/digest',pass:true,...binary});
 for(const [name,options] of [
  ['producer failure',{source:node('bad-source','process.exit(5)'),sinks:[consumer]}],
  ['consumer failure',{source,sinks:[node('bad-sink','process.exit(6)')]}],
  ['timeout',{source:node('stall','setInterval(()=>{},1000)'),sinks:[consumer],timeoutMs:100}],
  ['spawn failure',{source:{label:'missing',bin:'/nonexistent-somr429',args:[]},sinks:[consumer]}],
  ['cancellation',{source:node('stall','setInterval(()=>{},1000)'),sinks:[consumer],signal:AbortSignal.timeout(100)}]
 ]){await assert.rejects(fanout(options));tests.push({name,pass:true});}
 if(cfg){const result=await fanout({source:{label:'synthetic-pg-dump',bin:'pg_dump',args:['-h',cfg.host,'-p','5432','-U','synthetic','-d','synthetic','-Fc','--no-password']},sinks:[{label:'full-decode-to-null',bin:'pg_restore',args:['--file=/dev/null']}]});
 assert(result.bytes>0);tests.push({name:'synthetic custom-format dump full decode-to-null',pass:true,...result});}
 else tests.push({name:'synthetic custom-format dump full decode-to-null',executed:false,reason:'One cluster already stopped and removed following post-check failure; not recreated'});
 save('stream-tests.json',tests);
}
module.exports={fanout,syntheticStreamTests};