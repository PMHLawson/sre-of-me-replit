# Owner write resource budget contract (SOMR-468)

This source candidate adds durable resource admission. It does not change practice values, duration/repetition floors, frequency, targets, scores, ownership, retention, or the calculation engine. No existing record is deleted, truncated, normalized or rewritten by the helper.

## Server integration

Use the existing authenticated business transaction and trusted owner identity:

```ts
return withOwnerWriteBudget(tx, authenticatedOwnerId, async ({ admitMutation }) => {
  // Validate input and current state; resolve exact replay/no-op first.
  await admitMutation(); // Immediately before the first actual business/audit DML.
  // Write the business row and its audit in this same transaction.
});
```

The callback and admission must be awaited. Nested and sequential repository operations sharing the exact same Transaction handle and owner reuse one charge. Monitor-only saves do not measure lifetime storage or update its observation. Only explicit capacity enforcement makes the outermost scope check final logical growth; nested admission-only helpers do not finalize early. Do not create a separate Pool transaction or adapter per nested call. A Drizzle adapter must safely bind positional parameters against the same transaction, with one stable adapter identity.

The first helper lock is users(id) FOR UPDATE before invoking the callback. Existing membership/context revalidation keeps its established users-first ordering. Business validation row locks precede counter admission; counter ownership never derives from request body, query, path, IP or unverified claims. Bootstrap needs the authenticated users row but no preexisting organization membership.

The temporary Development adoption adapter retains its ban on business UPDATE/DELETE; it accepts only the helper's two exported exact counter UPDATE statements with validated owner, arity and scalar values. This restores operator seed compatibility without changing its activation/authentication gates. The counter row is inserted/locked lazily only when admitMutation is called. PostgreSQL serializes independent connections and server instances. Counter changes, business changes and audit appends commit or roll back together. Resource/operation failures poison the same SQL transaction with a static failed SELECT, then preserve the original typed error, so catching a JavaScript error cannot commit earlier writes. The existing transaction owner still performs rollback and expires its handles.

## Text boundaries retained by the integrations

Legacy new/changed notes and anomalyNote share one limit: 4,000 UTF-16 code units and 16 KiB of UTF-8 text. New reason fields retain their 500-unit limit. Generic context descriptions retain their existing separate 2,000-unit limit; generic activity notes retain the existing 4,000 UTF-16 limit.

Omitted or exactly unchanged historical oversized text is grandfathered. A legacy oversized field may also be strictly shortened when both its UTF-16 length and UTF-8 byte count do not increase and at least one decreases. This does not authorize trimming, truncation, normalization, or rewriting stored history. Old audit/history validators remain unchanged. Generic immutable raw-observation exact retries reconcile the saved payload before applying stricter new-input bounds; this does not widen the ordinary generic edit envelope.

## Rate and capacity policy

- Default rate: 30 accepted external mutations per UTC fixed minute; 500 per UTC day. These are fixed calendar buckets, not a rolling 60-second limit. An operation with multiple audited row writes consumes one admission. Exact replay/no-op consumes none when the caller does not admit.
- One durable owner row stores minute/day windows and counts. Elapsed buckets reset at admission; a backward clock cannot reopen an earlier allowance.
- Proposed capacity: 100 MiB logical serialized owned JSON UTF-8 bytes, monitor-only by default. Runtime activation of enforceCapacity remains held for Philip's separate decision. Trusted server options may configure capacityBytes and enforceCapacity; request data must never supply these options.
- Optional growth enforcement rejects only when final bytes exceed the cap AND exceed the pre-mutation measurement. Existing above-cap records remain saved/readable. Net reductions are permitted; immutable audit snapshots count as growth too. No deletion or retention policy is implied.
- readOwnerWriteBudgetStatus is read-only and returns only the authenticated owner's asOf, minute/day used/limit/remaining/reset timestamps, and storage usedBytes/limitBytes/enforcement/overLimit. It does not return payload rows or full note text.

Capacity is logical JSON payload size, not physical heap, index, WAL or TOAST disk usage. SQL aggregates include all owner sessions, session_edits, deviations, settings and profile; all owned domains, policy_versions, dimension_definitions, observations, evaluation_results, deviations_v2, deviation_domains and source_bindings; and every user-actor audit event. Soft-deleted rows, old policy versions, canonical copies and before/after audit snapshots remain counted. Shared organization rows, operational HTTP sessions and resource-counter metadata are excluded.

Owner-leading measurement indexes cover all three legacy history tables, all eight generic owned tables, and user-actor audits; existing primary keys cover profile/settings. They allow the aggregate predicates to avoid unrelated tenants' rows, without indexing note payloads or dropping soft-deleted/history rows. Full payload rows never leave PostgreSQL during measurement. Individual SQL statements use at most 2.5 seconds, lock waits at most 1 second, and the transaction resource scope has a 15-second monotonic deadline; existing transport guards remain in force. PostgreSQL JSON aggregation/materialization work itself is bounded by execution time, not by a fixed memory proof.

## Failure response

WriteResourceLimitError extends BoundaryError with status 429 and code WRITE_RATE_LIMIT_EXCEEDED or OWNER_CAPACITY_EXCEEDED. retryAfterSeconds is a positive integer for rate refusal, null for capacity refusal. Integrations must preserve the typed status/code, add Retry-After only when present, and show the explicit message. Existing 467 read-size/time errors remain 503. Missing counter DDL still fails closed with 503 before the first business DML. When trusted capacity enforcement is explicitly active, a failed required measurement also fails that mutation closed; never treat unavailable measurement as zero. Monitor-only mutations do not perform optional measurements, so measurement availability cannot fail or roll back their business save.

## Explicit DDL and verification

script/sql/write-resource-budgets.sql is an additive, transaction-wrapped reviewed script. It deliberately does not alter the migration journal or run at application startup. Before Development adoption, verify target identity and a fresh recoverable backup, verify the table is absent, apply this exact script explicitly, then verify its columns, primary key, owner FK, constraints and twelve owner/actor measurement indexes. Reapplying to an existing table fails safely; do not drop/recreate it or reset durable counters. The source/test fixture applies this exact script only to its newly created disposable PostgreSQL databases.

Native tests cover no-op/replay, nested/sequential reuse, independent-connection races, daily/minute limits/reset, owner separation, counter/business rollback, caught and wholly swallowed failures, logical UTF-8 measurement, monitor-only behavior, optional growth refusal, above-cap preservation/reduction, and an actual SQL timeout. Source preparation alone does not establish execution, Preview adoption or Production acceptance.


## SOMR-477: separate optional measurement from ordinary saves

Ordinary application callers retain the default `enforceCapacity: false`. Admission still validates and locks the authenticated owner, checks durable minute/day counters, and commits or rolls back admission, business records and audits together. It never runs the lifetime footprint query or updates `observed_bytes/observed_at` in monitor-only mode. Old/default values in those counter columns are not newly measured storage; do not display them as current. The optional trusted `enforceCapacity: true` seam retains exact before/after measurements and growth-only rejection; no application caller or runtime flag is activated by this correction.

The existing `readOwnerWriteBudgetStatus` export is the explicit operator measurement seam. It returns one consistent PostgreSQL statement snapshot with a dated `asOf`, scalar logical bytes and rate information; it does not transfer practice payloads, create a counter or consume a write allowance. The existing 2.5-second statement/1-second lock/15-second monotonic budgets apply, and errors normalize to a safe 503. A failed standalone attempt leaves prior successful receipts valid but stale.

Run this seam only through trusted operator code in its OWN finite transaction, never as part of an ordinary save, request-finalization hook, login, or background polling loop. The caller must supply the trusted owner identity and an approved database unit; this export grants no client route or authorization. Example operation boundary:

```ts
// Explicit operator action only, separate from every business-save transaction.
const snapshot = await operatorDatabase.transaction(tx =>
  readOwnerWriteBudgetStatus(tx, trustedOwnerId));
```

For an actual operator check, retain the returned result in a restricted private cloud receipt with its source commit and receipt time. Keep the preceding successful receipt as well; compare `storage.usedBytes` and `asOf` across both to report byte growth and elapsed time. Failure receipts should record only a safe status/stage and attempt time, never credentials or raw records; do not overwrite the last successful result. This records observations, not automatic anomaly detection, a running total or an exact provider bill. No database-history table, new DDL, scheduler, automatic cadence, notification service, quota activation or deletion is introduced.

The proposed seven-day active-account eligibility remains DEFERRED in [SOMR-478](https://pmhlawson.atlassian.net/browse/SOMR-478), not an adopted schedule. Any future automation must be separately scoped with freshness/failure handling, explicit resource budgets, no idle-database wakeups and a stated response requirement. The same decision record preserves transaction-safe running totals plus reconciliation and the review triggers for imports, retained-data changes, future allowances and security/release planning. [SOMR-477](https://pmhlawson.atlassian.net/browse/SOMR-477) records this bounded save-path correction.

Native synthetic checks verify identical monitor-only helper query sequences with zero versus 2,048 retained practice rows (including recoverable deletions), no footprint/observation query on those saves, preserved rows and durable charges, and that an explicit measurement timeout in its own transaction cannot prevent a later valid save. Existing native cases continue to cover explicit growth enforcement, rate races, rollback, exact replay and owner separation. Native execution and Development/Preview adoption are separate gates; authoring this source does not claim those gates passed.
