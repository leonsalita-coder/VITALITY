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

## Minimum effective dose, and transfer between lifts

Both were specified and both were **deliberately not built**, for the same
reason: each needs within-person variation across many months before it
can fire at all.

- **Minimum effective dose** — "you progressed the same on 12 sets of
  chest as on 18" — requires periods of genuinely different weekly volume
  in the same person, long enough apart to compare.
- **Transfer between lifts** — "your front squat went up and your back
  squat followed three weeks later" — requires a lead-lag signal across
  enough cycles to separate it from coincidence.

Their gates would be pure guesswork today, with no way to validate them
for close to a year. And they are the two findings a serious lifter is
**most likely to act on** — someone who is told twelve sets is enough will
drop six — which makes a guessed threshold expensive in a way a wrong
volume warning is not.

The engine already has everything they need: per-muscle volume
attribution, e1RM series, `periodComparison`, the curated-hypothesis
discipline from `weekly.ts`, and now `simulate()` for testing a fit
against replayed history.

**Revisit once there is real history to tune the gates against.** This is
a deferred decision, not an oversight.
