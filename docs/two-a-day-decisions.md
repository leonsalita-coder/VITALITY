# Two-a-days — the four decisions

History is keyed `(exerciseId, date)`. `rollupFor` drops every row for that
key before writing the new one, so a lift trained twice in one day keeps
only the second session. Five sets done, two on record, no warning.

The fix is a session id on every history row, old rows migrating to
`sessionId = date`. Four questions have no obvious answer, and an
implementation that decides them by accident is worse than one that decides
them wrongly on purpose — at least the second can be argued with.

**Decided before any code was written.** Each is asserted in
`tests/train/two-a-day.test.ts`, currently as `.fails` — green while the
behaviour is wrong, red the moment it starts working.

| Decision | Ruling | Why |
| --- | --- | --- |
| **PR scope** | Records are **chronological, not day-scoped**. The evening compares against every prior set, including this morning's. | A record is "better than anything before it". Excluding the same day lets a lighter evening lift score a PR the athlete already beat at breakfast. |
| **Plateau unit** | **Days, not sessions.** The window stays calendar-based and every session inside it is considered. | Three sessions inside 36 hours is not a plateau. Counting rows would deload a twice-daily trainee twice as fast as anyone else, for training more. |
| **Readiness** | The evening **sees the morning's load**. | Accumulated fatigue is the entire point of the reading. Advice that ignores a session the athlete has already done is advice about somebody else's day. |
| **e1RM chart** | The chart plots **the day's best**; the store keeps **both sessions**. One point per x. | Two points at the same x is not a line a chart can draw honestly. The store stays complete; only the projection collapses. |

## What this does not decide

The store always keeps both sessions. Every ruling above is about how a
READER treats them — none of them licenses throwing a session away. Where a
reader wants one number per day it derives one; it does not get one by the
data having been lossy upstream.

## The rule these share

Three of the four resolve the same way: **the day is the unit for
presentation, the session is the unit for storage.** The fourth (PR scope)
is the exception that proves it — records are ordered by time, not grouped
by day, so neither unit applies and chronology wins.

## Known limitation: the guard is scoped to today

The session-id guard in `rollupFor` and `metricsContextFor` only compares
`sessionId` when the write's target date **is today**:

```js
const isToday = date===today;
const sid = isToday ? curSession().id : null;
let h = histFor(e).filter(x=>x.date!==date || (isToday && x.sessionId!==sid));
```

For any other date, the filter collapses back to `x.date!==date` — the
same overwrite this feature exists to fix, just for a backdated edit
instead of a live session.

**Confirmed by running it, not by reasoning about it.** Two backdated
writes to the same past date, same lift, through the exact code path the
history-edit popup uses (`rollupFor(draft, date)`):

```
Session A: squat, 2026-08-01, 3×225 →  [{ date: '2026-08-01', kg: 225, sets: [225,225,225] }]
Session B: squat, 2026-08-01, 2×185 →  [{ date: '2026-08-01', kg: 185, sets: [185,185]     }]
```

One row survives. Session A's three sets are gone — not merged, replaced,
identically to the bug this whole feature closes, just on a date that
isn't today.

**Why it's scoped this way, deliberately, for now.** A backdated edit is,
by the existing UI's own design, a **whole-day rewrite**: the popup
("Same write path as a live session") replaces everything logged for that
date with what the user just entered. That is correct and wanted for the
common case — correcting a typo in last Tuesday's weight, or filling in a
day that was never logged. Making the backdated path sessionId-aware
would need the SAME decision the live guard needed — what identifies a
"session" when there is no `curSession()` open for that date at all — and
answering it by accident, inside this command, was explicitly out of
scope. `isToday` is the narrowest cut that stops the destruction on the
common path (a live two-a-day) without silently reinterpreting what a
backdated edit means.

**What it does not do:** protect a genuine two-a-day that happened on a
day the athlete is now backdating — logging a forgotten morning session
and a forgotten evening session for the same past date, separately, still
destroys the first. This is the same collision, just reached through the
history editor instead of the live session, and it is currently
*inherited*, not fixed. `tests/train/two-a-day.test.ts` carries a `.fails`
assertion for it (`'keeps both backdated sessions...'`) so the gap stays
visible rather than silently absorbed into "the guard is done."
