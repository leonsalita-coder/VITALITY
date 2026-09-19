import { describe, it, expect } from 'vitest'
import {
  isWorkingSet,
  workingSets,
  setWeight,
  workingVolume,
  topWorkingWeight,
  topWorkingReps,
} from '../../lib/train/sets'
import type { HistoryEntry } from '../../lib/train/sets'

/**
 * Weights are POUNDS throughout — the stored field is named `kg` for
 * historical reasons. No conversion exists anywhere in this system.
 *
 * A session entry records one top weight plus a set list. Newer sets carry
 * their own `w`; older ones do not, and fall back to the entry's weight.
 * An absent `warmup` means false, which is how existing history migrates
 * without anything being rewritten or guessed at.
 */

/** Two warm-ups at 95 and 135, then three working sets at 185. */
const mixed: HistoryEntry = {
  date: '2026-09-16',
  kg: 185,
  sets: [
    { w: 95, r: 8, warmup: true },
    { w: 135, r: 5, warmup: true },
    { w: 185, r: 5 },
    { w: 185, r: 5 },
    { w: 185, r: 4 },
  ],
}

describe('isWorkingSet', () => {
  it('counts a plain logged set', () => {
    expect(isWorkingSet({ w: 185, r: 5 })).toBe(true)
  })

  it('rejects a warm-up', () => {
    expect(isWorkingSet({ w: 95, r: 8, warmup: true })).toBe(false)
  })

  it('rejects a missed set', () => {
    expect(isWorkingSet({ w: 185, r: 0, fail: true })).toBe(false)
  })

  it('treats a set with no warmup field as working — existing history', () => {
    expect(isWorkingSet({ r: 5 })).toBe(true)
  })

  it('never guesses a warm-up from a light weight', () => {
    // 95 lb next to 185 lb working sets is *probably* a warm-up, and we
    // still do not say so: only an explicit flag counts.
    expect(isWorkingSet({ w: 95, r: 8 })).toBe(true)
  })
})

describe('workingSets', () => {
  it('drops warm-ups and misses, keeps the rest', () => {
    expect(workingSets(mixed)).toHaveLength(3)
  })

  it('leaves the stored set list untouched — history keeps warm-ups', () => {
    workingSets(mixed)
    expect(mixed.sets).toHaveLength(5)
  })

  it('handles an entry with no sets at all', () => {
    expect(workingSets({ date: '2026-09-16', kg: 100 })).toEqual([])
  })
})

describe('setWeight', () => {
  it('prefers the set’s own weight', () => {
    expect(setWeight(mixed, { w: 95, r: 8 })).toBe(95)
  })

  it('falls back to the entry weight for older rows that lack one', () => {
    const legacy: HistoryEntry = { date: '2026-09-16', kg: 185, sets: [{ r: 5 }] }
    expect(setWeight(legacy, legacy.sets![0])).toBe(185)
  })
})

describe('workingVolume', () => {
  it('counts only the working sets', () => {
    // 185x5 + 185x5 + 185x4 = 2590, with the two warm-ups excluded
    expect(workingVolume(mixed).load).toBe(2590)
  })

  it('would have been inflated by the warm-ups', () => {
    const everything = (mixed.sets || []).reduce(
      (sum, s) => sum + setWeight(mixed, s) * (s.r || 0),
      0,
    )
    expect(everything).toBeGreaterThan(workingVolume(mixed).load)
  })

  it('doubles a per-side lift', () => {
    const entry: HistoryEntry = { date: '2026-09-16', kg: 40, sets: [{ w: 40, r: 10 }] }
    expect(workingVolume(entry, { perSide: true }).load).toBe(800)
  })

  it('is zero for a session of nothing but warm-ups', () => {
    const warmOnly: HistoryEntry = {
      date: '2026-09-16', kg: 95,
      sets: [{ w: 95, r: 8, warmup: true }, { w: 95, r: 8, warmup: true }],
    }
    expect(workingVolume(warmOnly).load).toBe(0)
  })
})

describe('topWorkingWeight / topWorkingReps', () => {
  it('ignores warm-ups when finding the top weight', () => {
    const heavyWarmup: HistoryEntry = {
      date: '2026-09-16', kg: 185,
      sets: [{ w: 225, r: 1, warmup: true }, { w: 185, r: 5 }],
    }
    expect(topWorkingWeight(heavyWarmup)).toBe(185)
  })

  it('reports the best working rep count', () => {
    expect(topWorkingReps(mixed)).toBe(5)
  })

  it('is zero when nothing was worked', () => {
    expect(topWorkingWeight({ date: '2026-09-16', kg: 0 })).toBe(0)
    expect(topWorkingReps({ date: '2026-09-16', kg: 0 })).toBe(0)
  })
})
