const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { adaptSource, CONTROLLER_SHA256 } = require('./domain-chart-browser.cjs');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
test('fixture is the exact reviewed invented byte stream and independent literals', () => {
  assert.equal(sha(fs.readFileSync(path.join(__dirname, 'domain-chart-fixtures.cjs'))),
    '21c0a6b9c32cb3a59f3c06e15ede0fc1389286601a0f2c5de671d0a3b33e5226');
  const { createFixture } = require('./domain-chart-fixtures.cjs');
  assert.deepEqual(createFixture('dense', 'http://invented.invalid').expected.music,
    { current7: 140, previous7: 200, completed: { 7: 140, 14: 340, 28: 410, 42: 480 }, today: 20 });
});
test('local configuration pins accepted controller and retains safety/cleanup logic', () => {
  const original = fs.readFileSync(path.join(__dirname, 'owned-browser.cjs'), 'utf8');
  assert.equal(sha(original), CONTROLLER_SHA256);
  const adapted = adaptSource(original, '/invented/quote"binary');
  assert(adapted.includes('spawn("/invented/quote\\"binary",'));
  assert(adapted.includes('client = createPipeClient(child, 30000);'));
  for (const marker of ['function createPipeClient', 'function verifyOwnership', 'async function close()', 'const commandLine =', 'const context =', 'return {', '} catch (error) {']) {
    assert(adapted.includes(marker));
  }
  // Whole accepted transport/verification/close and post-start context/event/catch
  // code remain byte-identical; only explicit spawn/config/telemetry sites differ.
  assert.equal(adapted.slice(0, adapted.indexOf('    child = spawn(')),
    original.slice(0, original.indexOf('    child = spawn(')));
  assert.equal(adapted.slice(adapted.indexOf('    if (!version')),
    original.slice(original.indexOf('    if (!version')));
});
test('unknown controller bytes fail closed instead of adapting a changed controller', () => {
  const original = fs.readFileSync(path.join(__dirname, 'owned-browser.cjs'), 'utf8');
  assert.throws(() => adaptSource(original + '\n', '/invented/chromium'), /controller changed/);
});
test('entry-point argument validation needs no private evidence or shell interpolation', async () => {
  const { parseArgs } = await import('./run-domain-chart.mjs');
  assert.deepEqual(parseArgs(['/tmp/new-output']), { output: '/tmp/new-output' });
  assert.deepEqual(parseArgs(['/tmp/new-output', '--chromium', '/tmp/browser']), { output: '/tmp/new-output', '--chromium': '/tmp/browser' });
  for (const args of [[], ['relative'], ['/tmp/a', '--unknown', '/tmp/b'],
    ['/tmp/a', '--chromium', 'relative'], ['/tmp/a', '--git-dir'],
    ['/tmp/a', '--chromium', '/tmp/b', '--chromium', '/tmp/c']]) {
    assert.throws(() => parseArgs(args));
  }
});
test('fixture isolates outbound requests and never calls a live API', async () => {
  const { createFixture } = require('./domain-chart-fixtures.cjs');
  const f = createFixture('dense', 'http://invented.invalid'), calls = [];
  await f.respond({ url: 'https://provider.invalid/api/auth/user', method: 'GET' }, 'invented-request',
    async (method, args) => calls.push({ method, args }));
  assert.deepEqual(calls, [{ method: 'Fetch.failRequest', args: { requestId: 'invented-request', errorReason: 'BlockedByClient' } }]);
  assert.equal(f.requests.length, 0);
  assert.equal(f.blocked.length, 1);
  assert.equal(f.mutations.length, 0);
});