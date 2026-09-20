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
more". That is why the sentence it prints names what the log could
resolve instead of saying "the same" and stopping.

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
