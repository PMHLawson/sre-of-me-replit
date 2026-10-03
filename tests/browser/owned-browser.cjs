// Browser control uses only inherited pipes from our spawned child: no shared
// debugging address, discovery endpoint, reusable profile, or attach fallback.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

function failure(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

function createPipeClient(child, timeoutMs = 3000) {
  const write = child.stdio[3], read = child.stdio[4];
  if (!write || !read) throw failure('BROWSER_OWNERSHIP', 'Owned debugging pipes unavailable');
  let nextId = 0, buffered = Buffer.alloc(0), fatal = null, disposed = false;
  const pending = new Map(), listeners = new Set();
  function fail(error) {
    if (fatal) return;
    fatal = error;
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
  }
  read.on('data', chunk => {
    if (fatal) return;
    buffered = Buffer.concat([buffered, chunk]);
    if (buffered.length > 16 * 1024 * 1024) {
      return fail(failure('BROWSER_PROTOCOL', 'Owned browser response exceeded size limit'));
    }
    let end;
    while ((end = buffered.indexOf(0)) !== -1) {
      const frame = buffered.subarray(0, end);
      buffered = buffered.subarray(end + 1);
      let message;
      try { message = JSON.parse(frame.toString('utf8')); }
      catch { return fail(failure('BROWSER_PROTOCOL', 'Malformed owned browser response')); }
      if (message.id) {
        const item = pending.get(message.id);
        if (!item) continue;
        pending.delete(message.id);
        clearTimeout(item.timer);
        message.error
          ? item.reject(failure('BROWSER_COMMAND', `${item.method}: ${message.error.message}`))
          : item.resolve(message.result);
      } else {
        for (const listener of listeners) {
          try { listener(message); }
          catch (error) { fail(failure('BROWSER_EVENT', String(error))); }
        }
      }
    }
  });
  const disconnected = () => {
    if (!disposed) fail(failure('BROWSER_DISCONNECTED', 'Owned browser pipe disconnected'));
  };
  read.on('end', disconnected);
  read.on('close', disconnected);
  read.on('error', error => fail(failure('BROWSER_DISCONNECTED', error.message)));
  write.on('error', error => fail(failure('BROWSER_DISCONNECTED', error.message)));
  child.on('error', error => fail(failure('BROWSER_START', error.message)));
  child.on('exit', (code, signal) => {
    if (!disposed) fail(failure('BROWSER_DISCONNECTED', `Owned child exited (${signal || code})`));
  });
  return {
    isConnected: () => !fatal && !disposed,
    fail,
    onEvent: listener => listeners.add(listener),
    rpc(method, params = {}, sessionId) {
      if (fatal) return Promise.reject(fatal);
      if (disposed) return Promise.reject(failure('BROWSER_CLOSED', 'Owned browser already closed'));
      if (child.exitCode !== null || child.signalCode !== null) {
        fail(failure('BROWSER_DISCONNECTED', 'Owned child is no longer running'));
        return Promise.reject(fatal);
      }
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => {
          // A non-answer makes the whole connection unusable: do not continue
          // scenarios or try to discover/reconnect to some other browser.
          fail(failure('BROWSER_TIMEOUT', `${method} did not answer within ${timeoutMs}ms`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer, method });
        try {
          write.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0', error => {
            if (error) fail(failure('BROWSER_DISCONNECTED', error.message));
          });
        } catch (error) {
          fail(failure('BROWSER_DISCONNECTED', error.message));
        }
      });
    },
    dispose() {
      disposed = true;
      fail(failure('BROWSER_CLOSED', 'Owned browser cleanup'));
      listeners.clear();
      write.destroy();
      read.destroy();
    },
  };
}

function verifyOwnership(child, args, profile) {
  if (!Number.isInteger(child.pid) || child.pid <= 0 ||
      child.exitCode !== null || child.signalCode !== null ||
      !Array.isArray(args) || !args.includes('--remote-debugging-pipe') ||
      !args.includes(`--user-data-dir=${profile}`)) {
    throw failure('BROWSER_OWNERSHIP', 'Spawned child/private pipe/profile ownership was not established');
  }
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    const finish = exited => {
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
  });
}

async function startOwnedBrowser() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'somr326-owned-browser-'));
  const identity = fs.lstatSync(temporaryRoot);
  const profile = path.join(temporaryRoot, 'profile');
  let child, client, closed = false;
  const metadata = {
    transport: 'inherited-pipe', temporaryRoot, profile, ownershipEstablished: false,
    temporaryIdentity: { dev: identity.dev, ino: identity.ino, uid: identity.uid },
  };
  async function close() {
    if (closed) return;
    closed = true;
    if (client && client.isConnected() && metadata.ownershipEstablished) {
      // Let Chrome flush/close its own subprocesses before removing its profile.
      // This browser-level command travels only over our inherited private pipe.
      metadata.gracefulCloseRequested = true;
      try { await client.rpc('Browser.close'); }
      catch (error) { metadata.gracefulCloseResult = error.code; }
      if (child) await waitForExit(child, 1000);
    }
    if (client) client.dispose();
    if (child && child.pid && child.exitCode === null && child.signalCode === null) {
      // Only this ChildProcess is signaled, never a PID discovered from a port
      // or a process group that could include someone else's browser.
      child.kill('SIGTERM');
      if (!await waitForExit(child, 3000)) {
        child.kill('SIGKILL');
        if (!await waitForExit(child, 2000)) {
          child.unref();
          throw failure('BROWSER_CLEANUP', `Owned child did not exit; retaining ${temporaryRoot}`);
        }
      }
    }
    metadata.processExitConfirmed = true;
    const current = fs.lstatSync(temporaryRoot);
    if (!current.isDirectory() || current.isSymbolicLink() ||
        current.dev !== identity.dev || current.ino !== identity.ino || current.uid !== identity.uid) {
      throw failure('BROWSER_CLEANUP', 'Temporary directory ownership changed; refusing removal');
    }
    await fs.promises.rm(temporaryRoot, { recursive: true, force: false, maxRetries: 8, retryDelay: 100 });
    metadata.temporaryResourcesRemoved = true;
  }
  try {
    child = spawn('/repl/tools/bin/chromium', [
      '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--no-first-run', '--no-default-browser-check', '--enable-automation',
      '--remote-debugging-pipe', `--user-data-dir=${profile}`, 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
    metadata.pid = child.pid;
    client = createPipeClient(child);
    const version = await client.rpc('Browser.getVersion');
    if (!version || !/Chrome/.test(version.product)) throw failure('BROWSER_OWNERSHIP', 'Unexpected browser identity');
    const commandLine = await client.rpc('Browser.getBrowserCommandLine');
    verifyOwnership(child, commandLine?.arguments, profile);
    const context = await client.rpc('Target.createBrowserContext');
    if (!context?.browserContextId) throw failure('BROWSER_OWNERSHIP', 'Private browser context unavailable');
    const target = await client.rpc('Target.createTarget', { url: 'about:blank', browserContextId: context.browserContextId });
    if (!target?.targetId) throw failure('BROWSER_OWNERSHIP', 'Owned page target unavailable');
    const attached = await client.rpc('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    if (!attached?.sessionId) throw failure('BROWSER_OWNERSHIP', 'Owned page session unavailable');
    const sessionId = attached.sessionId;
    metadata.ownershipEstablished = true;
    metadata.privateContext = context.browserContextId;
    return {
      metadata, close, isConnected: client.isConnected,
      rpc: (method, params = {}) => client.rpc(method, params, sessionId),
      onEvent(listener) {
        client.onEvent(message => {
          if ((message.method === 'Target.detachedFromTarget' && message.params?.sessionId === sessionId) ||
              (message.method === 'Inspector.targetCrashed' && message.sessionId === sessionId)) {
            client.fail(failure('BROWSER_DISCONNECTED', 'Owned page session closed or crashed'));
          }
          if (message.sessionId === sessionId) listener(message);
        });
      },
    };
  } catch (error) {
    try { await close(); }
    catch (cleanupError) { error.message += `; ${cleanupError.message}`; }
    error.browserMetadata = metadata;
    throw error;
  }
}
module.exports = { createPipeClient, verifyOwnership, startOwnedBrowser };