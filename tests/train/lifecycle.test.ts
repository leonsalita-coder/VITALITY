import { describe, it, expect } from 'vitest'
import {
  sessionState, contributionOf, loggedSetCount, workingSetCount,
  countsForProgression, sameAsLastTime,
} from '../../lib/train/session'
import {
  DEFAULT_BAR_LB, defaultPlateConfig, loadableWeights, snapToLoadable, plateBreakdown,
} from '../../lib/train/plates'
import { suggestTarget } from '../../lib/train/progression'
import { detectPlateau } from '../../lib/train/deload'
import { currentWeekStreak } from '../../lib/train/streaks'
import type { HistoryEntry } from '../../lib/train/sets'

const sess = (over: any = {}) => ({
  date: '2026-09-19', off: false,
  ex: [{ log: [{ w: 185, r: 5 }, { w: 185, r: 5 }, null] }],
  ...over,
})

describe('session states', () => {
  const today = '2026-09-19'

  it('is not started with nothing logged', () => {
    expect(sessionState(sess({ ex: [{ log: [null, null] }] }), { today, finished: false })).toBe('not_started')
  })

  it('is in progress once something is logged today', () => {
    expect(sessionState(sess(), { today, finished: false })).toBe('in_progress')
  })

  it('is complete when finish was pressed', () => {
    expect(sessionState(sess(), { today, finished: true })).toBe('complete')
  })

  it('is abandoned only once the day has rolled over', () => {
    expect(sessionState(sess({ date: '2026-09-18' }), { today, finished: false })).toBe('abandoned')
  })

  it('stays in progress late on the same day — they may yet come back', () => {
    expect(sessionState(sess(), { today, finished: false })).toBe('in_progress')
  })

  it('is a rest day only when the athlete said so', () => {
    expect(sessionState(sess({ off: true }), { today, finished: false })).toBe('rest')
  })
})

describe('an empty session is not a rest day', () => {
  const today = '2026-09-19'

  it('keeps the two apart', () => {
    const empty = sessionState(sess({ ex: [{ log: [null] }] }), { today, finished: false })
    const rest = sessionState(sess({ off: true }), { today, finished: false })
    expect(empty).toBe('not_started')
    expect(rest).toBe('rest')
    expect(empty).not.toBe(rest)
  })

  it('and an abandoned day is neither', () => {
    expect(sessionState(sess({ date: '2026-09-01' }), { today, finished: false })).toBe('abandoned')
  })
})

describe('what an abandoned session contributes — the stated decision', () => {
  const abandoned = contributionOf('abandoned')

  it('counts toward volume, because the sets were performed', () => {
    expect(abandoned.volume).toBe(true)
  })

  it('counts toward plateau detection and records', () => {
    expect(abandoned.plateau).toBe(true)
    expect(abandoned.records).toBe(true)
  })

  it('does NOT count toward a streak — abandoning is not finishing', () => {
    expect(abandoned.streak).toBe(false)
  })

  it('does NOT earn a progression bump', () => {
    expect(abandoned.progression).toBe(false)
  })

  it('differs from complete on exactly those two things', () => {
    const complete = contributionOf('complete')
    expect(complete.streak).toBe(true)
    expect(complete.progression).toBe(true)
    expect(complete.volume).toBe(abandoned.volume)
    expect(complete.plateau).toBe(abandoned.plateau)
  })

  it('has a not-started session contribute nothing at all', () => {
    expect(contributionOf('not_started')).toEqual({
      volume: false, plateau: false, records: false, streak: false, progression: false,
    })
  })
})

describe('abandoned sessions through the real reads', () => {
  const clean = (date: string, w: number): HistoryEntry & { abandoned?: boolean } => ({
    date, kg: w, sets: [{ w, r: 5 }, { w, r: 5 }, { w, r: 5 }],
  })
  const at = (d: string) => new Date(`${d}T12:00:00`).getTime()

  it('does not bump progression off an unfinished session', () => {
    const history = [{ ...clean('2026-09-16', 185), abandoned: true }]
    const s = suggestTarget(history, { reps: 5, loading: 'barbell' }, at('2026-09-18'))
    expect(s.weight).toBe(185) // held, not 190
    expect(s.basis).toBe('miss')
  })

  it('still bumps off a finished one', () => {
    const s = suggestTarget([clean('2026-09-16', 185)], { reps: 5, loading: 'barbell' }, at('2026-09-18'))
    expect(s.weight).toBe(190)
  })

  it('still feeds plateau detection', () => {
    const stalled = ['2026-08-20', '2026-08-27', '2026-09-03', '2026-09-10']
      .map((d) => ({ ...clean(d, 185), abandoned: true }))
    expect(detectPlateau(stalled)).not.toBeNull()
  })

  it('does not feed the streak, which counts finished days only', () => {
    // finishedDates is what the streak reads, and an abandoned day never
    // enters it — so the streak is unchanged by one existing
    const finished = ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17']
    expect(currentWeekStreak(finished, 4, at('2026-09-19'))).toBe(1)
    expect(currentWeekStreak(finished, 5, at('2026-09-19'))).toBe(0)
  })

  it('treats a row with no flag as complete, so old history is unchanged', () => {
    expect(countsForProgression(clean('2026-09-16', 185))).toBe(true)
    expect(countsForProgression({ ...clean('2026-09-16', 185), abandoned: true })).toBe(false)
  })
})

describe('set counting', () => {
  it('counts logged sets including warm-ups', () => {
    const s = sess({ ex: [{ log: [{ w: 95, r: 5, warmup: true }, { w: 185, r: 5 }, null] }] })
    expect(loggedSetCount(s)).toBe(2)
  })

  it('counts working sets excluding warm-ups and misses', () => {
    const s = sess({ ex: [{ log: [{ w: 95, r: 5, warmup: true }, { w: 185, r: 0, fail: true }, { w: 185, r: 5 }] }] })
    expect(workingSetCount(s)).toBe(1)
  })
})

describe('plate math', () => {
  const config = defaultPlateConfig()

  it('starts from a bare bar', () => {
    expect(loadableWeights(config)).toContain(DEFAULT_BAR_LB)
  })

  it('never suggests a weight the rack cannot make', () => {
    for (const target of [182, 183, 187, 188, 191, 226, 314]) {
      const snapped = snapToLoadable(target, config)
      expect(plateBreakdown(snapped, config), `${target} -> ${snapped}`).not.toBeNull()
    }
  })

  it('snaps 187 to something real', () => {
    const snapped = snapToLoadable(187, config)
    expect([185, 190]).toContain(snapped)
  })

  it('breaks a total down into plates that add up', () => {
    const plates = plateBreakdown(225, config)!
    expect(plates).toEqual([45, 45])
    expect(DEFAULT_BAR_LB + plates.reduce((n, p) => n + p, 0) * 2).toBe(225)
  })

  it('returns an empty load for a bar-only lift', () => {
    expect(plateBreakdown(DEFAULT_BAR_LB, config)).toEqual([])
  })

  it('never goes below the bar', () => {
    expect(snapToLoadable(20, config)).toBe(DEFAULT_BAR_LB)
    expect(snapToLoadable(0, config)).toBe(DEFAULT_BAR_LB)
  })

  it('handles a different bar', () => {
    const womens = { barLb: 35, plates: [45, 25, 10, 5, 2.5] }
    expect(snapToLoadable(20, womens)).toBe(35)
    expect(plateBreakdown(snapToLoadable(120, womens), womens)).not.toBeNull()
  })

  it('handles a sparse plate set', () => {
    const sparse = { barLb: 45, plates: [45] }
    expect(loadableWeights(sparse).slice(0, 3)).toEqual([45, 135, 225])
    expect(snapToLoadable(100, sparse)).toBe(135)
  })

  it('handles no plates at all — the bar is the only option', () => {
    expect(loadableWeights({ barLb: 45, plates: [] })).toEqual([45])
    expect(snapToLoadable(200, { barLb: 45, plates: [] })).toBe(45)
  })

  it('breaks ties downward, because too heavy is a missed set', () => {
    // 187.5 is exactly between 185 and 190 on a 2.5 grid
    expect(snapToLoadable(187.5, { barLb: 45, plates: [45, 25, 10, 5, 2.5] })).toBeLessThanOrEqual(187.5)
  })
})

describe('same as last time', () => {
  const entry = (date: string, w: number, sets: number): HistoryEntry => ({
    date, kg: w, sets: Array.from({ length: sets }, () => ({ w, r: 8 })),
  })

  it('returns the previous working sets', () => {
    const out = sameAsLastTime([entry('2026-09-10', 135, 2), entry('2026-09-16', 145, 3)])!
    expect(out).toHaveLength(3)
    expect(out[0].weight).toBe(145)
    expect(out[0].reps).toBe(8)
  })

  it('is null on a lift with no history — nothing to repeat', () => {
    expect(sameAsLastTime([])).toBeNull()
  })

  it('is null when every past session was a rest day', () => {
    expect(sameAsLastTime([{ date: '2026-09-10', kg: 0, off: true }])).toBeNull()
  })

  it('is null when the only history has no working sets', () => {
    const warmOnly: HistoryEntry = {
      date: '2026-09-10', kg: 95, sets: [{ w: 95, r: 5, warmup: true }],
    }
    expect(sameAsLastTime([warmOnly])).toBeNull()
  })

  it('skips today, so it repeats the last session and not the current one', () => {
    const out = sameAsLastTime(
      [entry('2026-09-16', 145, 3), entry('2026-09-19', 999, 1)],
      { excludeDate: '2026-09-19' },
    )!
    expect(out[0].weight).toBe(145)
  })

  it('omits warm-ups — you repeat the work, not the ramp-up', () => {
    const mixed: HistoryEntry = {
      date: '2026-09-16', kg: 185,
      sets: [{ w: 95, r: 8, warmup: true }, { w: 185, r: 5 }, { w: 185, r: 5 }],
    }
    expect(sameAsLastTime([mixed])).toHaveLength(2)
  })

  it('carries the kind across for a non-weight lift', () => {
    const plank: HistoryEntry = {
      date: '2026-09-16', kg: 0, sets: [{ s: 60, kind: 'time' }, { s: 60, kind: 'time' }],
    }
    const out = sameAsLastTime([plank])!
    expect(out[0].kind).toBe('time')
    expect(out[0].seconds).toBe(60)
  })
})

describe('suggestions land on loadable weights', () => {
  const at = (d: string) => new Date(`${d}T12:00:00`).getTime()
  const hist = (w: number): HistoryEntry[] => [
    { date: '2026-09-16', kg: w, sets: [{ w, r: 5 }, { w, r: 5 }, { w, r: 5 }] },
  ]

  it('snaps a barbell bump to something the rack can build', () => {
    const plates = defaultPlateConfig()
    for (const start of [182, 183, 187, 188, 191]) {
      const s = suggestTarget(hist(start), { reps: 5, loading: 'barbell', plates }, at('2026-09-18'))
      expect(plateBreakdown(s.weight!, plates), `${start} -> ${s.weight}`).not.toBeNull()
    }
  })

  it('respects a sparse rack — only 45s available', () => {
    const sparse = { barLb: 45, plates: [45] }
    const s = suggestTarget(hist(135), { reps: 5, loading: 'barbell', plates: sparse }, at('2026-09-18'))
    expect([135, 225]).toContain(s.weight)
  })

  it('leaves non-barbell loading on the increment grid', () => {
    const s = suggestTarget(hist(50), { reps: 5, loading: 'dumbbell', plates: defaultPlateConfig() }, at('2026-09-18'))
    expect(s.weight).toBe(55)
  })

  it('behaves exactly as before when no rack is configured', () => {
    const s = suggestTarget(hist(185), { reps: 5, loading: 'barbell' }, at('2026-09-18'))
    expect(s.weight).toBe(190)
  })
})
