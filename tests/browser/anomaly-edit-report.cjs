const fs = require('node:fs');
const path = require('node:path');

// Fixed scenario/identity contracts, independent of observed requests/results.
const modes = {
  before: {
    full: ['http', 'network', 'parse', 'unusable', 'outlier'],
    dialog: ['http', 'network', 'parse', 'unusable', 'outlier'],
  },
  after: {
    full: ['http', 'network', 'parse', 'unusable', 'ordinary', 'outlier', 'cancel', 'save-failure',
      'http-ack', 'network-ack', 'parse-ack', 'unusable-ack', 'ordinary-ack', 'outlier-ack',
      'create-ordinary', 'create-outlier', 'create-http'],
    dialog: ['http', 'network', 'parse', 'unusable', 'ordinary', 'outlier', 'cancel', 'save-failure'],
  },
};
for (const plan of Object.values(modes)) {
  for (const list of Object.values(plan)) Object.freeze(list);
  Object.freeze(plan);
}
Object.freeze(modes);

function expectedAssertionIds(phase) {
  if (!modes[phase]) throw new Error('Unknown review phase');
  const ids = [];
  for (const [surface, scenarios] of Object.entries(modes[phase])) {
    for (const mode of scenarios) {
      const id = `${surface}-${mode}`;
      const unavailable = /^(http|network|parse|unusable)/.test(mode) || mode === 'create-http';
      ids.push(id + '-classification-prompt');
      // The retained before matrix has no outlier prompt because of the
      // original self-dilution bug. Preserve its original forty identities.
      if (phase === 'after' && ['outlier', 'cancel', 'save-failure', 'outlier-ack', 'create-outlier'].includes(mode)) {
        ids.push(id + '-blank-note');
      }
      if (mode === 'cancel') { ids.push(id + '-cancel'); continue; }
      if (surface === 'full' && mode.includes('ack')) ids.push(id + '-one-check-through-two-acks');
      ids.push(id + '-save', id + '-exclusion-request');
      if (!unavailable) ids.push(id + '-actual-route');
      if (unavailable && !mode.startsWith('create-')) ids.push(id + '-no-stale-metadata-write');
    }
  }
  if (ids.length !== (phase === 'before' ? 40 : 109)) throw new Error('Assertion contract drift');
  return ids;
}

function validateReport(report) {
  const expected = expectedAssertionIds(report.phase);
  const results = report.results || [], counts = new Map();
  for (const row of results) counts.set(row.id, (counts.get(row.id) || 0) + 1);
  const missing = expected.filter(id => !counts.has(id));
  const duplicates = [...counts].filter(([, n]) => n !== 1).map(([id]) => id);
  const unexpected = [...counts.keys()].filter(id => !expected.includes(id));
  const unfinished = results.filter(r => !['PASS', 'FAIL'].includes(r.result)).map(r => r.id);
  const failed = results.filter(r => r.result === 'FAIL').map(r => r.id);
  const expectedScenarios = Object.entries(modes[report.phase]).flatMap(([surface, list]) => list.map(mode => `${surface}-${mode}`));
  const checks = report.checks || [], requestCounts = new Map();
  for (const c of checks) {
    const id = `${c.surface}-${c.mode}`;
    requestCounts.set(id, (requestCounts.get(id) || 0) + 1);
  }
  const requestsComplete = checks.length === expectedScenarios.length &&
    expectedScenarios.every(id => requestCounts.get(id) === 1);
  const expectedConsoleErrors = [], unexpectedConsoleErrors = [];
  for (const entry of report.consoleErrors || []) {
    const simulatedSave = entry.mode === 'save-failure' && ['full', 'dialog'].includes(entry.surface) &&
      /^updateSession error: Error: Failed to update session(?:\n|$)/.test(entry.message);
    const simulatedNetwork = /^network(?:-ack)?$/.test(entry.mode) && /^TypeError: Failed to fetch(?:\n|$)/.test(entry.message);
    (simulatedSave || simulatedNetwork ? expectedConsoleErrors : unexpectedConsoleErrors).push(entry);
  }
  const browser = report.cleanup?.browser;
  const cleanupComplete = !!browser?.ownershipEstablished && !!browser.processExitConfirmed &&
    !!browser.temporaryResourcesRemoved && Array.isArray(report.cleanup?.errors) && report.cleanup.errors.length === 0;
  const complete = !missing.length && !duplicates.length && !unexpected.length && !unfinished.length;
  const ok = complete && requestsComplete && cleanupComplete &&
    Array.isArray(report.runtimeExceptions) && report.runtimeExceptions.length === 0 &&
    !(report.harnessErrors || []).length && !unexpectedConsoleErrors.length &&
    (report.phase === 'before' ? failed.length > 0 : failed.length === 0);
  return { ok, complete, expectedCount: expected.length, observedCount: results.length,
    missing, duplicates, unexpected, unfinished, failed, requestsComplete, cleanupComplete,
    expectedConsoleErrors, unexpectedConsoleErrors };
}

/** Terminal failures are thrown after best-effort evidence and owned cleanup.
 * Never return from finally: that would suppress a late setup/capture error. */
async function completeReview({ report, browser, browserMetadata, evidence,
  pendingOperations = [], finishStep = async () => {}, writeFile = fs.writeFileSync }) {
  report.harnessErrors ||= [];
  const fault = (stage, error) => report.harnessErrors.push({ stage, error: String(error) });
  const cleanup = { errors: [] };
  try {
    let consumed = 0;
    while (consumed < pendingOperations.length) {
      const batch = pendingOperations.slice(consumed);
      consumed += batch.length;
      for (const r of await Promise.allSettled(batch)) if (r.status === 'rejected') fault('pending-operation', r.reason);
    }
    await finishStep();
  } catch (error) {
    fault('final-step', error);
  } finally {
    try { if (browser) await browser.close(); }
    catch (error) { cleanup.errors.push(String(error)); }
    cleanup.browser = browser?.metadata || browserMetadata;
    report.cleanup = cleanup;
  }
  const refresh = () => {
    report.validation = validateReport(report);
    report.expectedConsoleErrors = report.validation.expectedConsoleErrors;
    report.unexpectedConsoleErrors = report.validation.unexpectedConsoleErrors;
    report.passing = report.results.filter(r => r.result === 'PASS').length;
    report.failing = report.results.filter(r => r.result === 'FAIL').length;
    report.success = report.phase === 'after' && report.validation.ok;
  };
  refresh();
  // Attempt both files even if one reporting operation fails, and retain the
  // reporting error in the results file when a subsequent write is possible.
  for (const [file, value] of [['browser-cleanup.json', cleanup], ['browser-results.json', report]]) {
    try { writeFile(path.join(evidence, file), JSON.stringify(value, null, 2)); }
    catch (error) { fault('reporting:' + file, error); }
  }
  if (report.harnessErrors.length) {
    refresh();
    try { writeFile(path.join(evidence, 'browser-results.json'), JSON.stringify(report, null, 2)); }
    catch (error) { fault('reporting:retry', error); refresh(); }
  }
  if (!report.validation.ok) {
    const error = new Error('Browser review failed: incomplete assertions, unexpected failure, or failed cleanup/reporting');
    error.name = 'BrowserReviewError';
    error.report = report;
    throw error;
  }
  return report;
}
module.exports = { modes, expectedAssertionIds, validateReport, completeReview };