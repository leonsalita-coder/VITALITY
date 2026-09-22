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
const twoMuscle = indexFrom({
  bench: { primary: [{ muscle: 'chest', share: 1 }] },
  squat: { primary: [{ muscle: 'quads', share: 1 }] },
})

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

describe('history rows that arrive incomplete', () => {
  /* This module's own spanOfHistory already steps over a row with no
     date; the shared attribute() reader did not, and every per-muscle
     figure comes through it. A dateless row is what an import produces
     when the source had no timestamp, and it crashed the whole load
     read — on the screen that talks about how hard someone is training.
  */
  const good = steady(12, 6)

  it('steps over a row with no date', () => {
    const rows = [{ ...session(1, 6), date: undefined }, ...good] as never
    expect(() => acuteChronic(ctx({ history: { bench: rows } }))).not.toThrow()
  })

  it('still reads the rows either side of it', () => {
    /* The control: skipping everything would satisfy the line above. */
    const rows = [{ ...session(1, 6), date: undefined }, ...good] as never
    const chest = acuteChronic(ctx({ history: { bench: rows } })).byMuscle.chest
    expect(chest?.usable).toBe(true)
    expect(chest!.chronic).toBeGreaterThan(MIN_CHRONIC_LOAD)
  })

  it('steps over an empty row', () => {
    const rows = [null, ...good] as never
    expect(acuteChronic(ctx({ history: { bench: rows } })).byMuscle.chest?.usable).toBe(true)
  })
})

/* ------------------------------------------------------------------ *
 * The three properties this module lives or dies on.
 * ------------------------------------------------------------------ */

/** Sessions on fixed weekdays, as absolute calendar dates. */
const isoOf = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const monWedFri = (daysBack: number, sets: number) => {
  const rows = []
  for (let back = daysBack; back >= 0; back--) {
    const d = new Date(2026, 8, 19 - back)
    if ([1, 3, 5].includes(d.getDay())) {
      rows.push({ date: isoOf(d), kg: 100, sets: Array.from({ length: sets }, () => ({ w: 100, r: 8 })) })
    }
  }
  return rows
}

describe('the reading does not depend on which day it is read', () => {
  /* The bug this correction exists for: lifting is bursty, so an
     exponential average of RAW daily values is dominated by whether
     today happened to be a training day. A perfectly steady block read
     1.32 on a Saturday and well under 1 on a Tuesday — the number moving
     for a reason the athlete did nothing about.
     
     The property is asserted, not the smoothing: an unchanging routine
     reads near 1.0 on every day of the week. */
  const rows = monWedFri(200, 6)
  const readOn = (back: number) => {
    const now = new Date(2026, 8, 19 - back, 12)
    const upTo = isoOf(now)
    return acuteChronic({
      history: { bench: rows.filter((r) => r.date <= upTo) },
      index, otherTraining: [], now: now.getTime(),
    }).byMuscle.chest!
  }

  it.each([0, 1, 2, 3, 4, 5, 6])('reads near 1.0 when read %i days back', (back) => {
    const chest = readOn(back)
    expect(chest.ratio).toBeGreaterThan(0.9)
    expect(chest.ratio).toBeLessThan(1.1)
  })

  it('varies by almost nothing across a whole week of reading days', () => {
    /* Stronger than each reading being in range: the SPREAD is the
       artefact. Day-dependence of the size that was there before would
       show up here even if every individual day still landed in band. */
    const ratios = [0, 1, 2, 3, 4, 5, 6].map((b) => readOn(b).ratio)
    expect(Math.max(...ratios) - Math.min(...ratios)).toBeLessThan(0.05)
  })

  it('is reading a real block, not an empty one', () => {
    /* The control for all eight assertions above: a fixture producing
       nothing would give a ratio of 0 on every day, and a spread of 0. */
    const chest = readOn(0)
    expect(chest.usable).toBe(true)
    expect(chest.chronic).toBeGreaterThan(MIN_CHRONIC_LOAD)
    expect(chest.acute).toBeGreaterThan(MIN_CHRONIC_LOAD)
  })
})

describe('the returning athlete, who must not be told they spiked', () => {
  /* The single most dangerous false positive here: after a layoff the
     chronic figure has decayed toward nothing, so ANY training produces
     an enormous ratio. It fires on exactly the person least helped by
     being told to do less. */
  const returning = (weeksOff: number) => [
    ...steady(8, 6).map((s, i) => session(weeksOff * 7 + 1 + Math.floor(i / 3) * 7 + (i % 3) * 2, 6)),
    session(1, 6), session(4, 6),
  ]

  it('produces a reading rather than no reading at all', () => {
    /* The missing control. `chest == null || chest.usable === false` is
       satisfied by the muscle being absent entirely — which is what a
       broken fixture looks like, and it would hide the whole case. */
    const chest = acuteChronic(ctx({ history: { bench: returning(10) } })).byMuscle.chest
    expect(chest).toBeDefined()
    expect(chest!.acute).toBeGreaterThan(0)
  })

  it('has an alarming raw ratio — which is the point', () => {
    /* If the arithmetic did not produce a spike there would be nothing
       to suppress, and the gate below would be proving nothing. */
    const chest = acuteChronic(ctx({ history: { bench: returning(10) } })).byMuscle.chest!
    expect(chest.ratio).toBeGreaterThan(SANE_BAND[1])
  })

  it('marks that reading unusable instead of reporting it', () => {
    const chest = acuteChronic(ctx({ history: { bench: returning(10) } })).byMuscle.chest!
    expect(chest.usable).toBe(false)
    expect(chest.chronic).toBeLessThan(MIN_CHRONIC_LOAD)
  })

  it('says nothing about them at all', () => {
    expect(loadFindings(ctx({ history: { bench: returning(10) } }))).toEqual([])
    /* Beside it, the same athlete with an intact baseline DOES get
       read — so the silence above is the gate, not the module. */
    expect(acuteChronic(ctx({ history: { bench: steady(12, 6) } })).byMuscle.chest!.usable).toBe(true)
  })

  it('holds across every layoff long enough to collapse the baseline', () => {
    for (const weeksOff of [8, 10, 16, 26]) {
      expect(loadFindings(ctx({ history: { bench: returning(weeksOff) } })), `${weeksOff} weeks off`)
        .toEqual([])
    }
  })
})

describe('other training reaches the systemic index and stops there', () => {
  const lots = Array.from({ length: 20 }, (_, i) => ({
    date: day(i + 1), activity: 'martial_arts' as const, minutes: 120, intensity: 9,
  }))
  const lifting = steady(12, 6)
  const without = () => acuteChronic(ctx({ history: { bench: lifting } }))
  const with_ = () => acuteChronic(ctx({ history: { bench: lifting }, otherTraining: lots }))

  it('moves the systemic reading', () => {
    /* Asserted FIRST, because the containment test below compares two
       numbers and would pass just as happily if the other-training
       fixture did nothing at all. */
    expect(with_().systemic.acute).toBeGreaterThan(without().systemic.acute)
  })

  it('leaves the per-muscle reading untouched', () => {
    expect(with_().byMuscle.chest!.acute).toBe(without().byMuscle.chest!.acute)
    expect(with_().byMuscle.chest!.chronic).toBe(without().byMuscle.chest!.chronic)
  })

  it('leaves a per-muscle figure that is not simply zero', () => {
    /* The other half of the same problem: two zeroes are equal. */
    expect(without().byMuscle.chest!.acute).toBeGreaterThan(MIN_CHRONIC_LOAD)
  })

  it('marks the systemic reading estimated and the muscle reading not', () => {
    expect(with_().systemic.estimated).toBe(true)
    expect(with_().byMuscle.chest!.estimated).toBe(false)
  })
})

describe('the sane band is inclusive at both edges', () => {
  /* Fixtures found by search, because an EWMA ratio cannot be dialled
     to a round number by hand. Each lands exactly on a boundary, so a
     gate that excluded its own edge would speak where it should not. */
  const blockOf = (weeks: number, sets: number, endsAgo: number) => {
    const out = []
    for (let w = 0; w < weeks; w++)
      for (const i of [0, 2, 4]) out.push(session(endsAgo + w * 7 + i, sets))
    return out
  }
  const ratioFor = (baseSets: number, recentSets: number) => {
    const history = [...blockOf(10, baseSets, 8), ...blockOf(1, recentSets, 1)]
    return {
      reading: acuteChronic(ctx({ history: { bench: history } })).byMuscle.chest!,
      findings: loadFindings(ctx({ history: { bench: history } })),
    }
  }

  it('says nothing at exactly the top of the band', () => {
    const { reading, findings } = ratioFor(6, 16)
    expect(reading.ratio).toBe(SANE_BAND[1])
    expect(findings).toEqual([])
  })

  it('speaks one hundredth above it', () => {
    const { reading, findings } = ratioFor(7, 19)
    expect(reading.ratio).toBeCloseTo(1.51, 5)
    expect(findings).toHaveLength(1)
    expect(findings[0].text).toMatch(/above your normal range/)
  })

  it('says nothing at exactly the bottom of the band', () => {
    const { reading, findings } = ratioFor(19, 10)
    expect(reading.ratio).toBe(SANE_BAND[0])
    expect(findings).toEqual([])
  })

  it('speaks one hundredth below it', () => {
    const { reading, findings } = ratioFor(6, 3)
    expect(reading.ratio).toBeCloseTo(0.79, 5)
    expect(findings).toHaveLength(1)
    expect(findings[0].text).toMatch(/below your normal range/)
  })
})

describe('training well under normal is also worth saying', () => {
  /* The other direction had no test at all: every existing case was a
     spike, so the branch choosing the word "below" had never run. */
  const detrained = [
    ...Array.from({ length: 30 }, (_, i) => session(i * 3 + 10, 8)),
    session(2, 1),
  ]

  it('names it as below, not above', () => {
    const found = loadFindings(ctx({ history: { bench: detrained } }))
    expect(found).toHaveLength(1)
    expect(found[0].text).toMatch(/below your normal range/)
    expect(found[0].text).not.toMatch(/above/)
  })

  it('states both loads, with the recent one lower', () => {
    const [found] = loadFindings(ctx({ history: { bench: detrained } }))
    expect(found.acute).toBeLessThan(found.chronic)
    expect(found.text).toContain(`${found.acute} hard sets a week lately`)
    expect(found.text).toContain(`usual ${found.chronic}`)
  })

  it('still refuses to phrase it as advice', () => {
    const [found] = loadFindings(ctx({ history: { bench: detrained } }))
    for (const word of ['injur', 'risk', 'should', 'rest', 'danger', 'overtrain']) {
      expect(found.text.toLowerCase(), word).not.toContain(word)
    }
  })
})

describe('findings are ordered by how far from normal they are', () => {
  it('puts the larger departure first', () => {
    /* Two muscles, two different ratios. Unordered output makes the
       most important thing the second line as often as the first. */
    /* QUADS spikes harder than chest, so the correct order is the
       reverse of alphabetical. With chest first in both orderings a
       sort that ignored the ratio entirely would still look right. */
    const history = {
      bench: [...Array.from({ length: 30 }, (_, i) => session(i * 3 + 8, 6)),
        session(1, 20), session(3, 20)],
      squat: [...Array.from({ length: 30 }, (_, i) => session(i * 3 + 8, 6)),
        session(1, 30), session(3, 30)],
    }
    const found = loadFindings(ctx({ history, index: twoMuscle }))
    expect(found.length).toBeGreaterThan(1)
    expect(found[0].ratio).toBeGreaterThan(found[1].ratio)
    expect(found.map((f) => f.muscle)).toEqual(['quads', 'chest'])
  })
})

describe('rows outside the window are not counted', () => {
  const good = steady(12, 6)

  it('ignores a session dated in the future', () => {
    const chest = acuteChronic(ctx({ history: { bench: [session(-5, 50), ...good] } })).byMuscle.chest!
    const plain = acuteChronic(ctx({ history: { bench: good } })).byMuscle.chest!
    expect(chest.acute).toBe(plain.acute)
  })

  it('ignores a session older than the window', () => {
    const chest = acuteChronic(ctx({ history: { bench: [session(900, 50), ...good] } })).byMuscle.chest!
    const plain = acuteChronic(ctx({ history: { bench: good } })).byMuscle.chest!
    expect(chest.chronic).toBe(plain.chronic)
  })

  it('counts a session on the oldest day that IS in the window', () => {
    /* The control: "ignores things" is satisfied by ignoring everything,
       and the window edge is where that shows. */
    const plain = acuteChronic(ctx({ history: { bench: good } })).byMuscle.chest!
    const edged = acuteChronic(ctx({ history: { bench: [session(55, 50), ...good] } })).byMuscle.chest!
    expect(edged.chronic).toBeGreaterThan(plain.chronic)
  })
})

describe('the figures are in sets per week, and that is checkable', () => {
  /* The smoothing window is what makes "a week" true. Widening it by a
     day leaves every property above intact — the reading is still
     weekday-independent, still near 1.0 — while quietly inflating every
     number the athlete reads by about a seventh, under a label that
     still says week. */
  const rows = monWedFri(200, 6)

  it('reports exactly the sets actually done in a week', () => {
    /* Monday, Wednesday, Friday at six sets is eighteen sets a week. */
    const chest = acuteChronic(ctx({ history: { bench: rows } })).byMuscle.chest!
    expect(chest.acute).toBe(18)
  })

  it('scales with the work, not with the window', () => {
    const chest = acuteChronic(ctx({ history: { bench: monWedFri(200, 10) } })).byMuscle.chest!
    expect(chest.acute).toBe(30)
  })
})

describe('the baseline needs enough calendar behind it', () => {
  /* Four weeks exactly is the stated minimum, and a gate that demands
     more than its own constant silently moves it. */
  const daysOf = (span: number) => {
    const out = []
    for (let back = span; back >= 0; back -= 2) out.push(session(back, 8))
    return out
  }

  it('accepts a history spanning exactly the minimum', () => {
    const chest = acuteChronic(ctx({ history: { bench: daysOf(MIN_CHRONIC_DAYS) } })).byMuscle.chest!
    expect(chest.chronic).toBeGreaterThan(MIN_CHRONIC_LOAD)
    expect(chest.usable).toBe(true)
  })

  it('refuses one day short of it', () => {
    const chest = acuteChronic(ctx({ history: { bench: daysOf(MIN_CHRONIC_DAYS - 1) } })).byMuscle.chest!
    expect(chest.usable).toBe(false)
  })
})

describe('the whole-body note honours the same band', () => {
  /* systemicLoadNote carries its own copy of the band comparison and
     its own copy of the direction word, and neither had a boundary
     case. With no other training logged the systemic series is the
     lifting series, so the same fixtures reach it. */
  const blockOf = (weeks: number, sets: number, endsAgo: number) => {
    const out = []
    for (let w = 0; w < weeks; w++)
      for (const i of [0, 2, 4]) out.push(session(endsAgo + w * 7 + i, sets))
    return out
  }
  const noteFor = (baseSets: number, recentSets: number) => systemicLoadNote(ctx({
    history: { bench: [...blockOf(10, baseSets, 8), ...blockOf(1, recentSets, 1)] },
  }))

  it('says nothing at exactly the top of the band', () => expect(noteFor(6, 16)).toBeNull())
  it('speaks just above it, and calls it above', () => {
    expect(noteFor(7, 19)).toMatch(/above your normal range/)
  })
  it('says nothing at exactly the bottom of the band', () => expect(noteFor(19, 10)).toBeNull())
  it('speaks just below it, and calls it below', () => {
    expect(noteFor(6, 3)).toMatch(/below your normal range/)
  })
})

describe('two muscles equally far from normal are ordered predictably', () => {
  it('falls back to the name when the ratios tie', () => {
    /* Identical histories give identical ratios, so only the tie-break
       decides. Unordered output makes a weekly read shuffle itself for
       no reason the athlete did anything about. */
    const spike = [
      ...Array.from({ length: 30 }, (_, i) => session(i * 3 + 8, 6)),
      session(1, 30), session(3, 30),
    ]
    const found = loadFindings(ctx({
      history: { bench: spike, squat: spike }, index: twoMuscle,
    }))
    expect(found).toHaveLength(2)
    expect(found[0].ratio).toBe(found[1].ratio)
    expect(found.map((f) => f.muscle)).toEqual(['chest', 'quads'])
  })
})

describe('other training that arrives malformed', () => {
  const lifting = steady(12, 6)
  const good = Array.from({ length: 20 }, (_, i) => ({
    date: day(i + 1), activity: 'martial_arts' as const, minutes: 120, intensity: 9,
  }))

  it('ignores an empty slot', () => {
    const withNull = acuteChronic(ctx({
      history: { bench: lifting }, otherTraining: [null, ...good] as never,
    }))
    expect(withNull.systemic.acute).toBe(
      acuteChronic(ctx({ history: { bench: lifting }, otherTraining: good })).systemic.acute)
  })

  it('ignores an entry with no date', () => {
    const undated = [{ activity: 'sport', minutes: 90, intensity: 9 }, ...good] as never
    const withUndated = acuteChronic(ctx({ history: { bench: lifting }, otherTraining: undated }))
    expect(withUndated.systemic.acute).toBe(
      acuteChronic(ctx({ history: { bench: lifting }, otherTraining: good })).systemic.acute)
  })

  it('still counts the entries that are well formed', () => {
    /* The control for both: ignoring everything satisfies them. */
    const plain = acuteChronic(ctx({ history: { bench: lifting } })).systemic.acute
    const withOther = acuteChronic(ctx({ history: { bench: lifting }, otherTraining: good })).systemic.acute
    expect(withOther).toBeGreaterThan(plain)
  })
})

describe('the trailing week is a trailing week, not a growing one', () => {
  /* The smoothing keeps a running seven-day total by adding today and
     dropping the day that fell out. Starting that subtraction one day
     late never drops the OLDEST day in the series at all, so whatever
     was done on it is carried in every figure for as long as it stays in
     the window — a permanent inflation attached to one session.
     
     It hides completely unless that oldest day was a training day, which
     is why a three-day-a-week fixture cannot see it. */
  const everyDay = (sets: number) =>
    Array.from({ length: 120 }, (_, i) => session(i, sets))

  it('reads a daily trainee at seven times their daily work', () => {
    const chest = acuteChronic(ctx({ history: { bench: everyDay(2) } })).byMuscle.chest!
    expect(chest.acute).toBe(14)
    /* Chronic lands a little short — its 28-day constant has not fully
       converged away from the ramp at the start of the series — so the
       claim is the rate, not equality with acute. */
    expect(chest.chronic).toBeGreaterThan(13.5)
    expect(chest.chronic).toBeLessThan(14)
  })

  it('reads the same block unchanged whatever sits at the far edge', () => {
    /* The property stated directly: the figure must not depend on one
       session at the boundary of the window. */
    const plain = acuteChronic(ctx({ history: { bench: everyDay(2) } })).byMuscle.chest!
    const withEdge = acuteChronic(ctx({
      history: { bench: [...everyDay(2).filter((s) => s.date !== day(55)), session(55, 40)] },
    })).byMuscle.chest!
    expect(withEdge.acute).toBe(plain.acute)
  })
})

describe('other training that is not there at all', () => {
  it('reads a context with no other-training list', () => {
    /* Optional at the boundary and absent for anyone who has never
       logged any, which is most people. */
    const partial = { history: { bench: steady(12, 6) }, index, now: NOW } as unknown as LoadContext
    expect(() => acuteChronic(partial)).not.toThrow()
    expect(acuteChronic(partial).byMuscle.chest!.usable).toBe(true)
  })

  it('reads a context with no history either', () => {
    const partial = { index, now: NOW } as unknown as LoadContext
    expect(() => acuteChronic(partial)).not.toThrow()
    /* Beside the silence, the same shape WITH history speaks — or this
       passes against a module that has stopped reading anything. */
    expect(loadFindings(ctx({ history: { bench: [...steady(12, 6), session(1, 40)] } })).length)
      .toBeGreaterThan(0)
    expect(loadFindings(partial)).toEqual([])
  })
})
