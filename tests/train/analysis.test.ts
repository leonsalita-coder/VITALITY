import { describe, it, expect } from 'vitest'
import {
  GAP_DAYS, WEEKLY_SET_BAND, RAMP_LIMIT,
  indexFrom, frequencyGaps, weeklySets, ratios, volumeRamp, analyse,
} from '../../lib/train/analysis'
import type { History } from '../../lib/train/analysis'

const NOW = new Date('2026-09-19T12:00:00').getTime()
const ago = (n: number) => {
  const d = new Date(NOW)
  d.setDate(d.getDate() - n)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** A session of n working sets on a given day. */
const sess = (day: number, sets: number) => ({
  date: ago(day), kg: 100,
  sets: Array.from({ length: sets }, () => ({ w: 100, r: 5 })),
})

const LIB = {
  bench: { primary: ['Chest'], secondary: ['Triceps'] },
  pecdeck: { primary: ['Pecs'] },            // same muscle, different word
  row: { primary: ['Lats'], secondary: ['Biceps'] },
  squat: { primary: ['Quads'] },
  curl: { primary: ['Biceps'] },
  legcurl: { primary: ['Hamstrings'] },
}
const INDEX = indexFrom(LIB)

/**
 * Fixture integrity.
 *
 * Almost every assertion below is "this stays silent", which would pass
 * just as happily against an index that never loaded. One test proves the
 * fixture is real so the silence means something.
 */
describe('the fixture itself', () => {
  it('maps every lift onto real muscles', () => {
    expect(Object.keys(INDEX)).toHaveLength(Object.keys(LIB).length)
    for (const id of Object.keys(LIB)) {
      expect(INDEX[id].primary.length, id).toBeGreaterThan(0)
      expect(INDEX[id].unmapped, id).toEqual([])
    }
  })
})

describe('the constraint that was silently broken', () => {
  it('counts a muscle hit under two names as one muscle', () => {
    // 6 sets as "Chest" and 6 as "Pecs" — neither alone reaches the band
    const history: History = { bench: [sess(1, 6)], pecdeck: [sess(2, 6)] }
    const found = weeklySets(history, INDEX, NOW)
    const chest = found.find((f) => f.muscle === 'chest')
    expect(chest).toBeUndefined() // 12 is inside the band, correctly quiet
    // but the volume really did combine:
    const ramp = volumeRamp(
      { bench: [sess(8, 4), sess(1, 8)], pecdeck: [sess(9, 4), sess(2, 8)] },
      INDEX, NOW,
    )
    expect(ramp.some((f) => f.muscle === 'chest')).toBe(true)
  })

  it('crosses the weekly ceiling only once the names are unified', () => {
    const history: History = { bench: [sess(1, 12)], pecdeck: [sess(2, 12)] }
    const found = weeklySets(history, INDEX, NOW)
    expect(found.some((f) => f.muscle === 'chest')).toBe(true)
  })
})

describe('frequency gaps', () => {
  it('names a muscle that stopped being trained', () => {
    const history: History = { legcurl: [sess(40, 3), sess(GAP_DAYS + 5, 3)] }
    const found = frequencyGaps(history, INDEX, NOW)
    expect(found).toHaveLength(1)
    expect(found[0].text).toMatch(/Hamstrings haven't been trained in \d+ days/)
  })

  it('stays quiet inside the threshold', () => {
    const history: History = { legcurl: [sess(20, 3), sess(GAP_DAYS - 2, 3)] }
    expect(frequencyGaps(history, INDEX, NOW)).toEqual([])
  })

  it('stays quiet on a single session — once is not a habit to have broken', () => {
    const history: History = { legcurl: [sess(60, 3)] }
    expect(frequencyGaps(history, INDEX, NOW)).toEqual([])
  })

  it('says nothing at all with no history', () => {
    expect(frequencyGaps({}, INDEX, NOW)).toEqual([])
  })
})

describe('weekly hard sets', () => {
  it('flags a muscle above the band', () => {
    const history: History = { squat: [sess(1, 14), sess(3, 12)] }
    const found = weeklySets(history, INDEX, NOW)
    expect(found[0].text).toMatch(/above the 20-set band/)
  })

  it('flags a muscle under the band once enough is being trained', () => {
    const history: History = {
      squat: [sess(1, 2)], bench: [sess(2, 12)], row: [sess(3, 12)], curl: [sess(3, 12)],
    }
    const found = weeklySets(history, INDEX, NOW)
    expect(found.some((f) => f.muscle === 'quads' && /under the 10-set band/.test(f.text))).toBe(true)
  })

  it('does not call a beginner under-trained on their first week', () => {
    const history: History = { squat: [sess(1, 2)] }
    expect(weeklySets(history, INDEX, NOW)).toEqual([])
  })

  it('ignores anything older than the week', () => {
    expect(weeklySets({ squat: [sess(20, 30)] }, INDEX, NOW)).toEqual([])
  })
})

describe('ratios', () => {
  it('flags a push-heavy month', () => {
    const history: History = { bench: [sess(3, 12), sess(10, 12)], row: [sess(5, 3)] }
    const found = ratios(history, INDEX, NOW)
    expect(found.some((f) => /Push to pull/.test(f.text))).toBe(true)
  })

  it('flags quad-dominant training', () => {
    const history: History = { squat: [sess(3, 15), sess(9, 15)], legcurl: [sess(5, 3)] }
    expect(ratios(history, INDEX, NOW).some((f) => /Quads to hamstrings/.test(f.text))).toBe(true)
  })

  it('stays quiet when the two sides are balanced', () => {
    const history: History = { bench: [sess(3, 10)], row: [sess(4, 10)] }
    expect(ratios(history, INDEX, NOW).some((f) => /Push to pull/.test(f.text))).toBe(false)
  })

  it('stays quiet when one side has almost nothing — a ratio against zero says nothing', () => {
    const history: History = { bench: [sess(3, 12)] }
    expect(ratios(history, INDEX, NOW)).toEqual([])
  })
})

describe('volume ramp', () => {
  it('flags a hard week-over-week jump', () => {
    const history: History = { squat: [sess(9, 8), sess(2, Math.ceil(8 * RAMP_LIMIT) + 2)] }
    const found = volumeRamp(history, INDEX, NOW)
    expect(found[0].text).toMatch(/jumped from .* to .* hard sets/)
  })

  it('stays quiet on a gentle increase', () => {
    const history: History = { squat: [sess(9, 10), sess(2, 11)] }
    expect(volumeRamp(history, INDEX, NOW)).toEqual([])
  })

  it('stays quiet when last week was too small to ramp from', () => {
    // 2 -> 6 sets triples the load and means nothing
    const history: History = { squat: [sess(9, 2), sess(2, 6)] }
    expect(volumeRamp(history, INDEX, NOW)).toEqual([])
  })
})

describe('the rules that govern all of it', () => {
  it('is deterministic', () => {
    const history: History = { squat: [sess(9, 8), sess(2, 20)], legcurl: [sess(40, 3), sess(20, 3)] }
    expect(analyse(history, INDEX, NOW)).toEqual(analyse(history, INDEX, NOW))
  })

  it('is silent when there is nothing specific to say', () => {
    expect(analyse({}, INDEX, NOW)).toEqual([])
    expect(analyse({ squat: [sess(2, 12)] }, INDEX, NOW)).toEqual([])
  })

  it('marks findings that rest on guessed muscle splits', () => {
    const history: History = { squat: [sess(9, 8), sess(2, 20)] }
    const found = volumeRamp(history, INDEX, NOW)
    expect(found[0].estimated).toBe(true)
  })

  it('ignores exercises with no muscles on record rather than guessing', () => {
    const index = indexFrom({ mystery: { primary: ['Vibes'] } })
    expect(analyse({ mystery: [sess(1, 20)] }, index, NOW)).toEqual([])
  })

  it('reads the clock only from `now`', () => {
    const history: History = { legcurl: [sess(40, 3), sess(20, 3)] }
    const later = new Date('2027-09-19T12:00:00').getTime()
    expect(frequencyGaps(history, INDEX, NOW).length).toBe(1)
    expect(frequencyGaps(history, INDEX, later).length).toBe(1)
    expect(frequencyGaps(history, INDEX, NOW)[0].text)
      .not.toBe(frequencyGaps(history, INDEX, later)[0].text)
  })
})

describe('an empty side is the finding, not a reason to withhold it', () => {
  it('says so when a month of pressing carries almost no pulling', () => {
    const history: History = { bench: [sess(3, 12), sess(10, 12), sess(17, 12)] }
    const found = ratios(history, INDEX, NOW)
    expect(found).toHaveLength(1)
    expect(found[0].text).toMatch(/almost none of pull/)
  })

  it('still needs a real amount of work before passing judgement', () => {
    // one session is a Tuesday, not a training pattern
    expect(ratios({ bench: [sess(3, 12)] }, INDEX, NOW)).toEqual([])
  })
})
