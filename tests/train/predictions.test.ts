import { describe, it, expect } from 'vitest'
import {
  scorePrediction, accuracyOver, progressionDamping, recordPrediction,
  MIN_SCORED_FOR_FEEDBACK, EASY_MARGIN, type Prediction,
} from '../../lib/train/predictions'
import { suggestTarget } from '../../lib/train/progression'

/**
 * Every suggestion is a prediction. Nothing recorded whether it came true.
 *
 * Scoring itself is the single most trust-building thing this engine can
 * do, because it turns every other claim from asserted into checkable.
 *
 * THE RULE THAT MAKES IT MEAN ANYTHING: a prediction is written once, at
 * session start, and never rewritten. A prediction that can be edited
 * after the outcome is not a prediction, it is a record of the outcome
 * wearing a prediction's name.
 */

const pred = (over: Partial<Prediction> = {}): Prediction => ({
  id: 'bench', date: '2026-09-19', weight: 200, reps: 5, seconds: null, metres: null,
  basis: 'clean', deloadState: null, readiness: 'normal', madeAt: 1, ...over,
})

const entry = (sets: Array<{ w: number; r: number }>) => ({
  date: '2026-09-19', kg: Math.max(...sets.map((s) => s.w)), sets,
})

describe('scoring one prediction', () => {
  it('is a hit when the work matched', () => {
    expect(scorePrediction(pred(), entry([{ w: 200, r: 5 }, { w: 200, r: 5 }]))).toBe('hit')
  })

  it('is missed HIGH when the reps came up short', () => {
    expect(scorePrediction(pred(), entry([{ w: 200, r: 5 }, { w: 200, r: 3 }]))).toBe('missed_high')
  })

  it('is missed HIGH when they loaded less than suggested', () => {
    expect(scorePrediction(pred(), entry([{ w: 185, r: 5 }]))).toBe('missed_high')
  })

  it('is missed LOW when it was far too easy', () => {
    const easy = entry([{ w: 200, r: 5 + EASY_MARGIN }, { w: 200, r: 5 + EASY_MARGIN }])
    expect(scorePrediction(pred(), easy)).toBe('missed_low')
  })

  it('is not attempted when the lift was not trained', () => {
    expect(scorePrediction(pred(), null)).toBe('not_attempted')
    expect(scorePrediction(pred(), entry([]))).toBe('not_attempted')
  })

  it('ignores warm-ups when deciding', () => {
    /* The warm-up has FEWER reps than the target, which is what a heavy
       ramp set looks like. A warm-up with more reps could not change the
       minimum and so could not tell whether it was excluded at all. */
    const withRamp = {
      date: '2026-09-19', kg: 200,
      sets: [{ w: 175, r: 2, warmup: true }, { w: 200, r: 5 }, { w: 200, r: 5 }],
    }
    expect(scorePrediction(pred(), withRamp)).toBe('hit')
  })

  it('scores a time lift in seconds', () => {
    const plank = pred({ weight: null, reps: null, seconds: 60 })
    expect(scorePrediction(plank, { date: '2026-09-19', kg: 0, sets: [{ kind: 'time', s: 60 }] })).toBe('hit')
    expect(scorePrediction(plank, { date: '2026-09-19', kg: 0, sets: [{ kind: 'time', s: 40 }] })).toBe('missed_high')
  })
})

describe('a prediction is written once', () => {
  it('records one per lift per session', () => {
    const store = {}
    const a = recordPrediction(store, pred())
    const b = recordPrediction(store, pred({ weight: 999 }))
    expect(a).toBe(true)
    expect(b).toBe(false)
    expect(Object.values(store)[0]).toMatchObject({ weight: 200 })
  })

  it('refuses to overwrite even when the new one looks better', () => {
    const store = {}
    recordPrediction(store, pred({ weight: 200 }))
    recordPrediction(store, pred({ weight: 205, basis: 'amrap' }))
    expect(Object.values(store)[0]).toMatchObject({ weight: 200, basis: 'clean' })
  })

  it('records a different lift and a different day separately', () => {
    const store = {}
    recordPrediction(store, pred())
    recordPrediction(store, pred({ id: 'squat' }))
    recordPrediction(store, pred({ date: '2026-09-20' }))
    expect(Object.keys(store).length).toBe(3)
  })
})

describe('accuracy over a window', () => {
  const scored = [
    { p: pred({ date: '2026-09-01' }), e: entry([{ w: 200, r: 5 }]) },
    { p: pred({ date: '2026-09-03' }), e: entry([{ w: 200, r: 5 }]) },
    { p: pred({ date: '2026-09-05' }), e: entry([{ w: 200, r: 2 }]) },
    { p: pred({ date: '2026-09-07', basis: 'layoff' }), e: entry([{ w: 200, r: 5 }]) },
  ]
  const store = Object.fromEntries(scored.map(({ p }) => [`${p.date}:${p.id}`, p]))
  const history = { bench: scored.map(({ e, p }) => ({ ...e, date: p.date })) }

  it('reports the overall rate', () => {
    const acc = accuracyOver(store, history)
    expect(acc.total).toBe(4)
    expect(acc.hit).toBe(3)
    expect(acc.rate).toBeCloseTo(0.75, 2)
  })

  it('breaks it down by basis', () => {
    const acc = accuracyOver(store, history)
    expect(acc.byBasis.clean.total).toBe(3)
    expect(acc.byBasis.clean.hit).toBe(2)
    expect(acc.byBasis.layoff.total).toBe(1)
  })

  it('says which way it is usually wrong', () => {
    const acc = accuracyOver(store, history)
    expect(acc.whenWrong).toMatch(/high/i)
  })

  it('does not count what was never attempted', () => {
    const withSkip = { ...store, '2026-09-09:bench': pred({ date: '2026-09-09' }) }
    const acc = accuracyOver(withSkip, history)
    expect(acc.total).toBe(4)
    expect(acc.notAttempted).toBe(1)
  })

  it('is empty rather than perfect with nothing scored', () => {
    // control: the same function on the real store does report a rate
    expect(accuracyOver(store, history).rate).not.toBeNull()
    const acc = accuracyOver({}, {})
    expect(acc.total).toBe(0)
    expect(acc.rate).toBeNull()
  })
})

describe('the damping reaches progression', () => {
  const NOW = new Date(2026, 8, 19, 12).getTime()
  const day = (b: number) => {
    const d = new Date(2026, 8, 19 - b)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  const clean = [21, 14, 7].map((b) => ({
    date: day(b), kg: 200, sets: [{ w: 200, r: 5 }, { w: 200, r: 5 }],
  }))
  const lift = { reps: 5, sets: 2, incrementLb: 10 }
  /* An easy last session buys a DOUBLE jump, which is the thing a poor
     record should refuse. Every working set at RPE 6. */
  const easy = clean.map((e) => ({ ...e, sets: e.sets.map((s) => ({ ...s, rpe: 6 })) }))

  it('refuses the double jump when the record is poor', () => {
    const plain = suggestTarget(easy, lift, NOW)
    const damped = suggestTarget(easy, { ...lift, damping: { maxMultiplier: 1, reason: 'x' } }, NOW)
    expect(plain.weight).toBe(220)   // two increments, earned by an easy session
    expect(damped.weight).toBe(210)  // one
  })

  it('changes nothing when absent, which is almost everybody', () => {
    expect(suggestTarget(easy, { ...lift, damping: null }, NOW).weight)
      .toBe(suggestTarget(easy, lift, NOW).weight)
  })

  it('never turns a step into a hold or a cut', () => {
    /* A cap of zero would mean "do not progress", which is a far bigger
       intervention than the evidence supports. One increment is the floor. */
    const hard = suggestTarget(easy, { ...lift, damping: { maxMultiplier: 0, reason: 'x' } }, NOW)
    expect(hard.weight).toBe(210)
  })

  it('leaves an ordinary single-step session alone', () => {
    const damped = suggestTarget(clean, { ...lift, damping: { maxMultiplier: 1, reason: 'x' } }, NOW)
    expect(damped.weight).toBe(suggestTarget(clean, lift, NOW).weight)
  })
})

describe('the feedback is gated hard', () => {
  const missing = (n: number) => {
    const store: Record<string, Prediction> = {}
    const history: Record<string, unknown[]> = { bench: [] }
    for (let i = 0; i < n; i++) {
      const date = `2026-09-${String(i + 1).padStart(2, '0')}`
      store[`${date}:bench`] = pred({ date })
      ;(history.bench as unknown[]).push({ ...entry([{ w: 200, r: 2 }]), date })
    }
    return { store, history }
  }

  it('does nothing below the sample gate, however bad the record', () => {
    const { store, history } = missing(MIN_SCORED_FOR_FEEDBACK - 1)
    expect(progressionDamping(accuracyOver(store, history as never))).toBeNull()
  })

  it('eases off once there is enough evidence', () => {
    const { store, history } = missing(MIN_SCORED_FOR_FEEDBACK + 2)
    const damping = progressionDamping(accuracyOver(store, history as never))
    expect(damping).not.toBeNull()
    expect(damping!.maxMultiplier).toBe(1)
  })

  it('says why, with the numbers', () => {
    const { store, history } = missing(MIN_SCORED_FOR_FEEDBACK + 2)
    const damping = progressionDamping(accuracyOver(store, history as never))!
    expect(damping.reason).toMatch(/missed/i)
    expect(damping.reason).toMatch(/\d/)
  })

  it('leaves an accurate record alone', () => {
    const store: Record<string, Prediction> = {}
    const history: Record<string, unknown[]> = { bench: [] }
    for (let i = 0; i < MIN_SCORED_FOR_FEEDBACK + 4; i++) {
      const date = `2026-09-${String(i + 1).padStart(2, '0')}`
      store[`${date}:bench`] = pred({ date })
      ;(history.bench as unknown[]).push({ ...entry([{ w: 200, r: 5 }]), date })
    }
    /* Control: the record really was scored, and scored well. An empty
       store also produces no damping. */
    const acc = accuracyOver(store, history as never)
    expect(acc.total).toBeGreaterThan(MIN_SCORED_FOR_FEEDBACK)
    expect(acc.rate).toBe(1)
    expect(progressionDamping(acc)).toBeNull()
  })

  it('does not ease off for being too CONSERVATIVE', () => {
    /* Missing low means the suggestions were too light. Damping them
       further would make a good week worse. */
    const store: Record<string, Prediction> = {}
    const history: Record<string, unknown[]> = { bench: [] }
    for (let i = 0; i < MIN_SCORED_FOR_FEEDBACK + 4; i++) {
      const date = `2026-09-${String(i + 1).padStart(2, '0')}`
      store[`${date}:bench`] = pred({ date })
      ;(history.bench as unknown[]).push({ ...entry([{ w: 200, r: 5 + EASY_MARGIN }]), date })
    }
    /* Control: the rate really is poor and past the sample gate — the
       only thing stopping the damping is the DIRECTION of the misses. */
    const acc = accuracyOver(store, history as never)
    expect(acc.total).toBeGreaterThan(MIN_SCORED_FOR_FEEDBACK)
    expect(acc.missedLow).toBeGreaterThan(acc.missedHigh)
    expect(progressionDamping(acc)).toBeNull()
  })
})
