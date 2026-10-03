// Add observation access to the SAME reviewed owned-browser starter.
// No ownership/startup/timeout/cleanup code is changed, and no browser is discovered.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),Module=require('node:module');
const {adaptSource}=require('./domain-chart-browser.cjs');
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
function createStarter(executable){
  if(!path.isAbsolute(executable))throw Error('Explicit absolute Chromium executable required');
  fs.accessSync(executable,fs.constants.X_OK);
  const file=path.join(__dirname,'owned-browser.cjs'),original=fs.readFileSync(file,'utf8');
  let configured=adaptSource(original,executable); // Enforces the accepted controller SHA.
  const needle='rpc: (method, params = {}) => client.rpc(method, params, sessionId),';
  if(configured.split(needle).length!==2)throw Error('Unexpected reviewed RPC site');
  configured=configured.replace(needle,needle+`
      // All RPCs remain on this verified ChildProcess's inherited private pipe.
      browserRpc: (method, params = {}) => client.rpc(method, params),
      sessionRpc: (id, method, params = {}) => client.rpc(method, params, id),
      onAnyEvent: listener => client.onEvent(listener),`);
  const controller=new Module(file,module);controller.filename=file;controller.paths=Module._nodeModulePaths(__dirname);
  controller._compile(configured,file);
  return {...controller.exports,adapterIdentity:{controller:'tests/browser/owned-browser.cjs',originalSha256:hash(original),
    configuredSha256:hash(configured),executable,rpcTimeoutMs:30000,
    additions:'Observation RPC/events for additional owned targets on the SAME private pipe; no attach/discovery fallback',
    unchanged:'PID/profile verification, private context, fatal disconnect/timeout and owned-only cleanup'}};
}
module.exports={createStarter};