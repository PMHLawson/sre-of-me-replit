# SOMR-459: deliberate preservation defaults

Philip's recovery instruction is: **"Do what you can to avoid losing the data."**
His existing Preview history must remain intact and available after production
deployment. These defaults deliberately replace automatic destructive startup
and merge behavior; they are not a claim that a backup or recovery is complete.

## Application startup

Startup does not expire activity records by default. Only the exact environment
setting `SESSION_RETENTION_PURGE_ENABLED=true` permits the existing startup purge.
Absent, empty, `false`, capitalized, whitespace-padded, numeric and other malformed
values all keep deletion disabled. Do not enable it during production recovery.
This change does not set or change any environment variable or secret.

With that deliberate opt-in, the previous behavior remains: once after the server
starts listening, fire-and-forget deletion of already soft-deleted cultivation
sessions older than exactly 42 days, using the existing storage predicate.
Active sessions and the exact cutoff boundary are not expiry targets. The existing
success log and asynchronous error log/handling remain. Manual activity editing,
soft deletion and restoration are unchanged.

## Ordinary code merge

The post-merge hook still runs `npm install --no-audit --no-fund` with `set -e`.
It no longer invokes `npm run db:push -- --force` or any database command.
The separate `db:push` package script remains `drizzle-kit push`; this change
does not run it or alter managed production publishing/schema behavior.

## Narrow verification

- `server/startup-retention.test.ts` uses invented records and fake storage only:
  disabled spellings preserve every row; explicit `true` uses an independently
  fixed calendar cutoff, with success, boundary and error checks.
- The actual `server/index.ts` listen-callback wiring is inspected without
  importing, starting or executing the application.
- `server/post-merge.test.ts` executes only the isolated hook with an invented
  `npm` first and alone on PATH. It asserts the unchanged install arguments and
  failure exit; no real package installation or database command occurs.

This prerequisite does not migrate data, assign legacy NULL owners, change
authentication or schema, establish a backup, or publish any app. Accepted-source
selection, private backup verification and production transfer still require
separate review and authorization. The original running Preview is untouched.