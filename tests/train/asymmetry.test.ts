import { describe, it, expect } from 'vitest'
import { sideGapOf, asymmetryFor, MIN_ASYMMETRY_SESSIONS, MIN_LOAD_GAP } from '../../lib/train/asymmetry'
import { workingVolume, topWorkingWeight, sidesOf } from '../../lib/train/sets'

/**
 * Left against right.
 *
 * perSide logs ONE side's work and doubles it for volume. Logging each
 * limb independently is a different thing, and it surfaces imbalance —
 * which almost no app tracks and which is a real signal.
 *
 * THE LINE: it reports a difference. It does not say anything about
 * injury, does not advise, and does not diagnose. A dominant side is
 * stronger in almost everyone, so only a LARGE and PERSISTENT gap is
 * worth a sentence at all.
 */

const day = (back: number) => {
  const d = new Date(2026, 8, 19 - back)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** A session logged per limb. */
const perLimb = (back: number, left: number, right: number, reps = 8, sets = 3) => ({
  date: day(back), kg: Math.min(left, right),
  sets: Array.from({ length: sets }, () => ({
    sides: { left: { w: left, r: reps }, right: { w: right, r: reps } },
  })),
})

/** The same lift logged the old way: one number, both sides. */
const single = (back: number, weight: number, reps = 8, sets = 3) => ({
  date: day(back), kg: weight,
  sets: Array.from({ length: sets }, () => ({ w: weight, r: reps, perSide: true })),
})

describe('volume counts both limbs once', () => {
  const entry = perLimb(1, 50, 50, 8, 2)

  it('adds the two sides rather than doubling one', () => {
    // 2 sets × (50×8 left + 50×8 right) = 1600
    expect(workingVolume(entry).load).toBe(1600)
  })

  it('does not ALSO apply the perSide doubling', () => {
    const withFlag = {
      ...entry,
      sets: entry.sets.map((s) => ({ ...s, perSide: true })),
    }
    /* perSide means "this number is one side". A per-limb set already
       carries both, so doubling it on top counts four limbs. */
    expect(workingVolume(withFlag).load).toBe(1600)
  })

  it('counts an uneven pair honestly', () => {
    // 2 × (60×8 + 40×8) = 1600 as well — the total is the same, the
    // asymmetry is the finding
    expect(workingVolume(perLimb(1, 60, 40, 8, 2)).load).toBe(1600)
  })
})

describe('a single number behaves exactly as it always did', () => {
  const entry = single(1, 50, 8, 2)

  it('still doubles for perSide', () => {
    expect(workingVolume(entry).load).toBe(1600)
  })

  it('has no sides to read', () => {
    expect(sidesOf(entry.sets[0])).toBeNull()
  })

  it('produces no asymmetry read at all', () => {
    const history = [1, 8, 15, 22, 29].map((b) => single(b, 50))
    // control: the fixture is five real sessions, not an empty list
    expect(history.every((h) => h.sets.length > 0)).toBe(true)
    expect(asymmetryFor(history)).toBeNull()
  })
})

describe('the working weight of a per-limb set', () => {
  it('is the WEAKER side — you progress when both sides can', () => {
    expect(topWorkingWeight(perLimb(1, 60, 40))).toBe(40)
  })

  it('is the shared number when both sides match', () => {
    expect(topWorkingWeight(perLimb(1, 50, 50))).toBe(50)
  })
})

describe('the gap in one session', () => {
  it('reports which side and by how much', () => {
    const gap = sideGapOf(perLimb(1, 60, 50))!
    expect(gap.stronger).toBe('left')
    expect(gap.left).toBe(60)
    expect(gap.right).toBe(50)
    expect(gap.loadGap).toBeCloseTo(0.2, 2)
  })

  it('is null for a session logged with a single number', () => {
    expect(sideGapOf(single(1, 50))).toBeNull()
  })

  it('is null when a session has no per-limb sets at all', () => {
    expect(sideGapOf({ date: day(1), kg: 0, sets: [] })).toBeNull()
  })

  it('reads reps when the weight is equal', () => {
    const gap = sideGapOf(perLimb(1, 50, 50, 8))!
    expect(gap.loadGap).toBe(0)
    expect(gap.repGap).toBe(0)
  })
})

describe('a small consistent gap says nothing', () => {
  it('stays silent at five percent', () => {
    const history = [1, 8, 15, 22, 29].map((b) => perLimb(b, 52.5, 50))
    // control: the gap is really there and really being read
    expect(sideGapOf(history[0])!.loadGap).toBeCloseTo(0.05, 2)
    expect(asymmetryFor(history)).toBeNull()
  })

  it('stays silent just under the threshold', () => {
    const under = 1 + MIN_LOAD_GAP * 0.9
    const history = [1, 8, 15, 22, 29].map((b) => perLimb(b, 50 * under, 50))
    expect(sideGapOf(history[0])!.loadGap).toBeGreaterThan(0)
    expect(sideGapOf(history[0])!.loadGap).toBeLessThan(MIN_LOAD_GAP)
    expect(asymmetryFor(history)).toBeNull()
  })
})

describe('a large persistent gap produces one observation', () => {
  const history = [1, 8, 15, 22, 29].map((b) => perLimb(b, 65, 50))

  it('reports it', () => {
    const found = asymmetryFor(history)
    expect(found).not.toBeNull()
    expect(found!.stronger).toBe('left')
    expect(found!.sessions).toBeGreaterThanOrEqual(MIN_ASYMMETRY_SESSIONS)
  })

  it('states both numbers', () => {
    const found = asymmetryFor(history)!
    expect(found.text).toMatch(/65/)
    expect(found.text).toMatch(/50/)
  })

  it('is an observation, not a diagnosis or advice', () => {
    const found = asymmetryFor(history)!
    expect(found.text).not.toMatch(/injur|risk|danger|should|must|fix|correct|imbalance/i)
  })

  it('needs the gap to be PERSISTENT, not one bad session', () => {
    const mostlyEven = [
      perLimb(29, 50, 50), perLimb(22, 50, 50), perLimb(15, 50, 50),
      perLimb(8, 50, 50), perLimb(1, 65, 50),
    ]
    /* Control: the one lopsided session is large enough that it WOULD
       fire if it were persistent — this is the same 65/50 the reporting
       test above uses. */
    expect(sideGapOf(mostlyEven[4])!.loadGap).toBeGreaterThan(MIN_LOAD_GAP)
    expect(asymmetryFor(mostlyEven)).toBeNull()
  })

  it('needs enough sessions to be a pattern', () => {
    const thin = [1, 8].map((b) => perLimb(b, 65, 50))
    // control: every session in it clears the size gate; only count fails
    expect(thin.every((h) => sideGapOf(h)!.loadGap > MIN_LOAD_GAP)).toBe(true)
    expect(asymmetryFor(thin)).toBeNull()
  })

  it('reports the other side when the other side is stronger', () => {
    const rightStrong = [1, 8, 15, 22, 29].map((b) => perLimb(b, 50, 65))
    expect(asymmetryFor(rightStrong)!.stronger).toBe('right')
  })
})

describe('it is data, deterministically', () => {
  const history = [1, 8, 15, 22, 29].map((b) => perLimb(b, 65, 50))

  it('is deterministic', () => {
    expect(asymmetryFor(history)).toEqual(asymmetryFor(history))
  })

  it('ignores warm-ups, like everything else', () => {
    /* The warm-up is deliberately lopsided the OTHER way and heavy
       enough to flip the verdict if it counted. An even warm-up would
       leave the answer unchanged either way and prove nothing. */
    const withWarmup = history.map((e) => ({
      ...e,
      sets: [{ sides: { left: { w: 10, r: 10 }, right: { w: 200, r: 10 } }, warmup: true }, ...e.sets],
    }))
    expect(asymmetryFor(withWarmup)!.stronger).toBe('left')
  })

  it('survives junk without throwing', () => {
    expect(asymmetryFor(null)).toBeNull()
    expect(asymmetryFor([])).toBeNull()
    expect(asymmetryFor([{ date: day(1), kg: 0, sets: [{ sides: {} as never }] }])).toBeNull()
  })
})
