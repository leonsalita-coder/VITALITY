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

describe('the three controls this pass was asked to fix', () => {
  it('sizes the dialog close button to the minimum', () => {
    /* It is the close target on twenty dialogs. It paints no background,
       so a 44px box looks identical to the 26px one it replaced. */
    const popX = find('.popX')
    expect(popX.boxH).toBeGreaterThanOrEqual(MIN_TARGET)
    expect(popX.boxW).toBeGreaterThanOrEqual(MIN_TARGET)
  })

  it('extends the card action pill without changing its painted height', () => {
    /* Vertical only: .exActions has a 7px horizontal gap, so widening
       would make neighbouring pills overlap each other. */
    const pill = find('.actionPill')
    expect(pill.boxH).toBeLessThan(MIN_TARGET)
    expect(pill.hitH).toBeGreaterThanOrEqual(MIN_TARGET)
    expect(pill.grew).toBe(true)
  })

  it('brings the set-row flags to the minimum in both axes', () => {
    /* W, A, RPE and L/R all live here, and they were 22x22. */
    const warm = find('.pillWarm')
    expect(warm.hitH).toBeGreaterThanOrEqual(MIN_TARGET)
    expect(warm.hitW).toBeGreaterThanOrEqual(MIN_TARGET)
  })

  it('keeps the set-row flag hit area inside its own row', () => {
    /* .pill is 46px tall (12px padding on 30px content) and sets
       overflow:hidden, so a 44px hit area is contained by the row rather
       than reaching the row above or below. If the row ever gets
       shorter than the target, taps become ambiguous between rows. */
    const warm = find('.pillWarm')
    const css = /<style[^>]*>([\s\S]*?)<\/style>/.exec(readFileSync('public/tiles/train.html', 'utf8'))![1]
    const pill = /\.pill\s*\{([^}]*)\}/.exec(css)![1]
    const padding = /padding\s*:\s*([\d.]+)px/.exec(pill)![1]
    const rowHeight = warm.boxH! + parseFloat(padding) * 2
    expect(rowHeight).toBeGreaterThanOrEqual(warm.hitH!)
    expect(pill).toContain('overflow:hidden')
  })

  it('spaces the flags so their hit areas tile rather than overlap', () => {
    /* 30px painted + 14px gap = 44. Adjacent hit areas meet exactly
       edge to edge; a smaller gap would make them overlap and a tap
       between two flags would be a coin toss. */
    const css = /<style[^>]*>([\s\S]*?)<\/style>/.exec(readFileSync('public/tiles/train.html', 'utf8'))![1]
    const gaps = [...css.matchAll(/\.pillActions\s*\{([^}]*)\}/g)]
      .flatMap((m) => [...m[1].matchAll(/gap\s*:\s*([\d.]+)px/g)].map((g) => parseFloat(g[1])))
    const gap = gaps[gaps.length - 1]
    const warm = find('.pillWarm')
    expect(warm.boxW! + gap).toBeGreaterThanOrEqual(MIN_TARGET)
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
    const missing = rows().filter((r) => !r.styled).map((r) => r.sel)
    /* .wcCheck and .wcX are the checklist controls — never styled, in
       August or now, and outside every list so far. Named here so the
       gap is recorded rather than rediscovered. */
    expect(missing).toEqual(['.wcCheck', '.wcX'])
  })
})
