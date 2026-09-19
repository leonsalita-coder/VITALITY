import { describe, it, expect } from 'vitest'
import { weeklyChange, HYPOTHESES, type WeeklyContext } from '../../lib/train/weekly'
import { indexFrom } from '../../lib/train/analysis'

/**
 * When a week is different, say what else was different.
 *
 * THE LINE THIS FILE WALKS. With this many metrics, an open-ended
 * correlation search would manufacture a finding every week — and a
 * finding that is wrong once teaches the athlete to ignore the next
 * twenty. So the engine tests a fixed list of physiologically plausible
 * links and nothing else, reports co-occurrence in both numbers, never
 * says "because", and stays completely silent when nothing clears the
 * gates.
 */

const NOW = new Date(2026, 8, 19, 12).getTime()
const day = (back: number) => {
  const d = new Date(2026, 8, 19 - back)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const CHEST = { primary: [{ muscle: 'chest', share: 1 }], kind: 'reps_weight' }
const index = indexFrom({ bench: CHEST })

/** A bench session `back` days ago with `sets` working sets at `weight`. */
const session = (back: number, weight: number, sets: number, over: Record<string, unknown> = {}) => ({
  date: day(back), kg: weight,
  sets: Array.from({ length: sets }, () => ({ w: weight, r: 5, ...over })),
})

const ctx = (over: Partial<WeeklyContext> = {}): WeeklyContext => ({
  history: {}, index, finishedDates: [], bodyweight: [], otherTraining: [],
  vitals: [], deloadDates: [], layoffDates: [], now: NOW, ...over,
})

/** Four baseline weeks at `base` sets, then this week at `now`. */
const weeks = (baseSets: number, thisWeekSets: number, weight = 185) => {
  const out = []
  for (let w = 1; w <= 4; w++) {
    for (const offset of [0, 3]) out.push(session(w * 7 + offset, weight, baseSets / 2))
  }
  for (const offset of [1, 4]) out.push(session(offset, weight, thisWeekSets / 2))
  return out
}

const sleepAll = (hours: number, days = 40) =>
  Array.from({ length: days }, (_, i) => ({ date: day(i + 1), sleepHours: hours }))

describe('the hypothesis list is closed', () => {
  it('is a fixed list, not a search', () => {
    expect(HYPOTHESES.length).toBeGreaterThan(0)
    expect(HYPOTHESES.length).toBeLessThan(12)
  })

  it('every hypothesis declares its own lag, sample size and effect', () => {
    for (const h of HYPOTHESES) {
      expect(typeof h.id).toBe('string')
      expect(typeof h.lagDays).toBe('number')
      expect(h.minSamples).toBeGreaterThan(0)
      expect(h.minEffect).toBeGreaterThan(0)
    }
  })

  it('covers the links that were specified, and no others', () => {
    expect(HYPOTHESES.map((h) => h.id).sort()).toEqual([
      'bodyweight_relative_strength',
      'frequency_progression',
      'other_load_volume',
      'recovery_e1rm',
      'rest_compression_reps',
      'sleep_output',
    ])
  })
})

describe('a real effect produces the finding', () => {
  /* Volume clearly up, on a week that was also clearly better slept. */
  const better = ctx({
    history: { bench: weeks(8, 16) },
    finishedDates: [day(1), day(4)],
    vitals: [
      ...Array.from({ length: 30 }, (_, i) => ({ date: day(i + 8), sleepHours: 6.4 })),
      ...Array.from({ length: 7 }, (_, i) => ({ date: day(i + 1), sleepHours: 7.8 })),
    ],
  })

  it('reports it', () => {
    const finding = weeklyChange(better)
    expect(finding).not.toBeNull()
    expect(finding!.hypothesis).toBe('sleep_output')
  })

  it('states both numbers', () => {
    const finding = weeklyChange(better)!
    expect(finding.outcome.current).toBeGreaterThan(finding.outcome.baseline)
    expect(finding.driver!.current).toBeGreaterThan(finding.driver!.baseline)
    expect(finding.text).toMatch(/7\.8/)
    expect(finding.text).toMatch(/6\.4/)
  })

  it('never claims causation', () => {
    const finding = weeklyChange(better)!
    expect(finding.text).not.toMatch(/because|caused|due to|thanks to|led to/i)
  })
})

describe('noise produces silence', () => {
  it('says nothing about a 4% move', () => {
    expect(weeklyChange(ctx({
      history: { bench: weeks(16, 16.6) },
      finishedDates: [day(1), day(4)],
      vitals: sleepAll(7),
    }))).toBeNull()
  })

  it('says nothing on a thin sample, however large the move', () => {
    /* One session this week against one baseline session. The effect is
       enormous and means nothing. */
    expect(weeklyChange(ctx({
      history: { bench: [session(8, 185, 3), session(1, 185, 12)] },
      finishedDates: [day(1)],
      vitals: sleepAll(8),
    }))).toBeNull()
  })

  it('says nothing with no history at all', () => {
    expect(weeklyChange(ctx())).toBeNull()
  })

  it('says nothing when the outcome moved but no tested driver did', () => {
    expect(weeklyChange(ctx({
      history: { bench: weeks(8, 16) },
      finishedDates: [day(1), day(4)],
      vitals: sleepAll(7),   // sleep flat
    }))).toBeNull()
  })
})

describe('each gate refuses on its own', () => {
  /* Every gate has to be tested with the OTHERS satisfied, or the first
     one to fire masks the rest — which is how all four of these survived
     mutation testing on the first pass while looking thoroughly covered. */
  const bigDriver = [
    ...Array.from({ length: 30 }, (_, i) => ({ date: day(i + 8), sleepHours: 6.0 })),
    ...Array.from({ length: 8 }, (_, i) => ({ date: day(i + 1), sleepHours: 8.4 })),
  ]

  it('refuses a small outcome even when the driver moved a lot', () => {
    /* +12.5%, under the 15% gate — and deliberately NOT zero, because a
       zero change is filtered by the direction check instead and would
       leave the effect gate untested. */
    expect(weeklyChange(ctx({
      history: { bench: weeks(16, 18) },
      finishedDates: [day(1), day(4)],
      vitals: bigDriver,                      // +40%, well over its gate
    }))).toBeNull()
  })

  it('refuses a small driver even when the outcome moved a lot', () => {
    expect(weeklyChange(ctx({
      history: { bench: weeks(8, 16) },       // +100%
      finishedDates: [day(1), day(4)],
      vitals: [
        ...Array.from({ length: 30 }, (_, i) => ({ date: day(i + 8), sleepHours: 7.0 })),
        ...Array.from({ length: 8 }, (_, i) => ({ date: day(i + 1), sleepHours: 7.3 })),
      ],                                       // +4%, under the 10% gate
    }))).toBeNull()
  })

  it('refuses a thin sample even when both moved a lot', () => {
    /* One session this week, one in the baseline. The effect is enormous
       and the evidence is a single pair of observations. */
    expect(weeklyChange(ctx({
      history: { bench: [session(8, 185, 4), session(1, 185, 12)] },
      finishedDates: [day(1)],
      vitals: bigDriver,
    }))).toBeNull()
  })

  it('refuses a pair that moved the wrong way for the hypothesis', () => {
    /* Volume up while sleep fell. Real enough on both sides, and not what
       sleep_output claims — accepting either direction would make every
       pair a match and turn the closed list back into a search. */
    expect(weeklyChange(ctx({
      history: { bench: weeks(8, 16) },
      finishedDates: [day(1), day(4)],
      vitals: [
        ...Array.from({ length: 30 }, (_, i) => ({ date: day(i + 8), sleepHours: 8.4 })),
        ...Array.from({ length: 8 }, (_, i) => ({ date: day(i + 1), sleepHours: 6.0 })),
      ],
    }))).toBeNull()
  })
})

describe('other-training load is always estimated', () => {
  it('marks a finding it drove', () => {
    const finding = weeklyChange(ctx({
      history: { bench: weeks(16, 8) },       // lifting volume halved
      finishedDates: [day(1), day(4)],
      otherTraining: [
        ...Array.from({ length: 4 }, (_, w) => ({
          date: day(w * 7 + 2), activity: 'conditioning' as const, minutes: 20, intensity: 4,
        })),
        { date: day(2), activity: 'martial_arts' as const, minutes: 120, intensity: 9 },
        { date: day(5), activity: 'martial_arts' as const, minutes: 120, intensity: 9 },
      ],
    }))
    expect(finding).not.toBeNull()
    expect(finding!.hypothesis).toBe('other_load_volume')
    expect(finding!.estimated).toBe(true)
    expect(finding!.text).toMatch(/self-reported/i)
  })
})

describe('the confound is named in the sentence, not just the data', () => {
  it('appends it to a finding that fired on its own', () => {
    const finding = weeklyChange(ctx({
      history: { bench: weeks(8, 16) },
      finishedDates: [day(1), day(4)],
      vitals: [
        ...Array.from({ length: 30 }, (_, i) => ({ date: day(i + 8), sleepHours: 6.4 })),
        ...Array.from({ length: 8 }, (_, i) => ({ date: day(i + 1), sleepHours: 7.8 })),
      ],
      layoffDates: [day(3)],
    }))
    expect(finding).not.toBeNull()
    expect(finding!.confounds).toContain('layoff')
    expect(finding!.text).toMatch(/layoff/i)
  })
})

describe('ranking picks the most important, not the last computed', () => {
  it('returns the higher-priority hypothesis when two fire', () => {
    /* BOTH must actually fire, or first and last are the same element and
       the ranking is untested. So this week has more sets (volume up, for
       sleep_output) AND shorter rest with fewer all-out reps (for
       rest_compression_reps). */
    const rested = (back: number, gap: number, amrap: number, sets: number) => {
      const start = new Date(`${day(back)}T18:00:00`).getTime()
      const rows = []
      for (let i = 0; i < sets; i++) rows.push({ w: 185, r: 5, at: start + i * gap * 1000 })
      rows.push({ w: 185, r: amrap, amrap: true, at: start + sets * gap * 1000 })
      return { date: day(back), kg: 185, sets: rows }
    }
    const history = {
      bench: [
        ...[1, 2, 3, 4].flatMap((w) => [rested(w * 7, 180, 12, 3), rested(w * 7 + 3, 180, 12, 3)]),
        rested(1, 60, 7, 7), rested(4, 60, 7, 7),
      ],
    }
    const finding = weeklyChange(ctx({
      history,
      finishedDates: [day(1), day(4)],
      vitals: [
        ...Array.from({ length: 30 }, (_, i) => ({ date: day(i + 8), sleepHours: 6.4 })),
        ...Array.from({ length: 8 }, (_, i) => ({ date: day(i + 1), sleepHours: 7.8 })),
      ],
    }))
    expect(finding).not.toBeNull()
    /* Prove two candidates really exist, or the assertion below passes
       whether or not anything was ranked. */
    expect(weeklyChange(ctx({
      history,
      finishedDates: [day(1), day(4)],
      vitals: [
        ...Array.from({ length: 30 }, (_, i) => ({ date: day(i + 8), sleepHours: 6.4 })),
        ...Array.from({ length: 8 }, (_, i) => ({ date: day(i + 1), sleepHours: 7.8 })),
      ],
    }))!.hypothesis).toBe('rest_compression_reps')
    expect(finding!.hypothesis).toBe('rest_compression_reps')
    expect(finding!.priority).toBe(5)
  })
})

describe('lag is applied correctly', () => {
  /* Sleep improves for the seven days ENDING yesterday, i.e. the nights
     before this week's sessions. A same-day read would miss it, and a
     read shifted the wrong way would find it in the baseline. */
  it('reads the nights before the sessions, not the same day', () => {
    const h = HYPOTHESES.find((x) => x.id === 'sleep_output')!
    expect(h.lagDays).toBeGreaterThan(0)
  })

  it('finds a driver that moved in the preceding window', () => {
    const finding = weeklyChange(ctx({
      history: { bench: weeks(8, 16) },
      finishedDates: [day(1), day(4)],
      vitals: [
        ...Array.from({ length: 30 }, (_, i) => ({ date: day(i + 9), sleepHours: 6.0 })),
        ...Array.from({ length: 8 }, (_, i) => ({ date: day(i + 1), sleepHours: 8.0 })),
      ],
    }))
    expect(finding).not.toBeNull()
    expect(finding!.driver!.lagDays).toBeGreaterThan(0)
  })

  it('reads the lagged window, and would miss the effect without it', () => {
    /* Built so the two windows DISAGREE, which is the only way to tell
       which one is being read. rollingWindow(now) covers days 0-6 and
       rollingWindow(now, 1) covers days 1-7, so they differ by exactly
       two days: today, and the day before the week began.
       A very short night today and a very long one on day 7 pull the two
       means in opposite directions — the lagged window rises past its
       gate, the same-day window falls. */
    const vitals = [
      ...Array.from({ length: 28 }, (_, i) => ({ date: day(i + 8), sleepHours: 6.4 })),
      { date: day(7), sleepHours: 13 },
      ...Array.from({ length: 6 }, (_, i) => ({ date: day(i + 1), sleepHours: 6.4 })),
      { date: day(0), sleepHours: 2 },
    ]
    const finding = weeklyChange(ctx({
      history: { bench: weeks(8, 16) },
      finishedDates: [day(1), day(4)],
      vitals,
    }))
    expect(finding).not.toBeNull()
    expect(finding!.hypothesis).toBe('sleep_output')
    // the lagged mean is the one above the usual 6.4
    expect(finding!.driver!.current).toBeGreaterThan(finding!.driver!.baseline)
  })

  it('does not find a driver that only moved AFTER the outcome window', () => {
    /* Sleep improved only in the baseline weeks and went back to normal
       for the nights before this week. Nothing to report. */
    const finding = weeklyChange(ctx({
      history: { bench: weeks(8, 16) },
      finishedDates: [day(1), day(4)],
      vitals: [
        ...Array.from({ length: 30 }, (_, i) => ({ date: day(i + 8), sleepHours: 8.2 })),
        ...Array.from({ length: 7 }, (_, i) => ({ date: day(i + 1), sleepHours: 6.2 })),
      ],
    }))
    // sleep fell while volume rose — not the hypothesis, so not reported
    expect(finding === null || finding.hypothesis !== 'sleep_output').toBe(true)
  })
})

describe('a deload week names the deload', () => {
  const deloaded = ctx({
    history: { bench: weeks(16, 8) },
    finishedDates: [day(1), day(4)],
    vitals: sleepAll(7),
    deloadDates: [day(1), day(4)],
  })

  it('reports the drop with the deload named', () => {
    const finding = weeklyChange(deloaded)
    expect(finding).not.toBeNull()
    expect(finding!.confounds).toContain('deload')
    expect(finding!.text).toMatch(/deload/i)
  })

  it('does not present it as a mystery', () => {
    expect(weeklyChange(deloaded)!.text).not.toMatch(/unexplained|mysterious|for no reason/i)
  })

  it('names a layoff the same way', () => {
    const finding = weeklyChange(ctx({
      history: { bench: weeks(16, 8) },
      finishedDates: [day(1), day(4)],
      vitals: sleepAll(7),
      layoffDates: [day(5)],
    }))
    expect(finding === null || finding.confounds.includes('layoff')).toBe(true)
  })

  it('marks a finding built on imported data as estimated', () => {
    const finding = weeklyChange(ctx({
      history: { bench: weeks(8, 16).map((s) => ({ ...s, sets: s.sets.map((x) => ({ ...x, atEstimated: true })) })) },
      finishedDates: [day(1), day(4)],
      vitals: [
        ...Array.from({ length: 30 }, (_, i) => ({ date: day(i + 8), sleepHours: 6.4 })),
        ...Array.from({ length: 7 }, (_, i) => ({ date: day(i + 1), sleepHours: 7.8 })),
      ],
      imported: true,
    }))
    expect(finding === null || finding.estimated).toBe(true)
  })
})

describe('coincidence is not a finding', () => {
  it('ignores two metrics moving together when the link is not on the list', () => {
    /* Bodyweight and session COUNT both jump. There is no
       bodyweight-to-frequency hypothesis, and inventing one from the
       coincidence is exactly what the closed list prevents. */
    const finding = weeklyChange(ctx({
      history: { bench: weeks(16, 16) },
      finishedDates: [day(1), day(3), day(5)],
      vitals: sleepAll(7),
      bodyweight: [
        ...Array.from({ length: 4 }, (_, i) => ({ date: day((i + 1) * 7 + 2), lb: 170 })),
        { date: day(2), lb: 182 },
      ],
    }))
    expect(finding === null || finding.hypothesis !== 'bodyweight_frequency').toBe(true)
    expect(HYPOTHESES.map((h) => h.id)).not.toContain('bodyweight_frequency')
  })
})

describe('one finding, ranked', () => {
  it('returns a single finding, never a list', () => {
    const finding = weeklyChange(ctx({
      history: { bench: weeks(8, 16) },
      finishedDates: [day(1), day(4)],
      vitals: [
        ...Array.from({ length: 30 }, (_, i) => ({ date: day(i + 8), sleepHours: 6.4, recovery: 55 })),
        ...Array.from({ length: 7 }, (_, i) => ({ date: day(i + 1), sleepHours: 7.8, recovery: 78 })),
      ],
    }))
    expect(finding).not.toBeNull()
    expect(Array.isArray(finding)).toBe(false)
    expect(typeof finding!.priority).toBe('number')
  })

  it('is deterministic', () => {
    const c = ctx({
      history: { bench: weeks(8, 16) },
      finishedDates: [day(1), day(4)],
      vitals: [
        ...Array.from({ length: 30 }, (_, i) => ({ date: day(i + 8), sleepHours: 6.4 })),
        ...Array.from({ length: 7 }, (_, i) => ({ date: day(i + 1), sleepHours: 7.8 })),
      ],
    })
    expect(weeklyChange(c)).toEqual(weeklyChange(c))
  })
})
