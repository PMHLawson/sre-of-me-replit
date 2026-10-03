// Detached frontend build + reviewed synthetic browser suite. NEVER executes server code.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
export const FIXTURE_SHA256 = '21c0a6b9c32cb3a59f3c06e15ede0fc1389286601a0f2c5de671d0a3b33e5226';
export function parseArgs(args) {
  const [output, ...options] = args;
  if (!output || !path.isAbsolute(output)) throw Error('Usage: node tests/browser/run-domain-chart.mjs ABS_NEW_OUTPUT [--git-dir ABS_GIT_DIR] [--chromium ABS_EXECUTABLE]');
  const result = { output };
  for (let i = 0; i < options.length; i += 2) {
    const key = options[i], value = options[i + 1];
    if (!['--git-dir', '--chromium'].includes(key) || !value || !path.isAbsolute(value) || result[key]) {
      throw Error('Unknown, duplicate or non-absolute option: ' + key);
    }
    result[key] = value;
  }
  return result;
}
function chromium(explicit) {
  if (explicit) { fs.accessSync(explicit, fs.constants.X_OK); return explicit; }
  const candidates = ['/repl/tools/bin/chromium',
    ...['chromium', 'chromium-browser', 'google-chrome'].flatMap(name =>
      (process.env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.resolve(dir, name)))];
  const executable = candidates.find(p => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } });
  if (!executable) throw Error('Chromium is required; install it in your own local environment or pass --chromium ABS_EXECUTABLE. No download/install is performed.');
  return executable;
}
export async function main(args) {
  const options = parseArgs(args), output = options.output;
  const relative = path.relative(root, output);
  if (!relative.startsWith('..' + path.sep)) throw Error('Evidence must be a NEW directory outside this repository');
  const prefix = options['--git-dir'] ? ['--git-dir=' + options['--git-dir'], '--work-tree=' + root] : ['-C', root];
  const git = (...a) => execFileSync('git', [...prefix, ...a]).toString().trim();
  if (fs.realpathSync(git('rev-parse', '--show-toplevel')) !== fs.realpathSync(root)) {
    throw Error('Git resolved a different checkout; supply --git-dir ABS_GIT_DIR');
  }
  if (git('status', '--porcelain=v1', '--untracked-files=all')) throw Error('Commit the candidate first: exact clean source identity is required');
  const executable = chromium(options['--chromium']);
  const browserModule = require('./domain-chart-browser.cjs');
  const adapterIdentity = browserModule.createStarter(executable).adapterIdentity;
  const fixture = path.join(root, 'tests/browser/domain-chart-fixtures.cjs');
  if (hash(fs.readFileSync(fixture)) !== FIXTURE_SHA256) throw Error('Reviewed invented fixture bytes changed');
  // Refuse overwrite: every failed or successful attempt is its own immutable folder.
  fs.mkdirSync(output, { recursive: false });
  const save = (name, value) => fs.writeFileSync(path.join(output, name), JSON.stringify(value, null, 2), { flag: 'wx' });
  let identity;
  try {
    const paths = git('ls-files', '-z').split('\0').filter(Boolean);
    const sourceFiles = paths.map(p => ({ path: p, blob: git('rev-parse', 'HEAD:' + p), sha256: hash(fs.readFileSync(path.join(root, p))) }));
    identity = { repository: root, commit: git('rev-parse', 'HEAD'), parent: git('rev-parse', 'HEAD^'),
      candidateTree: git('rev-parse', 'HEAD^{tree}'), clean: true, sourceFiles,
      fixture: { path: 'tests/browser/domain-chart-fixtures.cjs', sha256: FIXTURE_SHA256 },
      browserAdapter: adapterIdentity, node: process.version,
      buildConfiguration: 'configFile:false; plugins React/Tailwind; no .env, instrumentation or server execution' };
    save('source-identity-before-build.json', identity);
    const { build } = await import('vite');
    const { default: react } = await import('@vitejs/plugin-react');
    const { default: tailwindcss } = await import('@tailwindcss/vite');
    const buildPublic = path.join(output, 'build/public');
    await build({
      configFile: false, root: path.join(root, 'client'), envDir: path.join(output, 'no-env'),
      cacheDir: path.join(output, 'vite-cache'), plugins: [react(), tailwindcss()],
      resolve: { alias: { '@': path.join(root, 'client/src'), '@shared': path.join(root, 'shared'), '@assets': path.join(root, 'attached_assets') } },
      css: { postcss: { plugins: [] } }, build: { outDir: buildPublic, emptyOutDir: false },
    });
    const walk = (dir, files = {}) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, files);
        else if (e.isFile()) files[path.relative(output, p)] = hash(fs.readFileSync(p));
      }
      return files;
    };
    for (const file of sourceFiles) {
      if (hash(fs.readFileSync(path.join(root, file.path))) !== file.sha256) throw Error('Build changed tracked source: ' + file.path);
    }
    identity = { ...identity, buildFiles: walk(buildPublic) };
    save('source-build-identity.json', identity);
    const browserOutput = path.join(output, 'browser');
    const command = [path.join(root, 'tests/browser/domain-chart.cjs'), fixture, buildPublic, browserOutput,
      path.join(output, 'source-build-identity.json'), path.join(root, 'tests/browser/domain-chart-browser.cjs'), executable];
    save('invocation.json', { executable: process.execPath, arguments: command, cwd: root,
      entrypoint: 'tests/browser/run-domain-chart.mjs', suppliedArguments: args });
    // Let the harness close its own browser/listener; never time out by killing a process group.
    const log = fs.openSync(path.join(output, 'browser-run.log'), 'wx');
    let run;
    try { run = spawnSync(process.execPath, command, { cwd: root, stdio: ['ignore', log, log] }); }
    finally { fs.closeSync(log); }
    if (run.error || run.status !== 0) throw Error('Browser harness failed: ' + (run.error?.message || run.signal || run.status) + '; retain browser-run.log and browser/*.json');
    const report = JSON.parse(fs.readFileSync(path.join(browserOutput, 'browser-results.json')));
    const ids = report.results.map(r => r.id);
    if (report.success !== true || report.passing !== 1224 || report.failing !== 0 ||
        report.identity.expected !== 1224 || report.identity.actual !== 1224 || ids.length !== 1224 || new Set(ids).size !== 1224 ||
        ['missing', 'duplicates', 'unexpected'].some(k => report.identity[k].length) ||
        ['runtimeErrors', 'consoleErrors', 'fixtureErrors', 'harnessErrors'].some(k => report[k].length) ||
        report.cleanup.errors.length || !report.cleanup.browser.ownershipEstablished ||
        !report.cleanup.browser.processExitConfirmed || !report.cleanup.browser.temporaryResourcesRemoved ||
        !report.cleanup.ownedListenerClosed || !report.cleanup.ownedProfileAbsent ||
        fs.existsSync(report.cleanup.browser.temporaryRoot) || report.fixtureAudits.some(a => a.mutations.length)) {
      throw Error('Incomplete assertions, non-clean runtime, mutation or owned cleanup: refusing success');
    }
    for (const [p, expected] of Object.entries(identity.buildFiles)) {
      if (hash(fs.readFileSync(path.join(output, p))) !== expected) throw Error('Built artifact changed during test: ' + p);
    }
    for (const file of identity.sourceFiles) {
      if (hash(fs.readFileSync(path.join(root, file.path))) !== file.sha256) throw Error('Tracked source changed during test: ' + file.path);
    }
    if (git('status', '--porcelain=v1', '--untracked-files=all') || git('rev-parse', 'HEAD^{tree}') !== identity.candidateTree ||
        git('rev-parse', 'HEAD') !== identity.commit) throw Error('Source identity changed during test');
    save('run-summary.json', { success: true, commit: identity.commit, tree: identity.candidateTree,
      assertions: report.passing, sourceBuildIdentity: 'source-build-identity.json',
      rawResults: 'browser/browser-results.json', cleanup: 'browser/browser-cleanup.json' });
    console.log(JSON.stringify({ success: true, assertions: 1224, commit: identity.commit, tree: identity.candidateTree, output }));
  } catch (error) {
    save('run-failure.json', { success: false, error: String(error), commit: identity?.commit, tree: identity?.candidateTree });
    throw error;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error); process.exitCode = 1; });
}