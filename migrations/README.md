# Additive policy storage: review candidate, not application authorization

This chain acknowledges an **existing installation**. `0000_legacy_baseline.sql`
is intentionally comment-only; its untouched Kit snapshot describes users,
http_sessions, sessions, session_edits, deviations and user_settings.
Raw legacy CREATE SQL is private review evidence, not executable provisioning.
**Do not use this chain to bootstrap an empty database.**

Generated with installed drizzle-kit 0.31.8 / drizzle-orm 0.45.2, no installs.
The only executable migration creates eleven new tables and their constraints.
No legacy table definitions, accepted462 contracts or runtime consumers change.
The journal uses `public.__drizzle_migrations`; older Replit-managed migration
metadata may differ and must be accounted for, never erased or guessed.

## Source → storage mapping

All new declarations live additively in shared/schema.ts.

| Table | Purpose and structural boundary |
|---|---|
| organizations | Tenant root; rollout defaults to legacy, checked legacy/shadow/v2 |
| organization_members | Organization/user composite membership; references existing users |
| domains | Global permanent domain UID, scoped membership, org-unique slug; mutable nonunique name |
| policy_versions | Entire typed DomainConfiguration JSONB, scoped domain/predecessor; revision and null-safe identity mirrors |
| dimension_definitions | Typed MeasurementDefinition JSONB per policy/measurement, scoped policy FK |
| observations | Entire typed Observation JSONB; variable units and absent/0/false retained; scoped policy, global idempotency, paired legacy provenance |
| evaluation_results | Reserved window/result/explanation/components and policy-gated budget storage, not an evaluator |
| deviations_v2 | Exact interval instants and scoped owner membership; all/selected and stitch/substitute_target checks |
| deviation_domains | Same-owner/org links to deviation and domain |
| audit_events | Generic entities and user/system actors; nullable actor with membership FK, no destructive entity FK |
| source_bindings | Same-owner/org domain source identity, org/source/external uniqueness |

All tenant-bearing tables have NOT NULL org_id with direct organization FK.
All foreign keys use no-action deletion/update, never cascading history deletion.
All record/domain IDs are text. All new instant columns are timestamptz.
eligible_days is unconstrained PostgreSQL numeric, without a rounding scale,
to retain fractional logical-block eligibility. A CHECK rejects negatives and
NaN/Infinity/-Infinity. This stores eligibility; it does not compute it.
Scalar CHECK constraints reject missing/wrongly typed mirrored JSON identities
using `IS TRUE`; policy revision is JSON-number matched. First revision omits
previousVersionId, subsequent revisions mirror the non-null predecessor.
These checks are partial structural validation, **not full accepted462 Zod
validation or demonstrated authenticated tenant isolation**.

## Explicitly unimplemented persistence responsibilities

- Validate full accepted462 payloads and trusted caller authorization.
- Enforce immutable global domain IDs and immutable historical versions/records:
  a primary key alone does not forbid all identity updates or later reuse.
- Keep configuration.effectiveFrom/effective_from and observation.observedAt/
  observed_at aligned; validate effective-version intervals, predecessor
  chronology and cross-row continuity.
- Materialize dimension definitions in the same transaction with EXACT agreement
  to configuration.measurements; never replace the full configuration payload.
- Validate evaluation bands as ordered, nonoverlapping and covering, and actual
  policy-gated budgets. JSONB fields reserve shapes, not fabricated scoring.
- Enforce selected/all deviation-domain consistency and remaining interval rules.
- Reject credentials/tokens in source metadata. No secrets are seeded here.
- Implement approved ownership mapping/backfill in future SOMR-431; no inferred
  owner IDs, seed rows, live audit writes or migration of user data is included.

## Offline review commands and limits

`db:generate` and `db:check` are offline but write local migration metadata.
Only a deliberately dummy child-process URL is used to load the config.
Never copy a real database secret into review logs.
`script/verify-policy-migration.ts --mode static` reads local artifacts,
compares snapshots to actual schema declarations, checks scoped identities and
allowlisted SQL, independently regenerates expected SQL, and verifies zero
next schema delta. It opens no DB connection.
`--mode queries` only prints read-only catalog/reconciliation templates.
Unknown CLI modes fail. The SQL lexer is intentionally narrow, not a general
PostgreSQL parser; actual PostgreSQL enforcement is not tested in this packet.

## Application gate (SOMR-429, not authorized here)

Before any application: verify backups; compare the actual development catalog
(types, nullability, defaults, constraints and indexes) to the complete captured
legacy snapshot; reconcile ALL existing migration ledgers including
Replit-managed metadata. Stop on mismatch. Review the comment-only baseline
against the selected actual driver. Do not simply mark an unverified baseline
applied. Production remains untouched.

`db:migrate` is provided only for later authorization; `db:push` is retained
for compatibility. Neither is permitted in this generation/review packet.
Changing migration SQL after application is prohibited.

Rollback for this unapplied candidate: discard the isolated candidate files/
branch only, preserving private evidence and prior work. There is no database
rollback here because nothing was applied. Never discard the old462 dirty files.