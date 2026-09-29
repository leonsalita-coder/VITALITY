import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * --gold means a record, and nothing else; --signal (aliased --mint) is
 * deliberately scarce — both stated as design-system rules in this tile's
 * own :root comment. Ten call sites violated them by applying the colour
 * to a value with NO condition at all: a `class="v gold"` (or `c:'gold'`)
 * baked into a template string regardless of whether the number behind it
 * was ever a real record, streak, or non-zero total. Fixed by gating each
 * one on the same value it colours (see the commit that added this file).
 *
 * This is the general guard against that class of bug coming back. It is
 * pinned at 0, not ratcheted from a non-zero baseline — a check that
 * starts red and creeps down is the exact shape that already let a
 * mutation ratchet, a survivor scorer, and an unpinned-mode gate all ship
 * broken (see docs/ONBOARDING.md, "Reading a green test"). One allowlist
 * entry: `drawE1rmTrend`'s "Now" stat, a stated-open semantic question
 * (is "the current value" ever the right thing to colour gold, versus the
 * neutral "Best" beside it?) that is Leon's call, not this lint's.
 */

const TILE = 'public/tiles/train.html'

/**
 * Matches `class="...gold..."` / `class="...mint..."` / `class="...up..."`
 * or `c:'gold'` / `c:'mint'` ONLY when nothing between the anchor and the
 * colour word could be a condition — excluding `+`, `?` and `:` from what
 * the class attribute's own content may contain rules out exactly the
 * shape a ternary/concatenation produces (`'v'+(cond?' gold':'')+'"'` has
 * a `'`, a `?` and a `:` sitting between `class="` and `gold`, so it can
 * never match). A genuinely unconditional site — `class="v gold"` as one
 * plain string — has none of those characters in between, so it always
 * does. Self-tested below against both shapes before trusting it against
 * the real file.
 */
const UNCONDITIONAL_COLOR = /class="[^"+?:]*\b(?:gold|mint|up)\b[^"]*"|\bc:\s*'(?:gold|mint)'/g

describe('UNCONDITIONAL_COLOR — self-test', () => {
  it('matches a bare colour class, but not the same class built by a ternary', () => {
    const bad = `hstats.innerHTML='<div class="v gold">'+best+'</div>'`
    expect([...bad.matchAll(UNCONDITIONAL_COLOR)].length).toBe(1)
    /* The word "gold" is right there in this string too — the control
       that proves the regex is reading the SHAPE of the code, not just
       searching for the word. */
    const fixed = `'<div class="v'+(real.length?' gold':'')+'">'+best+'</div>'`
    expect([...fixed.matchAll(UNCONDITIONAL_COLOR)]).toEqual([])
  })

  it('matches a bare card-array colour property, but not the same property gated on the count', () => {
    const bad = `{ n:streak, l:'Week streak', c:'gold' }`
    expect([...bad.matchAll(UNCONDITIONAL_COLOR)].length).toBe(1)
    const fixed = `{ n:streak, l:'Week streak', c:streak>0?'gold':'' }`
    expect([...fixed.matchAll(UNCONDITIONAL_COLOR)]).toEqual([])
  })
})

describe('gold/mint/up is never applied to a value with no condition on it', () => {
  /* Scanned against the RAW file, deliberately not stripped of the
     TRAIN-ENGINE block: lib/train/*.ts is pure, DOM-free TypeScript (see
     CLAUDE.md) with no HTML template strings to match in the first place
     — confirmed empirically, the match set is identical either way — so
     skipping the strip avoids the allowlist's line numbers silently
     drifting every time the generated engine bundle changes SIZE (which
     happens on nearly every lib/train edit) rather than only when this
     hand-written section itself changes. */
  const source = readFileSync(TILE, 'utf8')

  /* Keyed by LINE NUMBER, not matched text — `class="v gold"` is common
     enough that two unrelated sites could produce the identical string,
     and a text-keyed allowlist would silently absorb both the moment a
     second one existed. A line is what's actually being excused here.
     Open question, not decided by this lint: is "the current value" ever
     the right thing to colour gold, versus the neutral "Best" beside it?
     Leon's call. */
  const ALLOWLIST = new Set<number>([
    11034, // drawE1rmTrend "Now"
  ])

  it('has no unconditional gold/mint/up outside the allowlist', () => {
    /* The control, in the SAME test as the absence check below: an empty
       raw scan would pass the filtered assertion for free, so prove the
       scan finds something real (the allowlisted "Now" stat, still
       unconditional on purpose) before trusting it to find nothing else. */
    const matches = [...source.matchAll(UNCONDITIONAL_COLOR)]
    expect(matches.length).toBeGreaterThan(0)

    const offenders = matches
      .filter((m) => !ALLOWLIST.has(source.slice(0, m.index).split('\n').length))
      .map((m) => `line ${source.slice(0, m.index).split('\n').length}: ${m[0]}`)
    expect(offenders).toEqual([])
  })

  it('the allowlist itself stays honest — every entry must still be hit exactly once', () => {
    /* An allowlist entry for a line that no longer matches (moved, fixed,
       or renumbered) is a silent hole: nothing would fail, but the count
       this lint is meant to hold at 0 would actually be -1 line of real
       coverage. Two matches on one allowlisted line is the collision this
       whole line-keyed design replaced text-keying to prevent. */
    const lines = [...source.matchAll(UNCONDITIONAL_COLOR)]
      .map((m) => source.slice(0, m.index).split('\n').length)
    for (const line of ALLOWLIST) {
      expect(lines.filter((l) => l === line), `allowlisted line ${line}`).toHaveLength(1)
    }
  })
})
