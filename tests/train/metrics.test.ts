import { describe, it, expect } from 'vitest'
import { publishedMetrics, PROVENANCE, type MetricsContext } from '../../lib/train/metrics'
import { indexFrom } from '../../lib/train/analysis'

/**
 * What Train tells the rest of the dashboard.
 *
 * The premise of this app is that tiles read each other, and Train has
 * been reading Vitals while publishing nothing. This is the other half.
 *
 * TYPED VALUES, NEVER PROSE. A consumer formats for its own surface; a
 * sentence from here would be Train deciding how another tile looks.
 *
 * AND NEVER MORE THAN THE FACT. No exercise names, no per-set detail, no
 * notes, no pain flags. Another tile needs to know the session was hard,
 * not what was in it — publishing less is the reversible choice, and the
 * only one that stays true when a consumer nobody has written yet starts
 * reading.
 *
 * Every value carries where it came from. A logged number, a number
 * computed from logged numbers, and a number resting on a guess are
 * three different things, and a consumer that cannot tell them apart
 * will present a guess as a measurement.
 */

const NOW = new Date(2026, 8, 19, 12).getTime()
const day = (b: number) => {
  const d = new Date(2026, 8, 19 - b)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const TODAY = day(0)

/** An exact split; nothing guessed. */
const index = indexFrom({ bench: { primary: [{ muscle: 'chest', share: 1 }] } })
/** A classifier guess — no contributions, just a name. */
const guessed = indexFrom({ bench: { primary: ['Chest'] } })

const session = (d: string, sets: number, w = 100, over: Record<string, unknown> = {}) => ({
  date: d, kg: w, sets: Array.from({ length: sets }, () => ({ w, r: 5, ...over })),
})

const ctx = (over: Partial<MetricsContext> = {}): MetricsContext => ({
  date: TODAY, history: {}, index, finishedDates: [], bodyweight: [],
  otherTraining: [], deloadLifts: 0, readiness: null, sessionSeconds: null,
  sessionTimingObserved: false, streakTarget: 4, pr: null, now: NOW, ...over,
})

const find = (ms: ReturnType<typeof publishedMetrics>, key: string) => ms.find((m) => m.key === key)

describe('the shape of what goes out', () => {
  const metrics = () => publishedMetrics(ctx({ history: { bench: [session(TODAY, 5)] } }))

  it('gives every metric a key, a date and a provenance', () => {
    const all = metrics()
    expect(all.length).toBeGreaterThan(3)
    for (const m of all) {
      expect(typeof m.key, m.key).toBe('string')
      expect(m.date, m.key).toBe(TODAY)
      expect(PROVENANCE, m.key).toContain(m.provenance)
    }
  })

  it('carries a unit on every number that has one', () => {
    for (const m of metrics()) {
      if (m.value == null) continue
      expect(m.unit === null || typeof m.unit === 'string', m.key).toBe(true)
    }
  })

  it('publishes values, never sentences', () => {
    /* A consumer formats for its own surface. Prose here is Train
       deciding how another tile reads. */
    for (const m of metrics()) {
      const text = JSON.stringify(m)
      expect(text, m.key).not.toMatch(/ [a-z]+ [a-z]+ [a-z]+ /)
    }
  })
})

describe('what must never leave the tile', () => {
  const loaded = publishedMetrics(ctx({
    history: { bench_press_incline: [session(TODAY, 5, 225, { rpe: 9 })] },
    index: indexFrom({ bench_press_incline: { primary: [{ muscle: 'chest', share: 1 }] } }),
  }))
  const blob = JSON.stringify(loaded)

  it('names no exercise', () => {
    expect(blob).not.toContain('bench_press_incline')
  })

  it('carries no per-set detail', () => {
    /* Not the weights, not the reps, not the RPE of any single set. */
    expect(blob).not.toContain('225')
    expect(blob).not.toMatch(/"rpe"/)
    expect(blob).not.toMatch(/"sets":\s*\[/)
  })

  it('carries nothing a person typed', () => {
    const withNote = publishedMetrics(ctx({
      history: { bench: [{ ...session(TODAY, 5), note: 'left shoulder hurts' } as never] },
    }))
    expect(JSON.stringify(withNote)).not.toContain('shoulder')
  })

  it('still says something', () => {
    /* The control for all three: publishing nothing satisfies them. */
    expect(loaded.length).toBeGreaterThan(3)
  })
})

describe('a rest day is a decision; an empty day is not', () => {
  const stateOn = (over: Partial<MetricsContext>) =>
    find(publishedMetrics(ctx(over)), 'trained')?.state

  it('reports a day with working sets as trained', () => {
    expect(stateOn({ history: { bench: [session(TODAY, 5)] } })).toBe('trained')
  })

  it('reports a day logged off as rest', () => {
    expect(stateOn({ history: { bench: [{ ...session(TODAY, 0), off: true }] } })).toBe('rest')
  })

  it('reports a day with nothing on it as not trained', () => {
    expect(stateOn({})).toBe('not_trained')
  })

  it('does not call a warm-up-only day trained', () => {
    /* Nothing was worked. Calling it training would let a consumer
       report a session that did not happen. */
    expect(stateOn({ history: { bench: [session(TODAY, 3, 45, { warmup: true })] } }))
      .toBe('not_trained')
  })
})

describe('provenance travels with the value', () => {
  it('calls logged hard sets measured', () => {
    const m = find(publishedMetrics(ctx({ history: { bench: [session(TODAY, 5)] } })), 'hard_sets')
    expect(m?.value).toBe(5)
    expect(m?.provenance).toBe('measured')
  })

  it('calls a per-muscle figure derived when the split is authored', () => {
    const all = publishedMetrics(ctx({ history: { bench: [session(TODAY, 5)] } }))
    expect(find(all, 'hard_sets.chest')?.provenance).toBe('derived')
  })

  it('calls it estimated when the split came from the classifier', () => {
    /* A guessed muscle split is a guess about the athlete's body, and a
       consumer showing it beside a logged number must be able to say so. */
    const all = publishedMetrics(ctx({
      history: { bench: [session(TODAY, 5)] }, index: guessed,
    }))
    expect(find(all, 'hard_sets.chest')?.provenance).toBe('estimated')
  })

  it('calls tonnage derived — it is arithmetic on logged numbers', () => {
    const m = find(publishedMetrics(ctx({ history: { bench: [session(TODAY, 3, 100)] } })), 'tonnage')
    expect(m?.value).toBe(1500)
    expect(m?.unit).toBe('lb')
    expect(m?.provenance).toBe('derived')
  })

  it('marks systemic load estimated when self-reported training fed it', () => {
    /* other.ts is emphatic that self-reported effort is a guess. It
       reaches the systemic index, so the index inherits the guess. */
    const history = { bench: Array.from({ length: 30 }, (_, i) => session(day(i * 2), 6)) }
    const clean = publishedMetrics(ctx({ history }))
    const dirty = publishedMetrics(ctx({
      history,
      otherTraining: Array.from({ length: 20 }, (_, i) => ({
        date: day(i), activity: 'conditioning' as const, minutes: 60, intensity: 7,
      })),
    }))
    expect(find(clean, 'load_ratio')?.provenance).toBe('derived')
    expect(find(dirty, 'load_ratio')?.provenance).toBe('estimated')
  })

  it('will not call a migrated timestamp a measurement', () => {
    const observed = publishedMetrics(ctx({
      history: { bench: [session(TODAY, 5)] }, sessionSeconds: 3600, sessionTimingObserved: true,
    }))
    const migrated = publishedMetrics(ctx({
      history: { bench: [session(TODAY, 5)] }, sessionSeconds: 3600, sessionTimingObserved: false,
    }))
    expect(find(observed, 'session_duration')?.provenance).toBe('measured')
    expect(find(migrated, 'session_duration')).toBeUndefined()
  })

  it('calls a logged bodyweight measured', () => {
    const m = find(publishedMetrics(ctx({ bodyweight: [{ date: TODAY, lb: 183 }] })), 'bodyweight')
    expect(m?.value).toBe(183)
    expect(m?.unit).toBe('lb')
    expect(m?.provenance).toBe('measured')
  })
})

describe('metrics that are only published when they exist', () => {
  it('says nothing about readiness when none was produced', () => {
    expect(find(publishedMetrics(ctx({})), 'readiness')).toBeUndefined()
  })

  it('publishes the verdict when one was', () => {
    expect(find(publishedMetrics(ctx({ readiness: 'rest_advised' })), 'readiness')?.state)
      .toBe('rest_advised')
  })

  it('says nothing about a record on a day without one', () => {
    expect(find(publishedMetrics(ctx({ history: { bench: [session(TODAY, 5)] } })), 'pr'))
      .toBeUndefined()
  })

  it('publishes the kind of record when one was set', () => {
    const m = find(publishedMetrics(ctx({
      history: { bench: [session(TODAY, 5)] }, pr: 'e1rm',
    })), 'pr')
    expect(m?.state).toBe('e1rm')
    expect(m?.value).toBe(1)
  })

  it('publishes a deload count of zero rather than staying silent', () => {
    /* Zero deloads is a fact about the programme; absence would read as
       "unknown", which is a different thing. */
    expect(find(publishedMetrics(ctx({})), 'deload_lifts')?.value).toBe(0)
    expect(find(publishedMetrics(ctx({ deloadLifts: 2 })), 'deload_lifts')?.value).toBe(2)
  })

  it('says nothing about bodyweight on a day it was not logged', () => {
    expect(find(publishedMetrics(ctx({ bodyweight: [{ date: day(9), lb: 183 }] })), 'bodyweight'))
      .toBeUndefined()
  })

  it('publishes the streak against the target the athlete chose', () => {
    const all = publishedMetrics(ctx({
      finishedDates: [day(0), day(2), day(4)], streakTarget: 4,
    }))
    expect(find(all, 'streak_sessions')?.value).toBe(3)
    expect(find(all, 'streak_target')?.value).toBe(4)
  })
})

describe('it does not know who is reading', () => {
  it('names no consumer anywhere in the payload', () => {
    const blob = JSON.stringify(publishedMetrics(ctx({ history: { bench: [session(TODAY, 5)] } })))
    for (const tile of ['fuel', 'vitals', 'brand', 'peak', 'finance', 'mentor']) {
      expect(blob.toLowerCase(), tile).not.toContain(tile)
    }
  })

  it('is deterministic — the same day published twice is the same payload', () => {
    const c = ctx({ history: { bench: [session(TODAY, 5)] } })
    expect(JSON.stringify(publishedMetrics(c))).toBe(JSON.stringify(publishedMetrics(c)))
  })
})

describe('the edges of each published number', () => {
  it('counts a session on the oldest day of the streak window', () => {
    /* Six days back is inside a seven-day week; seven is last week's. */
    expect(find(publishedMetrics(ctx({ finishedDates: [day(6)] })), 'streak_sessions')?.value).toBe(1)
    expect(find(publishedMetrics(ctx({ finishedDates: [day(7)] })), 'streak_sessions')?.value).toBe(0)
  })

  it('counts a session logged today', () => {
    expect(find(publishedMetrics(ctx({ finishedDates: [TODAY] })), 'streak_sessions')?.value).toBe(1)
  })

  it('does not count a session dated after the day being described', () => {
    /* Backdated publishing describes ONE day; a later session belongs to
       a later payload, not this one. */
    const all = publishedMetrics(ctx({ date: day(3), finishedDates: [day(3), TODAY] }))
    expect(find(all, 'streak_sessions')?.value).toBe(1)
  })

  it('withholds a session duration of zero rather than publishing it', () => {
    /* Zero seconds is not a measurement of anything. */
    expect(find(publishedMetrics(ctx({ sessionSeconds: 0, sessionTimingObserved: true })), 'session_duration'))
      .toBeUndefined()
    expect(find(publishedMetrics(ctx({ sessionSeconds: 1, sessionTimingObserved: true })), 'session_duration')?.value)
      .toBe(1)
  })

  describe('the load band, at its own edges and through the real payload', () => {
    /* The band is the consumer's whole summary of the ratio — most will
       show it and never the number — so its edges are the contract.
       These fixtures were found by search: an EWMA ratio cannot be
       dialled to a round number by hand. */
    const blockOf = (weeks: number, sets: number, endsAgo: number) => {
      const out = []
      for (let w = 0; w < weeks; w++)
        for (const i of [0, 2, 4]) out.push(session(day(endsAgo + w * 7 + i), sets))
      return out
    }
    const bandFor = (baseSets: number, recentSets: number) => {
      const history = { bench: [...blockOf(10, baseSets, 8), ...blockOf(1, recentSets, 1)] }
      return find(publishedMetrics(ctx({ history })), 'load_ratio')
    }

    it('calls exactly the top of the band in, not over', () => {
      const m = bandFor(6, 16)
      expect(m?.value).toBe(1.5)
      expect(m?.state).toBe('in')
    })

    it('calls one hundredth above it over', () => {
      const m = bandFor(7, 19)
      expect(m?.value).toBeCloseTo(1.51, 5)
      expect(m?.state).toBe('over')
    })

    it('calls exactly the bottom of the band in, not under', () => {
      const m = bandFor(19, 10)
      expect(m?.value).toBe(0.8)
      expect(m?.state).toBe('in')
    })

    it('calls one hundredth below it under', () => {
      const m = bandFor(6, 3)
      expect(m?.value).toBeCloseTo(0.79, 5)
      expect(m?.state).toBe('under')
    })
  })

  it('reports a trained day as one and every other day as zero', () => {
    /* The number and the state must agree: a consumer summing `value`
       across a month is counting training days. */
    const valueFor = (over: Partial<MetricsContext>) => find(publishedMetrics(ctx(over)), 'trained')
    expect(valueFor({ history: { bench: [session(TODAY, 5)] } })?.value).toBe(1)
    expect(valueFor({ history: { bench: [{ ...session(TODAY, 0), off: true }] } })?.value).toBe(0)
    expect(valueFor({})?.value).toBe(0)
  })
})
