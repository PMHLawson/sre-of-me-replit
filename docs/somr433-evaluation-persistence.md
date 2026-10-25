# SOMR-433 saved evaluation foundation

This isolated candidate adds a bounded saved-result read surface and a dormant,
trusted server calculation/write operation. It does not activate scoring in
application readers, calculate during a GET, or provide production recipe,
history, break, or persistence-profile adapters.

## Stored evidence

The existing `evaluation_results` table remains the storage boundary. Existing
summary-only rows are returned with `recordKind: "summary-only"`; new rows use
`kind: "trusted-evaluation-v1"` and retain the evaluator result, exact input,
effective policy, timezone/day-start, source snapshot, coverage receipt,
dispositions, calculation version, input fingerprint, component evidence,
condition, cadence, persistence, attention, trend, and explanation. Budget is
stored disabled with a null snapshot. The writer rejects PAGE and any incomplete
or unverified source assembly.

The idempotency key is the existing unique organization/domain/window/policy/
calculation-version tuple. An equal input fingerprint is a no-op; changed
evidence updates that tuple through the existing audited update path, preserving
the previous row in the audit event. The domain row is locked while the tuple is
checked and written. There is no accounting or audit write on an equal retry.

## Trust and unavailable behavior

The calculation operation accepts no request body or caller-provided score,
coverage, policy, owner, or approval. It requires a history loader branded to
the same database, authenticated ownership context, and domain; an exact
registered recipe; complete injected source and coverage receipts; resolved
exception evidence; and one assessed policy segment. Missing proof, an unknown
recipe, or mixed-policy assembly returns an explicit unavailable result without
writing a row. Adapted targets remain distinct from qualification and reference
minimums. No reference percentage is inferred by this writer.

The operation is intentionally not imported by any route or runtime reader.
The only new read endpoint is:

`GET /api/v2/domains/:domainId/evaluations?limit=1..20&cursor=...`

It reads already-saved owner/domain rows only. The cursor is versioned and bound
to the authenticated organization, owner, and domain. Unknown query parameters,
malformed or foreign cursors, and foreign domains are rejected. Each page is
limited to 20 records and 5 MiB; persisted result input is limited to 256 KiB.
An oversized page fails explicitly rather than silently truncating.

## Verification boundary

Synthetic tests cover open policy end semantics, same-day qualification,
idempotent and concurrent retries, audited evidence changes, private bounded
retrieval, summary-row labeling, and unavailable unapproved/mixed evidence.
Full-suite and build gates remain held for independent source review. This
candidate does not change saved owner data, schema, configuration, workflow,
dependencies, or the running Preview.
