import { describe, it, expect } from 'vitest'
import { suggestTarget, LAYOFF_DAYS } from '../../lib/train/progression'
import type { HistoryEntry, ProgressionExercise } from '../../lib/train/progression'

/**
 * Every weight here is POUNDS. The field is named `kg` because that is what
 * the tile's stored records call it — there is no unit conversion anywhere
 * in this system and none is being introduced.
 */

/** Local noon on a given day — avoids DST edges without mocking a clock. */
const at = (day: string) => new Date(`${day}T12:00:00`).getTime()

const ex = (over: Partial<ProgressionExercise> = {}): ProgressionExercise => ({
  kg: 135,
  lastKg: null,
  reps: 8,
  sets: 3,
  ...over,
})

/** A session where every set hit its target. */
const clean = (date: string, kg: number, reps = 8, sets = 3): HistoryEntry => ({
  date,
  kg,
  sets: Array.from({ length: sets }, () => ({ r: reps })),
})

describe('basis: new', () => {
  it('starts from the exercise weight when there is no history at all', () => {
    const s = suggestTarget([], ex({ kg: 135 }), at('2026-09-18'))
    expect(s.basis).toBe('new')
    expect(s.weight).toBe(135)
    expect(s.reason).toBe('starting at 135 lb — first time logging this')
  })

  it('prefers a carried-over last weight when one exists', () => {
    const s = suggestTarget([], ex({ kg: 135, lastKg: 155 }), at('2026-09-18'))
    expect(s.basis).toBe('new')
    expect(s.weight).toBe(155)
  })

  it('treats a history of nothing but rest days as no history', () => {
    const history: HistoryEntry[] = [{ date: '2026-09-10', kg: 0, off: true }]
    const s = suggestTarget(history, ex({ kg: 95 }), at('2026-09-18'))
    expect(s.basis).toBe('new')
    expect(s.weight).toBe(95)
  })
})

describe('basis: clean', () => {
  it('bumps and names the session that earned it', () => {
    const s = suggestTarget([clean('2026-09-16', 135, 8, 3)], ex({ reps: 8 }), at('2026-09-18'))
    expect(s.basis).toBe('clean')
    expect(s.weight).toBe(140)
    expect(s.reason).toBe('+5 lb — clean 3×8 last time')
  })

  it('uses a 2.5 lb step in the middleweight range', () => {
    const s = suggestTarget([clean('2026-09-16', 50, 10, 3)], ex({ reps: 10 }), at('2026-09-18'))
    expect(s.weight).toBe(52.5)
    expect(s.reason).toBe('+2.5 lb — clean 3×10 last time')
  })

  it('uses a 1 lb step on light accessory work', () => {
    const s = suggestTarget([clean('2026-09-16', 20, 12, 4)], ex({ reps: 12 }), at('2026-09-18'))
    expect(s.weight).toBe(21)
    expect(s.reason).toBe('+1 lb — clean 4×12 last time')
  })

  it('counts beating the rep target as clean', () => {
    const over: HistoryEntry = { date: '2026-09-16', kg: 135, sets: [{ r: 10 }, { r: 9 }, { r: 8 }] }
    const s = suggestTarget([over], ex({ reps: 8 }), at('2026-09-18'))
    expect(s.basis).toBe('clean')
    expect(s.weight).toBe(140)
  })

  it('reads the most recent session, not the first', () => {
    const history = [clean('2026-09-02', 115), clean('2026-09-16', 135)]
    const s = suggestTarget(history, ex({ reps: 8 }), at('2026-09-18'))
    expect(s.weight).toBe(140)
  })

  it('holds a bodyweight lift at zero rather than inventing load', () => {
    const s = suggestTarget([clean('2026-09-16', 0, 12, 3)], ex({ kg: 0, reps: 12 }), at('2026-09-18'))
    expect(s.weight).toBe(0)
    expect(s.basis).toBe('clean')
    expect(s.reason).toBe('bodyweight — clean 3×12 last time')
  })
})

describe('basis: miss', () => {
  it('holds after a failed set and says so', () => {
    const missed: HistoryEntry = { date: '2026-09-16', kg: 185, sets: [{ r: 5 }, { r: 5 }, { r: 0, fail: true }] }
    const s = suggestTarget([missed], ex({ reps: 5 }), at('2026-09-18'))
    expect(s.basis).toBe('miss')
    expect(s.weight).toBe(185)
    expect(s.reason).toBe('holding at 185 lb — missed the last set')
  })

  it('holds when every set was logged but came up short of target', () => {
    const short: HistoryEntry = { date: '2026-09-16', kg: 185, sets: [{ r: 5 }, { r: 4 }, { r: 3 }] }
    const s = suggestTarget([short], ex({ reps: 5 }), at('2026-09-18'))
    expect(s.basis).toBe('miss')
    expect(s.weight).toBe(185)
    expect(s.reason).toBe('holding at 185 lb — short of 5 reps last time')
  })

  it('treats a session with no sets recorded as nothing to progress from', () => {
    const empty: HistoryEntry = { date: '2026-09-16', kg: 185, sets: [] }
    const s = suggestTarget([empty], ex({ reps: 5 }), at('2026-09-18'))
    expect(s.basis).toBe('miss')
    expect(s.weight).toBe(185)
  })
})

describe('basis: layoff', () => {
  it('scales back and names the gap', () => {
    const s = suggestTarget([clean('2026-08-31', 135)], ex({ reps: 8 }), at('2026-09-18'))
    expect(s.basis).toBe('layoff')
    expect(s.weight).toBe(130)
    expect(s.reason).toBe('back to 130 lb — first session after 18 days off')
  })

  it('scales back further the longer the gap', () => {
    const short = suggestTarget([clean('2026-08-31', 200)], ex({ reps: 8 }), at('2026-09-18'))
    const long = suggestTarget([clean('2026-05-01', 200)], ex({ reps: 8 }), at('2026-09-18'))
    expect(long.weight!).toBeLessThan(short.weight!)
    expect(long.basis).toBe('layoff')
  })

  it('does not trigger one day before the threshold', () => {
    const day = new Date(at('2026-09-18'))
    day.setDate(day.getDate() - (LAYOFF_DAYS - 1))
    const last = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
    const s = suggestTarget([clean(last, 135)], ex({ reps: 8 }), at('2026-09-18'))
    expect(s.basis).toBe('clean')
  })

  it('triggers exactly at the threshold', () => {
    const day = new Date(at('2026-09-18'))
    day.setDate(day.getDate() - LAYOFF_DAYS)
    const last = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
    const s = suggestTarget([clean(last, 135)], ex({ reps: 8 }), at('2026-09-18'))
    expect(s.basis).toBe('layoff')
  })

  it('outranks a miss — time off explains the miss', () => {
    const missed: HistoryEntry = { date: '2026-08-31', kg: 185, sets: [{ r: 5 }, { r: 0, fail: true }] }
    const s = suggestTarget([missed], ex({ reps: 5 }), at('2026-09-18'))
    expect(s.basis).toBe('layoff')
  })

  it('never scales a bodyweight lift below zero', () => {
    const s = suggestTarget([clean('2026-05-01', 0, 12)], ex({ kg: 0, reps: 12 }), at('2026-09-18'))
    expect(s.weight).toBe(0)
  })
})

describe('basis: deload', () => {
  const deloading = {
    state: 'deloading', kind: 'intensity', priorWeight: 185,
    since: '2026-09-16', sessions: 0, confidence: 'measured',
  }

  it('reports a live deload as the deload basis', () => {
    const s = suggestTarget([clean('2026-09-16', 165)], ex({ reps: 5, deload: deloading as never }), at('2026-09-18'))
    expect(s.basis).toBe('deload')
  })

  it('outranks a layoff — a live prescription beats an inference', () => {
    const s = suggestTarget([clean('2026-05-01', 185)], ex({ reps: 5, deload: deloading as never }), at('2026-09-18'))
    expect(s.basis).toBe('deload')
  })
})

describe('purity', () => {
  it('reads the day only from `now`, never from the clock', () => {
    const history = [clean('2026-09-16', 135)]
    const soon = suggestTarget(history, ex({ reps: 8 }), at('2026-09-18'))
    const muchLater = suggestTarget(history, ex({ reps: 8 }), at('2027-09-18'))
    expect(soon.basis).toBe('clean')
    expect(muchLater.basis).toBe('layoff')
  })

  it('does not mutate what it is given', () => {
    const history = [clean('2026-09-16', 135)]
    const snapshot = JSON.stringify(history)
    const e = ex({ reps: 8 })
    const eSnapshot = JSON.stringify(e)
    suggestTarget(history, e, at('2026-09-18'))
    expect(JSON.stringify(history)).toBe(snapshot)
    expect(JSON.stringify(e)).toBe(eSnapshot)
  })

  it('ignores rest days when finding the last real session', () => {
    const history: HistoryEntry[] = [
      clean('2026-09-16', 135),
      { date: '2026-09-17', kg: 0, off: true },
    ]
    const s = suggestTarget(history, ex({ reps: 8 }), at('2026-09-18'))
    expect(s.basis).toBe('clean')
    expect(s.weight).toBe(140)
  })

  it('always returns a non-empty reason for every basis', () => {
    const cases = [
      suggestTarget([], ex(), at('2026-09-18')),
      suggestTarget([clean('2026-09-16', 135)], ex(), at('2026-09-18')),
      suggestTarget([{ date: '2026-09-16', kg: 135, sets: [{ r: 0, fail: true }] }], ex(), at('2026-09-18')),
      suggestTarget([clean('2026-05-01', 135)], ex(), at('2026-09-18')),
      suggestTarget([clean('2026-09-16', 135)], ex({ deload: { state: 'deloading', kind: 'intensity', priorWeight: 135, since: '2026-09-16', sessions: 0, confidence: 'measured' } as never }), at('2026-09-18')),
    ]
    const bases = cases.map((c) => c.basis)
    expect(new Set(bases)).toEqual(new Set(['new', 'clean', 'miss', 'layoff', 'deload']))
    for (const c of cases) expect(c.reason.length).toBeGreaterThan(0)
  })
})

/* ────────────────────────────────────────────────────────────────────
   Layoff ramp — a drop is not a one-off. Coming back, the lifter holds
   the reduced weight once and then climbs back to where they were over
   two or three sessions rather than jumping.
   ──────────────────────────────────────────────────────────────────── */
describe('layoff ramp', () => {
  const bar = (over: Partial<ProgressionExercise> = {}) =>
    ex({ reps: 5, loading: 'barbell', ...over })

  it('walks drop → hold → back across the full return', () => {
    const history: HistoryEntry[] = [clean('2026-08-31', 135, 5)]

    // first session back after 18 days
    const s0 = suggestTarget(history, bar(), at('2026-09-18'))
    expect(s0.basis).toBe('layoff')
    expect(s0.weight).toBe(130)
    expect(s0.reason).toBe('back to 130 lb — first session after 18 days off')

    // they log it, and come back the next day
    history.push(clean('2026-09-18', 130, 5))
    const s1 = suggestTarget(history, bar(), at('2026-09-19'))
    expect(s1.basis).toBe('layoff')
    expect(s1.weight).toBe(130)
    expect(s1.reason).toBe('holding at 130 lb — second session back')

    // third session climbs back to the old working weight
    history.push(clean('2026-09-19', 130, 5))
    const s2 = suggestTarget(history, bar(), at('2026-09-21'))
    expect(s2.basis).toBe('layoff')
    expect(s2.weight).toBe(135)
    expect(s2.reason).toBe('+5 lb — easing back to your 135 lb working weight')

    // ramp is over; normal progression resumes from there
    history.push(clean('2026-09-21', 135, 5))
    const s3 = suggestTarget(history, bar(), at('2026-09-23'))
    expect(s3.basis).toBe('clean')
    expect(s3.weight).toBe(140)
  })

  it('takes more steps back after a longer absence', () => {
    const history: HistoryEntry[] = [clean('2026-05-01', 200, 5)]
    const weights: number[] = []
    const dates = ['2026-09-18', '2026-09-20', '2026-09-22', '2026-09-24', '2026-09-26']
    for (const date of dates) {
      const s = suggestTarget(history, bar(), at(date))
      weights.push(s.weight!)
      history.push(clean(date, s.weight!, 5))
    }
    // drop, hold, climb, climb — never jumping straight back
    expect(weights[0]).toBe(140)
    expect(weights[1]).toBe(140)
    expect(weights[2]).toBe(170)
    expect(weights[3]).toBe(200)
    expect(weights[4]).toBe(205) // ramp done, normal progression
  })

  it('never overshoots the weight the lifter was already working at', () => {
    const history: HistoryEntry[] = [clean('2026-05-01', 200, 5)]
    const dates = ['2026-09-18', '2026-09-20', '2026-09-22', '2026-09-24']
    for (const date of dates) {
      const s = suggestTarget(history, bar(), at(date))
      expect(s.weight!).toBeLessThanOrEqual(200)
      history.push(clean(date, s.weight!, 5))
    }
  })

  it('stops ramping and holds when a set is missed on the way back', () => {
    const history: HistoryEntry[] = [
      clean('2026-08-31', 135, 5),
      { date: '2026-09-18', kg: 130, sets: [{ r: 5 }, { r: 0, fail: true }] },
    ]
    const s = suggestTarget(history, bar(), at('2026-09-19'))
    expect(s.basis).toBe('miss')
    expect(s.weight).toBe(130)
  })

  it('still lets time off excuse a miss on the very first session back', () => {
    const history: HistoryEntry[] = [
      { date: '2026-08-31', kg: 135, sets: [{ r: 5 }, { r: 0, fail: true }] },
    ]
    const s = suggestTarget(history, bar(), at('2026-09-18'))
    expect(s.basis).toBe('layoff')
  })
})

/* ────────────────────────────────────────────────────────────────────
   Double progression — reps climb within a range before weight moves.
   ──────────────────────────────────────────────────────────────────── */
describe('double progression', () => {
  const threeByEightToTen = (over: Partial<ProgressionExercise> = {}) =>
    ex({ reps: 8, repRange: [8, 10] as [number, number], sets: 3, loading: 'barbell', ...over })

  it('walks the whole range before touching the bar', () => {
    const history: HistoryEntry[] = [clean('2026-09-10', 135, 8, 3)]

    const a = suggestTarget(history, threeByEightToTen(), at('2026-09-12'))
    expect(a.basis).toBe('clean')
    expect(a.weight).toBe(135)
    expect(a.reps).toBe(9)
    expect(a.reason).toBe('same weight, chase 9 reps — hit 3×8 last time')

    history.push(clean('2026-09-12', 135, 9, 3))
    const b = suggestTarget(history, threeByEightToTen(), at('2026-09-14'))
    expect(b.weight).toBe(135)
    expect(b.reps).toBe(10)
    expect(b.reason).toBe('same weight, chase 10 reps — hit 3×9 last time')

    history.push(clean('2026-09-14', 135, 10, 3))
    const c = suggestTarget(history, threeByEightToTen(), at('2026-09-16'))
    expect(c.weight).toBe(140)
    expect(c.reps).toBe(8)
    expect(c.reason).toBe('+5 lb, back to 8 reps — hit 3×10 last time')

    history.push(clean('2026-09-16', 140, 8, 3))
    const d = suggestTarget(history, threeByEightToTen(), at('2026-09-18'))
    expect(d.weight).toBe(140)
    expect(d.reps).toBe(9)
  })

  it('advances only as far as the weakest set', () => {
    const uneven: HistoryEntry = { date: '2026-09-16', kg: 135, sets: [{ r: 10 }, { r: 10 }, { r: 8 }] }
    const s = suggestTarget([uneven], threeByEightToTen(), at('2026-09-18'))
    expect(s.weight).toBe(135)
    expect(s.reps).toBe(9)
  })

  it('holds when the bottom of the range was not reached', () => {
    const short: HistoryEntry = { date: '2026-09-16', kg: 135, sets: [{ r: 8 }, { r: 7 }, { r: 6 }] }
    const s = suggestTarget([short], threeByEightToTen(), at('2026-09-18'))
    expect(s.basis).toBe('miss')
    expect(s.weight).toBe(135)
    expect(s.reps).toBe(8)
  })

  it('starts a brand new lift at the bottom of its range', () => {
    const s = suggestTarget([], threeByEightToTen({ kg: 95 }), at('2026-09-18'))
    expect(s.basis).toBe('new')
    expect(s.reps).toBe(8)
  })

  it('keeps linear behaviour, and its wording, when no range is set', () => {
    const s = suggestTarget([clean('2026-09-16', 135, 8, 3)], ex({ reps: 8 }), at('2026-09-18'))
    expect(s.weight).toBe(140)
    expect(s.reps).toBe(8)
    expect(s.reason).toBe('+5 lb — clean 3×8 last time')
  })
})

/* ────────────────────────────────────────────────────────────────────
   Loading — a suggestion nobody can actually load is a bug.
   ──────────────────────────────────────────────────────────────────── */
describe('loadable weights', () => {
  const lastAt = (kg: number) => [clean('2026-09-16', kg, 8, 3)]

  it('never suggests a barbell weight off the 5 lb grid', () => {
    for (const start of [182, 183, 187, 188, 191]) {
      const s = suggestTarget(lastAt(start), ex({ reps: 8, loading: 'barbell' }), at('2026-09-18'))
      expect(s.weight! % 5).toBe(0)
    }
  })

  it('moves dumbbells in whole pair steps', () => {
    const s = suggestTarget(lastAt(47), ex({ reps: 8, loading: 'dumbbell' }), at('2026-09-18'))
    expect(s.weight! % 5).toBe(0)
    expect(s.weight).toBe(50)
  })

  it('respects a machine stack that only moves in tens', () => {
    const s = suggestTarget(lastAt(150), ex({ reps: 8, loading: 'stack', incrementLb: 10 }), at('2026-09-18'))
    expect(s.weight).toBe(160)
    expect(s.reason).toBe('+10 lb — clean 3×8 last time')
  })

  it('honours an explicit increment over the loading default', () => {
    const s = suggestTarget(lastAt(135), ex({ reps: 8, loading: 'barbell', incrementLb: 2.5 }), at('2026-09-18'))
    expect(s.weight).toBe(137.5)
  })

  it('snaps a layoff ramp to loadable weights too', () => {
    const history = [clean('2026-08-31', 185, 5)]
    const s = suggestTarget(history, ex({ reps: 5, loading: 'barbell' }), at('2026-09-18'))
    expect(s.weight! % 5).toBe(0)
  })

  it('leaves free-loaded work on the legacy weight-scaled step', () => {
    const s = suggestTarget(lastAt(50), ex({ reps: 8, loading: 'free' }), at('2026-09-18'))
    expect(s.weight).toBe(52.5)
  })

  it('defaults to free loading, so nothing changes for lifts with no equipment set', () => {
    const s = suggestTarget(lastAt(50), ex({ reps: 8 }), at('2026-09-18'))
    expect(s.weight).toBe(52.5)
  })
})

describe('ramp vs. evidence', () => {
  it('abandons the ramp once a session lands at or above the pre-break weight', () => {
    // trained light, took two weeks, came back and beat the old weight anyway
    const history = [clean('2026-09-02', 115, 8, 3), clean('2026-09-16', 135, 8, 3)]
    const s = suggestTarget(history, ex({ reps: 8 }), at('2026-09-18'))
    expect(s.basis).toBe('clean')
    expect(s.weight).toBe(140)
  })

  it('still ramps while they are genuinely below where they were', () => {
    const history = [clean('2026-09-02', 200, 5, 3), clean('2026-09-16', 140, 5, 3)]
    const s = suggestTarget(history, ex({ reps: 5, loading: 'barbell' }), at('2026-09-18'))
    expect(s.basis).toBe('layoff')
    expect(s.weight).toBeLessThan(200)
  })
})

/* ────────────────────────────────────────────────────────────────────
   Warm-ups are not evidence. The engine must read only working sets.
   ──────────────────────────────────────────────────────────────────── */
describe('warm-ups are excluded from progression', () => {
  it('reads the working sets and ignores the ramp-up', () => {
    // 2 warm-ups then 3 clean working sets at 185
    const session: HistoryEntry = {
      date: '2026-09-16', kg: 185,
      sets: [
        { w: 95, r: 8, warmup: true },
        { w: 135, r: 5, warmup: true },
        { w: 185, r: 5 }, { w: 185, r: 5 }, { w: 185, r: 5 },
      ],
    }
    const s = suggestTarget([session], ex({ reps: 5, loading: 'barbell' }), at('2026-09-18'))
    expect(s.basis).toBe('clean')
    expect(s.weight).toBe(190)
    // three working sets, not five
    expect(s.reason).toBe('+5 lb — clean 3×5 last time')
  })

  it('does not let a light warm-up read as a failed working session', () => {
    // a 95lb warm-up double would look like "short of 5 reps" if counted
    const session: HistoryEntry = {
      date: '2026-09-16', kg: 185,
      sets: [{ w: 95, r: 2, warmup: true }, { w: 185, r: 5 }, { w: 185, r: 5 }],
    }
    const s = suggestTarget([session], ex({ reps: 5, loading: 'barbell' }), at('2026-09-18'))
    expect(s.basis).toBe('clean')
  })

  it('does not let a heavy warm-up single inflate the working weight', () => {
    const session: HistoryEntry = {
      date: '2026-09-16', kg: 185,
      sets: [{ w: 225, r: 1, warmup: true }, { w: 185, r: 5 }, { w: 185, r: 5 }],
    }
    const s = suggestTarget([session], ex({ reps: 5, loading: 'barbell' }), at('2026-09-18'))
    expect(s.weight).toBe(190)
  })

  it('treats a session of nothing but warm-ups as nothing logged', () => {
    const session: HistoryEntry = {
      date: '2026-09-16', kg: 95,
      sets: [{ w: 95, r: 8, warmup: true }, { w: 95, r: 8, warmup: true }],
    }
    const s = suggestTarget([session], ex({ reps: 5 }), at('2026-09-18'))
    expect(s.basis).toBe('miss')
  })

  it('still counts sets with no warmup field — existing history', () => {
    const legacy: HistoryEntry = { date: '2026-09-16', kg: 185, sets: [{ r: 5 }, { r: 5 }, { r: 5 }] }
    const s = suggestTarget([legacy], ex({ reps: 5, loading: 'barbell' }), at('2026-09-18'))
    expect(s.basis).toBe('clean')
    expect(s.weight).toBe(190)
  })
})

/* ────────────────────────────────────────────────────────────────────
   Deload state drives the suggestion. The loop this closes: drop once,
   see a clean session at the reduced weight, bump straight back, and
   arrive at the same plateau three sessions later.
   ──────────────────────────────────────────────────────────────────── */
describe('suggestTarget honours deload state', () => {
  const held = [clean('2026-09-16', 165, 5, 3)]
  const rec = (over: Record<string, unknown> = {}) => ({
    state: 'deloading', kind: 'intensity', priorWeight: 185,
    since: '2026-09-16', sessions: 0, confidence: 'measured', ...over,
  })

  it('does NOT bump after a clean session while deloading', () => {
    const s = suggestTarget(held, ex({ reps: 5, loading: 'barbell', deload: rec() as never }), at('2026-09-18'))
    expect(s.basis).toBe('deload')
    // 185 * 0.9 = 166.5, snapped to a loadable 165 — and crucially NOT 170,
    // which is where plain progression would have taken the clean session
    expect(s.weight).toBe(165)
  })

  it('says it is holding, not that it is dropping again', () => {
    const s = suggestTarget(held, ex({ reps: 5, deload: rec() as never }), at('2026-09-18'))
    expect(s.reason).toContain('holding')
  })

  it('cuts sets rather than weight for a volume deload', () => {
    const s = suggestTarget(held, ex({ reps: 5, deload: rec({ kind: 'volume' }) as never }), at('2026-09-18'))
    expect(s.weight).toBe(185)
    expect(s.reason).toContain('sets')
  })

  it('climbs to just under the prior weight on re-approach', () => {
    const s = suggestTarget(held, ex({ reps: 5, deload: rec({ state: 'reapproach' }) as never }), at('2026-09-18'))
    expect(s.weight).toBe(175) // 185 * 0.95, snapped to something loadable
    expect(s.basis).toBe('deload')
  })

  it('resumes normal progression once the state is back to normal', () => {
    const s = suggestTarget(held, ex({ reps: 5, loading: 'barbell', deload: rec({ state: 'normal' }) as never }), at('2026-09-18'))
    expect(s.basis).toBe('clean')
    expect(s.weight).toBe(170)
  })

  it('progresses normally while merely flagged — noticing is not acting', () => {
    const s = suggestTarget(held, ex({ reps: 5, loading: 'barbell', deload: rec({ state: 'flagged' }) as never }), at('2026-09-18'))
    expect(s.basis).toBe('clean')
  })

  it('never climbs across a full hold, no matter how clean the sessions', () => {
    const sessions = [clean('2026-09-14', 165, 5, 3), clean('2026-09-16', 165, 5, 3)]
    const first = suggestTarget(sessions.slice(0, 1), ex({ reps: 5, deload: rec() as never }), at('2026-09-15'))
    const second = suggestTarget(sessions, ex({ reps: 5, deload: rec({ sessions: 1 }) as never }), at('2026-09-17'))
    expect(second.weight).toBe(first.weight)
  })
})

/* ────────────────────────────────────────────────────────────────────
   Autoregulation. A clean session says the weight was manageable; RPE
   says by how much, and a session with four reps in reserve has earned
   more than the default nudge.
   ──────────────────────────────────────────────────────────────────── */
describe('RPE autoregulation', () => {
  const withRpe = (rpe: number | null, w = 185): HistoryEntry => ({
    date: '2026-09-16', kg: w,
    sets: Array.from({ length: 3 }, () => ({ w, r: 5, ...(rpe == null ? {} : { rpe }) })),
  })
  const bar = () => ex({ reps: 5, loading: 'barbell' })

  it('takes a bigger jump when the session was clearly easy', () => {
    const s = suggestTarget([withRpe(6.5)], bar(), at('2026-09-18'))
    expect(s.weight).toBe(195) // two increments, not one
    expect(s.reason).toContain('RPE 6.5')
  })

  it('takes the normal jump in the usual working range', () => {
    const s = suggestTarget([withRpe(8)], bar(), at('2026-09-18'))
    expect(s.weight).toBe(190)
  })

  it('holds when every set was a grind, clean or not', () => {
    const s = suggestTarget([withRpe(9.5)], bar(), at('2026-09-18'))
    expect(s.weight).toBe(185)
    expect(s.reason).toContain('RPE 9.5')
  })

  it('behaves exactly as before when RPE was never logged', () => {
    const without = suggestTarget([withRpe(null)], bar(), at('2026-09-18'))
    expect(without.weight).toBe(190)
    expect(without.reason).toBe('+5 lb — clean 3×5 last time')
  })

  it('never reads RPE off a warm-up', () => {
    const entry: HistoryEntry = {
      date: '2026-09-16', kg: 185,
      sets: [{ w: 95, r: 5, rpe: 6, warmup: true }, { w: 185, r: 5, rpe: 9.5 }, { w: 185, r: 5, rpe: 9.5 }],
    }
    // the easy warm-up must not pull the average down into a double bump
    const s = suggestTarget([entry], bar(), at('2026-09-18'))
    expect(s.weight).toBe(185)
  })

  it('still respects the rep range before touching the weight', () => {
    const entry: HistoryEntry = {
      date: '2026-09-16', kg: 185,
      sets: Array.from({ length: 3 }, () => ({ w: 185, r: 8, rpe: 6 })),
    }
    const s = suggestTarget([entry], ex({ reps: 8, repRange: [8, 10] as [number, number], loading: 'barbell' }), at('2026-09-18'))
    expect(s.weight).toBe(185)
    expect(s.reps).toBe(9)
  })
})

/* ────────────────────────────────────────────────────────────────────
   A plank progresses in seconds, not pounds.
   ──────────────────────────────────────────────────────────────────── */
const kindHistory = (kind: string, field: string, values: number[]): HistoryEntry[] =>
  ['2026-09-10', '2026-09-13', '2026-09-16'].map((date, i) => ({
    date, kg: 0,
    sets: [{ [field]: values[i], kind } as never, { [field]: values[i], kind } as never],
  }))

describe('progression per kind', () => {
  it('adds seconds to a plank and returns no weight', () => {
    const s = suggestTarget(kindHistory('time', 's', [50, 55, 60]), ex({ kind: 'time' as never, reps: 1 }), at('2026-09-18'))
    expect(s.kind).toBe('time')
    expect(s.seconds).toBe(65)
    expect(s.weight).toBeNull()
    expect(s.reason).toContain('s')
  })

  it('adds metres to a carry and returns no weight', () => {
    const s = suggestTarget(kindHistory('distance', 'm', [30, 35, 40]), ex({ kind: 'distance' as never, reps: 1 }), at('2026-09-18'))
    expect(s.kind).toBe('distance')
    expect(s.metres).toBe(50)
    expect(s.weight).toBeNull()
  })

  it('adds a rep to bodyweight work', () => {
    const s = suggestTarget(kindHistory('reps_only', 'r', [10, 11, 12]), ex({ kind: 'reps_only' as never, reps: 12 }), at('2026-09-18'))
    expect(s.kind).toBe('reps_only')
    expect(s.reps).toBe(13)
    expect(s.weight).toBeNull()
  })

  it('holds a plank after a session that went backwards', () => {
    const s = suggestTarget(kindHistory('time', 's', [60, 60, 45]), ex({ kind: 'time' as never, reps: 1 }), at('2026-09-18'))
    expect(s.seconds).toBe(45)
    expect(s.basis).toBe('miss')
  })

  it('reads the kind from history even when the exercise does not say', () => {
    const s = suggestTarget(kindHistory('time', 's', [50, 55, 60]), ex({ reps: 1 }), at('2026-09-18'))
    expect(s.kind).toBe('time')
  })

  it('still defaults to reps_weight with nothing to go on', () => {
    const s = suggestTarget([], ex({ kg: 135, reps: 5 }), at('2026-09-18'))
    expect(s.kind).toBe('reps_weight')
    expect(s.weight).toBe(135)
  })

  it('honours a custom seconds increment', () => {
    const s = suggestTarget(
      kindHistory('time', 's', [50, 55, 60]),
      ex({ kind: 'time' as never, reps: 1, incrementSeconds: 15 as never }),
      at('2026-09-18'),
    )
    expect(s.seconds).toBe(75)
  })
})

describe('assisted progression removes assistance', () => {
  const assistedHistory = (values: number[]): HistoryEntry[] =>
    ['2026-09-10', '2026-09-13', '2026-09-16'].map((date, i) => ({
      date, kg: values[i],
      sets: [{ w: values[i], r: 8, assisted: true }, { w: values[i], r: 8, assisted: true }],
    }))

  it('REDUCES assistance after a clean session', () => {
    const s = suggestTarget(assistedHistory([40, 35, 30]), ex({ reps: 8, assisted: true as never, loading: 'stack' }), at('2026-09-18'))
    expect(s.weight!).toBeLessThan(30)
    expect(s.basis).toBe('clean')
  })

  it('says it is taking help away, not adding weight', () => {
    const s = suggestTarget(assistedHistory([40, 35, 30]), ex({ reps: 8, assisted: true as never, loading: 'stack' }), at('2026-09-18'))
    expect(s.reason).toMatch(/less assistance|assistance/i)
  })

  it('never drops below zero assistance', () => {
    const s = suggestTarget(assistedHistory([10, 5, 0]), ex({ reps: 8, assisted: true as never, loading: 'stack' }), at('2026-09-18'))
    expect(s.weight).toBe(0)
  })

  it('holds the assistance after a missed session', () => {
    const missed: HistoryEntry[] = [
      { date: '2026-09-16', kg: 30, sets: [{ w: 30, r: 8, assisted: true }, { w: 30, r: 2, fail: true, assisted: true }] },
    ]
    const s = suggestTarget(missed, ex({ reps: 8, assisted: true as never, loading: 'stack' }), at('2026-09-18'))
    expect(s.weight).toBe(30)
    expect(s.basis).toBe('miss')
  })
})

/* ────────────────────────────────────────────────────────────────────
   Changing a lift's kind. Old rows keep their own kind and are never
   rewritten, so they stay readable — but they stop feeding progression,
   because seconds and pounds are not comparable quantities.
   ──────────────────────────────────────────────────────────────────── */
describe('changing kind on a lift that has history', () => {
  const asWeight: HistoryEntry[] = [
    { date: '2026-09-10', kg: 185, sets: [{ w: 185, r: 5 }, { w: 185, r: 5 }] },
    { date: '2026-09-16', kg: 185, sets: [{ w: 185, r: 5 }, { w: 185, r: 5 }] },
  ]

  it('does not carry a pounds history into a seconds suggestion', () => {
    const s = suggestTarget(asWeight, ex({ kind: 'time' as never, reps: 1 }), at('2026-09-18'))
    expect(s.kind).toBe('time')
    expect(s.weight).toBeNull()
    expect(s.basis).toBe('new')
  })

  it('leaves the stored rows untouched, still readable under their own kind', () => {
    const before = JSON.stringify(asWeight)
    suggestTarget(asWeight, ex({ kind: 'time' as never, reps: 1 }), at('2026-09-18'))
    expect(JSON.stringify(asWeight)).toBe(before)
  })

  it('picks up again from rows logged under the NEW kind', () => {
    const mixed = [
      ...asWeight,
      { date: '2026-09-17', kg: 0, sets: [{ s: 60, kind: 'time' } as never] },
    ]
    const s = suggestTarget(mixed, ex({ kind: 'time' as never, reps: 1 }), at('2026-09-18'))
    expect(s.seconds).toBe(65)
    expect(s.basis).toBe('clean')
  })

  it('still lets the exercise definition declare the kind up front', () => {
    const s = suggestTarget([], ex({ kind: 'distance' as never, reps: 1 }), at('2026-09-18'))
    expect(s.kind).toBe('distance')
    expect(s.basis).toBe('new')
  })

  it('leaves a lift with no declared kind reading its history, as before', () => {
    const s = suggestTarget(asWeight, ex({ reps: 5, loading: 'barbell' }), at('2026-09-18'))
    expect(s.kind).toBe('reps_weight')
    expect(s.weight).toBe(190)
  })
})
