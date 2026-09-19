import { describe, it, expect } from 'vitest'
import {
  amrapSignal, amrapTrend, AMRAP_OVER, AMRAP_MAX_MULTIPLIER,
} from '../../lib/train/amrap'
import { amrapOf, rangeSets, workingSets, workingVolume } from '../../lib/train/sets'
import { suggestTarget } from '../../lib/train/progression'
import { detectPlateau } from '../../lib/train/deload'
import { classifyPR } from '../../lib/train/records'

/**
 * AMRAP — the last set taken to technical failure.
 *
 * The best in-gym readiness signal available to somebody with no wearable
 * and no RPE habit, because it measures OUTPUT rather than inferring
 * state. Reps against the target say whether the load was right.
 *
 * Two constraints run this file:
 *
 *   It is never required. With no AMRAP anywhere, every suggestion,
 *   plateau read and record is byte-identical to what it was.
 *
 *   It may set a PR and it may not distort the rep range. Double
 *   progression asks "did every working set hit the top of the range",
 *   and a set deliberately taken past the range would answer that
 *   question wrongly in both directions.
 */

const NOW = new Date(2026, 8, 19, 12).getTime()
const day = (back: number) => {
  const d = new Date(2026, 8, 19 - back)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const set = (w: number, r: number, extra: Record<string, unknown> = {}) => ({ w, r, ...extra })
/** Three sets of five, the last one taken to failure at `amrapReps`. */
const session = (back: number, weight: number, amrapReps: number | null, target = 5) => ({
  date: day(back), kg: weight,
  sets: [
    set(weight, target), set(weight, target),
    amrapReps == null ? set(weight, target) : set(weight, amrapReps, { amrap: true }),
  ],
})

const lift = { reps: 5, sets: 3, incrementLb: 5, repRange: [5, 5] as [number, number] }

describe('the signal', () => {
  it('reads reps against the target', () => {
    const signal = amrapSignal(session(1, 200, 9), 5)!
    expect(signal).toMatchObject({ reps: 9, target: 5, surplus: 4 })
  })

  it('calls well over target under-loaded', () => {
    expect(amrapSignal(session(1, 200, 5 + AMRAP_OVER), 5)!.verdict).toBe('under_loaded')
  })

  it('calls hitting the target on target', () => {
    expect(amrapSignal(session(1, 200, 5), 5)!.verdict).toBe('on_target')
    expect(amrapSignal(session(1, 200, 6), 5)!.verdict).toBe('on_target')
  })

  it('calls under target struggling', () => {
    expect(amrapSignal(session(1, 200, 3), 5)!.verdict).toBe('struggling')
  })

  it('is null when no set was flagged', () => {
    expect(amrapSignal(session(1, 200, null), 5)).toBeNull()
  })

  it('ignores a warm-up flagged AMRAP, which is a contradiction', () => {
    const entry = {
      date: day(1), kg: 200,
      sets: [set(95, 12, { amrap: true, warmup: true }), set(200, 5)],
    }
    expect(amrapSignal(entry, 5)).toBeNull()
  })

  it('scales the jump with the overshoot, up to a cap', () => {
    expect(amrapSignal(session(1, 200, 5), 5)!.multiplier).toBe(1)
    expect(amrapSignal(session(1, 200, 5 + AMRAP_OVER), 5)!.multiplier).toBe(2)
    expect(amrapSignal(session(1, 200, 5 + AMRAP_OVER * 2), 5)!.multiplier).toBe(3)
    expect(amrapSignal(session(1, 200, 60), 5)!.multiplier).toBe(AMRAP_MAX_MULTIPLIER)
  })
})

describe('over and under target produce different next suggestions', () => {
  const history = (amrapReps: number) => [
    session(15, 200, 5), session(8, 200, 5), session(1, 200, amrapReps),
  ]

  it('jumps more than one increment when they were clearly under-loaded', () => {
    const over = suggestTarget(history(12), lift, NOW)
    const normal = suggestTarget(history(5), lift, NOW)
    expect(over.weight!).toBeGreaterThan(normal.weight!)
    expect(over.weight! - 200).toBeGreaterThan(5)
    expect(over.reason).toMatch(/AMRAP|12 reps/i)
  })

  it('holds progression when the AMRAP came in under target', () => {
    const under = suggestTarget(history(3), lift, NOW)
    expect(under.weight).toBe(200)
    expect(under.basis).toBe('amrap')
    expect(under.reason).toMatch(/3 reps|under/i)
  })

  it('moves one increment when the AMRAP landed on target', () => {
    expect(suggestTarget(history(5), lift, NOW).weight).toBe(205)
  })
})

describe('a falling AMRAP surfaces as a stall', () => {
  /* Constant load, working sets identical every session — the only thing
     moving is the AMRAP, downward. That is a lifter getting weaker under
     a weight that looks perfectly stable in the log. */
  const falling = [
    session(29, 200, 12), session(22, 200, 10),
    session(15, 200, 8), session(8, 200, 6), session(1, 200, 4),
  ]
  const steady = [
    session(29, 200, 8), session(22, 200, 8),
    session(15, 200, 8), session(8, 200, 8), session(1, 200, 8),
  ]

  it('reports the trend', () => {
    const trend = amrapTrend(falling)!
    expect(trend.falling).toBe(true)
    expect(trend.from).toBe(12)
    expect(trend.to).toBe(4)
    expect(trend.sessions).toBe(5)
  })

  it('does not report a steady one', () => {
    expect(amrapTrend(steady)!.falling).toBe(false)
  })

  it('needs more than one point to call a direction', () => {
    expect(amrapTrend([session(1, 200, 5)])).toBeNull()
    expect(amrapTrend([session(1, 200, null), session(8, 200, null)])).toBeNull()
  })

  it('diagnoses the stall as fatigue rather than programming', () => {
    const plateau = detectPlateau(falling, {})!
    expect(plateau).toBeTruthy()
    expect(plateau.cause).toBe('fatigue')
    expect(plateau.amrapFalling).toBe(true)
  })

  it('leaves a steady-AMRAP stall diagnosed the other way', () => {
    const plateau = detectPlateau(steady, {})!
    expect(plateau).toBeTruthy()
    expect(plateau.amrapFalling).toBe(false)
    expect(plateau.cause).not.toBe('fatigue')
  })
})

describe('an AMRAP set counts, but not toward the rep range', () => {
  const entry = session(1, 200, 12)

  it('is a working set — it happened and it was hard', () => {
    expect(workingSets(entry).length).toBe(3)
    /* Loaded work is measured in load, not rep count — so 22 reps at
       200 lb, the AMRAP's twelve included. */
    expect(workingVolume(entry).load).toBe(200 * (5 + 5 + 12))
  })

  it('is excluded from the sets double progression measures', () => {
    expect(rangeSets(entry).length).toBe(2)
    expect(rangeSets(entry).every((s) => s.r === 5)).toBe(true)
  })

  it('does not fake a completed rep range', () => {
    /* Range [5, 8]: the working sets hit 5, so the next session chases 6.
       Counting the AMRAP's 12 would read the range as finished and add
       weight the lifter has not earned. */
    const ranged = { ...lift, reps: 5, repRange: [5, 8] as [number, number] }
    const next = suggestTarget([session(15, 200, 12), session(8, 200, 12), session(1, 200, 12)], ranged, NOW)
    expect(next.reps).toBe(6)
    expect(next.weight).toBe(200)
  })

  it('does not drag the range down when it comes in low either', () => {
    const ranged = { ...lift, reps: 5, repRange: [5, 8] as [number, number] }
    const next = suggestTarget([session(15, 200, 2), session(8, 200, 2), session(1, 200, 2)], ranged, NOW)
    // the working sets still hit 5 of a 5-8 range; the AMRAP is a signal,
    // not evidence that the range was missed
    expect(next.weight).toBe(200)
  })

  it('can still set a record', () => {
    const history = [{ date: day(30), kg: 200, sets: [set(200, 5)] }]
    const pr = classifyPR(history, { weight: 200, reps: 12, amrap: true }, NOW)
    expect(pr.kind).not.toBeNull()
  })
})

describe('no AMRAP anywhere reproduces today exactly', () => {
  const plain = [session(15, 200, null), session(8, 200, null), session(1, 200, null)]

  it('suggests what it always suggested', () => {
    const s = suggestTarget(plain, lift, NOW)
    expect(s.basis).toBe('clean')
    expect(s.weight).toBe(205)
  })

  it('reads a plateau the way it always did', () => {
    const flat = [0, 1, 2, 3, 4].map((i) => session(29 - i * 7, 200, null))
    const plateau = detectPlateau(flat, {})!
    expect(plateau).toBeTruthy()
    expect(plateau.amrapFalling).toBe(false)
  })

  it('leaves the set helpers answering for an ordinary session', () => {
    const entry = session(1, 200, null)
    expect(amrapOf(entry)).toBeNull()
    expect(rangeSets(entry).length).toBe(workingSets(entry).length)
  })
})
