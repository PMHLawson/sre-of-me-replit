// node --test tests/browser/owned-browser.test.cjs
// Synthetic pipe/process doubles; no browser discovery, OS changes, or real PID signals.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createPipeClient, verifyOwnership } = require('./owned-browser.cjs');

function harness(timeout = 200) {
  const child = new EventEmitter();
  child.pid = 12345; child.exitCode = null; child.signalCode = null;
  const write = new PassThrough(), read = new PassThrough(), commands = [];
  child.stdio = [null, null, null, write, read];
  write.on('data', chunk => commands.push(JSON.parse(chunk.toString().slice(0, -1))));
  const client = createPipeClient(child, timeout);
  return { child, write, read, commands, client };
}

test('commands use only owned pipe frames and the supplied private session', async () => {
  const h = harness();
  try {
    const response = h.client.rpc('Runtime.evaluate', { expression: '1' }, 'private-session');
    assert.deepEqual(h.commands[0], { id: 1, method: 'Runtime.evaluate', params: { expression: '1' }, sessionId: 'private-session' });
    const frame = Buffer.from(JSON.stringify({ id: 1, result: { value: 1 } }) + '\0');
    h.read.write(frame.subarray(0, 5));
    h.read.write(frame.subarray(5));
    assert.deepEqual(await response, { value: 1 });
  } finally { h.client.dispose(); }
});

test('browser command errors name the rejected method', async () => {
  const h = harness();
  try {
    const response = h.client.rpc('Example.unsupported');
    const checked = assert.rejects(response, { code: 'BROWSER_COMMAND', message: /Example.unsupported.*unsupported/ });
    h.read.write(JSON.stringify({ id: 1, error: { message: 'unsupported' } }) + '\0');
    await checked;
  } finally { h.client.dispose(); }
});

test('non-answer has a bounded timeout, rejects all pending calls and refuses reuse', async () => {
  const h = harness(25);
  try {
    const started = Date.now();
    const responses = await Promise.allSettled([
      h.client.rpc('Runtime.evaluate'), h.client.rpc('Page.captureScreenshot'),
    ]);
    assert(responses.every(r => r.status === 'rejected' && r.reason.code === 'BROWSER_TIMEOUT'));
    assert.match(responses[0].reason.message, /Runtime.evaluate.*25ms/);
    assert(Date.now() - started < 2000);
    assert.equal(h.client.isConnected(), false);
    await assert.rejects(h.client.rpc('Browser.getVersion'), { code: 'BROWSER_TIMEOUT' });
    assert.equal(h.commands.length, 2, 'Fatal connection must not send another command');
  } finally { h.client.dispose(); }
});

test('pipe disconnect immediately rejects pending and future calls', async () => {
  const h = harness();
  try {
    const checked = assert.rejects(h.client.rpc('Runtime.evaluate'), { code: 'BROWSER_DISCONNECTED' });
    h.read.end();
    await checked;
    await assert.rejects(h.client.rpc('Browser.getVersion'), { code: 'BROWSER_DISCONNECTED' });
  } finally { h.client.dispose(); }
});

test('owned child exit rejects pending calls without discovery or reconnect', async () => {
  const h = harness();
  try {
    const checked = assert.rejects(h.client.rpc('Runtime.evaluate'), { code: 'BROWSER_DISCONNECTED' });
    h.child.exitCode = 1;
    h.child.emit('exit', 1, null);
    await checked;
    assert.equal(h.client.isConnected(), false);
  } finally { h.client.dispose(); }
});

test('spawn failure rejects pending startup requests with a clear error', async () => {
  const h = harness();
  try {
    const checked = assert.rejects(h.client.rpc('Browser.getVersion'), { code: 'BROWSER_START', message: /fixture spawn failure/ });
    h.child.emit('error', new Error('fixture spawn failure'));
    await checked;
  } finally { h.client.dispose(); }
});

test('write-pipe failure rejects pending calls', async () => {
  const h = harness();
  try {
    const checked = assert.rejects(h.client.rpc('Runtime.evaluate'), { code: 'BROWSER_DISCONNECTED' });
    h.write.emit('error', new Error('fixture write failure'));
    await checked;
  } finally { h.client.dispose(); }
});

test('malformed browser responses fail closed', async () => {
  const h = harness();
  try {
    const checked = assert.rejects(h.client.rpc('Browser.getVersion'), { code: 'BROWSER_PROTOCOL' });
    h.read.write('not-json\0');
    await checked;
    assert.equal(h.client.isConnected(), false);
  } finally { h.client.dispose(); }
});

test('ownership requires a live spawned child and its exact private profile/pipe', () => {
  const h = harness();
  try {
    verifyOwnership(h.child, ['--remote-debugging-pipe', '--user-data-dir=/owned/profile'], '/owned/profile');
  } finally { h.client.dispose(); }
});

test('wrong profile, missing private pipe, and exited process all reject ownership', () => {
  const h = harness();
  try {
    for (const args of [
      ['--remote-debugging-pipe', '--user-data-dir=/unrelated/profile'],
      ['--remote-debugging-port=9224', '--user-data-dir=/owned/profile'],
    ]) assert.throws(() => verifyOwnership(h.child, args, '/owned/profile'), { code: 'BROWSER_OWNERSHIP' });
    h.child.exitCode = 0;
    assert.throws(() => verifyOwnership(h.child,
      ['--remote-debugging-pipe', '--user-data-dir=/owned/profile'], '/owned/profile'), { code: 'BROWSER_OWNERSHIP' });
  } finally { h.client.dispose(); }
});

// Execute the actual helper with synthetic child/pipes and a newly created real
// temp directory. Fake kill emits exit locally; it never signals a real PID.
function lifecycleHarness({ wrongProfile = false, changedIdentity = false } = {}) {
  const h = harness();
  h.client.dispose();
  const child = new EventEmitter(), write = new PassThrough(), read = new PassThrough();
  child.pid = 12345; child.exitCode = null; child.signalCode = null;
  child.stdio = [null, null, null, write, read];
  const commands = [], signals = [];
  let root, args, statCalls = 0, removals = 0;
  child.kill = signal => {
    signals.push(signal); child.signalCode = signal; child.emit('exit', null, signal);
    return true;
  };
  const fakeFs = {
    mkdtempSync(prefix) { root = fs.mkdtempSync(prefix); return root; },
    lstatSync(file) {
      const stat = fs.lstatSync(file);
      // Adding one can round back to the same Number for large inode values.
      // Toggle between exactly representable values instead.
      if (changedIdentity && ++statCalls > 1) stat.ino = stat.ino === 0 ? 1 : 0;
      return stat;
    },
    promises: { async rm(...params) { removals++; return fs.promises.rm(...params); } },
  };
  write.on('data', chunk => {
    const message = JSON.parse(chunk.toString().slice(0, -1));
    commands.push(message.method);
    const result = {
      'Browser.getVersion': { product: 'Chrome/fixture' },
      'Browser.getBrowserCommandLine': { arguments: wrongProfile ? ['--remote-debugging-pipe', '--user-data-dir=/unrelated/profile'] : args },
      'Target.createBrowserContext': { browserContextId: 'private-context' },
      'Target.createTarget': { targetId: 'private-target' },
      'Target.attachToTarget': { sessionId: 'private-session' },
      'Browser.close': {},
    }[message.method];
    read.write(JSON.stringify({ id: message.id, result }) + '\0');
    if (message.method === 'Browser.close') {
      child.exitCode = 0; child.emit('exit', 0, null);
    }
  });
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'owned-browser.cjs'), 'utf8'), {
    module, Buffer, setTimeout, clearTimeout,
    require(name) {
      if (name === 'node:fs') return fakeFs;
      if (name === 'node:child_process') return { spawn(_executable, commandArgs) { args = commandArgs; return child; } };
      return require(name);
    },
  });
  return { start: module.exports.startOwnedBrowser, commands, signals,
    get root() { return root; }, get removals() { return removals; } };
}

test('failed ownership sends no browser mutation/close and cleans only its own child/temp directory', async () => {
  const h = lifecycleHarness({ wrongProfile: true });
  try {
    await assert.rejects(h.start(), { code: 'BROWSER_OWNERSHIP' });
    assert.deepEqual(h.commands, ['Browser.getVersion', 'Browser.getBrowserCommandLine']);
    assert.deepEqual(h.signals, ['SIGTERM']);
    assert.equal(h.removals, 1);
    assert.equal(fs.existsSync(h.root), false);
  } finally {
    if (h.root && fs.existsSync(h.root)) await fs.promises.rm(h.root, { recursive: true });
  }
});

test('cleanup refuses removal when temporary directory identity no longer matches', async () => {
  const h = lifecycleHarness({ changedIdentity: true });
  try {
    const browser = await h.start();
    await assert.rejects(browser.close(), { code: 'BROWSER_CLEANUP', message: /ownership changed/ });
    assert.equal(h.removals, 0);
    assert.equal(fs.existsSync(h.root), true);
  } finally {
    // This test only simulated identity replacement: its actual freshly-created
    // directory was never replaced and remains owned by this synthetic test.
    if (h.root && fs.existsSync(h.root)) await fs.promises.rm(h.root, { recursive: true });
  }
});