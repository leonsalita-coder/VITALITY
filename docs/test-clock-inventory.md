# Test files that read the real clock

What each real-clock read in `tests/` is for, and which were pinned.
Counted on `iy/test-clock-inline` (on top of the `localToday` extraction):
**23 test files** read the clock directly — 21 through `Date.now()`, plus
2 more through `new Date()` with no argument (`migration-roundtrip`,
`progress-tab`). `performance.now()` appears nowhere. 22 files import
`tests/helpers/clock.ts`. Separately, **33 files boot the tile in JSDOM**,
and the tile reads the wall clock itself in 30+ places in
`public/tiles/train.html` (`daysAgo`, `getLocalDateKey`, every
`now: Date.now()` it hands the engine) — so those tests depend on the
clock even where the test file never mentions it.

## Why most were not pinned

A fixture like "three days ago" only means three days ago relative to the
clock the code under test reads. In a JSDOM test that is the tile's
window, which runs on the real clock. Pinning the fixture alone makes the
gap grow by a day every real day — "3 days ago" becomes "3 weeks ago" and
staleness, layoff and streak logic give different answers. So these are
fixtures, but a fixed clock is only equivalent if the **tile's** clock is
pinned too (e.g. an offset `Date` installed in `beforeParse`, with
`localToday(clock)` given the same clock). That is a design decision, not
a per-file fix: it also changes what the 22 `localToday()` files compute,
and a pinned hour removes the midnight/DST exposure that `mutate:fuzz`
exists to probe (it found 44 tests passing vacuously in Sydney). Not
decided here.

## Pinned (fixed clock proven equivalent by running, not by reading)

| file:line | what it was | evidence |
|---|---|---|
| `trim.test.ts:24` | `now: Date.now()` in the context builder | `trimSession` never reads `now`: the file passes with `now: NaN` |
| `other.test.ts:285` | `classifyPR([], entry, Date.now())` | returns before reading `now` for a non-working set: passes with `NaN` |
| `timing-wiring.test.ts:137` | base time of two `at` stamps on a `2026-09-01` row | `restTaken`/`hasObservedTiming` are clock-free (`lib/train/timing.ts` has no `Date`/`now`); passes with base 1970, 2026 and 2100. Now matches the row's own date |

## Fixture, but measured from the tile's live clock (left; needs the decision above)

- `amrap-wiring:143`, `asymmetry-wiring:180,201`, `fitting-wiring:60`,
  `lastsession-wiring:61,141,157`, `load-wiring:44`,
  `predictions-wiring:178`, `prefill:70,325`, `projection-wiring:56`,
  `simulate-wiring:55`, `staleness-wiring:52`, `superset-wiring:196`,
  `targets-wiring:73,155,189,237`, `weekly-change-wiring:54`,
  `other-wiring:50,114,145,201,225` — history rows N days/weeks back,
  evaluated inside the tile's window.
- `migration-roundtrip:33`, `progress-tab:14`, `publish-wiring:32`,
  `shadow-wiring:32` — the same, built Node-side (`new Date()` +
  `setDate`) and loaded into the tile.
- `load-wiring:109,112`, `targets-wiring:244`, `shadow-wiring:286,296,309`,
  `simulate-wiring:93,106,117` — `now: Date.now()` handed to engine calls
  inside the tile; must agree with the fixtures above, so it moves with them.
- `timing-wiring:157` — `at: Date.now()` on a set in today's live session,
  rolled up into today's entry. Only the `atEstimated` flag is asserted,
  but the row is "today" by the tile's clock.
- `predictions-wiring:119` — `madeAt` on a prediction for the tile's
  `sessionDate()`. Only the kept weight is asserted.

## Actually testing relative time (left on purpose)

- `timing-wiring:82,86` — records `Date.now()` before and after three
  real clicks and asserts each logged set's `at` falls between: it proves
  the tile stamps sets with the current time. Frozen, "stamped now" and
  "stamped with a constant" become indistinguishable.
- `publish-wiring:23`, `two-a-day:319` — `startedAt` an hour ago. The tile
  computes session length as `Date.now() - startedAt`, so the fixture
  means "a session that has been running for an hour".
- `kind-wiring:137`, `prefill:149` — `Date.now() + 86400000`: the
  suggestion for *tomorrow's* session, relative to history dated from now.
- `shadow-wiring:151` — asserts the tile stamped the verdict on this
  week's Monday, 0–6 days before today. The assertion is about "now".
