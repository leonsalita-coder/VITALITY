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
