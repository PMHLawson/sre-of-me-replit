// Run from candidate: node tests/browser/session-edit.cjs <evidence-directory>
// Existing Chromium through owned private pipes; no provider login or live DB.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { startOwnedBrowser } = require('./owned-browser.cjs');
const { fixture } = require('./session-edit-fixtures.cjs');
const root = path.resolve(__dirname, '../../dist/public');
const evidence = path.resolve(process.argv[2] || path.join(__dirname, '../../.local/review/somr326'));
fs.mkdirSync(evidence, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [], exceptions = [], consoleErrors = [];
let browser, fixtureServer, data, mode;
async function main() {
  fixtureServer = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://fixture.invalid');
    if (u.pathname.startsWith('/api/') || u.pathname === '/service-worker.js') {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end('{"message":"Detached browser fixture only"}');
    }
    let f = path.resolve(root, '.' + u.pathname);
    if (!f.startsWith(root + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(root, 'index.html');
    res.writeHead(200, { 'Content-Type': f.endsWith('.js') ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : 'text/html',
      'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(f));
  });
  await new Promise((resolve, reject) => {
    fixtureServer.once('error', reject);
    fixtureServer.listen(0, '127.0.0.1', resolve);
  });
  const address = fixtureServer.address();
  assert(address && address.address === '127.0.0.1', 'Owned loopback fixture listener unavailable');
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await startOwnedBrowser();
  const rpc = browser.rpc;
  browser.onEvent(m => {
    if (m.method === 'Fetch.requestPaused') {
      data.respond(m.params.request, m.params.requestId, rpc).catch(e => exceptions.push(String(e)));
    } else if (m.method === 'Runtime.exceptionThrown') {
      exceptions.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push({ scenario: mode, message: m.params.args.map(a => a.value || a.description).join(' ') });
    }
  });
  async function evaluate(expression) {
    const r = await rpc('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  async function waitFor(expression) {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await sleep(80);
    }
    throw new Error('Timed out: ' + expression);
  }
  async function click(selector) {
    const point = await evaluate(`(() => {const e=document.querySelector(${JSON.stringify(selector)});
      if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();
      return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    assert(point, 'Control unavailable: ' + selector);
    await rpc('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await rpc('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
    await sleep(100);
  }
  async function screenshot(name) {
    const r = await rpc('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(evidence, name + '.png'), Buffer.from(r.data, 'base64'));
  }
  await rpc('Page.enable');
  await rpc('Runtime.enable');
  await rpc('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await rpc('Emulation.setDeviceMetricsOverride', { width: 1000, height: 900, deviceScaleFactor: 1, mobile: false });
  const modes = ['confirm', 'cancel', 'ordinary', 'clear-prior', 'fail-open-http',
    'fail-open-network', 'save-failure', 'create-ordinary', 'create-confirm'];
  for (const current of modes) {
    mode = current; data = fixture(mode, origin);
    const create = mode.startsWith('create-');
    const anomaly = ['confirm', 'cancel', 'create-confirm'].includes(mode);
    const duration = anomaly || mode.startsWith('fail-open') ? 60 : 35;
    let result = { scenario: mode };
    try {
      const url = origin + '/log?domain=music' + (create ? '' : '&edit=synthetic-edit');
      await rpc('Page.navigate', { url });
      await waitFor(`document.querySelector('[data-testid="input-notes"]')?.value === ${JSON.stringify(create ? '' : data.before.notes)}`);
      await click('[data-testid="input-duration-slider"]');
      for (const key of ['Home', ...Array((duration - 5) / 5).fill('ArrowRight')]) {
        const keyCode = key === 'Home' ? 36 : 39;
        await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key,
          windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
        await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key,
          windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
      }
      await waitFor(`document.querySelector('[data-testid="input-duration-slider"]').value === '${duration}'`);
      await click('[data-testid="button-save-session"]');
      if (anomaly) {
        await waitFor(`!!document.querySelector('[data-testid="modal-anomaly"]')`);
        assert.equal(data.writes.length, 0, 'Mutation before confirmation');
        assert(await evaluate(`document.querySelector('[data-testid="modal-anomaly-confirm"]').disabled`));
        await screenshot(mode + '-prompt');
        if (mode === 'cancel') {
          await click('[data-testid="modal-anomaly-cancel"]');
          assert.equal(data.writes.length, 0);
          assert.equal(await evaluate('location.pathname'), '/log');
          assert.deepEqual(data.session, data.before);
          await screenshot(mode + '-after');
          results.push({ ...result, result: 'PASS', observed: 'Cancel caused no write or state change',
            requests: { anomalyChecks: data.checks, mutations: data.writes }, syntheticSavedSession: data.session });
          continue;
        }
        await click('[data-testid="input-anomaly-note"]');
        await rpc('Input.insertText', { text: '   ' });
        assert(await evaluate(`document.querySelector('[data-testid="modal-anomaly-confirm"]').disabled`));
        assert.equal(data.writes.length, 0, 'Whitespace-only explanation allowed mutation');
        await screenshot(mode + '-whitespace-note');
        // Test both leading and trailing trimming through real text input.
        await rpc('Input.insertText', { text: 'intentional synthetic practice   ' });
        await waitFor(`!document.querySelector('[data-testid="modal-anomaly-confirm"]').disabled`);
        await click('[data-testid="modal-anomaly-confirm"]');
      }
      await waitFor(mode === 'save-failure'
        ? `!!document.querySelector('[data-testid="button-save-session"]') && !document.querySelector('[data-testid="button-save-session"]').disabled && document.querySelector('[data-testid="button-save-session"]').textContent.includes('Save Session')`
        : create ? `!!document.querySelector('[data-testid="toast-post-save"]')` : "location.pathname === '/'");
      await sleep(150);
      assert.equal(data.writes.length, 1);
      assert.equal(data.checks.length, 1);
      const write = data.writes[0];
      assert.equal(write.method, create ? 'POST' : 'PATCH');
      assert.equal(write.body.domain, 'music');
      assert.equal(write.body.durationMinutes, duration);
      const expectedMetadata = { isAnomaly: anomaly, anomalyNote: anomaly ? 'intentional synthetic practice' : null };
      // Validate real request keys independently of synthetic "persistence".
      assert.deepEqual({ isAnomaly: write.body.isAnomaly, anomalyNote: write.body.anomalyNote }, expectedMetadata,
        'Save payload omitted or corrupted resolved anomaly metadata');
      if (create) {
        assert.equal(write.body.notes, undefined, 'Create empty-note behavior changed');
        assert.equal(write.body.reason, undefined, 'Create gained edit reason');
      } else {
        assert.equal(write.body.notes, data.before.notes);
        assert.equal(write.body.reason, 'Post-save edit');
        assert.equal(write.body.timestamp, data.before.timestamp);
      }
      if (mode === 'save-failure') {
        assert.equal(await evaluate('location.pathname'), '/log');
        assert.deepEqual(data.session, data.before);
      } else {
        assert.equal(data.session.durationMinutes, duration);
        assert.equal(data.session.userId, 'synthetic-viewer');
        assert.deepEqual({ isAnomaly: data.session.isAnomaly, anomalyNote: data.session.anomalyNote }, expectedMetadata,
          'Synthetic saved state did not preserve/clear metadata');
        if (!create) assert.equal(data.session.id, data.before.id);
      }
      await screenshot(mode + '-after');
      result = { ...result, result: 'PASS', observed: mode === 'clear-prior'
        ? 'Ordinary edit sent false/null and cleared previous anomaly flag/note'
        : mode === 'save-failure' ? 'Failed PATCH left form enabled and fixture unchanged'
        : anomaly ? 'Save sent true and trimmed explanation; resulting fixture preserved both'
        : mode.startsWith('fail-open') ? 'Unavailable check still allowed save without anomaly metadata'
        : create ? 'Ordinary create preserved POST and empty-note behavior' : 'Ordinary edit saved resolved metadata' };
    } catch (error) {
      result = { ...result, result: 'FAIL', observed: String(error) };
      if (!browser.isConnected()) {
        results.push({ ...result, requests: { anomalyChecks: data.checks, mutations: data.writes },
          syntheticBefore: data.before, syntheticSavedSession: data.session });
        throw error;
      }
      await screenshot(mode + '-failure');
    }
    results.push({ ...result, requests: { anomalyChecks: data.checks, mutations: data.writes },
      syntheticBefore: data.before, syntheticSavedSession: data.session });
  }
  writeReport();
}
function writeReport(error) {
  const report = { source: 'Production-built isolated candidate; synthetic APIs only; external requests blocked',
    isolation: browser?.metadata || error?.browserMetadata, ...(error ? { fatalError: String(error) } : {}),
    results, runtimeExceptions: exceptions, expectedConsoleErrors: consoleErrors,
    limits: ['No real provider login or PostgreSQL transaction was tested.',
      'No pre-existing owner record was accessed or changed.',
      'All classifier fixtures have eight valid samples; no disputed cold-start policy is asserted.'],
    passing: results.filter(r => r.result === 'PASS').length,
    failing: results.filter(r => r.result === 'FAIL').length };
  fs.writeFileSync(path.join(evidence, 'browser-results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (error || report.failing || exceptions.length) process.exitCode = 1;
}
main().catch(e => { console.error(String(e)); writeReport(e); }).finally(async () => {
  // Attempt both cleanups even if one fails; a broken browser must not leave
  // this run's static listener alive, and neither cleanup uses shared resources.
  const cleanup = await Promise.allSettled([
    browser ? browser.close() : Promise.resolve(),
    (async () => {
      if (!fixtureServer) return;
      fixtureServer.closeAllConnections();
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('FIXTURE_CLEANUP: Owned listener did not close within 2000ms')), 2000);
        fixtureServer.close(error => {
          clearTimeout(timer);
          if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error); else resolve();
        });
      });
    })(),
  ]);
  const errors = cleanup.filter(x => x.status === 'rejected').map(x => String(x.reason));
  if (errors.length) {
    errors.forEach(error => console.error(error));
    process.exitCode = 1;
  }
  fs.writeFileSync(path.join(evidence, 'runner-cleanup.json'), JSON.stringify({
    browser: browser?.metadata, ownedFixtureListenerClosed: !fixtureServer?.listening, errors,
  }, null, 2));
});