# Every way data leaves a tile

A tile is a sandboxed `srcDoc` iframe: opaque origin, no network, no
storage. Nothing leaves it except through `window.Vitality`. That makes the
list of exits short and worth writing down, because "what does this tile
expose" is a question people answer by guessing otherwise.

The principle: **a tile publishes what it means to share and nothing else.**
Everything not published stays a decision nobody has to defend later.

## The six paths out of Train

| Path | What goes | Where it lands | Why |
| --- | --- | --- | --- |
| `save(STATE)` | The whole private state — exercise names, session notes, photo URLs, history | Train's **own** store. No other tile can read it. | How a sealed tile persists at all. |
| `publish(metrics)` | Typed daily metrics: key, value, unit, date, provenance | `train:metrics`, readable by any tile | The disciplined cross-tile channel. See `lib/train/metrics.ts`. |
| `classify(name)` | One exercise name | The AI, to resolve an unknown lift | User typed a lift nothing recognises and asked what it is. |
| `getInsight({goal, digest})` | The stated goal, and a digest of findings already computed locally | The AI, to phrase one note | User asked for a written read of their week. |
| `generateWorkout({…})` | Goal, the allowed lift list, equipment, minutes, **and pain flags** | The AI, to propose a session | The pain flags are the point: a generated session that ignores them is worse than none. |
| `addProgressPhoto({base64, mime, goal})` | **A progress photo**, once | The AI, to analyse it. The image is not stored in tile state and goes nowhere else — `base64` is a local variable, sent, and dropped; `STATE.photos` keeps only the returned URL, the date and the analysis text. | User chose to upload a photo for analysis. That is the feature. |

### The two carve-outs, on purpose

The metrics contract explicitly refuses to publish pain flags or images.
Two of the AI paths carry exactly those. That is not an inconsistency:

- **Cross-tile publishing is passive and permanent.** Any tile can read it,
  including one nobody has written yet, and a consumer that starts reading a
  field makes it permanent. So the bar is: would this still be right if an
  unknown reader depended on it forever?
- **The AI paths are user-initiated and singular.** Somebody pressed a
  button to get a specific answer, the data goes to one place for that
  answer, and nothing keeps it. The bar is consent and purpose, not
  permanence.

A field can be right to send in the second case and wrong in the first, and
these two are.

## Reading across tiles

| Rule | Where |
| --- | --- |
| `<tile>:metrics` — typed, provenance-carrying, readable by anyone | `isReadableSlot`, `lib/tiles/metricsContract.ts` |
| Whole-store reads — one entry, `vitals` | same file, `WHOLE_STORE_READABLE` |

`train`, `fuel`, `brand`, `peak` and `finance` were all whole-store readable
and **none of them was ever read** — two `read()` calls exist in the whole
codebase and both ask for `vitals`. Train's store alone held exercise names,
session notes and progress photo URLs, which made the most sensitive data on
the board the most freely available, for no consumer at all. They are closed.

### The asymmetry Train benefits from

`vitals` stays whole-store readable because it has two real consumers:
`train.html` and `peak.html`, both for a recovery signal. Train reads that
entire private store and uses **three fields** — `whoopRecovery`, `feel`,
`sleepHours`.

So Train now publishes narrowly and still consumes broadly. That is the
exact shape it just closed on itself, and it is **recorded rather than
fixed**: narrowing `vitals` means giving that tile a metrics publish of its
own, which is a change to another tile and a separate decision.

Noting it here so the difference stays deliberate instead of becoming
something nobody remembers choosing.
