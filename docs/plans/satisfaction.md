# Four held features — what they'd cost, and what they'd cost the design system

Four features that have been held, never specified: milestones, a shareable
session card, haptics on log, and an "arc" sentence. For each: where the
data already exists, what's missing, where it would render, and — asked
for honestly — whether it survives "silence is a state" and "gold means a
record and nothing else."

---

## Milestones

**Proposed set:** first plate a side, two plates, three plates, 100th
session, a year, first million lb lifted.

**Where the data already exists.**
- Plate-count thresholds map directly onto `lib/train/plates.ts`'s
  `plateBreakdown(weight, config)`, which already returns the per-side
  plate list for a total weight (`plateBreakdown(225, defaultConfig()).length
  === 2` — two plates a side). "First plate a side" / "two plates" /
  "three plates" are exactly the first history entry where
  `plateBreakdown(topWorkingWeight(entry), config).length` first reaches 1,
  2, and 3. No new math — this is an existing function applied to history
  that's already stored.
- Session count: `STATE.finishedDates` is already a deduplicated,
  sorted array of trained days (`finishedDates.length` for "100th
  session"; see `lib/train/other.ts:211`, `trainingDates`, for the pattern
  of building this kind of set).
- "A year" is ambiguous as stated — see **Before starting**, below.

**What's missing.**
- Lifetime tonnage does not exist as a maintained figure anywhere.
  `metrics.ts`'s `tonnage` is per-day; nothing sums it across all history
  and all exercises. "First million lb" needs a new aggregate: iterate
  every entry in `STATE.history` (all exercise ids, not just one), sum
  `setWeight(entry, set) * (set.r || 0)` over every working set, ever. This
  is the same shape as `weeklyHardSets` (`train.html:6900`) but unbounded
  by date and unbounded by exercise — cheap to compute on demand for a
  personal-scale history, not something that needs to be cached, but it
  is genuinely new code, not a read of something that already exists.
- Nothing currently remembers "this milestone has already fired." A
  milestone is meant to be a one-time event — `STATE` needs a new field
  (e.g. `STATE.milestonesSeen: string[]`) recording which milestone ids
  have already been shown, checked before ever computing whether a new one
  just triggered, and never re-shown once seen. Without this, restarting
  the app or re-deriving history would re-trigger every milestone the
  athlete has already passed.

**Where it would render.** Not specified here — that's a design decision,
not an implementation one. The natural trigger point is the same place
`isBigPR`/`exHasPR` already fire the PR celebration (`train.html:8789`,
right where today's `kg` bugfix landed), since a milestone crossing is
discovered at the same moment a PR is: right after `doLog` commits a set.

**Against the design system's own rules — the part that has to be said
plainly.**
- **"Gold means a record and nothing else."** A milestone is not a
  record — "your 100th session" and "an e1RM PR" are different claims, and
  the existing `.celebrate`/`--gold` treatment (`train.html:724-727`) is
  already wired specifically to PRs. Milestones firing in gold would blur
  that distinction the moment they shipped. They need their own, visually
  distinct treatment — not gold, and not reusing `.celebrate` verbatim. What
  that treatment IS is a real design decision I'm not making here.
- **Silence is a state.** Every one of these six milestones is inherently
  a one-shot, rare event *if and only if* the "already seen" guard above
  is actually built and actually gates them. Without it, a milestone
  firing every time history is re-derived (e.g. after an import, or a
  backdated edit that recomputes `finishedDates`) would turn a rare event
  into noise — exactly the failure mode `readiness.ts`'s own docstring
  already warns about for a different feature ("a readiness call that
  fires on nothing teaches you to ignore readiness calls"). The one-shot
  guard is not optional polish here; it is the thing that keeps this
  feature inside the existing rule rather than breaking it.
- Net read: **buildable inside both rules, but only with the "seen"
  guard and a non-gold visual language** — drop either one and it stops
  being consistent with what's already shipped.

**Before starting — the question to ask:** what does "a year" mean? Two
readings produce different code: (a) the calendar anniversary of the
first-ever `finishedDates` entry ("you've been training with this app for
a year" — a date comparison, fires once, on a specific day), or (b) 365
total trained days, same shape as "100th session" but at 365 (a count
threshold, could be reached in under a year of real time with a 7-day-a-
week trainee, or never for an inconsistent one). These are genuinely
different features with different trigger logic — I'd rather ask than
build the wrong one.

---

## A shareable session card

**Where the data already exists.** Everything a card would show is
already computed per-session: `sessionTotals`, `hard_sets`/`tonnage` via
`publishedMetrics`, any PR fired that session (`exHasPR`). No new
engine-level computation needed — this is a rendering problem, not a data
problem.

**What's missing, and the real constraint.** The tile's iframe is
sandboxed `allow-scripts` only (`app/app/DashboardGrid.tsx:253`) — no
`allow-popups`, no `allow-downloads`, no `allow-modals`. That has two
concrete consequences worth stating before any design work happens:
- **`navigator.share()`** (the native share sheet) is very likely
  unavailable in a sandbox this narrow — the Web Share API is commonly
  gated behind a permissions policy that a bare `allow-scripts` sandbox
  doesn't grant. This needs to actually be tested in a real sandboxed
  frame before assuming the "share" half of "shareable" works at all.
- **Triggering a file download** (`<a download>`, canvas `toBlob` +
  synthetic click) typically needs `allow-downloads`, which also isn't
  granted.
- If both are genuinely blocked, "shareable" reduces to "renders a
  card on screen for a manual screenshot" — which may be a perfectly fine
  feature, but it's a different feature than the name implies, and the
  gap between them is a sandbox constraint, not a design choice. Worth
  confirming with a real test in a real sandboxed iframe before writing a
  spec for the "share" interaction, rather than designing a share-sheet
  flow that the security model won't allow.

**Against the design system.** Nothing in "silence is a state" or "gold
means a record" obviously bears on this one — it's user-triggered
(presumably a button after finishing a session), not something the app
decides to show unprompted, so the silence-gate concern doesn't apply the
same way. Worth checking against the type ramp and token rules generally
(no raw hex, nothing under `--fs-micro`) once an actual layout exists, same
as any other new tile surface.

---

## Haptics on log (`navigator.vibrate`)

**Where the data already exists.** Nothing new needed — this has no data
dependency at all. The trigger is `doLog` itself
(`train.html:8787`, the same function today's `kg` bugfix touched).

**What's missing.** One call: `if (navigator.vibrate) navigator.vibrate(<pattern>)`
inside `doLog`, gated on whatever condition is decided (every logged set?
only a working set, not a warm-up? only on a PR?). `navigator.vibrate` is
a device API, not a network or storage one — the `allow-scripts` sandbox
should not block it, though this is also worth a real test rather than an
assumption, same as the share API above, since sandboxed-frame behavior
for device APIs varies by browser.

**Against the design system.** No conflict — it's not visual, so neither
rule applies. The only real design question is WHEN it fires (every set,
vs. only a meaningful one), which is a decision, not a constraint.

---

## The arc sentence

**Where the data already exists — almost entirely.**
`lib/train/projection.ts` already computes exactly the shape this needs:
`slopePerDay`/`perWeek` (a least-squares slope over an e1RM series,
`projection.ts:99-114`) and a verdict classification (`on_track`,
`static`, `unreachable`, `reached`, `projection.ts:54`). That machinery
exists to project a lift toward a GOAL target; the arc sentence doesn't
need a goal, just the descriptive half — the slope and the "hasn't moved
in N weeks" static-detection (`projection.ts:162-171`) are both reusable
as-is, minus the target-comparison and arrival-date logic that only make
sense relative to a goal.

**What's missing.** A goal-free entry point — something like
`describeArc(series, now)` that runs the same silence gates
`projectGoal` already has (`MIN_PROJECTION_POINTS`, `STALE_DAYS`) but
returns a sentence describing the trend itself, not a projected arrival.
The rising/flat cases fall out of existing code almost unchanged. A THIRD
shape — a dip followed by a recovery, which is a genuinely common real
lifting pattern around a deload — is not something `slopePerDay`'s linear
regression can name on its own; a straight-line slope averages a dip and
a recovery into "roughly flat," which is a different (and less useful)
statement than "you dropped and came back." Naming that shape would need
new pattern detection (something like: find a local minimum in the
series, confirm the value before it and after it both exceed it), not a
read of something that already exists.

**Three candidate sentences, using real shapes the engine can actually
produce today:**

1. **Steady rise** (direct from `perWeek` + span, no new code):
   > "Bench has climbed 18 lb over the last 9 weeks — about 2 lb a week,
   > still moving."

2. **Plateau** (direct from the existing static-detection branch):
   > "Squat hasn't moved in 7 weeks. The last real jump was in July."

3. **Dip, then recovery** (needs the new local-minimum detection
   described above — not a straight read of existing code):
   > "Deadlift dropped 15 lb after the last deload, then climbed back
   > past where it started within five weeks."

Sentence 3 is the one worth judging hardest before committing to it: it's
the most narratively satisfying of the three, and also the one that
doesn't exist in the codebase yet in any form. If it doesn't land, 1 and 2
alone still describe "what the trend already contains" honestly — they're
just less interesting to read.

**Against the design system.** This is the one place the "gold" rule has
real teeth: an arc sentence describing genuine progress is *not* a
record, and rendering it gold (or anything visually adjacent to the PR
treatment) would say "this is a record" about something that is a trend
observation. It should render as ordinary body text, every time, including
the good-news case. **Silence is a state** applies directly and cheaply:
reuse `projectGoal`'s own silence gates verbatim
(`MIN_PROJECTION_POINTS`, `STALE_DAYS`) — fewer than 4 usable points, or
nothing recent enough, and the arc sentence says nothing at all, the same
way a goal projection already does. No new silence logic to invent; the
existing gate already says exactly when there's enough to speak from.

**Before starting:** whether sentence 3's shape (dip-then-recovery) is
worth the new detection code, or whether shipping only the two "free"
shapes (rise, plateau) is enough for a first version — that's a real
scope decision, not an implementation detail, and I'd rather ask than
guess which one you'd rather see first.
