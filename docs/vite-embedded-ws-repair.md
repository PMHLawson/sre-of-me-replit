# Isolated Vite embedded WebSocket repair

Review candidate only. Do not adopt into the owner's running Preview without
independent source acceptance. Root ws 8.21.0 does not repair Vite's embedded ws.

## Provenance and scope

- Advisory: GHSA-96hv-2xvq-fx4p (CVE-2026-48779).
- Upstream implementation:
  https://github.com/websockets/ws/commit/2b2abd458a1b647d0b6033bd62a619c36189839a
- Upstream release:
  https://github.com/websockets/ws/commit/bca91adf15677e47dbe4f959653452727be28b94
- Backport all runtime changes in that implementation commit: receiver chunk
  guard, compressed and uncompressed retained-fragment guards, client/server
  defaults, and both socket-to-receiver propagation paths.
- No version substitution, global override, root ws change or Vite major change.
  The embedded package label remains 8.18.3; this is a local, auditable backport,
  not an official newly released Vite artifact or a claim that every subsequent
  upstream ws change has been incorporated.

## Installation and failure behavior

`npm ci` runs `node script/patch-vite-ws.mjs` through postinstall.
The input must be exactly Vite 7.3.7 with the recorded published bundle SHA-256.
Each patch anchor has an exact multiplicity. The transformed output must match
the recorded patched hash before an atomic rename. Reapplication to that exact
patched output is a no-op. Unexpected versions or content fail installation.
Lifecycle scripts must be enabled; an install using `--ignore-scripts` does not
apply this repair. Run the patch command and focused test explicitly in such
environments before starting Vite.

The existing semver range is intentionally not forcibly changed. Any future
resolution to another Vite release fails closed until this backport is reviewed
and rebased or retired. No dependency lock resolution changes are required.

Upstream defaults are 1,048,576 buffered chunks and 131,072 retained fragments.
Explicit zero disables the respective guard, matching upstream semantics.
Violations use `WS_ERR_TOO_MANY_BUFFERED_PARTS` and close status 1008.
Small configurable limits test behavior without a resource-exhaustion attack.

## Verification

`node --test --test-timeout=10000 script/vite-ws.test.mjs` checks the actual bundle
constructors, not root ws. A byte-identical temporary copy exposes internal
CommonJS constructors solely to test receiver paths and is removed afterward.
The separate real Vite shared-HTTP-server test uses the uninstrumented installed
bundle: token checks, custom messages, reload delivery and receiver defaults.
The root ws package serves only as a client for this HMR integration test.

This does not establish signed-in owner-app behavior, owner Preview adoption,
Production adoption or a new authenticated application session. It exercises
Vite's existing HMR token policy, not the app's identity provider. Database tests
must run with owner database bindings removed and use disposable fixtures.

Ordinary dependency audit can remain unchanged because embedded implementations
are not separate entries in the dependency graph. Review the exact repaired
artifact hash and runtime assertions rather than treating audit counts as proof.
Actual check outcomes and any failed attempts are retained separately in the
private/local review evidence; no backup contents belong in a source review.
