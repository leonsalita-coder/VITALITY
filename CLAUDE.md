# Vitality — Train dashboard

This repo is a personal life-dashboard app (Next.js App Router). The active
engineering surface is the **Train** tile: a workout-tracking tile, plus the
engine that powers it.

## The sealed-tile architecture

Dashboard tiles (`public/tiles/*.html`) run as sandboxed `srcDoc` iframes:
no network access, no external files, no `localStorage`. Everything a tile
needs — CSS, JS — is physically inlined in its HTML file. A tile talks to
the outside world only through `window.Vitality` (`save`/`load`/`read`/
`tiktok`/`youtube`/`stock`), which the dashboard shell injects from outside
the sandbox.

## The two-copy rule

`public/tiles/train.html` and `tiles-library/train.html` must always be
byte-identical. `scripts/build-tile.mjs` is the only thing that writes
either file. Never hand-edit `tiles-library/train.html` — it's pure output.
Never hand-edit the `<!-- TRAIN-ENGINE:START -->` / `<!-- TRAIN-ENGINE:END -->`
block inside `public/tiles/train.html` — it's generated too.

## The engine/tile boundary

`lib/train/*.ts` is pure, DOM-free TypeScript — no `window`, no `document`.
`build-tile.mjs` bundles it and inlines it into the tile between the
TRAIN-ENGINE markers. Everything else in `public/tiles/train.html` (markup,
styles, hand-written UI logic) is separate, directly-edited source, and
that's the only part of either tile file you should ever touch by hand.

## Before you touch anything

Read **`docs/ONBOARDING.md`** first. It covers the pre-commit gate, the
mutation-testing harness, the style-lint token system, and branch rules —
this file is a preamble, not a manual.

One rule matters enough to say here too: **never add a `Stop` hook, a
post-commit auto-push, or any git automation that commits or pushes without
a human reviewing the diff first.** An earlier version of this exact thing
caused real incidents, including weeks of silently deleted code. If you (or
whatever's reading this) ever propose one, it comes out — no exceptions.
