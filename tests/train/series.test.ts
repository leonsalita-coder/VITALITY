import { describe, it, expect } from 'vitest'
import {
  e1rmSeries, muscleWeekSeries, sessionsPerWeekSeries, periodComparison,
} from '../../lib/train/series'
import { indexFrom } from '../../lib/train/analysis'

const NOW = new Date('2026-09-19T12:00:00').getTime()
const ago = (n: number) => {
  const d = new Date(NOW); d.setDate(d.getDate() - n)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
const entry = (day: number, w: number, reps: number, sets = 3) => ({
  date: ago(day), kg: w,
  sets: Array.from({ length: sets }, () => ({ w, r: reps })),
})

const LIB = { bench: { primary: ['Chest'], secondary: ['Triceps'] }, squat: { primary: ['Quads'] } }
const INDEX = indexFrom(LIB)

/** A silent series and an unloaded fixture look identical; this separates them. */
describe('the fixture itself', () => {
  it('resolves its muscles', () => {
    expect(Object.keys(INDEX)).toHaveLength(Object.keys(LIB).length)
    for (const id of Object.keys(LIB)) expect(INDEX[id].primary.length, id).toBeGreaterThan(0)
  })
})

describe('e1RM trend — the default view', () => {
  it('produces a point per session', () => {
    const s = e1rmSeries([entry(14, 185, 5), entry(7, 190, 5), entry(1, 190, 6)])
    expect(s).toHaveLength(3)
    expect(s[0].date).toBe(ago(14))
  })

  it('rises when reps improve at the same weight — a weight chart would look flat', () => {
    const s = e1rmSeries([entry(7, 190, 5), entry(1, 190, 6)])
    expect(s[1].value).toBeGreaterThan(s[0].value)
  })

  it('carries the date so a point taps back to its session', () => {
    for (const p of e1rmSeries([entry(3, 185, 5)])) expect(p.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('skips rest days and sessions with nothing to measure', () => {
    expect(e1rmSeries([{ date: ago(2), kg: 0, off: true }])).toEqual([])
    expect(e1rmSeries([{ date: ago(2), kg: 100, sets: [{ w: 100, r: 20 }] }])).toEqual([])
  })

  it('ignores warm-ups', () => {
    const mixed = { date: ago(1), kg: 185, sets: [{ w: 315, r: 1, warmup: true }, { w: 185, r: 5 }] }
    const s = e1rmSeries([mixed])
    expect(s[0].value).toBeLessThan(315)
  })

  it('is empty with no history', () => {
    expect(e1rmSeries([])).toEqual([])
  })
})

describe('hard sets per muscle against the band', () => {
  it('bands each muscle', () => {
    const out = muscleWeekSeries({ bench: [entry(1, 100, 5, 12), entry(3, 100, 5, 12)] }, INDEX, NOW)
    const chest = out.find((m) => m.muscle === 'chest')!
    expect(chest.band).toBe('over')
    expect(chest.sets).toBeGreaterThan(20)
  })

  it('marks figures resting on guessed splits', () => {
    const out = muscleWeekSeries({ bench: [entry(1, 100, 5, 4)] }, INDEX, NOW)
    expect(out.every((m) => m.estimated)).toBe(true)
  })

  it('ignores anything outside the week', () => {
    expect(muscleWeekSeries({ bench: [entry(30, 100, 5, 20)] }, INDEX, NOW)).toEqual([])
  })

  it('is empty when nothing has muscles on record', () => {
    expect(muscleWeekSeries({ mystery: [entry(1, 100, 5)] }, indexFrom({}), NOW)).toEqual([])
  })
})

describe('rolling sessions per week', () => {
  it('counts the finished days in each window', () => {
    const s = sessionsPerWeekSeries([ago(1), ago(3), ago(5), ago(9)], NOW, 2)
    expect(s[s.length - 1].value).toBe(3)
    expect(s[s.length - 2].value).toBe(1)
  })

  it('returns a point per week, oldest first', () => {
    const s = sessionsPerWeekSeries([], NOW, 12)
    expect(s).toHaveLength(12)
    expect(s[0].date < s[11].date).toBe(true)
  })

  it('counts a duplicated date once', () => {
    expect(sessionsPerWeekSeries([ago(1), ago(1)], NOW, 1)[0].value).toBe(1)
  })
})

describe('period comparison', () => {
  const history = {
    bench: [entry(3, 185, 5), entry(10, 185, 5), entry(70, 175, 5)],
  }
  const finished = [ago(3), ago(10), ago(70)]

  it('measures this block against the one before it', () => {
    const c = periodComparison(history, finished, NOW, 8)
    expect(c.current.sessions).toBe(2)
    expect(c.previous.sessions).toBe(1)
  })

  it('reports the change as a ratio', () => {
    const c = periodComparison(history, finished, NOW, 8)
    expect(c.change.sessions).toBe(2)
  })

  it('returns null rather than dividing by an empty period', () => {
    const c = periodComparison({ bench: [entry(1, 185, 5)] }, [ago(1)], NOW, 8)
    expect(c.change.sessions).toBeNull()
    expect(c.change.tonnage).toBeNull()
  })

  it('names the windows it compared', () => {
    const c = periodComparison(history, finished, NOW, 8)
    expect(c.current.to).toBe(ago(0))
    expect(c.previous.to < c.current.from).toBe(true)
  })
})

/**
 * Rows with holes in them, through all three traversals.
 *
 * This module walks history three separate times and never through the
 * shared reader, so every guard the shared one has had to be repeated
 * here — and none of them were. The same defect was found in analysis
 * and again in load: a null row, or one with no date, arrives from an
 * import and the traversal reaches straight through it.
 *
 * The chart is the one place the failure is loud rather than silent —
 * the Progress tab throws instead of drawing — but it is the same bug.
 */
describe('history rows that arrive incomplete', () => {
  const good = [entry(3, 100, 5), entry(10, 100, 5), entry(17, 100, 5)]
  const nullRow = [null, ...good] as never
  const dateless = [{ ...entry(1, 100, 5), date: undefined }, ...good] as never

  describe('the e1RM line', () => {
    it('steps over an empty row', () => {
      expect(() => e1rmSeries(nullRow)).not.toThrow()
      expect(e1rmSeries(nullRow)).toHaveLength(good.length)
    })

    it('steps over a row with no date', () => {
      /* Not merely "does not throw": this module's whole premise is that
         every point taps back to its session, so a point with no date is
         a picture rather than a record. */
      const points = e1rmSeries(dateless)
      expect(points).toHaveLength(good.length)
      expect(points.every((p) => typeof p.date === 'string' && p.date.length > 0)).toBe(true)
    })

    it('still plots the rows either side of them', () => {
      /* The control for both: dropping everything satisfies them. */
      expect(e1rmSeries(good)).toHaveLength(3)
      expect(e1rmSeries(good)[0].value).toBeGreaterThan(0)
    })
  })

  describe('the per-muscle week', () => {
    it('steps over an empty row', () => {
      expect(() => muscleWeekSeries({ bench: nullRow }, INDEX, NOW)).not.toThrow()
    })

    it('steps over a row with no date', () => {
      expect(() => muscleWeekSeries({ bench: dateless }, INDEX, NOW)).not.toThrow()
    })

    it('still counts the rows either side of them', () => {
      const withHoles = muscleWeekSeries({ bench: [null, { ...entry(1, 100, 5), date: undefined }, entry(1, 100, 5)] as never }, INDEX, NOW)
      expect(withHoles.length).toBeGreaterThan(0)
      expect(withHoles.find((p) => p.muscle === 'chest')!.sets).toBeGreaterThan(0)
    })
  })

  describe('the period comparison', () => {
    it('steps over an empty row', () => {
      expect(() => periodComparison({ bench: nullRow }, [ago(3)], NOW)).not.toThrow()
    })

    it('steps over a row with no date', () => {
      expect(() => periodComparison({ bench: dateless }, [ago(3)], NOW)).not.toThrow()
    })

    it('still measures the rows either side of them', () => {
      const withHoles = periodComparison({ bench: nullRow }, [ago(3)], NOW)
      expect(withHoles.current.sets).toBe(good.length * 3)
    })
  })
})

/* ------------------------------------------------------------------ *
 * The numbers the chart is drawn from.
 *
 * Nothing here pins geometry. A test that asserts an SVG path is
 * brittle and says nothing about whether the figures are right; what
 * matters is that a series holds the values the athlete logged, in
 * order, with gaps where there were gaps.
 * ------------------------------------------------------------------ */

describe('the per-muscle week counts the right days', () => {
  /* squat carries a single primary, so its sets land 1:1 on quads and a
     boundary can be stated exactly. */
  const setsOn = (day: number, sets: number) =>
    muscleWeekSeries({ squat: [entry(day, 100, 5, sets)] }, INDEX, NOW)
      .find((p) => p.muscle === 'quads')?.sets ?? 0

  it('counts work done today', () => expect(setsOn(0, 12)).toBe(12))
  it('counts work done six days ago', () => expect(setsOn(6, 12)).toBe(12))
  it('drops work done seven days ago', () => expect(setsOn(7, 12)).toBe(0))

  it('ignores a session dated in the future', () => {
    /* A clock skew or a bad import should not inflate this week. */
    expect(setsOn(-1, 12)).toBe(0)
  })

  it('ignores a date it cannot read as a day', () => {
    /* A date string with no month or day falls back to the first of the
       year, which is far outside the week. Without that fallback it
       becomes an invalid date, whose comparisons are all false — so the
       row is neither in the window nor excluded from it, and lands in
       this week's chart from an arbitrary point in history. */
    const rows = [{ date: '2026', kg: 100, sets: [{ w: 100, r: 5 }] }] as never
    expect(muscleWeekSeries({ squat: rows }, INDEX, NOW)).toEqual([])
    /* Beside it, a readable date on the same shape IS counted. */
    const dated = [{ date: ago(1), kg: 100, sets: [{ w: 100, r: 5 }] }] as never
    expect(muscleWeekSeries({ squat: dated }, INDEX, NOW)).toHaveLength(1)
  })
})

describe('the band edges are the band edges', () => {
  const bandAt = (sets: number) =>
    muscleWeekSeries({ squat: [entry(1, 100, 5, sets)] }, INDEX, NOW)
      .find((p) => p.muscle === 'quads')!.band

  it('calls the top of the band in, not over', () => expect(bandAt(20)).toBe('in'))
  it('calls one above it over', () => expect(bandAt(21)).toBe('over'))
  it('calls the bottom of the band in, not under', () => expect(bandAt(10)).toBe('in'))
  it('calls one below it under', () => expect(bandAt(9)).toBe('under'))
})

describe('a lift with only a primary muscle still counts', () => {
  it('does not require a secondary list to be non-empty', () => {
    /* The skip is for lifts with NO muscles at all. Requiring both lists
       to be empty before skipping is the correct reading; requiring
       either would drop every single-muscle lift off the chart — which
       is most isolation work. */
    const found = muscleWeekSeries({ squat: [entry(1, 100, 5, 12)] }, INDEX, NOW)
    expect(found.map((p) => p.muscle)).toContain('quads')
  })

  it('still skips a lift with no muscles at all', () => {
    const index = indexFrom({ mystery: { primary: ['Vibes'] }, squat: { primary: ['Quads'] } })
    expect(muscleWeekSeries({ mystery: [entry(1, 100, 5, 12)] }, index, NOW)).toEqual([])
    /* The control: the same index DOES read a lift it recognises, so the
       silence above is the unknown muscle rather than a dead reader. */
    expect(muscleWeekSeries({ squat: [entry(1, 100, 5, 12)] }, index, NOW)).toHaveLength(1)
  })
})

describe('rolling weeks cover seven days each and are labelled by their oldest', () => {
  it('counts a session six days back in the most recent week', () => {
    const points = sessionsPerWeekSeries([ago(6)], NOW, 1)
    expect(points).toHaveLength(1)
    expect(points[0].value).toBe(1)
  })

  it('pushes a session seven days back out of a one-week view', () => {
    expect(sessionsPerWeekSeries([ago(7)], NOW, 1)[0].value).toBe(0)
    /* Beside it, the same date IS found when the view is wide enough —
       so the zero above is the window, not the series. */
    expect(sessionsPerWeekSeries([ago(7)], NOW, 2)[0].value).toBe(1)
  })

  it('labels each week with its oldest day', () => {
    /* The label is what a tapped point resolves to. Taking a different
       day of the week silently moves every point on the axis. */
    expect(sessionsPerWeekSeries([], NOW, 1)[0].date).toBe(ago(6))
    expect(sessionsPerWeekSeries([], NOW, 2).map((p) => p.date)).toEqual([ago(13), ago(6)])
  })

  it('puts each session in exactly one week', () => {
    const days = Array.from({ length: 21 }, (_, i) => ago(i))
    const points = sessionsPerWeekSeries(days, NOW, 3)
    expect(points.map((p) => p.value)).toEqual([7, 7, 7])
  })
})

describe('the period comparison measures what it says it measures', () => {
  const rows = (day: number) => ({ bench: [entry(day, 100, 5, 3)] })

  it('adds up every working rep as tonnage', () => {
    /* 3 sets x 5 reps x 100 lb. A tonnage that ignores reps reads zero
       and the chart draws a flat line through a real block. */
    const found = periodComparison(rows(1), [ago(1)], NOW, 8)
    expect(found.current.sets).toBe(3)
    expect(found.current.tonnage).toBe(1500)
  })

  it('counts a session on the first day of the window', () => {
    const { current } = periodComparison({}, [], NOW, 8)
    const onEdge = periodComparison(
      { bench: [{ ...entry(0, 100, 5, 3), date: current.from }] }, [current.from], NOW, 8)
    expect(onEdge.current.sets).toBe(3)
    expect(onEdge.current.sessions).toBe(1)
  })

  it('counts a session on the last day of the window', () => {
    const { current } = periodComparison({}, [], NOW, 8)
    const onEdge = periodComparison(
      { bench: [{ ...entry(0, 100, 5, 3), date: current.to }] }, [current.to], NOW, 8)
    expect(onEdge.current.sets).toBe(3)
    expect(onEdge.current.sessions).toBe(1)
  })

  it('puts the block before this one in the previous period', () => {
    const { previous } = periodComparison({}, [], NOW, 8)
    const found = periodComparison(
      { bench: [{ ...entry(0, 100, 5, 3), date: previous.to }] }, [previous.to], NOW, 8)
    expect(found.previous.sets).toBe(3)
    expect(found.current.sets).toBe(0)
  })

  it('leaves an off day out of both', () => {
    const off = { bench: [{ ...entry(1, 100, 5, 3), off: true }] }
    expect(periodComparison(off, [], NOW, 8).current.sets).toBe(0)
    expect(periodComparison(rows(1), [], NOW, 8).current.sets).toBe(3)
  })
})

describe('the e1RM point is the best set of the session, not the last', () => {
  /* Every fixture above builds a session from identical sets, so "the
     heaviest" and "the last" are the same number and the comparison
     picking between them was never exercised. A real session ramps and
     often ends on a back-off set. */
  const mixed = (sets: Array<{ w: number; r: number }>) => [{ date: ago(1), kg: 100, sets }]

  it('takes the heaviest estimate when the session ends lighter', () => {
    /* 225x5 estimates 262.5; the back-off set after it must not replace
       it, or the chart draws a drop on a session that set a record. */
    const [point] = e1rmSeries(mixed([{ w: 135, r: 5 }, { w: 225, r: 5 }, { w: 95, r: 8 }]))
    expect(point.value).toBe(262.5)
  })

  it('takes it when the session ends heavier too', () => {
    const [point] = e1rmSeries(mixed([{ w: 95, r: 8 }, { w: 225, r: 5 }]))
    expect(point.value).toBe(262.5)
  })

  it('ignores a set too far past the rep cap to estimate from', () => {
    /* 300x20 has no Epley estimate, so the 225x5 stands. */
    const [point] = e1rmSeries(mixed([{ w: 225, r: 5 }, { w: 300, r: 20 }]))
    expect(point.value).toBe(262.5)
  })

  it('plots nothing for a session with no estimable set at all', () => {
    expect(e1rmSeries(mixed([{ w: 300, r: 20 }]))).toEqual([])
    /* Beside it, one estimable set does produce a point. */
    expect(e1rmSeries(mixed([{ w: 225, r: 5 }]))).toHaveLength(1)
  })
})
