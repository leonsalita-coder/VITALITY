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
npm run verify          # the commit gate: build, typecheck, tests, lint, callsites
npm run mutate          # everything, including the slow modes
npm run mutate:lint     # absence assertions without a positive control (seconds)
npm run mutate:callsites# guards that assert existence rather than reachability
npm run mutate:fuzz     # every date test, 5 times of day × 4 timezones
```

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
