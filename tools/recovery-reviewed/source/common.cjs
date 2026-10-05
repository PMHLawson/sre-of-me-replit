const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('assert/strict');
const {spawnSync}=require('child_process');
process.umask(0o077);
const root=path.resolve('.'),out=path.join(root,'.local/review/somr429-oracle-role-fix');
const accepted=path.join(root,'.local/checkouts/somr428-generation');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const save=(n,x)=>fs.writeFileSync(path.join(out,n),typeof x==='string'?x:JSON.stringify(x,null,2)+'\n',{mode:0o600});
const cleanEnv=()=>({PATH:process.env.PATH,HOME:out,LANG:'C.UTF-8',TZ:'UTC'});
function command(label,bin,args,options={}){
 const start=new Date().toISOString(),t=performance.now();
 const r=spawnSync(bin,args,{env:cleanEnv(),encoding:'utf8',timeout:60000,maxBuffer:8e6,...options});
 save(label+'.stdout.log',r.stdout||'');save(label+'.stderr.log',r.stderr||'');
 save(label+'.command.json',{bin,args,start,end:new Date().toISOString(),durationMs:performance.now()-t,status:r.status,signal:r.signal,error:r.error?.code});
 assert.equal(r.status,0,`${label} failed; see private logs`);return r.stdout;
}
const git=(args)=>{const r=spawnSync('git',['--no-optional-locks',...args],{encoding:'utf8'});assert.equal(r.status,0);return r.stdout;};
function inventory(){
 const files={};function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(p===out||['node_modules','.git','candidate-git'].includes(e.name))continue;if(e.isDirectory())walk(p);else if(e.isFile())files[path.relative(root,p)]=sha(fs.readFileSync(p));}}
 for(const p of ['.local/review','.local/checkouts','.agents/memory'])if(fs.existsSync(p))walk(path.resolve(p));
 for(const p of git(['ls-files','-z','--cached','--others','--exclude-standard']).split('\0').filter(Boolean))if(fs.existsSync(p)&&fs.lstatSync(p).isFile())files[p]=sha(fs.readFileSync(p));
 const repos=[{name:'original',args:[]},{name:'accepted',args:[`--git-dir=${root}/.local/review/somr428-generation/candidate-git`,`--work-tree=${accepted}`]}];
 return {at:new Date().toISOString(),files,repos:repos.map(r=>({name:r.name,head:git([...r.args,'rev-parse','HEAD']),tree:git([...r.args,'rev-parse','HEAD^{tree}']),refs:git([...r.args,'for-each-ref','--format=%(refname) %(objectname)']),status:git([...r.args,'status','--porcelain=v1'])}))};
}
module.exports={fs,path,crypto,assert,root,out,accepted,sha,save,cleanEnv,command,git,inventory};