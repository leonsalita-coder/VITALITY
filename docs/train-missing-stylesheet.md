# Train — the tile lost most of its stylesheet

Commit `191c04a` (2026-08-11, message `auto: update from Claude Code`)
deleted 1,252 lines across `public/tiles/train.html` and
`tiles-library/train.html`. The Train tile's `<style>` block went from
**73,694 characters / 333 styled classes** to **4,799 / 6**.

It is currently 12,119 chars / 56 classes, and all 56 were added by feature
work *after* the loss — rest bar, note cards, weekly review, readiness
verdicts. The original design system is gone. `.ex`, `.exHead`, `.pillHit`,
`.pillMiss`, `.pillInput`, `.actionPill`, `.grip` and `.menuBtn` have no
rules at all. A visible trace of it: `.pillWarm` still declares `flex:none`,
which does nothing, because the `.pillActions` flex container it assumed no
longer exists.

**This is recorded, not fixed.** Restoring it is a deliberate decision that
has not been taken. Of the 333 lost classes only 20 overlap with the
current 56, and those 20 are the rest-bar and background classes re-added
since — so a restore is a merge with 20 known conflict points rather than a
guess. `git show 731e891:public/tiles/train.html` has the last good copy.

It is written down because it was found by accident, twice over: a
tap-target measurement reported "not declared" for every logging control,
which only looked like a bug in the measurement until the history was
checked.

Anything that needs a **tap target to be larger, or any other visual
change, is blocked on this** — there is no rule to change. Work that
concerns which controls *render* (see training mode vs edit mode in
`renderExercise`) is unaffected and stands either way.

---

# Other deferred decisions

## Minimum effective dose, and transfer between lifts — NO LONGER DEFERRED

Both were deferred, for a stated reason: their gates would be guesswork,
with no way to validate them for close to a year, and they are the two
findings a lifter is most likely to act on.

**Both are now built**, because the objection was answered rather than
waited out. The gates are not constants: an effect is compared against a
null resampled from the athlete's own history by block permutation, so
there is no threshold to guess. The handful of numbers that decide *how*
to resample were measured against simulated histories where the truth is
known — see `docs/train-verification.md` for the tables, and
`tests/train/calibration.test.ts`, which keeps them executable.

Both also ship in **shadow mode**: they compute from the first session and
surface nothing. Every verdict is stored with its inputs, its resampled
null and the date; `node scripts/shadow-review.mjs` and the tile's
`__shadowReview()` print what would have been said and on what evidence.
Turning either on is one boolean in `lib/train/shadow.ts` plus a call
site — `doseNote` and `transferNote` exist, closed, for exactly that.

See `lib/train/dose.ts`, `lib/train/transfer.ts`, `lib/train/resample.ts`,
`lib/train/shadow.ts`.
