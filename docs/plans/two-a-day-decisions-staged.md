# Two-a-day decisions — staged for execution

`docs/plans/two-a-day-decisions-impl.md` has the reasoning. This is the
mechanical sequence — exact edits, file and line, verified current as of
this staging pass (nothing in `records.ts`, `deload.ts`, or `series.ts` has
moved since the original plan was written). No code has been touched;
this is what a single execution pass would do, in order.

Written and verified while the mutate sweep runs — reading only, nothing
here touches `lib/`, `tests/`, or the tile.

---

## Readiness — settled: fixture bug, zero production code

**Confirmed, not just suspected.** Read `tests/train/two-a-day.test.ts`'s
`'CHOICE: does readiness see the morning before advising the evening?'`
test and `lib/train/metrics.ts`'s `entriesOn`/`hardSets` side by side:

- The test passes `history: { squat: [morning] }` — one row, 3 sets
  (`morning = sess(DAY, 3, 225)`).
- `entriesOn` (metrics.ts) sums `workingSets(entry).length` across every
  entry matching `ctx.date` — a flat sum, no per-session or per-day
  dedup. With one 3-set row, the only value it can produce is **3**.
- The test asserts **6** — which is `morning.sets.length +
  evening.sets.length` (3 + 3), where `evening = sess(DAY, 3, 245)` is
  defined two lines above in the same `describe` block and never used.

There's no code path that turns a single 3-set entry into 6. **The
fixture is wrong, not the code.** The fix:

```diff
-      const one = publishedMetrics({
-        date: DAY, history: { squat: [morning] }, index, finishedDates: [DAY],
+      const one = publishedMetrics({
+        date: DAY, history: { squat: [morning, evening] }, index, finishedDates: [DAY],
```
(`tests/train/two-a-day.test.ts`, inside the `'CHOICE: does readiness...'`
test body.)

Once that's the fixture, `hard_sets` will already come back as 6 — no
change needed anywhere in `lib/train/` or `public/tiles/train.html`. The
underlying `rollupFor` session-id fix already makes this correct; this
test just never actually exercised it. **Execution step:** flip the
fixture, remove `.fails`, run `tests/train/two-a-day.test.ts` alone,
confirm the one test goes from wrongly-green to actually-green and
nothing else in that file regresses.

---

## 1. PR scope — chronological, session-scoped exclusion

**Files, in this order:**

**`lib/train/records.ts:61-66`** — add a field to `BestOptions`:
```diff
 export interface BestOptions {
   /** Today never competes with itself. */
   excludeDate?: string
   /** Rolling window floor, inclusive, as YYYY-MM-DD. */
   sinceDate?: string
+  /** The session currently being logged — excluded from its own baseline. */
+  excludeSessionId?: string
 }
```

**`lib/train/records.ts:70-74`** — `eligible()` checks it first:
```diff
 function eligible(entry: HistoryEntry, opts: BestOptions): boolean {
+  if (opts.excludeSessionId && entry.sessionId === opts.excludeSessionId) return false
   if (opts.excludeDate && entry.date === opts.excludeDate) return false
   if (opts.sinceDate && entry.date < opts.sinceDate) return false
   return true
 }
```

**`lib/train/records.ts:220-228`** (`classifyPR`) — new parameter,
switch the baseline from date-exclusion to session-exclusion:
```diff
 export function classifyPR(
   history: HistoryEntry[],
   candidate: PRCandidate,
   now: number,
+  currentSessionId?: string,
 ): PRResult {
   if (!isWorkingSet(candidate)) return NO_PR

-  const today = dateKey(now)
-  const base: BestOptions = { excludeDate: today }
+  const base: BestOptions = { excludeSessionId: currentSessionId }
   const kind = candidate.kind || DEFAULT_SET_KIND
```
Check whether `dateKey`/`today` are still referenced later in the same
function before deleting the `dateKey` import — if this was their only
use in the file, remove the now-dead import too.

**`public/tiles/train.html:7183`** — the one call site:
```diff
-  return TrainEngine.classifyPR(histFor(e).filter(x=>!x.off), prCandidateFor(e, idx), Date.now());
+  return TrainEngine.classifyPR(histFor(e).filter(x=>!x.off), prCandidateFor(e, idx), Date.now(), curSession().id);
```

**One verification step worth doing before calling this finished, found
while re-checking line numbers for this staging pass — not in the
original plan:** `lib/train/sets.ts:266` already back-fills a synthetic
`sessionId` for any legacy row that doesn't have a real one:
`entry.sessionId ? entry : { ...entry, sessionId: entry.date }` — a
row with no stored session id reads back with `sessionId` equal to its
own date string. Separately, `public/tiles/train.html:7152` has
`if(!STATE.session.id) STATE.session.id = today;` — a fallback that
gives the *live* session's id the literal value `today` under some
initialization path. If those two things ever collide — a live session
whose id fell back to `today`, and a legacy same-day row whose sessionId
synthesized to that same `today` — `excludeSessionId` would incorrectly
exclude a real historical row from the baseline. Worth confirming
whether `STATE.session.id` ever actually reaches runtime still equal to
`today` (or whether something always calls `newSessionId()` first) before
treating this as done — a five-minute check, not a redesign, but worth
doing rather than assuming.

**Test to flip:** `'CHOICE: may the evening set a PR against the morning
of the same day?'`, `tests/train/two-a-day.test.ts`.

---

## 2. e1RM chart — day's best, one point per day

Doing this before plateau unit since plateau reuses this shape.

**`lib/train/series.ts:51-64`** (`e1rmSeries`) — replace the per-entry
loop with a per-date grouping:
```diff
 export function e1rmSeries(entries: HistoryEntry[]): Point[] {
-  const points: Point[] = []
-  for (const entry of readableEntries(entries)) {
+  const byDate = new Map<string, number>()
+  for (const entry of readableEntries(entries)) {
     let best = 0
     for (const set of workingSets(entry)) {
       const value = epley1RM(setWeight(entry, set), set.r || 0)
       if (value != null && value > best) best = value
     }
-    if (best > 0) points.push({ date: entry.date, value: Math.round(best * 10) / 10 })
+    if (best > 0) {
+      const existing = byDate.get(entry.date) ?? 0
+      byDate.set(entry.date, Math.max(existing, best))
+    }
   }
-  return points.sort((a, b) => a.date.localeCompare(b.date))
+  return [...byDate.entries()]
+    .map(([date, value]) => ({ date, value: Math.round(value * 10) / 10 }))
+    .sort((a, b) => a.date.localeCompare(b.date))
 }
```

**Test to flip:** `'CHOICE: does the e1RM chart plot one point a day or
one a session?'`, `tests/train/two-a-day.test.ts`.

**Regression check:** `tests/train/series.test.ts` in full — every
`e1rmSeries` fixture there uses distinct dates, so this should be a
no-op against the existing suite, but confirm rather than assume.

---

## 3. Plateau unit — days, not sessions

**`lib/train/deload.ts:186-190`** — group by date before slicing,
reusing the same "day's best" shape as the e1RM fix:
```diff
   const usable = (history || []).filter(
     (entry) => entry && !entry.off && !isExcluded(entry.date, opts.excluded),
   )
-  if (usable.length < PLATEAU_WINDOW + 1) return null
-  const recent = usable.slice(-PLATEAU_WINDOW)
+  const byDay = new Map<string, HistoryEntry>()
+  for (const entry of usable) {
+    const existing = byDay.get(entry.date)
+    if (!existing || entryScore(entry, opts).primary > entryScore(existing, opts).primary) {
+      byDay.set(entry.date, entry)
+    }
+  }
+  const days = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date))
+  if (days.length < PLATEAU_WINDOW + 1) return null
+  const recent = days.slice(-PLATEAU_WINDOW)
```
Note `entryScore` gets called twice per entry in the grouping pass (once
here, once again at the existing `scores = recent.map(...)` line just
below) — deliberate, not a mistake to "optimize" away; leave a comment
saying so when this lands, since it's exactly the kind of thing a later
cleanup pass might "simplify" into calling `entryScore` on the wrong
day's representative entry.

**Test to flip:** `'CHOICE: is a plateau three SESSIONS or three DAYS?'`,
`tests/train/two-a-day.test.ts`.

**Regression check:** `tests/train/deload.test.ts` and
`tests/train/deload-walk.test.ts` in full — every existing fixture uses
one row per distinct, weekly-spaced date, so day-grouping should be a
no-op against them, but confirm.

---

## Execution order and what "done" looks like

1. Readiness fixture fix (no production code) — flip, verify, done in
   one step.
2. e1RM chart (`series.ts`) — smallest, most self-contained real change.
3. Plateau unit (`deload.ts`) — reuses e1RM's grouping shape, do it
   right after so the pattern is fresh.
4. PR scope (`records.ts` + one tile call site) — the one with the
   sessionId-collision check to run before calling it finished.

After all four: `tests/train/two-a-day.test.ts` should have **zero**
remaining `.fails` under `describe('decisions nobody has made yet')` —
every one either flipped to a real passing assertion or (readiness)
proven to already be handled. Run the full file, then the full suite,
before calling this done.
