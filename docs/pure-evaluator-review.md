# Pure generalized evaluator — bounded review candidate

This is source-only SOMR-426 work. It does not adopt scoring in the application.
The five sealed Step 9 files remain unchanged. SOMR-427, runtime integration,
database changes and whole-objective completion are not part of this delivery.

## Surface and trust

`createEvaluator(reviewedRecipes)(input)` deterministically evaluates supplied
policy, observations, clock, positive integer internal window length, coverage,
exception intervals and an exact versioned recipe. There is no ambient clock,
database, service, route, UI, environment, network or authentication dependency.
The registry is snapshotted; inputs are cloned and outputs are detached.

The embedding caller must supply a trusted registry. Registry membership is
mathematical recipe approval, **not** owner authorization. Passing invented
fixtures to that registry cannot authorize access to any owner's records.
An `approved: true` field is rejected. The pure function itself is not an
authenticated tenant boundary. Mismatched observation owners, organizations,
domains, policies, measurement units, value types and task variants fail closed.
It does not filter foreign rows then silently score a different dataset.

Each recipe binds exact measurement definitions (including units, task variants,
role, direction and aggregation), target ID, selection, target conditions and
whole qualification predicate, plus positive finite weights and mandatory flags.
All conditions of the selected target must participate. Extra stretch/recovery
conditions currently make evaluation unavailable rather than being ignored.
Weights are normalized by their sum; they need not sum to one.

## Supported arithmetic

Only explicitly registered `positive-linear-ratio-v1`, higher-is-better numeric
`gte` period targets are supported. Actuals are either:

* sums of typed numeric per-event values, with explicit period sum aggregation;
* counts of distinct logical days containing an individually qualifying practice.

There is no implicit unit conversion, duration synthesis, target conversion or
measurement-shape-based participation. Twenty cupcakes **per event** cannot be
treated as twenty cupcakes per week. Completion values, including false, remain
raw typed evidence and can participate in qualification; completion percentage
scoring is unavailable. Optional omitted numeric values add nothing to a sum
and are explicitly listed in `missingObservationIds`, not rewritten as records.

For each component:

    expected = target × eligible day equivalents / declared basis days
    attainment = 100 × actual / expected
    health = sum(weight × min(100, attainment)) / sum(weight)
    overachievement = minimum uncapped attainment of every participating component

Returned numeric presentation evidence uses JavaScript Number arithmetic, with
no display rounding. Policy decisions use exact decimal-rational intermediates
from original observations and per-day coverage, not approximate returned numbers.
Exported health is bounded to 0..100 after finite-arithmetic validation; this
range enforcement leaves interior values unrounded.
Nonfinite/zero-denominator arithmetic is unavailable.
Health conditions start at 90 / 70 / 50; below 50 is Critical. Mandatory
attainment below 50 limits condition to Warning or worse. Mandatory zero forces
Critical with driver reasons but does not change the numeric score or promote
a sustained state. Fractional uncapped overachievement is retained; badges and
sustained state are explicitly unavailable. Budget is absent.

Independent examples include saved-profile Meditation 70/week and proposed-only
50/week. In fourteen eligible days the expectations are respectively 140/100
minutes and ten qualifying days. For the 50 profile:

| Practices | Quantity % | Frequency % | Health | Condition |
|---|---:|---:|---:|---|
| 5 days × 10 | 50 | 50 | 50 | Warning |
| 6 days × 10 | 60 | 60 | 60 | Warning |
| 10 days × 10 | 100 | 100 | 100 | Healthy |
| 4 days × 25 | 100 | 40 | 70 | Warning |
| 10 practices on 5 days | 100 | 50 | 75 | Needs Attention |

One cupcake component with forty actual and twenty/week over fourteen days is
100%. Three components with actuals 80, 20, 40, each expectation 40 and weights
1, 2, 1, yield uncapped 200%, 50%, 100%, health 75 and overachievement 50%.
Tests use these handwritten expectations, not the sealed reference calculator.

## Civil windows, coverage and breaks

Completed windows use supplied IANA timezone and civil day-start 0–23. Start is
inclusive, end exclusive. Today and future observations are separate. Arbitrary
positive integer internal lengths include 10 and 30 without UI-setting changes.

Civil boundaries resolve repeated hours to their earliest occurrence and skipped
hours to the first valid wall time afterward. Entire missing civil dates that
cannot be assembled are explicitly unavailable. Exact day endpoints are emitted.
Today selection and practice bucketing both use the containing half-open interval
between these resolved boundary instants, not a comparison of local hour numbers.
Thus the logical date cannot move backwards merely because an offset rolls back
across day start. In the bundled timezone data, Antarctica/Troll's 2026-10-25
day-start 02:00 is first reached at 00:00Z; both 00:30Z (local 02:30) and 01:30Z
(local 01:30 after rollback) belong to that same logical day. It ends at
2026-10-26T02:00Z, after 26 hours. Tests assert every minute of this interval,
the exact half-open boundaries, Today exclusion and distinct qualification-day
counting, alongside the existing New York fold/gap and partial-break cases.
The timezone rules come from the host's Intl/IANA database; repeatability across
different host timezone database versions requires the same timezone data.

Coverage is clipped to onboarding and supplied policy start/end. Exceptions are
half-open instants, clipped to each covered day and unioned before subtraction.
Eligible fraction is remaining covered milliseconds divided by **that civil
day's actual duration**, not a fixed 24 hours. The evidence includes each day's
duration, covered interval and merged exception intervals.

Example: a 23-hour spring day, onboarding one hour into the day, and overlapping
breaks covering hours −3..3 and 2..4 has 22 covered hours, 3 exempt covered hours,
and 19/23 eligible days. The equivalent fall day has 21/25 eligible days.

Breaks reduce expectations only. Whenever total E > 0, all valid completed-window
practices after onboarding receive full actual credit, including practices in
fully exempt days. A wholly exempt window returns no numeric health or condition,
retains raw work and completed practices, and preserves continuity. This
deliberately supersedes the sealed oracle's known break-credit limitation;
the oracle and its original tests are not changed.

## Policy coverage and intentionally unavailable cases

Coverage is an explicit caller attestation of policy validity; this function
does not discover policies. Start must match the supplied policy effective time.
Missing history before that start (after onboarding), insufficient end coverage,
or rows from another policy are unavailable. No mixed-policy assembly recipe is
implemented. Missing policies must not be disguised as onboarding.

Adapted target selection must be explicit and bound to the recipe. An adaptation
starting during the covered window is unavailable; no history is reweighted.
Its review date is not expiry: passing it does not restore, raise or rewrite
the saved target. Qualification and references remain untouched; reference
minimums are provenance, not personal denominators.

Other unavailable cases: missing/zero targets, omitted conditions, unsupported
directions or percentage operators, unapproved aggregation, context/outcome
participation, incompatible identities/units/versions, period qualification,
invalid windows/intervals, unregistered recipes, nonfinite arithmetic.

## Review evidence

New source inventory: `shared/evaluator-window.ts`, `shared/evaluator-recipe.ts`,
`shared/pure-evaluator.ts`, `shared/pure-evaluator.test.ts`, and this document.
No preexisting source/configuration is edited.

Execution receipts, preserved baseline, original failed targeted typing output,
subsequent checks, cleanup receipts, exact byte/hash/blob manifest and isolated
commit identity live in `.local/review/somr426/`. The review runner excludes owner
database bindings; existing database-backed tests may use only their disposable
Unix-socket synthetic fixtures. This record does not prove owner-database content
equality, because those databases are intentionally never read.

The rollback correction has separate evidence in `.local/review/somr426-fold/`.
The original candidate and every original receipt, including the interrupted
first full-suite attempt, remain unchanged. The correction records a red
regression run before the implementation change, followed by new verification
and a separate sealed five-file candidate. Only this document, the window module
and its evaluator test file change relative to the prior candidate.

Further component/arithmetic correction evidence is in
`.local/review/somr426-arithmetic/`; both earlier sealed candidates and receipts
remain unchanged. Each component binds its own target's measurement ID, unit,
value type and task variant, in addition to the complete target-set check.
Observation policy-end validation occurs before future/Today separation.
Aggregate weights and weighted numerators must remain finite.

Policy threshold decisions use exact rational arithmetic over the supplied
numbers' canonical decimal strings. Eligible coverage is assembled exactly from
each day's covered/exempt milliseconds and actual duration; quantity is summed
from individual decimal observations. Weighted capped health and mandatory
50-percent comparisons therefore do not drift across boundaries through binary
floating-point representation. This is not tolerance-based promotion: even
genuine shortfalls smaller than a display rounding increment stay below their
threshold. Returned numeric evidence and scores remain unrounded Number
arithmetic (and can differ by a representational ULP from the exact boundary),
with exported health bounded to 0..100;
only display consumers may round them. Nonfinite arithmetic remains unavailable.
The exact arithmetic is internal and introduces no BigInt output, dependency,
compiler setting, runtime integration or scoring-policy change.

Tests include the four seed profiles, arbitrary numeric components, exact
boundaries, internal windows, DST, fractional overlapping breaks, full credit,
E0 raw retention, mandatory guards, qualification, duplicates, adaptation,
reference independence, negative validation and immutable/detached results.
Targeted strict TypeScript checking includes the test source excluded by the
project's ordinary type check. Runtime-import assertions ensure no adoption.

## Exported health bound correction and later derivation contract

The fully attained three-component case with weights 0.3, 0.6 and 0.1 previously
exported 100.00000000000001. The retained pre-fix regression demonstrates that
failure. Clamping only the finite exported health to its promised 0..100 range
returns exactly 100 without rounding any interior score or adding a threshold
tolerance. Exact-rational condition and mandatory-component decisions are
unchanged, including genuine just-below-90/50 shortfalls and positive attainment
whose Number evidence underflows to zero. Uncapped overachievement is unchanged.

SOMR-427 must preserve the evaluator's validated condition and reasons rather
than reclassify approximate numeric outputs. Any exact trend boundary at +/-2
must use original provenance arithmetic, including exact decimal observations
and per-day rational coverage, not subtraction of approximate exported scores.
This requirement does not implement or approve a trend or sustained-state recipe.

New evidence lives in `.local/review/somr426-health-bound/`. Earlier candidates
and all success, failure and interruption receipts remain prior evidence; the
earlier interrupted fixture cleanup remains UNKNOWN, not retroactively passed.
Only evaluator, test and review-document source change in this correction.
The five-file candidate remains pending independent actual-source acceptance.
