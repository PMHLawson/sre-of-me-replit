// Backport ws 2b2abd458a1b647d0b6033bd62a619c36189839a to Vite's bundled ws.
// No dependency substitution: the embedded client, server and receiver are fixed.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const originalHash = '2e71344450b7c25a7fe0848d5ee474fb7342614d900ab9168588986150cbb9f9';
export const digest = value => createHash('sha256').update(value).digest('hex');
export function transform(source) {
  if (digest(source) !== originalHash) throw new Error('Unexpected Vite bundle content');
  let out = source;
  const replace = (from, to, count = 1) => {
    if (out.split(from).length - 1 !== count) throw new Error('Unexpected patch anchor count');
    out = out.split(from).join(to);
  };
  replace('this._maxPayload = options$1.maxPayload | 0;',
    'this._maxBufferedChunks = options$1.maxBufferedChunks | 0;\nthis._maxFragments = options$1.maxFragments | 0;\nthis._maxPayload = options$1.maxPayload | 0;');
  replace('this._bufferedBytes += chunk.length;', `if (this._maxBufferedChunks > 0 && this._buffers.length >= this._maxBufferedChunks) {
cb(this.createError(RangeError, "Too many buffered chunks", false, 1008, "WS_ERR_TOO_MANY_BUFFERED_PARTS"));
return;
}
this._bufferedBytes += chunk.length;`);
  const guard = `if (this._maxFragments > 0 && this._fragments.length >= this._maxFragments) {
cb(this.createError(RangeError, "Too many message fragments", false, 1008, "WS_ERR_TOO_MANY_BUFFERED_PARTS"));
return;
}
`;
  replace('this._messageLength = this._totalPayloadLength;',
    `${guard}this._messageLength = this._totalPayloadLength;`);
  replace('this._fragments.push(buf);', `${guard}this._fragments.push(buf);`);
  replace('maxPayload: 100 * 1024 * 1024,',
    'maxBufferedChunks: 1024 * 1024,\nmaxFragments: 128 * 1024,\nmaxPayload: 100 * 1024 * 1024,', 2);
  for (const obj of ['options$1', 'opts', 'this.options']) {
    replace(`maxPayload: ${obj}.maxPayload,`,
      `maxBufferedChunks: ${obj}.maxBufferedChunks,\nmaxFragments: ${obj}.maxFragments,\nmaxPayload: ${obj}.maxPayload,`);
  }
  return out;
}

export function repair(root = resolve(import.meta.dirname, '..')) {
  const vite = resolve(root, 'node_modules/vite');
  if (JSON.parse(readFileSync(resolve(vite, 'package.json'))).version !== '7.3.7')
    throw new Error('Expected exactly Vite 7.3.7; review and retire/rebase this patch before upgrading');
  const manifest = JSON.parse(readFileSync(resolve(root, 'script/vite-ws-patch.json')));
  const path = resolve(vite, 'dist/node/chunks/config.js');
  const source = readFileSync(path, 'utf8');
  if (digest(source) === manifest.patchedSHA256) return 'already-correct';
  const result = transform(source);
  if (digest(result) !== manifest.patchedSHA256) throw new Error('Unexpected patched output');
  // Validate completely before writing; never leave a partially patched bundle.
  const temporary = `${path}.security-${process.pid}.tmp`;
  writeFileSync(temporary, result, { flag: 'wx' });
  renameSync(temporary, path);
  return 'patched';
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(`Vite embedded ws: ${repair()}`);
