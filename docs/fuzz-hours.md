# Why fuzz has no hours, and why its count is unpinned

**Deliberate. Do not "fix" either by re-adding the hours or by blessing a
number.**

## What was wrong

`mutate --mode=fuzz` looped over four zones × five hours
(`00:30, 01:30, 06:30, 12:30, 23:30`) and ran the date-touching tests once
per pair, passing `TZ` and `MUTATE_HOUR` to the child vitest. Its survivor
labels read `Sydney @ 00:30`, and the docs described it as running "every
date-touching test at 00:30, 01:30, 06:30, 12:30 and 23:30".

Nothing read `MUTATE_HOUR`. A grep of the whole repo — scripts, lib,
tests, the tiles, package.json; there is no CI config — found exactly one
occurrence, the line that set it. No test fakes the clock from it, and
there is no dynamic `process.env[...]` read that could pick it up. So:

- the five "hours" were five identical runs of the same zone, at whatever
  time the wall clock said;
- the `20/20` in the docs was 4 distinct results counted five times;
- the pinned `fuzz: 0` was measured by a mode whose labels described a
  variable that does not exist.

`TZ` was real and still is: Node honours it, so the zone half of the sweep
did what it said.

## What changed

- `scripts/mutate.mjs`: `HOURS` and `MUTATE_HOUR` removed. Fuzz runs once
  per zone (4 runs, not 20); survivors are labelled by zone alone.
- `.mutation-baseline.json`: `fuzz` set to `null` (unpinned), with the
  reason in its `_note`. It was **not** blessed to a new figure.
- `docs/train-verification.md`: the hour claims corrected.

## Why remove the hours instead of wiring them up

Making an hour real means faking the clock inside every date-touching test
— including the tile's own clock inside JSDOM, which reads the wall clock
in 30+ places. That is the same decision `docs/test-clock-inventory.md`
leaves open (pinning the tile's clock also changes what the 22
`localToday()` files compute). A harness that claims hours it cannot
deliver is worse than one that honestly claims zones, so the claim goes
now and the capability can come back with that decision.

## Consequences to know about

- **`verify:full` fails at the fuzz step until fuzz is re-pinned.** It
  passes `--require-pinned`, which rejects a `null` mode
  (`mutate.mjs`, the "is unpinned" check). That is intended: a
  comprehensive run should not report fuzz as gated when it isn't.
  `npm run mutate:fuzz` on its own still runs and reports, unpinned and
  not gating.
- Re-pin only from a run whose meaning matches its labels — zones as they
  are now, or hours once the clock is genuinely faked — never from a
  number produced before this change.
