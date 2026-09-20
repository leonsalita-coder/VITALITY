import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { measure, MIN_TARGET } from '../../scripts/measure-targets.mjs'

/**
 * Tap targets, computed from the cascade rather than guessed.
 *
 * The previous measurement read the first `height:` in the first rule
 * matching a selector, which reported .pillHit as 4px — a border width —
 * and kept reporting .pillWarm at 22x22 after a later rule resized it.
 * A measurement that reads the wrong declaration is worse than none,
 * because it looks like an answer.
 *
 * These are DERIVED, not rendered: there is no headless browser here, so
 * nothing accounts for flex stretching or text width. Where a width
 * follows content the measurement says so instead of inventing a number.
 */

const rows = () => measure()
const find = (sel: string) => rows().find((r) => r.sel === sel)!

/** Everything a thumb can land on, and what it measures. */
const REQUIRED = [
  '.pillHit', '.pillMiss', '.pillWarm', '.pillReset', '.pillDrop',
  '.actionPill', '.popX', '.pbtn', '.finishBtn', '.freshbtn', '.chip',
  '.step', '.swapItem', '.cvSend', '.bouncyToggle', '.wcCheck', '.wcX', '.wcAddBtn',
]

describe('every tap target clears the minimum', () => {
  it.each(REQUIRED)('%s reaches 44px', (sel) => {
    const r = find(sel)
    expect(r.styled, `${sel} has no rule`).toBe(true)
    expect(r.hitH).toBeGreaterThanOrEqual(MIN_TARGET)
  })

  it('leaves the painted boxes smaller than the targets', () => {
    /* The point of the exercise: the visual density is unchanged and the
       reachable area grew. If every painted box had simply been inflated
       to 44 the row would be twice as tall. */
    const padded = REQUIRED.map(find).filter((r) => r.hitH! > r.boxH!)
    expect(padded.length).toBeGreaterThan(8)
  })
})

describe('the set row cannot produce an ambiguous tap', () => {
  const css = () => /<style[^>]*>([\s\S]*?)<\/style>/.exec(readFileSync('public/tiles/train.html', 'utf8'))![1]

  it('tiles the action buttons edge to edge rather than overlapping', () => {
    /* Every control in .pillActions extends 7px each side into a 14px
       gap, so neighbouring hit areas meet exactly and never overlap.
       A tap between Hit it and Miss resolves to a logged set or a
       recorded failure — the worst ambiguity in the product. */
    const gaps = [...css().matchAll(/\.pillActions[^{]*\{([^}]*)\}/g)]
      .flatMap((m) => [...m[1].matchAll(/gap\s*:\s*([\d.]+)px/g)].map((g) => parseFloat(g[1])))
    const gap = gaps[gaps.length - 1]
    const reach = [...css().matchAll(/\.pillActions > button::before\s*\{([^}]*)\}/g)]
      .flatMap((m) => [...m[1].matchAll(/left\s*:\s*(-[\d.]+)px/g)].map((g) => -parseFloat(g[1])))
    expect(reach).toHaveLength(1)
    expect(reach[0] * 2).toBe(gap)
  })

  it('gives every control in the row the same target height', () => {
    /* Five painted heights, one target. If they differed, the boundary
       between two buttons would sit at a different place depending on
       how far down the row the thumb landed. */
    const heights = ['.pillHit', '.pillMiss', '.pillWarm', '.pillReset', '.pillDrop'].map((s2) => find(s2).hitH)
    expect(new Set(heights).size).toBe(1)
    expect(heights[0]).toBe(MIN_TARGET)
  })

  it('keeps the whole target inside its own row', () => {
    /* .pill sets overflow:hidden and is taller than the target, so a hit
       area cannot reach the row above or below. */
    const warm = find('.pillWarm')
    const pill = /\.pill\s*\{([^}]*)\}/.exec(css())![1]
    const padding = parseFloat(/padding\s*:\s*([\d.]+)px/.exec(pill)![1])
    expect(warm.boxH! + padding * 2).toBeGreaterThanOrEqual(warm.hitH!)
    expect(pill).toContain('overflow:hidden')
  })
})

describe('what is still under, recorded rather than forgotten', () => {
  it('names the inputs, which a pseudo-element cannot reach', () => {
    /* ::before does not apply to a void element, so .pillInput cannot be
       padded the way every button here was — reaching 44 needs a real
       height change and a taller row. Recorded so it is a decision
       rather than an oversight. */
    expect(find('.pillInput').hitH).toBeLessThan(MIN_TARGET)
  })
})

describe('the measurement itself', () => {
  it('reads a border width as a border, not a height', () => {
    /* .pillHit declares border-bottom-width:4px and no height. The old
       measurement reported it as a 4px tall button. */
    const hit = find('.pillHit')
    expect(hit.boxH).toBeGreaterThan(20)
  })

  it('reports the winning rule when a later one overrides an earlier', () => {
    /* .pillWarm is declared twice: 22x22 in the recovered block, then
       30x30 in the touch-target block. The later one wins. */
    const warm = find('.pillWarm')
    expect(warm.boxH).toBe(30)
  })

  it('says auto rather than inventing a width it cannot know', () => {
    expect(find('.pillMiss').boxW).toBeNull()
  })

  it('finds every target it was asked about', () => {
    /* .wcCheck and .wcX were unstyled in August and here, and were also
       invisible to this measurement until the contact sheet rendered the
       checklist — the sheet is the DOM the matcher runs against, so a
       surface missing from it cannot be measured. Both are now styled
       and both are found. */
    expect(rows().filter((r) => !r.styled).map((r) => r.sel)).toEqual([])
  })
})
