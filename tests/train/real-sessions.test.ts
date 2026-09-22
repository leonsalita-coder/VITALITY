import { describe, it, expect } from 'vitest'
import { e1rmSeries, muscleWeekSeries } from '../../lib/train/series'
import { bestE1RM, classifyPR } from '../../lib/train/records'
import { acuteChronic } from '../../lib/train/load'
import { amrapOf, workingSets } from '../../lib/train/sets'
import { indexFrom } from '../../lib/train/analysis'

/**
 * Sessions shaped like real training rather than like a fixture.
 *
 * Every fixture in this suite was degenerate in the same way, and it hid
 * a real defect for seven review passes: sessions were built from
 * IDENTICAL sets, so "the heaviest set" and "the last set" were always
 * the same number, and every comparison choosing between them was
 * invisible. e1rmSeries was picking the last rather than the best and
 * nothing could tell.
 *
 * A real session ramps, tops out somewhere in the middle, and ends on a
 * back-off. A real training week has several lifts hitting one muscle. A
 * real block is not every third day forever. None of those shapes were
 * in the suite; all of them are here.
 *
 * Nothing below found a bug. That is the point of writing them down —
 * these are the branches that were correct and unasserted, which is the
 * state the e1RM one was in until it wasn't.
 */

const NOW = new Date(2026, 8, 19, 12).getTime()
const day = (b: number) => {
  const d = new Date(2026, 8, 19 - b)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const at = (d: string) => new Date(`${d}T12:00:00`).getTime()

/** A push day: three lifts, all of them chest. */
const index = indexFrom({
  bench: { primary: [{ muscle: 'chest', share: 1 }] },
  incline: { primary: [{ muscle: 'chest', share: 1 }] },
  dip: { primary: [{ muscle: 'chest', share: 1 }] },
})
const flat = (b: number, n: number, w = 100) => ({
  date: day(b), kg: w, sets: Array.from({ length: n }, () => ({ w, r: 5 })),
})

describe('a session that ramps and backs off', () => {
  /* The top set is in the MIDDLE — neither first nor last. */
  const ramped = {
    date: day(1), kg: 225,
    sets: [{ w: 135, r: 5 }, { w: 225, r: 5 }, { w: 185, r: 8 }],
  }

  it('charts the top set, not the one logged last', () => {
    expect(e1rmSeries([ramped] as never)[0].value).toBe(262.5)
  })

  it('records the top set as the best on record', () => {
    expect(bestE1RM([ramped] as never)?.weight).toBe(225)
  })

  it('measures a new record against the top set', () => {
    const history = [ramped] as never
    expect(classifyPR(history, { weight: 230, reps: 5 }, at('2026-09-25')).kind).toBe('e1rm')
  })

  it('does not hand out a record for beating only the back-off set', () => {
    /* 200 lb clears the 185 back-off and loses to the 225 top set. A
       read that took the last set would celebrate this. */
    const history = [ramped] as never
    /* Paired with the weight that DOES clear the top set, so the silence
       is the comparison rather than a module that stopped awarding
       records at all. */
    expect(classifyPR(history, { weight: 230, reps: 5 }, at('2026-09-25')).kind).toBe('e1rm')
    expect(classifyPR(history, { weight: 200, reps: 5 }, at('2026-09-25')).kind).toBeNull()
  })

  it('counts every working set, ramp included', () => {
    const chest = muscleWeekSeries({ bench: [ramped] } as never, index, NOW)
      .find((p) => p.muscle === 'chest')
    expect(chest?.sets).toBe(3)
  })

  it('takes the flagged all-out set rather than the final one', () => {
    const session = {
      date: day(1), kg: 225,
      sets: [{ w: 225, r: 12, amrap: true }, { w: 185, r: 5 }],
    }
    expect(amrapOf(session as never)?.r).toBe(12)
  })
})

describe('warm-ups sitting in the same session as working sets', () => {
  const mixed = {
    date: day(1), kg: 225,
    sets: [
      { w: 45, r: 10, warmup: true }, { w: 95, r: 5, warmup: true },
      { w: 225, r: 5 }, { w: 225, r: 5 },
    ],
  }

  it('charts the working set, never the warm-up', () => {
    expect(e1rmSeries([mixed] as never)[0].value).toBe(262.5)
  })

  it('counts only the working sets as volume', () => {
    expect(workingSets(mixed as never)).toHaveLength(2)
    expect(muscleWeekSeries({ bench: [mixed] } as never, index, NOW)
      .find((p) => p.muscle === 'chest')?.sets).toBe(2)
  })

  it('plots nothing at all for a session that was only warm-ups', () => {
    const onlyWarm = { date: day(1), kg: 45, sets: [{ w: 45, r: 10, warmup: true }] }
    expect(e1rmSeries([onlyWarm] as never)).toEqual([])
    /* Beside it, the same session with one real set does plot. */
    expect(e1rmSeries([{ ...onlyWarm, sets: [...onlyWarm.sets, { w: 225, r: 5 }] }] as never))
      .toHaveLength(1)
  })
})

describe('several lifts hitting one muscle, which is what a push day is', () => {
  it('adds their volume together', () => {
    const one = muscleWeekSeries({ bench: [flat(1, 6)] } as never, index, NOW)
    const three = muscleWeekSeries(
      { bench: [flat(1, 6)], incline: [flat(1, 6)], dip: [flat(2, 6)] } as never, index, NOW)
    expect(one.find((p) => p.muscle === 'chest')!.sets).toBe(6)
    expect(three.find((p) => p.muscle === 'chest')!.sets).toBe(18)
  })

  it('carries that sum into the load reading', () => {
    const ctx = (h: object) => ({ history: h as never, index, otherTraining: [], now: NOW })
    const one = acuteChronic(ctx({ bench: [flat(1, 6)] })).byMuscle.chest!
    const three = acuteChronic(ctx({
      bench: [flat(1, 6)], incline: [flat(1, 6)], dip: [flat(2, 6)],
    })).byMuscle.chest!
    expect(three.acute).toBeGreaterThan(one.acute * 2.5)
  })
})

describe('a block that is not evenly spaced', () => {
  /* Real training clusters: two days on, a gap, a busy week, a quiet
     one. Every load fixture in the suite trained every third day
     forever, which is the one pattern a rolling average handles most
     gracefully. */
  const ragged = [1, 2, 5, 6, 13, 14, 15, 22, 30, 31, 32, 40, 47, 48, 55, 56, 57, 60, 61, 62]
    .map((d) => flat(d, 6))

  it('still produces a usable reading', () => {
    const chest = acuteChronic({ history: { bench: ragged } as never, index, otherTraining: [], now: NOW })
      .byMuscle.chest!
    expect(chest.usable).toBe(true)
    expect(chest.chronic).toBeGreaterThan(0)
  })

  it('does not read a ragged block as a spike', () => {
    /* The reading may differ from an even block — the athlete really did
       train differently — but clustering alone must not push it outside
       the band and manufacture a finding. */
    const chest = acuteChronic({ history: { bench: ragged } as never, index, otherTraining: [], now: NOW })
      .byMuscle.chest!
    expect(chest.ratio).toBeLessThan(1.5)
    expect(chest.ratio).toBeGreaterThan(0.8)
  })
})
