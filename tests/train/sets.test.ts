import { describe, it, expect } from 'vitest'
import {
  isWorkingSet,
  workingSets,
  setWeight,
  workingVolume,
  topWorkingWeight,
  topWorkingReps,
  topWorkingSeconds,
  topWorkingMetres,
  entryScore,
  workingRpe,
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

/**
 * sets.ts is the migration chokepoint.
 *
 * readableEntries is where `sessionId ?? date` will go, and everything
 * downstream — volume, scores, top weights, RPE — reads a session's sets
 * through the helpers in this file. 23 of its 83 mutations survived, so
 * the reads the migration will lean on were largely unpinned.
 *
 * Every assertion below is about a DECISION the module makes, not about
 * an arrangement of numbers: whether a bodyweight is usable, which limb
 * is the working one, which sets carry which unit, and what happens when
 * a field is absent rather than wrong.
 */
const set = (over: Record<string, unknown> = {}) => ({ w: 100, r: 5, ...over }) as never
const entryOf = (sets: unknown[], kg = 100): HistoryEntry =>
  ({ date: '2026-09-22', kg, sets } as never)

describe('a bodyweight is usable, or it is not', () => {
  /* Four guards say the same thing in two places, and every one of them
     decides whether a calisthenics lift scores on real load or falls
     back to counting reps. A zero or a stray string must fall back —
     scoring a pull-up at 0 lb makes every session a tie. */
  const pullups = entryOf([set({ w: 0, r: 8, kind: 'bodyweight' })], 0)

  it('uses a real bodyweight as load', () => {
    const v = workingVolume(pullups, { bodyweightLb: 180 })
    expect(v.load).toBe(180 * 8)
    expect(v.loadUnavailable).toBe(false)
  })

  it.each([
    ['zero', 0],
    ['negative', -180],
    ['not a number', '180' as never],
    ['absent', undefined],
  ])('refuses a bodyweight that is %s', (_label, bodyweightLb) => {
    const v = workingVolume(pullups, { bodyweightLb: bodyweightLb as never })
    expect(v.loadUnavailable).toBe(true)
    expect(v.load).toBe(0)
    expect(v.reps).toBe(8)
  })

  it('scales by a real factor', () => {
    /* A push-up lifts about two thirds of the athlete. */
    expect(workingVolume(pullups, { bodyweightLb: 180, bodyweightFactor: 0.65 }).load)
      .toBeCloseTo(117 * 8, 1)
  })

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['not a number', '0.65' as never],
  ])('falls back to the whole athlete on a factor that is %s', (_label, bodyweightFactor) => {
    expect(workingVolume(pullups, { bodyweightLb: 180, bodyweightFactor: bodyweightFactor as never }).load)
      .toBe(180 * 8)
  })
})

describe('the same rule, in the scoring path', () => {
  const pullups = entryOf([set({ w: 0, r: 8, kind: 'bodyweight' })], 0)

  it('scores on real load once a bodyweight is known', () => {
    const s = entryScore(pullups, { bodyweightLb: 180 })
    expect(s.primary).toBe(180)
    expect(s.secondary).toBe(8)
  })

  it.each([
    ['zero', 0],
    ['negative', -180],
    ['not a number', '180' as never],
  ])('scores on REPS when the bodyweight is %s', (_label, bodyweightLb) => {
    /* Reps are the only honest measure without a bodyweight, and the
       primary becoming a weight-shaped 0 would make every plateau
       detector read a flat line. */
    const s = entryScore(pullups, { bodyweightLb: bodyweightLb as never })
    expect(s.primary).toBe(8)
    expect(s.secondary).toBe(8)
  })

  it('adds the extra weight on a weighted bodyweight lift', () => {
    const weighted = entryOf([set({ w: 45, r: 5, kind: 'weighted_bodyweight' })], 45)
    expect(entryScore(weighted, { bodyweightLb: 180 }).primary).toBe(225)
  })

  it('does not add it on a plain bodyweight lift', () => {
    /* `kind === 'weighted_bodyweight' ? setWeight : 0` — reading the
       weight field on a plain bodyweight row would count assistance or
       a stray number as added load. */
    const plain = entryOf([set({ w: 45, r: 5, kind: 'bodyweight' })], 45)
    expect(entryScore(plain, { bodyweightLb: 180 }).primary).toBe(180)
  })

  it('scales the scored load by a real factor too', () => {
    /* entryScore recomputes bodyweightFactor validity independently of
       workingVolume, and reads it into the SAME bodyweightLoad call —
       so a real factor like a push-up's 0.65 must reach the scoring
       path, not just the volume total. */
    const pushups = entryOf([set({ w: 0, r: 10, kind: 'bodyweight' })], 0)
    const scaled = entryScore(pushups, { bodyweightLb: 180, bodyweightFactor: 0.65 })
    expect(scaled.primary).toBe(117)
  })
})

describe('per-limb sets', () => {
  it('takes the weaker side as the working weight', () => {
    const e = entryOf([set({ sides: { left: { w: 40, r: 8 }, right: { w: 45, r: 8 } } })])
    expect(setWeight(e, (e.sets as never[])[0])).toBe(40)
  })

  it('needs BOTH sides before it is a per-limb set', () => {
    /* One side alone is a malformed row, and reading it as per-limb
       would halve the volume of an ordinary set. */
    const onlyLeft = entryOf([set({ w: 100, r: 5, sides: { left: { w: 40, r: 8 } } })])
    expect(setWeight(onlyLeft, (onlyLeft.sets as never[])[0])).toBe(100)
  })

  it('treats a non-numeric side value as zero rather than NaN', () => {
    /* A NaN here reaches every total and loses every comparison
       silently. */
    const e = entryOf([set({ sides: { left: { w: 'forty' as never, r: 8 }, right: { w: 45, r: 8 } } })])
    expect(setWeight(e, (e.sets as never[])[0])).toBe(0)
    expect(Number.isFinite(workingVolume(e).load)).toBe(true)
  })

  it('treats NaN and Infinity as zero too, not just a string', () => {
    /* `typeof v === 'number' && Number.isFinite(v)` — a string fails
       BOTH halves and cannot tell `&&` from `||` apart. NaN and
       Infinity are typeof 'number' but not finite, so they only fail
       the second half: the one input shape that actually needs both
       checks to be an AND. Either one reaching a total silently loses
       every comparison against it. */
    const withNaN = entryOf([set({ sides: { left: { w: Number.NaN, r: 8 }, right: { w: 45, r: 8 } } })])
    expect(setWeight(withNaN, (withNaN.sets as never[])[0])).toBe(0)
    const withInf = entryOf([set({ sides: { left: { w: Number.POSITIVE_INFINITY, r: 8 }, right: { w: 45, r: 8 } } })])
    expect(setWeight(withInf, (withInf.sets as never[])[0])).toBe(0)
  })

  it('counts both limbs once each, not one doubled', () => {
    const e = entryOf([set({ sides: { left: { w: 40, r: 8 }, right: { w: 45, r: 8 } } })])
    expect(workingVolume(e).load).toBe(40 * 8 + 45 * 8)
  })
})

describe('which sets carry which unit', () => {
  it('reads seconds from timed sets only', () => {
    const mixed = entryOf([
      set({ s: 60, kind: 'time' }),
      set({ s: 999, kind: 'reps_weight' }),
    ])
    expect(topWorkingSeconds(mixed)).toBe(60)
  })

  it('reads seconds from a time_distance set too', () => {
    /* Both arms of the same filter: a row that carries time AND
       distance still has a time worth reading. */
    expect(topWorkingSeconds(entryOf([set({ s: 600, m: 2000, kind: 'time_distance' })]))).toBe(600)
  })

  it('reads metres from distance sets only', () => {
    const mixed = entryOf([
      set({ m: 2000, kind: 'distance' }),
      set({ m: 999, kind: 'reps_weight' }),
    ])
    expect(topWorkingMetres(mixed)).toBe(2000)
  })

  it('reads metres from a time_distance set too', () => {
    expect(topWorkingMetres(entryOf([set({ s: 600, m: 5000, kind: 'time_distance' })]))).toBe(5000)
  })
})

describe('scoring a session that is missing a field', () => {
  it('scores reps_only on its reps, in both slots', () => {
    /* primary and secondary are the SAME expression, `s.r || 0`, but
       two separate occurrences in the source at different offsets — a
       mutation to one does not touch the other, so checking only
       primary leaves secondary's copy completely unwatched. */
    const s = entryScore(entryOf([set({ r: 12, kind: 'reps_only' })]))
    expect(s.primary).toBe(12)
    expect(s.secondary).toBe(12)
  })

  it('reads an absent rep count as zero rather than NaN', () => {
    const s = entryScore(entryOf([set({ r: undefined, kind: 'reps_only' })]))
    expect(s.primary).toBe(0)
    expect(Number.isNaN(s.primary)).toBe(false)
  })

  it('scores a timed session on its longest hold', () => {
    expect(entryScore(entryOf([set({ s: 45, kind: 'time' }), set({ s: 60, kind: 'time' })])).primary)
      .toBe(60)
  })

  it('scores time_distance on distance, and negates the time so faster is better', () => {
    const e = entryOf([set({ m: 5000, s: 1500, kind: 'time_distance' })])
    const s = entryScore(e)
    expect(s.primary).toBe(5000)
    expect(s.secondary).toBe(-1500)
  })

  it('reports no time rather than minus infinity when none was logged', () => {
    /* `Math.min(...sets.map(s => s.s || Infinity))` — an Infinity that
       escaped would make every later comparison against it true. */
    const s = entryScore(entryOf([set({ m: 5000, s: undefined, kind: 'time_distance' })]))
    expect(s.secondary).toBe(0)
  })

  it('falls back to the entry weight when nothing was worked', () => {
    /* A legacy row with no per-set weights keeps reading the way it
       always did. */
    expect(entryScore(entryOf([], 225)).primary).toBe(225)
  })

  it('reads an absent entry weight as zero', () => {
    /* Built directly: entryOf defaults kg, which would hide this. */
    const bare = { date: '2026-09-22', sets: [] } as never
    expect(entryScore(bare).primary).toBe(0)
  })

  it('scores an assisted session on the LEAST help, negated', () => {
    const e = entryOf([set({ w: 40, r: 5, assisted: true }), set({ w: 20, r: 5, assisted: true })])
    const scored = entryScore(e)
    expect(scored.primary).toBe(-20)
    /* The rep count travels in `secondary` even on the assisted branch,
       and it is its own `s.r || 0` occurrence — unwatched by asserting
       primary alone. */
    expect(scored.secondary).toBe(5)
  })
})

describe('mean RPE across the sets that carry one', () => {
  it('averages the ones that have it', () => {
    expect(workingRpe(entryOf([set({ rpe: 8 }), set({ rpe: 9 })]))).toBe(8.5)
  })

  it('ignores a set with no RPE rather than counting it as zero', () => {
    expect(workingRpe(entryOf([set({ rpe: 8 }), set({})]))).toBe(8)
  })

  it('ignores a value that is not a finite number', () => {
    /* Both halves of the filter: a string passes typeof, a NaN passes
       nothing, and either one reaching the mean poisons it. */
    expect(workingRpe(entryOf([set({ rpe: 8 }), set({ rpe: Number.NaN })]))).toBe(8)
    expect(workingRpe(entryOf([set({ rpe: 8 }), set({ rpe: '9' as never })]))).toBe(8)
  })

  it('says nothing when no set carried one', () => {
    expect(workingRpe(entryOf([set({}), set({})]))).toBeNull()
    /* Beside it, one that does carry one reads. */
    expect(workingRpe(entryOf([set({ rpe: 7 })]))).toBe(7)
  })
})
