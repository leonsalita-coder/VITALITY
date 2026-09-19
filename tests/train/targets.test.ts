import { describe, it, expect } from 'vitest'
import {
  weeklySetBand, deloadCut, repRangeFor, streakTarget, profileFor,
} from '../../lib/train/targets'
import { defaultRepRange } from '../../lib/train/classify'
import { deloadPlan } from '../../lib/train/deload'
import { weeklySets, indexFrom } from '../../lib/train/analysis'
import { DEFAULT_WEEKLY_TARGET } from '../../lib/train/streaks'

/**
 * Targets that belong to the user.
 *
 * The property under test throughout: a finding must never fire SOLELY
 * because someone trains less than a default they never chose.
 */

describe('the band floor', () => {
  it('is absent entirely when nothing is known about the athlete', () => {
    const band = weeklySetBand({})
    expect(band.floor).toBeNull()
    expect(band.floorSource).toBe('none')
  })

  it('comes from the age profile once they state a training age', () => {
    expect(weeklySetBand({ trainingAge: 'beginner' })).toMatchObject({ floor: 5, floorSource: 'age' })
    expect(weeklySetBand({ trainingAge: 'advanced' })).toMatchObject({ floor: 12, floorSource: 'age' })
  })

  it('prefers the athlete’s own trailing average over any profile', () => {
    const band = weeklySetBand({ trainingAge: 'advanced', trailingSets: 8 })
    expect(band.floorSource).toBe('trailing')
    expect(band.floor).toBe(4.8) // 60% of their own norm, not the 12 a profile would impose
  })

  it('ignores a trailing average too thin to be a norm', () => {
    const band = weeklySetBand({ trainingAge: 'beginner', trailingSets: 2 })
    expect(band.floorSource).toBe('age')
  })

  it('ignores a garbage trailing average rather than deriving a floor from it', () => {
    for (const junk of [NaN, Infinity, null, undefined]) {
      expect(weeklySetBand({ trailingSets: junk as never }).floorSource).toBe('none')
    }
  })
})

describe('the band ceiling', () => {
  it('is absolute — too much volume is a real risk at any training age', () => {
    expect(weeklySetBand({ trainingAge: 'beginner' }).ceiling).toBe(14)
    expect(weeklySetBand({ trainingAge: 'advanced' }).ceiling).toBe(25)
  })

  it('does not move when the athlete’s own average is low', () => {
    expect(weeklySetBand({ trainingAge: 'intermediate', trailingSets: 5 }).ceiling)
      .toBe(weeklySetBand({ trainingAge: 'intermediate' }).ceiling)
  })
})

describe('an unstated training age keeps every shipped NUMBER', () => {
  /* Scaling is additive in the numbers: someone who never answered the
     onboarding gets exactly the thresholds the app used yesterday.
     One behaviour DOES change, deliberately — an under-band finding no
     longer fires off an age profile nobody chose (see the beginner case
     below). The numbers themselves are untouched. */
  it('keeps the 10-20 band', () => {
    const band = weeklySetBand({ trainingAge: null })
    expect([profileFor(null).floor, band.ceiling]).toEqual([10, 20])
  })

  it('keeps the 10% measured and 5% inferred deloads', () => {
    expect(deloadCut(null, 'measured')).toBe(0.9)
    expect(deloadCut(null, 'inferred')).toBe(0.95)
  })

  it('keeps the shipped rep ranges', () => {
    expect([repRangeFor(null, 1), repRangeFor(null, 2), repRangeFor(null, 3)])
      .toEqual([[4, 6], [6, 10], [10, 15]])
  })
})

describe('deload depth scales with training age', () => {
  it('is gentler on a beginner, who recovers fast', () => {
    expect(deloadCut('beginner', 'measured')).toBeGreaterThan(deloadCut('intermediate', 'measured'))
  })

  it('is deeper on an advanced lifter, who does not', () => {
    expect(deloadCut('advanced', 'measured')).toBeLessThan(deloadCut('intermediate', 'measured'))
  })

  it('stays gentler when inferred than when measured, at every age', () => {
    for (const age of ['beginner', 'intermediate', 'advanced'] as const) {
      expect(deloadCut(age, 'inferred')).toBeGreaterThan(deloadCut(age, 'measured'))
    }
  })

  it('reaches the actual prescription — the same stall cuts a beginner less', () => {
    const record = {
      state: 'deloading' as const, kind: 'intensity' as const, confidence: 'measured' as const,
      priorWeight: 200, since: '2026-09-01', plateauLength: 3, sessions: 0,
    }
    expect(deloadPlan(record, 'beginner').weight).toBe(190)
    expect(deloadPlan(record, 'advanced').weight).toBe(170)
  })
})

describe('rep ranges scale with training age', () => {
  it('gives a beginner more reps on a compound, where technique is the limit', () => {
    expect(repRangeFor('beginner', 1)).toEqual([5, 8])
    expect(repRangeFor('advanced', 1)).toEqual([3, 5])
  })

  it('reaches classification — the same lift gets a different starting range', () => {
    expect(defaultRepRange(1, 'reps_weight', 'beginner')).toEqual([5, 8])
    expect(defaultRepRange(1, 'reps_weight', 'advanced')).toEqual([3, 5])
  })

  it('still gives a plank no rep range at any age', () => {
    for (const age of ['beginner', 'intermediate', 'advanced'] as const) {
      expect(defaultRepRange(1, 'time', age)).toBeNull()
    }
  })
})

describe('the streak target is what they said, not a constant', () => {
  it('uses a stated frequency', () => {
    expect(streakTarget(2)).toBe(2)
  })

  it('falls back only when nothing was ever stated', () => {
    expect(streakTarget(null)).toBe(DEFAULT_WEEKLY_TARGET)
    expect(streakTarget(undefined)).toBe(DEFAULT_WEEKLY_TARGET)
  })

  it('clamps nonsense rather than storing it', () => {
    expect(streakTarget(0)).toBe(1)
    expect(streakTarget(99)).toBe(14)
    expect(streakTarget(NaN)).toBe(DEFAULT_WEEKLY_TARGET)
  })
})

/* ---- the three cases the spec names, driven through the real analysis ---- */

const CHEST = { primary: [{ muscle: 'chest', share: 1 }] }
const BACK = { primary: [{ muscle: 'lats', share: 1 }] }
const LEGS = { primary: [{ muscle: 'quads', share: 1 }] }

const NOW = new Date(2026, 8, 19, 12).getTime()
const day = (back: number) => {
  const d = new Date(2026, 8, 19 - back)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const sets = (n: number) => Array.from({ length: n }, () => ({ w: 100, r: 8 }))
const session = (back: number, n: number) => ({ date: day(back), kg: 100, sets: sets(n) })

const index = indexFrom({ bench: CHEST, pulldown: BACK, squat: LEGS })

describe('a beginner doing six good sets a week', () => {
  const history = {
    bench: [session(1, 3), session(4, 3)],
    pulldown: [session(2, 3), session(5, 3)],
    squat: [session(3, 3), session(6, 3)],
  }

  /* The shipped app said "under the 10-set band" here, every week,
     forever. Six good sets is not a problem to be reported — it is a
     beginner training. */
  it('is told nothing, with no training age on file', () => {
    expect(weeklySets(history, index, NOW).filter((f) => /under/.test(f.text))).toEqual([])
  })

  it('is told nothing once the app knows they are a beginner either', () => {
    const findings = weeklySets(history, index, NOW, { trainingAge: 'beginner' })
    expect(findings.filter((f) => /under/.test(f.text))).toEqual([])
  })

  it('is still told when they go OVER what a beginner can absorb', () => {
    const heavy = { bench: [session(1, 9), session(4, 9)] }
    const findings = weeklySets(heavy, index, NOW, { trainingAge: 'beginner' })
    expect(findings.filter((f) => /above/.test(f.text)).length).toBe(1)
  })
})

describe('the same history reads differently at two training ages', () => {
  const history = {
    bench: [session(1, 8), session(4, 8)],
    pulldown: [session(2, 8), session(5, 8)],
    squat: [session(3, 8), session(6, 8)],
  }

  it('is over the ceiling for a beginner and fine for an advanced lifter', () => {
    const asBeginner = weeklySets(history, index, NOW, { trainingAge: 'beginner' })
    const asAdvanced = weeklySets(history, index, NOW, { trainingAge: 'advanced' })
    expect(asBeginner.filter((f) => /above/.test(f.text)).length).toBeGreaterThan(0)
    expect(asAdvanced.filter((f) => /above/.test(f.text))).toEqual([])
  })
})

describe('one week of history is not yet a norm', () => {
  /* The trailing average is the athlete's own evidence, so it has to BE
     evidence. A single prior week is a week, not a pattern, and deriving
     a floor from it is the same mistake as an unchosen default wearing
     a friendlier name. */
  const history = {
    bench: [session(1, 2), session(8, 12)],
    pulldown: [session(2, 6), session(9, 6)],
    squat: [session(3, 6), session(10, 6)],
  }

  it('reports no drop against a single week of prior training', () => {
    const findings = weeklySets(history, index, NOW)
    expect(findings.filter((f) => /average/.test(f.text))).toEqual([])
  })

  it('reports it once a second prior week makes the average real', () => {
    const longer = {
      ...history,
      bench: [session(1, 2), session(8, 12), session(15, 12)],
    }
    const findings = weeklySets(longer, index, NOW)
    expect(findings.filter((f) => /average/.test(f.text)).length).toBe(1)
  })
})

describe('weeks before they started are not counted as zeroes', () => {
  /* Averaging over four fixed weeks when only two of them exist halves
     the athlete's norm, and a floor derived from a phantom zero is too
     low to ever catch the drop it was built to catch. */
  const history = {
    bench: [session(1, 4), session(8, 10), session(15, 10)],
    pulldown: [session(2, 6), session(9, 6), session(16, 6)],
    squat: [session(3, 6), session(10, 6), session(17, 6)],
  }

  it('reports a drop to 4 sets against a real average of 10', () => {
    const drop = weeklySets(history, index, NOW).find((f) => /Chest/.test(f.text))
    expect(drop).toBeTruthy()
    expect(drop!.text).toContain('recent average of 10')
  })
})

describe('a real drop below the athlete’s own norm still fires', () => {
  /* The other half of the property. Scaling must not turn the analysis
     mute — "less than you have been doing" is a fact about them, and
     is exactly what is worth saying. */
  const history = {
    bench: [
      session(1, 2),                                            // this week: 2 sets
      session(8, 10), session(11, 10),                           // four prior weeks
      session(15, 10), session(18, 10),
      session(22, 10), session(25, 10),
      session(29, 10), session(32, 10),
    ],
    pulldown: [session(2, 6), session(9, 6), session(16, 6), session(23, 6), session(30, 6)],
    squat: [session(3, 6), session(10, 6), session(17, 6), session(24, 6), session(31, 6)],
  }

  it('names their own average rather than a generic band', () => {
    const findings = weeklySets(history, index, NOW, { trainingAge: 'beginner' })
    const drop = findings.find((f) => /Chest/.test(f.text) && /under/.test(f.text))
    expect(drop).toBeTruthy()
    expect(drop!.text).toMatch(/average/)
    expect(drop!.text).not.toMatch(/band/)
  })
})
