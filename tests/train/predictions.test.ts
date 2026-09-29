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

  it('calls a hold too LIGHT at the same margin reps use, scaled to seconds', () => {
    /* Reps: EASY_MARGIN past target is too light, and exactly the margin
       counts (see 'is missed LOW when it was far too easy'). Seconds use
       five seconds per rep of margin, with the same inclusive edge. */
    const plank = pred({ weight: null, reps: null, seconds: 60 })
    const held = (s: number) => ({ date: '2026-09-19', kg: 0, sets: [{ kind: 'time' as const, s }] })
    expect(scorePrediction(plank, held(60 + EASY_MARGIN * 5))).toBe('missed_low')
    expect(scorePrediction(plank, held(60 + EASY_MARGIN * 5 - 1))).toBe('hit')
  })

  it('scores a distance lift in metres, including too light', () => {
    /* Nothing covered distance at all. Too light is 20% past the target,
       inclusive, matching the other two kinds' inclusive edges. */
    const carry = pred({ weight: null, reps: null, metres: 400 })
    const went = (m: number) => ({ date: '2026-09-19', kg: 0, sets: [{ kind: 'distance' as const, m }] })
    expect(scorePrediction(carry, went(400))).toBe('hit')
    expect(scorePrediction(carry, went(399))).toBe('missed_high')
    expect(scorePrediction(carry, went(479))).toBe('hit')
    expect(scorePrediction(carry, went(480))).toBe('missed_low')
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

  it('refuses a prediction with no lift or no session date, and writes nothing', () => {
    /* Either one missing makes a key like "2026-09-19:" that no lift will
       ever be scored against — a phantom row inflating nothing but the
       store. Each is refused on its own, not only when both are missing. */
    const store: Record<string, Prediction> = {}
    expect(recordPrediction(store, pred({ id: '' }))).toBe(false)
    expect(recordPrediction(store, pred({ date: '' }))).toBe(false)
    expect(store).toEqual({})
    // control: the same store does take a complete one
    expect(recordPrediction(store, pred())).toBe(true)
    expect(Object.keys(store)).toEqual(['2026-09-19:bench'])
  })

  it('refuses rather than throws when there is no store or no prediction', () => {
    /* The tile calls this with whatever STATE.predictions holds, which
       can be absent on a first boot. */
    expect(recordPrediction(null as never, pred())).toBe(false)
    expect(recordPrediction({}, null as never)).toBe(false)
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

  it('scores only predictions on or after `since`, the day itself included', () => {
    /* The tile passes a since-date to get "lately" (train.html accuracyNow).
       09-03 is the boundary: it is in, 09-01 is out. */
    const acc = accuracyOver(store, history, { since: '2026-09-03' })
    expect(acc.total).toBe(3)   // 09-03, 09-05, 09-07
    expect(acc.hit).toBe(2)     // 09-05 was the miss
    // control: without it, the 09-01 hit counts too
    expect(accuracyOver(store, history).total).toBe(4)
  })

  it('has nothing to say about which way it is wrong when it never was', () => {
    const allHits = Object.fromEntries(scored.filter((_, i) => i !== 2).map(({ p }) => [`${p.date}:${p.id}`, p]))
    const acc = accuracyOver(allHits, history)
    // control: there was a record, and all of it was right
    expect(acc.total).toBe(3)
    expect(acc.rate).toBe(1)
    expect(acc.whenWrong).toBeNull()
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

  /* A record built to order: `hit` hits, `high` too heavy, `low` too light. */
  const record = (hit: number, high: number, low: number) => {
    const store: Record<string, Prediction> = {}
    const history: Record<string, unknown[]> = { bench: [] }
    const reps = [...Array(hit).fill(5), ...Array(high).fill(2), ...Array(low).fill(5 + EASY_MARGIN)]
    reps.forEach((r, i) => {
      const date = `2026-08-${String(i + 1).padStart(2, '0')}`
      store[`${date}:bench`] = pred({ date })
      ;(history.bench as unknown[]).push({ ...entry([{ w: 200, r }]), date })
    })
    return accuracyOver(store, history as never)
  }

  it('moves at exactly the sample gate, not one after it', () => {
    /* "Scored predictions needed before the feedback may change anything":
       ten is enough. */
    const acc = record(0, MIN_SCORED_FOR_FEEDBACK, 0)
    expect(acc.total).toBe(MIN_SCORED_FOR_FEEDBACK)
    expect(progressionDamping(acc)).not.toBeNull()
  })

  it('leaves a decent record alone even when its misses are all high', () => {
    /* 8 of 12 right is 67%, above the 60% line: the direction of the
       misses must not be reached at all. */
    const acc = record(8, 4, 0)
    expect(acc.missedHigh).toBe(4)   // control: every miss really is high
    expect(acc.rate).toBeGreaterThan(0.6)
    expect(progressionDamping(acc)).toBeNull()
  })

  it('treats exactly a 60% hit rate as not poor', () => {
    /* POOR_RATE is the rate BELOW which progression eases off. */
    const acc = record(6, 4, 0)
    expect(acc.rate).toBe(0.6)
    expect(acc.missedHigh).toBe(4)
    expect(progressionDamping(acc)).toBeNull()
    // control: one fewer hit, one more miss, and it does ease off
    expect(progressionDamping(record(5, 5, 0))).not.toBeNull()
  })

  it('eases off when exactly 60% of the misses are high', () => {
    /* MOSTLY_HIGH is the share of misses that must be high: 60% qualifies. */
    const acc = record(0, 6, 4)
    expect(acc.missedHigh / (acc.missedHigh + acc.missedLow)).toBe(0.6)
    expect(progressionDamping(acc)).not.toBeNull()
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
