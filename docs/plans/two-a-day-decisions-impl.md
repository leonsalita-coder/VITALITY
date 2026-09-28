# Implementing the four two-a-day decisions

The decisions themselves are already made and recorded in
`docs/two-a-day-decisions.md`. This is the implementation plan for the four
`.fails` assertions in `tests/train/two-a-day.test.ts` under
`describe('decisions nobody has made yet')` — what to change, where, what
proves it, and what could break.

Shared context: the underlying data-loss bug (`rollupFor` dropping same-day
rows) is **already fixed** — history rows now carry a `sessionId`, and a
two-a-day correctly produces two rows. That fix is what the other tests in
this file (`'keeps BOTH sessions, each on its own row'` etc.) already assert
green. These four decisions are about how *readers* of that now-correct
history should behave, not about the storage layer again.

---

## 1. PR scope — chronological, not day-scoped

**Test to flip:** `'CHOICE: may the evening set a PR against the morning of
the same day?'`

**Current behavior.** `lib/train/records.ts:227-228`:
```ts
const today = dateKey(now)
const base: BestOptions = { excludeDate: today }
```
Every baseline lookup inside `classifyPR` (`bestE1RM`, `bestWorkingWeight`,
etc., all gated through `eligible()` at `records.ts:70-74`) excludes **the
whole of today**, not just the in-progress session. The comment at
`BestOptions.excludeDate` (`records.ts:62`) says why: *"Today never competes
with itself"* — the ORIGINAL reason for excluding today was to stop a
still-being-logged session from retroactively comparing itself against its
own not-yet-complete sets, not to hide an already-finished earlier session
on the same date. With two-a-days now real, date-scoped exclusion throws
away a genuinely separate, completed session.

**The fix.** Don't remove the exclusion — narrow it from *date* to
*session*, the same unit `rollupFor` already uses:

1. `lib/train/records.ts:61-66` — add a new field to `BestOptions`:
   ```ts
   export interface BestOptions {
     excludeDate?: string
     sinceDate?: string
     /** The session currently being logged — excluded from its own baseline. */
     excludeSessionId?: string
   }
   ```
   Additive, not a replacement — `excludeDate` keeps its current meaning for
   every other caller of `bestE1RM`/`bestWorkingWeight`/etc. Only `classifyPR`
   switches to the new field.

2. `lib/train/records.ts:70-74` (`eligible`) — check both:
   ```ts
   function eligible(entry: HistoryEntry, opts: BestOptions): boolean {
     if (opts.excludeSessionId && entry.sessionId === opts.excludeSessionId) return false
     if (opts.excludeDate && entry.date === opts.excludeDate) return false
     if (opts.sinceDate && entry.date < opts.sinceDate) return false
     return true
   }
   ```

3. `lib/train/records.ts:220-228` (`classifyPR`) — add a parameter and use
   it instead of `excludeDate`:
   ```ts
   export function classifyPR(
     history: HistoryEntry[],
     candidate: PRCandidate,
     now: number,
     currentSessionId?: string,
   ): PRResult {
     if (!isWorkingSet(candidate)) return NO_PR
     const base: BestOptions = { excludeSessionId: currentSessionId }
     ...
   ```
   `today`/`dateKey(now)` drops out of this function entirely unless
   something else here still needs it — check the rest of the function body
   (lines 229-260+) before deleting the `dateKey` import.

4. `public/tiles/train.html:7183` — the one call site:
   ```js
   return TrainEngine.classifyPR(histFor(e).filter(x=>!x.off), prCandidateFor(e, idx), Date.now());
   ```
   becomes
   ```js
   return TrainEngine.classifyPR(histFor(e).filter(x=>!x.off), prCandidateFor(e, idx), Date.now(), curSession().id);
   ```

**What could break that currently passes.**
- Any `HistoryEntry` fixture built **without** a `sessionId` (older rows,
  or hand-built test fixtures that predate the migration) will never match
  `excludeSessionId` — `entry.sessionId === undefined` is never `===` a real
  session id, so such rows are never excluded. This is almost certainly the
  *wanted* behavior for genuinely old, migrated rows (they're a different,
  already-finished day's data by construction), but it's worth stating
  explicitly rather than discovering it as a surprise.
- `tests/train/records.test.ts:79` is the only existing use of
  `excludeDate` in that file, and it's against `bestE1RM` directly, not
  `classifyPR` — unaffected, since `bestE1RM`'s own `BestOptions` contract
  doesn't change.
- Anything that calls `classifyPR` and currently relies on "today" being
  excluded wholesale (a single-session day behaves identically either way,
  since a lone session's `sessionId` only ever matches its own rows — so
  the common case shouldn't shift). Worth a full run of
  `tests/train/records.test.ts` and `tests/train/records-wiring.test.ts` (if
  it exists) to confirm before this ships, since PR-firing logic is exactly
  the kind of thing a silent behavior change would be easy to miss.

**Before starting:** none — this one doesn't hinge on an undecided call.

---

## 2. Plateau unit — days, not sessions

**Test to flip:** `'CHOICE: is a plateau three SESSIONS or three DAYS?'`

**Current behavior.** `lib/train/deload.ts:186-190`:
```ts
const usable = (history || []).filter(
  (entry) => entry && !entry.off && !isExcluded(entry.date, opts.excluded),
)
if (usable.length < PLATEAU_WINDOW + 1) return null
const recent = usable.slice(-PLATEAU_WINDOW)
```
This slices the last `PLATEAU_WINDOW` (3) **rows**, with no notion of which
calendar day each row falls on. Two sessions in one day count as two of the
three.

**The fix.** Group by date before slicing, take one representative entry
per day. The decision doc's own stated rule — *"the day is the unit for
presentation... where a reader wants one number per day it derives one"** —
and the e1RM chart decision below both resolve the same way: the day's
**best** `entryScore` represents that day. Reuse that shape here for
consistency rather than inventing a second rule for "best" per day.

1. `lib/train/deload.ts:186-190` — after building `usable`, collapse by
   date before slicing:
   ```ts
   const usable = (history || []).filter(
     (entry) => entry && !entry.off && !isExcluded(entry.date, opts.excluded),
   )
   const byDay = new Map<string, HistoryEntry>()
   for (const entry of usable) {
     const existing = byDay.get(entry.date)
     if (!existing || entryScore(entry, opts).primary > entryScore(existing, opts).primary) {
       byDay.set(entry.date, entry)
     }
   }
   const days = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date))
   if (days.length < PLATEAU_WINDOW + 1) return null
   const recent = days.slice(-PLATEAU_WINDOW)
   ```
   This calls `entryScore` twice per entry in the grouping pass (once to
   compare, once later at line 199 for the real `scores` computation) —
   cheap given a day's history is small, but worth a comment noting it's
   deliberate, not an oversight, so nobody "optimizes" it into calling
   `entryScore` on the WRONG day's representative entry.

**What could break that currently passes.** Checked
`tests/train/deload.test.ts` — every existing fixture (`session('2026-08-20',
...)` etc.) uses one row per distinct date, weekly-spaced. Day-grouping a
history with no same-day duplicates is a no-op, so none of the existing
plateau tests should change behavior. The risk is narrower: any test that
constructs `PLATEAU_WINDOW`-or-fewer **rows** spanning fewer than
`PLATEAU_WINDOW`-worth of **distinct days** would now need MORE rows (or
different dates) to still trigger a plateau — worth a full run of
`tests/train/deload.test.ts` and `tests/train/deload-walk.test.ts` before
this ships.

**Before starting:** none — "day's best" is already the established
resolution rule for this exact class of problem (see the e1RM chart
decision), so this isn't inventing a new choice, just applying the existing
one here too.

---

## 3. Readiness — the evening sees the morning's load

**Test to flip:** `'CHOICE: does readiness see the morning before advising
the evening?'`

**This one looks like it may already be true — a decision that doesn't need
implementing, only confirming.** Traced the actual read path:

- `assessReadiness`'s `recentHardSets` input comes from
  `public/tiles/train.html:6900-6918` (`weeklyHardSets` /
  `baselineHardSets`), which sums `TrainEngine.workingSets(entry).length`
  over **every row** in `STATE.history[id]` whose date falls in the target
  week — a flat sum over rows, with no per-session or per-day
  deduplication at all.
- Since `rollupFor`'s session-id fix already ensures a two-a-day produces
  **two rows** in history (not one, overwritten), `weeklyHardSets(0)`
  already sums both the morning's and evening's working sets for "this
  week" with **zero further code change** — it was never date-scoped or
  session-scoped to begin with, just a straight sum over whatever rows
  exist for the window.
- Same shape in `lib/train/metrics.ts`'s `hard_sets` metric
  (`entriesOn` + `hardSets` reduce, `metrics.ts:114-116`): it sums
  `workingSets(entry).length` over every entry matching `ctx.date`, again
  with no per-entry deduplication. Two same-date rows already sum
  correctly there too.

**The test as currently written doesn't prove this either way — I think it
has a fixture bug.** It's in `tests/train/two-a-day.test.ts`, inside
`describe('decisions nobody has made yet')`, where `morning = sess(DAY, 3,
225)` and `evening = sess(DAY, 3, 245)` are both defined at the top of the
block. The readiness test only passes `history: { squat: [morning] }` — a
single 3-set row — and asserts `hard_sets` equals **6**. With only
`morning` in history, the correct value is 3, not 6; 6 is exactly
`morning.sets.length + evening.sets.length` (3 + 3). This reads like the
fixture should be `history: { squat: [morning, evening] }` and the `[morning]`
is a copy/paste leftover from a nearby test.

**Before starting — this is the question to ask:** is the fixture a bug
(should include both sessions), in which case fixing the test to pass both
sessions and un-marking `.fails` should turn it green **today, with no
production code change**, since the summing logic already handles it? Or is
there a different, not-yet-articulated readiness behavior this test was
actually meant to probe (something about the *verdict*, not just the raw
`hard_sets` metric) that the current assertion doesn't capture? I'd rather
flag this than quietly "fix" the fixture and claim the decision is
implemented when I might be missing what it was actually meant to test.

**What could break that currently passes.** If the fixture is simply
corrected to `[morning, evening]`, nothing else changes — no production
code moves. If it turns out real code changes ARE needed here after
clarifying the above, re-evaluate against `tests/train/readiness.test.ts`
and `tests/train/readiness-wiring.test.ts` before touching
`assessReadiness` itself, since that function's own logic (§`lib/train/readiness.ts`)
is unrelated to this — the gap, if there is one, would live in the
tile-side context builder, not the engine.

---

## 4. e1RM chart — the day's best, one point per day

**Test to flip:** `'CHOICE: does the e1RM chart plot one point a day or one
a session?'`

**Current behavior.** `lib/train/series.ts:51-64` (`e1rmSeries`):
```ts
export function e1rmSeries(entries: HistoryEntry[]): Point[] {
  const points: Point[] = []
  for (const entry of readableEntries(entries)) {
    let best = 0
    for (const set of workingSets(entry)) {
      const value = epley1RM(setWeight(entry, set), set.r || 0)
      if (value != null && value > best) best = value
    }
    if (best > 0) points.push({ date: entry.date, value: Math.round(best * 10) / 10 })
  }
  return points.sort((a, b) => a.date.localeCompare(b.date))
}
```
One point per **entry**. Two same-date entries produce two points at the
same x.

**The fix.** Collapse to one point per date, keeping the higher of the two
if there's a tie on date:
```ts
export function e1rmSeries(entries: HistoryEntry[]): Point[] {
  const byDate = new Map<string, number>()
  for (const entry of readableEntries(entries)) {
    let best = 0
    for (const set of workingSets(entry)) {
      const value = epley1RM(setWeight(entry, set), set.r || 0)
      if (value != null && value > best) best = value
    }
    if (best > 0) {
      const existing = byDate.get(entry.date) ?? 0
      byDate.set(entry.date, Math.max(existing, best))
    }
  }
  return [...byDate.entries()]
    .map(([date, value]) => ({ date, value: Math.round(value * 10) / 10 }))
    .sort((a, b) => a.date.localeCompare(b.date))
}
```

**What could break that currently passes.** Checked
`tests/train/series.test.ts` — every `e1rmSeries` fixture in that file uses
distinct dates (built through an `ago(n)`/date-offset helper); none
construct two same-date entries expecting two separate points. Grouping by
date should be a no-op against every existing assertion in that file. Worth
a full run of `tests/train/series.test.ts` and `tests/train/series-wiring.test.ts`
(if it exists) before this ships, same as the others, but nothing in a
read-only pass suggests a conflict.

**Before starting:** none.

---

## Suggested order

PR scope and the e1RM chart are self-contained, low-risk, and don't depend
on each other — either first. Plateau unit reuses the same "day's best"
shape the e1RM fix introduces, so doing e1RM first and lifting the grouping
pattern into deload.ts (rather than writing it twice) is probably the
tidier sequence. Readiness should be **last**, and should start with the
fixture question above rather than code — it may turn out to already be
one commit: fix the test, watch it go from `.fails` (wrongly green) to
green-for-real, done.
