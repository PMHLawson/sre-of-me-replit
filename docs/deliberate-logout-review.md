# SOMR-471 / SOMR-473: deliberate, durable browser-session sign-out

Isolated candidate stacked on reviewed PR42
`6c864cfd752e5ba1b4d5520936c964a2075a0cfd`.
Request identity: objective 15, combined relative estimate 3 points
(2 reliable logout + 1 deliberate logout), nested in—not added to—the existing
273-point plan. No Development adoption or real provider sign-in/sign-out.
Private recovery and operational receipts are deliberately excluded.

## Threat and repair

The previous endpoint mutated login state on GET and discarded Passport's
logout callback error. Its client initiated navigation and then treated mutation
completion as success without a durable server result.

The route is now POST-only, with one exact Origin equal to the previously
validated trusted app origin, plus an explicit X-SRE-Logout intent header.
Duplicate, missing, null, foreign, insecure, trailing-slash/list Origins fail.
Present Sec-Fetch-Site must be same-origin. GET/HEAD fail before session handling;
simple cross-site forms/images/links cannot supply the required intent.
Trusted-address resolution itself is byte-identical to the accepted repair.

The handler awaits the installed Passport save/regenerate sequence, then destroys
the replacement local session before clearing the secure, HttpOnly, SameSite=Lax,
path=/ connect.sid cookie. Failures return a generic 503, never raw errors,
credentials or a local-success claim. A partial failure may already have removed
authentication; the response deliberately says confirmation failed and permits
retry rather than claiming the old authentication is definitely still valid.

The existing Replit end-session URL builder and client identity remain in use.
The exact matched trusted app origin supplies post_logout_redirect_uri; request
redirect parameters are ignored. JSON success drives a genuine top-level browser
navigation, not a fetch-followed redirect. Provider-URL construction or browser
handoff failure is distinguished from local invalidation failure. The app cannot
prove successful completion after navigation to the real external provider.
No assertion is made about revoking all provider tokens.

## Concurrent writes and scope

Installed connect-pg-simple set uses an upsert. A synthetic test demonstrates
that deleting then saving the old session recreates its authenticated row.

NonresurrectingStore retains the installed store's get/destroy/touch/pruning and
replaces set semantics: a loaded/saved session carries a server-only persisted
marker in existing session JSON. Loaded sessions UPDATE existing rows only.
New session IDs INSERT once, without conflict replacement. The marker is set
synchronously before dispatching the first insert. PostgreSQL row locking orders
DELETE against UPDATE; a late update cannot resurrect a deleted row and reports
a sanitized storage failure. Existing pre-candidate sessions gain the marker
when loaded, without a migration or read-time database write.

Direct first-save table bootstrap is supported. The bounded compatibility bridge
uses the installed connect-pg-simple **10.0.0** private query method, which awaits
its existing lazy readiness promise and returns the first row (not pg's Result).
Version/API guards fail closed; there is no invented readiness function, raw-pool
bypass, or disabled automatic initialization. A disposable absent-schema-table
test calls set first, without any preceding store operation. A separate unmarked
legacy record passes through actual middleware, receives synthetic refresh data,
saves normally, then rejects a stale save after deletion. No owner migration is
performed. Cookie lifetime, TTL, maintenance and pool/TLS policy are retained.

The guarantee applies to writes routed through this candidate store. An old
process still using the previous upsert, a direct SQL writer, an already
authorized in-flight business action, other independent browser sessions and
provider tokens are not universally revoked. Later adoption must replace the
old process rather than mix old/new session writers.

## Client state and usability

The sign-out button is disabled while pending. Server success is required before
cancelling and clearing the installed TanStack Query cache. Delayed query results
cannot repopulate that cleared cache. Full navigation discards old in-memory
page state. Failed/network requests retain current client state and show a
retryable “not confirmed” notice. Provider handoff failure after local success
uses a distinct notice and local landing destination.

Independent review correction: the unconfirmed client notice is exactly
“Sign-out could not be confirmed; please retry”. It makes no assertion about
whether partial server invalidation occurred. Confirmed local success followed
by provider-handoff failure remains a distinct outcome.

## Independently inspectable tests

- Installed Passport, express-session and the installed PostgreSQL session store
  operate against an owned disposable synthetic database.
- Original-cookie replay, distinct synthetic identities, repeated requests,
  cookie flags, delayed callbacks, and delayed authenticated-session writes.
- Real database errors injected at save, regeneration destruction and final
  destruction; credential-shaped error sentinels excluded from responses/logs.
- Installed query cancellation/cache behavior and truthful failure outcomes.
- Real headless Chromium executes the bundled actual client helper: it stays
  on the app while response is delayed, then requests the synthetic provider as
  a top-level document. No real provider/account is contacted.
- Existing trusted-address, TLS, WebSocket and application regressions remain
  in the complete single-worker suite.

Retained unsuccessful attempts: a missing test-file brace; redundant creation
of a table already supplied by the synthetic fixture; browser cleanup calling
response completion twice (timeout); and Chromium cache cleanup racing a
terminating descendant (ENOTEMPTY). Corrected browser cleanup is idempotent,
records fixture ownership and uses bounded directory-removal retries. Earlier
failures are not relabeled as passing.

Review acceptance does not authorize owner adoption. Fresh recovery and a
separately approved controlled adoption remain necessary. Actual billing is
unavailable; runtime duration must not be converted into claimed charges.
