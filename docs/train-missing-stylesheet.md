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

**Dose never surfaces a verdict.** Its equivalence claim cannot be
supported at a true ratio of 1.25x at any realistic sample size, and a
self-stated bound is a caveat readers discount — so it is off
`SURFACEABLE` entirely rather than behind a flag. It reports resolution
instead: what the log can tell apart, and how much more history would
close the gap. See docs/train-verification.md.

Both also ship in **shadow mode**: they compute from the first session and
surface nothing. Every verdict is stored with its inputs, its resampled
null and the date; `node scripts/shadow-review.mjs` and the tile's
`__shadowReview()` print what would have been said and on what evidence.
Turning either on is one boolean in `lib/train/shadow.ts` plus a call
site — `doseNote` and `transferNote` exist, closed, for exactly that.

See `lib/train/dose.ts`, `lib/train/transfer.ts`, `lib/train/resample.ts`,
`lib/train/shadow.ts`.

## The coach overlay — still deferred, needs a design pass not a rounding pass

`.coachFab`, `.coachOverlay`, `.coachMorph` and the ten `.cv*` classes
(`.cvSend`/`.cvInputRow` excepted — they came back earlier as button/input
primitives) were part of the August loss and have not been recovered,
unlike the frame, the fan browser, progress photos, settings and the
calendar, which all were in this same pass.

**It is a different kind of gap.** Every other recovered group ported onto
the current token set with nothing worse than a sub-floor size needing to
round up. The coach overlay does not: every colour in it is a bespoke raw
`rgba()` — `rgba(10,20,17,.92)`, `rgba(2,3,3,.98)`, `rgba(16,22,20,.95)`,
`rgba(4,5,5,.98)`, plus `rgba(110,231,183,.2)` and `.03` for its border and
inset glow — describing a 28px-blur, saturated glass panel. None of it maps
onto `--e0`–`--e4`, and none of it should: it is a second visual language,
not a token gap.

**This was a deliberate move, not an oversight, and the record of that
decision already exists in the tile.** The comment above `#vt-backdrop`
(`public/tiles/train.html`, near the top of the `<style>` block) says the
rest of the design moved away from heavy blur and glass toward flat
elevation steps, and kept the backdrop only "as-is per request." Recovering
the coach overlay verbatim would reintroduce exactly what that move left
behind — same blur-and-glass instinct, just on a different surface.

**Recommendation for whoever picks this up:** treat it as a redesign
brief, not a recovery task. The markup and JS (`openCoach`/`closeCoach`,
`lib/train/insight.ts`, `lib/train/review.ts`) are live and unaffected —
this is styling only. `git show 731e891:public/tiles/train.html` still has
the original rules if the old shape is useful as a reference, but porting
its colours is very likely repeating the thing `#vt-backdrop`'s comment
already says was corrected once.
