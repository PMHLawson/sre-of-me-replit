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

The callback and admission must be awaited. Nested and sequential repository operations sharing the exact same Transaction handle and owner reuse one charge. The outermost scope checks final logical growth; nested admission-only helpers do not finalize early. Do not create a separate Pool transaction or adapter per nested call. A Drizzle adapter must safely bind positional parameters against the same transaction, with one stable adapter identity.

The first helper lock is users(id) FOR UPDATE before invoking the callback. Existing membership/context revalidation keeps its established users-first ordering. Business validation row locks precede counter admission; counter ownership never derives from request body, query, path, IP or unverified claims. Bootstrap needs the authenticated users row but no preexisting organization membership.

The counter row is inserted/locked lazily only when admitMutation is called. PostgreSQL serializes independent connections and server instances. Counter changes, business changes and audit appends commit or roll back together. Resource/operation failures poison the same SQL transaction with a static failed SELECT, then preserve the original typed error, so catching a JavaScript error cannot commit earlier writes. The existing transaction owner still performs rollback and expires its handles.

## Rate and capacity policy

- Default rate: 30 accepted external mutations per UTC fixed minute; 500 per UTC day. These are fixed calendar buckets, not a rolling 60-second limit. An operation with multiple audited row writes consumes one admission. Exact replay/no-op consumes none when the caller does not admit.
- One durable owner row stores minute/day windows and counts. Elapsed buckets reset at admission; a backward clock cannot reopen an earlier allowance.
- Proposed capacity: 100 MiB logical serialized owned JSON UTF-8 bytes, monitor-only by default. Runtime activation of enforceCapacity remains held for Philip's separate decision. Trusted server options may configure capacityBytes and enforceCapacity; request data must never supply these options.
- Optional growth enforcement rejects only when final bytes exceed the cap AND exceed the pre-mutation measurement. Existing above-cap records remain saved/readable. Net reductions are permitted; immutable audit snapshots count as growth too. No deletion or retention policy is implied.
- readOwnerWriteBudgetStatus is read-only and returns only the authenticated owner's asOf, minute/day used/limit/remaining/reset timestamps, and storage usedBytes/limitBytes/enforcement/overLimit. It does not return payload rows or full note text.

Capacity is logical JSON payload size, not physical heap, index, WAL or TOAST disk usage. SQL aggregates include all owner sessions, session_edits, deviations, settings and profile; all owned domains, policy_versions, dimension_definitions, observations, evaluation_results, deviations_v2, deviation_domains and source_bindings; and every user-actor audit event. Soft-deleted rows, old policy versions, canonical copies and before/after audit snapshots remain counted. Shared organization rows, operational HTTP sessions and resource-counter metadata are excluded.

Full payload rows never leave PostgreSQL during measurement. Individual SQL statements use at most 2.5 seconds, lock waits at most 1 second, and the transaction resource scope has a 15-second monotonic deadline; existing transport guards remain in force. PostgreSQL JSON aggregation/materialization work itself is bounded by execution time, not by a fixed memory proof.

## Failure response

WriteResourceLimitError extends BoundaryError with status 429 and code WRITE_RATE_LIMIT_EXCEEDED or OWNER_CAPACITY_EXCEEDED. retryAfterSeconds is a positive integer for rate refusal, null for capacity refusal. Integrations must preserve the typed status/code, add Retry-After only when present, and show the explicit message. Existing 467 read-size/time errors remain 503. Missing DDL or failed measurement fails closed with 503 before the first business DML; never treat unavailable measurement as zero.

## Explicit DDL and verification

script/sql/write-resource-budgets.sql is an additive, transaction-wrapped reviewed script. It deliberately does not alter the migration journal or run at application startup. Before Development adoption, verify target identity and a fresh recoverable backup, verify the table is absent, apply this exact script explicitly, then verify its columns, primary key, owner FK and constraints. Reapplying to an existing table fails safely; do not drop/recreate it or reset durable counters. The source/test fixture applies this exact script only to its newly created disposable PostgreSQL databases.

Native tests cover no-op/replay, nested/sequential reuse, independent-connection races, daily/minute limits/reset, owner separation, counter/business rollback, caught and wholly swallowed failures, logical UTF-8 measurement, monitor-only behavior, optional growth refusal, above-cap preservation/reduction, and an actual SQL timeout. Source preparation alone does not establish execution, Preview adoption or Production acceptance.
