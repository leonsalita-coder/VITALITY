import { describe, it, expect } from 'vitest'
import {
  normalizeOtherEntry, otherLoadOf, recentOtherLoad,
  trainingDates, otherTrainingLines,
  HARD_OTHER_LOAD, MODERATE_OTHER_LOAD, SYSTEMIC_WINDOW_DAYS,
  type OtherEntry,
} from '../../lib/train/other'
import { assessReadiness, type ReadinessContext } from '../../lib/train/readiness'
import { detectPlateau, nextDeloadState, limitDeloads } from '../../lib/train/deload'
import { workingVolume } from '../../lib/train/sets'
import { classifyPR } from '../../lib/train/records'
import { currentWeekStreak } from '../../lib/train/streaks'

/**
 * Training that isn't lifting.
 *
 * Two constraints run this whole file.
 *
 *   The load contribution is ESTIMATED. Self-reported intensity times
 *   duration is a crude proxy with no objective anchor — the same class of
 *   number as a classifier's muscle split. Everything downstream has to
 *   know it is reasoning from a guess.
 *
 *   It SUPPRESSES, it does not PRESCRIBE. Systemic fatigue is real, so
 *   two hours of sparring may hold a session back. The causal link from
 *   that to "your bench is stalled" is far too weak to act on, and a wrong
 *   deload attributed to something the athlete only roughly described is
 *   the fastest way to lose trust in the mechanism entirely.
 */

const entry = (over: Record<string, unknown> = {}): OtherEntry =>
  normalizeOtherEntry({ date: '2026-09-18', activity: 'conditioning', minutes: 60, intensity: 8, ...over })!

/* Readiness is the only entry point suppression has, by design, so every
   suppression test below goes through it. `base` is a context with nothing
   measured to say, which is the only state suppression may speak from. */
const base = (over: Partial<ReadinessContext> = {}): ReadinessContext => ({
  recovery: null, recentHardSets: null, baselineHardSets: null,
  activeDeload: false, restAdvisedDates: [], today: TODAY, ...over,
})

const TODAY = '2026-09-19'
const back = (n: number) => {
  const d = new Date(2026, 8, 19 - n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const raw = (over: Record<string, unknown> = {}) =>
  ({ date: '2026-09-18', activity: 'conditioning', minutes: 60, intensity: 8, ...over })

describe('an entry is three things: what, how long, how hard', () => {
  it('accepts a plain one', () => {
    expect(normalizeOtherEntry(raw())).toMatchObject({
      activity: 'conditioning', minutes: 60, intensity: 8,
    })
  })

  it('keeps an activity nobody anticipated rather than losing the session', () => {
    expect(normalizeOtherEntry(raw({ activity: 'astral_projection' }))!.activity).toBe('other')
  })

  it('clamps a self-report rather than storing nonsense', () => {
    expect(normalizeOtherEntry(raw({ intensity: 99 }))!.intensity).toBe(10)
    expect(normalizeOtherEntry(raw({ intensity: -3 }))!.intensity).toBe(1)
    expect(normalizeOtherEntry(raw({ minutes: 9999 }))!.minutes).toBe(600)
  })

  it('rejects an entry with no date, which nothing downstream could place', () => {
    expect(normalizeOtherEntry(raw({ date: '' }))).toBeNull()
    expect(normalizeOtherEntry(null)).toBeNull()
    expect(normalizeOtherEntry('an hour of football')).toBeNull()
  })
})

describe('the load contribution is always marked estimated', () => {
  it('says so on every summary, including an empty one', () => {
    expect(recentOtherLoad([], TODAY).estimated).toBe(true)
    expect(recentOtherLoad([entry()], TODAY).estimated).toBe(true)
  })

  it('says so in the words the coach reads', () => {
    const lines = otherTrainingLines(recentOtherLoad([entry()], TODAY))
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.join(' ')).toMatch(/estimated|self-reported/i)
  })

  it('says so in the reason an athlete sees, on BOTH branches', () => {
    /* Two verdicts come out of suppression and each has its own sentence.
       Testing one of them leaves the other free to read like a
       measurement — which is the whole thing this constraint forbids. */
    const hard = recentOtherLoad([entry({ minutes: 120, intensity: 9 })], TODAY)
    const moderate = recentOtherLoad([entry({ minutes: 40, intensity: 9 })], TODAY)

    const hardResult = assessReadiness(base({ otherLoad: hard }))
    const moderateResult = assessReadiness(base({ otherLoad: moderate }))

    expect(hardResult.verdict).toBe('reduced_volume')
    expect(moderateResult.verdict).toBe('reduced_intensity')
    for (const result of [hardResult, moderateResult]) {
      expect(result.reason).toMatch(/told me|reported|estimate/i)
      expect(result.confidence).toBe('inferred')
    }
  })

  it('is always inferred, even alongside a measured recovery reading', () => {
    const summary = recentOtherLoad([entry({ minutes: 120, intensity: 9 })], TODAY)
    // recovery 85 is measured and has nothing to say; the verdict that
    // comes back is the estimate's, so its confidence must be too
    const result = assessReadiness(base({ recovery: 85, otherLoad: summary }))
    expect(result.verdict).toBe('reduced_volume')
    expect(result.confidence).toBe('inferred')
  })

  it('is never expressed in hard sets — there is no conversion to invent', () => {
    const summary = recentOtherLoad([entry()], TODAY) as unknown as Record<string, unknown>
    expect(summary.hardSets).toBeUndefined()
    expect(summary.sets).toBeUndefined()
  })
})

describe('load is duration by self-reported intensity, and nothing cleverer', () => {
  it('multiplies the two', () => {
    expect(otherLoadOf(normalizeOtherEntry(entry({ minutes: 60, intensity: 8 }))!)).toBe(480)
  })

  it('sums across a short systemic window', () => {
    const entries = [entry({ date: back(1) }), entry({ date: back(2) })]
    expect(recentOtherLoad(entries, TODAY).load).toBe(960)
    expect(recentOtherLoad(entries, TODAY).sessions).toBe(2)
  })

  it('ignores anything older than the window — fatigue is short-horizon', () => {
    const stale = [entry({ date: back(SYSTEMIC_WINDOW_DAYS + 1) })]
    expect(recentOtherLoad(stale, TODAY).load).toBe(0)
  })

  it('ignores anything in the future', () => {
    expect(recentOtherLoad([entry({ date: '2027-01-01' })], TODAY).load).toBe(0)
  })
})

describe('suppression', () => {
  const summaryFor = (load: number) =>
    recentOtherLoad([entry({ minutes: load / 10, intensity: 10 })], TODAY)

  it('holds a session back after hard conditioning', () => {
    const result = assessReadiness(base({ otherLoad: summaryFor(HARD_OTHER_LOAD) }))
    expect(result.verdict).toBe('reduced_volume')
    expect(result.setsFactor).toBeLessThan(1)
    expect(result.reason).toContain('conditioning')
  })

  it('eases the weight after a moderate session', () => {
    const result = assessReadiness(base({ otherLoad: summaryFor(MODERATE_OTHER_LOAD) }))
    expect(result.verdict).toBe('reduced_intensity')
    expect(result.weightFactor).toBeLessThan(1)
  })

  it('says nothing after an easy walk', () => {
    const easy = recentOtherLoad([entry({ minutes: 30, intensity: 2 })], TODAY)
    expect(assessReadiness(base({ otherLoad: easy })).reason).toBeNull()
  })

  it('never advises rest — the strongest call the app makes needs better evidence', () => {
    const enormous = recentOtherLoad(
      [entry({ minutes: 600, intensity: 10 }), entry({ date: back(1), minutes: 600, intensity: 10 })],
      TODAY,
    )
    expect(assessReadiness(base({ otherLoad: enormous })).verdict).not.toBe('rest_advised')
  })

  it('never overrides a measured rest verdict with something softer', () => {
    const result = assessReadiness(base({
      recovery: 30, otherLoad: summaryFor(HARD_OTHER_LOAD),
    }))
    expect(result.verdict).toBe('rest_advised')
    expect(result.confidence).toBe('measured')
  })

  it('leaves a stronger measured verdict alone rather than talking over it', () => {
    const measured = assessReadiness(base({ recovery: 50 }))
    const withOther = assessReadiness(base({ recovery: 50, otherLoad: summaryFor(MODERATE_OTHER_LOAD) }))
    expect(withOther).toEqual(measured)
    expect(withOther.confidence).toBe('measured')
  })

  it('stays silent when a lift is already mid-deload, like everything else here', () => {
    /* The bug this ordering exists to prevent: a lift already carrying a
       cut, suppressed a second time on the strength of a self-report. */
    const result = assessReadiness(base({
      activeDeload: true, otherLoad: summaryFor(HARD_OTHER_LOAD * 2),
    }))
    expect(result.setsFactor).toBe(1)
    expect(result.weightFactor).toBe(1)
    expect(result.reason).toBeNull()
  })

  it('is the only thing that can speak from an otherwise empty context', () => {
    // nothing measured at all: without other training this is silence
    expect(assessReadiness(base()).reason).toBeNull()
    expect(assessReadiness(base({ otherLoad: summaryFor(HARD_OTHER_LOAD) })).reason).not.toBeNull()
  })
})

/* ---------------- it must never reach a specific lift ---------------- */

describe('it never produces or worsens a deload', () => {
  const set = (w: number, r: number) => ({ w, r })
  const stalled = [
    { date: back(2), kg: 200, sets: [set(200, 5), set(200, 5)] },
    { date: back(9), kg: 200, sets: [set(200, 5), set(200, 5)] },
    { date: back(16), kg: 200, sets: [set(200, 5), set(200, 5)] },
    { date: back(23), kg: 200, sets: [set(200, 5), set(200, 5)] },
  ]
  const brutal = Array.from({ length: SYSTEMIC_WINDOW_DAYS }, (_, i) =>
    entry({ date: back(i), minutes: 600, intensity: 10 }))

  it('is a hard enough week to suppress readiness, so the silence below means something', () => {
    // without this the four tests after it could pass on a fixture that
    // simply contains nothing
    const summary = recentOtherLoad(brutal, TODAY)
    expect(summary.load).toBeGreaterThanOrEqual(HARD_OTHER_LOAD)
    expect(assessReadiness(base({ otherLoad: summary })).verdict).toBe('reduced_volume')
  })

  it('does not change whether a lift reads as plateaued', () => {
    const plateau = detectPlateau(stalled, {})
    expect(plateau).toBeTruthy()
    expect(detectPlateau(stalled, {})).toEqual(plateau)
  })

  it('cannot reach the deload state machine — its context has no door for it', () => {
    const ctx = {
      history: stalled, today: TODAY, recovery: null, rpe: null, sessionLogged: true,
    }
    const record = nextDeloadState(null, ctx)
    expect(record).toBeTruthy()
    /* Every field the state machine reads, enumerated. Adding other
       training to this context is the change this test is here to make
       somebody argue for out loud rather than slip in. */
    expect(Object.keys(ctx).sort()).toEqual(
      ['history', 'recovery', 'rpe', 'sessionLogged', 'today'],
    )
    expect(nextDeloadState(null, ctx)).toEqual(record)
  })

  it('never appears among the lifts chosen to drop', () => {
    const chosen = limitDeloads([
      { id: 'bench', weight: 200, plateauLength: 3 },
      { id: 'squat', weight: 300, plateauLength: 3 },
    ])
    expect(chosen.every((id) => ['bench', 'squat'].includes(id))).toBe(true)
  })

  it('a suppressed verdict still cannot stack onto a deload', () => {
    const result = assessReadiness(base({
      recovery: 40, recentHardSets: 30, baselineHardSets: 10,
      activeDeload: true, otherLoad: recentOtherLoad(brutal, TODAY),
    }))
    expect(result.setsFactor).toBe(1)
    expect(result.weightFactor).toBe(1)
    expect(result.reason).toBeNull()
  })
})

describe('it never enters lift volume or records', () => {
  /* Structural, not careful: an other-training entry is not a history row,
     so the functions that compute volume and records have no argument
     through which one could arrive. These assert that the shapes really
     are disjoint rather than that somebody remembered to filter. */
  it('carries none of the fields a history entry is read through', () => {
    const e = entry() as unknown as Record<string, unknown>
    expect(e.sets).toBeUndefined()
    expect(e.kg).toBeUndefined()
    expect(e.w).toBeUndefined()
    expect(e.r).toBeUndefined()
  })

  it('contributes nothing to volume even if one were somehow passed in', () => {
    expect(workingVolume(entry() as never))
      .toEqual({ load: 0, loadUnavailable: false, reps: 0, seconds: 0, metres: 0 })
  })

  it('cannot produce a PR — a candidate is weight and reps, which it has neither of', () => {
    expect(classifyPR([], entry() as never, Date.now()).kind).toBeNull()
  })

  it('leaves a real lift’s record exactly as it was', () => {
    const lift = [{ date: back(9), kg: 200, sets: [{ w: 200, r: 5 }] }]
    const now = new Date(2026, 8, 19).getTime()
    const pr = classifyPR(lift, { weight: 210, reps: 5 }, now)
    // the PR stands on the lift alone, and there is no argument here
    // through which anything above could have changed it
    expect(pr.kind).not.toBeNull()
    expect(classifyPR(lift, { weight: 210, reps: 5 }, now)).toEqual(pr)
  })
})

describe('it does count as having trained', () => {
  it('holds a streak on weeks of running alone', () => {
    const lifted: string[] = []
    const ran = [1, 3, 8, 10, 15, 17, 22, 24].map((n) => entry({ date: back(n) }))
    const dates = trainingDates(lifted, ran)
    expect(currentWeekStreak(dates, 2, new Date(2026, 8, 19, 12).getTime())).toBeGreaterThanOrEqual(3)
  })

  it('does not double-count a day that had both', () => {
    const dates = trainingDates([back(1)], [entry({ date: back(1) })])
    expect(dates).toEqual([back(1)])
  })

  it('leaves the lifting record itself untouched', () => {
    const lifted = [back(1), back(3)]
    trainingDates(lifted, [entry({ date: back(5) })])
    expect(lifted).toEqual([back(1), back(3)])
  })
})
