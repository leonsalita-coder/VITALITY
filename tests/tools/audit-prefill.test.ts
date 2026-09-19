import { describe, it, expect } from 'vitest'
import { inspect } from '../../scripts/audit-prefill-climb.mjs'

/**
 * The audit's fingerprint.
 *
 * It only reports, so a false positive costs somebody a minute of looking
 * and a false negative costs them a corrupted session they never knew
 * about. The tell is a CONSTANT step up with the reps unchanged, because
 * the bug prescribed the same rep target and one more increment each row.
 */

const entry = (sets: unknown[], kg = 0) => ({ date: '2026-09-05', kg, sets })

describe('what the bug looks like', () => {
  it('matches a constant climb at constant reps', () => {
    const found = inspect(entry([{ w: 315, r: 5 }, { w: 320, r: 5 }, { w: 325, r: 5 }]))!
    expect(found.likelyBug).toBe(true)
    expect(found.step).toBe(5)
    expect(found.weights).toEqual([315, 320, 325])
  })

  it('ignores the warm-ups above it', () => {
    const found = inspect(entry([
      { w: 95, r: 8, warmup: true }, { w: 315, r: 5 }, { w: 320, r: 5 }, { w: 325, r: 5 },
    ]))!
    expect(found.weights).toEqual([315, 320, 325])
  })

  it('reads an older row with no per-set weight from the entry', () => {
    const found = inspect(entry([{ r: 5 }, { r: 5 }], 225))
    // both fall back to 225, so there is no climb and nothing to report
    expect(found).toBeNull()
  })
})

describe('what it must not call a bug', () => {
  it('a flat session', () => {
    expect(inspect(entry([{ w: 185, r: 5 }, { w: 185, r: 5 }, { w: 185, r: 5 }]))).toBeNull()
  })

  it('a descending session', () => {
    expect(inspect(entry([{ w: 225, r: 5 }, { w: 205, r: 5 }, { w: 185, r: 5 }]))).toBeNull()
  })

  it('a single working set', () => {
    expect(inspect(entry([{ w: 315, r: 5 }]))).toBeNull()
  })

  it('an uneven climb, which the bug could not produce', () => {
    expect(inspect(entry([{ w: 185, r: 5 }, { w: 205, r: 5 }, { w: 210, r: 5 }]))).toBeNull()
  })

  it('a deliberate pyramid — it rises, but the reps fall', () => {
    const found = inspect(entry([{ w: 185, r: 8 }, { w: 205, r: 5 }, { w: 225, r: 2 }]))
    // reported separately, never counted as the bug
    expect(found).not.toBeNull()
    expect(found!.likelyBug).toBe(false)
  })

  it('a failed set, which is not a working set', () => {
    expect(inspect(entry([{ w: 315, r: 5 }, { w: 320, r: 1, fail: true }]))).toBeNull()
  })
})
