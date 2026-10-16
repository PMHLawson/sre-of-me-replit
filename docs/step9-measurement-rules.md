# Step 9: measurement rules and synthetic acceptance contract

**Correction candidate: awaiting independent review; not accepted.**

## Explicit participation and raw evidence corrections

An available seed result requires an explicit approved
`duration-plus-distinct-qualifying-days-v1` participation declaration. It binds
organization, owner, domain, policy version, personal target, and two distinct
measurement IDs. Quantity and frequency must each be mandatory and weighted
exactly 0.5. Duration/frequency-shaped records do not constitute approval.
This is a separate future-only contract, not a stored configuration migration,
authorization mechanism, or a change to any saved owner choice. The approval
helper is used only to explicitly construct synthetic test inputs.

Only declared practice-role duration and distinct-day frequency can participate.
Context/outcome components are explicitly unavailable even when their types and
values otherwise look compatible. Additional normal-target conditions, stretch
targets and upper-recovery targets are unavailable until an approved interpretation
exists; the oracle never silently drops these requirements. Adaptation remains
separately unavailable under the previously declared rule.

`creditedEligibleQuantity` and `creditedQualifyingDays` describe credit, **not
all recorded activity**. `rawCompletedPractices` contains detached typed copies
of in-scope practices in the completed window, independently of exemption credit.
The 28- and 42-day fully exempt fixtures contain respectively 28 and 42 actual
synthetic ten-minute records (280/420 raw minutes), for both 50- and 70-minute
weekly profiles. Credited quantity and days are zero, health is unavailable,
continuity is preserved, and every input record is unchanged. Zero credit must
never be described as “nothing practiced.” This evidence is not a live storage
or UI implementation.

This is a **preparation and verification contract**, not the new scoring engine.
No runtime route, storage hook, domain editor, dashboard or current score path
imports these files. Sustained state, trends, streak behavior and presentation
remain later steps. No database contents are needed to run the focused tests.

## Scope and authority

The approved arithmetic below applies to the declared **duration + distinct
qualifying days** pair, with equal weights and both components mandatory. It is
not a default recipe for every measurement type. Arbitrary domain names and
opaque domain/measurement identifiers work; names such as “Meditation” are not
identities or authorization.

Use the existing strict `DomainConfigurationSchema`, `ObservationSchema` and
`ConfigurationBundleSchema` for typed records and complete version chains. An
observation belongs to its exact organization, owner, domain and policy version.
Values retain measurement ID, value type, exact unit and task variant. Do not
reinterpret another owner's records, silently convert units, reuse measurement
IDs for changed meaning, or apply a later policy retroactively.

The mathematical result schema is **not an authentication capability** or a
persisted result envelope. The later engine must use accepted authenticated
ownership boundaries and retain scoped input/policy provenance in its result.
The test-only oracle filters synthetic inputs by the explicit scope, then
validates version and measurement meaning with the accepted bundle.

## Completed logical days

1. A logical day uses the person's timezone and configured **civil hour** of day
   start, not the server timezone or a fixed UTC offset.
2. Select the preceding **7, 14, 28 or 42 completed logical dates**. The current
   logical day is separate until its boundary closes. A future-dated observation
   does not count merely because it falls on today's civil date.
3. Count civil dates across DST, rather than assuming every day is 24 hours.
   Boundary fixtures cover New York spring/fall changes, a non-midnight start
   and Kolkata's half-hour offset.
4. Coverage must be explicit. The synthetic oracle requires a coverage fraction
   for every selected day; it never invents full coverage for an unknown history.
   Partial onboarding coverage does not extend the selected window backwards.
5. Subtract approved exemption fractions from covered day-equivalents, without
   double counting overlaps. Each day's eligible fraction lies between 0 and 1.
   Unknown or invalid coverage is unavailable, not zero health.

For target amount `T` over `P` days and total eligible day-equivalents `E`:

```
expected amount = T × E / P
```

Approved breaks reduce expectations and preserve continuity. This contract does
not create a streak engine. A fully exempt window returns
`unavailable: no_eligible_coverage`, with no numeric score or Healthy condition.
Crediting practices performed on partially/fully exempt days has not been
approved here; those synthetic inputs explicitly return
`break_activity_credit_unsettled`. Resolving overlapping break intervals into
the supplied fractions is a later engine responsibility, not guessed here.

## Qualification and measurement

- Qualification evaluates the entire declared predicate against **one
  individual practice**. Never add two short practices together to make a
  qualifying session, or satisfy different parts of a conjunction on different
  records.
- Frequency is the number of **distinct qualifying logical days**. Ten
  qualifying practices on five days yield five days, not ten.
- Quantity includes all eligible in-scope recorded amounts, including
  below-floor practice. Qualification is not a deletion/filter rule for raw
  quantity evidence.
- A missing value, numeric zero and recorded boolean `false` are distinct.
  `false` remains a typed observation. It fails a `true` completion predicate,
  but can satisfy an explicitly declared `false` predicate.
- Duration, repetitions, counts, quantities, completion and frequency retain
  their declared types. Count-only practice has no invented minutes.
- `frequency.countBy = events` and `distinct_days` remain different definitions;
  the approved seed recipe requires distinct days and derives them later.

## Personal, adapted and reference targets

Qualification, the chosen personal target, temporary adapted targets and
reference baselines are separate objects. An adapted target never lowers
qualification silently or edits historical observations.

A reference baseline is neither the personal scoring denominator nor an
automatic qualification floor. A review date on an adaptation is not assumed to
be an expiry date. Selection, expiry and mixed-window weighting of adaptations
remain `adaptation_selection_unsettled` in the synthetic score oracle.
Mixed policy-version aggregate scores similarly remain
`policy_boundary_unsettled`, while individual observations still obey their
half-open effective intervals. Future versions are validated but do not
retroactively change earlier observations.

## Approved health and overachievement arithmetic

For quantity and frequency:

```
uncapped component % = 100 × actual / expected
health component %   = min(100, uncapped component %)
numeric health       = (quantity health % + frequency health %) / 2
overachievement %    = min(quantity uncapped %, frequency uncapped %)
```

Cap **each component before averaging**. Keep full precision until display.
The unrounded score determines the condition:

| Unrounded numeric score | Base condition |
|---|---|
| >= 90 | Healthy |
| >= 70 and < 90 | Needs Attention |
| >= 50 and < 70 | Warning |
| < 50 | Critical |

Then apply mandatory-component guardrails:

- Any mandatory component **below** 50% limits the condition to Warning or worse.
- Exactly 50% does not activate that cap.
- Any zero mandatory component forces Critical, even if quantity alone produces
  a numeric score of 50.
- Guardrails change the condition, not the independently reported numeric score.
- An 89.9999 score may display as 90 after rounding, but its condition remains
  Needs Attention. The rounding precision/display treatment is a later UI choice.

Overachievement uses the least attained **uncapped** component; extra quantity
cannot hide missed days. Quantity 200% and frequency 50% produce health 75,
Needs Attention, and overachievement evidence 50%, not 125% or 200%.

Budget is **absent**, not zero or an implicitly enabled budget object. The
strict future seed-result schema rejects an invented budget field.

## Independently checkable Meditation examples

These are invented fixtures, not an inspection or edit of anyone's saved data.
Qualification: **10 minutes per individual practice**. Frequency target:
**5 distinct qualifying days per 7 days**. Fourteen completed eligible days
therefore require **10 qualifying days**.

The saved-profile example is **70 minutes/week**. **50 minutes/week is only a
synthetic alternative pending Philip's choice.** No saved target changes here.

| Synthetic activity over 14 eligible days | Minutes | Qualifying days | 50/week: quantity %, frequency % | 50/week: score / condition | 70/week: score / condition |
|---|---:|---:|---|---|---|
| Five days × 10 minutes | 50 | 5 | 50, 50 | 50 / Warning | 300/7 ≈ 42.857 / Critical |
| Six days × 10 minutes | 60 | 6 | 60, 60 | 60 / Warning | 360/7 ≈ 51.429 / Warning |
| Ten days × 10 minutes | 100 | 10 | 100, 100 | 100 / Healthy | 600/7 ≈ 85.714 / Needs Attention |
| Four days × 25 minutes | 100 | 4 | 100, 40 | 70 / Warning (guardrail) | 390/7 ≈ 55.714 / Warning |
| Two × 10 minutes on each of five days | 100 | 5 | 100, 50 | 75 / Needs Attention | 425/7 ≈ 60.714 / Warning |
| Two × 5 minutes on each of ten days | 100 | 0 | 100, 0 | 50 / Critical (zero guardrail) | 250/7 ≈ 35.714 / Critical |

The quantity expectation is **100 minutes** for 50/week and **140 minutes** for
70/week. Fractions in the table are exact acceptance values; decimals are only
explanations. For example, the saved profile's ten-day case is
`(100 × 100/140 + 100 × 10/10) / 2 = 600/7`.

With half of an otherwise covered, inactive day exempt, `E = 13.5`:
the 50/week quantity expectation becomes `675/7` minutes and frequency
expectation `67.5/7` days. Five 10-minute qualifying days give
`1400/27 ≈ 51.852`, Warning. Neither expected frequency nor health is rounded
before comparison.

All four seed profiles are covered with their own literal expectations:

| Profile | Weekly quantity | Individual qualification | Qualifying days/week | 14-day expectations |
|---|---:|---:|---:|---|
| Martial arts | 105 minutes | 15 minutes | 5 | 210 minutes, 10 days |
| Meditation (saved-profile example) | 70 minutes | 10 minutes | 5 | 140 minutes, 10 days |
| Fitness | 90 minutes | 15 minutes | 5 | 180 minutes, 10 days |
| Music | 45 minutes | 15 minutes | 3 | 90 minutes, 6 days |

## Explicitly unavailable, not silently Healthy

The contract represents these unresolved inputs with an unavailable reason and
**no numeric score or condition**:

- No eligible coverage, unknown coverage or invalid scope/typed version bundle.
- Missing qualification, missing target or a zero denominator.
- Lower-is-better, equal and range-direction percentages without an approved
  recipe; unsupported aggregations or non-seed percentage recipes.
- Count/quantity/completion-only percentage recipes: typed evidence and
  qualification are supported, but duration arithmetic is not borrowed.
- Adaptation selection and mixed-policy aggregate weighting.
- Credit for practice on approved exemption fractions.

The unavailable condition's wording, color and placement; display rounding
precision; sustained state/trends; multi-domain weighting; and overachievement
tiers/persistence remain later decisions. An unavailable result must not be
presented as Healthy. Tests here do not pretend these later behaviors exist.

## Review and verification

Files added for this bounded slice:

- `shared/step9-contract.ts`: declarations and validation of supplied arithmetic.
- `shared/fixtures/step9-examples.ts`: synthetic profiles and literal expectations.
- `shared/fixtures/step9-reference-oracle.ts`: **test-only** reference calculation.
- `shared/step9-contract.test.ts`: acceptance and rejection checks.
- This document.

Focused command: `npm test -- shared/step9-contract.test.ts`.
Existing suite under bounded resource use: `npm test -- --maxWorkers=2`.
Type check: `npm run check`. Build: `npm run build`.

The independent reviewer can inspect the literal tables, verify the equations
without running code, and compare them with the test-only oracle and invariant
schema. A static test confirms no runtime source imports the new contract or
oracle. Passing these tests is **not** proof of a live future scoring engine,
authenticated runtime isolation, dashboard correctness or preserved production
data via database comparison.

Execution receipts, retained failed attempts, initial file hashes, preservation
comparison and an exact added-files patch are kept in the Step 9 review packet.
Protection is by non-access to both app databases, explicit synthetic fixture
connections with owner environment bindings excluded, no runtime source edits,
and byte comparison of pre-existing files including uncommitted work. No
database backup, copy, migration or owner-data read is claimed.
