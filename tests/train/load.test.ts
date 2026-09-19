import { describe, it, expect } from 'vitest'
import {
  acuteChronic, loadFindings, systemicLoadNote, SANE_BAND,
  MIN_CHRONIC_DAYS, MIN_CHRONIC_LOAD,
  type LoadContext,
} from '../../lib/train/load'
import { indexFrom } from '../../lib/train/analysis'

/**
 * Acute load against chronic load.
 *
 * Sports science uses recent workload against long-term workload as a
 * load-management signal. Almost nobody applies it to lifting because
 * almost nobody has a per-muscle volume model. This engine does.
 *
 * IT IS A LOAD OBSERVATION AND NOTHING MORE. It is not injury
 * prediction, it is not medical advice, and it never says either. The
 * ratio is a fact about training volume; what it implies for a
 * particular body is not something this app can know.
 *
 * AND IT NEEDS A REAL BASELINE. The failure mode that matters is a
 * returning lifter: after a layoff the chronic load has decayed toward
 * nothing, so any training at all produces an enormous ratio. That is
 * arithmetic, not a finding, and it fires on exactly the person least
 * helped by being told to do less.
 */

const day = (back: number) => {
  const d = new Date(2026, 8, 19 - back)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const NOW = new Date(2026, 8, 19, 12).getTime()

const index = indexFrom({ bench: { primary: [{ muscle: 'chest', share: 1 }] } })

/** A session `back` days ago with `sets` working sets. */
const session = (back: number, sets: number) => ({
  date: day(back), kg: 100,
  sets: Array.from({ length: sets }, () => ({ w: 100, r: 8 })),
})

/** Steady training: `setsPer` sets, twice a week, for `weeks`. */
const steady = (weeks: number, setsPer: number) => {
  const out = []
  for (let w = 0; w < weeks; w++) {
    for (const offset of [0, 3]) out.push(session(w * 7 + offset, setsPer))
  }
  return out
}

const ctx = (over: Partial<LoadContext> = {}): LoadContext => ({
  history: {}, index, otherTraining: [], now: NOW, ...over,
})

describe('a steady block sits near one', () => {
  const reading = () => acuteChronic(ctx({ history: { bench: steady(10, 6) } }))

  it('reports a ratio close to 1', () => {
    const chest = reading().byMuscle.chest
    expect(chest).toBeTruthy()
    expect(chest!.ratio).toBeGreaterThan(0.85)
    expect(chest!.ratio).toBeLessThan(1.15)
  })

  it('states both loads, not just the ratio', () => {
    const chest = reading().byMuscle.chest!
    expect(chest.acute).toBeGreaterThan(0)
    expect(chest.chronic).toBeGreaterThan(0)
  })

  it('produces no finding, because it is inside the band', () => {
    expect(loadFindings(ctx({ history: { bench: steady(10, 6) } }))).toEqual([])
  })
})

describe('a spike week is elevated', () => {
  /* Nine steady weeks, then one at four times the volume. */
  const spiked = [...steady(10, 4).filter((s) => s.date < day(6)), session(1, 18), session(4, 18)]

  it('reports a ratio well above one', () => {
    const chest = acuteChronic(ctx({ history: { bench: spiked } })).byMuscle.chest!
    expect(chest.ratio).toBeGreaterThan(SANE_BAND[1])
  })

  it('produces a finding with both numbers in it', () => {
    const found = loadFindings(ctx({ history: { bench: spiked } }))
    expect(found.length).toBe(1)
    expect(found[0].text).toMatch(/\d/)
    expect(found[0].muscle).toBe('chest')
  })

  it('never phrases it as injury or advice', () => {
    const found = loadFindings(ctx({ history: { bench: spiked } }))
    expect(found[0].text).not.toMatch(/injur|risk|danger|should|must|medical|safe|unsafe/i)
  })
})

describe('a returning lifter is not told they spiked', () => {
  /* Eight weeks of solid training, ten weeks off, then one ordinary week
     back. Chronic has decayed to almost nothing, so the raw ratio is
     enormous — and means nothing about this person's training. */
  const returning = [
    ...steady(8, 6).map((s) => ({ ...s, date: day(70 + (new Date(day(0)).getTime() - new Date(s.date).getTime()) / 86400000) })),
    session(1, 6), session(4, 6),
  ]

  it('stays silent rather than reporting the arithmetic', () => {
    expect(loadFindings(ctx({ history: { bench: returning } }))).toEqual([])
  })

  it('says the baseline is not usable rather than inventing one', () => {
    const chest = acuteChronic(ctx({ history: { bench: returning } })).byMuscle.chest
    expect(chest == null || chest.usable === false).toBe(true)
  })
})

describe('no baseline is silence', () => {
  it('says nothing in a first week of training', () => {
    expect(loadFindings(ctx({ history: { bench: [session(1, 10), session(4, 10)] } }))).toEqual([])
  })

  it('says nothing at all with no history', () => {
    expect(loadFindings(ctx())).toEqual([])
    expect(acuteChronic(ctx()).byMuscle).toEqual({})
  })

  it('needs enough days before a chronic load means anything', () => {
    const short = steady(Math.floor(MIN_CHRONIC_DAYS / 7) - 1, 6)
    const chest = acuteChronic(ctx({ history: { bench: short } })).byMuscle.chest
    expect(chest == null || chest.usable === false).toBe(true)
  })

  it('does not divide by a chronic load of zero', () => {
    /* A lift abandoned two months ago: the muscle is still in the record,
       so a reading is produced, but nothing falls inside the window. The
       ratio is undefined, not infinite, and reporting Infinity would put
       a number on screen that means nothing. */
    const abandoned = { bench: [session(70, 10), session(73, 10)] }
    const chest = acuteChronic(ctx({ history: abandoned })).byMuscle.chest!
    expect(chest).toBeTruthy()
    expect(chest.chronic).toBe(0)
    expect(Number.isFinite(chest.ratio)).toBe(true)
    expect(chest.usable).toBe(false)
    expect(loadFindings(ctx({ history: abandoned }))).toEqual([])
  })

  it('needs enough LOAD, not only enough days', () => {
    /* One set a fortnight for three months is enough calendar and not
       enough training — the chronic figure is a rounding error and a
       ratio against it is noise. */
    const trickle = Array.from({ length: 6 }, (_, i) => session(i * 14 + 1, 1))
    const chest = acuteChronic(ctx({ history: { bench: trickle } })).byMuscle.chest
    expect(chest == null || chest.usable === false).toBe(true)
    expect(MIN_CHRONIC_LOAD).toBeGreaterThan(0)
  })
})

describe('other training is folded in, and marked', () => {
  const hard = Array.from({ length: 6 }, (_, i) => ({
    date: day(i + 1), activity: 'martial_arts' as const, minutes: 90, intensity: 8,
  }))

  it('raises the acute load when there has been a lot of it', () => {
    const without = acuteChronic(ctx({ history: { bench: steady(10, 6) } }))
    const with_ = acuteChronic(ctx({ history: { bench: steady(10, 6) }, otherTraining: hard }))
    expect(with_.systemic.acute).toBeGreaterThan(without.systemic.acute)
  })

  it('marks anything it contributed to as estimated', () => {
    const reading = acuteChronic(ctx({ history: { bench: steady(10, 6) }, otherTraining: hard }))
    expect(reading.systemic.estimated).toBe(true)
  })

  it('is not estimated when no other training was logged', () => {
    expect(acuteChronic(ctx({ history: { bench: steady(10, 6) } })).systemic.estimated).toBe(false)
  })

  it('never enters the per-muscle set counts', () => {
    /* The rule from other.ts stands: self-reported load is never
       expressed in the units of lifting. It reaches the SYSTEMIC index,
       which is its own derived thing, and not a muscle's hard sets. */
    const without = acuteChronic(ctx({ history: { bench: steady(10, 6) } }))
    const with_ = acuteChronic(ctx({ history: { bench: steady(10, 6) }, otherTraining: hard }))
    expect(with_.byMuscle.chest!.acute).toBe(without.byMuscle.chest!.acute)
  })
})

describe('the whole-body reading is where other training counts', () => {
  const hard = Array.from({ length: 12 }, (_, i) => ({
    date: day(i + 1), activity: 'martial_arts' as const, minutes: 120, intensity: 9,
  }))

  it('says nothing for a steady block', () => {
    expect(systemicLoadNote(ctx({ history: { bench: steady(10, 6) } }))).toBeNull()
  })

  it('speaks when a lot of other training lands on top', () => {
    const note = systemicLoadNote(ctx({ history: { bench: steady(10, 6) }, otherTraining: hard }))
    expect(note).not.toBeNull()
    expect(note!).toMatch(/set-equivalents/)
  })

  it('says the other-training half is self-reported', () => {
    const note = systemicLoadNote(ctx({ history: { bench: steady(10, 6) }, otherTraining: hard }))!
    expect(note).toMatch(/self-reported/i)
  })

  it('never phrases it as injury or advice', () => {
    const note = systemicLoadNote(ctx({ history: { bench: steady(10, 6) }, otherTraining: hard }))!
    expect(note).not.toMatch(/injur|risk|danger|should|must|medical/i)
  })

  it('stays silent without a usable baseline', () => {
    expect(systemicLoadNote(ctx({ otherTraining: hard }))).toBeNull()
  })
})

describe('it is deterministic and total', () => {
  it('gives the same answer twice', () => {
    const c = ctx({ history: { bench: steady(10, 6) } })
    expect(acuteChronic(c)).toEqual(acuteChronic(c))
  })

  it('survives junk without throwing', () => {
    expect(() => acuteChronic(ctx({ history: { bench: [] } }))).not.toThrow()
    expect(() => loadFindings(ctx({ history: null as never }))).not.toThrow()
  })
})
