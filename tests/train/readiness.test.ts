import { describe, it, expect } from 'vitest'
import {
  REST_FLOOR, LOW_RECOVERY, MODERATE_RECOVERY, LOAD_SPIKE, REST_ADVICE_COOLDOWN_DAYS,
  assessReadiness,
} from '../../lib/train/readiness'
import type { ReadinessContext } from '../../lib/train/readiness'
import { HARD_OTHER_LOAD } from '../../lib/train/other'
import type { OtherLoadSummary } from '../../lib/train/other'

const ctx = (over: Partial<ReadinessContext> = {}): ReadinessContext => ({
  recovery: null,
  recentHardSets: null,
  baselineHardSets: null,
  activeDeload: false,
  restAdvisedDates: [],
  today: '2026-09-19',
  ...over,
})

describe('each verdict from its own signal', () => {
  it('advises rest on genuinely low recovery', () => {
    const r = assessReadiness(ctx({ recovery: REST_FLOOR - 10 }))
    expect(r.verdict).toBe('rest_advised')
    expect(r.setsFactor).toBe(0)
    expect(r.reason).toMatch(/rest day/i)
  })

  it('cuts volume on low recovery', () => {
    const r = assessReadiness(ctx({ recovery: LOW_RECOVERY - 5 }))
    expect(r.verdict).toBe('reduced_volume')
    expect(r.setsFactor).toBeLessThan(1)
    expect(r.weightFactor).toBe(1)
  })

  it('eases weight on middling recovery', () => {
    const r = assessReadiness(ctx({ recovery: MODERATE_RECOVERY - 5 }))
    expect(r.verdict).toBe('reduced_intensity')
    expect(r.weightFactor).toBeLessThan(1)
    expect(r.setsFactor).toBe(1)
  })

  it('cuts volume on a load spike even with no recovery data', () => {
    const r = assessReadiness(ctx({ recentHardSets: 30, baselineHardSets: 18 }))
    expect(r.verdict).toBe('reduced_volume')
    expect(r.confidence).toBe('inferred')
    expect(r.reason).toMatch(/up \d+%/)
  })

  it('says nothing when recovery is good and load is normal', () => {
    const r = assessReadiness(ctx({ recovery: 85, recentHardSets: 18, baselineHardSets: 18 }))
    expect(r.verdict).toBe('normal')
    expect(r.reason).toBeNull()
    expect(r.setsFactor).toBe(1)
    expect(r.weightFactor).toBe(1)
  })

  it('states the reason as fact rather than a question', () => {
    const r = assessReadiness(ctx({ recovery: 40 }))
    expect(r.reason).not.toMatch(/\?|should you|do you want/i)
    expect(r.reason).toMatch(/^Recovery is \d+\/100\./)
  })
})

describe('each recovery tier ends exactly on its floor, not before', () => {
  it('is not rest-advised at exactly REST_FLOOR — that tier is strictly below it', () => {
    const r = assessReadiness(ctx({ recovery: REST_FLOOR }))
    expect(r.verdict).not.toBe('rest_advised')
    expect(r.verdict).toBe('reduced_volume') // falls to the next tier down
    expect(r.setsFactor).toBe(0.6)
  })

  it('is not the low-recovery cut at exactly LOW_RECOVERY — that tier is strictly below it', () => {
    const r = assessReadiness(ctx({ recovery: LOW_RECOVERY }))
    expect(r.setsFactor).toBe(1) // the 0.6 sets cut did not fire
    expect(r.verdict).toBe('reduced_intensity') // falls to the next tier down
    expect(r.weightFactor).toBeLessThan(1)
  })

  it('is not weight-eased at exactly MODERATE_RECOVERY — that tier is strictly below it', () => {
    const r = assessReadiness(ctx({ recovery: MODERATE_RECOVERY }))
    expect(r.weightFactor).toBe(1) // the 0.9 weight ease did not fire
    expect(r.verdict).toBe('normal')
    expect(r.reason).toBeNull()
    expect(r.confidence).toBe('measured') // control: recovery WAS read, it just had nothing to say
  })
})

describe('silence without signal', () => {
  it('says nothing at all with neither recovery nor load', () => {
    const r = assessReadiness(ctx())
    expect(r.verdict).toBe('normal')
    expect(r.reason).toBeNull()
  })

  it('says nothing with a load figure but no baseline to compare it to', () => {
    expect(assessReadiness(ctx({ recentHardSets: 30 })).reason).toBeNull()
  })

  it('says nothing with a zero baseline, which is not a comparison', () => {
    expect(assessReadiness(ctx({ recentHardSets: 30, baselineHardSets: 0 })).reason).toBeNull()
  })

  it('never scales anything while silent', () => {
    const r = assessReadiness(ctx())
    expect(r.setsFactor).toBe(1)
    expect(r.weightFactor).toBe(1)
  })
})

describe('it does not stack with a deload', () => {
  it('stays silent when a lift is already being deloaded', () => {
    const r = assessReadiness(ctx({ recovery: 20, activeDeload: true }))
    expect(r.verdict).toBe('normal')
    expect(r.reason).toBeNull()
  })

  it('applies exactly one adjustment, never two', () => {
    const withDeload = assessReadiness(ctx({ recovery: 20, activeDeload: true }))
    expect(withDeload.setsFactor).toBe(1)
    expect(withDeload.weightFactor).toBe(1)
  })

  it('resumes once the deload is over', () => {
    expect(assessReadiness(ctx({ recovery: 20, activeDeload: false })).verdict).toBe('rest_advised')
  })

  it('suppresses a load-spike call too, not just a recovery one', () => {
    const r = assessReadiness(ctx({ recentHardSets: 40, baselineHardSets: 18, activeDeload: true }))
    expect(r.reason).toBeNull()
  })
})

describe('the rest-advice cap', () => {
  const recent = (daysAgo: number) => {
    const d = new Date('2026-09-19T12:00:00')
    d.setDate(d.getDate() - daysAgo)
    const p = (x: number) => String(x).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }

  it('advises rest when none has been advised recently', () => {
    const r = assessReadiness(ctx({ recovery: 20, restAdvisedDates: [recent(30)] }))
    expect(r.verdict).toBe('rest_advised')
  })

  it('refuses to advise rest twice inside the window', () => {
    const r = assessReadiness(ctx({ recovery: 20, restAdvisedDates: [recent(2)] }))
    expect(r.verdict).not.toBe('rest_advised')
  })

  it('degrades to the next strongest call rather than going silent', () => {
    const r = assessReadiness(ctx({ recovery: 20, restAdvisedDates: [recent(2)] }))
    expect(r.verdict).toBe('reduced_volume')
    expect(r.reason).toMatch(/rested recently/i)
    expect(r.setsFactor).toBeLessThan(1)
  })

  it('frees up again once the window passes', () => {
    const r = assessReadiness(ctx({ recovery: 20, restAdvisedDates: [recent(REST_ADVICE_COOLDOWN_DAYS)] }))
    expect(r.verdict).toBe('rest_advised')
  })

  it('is not fooled by a future date', () => {
    const r = assessReadiness(ctx({ recovery: 20, restAdvisedDates: ['2027-01-01'] }))
    expect(r.verdict).not.toBe('rest_advised')
  })
})

describe('precedence', () => {
  it('lets low recovery outrank a load spike — the body outranks the plan', () => {
    const r = assessReadiness(ctx({ recovery: 40, recentHardSets: 40, baselineHardSets: 18 }))
    expect(r.verdict).toBe('reduced_volume')
    expect(r.reason).toMatch(/Recovery/)
  })

  it('reports a spike when recovery is fine', () => {
    const r = assessReadiness(ctx({ recovery: 90, recentHardSets: 40, baselineHardSets: 18 }))
    expect(r.reason).toMatch(/Hard sets are up/)
    expect(r.confidence).toBe('measured')
  })

  it('is exactly at the spike threshold, not past it', () => {
    const base = 20
    expect(assessReadiness(ctx({ recentHardSets: base * LOAD_SPIKE, baselineHardSets: base })).verdict)
      .toBe('reduced_volume')
    expect(assessReadiness(ctx({ recentHardSets: base * (LOAD_SPIKE - 0.1), baselineHardSets: base })).verdict)
      .toBe('normal')
  })
})

describe('self-reported training names how many sessions, correctly pluralised', () => {
  const summary = (sessions: number): OtherLoadSummary => ({
    load: HARD_OTHER_LOAD, sessions, days: sessions, estimated: true,
    hardest: { date: '2026-09-18', activity: 'martial_arts', minutes: 90, intensity: 8 },
  })

  it('names no extra sessions at exactly one — "plus 0 more" is not a sentence', () => {
    const r = assessReadiness(ctx({ otherLoad: summary(1) }))
    expect(r.reason).not.toMatch(/plus/i)
  })

  it('names the extra sessions once there genuinely is more than one', () => {
    const r = assessReadiness(ctx({ otherLoad: summary(2) }))
    expect(r.reason).toMatch(/plus 1 more/i)
  })
})
