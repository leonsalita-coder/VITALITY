# Accessibility audit — VoiceOver and dynamic type

Flagged day one, never built. Read-only pass over `public/tiles/train.html`
and the host (`app/app/DashboardGrid.tsx`) — findings and severity, no
fixes, per the ask. Severity is rated against real-user impact, not
against a specific WCAG conformance level, since this app doesn't claim
one.

---

## HIGH — color is the only signal, with no text alternative at all

**`#daydots` — the per-exercise status row (`train.html:7358-7363`,
CSS at `train.html:821-824`).**
```
<span class="dd done">   -- background: var(--signal)  (mint)
<span class="dd pr">     -- background: var(--gold)
<span class="dd miss">   -- border-color: var(--fail)  (red-ish)
```
Each exercise in the session gets one 6×6px dot, colored by state, with
**no text content, no `aria-label`, no `aria-hidden`.** A sighted user
reads "green = done, gold = PR, red border = missed a set" at a glance;
a VoiceOver user gets either silence or an unlabeled, meaningless
element per exercise — worse than nothing, since an announced-but-empty
element is noise. This is the one place in the app that visibly
contradicts its own design language: `--gold` is supposed to mean "a
record and nothing else" *conveyed visually*, and here that meaning has
no non-visual equivalent whatsoever.

Compounding, not separate: the same dots are also below the tile's own
established minimum touch target (see the 44px finding below) — a
6×6px target with no accessible name is a double gap on the same
element.

---

## HIGH — systemic missing label association on numeric fields

**`fieldRow()`, `train.html:10403`:**
```
function fieldRow(label, ctl, icon){
  ...
  return '<div class="field"><span class="lbl">'+svg(ic,...)+label+'</span>
          <div class="stepper">'+ctl+'</div></div>';
}
```
The label is a bare `<span class="lbl">`, not a `<label for="...">`, and
nothing in the generated markup links it to the control by `id`/`for` or
`aria-labelledby`. Confirmed on a live example: the weight field in the
Tune dialog (`train.html:10317`) renders `<span class="lbl">Weight</span>`
next to `<input id="tw">` with zero programmatic connection between
them. A VoiceOver user landing on that input hears "number, edit text" —
no field name at all.

This is not a one-off: `fieldRow` is the shared helper for numeric field
editors throughout the tile, so this gap repeats everywhere it's used,
not just on the one example checked. Worth actually enumerating every
call site before fixing, since the fix (associating each with a real
`<label for>`) is the same shape everywhere but has to touch every call
site individually.

---

## MODERATE-HIGH — placeholder used as the only label

9 of the tile's 28 `<input>` elements carry a `placeholder` and no
`aria-label` (and, per the finding above, some of those also lack a
paired `<label>`). Placeholder text is a known-insufficient substitute
for a real accessible name: it disappears the moment a value is typed,
and isn't consistently exposed as a name by every screen reader the way
a true label or `aria-label` is. Worth a full enumeration of which 9
specifically before fixing — not listed exhaustively here since a
read-only grep-based pass can't distinguish "this placeholder is the
only cue" from "this one also happens to sit next to real label text
the grep didn't catch," and getting that distinction right matters for
prioritizing which ones are genuine gaps.

---

## MODERATE — sub-44px interactive targets

`.step` (the +/- minute stepper used in Trim and elsewhere),
`train.html:360`, is a fixed `36px × 36px`. The tile has an established
44px minimum elsewhere — recovered deliberately in an earlier pass
("every tap target to 44," per the git history) — which makes this one
an inconsistency with the app's *own* stated standard, not just a
generic accessibility guideline. Worth checking whether `.step` was
missed by that earlier sweep or intentionally exempted (it's a paired
control, not a lone tap target, which is sometimes treated differently)
before assuming it needs the same treatment.

---

## LOW-MODERATE — ellipsis truncation at a fixed pixel width

Four rules combine `white-space:nowrap` + `overflow:hidden` +
`text-overflow:ellipsis` against a fixed container width:
`.noteCard` (`139`), `.noteTxt` (`144`), `.restbar .restLabel` (`226`),
`.railDate` (`812`). This is a common, generally-accepted UI pattern —
not a violation on its own — but it means more content gets silently
clipped as text scales up, with no visible affordance that anything was
cut off. Worth checking whether the truncated content is recoverable
another way (a `title` attribute, a tap-to-expand) for at least the two
that carry actual note/label CONTENT (`.noteCard`, `.restbar .restLabel`)
rather than short, low-stakes strings.

---

## HIGH — dynamic type doesn't do anything here, structurally

This is the one that matters most for the literal question asked.
Every type-ramp token is a hardcoded pixel value:
```
--fs-micro:11px; --fs-label:12px; --fs-caption:13px; ...
```
(`train.html:67-69` and onward through the rest of the ramp). None are
`rem` or tied to a root font-size. **This means OS-level Dynamic
Type / "Larger Text" accessibility settings have zero effect on this
tile's text, full stop** — not "clips at large sizes," but doesn't
respond at all, because nothing here is wired to the mechanism those
settings use (which generally scales relative units or the system font
size, neither of which this stylesheet uses anywhere). A user who has
set their OS text size larger specifically because 11-13px is
unreadable to them gets the exact same 11-13px inside this tile that
everyone else gets.

**Worth separating from browser/pinch page zoom**, which is a different
mechanism (it scales the whole rendered viewport, `px` included) and
should still work regardless of unit — the ellipsis-truncation finding
above would get *more* visible under page zoom, but page zoom itself
isn't blocked by the `px`-only tokens the way OS Dynamic Type is.

---

## Findings that turned up nothing — stated for completeness, not padding

- **The host `<iframe>` is correctly named.** `app/app/DashboardGrid.tsx:253`
  sets `title={slot.name}` on the frame — a screen reader user tabbing
  onto the tile from the dashboard hears what it is before entering it.
- **`prefers-reduced-motion` is already respected** in at least two
  places: dialogs/sheets/scrim animation is disabled under it
  (`train.html:427`), and so is the ambient particle backdrop
  (`train.html:122`). Not exhaustively checked against every animated
  element in the tile, but the pattern exists and is used more than
  once, which suggests it's a considered convention, not a one-off.
- **Most icon-only buttons already carry a real accessible name.**
  Checked `.popX`, `.cvClose`, `.exEye`, `.pinBtn`, `.pillHit`/`.pillMiss`,
  and the `actionPill` family — all either have `aria-label` or visible
  text alongside their icon. The `#daydots` finding above is the
  exception, not the rule.
- **No structural evidence that the sandboxed iframe itself
  (`sandbox="allow-scripts"`, no `allow-same-origin`) blocks VoiceOver.**
  Assistive tech reads the rendered accessibility tree regardless of a
  frame's origin/script sandboxing — sandbox flags restrict script
  capabilities (storage, navigation, popups), not what's exposed to
  screen readers. This can't be fully confirmed by reading code alone;
  it would need an actual VoiceOver pass on a real device before ruling
  it out completely, but there's no red flag in the sandbox
  configuration itself the way there is in, say, the missing-`title`
  class of bug (which isn't present here).

---

## Summary, by severity

| Severity | Finding | Scope |
|---|---|---|
| High | `#daydots` — color-only state, no text/aria alternative | 1 component, used every session |
| High | `fieldRow()` — no programmatic label association | Every numeric field editor built through it |
| High | Type ramp is 100% fixed `px` — OS Dynamic Type has no effect | Every piece of text in the tile |
| Moderate-high | 9 inputs rely on placeholder as the only label | Needs enumeration to confirm exact 9 |
| Moderate | `.step` buttons at 36px, below the app's own 44px standard | The stepper control specifically |
| Low-moderate | Ellipsis truncation on 4 fixed-width text containers | Notes, rest label, date rail |
