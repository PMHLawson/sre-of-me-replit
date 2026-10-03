// Actual built application + retained invented API fixture. Never start a backend.
// Usage: node domain-chart.cjs FIXTURE_MODULE BUILD_PUBLIC EVIDENCE SOURCE_IDENTITY_JSON [OWNED_BROWSER_ADAPTER]
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),{performance}=require('node:perf_hooks');
const {startOwnedBrowser}=require(process.argv[6]?path.resolve(process.argv[6]):'./owned-browser.cjs');
const [fixturePath,buildPath,evidencePath,identityPath]=process.argv.slice(2);
if(!fixturePath||!buildPath||!evidencePath||!identityPath)throw Error('Explicit fixture/build/evidence/source identity required');
const {createFixture,NOW,TODAY,windowSets,policy}=require(path.resolve(fixturePath));
const build=path.resolve(buildPath),evidence=path.resolve(evidencePath),source=JSON.parse(fs.readFileSync(identityPath));
fs.mkdirSync(evidence,{recursive:true});
const results=[],observations=[],runtimeErrors=[],consoleErrors=[],fixtureErrors=[],harnessErrors=[],pending=[],fixtureAudits=[];
let browser,browserMetadata,server,data,origin,scenario='setup';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const standard=['choices','buckets','comparison','completed-total','today','pinned','layout','y-tick-bounds','y-tick-alignment',
  'shared-positive-scale','shared-baseline','floor-alignment','target-alignment','threshold-containment',
  'marker-day-count','marker-bounds','outline','deviation','zero-activity','today-notes'];
const dense=[];
for(const width of [1280,360,320])for(const theme of ['dark','light'])for(const domain of ['music','martial-arts'])
  for(const days of [7,14,28,42])dense.push({id:`dense-${domain}-${width}-${theme}-${days}d`,width,theme,domain,days,mode:'dense'});
const specials=['empty','sparse','zero-today','today-only','today-large','history-large','top-marker','no-flags'];
const expectedIds=dense.flatMap(c=>[...standard.map(k=>c.id+'-'+k),c.id+'-tooltip',
  ...([28,42].includes(c.days)?['scroll-left','scroll-right'].map(k=>c.id+'-'+k):[])])
  .concat(specials.flatMap(mode=>standard.map(k=>mode+'-'+k)),
    ['large-today-invariance','top-marker-tooltip','multi-flag-one-circle','range-marker-leak-14','range-marker-leak-7',
      'range-marker-leak-42','domain-marker-leak-music','domain-marker-leak-martial']);
const record=(id,pass,expected,actual)=>results.push({id,result:pass?'PASS':'FAIL',expected,actual});
async function ev(expression){
  const r=await browser.rpc('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
  if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);
  return r.result.value;
}
async function wait(expression){
  const end=performance.now()+8000;
  while(performance.now()<end){if(await ev(expression))return;await sleep(60);}
  throw Error('Bounded chart wait: '+expression);
}
async function click(selector){
  const pt=await ev(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  if(!pt)throw Error('Missing native control '+selector);
  await browser.rpc('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...pt});
  await browser.rpc('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...pt});
  await sleep(120);
}
function invent(mode){
  const f=createFixture(mode,origin);
  if(['history-large','top-marker'].includes(mode)){
    const last=f.sessions.filter(s=>s.domain==='music'&&f.sessionDays[s.id]==='2026-10-02');
    last.forEach((s,i)=>{s.durationMinutes=i?195:5;s.isAnomaly=mode==='top-marker';});
  }
  if(['no-flags','older-flag'].includes(mode))f.sessions.forEach(s=>{s.isAnomaly=false;});
  if(mode==='older-flag')f.sessions.find(s=>s.domain==='music'&&f.sessionDays[s.id]==='2026-09-19').isAnomaly=true;
  if(mode==='music-only-flags')f.sessions.filter(s=>s.domain==='martial-arts').forEach(s=>{s.isAnomaly=false;});
  if(mode==='multi-flag')f.sessions.filter(s=>s.domain==='music'&&f.sessionDays[s.id]==='2026-10-02').forEach(s=>{s.isAnomaly=true;});
  // Independent oracle, never imports the application's aggregation or policy code.
  for(const domain of ['music','martial-arts']){
    const sum=keys=>f.sessions.filter(s=>s.domain===domain&&keys.includes(f.sessionDays[s.id])).reduce((n,s)=>n+s.durationMinutes,0);
    f.expected[domain]={current7:sum(windowSets.w7),previous7:sum(windowSets.prev7),
      completed:Object.fromEntries([7,14,28,42].map(d=>[d,sum(windowSets.w42.slice(-d))])),today:sum([TODAY])};
  }
  return f;
}
async function navigate(domain,mode='dense'){
  if(data)fixtureAudits.push({mode:data.mode,mutations:data.mutations,requests:data.requests,blocked:data.blocked});
  data=invent(mode);
  await browser.rpc('Page.navigate',{url:origin+'/domain/'+domain});
  await wait(`!!document.querySelector('[data-testid="col-today-reference"]')&&!!document.querySelector('[data-testid="chart-y-axis"]')&&!!document.querySelector('.recharts-bar')`);
  await sleep(180);
}
async function theme(color){
  if(await ev(`document.documentElement.classList.contains('dark')?'dark':'light'`)!==color)await click('[aria-label="Toggle Theme"]');
  await sleep(120);
}
async function center(){
  await ev(`document.querySelector('[data-testid="button-range-7d"]').closest('section').scrollIntoView({block:'center'})`);
  await sleep(80);
}
async function shot(name){
  const r=await browser.rpc('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
  fs.writeFileSync(path.join(evidence,name+'.png'),Buffer.from(r.data,'base64'));
  return name+'.png';
}
function domSnapshot(){
  const q=s=>document.querySelector(s),rect=e=>{if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
  const chart=q('[data-testid="button-range-7d"]').closest('section');
  const svg=[...chart.querySelectorAll('svg.recharts-surface')].find(e=>e.querySelector('.recharts-bar'));
  const col=q('[data-testid="col-today-reference"]'),scroller=col.previousElementSibling,rail=q('[data-testid="chart-y-axis"]');
  function bounds(e,glyph=false){
    let r=rect(e);
    if(glyph&&e.firstChild){const range=document.createRange();range.selectNodeContents(e);r=rect(range);}
    let visible={x:0,y:0,right:innerWidth,bottom:innerHeight};const clips=[];
    for(let p=e.parentElement;p;p=p.parentElement){
      const s=getComputedStyle(p),b=rect(p);
      if(['hidden','auto','scroll','clip'].includes(s.overflowX)){visible.x=Math.max(visible.x,b.x+p.clientLeft);visible.right=Math.min(visible.right,b.x+p.clientLeft+p.clientWidth);clips.push({tag:p.tagName,axis:'x',rect:b});}
      if(['hidden','auto','scroll','clip'].includes(s.overflowY)){visible.y=Math.max(visible.y,b.y+p.clientTop);visible.bottom=Math.min(visible.bottom,b.y+p.clientTop+p.clientHeight);clips.push({tag:p.tagName,axis:'y',rect:b});}
      if(p.tagName.toLowerCase()==='svg'){visible.x=Math.max(visible.x,b.x);visible.right=Math.min(visible.right,b.right);visible.y=Math.max(visible.y,b.y);visible.bottom=Math.min(visible.bottom,b.bottom);}
    }
    return{rect:r,elementRect:rect(e),clips,visibleBounds:visible,fullyVisible:!!r&&r.width>0&&r.height>0&&r.x>=visible.x-1&&r.right<=visible.right+1&&r.y>=visible.y-1&&r.bottom<=visible.bottom+1};
  }
  const bars=[...svg.querySelectorAll('.recharts-bar-rectangle')].map(e=>{const p=e.querySelector('path');return{rect:rect(p),stroke:p?.getAttribute('stroke'),fill:p?.getAttribute('fill'),opacity:p?.getAttribute('fill-opacity')};});
  const lines=[...svg.querySelectorAll('.recharts-reference-line-line')].map(e=>({rect:rect(e),dash:e.getAttribute('stroke-dasharray')}));
  const ticks=[...rail.querySelectorAll('span')].map(e=>({text:e.textContent,value:Number(e.textContent),...bounds(e,true)}));
  const markers=[...svg.querySelectorAll('circle[fill="#E2B23E"]')].map(e=>({...bounds(e),pointerEvents:getComputedStyle(e).pointerEvents}));
  const footer=chart.querySelector('.grid.grid-cols-3'),ranges=q('[data-testid="button-range-7d"]').parentElement;
  const raw=q('main').innerText;
  return{width:innerWidth,documentWidth:document.documentElement.scrollWidth,theme:document.documentElement.classList.contains('dark')?'dark':'light',
    clock:new Date().toISOString(),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,path:location.pathname,
    rangeChoices:[...chart.querySelectorAll('[data-testid^="button-range-"]')].map(e=>e.textContent),
    chartTitle:rect(ranges.previousElementSibling),ranges:rect(ranges),svg:rect(svg),bars,lines,ticks,markers,
    axisLabels:[...svg.querySelectorAll('.recharts-xAxis .recharts-cartesian-axis-tick-value')].map(e=>e.textContent),
    comparison:[...footer.children].map(e=>e.firstElementChild.textContent),
    trend:raw.match(/(?:Vs\. Last Week|VS\. LAST WEEK)\s*([\s\S]*?)\s*(\d+m vs \d+m)/i)?.slice(1),
    sloScore:raw.match(/SLO SCORE\s*(\d+)/i)?.[1],sloCaption:raw.match(/\d+% of \d+m\/week SLO[^\n]*/)?.[0],
    today:rect(col),todayPlot:rect(q('[data-testid="plot-today-reference"]')),todayBar:rect(q('[data-testid="bar-today-reference"]')),
    todayBarColor:getComputedStyle(q('[data-testid="bar-today-reference"]')).backgroundColor,
    todayFloor:rect(q('[data-testid="line-today-floor"]')),todayTarget:rect(q('[data-testid="line-today-target"]')),
    todayText:q('[data-testid="text-today-minutes"]').textContent,todayNotes:q('[data-testid="card-today-live"]').innerText,
    todayCount:q('[data-testid="list-today-sessions"]')?.children.length||0,zeroText:q('[data-testid="text-today-no-sessions"]')?.textContent,
    pinned:!scroller.contains(col)&&!scroller.contains(rail),divider:getComputedStyle(col.firstElementChild).borderLeftStyle,
    scroller:{rect:rect(scroller),scrollLeft:scroller.scrollLeft,scrollWidth:scroller.scrollWidth,clientWidth:scroller.clientWidth},
    deviations:[...svg.querySelectorAll('.recharts-reference-area-rect')].map(e=>rect(e)),
  };
}
async function snapshot(id){
  const s=await ev(`(${domSnapshot.toString()})()`);observations.push({id,...s});return s;
}
function check(id,domain,days,s){
  const e=data.expected[domain],keys=windowSets.w42.slice(-days),sessions=data.sessions.filter(x=>x.domain===domain);
  const minutes=keys.map(k=>sessions.filter(x=>data.sessionDays[x.id]===k).reduce((n,x)=>n+x.durationMinutes,0));
  const flags=keys.filter(k=>sessions.some(x=>data.sessionDays[x.id]===k&&x.isAnomaly));
  const zero=s.ticks.find(t=>t.value===0),high=s.ticks.at(-1);
  const baseline=zero.elementRect.y+zero.elementRect.height/2;
  const pxPerMinute=(baseline-high.elementRect.y-high.elementRect.height/2)/high.value;
  const floor=s.lines.find(l=>l.dash==='2 4'),target=s.lines.find(l=>l.dash==='3 3');
  const center=r=>r.y+r.height/2,tolerance=1;
  const positive=s.bars.map((b,i)=>({index:i,minutes:minutes[i],height:b.rect?.height||0,bottom:b.rect?.bottom})).filter(b=>b.minutes>0);
  const metrics={pxPerMinute,baseline,completedMinutes:s.bars.reduce((n,b)=>n+(b.rect?.height||0),0)/pxPerMinute,
    todayHeightError:s.todayBar.height-e.today*pxPerMinute,todayBaselineError:s.todayBar.bottom-baseline,
    floorError:center(s.todayFloor)-floor?.rect.y,targetError:center(s.todayTarget)-target?.rect.y};
  observations.at(-1).measured={...metrics,expectedMinutes:minutes,flaggedDays:flags};
  const r=(key,pass,expected,actual)=>record(id+'-'+key,pass,expected,actual);
  r('choices',s.rangeChoices.join('|')==='7d|14d|28d|42d',['7d','14d','28d','42d'],s.rangeChoices);
  r('buckets',s.bars.length===days,{count:days,last:'2026-10-02',todayExcluded:true},{count:s.bars.length,labels:s.axisLabels});
  const comparison=[e.current7+'m',e.previous7+'m',(e.current7>e.previous7?'+':'')+(e.current7-e.previous7)+'m'];
  r('comparison',s.comparison.join('|')===comparison.join('|'),comparison,s.comparison);
  r('completed-total',pxPerMinute>0&&Math.abs(metrics.completedMinutes-e.completed[days])<0.1,e.completed[days],metrics);
  r('today',s.todayText===(e.today?e.today+'m':'—')&&s.todayCount===(e.today?2:0),{minutes:e.today,count:e.today?2:0},{text:s.todayText,count:s.todayCount});
  r('pinned',s.pinned&&s.divider==='dashed'&&s.today.right<=s.width+1,'Pinned Today and Y labels outside scroller, dashed divider, contained',s.today);
  r('layout',s.documentWidth<=s.width+1&&s.chartTitle.right<=s.ranges.x+1,'No page/range-control overlap',{documentWidth:s.documentWidth,title:s.chartTitle,controls:s.ranges});
  r('y-tick-bounds',s.ticks.length>1&&s.ticks.some(t=>t.text.length>1)&&s.ticks.every(t=>t.fullyVisible),'Every full numeric glyph inside viewport and every clipping ancestor, including multi-digit ticks',s.ticks);
  r('y-tick-alignment',positive.every(b=>Math.abs(b.bottom-baseline)<=tolerance)&&Math.abs(s.todayPlot.bottom-baseline)<=tolerance,'Zero tick, completed baseline and Today plot baseline agree within1 CSSpx',{baseline,positive,todayPlot:s.todayPlot});
  r('shared-positive-scale',positive.every(b=>Math.abs(b.height-b.minutes*pxPerMinute)<=tolerance)&&(e.today===0||Math.abs(metrics.todayHeightError)<=tolerance),'Every positive bar proportional to measured axis; equal minutes/equal height within1px',{positive,metrics});
  r('shared-baseline',positive.every(b=>Math.abs(b.bottom-s.todayBar.bottom)<=tolerance)&&Math.abs(metrics.todayBaselineError)<=tolerance,'Common zero baseline within1 CSSpx',metrics);
  r('floor-alignment',!!floor&&Math.abs(metrics.floorError)<=tolerance&&Math.abs(floor.rect.y-(baseline-policy[domain].sessionFloor*pxPerMinute))<=tolerance,{floor:policy[domain].sessionFloor,tolerance},metrics);
  r('target-alignment',!!target&&Math.abs(metrics.targetError)<=tolerance&&Math.abs(target.rect.y-(baseline-policy[domain].dailyProRate*pxPerMinute))<=tolerance,{target:policy[domain].dailyProRate,tolerance},metrics);
  r('threshold-containment',[floor?.rect,target?.rect,s.todayFloor,s.todayTarget].every(l=>l&&l.y>=s.todayPlot.y-1&&l.bottom<=s.todayPlot.bottom+1&&l.y>=s.ranges.bottom),'Both thresholds inside both actual plotting regions, clear of controls',{floor,target,todayFloor:s.todayFloor,todayTarget:s.todayTarget,plot:s.todayPlot,controls:s.ranges});
  r('marker-day-count',s.markers.length===flags.length,'Exactly one circle per flagged completed day; none otherwise',{expectedDays:flags,circles:s.markers});
  r('marker-bounds',s.markers.every(m=>m.fullyVisible&&m.pointerEvents==='none'&&s.bars.some((b,i)=>flags.includes(keys[i])&&b.rect&&Math.abs((b.rect.x+b.rect.width/2)-(m.rect.x+m.rect.width/2))<=1&&m.rect.bottom<b.rect.y)),'Circle visible above its flagged bar, inside clipping bounds and pointer-transparent',s.markers);
  r('outline',s.bars.filter(b=>b.stroke==='#E2B23E').length===flags.length,'Preserve amber outline on exactly flagged days',s.bars.filter(b=>b.stroke==='#E2B23E'));
  const deviationDays=domain==='music'&&data.deviations.length>0?1:0;
  r('deviation',s.deviations.length===deviationDays,'Preserve existing contiguous completed deviation band',{expected:deviationDays,areas:s.deviations});
  r('zero-activity',e.today?true:s.todayText==='—'&&!!s.zeroText&&s.todayBar.height===2&&s.todayBarColor==='rgba(0, 0, 0, 0)',
    'Zero Today has explicit no-session text and a transparent2px baseline; completed zero buckets have no positive bars',{text:s.todayText,zeroText:s.zeroText,bar:s.todayBar,color:s.todayBarColor});
  r('today-notes',!e.today||(s.todayNotes.includes(domain==='music'?'Invented Today A':'Invented second domain Today A')&&s.todayNotes.includes(domain==='music'?'Invented Today B':'Invented second domain Today B')),'Preserve both invented Today notes',s.todayNotes);
}
async function tooltip(id,s,expected,marker=false){
  const rect=marker?s.markers.at(-1).rect:s.bars.at(-1).rect;
  await browser.rpc('Input.dispatchMouseEvent',{type:'mouseMoved',x:rect.x+rect.width/2,y:rect.y+rect.height/2});
  await sleep(140);
  const tip=await ev(`(()=>{const e=document.querySelector('.recharts-tooltip-wrapper');return{text:e?.innerText||'',visible:e?getComputedStyle(e).visibility==='visible':false}})()`);
  record(id,tip.visible&&expected.every(t=>tip.text.includes(t)),expected,tip);
}
async function main(){
  server=http.createServer((req,res)=>{
    const u=new URL(req.url,'http://invented.invalid');
    if(u.pathname.startsWith('/api/')||u.pathname==='/service-worker.js'){res.writeHead(503);return res.end('Detached frontend; no backend');}
    let file=path.resolve(build,'.'+u.pathname);
    if(!file.startsWith(build+path.sep)||!fs.existsSync(file)||fs.statSync(file).isDirectory())file=path.join(build,'index.html');
    res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html','Cache-Control':'no-store'});
    res.end(fs.readFileSync(file));
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  origin=`http://127.0.0.1:${server.address().port}`;browser=await startOwnedBrowser();
  browser.onEvent(m=>{
    if(m.method==='Fetch.requestPaused')pending.push(data.respond(m.params.request,m.params.requestId,browser.rpc).catch(e=>fixtureErrors.push({scenario,error:String(e)})));
    if(m.method==='Runtime.exceptionThrown')runtimeErrors.push({scenario,error:m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text});
    if(m.method==='Runtime.consoleAPICalled'&&m.params.type==='error')consoleErrors.push({scenario,error:m.params.args.map(a=>a.value||a.description).join(' ')});
  });
  await browser.rpc('Page.enable');await browser.rpc('Runtime.enable');await browser.rpc('Fetch.enable',{patterns:[{urlPattern:'*'}]});
  await browser.rpc('Emulation.setTimezoneOverride',{timezoneId:'America/New_York'});
  await browser.rpc('Page.addScriptToEvaluateOnNewDocument',{source:`{const D=Date,t=D.parse(${JSON.stringify(NOW)});window.Date=class extends D{constructor(...a){super(...(a.length?a:[t]))}static now(){return t}};}`});
  let group='';
  for(const c of dense){
    scenario=c.id;
    const next=`${c.width}-${c.theme}-${c.domain}`;
    if(next!==group){
      await browser.rpc('Emulation.setDeviceMetricsOverride',{width:c.width,height:1000,deviceScaleFactor:1,mobile:false});
      await navigate(c.domain);await theme(c.theme);group=next;
    }
    await click(`[data-testid="button-range-${c.days}d"]`);await center();
    const s=await snapshot(c.id);check(c.id,c.domain,c.days,s);
    if(c.id==='dense-music-1280-dark-14d')await shot('desktop-music-14d');
    if(c.id==='dense-music-320-dark-42d')await shot('narrow-music-42d');
    if(c.id==='dense-martial-arts-320-light-42d')await shot('narrow-light-martial-arts-42d');
    await tooltip(c.id+'-tooltip',s,['Oct 2',c.domain==='music'?'20m':'10m','Anomalous session flagged',...(c.domain==='music'?['Deviation active']:[])]);
    if([28,42].includes(c.days))for(const side of ['left','right']){
      await ev(`document.querySelector('[data-testid="col-today-reference"]').previousElementSibling.scrollLeft=${side==='left'?'0':'1e6'}`);
      await sleep(50);const scroll=await snapshot(c.id+'-scroll-'+side);
      record(c.id+'-scroll-'+side,Math.abs(scroll.today.x-s.today.x)<=1&&Math.abs(scroll.todayBar.bottom-s.todayBar.bottom)<=1&&scroll.ticks.every(t=>t.fullyVisible),
        'Today position/baseline and full Ytick visibility invariant during native scroll',{todayBefore:s.today,todayAfter:scroll.today,ticks:scroll.ticks,scroll:scroll.scroller});
    }
  }
  await browser.rpc('Emulation.setDeviceMetricsOverride',{width:1280,height:1000,deviceScaleFactor:1,mobile:false});await theme('dark');
  for(const mode of specials){
    scenario=mode;await navigate('music',mode);await click('[data-testid="button-range-14d"]');await center();
    const s=await snapshot(mode);check(mode,'music',14,s);
    if(mode==='empty')await shot('empty-music-14d');
    if(mode==='today-large'){
      await shot('large-today-14d');const normal=observations.find(s=>s.id==='dense-music-1280-dark-14d');
      record('large-today-invariance',s.comparison.join('|')===normal.comparison.join('|')&&s.trend?.join('|')===normal.trend?.join('|')&&s.sloScore===normal.sloScore&&s.sloCaption===normal.sloCaption&&s.comparison.join('|')==='140m|200m|-60m',
        'Today20→200 leaves completed14d340, Current140/Prev200/delta-60, trend and supplied SLO context unchanged',{normal:{comparison:normal.comparison,trend:normal.trend,sloScore:normal.sloScore,sloCaption:normal.sloCaption},large:{comparison:s.comparison,trend:s.trend,sloScore:s.sloScore,sloCaption:s.sloCaption}});
    }
    if(mode==='top-marker'){await shot('flagged-bar');await tooltip('top-marker-tooltip',s,['200m','Anomalous session flagged','Deviation active'],true);await shot('flagged-tooltip');}
  }
  scenario='multi-flag';await navigate('music','multi-flag');await center();const multi=await snapshot(scenario);
  record('multi-flag-one-circle',data.sessions.filter(s=>s.domain==='music'&&data.sessionDays[s.id]==='2026-10-02'&&s.isAnomaly).length===2&&multi.markers.length===1,'Two flagged sessions in one completed day produce exactly one visible circle',multi.markers);
  scenario='range-leak';await navigate('music','older-flag');
  for(const days of [14,7,42]){
    await click(`[data-testid="button-range-${days}d"]`);await center();const s=await snapshot('range-marker-leak-'+days);
    record('range-marker-leak-'+days,s.markers.length===(days===7?0:1),'Only in-range flagged day has a marker',{days,circles:s.markers.length});
  }
  scenario='domain-leak';await navigate('music','music-only-flags');await center();const music=await snapshot('domain-marker-leak-music');
  record('domain-marker-leak-music',music.markers.length===1,'Music has one flagged day',music.markers);
  await click('[data-testid="button-back"]');await wait(`!!document.querySelector('[data-testid="card-domain-martial-arts"]')`);
  await click('[data-testid="card-domain-martial-arts"]');await wait(`location.pathname==='/domain/martial-arts'&&!!document.querySelector('.recharts-bar')`);await center();
  const martial=await snapshot('domain-marker-leak-martial');
  record('domain-marker-leak-martial',martial.markers.length===0&&martial.bars.every(b=>b.stroke!=='#E2B23E')&&martial.comparison.join('|')==='70m|100m|-30m','SPA navigation clears Music marker; unflagged Martial Arts has none',martial);
}
async function run(){
  try{await main();}catch(error){browserMetadata=error.browserMetadata;harnessErrors.push({scenario,error:String(error),browserMetadata});}
  const cleanup={errors:[]};
  try{
    let n=0;while(n<pending.length){const batch=pending.slice(n);n+=batch.length;await Promise.allSettled(batch);}
  }catch(error){harnessErrors.push({stage:'pending',error:String(error)});}
  if(data)fixtureAudits.push({mode:data.mode,mutations:data.mutations,requests:data.requests,blocked:data.blocked});
  const settled=await Promise.allSettled([browser?.close(),(async()=>{
    if(!server)return;server.closeAllConnections();await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('Owned static listener cleanup timed out')),2000);
      server.close(e=>{clearTimeout(timer);e?reject(e):resolve();});
    });
  })()]);
  cleanup.errors=settled.filter(r=>r.status==='rejected').map(r=>String(r.reason));
  cleanup.browser=browser?.metadata||browserMetadata;cleanup.ownedListenerClosed=!server?.listening;cleanup.ownerBackendStarted=false;
  cleanup.ownedProfileAbsent=!!cleanup.browser?.temporaryRoot&&!fs.existsSync(cleanup.browser.temporaryRoot);
  const counts=new Map();for(const r of results)counts.set(r.id,(counts.get(r.id)||0)+1);
  const identity={expected:expectedIds.length,actual:results.length,missing:expectedIds.filter(id=>!counts.has(id)),
    duplicates:[...counts].filter(([,n])=>n!==1).map(([id])=>id),unexpected:[...counts.keys()].filter(id=>!expectedIds.includes(id))};
  const passing=results.filter(r=>r.result==='PASS').length,failing=results.filter(r=>r.result!=='PASS').length;
  const success=!failing&&!runtimeErrors.length&&!consoleErrors.length&&!fixtureErrors.length&&!harnessErrors.length&&
    !identity.missing.length&&!identity.duplicates.length&&!identity.unexpected.length&&identity.actual===identity.expected&&
    !cleanup.errors.length&&cleanup.browser?.ownershipEstablished&&cleanup.browser.processExitConfirmed&&cleanup.browser.temporaryResourcesRemoved&&
    cleanup.ownedListenerClosed&&cleanup.ownedProfileAbsent&&fixtureAudits.every(f=>!f.mutations.length);
  const report={source,fixture:{path:fixturePath,clock:NOW,timezone:'America/New_York',dayStartHour:4},success,passing,failing,identity,
    results,observations,runtimeErrors,consoleErrors,fixtureErrors,harnessErrors,fixtureAudits,cleanup,
    limits:'Actual built chart; invented in-memory API responses only. No backend, owner records, SQL or provider verification.'};
  fs.writeFileSync(path.join(evidence,'browser-cleanup.json'),JSON.stringify(cleanup,null,2));
  fs.writeFileSync(path.join(evidence,'route-listener-cleanup.json'),JSON.stringify({ownedListenerClosed:cleanup.ownedListenerClosed,origin,ownerBackendStarted:false},null,2));
  fs.writeFileSync(path.join(evidence,'browser-results.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({success,passing,failing,identity:{expected:identity.expected,actual:identity.actual,missing:identity.missing.length,duplicates:identity.duplicates.length,unexpected:identity.unexpected.length},runtimeErrors,consoleErrors,fixtureErrors,harnessErrors,cleanup}));
  if(!success)process.exitCode=1;
}
run().catch(error=>{console.error(error);process.exitCode=1;});