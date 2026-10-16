# SOMR-459 / SOMR-469: historical-data preservation

Philip's current policy is: **all historical data remains available in the
application**. Paging and bounded loading may control each request; a reporting
or compliance window is not a storage-expiration rule. The earlier opt-in
42-day deletion design is superseded, not an authorized future default.

## Application startup

Startup never expires practice records. `SESSION_RETENTION_PURGE_ENABLED` is
retired: even the old exact value `true` only logs a notice that it is ignored.
The startup helper does not call storage or calculate an expiry cutoff. No
environment variable or secret is set or changed by this source change.

The old `DatabaseStorage.purgeExpiredDeletedSessions` signature remains only as
a refusing compatibility seam. It always rejects before any storage access;
neither an old cutoff nor a stale caller can authorize a hard delete.

Active and soft-deleted history, original notes, edit history, canonical
observations and audit provenance are retained. Authenticated soft deletion and
restoration remain unchanged, including restoration of old records. History
pages load manageable batches without imposing a lifetime access cutoff.

Explicit permanent deletion is a separate future owner-authorized feature
(Objective 19). This safeguard does not implement it, authorize a deletion,
invent a retention cap, cascade-delete audit content, or promise immediate
erasure from provider backups.

## Ordinary code merge

The post-merge hook still runs `npm install --no-audit --no-fund` with `set -e`.
It no longer invokes `npm run db:push -- --force` or any database command.
The separate `db:push` package script remains `drizzle-kit push`; this change
does not run it or alter managed production publishing/schema behavior.

## Narrow verification

- `server/startup-retention.test.ts` proves all flag spellings, including
  `true`, preserve invented active and soft-deleted history; no storage
  dependency or expiry clock is touched.
- The actual `server/index.ts` listen-callback wiring is inspected without
  importing, starting or executing the application.
- `server/session-retention.storage.test.ts` exercises the refusing old method
  against a disposable, owned Unix-socket PostgreSQL fixture. Full before/after
  snapshots include old practices, exact old notes/edit history, canonical
  observations, audit provenance and quota counters; they must remain identical.
- Existing authenticated route, owner-isolation, bounded history paging and
  soft-delete/restore tests remain applicable.
- `server/post-merge.test.ts` executes only the isolated hook with an invented
  `npm` first and alone on PATH. No real installation or database command occurs.

This source change does not migrate or delete data, assign legacy NULL owners,
change authentication or schema, establish a backup, or publish any app.
Development adoption, recovery verification and Production acceptance remain
separate evidence gates.
