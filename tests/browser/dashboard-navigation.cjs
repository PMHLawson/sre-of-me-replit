// Native-input regression review of a DETACHED frontend, never server/index.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {performance}=require('node:perf_hooks');
const {fixture,domains,titles,modes,policy}=require('./dashboard-navigation-fixtures.cjs');
const {createStarter}=require('./dashboard-navigation-browser.cjs');
const [buildDir,outputDir,executable,identityFile]=process.argv.slice(2);
for(const p of [buildDir,outputDir,executable,identityFile])if(!p||!path.isAbsolute(p))throw Error('Four explicit absolute paths required; see DASHBOARD-NAVIGATION.md');
if(fs.existsSync(outputDir))throw Error('Output already exists; never overwrite evidence');
if(!fs.existsSync(path.join(buildDir,'index.html')))throw Error('Missing detached frontend');
const source=JSON.parse(fs.readFileSync(identityFile,'utf8'));
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
for(const [p,h]of Object.entries(source.buildFiles))if(p.startsWith('public/')&&hash(fs.readFileSync(path.join(buildDir,p.slice(7))))!==h)throw Error('Detached build identity mismatch: '+p);
fs.mkdirSync(outputDir,{recursive:false});
const starter=createStarter(executable),results=[],observations=[],audits=[],errors=[],pending=new Set(),popups=new Map();
const expectedIds=[],combinations=[1280,360,320].flatMap(width=>['dark','light'].map(theme=>({width,theme,id:width+'-'+theme})));
const css={NOMINAL:['bg-status-healthy/10','border-status-healthy/20'],ADVISORY:['bg-status-advisory/10','border-status-advisory/20'],
  WARNING:['bg-status-degraded/10','border-status-degraded/20'],BREACH:['bg-status-critical/10','border-status-critical/20'],PAGE:['bg-status-critical/15','border-status-critical/30']};
const cardId=d=>'card-domain-'+d;
const links=mode=>[{id:mode==='ramp'?'card-system-health-rampup':'card-system-health',href:'/system-health',name:'View System Health'},
  ...modes[mode].order.map(d=>({id:cardId(d),href:'/domain/'+d,name:'View '+titles[d]}))];
for(const c of combinations)for(const mode of Object.keys(modes)){
  const p=c.id+'/'+mode;
  for(const id of ['count','order','sections','layout','anchors','content','style','log-controls','forward','backward','history-anchor','decide-anchor','history-log'])
    expectedIds.push(p+'/'+id);
  for(const link of links(mode))for(const id of ['semantics','focus','enter','return','pointer'])expectedIds.push(p+'/'+link.id+'/'+id);
  for(const n of ['settings','decide','history','quick-log','dashboard-fab'])expectedIds.push(p+'/surround/'+n);
}
for(const mode of ['sorted','ramp'])for(const link of links(mode).slice(0,mode==='sorted'?5:1))for(const kind of ['control','middle'])
  expectedIds.push('1280-dark/'+mode+'/'+link.id+'/'+kind);
expectedIds.push('safety/no-data-writes','safety/all-api-intercepted');
if(new Set(expectedIds).size!==expectedIds.length)throw Error('Duplicate expected IDs');
fs.writeFileSync(outputDir+'/expected-ids.json',JSON.stringify(expectedIds,null,2));
let browser,server,origin,data,themeScript,mainTargetId,fatal,scenario='setup';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function track(p){pending.add(p);p.catch(e=>{errors.push({scenario,error:String(e)});fatal=e}).finally(()=>pending.delete(p));}
function record(id,pass,expected,actual){
  if(!expectedIds.includes(id)||results.some(r=>r.id===id))throw Error('Unregistered/duplicate assertion '+id);
  results.push({id,result:pass?'PASS':'FAIL',expected,actual,scenario,atMs:performance.now()});
}
async function evaluate(expression,session){
  const r=await (session?browser.sessionRpc(session,'Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true}):
    browser.rpc('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true}));
  if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;
}
async function wait(expression,session,ms=8000){
  const deadline=performance.now()+ms;
  while(performance.now()<deadline){if(fatal)throw fatal;if(await evaluate(expression,session))return true;await sleep(40)}return false;
}
const observer=`(()=>{
  const state=window.__navigationProof={document:crypto.randomUUID(),timeOrigin:performance.timeOrigin,nav:[],clicks:[],keys:[]};
  for(const name of ['pushState','replaceState']){
    const original=history[name];history[name]=function(...args){state.nav.push({method:name,url:String(args[2]),at:performance.now()});return original.apply(this,args)};
  }
  for(const type of ['click','auxclick'])window.addEventListener(type,e=>state.clicks.push({
    type,button:e.button,ctrl:e.ctrlKey,meta:e.metaKey,shift:e.shiftKey,trusted:e.isTrusted,prevented:e.defaultPrevented,
    testids:e.composedPath().filter(n=>n instanceof Element&&n.dataset.testid).map(n=>n.dataset.testid),at:performance.now()}));
  for(const type of ['keydown','keyup','keypress'])window.addEventListener(type,e=>state.keys.push({
    type,key:e.key,shift:e.shiftKey,trusted:e.isTrusted,at:performance.now()}),{capture:true});
})();`;
async function viewport(c){
  await browser.rpc('Emulation.setDeviceMetricsOverride',{width:c.width,height:900,deviceScaleFactor:1,mobile:false});
  await browser.rpc('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:c.theme}]});
  if(themeScript)await browser.rpc('Page.removeScriptToEvaluateOnNewDocument',{identifier:themeScript});
  themeScript=(await browser.rpc('Page.addScriptToEvaluateOnNewDocument',{source:
    `localStorage.setItem('sre-of-me-v2',JSON.stringify({state:{theme:${JSON.stringify(c.theme)}},version:0}))`})).identifier;
}
async function navigate(mode){
  if(data)audits.push(data);data=fixture(mode,origin);
  await browser.rpc('Page.navigate',{url:origin+'/'});
  if(!await wait(`!!document.querySelector('[data-testid="card-domain-music-rationale"]')`))throw Error('Invented authenticated fixture did not render');
  await browser.rpc('Input.dispatchMouseEvent',{type:'mouseMoved',x:1,y:1});
  await sleep(500); // Actual CSS settles; no tolerance, frozen clocks or timer changes.
}
async function key(key,shift=false){
  const code=key==='Tab'?9:13;
  await browser.rpc('Input.dispatchKeyEvent',{type:'keyDown',key,code:key,windowsVirtualKeyCode:code,nativeVirtualKeyCode:code,modifiers:shift?8:0,
    ...(key==='Enter'?{text:'\r',unmodifiedText:'\r'}:{})});
  await browser.rpc('Input.dispatchKeyEvent',{type:'keyUp',key,code:key,windowsVirtualKeyCode:code,nativeVirtualKeyCode:code,modifiers:shift?8:0});
}
const active=()=>evaluate(`({id:document.activeElement?.dataset.testid,tag:document.activeElement?.tagName,path:location.pathname})`);
async function tabTo(selector,shift=false){
  const trace=[];
  for(let i=0;i<42;i++){
    if(await evaluate(`document.activeElement?.matches(${JSON.stringify(selector)})`))return {reachable:true,trace};
    await key('Tab',shift);trace.push({...await active(),shift});
  }return {reachable:false,trace};
}
const select=id=>`[data-testid="${id}"]`;
async function pointer(selector,kind='left'){
  const p=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  if(!p)throw Error('Missing pointer control '+selector);
  for(const type of ['mousePressed','mouseReleased'])await browser.rpc('Input.dispatchMouseEvent',{type,button:kind==='middle'?'middle':'left',clickCount:1,...p,modifiers:kind==='control'?2:0});
}
async function screenshot(name){
  const r=await browser.rpc('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
  fs.writeFileSync(outputDir+'/'+name+'.png',Buffer.from(r.data,'base64'));
}
async function snapshot(){
  return evaluate(`(()=>{
    const rect=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom}};
    const style=e=>{const s=getComputedStyle(e);return{display:s.display,background:s.backgroundColor,border:s.borderColor,color:s.color,font:s.fontSize,radius:s.borderRadius,padding:s.padding,textDecoration:s.textDecorationLine}};
    const cards=[...document.querySelectorAll('[data-testid]')].filter(e=>/^card-domain-(martial-arts|meditation|fitness|music)$/.test(e.dataset.testid)).map(e=>({
      id:e.dataset.testid,domain:e.dataset.testid.slice(12),classes:e.className,text:e.innerText,rect:rect(e),style:style(e),
      tier:document.querySelector('[data-testid="'+e.dataset.testid+'-tier"]')?.textContent.trim(),
      rationale:document.querySelector('[data-testid="'+e.dataset.testid+'-rationale"]')?.textContent.trim(),
      action:document.querySelector('[data-testid="'+e.dataset.testid+'-action"]')?.textContent.trim(),
      floor:document.querySelector('[data-testid="'+e.dataset.testid+'-floor"]')?.textContent.trim(),
      cadence:document.querySelector('[data-testid="'+e.dataset.testid+'-cadence"]')?.textContent.trim()}));
    const system=document.querySelector('[data-testid="card-system-health"],[data-testid="card-system-health-rampup"]');
    const sections=[system,document.querySelector('[data-testid="dashboard-tier-timeline"]'),document.querySelector('[data-testid="domains-grid"]'),document.querySelector('[data-testid="section-deviations"]')].filter(Boolean);
    const text=id=>document.querySelector('[data-testid="'+id+'"]')?.textContent.trim();
    return{path:location.pathname,width:innerWidth,documentWidth:document.documentElement.scrollWidth,
      theme:document.documentElement.classList.contains('dark')?'dark':'light',cards,history:!!document.querySelector('[data-testid="dashboard-tier-timeline"]'),
      system:{id:system.dataset.testid,classes:system.className,text:system.innerText,rect:rect(system),style:style(system)},
      sectionOrder:sections.every((e,i)=>!i||!!(sections[i-1].compareDocumentPosition(e)&Node.DOCUMENT_POSITION_FOLLOWING)),
      shell:text('text-anchor-shell'),dashboard:text('text-anchor-dashboard'),body:document.body.innerText,
      checkmark:!!document.querySelector('[data-testid="fab-dashboard-log"] svg.lucide-check'),
      quickLog:!!document.querySelector('[data-testid="button-quick-log"]'),fabs:document.querySelectorAll('[data-testid^="fab-"]').length};
  })()`);
}
async function semantics(link){
  const r=await browser.rpc('Runtime.evaluate',{expression:`document.querySelector(${JSON.stringify(select(link.id))})`});
  const ax=await browser.rpc('Accessibility.getPartialAXTree',{objectId:r.result.objectId,fetchRelatives:false});
  await browser.rpc('Runtime.releaseObject',{objectId:r.result.objectId});
  const dom=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(select(link.id))});return{tag:e.tagName,href:e.getAttribute('href'),label:e.getAttribute('aria-label'),tabIndex:e.tabIndex,nested:e.querySelectorAll('a,button,input,select,textarea,[tabindex]').length}})()`);
  return {...dom,accessible:ax.nodes.filter(n=>!n.ignored).map(n=>({role:n.role?.value,name:n.name?.value}))};
}
async function focus(link){
  // The preserved transition-all animates outline-offset. Observe its finished
  // native CSS state, not an intermediate frame. Real browser time only.
  await evaluate(`Promise.all(document.querySelector(${JSON.stringify(select(link.id))}).getAnimations()
    .filter(a=>a.playState==='running').map(a=>a.finished)).then(()=>true)`);
  return evaluate(`(()=>{
    const e=document.querySelector(${JSON.stringify(select(link.id))}),s=getComputedStyle(e),r=e.getBoundingClientRect();
    const root=document.querySelector('.min-h-screen'),background=getComputedStyle(root).backgroundColor;
    const ctx=document.createElement('canvas').getContext('2d');
    const rgb=(color,base)=>{ctx.clearRect(0,0,1,1);if(base){ctx.fillStyle=base;ctx.fillRect(0,0,1,1)}ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].slice(0,3)};
    const lum=a=>a.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);
    const ratio=(a,b)=>(Math.max(lum(a),lum(b))+.05)/(Math.min(lum(a),lum(b))+.05);
    const outline=rgb(s.outlineColor),bg=rgb(background),card=rgb(s.backgroundColor,background);
    return{active:document.activeElement===e,visible:e.matches(':focus-visible'),outline:s.outlineStyle,width:parseFloat(s.outlineWidth),
      offset:parseFloat(s.outlineOffset),color:s.outlineColor,background,cardBackground:s.backgroundColor,
      contrastBackground:ratio(outline,bg),contrastCard:ratio(outline,card),
      rect:{x:r.x,y:r.y,right:r.right,bottom:r.bottom,w:r.width,h:r.height},viewport:{w:innerWidth,h:innerHeight},keys:window.__navigationProof.keys.slice(-6)};
  })()`);
}
async function proof(reset=false){
  return evaluate(`(()=>{const p=window.__navigationProof;if(${reset}){p.nav.length=0;p.clicks.length=0;p.keys.length=0}return{document:p.document,timeOrigin:p.timeOrigin,path:location.pathname,nav:p.nav,clicks:p.clicks,keys:p.keys,at:performance.now()}})()`);
}
const single=(before,after,route)=>after.path===route&&before.document===after.document&&before.timeOrigin===after.timeOrigin&&
  after.nav.length===1&&new URL(after.nav[0].url,origin).pathname===route&&after.clicks.length===1&&after.clicks[0].trusted;
const backSelector='header button:has(svg.lucide-arrow-left)';
async function returnHome(){
  const tab=await tabTo(backSelector),before=await proof(true);
  if(tab.reachable)await key('Enter');
  await wait("location.pathname==='/'");await sleep(100);
  const after=await proof();return {pass:tab.reachable&&single(before,after,'/'),tab,before,after};
}
async function activation(mode,link,kind){
  await navigate(mode);const tab=kind==='enter'?await tabTo(select(link.id)):null,before=await proof(true);
  const attempted=kind!=='enter'||tab.reachable;
  if(attempted){if(kind==='enter')await key('Enter');else await pointer(select(link.id));await wait('location.pathname==='+JSON.stringify(link.href));await sleep(100)}
  const after=await proof();const result={pass:attempted&&single(before,after,link.href),tab,before,after};
  let returned={pass:false,note:'Activation was not attempted or did not reach the route'};
  if(after.path===link.href)returned=await returnHome();
  return {result,returned};
}
async function modified(mode,link,kind){
  await navigate(mode);const sem=await semantics(link),before=await proof(true),old=new Set(popups.keys());
  await pointer(select(link.id),kind);
  if(sem.tag!=='A'||sem.href!==link.href){
    await sleep(100);
    return {pass:false,sem,before,after:await proof(),nativeAttempted:true,
      newTargets:[...popups.values()].filter(p=>!old.has(p.targetId)),
      note:'Actual trusted modified input on baseline non-link; native link semantics absent'};
  }
  const deadline=performance.now()+8000;let popup;
  while(performance.now()<deadline){if(fatal)throw fatal;popup=[...popups.values()].find(p=>!old.has(p.targetId));if(popup?.ready)break;await sleep(40)}
  const after=await proof();
  if(!popup?.ready)return {pass:false,sem,before,after,note:'No intercepted owned child target became ready'};
  const loaded=await wait(`location.pathname===${JSON.stringify(link.href)}&&!!document.querySelector('[data-testid="text-anchor-shell"]')`,popup.sessionId);
  const child=await evaluate('({path:location.pathname,href:location.href,ready:document.readyState})',popup.sessionId);
  // Header rendering precedes the domain's sessions-dependent baseline effect.
  // Closing then can release a paused request during inspector detachment.
  const baselineReady=!link.href.startsWith('/domain/')||
    await wait(`!!document.querySelector('[data-testid="card-baseline"]')`,popup.sessionId);
  const quietDeadline=performance.now()+8000;
  let networkQuiet=false;
  while(performance.now()<quietDeadline){
    if(fatal)throw fatal;
    if(!popup.fetchPending&&!Object.keys(popup.apiPending).length&&performance.now()-popup.lastActivity>=1000){networkQuiet=true;break;}
    await sleep(40);
  }
  const settled={baselineReady,networkQuiet,fetchPending:popup.fetchPending,apiPending:{...popup.apiPending},
    quietMs:performance.now()-popup.lastActivity,apiEvents:popup.apiEvents};
  const click=after.clicks[0];
  const pass=loaded&&baselineReady&&networkQuiet&&after.document===before.document&&after.path==='/'&&after.nav.length===0&&after.clicks.length===1&&click.trusted&&!click.prevented&&
    (kind==='control'?click.ctrl:click.type==='auxclick'&&click.button===1)&&child.path===link.href&&
    [...popups.values()].filter(p=>!old.has(p.targetId)).length===1;
  const closed=await browser.browserRpc('Target.closeTarget',{targetId:popup.targetId});
  popup.closed=closed.success===true;
  return {pass:pass&&popup.closed,sem,before,after,child,popup:{...popup},loaded,settled};
}
async function matrix(){
  for(const c of combinations)for(const mode of Object.keys(modes)){
    const prefix=c.id+'/'+mode;scenario=prefix;console.log(prefix);await viewport(c);await navigate(mode);
    const s=await snapshot();observations.push({scenario,kind:'dashboard',snapshot:s});
    record(prefix+'/count',s.cards.length===4&&new Set(s.cards.map(x=>x.domain)).size===4,domains,s.cards.map(x=>x.domain));
    record(prefix+'/order',JSON.stringify(s.cards.map(x=>x.domain))===JSON.stringify(modes[mode].order),modes[mode].order,s.cards.map(x=>x.domain));
    record(prefix+'/sections',s.sectionOrder&&s.history===(mode!=='ramp'),'System Health < conditional Tier History < Domains < Deviations',{ordered:s.sectionOrder,history:s.history});
    record(prefix+'/layout',s.documentWidth<=c.width+1&&[...s.cards,s.system].every(x=>x.rect.x>=-1&&x.rect.right<=c.width+1),c.width,s);
    record(prefix+'/anchors',s.shell==='Protect what grows you.'&&s.dashboard==='Capacity is built, not found.'&&s.theme===c.theme,{shell:'Protect what grows you.',dashboard:'Capacity is built, not found.',theme:c.theme},{shell:s.shell,dashboard:s.dashboard,theme:s.theme});
    record(prefix+'/content',s.cards.every(x=>x.rationale==='Synthetic tier rationale '+x.domain&&x.action==='→ Synthetic tier action '+x.domain&&x.floor===`Floor ${policy[x.domain].sessionFloor}m`&&x.cadence===policy[x.domain].cadence&&
      new RegExp('m\\s*/\\s*'+policy[x.domain].targetMinutes+'m').test(x.text)),'original returned rationale/action/floor/cadence/minute target',s.cards);
    record(prefix+'/style',s.cards.every(x=>x.tier===modes[mode].tiers[domains.indexOf(x.domain)]&&css[x.tier].every(t=>x.classes.split(' ').includes(t)))&&s.cards.every(x=>x.style.textDecoration==='none'),
      'unchanged server tier backgrounds/borders; no link underline',s.cards);
    record(prefix+'/log-controls',s.quickLog&&s.checkmark&&s.fabs===1,'existing Quick Log and one checkmark Dashboard Log FAB',s);
    const start=await tabTo(select('button-user-menu')),forward=[];
    for(const link of links(mode)){
      await key('Tab');forward.push(await active());
      const sem=await semantics(link);
      record(prefix+'/'+link.id+'/semantics',sem.tag==='A'&&sem.href===link.href&&sem.tabIndex===0&&sem.nested===0&&sem.accessible.some(n=>n.role==='link'&&n.name===link.name),
        {tag:'A',href:link.href,accessibleName:link.name,nested:0},sem);
      const f=await focus(link),extra=f.width+f.offset;
      record(prefix+'/'+link.id+'/focus',f.active&&f.visible&&f.outline==='solid'&&f.width>=2&&f.offset>=2&&f.contrastBackground>=3&&f.contrastCard>=3&&
        f.rect.x-extra>=0&&f.rect.right+extra<=f.viewport.w&&f.rect.y-extra>=0&&f.rect.bottom+extra<=f.viewport.h,
        'native Tab :focus-visible; >=2px solid outline, >=3:1 against background/card; not clipped',f);
      if(mode==='sorted'||mode==='ramp'&&link.href==='/system-health'||mode==='advisory'&&link.href==='/domain/martial-arts')
        await screenshot(prefix.replaceAll('/','-')+'-'+link.id+'-focus');
    }
    await key('Tab');forward.push(await active());
    const forwardIds=[...links(mode).map(l=>l.id),'button-declare-deviation'];
    record(prefix+'/forward',start.reachable&&JSON.stringify(forward.map(x=>x.id))===JSON.stringify(forwardIds),
      {from:'button-user-menu',ids:forwardIds},{start,forward});
    const backward=[];for(let i=0;i<6;i++){await key('Tab',true);backward.push(await active())}
    const backwardIds=[...links(mode).map(l=>l.id).reverse(),'button-user-menu'];
    record(prefix+'/backward',JSON.stringify(backward.map(x=>x.id))===JSON.stringify(backwardIds),{shift:true,ids:backwardIds},backward);
    for(const link of links(mode)){
      const entered=await activation(mode,link,'enter');
      record(prefix+'/'+link.id+'/enter',entered.result.pass,'one native trusted Enter click / one correct SPA transition / same document',entered.result);
      record(prefix+'/'+link.id+'/return',entered.returned.pass,'native Tab/Enter return control; one correct SPA transition',entered.returned);
      const pointed=await activation(mode,link,'pointer');
      record(prefix+'/'+link.id+'/pointer',pointed.result.pass&&pointed.returned.pass,'whole-card native pointer route and usable native return; no reload/duplicate',pointed);
    }
    for(const n of [
      {name:'settings',id:'button-settings',href:'/settings'},{name:'decide',id:'button-decide',href:'/decide'},
      {name:'history',id:'button-history',href:'/history'},{name:'quick-log',id:'button-quick-log',href:'/log'},
      {name:'dashboard-fab',id:'fab-dashboard-log',href:'/log'},
    ]){
      await navigate(mode);const tab=await tabTo(select(n.id)),before=await proof(true);
      if(tab.reachable)await key('Enter');await wait('location.pathname==='+JSON.stringify(n.href));await sleep(100);
      const after=await proof();
      if(n.name==='decide'){
        const actual=await evaluate(`({anchor:document.querySelector('[data-testid="text-anchor-decide"]')?.textContent.trim(),fabs:document.querySelectorAll('[data-testid^="fab-"]').length})`);
        record(prefix+'/decide-anchor',actual.anchor==='Execute the policy. Trust the process.'&&actual.fabs===0,'exact Decide anchor / no FAB',actual);
      }
      if(n.name==='history'){
        const actual=await evaluate(`({anchor:document.querySelector('[data-testid="text-anchor-metrics"]')?.textContent.trim(),plus:!!document.querySelector('[data-testid="fab-metrics-quicklog"] svg.lucide-plus'),fabs:document.querySelectorAll('[data-testid^="fab-"]').length})`);
        record(prefix+'/history-anchor',actual.anchor==='Invest in the long game.'&&actual.plus&&actual.fabs===1,'exact History anchor / one plus Quick Log FAB',actual);
        // Native reverse traversal reaches the existing last-in-DOM History FAB
        // without a fixture-size-dependent forward limit through every row action.
        const t=await tabTo(select('fab-metrics-quicklog'),true),b=await proof(true);if(t.reachable)await key('Enter');
        await wait("location.pathname==='/log'");const a=await proof();const returned=await returnHome();
        record(prefix+'/history-log',t.reachable&&single(b,a,'/log')&&returned.pass,'native plus Quick Log reaches /log once; return usable',{tab:t,before:b,after:a,returned});
        // Return to History via the same existing control, to assess its return separately.
        await pointer(select('button-history'));await wait("location.pathname==='/history'");
      }
      const returned=await returnHome();
      record(prefix+'/surround/'+n.name,tab.reachable&&single(before,after,n.href)&&returned.pass,'existing control reachable, single correct route and usable return',{tab,before,after,returned});
    }
    if(c.id==='1280-dark'&&['sorted','ramp'].includes(mode))for(const link of links(mode).slice(0,mode==='sorted'?5:1))for(const kind of ['control','middle']){
      const actual=await modified(mode,link,kind);
      record(prefix+'/'+link.id+'/'+kind,actual.pass,'one owned intercepted new tab at href; unprevented native modifier/auxclick; no parent SPA navigation',actual);
    }
  }
}
async function main(){
  const begin=performance.now(),cleanup={errors:[]};
  try{
    server=http.createServer((req,res)=>{
      const u=new URL(req.url,'http://127.0.0.1');
      if(u.pathname.startsWith('/api/')){errors.push({scenario,error:'API escaped interception: '+u.pathname,atMs:performance.now(),referer:req.headers.referer});res.writeHead(500);return res.end('No backend exists');}
      const file=path.resolve(buildDir,'.'+decodeURIComponent(u.pathname));
      if(!file.startsWith(buildDir+path.sep)&&file!==buildDir){res.writeHead(403);return res.end();}
      const p=fs.existsSync(file)&&fs.statSync(file).isFile()?file:path.join(buildDir,'index.html');
      res.setHeader('Content-Type',p.endsWith('.js')?'application/javascript':p.endsWith('.css')?'text/css':p.endsWith('.svg')?'image/svg+xml':'text/html');
      fs.createReadStream(p).pipe(res);
    });
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
    origin='http://127.0.0.1:'+server.address().port;
    browser=await starter.startOwnedBrowser();
    mainTargetId=(await browser.browserRpc('Target.getTargets')).targetInfos.find(t=>t.type==='page'&&t.browserContextId===browser.metadata.privateContext)?.targetId;
    if(!mainTargetId)throw Error('No page in the verified private owned context');
    browser.onAnyEvent(message=>{
      if(message.method==='Target.attachedToTarget'){
        const {sessionId,targetInfo}=message.params;
        if(targetInfo.targetId===mainTargetId)return;
        if(targetInfo.browserContextId!==browser.metadata.privateContext)return; // Owned blank default page stays paused, never used.
        const popup={sessionId,targetId:targetInfo.targetId,context:targetInfo.browserContextId,ready:false,closed:false,
          fetchPending:0,apiPending:{},apiEvents:[],lastActivity:performance.now()};
        popups.set(popup.targetId,popup);
        track((async()=>{
          await browser.sessionRpc(sessionId,'Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]});
          await browser.sessionRpc(sessionId,'Network.enable');
          await browser.sessionRpc(sessionId,'Runtime.enable');await browser.sessionRpc(sessionId,'Page.enable');
          await browser.sessionRpc(sessionId,'Runtime.runIfWaitingForDebugger');popup.ready=true;
        })());
      }
      if(message.method==='Runtime.exceptionThrown'||message.method==='Runtime.consoleAPICalled'&&message.params.type==='error')
        errors.push({scenario,type:message.method,details:message.params});
      const popup=[...popups.values()].find(p=>p.sessionId===message.sessionId);
      if(popup&&message.method==='Network.requestWillBeSent'&&message.params.request.url.startsWith(origin+'/api/')){
        popup.apiPending[message.params.requestId]=message.params.request.url;
        popup.apiEvents.push({type:'start',url:message.params.request.url,atMs:performance.now()});popup.lastActivity=performance.now();
      }
      if(popup&&['Network.loadingFinished','Network.loadingFailed'].includes(message.method)&&popup.apiPending[message.params.requestId]){
        popup.apiEvents.push({type:message.method,url:popup.apiPending[message.params.requestId],atMs:performance.now()});
        delete popup.apiPending[message.params.requestId];popup.lastActivity=performance.now();
      }
      if(message.method==='Fetch.requestPaused'){
        const current=data,session=message.sessionId;
        if(!current){fatal=Error('Request before invented fixture');errors.push(String(fatal));return;}
        if(popup){popup.fetchPending++;popup.lastActivity=performance.now();}
        track(current.respond(message.params.request,message.params.requestId,(method,params)=>browser.sessionRpc(session,method,params))
          .finally(()=>{if(popup){popup.fetchPending--;popup.lastActivity=performance.now();}}));
      }
    });
    await browser.rpc('Runtime.enable');await browser.rpc('Page.enable');
    await browser.rpc('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]});
    await browser.rpc('Page.addScriptToEvaluateOnNewDocument',{source:observer});
    // Pause newly created owned page targets until their Fetch interception is installed.
    await browser.browserRpc('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:true,flatten:true,filter:[{type:'page',exclude:false}]});
    await matrix();
    const all=[...audits,data].filter(Boolean);
    record('safety/no-data-writes',all.every(a=>a.mutations.length===0),'zero Settings/session/logout/other writes',all.flatMap(a=>a.mutations));
    record('safety/all-api-intercepted',!errors.length&&all.every(a=>a.unknown.length===0),'zero unknown/API escape/runtime/console/fixture errors',errors);
  }catch(e){errors.push({scenario,error:String(e),metadata:e.browserMetadata});if(e.browserMetadata)cleanup.browser=e.browserMetadata;}
  finally{
    if(data)audits.push(data);
    await Promise.allSettled([...pending]);
    if(browser){try{await browser.close()}catch(e){cleanup.errors.push(String(e))}cleanup.browser=browser.metadata}
    if(server){server.closeAllConnections();try{if(server.listening)await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
      cleanup.listenerClosed=!server.listening&&server.address()===null}catch(e){cleanup.errors.push(String(e))}}
    cleanup.profileAbsent=cleanup.browser?!fs.existsSync(cleanup.browser.temporaryRoot):null;
    if(!cleanup.browser?.processExitConfirmed||!cleanup.browser?.temporaryResourcesRemoved||!cleanup.profileAbsent||!cleanup.listenerClosed)
      cleanup.errors.push('STOP: owned cleanup not fully verified');
    const ids=results.map(r=>r.id),identity={expected:expectedIds.length,actual:ids.length,unique:new Set(ids).size,
      missing:expectedIds.filter(id=>!ids.includes(id)),duplicates:ids.filter((id,i)=>ids.indexOf(id)!==i),unexpected:ids.filter(id=>!expectedIds.includes(id))};
    const responseBodies={},fixtureAudits=audits.map(a=>({...a,respond:undefined,responses:a.responses.map(r=>{
      const sha256=hash(JSON.stringify(r.value));responseBodies[sha256]=r.value;return{path:r.path,status:r.status,sha256}})}));
    const report={source,adapter:starter.adapterIdentity,
      harnessFiles:Object.fromEntries(['dashboard-navigation.cjs','dashboard-navigation-fixtures.cjs','dashboard-navigation-browser.cjs','domain-chart-fixtures.cjs','domain-chart-browser.cjs','owned-browser.cjs'].map(p=>[p,hash(fs.readFileSync(path.join(__dirname,p)))])),
      identity,passed:results.filter(r=>r.result==='PASS').length,failed:results.filter(r=>r.result==='FAIL').length,results,observations,
      errors,cleanup,fixtureAudits,responseBodies,popups:[...popups.values()],durationMs:performance.now()-begin,
      complete:!identity.missing.length&&!identity.duplicates.length&&!identity.unexpected.length&&!errors.length,
      limits:['Invented intercepted frontend only; no provider auth/database/backend/startup/owner data/installed-device/production acceptance',
        'Real unmodified clocks and trusted CDP input; no direct focus substitute, synthetic activation or real session/logout/Settings save',
        'No Decide timer or shared router lifecycle source changed; previous real-time inactivity evidence remains separate']};
    report.success=report.complete&&!report.failed&&!cleanup.errors.length;
    fs.writeFileSync(outputDir+'/results.json',JSON.stringify(report,null,2));
    fs.writeFileSync(outputDir+'/cleanup.json',JSON.stringify(cleanup,null,2));
    console.log(JSON.stringify({identity,passed:report.passed,failed:report.failed,errors:errors.length,cleanupErrors:cleanup.errors.length,durationMs:report.durationMs}));
    process.exitCode=report.success?0:1;
  }
}
main().catch(e=>{console.error(e);process.exitCode=1});