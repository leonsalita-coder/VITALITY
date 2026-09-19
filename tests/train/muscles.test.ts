import { describe, it, expect } from 'vitest'
import {
  MUSCLES, SECONDARY_SHARE, mapMuscle, normalizeShares, muscleSplitFrom, distribute,
  PUSH_MUSCLES, PULL_MUSCLES,
} from '../../lib/train/muscles'

describe('the closed list', () => {
  it('has no duplicates', () => {
    expect(new Set(MUSCLES).size).toBe(MUSCLES.length)
  })

  it('splits the delts into heads rather than one bucket', () => {
    expect(MUSCLES).toContain('front_delts')
    expect(MUSCLES).toContain('rear_delts')
    expect(MUSCLES).not.toContain('shoulders' as never)
  })
})

describe('synonyms collapse to one muscle', () => {
  it('maps every spelling of chest to the same place', () => {
    for (const name of ['Chest', 'chest', 'PECS', 'Pecs', 'pectorals', ' pectoral ']) {
      expect(mapMuscle(name).muscle).toBe('chest')
    }
  })

  it('maps the abbreviations lifters actually use', () => {
    expect(mapMuscle('tris').muscle).toBe('triceps')
    expect(mapMuscle('bis').muscle).toBe('biceps')
    expect(mapMuscle('hams').muscle).toBe('hamstrings')
    expect(mapMuscle('quadriceps').muscle).toBe('quads')
  })

  it('handles spacing and punctuation', () => {
    expect(mapMuscle('lower back').muscle).toBe('lower_back')
    expect(mapMuscle('Lower-Back').muscle).toBe('lower_back')
    expect(mapMuscle('upper back').muscle).toBe('upper_back')
  })

  it('marks a generic term as inexact rather than pretending it was specified', () => {
    const m = mapMuscle('shoulders')
    expect(m.muscle).toBe('front_delts')
    expect(m.exact).toBe(false)
  })

  it('marks a precise term exact', () => {
    expect(mapMuscle('rear delts').exact).toBe(true)
  })
})

describe('unmappable input surfaces rather than vanishing', () => {
  it('returns null for something nothing handles', () => {
    expect(mapMuscle('spleen').muscle).toBeNull()
    expect(mapMuscle('').muscle).toBeNull()
    expect(mapMuscle(null).muscle).toBeNull()
  })

  it('reports it on the split instead of dropping it', () => {
    const split = muscleSplitFrom({ primary: ['Chest', 'Spleen'], secondary: [] })
    expect(split.primary.map((c) => c.muscle)).toEqual(['chest'])
    expect(split.unmapped).toEqual(['Spleen'])
  })

  it('reports unmapped names from both lists', () => {
    const split = muscleSplitFrom({ primary: ['Wingspan'], secondary: ['Gumption'] })
    expect(split.unmapped.sort()).toEqual(['Gumption', 'Wingspan'])
  })
})

describe('contributions sum correctly', () => {
  it('splits a two-muscle primary evenly', () => {
    const split = muscleSplitFrom({ primary: ['Quads', 'Glutes'] })
    expect(split.primary.reduce((n, c) => n + c.share, 0)).toBeCloseTo(1)
    expect(split.primary[0].share).toBeCloseTo(0.5)
  })

  it('gives a single primary the whole share', () => {
    const split = muscleSplitFrom({ primary: ['Chest'] })
    expect(split.primary[0].share).toBe(1)
  })

  it('collapses a duplicate rather than double-counting it', () => {
    const split = muscleSplitFrom({ primary: ['Chest', 'Pecs'] })
    expect(split.primary).toHaveLength(1)
    expect(split.primary[0].share).toBe(1)
  })

  it('normalizes an arbitrary weighting', () => {
    const out = normalizeShares([
      { muscle: 'quads', share: 3 },
      { muscle: 'glutes', share: 1 },
    ])
    expect(out[0].share).toBeCloseTo(0.75)
    expect(out[1].share).toBeCloseTo(0.25)
  })

  it('handles an empty list', () => {
    expect(muscleSplitFrom({}).primary).toEqual([])
    expect(normalizeShares([])).toEqual([])
  })
})

describe('guessed splits are marked', () => {
  it('marks a flat classifier list as estimated', () => {
    expect(muscleSplitFrom({ primary: ['Chest'], secondary: ['Triceps'] }).estimated).toBe(true)
  })

  it('marks a split built on a generic term as estimated', () => {
    expect(muscleSplitFrom({ primary: ['Shoulders'] }).estimated).toBe(true)
  })
})

describe('distribute', () => {
  const bench = muscleSplitFrom({ primary: ['Chest'], secondary: ['Triceps', 'Front Delts'] })

  it('gives the primary the full set count', () => {
    expect(distribute(6, bench).chest).toBeCloseTo(6)
  })

  it('discounts the secondaries', () => {
    const out = distribute(6, bench)
    expect(out.triceps).toBeCloseTo(6 * 0.5 * SECONDARY_SHARE)
  })

  it('touches nothing the exercise does not work', () => {
    expect(distribute(6, bench).calves).toBeUndefined()
  })
})

describe('push and pull sets', () => {
  it('do not overlap', () => {
    expect(PUSH_MUSCLES.filter((m) => PULL_MUSCLES.includes(m))).toEqual([])
  })

  it('are all on the closed list', () => {
    for (const m of [...PUSH_MUSCLES, ...PULL_MUSCLES]) expect(MUSCLES).toContain(m)
  })
})
