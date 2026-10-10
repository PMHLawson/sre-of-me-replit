import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import pathModule from 'node:path';
import { once } from 'node:events';
import { createServer as httpServer } from 'node:http';
import { createServer } from 'vite';
import WS from 'ws';
import { repair, transform, digest } from './patch-vite-ws.mjs';

const path = new URL('../node_modules/vite/dist/node/chunks/config.js', import.meta.url);
const instrumented = new URL('./security-test-bundle.mjs', path);
// Only expose constructors from a byte-identical copy; the installed bundle is not instrumented.
fs.writeFileSync(instrumented, fs.readFileSync(path, 'utf8') +
  '\nexport const SecurityReceiver=require_receiver(), SecurityWebSocket=require_websocket(), SecurityServer=require_websocket_server(), SecurityDeflate=require_permessage_deflate();\n');
const { SecurityReceiver: Receiver, SecurityWebSocket: EmbeddedWS, SecurityServer: Server,
  SecurityDeflate: Deflate } = await import(instrumented.href);
test.after(() => fs.unlinkSync(instrumented));
test('strict identity, repeat application and tampered content', () => {
  assert.equal(repair(), 'already-correct');
  assert.throws(() => transform('unknown content'), /Unexpected/);
  assert.equal(digest(fs.readFileSync(path)), JSON.parse(fs.readFileSync(new URL('./vite-ws-patch.json', import.meta.url))).patchedSHA256);
});
test('unexpected installed version and changed bundle fail without writing', () => {
  const root = fs.mkdtempSync(pathModule.join(os.tmpdir(), 'vite-ws-identity-'));
  const vite = pathModule.join(root, 'node_modules/vite');
  try {
    fs.mkdirSync(vite, {recursive:true});
    fs.writeFileSync(pathModule.join(vite,'package.json'), '{"version":"7.3.8"}');
    assert.throws(()=>repair(root), /exactly Vite/);
    fs.writeFileSync(pathModule.join(vite,'package.json'), '{"version":"7.3.7"}');
    fs.mkdirSync(pathModule.join(root,'script'));
    fs.copyFileSync(new URL('./vite-ws-patch.json',import.meta.url),pathModule.join(root,'script/vite-ws-patch.json'));
    fs.mkdirSync(pathModule.join(vite,'dist/node/chunks'),{recursive:true});
    const bundle=pathModule.join(vite,'dist/node/chunks/config.js');
    fs.writeFileSync(bundle,'unexpected');
    assert.throws(()=>repair(root),/Unexpected Vite bundle/);
    assert.equal(fs.readFileSync(bundle,'utf8'),'unexpected');
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
const frame = (byte, data) => Buffer.concat([Buffer.from([byte, data.length]), data]);
async function errorOf(receiver, write) {
  const failure = new Promise(resolve => receiver.once('error', resolve));
  write(receiver);
  const err = await failure;
  assert.equal(err.code, 'WS_ERR_TOO_MANY_BUFFERED_PARTS');
  assert.equal(err[Object.getOwnPropertySymbols(err).find(s => s.description === 'status-code')], 1008);
}
test('uncompressed fragment guard', async () => {
  await errorOf(new Receiver({ maxFragments: 2 }), r => r.write(Buffer.from([2,1,97,0,1,98,0,1,99])));
});
test('buffered chunk guard', async () => {
  await errorOf(new Receiver({ maxBufferedChunks: 2 }), r => {
    r.write(Buffer.from([130,10])); r.write(Buffer.from([97])); r.write(Buffer.from([98])); r.write(Buffer.from([99]));
  });
});
test('compressed fragment guard', async () => {
  const deflate = new Deflate(); deflate.accept([{}]);
  const compress = b => new Promise((resolve,reject) => deflate.compress(b,false,(e,d)=>e?reject(e):resolve(d)));
  try {
    const a = await compress(Buffer.from('foo')), b = await compress(Buffer.from('bar'));
    await errorOf(new Receiver({maxFragments:1,extensions:{'permessage-deflate':deflate}}),
      r=>r.write(Buffer.concat([frame(65,a),frame(0,b)])));
  } finally { deflate.cleanup(); }
});
test('ordinary fragmented messages and explicit zero limit', async () => {
  for (const maxFragments of [0,2]) {
    const r = new Receiver({maxFragments});
    const message = once(r,'message'); r.write(Buffer.from([1,1,97,128,1,98]));
    assert.equal(String((await message)[0]),'ab'); r.destroy();
  }
});
test('embedded client/server defaults and options propagate to receivers', async () => {
  for (const custom of [false,true]) {
    const opts = custom ? {maxFragments:2,maxBufferedChunks:3}: {};
    const server = new Server({port:0,host:'127.0.0.1',...opts}); await once(server,'listening');
    const accepted = once(server,'connection');
    const client = new EmbeddedWS(`ws://127.0.0.1:${server.address().port}`,opts);
    try {
      const [socket] = await accepted; await once(client,'open');
      for (const peer of [socket,client]) {
        assert.equal(peer._receiver._maxFragments,custom?2:131072);
        assert.equal(peer._receiver._maxBufferedChunks,custom?3:1048576);
      }
      const msg=once(socket,'message');client.send('ordinary');assert.equal(String((await msg)[0]),'ordinary');
      socket.terminate();
    } finally { client.terminate();await new Promise(r=>server.close(r)); }
  }
});
test('actual shared-server Vite HMR: token denial/acceptance, custom messages and reload', async () => {
  const http = httpServer();
  const vite = await createServer({configFile:false,server:{middlewareMode:true,hmr:{server:http}},logLevel:'silent'});
  http.on('request',vite.middlewares);http.listen(0,'127.0.0.1');await once(http,'listening');
  const url=`ws://127.0.0.1:${http.address().port}/`;
  const clients=[];
  try {
    for (const token of ['', '?token=incorrect']) {
      const denied = new WS(url+token,'vite-hmr',{origin:'http://localhost',handshakeTimeout:2000});
      clients.push(denied);
      await new Promise((resolve,reject)=>{denied.once('open',()=>reject(Error('unauthorized open')));denied.once('error',resolve);});
    }
    const ws=new WS(url+'?token='+vite.config.webSocketToken,'vite-hmr',{origin:'http://localhost'});
    clients.push(ws);
    const connected=once(ws,'message');await once(ws,'open');assert.equal(JSON.parse(String((await connected)[0])).type,'connected');
    const socket=[...vite.ws.clients][0].socket;
    assert.equal(socket._receiver._maxFragments,131072);
    assert.notEqual(socket.constructor,WS);
    const custom=new Promise(resolve=>vite.ws.on('proof',resolve));
    ws.send(JSON.stringify({type:'custom',event:'proof',data:{synthetic:true}}));
    assert.deepEqual(await custom,{synthetic:true});
    const reload=once(ws,'message');vite.ws.send({type:'full-reload',path:'*'});
    assert.equal(JSON.parse(String((await reload)[0])).type,'full-reload');
  } finally {
    for(const ws of clients)ws.terminate();
    await vite.close();await new Promise(r=>http.close(r));
    assert.equal(http.listening,false);
  }
});
