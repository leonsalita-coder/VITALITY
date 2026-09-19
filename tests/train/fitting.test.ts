import { describe, it, expect } from 'vitest'
import {
  fitParameters, resetParameter, fittedIncrementFor, PARAMETER_GATES,
  type FittedParameters,
} from '../../lib/train/fitting'

/**
 * Per-user parameters, fitted from what actually happened.
 *
 * Increments, sessions-to-stall and recovery interval are constants.
 * They are reasonable and they are wrong for most individuals — a lifter
 * whose lower body climbs 10 lb a week and whose press climbs 2.5 is
 * being served the same number for both.
 *
 * NOT MACHINE LEARNING. Parameter fitting with explicit gates: each
 * parameter declares the sample it needs before it may move off the
 * default at all. Below the gate, behaviour is EXACTLY today's — which is
 * most people, most of the time, and is the property that makes this safe
 * to ship.
 *
 * Every fitted value says what it learned and from how much, is marked
 * fitted the same way estimated data is marked everywhere, and can be put
 * back.
 */

const day = (back: number) => {
  const d = new Date(2026, 8, 19 - back)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const NOW = new Date(2026, 8, 19, 12).getTime()

/** `n` weekly sessions climbing by `step` from `from`. */
const climbing = (n: number, from: number, step: number) =>
  Array.from({ length: n }, (_, i) => ({
    date: day((n - 1 - i) * 7), kg: from + i * step,
    sets: [{ w: from + i * step, r: 5 }, { w: from + i * step, r: 5 }],
  }))

/** Weekly sessions whose gaps are exactly the steps given. */
const fromSteps = (from: number, steps: number[]) => {
  const weights = [from]
  for (const s of steps) weights.push(weights[weights.length - 1] + s)
  return weights.map((w, i) => ({
    date: day((weights.length - 1 - i) * 7), kg: w,
    sets: [{ w, r: 5 }, { w, r: 5 }],
  }))
}

const lib = {
  back_squat: { equipment: 'barbell', kind: 'reps_weight' },
  bench_press: { equipment: 'barbell', kind: 'reps_weight' },
}

describe('below the gate, nothing changes', () => {
  it('fits nothing from a short history', () => {
    const fitted = fitParameters({
      history: { back_squat: climbing(3, 200, 10) }, customLib: lib, now: NOW,
    })
    expect(fitted.increments).toEqual({})
    expect(fitted.fitted).toBe(false)
  })

  it('returns the default increment, exactly as today', () => {
    const fitted = fitParameters({
      history: { back_squat: climbing(3, 200, 10) }, customLib: lib, now: NOW,
    })
    expect(fittedIncrementFor(fitted, 'back_squat', 5)).toBe(5)
  })

  it('fits nothing at all from an empty history', () => {
    const fitted = fitParameters({ history: {}, customLib: {}, now: NOW })
    expect(fitted.fitted).toBe(false)
    expect(fittedIncrementFor(fitted, 'anything', 2.5)).toBe(2.5)
  })
})

describe('a clear pattern moves the parameter', () => {
  const both = {
    back_squat: climbing(PARAMETER_GATES.increment + 2, 200, 10),
    bench_press: climbing(PARAMETER_GATES.increment + 2, 135, 2.5),
  }

  it('fits a different increment per movement pattern', () => {
    const fitted = fitParameters({ history: both, customLib: lib, now: NOW })
    const lower = fittedIncrementFor(fitted, 'back_squat', 5)
    const press = fittedIncrementFor(fitted, 'bench_press', 5)
    expect(lower).toBeGreaterThan(press)
  })

  it('fits the lower body faster than the default', () => {
    const fitted = fitParameters({ history: both, customLib: lib, now: NOW })
    expect(fittedIncrementFor(fitted, 'back_squat', 5)).toBeGreaterThan(5)
  })

  it('says what it learned and from how much', () => {
    const fitted = fitParameters({ history: both, customLib: lib, now: NOW })
    const report = fitted.increments.squat
    expect(report).toBeTruthy()
    expect(report!.samples).toBeGreaterThanOrEqual(PARAMETER_GATES.increment)
    expect(report!.text).toMatch(/\d/)
    expect(report!.fitted).toBe(true)
  })

  it('marks the whole set as fitted', () => {
    expect(fitParameters({ history: both, customLib: lib, now: NOW }).fitted).toBe(true)
  })
})

describe('a pattern with no signal stays on the default', () => {
  it('does not fit from a flat history', () => {
    const flat = { back_squat: climbing(PARAMETER_GATES.increment + 4, 200, 0) }
    const fitted = fitParameters({ history: flat, customLib: lib, now: NOW })
    expect(fittedIncrementFor(fitted, 'back_squat', 5)).toBe(5)
  })

  it('does not fit from a history going backwards', () => {
    const falling = { back_squat: climbing(PARAMETER_GATES.increment + 4, 300, -10) }
    const fitted = fitParameters({ history: falling, customLib: lib, now: NOW })
    expect(fittedIncrementFor(fitted, 'back_squat', 5)).toBe(5)
  })

  it('refuses an absurd fit rather than trusting it', () => {
    /* A hundred pounds a week is data entry, not progress. */
    const absurd = { back_squat: climbing(PARAMETER_GATES.increment + 4, 200, 100) }
    const fitted = fitParameters({ history: absurd, customLib: lib, now: NOW })
    expect(fittedIncrementFor(fitted, 'back_squat', 5)).toBe(5)
  })

  it('drops the absurd steps and fits the real ones beside them', () => {
    /* The case that discriminates. Eight honest ten-pound jumps and eight
       data-entry errors: filtering per STEP fits ten, while letting them
       through drags the median to fifty-five and fits nothing at all.
       A fixture of only-absurd steps cannot tell those apart. */
    const mixed = { back_squat: fromSteps(200, [
      10, 10, 10, 10, 10, 10, 10, 10, 100, 100, 100, 100, 100, 100, 100, 100,
    ]) }
    const fitted = fitParameters({ history: mixed, customLib: lib, now: NOW })
    expect(fittedIncrementFor(fitted, 'back_squat', 5)).toBe(10)
  })

  it('takes the median, so a few big jumps do not set the step', () => {
    /* Seven fives and one twenty-five: the median is 5 and the mean is
       7.5. A fixture of identical steps cannot tell which is running. */
    const skewed = { back_squat: fromSteps(200, [5, 5, 5, 5, 5, 5, 5, 25]) }
    const fitted = fitParameters({ history: skewed, customLib: lib, now: NOW })
    expect(fittedIncrementFor(fitted, 'back_squat', 2.5)).toBe(5)
  })
})

describe('every fitted value can be put back', () => {
  const fitted = () => fitParameters({
    history: { back_squat: climbing(PARAMETER_GATES.increment + 2, 200, 10) },
    customLib: lib, now: NOW,
  })

  it('resets one parameter', () => {
    const f = fitted()
    expect(fittedIncrementFor(f, 'back_squat', 5)).toBeGreaterThan(5)
    const after = resetParameter(f, 'increment', 'squat')
    expect(fittedIncrementFor(after, 'back_squat', 5)).toBe(5)
  })

  it('leaves the others alone when resetting one', () => {
    const f = fitParameters({
      history: {
        back_squat: climbing(PARAMETER_GATES.increment + 2, 200, 10),
        bench_press: climbing(PARAMETER_GATES.increment + 2, 135, 5),
      }, customLib: lib, now: NOW,
    })
    const after = resetParameter(f, 'increment', 'squat')
    expect(after.increments.squat).toBeUndefined()
    expect(after.increments.horizontal_push).toBeTruthy()
  })

  it('does not mutate the set it was given', () => {
    const f = fitted()
    const before = JSON.stringify(f)
    resetParameter(f, 'increment', 'squat')
    expect(JSON.stringify(f)).toBe(before)
  })

  it('resets everything at once', () => {
    const after = resetParameter(fitted(), 'all')
    expect(after.fitted).toBe(false)
    expect(after.increments).toEqual({})
  })
})

describe('fitted marking travels with the value', () => {
  it('marks a fitted increment so a caller can say so', () => {
    const f = fitParameters({
      history: { back_squat: climbing(PARAMETER_GATES.increment + 2, 200, 10) },
      customLib: lib, now: NOW,
    })
    expect(f.increments.squat!.fitted).toBe(true)
    expect(f.increments.squat!.default).toBe(false)
  })

  it('is deterministic', () => {
    const ctx = {
      history: { back_squat: climbing(PARAMETER_GATES.increment + 2, 200, 10) },
      customLib: lib, now: NOW,
    }
    expect(fitParameters(ctx)).toEqual(fitParameters(ctx))
  })
})
