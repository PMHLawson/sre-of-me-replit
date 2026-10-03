// Invented, read-only Dashboard data. Every API and foreign request is intercepted.
const {createFixture,policy}=require('./domain-chart-fixtures.cjs');
const domains=['martial-arts','meditation','fitness','music'];
const titles={'martial-arts':'Martial Arts',meditation:'Meditation',fitness:'Fitness',music:'Music'};
const modes={
  sorted:{tiers:['WARNING','BREACH','PAGE','WARNING'],order:['fitness','meditation','martial-arts','music']},
  ties:{tiers:['NOMINAL','NOMINAL','NOMINAL','NOMINAL'],order:domains},
  ramp:{tiers:['NOMINAL','NOMINAL','NOMINAL','NOMINAL'],order:domains},
  advisory:{tiers:['ADVISORY','NOMINAL','NOMINAL','NOMINAL'],order:domains},
};
function fixture(mode,origin){
  if(!modes[mode])throw Error('Unknown invented fixture');
  const base=createFixture('dense',origin),tiers=modes[mode].tiers;
  const output={mode,requests:[],responses:[],mutations:[],blocked:[],unknown:[],
    async respond(request,requestId,rpc){
      const u=new URL(request.url);
      if(u.origin!==origin){output.blocked.push({url:request.url,kind:'foreign-blocked'});return rpc('Fetch.failRequest',{requestId,errorReason:'BlockedByClient'});}
      if(!u.pathname.startsWith('/api/'))return rpc('Fetch.continueRequest',{requestId});
      output.requests.push({method:request.method,path:u.pathname,query:u.search});
      if(request.method!=='GET'||/logout/i.test(u.pathname)){
        output.mutations.push({method:request.method,path:u.pathname});
        return rpc('Fetch.failRequest',{requestId,errorReason:'BlockedByClient'});
      }
      return base.respond(request,requestId,async(method,params)=>{
        if(method!=='Fetch.fulfillRequest')return rpc(method,params);
        const value=JSON.parse(Buffer.from(params.body,'base64').toString('utf8'));
        if(params.responseCode!==200)output.unknown.push({path:u.pathname,status:params.responseCode});
        if(u.pathname==='/api/deviations')value.splice(0);
        if(u.pathname==='/api/policy-state')value.isRampUp=mode==='ramp';
        if(u.pathname==='/api/escalation-state'){
          value.isRampUp=mode==='ramp';
          value.highestTier=mode==='sorted'?'PAGE':mode==='advisory'?'ADVISORY':'NOMINAL';
          domains.forEach((d,i)=>{
            value.perDomain[d].tier=tiers[i];
            value.perDomain[d].rationale=`Synthetic tier rationale ${d}`;
            value.perDomain[d].recommendedAction=`Synthetic tier action ${d}`;
            value.perDomain[d].errorBudget.percentRemaining=[90,40,1,30][i];
          });
          value.composite={...value.composite,tier:value.highestTier,displayStatus:value.highestTier,
            rationale:'Synthetic composite rationale',recommendedAction:'Synthetic composite action',
            domainsByTier:Object.fromEntries(['NOMINAL','ADVISORY','WARNING','BREACH','PAGE'].map(t=>[t,domains.filter((d,i)=>tiers[i]===t)]))};
        }
        output.responses.push({path:u.pathname,status:params.responseCode,value});
        return rpc(method,{...params,body:Buffer.from(JSON.stringify(value)).toString('base64')});
      });
    }};
  return output;
}
module.exports={fixture,domains,titles,modes,policy};