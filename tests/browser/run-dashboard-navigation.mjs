// Reproducible clean-clone entry point. Frontend build only; NEVER npm run dev.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';import {execFileSync,spawnSync} from 'node:child_process';
import {build} from 'vite';import react from '@vitejs/plugin-react';import tailwindcss from '@tailwindcss/vite';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const args=process.argv.slice(2),output=args.shift();
let chromium,gitDir;
while(args.length){const name=args.shift(),value=args.shift();if(name==='--chromium')chromium=value;else if(name==='--git-dir')gitDir=value;else throw Error('Unknown flag '+name)}
if(!output||!path.isAbsolute(output)||fs.existsSync(output)||output.startsWith(root+path.sep)||!fs.existsSync(path.dirname(output)))
  throw Error('Explicit non-existent absolute output outside checkout, with existing parent, required');
if(!chromium||!path.isAbsolute(chromium))throw Error('--chromium /absolute/executable required (never installed/discovered)');
fs.accessSync(chromium,fs.constants.X_OK);
if(gitDir&&(!path.isAbsolute(gitDir)||!fs.existsSync(path.join(gitDir,'HEAD'))))throw Error('Explicit existing absolute Git metadata required');
if(!gitDir&&!fs.existsSync(root+'/.git'))throw Error('No local checkout metadata; supply --git-dir explicitly; never fall through to ancestor');
const prefix=gitDir?[`--git-dir=${gitDir}`,`--work-tree=${root}`,'-c','core.bare=false']:['-C',root];
const git=(...a)=>execFileSync('git',[...prefix,...a],{encoding:'utf8'}).trim();
if(git('status','--porcelain=v1','--untracked-files=all'))throw Error('Clean committed candidate required');
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const source={cwd:root,commit:git('rev-parse','HEAD'),tree:git('rev-parse','HEAD^{tree}'),node:process.version,
  sourceFiles:git('ls-files','-z').split('\0').filter(Boolean).map(p=>({path:p,blob:git('rev-parse',`HEAD:${p}`),sha256:hash(root+'/'+p)})),
  configuration:'Detached React/Tailwind build, configFile:false, no env/backend/startup/credentials; tracked fixture and owned controller'};
fs.mkdirSync(output,{recursive:false});
await build({configFile:false,root:root+'/client',envDir:output+'/no-env',cacheDir:output+'/vite-cache',
  plugins:[react(),tailwindcss()],resolve:{alias:{'@':root+'/client/src','@shared':root+'/shared','@assets':root+'/attached_assets'}},
  css:{postcss:{plugins:[]}},build:{outDir:output+'/public',emptyOutDir:false}});
const inventory=(dir,result={})=>{for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())inventory(p,result);else result[path.relative(output,p)]=hash(p)}return result};
source.buildFiles=inventory(output+'/public');
for(const f of source.sourceFiles)if(hash(root+'/'+f.path)!==f.sha256)throw Error('Source changed while building');
fs.writeFileSync(output+'/identity.json',JSON.stringify(source,null,2));
const command={executable:process.execPath,args:[root+'/tests/browser/dashboard-navigation.cjs',output+'/public',output+'/browser',chromium,output+'/identity.json'],cwd:root};
// Never externally kill the harness before its owned-only finally cleanup.
// Individual CDP requests and scenario waits remain bounded by the controller.
const begin=process.hrtime.bigint(),result=spawnSync(command.executable,command.args,{cwd:root,encoding:'utf8',maxBuffer:16*1024*1024});
fs.writeFileSync(output+'/browser.log',(result.stdout||'')+'\n'+(result.stderr||''));
fs.writeFileSync(output+'/invocation.json',JSON.stringify({...command,exitCode:result.status,signal:result.signal,error:result.error?.message,
  durationMs:Number(process.hrtime.bigint()-begin)/1e6},null,2));
console.log((result.stdout||'').slice(-1600),(result.stderr||'').slice(-1600));
process.exitCode=result.status??1;