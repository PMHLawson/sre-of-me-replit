// Chart-only validation configuration; the accepted shared controller is NOT edited.
// No address/port discovery, attach fallback, reusable profile or protocol retry.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');

const CONTROLLER_SHA256 = 'b13aa0964029e9ae16b9217640062bd723b50452d297366ae413c60348d320e6';
const sha256 = source => crypto.createHash('sha256').update(source).digest('hex');
function adaptSource(original, executable) {
  if (sha256(original) !== CONTROLLER_SHA256) {
    throw Error('Accepted owned-browser controller changed; review configuration before running');
  }
  function replaceOnce(source, needle, replacement) {
    if (source.split(needle).length !== 2) throw Error('Expected exactly one controller configuration site: ' + needle);
    return source.replace(needle, replacement);
  }
  let source = replaceOnce(original, "spawn('/repl/tools/bin/chromium',", `spawn(${JSON.stringify(executable)},`);
  source = replaceOnce(source, 'client = createPipeClient(child);', 'client = createPipeClient(child, 30000);');
  source = replaceOnce(source, "stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe']",
    "stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe']");
  source = replaceOnce(source, 'metadata.pid = child.pid;', `metadata.pid = child.pid;
    metadata.rpcTimeoutMs = 30000;
    metadata.startupStderr = '';
    metadata.startupStartedAtMs = Date.now();
    child.stderr.on('data', b => {
      metadata.startupStderr += b.toString().slice(0, Math.max(0, 12000 - metadata.startupStderr.length));
    });`);
  source = replaceOnce(source, "const version = await client.rpc('Browser.getVersion');",
    `const version = await client.rpc('Browser.getVersion');
    metadata.browserVersion = version;
    metadata.startupElapsedMs = Date.now() - metadata.startupStartedAtMs;`);
  return source;
}
function createStarter(executable) {
  if (!path.isAbsolute(executable)) throw Error('Explicit absolute Chromium executable required');
  fs.accessSync(executable, fs.constants.X_OK);
  const file = path.join(__dirname, 'owned-browser.cjs');
  const original = fs.readFileSync(file, 'utf8'), adapted = adaptSource(original, executable);
  // Compile only the SHA-pinned tracked local controller. No downloaded code.
  const controller = new Module(file, module);
  controller.filename = file;
  controller.paths = Module._nodeModulePaths(__dirname);
  controller._compile(adapted, file);
  return {
    ...controller.exports,
    adapterIdentity: { controllerPath: 'tests/browser/owned-browser.cjs',
      originalSourceSha256: sha256(original), configuredSourceSha256: sha256(adapted),
      executable, rpcTimeoutMs: 30000, stderrLimitBytes: 12000,
      changes: ['Chromium executable', 'bounded RPC timeout', 'owned-child stderr capture', 'startup/version telemetry'],
      unchanged: ['inherited private pipes', 'PID/command-line/profile ownership verification', 'new private context and page',
        'fatal timeout/disconnect behavior', 'guarded directory identity', 'owned-only process signalling and cleanup'] },
  };
}
module.exports = {
  adaptSource, createStarter, CONTROLLER_SHA256,
  // domain-chart.cjs supplies this absolute executable as its final CLI argument.
  startOwnedBrowser: async () => createStarter(process.argv[7] || '/repl/tools/bin/chromium').startOwnedBrowser(),
};