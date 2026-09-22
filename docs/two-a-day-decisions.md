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
