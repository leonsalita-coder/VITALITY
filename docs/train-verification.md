# Train — why green tests are not sufficient

Across the whole of this engine's development, **not one failure has been a
bug the tests caught late.** Every single one has been a test that could not
have failed:

| What shipped | Why the suite missed it |
| --- | --- |
| `kind: e.kind` read a field that never existed | the guard asserted the code existed, not that it ran |
| Four engine modules missing from the barrel | every `TrainEngine.x` call was `undefined` at runtime; type-checked and grepped clean |
| The coach's `showApply` path never wired | nothing drove the call site |
| `analysis.ts` unreachable from the tile | same |
| Seven of fourteen weekly-change gates | each gate was masked by another firing first |
| A DST boundary test | written at noon, where an hour of drift has twelve hours of slack |
| Eleven "verified" guards | the harness resolved **zero test files** and reported zero failures |

The last one is the reason this document exists. A verification tool that
fails open is worse than the bugs it hunts, because everything downstream of
it is believed.

## The tool

```
npm run verify       # every commit: build, typecheck, tests, lint   (~1 min)
npm run verify:full  # pre-push: adds callsites, fuzz, mutate        (~30 min)
npm run mutate       # all four modes directly
npm run mutate:lint  # absence assertions with no positive control   (seconds)
```

The commit gate is deliberately the fast subset. A gate slow enough to be
skipped is a gate that is skipped.

## The ratchet, and the numbers it holds

The first run found real debt, so the gate fails on a number getting WORSE
rather than on the debt existing — a gate that is red on day one gets
switched off within a week and then protects nothing.
`.mutation-baseline.json` holds the counts:

| mode | caught | survivors |
| --- | --- | --- |
| `mutate` | 123/192 (64%) | **69** across 29 modules |
| `callsites` | 55/75 (73%) | **20** unguarded call sites |
| `fuzz` | 20/20 | **0** |
| `lint` | — | **69** absence assertions |

These are meant to fall. Lower one with `--bless`; raising one has to be
deliberate and visible in the diff.

Exit codes: `0` clean, `1` survivors, **`2` harness failure** — deliberately
distinct, because "the tool broke" must never read as "nothing survived".

## What each mode encodes

**`mutate`** — flips operators and removes guards in `lib/train/*.ts`, then
runs the tests that import that module. A survivor is a change to the engine
that its own tests did not notice.

**`callsites`** — replaces each `TrainEngine.x(` call in the tile with a stub
returning `undefined`, and checks something goes red. A guard satisfiable by
code merely *existing* is asserting existence, not reachability. This is the
class that produced four of the seven rows above.

**`fuzz`** — runs every date-touching test at 00:30, 01:30, 06:30, 12:30 and
23:30, across New York, London, Sydney and UTC. A date test written at one
time of day, in one zone, is a test written where it cannot fail.

**`lint`** — flags absence assertions (`toEqual([])`, `toBeNull()`) made
against a fixture the test **built itself**, with no paired assertion proving
the fixture loaded. Silence against an empty fixture is indistinguishable
from silence against a real one.

It deliberately does *not* flag `expect(frequencyGaps({}, INDEX, NOW))
.toEqual([])`, where the input is an inline literal and self-evidently
present. An earlier version did, produced 179 findings, and was unactionable
— a lint nobody acts on is the same failure as a guard nobody can falsify.

## Rules the harness itself obeys

- **It asserts it ran.** Every result is checked against the expected file
  and test counts before it is believed. Zero tests is a harness failure,
  never a pass.
- **A collapsed run after a good baseline is a KILL, not a failure.** If the
  identical invocation worked moments earlier, a mutation that breaks
  collection outright has been caught emphatically.
- **A timeout is a kill.** A mutation that stops the code terminating is a
  behaviour change the suite noticed in the strongest way available.
- **It restores from a file snapshot, never `git checkout`.** A snapshot
  taken from HEAD is not a snapshot of what you were editing; that discarded
  uncommitted work in six files once already.

## A heuristic that has paid for itself three times

**A defensive check written near an existing one should immediately be
asked whether either can fire alone.**

Three times now, a pair of guards has turned out to be mutually masking —
each catching exactly what the other would, so that removing either left
the other covering and neither could be shown to matter:

| Where | The pair |
| --- | --- |
| `sets.ts` | a `sidesOf` check inside `isPerSide`, when `workingVolume` already returned before reaching it |
| `staleness.ts` | `!def` and `!candidates.length`, both catching the unknown-lift case |
| `fitting.ts` | a per-step range filter and a range check on the resulting median |

In all three the resolution was the same: **delete one.** The median of
values already inside a range is always inside it; `rankSwaps` returns
nothing for a null lift; `workingVolume` never reaches `isPerSide` for a
per-limb set. A second guard that cannot fire is not defence in depth, it
is a comment that looks like code — and worse, it reads as protection to
the next person, who then does not add the check that would have worked.

Mutation testing finds these, but the cheaper moment to catch one is while
writing it.

## Reading a survivor

A survivor is not automatically a bug. It is a change nothing objected to,
which means one of three things, in descending order of how often it is true
here:

1. The test asserts the shape of an answer rather than the answer.
2. The guard is genuinely unreachable and should be **deleted** — four have
   been, across this engine, rather than propped up with a test written to
   fit them.
3. The mutation is behaviour-preserving and the operator is too blunt.

Judge which before writing a test. A test written purely to kill a mutant is
how a mutation score becomes a number people stop reading.

## Constants that survived, and what they were measured against

Two findings — minimum effective dose and transfer between lifts — replace
a guessed effect size with a null resampled from the athlete's own history.
That removes the threshold but not every number: something still has to
decide **how** to resample, and picking those badly is the failure the
design exists to avoid. So they were measured rather than argued.

The method: simulate histories where the truth is known, and count how
often each finding gets it wrong. `tests/train/calibration.test.ts` keeps
the headline of each executable, so a change to the resampling cannot
quietly stop being justified.

### `TRANSFER_BLOCK_WEEKS = 8`

How often does transfer fire on two **independent** autocorrelated series?
It should be 5%, the margin.

| autocorrelation | block 1 | block 4 | block 6 | block 8 |
|---|---|---|---|---|
| phi 0.60 | 20.8% | 5.8% | 5.0% | 5.0% |
| phi 0.75 | 25.0% | 9.2% | 6.7% | 5.0% |
| phi 0.85 | 33.3% | 15.0% | 7.5% | 6.7% |

Block 1 is naive shuffling, and it fires on a third of unrelated pairs —
the number that justifies the whole design. Block 4, which a "training
block is about a month" argument gives, is still two to three times
nominal: four weeks is roughly the length of the autocorrelation itself,
so most of the structure is destroyed at the block boundaries anyway.

Checked again at the sample sizes it actually runs at, since a gate should
be calibrated where it is weakest (phi 0.85, 160 draws each):

| overlap | 33w | 41w | 49w | 57w | 65w | 73w |
|---|---|---|---|---|---|---|
| block 4 | 7.5% | 8.8% | 11.3% | 11.3% | 10.0% | 11.3% |
| block 8 | 3.1% | 3.8% | 1.3% | 3.8% | 4.4% | 4.4% |

### `DOSE_BLOCK_WEEKS = 4`

Deliberately **not** the eight transfer measured its way to, because this
finding's error runs the other way: it claims the ABSENCE of a
relationship, so a tight null makes it fire *less*. How often does it
claim equivalence when the high-volume weeks genuinely progressed faster?

| true ratio | block 2 | block 4 | block 6 | block 8 |
|---|---|---|---|---|
| 1.0x (equal) | 90% | 95% | 93% | 94% |
| 1.5x | 29% | 43% | 46% | 65% |
| 2.0x | 0% | 3% | 3% | 8% |

The first row should be high and the rest low. Bigger blocks are strictly
worse. Two is better still, but a two-week block keeps almost none of the
structure this is there to preserve, so it would be right by accident.

### `POWER_MARGIN = 3`

The null band must be narrower than the athlete's weekly progression rate
divided by this before equivalence may be claimed. It was 1 — "the test
could have seen a difference the size of your whole progression rate" —
and 1 is far too loose:

| true ratio | /1 | /2 | /3 | /4 |
|---|---|---|---|---|
| 1.0x, 40w | 84% | 26% | 6% | 0% |
| 1.0x, 80w | 95% | 75% | 24% | 5% |
| 1.0x, 120w | 96% | 93% | 55% | 11% |
| 1.5x, 40w | 71% | 38% | 8% | 0% |
| 1.5x, 80w | 43% | 40% | 19% | 8% |
| 1.5x, 120w | 28% | 28% | 18% | 6% |
| 2.0x, 80w | 3% | 3% | 3% | 0% |

At /1 this tells somebody their volume made no difference on nearly half
the histories where it made a 50% difference. /4 silences it almost
entirely.

**And a limit worth stating plainly: at a true ratio of 1.25x the rates
are indistinguishable from the equal case at every sample size a real
person will produce.** This finding cannot tell "the same" from "a quarter
more".

That limit is why **the dose verdict is never surfaced at all**, rather
than surfaced with its bound attached. The bounded sentence — "the same,
to within the 0.03% a week your log can resolve" — is a caveat, and a
caveat is exactly what readers discount: people take the headline, and
this headline invites cutting a third of their training. A verdict whose
correctness depends on the reader honouring a qualifier is not one worth
shipping.

So `minimum_effective_dose` is off `SURFACEABLE` in `lib/train/shadow.ts`.
That is stronger than a flag defaulting to false: flipping the flag does
nothing. The verdict is still computed and still logged, so the shadow log
can answer later whether the band ever narrows — putting it back is a
deliberate decision made on that evidence.

What dose reports instead is **resolution**: what its log can and cannot
tell apart, and how much more history would close the gap. True, useful,
and unactionable in the dangerous direction. See `doseResolutions`.

### `BAND_EXPONENT = 0.42`

How fast the resolution band narrows, and the basis for "roughly N more
weeks". **Not** the inverse square root a textbook would assume — fitted
across simulated histories, the exponent is -0.417, because
autocorrelation makes effective sample size grow more slowly than the
calendar does:

| weeks | 39 | 59 | 79 | 119 | 159 | 239 |
|---|---|---|---|---|---|---|
| band | 2.2e-3 | 1.8e-3 | 1.6e-3 | 1.4e-3 | 1.3e-3 | 1.0e-3 |

It matters which is used: inverse-square-root understates the wait, which
tells somebody an answer is closer than it is.

### `RESOLUTION_TARGET = 4`

The projection is quoted against a difference of a quarter of the
athlete's own progression rate, because that is precisely the difference
the table above identified as invisible. It is a reference, not a
judgement — "here is what it would take to resolve a difference this
small" is a fact about statistical power, where "a difference this small
matters" would be a normative claim about a stranger's training.

### `MIN_OVERLAP_WEEKS = 32`, `MIN_TRAINED_WEEKS = 32`

Eight blocks of four for dose, four blocks of eight for transfer. The
floor on a permutation p is one over the number of arrangements, so four
blocks gives 1/24 ≈ 0.042 — the minimum at which a result below a 0.05
margin can exist at all.

### Still unmeasured

`DEFAULT_MARGIN = 0.05` is convention, not physiology, and is the one
number here chosen by taste. It is defensible as a starting point because
it is a stated, checkable rule rather than a guessed effect size — and
because shadow mode means the first year of real verdicts can be read back
and this moved against evidence.

`MAX_LOG_ENTRIES = 1000` is about fifteen months of weekly verdicts across
both features. That is also when the log starts dropping its oldest rows,
so **exporting it is part of the tuning workflow**, not an afterthought.

## Guards deleted because nothing could make them fail

Mutation testing found five this round, on top of the three already listed
above. Two are worth recording because the reasoning generalises:

- **`z > 0` in transfer.** Guarded against reporting an unusually WEAK
  co-movement as a finding, since the margin is two-sided. It could never
  fire: measured over 400 simulated athletes — 200 with the lifts
  deliberately mirrored — `outside` and a negative z co-occurred exactly
  zero times. Not an accident of the fixtures: the statistic is a MAXIMUM
  across lags, and the null of a maximum is right-skewed with almost no
  lower tail, so a real value essentially cannot sit far enough below it.
  The two-sidedness is conservative rather than wrong.

- **`overall > 0` in dose.** Subsumed by the power gate beside it:
  `detectable` is a half-width and never negative, so `detectable <
  overall / POWER_MARGIN` is already false whenever progression is zero or
  negative.

The pattern is the one in the table above — a defensive check written near
an existing one should immediately be asked whether either can fire alone.

## What "equivalent" meant, per module

A surviving mutation gets one of three verdicts: killed by a new test, deleted
as unreachable, or **left as equivalent**. That third verdict is a claim, and
it is only ever as good as the inputs it was checked against.

The method is a probe grid: capture every output across a spread of inputs,
apply the mutation at the byte offset the sweep recorded, and compare. Identical
output means equivalent — *over the dimensions the grid varies*. It says nothing
about a dimension the grid never touches.

That is not hypothetical. The first analysis grid agreed with **23 of 30**
mutants. Widening it to include sessions marked `off`, warm-up-only sessions,
forward-dated entries and exercises missing from the index took that to 15, and
three of those newly-caught mutants were real bugs — including one I had already
written off as dead code. The grid was the thing that was wrong, and a grid that
is wrong is indistinguishable from a module that is clean.

So each module's equivalence claims carry their scope. **Absent dimensions are
not a to-do list** — they are the boundary of what was actually checked.

**plates.** Seven configurations — the default rack; a rack with no 2.5s; a
barless setup; an empty plate list; a list containing zero; a list containing a
negative; a 20kg-style bar with 1.25 pairs — crossed with every target from 0 to
400 lb in 1.25 lb steps, through `snapToLoadable`, `plateBreakdown` and
`loadableWeights`. *Never varied:* `maxLb` beyond its default, non-finite or NaN
targets, duplicate denominations in one list, denominations other than the
standard imperial and metric sets, or a bar heavier than the targets asked for.
The seven survivors' equivalence is claimed only within that.

**catalog.** No probe grid at all, and none was needed: the survivors were
authored booleans, the replacement was invariant tests over the whole table, and
all eight mutations are killed. **No equivalence claims are outstanding here** —
nothing was left standing to justify.

**progression.** No probe grid either. That pass was driven by hand-written
fixtures naming a user consequence per survivor, which is a different and
weaker instrument: it proves the cases someone thought of. One survivor remains,
at `progression.ts` around the `previous > 0` guard, and its equivalence rests
on **reading the code, not on measurement** — the argument being that `previous`
is zero only when there is no earlier session and a negative count of reps,
seconds or metres is unreachable. That argument is sound but it has never been
executed against a grid, which makes it the weakest equivalence claim in the
engine.

**analysis.** Final grid: gap lengths 0–40 days; per-muscle set counts 0–30
across one, two and three muscle shapes; a five-session trailing history with a
deliberately odd final week; every quads/hamstrings pair from 0–24 against
0/1/5/6/10/20 with the sides swapped; ratio windows at 0, 27, 28 and 29 days;
colliding and out-of-order dates; sessions marked `off`; warm-up-only sessions;
forward-dated sessions; empty history; an exercise absent from the index; an
exercise whose muscles are unrecognised; and all four training ages including
none — through `analyse`, `weeklySets`, `frequencyGaps`, `ratios` and
`volumeRamp`. *Never varied:* `otherTraining` entries (so the systemic-load path
is exercised only at its default), exercises with secondary muscles at the ratio
boundaries, histories longer than about five sessions per lift, or any date
range past 40 days.

**weekly.** The grid had to be widened three times before it was worth
trusting, and each widening found real bugs. Final shape: all six hypotheses
driven to fire, plus the confounded-change path; outcome and driver moves
above, below and exactly on each hypothesis's own thresholds; sleep and
recovery series with the driver window shifted by its lag; rest derived from
real `at` timestamps on sets; AMRAP reps around the ten-rep e1RM cap; bodyweight
and other-training series; finished-session counts 0–3; deload, layoff and
imported confounds alone and together; entries marked `off`, warm-up-only,
failed, zero-rep and over-cap; malformed rows — a non-numeric bodyweight, a null
slot, a reading outside the window; NaN and Infinity in vitals; and a missing
context entirely. *Never varied:* more than one exercise id at a time, supersets,
per-side logging, assisted sets, weeks containing both a deload and a layoff
with a hypothesis also firing, or any window length other than the shipped 7
and 28 days.

The three widenings, because the pattern is the lesson. **First:** two of the six
hypotheses never fired at all — `recovery_e1rm` because the fixture used one
weight for both the week and the baseline so e1RM never moved, and
`rest_compression_reps` because rest is derived from timestamps and the fixture
set a `rest` field that nothing reads. A grid that cannot make a finding fire
proves nothing about the gates guarding it. **Second:** no context was ever
missing, so every "reaches through an absent list" mutant read as equivalent.
**Third:** sample counts were never *asymmetric* — every fixture had a fat
baseline and a two-session week, so a gate checking only one end passed all of
them. That last one hid a real defect: a returning athlete with one baseline
session would have had a change reported against a single observation.

**load.** The grid was built to answer one question first: can every reading
actually speak? Each of ten outputs was checked as firing at least once before
any gate on it was trusted — findings above and below the band, systemic notes
above and below, the estimated caveat, usable and unusable muscle readings, and
the estimated systemic flag. Dimensions varied: steady blocks read on all seven
weekdays with training continuing through each; recent-week volumes from 0 to 30
sets against baselines of 3–24; chronic baselines of 1–12 weeks and 1–7 sessions
a week; layoffs of 2, 4, 8, 10, 16 and 26 weeks; other-training from none to
forty days at two hours; two muscles at once; and malformed rows — null, no
date, marked `off`, dated in the future, dated 900 days back, a null other-
training entry and an undated one. Band edges were found by search rather than
by hand, because an EWMA ratio cannot be dialled to a round number: fixtures
landing on exactly 0.80 and exactly 1.50 are in the suite. *Never varied:*
supersets, per-side logging, assisted sets, more than two muscles, an index
missing the lift entirely, `now` at a DST boundary, or histories longer than
about 200 days.

Two blind spots in the FIRST load grid, both caught before they were trusted.
Its "read on each weekday" cases shifted the whole block backwards, which means
the athlete stopped training — so the falling ratio at the later offsets was
real, not a weekday artefact, and the fixture was measuring something other than
the property it was named for. And it never placed a session on the oldest day
inside the window, which is the only place the trailing-week mutant is visible
at all.

**series.** Charts, and the one module where the rule is to assert the DATA
rather than the geometry: a test pinning an SVG path is brittle and says nothing
about whether the figures are right. Dimensions varied: reps 0–20 spanning the
e1RM cap, weights 0–225, 0–3 sets a session, warm-up-only and `off` sessions,
sessions in either chronological order and on the same date, per-muscle counts
0–26 across both band edges, window ages −1 to 30 days, lifts absent from the
index and lifts whose muscles are unrecognised, rolling views of 1–26 weeks with
duplicate and consecutive dates, and period windows probed on every boundary day
of a 1-, 4- and 8-week block. *Never varied:* supersets, per-side logging,
assisted sets, more than two lifts at once, `now` at a DST boundary, or
session-level metadata beyond `off` and `warmup`.

One blind spot, and it hid the last live defect in the module: every fixture
built a session from IDENTICAL sets, so "the heaviest set" and "the last set"
were always the same number and the comparison choosing between them was never
exercised. A real session ramps and often ends on a back-off set.

**A second way to be wrong, separate from the grid.** Twice I "confirmed" a
survivor was real by hand-editing the source, and once that meant replacing both
`||` operators on a line the sweep mutates one of. With the correct single
operator the mutation is genuinely equivalent. Apply mutations at the offset the
sweep recorded, never by search-and-replace on the text.
