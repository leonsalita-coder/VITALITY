# Coverage queue — survivors, module by module

Each module was swept with `node scripts/mutate.mjs --mode=mutate --files=<module>`,
every survivor read, and **tests** added (no engine code changed). A survivor
left standing has one of two things here: a proven equivalence, or a written
reason it is a gap nobody should close by pinning the implementation.

"Proven equivalent" means run, not argued: the original and mutated module
were bundled side by side and the same generated inputs pushed through both,
including through the real downstream consumer. The tool that does this is
described at the end.

The two-a-day `.fails` tests in `tests/train/two-a-day.test.ts` are left
failing on purpose throughout; they wait on decisions that are not the
harness's to make.

---

## predictions — 20 → 3

**Real gaps closed (17):** metres scoring was untested outright (hit, short,
and the 20%-too-light edge); the seconds too-light edge; `recordPrediction`
refusing a missing id / missing date / null store / null prediction, each on
its own; `accuracyOver`'s `since` filter and its inclusive boundary (the tile
uses it); `whenWrong` staying null when nothing was wrong; and the three
`progressionDamping` edges — exactly the sample gate (10 is enough), exactly
a 60% rate (not poor: the rate is the one *below which* it eases off), and
exactly 60% of misses high (qualifies) — plus a decent record with all-high
misses, which must stop at the rate gate before direction is considered.

**Left (3):**

- `L170` sort `||` → `&&` — **equivalent, proven.** It changes only the
  insertion order of the `byBasis`/`byLift` keys. Nothing reads them: not
  the tile, not any engine module (grepped). Across 400 generated stores ×
  three `since` values, the values (keys sorted), `progressionDamping` and
  the tile's accuracy line (`train.html:7672`, reproduced verbatim) were
  identical; only the raw key order differed.
- `L171` empty-store early return removed — **equivalent, proven.** The loop
  then builds a deep-equal empty result. Same 1,602 comparisons, 0 differ,
  including empty, null, and fully-filtered-by-`since` stores.
  *Side note, not a test gap:* the early return hands back `{ ...EMPTY }`,
  whose `byBasis`/`byLift` are the SAME objects on every empty call. A
  caller that mutated them would poison every later empty result. Nothing
  does today.
- `L204` `missedHigh >= missedLow` → `>` — **a real, unspecified choice; not
  pinned.** On a tie the text says "usually too high (1 of 2)" — "usually" is
  false at 50/50, and the tie-break direction is arbitrary. A test pinning
  either side would assert the implementation, not a rule. Needs a decision
  (e.g. "as often too high as too light"). It never reaches damping: damping
  requires ≥ 60% of misses high.

Fixture shape: nothing here was masked by shape rather than value.

---

## weekly — 19 → 14

**Real gaps closed (5):** a `NaN`/`Infinity` night in vitals was averaged in
and silently dropped the finding (L216); a weightless set counted as a best
set of zero and halved the week's e1RM reading (L163 `>` → `>=`); a week of
only high-rep work read as "best sets down 100%" (L166); an all-negative
bodyweight record produced "strength per pound up" (L226, two mutants). Each
test has a control showing the same fixture fires once the bad value is gone.

**Left (14) — all equivalent, proven** against 3,000 generated weekly contexts
through `weeklyChange` (varied volume, load, sleep, recovery, rest, bodyweight,
other training, deload/layoff/import flags, and hostile values: `NaN`/`Infinity`
vitals, zero/negative bodyweight, weightless and >10-rep sets, weeks with
unfinished sessions), plus 3,000 more with targeted zero/negative bodyweight
for the L226 group:

- `L134, L144, L173, L180, L189, L196, L217` empty-reading guards removed:
  with nothing in the window the code below computes `mean([]) = 0` and
  `samples: 0`, which is `NOTHING` field for field, and the samples gate
  refuses it identically.
- `L201` same, except the unguarded path reports `estimated: true`; that flag
  is only read after the samples gate, which a zero-sample reading never
  passes.
- `L98` `weeks > 0` → `>=`: dead branch. Every window is 7 or 28 days.
- `L388` product `> 0` → `>= 0`: the product cannot be zero there — both
  deltas already cleared `moved()` with strictly positive minimums.
- `L226` first `||` → `&&`: with no e1RM samples it computes `samples: 0`
  and the gate refuses it.
- **Equivalent only through `deltaOf`** (flagged, not buried): `L226 <=` → `<`
  (bodyweight exactly 0) and both `L237` mutants (no finished sessions)
  divide by zero. The resulting `Infinity`/`NaN` reaches `deltaOf`, which
  returns `change: null` for non-finite input, so `moved()` refuses it
  exactly as it refuses the original's empty reading. That guard is itself
  pinned (`windows.test.ts:109-111`), but these three are equivalent BECAUSE
  of it, not on their own.

*What I got wrong first:* I argued the negative-bodyweight mutants equivalent
("both deltas go negative, so the opposite-direction gate refuses"). The
random driver agreed — but only because a random week rarely has a negative
MEAN. A targeted driver with every reading negative produced
"Strength per pound up 8% in a week you averaged -162 lb". Both now killed.

Fixture shape: nothing here was masked by shape rather than value.

---

## deload — 11 → 0

All 11 were real gaps, every one a documented edge the tests never sat on:
two RPE points being enough for a trend (L159); a rise of exactly one point
(L165); a mean of exactly `HIGH_RPE` (L166, "at or above"); recovery of
exactly `RECOVERY_FLOOR` not being a recovery problem (L235, "below this");
a last-session RPE of exactly `HIGH_RPE` counting as measured evidence and a
comfortable one (7) not counting — the latter matters because a measured
diagnosis buys the harsher cut in `deloadPlan` (L238, three mutants); the
cooldown ending ON its date, not a day later (L275, "no re-flagging BEFORE");
and `plateauAdvice`, which was only ever tested for the rest-compression
sentence — `null` → `''`, and fatigue / programming / unknown each getting
their own advice (L423, L427, L432).

Fixture shape: nothing masked by shape.

---

## timing — 8 → 4

**Real gaps closed (4):** a gap of exactly `MAX_REST_SECONDS` counting as
rest ("longer than this is not rest", L106 `<=`); two sets stamped the same
second not reading as zero rest (L106 `> 0`) — a zero would halve a median
and fake a compression; a day marked `off` yielding no timing, and
`restTaken(null)` returning the empty reading instead of throwing (L86, two
mutants; the signature explicitly accepts null).

**Left (4) — equivalent, proven** over 2,500 generated histories (21,116
comparisons of `restTaken`, `restTrend`, `hasObservedTiming`, and the
downstream `detectPlateau` + `plateauAdvice`), with timestamps that were
missing, estimated, strings, `NaN`, `Infinity`, gaps of 0 / 0.4 s / exactly
900 s / 900.4 s, null sets, warm-ups, off days and superset groups:

- `L58` `&&` → `||` in `observedAt`: lets a `NaN`/`Infinity` stamp through,
  but the gap it produces is non-finite and fails the range check, and the
  next gap measured from it is non-finite too — so the chain breaks exactly
  where the original breaks it.
- `L55` `if (!set)` removed: unreachable. `isWorkingSet` filters null sets
  before `observedAt` ever sees one.
- `L169` `!==` → `===`: inverts every grouped flag, and "does any differ from
  the first" is invariant under inverting all of them.
- `L181` `from > 0` → `>=`: `from` is a median of gaps that are each > 0, so
  it is never 0.

Fixture shape: nothing masked by shape.

---

## analysis — 7 → 3

**Real gaps closed (4):** a session on the seventh day of a trailing week
(ages 13, 20, …) dropping out of "your recent average" (L198 `<=`); a muscle
whose weekly share rounds to 0 sets being reported "got 0 hard sets, under
the band" (L249, two mutants); and `analyse` silently dropping the athlete's
other training before the load read (L371), which removes volume-ramp
findings for a lifter whose conditioning history predates their lifting.

**MASKED BY FIXTURE SHAPE — L249 (both mutants).** The first equivalence run
(1,500 generated histories) said 0 differences. The generator gave every lift
ONE secondary muscle, and `normalizeShares` rescales a lone secondary to
100% — so no muscle could ever total less than half a set, and the
`sets <= 0` guard was unreachable *in that fixture shape*. Re-run with a
1%/99% secondary split: 312 of 1,500 differ. The value was always reachable;
the shape hid it. This is the third shape-masked finding I know of in this
queue's history (the brief puts the running total at 2 of 55 before tonight).

**Left (3) — equivalent, and provable by arithmetic** rather than only by
the driver (which also found 0 differences in 1,500 histories):

- `L154` `>` → `>=`: when the dates are equal, assigning `last = row.date`
  writes the value it already holds.
- `L311` `left > right` → `>=`: this branch runs only when one side is
  under 1 set, and the pair gate before it requires `left + right >= 20`,
  so the sides can never tie inside it.
- `L308` `max < MIN_STRONG` → `<=`: **the `MIN_STRONG = 6` gate is dead as
  configured.** `left + right >= MIN_TOTAL (20)` already forces
  `max(left, right) >= 10`, so a max of 6 can never reach it. Not a test gap —
  a gate that cannot fire. Worth a decision: either it should be larger than
  `MIN_TOTAL / 2`, or it should go.
