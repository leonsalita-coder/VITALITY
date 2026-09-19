import { describe, it, expect } from 'vitest'
import { warmupRamp, MAX_RAMP_SETS } from '../../lib/train/ramp'
import { defaultPlateConfig, loadableWeights, plateBreakdown } from '../../lib/train/plates'
import { workingSets, workingVolume, rangeSets, isWorkingSet } from '../../lib/train/sets'
import { classifyPR } from '../../lib/train/records'
import { suggestTarget } from '../../lib/train/progression'

/**
 * Warm-up ramp generation.
 *
 * The working weight, the bar and the plate math were all already here;
 * generating the ramp is nearly free and removes the most tedious
 * arithmetic anybody does in a gym.
 *
 * The constraint that shapes it: ramp sets are flagged `warmup: true` at
 * the moment they are created, so they stay out of volume, records and
 * progression BY CONSTRUCTION rather than because the lifter remembered
 * to press W. Nothing here is ever auto-logged — it is generated,
 * editable and skippable.
 */

const config = defaultPlateConfig() // 45 lb bar, 45/35/25/10/5/2.5 pairs

describe('the shape of a ramp', () => {
  it('climbs to but never reaches the working weight', () => {
    const ramp = warmupRamp({ workingLb: 225, kind: 'reps_weight', plates: config })
    expect(ramp.length).toBeGreaterThan(0)
    expect(ramp.every((s) => s.kg < 225)).toBe(true)
    expect(ramp.map((s) => s.kg)).toEqual([...ramp.map((s) => s.kg)].sort((a, b) => a - b))
  })

  it('starts at the bar', () => {
    expect(warmupRamp({ workingLb: 225, kind: 'reps_weight', plates: config })[0].kg).toBe(45)
  })

  it('drops the reps as the weight climbs', () => {
    const reps = warmupRamp({ workingLb: 315, kind: 'reps_weight', plates: config }).map((s) => s.reps)
    expect(reps).toEqual([...reps].sort((a, b) => b - a))
    expect(reps[0]).toBeGreaterThan(reps[reps.length - 1])
  })
})

describe('every ramp weight is one you can actually load', () => {
  const loadable = new Set(loadableWeights(config, 2000))

  it.each([95, 135, 185, 225, 275, 315, 405, 495])('snaps at a %i lb working weight', (working) => {
    const ramp = warmupRamp({ workingLb: working, kind: 'reps_weight', plates: config })
    for (const set of ramp) {
      expect(loadable.has(set.kg)).toBe(true)
      expect(plateBreakdown(set.kg, config)).not.toBeNull()
    }
  })

  it('snaps to a different bar', () => {
    const womens = { barLb: 35, plates: [45, 25, 10, 5, 2.5] }
    const ramp = warmupRamp({ workingLb: 155, kind: 'reps_weight', plates: womens })
    expect(ramp[0].kg).toBe(35)
    const loadableThere = new Set(loadableWeights(womens, 2000))
    expect(ramp.every((s) => loadableThere.has(s.kg))).toBe(true)
  })

  it('never emits the same weight twice', () => {
    for (const working of [95, 115, 135, 225, 405]) {
      const kgs = warmupRamp({ workingLb: working, kind: 'reps_weight', plates: config }).map((s) => s.kg)
      expect(new Set(kgs).size).toBe(kgs.length)
    }
  })
})

describe('the ramp scales to the load', () => {
  it('gives a light working weight a short ramp', () => {
    expect(warmupRamp({ workingLb: 95, kind: 'reps_weight', plates: config }).length).toBeLessThanOrEqual(2)
  })

  it('gives a heavy one a full one', () => {
    expect(warmupRamp({ workingLb: 405, kind: 'reps_weight', plates: config }).length)
      .toBe(MAX_RAMP_SETS)
  })

  it('gives a working weight at the bar no ramp at all', () => {
    expect(warmupRamp({ workingLb: 45, kind: 'reps_weight', plates: config })).toEqual([])
  })

  it('is monotonic in length — heavier never means fewer sets', () => {
    const lengths = [95, 135, 185, 225, 275, 315, 405].map(
      (w) => warmupRamp({ workingLb: w, kind: 'reps_weight', plates: config }).length,
    )
    expect(lengths).toEqual([...lengths].sort((a, b) => a - b))
  })
})

describe('kinds with no load get no ramp', () => {
  it.each(['reps_only', 'bodyweight', 'time', 'distance', 'time_distance'] as const)(
    'returns nothing for %s', (kind) => {
      expect(warmupRamp({ workingLb: 225, kind, plates: config })).toEqual([])
    },
  )

  it('still ramps a weighted bodyweight lift, which does carry load', () => {
    expect(warmupRamp({ workingLb: 90, kind: 'weighted_bodyweight', plates: config }).length)
      .toBeGreaterThan(0)
  })

  it('returns nothing for a working weight it cannot make sense of', () => {
    for (const bad of [0, -100, NaN, Infinity]) {
      expect(warmupRamp({ workingLb: bad, kind: 'reps_weight', plates: config })).toEqual([])
    }
  })
})

describe('ramp sets are warm-ups by construction', () => {
  const ramp = warmupRamp({ workingLb: 315, kind: 'reps_weight', plates: config })

  it('every generated set carries the flag', () => {
    expect(ramp.every((s) => s.warmup === true)).toBe(true)
  })

  it('so none of them is a working set', () => {
    expect(ramp.every((s) => !isWorkingSet({ w: s.kg, r: s.reps, warmup: s.warmup }))).toBe(true)
  })

  const entry = {
    date: '2026-09-19', kg: 315,
    sets: [
      ...ramp.map((s) => ({ w: s.kg, r: s.reps, warmup: true })),
      { w: 315, r: 5 }, { w: 315, r: 5 }, { w: 315, r: 5 },
    ],
  }

  it('is excluded from volume', () => {
    expect(workingSets(entry).length).toBe(3)
    expect(workingVolume(entry).load).toBe(315 * 15)
  })

  it('is excluded from the rep range', () => {
    expect(rangeSets(entry).length).toBe(3)
  })

  it('cannot set a record', () => {
    const history = [{ date: '2026-09-01', kg: 315, sets: [{ w: 315, r: 5 }] }]
    const heaviestRamp = ramp[ramp.length - 1]
    const pr = classifyPR(history, { weight: heaviestRamp.kg, reps: heaviestRamp.reps, warmup: true },
      new Date(2026, 8, 19).getTime())
    expect(pr.kind).toBeNull()
  })

  it('cannot become the weight progression reads', () => {
    const NOW = new Date(2026, 8, 19, 12).getTime()
    const withRamp = [
      { date: '2026-09-05', kg: 315, sets: entry.sets },
      { date: '2026-09-12', kg: 315, sets: entry.sets },
    ]
    const suggestion = suggestTarget(withRamp, { reps: 5, sets: 3, incrementLb: 5 }, NOW)
    // 315 is the work; the 45 lb bar in the ramp must not read as the load
    expect(suggestion.weight).toBeGreaterThanOrEqual(315)
  })
})
