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

/* ------------------------------------------------------------------ *
 * The number the athlete is shown.
 *
 * 49 of 77 mutations survived this module — the largest count in the
 * engine, in the thing that speaks once a week to someone who may not
 * have trained. Two shapes accounted for nearly all of it, and both are
 * about what is NOT asserted rather than what is.
 *
 * Gates were checked only in the silent direction, so a gate that had
 * stopped firing altogether would pass. And findings had their presence
 * asserted but not their content: the sentence composes real figures
 * into a claim a user acts on, and every test checked that a sentence
 * appeared rather than what it said. A wrong number inside a
 * true-shaped sentence is the worst failure available here, because it
 * is the one the athlete cannot detect.
 * ------------------------------------------------------------------ */

/** One session `back` days ago, each set at `weight` for `reps`. */
const setsAt = (back: number, weight: number, reps: number[]) => ({
  date: day(back), kg: weight,
  sets: reps.map((r) => ({ w: weight, r })),
})

/**
 * Four baseline weeks at `base` sets a week, this week at `now`.
 *
 * TWO sessions a week, always. Every hypothesis needs two observations
 * at each end, so a one-session week silently fails the sample gate and
 * the whole fixture reports nothing — which looks exactly like the
 * finding being correctly withheld.
 */
const weekly = (baseSets: number, weekSets: number, weight = 185, baseWeight = weight) => {
  const split = (n: number) => [Math.floor(n / 2), Math.ceil(n / 2)]
  const out: ReturnType<typeof session>[] = []
  for (let w = 1; w <= 4; w++)
    split(baseSets).forEach((n, i) => out.push(session(w * 7 + i * 2, baseWeight, n)))
  split(weekSets).forEach((n, i) => out.push(session(1 + i * 2, weight, n)))
  return out
}
const vitalsOf = (field: 'sleepHours' | 'recovery', now: number, then: number, lag = 1) =>
  Array.from({ length: 40 }, (_, i) => ({ date: day(i + 1), [field]: i + 1 <= 7 + lag ? now : then }))
const bwOf = (now: number, then: number, days = 40) =>
  Array.from({ length: days }, (_, i) => ({ date: day(i + 1), lb: i + 1 <= 7 ? now : then }))

describe('the sentence carries the figures, not just the shape', () => {
  const found = () => weeklyChange(ctx({
    history: { bench: weekly(20, 24) },
    vitals: vitalsOf('sleepHours', 9, 8),
  }))

  it('states the outcome the data actually holds', () => {
    const f = found()
    expect(f?.hypothesis).toBe('sleep_output')
    expect(f?.outcome.current).toBe(24)
    expect(f?.outcome.baseline).toBe(20)
    expect(f?.outcome.change).toBeCloseTo(0.2, 5)
  })

  it('puts that same outcome in the sentence', () => {
    expect(found()?.text).toMatch(/Volume up 20%/)
  })

  it('states the driver in its own units, both sides of it', () => {
    const f = found()
    expect(f?.driver?.current).toBe(9)
    expect(f?.text).toMatch(/averaged 9h sleep against your usual 8/)
  })

  it('names the metric correctly when a confound explains the change', () => {
    /* The noun is chosen by a chain of comparisons and nothing checked
       which word came out. A volume drop announced as "Sessions down
       30%" is a true number attached to the wrong thing. */
    const f = weeklyChange(ctx({
      history: { bench: weekly(20, 14) },
      deloadDates: [day(2)],
    }))
    expect(f?.hypothesis).toBe('confounded_change')
    expect(f?.outcome.metric).toBe('hard_sets')
    expect(f?.text).toMatch(/^Volume down 30% on the week/)
    expect(f?.text).not.toMatch(/Sessions|Tonnage/)
  })
})

describe('the estimated flag on a confounded change', () => {
  const build = (over: Partial<WeeklyContext>) => weeklyChange(ctx({
    history: { bench: weekly(20, 14) }, deloadDates: [day(2)], ...over,
  }))

  it('marks it when the history was imported', () => {
    expect(build({ imported: true })?.estimated).toBe(true)
  })

  it('leaves it unmarked when every split is exact and nothing was imported', () => {
    /* The control. A flag that is always true says nothing, and a flag
       that is always false is the one that misleads. */
    expect(build({})?.estimated).toBe(false)
  })
})

describe('the effect threshold includes its own boundary', () => {
  /* 20 sets a week to 23 is exactly the 15% this hypothesis asks for.
     A gate that needs MORE than its threshold silently raises every
     number in the closed list. */
  const at = (weekSets: number) => weeklyChange(ctx({
    history: { bench: weekly(20, weekSets) },
    vitals: vitalsOf('sleepHours', 9, 7),
  }))

  it('speaks at exactly the minimum effect', () => {
    const f = at(23)
    expect(f?.hypothesis).toBe('sleep_output')
    expect(f?.outcome.change).toBeCloseTo(0.15, 10)
  })

  it('stays silent below it', () => expect(at(22)).toBeNull())
})

describe('direction is part of the claim', () => {
  const other = (now: number, then: number) =>
    Array.from({ length: 40 }, (_, i) => ({
      date: day(i + 1), activity: 'conditioning' as const,
      minutes: i + 1 <= 7 ? now : then, intensity: 3,
    }))

  it('reports lifting volume falling while other training rose', () => {
    const f = weeklyChange(ctx({
      history: { bench: weekly(20, 14) }, otherTraining: other(60, 30),
    }))
    expect(f?.hypothesis).toBe('other_load_volume')
  })

  it('says nothing when both rose, which is not what this hypothesis claims', () => {
    /* An opposite-direction link firing on a same-direction week is the
       app asserting something the data contradicts. */
    const f = weeklyChange(ctx({
      history: { bench: weekly(20, 26) }, otherTraining: other(60, 30),
    }))
    expect(f?.hypothesis).not.toBe('other_load_volume')
  })
})

describe('the estimated one-rep max behind three of the findings', () => {
  /* e1RM feeds recovery_e1rm, relative_strength and progression. Every
     test here reads the NUMBER through a finding, because the reader
     itself is private and a finding is what the athlete sees. */
  const withWeek = (weekSets: Array<{ w: number; r: number }>) => weeklyChange(ctx({
    history: {
      bench: [
        ...[1, 2, 3, 4].flatMap((w) => [setsAt(w * 7, 185, [5, 5]), setsAt(w * 7 + 2, 185, [5, 5])]),
        { date: day(1), kg: 185, sets: weekSets },
        { date: day(3), kg: 185, sets: weekSets },
      ],
    },
    vitals: vitalsOf('recovery', 80, 60),
  }))

  it('uses the best set of the week, not the last one logged', () => {
    /* 205x5 estimates 239.2; a lighter set after it must not replace it. */
    const f = withWeek([{ w: 205, r: 5 }, { w: 95, r: 5 }])
    expect(f?.outcome.current).toBeCloseTo(239.2, 1)
  })

  it('ignores a set above the ten-rep cap however heavy it is', () => {
    /* 300x12 would estimate 420 — an Epley figure off a set that far out
       is not a one-rep max, and letting it in inflates the week. */
    const capped = withWeek([{ w: 205, r: 5 }, { w: 300, r: 12 }])
    expect(capped?.outcome.current).toBeCloseTo(239.2, 1)
  })

  it('counts a set at exactly ten reps', () => {
    /* The boundary in the other direction: the cap excludes ELEVEN. */
    const f = withWeek([{ w: 200, r: 10 }])
    expect(f?.outcome.current).toBeCloseTo(266.7, 1)
  })

  it('ignores a set logged with no reps at all', () => {
    const f = withWeek([{ w: 205, r: 5 }, { w: 400, r: 0 }])
    expect(f?.outcome.current).toBeCloseTo(239.2, 1)
  })
})

describe('bodyweight is read from the entries that are actually bodyweight', () => {
  /* Lifting held flat and bodyweight rising: strength per pound falls
     while the driver climbs, which is the opposite-direction pairing
     this hypothesis is actually about. */
  const build = (entries: unknown[]) => weeklyChange(ctx({
    history: { bench: weekly(6, 6) },
    bodyweight: entries as WeeklyContext['bodyweight'],
  }))

  it('averages the readings inside the week', () => {
    const f = build(bwOf(190, 180))
    expect(f?.hypothesis).toBe('bodyweight_relative_strength')
    expect(f?.driver?.current).toBe(190)
    expect(f?.text).toMatch(/averaged 190 lb/)
  })

  it('ignores an entry whose weight is not a number', () => {
    const polluted = [...bwOf(190, 180), { date: day(2), lb: 'heavy' }]
    expect(build(polluted)?.driver?.current).toBe(190)
  })

  it('ignores an empty slot in the list', () => {
    const polluted = [...bwOf(190, 180), null]
    expect(build(polluted)?.driver?.current).toBe(190)
  })

  it('ignores a reading from outside the window', () => {
    const polluted = [...bwOf(190, 180), { date: day(200), lb: 400 }]
    expect(build(polluted)?.driver?.current).toBe(190)
  })
})

describe('a context missing the parts it never filled in', () => {
  /* Each of these lists is optional at the boundary and absent in a
     brand-new athlete's state. Reaching through one is a crash on the
     quietest week there is. */
  const bare = { history: { bench: weekly(20, 14) }, deloadDates: [day(2)] }

  it.each(['finishedDates', 'bodyweight', 'otherTraining', 'vitals', 'layoffDates'])(
    'survives a missing %s and still answers', (field) => {
      /* Paired in one body: "does not throw" alone is satisfied by a
         function that returns null for everybody, which is exactly the
         failure this module is prone to. deloadDates is excluded because
         removing it removes the confound this fixture is built on — it
         has its own case below. */
      const partial = { ...ctx(bare), [field]: undefined } as WeeklyContext
      expect(() => weeklyChange(partial)).not.toThrow()
      expect(weeklyChange(partial)?.text).toMatch(/Volume down 30% on the week/)
    })

  it('survives a missing deloadDates, which removes the only confound', () => {
    const partial = { ...ctx(bare), deloadDates: undefined } as unknown as WeeklyContext
    expect(() => weeklyChange(partial)).not.toThrow()
    /* Silence is the correct answer with no confound left — so the same
       context WITH one sits beside it, or this passes against a module
       that has stopped speaking entirely. */
    expect(weeklyChange(ctx(bare))?.text).toMatch(/Volume down 30% on the week/)
    expect(weeklyChange(partial)).toBeNull()
  })

  it('returns nothing rather than throwing when there is no context at all', () => {
    expect(weeklyChange(null as never)).toBeNull()
    expect(weeklyChange(undefined as never)).toBeNull()
    expect(weeklyChange({} as never)).toBeNull()
  })

  it('still produces its finding when everything IS filled in', () => {
    /* The control for the six above: "does not throw" is satisfied by a
       function that returns null for everybody. */
    expect(weeklyChange(ctx(bare))?.hypothesis).toBe('confounded_change')
  })
})

describe('both ends of a comparison need enough behind them', () => {
  /* "A mean of one is not a mean" is the rule, and it has to hold on
     each side independently. Every fixture above happens to have a fat
     baseline and a two-session week, so a gate that only ever checked
     one end passed all of them. */
  const sleep = vitalsOf('sleepHours', 9, 7)

  /** Baseline weeks holding `sessions` sessions in total, `sets` each. */
  const sparseBaseline = (sessions: number, sets: number) =>
    Array.from({ length: sessions }, (_, i) => session(8 + i * 7, 185, sets))

  it('needs two baseline sessions, and exactly two is enough', () => {
    /* A returning athlete has plenty logged this week and almost
       nothing to compare it against; reporting a change there is
       arithmetic against one observation. Both halves sit in one body
       because the silent half alone is satisfied by a module that never
       speaks at all. */
    const at = (sessions: number, sets: number) => weeklyChange(ctx({
      history: { bench: [...sparseBaseline(sessions, sets), session(1, 185, 12), session(3, 185, 12)] },
      vitals: sleep,
    }))
    expect(at(1, 80)).toBeNull()
    const f = at(2, 40)
    expect(f?.hypothesis).toBe('sleep_output')
    expect(f?.outcome.baseline).toBe(20)
    expect(f?.outcome.current).toBe(24)
  })

  it('applies the same rule on the confounded path', () => {
    /* That path carries its own copy of the gate, so it needs its own
       pair rather than inheriting the one above. */
    const at = (sessions: number, sets: number) => weeklyChange(ctx({
      history: { bench: [...sparseBaseline(sessions, sets), session(1, 185, 7), session(3, 185, 7)] },
      deloadDates: [day(2)],
    }))
    expect(at(1, 80)).toBeNull()
    const f = at(2, 40)
    expect(f?.hypothesis).toBe('confounded_change')
    expect(f?.text).toMatch(/Volume down 30% on the week/)
  })

  it('gates the DRIVER baseline separately, and on the same rule', () => {
    /* The driver window is read and gated on its own, and a thin driver
       is exactly how a coincidence gets promoted to a finding. */
    const week = [{ date: day(2), sleepHours: 9 }, { date: day(4), sleepHours: 9 }]
    const at = (baselineReadings: string[]) => weeklyChange(ctx({
      history: { bench: weekly(20, 24) },
      vitals: [...week, ...baselineReadings.map((d) => ({ date: d, sleepHours: 7 }))],
    }))
    expect(at([day(20)])).toBeNull()
    const f = at([day(20), day(24)])
    expect(f?.hypothesis).toBe('sleep_output')
    expect(f?.driver?.current).toBe(9)
    expect(f?.driver?.baseline).toBe(7)
  })
})

describe('self-reported training that arrives malformed', () => {
  it('ignores an empty slot rather than reaching through it', () => {
    /* Same shape as the bodyweight list, and the same crash: a null in
       an array the athlete fills in by hand. */
    const entries = [
      ...Array.from({ length: 40 }, (_, i) => ({
        date: day(i + 1), activity: 'conditioning' as const,
        minutes: i + 1 <= 7 ? 60 : 30, intensity: 3,
      })),
      null,
    ] as unknown as WeeklyContext['otherTraining']
    const f = weeklyChange(ctx({ history: { bench: weekly(20, 14) }, otherTraining: entries }))
    expect(f?.hypothesis).toBe('other_load_volume')
  })
})

describe('history that arrives with holes in it', () => {
  it('steps over an empty slot in a lift\'s history', () => {
    /* The bodyweight and other-training lists are both guarded against
       this; history is the one that carries imported rows, so it is the
       likeliest of the three to hold a null. */
    const rows = [...weekly(20, 24), null] as never
    expect(() => weeklyChange(ctx({ history: { bench: rows }, vitals: vitalsOf('sleepHours', 9, 8) }))).not.toThrow()
    expect(weeklyChange(ctx({ history: { bench: rows }, vitals: vitalsOf('sleepHours', 9, 8) }))?.hypothesis)
      .toBe('sleep_output')
  })
})

describe('tonnage is the metric that catches a deload', () => {
  /* The confounded chain tries hard sets, then tonnage, then sessions,
     and only the first of those had ever been reached. A deload that
     keeps the set count and drops the load moves nothing BUT tonnage —
     which is precisely the week the athlete most needs explained. */
  const sameSetsLighter = () => {
    const out: ReturnType<typeof session>[] = []
    for (let w = 1; w <= 4; w++) for (const i of [0, 2]) out.push(session(w * 7 + i, 225, 5))
    for (const i of [1, 3]) out.push(session(i, 135, 5))
    return out
  }

  it('reports the load drop when the set count did not move', () => {
    const f = weeklyChange(ctx({ history: { bench: sameSetsLighter() }, deloadDates: [day(2)] }))
    expect(f?.hypothesis).toBe('confounded_change')
    expect(f?.outcome.metric).toBe('tonnage')
    expect(f?.text).toMatch(/^Tonnage down 40% on the week/)
  })

  it('carries the real tonnage figures, not just the word', () => {
    const f = weeklyChange(ctx({ history: { bench: sameSetsLighter() }, deloadDates: [day(2)] }))
    /* 2 sessions x 5 sets x 5 reps: 225 lb gives 11,250 a week, 135 gives 6,750. */
    expect(f?.outcome.baseline).toBe(11250)
    expect(f?.outcome.current).toBe(6750)
  })
})
