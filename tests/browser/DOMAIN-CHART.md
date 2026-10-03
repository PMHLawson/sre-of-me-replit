# Reproduce the isolated Domain Detail chart review

This command builds the actual frontend from a **clean committed checkout** and
runs the fixed 1,224-assertion chart harness. It does not execute the application
backend, contact a database/auth provider, require credentials, or use owner data.
Only reviewed invented in-memory API responses are supplied.

## Prerequisites and invocation

- Linux, Git and Node **20.19+** (or supported newer Node for Vite 7).
- Install the dependencies already declared in package.json/package-lock.json
  with `npm ci` in your own clone. No new package is required by this repair.
- A Chromium executable with headless private-pipe CDP support. The entry point
  checks `/repl/tools/bin/chromium`, then `chromium`, `chromium-browser` and
  `google-chrome` on PATH; or supply `--chromium /absolute/executable`.
  It does not install/download anything or attach to an existing browser.
- Choose an **absolute, non-existent output directory outside the checkout**.
  Its parent must exist. Existing output is rejected, never overwritten.

From an ordinary clone, with dependencies installed:

```sh
node tests/browser/run-domain-chart.mjs "/tmp/domain-chart-$(date +%s)-$$"
```

To choose Chromium explicitly:

```sh
node tests/browser/run-domain-chart.mjs "/tmp/domain-chart-$(date +%s)-$$" \
  --chromium /absolute/path/to/chromium
```

This isolated Replit candidate uses separate Git metadata rather than a .git
directory in its worktree. From the workspace root, the exact equivalent is:

```sh
cd .local/checkouts/somr453455-review
node tests/browser/run-domain-chart.mjs \
  /home/runner/workspace/.local/review/somr453455-2ad3e8f0/reproducibility-11f886bd/run-1 \
  --git-dir /home/runner/workspace/.local/repository-metadata/somr453455-review \
  --chromium /repl/tools/bin/chromium
```

Use a new output name for subsequent attempts. `--git-dir` is only needed for
nonstandard checkouts; it is not a dependency on earlier private review evidence.
The runner refuses Git accidentally resolving a parent/unrelated checkout.

Run focused reproducibility unit checks (no browser/backend):

```sh
node --test tests/browser/domain-chart-repro.test.cjs
```

## Repository-local dependency inventory

- `run-domain-chart.mjs`: clean source/Git identity; detached Vite frontend build;
  complete SHA-256 source/build inventory; fixed-result and cleanup validation.
  It uses declared Vite/React/Tailwind packages and Node built-ins, not private
  build configs or the backend-oriented npm build/dev commands.
- `domain-chart.cjs`: the unchanged accepted matrix, native interaction and
  screenshot runner; its expected-ID registry rejects missing/duplicate/unexpected
  assertions, runtime/fixture failures, mutations and partial runs.
- `domain-chart-fixtures.cjs`: **byte-for-byte reviewed fixture** from the earlier
  retained packet, SHA-256
  `21c0a6b9c32cb3a59f3c06e15ede0fc1389286601a0f2c5de671d0a3b33e5226`.
  No private fixture file is loaded. The runner refuses different fixture bytes.
- `domain-chart-browser.cjs`: explicit local chart-only configuration of the
  tracked `owned-browser.cjs`. It verifies the accepted controller SHA-256,
  changes only executable selection, 30s bounded RPC timeout, 12KB stderr capture
  and startup/version telemetry, then compiles that known local source. It
  refuses changed controller source or missing/ambiguous configuration sites.
  No external adapter or downloaded code is used. The broader controller file
  and its other callers retain their accepted three-second behavior.
- `owned-browser.cjs`: already tracked shared safety implementation, unchanged.
  Each run spawns its own child/profile, controls it via inherited private pipes,
  verifies PID/command-line/profile ownership, and creates a new private context
  and page. Timeout/disconnection is fatal, not a reconnect/discovery opportunity.
  Cleanup signals only that child, confirms exit, verifies temporary-directory
  device/inode/uid and refuses unsafe removal. Failed startup metadata is retained.

The static listener binds only an ephemeral 127.0.0.1 port; it has no backend.
The fixture blocks every page request to another origin. Unknown APIs fail and
mutations fail acceptance. The original fixture's invented Settings PATCH
implementation is retained for byte identity but this chart run never uses it.

## Output and interpretation

Exit 0 requires **all 1,224 expected assertions exactly once**, no runtime,
console, fixture or harness failures, no mutations, and verified browser process
exit/profile removal/static-listener closure. Never interpret a partial report
as acceptance. Nonzero failures remain in their own output directory; no retries
or automatic overwrites conceal them.

- `source-identity-before-build.json`, `source-build-identity.json`: actual commit,
  parent/tree, full source blob/SHA-256 inventory, build hashes and browser config.
- `invocation.json`, `browser-run.log`, `run-summary.json` (only on success),
  `run-failure.json` (on failure after output creation).
- `browser/browser-results.json`: complete raw measurements, fixed assertion
  identities/results, API request/mutation/blocked-request audits, runtime errors
  and owned-resource metadata.
- `browser/browser-cleanup.json`, `browser/route-listener-cleanup.json`.
- Seven PNGs in `browser/`: desktop-music-14d, narrow-music-42d,
  narrow-light-martial-arts-42d, empty-music-14d, flagged-bar, flagged-tooltip,
  large-today-14d.

The matrix is two domains ×1280/360/320 ×dark/light ×7/14/28/42, plus sparse,
empty/zero/Today-only, large Today/history, near-top marker, duplicate flagged
sessions, range/domain marker leaks, tooltips and native scrolling.

## Prior attempts and limits (not replaced by this reproduction)

The earlier bounded review had **three startup-only failed attempts**: two at
3s and one at 12s. No chart assertions ran in them. The owned diagnostic answered
in about9.7s; a bounded30s/stderr-capturing configuration then passed1,224.
All original artifacts remain retained in the bounded review area. The first
failure predates per-profile metadata capture: the controller reported no cleanup
error, but direct per-profile exit/removal metadata was not saved for that attempt.
That limitation remains; do not claim retrospectively measured proof.

This reproduction does **not** prove these six live integration items:
live server window/score arithmetic; real Settings persistence/legacy migration;
concurrent Settings update runtime; real provider authentication; narrow Settings
save roundtrips; live history date generation. Fixture-supplied scores, settings,
date windows and auth context are synthetic—not live SQL/provider acceptance.