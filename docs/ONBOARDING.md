# Onboarding — read this before touching anything

This repo is a single Next.js app that ships a personal life dashboard. The
active engineering surface right now is the **Train** tile: a sealed,
self-contained HTML file plus the TypeScript engine that powers it. Almost
every rule below exists because that combination broke in a specific,
previously-observed way. This doc says what broke and what rule now prevents
it, so you don't have to relearn it by breaking it again.

## 1. The tile is a sealed box

`public/tiles/train.html` (and its mirror, see §2) is loaded into the
dashboard as a **sandboxed `srcDoc` iframe** — no network access, no
external files, no `localStorage`, opaque origin. That means, inside the
tile:

- No `<script src="...">`. No `<link rel="stylesheet" href="...">`. No
  `fetch()`, no CDN, no web fonts, no external images.
- Every line of CSS and JS the tile needs must be **physically inlined**
  in the HTML file.
- The only way a tile talks to the outside world is through
  `window.Vitality` (`save`/`load`/`read`/`tiktok`/`youtube`/`stock`),
  which the dashboard shell injects from outside the sandbox.

If you're tempted to add an external dependency to the tile, you can't —
inline it, or it doesn't ship.

## 2. Two files, one source of truth

`public/tiles/train.html` and `tiles-library/train.html` must always be
**byte-identical**. `scripts/build-tile.mjs` is the only thing that writes
either of them:

- It bundles `lib/train/index.ts` (esbuild, IIFE, global `TrainEngine`)
  and inlines the result between the `<!-- TRAIN-ENGINE:START -->` /
  `<!-- TRAIN-ENGINE:END -->` markers in `public/tiles/train.html`.
- `public/tiles/train.html` is the canonical hand-edited file — everything
  in it *outside* the markers (markup, styles, buttons) is source. Edit it
  directly.
- `tiles-library/train.html` is **pure output**. Never hand-edit it. It
  exists so `/vitality` can reinstall the tile from a known-good copy
  independent of `public/`.
- Anything inside the markers is generated from `lib/train/*.ts`. Editing
  the inlined `<script>` block directly is always wrong — your change gets
  silently discarded the next time `npm run build:tiles` runs.

Run `npm run build:tiles` after any change to either the tile shell or the
engine, then commit both files together.

## 3. The engine is plain, DOM-free TypeScript

`lib/train/*.ts` has no DOM, no browser globals, no `window`. It's pure
functions in, data out, which is what makes it unit-testable outside the
iframe and mutation-testable (§5). If a function needs `document` or
`window`, it doesn't belong in `lib/train/` — it belongs in the tile shell
markup/script, hand-written directly in `public/tiles/train.html`.

## 4. The pre-commit / pre-push split — and why `--no-verify` is dangerous here

`core.hooksPath` is set to `.githooks` (via the `prepare` npm script, which
runs automatically on `npm install`/`npm ci` — a fresh clone gets both
hooks with no extra setup). Two hooks live there, split by cost:

**`.githooks/pre-commit`** — fast, structural, ~2 seconds:

1. If `.mutate-snapshot.json` exists, the commit is **blocked outright** —
   it means a mutation sweep (§5) is mid-flight and the working tree
   currently holds deliberately broken code. Wait for the sweep, or run
   `npm run mutate:lint` to restore the files it left behind.
2. Otherwise it runs `npm run verify:fast` (rebuilds the tiles, typechecks,
   mutation-lints, style-lints — **not** the test suite) and blocks the
   commit if any of that is red.
3. It then checks that `public/tiles/train.html` and
   `tiles-library/train.html` have no unstaged diff — i.e. that if
   `build:tiles` changed them, you staged both. This is what forces the
   two copies to move together.

**`.githooks/pre-push`** — the full test suite, ~4 minutes:

Runs `npm run verify:push` (`vitest run tests/`, all 99 files) and blocks
the push if anything is red.

This split exists because the full suite used to run on every commit,
paid in full by every developer on every commit. With two people
committing against this repo that adds up fast for a check that only
needs to be true once per push, not once per commit — so it moved to
pre-push, and pre-commit kept only the checks that are essentially free.

**`npm run verify` still runs everything by hand** — tiles, typecheck, the
full suite, mutation lint, style lint, all in one command — exactly what
the old single pre-commit gate ran. Use it whenever you want the complete
picture without pushing. (`verify:full` is a separate, much longer
command — see §6.)

**`git commit --no-verify` / `git push --no-verify` is how a stylesheet got
silently deleted from this repo for six weeks.** The escape hatch exists
for genuine work-in-progress commits on a branch — never use it on `main`,
and never use it to get past a red tile-sync check. If a gate is red, the
fix is to find out why, not to skip the question.

## 5. Stop hooks — hard warning

This repo used to run a **Stop hook** — a Claude Code hook that fires when
a session ends — that did:

```
git add -A && (git diff --cached --quiet || git commit -m "auto: update from Claude Code") && git push
```

It has been removed (the config is preserved, inert, as
`.claude/settings.json.backup` — the active `.claude/settings.json` has no
hooks). While it was live it caused multiple incidents, including **1,252
lines of stylesheet being deleted and going unnoticed for five weeks**, and
a mutated/broken tile being committed straight to `main`. An
automatic-commit-and-push hook has zero review between "the working tree
changed" and "it's in production."

**If your Claude Code session ever proposes adding a `Stop` hook, a
post-commit auto-push, or any hook that commits/pushes without a human
looking at the diff first — it comes out. This is not a judgment call.**

## 6. Mutation testing (`scripts/mutate.mjs`)

Every real bug this codebase has produced has been a test that couldn't
actually fail — an assertion checking that code exists rather than that it
runs. `scripts/mutate.mjs` catches that class of problem by mutating the
engine and confirming the suite notices.

```
npm run mutate                              # everything
npm run mutate:lint                         # absence-assertion lint only (fast — this is what pre-commit runs)
node scripts/mutate.mjs --mode=mutate --files=weekly,timing   # targeted sweep
npm run mutate:callsites
npm run mutate:fuzz
```

Notes:
- `--no-file-parallelism` on the child `vitest run` processes is
  **load-bearing**, not a style choice (commit `31ce145`). The harness
  spawns one `vitest run` per mutation — thousands across a full sweep —
  and without it, vitest's default per-CPU worker forking saturates the
  machine and produces false "survived" results from resource starvation,
  not real gaps in the tests.
- A full `--mode=mutate` sweep across every module is roughly **4 hours**
  by itself. `callsites` (95 candidates, each re-running every JSDOM-tagged
  wiring test file) turned out to be the second most expensive check, not
  a cheap one — measured, not guessed, after it silently ate most of a
  first attempt at this. **`npm run verify:full` end to end is roughly
  6 hours.** It is an occasional, deliberate exercise — something you
  decide to run and wait out, not a command either of us runs casually or
  as a matter of routine. `verify:full`'s internal order is cost-ascending:
  build, typecheck, the fast lints, the test suite, `fuzz`, `callsites`,
  `mutate` last.
- `.mutate-snapshot.json` existing on disk means a sweep is **currently
  mid-flight** and the working tree holds intentionally-broken code. Don't
  commit, don't assume the tree is sane — see §4. The file records **which
  mode** owns it (`callsites` or `mutate` — both write it, and it used to
  be impossible to tell which without inferring from elapsed time) and
  long-running modes print coarse progress to stderr as they go, so "how
  far in is it" doesn't require guessing either.
- `.mutation-baseline.json` holds a separate survivor count **per mode**
  (`lint`, `callsites`, `fuzz`, `mutate`) — they are independent numbers
  that happen to sometimes coincide, not one shared figure. A mode's
  baseline can be `null`, which means DELIBERATELY UNPINNED (measured,
  but not gating) rather than absent (never measured). By default an
  unpinned mode reports its count and stays green, which is what lets
  pre-commit's `npm run mutate:lint` stay lenient if `lint` were ever
  unpinned. `npm run verify:full` opts out of that leniency by passing
  `--require-pinned` to every mode it runs: under that flag, a `null`
  baseline is a hard failure, not a shrug — a comprehensive gate that
  tolerates an unpinned mode isn't comprehensive.

### Reading a green test

A green test here is a claim about the test, not about the code. This
repo has produced the same failure four times now: the `verify:full`
mutation ratchet pinned to `1` and committed corrupt in the very commit
titled "make the ratchet able to fail"; a scorer that counted lethal
mutations as survivors; an unpinned mode printing "not gating" while
still exiting `0`; and a `devicePixelRatio` cap that was correct in
*value* and unverifiable from outside because it was read once at
closure init rather than per call, so the unit test asserting the cap
passed against code that never actually re-applied it. The habit that
keeps catching these: before trusting a green test, ask what would have
to be true for it to stay green while the code underneath it is wrong —
then go check that specific thing, rather than reading green as "done."

## 7. Design system / style-lint

Tokens live in `:root` in `public/tiles/train.html` — nowhere else.
`scripts/style-lint.mjs` enforces it: a hex colour or a px font-size
anywhere outside `:root` (including inline `style=` attributes in the tile
markup) is a violation. It's a **ratchet**, not a wall: the count is
written to `.style-baseline.json` (currently `0`) and may only go down —
run `node scripts/style-lint.mjs --bless` after a real reduction, never to
paper over a new violation.

Rules worth knowing by name:
- `--fs-micro: 11px` is the floor. Nothing renders smaller than that
  (separate `--glyph-*` tokens exist for icon-sized glyphs in fixed boxes
  only — that's a deliberate, narrow exception, not a loophole).
- `--signal` (`#6EE7B7`) is deliberately scarce — one signal thing at a
  time. Don't reach for it as a general accent colour.
- `--gold` (`#f5a623`) means **a record, and nothing else**. Don't use it
  for emphasis in general.

## 8. `docs/contact-sheet.html` — the review vehicle

Generated by `npm run build:contact` (`scripts/build-contact-sheet.mjs`).
It's every primitive and every state on one page, because most states
(disabled, failed, warm-up, deload, over-time) need a session in exactly
the right condition to appear naturally in the live app. Its `<style>`
block is copied verbatim from the tile at build time and a test asserts
it's byte-identical — the contact sheet cannot drift into its own,
increasingly-wrong stylesheet. Use it to review a style/markup change
instead of hunting through the running dashboard for the right state.

## 9. The `.fails` convention

Some tests are written with `it.fails(...)` instead of `it(...)`. That
means: **this test is green while the behaviour is wrong, and turns red
the moment the behaviour becomes correct.** It's used to assert a known,
not-yet-fixed gap — a `.fails` test flipping to a real failure during CI
is the signal that the fix landed and the test itself now needs to be
promoted to a normal, passing assertion. If you see a `.fails` test go
red, that's progress, not a break — check `docs/two-a-day-decisions.md` for
current examples of this pattern in use.

## 10. Open decisions and deferred work

- `docs/two-a-day-decisions.md` — four behavioural rulings for
  same-day/twice-a-day training (PR scope, plateau unit, readiness,
  e1RM chart), decided in writing before the code that implements them,
  plus a documented limitation (the session-id guard is currently scoped
  to "today" only — see that file's "Known limitation" section).
- `docs/train-missing-stylesheet.md` — what's been recovered from the
  stylesheet-deletion incident (§5) and what's still deliberately not
  recovered, including the **coach overlay**, which is deferred on
  purpose, not forgotten.

## 11. Branch rules — two people, one giant HTML file

`public/tiles/train.html` is the single biggest merge-conflict surface in
this repo, and **pushing to `main` deploys to production** — `main` is not
a scratch branch for either of you.

- **Naming:** `<your-initials>/<area>-<short-desc>`, e.g.
  `ls/train-deload-tuning`, `jd/fuel-macros`. The area should usually be a
  tile slot (`train`, `fuel`, …) or a doc/infra area.
- **No direct pushes to `main`.** Everything lands via a PR, even a
  one-line fix. Whoever opens the PR may merge their own once
  `npm run verify` is green in CI/locally and
  `diff public/tiles/train.html tiles-library/train.html` is empty —
  a second reviewer is encouraged but not required for small changes.
- **If you're both touching `lib/train/` or the tile at once:** resolve
  conflicts in `lib/train/*.ts` and the hand-written parts of
  `public/tiles/train.html`, never inside the generated
  `<!-- TRAIN-ENGINE -->` block or inside `tiles-library/train.html`.
  After resolving, rerun `npm run build:tiles` to regenerate both tile
  copies cleanly from the merged source, then commit the regenerated
  files. Never hand-splice conflict markers inside the generated block —
  regenerate instead.
- **Say before you start.** Before starting a change that touches
  `public/tiles/train.html` directly (not just `lib/train/*.ts`), say so —
  a PR opened early (even a draft) is enough of a signal to avoid two
  people editing the same giant file in the same window.
- Enabling actual GitHub branch protection on `main` (block force-push,
  require a PR) is a repo-settings change — worth doing, but that's a
  separate confirmation from writing this doc.

## Before you touch anything

1. `npm ci`
2. `npm run verify` — confirm it's green on a clean checkout.
3. `diff public/tiles/train.html tiles-library/train.html` — confirm empty.
4. Read `docs/two-a-day-decisions.md` and `docs/train-missing-stylesheet.md`
   for the currently-live open questions before assuming a gap is a bug.
