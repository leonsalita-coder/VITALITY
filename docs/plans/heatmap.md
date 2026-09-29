# The Train heatmap — a spec, not code

This replaces `.cal`/`.calShell` and everything under it
(`.calGridRow`, `.calDayLbls`, `.calMonths`, `.calPop`, `.calTotal`,
`.calLegend`, `renderCalQuarter`, `renderCal`... — see "What exists
today," below, for the exact inventory). One object, three axes (a
fourth added in §13), built from what the engine actually has, not
around what would be nice. Every section states what the engine already
provides, what needs deriving, and what it would cost. Open decisions
are named, not chosen, per the ask.

No code below. `STOP` at the end means stop.

---

## What exists today, and why it's being replaced wholesale

Read in full: `renderCalQuarter`, `drawSessionsCal`, `calQuarterCells`,
`calQuarterStats`, `aggregateVolumeByDate` (`public/tiles/train.html`,
~11129–11379), and the `.cal`/`.calShell` CSS family (~lines 892–935).

- **Scope: one quarter only.** `calBounds`/`calAddQuarters`/`calQuarterOf`
  are all quarter-unit. There is no year, month, or week view — zoom
  (§5) is entirely new, not an extension.
- **Color: raw tonnage, not self-relative.** `aggregateVolumeByDate`
  sums `workingVolume(entry).load` per date across all exercises; `level(v)`
  quantizes that against *this quarter's own max* into 5 buckets
  (`.cd.l0`–`.cd.l4`). This is exactly the wrong model the spec names in
  §1 — a heavy low-rep day and a light high-rep day are compared by raw
  load, and the scale resets every quarter, so the same absolute effort
  reads differently in a quiet quarter than a heavy one.
- **`--signal` is not scarce here — it's the only color used, at four
  opacities, across up to ~92 cells at once** (`.cd.l1`–`.cd.l4`, all
  `color-mix` steps of `var(--signal)`). This is the existing violation
  §-Constraints asks the redesign to explicitly not repeat.
- **DOM, not SVG.** Every cell is a real `<span class="cd">` with a
  `pointerover`/`pointerleave` handler pattern (delegated at the
  `#calCells` container level, which is good) but no `button`, no
  `tabindex`, no keyboard path, no `aria-*` at all. Hover-only.
- **Cascade-in animation on every render** (`animation:calIn .3s ...
  backwards`, staggered by `w*22+d*8`ms per cell) — exactly what the
  "no cascade animation on load" rule rules out.
- **`.calTotal` is a static number** with a hover-revealed sparkline
  (`.calPop`) of the quarter's cumulative volume curve — the closest
  existing thing to §7's "summary cell unfolds its own workings," and
  worth reusing the *idea* (a curve, drawn from the same days) even
  though the visual language changes.

Nothing here is reusable as-is. The replacement is a genuine rebuild,
not a refactor — stated plainly because "replace .cal" could otherwise
be read as "reskin .cal."

---

## §1 — The intensity model

**Per-day self-relative load is NOT currently exposed. It needs a new
derivation — here's exactly what.**

`lib/train/load.ts`'s `acuteChronic(ctx)` computes acute:chronic
**as of one instant** (`ctx.now`) — a single snapshot, not a series. To
color 365 cells by "how hard was *that* day relative to baseline," the
naive approach is calling `acuteChronic` once per visible day
(365× for a year view) — correct, but expensive: each call rebuilds a
56-day (`CHRONIC_DAYS * 2`) `dailySeries` from the full history and runs
two EWMA passes over it, per muscle. That's O(365 × muscles × history
size) for a single render.

**The real derivation is cheap, though, once shaped right.** `ewma()`
(`load.ts:140-145`) already computes the exact right recurrence — it
just discards every intermediate value and returns only the last one.
Capturing the running values as it iterates instead of discarding them
gets the **whole trailing series for the same O(span) cost the snapshot
already pays**. Concretely: a new function (call it `acuteChronicSeries`)
that runs the same `weeklyRate`→`ewma` pipeline once per muscle (or
systemic) and returns `{ date, ratio, usable }` for every day in range,
rather than the current `readingFrom`'s single `{ acute, chronic, ratio,
usable }`. This is a moderate, well-scoped addition — reusing tested
math, not inventing new math — not a one-line change.

**A hard constraint this surfaces, not incidental to it:** `usable`
requires `observedDays >= MIN_CHRONIC_DAYS` (28) **and**
`chronic >= MIN_CHRONIC_LOAD` (4 hard sets/week). For any athlete with
under 28 days of history, **every single day is unusable** — the
self-relative layer has *nothing* to show, universally, for a brand-new
user's entire first month. This is not a rendering detail; it directly
shapes §11 (first run) — day one cannot use this model at all, by the
model's own honest design. **Decided (§11):** the grid shows presence,
not intensity, until the gate clears — never tonnage as a silent
substitute.

**The second channel — proposed, not decided by me:** whether the
session met its own prescribed targets (a fact `sessionState`/
`workingSetCount` vs. the day's prescription already makes computable
per session) rendered as a **shape or border treatment**, not a second
hue — e.g., a filled square for "met," an outlined/hollow square for
"under," reserving color intensity purely for the load axis. This keeps
the two channels genuinely independent (color answers "how hard," shape
answers "as planned or not") rather than one diluting the other.
**Open decision:** the exact shape/fill vocabulary — named, not chosen.

**Two-a-days:** the `sessionId`-carrying rows already distinguish two
same-day sessions (`docs/two-a-day-decisions.md`). A cell representing a
two-a-day day needs its own mark — proposed: a split cell (diagonal or
side-by-side half-fill) rather than a single averaged value, so "two
sessions" is legible as a fact, not inferred from an unusually dark
square. **Open decision:** the exact split treatment.

**Greyscale requirement:** since intensity is the *only* color-bearing
channel (the second channel is shape, per above), the grid already
satisfies "reads in greyscale" by construction, provided the shape
distinction is genuinely visible without color — worth a real greyscale
render check once built, not just an assumption from the design.

**Signal scarcity — decided, not the elevation ramp.** The grid is a
low-opacity tint ramp of the single `--signal` hue. **Full-strength
`--signal` appears only on the top intensity band** — across a year,
five to ten days actually wear it at full strength; everything else is
a lower-opacity tint of the same hue, which is what keeps "signal is
scarce" true at 365-cell scale rather than diluting it into ambient
color. The `--e0`–`--e4` elevation ramp was considered and rejected: that
range is too narrow to read as a *scale* against a near-black
background — it's built for depth/layering, not for encoding a
continuous quantity, and forcing it to do both would make neither
legible.

**Rest vs. missed — proposed:** `STATE.finishedDates` (trained) and each
weekday's `streakTarget` (the athlete's own stated weekly target,
`lib/tiles/weights.ts`-adjacent / `weeklyTarget()` in the tile) together
already distinguish "the athlete said this is a planned rest pattern" —
no, they don't, directly: `finishedDates` says *trained or not*, and
`off:true` on a session (a rest day, per `session.ts`'s `sessionState`)
is a **decision the athlete made**, already distinct from an **empty
day** (`not_started`) per the existing `sessionState`/`contributionOf`
logic (`lib/train/session.ts`). So this is **already derivable, not
new**: a day is `rest` when its session has `off:true`, `missed` when it
has neither a logged session nor an explicit rest flag and fell on a day
the weekly target implies training was expected. Rendered as a quiet,
non-scolding mark — proposed: a small neutral dot or outline distinct
from both "trained" and "rest," at low visual weight. **Open decision:**
the exact mark.

---

## §2 — Cross-tile layers

**Checked against what Train can actually read** (`window.Vitality.read
('vitals')`, `public/tiles/train.html:7590` and surrounding): confirmed
fields are `whoopRecovery`, `feel`, `sleepHours` — matching the spec's
own statement exactly, nothing more. **Bodyweight is not from vitals at
all** — it's Train's own `STATE.bodyweight` (local, logged in this
tile), so that layer reads from Train's own data, not a cross-tile read.

Per proposed layer:
- **Training load** — the new `acuteChronicSeries`, §1.
- **Recovery** — `whoopRecovery` per day, already a plain number when
  present. Layer is a direct read, no new derivation.
- **Sleep** — `sleepHours` per day, same: direct read.
- **Bodyweight** — `STATE.bodyweight`, already date-tagged entries
  (confirmed: local logging, not from vitals). Direct read.
- **A single lift's e1RM** — `e1rmSeries` (`lib/train/series.ts`),
  already produces one point per day post the two-a-day fix
  (`docs/plans/two-a-day-decisions-staged.md`, §2). Direct read once
  that lands; **depends on that fix being merged first**, otherwise this
  layer inherits the pre-fix one-point-per-*session* bug on two-a-day
  dates.

**The overlay — proposed mechanism.** Primary layer (training load)
keeps full color intensity per §1. A second layer (proposed default:
recovery) marks its own condition — "recovery was low that day" —
with a **quiet geometric mark inside or around the cell** (a small
notch, a dot in a corner, a thin ring) rendered in the **same neutral
tone the "missed" mark from §1 uses**, not a second hue and not
`--signal`/`--gold`. This keeps "hard day, bad recovery" legible as
"dark cell + quiet mark," stays inside greyscale, and doesn't compete
with the shape channel from §1 (which is about *that day's own* target,
a different question than *the overlay's* "was something else true that
day"). **Open decision:** the exact overlay mark, and whether the
overlay is its own selectable state or always-on whenever a secondary
layer is chosen.

**Missing data is not zero — mechanism:** every layer's per-day value
needs a third state beyond "present" and "absent-from-lack-of-training":
**absent-from-lack-of-data**. A day with no vitals connection at all
(never has data) reads differently from a day inside a connected
vitals history that simply has a gap. Proposed: an explicit `null`
(no data ever) vs `undefined-in-a-connected-range` (a gap) distinction
carried through whatever `layerSeries` fetch each layer uses, rendered
as: no distinct mark for "never connected" (the whole grid says so once,
not per-cell — see below), and a visibly different (hatch/outline)
treatment for "gap inside connected data." **Open decision:** the exact
visual for a gap.

**"A layer with no data says so plainly" — decided: neutral grid PLUS a
statement, never replaced.** When a layer has zero data anywhere in the
visible range (e.g., recovery selected but Vitals was never connected),
the grid does not render 365 "no data" cells, and it does not
disappear either — the geometry stays exactly where it is (grid shape
neutral, colour dropped) and the arc-sentence slot (§4) says why
("Recovery isn't connected — nothing to show here"). **This is the same
rule as the 28-day gate in §11, not a second one:** both are "keep the
shape, drop the colour, say why" — the 28-day gate is a *temporal* case
of it (not enough history *yet*), an empty layer is a *data* case of it
(no source connected *at all*). One rule, two triggers. The grid's own
geometry is how someone orients on the page; removing it on top of
having nothing to show would compound "no data" into "no page," which
is a worse failure than either alone.

**Open
decision:** which.

---

## §3 — The phase band

**`DeloadState` has four values, not five: `'normal' | 'flagged' |
'deloading' | 'reapproach'`** (`lib/train/deload.ts:43`). There is no
`'cooldown'` state in the type. **Decided: four states, not five —
`cooldown` is dropped as a phase.** What exists instead: `COOLDOWN_DAYS
= 14` (`deload.ts:39`), a **suppression window** after a deload
completes — "do not re-flag the same lift for this long" — not a stored
phase, and it doesn't become one here. If it's ever worth showing, it's
derived (a day reads as "in cooldown" when the state is `normal` and
fewer than 14 days have passed since the last `reapproach → normal`
transition) and rendered as a distinct *visual treatment of the `normal`
band* — a texture or reduced-opacity variant of "normal" — never a fifth
phase-band color, since it isn't a fifth state.

**A second gap, solved by reusing §13's filtering rather than inventing
an aggregation rule.** `STATE.deloadStates[id]`
(`public/tiles/train.html`, throughout ~6717–7985) is keyed by exercise
id — an athlete training eight lifts can have eight different,
simultaneous phases. **Decided:** two readings, not one invented
composite:

- **Unfiltered (no lift selected):** the band shows *how much* of the
  athlete's training is in a non-normal state, as **intensity**, not a
  category — one lift flagged reads faint, everything deloading reads
  solid. This is a density reading over the same per-lift states that
  already exist (the fraction of tracked lifts currently in
  `flagged`/`deloading`/`reapproach`), not a new state machine.
- **Filtered to one lift (§13):** the band shows that lift's *actual*
  categorical state machine — `normal`/`flagged`/`deloading`/
  `reapproach`, exactly as `DeloadState` already defines it, no
  aggregation needed because there's only one state to show.

No invented rule, no stacked multi-row band — the existing filtering
mechanism from §13 is what switches between the two readings.

---

## §4 — The arc sentence

Reuses the same silence-gated shape as `lib/train/projection.ts`'s
existing goal projections (`MIN_PROJECTION_POINTS`, `STALE_DAYS`) — see
`docs/plans/satisfaction.md`'s arc-sentence section for the general
mechanism; this is that same idea applied to whatever period is in view
rather than to a single lift's trend.

Three candidates, built from real shapes the engine can produce:

1. **A clean, on-plan quarter:**
   > "Twelve sessions this quarter, load holding inside your normal
   > range the whole time."

2. **A quarter with a deload in it** (using the phase band's own
   states, once §3's aggregation is decided):
   > "One deload this quarter, on the bench press — three weeks
   > flagged, two reapproaching, back to normal since March 3rd."

3. **A quarter with a real gap** (missing data, §2, or a genuine break
   in training — proposed use of `frequencyGaps`, already computed in
   `lib/train/analysis.ts`):
   > "Eleven days off in February, then back to your usual four a
   > week."

Candidate 2 is the most interesting and the most dependent on §3's open
decision landing first — it can't be built honestly until "one deload
this quarter" has an actual, decided meaning across potentially several
simultaneous per-lift states.

---

## §5 — Zoom

**Entirely new — today's `.cal` is quarter-only, full stop.** Year,
month, and week views don't exist in any form to extend.

Cost is mostly in §1's derivation: `acuteChronicSeries` needs to run
efficiently at whatever the widest zoom (year, or multi-year per §17)
requires, since the per-day EWMA pass is the expensive part regardless
of how many cells are actually rendered. Proposed approach: compute the
series once for the full requested range on zoom/period change, and let
zoom purely re-render from that cached series rather than re-deriving
per zoom level — a rendering-layer concern, not a new data concern,
once `acuteChronicSeries` exists.

---

## §6 — Selection and comparison

**"Versus the last time you did this session"** already has its data
shape available: `sameAsLastTime` (`lib/train/session.ts`) already finds
the most recent prior session for a lift; the breakdown (§7) needs the
equivalent at the **whole-session** level (same set of lifts/slots, not
one lift) — not something that exists today, but a natural sibling of
`sameAsLastTime`'s existing logic, built the same way (walk history
backward, match on the session's lift set, not on typical-session
heuristics from a specific lift).

Two-day comparison ("same rows, deltas stated") and range summary are
rendering-layer work over data every layer already exposes once §1–§2
land — no new engine derivation beyond what those sections already
name.

---

## §7 — The breakdown

Each row's data source, checked against what exists:

- **What you did** — `sessionTotals`, `workingSetCount`, `loggedSetCount`
  (`lib/train/metrics.ts`, `lib/train/session.ts`) — exists.
- **What changed** — `classifyPR`/`bestE1RM` per lift, already exists;
  "first-times" (a lift never logged before) is a simple presence check
  against prior history, not something computed today but trivial to
  add.
- **What the system saw at the time** — deload state (exists, per-lift,
  §3's aggregation problem applies here too if summarizing rather than
  listing per-lift), acute:chronic (via §1's new series, evaluated at
  that specific day), readiness (exists, but **only ever computed for
  "today" in the live tile** — `computeReadiness()` reads `STATE.history`
  as of *now*, not as of a past date; showing "what readiness said that
  day" for a HISTORICAL day is not something the current readiness
  computation supports, since it has no `now`-in-the-past mode; this is
  a small but real gap: `assessReadiness` itself takes a context object
  and could be evaluated at a past `now`, but nothing currently builds
  that context for anything but the live session).
- **Versus last time** — §6, needs the new session-level "same as last
  time" sibling function.

**`.calTotal` unfolding its own curve** — closest existing precedent is
today's `.calPop` sparkline (hover-reveals the quarter's cumulative
volume curve). The replacement keeps the *idea*, changes the *data*
(tonnage → whatever the active layer is) and the *interaction* (should
work via keyboard selection, not hover-only, per §8).

---

## §8 — Accessibility as structure

Direct answer to the `#daydots` and `fieldRow()` findings from
`docs/plans/accessibility-audit.md`: this component is the reason those
findings matter enough to fix as structure rather than retrofit — a
365-cell grid is the single largest color-only-state surface in the
whole tile, and if it ships the same way `#daydots` did, it's the same
bug at 17× the scale.

Every cell a real `<button>` (or, if the render is genuinely one `<svg>`
per §12, focusable elements the SVG itself hosts — `<rect
tabindex>`/`role="button"` inside the SVG, still real, keyboard-focusable
nodes, not `<div>`s pretending). Arrow-key navigation moves focus
between days; the focused day drives the same readout hover currently
drives, so keyboard and pointer users get identical information, not a
degraded keyboard-only experience. An `aria-live="polite"` region
announces the focused day's summary. The grid container carries a label
naming the period and active layer ("Training load, Q3 2026").

---

## §9 — Annotations

**Checked — there is no existing "a day carries a note" mechanism to
extend.** Two things exist that are adjacent but not it:
- `.noteEdit`/`e.note` (`public/tiles/train.html:10440-10452`) is a note
  on a single **exercise within a session** ("A note for this lift") —
  wrong granularity, tied to one lift, not the day.
- `OtherEntry.note` (`lib/train/other.ts`) is a note on a **non-lifting
  training entry** (martial arts, conditioning) — has a date, but only
  exists for days someone logged other-training, not every day.

**This needs a new, small structure** — proposed: `STATE.dayNotes`, a
flat date-keyed map of plain strings, independent of any specific
exercise or other-training entry, matching the existing `e.note`/
`OtherEntry.note` convention (plain user-authored text, `.slice(0, 200)`-
style length cap, never generated). Calling this "extending" the
existing mechanism would be inaccurate — it's a new field that borrows
the existing pattern's shape and voice.

Marks the grid quietly (a small indicator distinct from the §1/§2 marks
— **a third mark vocabulary competing for the same tiny cell is a real
design risk worth naming**: by this point a single cell may need to
carry load intensity (color), met-target (shape), an overlay condition
(§2's quiet mark), rest-vs-missed (§1), AND a note indicator. That's up
to five simultaneous signals on one ~13px square. **Open decision, and
possibly the most important one in this whole spec:** which of these
compete for the same visual budget and what actually survives at cell
scale — directly connects to §10.

---

## §10 — What degrades at which zoom

Honest accounting, not a guarantee:

- **Year (~365 cells, ~4px each per the spec's own estimate):** color
  intensity survives (it's the whole cell). Shape/fill distinction
  (§1's second channel) is very likely **not legible** at 4px — a filled
  vs. outlined square is a marginal distinction even at 13px (today's
  cell size), let alone 4px. Overlay marks, note indicators, and the
  two-a-day split treatment are almost certainly invisible at this
  scale. **What carries the signal instead at year zoom: the arc
  sentence and the phase band** — both operate at the period level, not
  the cell level, so they're unaffected by cell size. This is the
  honest answer the spec asked for, not a guarantee that quietly fails:
  **at year zoom, only color intensity and (per §3) the phase band
  underneath are reliably legible; everything else is real but
  effectively decorative at that scale, and shouldn't be relied on to
  communicate anything the arc sentence or phase band doesn't also say.**
- **Quarter (today's existing scale, 13px):** shape/fill distinction and
  the two-a-day split are legible (today's cells are already this size).
  Overlay marks and note indicators need testing at real scale before
  claiming they work — proposed, not confirmed.
- **Month/week:** cells large enough that every channel proposed above
  should be legible; the open question shifts from "does it fit" to
  "is five simultaneous signals overwhelming even when each is
  individually visible" — a design judgment call for whoever reviews
  the built component, not something resolvable in a spec.

---

## §11 — The first run

**A hard constraint, not a design choice:** per §1, the self-relative
load model is universally `unusable` for the first 28 days of any
athlete's history (`MIN_CHRONIC_DAYS`). Day one, week one, and most of
month one cannot use the primary intensity model at all — this isn't a
styling decision, it's the model's own math.

**Decided:** for the pre-28-day period, the grid shows **presence, not
intensity, and says why** — never tonnage as a silent substitute for the
real model, which would be exactly the kind of colour-lies-about-effort
problem §1 exists to fix, just moved earlier in the timeline instead of
removed. Concretely: cells show trained / rest (`off:true`) /
not-yet-happened only, at a single flat mark weight, alongside a visible
statement (arc-sentence slot, §4) naming the gate plainly — e.g. "Coloring
by training load starts once you have 28 days on record — 12 to go."
That statement is itself an instance of the arc sentence's own silence
rule in reverse: instead of staying silent for lack of data, it says
*exactly* what's missing and when it resolves, because "there's nothing
to say yet" and "there's a known, counting-down reason" are different
statements and the second one is true here.

**Day 28 is designed as a moment, not a threshold that passes
unannounced.** The grid doesn't quietly start coloring on day 29 as if
it always could. Proposed: the transition is the one deliberate
exception to the "no cascade animation on load" rule — a single,
one-time reveal, the first and only time the grid is allowed to animate
its own coloring in, precisely because it's reporting a genuine
capability the athlete's own consistency just unlocked, not decoration.
Paired with an arc-sentence line marking it explicitly ("28 days in —
this is now colored by how hard each day actually was for you"). Never
repeats, never fires again once seen.

**When does year view become worth offering at all? Decided: the same
day 28 threshold, not a second one.** The year view arrives exactly
when the colour does. Before day 28, the widest zoom offered is month —
there's no separate "enough data for a year view" judgment call to make,
because the real gate is "enough data for the thing a year view exists
to show" (self-relative load), and that's already day 28. One threshold
does both jobs: it's when the grid gains its colour, and it's when the
widest useful zoom becomes available. Simpler than picking two numbers
that would otherwise drift apart for no real reason.

---

## §12 — It has to feel fast

**One `<svg>`, cells as `<rect>`/`<g>` children, one delegated pointer
listener on the SVG root** — matching the existing pattern this tile
already uses for delegated interaction (`#calCells`'s current
`pointerover`/`pointerleave` delegation, `wireCardGlow`'s pattern at
`train.html:11401`), just moved from DOM spans to SVG shapes. 365+ DOM
nodes each carrying their own handler is exactly the shape the spec
rules out, and it's also, not incidentally, the shape today's `.cal`
already avoids for its *events* (delegated) while still paying the DOM
cost for the *elements themselves* (365 real `<span>`s). SVG shapes are
lighter DOM nodes than styled `<span>`s and the whole grid becomes one
paint/layout unit instead of hundreds.

**Re-render on layer/zoom change:** proposed — re-render is a full
redraw of the SVG's cell fills/marks from the currently-cached series
(§5's caching approach), not a DOM diff — at this cell count, redrawing
is cheaper than diffing, and it avoids maintaining transition state
across a layer swap that's supposed to feel instant, not animated (per
"no cascade animation" and the general "no decoration that isn't
carrying information" rule — a layer swap is not itself information).

---

## §13 — Filtering

Fourth axis, alongside layer/zoom/selection. "Dim what doesn't match,
light what does" is cheap to implement once the underlying per-day facts
exist:
- **A given lift** — already derivable from history, per exercise id.
- **A record day** — `classifyPR` per day, already derivable.
- **Above/below a load threshold** — the new `acuteChronicSeries` (§1)
  directly supports this once it exists.
- **A note** — `STATE.dayNotes` (§9) presence check, once that exists.

No new engine work beyond what §1 and §9 already require — filtering is
a rendering-layer predicate over data the other sections already
specify deriving.

---

## §14 — Photos on the grid

**Already date-tagged — confirmed, no new modeling needed.**
`STATE.photos` (`public/tiles/train.html:10688` and surrounding) is a
flat array of `{ url, date, analysis }` entries. A day holding a photo
is a direct `STATE.photos.some(p => p.date === cellDate)` check.

**Privacy boundary, confirmed intact by construction:** photos already
go through `window.Vitality.addProgressPhoto` (server-routed to the AI
path) and are stored as `{ url, date }` locally — putting a marker on
the grid reads `date` only, never touches the photo's own content or
the AI-analysis path. Nothing about surfacing "a photo exists on this
day" as a grid mark changes where the photo itself goes.

---

## §15 — Session start time

**Checked, and dropped.** Sessions do not currently carry a start time
once committed to history — `startedAt` exists only on the *live*
`curSession()` object (`public/tiles/train.html:8770`), never written
into the row `rollupFor` commits (confirmed by reading its row
construction directly: `row = {date, kg, sets, sessionId}`, no
time-of-day field). **Decided: not adding it.** No field, no "train
better in the morning" discovery feature, speculative or otherwise. This
section exists in the spec only to record that the question was asked
and answered no, not as an open item.

---

## §16 — Editing a day, and closing the backdated-hole bug

**Decided: close the bug, don't defer the feature.** A calendar you
can't correct from is worse than the bug it would otherwise ship around.
Scoped below, from reading the actual backdate path in full
(`openBackdate`/`editPastSession`, `public/tiles/train.html:9567-9643`),
not just the `rollupFor` filter in isolation.

**What the current bug actually is.** `rollupFor`'s exclusion filter
(`train.html:8878-8880`):
```
const isToday = date===today;
const sid = isToday ? curSession().id : null;
let h = histFor(e).filter(x=>x.date!==date || (isToday && x.sessionId!==sid));
```
For any backdated write (`isToday` false), this collapses to
`x.date!==date` — drop every row on that date, unconditionally. Fixing
*only* this line isn't enough, though: if `sid` simply became a real
value for backdated writes too, every caller still has to supply a
sessionId that's actually distinct per logical edit, or the collision
just moves rather than closes.

**Three things this touches, not one:**

1. **`rollupFor` itself** — the `isToday` branch is removed; the
   sessionId-based exclusion applies unconditionally, today or
   backdated.
2. **`editPastSession` (`train.html:9585-9599`)** — `draft` currently
   carries no `sessionId` at all. It needs one, generated fresh
   (`newSessionId()`-style, the same mechanism `train.html:7132` already
   uses for live sessions) each time the dialog opens for a *new* entry
   — never derived from `date`, which is exactly what caused the
   original collision.
3. **A real, previously-hidden product question this surfaces —
   decided.** `editPastSession`'s existing-row lookup —
   `const existing=(STATE.history[id]||[]).find(x=>x.date===date)`
   (`train.html:9587`) — grabs the *first* row on that date, with no way
   to show or reach a second. **Decided: a date with two sessions lists
   both in the grid's breakdown (§7), each editable in place. No session
   picker, no "add another session" action, in v1.** This is simpler
   than the picker/add-another shape considered above, and it fits the
   breakdown's own existing job (§7 already lists "what you did" per
   session) rather than inventing new dialog UI — `editPastSession`'s
   single-row assumption is what needs to go, not what needs a new
   affordance layered on top of it.

**What it changes in the existing tests.** Searched the whole suite:
`rollupFor(` and `editPastSession`/`openBackdate` are exercised **only**
in `tests/train/two-a-day.test.ts` — no other test file touches this
path at all, directly or through the tile. Inside that file, the one
`.fails` test this fix is meant to flip
(`'keeps both backdated sessions on the same past date'`) currently
constructs both `draft` objects with **no `sessionId` field either** —
so the test itself needs updating alongside the fix, giving each draft
its own distinct id, or both would still collide under `undefined !==
undefined`. That's expected work, not a regression — it's the same test,
made to actually exercise the fixed behavior instead of describing the
bug. No other existing, currently-passing test pins the old
single-session-per-backdated-day behavior anywhere in the suite.

---

## §17 — More than one year

Not designed as an afterthought: zoom (§5) already treats year as one
level among several, and `acuteChronicSeries` (§1) is range-based rather
than quarter-bound, so nothing in §1 or §5 assumes a single-year
boundary.

**Decided: paging between years, not a continuous zoom-out — and a year
is the widest DAY grid, full stop.** Beyond one year, the view is not
"the same grid, smaller cells" (§10 already establishes that cells
shrink to illegibility well before a multi-year range would need them
to) — it becomes **a different geometry entirely**: years as rows,
months as columns, one cell per month — the shape a contribution/
returns-style calendar already uses for exactly this reason. Reached by
**zooming out past the year**, not by cramming more days into the same
pixel budget. This means the zoom axis (§5) isn't strictly "the same
object at different scales" all the way out — it's "the same object,
day-granularity, from week through year, and then a second, coarser
representation beyond that," which is worth stating plainly rather than
implying one continuous geometry that doesn't actually hold at every
level.

**Does the arc sentence span years?** — mechanically yes (it's already
period-agnostic per §4), but a multi-year arc sentence needs its own
candidate shapes (a 3-year "steady climb" sentence reads very
differently from a 1-quarter one) — not attempted here since it's a new
writing problem, not a data problem, and better done once the
single-year version is built and its voice is proven. Still open, and
narrower now that the geometry above is decided: what does the arc
sentence say about a *month-cell* view rather than a *day-cell* one?

---

## Open decisions, collected

Ten of the original fourteen are now settled: 28-day gate, phase-band
aggregation, signal scarcity, closing the backdated bug, dropping
`cooldown` as a fifth state, dropping session start time, empty-layer
degradation (same rule as the 28-day gate), the year-view threshold
(same moment as the colour gate), the two-session edit question (list
both in the breakdown, no picker), and paging vs. continuous zoom-out
(paging, plus a decided multi-year geometry change past one year).

**Five collapse into one probe, per the instruction not to guess them
from the spec:**

- §1 — exact shape/fill vocabulary for "met target vs. not."
- §1 — exact two-a-day split-cell treatment.
- §1 / §2 — exact "rest vs. missed" and "gap in connected data" marks.
- §2 — exact overlay mark, and whether it's always-on or its own toggle.
- §9 / §10 — which of the (up to five) simultaneous per-cell signals
  actually survive contact with a real cell.

See "The signal-survival probe," below — built, not spec'd, because
legibility at 13px (and ~4px) isn't something a document can settle.

## The signal-survival probe

Built as `docs/heatmap-probe.html`, published for review at
https://claude.ai/artifact/X3nTG7NEakfeNfwDibEVUo — real tokens copied
from `public/tiles/train.html`'s `:root`, cells at true 13px (today's
`.cal .cd` size) and true 4px (year scale), every signal alone, every
pairing, all five together, and the same sets in greyscale.

**Not yet wired into `docs/contact-sheet.html`.** The real contact sheet
is a build artifact (`scripts/build-contact-sheet.mjs`, which copies the
tile's `<style>` block verbatim and asserts byte-identity) — running
that build means spawning node while the mutate sweep is still live
mutating `lib/train/`. Built as a standalone page instead, tokens
reconciled by hand rather than by the real pipeline, to get something
reviewable now without touching anything the sweep is using. Folding it
into the real contact sheet is a short follow-up once the sweep is done
and it's safe to run the build script again.

**A first read, from the CSS values themselves — not a substitute for
looking at the live page, which is the entire reason this was built
instead of guessed:**

- **Load alone, at both sizes:** reads clearly. The whole point of the
  design (colour as the only universal carrier) holds.
- **Load + target-met (13px):** plausible — a filled disc vs. a
  coloured hollow ring is a real distinction at 13px with a 1.5px
  border. At **4px**, that same 1.5px ring is most of the cell's total
  diameter; there is very little room left for a visible hollow centre.
  Likely fails at year scale, which matches §10's prediction rather than
  contradicting it.
- **Overlay (the inset ring):** the highest-risk pairing at 13px. It's
  drawn in `--muted-2`, a mid-dark grey, nested *inside* a cell that at
  high load levels is nearly full-strength `--signal` — a dark ring on a
  bright mint fill is a real contrast risk worth checking first on the
  live page, not assumed fine because the geometry is correct.
- **Note (the corner dot):** sits outside the cell's own bounds
  (`top:-1px;right:-1px`), so it depends on real cell-to-cell spacing in
  the eventual grid, not shown by a single isolated swatch — the probe
  page shows the mark itself clearly; whether it survives sitting next
  to a neighbouring cell is a question the probe can't answer alone.
- **Split, overlay, and note at 4px:** all three are built at a scale
  where the mark is a fraction of a css pixel's worth of visual budget.
  Expect these to be effectively invisible at year zoom — again
  consistent with §10 rather than a new finding.
- **All five at once, 13px:** the combination most likely to read as
  crowded rather than legible — a filled/ring shape, a nested overlay
  ring, a corner dot, and a diagonal split compete for the same ~130
  square pixels. This is the single most important swatch on the page to
  look at directly before deciding anything from §1's remaining open
  items.

Treat the above as a hypothesis the page was built to let you overturn,
not a conclusion — the live artifact is the actual instrument here.

**One genuinely new, narrower question, from §17:** what does the arc
sentence say about a month-cell multi-year view, as opposed to a
day-cell one — deferred until the single-year voice is proven, per §17.

## Cost, roughly, by dependency order

1. **Closing the backdated-hole bug (§16)** — moved to first, since it's
   now decided work rather than a deferred question, and the grid's edit
   path depends on it existing before it ships at all. Touches
   `rollupFor`, `editPastSession`, and the one existing `.fails` test
   (which needs its own fixtures updated to supply distinct session ids,
   not just an assertion flip). Contained blast radius — confirmed no
   other test in the suite exercises this path — but real product
   surface, not a one-line fix, because of the "which existing session"
   question it surfaces (open decision §16 above).
2. `acuteChronicSeries` (§1) — the load-bearing new derivation
   everything else's "load" layer depends on. Moderate: reuses tested
   EWMA math, needs restructuring to expose the trailing series instead
   of the final value.
3. Two-a-day decisions (`docs/plans/two-a-day-decisions-staged.md`) —
   the e1RM layer (§2) inherits its bug until that lands.
4. Session-level "same as last time" (§6) — small, a direct sibling of
   existing `sameAsLastTime`.
5. `STATE.dayNotes` (§9) — small, new but shape-matches existing
   conventions.
6. Everything else (zoom, layers, phase band, breakdown, filtering,
   accessibility, SVG render) is rendering-layer work over data the
   above five items provide — real work, but not new derivations.

STOP.
