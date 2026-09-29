# Why `fuzz` is unpinned — deliberately, not by neglect

`.mutation-baseline.json`'s `fuzz` key is `null`. This records why, so the
next reader doesn't read that as an oversight and quietly re-bless it to
whatever number a run happens to produce.

## What was found

`fuzz` mode varies a test's `TZ` (and, until this change, a `MUTATE_HOUR`
env var) and checks whether the same dated tests still pass. Two
consecutive runs on the same, unchanged commit produced two **different**
survivor sets — `Australia/Sydney`/`UTC` at four specific hours one run,
a single unrelated `Europe/London` survivor the next. That's not
flakiness in the abstract; it has a specific, confirmed cause.

## The root cause

`MUTATE_HOUR` was set on every fuzz sub-run and **read by nothing** —
grepped `lib/`, `tests/`, and `vitest.config.ts` for it: zero consumers
outside `scripts/mutate.mjs` itself, which only ever wrote it. Only `TZ`
had real effect. It's been removed from `scripts/mutate.mjs` — fuzz now
varies `TZ` alone, across the same four zones, once each, and says so
honestly.

Removing the dead variable doesn't fix the underlying non-determinism,
though — that's a separate, larger problem. 22 test files each define an
identical `localToday()` helper that reads the **real system clock**
(`new Date()`, no injected time) and formats it with **local-time**
getters. Local-time getters are governed by `TZ`, so under fuzz's zone
override, whatever real moment a check happens to run at can land on a
different calendar day depending on the zone — a genuinely
non-reproducible result, not a fixed bug fuzz is correctly catching. A
further 16 files build "N days ago" fixtures with inline
`Date.now()`-relative math, same underlying problem in a different shape.
27 files total.

`iy/test-clock-helper` (reviewed, recommended for merge) extracts
`localToday()` into `tests/helpers/clock.ts` with an injectable clock,
defaulting to real time — the prerequisite for actually fixing this, not
the fix itself. Every call site still defaults to the real clock today.

## Why not just re-bless it

A baseline is supposed to mean "this number shouldn't rise." Blessing
`fuzz` to whatever a clean-looking run currently shows (7, or 1, or 0 on
a lucky run) would encode **noise** as if it were a real, meaningful
figure — the next person to see a `fuzz` regression would have no way to
tell a real timezone bug from an artifact of what time it happened to be
when the sweep ran. A baseline that fails for reasons unrelated to code
teaches people to re-bless instead of investigate, which is the same
failure this whole harness exists to prevent in every other mode.

## What re-pins it

Once the 27 files take an injected clock (the real fix, staged as its
own piece of work, not attempted here), a `fuzz` run becomes
reproducible regardless of real-world time or zone — at that point, and
not before, a clean run is worth recording as a real baseline.

Until then: `fuzz: null` is deliberate. Do not re-pin it from a single
run's count.
