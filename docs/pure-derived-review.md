# SOMR-427: isolated derived status, attention and trend

## Scope and review status

### Independent-review correction: immutable canonical policy exports

Review of sealed `7c9c5eb60b9036ef98d1b5d921b60828a8a3a5c1` found that
the exported condition and persistence rank maps were mutable. A caller could
legally assign Critical rank zero and change attention and profile/promotion
validation. The canonical condition/state arrays also required runtime
protection, not merely TypeScript readonly tuples.

Both arrays and both rank maps are now frozen with `Object.freeze`; rank map
types are explicitly `Readonly<Record<...>>`. Their members are primitives,
so freezing each container protects the complete canonical value. No rank,
condition, state, selector, promotion rule or policy meaning changed.

Synthetic regressions attempt assignment, deletion, extension and property
redefinition on all four exports. They also attempt Critical demotion before
checking actual attention, valid/invalid profile validation and four-block
fixture-only Critical promotion. Compile-only negative assignments verify
readonly typing of all exports, including array growth/shrink operations.
The pre-fix receipt retains five failed regressions and 85 existing passes.
Final focused, strict source/test typing, project check, complete one-worker
suite, build, cleanup and preservation receipts are appended separately under
`.local/review/somr427-immutable/`; earlier seals and receipts are not replaced.
Prior interrupted cleanup remains UNKNOWN regardless of this attempt's
individual positive cleanup receipts. Independent actual-source acceptance of
this corrected candidate is still required. The independent platform QA prompt
below remains applicable; this correction does not adopt either engine live.

Correction verification: the focused suite contains 91 tests (85 prior, five
runtime mutation regressions and one readonly compile-contract case). Strict
source/test typing and the unchanged project check passed. The first complete
suite attempt exceeded the shell's 300-second limit without a completion
receipt; `full-interrupted.json` records it as uncompleted, cleanup UNKNOWN,
not a pass. The unchanged one-worker retry is recorded separately as
`full-final.json`. The sealing script requires successful focused, typing,
project, full-final and build receipts and a preservation/cleanup receipt before
creating an isolated candidate. Exact byte replacements from the prior seal
are in `replacement-opcodes.json`, with offsets into old UTF-8 bytes.

### Combined independent-review corrections: history consistency and equality

The rank-only attempt completed 91 focused tests and 1,454 full-suite tests
across 53 files, strict typing, project check and build. Those receipts remain
unchanged. Additional review found that an older known practice could be
omitted from an earlier prepared block without preventing an adverse sustained
result, because only current-window overlap was checked. Snapshot collection
was also incremental, so evidence learned from later blocks was not applied
to earlier blocks.

The corrected derivation first replays all supplied results, checks exact scope
and policy intervals, and unions their raw observations with the current
result. Conflicting identities are rejected. Before deriving any state it
checks every known practice against every covering half-open window, including
exempt windows and the current window. This uses raw records, not scored
quantity, and preserves event units and complete observation equality.
Chronological prepared-block assembly remains mandatory; evidence discovery
does not depend on block iteration order.

Synthetic three-week cases put the missing first-week Healthy practice in
current or later snapshots; a reverse case places a second-week practice in
an earlier snapshot. Omission is unavailable in either direction. Exempt
omission is also rejected, while consistently supplied active and exempt
histories remain valid. Before correction all four omission regressions failed.

Whole-result equality now explicitly compares array lengths, including sparse
trailing holes, and rejects nonfinite numeric primitives before identity
comparison. Object identity no longer bypasses nested validation. The pre-fix
equality regression also failed; the combined pre-fix receipt records five
failures and 91 passes. Final combined checks use separate `combined-*`
receipts and `preservation-combined.json`, preserving all earlier evidence.
The final candidate's byte opcodes are against ORIGINAL `7c9c5eb`, not an
intermediate rank-only snapshot. No live adoption or acceptance is asserted.

This is a pure source/test delivery for independent actual-source inspection.
It does not wire either the accepted SOMR-426 evaluator or this module into
Preview, storage, services, APIs, UI or Production. Preview's legacy Budget/SLO
behavior remains unchanged. No owner database is accessed or compared. No
default production persistence profile, active-block assembler, authentication
mechanism or approval workflow is supplied.

The prerequisite is the accepted five-file SOMR-426 health-bound candidate,
locally sealed at `25a48e372117ed4743d5604fdc0e0e4ee6a205dd`, reported preserved
by the independent reviewer in draft PR28 at
`78b69f4c1f46ae8d8eb0ebb4b99678cf4e5d02cf`.
This work neither re-authenticates to GitHub nor alters that prerequisite.
The local seal has the local accepted candidate as parent; later native GitHub
handoff must add only the five new blobs to the independently verified PR28
head, preserving every application blob and mode. Local and remote histories
are not interchangeable.

New-file inventory:

1. `shared/derived-exact.ts`: decimal-rational provenance arithmetic.
2. `shared/derived-profile.ts`: explicit profile types, schema, registry scope
   and rule validation.
3. `shared/pure-derived.ts`: current condition, attention, exact trend,
   prepared-history validation and persistence derivation.
4. `shared/pure-derived.test.ts`: independent synthetic expectations.
5. `docs/pure-derived-review.md`: this review contract.

All existing evaluator, measurement-contract, application and configuration
files remain byte-identical to the original SOMR-427 baseline.

## Trust boundary and public API

`createDeriver({recipes, profiles, comparability})` snapshots the trusted
registries and exposes `current`, `trend`, `persistence` and `status`.
The embedding code must obtain these registries from reviewed authoritative
sources, not accept arbitrary registries from an end user. This pure capability
is not authentication or proof of owner consent.

Every supplied evaluator result is replayed using its complete original
provenance and the exact trusted recipe registry. The entire supplied result
must match the replay, including condition, guardrail reasons, component
evidence, observations, coverage and exclusions. Results are not validated
merely by a numeric range or an `approved` flag.

The evaluator's `Needs Attention` name is mapped to derived `NeedsAttention`;
the original condition string, reasons and original result are also retained.
No approximate exported score is used to reclassify a condition. An exact 90
may export 89.99999999999999, and a strictly positive attainment may export
zero through Number underflow. Neither can change the authoritative decision.
The distinct `attention` helper is a rank-combination primitive, not a result
validation API; `status` only calls it after validating both inputs.

All public methods return detached evidence. Callers retain responsibility for
the completeness and authenticity of source observations supplied to the pure
evaluator. Replay can prove deterministic consistency, not prove that an
external source omitted no records. No owner data is consulted to fill gaps.

## Attention, origins and labels

Condition ranks are Healthy 0, NeedsAttention 1, Warning 2, Critical 4.
Persistence ranks are Nominal 0, Advisory 1, Warning 2, Breach 3, Critical 4.
Attention is the maximum, and ties retain both origins, including a 0/0 tie.
All twenty pairings have independent rank/origin expectations.

Current labels identify current condition, guardrail reasons or health-band
basis, and recipe version. Persistence labels identify sustained trouble,
profile/version, triggering rule/selector, completed block count and whether
the profile is fixture-only. Combined attention labels retain both explanations.
Unavailable persistence does not silently produce a current-only definitive
attention result. `migrateLegacyPersistence("PAGE")` explicitly maps legacy
input to Critical; no fresh state/profile can emit PAGE.

## Exact trend and compatibility

Trend compares adjacent completed windows of equal logical-day count. It does
not require equal elapsed milliseconds or equal eligible coverage: valid DST,
clipped coverage and breaks can change those amounts.

The complete scope binds owner, organization, immutable domain, full policy,
recipe, target selection and identity, measurement types/units/task variants,
qualification, weights, mandatory flags, target bases, onboarding, boundary
version and calculation version. Same-scope results must also agree on their
declared policy coverage interval.

Different policies/recipe versions require an exact registered comparability
strategy. The only implemented strategy is a same-semantics version transition:
it can vary policy version/revision/effective/predecessor metadata and recipe
version, but not ownership, targets, measurement meaning, units, qualification,
boundary, onboarding or any other semantic policy field. Its approved effective
interval must cover both windows. Supplied strategies are validated even when
the two scopes are identical; conflicting registry entries for the same
strategy identity/version are rejected. General conversions, adaptation
comparisons and mixed-policy assembly remain unavailable, not guessed.
Both original results are retained in available and unavailable trend output.

Arithmetic is reconstructed from individual recorded decimal Number strings,
verified qualifying-day counts and each logical day's integer covered/exempt
milliseconds divided by that day's actual integer duration. It never uses a
rounded actual sum, exported health, rounded eligible aggregate or
re-rationalized Number delta as a policy input. Weights, targets and bases also
use their original decimal values. Components are capped individually before
the exact weighted health calculation.

Stable includes the exact interval [-2,+2]. Strictly larger changes are
Improving/Declining. Output supplies exact numerator/denominator plus approximate
Number evidence for aggregate and component changes. Each generic driver
retains measurement/unit/variant and target/basis, raw quantity, expected
quantity, capped and uncapped attainment, weight, mandatory flag and weighted
contribution. Opposing movements remain visible in an aggregate Stable result.
Approximate projections are presentation evidence only, never a new policy
decision. There is no display rounding or tolerance in exact decisions.

Independent goldens include:

- Equal weights 80/80 to 90/70: delta 0, Stable, drivers +10/-10 and weighted
  contributions +5/-5.
- 80/80 to 84/70: delta -3, Declining, drivers +4/-10.
- Synthetic decimal-duration Meditation70, two adjacent fourteen-day windows:
  prior eight days of fourteen minutes =112 minutes, quantity80/frequency80,
  health80. Current nine qualifying days, eight of11.2 and one of14 minutes
  =103.6 minutes, quantity74/frequency90, health82. Exact delta+2 is Stable;
  exchanging those patterns in chronological windows gives -2, Stable.
- Changing that final14 to14.00028 gives quantity74.0002, health82.0001,
  delta+2.0001 or -2.0001: Improving or Declining.

These are compatible synthetic decimal measurements, not changes to the saved
70-minute target or the legacy owner's integer duration storage column.
Generic one/three-component cupcake profiles and kilometre quantities are
tested without invented minutes or implicit `km` conversion.

## Explicit persistence profiles and prepared history

A profile must exactly match the trusted registry and pass structural and
semantic validation. It includes full scope; source/revision/review provenance;
effective interval; explicit fixture-only/reviewed-external designation;
versioned prepared-block verification method; all five states with exact ranks;
complete acceptable/sub-acceptable/severe selectors; unique rules/priorities;
positive safe integer promotion and recovery counts; explicit Critical rule;
trusted known-origin provenance; and retain-both attention tie policy.
Higher-severity satisfied promotions may not be overridden by lower-priority
severity rules. Conflicting same-identity/version profiles are unavailable.

No default sustained-Critical threshold is invented. The starting guidance is
represented only in explicitly registered synthetic profiles: 1/2/3 consecutive
sub-acceptable blocks promote Advisory/Warning/Breach; two severe blocks may
alternatively promote Breach; one completed acceptable block recovers Nominal.
Fixtures separately approve four-block and five-block Critical policies and
label both fixture-only. Instantaneous Critical is not sustained Critical.
Changing a count without a new exact registry entry is not implicit approval.

The module consumes prepared history; it does not construct it. A profile binds
the preparation algorithm identity/version and seven active-day requirement.
Every prepared entry contains its replay-validated result, source identifier,
exact start/end and declared kind/active coverage. Validation checks:

- Exact scope/policy interval and registry-origin agreement.
- Continuous ordered half-open intervals from the explicit known origin through
  the current completed-window boundary, without gaps, overlaps or future ends.
- Full known daily coverage; clipped onboarding is not called a complete block.
- Exactly seven rational eligible days for an active block; seven calendar days
  with a partial break do not satisfy this.
- Raw-observation consistency for reused IDs and intersecting current/block
  windows, plus exact overlapping daily-coverage consistency.

The verifier may accept an explicitly supplied longer calendar span whose
exact eligible coverage is seven days, but it does not decide how an upstream
assembler should create that span. No active-block assembly is supplied here.
Fractional-cut assembly and unknown prior history are not stitched together.

Fully exempt markers require the evaluator's E0 result and exactly zero
eligible coverage. They retain recorded practices and do not increment, reset,
recover or promote. Exempt gaps between bad blocks preserve streaks.
An optional explicitly prepared final pending tail can evidence positive
coverage below seven days. It does not count as a block, does not reset or
recover, and cannot appear in the middle of history. Its decimal coverage claim
must equal reconstructed coverage exactly; unsupported fractional claims remain
unavailable.

Empty, unknown, exempt-only or pending-only history cannot establish Nominal:
at least one validated completed active block is required. Zero adverse blocks
can yield Nominal when there is explicit completed acceptable history.
Current Healthy, a green pending tail or Today improvement cannot recover
sustained Breach; recovery requires the registered completed-green-block count.
For a current E0 window, condition/persistence/attention/trend are unavailable;
current output retains original raw evidence rather than inventing Healthy,
Nominal, zero health or an adverse reset. A subsequent available window can
validate the exempt marker without losing known continuity.

## Failure history, verification and preservation

Evidence is append-only under `.local/review/somr427/`. The original
`focused-first` run remains 4 failed /77 passed, and `typing-first` remains its
original passing receipt. Those four failures were investigated, not erased:

1. Weights .1/.2/.7 happened to export exactly90. The drift regression now uses
   .1/.2: exact27/.3 is90, while Number27/.30000000000000004 is below90.
2. Two driver assertions used `km`; the declared unit identity is `kilometre`.
   Only those expectations changed; no unit conversion was introduced.
3. Empty history expected Nominal incorrectly. It now remains unavailable;
   zero-adverse Nominal is demonstrated by a completed acceptable block.

The initial misnamed verification-runner invocation raised a KeyError before
launching any check; it is not a passing test. The credit stop interrupted the
work, not the two completed recorded checks. Later project/full/build checks
were still uncompleted then. Original UNKNOWN cleanup evidence from earlier
objectives remains UNKNOWN, never retroactively passed.

On resume the first project check found an ArrayIterator loop incompatible with
the existing default compiler target. It was changed to an indexed loop without
changing compiler options. Its failed `check.json` remains evidence. The first
resumed full-suite command hit the shell's 300-second timeout without producing
a completion receipt; `full-interrupted.json` retains its uncompleted/UNKNOWN
status. Final checks use distinct `focused-final`, `typing-final`, `check-final`
and `full-final` receipts. Positive individual cleanup receipts do not turn an
interrupted whole-suite attempt into a pass.

The original baseline inventories all preexisting source/configuration and
prior review artifacts. The authorized resume checkpoint has a different
workspace HEAD because the platform checkpointed the prior turn; source hashes,
not an assertion that those commit IDs are identical, establish preservation.
The resume receipt preserves the initial runner, baseline and check receipts.
No manual mutation of the workspace branch is used to seal this delivery.

Final receipt files record focused tests, strict targeted source-and-test typing,
project check, complete one-worker suite, and build. Full-suite children receive
an allowlisted environment with no owner database bindings. Existing disposable
synthetic fixtures supply positive Unix-only cleanup receipts. Any interrupted
attempt must retain a separate uncompleted receipt and unknown cleanup status.
Manifest/seal records include exact new-file byte lengths, SHA-256, Git blobs,
commit/parent/tree, preservation receipt, and optional raw-DEFLATE handoff
metadata. A passing test run alone is not independent source acceptance.

## Independent review prompt after the bounded objective-10 delivery

You are an independent reviewer. Inspect actual source, not only the author's
summary or green checks. First verify the immutable dependency and candidate
commit/parent/tree, each path/mode/blob, byte length and SHA-256 against the
sealed manifest. Compare the five-file addition against the accepted PR28
application base; identify any unrelated changes. Do not merge or publish.

Review the accepted measurement contract, evaluator and new derived module as
one calculation chain while keeping their public responsibilities separate.
Trace every claimed acceptance behavior to implementation and an independent
expected value. Challenge registry trust, incomplete result/provenance handling,
exact numeric decisions, mandatory guards, component binding, owner/domain
isolation, target/adaptation semantics, time boundaries, DST folds/gaps, break
coverage, E0 retention, prepared-history completeness, rule priority/recovery,
five persistence states, attention ties, legacy PAGE migration and trend
compatibility. Verify +/-2 boundaries using original individual decimals and
per-day rational coverage. Attempt contradictory raw IDs, omitted observations,
mutated outputs, changed registries, incompatible units and policy versions.

Independently assess the tests' strength: check hand calculations; identify
self-confirming expectations and untested error paths; distinguish pure input
consistency from authentication/source completeness; assess numerical and
resource limits. Review all failed, interrupted and final receipts, including
UNKNOWN cleanup. Reproduce checks only in an authorized disposable synthetic
environment with owner bindings excluded. Never access, compare, copy or
modify owner databases to prove preservation.

For the wider platform inspection, separately inventory existing user journeys,
features, correction history, custom domains, measurement storage, authentication
and authorization boundaries, privacy, accessibility, error/empty/loading states,
test coverage, maintainability, observability and operational risks. Trace
current runtime behavior from source; do not confuse legacy Preview behavior
with these unintegrated future modules. Report source-supported findings,
severity, reproducible synthetic examples, affected paths and suggested fixes.
Separate correctness defects from policy decisions and future integration work.
Do not assume that passing pure tests proves UI/runtime behavior or production
security. Do not run active security probes or call external services without
separate authorization.

Deliver a requirement-by-requirement acceptance matrix and a prioritized review
report. Explicitly state what you inspected, what you independently executed,
what remains unavailable/unsettled, and what cannot be verified without future
permission. No database changes, dependencies, workflows/restarts, credential
retries, publication, main/Production changes, purchases or task-queue actions.
Keep the default Critical threshold and production active-block assembly
unapproved unless separate authoritative evidence settles them.
