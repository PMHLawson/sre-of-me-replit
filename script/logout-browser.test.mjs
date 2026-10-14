import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {build} from 'esbuild';
import WS from 'ws';

test('real Chromium top-level handoff after confirmed client logout', {timeout:45000}, async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'logout-browser-'));
 let browser,cdp,app,provider,resolveLogout,sessionId;
 const result={profileRemoved:false,serversClosed:false,browserExited:false};
 try{
  let providerResolve;const providerSeen=new Promise(r=>providerResolve=r);
  provider=http.createServer((req,res)=>{providerResolve({destination:req.headers['sec-fetch-dest']});res.end('<html><body>synthetic provider signed out</body></html>');});
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  const providerURL=`http://127.0.0.1:${provider.address().port}/end`;
  const bundled=await build({stdin:{contents:`
   import {logout,finishLogout} from './client/src/hooks/use-auth.ts';
   import {QueryClient} from '@tanstack/react-query';
   const cache=new QueryClient();cache.setQueryData(['private'],{name:'synthetic'});
   document.querySelector('button').onclick=async()=>{
    document.body.dataset.state='pending';
    try{const result=await logout();await finishLogout(result,cache,url=>{
      if(cache.getQueryCache().getAll().length)throw Error('Private cache remains');
      window.location.replace(url);
    });}catch{document.body.dataset.state='failed';}
   };`,resolveDir:process.cwd()},bundle:true,write:false,format:'iife',platform:'browser',tsconfig:'tsconfig.json'});
  const script=bundled.outputFiles[0].text;
  let requestResolve;const requestSeen=new Promise(r=>requestResolve=r);
  app=http.createServer((req,res)=>{
   if(req.url==='/api/logout'){
    requestResolve({method:req.method,intent:req.headers['x-sre-logout'],origin:req.headers.origin});
    resolveLogout=()=>{if(res.writableEnded)return;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({localSignedOut:true,providerLogoutUrl:providerURL}));};return;
   }
   if(req.url==='/script.js'){res.setHeader('Content-Type','text/javascript');res.end(script);return;}
   res.end('<html><body><button>Sign out</button><script src="/script.js"></script></body></html>');
  });app.listen(0,'127.0.0.1');await once(app,'listening');
  const url=`http://127.0.0.1:${app.address().port}/`;
  browser=spawn('chromium',['--headless','--no-sandbox','--disable-gpu','--disable-background-networking','--no-first-run','--no-default-browser-check','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0',`--user-data-dir=${dir}`,'about:blank'],{env:{PATH:process.env.PATH,HOME:dir},stdio:['ignore','ignore','pipe']});
  if(process.env.OWNERSHIP_EVIDENCE_DIR)fs.writeFileSync(path.join(process.env.OWNERSHIP_EVIDENCE_DIR,'logout-browser-owned.json'),JSON.stringify({profile:dir,pid:browser.pid,started:new Date().toISOString()}));
  const debuggerURL=await new Promise((resolve,reject)=>{let text='';browser.stderr.on('data',chunk=>{text+=chunk;const m=text.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(m)resolve(m[1]);});browser.once('error',reject);browser.once('exit',()=>reject(Error('Browser exited during setup')));});
  cdp=new WS(debuggerURL);await once(cdp,'open');let sequence=0;const pending=new Map();
  cdp.on('message',data=>{const m=JSON.parse(String(data));if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}});
  const send=(method,params={},sid=sessionId)=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});cdp.send(JSON.stringify({id,method,params,...(sid?{sessionId:sid}:{})}));});
  const target=await send('Target.createTarget',{url:'about:blank'});sessionId=(await send('Target.attachToTarget',{targetId:target.targetId,flatten:true})).sessionId;
  await send('Page.enable');await send('Page.navigate',{url});
  async function evaluate(expression){const r=await send('Runtime.evaluate',{expression,returnByValue:true});if(r.exceptionDetails)throw Error('Browser evaluation failed');return r.result.value;}
  for(let n=0;n<100;n++){if(await evaluate("!!document.querySelector('button')?.onclick"))break;await new Promise(r=>setTimeout(r,50));}
  await evaluate("document.querySelector('button').click()");
  assert.deepEqual(await requestSeen,{method:'POST',intent:'1',origin:new URL(url).origin});
  assert.equal(await evaluate('location.href'),url);
  assert.equal(await evaluate('document.body.dataset.state'),'pending');
  resolveLogout();assert.deepEqual(await providerSeen,{destination:'document'});
  for(let n=0;n<100;n++){if(await evaluate('location.href')===providerURL)break;await new Promise(r=>setTimeout(r,50));}
  assert.equal(await evaluate('location.href'),providerURL);result.confirmedTopLevelProviderNavigation=true;
 }finally{
  resolveLogout?.();cdp?.terminate();
  if(browser&&browser.exitCode===null){const exit=once(browser,'exit');browser.kill('SIGTERM');await exit;}
  result.browserExited=!browser||browser.exitCode!==null||browser.signalCode!==null;
  for(const server of [app,provider])if(server?.listening){server.closeAllConnections();await new Promise(r=>server.close(r));}
  result.serversClosed=!app?.listening&&!provider?.listening;
  fs.rmSync(dir,{recursive:true,force:true,maxRetries:20,retryDelay:100});result.profileRemoved=!fs.existsSync(dir);
  if(process.env.OWNERSHIP_EVIDENCE_DIR)fs.writeFileSync(path.join(process.env.OWNERSHIP_EVIDENCE_DIR,'logout-browser-cleanup.json'),JSON.stringify(result,null,2));
 }
});
