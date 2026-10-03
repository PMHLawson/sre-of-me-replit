const fs=require('node:fs'),path=require('node:path'),{performance}=require('node:perf_hooks');
const {startOwnedBrowser}=require('./owned-browser.cjs');
const {fixture}=require('./session-edit-fixtures.cjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function runReview({origin,phase,evidence,reset,state}) {
  if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin))throw Error('Owned origin required');
  fs.mkdirSync(evidence,{recursive:true});
  let browser,mode='setup',surface,synthetic;
  const results=[],checks=[],exceptions=[],consoleErrors=[],responses=[],pendingBodies=[];
  const responseRequests=new Map();
  const record=(id,pass,expected,actual,screenshot)=>results.push({id,result:pass?'PASS':'FAIL',expected,actual,screenshot});
  try {
    browser=await startOwnedBrowser();
    const rpc=browser.rpc;
    browser.onEvent(m=>{
      if(m.method==='Runtime.exceptionThrown')exceptions.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);
      if(m.method==='Runtime.consoleAPICalled'&&m.params.type==='error')consoleErrors.push({mode,surface,message:m.params.args.map(a=>a.value||a.description).join(' ')});
      if(m.method!=='Fetch.requestPaused')return;
      const {request,requestId}=m.params;
      (async()=>{
        const u=new URL(request.url);
        if(u.origin!==origin)return rpc('Fetch.failRequest',{requestId,errorReason:'BlockedByClient'});
        if(u.pathname==='/api/sessions/anomaly-check') {
          const body=JSON.parse(request.postData);checks.push({surface,mode,body});
          if(mode.startsWith('network'))return rpc('Fetch.failRequest',{requestId,errorReason:'Failed'});
          if(mode.startsWith('http')||mode==='create-http'||mode.startsWith('parse')||mode.startsWith('unusable')) {
            return rpc('Fetch.fulfillRequest',{requestId,responseCode:mode.startsWith('http')||mode==='create-http'?503:200,
              responseHeaders:[{name:'Content-Type',value:'application/json'}],
              body:Buffer.from(mode.startsWith('parse')?'{"broken":':mode.startsWith('unusable')?'{}':'{"message":"Synthetic unavailable"}').toString('base64')});
          }
          return rpc('Fetch.continueRequest',{requestId});
        }
        if(u.pathname==='/api/sessions'||u.pathname.startsWith('/api/sessions/'))
          return rpc('Fetch.continueRequest',{requestId});
        return synthetic.respond(request,requestId,rpc);
      })().catch(e=>exceptions.push(String(e)));
    });
    await rpc('Page.enable');await rpc('Runtime.enable');await rpc('Network.enable');
    browser.onEvent(m=>{
      if(m.method==='Network.responseReceived'&&m.params.response.url===origin+'/api/sessions/anomaly-check') {
        const response={surface,mode,status:m.params.response.status};
        responses.push(response);responseRequests.set(m.params.requestId,response);
      }
      if(m.method==='Network.loadingFinished'&&responseRequests.has(m.params.requestId)) {
        const response=responseRequests.get(m.params.requestId);
        pendingBodies.push(rpc('Network.getResponseBody',{requestId:m.params.requestId}).then(r=>{
          try {response.body=JSON.parse(r.base64Encoded?Buffer.from(r.body,'base64').toString():r.body);}
          catch {response.body='Deliberately invalid synthetic JSON';}
        }).catch(e=>{response.bodyUnavailable=String(e);}));
      }
    });
    await rpc('Fetch.enable',{patterns:[{urlPattern:'*'}]});
    await rpc('Emulation.setTimezoneOverride',{timezoneId:'America/New_York'});
    await rpc('Emulation.setDeviceMetricsOverride',{width:1100,height:900,deviceScaleFactor:1,mobile:false});
    await rpc('Page.addScriptToEvaluateOnNewDocument',{source:`{const D=Date,t=D.parse('2026-10-03T12:00:00Z');window.Date=class extends D{constructor(...a){super(...(a.length?a:[t]))}static now(){return t}};}`});
    async function ev(expression) {
      const r=await rpc('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
      if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);
      return r.result.value;
    }
    async function wait(expression) {
      const end=performance.now()+6000;
      while(performance.now()<end){if(await ev(expression))return;await sleep(60);}
      throw Error('Bounded wait: '+expression);
    }
    async function click(id) {
      const p=await ev(`(()=>{const e=document.querySelector('[data-testid="${id}"]');if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      if(!p)throw Error('Missing native click '+id);
      await rpc('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...p});
      await rpc('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...p});await sleep(120);
    }
    async function key(key,code,n,modifiers=0) {
      await rpc('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode:n,modifiers});
      await rpc('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:n,modifiers});
    }
    async function text(id,value) {await click(id);await key('a','KeyA',65,2);await rpc('Input.insertText',{text:value});await sleep(50);}
    async function shot(name) {
      const r=await rpc('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
      const file=name+'.png';fs.writeFileSync(path.join(evidence,file),Buffer.from(r.data,'base64'));return file;
    }
    for(const screen of ['full','dialog']) {
      const modes=phase==='before'?['http','network','parse','unusable','outlier']:
        screen==='full'?['http','network','parse','unusable','ordinary','outlier','cancel','save-failure','http-ack','network-ack','parse-ack','unusable-ack','ordinary-ack','outlier-ack','create-ordinary','create-outlier','create-http']:
        ['http','network','parse','unusable','ordinary','outlier','cancel','save-failure'];
      for(const nextMode of modes) {
        surface=screen;mode=nextMode;reset(mode);synthetic=fixture('ordinary',origin);
        const startChecks=checks.length,id=screen+'-'+mode,create=mode.startsWith('create-');
        const duration=mode.includes('ack')?(mode==='outlier-ack'?5:10):mode==='ordinary'||mode==='create-ordinary'||mode==='create-http'?30:mode==='cancel'||mode==='save-failure'||mode==='create-outlier'?70:51;
        const unavailable=/^(http|network|parse|unusable)/.test(mode)||mode==='create-http';
        const outlier=['outlier','cancel','save-failure','outlier-ack','create-outlier'].includes(mode);
        try {
          await rpc('Page.navigate',{url:origin+(screen==='full'?'/log?domain=music'+(create?'':'&edit=synthetic-edit'):'/history')});
          if(screen==='dialog') {
            await wait(`!!document.querySelector('[data-testid="button-edit-session-synthetic-edit"]')`);
            await click('button-edit-session-synthetic-edit');
            await wait(`!!document.querySelector('[data-testid="input-session-edit-reason"]')`);
            await text('input-session-edit-reason','  synthetic owned regression  ');
            await text('input-session-edit-duration',String(duration));
          } else {
            await wait(`document.querySelector('[data-testid="input-notes"]')?.value===${JSON.stringify(create?'':'synthetic original notes')}`);
            if(duration!==51) {
              await click('input-duration-slider');await key('Home','Home',36);
              for(let n=5;n<duration;n+=5)await key('ArrowRight','ArrowRight',39);
            }
          }
          await click(screen==='full'?'button-save-session':'button-session-edit-submit');
          await wait(`!!document.querySelector('[data-testid="${screen==='full'?'modal-anomaly':'dialog-session-edit-anomaly'}"]') || ${screen==='full'?"location.pathname==='/' || !!document.querySelector('[data-testid=\"modal-below-floor\"]') || !!document.querySelector('[data-testid=\"toast-post-save\"]')":"!document.querySelector('[data-testid=\"dialog-session-edit\"]') || !!document.querySelector('[data-testid=\"text-session-edit-error\"]')"}`);
          const prompt=await ev(`!!document.querySelector('[data-testid="${screen==='full'?'modal-anomaly':'dialog-session-edit-anomaly'}"]')`);
          record(id+'-classification-prompt',prompt===outlier,{outlierPrompt:outlier},{outlierPrompt:prompt,request:checks.at(-1)},await shot(id+'-check'));
          if(prompt) {
            const noteId=screen==='full'?'input-anomaly-note':'input-session-edit-anomaly-note';
            const confirm=screen==='full'?'modal-anomaly-confirm':'button-session-edit-anomaly-confirm';
            await text(noteId,'   ');
            record(id+'-blank-note',await ev(`document.querySelector('[data-testid="${confirm}"]').disabled`)&&state().writes.length===0,
              'Whitespace explanation disables confirmation and sends no save',{disabled:await ev(`document.querySelector('[data-testid="${confirm}"]').disabled`),writes:state().writes},await shot(id+'-blank'));
            if(mode==='cancel') {
              await click(screen==='full'?'modal-anomaly-cancel':'button-session-edit-anomaly-cancel');
              record(id+'-cancel',state().writes.length===0&&state().rows.find(s=>s.id==='synthetic-edit').anomalyNote==='intentional practice',
                'Cancellation leaves owned row unchanged and never saves',state(),await shot(id+'-cancelled'));continue;
            }
            await text(noteId,'  reviewed intentional practice  ');await click(confirm);
          }
          if(screen==='full'&&mode.includes('ack')) {
            await wait(`!!document.querySelector('[data-testid="modal-below-floor"]')`);
            await click('modal-below-floor-confirm');
            await wait(`!!document.querySelector('[data-testid="modal-frequency"]')`);
            const img=await shot(id+'-frequency');await click('modal-frequency-confirm');
            record(id+'-one-check-through-two-acks',checks.length-startChecks===1,'One check across below-floor and same-day-frequency continuations',{checks:checks.slice(startChecks)},img);
          }
          if(mode==='save-failure') {
            await wait(screen==='full'?`!!document.querySelector('[data-testid="button-save-session"]')&&!document.querySelector('[data-testid="button-save-session"]').disabled`:`!!document.querySelector('[data-testid="text-session-edit-error"]')`);
          } else await wait(screen==='full'?(create?`!!document.querySelector('[data-testid="toast-post-save"]')`:`location.pathname==='/'`):`!document.querySelector('[data-testid="dialog-session-edit"]')`);
          await sleep(100);
          const st=structuredClone(state()),saved=st.rows.find(s=>s.id===(create?'synthetic-created':'synthetic-edit'));
          const expectedFlag=mode==='save-failure'||unavailable&&!create||outlier;
          const expectedNote=mode==='save-failure'||unavailable&&!create?'intentional practice':outlier?'reviewed intentional practice':null;
          const passed=st.writes.length===1&&checks.length-startChecks===1&&saved?.isAnomaly===expectedFlag&&saved?.anomalyNote===expectedNote&&
            (mode==='save-failure'?st.audits.length===0&&saved.durationMinutes===51:saved.durationMinutes===duration);
          const image=await shot(id+'-after');
          record(id+'-save',passed,{checks:1,writeAttempts:1,savedFlag:expectedFlag,savedNote:expectedNote,duration:mode==='save-failure'?51:duration},st,image);
          const request=checks.at(-1).body;
          record(id+'-exclusion-request',!('userId'in request)&&(create?!('excludeSessionId'in request):request.excludeSessionId==='synthetic-edit'),
            create?'Creation has no exclusion':'Edit sends its own identifier and no userId',request,image);
          if(!unavailable)record(id+'-actual-route',st.trace.some(t=>t.path==='/api/sessions/anomaly-check'&&t.status===200),
            'Successful classification traverses actual registered route and detector, not canned response',st.trace,image);
          if(unavailable&&!create)record(id+'-no-stale-metadata-write',!('isAnomaly'in st.writes[0].patch)&&!('anomalyNote'in st.writes[0].patch),
            'Unavailable classification omits metadata so stored authoritative values survive',st.writes[0],image);
        } catch(e) {record(id+'-harness',false,'Scenario completes in bounded time',{error:String(e),state:structuredClone(state()),checks:checks.slice(startChecks)},await shot(id+'-failure'));}
      }
    }
  } finally {
    await Promise.allSettled(pendingBodies);
    const cleanup={errors:[]};
    try {if(browser)await browser.close();}catch(e){cleanup.errors.push(String(e));}
    cleanup.browser=browser?.metadata;
    const report={source:'Actual registered anomaly/GET/PATCH/POST routes with synthetic in-memory owned rows; fake principal, not real provider auth',
      phase,results,checks,responses,runtimeExceptions:exceptions,consoleErrors,cleanup,
      passing:results.filter(x=>x.result==='PASS').length,failing:results.filter(x=>x.result==='FAIL').length};
    fs.writeFileSync(path.join(evidence,'browser-results.json'),JSON.stringify(report,null,2));
    fs.writeFileSync(path.join(evidence,'browser-cleanup.json'),JSON.stringify(cleanup,null,2));
    return report;
  }
}
module.exports={runReview};