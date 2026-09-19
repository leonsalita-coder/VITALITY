# Train — which numbers are measured, and which are guesses

Some of what this app reasons from is counted. Some of it is somebody's
impression of how hard something felt. Those are not the same kind of
number, and the moment they are stored in the same field nothing
downstream can tell them apart any more.

This file records which is which, and what each is allowed to do.

## Measured

Counted directly from what the athlete logged. No inference involved.

| Input | Where it comes from |
| --- | --- |
| Working sets, reps, weight | the set log |
| Session dates | finishing a session |
| Bodyweight | a logged weigh-in |
| Recovery score | a connected Vitals read |
| RPE | per-set, when entered |

These may do anything: drive a PR, detect a plateau, trigger a deload,
advise rest.

## Estimated

Inferred, self-reported, or authored by a model. Each is flagged at the
source and the flag travels with the value.

| Input | Why it is a guess | Flag |
| --- | --- | --- |
| Muscle split from the classifier | a flat list of names carries no weighting, so an even split is an assumption | `MuscleSplit.estimated` |
| Generic muscle names ("shoulders", "legs") | resolved to a specific head by guessing | `MuscleMatch.exact === false` |
| Bodyweight load contribution | `bodyweightFactor` is an authored constant, not a measurement of this person | `estimated` on the volume totals |
| **Other training load** | **duration × self-reported intensity, with no objective anchor** | **`OtherLoadSummary.estimated`, typed as literal `true`** |

## What other training may and may not do

Self-reported intensity times duration is the crudest number in the app.
"Hard" means different things on different days to the same person, and
nothing here can check. So it is confined, deliberately:

**It may** hold a session back — cut the volume or ease the weight, once,
and only when nothing measured had anything to say. It may count as having
trained, for the frequency streak. It may be shown to the coach, with the
caveat attached in words.

**It may not** touch a specific lift. Not the prescribed weight, not the
plateau read, not a PR, not a deload. The causal link from "two hours of
sparring" to "your bench is stalled" is far too weak to act on, and a wrong
deload attributed to something the athlete only roughly described is the
fastest way to lose trust in the mechanism — including in the deloads that
were right.

**It may not advise rest.** Rest is the strongest call this app makes and it
should turn on a measured recovery number, not on a self-report.

### How that is held

Structurally, not by remembering:

- Other-training entries live in `STATE.otherTraining`. They are not
  history rows, so `workingVolume`, `classifyPR` and `detectPlateau` have
  no argument through which one could arrive.
- `lib/train/other.ts` cannot suppress anything. It supplies the
  vocabulary; `readiness.ts` owns what may act on it.
- Suppression is a rule *inside* `assessReadiness`, reached only after the
  `activeDeload` gate at the top and after every measured verdict. It is
  not a function anyone can call separately and forget to guard.

That last point is a scar. The first version had suppression as its own
exported function, and it could not tell "silent because the athlete is
fine" from "silent because a lift is already being cut" — so it stacked a
second cut onto a deload. `DeloadContext`'s field list is asserted in
`tests/train/other.test.ts` for the same reason: adding other training to
it should require arguing for it out loud, not slipping it in.

## The rule for anything added later

If a new input is inferred, self-reported, or written by a model, it gets a
flag at the source, the flag travels with the value, and the words that
reach the athlete say so. A flag that stops at the type boundary is not a
flag — a model handed `training load 1440` will reason about it exactly as
confidently as it reasons about a set count.
