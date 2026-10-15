# SOMR-467 bounded history read contract

This source is a coordinated server/client change. Do not adopt its page responses
without the matching client, or treat a history page as complete calculation input.
No retention job, deletion or scoring-policy change is introduced.

The current-state bundle uses one read-only repeatable-read transaction, clock and
settings snapshot. It fails as a whole on resource limits. Completed scoring windows
are the union of the actual existing evaluator anchors. The planner preserves those
anchors; it does not correct their legacy timezone assumptions.

Raw pages preserve older and persisted future records, using an exact database
timestamp plus ID cursor. Complete context covers a conservative93 elapsed days and
all future records, with a finite complete-or-fail budget. The90-day heatmap and
7/14/30/90-day history ranges must never infer totals from one page. Weekly
subtotals on raw pages describe shown records only, not a complete calendar week.

Lists omit raw note/anomaly/reason text. Explicit detail and fixed2048 PostgreSQL
character chunks preserve Unicode and whitespace. A SHA256 full-record version
prevents mixing chunks across a change. Chunk bytes is the TOTAL field UTF8 length.

## Resource limits

Each complete legacy calculation/context input allows2000 rows; relevant deviations
allow1000. Each page allows100 rows. SQL statement and transport-query timeouts are
2500ms; lock timeout1000ms; the operation budget is15 seconds measured monotonically.
Pool acquisition uses the existing finite application-pool connection timeout.
Timeouts/overflow return503 with no partial score. These are availability safeguards,
not data truncation or deletion. Existing mutation responses remain compatible.

## Additive index adoption

`migrations/0002_bounded_history_read_indexes.sql` is intentionally a separately
reviewed additive index packet. It is NOT registered in Drizzle's journal and the
ordinary migration command must not be claimed to apply it. No live database has
been changed by saving this source.

After source acceptance, take/verify the prescribed recovery checkpoint, inspect
current index definitions, and apply this exact packet transactionally to the
verified Development target only. Native acceptance must inspect pg_index /
pg_get_indexdef, not merely a matching index NAME: correct schema/table, btree
columns and order, and active/deleted partial predicates are required. A preexisting
index with the same name but another definition is a stop condition; IF NOT EXISTS
alone is not evidence of adoption. Prove the relevant keyset/range query plans on
the synthetic fixture and retain the receipt. Production requires its separate
approved backup/adoption process. Never use db:push to adopt these indexes.

Before future generated schema migrations, reconcile these applied indexes into
the schema/snapshot metadata under review; do not generate a conflicting duplicate.
