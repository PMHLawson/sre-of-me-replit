const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture,modes,domains}=require('./dashboard-navigation-fixtures.cjs');
const origin='http://127.0.0.1:9876'; // An invented string only; no listener or HTTP request.
const rpc=async(method,params)=>({method,params});
const decode=result=>JSON.parse(Buffer.from(result.params.body,'base64').toString());
for(const mode of Object.keys(modes)){
  test(mode+': invented escalation is deterministic and distinct from owner data',async()=>{
    const f=fixture(mode,origin);
    const result=await f.respond({url:origin+'/api/escalation-state',method:'GET'},'invented-id',rpc);
    assert.equal(result.method,'Fetch.fulfillRequest');assert.equal(result.params.responseCode,200);
    const data=decode(result);
    assert.equal(data.isRampUp,mode==='ramp');
    assert.deepEqual(domains.map(d=>data.perDomain[d].tier),modes[mode].tiers);
    for(const d of domains){assert.equal(data.perDomain[d].rationale,'Synthetic tier rationale '+d);assert.equal(data.perDomain[d].recommendedAction,'Synthetic tier action '+d);}
    assert.equal(f.mutations.length,0);
  });
  test(mode+': wrapper denies Settings writes before the existing fixture can mutate',async()=>{
    const f=fixture(mode,origin),get=()=>f.respond({url:origin+'/api/settings',method:'GET'},'invented-get',rpc);
    const before=decode(await get());
    const result=await f.respond({url:origin+'/api/settings',method:'PATCH',postData:'{"windowDays":42}'},'invented-write',rpc);
    assert.equal(result.method,'Fetch.failRequest');assert.deepEqual(decode(await get()),before);
    assert.equal(f.mutations.length,1);
  });
}
test('blocks foreign origins, logout and unknown API; no network calls in this unit suite',async()=>{
  const f=fixture('sorted',origin);
  assert.equal((await f.respond({url:'https://invented.invalid/api/sessions',method:'GET'},'foreign',rpc)).method,'Fetch.failRequest');
  assert.equal((await f.respond({url:origin+'/api/logout',method:'GET'},'logout',rpc)).method,'Fetch.failRequest');
  const unknown=await f.respond({url:origin+'/api/invented-unknown',method:'GET'},'unknown',rpc);
  assert.equal(unknown.params.responseCode,404);
  assert.equal(f.blocked.length,1);assert.equal(f.mutations.length,1);assert.equal(f.unknown.length,1);
});
test('static same-origin assets continue, while session writes are denied',async()=>{
  const f=fixture('sorted',origin);
  assert.equal((await f.respond({url:origin+'/assets/invented.js',method:'GET'},'asset',rpc)).method,'Fetch.continueRequest');
  assert.equal((await f.respond({url:origin+'/api/sessions',method:'POST',postData:'{}'},'session',rpc)).method,'Fetch.failRequest');
});