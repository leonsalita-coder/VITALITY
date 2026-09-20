import { describe, it, expect } from 'vitest'
import { weekIndexer, bestE1rm, weeklyBestE1rm, weeklyRelativeChange } from '../../lib/train/liftweeks'
import type { HistoryEntry } from '../../lib/train/sets'

/**
 * A lift's week-by-week progress, which two findings both depend on.
 *
 * Minimum effective dose averages this across the lifts that train a
 * muscle; transfer between lifts correlates one lift's against another's.
 * They used to compute it separately, which is two answers to "did this
 * lift go up this week" and how two findings come to disagree about the
 * same history.
 */

const day = (back: number) => {
  const d = new Date(2026, 8, 19 - back)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const NOW = new Date(2026, 8, 19, 12).getTime()
const weekOf = weekIndexer(NOW)

const session = (back: number, sets: Array<{ w: number; r: number; warmup?: boolean }>): HistoryEntry =>
  ({ date: day(back), kg: sets[0]?.w ?? 0, sets })

describe('which week a session belongs to', () => {
  it('puts today in week zero', () => {
    expect(weekOf(day(0))).toBe(0)
  })

  it('puts six days ago in week zero and seven days ago in week one', () => {
    expect(weekOf(day(6))).toBe(0)
    expect(weekOf(day(7))).toBe(1)
  })

  it('counts older sessions as larger numbers', () => {
    expect(weekOf(day(70))).toBe(10)
  })

  it('gives a future session a negative week', () => {
    /* Not filtered here. Callers decide what a future-dated row means,
       and hiding it inside the indexer would make it undetectable. */
    expect(weekOf(day(-7))).toBeLessThan(0)
  })

  it('never reads the clock', () => {
    /* Built from `now`, like everything else in this engine — it is what
       lets a finding be replayed over a history that has not happened. */
    const other = weekIndexer(new Date(2027, 0, 1, 12).getTime())
    expect(other(day(0))).not.toBe(weekOf(day(0)))
  })
})

describe('the best estimate a session produced', () => {
  it('takes the heaviest working set, not the first', () => {
    expect(bestE1rm(session(0, [{ w: 100, r: 5 }, { w: 200, r: 5 }]))).toBeGreaterThan(200)
  })

  it('takes the heaviest working set, not the last', () => {
    expect(bestE1rm(session(0, [{ w: 200, r: 5 }, { w: 100, r: 5 }]))).toBeGreaterThan(200)
  })

  it('ranks more reps at the same weight above fewer', () => {
    /* Five at 200 is progress over three at 200, and a weight-only
       measure would call that a flat week. */
    const more = bestE1rm(session(0, [{ w: 200, r: 5 }])) as number
    const fewer = bestE1rm(session(0, [{ w: 200, r: 3 }])) as number
    expect(more).toBeGreaterThan(fewer)
  })

  it('ignores warm-up sets', () => {
    const withWarmup = bestE1rm(session(0, [{ w: 400, r: 5, warmup: true }, { w: 200, r: 5 }])) as number
    const without = bestE1rm(session(0, [{ w: 200, r: 5 }])) as number
    expect(withWarmup).toBe(without)
  })

  it('returns null for a set carrying no load', () => {
    expect(bestE1rm(session(0, [{ w: 0, r: 8 }]))).toBeNull()
    /* The control: the same shape WITH load does produce an estimate, so
       the null above is the missing weight and nothing else. The rep
       count has to stay inside the range an estimate is defined over —
       the first version used twenty reps, which is refused whatever the
       weight, so it was not isolating the thing it claimed to. */
    expect(bestE1rm(session(0, [{ w: 50, r: 8 }]))).not.toBeNull()
  })

  it('returns null for a session with no sets', () => {
    expect(bestE1rm(session(0, []))).toBeNull()
  })

  it('returns null for a session marked off', () => {
    expect(bestE1rm({ ...session(0, [{ w: 200, r: 5 }]), off: true })).toBeNull()
    expect(bestE1rm(session(0, [{ w: 200, r: 5 }]))).not.toBeNull()
  })

  it('returns null rather than throwing on nothing at all', () => {
    expect(bestE1rm(null)).toBeNull()
    expect(bestE1rm(undefined)).toBeNull()
  })
})

describe('the best each week carried', () => {
  it('keeps the best of several sessions in the same week', () => {
    const best = weeklyBestE1rm([
      session(0, [{ w: 100, r: 5 }]),
      session(2, [{ w: 300, r: 5 }]),
    ], weekOf)
    expect(best.get(0)).toBeGreaterThan(300)
  })

  it('keeps weeks apart', () => {
    const best = weeklyBestE1rm([
      session(0, [{ w: 100, r: 5 }]),
      session(7, [{ w: 300, r: 5 }]),
    ], weekOf)
    expect(best.size).toBe(2)
    expect(best.get(0)).toBeLessThan(best.get(1) as number)
  })

  it('skips entries with no date', () => {
    const best = weeklyBestE1rm([{ date: '', kg: 200, sets: [{ w: 200, r: 5 }] }], weekOf)
    expect(best.size).toBe(0)
  })

  it('skips weeks that produced no estimate', () => {
    expect(weeklyBestE1rm([session(0, [{ w: 0, r: 8 }])], weekOf).size).toBe(0)
    expect(weeklyBestE1rm([session(0, [{ w: 90, r: 8 }])], weekOf).size).toBe(1)
  })

  it('survives nothing at all', () => {
    expect(weeklyBestE1rm(null, weekOf).size).toBe(0)
  })
})

describe('how much it moved, week over week', () => {
  it('reports the fraction gained, not the pounds', () => {
    /* A press and a squat cannot be averaged or correlated in pounds;
       five pounds is a fortnight on one and a session on the other. */
    const change = weeklyRelativeChange([
      session(7, [{ w: 100, r: 1 }]),
      session(0, [{ w: 110, r: 1 }]),
    ], weekOf)
    expect(change.get(0)).toBeCloseTo(0.1, 5)
  })

  it('reports a drop as negative', () => {
    const change = weeklyRelativeChange([
      session(7, [{ w: 100, r: 1 }]),
      session(0, [{ w: 90, r: 1 }]),
    ], weekOf)
    expect(change.get(0)).toBeCloseTo(-0.1, 5)
  })

  it('gives the oldest week no change, having nothing before it', () => {
    const change = weeklyRelativeChange([
      session(7, [{ w: 100, r: 1 }]),
      session(0, [{ w: 110, r: 1 }]),
    ], weekOf)
    expect(change.has(1)).toBe(false)
    expect(change.has(0)).toBe(true)
  })

  it('measures against the last week TRAINED, not the calendar week before', () => {
    /* Somebody who trains a movement every third week is still
       progressing on it. Treating the blank weeks as zero would report
       them as stalled, and treating the gap as several steps would
       divide their progress by three. */
    const change = weeklyRelativeChange([
      session(21, [{ w: 100, r: 1 }]),
      session(0, [{ w: 110, r: 1 }]),
    ], weekOf)
    expect(change.size).toBe(1)
    expect(change.get(0)).toBeCloseTo(0.1, 5)
  })

  it('reports no change for a week that held', () => {
    const change = weeklyRelativeChange([
      session(7, [{ w: 100, r: 1 }]),
      session(0, [{ w: 100, r: 1 }]),
    ], weekOf)
    expect(change.get(0)).toBe(0)
  })

  it('produces nothing from a single week', () => {
    expect(weeklyRelativeChange([session(0, [{ w: 100, r: 1 }])], weekOf).size).toBe(0)
  })

  it('never produces a change keyed on nothing', () => {
    /* An index-walked version of this read one past the end and stored a
       change against `undefined` with a value of NaN — a row no lookup
       would ever ask for, and nothing would ever see. */
    const change = weeklyRelativeChange([
      session(21, [{ w: 100, r: 1 }]),
      session(14, [{ w: 105, r: 1 }]),
      session(7, [{ w: 110, r: 1 }]),
      session(0, [{ w: 115, r: 1 }]),
    ], weekOf)
    for (const [week, value] of change) {
      expect(Number.isFinite(week)).toBe(true)
      expect(Number.isFinite(value)).toBe(true)
    }
    expect(change.size).toBe(3)
  })

  it('survives nothing at all', () => {
    expect(weeklyRelativeChange(null, weekOf).size).toBe(0)
  })
})
