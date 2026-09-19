import { describe, it, expect } from 'vitest'
import {
  workingSets,
  DEFAULT_SET_KIND,
  setKind,
  entryKind,
  emptyVolume,
  workingVolume,
  entryScore,
  topWorkingSeconds,
  topWorkingMetres,
} from '../../lib/train/sets'
import type { HistoryEntry } from '../../lib/train/sets'

const entry = (sets: any[], over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  date: '2026-09-16',
  kg: 0,
  sets,
  ...over,
})

describe('kind defaults', () => {
  it('reads an absent kind as reps_weight — existing rows migrate untouched', () => {
    expect(DEFAULT_SET_KIND).toBe('reps_weight')
    expect(setKind({ r: 5, w: 185 })).toBe('reps_weight')
  })

  it('reads an explicit kind', () => {
    expect(setKind({ s: 60, kind: 'time' })).toBe('time')
  })

  it('takes an entry’s kind from its working sets, not a warm-up', () => {
    const e = entry([
      { s: 30, kind: 'time', warmup: true },
      { s: 60, kind: 'time' },
    ])
    expect(entryKind(e)).toBe('time')
    expect(entryKind(entry([]))).toBe('reps_weight')
  })
})

describe('volume never sums across kinds', () => {
  it('counts load for reps_weight', () => {
    const v = workingVolume(entry([{ w: 185, r: 5 }, { w: 185, r: 5 }]))
    expect(v.load).toBe(1850)
    expect(v.reps).toBe(0)
    expect(v.seconds).toBe(0)
    expect(v.metres).toBe(0)
  })

  it('counts reps for reps_only, and no load', () => {
    const v = workingVolume(entry([{ r: 12, kind: 'reps_only' }]))
    expect(v.reps).toBe(12)
    expect(v.load).toBe(0)
  })

  it('counts seconds for time', () => {
    const v = workingVolume(entry([{ s: 45, kind: 'time' }, { s: 60, kind: 'time' }]))
    expect(v.seconds).toBe(105)
    expect(v.load).toBe(0)
  })

  it('counts metres for distance', () => {
    const v = workingVolume(entry([{ m: 40, kind: 'distance' }]))
    expect(v.metres).toBe(40)
  })

  it('counts both for time_distance', () => {
    const v = workingVolume(entry([{ m: 400, s: 75, kind: 'time_distance' }]))
    expect(v.metres).toBe(400)
    expect(v.seconds).toBe(75)
    expect(v.load).toBe(0)
  })

  it('keeps a mixed session in separate buckets rather than one nonsense number', () => {
    const v = workingVolume(
      entry([
        { w: 185, r: 5 },
        { s: 60, kind: 'time' },
        { m: 40, kind: 'distance' },
        { r: 12, kind: 'reps_only' },
      ]),
    )
    expect(v).toEqual({ load: 925, reps: 12, seconds: 60, metres: 40 })
    // there is deliberately no `total` — adding lb·reps to seconds is meaningless
    expect('total' in v).toBe(false)
  })

  it('excludes warm-ups and misses from every bucket', () => {
    const v = workingVolume(
      entry([
        { w: 95, r: 8, warmup: true },
        { s: 30, kind: 'time', warmup: true },
        { w: 185, r: 5, fail: true },
        { w: 185, r: 5 },
      ]),
    )
    expect(v).toEqual({ ...emptyVolume(), load: 925 })
  })
})

describe('per-side doubles volume once and only once', () => {
  it('doubles a per-side set', () => {
    expect(workingVolume(entry([{ w: 40, r: 10, perSide: true }])).load).toBe(800)
  })

  it('does not double again when the exercise is also marked per-side', () => {
    const e = entry([{ w: 40, r: 10, perSide: true }])
    expect(workingVolume(e, { perSide: true }).load).toBe(800)
  })

  it('honours the exercise flag when the set says nothing', () => {
    expect(workingVolume(entry([{ w: 40, r: 10 }]), { perSide: true }).load).toBe(800)
  })

  it('lets an explicit set flag override the exercise', () => {
    expect(workingVolume(entry([{ w: 40, r: 10, perSide: false }]), { perSide: true }).load).toBe(400)
  })

  it('doubles time and distance too', () => {
    const e = entry([{ s: 30, kind: 'time', perSide: true }, { m: 20, kind: 'distance', perSide: true }])
    const v = workingVolume(e)
    expect(v.seconds).toBe(60)
    expect(v.metres).toBe(40)
  })

  it('leaves the logged number itself alone', () => {
    const e = entry([{ w: 40, r: 10, perSide: true }])
    expect(e.sets![0].r).toBe(10)
    expect(e.sets![0].w).toBe(40)
  })
})

describe('assisted work: less assistance is better', () => {
  it('contributes reps but no load, since the real load is not knowable', () => {
    const v = workingVolume(entry([{ w: 40, r: 8, assisted: true }]))
    expect(v.load).toBe(0)
    expect(v.reps).toBe(8)
  })

  it('scores LESS assistance as the better session', () => {
    const heavy = entryScore(entry([{ w: 60, r: 8, assisted: true }]))
    const light = entryScore(entry([{ w: 30, r: 8, assisted: true }]))
    expect(light.primary).toBeGreaterThan(heavy.primary)
  })

  it('scores MORE weight as better when not assisted — the direction inverts', () => {
    const heavy = entryScore(entry([{ w: 225, r: 5 }]))
    const light = entryScore(entry([{ w: 135, r: 5 }]))
    expect(heavy.primary).toBeGreaterThan(light.primary)
  })

  it('treats dropping to zero assistance as the best possible', () => {
    const unassisted = entryScore(entry([{ w: 0, r: 8, assisted: true }]))
    const assisted = entryScore(entry([{ w: 20, r: 8, assisted: true }]))
    expect(unassisted.primary).toBeGreaterThan(assisted.primary)
  })
})

describe('entryScore normalises every kind so higher is better', () => {
  it('scores reps_weight on weight then reps', () => {
    const s = entryScore(entry([{ w: 185, r: 5 }, { w: 185, r: 8 }]))
    expect(s.primary).toBe(185)
    expect(s.secondary).toBe(8)
  })

  it('scores reps_only on reps', () => {
    expect(entryScore(entry([{ r: 14, kind: 'reps_only' }])).primary).toBe(14)
  })

  it('scores time on seconds', () => {
    expect(entryScore(entry([{ s: 90, kind: 'time' }])).primary).toBe(90)
  })

  it('scores distance on metres', () => {
    expect(entryScore(entry([{ m: 60, kind: 'distance' }])).primary).toBe(60)
  })

  it('scores time_distance on distance, and treats faster as better', () => {
    const slow = entryScore(entry([{ m: 400, s: 90, kind: 'time_distance' }]))
    const fast = entryScore(entry([{ m: 400, s: 75, kind: 'time_distance' }]))
    expect(fast.primary).toBe(slow.primary)
    expect(fast.secondary).toBeGreaterThan(slow.secondary)
  })

  it('ignores warm-ups', () => {
    const s = entryScore(entry([{ w: 315, r: 1, warmup: true }, { w: 185, r: 5 }]))
    expect(s.primary).toBe(185)
  })
})

describe('per-kind accessors', () => {
  it('reads the best working seconds and metres', () => {
    const e = entry([{ s: 30, kind: 'time' }, { s: 75, kind: 'time' }])
    expect(topWorkingSeconds(e)).toBe(75)
    expect(topWorkingMetres(entry([{ m: 40, kind: 'distance' }]))).toBe(40)
  })

  it('is zero when the kind does not measure that unit', () => {
    expect(topWorkingSeconds(entry([{ w: 185, r: 5 }]))).toBe(0)
  })
})

/* ────────────────────────────────────────────────────────────────────
   The training this exists for: taekwondo and soccer. None of it is
   weight x reps, and none of it could be logged before.
   ──────────────────────────────────────────────────────────────────── */
describe('a real explosiveness session', () => {
  const session = entry([
    { s: 45, kind: 'time' },                       // plank
    { m: 30, kind: 'distance', perSide: true },    // single-arm carry
    { r: 8, kind: 'reps_only' },                   // box jumps
    { m: 20, s: 4, kind: 'time_distance' },        // sprint
    { w: 185, r: 5 },                              // squat
  ])

  it('logs every one of them', () => {
    expect(workingSets(session)).toHaveLength(5)
  })

  it('keeps each in its own unit rather than inventing a total', () => {
    const v = workingVolume(session)
    expect(v.load).toBe(925)      // the squat only
    expect(v.reps).toBe(8)        // the jumps only
    expect(v.seconds).toBe(49)    // plank + sprint
    expect(v.metres).toBe(80)     // carry doubled per side, plus the sprint
  })

  it('never produces a single combined number', () => {
    const v = workingVolume(session) as unknown as Record<string, unknown>
    expect(Object.keys(v).sort()).toEqual(['load', 'metres', 'reps', 'seconds'])
  })
})

describe('migration', () => {
  it('reads a pre-typed row as reps_weight with nothing rewritten', () => {
    const legacy = entry([{ r: 5 }, { r: 5 }], { kg: 185 })
    expect(entryKind(legacy)).toBe('reps_weight')
    expect(workingVolume(legacy).load).toBe(1850)
    // the stored rows still carry no kind — nothing was written back
    expect(legacy.sets!.every((s) => s.kind === undefined)).toBe(true)
  })
})
