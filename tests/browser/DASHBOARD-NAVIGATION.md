# Reproduce the Dashboard navigation regression review

This runs the **actual detached frontend** with tracked invented fixtures. It
never runs the backend, startup purge, database, auth provider or an owner session.
No Settings save, logout, session/deviation write, installation or paid service is
performed. Both normal and ramp-up System Health and all four domain cards are
covered at 1280/360/320 in dark/light themes, plus ties and advisory colors.

## Prerequisites

- Linux, Git, Node 20.19+ (or a compatible newer Node for Vite 7).
- Dependencies already declared in package.json/package-lock.json. In an
  independent clean clone, install those with `npm ci`; this pass added none.
- Explicit absolute path to an existing headless Chromium supporting private
  inherited-pipe CDP. It is not installed, downloaded or attached by this runner.
- A non-existent absolute output directory outside the checkout, whose parent
  already exists. Evidence is never overwritten.
- A clean committed checkout. All fixtures, scripts and controllers are tracked.

```sh
node tests/browser/run-dashboard-navigation.mjs /tmp/navigation-review \
  --chromium /absolute/path/to/chromium
```

For an explicitly separate Git metadata directory, also pass
`--git-dir /absolute/path/to/metadata`. Without a checkout-local `.git`, the runner
refuses ancestor Git discovery. It does not fetch, publish or mutate refs.

For an already-built detached baseline whose frontend hashes are inventoried,
the exact same harness can be invoked without rebuilding:

```sh
node tests/browser/dashboard-navigation.cjs \
  /absolute/detached/public /absolute/new/browser-output \
  /absolute/path/to/chromium /absolute/detached/identity.json
```

The identity must include `commit`, `tree`, `sourceFiles` with blob/SHA256 and
`buildFiles` keyed `public/<relative-path>`. The harness verifies the build hashes.

## What is measured

- A predeclared unique assertion registry; missing/duplicate/unexpected IDs fail.
- Native Tab from the surrounding User menu through all five visible links to
  Declare; native Shift+Tab in reverse. No `.focus()` substitute.
- Actual accessibility-tree link roles/names/hrefs, no nested interactive controls.
- Focus-visible outline, geometry and sRGB contrast against background and card;
  real focus screenshots on colored cards in both themes.
  Links retain an 8-pixel scroll margin because native keyboard scrolling otherwise
  can align the border to the viewport edge and clip the outside focus outline.
  The focus measurement awaits the link's actual CSS transition completion because
  the preserved `transition-all` animates outline-offset; it never advances time.
- Native Enter and pointer activation, exactly one route push and trusted click,
  unchanged document/time origin, and native keyboard return controls.
- Actual Ctrl-click and middle-click new-tab behavior on all five normal links
  and ramp-up System Health: one owned intercepted child page, unchanged parent,
  unprevented native input and the correct child route.
- Counts/order/styles/content/thresholds/anchors, both Dashboard Log controls and
  History Quick Log; no new Decide FAB or altered timer/policy behavior.

The observer delegates native history calls. It records real clocks and trusted
input; it does not change timers, router state or application data. Themes are
seeded only in the owned private browser's local preference.

The accepted SHA-pinned controller's private-pipe/context/profile ownership,
fatal timeout/disconnect handling and guarded process/directory cleanup are
unchanged. A small tracked adapter exposes browser/session observation RPCs on
the **same verified owned pipe**. New owned targets are paused until their Fetch
interception is installed. No browser address/port discovery or attach fallback.
Interception is installed before enabling/resuming each new target. Before a child
is closed, its baseline UI must render (domain routes), interception must drain,
and its recorded API network activity must be quiet for one real second. Closing
on the header alone can release a still-paused baseline request during detachment.
Only a separately owned ephemeral loopback static listener is opened; any API
escaping interception is a fatal verification failure, not forwarded to a backend.

Output includes raw results, exact assertion IDs, trusted event/monotonic timing
traces, source/build/harness identities, response hashes with deduplicated exact
bodies, request/write/foreign-block audits, focus screenshots and cleanup records.
Nonzero assertion results remain failures, not blanket acceptance. Cleanup failure
means STOP; no retry or other work until independently resolved.

This does not prove real provider authentication, a database, installed-device
accessibility or production acceptance. Broader existing acceptance remains open.