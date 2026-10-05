const vm=require('vm'),{createRequire}=require('module');
const common=require('./common.cjs'),{fs,path,out,assert,save}=common;
const source=fs.readFileSync(out+'/capture.cjs','utf8');
const realRequire=createRequire(out+'/capture.cjs'),results=[];
// Expose only the exact internal functions to this offline VM; production module
// exports are unchanged. No Client connects and no child process is spawned.
for(const mode of ['success','short-writes','write-throws-after-prefix','zero-write','fsync-failure','close-failure','publish-failure','post-link-unlink-failure','preexisting-final','preexisting-stage']){
 const dir=fs.mkdtempSync(out+'/test-');fs.chmodSync(dir,0o700);
 const staged=dir+'/COMPLETE.json.partial',final=dir+'/COMPLETE.json',owned=[];
 for(const n of ['dump.cms','inventory.cms']){fs.writeFileSync(dir+'/'+n,'synthetic ciphertext sentinel',{mode:0o600});owned.push(dir+'/'+n);}
 if(mode==='preexisting-final')fs.writeFileSync(final,'unrelated',{mode:0o600});
 if(mode==='preexisting-stage')fs.writeFileSync(staged,'unrelated',{mode:0o600});
 let writes=0,closed=false,unlinked=false;
 const fake={...fs,
 writeSync(fd,b,offset,length){
  if(!mode.startsWith('preexisting'))assert(!fs.existsSync(final),'Marker visible before complete write');
  writes++;
  if(mode==='zero-write')return 0;
  if(mode==='write-throws-after-prefix'){if(writes===1)return fs.writeSync(fd,b,offset,3);throw Error('injected write failure');}
  return fs.writeSync(fd,b,offset,mode==='short-writes'?Math.min(3,length):length);
 },
 fsyncSync(fd){if(mode==='fsync-failure')throw Error('injected sync failure');return fs.fsyncSync(fd);},
 closeSync(fd){fs.closeSync(fd);if(mode==='close-failure'&&!closed){closed=true;throw Error('injected close failure');}},
 linkSync(a,b){assert.equal(fs.readFileSync(a,'utf8'),JSON.stringify({complete:true,syntheticOnly:true},null,2)+'\n');if(mode==='publish-failure')throw Error('injected link failure');return fs.linkSync(a,b);},
 unlinkSync(p){if(mode==='post-link-unlink-failure'&&p===staged&&!unlinked){unlinked=true;throw Error('injected staged unlink failure');}return fs.unlinkSync(p);}
 };
 const module={exports:{}};
 const context={module,exports:module.exports,require:n=>n==='./common.cjs'?{...common,fs:fake}:realRequire(n),Buffer,console,setTimeout,clearTimeout,process};
 vm.runInNewContext(source+'\nmodule.exports.offline={publishReceipt,cleanupArtifacts};',context,{filename:'capture-under-test.cjs'});
 const api=module.exports.offline;let failed=false;
 try{api.publishReceipt({complete:true,syntheticOnly:true},staged,final,owned);}catch{failed=true;api.cleanupArtifacts(owned);}
 if(['success','short-writes'].includes(mode)){
  assert(!failed);assert(fs.existsSync(final)&&!fs.existsSync(staged));
  assert.equal(fs.statSync(final).mode&511,384);assert.equal(JSON.parse(fs.readFileSync(final)).complete,true);
  api.cleanupArtifacts(owned);
 }else assert(failed,'Expected injected rejection');
 const remaining=fs.readdirSync(dir);
 if(mode==='preexisting-final'){assert.deepEqual(remaining,['COMPLETE.json']);assert.equal(fs.readFileSync(final,'utf8'),'unrelated');}
 else if(mode==='preexisting-stage'){assert.deepEqual(remaining,['COMPLETE.json.partial']);assert.equal(fs.readFileSync(staged,'utf8'),'unrelated');}
 else assert.deepEqual(remaining,[]);
 results.push({mode,pass:true,remainingUnownedOnly:remaining});
 assert.equal(fs.realpathSync(dir),dir);assert.equal(fs.statSync(dir).uid,process.getuid());fs.rmSync(dir,{recursive:true});
}
save('receipt-tests.json',{at:new Date().toISOString(),sourceSha256:common.sha(source),offlineOnly:true,noCluster:true,noCapture:true,results});
console.log(JSON.stringify({passed:results.length,offlineOnly:true}));