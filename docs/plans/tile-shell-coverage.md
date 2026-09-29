# Covering the tile shell

The hand-written part of `public/tiles/train.html` — everything outside the
`TRAIN-ENGINE` markers — has no mutation coverage. The harness sweeps
`lib/train` only, and `callsites` mode checks that each `TrainEngine.x(`
call is *reached*, not that the logic around it is right. Two real crashes
lived there undetected by 2,483 passing tests (`acef229`):

- `doLog` passed bare `kg`/`reps` to the PR celebration — identifiers never
  declared in that scope. `ReferenceError` on any set that beat a prior e1RM
  and finished the exercise.
- `rollupFor` read `top.kg` when `top` is null — every logged set that day a
  warm-up. `TypeError`.

This is a plan, written from reading and a few measurements. Nothing here
edits the tile or the harness.

## The first finding: mutation testing is not what would have caught them

Both bugs are code that **no test ever executed**. Mutation testing asks
"when this code changes, does a test notice?" — which presupposes a test
runs it. The direct tools for "never ran" and "cannot run" are cheaper and
should come first:

1. **An undeclared-identifier lint — measured, catches bug 1.** ESLint's
   `no-undef` on the extracted shell script (browser env, one declared
   global: `TrainEngine`) was run against the shell as it stood *before*
   `acef229`: exactly 2 findings — `'kg' is not defined` and
   `'reps' is not defined`, at the crash site — and 0 on today's main. No
   other false positives. Seconds to run. It cannot see bug 2.
2. **Line/branch coverage of the shell under the JSDOM tests — would catch
   bug 2's *path* being unexercised.** Not yet working: a first attempt with
   `NODE_V8_COVERAGE` on one wiring test recorded no tile functions at all,
   most likely because vitest's worker exits without flushing V8 coverage.
   Two ways to make it real, both test-side only: `@vitest/coverage-v8`
   (handles workers; new dev dependency), or instrumenting the extracted
   shell with istanbul before the test boots it (no dependency on V8
   plumbing, but a second copy of the script in play). Open question which.
3. **Mutation testing, for the logic that coverage says IS executed** — the
   question coverage cannot answer: "it ran, but would anyone notice if it
   were wrong?"

## What is mutable

The harness's own operators (`mutationsFor` from `scripts/mutate.mjs`), run
over the shell script extracted from `train.html` on main:

| operator | mutants |
| --- | --- |
| `and-to-or` | 177 |
| `or-to-and` | 159 |
| `true-to-false` | 52 |
| `eq-to-neq` | 32 |
| `neq-to-eq` | 8 |
| `gt-to-gte` | 6 |
| `lt-to-lte` | 4 |
| `gte-to-gt` | 3 |
| `guard-removed` | 3 |
| **total** | **444** |

Shape of the shell: ~4,900 lines after the engine block, 375 functions,
138 `TrainEngine.x(` call sites. It is UI code, so the mutants skew heavily
toward `&&`/`||` (76%) — a lot of which will be `el && el.classList…`-style
null guards and `a || default` fallbacks. Expect a much higher equivalent
rate than in the engine: many guards protect against a DOM node that the
tests always render. Budget for reading, not just running.

## What a "scope" means when it is one file

For an engine module, scope is "test files that import it" (`testsFor`).
The shell has one file and 32 tests that boot it, so the naive scope is
all 32 for every mutant.

- **Naive:** one pass of all 32 JSDOM files takes **69 s** (measured; 387
  tests; files run serially, which `vitest.config.ts` requires). 444 × 69 s
  ≈ **8.5 hours** per full sweep, before re-runs.
- **Per-function scope:** map each shell function to the test files that
  execute it — which is exactly what (2) above produces as a by-product —
  and run only those per mutant. If a typical function is reached by a
  handful of files, a sweep drops to roughly 1.5–3 hours. That estimate is
  a guess until the coverage map exists.
- **Survivor = not killed by the files that reach it.** A mutant in a
  function no test reaches is not a survivor, it is uncovered code — report
  it under (2), not as a mutation result, or the count is meaningless.

## How big is the job

In order, each step useful on its own:

1. **`no-undef` lint as a gate** — small. Extract the script (the style-lint
   and build scripts already split the file), run ESLint with a short globals
   list, add it to `verify:fast`. Ratchet at 0. Hours, not days.
2. **Shell coverage** — medium. Choose the mechanism, get the tile's
   functions into a coverage report, list never-executed functions and
   branches. The list itself is the deliverable: it names every place like
   `rollupFor`'s all-warm-up day. A day or two, most of it the plumbing.
3. **Harness support for the shell** — medium, and it edits the tool, so it
   belongs in a session where results are not confounded (the speed work
   already queued is the same kind of change). Needs: a `shell` mode that
   extracts the script, mutates it in the tile file inside the snapshot the
   harness already takes of both tiles, and uses the coverage map for scope.
4. **The first sweep and reading its survivors** — large. 444 mutants, a high
   expected equivalent rate, each survivor read and either tested or written
   up. By tonight's rate on the engine (~52 real gaps and ~34 equivalents
   read in one night across 87 survivors), a first pass is several nights.

Constraint throughout: the shell is Leon's working area. Everything above is
test-side or tool-side until it is time to fix what it finds.
