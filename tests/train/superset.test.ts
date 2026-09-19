import { describe, it, expect } from 'vitest'
import { workingVolume, topWorkingWeight } from '../../lib/train/sets'
import { detectPlateau } from '../../lib/train/deload'
import { suggestTarget } from '../../lib/train/progression'
import { attribute, indexFrom } from '../../lib/train/analysis'
import { restTaken, medianRest } from '../../lib/train/timing'

/**
 * Supersets against the engine that was built after them.
 *
 * Grouping predates every piece of this engine and nothing had verified
 * that the new reads handle it. This is a latent bug hunt: the assertion
 * throughout is that a linked pair produces the SAME answers as the same
 * two lifts trained unlinked, except where they legitimately differ.
 *
 * The one place they legitimately differ is TIME. In a superset the rest
 * between two sets of A genuinely contains a set of B, so the gap is
 * longer — that is a fact about the training, not an error.
 */

const day = (back: number) => {
  const d = new Date(2026, 8, 19 - back)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const NOW = new Date(2026, 8, 19, 12).getTime()

/** Straight sets: A A A, ninety seconds apart. */
const straight = (back: number, weight: number, gap = 90) => {
  const start = new Date(`${day(back)}T18:00:00`).getTime()
  return {
    date: day(back), kg: weight,
    sets: [0, 1, 2].map((i) => ({ w: weight, r: 5, at: start + i * gap * 1000 })),
  }
}

/**
 * The same three sets, alternating with a partner lift.
 *
 * A at 0, 180, 360; B at 90, 270, 450. Each lift still rests ninety
 * seconds before its partner's set and ninety after — so A's own gaps are
 * 180 seconds, which is exactly what a superset costs.
 */
const supersetA = (back: number, weight: number) => {
  const start = new Date(`${day(back)}T18:00:00`).getTime()
  return {
    date: day(back), kg: weight,
    sets: [0, 1, 2].map((i) => ({ w: weight, r: 5, at: start + i * 180 * 1000 })),
  }
}
const supersetB = (back: number, weight: number) => {
  const start = new Date(`${day(back)}T18:00:00`).getTime() + 90 * 1000
  return {
    date: day(back), kg: weight,
    sets: [0, 1, 2].map((i) => ({ w: weight, r: 5, at: start + i * 180 * 1000 })),
  }
}

const lift = { reps: 5, sets: 3, incrementLb: 5 }

describe('progression reads each lift, not the group', () => {
  const weeks = [21, 14, 7, 0]

  it('suggests per lift, identically to the unlinked case', () => {
    const linkedA = weeks.map((b) => supersetA(b, 200))
    const plainA = weeks.map((b) => straight(b, 200))
    expect(suggestTarget(linkedA, lift, NOW).weight)
      .toBe(suggestTarget(plainA, lift, NOW).weight)
  })

  it('gives the partner its own answer, not the first lift’s', () => {
    const linkedA = weeks.map((b) => supersetA(b, 200))
    const linkedB = weeks.map((b) => supersetB(b, 60))
    const a = suggestTarget(linkedA, lift, NOW)
    const b = suggestTarget(linkedB, lift, NOW)
    expect(a.weight).not.toBe(b.weight)
    expect(b.weight).toBe(suggestTarget(weeks.map((x) => straight(x, 60)), lift, NOW).weight)
  })
})

describe('plateau detection reads each lift independently', () => {
  const flatWeeks = [35, 28, 21, 14, 7, 0]

  it('finds the same stall linked as unlinked', () => {
    const linked = flatWeeks.map((b) => supersetA(b, 200))
    const plain = flatWeeks.map((b) => straight(b, 200))
    const a = detectPlateau(linked, {})
    const p = detectPlateau(plain, {})
    expect(a).toBeTruthy()
    expect(a!.sessions).toBe(p!.sessions)
    expect(a!.weight).toBe(p!.weight)
  })

  it('does not let a stalled partner stall the other', () => {
    /* flatWeeks counts DAYS BACK, so index 0 is the oldest session and
       the weight must rise with the index. The first version subtracted
       instead of adding and produced a descending run, which
       detectPlateau correctly called a stall — a fixture bug that looked
       exactly like an engine bug. */
    const climbing = flatWeeks.map((b, i) => supersetB(b, 60 + i * 5))
    /* Control: the same fixture shape held FLAT does stall, so what
       silences it here is the climb and not an empty history. */
    expect(detectPlateau(flatWeeks.map((b) => supersetB(b, 60)), {})).toBeTruthy()
    expect(detectPlateau(climbing, {})).toBeNull()
  })
})

describe('volume and muscle attribution count each lift once', () => {
  const index = indexFrom({
    a: { primary: [{ muscle: 'chest', share: 1 }] },
    b: { primary: [{ muscle: 'lats', share: 1 }] },
  })

  it('counts a linked pair the same as an unlinked pair', () => {
    const linked = { a: [supersetA(0, 200)], b: [supersetB(0, 60)] }
    const plain = { a: [straight(0, 200)], b: [straight(0, 60)] }
    const sum = (h: typeof linked) =>
      Object.values(h).reduce((n, list) => n + workingVolume(list[0]).load, 0)
    expect(sum(linked)).toBe(sum(plain))
  })

  it('attributes each lift to its own muscle, once', () => {
    const rows = attribute({ a: [supersetA(0, 200)], b: [supersetB(0, 60)] }, index)
    const chest = rows.filter((r) => r.muscle === 'chest').reduce((n, r) => n + r.sets, 0)
    const lats = rows.filter((r) => r.muscle === 'lats').reduce((n, r) => n + r.sets, 0)
    expect(chest).toBe(3)
    expect(lats).toBe(3)
  })

  it('reads the same top weight either way', () => {
    expect(topWorkingWeight(supersetA(0, 200))).toBe(topWorkingWeight(straight(0, 200)))
  })
})

describe('timing, where a superset legitimately differs', () => {
  it('reads a longer gap, because the rest contains the partner’s set', () => {
    expect(medianRest(straight(0, 200))).toBe(90)
    expect(medianRest(supersetA(0, 200))).toBe(180)
  })

  it('still reads real gaps rather than refusing', () => {
    const reading = restTaken(supersetA(0, 200))
    expect(reading.hasObservedTiming).toBe(true)
    expect(reading.gaps).toEqual([180, 180])
  })

  it('does not read a partner’s set as a gap in this lift', () => {
    /* Each entry holds only its own sets, so interleaving in TIME cannot
       interleave in the data. This is the property that makes everything
       above hold. */
    expect(restTaken(supersetA(0, 200)).gaps.length).toBe(2)
  })
})

describe('the shape of the interleave itself', () => {
  it('produces sets that really do alternate in time', () => {
    /* A control for the whole file: if the two fixtures did not actually
       interleave, every comparison above would be comparing a superset
       to itself. */
    const a = supersetA(0, 200).sets.map((s) => s.at)
    const b = supersetB(0, 60).sets.map((s) => s.at)
    const merged = [...a.map((t) => ({ t, who: 'a' })), ...b.map((t) => ({ t, who: 'b' }))]
      .sort((x, y) => x.t - y.t)
      .map((x) => x.who)
    expect(merged).toEqual(['a', 'b', 'a', 'b', 'a', 'b'])
  })
})
