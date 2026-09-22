import { describe, it, expect } from 'vitest'
import {
  GAP_DAYS, WEEKLY_SET_BAND,
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
    /* But the volume really did combine. Shown against a month of
       baseline, because volumeRamp now delegates to the acute-versus-
       chronic model and that model refuses to speak without one. */
    const steady = (id: string, perWeek: number) =>
      Array.from({ length: 10 }, (_, w) => sess(w * 7 + 1, perWeek))
    const ramp = volumeRamp(
      {
        bench: [...steady('bench', 3), sess(1, 14)],
        pecdeck: [...steady('pecdeck', 3), sess(2, 14)],
      },
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
    /* Needs a stated training age now: an under-band finding is never
       fired off a default the athlete never chose — see targets.ts. */
    const found = weeklySets(history, INDEX, NOW, { trainingAge: 'intermediate' })
    expect(found.some((f) => f.muscle === 'quads' && /under the 10-set band/.test(f.text))).toBe(true)
  })

  it('says nothing about being under when no training age was ever stated', () => {
    const history: History = {
      squat: [sess(1, 2)], bench: [sess(2, 12)], row: [sess(3, 12)], curl: [sess(3, 12)],
    }
    expect(weeklySets(history, INDEX, NOW).filter((f) => /under/.test(f.text))).toEqual([])
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
  /* volumeRamp now delegates to the acute-versus-chronic model, so every
     case below needs a real baseline to be measured against — which is
     the point of the replacement. A week-over-week threshold fired on two
     sessions and said nothing about how used to the work the lifter was. */
  const block = (perWeek: number, weeks = 10) =>
    Array.from({ length: weeks }, (_, w) => sess((weeks - w) * 7, perWeek))

  it('flags a load well above what the lifter is used to', () => {
    const history: History = { squat: [...block(8), sess(2, 26), sess(5, 26)] }
    const found = volumeRamp(history, INDEX, NOW)
    expect(found.length).toBeGreaterThan(0)
    expect(found[0].text).toMatch(/hard sets a week lately against a usual/)
  })

  it('stays quiet on a gentle increase', () => {
    // control: the same block with a big jump DOES fire
    expect(volumeRamp({ squat: [...block(10), sess(2, 30)] }, INDEX, NOW).length)
      .toBeGreaterThan(0)
    const history: History = { squat: [...block(10), sess(2, 11)] }
    expect(volumeRamp(history, INDEX, NOW)).toEqual([])
  })

  it('stays quiet with no baseline to compare against', () => {
    // two sessions is not a month of training, whatever the jump
    const history: History = { squat: [sess(9, 2), sess(2, 20)] }
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
    /* weeklySets carries the same flag and needs no month of baseline,
       so it is the cheaper place to hold this rule. */
    const history: History = {
      squat: [sess(1, 2)], bench: [sess(2, 12)], row: [sess(3, 12)], curl: [sess(3, 12)],
    }
    const found = weeklySets(history, INDEX, NOW, { trainingAge: 'intermediate' })
    expect(found.length).toBeGreaterThan(0)
    expect(found.some((f) => f.estimated)).toBe(true)
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

/**
 * Every gate, in both directions.
 *
 * Thirty mutations survived this module, and the reason is the shape
 * that bit the catalog: a gate asserted only in the silent direction is
 * satisfied completely by never firing. "Stays quiet inside the
 * threshold" passes just as happily against a finding that has been
 * switched off — so each one below is paired with the case that proves
 * it can still speak, and both sit on the exact boundary rather than
 * comfortably inside it.
 *
 * squat and legcurl carry a single primary each, so their sets land 1:1
 * on quads and hamstrings and a boundary can be hit exactly.
 */
describe('each gate fires on its boundary and not before', () => {
  describe('a gap of exactly the threshold is a gap', () => {
    it('speaks at GAP_DAYS and not a day earlier', () => {
      /* Both halves in one body deliberately. The quiet assertion on its
         own is satisfied by a finding that never fires at all, which is
         the shape this whole pass is about. */
      const at = (gap: number) =>
        frequencyGaps({ squat: [sess(gap, 5), sess(gap + 7, 5)] }, INDEX, NOW)
          .some((f) => f.muscle === 'quads')
      expect(at(GAP_DAYS)).toBe(true)
      expect(at(GAP_DAYS - 1)).toBe(false)
    })
  })

  describe('the weekly window includes today and the seventh day back', () => {
    const over = (day: number) =>
      weeklySets({ squat: [sess(day, 21)] }, INDEX, NOW).some((f) => /above/.test(f.text))

    it('counts sets logged today', () => {
      /* The window runs 0..6 days. Dropping today would silence the
         finding on the day the athlete is most likely looking. */
      expect(over(0)).toBe(true)
    })

    it('counts sets logged six days ago', () => expect(over(6)).toBe(true))
    it('ignores sets logged seven days ago', () => expect(over(7)).toBe(false))
  })

  describe('the ceiling is a ceiling, not a limit to reach', () => {
    const at = (sets: number) =>
      weeklySets({ squat: [sess(1, sets)] }, INDEX, NOW).some((f) => /above the 20-set band/.test(f.text))

    it('says nothing at exactly the band ceiling', () => expect(at(20)).toBe(false))
    it('speaks one set above it', () => expect(at(21)).toBe(true))
  })

  describe('the floor is a floor', () => {
    /* All inside the last week, so no trailing average exists and the
       age profile is the floor under test. Three muscles, because the
       age-profile floor is gated on the athlete training enough for
       "under" to be a choice rather than a starting point. */
    const at = (sets: number) => weeklySets(
      { squat: [sess(1, sets)], curl: [sess(2, 12)], legcurl: [sess(3, 12)] },
      INDEX, NOW, { trainingAge: 'intermediate' },
    ).some((f) => f.muscle === 'quads' && /under/.test(f.text))

    it('says nothing at exactly the band floor', () => expect(at(10)).toBe(false))
    it('speaks one set below it', () => expect(at(9)).toBe(true))
    it('says nothing at all about a muscle with no sets', () => expect(at(0)).toBe(false))
  })

  describe('the age-profile floor needs three muscles, and exactly three will do', () => {
    const withMuscles = (lifts: History) =>
      weeklySets(lifts, INDEX, NOW, { trainingAge: 'intermediate' })
        .some((f) => f.muscle === 'quads' && /under the 10-set band/.test(f.text))

    it('speaks on exactly three', () => {
      expect(withMuscles({ squat: [sess(1, 2)], curl: [sess(2, 12)], legcurl: [sess(3, 12)] })).toBe(true)
    })

    it('stays quiet on two', () => {
      expect(withMuscles({ squat: [sess(1, 2)], curl: [sess(2, 12)] })).toBe(false)
    })
  })

  describe('the ratio window runs from today to the far edge inclusive', () => {
    const heavy = (day: number) =>
      ratios({ squat: [sess(day, 14)], legcurl: [sess(1, 6)] }, INDEX, NOW)
        .some((f) => /Quads to hamstrings/.test(f.text))

    it('counts work done today', () => expect(heavy(0)).toBe(true))
    it('counts work on the last day of the window', () => expect(heavy(28)).toBe(true))
    it('drops work one day past it', () => expect(heavy(29)).toBe(false))
  })

  describe('a pattern needs enough sets behind it', () => {
    const total = (quads: number) =>
      ratios({ squat: [sess(3, quads)], legcurl: [sess(5, 6)] }, INDEX, NOW)
        .some((f) => /Quads to hamstrings/.test(f.text))

    it('passes judgement at exactly twenty combined sets', () => expect(total(14)).toBe(true))
    it('withholds it at nineteen', () => expect(total(13)).toBe(false))
  })

  describe('the balanced band is inclusive at both edges', () => {
    const ratioOf = (quads: number, hams: number) =>
      ratios({ squat: [sess(3, quads)], legcurl: [sess(5, hams)] }, INDEX, NOW)
        .some((f) => /Quads to hamstrings/.test(f.text))

    it('says nothing at exactly the top of the band', () => expect(ratioOf(17, 10)).toBe(false))
    it('speaks just above it', () => expect(ratioOf(18, 10)).toBe(true))
    it('says nothing at exactly the bottom of the band', () => expect(ratioOf(12, 20)).toBe(false))
    it('speaks just below it', () => expect(ratioOf(11, 20)).toBe(true))
  })
})

describe('what counts as having trained', () => {
  it('ignores a session marked off, and only because it is marked off', () => {
    const session = sess(1, 25)
    expect(weeklySets({ squat: [{ ...session, off: true }] }, INDEX, NOW)).toEqual([])
    expect(weeklySets({ squat: [session] }, INDEX, NOW).length).toBeGreaterThan(0)
  })

  it('does not treat a warm-up-only session as having trained', () => {
    /* Counting it does more than inflate a total: it makes the muscle
       look trained twice, so the app then reports a gap since a day the
       athlete never worked. The control is the same shape with real
       sets, in the same body — alone, the quiet half passes against a
       gap finding that fires for nobody. */
    const warmOnly = {
      date: ago(20), kg: 100,
      sets: Array.from({ length: 8 }, () => ({ w: 100, r: 5, warmup: true })),
    }
    expect(frequencyGaps({ squat: [warmOnly, sess(30, 5)] }, INDEX, NOW)).toEqual([])
    expect(frequencyGaps({ squat: [sess(20, 8), sess(30, 5)] }, INDEX, NOW)
      .some((f) => f.muscle === 'quads')).toBe(true)
  })

  it('skips a lift whose muscles are unrecognised instead of throwing', () => {
    const index = indexFrom({ mystery: { primary: ['Vibes'] }, squat: { primary: ['Quads'] } })
    const history: History = { mystery: [sess(1, 20)], squat: [sess(1, 25)] }
    expect(() => analyse(history, index, NOW)).not.toThrow()
    const found = analyse(history, index, NOW)
    expect(found.every((f) => f.muscle !== undefined ? f.muscle === 'quads' : true)).toBe(true)
  })
})

describe('a guess anywhere makes the finding a guess', () => {
  it('marks a gap estimated when any contributing set was estimated', () => {
    /* Propagation is an OR, not an AND. Requiring every row to be a
       guess would report a finding as exact on the strength of one
       exact lift among guesses — the flag reads as "trust this". */
    const index = indexFrom({
      exact: { primary: [{ muscle: 'quads', share: 1 }] },
      guessy: { primary: ['Quads'] },
    })
    const history: History = { exact: [sess(20, 5)], guessy: [sess(30, 5)] }
    const found = frequencyGaps(history, index, NOW)
    expect(found).toHaveLength(1)
    expect(found[0].estimated).toBe(true)
  })

  it('leaves a finding built only from exact splits unmarked', () => {
    const index = indexFrom({ exact: { primary: [{ muscle: 'quads', share: 1 }] } })
    const history: History = { exact: [sess(20, 5), sess(30, 5)] }
    const found = frequencyGaps(history, index, NOW)
    expect(found).toHaveLength(1)
    expect(found[0].estimated).toBe(false)
  })
})

/**
 * The trailing average, pinned by the number it puts on screen.
 *
 * The four-week walk is the most intricate arithmetic in the file and
 * nothing asserted its result — only that a finding of some kind
 * appeared. Both the week-boundary comparisons survived a sweep because
 * a finding still appeared with the wrong average in it.
 *
 * So these assert the average the athlete is actually shown.
 */
describe('the four-week trailing average', () => {
  /* Weeks 1-4 are days 7-13, 14-20, 21-27, 28-34. One session sits on
     the first day of each, and the last one is deliberately the odd one
     out so that dropping or keeping it changes the answer. */
  const history: History = {
    squat: [sess(1, 3), sess(7, 6), sess(14, 6), sess(21, 6), sess(28, 18)],
  }

  it('counts all four weeks, including the one the oldest session starts', () => {
    /* 6 + 6 + 6 + 18 over four weeks is 9. Stopping a week early reads
       18 over three and calls it 6. */
    const found = weeklySets(history, INDEX, NOW, { trainingAge: 'intermediate' })
    expect(found.some((f) => f.muscle === 'quads' && /recent average of 9/.test(f.text))).toBe(true)
  })

  it('counts a session landing exactly on a week boundary', () => {
    /* Every session above sits on the first day of its week. Excluding
       the boundary empties all four weeks, the average becomes zero, and
       the finding vanishes rather than becoming wrong — which is how it
       survived unnoticed. */
    const found = weeklySets(history, INDEX, NOW, { trainingAge: 'intermediate' })
    expect(found.some((f) => f.muscle === 'quads' && /recent average/.test(f.text))).toBe(true)
  })

  it('prefers the athlete\'s own average to the age profile', () => {
    /* The control on which floor is in play: 3 sets is under the
       intermediate floor of 10 too, so a test that only checked for
       "under" would pass either way. */
    const found = weeklySets(history, INDEX, NOW, { trainingAge: 'intermediate' })
    const quads = found.find((f) => f.muscle === 'quads')
    expect(quads?.text).toMatch(/recent average/)
    expect(quads?.text).not.toMatch(/10-set band/)
  })
})

describe('history the index has never heard of', () => {
  it('skips an exercise with no entry in the index at all', () => {
    /* Not the same as an entry with no muscles: this id is absent, so
       the split is undefined and anything that reaches through it
       throws rather than staying quiet. */
    const index = indexFrom({ squat: { primary: ['Quads'] } })
    const history: History = { ghost: [sess(1, 20)], squat: [sess(1, 25)] }
    expect(() => analyse(history, index, NOW)).not.toThrow()
    /* Ratio findings carry no muscle, so only the ones that name a
       muscle are the claim here: none of them may be the ghost. */
    const named = analyse(history, index, NOW).filter((f) => f.muscle)
    expect(named.length).toBeGreaterThan(0)
    expect(named.every((f) => f.muscle === 'quads')).toBe(true)
  })

  it('still reads the exercises it does know', () => {
    const index = indexFrom({ squat: { primary: ['Quads'] } })
    const history: History = { ghost: [sess(1, 20)], squat: [sess(1, 25)] }
    expect(analyse(history, index, NOW).length).toBeGreaterThan(0)
  })
})

/**
 * One set is not "almost none".
 *
 * The one-sided wording exists for the case where a ratio cannot be
 * stated — a month of pressing against literally nothing. A side holding
 * a whole set has a ratio, and saying "almost none" of it instead throws
 * away the number that makes the finding actionable.
 *
 * Both operands are asserted: the guard reads `right < 1 || left < 1`,
 * and each half is reachable depending on which side is the busy one.
 */
describe('the line between a ratio and an empty side', () => {
  it('states the ratio when the quiet side has a whole set', () => {
    const found = ratios({ squat: [sess(3, 20)], legcurl: [sess(5, 1)] }, INDEX, NOW)
    expect(found.some((f) => /Quads to hamstrings is running/.test(f.text))).toBe(true)
    expect(found.some((f) => /almost none/.test(f.text))).toBe(false)
  })

  it('says almost none when that side has nothing at all', () => {
    const found = ratios({ squat: [sess(3, 20)] }, INDEX, NOW)
    expect(found.some((f) => /almost none of hamstrings/.test(f.text))).toBe(true)
  })

  it('states the ratio when it is the BUSY side that holds one set', () => {
    /* The other operand. With hamstrings carrying the volume the same
       guard is reached through its left-hand half. */
    const found = ratios({ squat: [sess(3, 1)], legcurl: [sess(5, 20)] }, INDEX, NOW)
    expect(found.some((f) => /Quads to hamstrings is running/.test(f.text))).toBe(true)
    expect(found.some((f) => /almost none/.test(f.text))).toBe(false)
  })

  it('says almost none when the busy side is alone', () => {
    const found = ratios({ legcurl: [sess(5, 20)] }, INDEX, NOW)
    expect(found.some((f) => /almost none of quads/.test(f.text))).toBe(true)
  })
})
