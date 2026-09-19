import { describe, it, expect } from 'vitest'
import { lastSessionFor } from '../../lib/train/lastsession'

/**
 * What you did last time, beside what you are about to do.
 *
 * When the prefill says 190×8, the thing a lifter wants next to it is
 * 185×8,8,7 — and the app has it. This removes the most common reason
 * anybody opens History mid-session, which is the most expensive
 * navigation in the app because it happens between sets.
 *
 * Structured data only. The shape has to be kind-aware, because "185×8"
 * is meaningless for a plank, and it has to be null rather than empty
 * when there is no history, so a caller renders nothing instead of
 * rendering a box with nothing in it.
 */

const NOW = new Date(2026, 8, 19, 12).getTime()
const day = (back: number) => {
  const d = new Date(2026, 8, 19 - back)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

describe('an ordinary lift', () => {
  const history = [
    { date: day(10), kg: 180, sets: [{ w: 180, r: 8 }] },
    { date: day(3), kg: 185, sets: [
      { w: 95, r: 10, warmup: true },
      { w: 185, r: 8 }, { w: 185, r: 8 }, { w: 185, r: 7 },
    ] },
  ]

  it('returns the most recent session, not the first', () => {
    expect(lastSessionFor(history, NOW)!.date).toBe(day(3))
  })

  it('returns the working sets as weight and reps', () => {
    const last = lastSessionFor(history, NOW)!
    expect(last.kind).toBe('reps_weight')
    expect(last.sets).toEqual([
      { weight: 185, reps: 8, missed: false, rpe: null, amrap: false },
      { weight: 185, reps: 8, missed: false, rpe: null, amrap: false },
      { weight: 185, reps: 7, missed: false, rpe: null, amrap: false },
    ])
  })

  it('excludes the warm-up — this is a comparison against working sets', () => {
    expect(lastSessionFor(history, NOW)!.sets.every((s) => s.weight === 185)).toBe(true)
  })

  it('says how long ago', () => {
    expect(lastSessionFor(history, NOW)!.daysAgo).toBe(3)
  })
})

describe('missed sets and RPE', () => {
  const history = [{ date: day(2), kg: 200, sets: [
    { w: 200, r: 5, rpe: 8 },
    { w: 200, r: 5, rpe: 9 },
    { w: 200, r: 2, fail: true },
  ] }]

  it('reports a missed set rather than hiding it', () => {
    const last = lastSessionFor(history, NOW)!
    expect(last.sets.length).toBe(3)
    expect(last.sets[2].missed).toBe(true)
    expect(last.sets[2].reps).toBe(2)
  })

  it('carries RPE when it was logged, and null when it was not', () => {
    const last = lastSessionFor(history, NOW)!
    expect(last.sets[0].rpe).toBe(8)
    expect(last.sets[1].rpe).toBe(9)
    expect(last.sets[2].rpe).toBeNull()
  })

  it('flags an all-out set, which is why the reps look different', () => {
    const withAmrap = [{ date: day(2), kg: 200, sets: [
      { w: 200, r: 5 }, { w: 200, r: 12, amrap: true },
    ] }]
    const last = lastSessionFor(withAmrap, NOW)!
    expect(last.sets[1].amrap).toBe(true)
    expect(last.sets[1].reps).toBe(12)
  })
})

describe('the shape follows the kind', () => {
  it('gives seconds for a plank, and no weight', () => {
    const history = [{ date: day(4), kg: 0, sets: [
      { kind: 'time' as const, s: 60 }, { kind: 'time' as const, s: 55 },
    ] }]
    const last = lastSessionFor(history, NOW)!
    expect(last.kind).toBe('time')
    expect(last.sets).toEqual([
      { seconds: 60, missed: false, rpe: null, amrap: false },
      { seconds: 55, missed: false, rpe: null, amrap: false },
    ])
  })

  it('gives metres for a carry', () => {
    const history = [{ date: day(4), kg: 0, sets: [{ kind: 'distance' as const, m: 40 }] }]
    const last = lastSessionFor(history, NOW)!
    expect(last.kind).toBe('distance')
    expect(last.sets[0]).toMatchObject({ metres: 40 })
    expect((last.sets[0] as unknown as Record<string, unknown>).weight).toBeUndefined()
  })

  it('gives both for a sprint', () => {
    const history = [{ date: day(4), kg: 0, sets: [{ kind: 'time_distance' as const, m: 20, s: 4 }] }]
    expect(lastSessionFor(history, NOW)!.sets[0]).toMatchObject({ metres: 20, seconds: 4 })
  })

  it('gives reps alone for bodyweight work', () => {
    const history = [{ date: day(4), kg: 0, sets: [{ kind: 'reps_only' as const, r: 12 }] }]
    const last = lastSessionFor(history, NOW)!
    expect(last.sets[0]).toMatchObject({ reps: 12 })
    expect((last.sets[0] as unknown as Record<string, unknown>).weight).toBeUndefined()
  })
})

describe('nothing to show is null, not empty', () => {
  it('is null with no history at all', () => {
    expect(lastSessionFor([], NOW)).toBeNull()
    expect(lastSessionFor(null, NOW)).toBeNull()
  })

  it('is null when the only session was a rest day', () => {
    expect(lastSessionFor([{ date: day(3), kg: 0, sets: [], off: true }], NOW)).toBeNull()
  })

  it('skips a day marked off even when sets were logged on it', () => {
    /* The empty-sets case above is caught by having nothing to show, so
       it cannot prove the off-flag is read at all. This one can. */
    const history = [
      { date: day(9), kg: 185, sets: [{ w: 185, r: 8 }] },
      { date: day(3), kg: 205, sets: [{ w: 205, r: 5 }], off: true },
    ]
    const last = lastSessionFor(history, NOW)!
    expect(last.date).toBe(day(9))
    expect(last.sets[0].weight).toBe(185)
  })

  it('is null when the only session was all warm-ups', () => {
    const history = [{ date: day(3), kg: 95, sets: [{ w: 95, r: 10, warmup: true }] }]
    expect(lastSessionFor(history, NOW)).toBeNull()
  })

  it('skips back to the last session that had real work', () => {
    const history = [
      { date: day(10), kg: 185, sets: [{ w: 185, r: 8 }] },
      { date: day(3), kg: 95, sets: [{ w: 95, r: 10, warmup: true }] },
    ]
    expect(lastSessionFor(history, NOW)!.date).toBe(day(10))
  })

  it('does not show today as last time', () => {
    const history = [
      { date: day(7), kg: 185, sets: [{ w: 185, r: 8 }] },
      { date: day(0), kg: 190, sets: [{ w: 190, r: 8 }] },
    ]
    expect(lastSessionFor(history, NOW)!.date).toBe(day(7))
  })
})

describe('it is data, not a sentence', () => {
  it('returns no rendered string for the caller to parse', () => {
    const history = [{ date: day(3), kg: 185, sets: [{ w: 185, r: 8 }] }]
    const last = lastSessionFor(history, NOW) as unknown as Record<string, unknown>
    expect(last.text).toBeUndefined()
    expect(last.html).toBeUndefined()
    expect(Array.isArray(last.sets)).toBe(true)
  })

  it('is deterministic and reads the clock only from `now`', () => {
    const history = [{ date: day(3), kg: 185, sets: [{ w: 185, r: 8 }] }]
    expect(lastSessionFor(history, NOW)).toEqual(lastSessionFor(history, NOW))
    expect(lastSessionFor(history, NOW + 86_400_000)!.daysAgo).toBe(4)
  })
})
