**Addendum (horizontal-scroll fix):** `.coachFab` and `#coachFabCanvas` now
carry minimal CSS — `position:fixed`, an explicit 56×56 size, and enough
surface (`--e3`, a hairline border, a shadow) not to render as a bare
unstyled rectangle — added to close a real page-overflow bug (the FAB's
canvas had no CSS at all, so its DPR-scaled backing store became its
rendered CSS size, widening the page 223px past the viewport on an iPhone).
This is NOT the visual treatment this brief specs below — the elevation
step and every other call in the `.coachFab` section further down are
still open. `makeConstellation`'s `resize()` (`train.html`) was also
changed to always pin `canvas.style.width/height` from the measured CSS
box, independent of whatever backing-store size it computes — so `#cvCanvas`
(the coach overlay's own canvas, still fully unstyled) can no longer cause
the same class of bug once the overlay is opened, even though its panel's
CSS is still deferred exactly as below.

# The coach overlay — a redesign brief, not a recovery

`docs/train-missing-stylesheet.md` already made the call: the coach
overlay's original styling was a bespoke glass-and-blur language (raw
`rgba()` colors, 28px blur) that the rest of the tile deliberately moved
away from — recorded in the comment above `#vt-backdrop`
(`public/tiles/train.html`). Porting the old CSS back would reintroduce
exactly what that move corrected. This is what replaces it in the CURRENT
system instead: flat elevation (`--e0`–`--e4`), the existing token ramp,
and the primitives every other dialog in this tile already uses. No CSS
below, per the ask — selector names, which existing primitive each maps
onto, and what's genuinely new.

The markup and behavior (`openCoach`/`closeCoach`,
`lib/train/insight.ts`, `lib/train/review.ts`) are live, unaffected, and
out of scope — this is styling only, exactly as the deferral doc says.

## The 13 deferred selectors

Counted from what's still live in `public/tiles/train.html`'s markup/JS
with no CSS behind it: `.coachFab`, `.coachOverlay`, `.cvBackdrop`,
`.coachMorph`, `.cvClose`, `.cvCanvasWrap`, `.cvHead`, `.cvTitle`,
`.cvStatus`, `.cvWave`, `.cvLog`, `.cvEmpty`, `.cvMsg` — thirteen.
(`.cvInputRow` and `.cvSend` already came back earlier as the tile's
general input/button primitives — unaffected, not part of this pass.)

### `.coachOverlay`
**Maps directly onto `.scrim`.** The exact same full-screen backdrop
every other dialog in this tile already opens with — flat
`rgba(0,0,0,.5)`, explicitly **no blur**
(`.scrim`'s own rule already sets `backdrop-filter:blur(0px)`, which is
the tile stating its own no-glass rule in code). No new surface needed;
this selector's job is already done by an existing one.

### `.cvBackdrop`
**Should not exist.** In the original markup this sits nested *inside*
`.coachOverlay`, a second backdrop layer — almost certainly there to
carry part of the old blur stack. `.scrim` alone is the full-screen
backdrop; a second one under it has no job in the flat system. This is
the one selector in the set that gets deleted rather than re-themed —
the flat version of this component needs fewer layers, not a re-colored
version of the same ones.

### `.coachMorph`
**Maps onto `.pop`.** The same flat elevated panel every other dialog
uses — `--e2` background, hairline border, a real `box-shadow` (not a
glow), `--r-lg` corner radius. The "morph" is a motion concern, not a
color one: the panel still animates in from the `.coachFab`'s screen
position (the existing JS already computes this —
`fab.getBoundingClientRect()` vs `morph.getBoundingClientRect()`,
`train.html:10137`) rather than fading in from screen-center the way a
plain `.pop` does. That transform-origin behavior is unchanged; only the
panel's own surface (currently undefined, since this is one of the 13)
should read as `.pop` once it's given one.

### `.coachFab`
**No exact existing match — closest relative is `.actionPill`.** It's a
persistent, floating trigger, not part of a dialog, so it doesn't sit on
the `--e0`–`--e4` panel ramp the same way dialog content does. Recommend
treating it like `.actionPill`'s floating-flat family: an elevated flat
surface (`--e3` or `--e4`, since it floats above the page content
rather than sitting flush with it), signal-tinted on hover/active the
same way `.actionPill` already is. It holds a canvas
(`#coachFabCanvas`) for its own icon/visual — that inner rendering is a
JS/canvas concern, not a token one.

### `.cvClose`
**Maps directly onto `.popX`.** Every other dialog's close button is
already this exact primitive — background none, `--muted` icon,
`--text` on hover, the existing scale-down `:active` state. No reason
for the coach panel's close button to be any different from Trim's or
Simulate's.

### `.cvHead`
**Maps directly onto `.popHead`.** The existing header-row pattern —
eyebrow + title on the left, close button on the right, already used by
every `openPop(...)` dialog via the shared `popHead(eyebrow, title)`
helper (`train.html:9117`). The coach panel should build its header the
same way rather than a bespoke row.

### `.cvTitle`
**Maps directly onto `.popTitle`.** "Your Coach" is exactly the kind of
string `.popTitle` already renders for every other dialog (`popHead`'s
second argument). No new type style — reuse the helper.

### `.cvStatus` / the "Ready" text
**No exact match; closest relative is `.eyebrow`.** A short, muted,
secondary status string is exactly what `.eyebrow` already is (mono,
uppercase, `--fs-micro` floor, `--muted` color) elsewhere in this tile.
Recommend using it here rather than a new micro-text style — one more
place the type ramp doesn't grow a ninth role for something the eighth
already covers.

### `.cvWave` (the four-span "thinking" indicator)
**Genuinely new — nothing in the current primitive set does a pulsing
multi-bar indicator.** This is the one piece of the header that isn't a
re-skin of something that already exists. Building it inside the rules
rather than outside them: bars in `--signal` (matching the "one signal
thing at a time" rule — this is the ONE place in the coach panel that
should carry the signal color, not scattered across the whole surface),
sized no smaller than `--fs-micro`'s adjacent glyph exemption allows, and
animated on the existing timing tokens (`--d1`–`--d4`, `--ease-*` /
`--spring`) rather than inventing new duration/easing values for one
component.

### `.cvCanvasWrap`
**Structural only — the interesting part is a canvas, not CSS.** `#cvCanvas`
renders its own visual via JS (in the same family as the header gem's
Three.js canvas, going by how this tile treats canvases elsewhere); the
wrapper div itself just needs to size and position it inside the panel.
No color decision to make here — whatever the canvas draws is a
different piece of work, outside a style-only pass.

### `.cvLog`
**No exact match; closest relative is a recessed panel-within-a-panel.**
The message transcript should read as sitting slightly BELOW the panel's
own `--e2` surface — a step down the elevation ramp (`--e1` or `--e0`)
rather than a step up, the same visual logic `--e0`–`--e4` already
establishes (lower step = further back/recessed). Follow whatever
convention the tile already uses for other scrollable nested content
(the history list, the set log) rather than inventing a second recessed-
panel pattern — check those before finalizing which step.

### `.cvEmpty`
**Maps onto `.formGist`.** The muted explanatory-paragraph style already
used inside `openTrim`'s panel body ("A shorter session is training...")
is exactly what an empty-state line inside the coach log needs — no new
text style for "nothing here yet" prose.

### `.cvMsg` (with a `.role` modifier — user vs. coach)
**No exact existing match — this is the one real design decision left
in the set.** Two message roles need to read as visually distinct
without inventing new colors. Recommend the elevation ramp does this
job too, the same way it already distinguishes every other level of
"how far forward is this surface": the athlete's own messages a step up
from the log's base (`--e3`, say), the coach's replies sitting flush
with the log's own surface rather than elevated (no extra step — the
coach's voice IS the log's voice, the way a narrator's text doesn't get
its own card). This is a recommendation, not a decision made on your
behalf — bubble-differentiation is a real design call and I'm not
choosing it for you, just naming the token-compliant shape it could
take.

## What this pass does NOT touch

`.cvInputRow` and `.cvSend` — already recovered as general input/button
primitives elsewhere in this tile, already token-compliant, already
unaffected by any of the above. The coach panel's input row should
already be using them; confirm rather than re-spec.

## One open question worth naming before this is built

`.coachFab`'s floating elevation step (`--e3` vs `--e4`) and `.cvMsg`'s
role-differentiation step are the two genuinely unresolved calls above —
everything else in this list is a direct rename onto something that
already exists. Worth deciding those two before writing any markup,
since they're the only places this component invents new visual
territory rather than reusing established territory.
