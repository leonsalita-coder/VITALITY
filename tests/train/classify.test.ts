import { describe, it, expect } from 'vitest'
import { SET_KINDS, normalizeClassification, defaultRepRange } from '../../lib/train/classify'

/**
 * The classifier is a language model. Its answer is untrusted input that
 * lands directly in the data model, so every field is validated and
 * anything unexpected falls back to the shape that behaves exactly like
 * today's app.
 */

describe('SET_KINDS', () => {
  it('is the closed list the rest of the engine dispatches on', () => {
    expect(SET_KINDS).toEqual(['reps_weight', 'reps_only', 'time', 'distance', 'time_distance'])
  })
})

describe('normalizeClassification — kind', () => {
  it('accepts every allowed kind', () => {
    for (const kind of SET_KINDS) {
      expect(normalizeClassification({ defaultSetKind: kind }).kind).toBe(kind)
    }
  })

  it('falls back to reps_weight on a kind it has never heard of', () => {
    expect(normalizeClassification({ defaultSetKind: 'isometric_hold' }).kind).toBe('reps_weight')
    expect(normalizeClassification({ defaultSetKind: 'TIME' }).kind).toBe('reps_weight')
  })

  it('falls back on a non-string', () => {
    expect(normalizeClassification({ defaultSetKind: 7 }).kind).toBe('reps_weight')
    expect(normalizeClassification({ defaultSetKind: null }).kind).toBe('reps_weight')
    expect(normalizeClassification({}).kind).toBe('reps_weight')
  })

  it('survives being handed nothing at all', () => {
    expect(normalizeClassification(null).kind).toBe('reps_weight')
    expect(normalizeClassification(undefined).kind).toBe('reps_weight')
    expect(normalizeClassification('a plank, probably').kind).toBe('reps_weight')
    expect(normalizeClassification([]).kind).toBe('reps_weight')
  })
})

describe('normalizeClassification — flags', () => {
  it('takes only a real boolean true', () => {
    expect(normalizeClassification({ perSide: true }).perSide).toBe(true)
    expect(normalizeClassification({ assisted: true }).assisted).toBe(true)
  })

  it('treats a truthy string as false rather than guessing', () => {
    expect(normalizeClassification({ perSide: 'yes' }).perSide).toBe(false)
    expect(normalizeClassification({ assisted: 1 }).assisted).toBe(false)
  })

  it('defaults both to false', () => {
    const c = normalizeClassification({})
    expect(c.perSide).toBe(false)
    expect(c.assisted).toBe(false)
  })
})

describe('normalizeClassification — numbers', () => {
  it('keeps sane starting numbers', () => {
    const c = normalizeClassification({ tier: 1, startingSets: 4, startingReps: 6, startingKg: 135, restSeconds: 180 })
    expect(c.tier).toBe(1)
    expect(c.sets).toBe(4)
    // reps follow the range's floor rather than the model's suggestion, so
    // the first session is not already short of its own target
    expect(c.reps).toBe(4)
    expect(c.weight).toBe(135)
    expect(c.rest).toBe(180)
  })

  it('clamps nonsense into range instead of storing it', () => {
    const c = normalizeClassification({ tier: 99, startingSets: 400, startingReps: -5, startingKg: -20, restSeconds: 9 })
    expect(c.tier).toBe(2) // an impossible tier is garbage, not a very high one
    expect(c.sets).toBeLessThanOrEqual(8)
    expect(c.reps).toBeGreaterThanOrEqual(1)
    expect(c.weight).toBe(0)
    expect(c.rest).toBeGreaterThanOrEqual(30)
  })

  it('falls back when the numbers are not numbers', () => {
    const c = normalizeClassification({ startingSets: 'three', startingReps: null, startingKg: 'heavy' })
    expect(Number.isFinite(c.sets)).toBe(true)
    expect(Number.isFinite(c.reps)).toBe(true)
    expect(c.weight).toBe(0)
  })
})

describe('defaultRepRange — compounds narrow, accessories wider', () => {
  it('gives a primary compound a narrow range', () => {
    expect(defaultRepRange(1, 'reps_weight')).toEqual([4, 6])
  })

  it('gives a secondary compound a middle range', () => {
    expect(defaultRepRange(2, 'reps_weight')).toEqual([6, 10])
  })

  it('gives an accessory a wide range', () => {
    expect(defaultRepRange(3, 'reps_weight')).toEqual([10, 15])
  })

  it('gives no range to a kind that has no reps to climb', () => {
    expect(defaultRepRange(2, 'time')).toBeNull()
    expect(defaultRepRange(2, 'distance')).toBeNull()
    expect(defaultRepRange(2, 'time_distance')).toBeNull()
  })

  it('gives no range to bodyweight reps, which progress one rep at a time', () => {
    expect(defaultRepRange(3, 'reps_only')).toBeNull()
  })
})

describe('a newly classified lift is not inert', () => {
  it('arrives with a usable rep range so double progression actually runs', () => {
    const c = normalizeClassification({ defaultSetKind: 'reps_weight', tier: 2 })
    expect(c.repRange).toEqual([6, 10])
  })

  it('arrives with no range when the kind cannot use one', () => {
    expect(normalizeClassification({ defaultSetKind: 'time' }).repRange).toBeNull()
  })

  it('keeps the bottom of the range as the starting reps, so they agree', () => {
    const c = normalizeClassification({ defaultSetKind: 'reps_weight', tier: 1 })
    expect(c.reps).toBe(c.repRange![0])
  })
})

describe('garbage in', () => {
  it('produces a complete, usable definition from total nonsense', () => {
    const c = normalizeClassification({
      defaultSetKind: { nested: 'object' },
      perSide: [],
      assisted: 'true',
      tier: 'primary',
      startingSets: NaN,
      startingReps: Infinity,
      startingKg: {},
      restSeconds: 'ninety',
    })
    expect(c.kind).toBe('reps_weight')
    expect(c.perSide).toBe(false)
    expect(c.assisted).toBe(false)
    expect(Number.isFinite(c.sets)).toBe(true)
    expect(Number.isFinite(c.reps)).toBe(true)
    expect(Number.isFinite(c.weight)).toBe(true)
    expect(Number.isFinite(c.rest)).toBe(true)
    expect(c.repRange).not.toBeNull()
  })
})
