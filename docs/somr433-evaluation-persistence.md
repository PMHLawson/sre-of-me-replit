# SOMR-433 saved evaluation foundation

This isolated candidate adds a bounded saved-result read surface and a dormant,
trusted server calculation/write operation. It does not activate scoring in
application readers, calculate during a GET, or provide production recipe,
history-origin or exception-approval adapters.

## Stored evidence

The existing evaluation_results table remains the storage boundary. Existing
summary-only rows are returned with recordKind: "summary-only"; new rows use
kind: "trusted-evaluation-v1" and retain the evaluator result, exact input,
effective policy, timezone/day-start, source snapshot, full coverage receipt,
dispositions, calculation version, semantic input fingerprint, component
evidence, current condition, approved cadence, persistence, attention, trend
and explanation. Budget remains disabled with a null snapshot. The writer
rejects PAGE and incomplete or unverified source assemblies.

The idempotency key remains the existing unique organization/domain/window/
policy/calculation-version tuple. Equal semantic evidence is a no-op, preserving
the original full saved receipt and resultId. Volatile receipt issuance IDs and
snapshot capture metadata are retained as provenance but do not force a new
write. Meaningful input, authority, version, cadence and as-of changes remain
fingerprinted. Changed evidence updates that tuple through the audited update
path, preserving the previous row. The domain row remains locked while checking
and writing the tuple; equal and concurrent retries do not duplicate admission,
accounting or audit writes.

## Trust, history and unavailable behavior

The operation accepts no request body or caller-supplied score, owner or approval.
Its authenticated database context, domain, branded history dependency, clock and
calculation version are validated and captured at construction. Later mutation
of the options object cannot replace them. Recipes and comparison strategies
are cloned from injected reviewed registries.

Actual onboarding requires exactly one independently verified empty-domain
activation origin for the earliest history episode. Later policy or target
origins are reconciliation; they do not grant a fresh onboarding exemption.
The operation chooses the unique assessed episode covering the actual closed
assessment window after that domain activation. Unrelated retired and pending
future policies stay in the complete source evidence without blocking a valid
single-policy window. A genuinely mixed policy/target window, missing activation
proof, unknown recipe or ambiguous selection remains explicitly unavailable.

Persistence is the approved qualifying-day cadence result. The former
fixture-only seven-day prepared-profile path is not an option for this operation.
The standalone attention combiner supports the approved Nominal, Advisory,
Warning, Breach and Critical mappings. RhythmSlipping and Recovering retain their
actual cadence state with attention explicitly unavailable until a mapping is
approved. No replacement rank or status is invented. Adapted targets remain
distinct from qualification and reference minimums; no reference percentage is
inferred by this writer.

The operation has no non-test runtime importer. The read endpoint is:

GET /api/v2/domains/:domainId/evaluations?limit=1..20&cursor=...

It retrieves saved owner/domain rows only. The cursor is versioned and bound to
authenticated organization, owner and domain. Unknown parameters, malformed or
foreign cursors and foreign domains are rejected. Each page is limited to
20 records and 5 MiB; persisted result input is limited to 256 KiB. An oversized
page fails explicitly rather than silently truncating history.

## Verification boundary

The corrective source remains unaccepted until the native focused and typing
phase, independent exact-source review, full suite, build and owned-fixture
cleanup gates succeed. Tests must exercise real saved calculations, later and
future policies, original historical replay, receipt-refresh/concurrent retries,
dependency mutation, exact private paging and persisted target bindings.
Arithmetic on a future reference fixture is not integration evidence.

No owner data, schema, configuration, dependencies, runtime scoring, publishing
or Production change is authorized by this foundation.
