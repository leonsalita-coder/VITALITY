# Train — what the sandboxed tile genuinely cannot do

A Vitality tile is a **sandboxed `srcDoc` iframe on an opaque origin with no
network**. That is the security model, not a configuration mistake, and it
puts a hard ceiling on a few things the rest timer would obviously want.

This file exists so those limits are **recorded rather than worked around**.
None of them are faked in the tile. They are native-app work.

## Hard blocks

| Capability | Why it cannot work here | Belongs to |
|---|---|---|
| **Notification API** | Needs a permission grant against a real origin. An opaque-origin frame can never be granted one, so `Notification.requestPermission()` is either absent or permanently denied. | Native app, or the dashboard shell on its own origin |
| **Wake Lock API** (`navigator.wakeLock`) | Gated by Permissions Policy and unavailable to a sandboxed frame. The screen will sleep mid-rest and nothing in the tile can stop it. | Native app |
| **iOS Live Activity / Dynamic Island** | No web API exists at all, on any origin. | Native app (iOS) |
| **Android ongoing notification** | Same — requires a real notification channel. | Native app (Android) |
| **Guaranteed background execution** | A hidden tab has its timers throttled to ≥1s; a locked phone suspends them entirely. `AudioContext` is suspended alongside. | Native app |
| **`navigator.vibrate` (some browsers)** | Blocked or absent in sandboxed frames depending on engine; iOS Safari does not implement it anywhere. | Feature-detected, degrades silently |

## What the tile does instead

The timer is built so that the part which *can* be correct, is:

- **Time is derived, never accumulated.** `restRemaining()` computes from a
  stored `startedAt` timestamp on every read. A countdown that subtracts one
  per tick returns wrong by exactly however long the phone was asleep —
  which is most of a rest period. Deriving means the number is right the
  instant you look at it again, no matter what the browser did meanwhile.
- **`visibilitychange` forces an immediate recompute and repaint**, because
  returning to the tab is the one moment we know the clock jumped.
- **A single 250 ms ticker drives every bar.** Its only job is repainting, so
  a throttled or dropped tick costs smoothness and never accuracy.
- **Overtime counts up past zero** rather than freezing at `0:00`. How long
  you actually rested is information; a stopped clock discards it.
- **The chime is suppressed if it is stale.** If zero passed more than ~5
  seconds ago — meaning the tab was hidden through it — the tile marks the
  timer chimed and stays silent. A beep ten minutes late is worse than none.
- **Audio is created inside a user gesture** (logging a set), because that is
  the only gesture reliably preceding a rest, and browsers will not start an
  `AudioContext` outside one.

## The honest summary

The rest timer is **accurate whenever the tile is visible**, and **correct
again the moment you return to it**. It cannot reliably make a sound at the
exact instant zero passes while the phone is face-down and locked — which is
precisely when a lifter wants it.

That specific gap is not closable from inside a sandboxed iframe. It is the
clearest single argument for the native app, and it should be quoted as such
rather than papered over.
