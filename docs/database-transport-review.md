# Database transport candidate — isolated review only

## Independent pool-sharing correction

The original shared pool omitted the idle-client error listener that the session
store's internally owned pool previously supplied. The shared pool factory now
handles that event with one fixed sanitized message, never logging the error or
client (including nested credential-bearing properties). Reporting failures are
contained. pg-pool itself discards the failed idle client before this handler;
the handler neither retries requests nor changes active-query errors.

The regression preserves proof that an unhandled error on the old pool throws.
On the guarded pool, a credential-shaped client error passes through pg-pool's
actual idle listener, removes the connection, and logs only the approved literal.
Session reads and database queries then recover on a new backend. A separate
real pg_terminate_backend against that fixture's idle session connection verifies
asynchronous disconnect recovery. All involved records/backends are disposable.
The correction's 23 focused tests, project check, strict source/test typing and
build pass. The previously passing 1,483-test suite is retained, not rerun.

## Scope and policy

The application pool and connect-pg-simple now share one configured pool.
Session TTL, table-creation setting, pruning, authentication, and cookies are
unchanged. This candidate is not adopted in the owner's Preview.

Remote endpoints require TLS 1.2 or newer, trusted certificate chains, and an
identity matching the configured database hostname/IP. Node's normal trust
store is used unless an operator supplies an explicit PEM DATABASE_CA_CERT.
That variable is trusted configuration, not a URL-supplied file path. A custom
CA replaces the default roots; it does not disable identity verification.
No fallback to plaintext or retry with verification disabled exists.

URLs are parsed into explicit credential/endpoint fields, never passed through
to pg as connectionString. Only one sslmode parameter is allowed. `require`
is deliberately strengthened to full verification, as is `verify-full`.
Remote disable/prefer/allow/no-verify/verify-ca, competing URL parameters, service
files, PGSSLROOTCERT/PGSSLCERT/PGSSLKEY, and NODE_TLS_REJECT_UNAUTHORIZED=0 fail
closed. Existing provider URLs with unsupported parameters require explicit
review rather than silently changing their meaning. Errors omit the URL.

The local exceptions are explicit: non-Production Unix-domain socket paths, or
the exact Replit Development hostname `helium`, port 5432, with a Replit project
marker and non-Production mode. Ordinary loopback/private IP addresses and
arbitrary DNS names are not exceptions. Local connections allow absent or
disabled SSL only; contradictory TLS/CA requirements are rejected. Production
Unix sockets are rejected. This is a trusted deployment-configuration boundary,
not permission for untrusted users to select an endpoint.

## Evidence and limitations

Read-only inspection confirmed the owner's Development connection reaches the
local provider endpoint without TLS. The candidate policy also completed
BEGIN READ ONLY / SELECT 1 / ROLLBACK without importing the application or
session initializer, creating tables, or reading owner records.

Disposable PostgreSQL tests exercise both Pool queries and actual
connect-pg-simple operations. Correctly signed and matching TLS works, including
a synthetic session round trip. Wrong identity, expired certificates, an
untrusted self-signed certificate, missing custom trust, and a plaintext server
are rejected with the expected TLS error, for both consumers.

Production endpoint settings, actual CA chain, and connectivity have NOT been
proved. The Development exception does not establish Production compatibility.
Provider-specific roots must be obtained from an authenticated official
provider source before configuring a private/custom CA. No guessed CA, insecure
bypass, real sign-in, or Production probe is included.

The full isolated suite is justified because pooling is now shared by the
application and authentication session store. Test processes have no owner
database bindings. Attempt logs and positive fixture cleanup receipts are kept
separately from public source.

Two preparation corrections are retained: the first isolated dependency-copy
command exceeded its time allowance and was completed without installation or
resolution changes; the initial project type check found iterator-target and
nullable-host typing errors, corrected without changing compiler configuration.
The first focused run passed before these typing corrections; final verification
is reported separately.

## References and recovery boundary

- https://node-postgres.com/features/ssl
- https://github.com/brianc/node-postgres/issues/2380
- https://nodejs.org/api/tls.html#tlscheckserveridentityhostname-cert
- https://docs.replit.com/features/data-and-storage/connection-details
- https://docs.replit.com/features/data-and-storage/development-and-production

Existing private cloud recovery protection remains untouched. It covers an
earlier consistent snapshot, not practices recorded subsequently. Adoption
requires a NEW fresh snapshot and separate authorization/review; code rollback
must never rewind owner data. This candidate changes no dependency resolutions,
schema, maintenance policy, scoring, or WebSocket repair.
