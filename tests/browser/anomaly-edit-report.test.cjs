const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { modes, expectedAssertionIds, validateReport, completeReview } = require('./anomaly-edit-report.cjs');
const { runReview } = require('./anomaly-edit.cjs');

function report() {
  return {
    phase: 'after',
    results: expectedAssertionIds('after').map(id => ({ id, result: 'PASS' })),
    checks: Object.entries(modes.after).flatMap(([surface, list]) => list.map(mode => ({ surface, mode }))),
    runtimeExceptions: [], consoleErrors: [], harnessErrors: [],
    cleanup: { errors: [], browser: { ownershipEstablished: true, processExitConfirmed: true, temporaryResourcesRemoved: true } },
  };
}
function fixture(t) {
  const evidence = fs.mkdtempSync(path.join(os.tmpdir(), 'somr452-report-control-'));
  t.after(() => fs.rmSync(evidence, { recursive: true }));
  const metadata = { ownershipEstablished: true, processExitConfirmed: false, temporaryResourcesRemoved: false };
  let closes = 0;
  const browser = { metadata, onEvent() {}, async rpc() { throw Error('Deliberate setup RPC failure'); },
    async close() { closes++; metadata.processExitConfirmed = true; metadata.temporaryResourcesRemoved = true; } };
  return { evidence, browser, closes: () => closes };
}
async function rejected(promise, inspect) {
  await assert.rejects(promise, error => {
    assert.equal(error.name, 'BrowserReviewError');
    assert.equal(error.report.success, false);
    assert.equal(error.report.validation.ok, false);
    inspect?.(error.report);
    return true;
  });
}

test('fixed identities preserve forty before assertions and 109 after assertions', () => {
  assert.equal(expectedAssertionIds('before').length, 40);
  assert.equal(expectedAssertionIds('after').length, 109);
  assert.equal(new Set(expectedAssertionIds('after')).size, 109);
  assert.equal(validateReport(report()).ok, true);
});
for (const [name, mutate] of [
  ['missing final identity after all25 requests', r => r.results.pop()],
  ['duplicate replacing missing identity with unchanged109 count', r => { r.results[r.results.length - 1] = { ...r.results[0] }; }],
  ['unexpected identity', r => r.results.push({ id: 'extra', result: 'PASS' })],
  ['unfinished expected identity', r => { r.results.at(-1).result = 'SKIP'; }],
  ['failed assertion', r => { r.results.at(-1).result = 'FAIL'; }],
  ['runtime exception', r => r.runtimeExceptions.push('Unexpected runtime exception')],
  ['late screenshot failure with all109 identities complete', r => r.harnessErrors.push({ stage: 'failure-screenshot', error: 'Deliberate secondary screenshot failure' })],
  ['unexpected console error even in simulated save scenario', r => r.consoleErrors.push({ surface: 'full', mode: 'save-failure', message: 'Unexpected application crash' })],
  ['cleanup error', r => r.cleanup.errors.push('Deliberate owned cleanup failure')],
  ['unconfirmed browser exit', r => { r.cleanup.browser.processExitConfirmed = false; }],
  ['unremoved owned profile', r => { r.cleanup.browser.temporaryResourcesRemoved = false; }],
]) {
  test('cannot accept ' + name, async t => {
    const f = fixture(t), r = report();
    // Mutation must survive completeReview replacing cleanup with actual
    // owned-resource results; inject cleanup controls into its fake owner.
    if (name === 'cleanup error') f.browser.close = async () => { throw Error('Deliberate owned cleanup failure'); };
    else if (name === 'unconfirmed browser exit') f.browser.close = async () => { f.browser.metadata.temporaryResourcesRemoved = true; };
    else if (name === 'unremoved owned profile') f.browser.close = async () => { f.browser.metadata.processExitConfirmed = true; };
    mutate(r);
    assert.equal(r.checks.length, 25);
    assert.equal(validateReport(r).ok, false);
    await rejected(completeReview({ report: r, ...f }));
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.evidence, 'browser-results.json'))).success, false);
  });
}
test('distinguishes expected simulated network/save console errors from unexpected failures', () => {
  const r = report();
  r.consoleErrors.push(
    { surface: 'full', mode: 'save-failure', message: 'updateSession error: Error: Failed to update session\nsynthetic stack' },
    { surface: 'dialog', mode: 'network', message: 'TypeError: Failed to fetch' },
  );
  const validation = validateReport(r);
  assert.equal(validation.ok, true);
  assert.equal(validation.expectedConsoleErrors.length, 2);
  assert.deepEqual(validation.unexpectedConsoleErrors, []);
});
test('runReview rejects setup failure instead of returning a zero-failure partial run', async t => {
  const f = fixture(t);
  await rejected(runReview({ ...f, origin: 'http://127.0.0.1:1', phase: 'after', reset() {}, state() {},
    startBrowser: async () => { throw Error('Deliberate browser setup failure'); } }), r => {
    assert.equal(r.results.length, 0);
    assert.equal(r.harnessErrors[0].stage, 'setup');
  });
});
test('runReview rejects secondary setup failure and closes only its injected owner', async t => {
  const f = fixture(t);
  await rejected(runReview({ ...f, origin: 'http://127.0.0.1:1', phase: 'after', reset() {}, state() {},
    startBrowser: async () => f.browser }), r => {
    assert.equal(r.cleanup.browser.processExitConfirmed, true);
    assert.equal(r.harnessErrors[0].stage, 'setup');
  });
  assert.equal(f.closes(), 1);
});
test('late secondary step after the last request cannot pass even with all109 identities', async t => {
  const f = fixture(t);
  await rejected(completeReview({ report: report(), ...f,
    finishStep: async () => { throw Error('Deliberate final screenshot/reporting step failure'); } }), r => {
    assert.equal(r.validation.complete, true);
    assert.equal(r.validation.requestsComplete, true);
    assert.equal(r.harnessErrors[0].stage, 'final-step');
  });
  assert.equal(f.closes(), 1);
});
test('failed reporting rejects and still attempts cleanup evidence', async t => {
  const f = fixture(t);
  const attempts = [];
  await rejected(completeReview({ report: report(), ...f, writeFile(file, content) {
    attempts.push(path.basename(file));
    if (file.endsWith('browser-results.json')) throw Error('Deliberate results reporting failure');
    fs.writeFileSync(file, content);
  } }), r => assert(r.harnessErrors.some(e => e.stage.startsWith('reporting:'))));
  assert(attempts.includes('browser-cleanup.json'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.evidence, 'browser-cleanup.json'))).browser.processExitConfirmed, true);
  assert.equal(f.closes(), 1);
});
test('secondary cleanup-report failure invalidates and is saved in subsequent results', async t => {
  const f = fixture(t);
  await rejected(completeReview({ report: report(), ...f, writeFile(file, content) {
    if (file.endsWith('browser-cleanup.json')) throw Error('Deliberate cleanup reporting failure');
    fs.writeFileSync(file, content);
  } }));
  const saved = JSON.parse(fs.readFileSync(path.join(f.evidence, 'browser-results.json')));
  assert.equal(saved.success, false);
  assert(saved.harnessErrors.some(e => e.stage === 'reporting:browser-cleanup.json'));
});
test('complete run returns success only after confirmed cleanup and reporting', async t => {
  const f = fixture(t);
  const r = await completeReview({ report: report(), ...f });
  assert.equal(r.success, true);
  assert.equal(r.validation.observedCount, 109);
  assert.equal(f.closes(), 1);
});