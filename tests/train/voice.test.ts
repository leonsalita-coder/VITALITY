import { describe, it, expect } from 'vitest'
import { collectSignals, chooseSignal, briefFor } from '../../lib/train/insight'
import type { SignalContext } from '../../lib/train/insight'
import { weeklyReview, reviewWorthSending } from '../../lib/train/review'
import { indexFrom } from '../../lib/train/analysis'

const NOW = new Date('2026-09-19T12:00:00').getTime()
const ago = (n: number) => {
  const d = new Date(NOW); d.setDate(d.getDate() - n)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
const sess = (day: number, sets: number, w = 100) => ({
  date: ago(day), kg: w, sets: Array.from({ length: sets }, () => ({ w, r: 5 })),
})

const LIB = {
  bench: { primary: ['Chest'], secondary: ['Triceps'] },
  row: { primary: ['Lats'], secondary: ['Biceps'] },
  legcurl: { primary: ['Hamstrings'] },
}
const INDEX = indexFrom(LIB)

/** The gate tests assert silence; an empty index would fake every one. */
describe('the fixture itself', () => {
  it('resolves its muscles', () => {
    expect(Object.keys(INDEX)).toHaveLength(Object.keys(LIB).length)
    for (const id of Object.keys(LIB)) expect(INDEX[id].primary.length, id).toBeGreaterThan(0)
  })
})

const ctx = (over: Partial<SignalContext> = {}): SignalContext => ({
  history: {}, index: INDEX, now: NOW, today: ago(0),
  records: [], deloadsApplied: [], plateaus: [],
  streak: 0, weeklyTarget: 4, firsts: [],
  ...over,
})

describe('silence is the default', () => {
  it('produces no signal from a session with nothing notable', () => {
    expect(collectSignals(ctx())).toEqual([])
    expect(chooseSignal([])).toBeNull()
  })

  it('returns no brief, so no model is ever called', () => {
    expect(briefFor(ctx(), 'get strong')).toBeNull()
  })

  it('stays silent on a single ordinary session', () => {
    expect(briefFor(ctx({ history: { bench: [sess(1, 3)] } }), 'get strong')).toBeNull()
  })

  it('does not treat a one-week streak as a milestone', () => {
    expect(collectSignals(ctx({ streak: 1 }))).toEqual([])
  })
})

describe('each signal type produces exactly one insight', () => {
  const one = (over: Partial<SignalContext>) => {
    const signals = collectSignals(ctx(over))
    expect(signals.length).toBeGreaterThan(0)
    return chooseSignal(signals)!
  }

  it('a deload that was applied', () => {
    const s = one({ deloadsApplied: [{ name: 'Squat', from: 200, to: 180, kind: 'intensity' }] })
    expect(s.kind).toBe('deload_applied')
    expect(s.text).toContain('180')
  })

  it('a plateau', () => {
    const s = one({ plateaus: [{ name: 'Bench', sessions: 3, weight: 185 }] })
    expect(s.kind).toBe('plateau')
    expect(s.text).toContain('185')
  })

  it('a personal record', () => {
    const s = one({ records: [{ name: 'Squat', kind: 'e1RM', value: 275, unit: ' lb' }] })
    expect(s.kind).toBe('personal_record')
    expect(s.text).toContain('275')
  })

  it('a frequency gap', () => {
    const s = one({ history: { legcurl: [sess(60, 3), sess(30, 3)] } })
    expect(s.kind).toBe('frequency_gap')
  })

  it('a weekly-sets band breach', () => {
    // pull work included on purpose: without it the ratio finding fires
    // too and correctly outranks this one
    const s = one({ history: { bench: [sess(1, 14), sess(3, 14)], row: [sess(2, 10), sess(4, 10)] } })
    expect(s.kind).toBe('weekly_sets')
    expect(s.text).toMatch(/\d+ hard sets/)
  })

  it('a ratio finding', () => {
    const s = one({ history: { bench: [sess(3, 12), sess(10, 12), sess(17, 12)] } })
    expect(s.kind).toBe('ratio')
  })

  it('a streak milestone', () => {
    const s = one({ streak: 4 })
    expect(s.kind).toBe('streak_milestone')
    expect(s.text).toContain('4')
  })

  it('a genuine first', () => {
    const s = one({ firsts: ['Sled Push'] })
    expect(s.kind).toBe('first_time')
    expect(s.text).toContain('Sled Push')
  })
})

describe('one per session, most important first', () => {
  it('reports the deload over the personal record', () => {
    const s = chooseSignal(collectSignals(ctx({
      deloadsApplied: [{ name: 'Squat', from: 200, to: 180, kind: 'intensity' }],
      records: [{ name: 'Bench', kind: 'e1RM', value: 275, unit: ' lb' }],
    })))!
    expect(s.kind).toBe('deload_applied')
  })

  it('puts an injury-relevant ratio above a rep record', () => {
    const s = chooseSignal(collectSignals(ctx({
      history: { bench: [sess(3, 12), sess(10, 12), sess(17, 12)] },
      records: [{ name: 'Bench', kind: 'rep', value: 8, unit: ' reps' }],
    })))!
    expect(s.kind).toBe('ratio')
  })

  it('never returns more than one', () => {
    const brief = briefFor(ctx({
      plateaus: [{ name: 'Bench', sessions: 3, weight: 185 }],
      records: [{ name: 'Squat', kind: 'e1RM', value: 275, unit: ' lb' }],
      streak: 8,
    }), 'get strong')!
    expect(brief.fact.split('.').filter(Boolean)).toHaveLength(1)
  })
})

describe('every line carries a traceable number', () => {
  it('names the figure it is built on', () => {
    for (const over of [
      { deloadsApplied: [{ name: 'Squat', from: 200, to: 180, kind: 'intensity' }] },
      { plateaus: [{ name: 'Bench', sessions: 3, weight: 185 }] },
      { records: [{ name: 'Squat', kind: 'e1RM', value: 275, unit: ' lb' }] },
      { streak: 4 },
      { history: { bench: [sess(1, 14), sess(3, 14)], row: [sess(2, 10), sess(4, 10)] } },
    ]) {
      const s = chooseSignal(collectSignals(ctx(over as never)))!
      expect(s.text, s.text).toMatch(/\d/)
      expect(s.value).toBeDefined()
    }
  })

  it('tells the model to keep the number exactly', () => {
    const brief = briefFor(ctx({ plateaus: [{ name: 'Bench', sessions: 3, weight: 185 }] }), 'get strong')!
    expect(brief.prompt).toContain('185')
    expect(brief.prompt).toMatch(/keeping the number exactly/i)
    expect(brief.prompt).toMatch(/Add nothing/i)
  })

  it('carries a fact usable without any model at all', () => {
    const brief = briefFor(ctx({ plateaus: [{ name: 'Bench', sessions: 3, weight: 185 }] }), 'get strong')!
    expect(brief.fact).toContain('185')
  })
})

describe('weekly review', () => {
  const review = (over: any = {}) => weeklyReview({
    history: {}, customLib: LIB, exerciseNames: { bench: 'Bench', row: 'Row', legcurl: 'Leg Curl' },
    finishedDates: [], weeklyTarget: 4, now: NOW, ...over,
  })

  it('returns data, not a rendered string', () => {
    const r = review()
    expect(typeof r).toBe('object')
    expect(r).toHaveProperty('sessions')
    expect(r).toHaveProperty('hardSetsByMuscle')
    expect(r).toHaveProperty('findings')
  })

  it('counts sessions against the target', () => {
    const r = review({ finishedDates: [ago(1), ago(3), ago(5)] })
    expect(r.sessions).toBe(3)
    expect(r.target).toBe(4)
    expect(r.metTarget).toBe(false)
  })

  it('bands volume by muscle', () => {
    const r = review({ history: { bench: [sess(1, 14), sess(3, 14)] } })
    const chest = r.hardSetsByMuscle.find((m) => m.muscle === 'chest')!
    expect(chest.band).toBe('over')
    expect(chest.sets).toBeGreaterThan(20)
  })

  it('reports what moved', () => {
    const r = review({ history: { bench: [sess(5, 3, 135), sess(1, 3, 145)] } })
    expect(r.moved[0]).toMatchObject({ exerciseId: 'bench', from: 135, to: 145 })
  })

  it('reports what has been quiet', () => {
    const r = review({ history: { bench: [sess(1, 3)], legcurl: [sess(40, 3)] } })
    expect(r.quiet).toContain('hamstrings')
    expect(r.quiet).not.toContain('chest')
  })

  it('says so briefly on a quiet week rather than padding', () => {
    const r = review()
    expect(r.quiet_week).toBe(true)
    expect(r.headline).toMatch(/No sessions this week/)
    expect(reviewWorthSending(r)).toBe(false)
  })

  it('is not quiet when something actually happened', () => {
    const r = review({ finishedDates: [ago(1)], history: { bench: [sess(1, 3)] } })
    expect(r.quiet_week).toBe(false)
    expect(reviewWorthSending(r)).toBe(true)
  })

  it('builds its headline from real counts', () => {
    const r = review({ finishedDates: [ago(1), ago(2)], history: { bench: [sess(5, 3, 135), sess(1, 3, 145)] } })
    expect(r.headline).toContain('2 of 4 sessions')
    expect(r.headline).toContain('1 lift up')
  })

  it('carries every number back to the analysis output', () => {
    const r = review({ history: { bench: [sess(1, 14), sess(3, 14)] } })
    for (const f of r.findings) expect(f.text).toMatch(/\d/)
  })

  it('flags when the figures rest on guessed muscle splits', () => {
    const r = review({ history: { bench: [sess(1, 5)] } })
    expect(r.estimated).toBe(true)
  })

  it('reports the window it covers', () => {
    const r = review()
    expect(r.to).toBe(ago(0))
    expect(r.from).toBe(ago(6))
  })
})
