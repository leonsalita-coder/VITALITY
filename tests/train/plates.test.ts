import { describe, it, expect } from 'vitest'
import {
  loadableWeights, snapToLoadable, plateBreakdown, defaultPlateConfig,
  DEFAULT_BAR_LB,
} from '../../lib/train/plates'

/**
 * The number a lifter actually puts on the bar.
 *
 * This module had no test file of its own — it was reached only
 * incidentally through lifecycle and ramp, and 14 of its 24 mutations
 * survived. It is also upstream of progression: hardening the module
 * that decides every weight while the thing it rounds through was
 * unverified is the right answer resting on an unchecked one.
 *
 * A wrong answer here is visible every single session and reads as an
 * app that has never loaded a bar.
 */

const cfg = defaultPlateConfig()

describe('what the rack can actually make', () => {
  it('builds every weight it claims is loadable', () => {
    /* The round trip, and the strongest single statement this module
       can make: if snapToLoadable can return it, plateBreakdown can
       build it. Either function drifting alone breaks this. */
    for (const total of loadableWeights(cfg, 400)) {
      expect(plateBreakdown(total, cfg), `${total} lb is offered but cannot be built`).not.toBeNull()
    }
  })

  it('offers the empty bar and nothing below it', () => {
    const all = loadableWeights(cfg, 400)
    expect(Math.min(...all)).toBe(DEFAULT_BAR_LB)
  })

  it('reaches the cap rather than stopping just short of it', () => {
    /* The limit is inclusive. A per-side load landing exactly on it is
       loadable, and excluding it silently lowers the ceiling by one
       plate pair. */
    expect(loadableWeights(cfg, 1000)).toContain(1000)
  })

  it('counts a denomination once per pair, not once ever', () => {
    /* Two pairs of 45s is a real rack. Treating the list as one-of-each
       would cap the bar at 315. */
    expect(loadableWeights(cfg, 500)).toContain(405)
  })
})

describe('snapping a suggestion', () => {
  it('never suggests a weight that cannot be built', () => {
    for (let target = 45; target <= 400; target += 1.25) {
      const snapped = snapToLoadable(target, cfg)
      expect(plateBreakdown(snapped, cfg), `${target} snapped to unbuildable ${snapped}`).not.toBeNull()
    }
  })

  it('breaks a tie downward', () => {
    /* The module's own rule, and the one with a cost attached: being
       handed slightly less costs one easy rep, being handed slightly
       more is how a marginal set becomes a miss. 137.5 sits exactly
       between 135 and 140. */
    expect(snapToLoadable(137.5, cfg)).toBe(135)
  })

  it('breaks every tie downward, not just that one', () => {
    /* One example can pass by luck of ordering. Every midpoint in the
       working range is the claim. */
    const all = loadableWeights(cfg, 400)
    for (let i = 0; i < all.length - 1; i++) {
      const mid = (all[i] + all[i + 1]) / 2
      expect(snapToLoadable(mid, cfg), `midpoint ${mid} rounded up`).toBe(all[i])
    }
  })

  it('hands back the empty bar for anything lighter than it', () => {
    expect(snapToLoadable(20, cfg)).toBe(DEFAULT_BAR_LB)
    expect(snapToLoadable(0, cfg)).toBe(DEFAULT_BAR_LB)
  })
})

describe('the breakdown refuses rather than guesses', () => {
  it('says null for a weight below the bar', () => {
    /* Not an empty list. An empty list means "just the bar", which is a
       different and loadable answer — the lifter would rack an empty
       bar believing it was what was asked for. */
    expect(plateBreakdown(20, cfg)).toBeNull()
  })

  it('says an empty list for the bar itself', () => {
    expect(plateBreakdown(DEFAULT_BAR_LB, cfg)).toEqual([])
  })

  it('says null for a weight between denominations', () => {
    expect(plateBreakdown(136, cfg)).toBeNull()
  })

  it('hangs plates heaviest first', () => {
    expect(plateBreakdown(135, cfg)).toEqual([45])
    expect(plateBreakdown(225, cfg)).toEqual([45, 45])
    expect(plateBreakdown(140, cfg)).toEqual([45, 2.5])
  })
})

describe('a plate list that is not a plate list', () => {
  it('terminates on a zero denomination', () => {
    /* A zero-weight plate takes the load down by nothing, so a loop
       that accepts it never finishes and the tile freezes with no error
       to read. The filter is the only thing standing between a
       hand-edited config and a hung session. */
    expect(plateBreakdown(135, { barLb: 45, plates: [0, 45, 25] })).toEqual([45])
  })

  it('ignores a negative denomination', () => {
    expect(plateBreakdown(135, { barLb: 45, plates: [-5, 45] })).toEqual([45])
    expect(loadableWeights({ barLb: 45, plates: [-5, 45] }, 200).every((w) => w >= 45)).toBe(true)
  })

  it('offers only the bar when there are no plates', () => {
    expect(loadableWeights({ barLb: 45, plates: [] }, 400)).toEqual([45])
    expect(snapToLoadable(200, { barLb: 45, plates: [] })).toBe(45)
  })

  it('works with no bar at all', () => {
    /* A movement loaded without one — a loading pin, a belt squat. */
    expect(loadableWeights({ barLb: 0, plates: [10, 5] }, 50)).toContain(10)
    expect(plateBreakdown(20, { barLb: 0, plates: [10, 5] })).toEqual([10])
  })
})
