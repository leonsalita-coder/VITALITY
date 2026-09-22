import { describe, it, expect } from 'vitest'
import {
  epley1RM,
  E1RM_MAX_REPS,
  ROLLING_PR_DAYS,
  bestE1RM,
  classifyPR,
  nearMissCue,
} from '../../lib/train/records'
import type { HistoryEntry } from '../../lib/train/sets'

const at = (day: string) => new Date(`${day}T12:00:00`).getTime()

const session = (date: string, w: number, reps: number[], warmup = 0): HistoryEntry => ({
  date,
  kg: w,
  sets: reps.map((r, i) => ({ w, r, ...(i < warmup ? { warmup: true } : {}) })),
})

describe('epley1RM', () => {
  it('returns the weight itself at one rep', () => {
    expect(epley1RM(225, 1)).toBeCloseTo(225, 6)
  })

  it('follows Epley for low reps', () => {
    // 225 * (1 + 5/30) = 262.5
    expect(epley1RM(225, 5)).toBeCloseTo(262.5, 6)
  })

  it('refuses to extrapolate past the rep cap', () => {
    expect(epley1RM(135, E1RM_MAX_REPS)).not.toBeNull()
    expect(epley1RM(135, E1RM_MAX_REPS + 1)).toBeNull()
    expect(epley1RM(95, 20)).toBeNull()
  })

  it('is null for nonsense input', () => {
    expect(epley1RM(0, 5)).toBeNull()
    expect(epley1RM(225, 0)).toBeNull()
    expect(epley1RM(-5, 3)).toBeNull()
  })

  it('ranks heavy-low against light-high the way a lifter would', () => {
    const triple = epley1RM(245, 3)! // 269.5
    const fiver = epley1RM(225, 5)! // 262.5
    const eight = epley1RM(205, 8)! // 259.67
    expect(triple).toBeGreaterThan(fiver)
    expect(fiver).toBeGreaterThan(eight)
  })
})

describe('bestE1RM', () => {
  const history = [session('2026-01-10', 205, [5, 5, 5]), session('2026-06-10', 225, [5, 5, 4])]

  it('finds the best across every working set', () => {
    expect(bestE1RM(history)!.value).toBeCloseTo(262.5, 4)
  })

  it('reports which session produced it', () => {
    const best = bestE1RM(history)!
    expect(best.date).toBe('2026-06-10')
    expect(best.weight).toBe(225)
    expect(best.reps).toBe(5)
  })

  it('ignores warm-ups entirely', () => {
    // a 315 warm-up single would otherwise be the best e1RM on record
    const withWarmup: HistoryEntry[] = [
      { date: '2026-06-10', kg: 225, sets: [{ w: 315, r: 1, warmup: true }, { w: 225, r: 5 }] },
    ]
    expect(bestE1RM(withWarmup)!.weight).toBe(225)
  })

  it('ignores sets above the rep cap rather than inventing a max', () => {
    const highRep: HistoryEntry[] = [{ date: '2026-06-10', kg: 95, sets: [{ w: 95, r: 20 }] }]
    expect(bestE1RM(highRep)).toBeNull()
  })

  it('can exclude a date, so today never competes with itself', () => {
    expect(bestE1RM(history, { excludeDate: '2026-06-10' })!.date).toBe('2026-01-10')
  })

  it('can restrict to a rolling window', () => {
    expect(bestE1RM(history, { sinceDate: '2026-03-01' })!.date).toBe('2026-06-10')
  })

  it('is null when there is nothing to measure', () => {
    expect(bestE1RM([])).toBeNull()
  })
})

describe('classifyPR', () => {
  const history = [session('2026-06-10', 225, [5, 5, 5])] // best e1RM 262.5
  const today = at('2026-09-18')

  it('fires an e1RM PR on a genuinely better set', () => {
    const pr = classifyPR(history, { weight: 245, reps: 3 }, today) // 269.5
    expect(pr.kind).toBe('e1rm')
    expect(pr.scope).toBe('all-time')
  })

  it('stays quiet when the set is worse by e1RM even at a heavier weight', () => {
    // 235x1 = 235 e1RM, well under 262.5 — but it IS a weight PR
    const pr = classifyPR(history, { weight: 235, reps: 1 }, today)
    expect(pr.kind).toBe('weight')
  })

  it('calls a same-weight-more-reps set a rep PR, not a celebration', () => {
    const flat = [session('2026-06-10', 225, [5, 5, 5])]
    const pr = classifyPR(flat, { weight: 225, reps: 6 }, today)
    // 225x6 = 270 e1RM, which beats 262.5 — so this is the stronger claim
    expect(pr.kind).toBe('e1rm')
  })

  it('reports a rep PR when e1RM is capped out of the running', () => {
    const highRep = [{ date: '2026-06-10', kg: 95, sets: [{ w: 95, r: 15 }] }]
    const pr = classifyPR(highRep, { weight: 95, reps: 18 }, today)
    expect(pr.kind).toBe('reps')
  })

  it('never lets a warm-up set a PR', () => {
    const pr = classifyPR(history, { weight: 315, reps: 5, warmup: true }, today)
    expect(pr.kind).toBeNull()
  })

  it('never lets a missed set take a PR', () => {
    const pr = classifyPR(history, { weight: 315, reps: 1, fail: true }, today)
    expect(pr.kind).toBeNull()
  })

  it('does not celebrate the very first session — nothing to beat yet', () => {
    const pr = classifyPR([], { weight: 225, reps: 5 }, today)
    expect(pr.kind).toBeNull()
  })

  it('finds a 12-month PR once the all-time best has aged out', () => {
    // a huge lift two years ago, a modest year since
    const long = [session('2024-01-10', 315, [5]), session('2026-02-10', 205, [5])]
    const pr = classifyPR(long, { weight: 225, reps: 5 }, today) // 262.5
    expect(pr.kind).toBe('e1rm')
    expect(pr.scope).toBe('12-month')
  })

  it('prefers the all-time scope when both are beaten', () => {
    const pr = classifyPR(history, { weight: 275, reps: 5 }, today)
    expect(pr.scope).toBe('all-time')
  })

  it('excludes today from the comparison', () => {
    const withToday = [...history, session('2026-09-18', 275, [5])]
    const pr = classifyPR(withToday, { weight: 245, reps: 3 }, today)
    expect(pr.kind).toBe('e1rm') // still beats June, not judged against today
  })

  it('uses a rolling window of a year', () => {
    expect(ROLLING_PR_DAYS).toBe(365)
  })
})

describe('nearMissCue', () => {
  const history = [session('2026-06-10', 225, [5, 5, 5])] // best e1RM 262.5
  const today = at('2026-09-18')

  it('speaks up when the prefill lands just under the best', () => {
    // 220x5 = 256.67, which is 5.83 under 262.5 — inside a 10 lb increment
    const cue = nearMissCue(history, { weight: 220, reps: 5 }, 10, today)
    expect(cue).toBe('5.8 lb under your best')
  })

  it('stays silent when the prefill already beats the best', () => {
    expect(nearMissCue(history, { weight: 245, reps: 5 }, 10, today)).toBeNull()
  })

  it('stays silent when the prefill is nowhere near', () => {
    expect(nearMissCue(history, { weight: 135, reps: 5 }, 5, today)).toBeNull()
  })

  it('stays silent with no history to be near', () => {
    expect(nearMissCue([], { weight: 225, reps: 5 }, 5, today)).toBeNull()
  })

  it('stays silent above the rep cap, where e1RM means nothing', () => {
    expect(nearMissCue(history, { weight: 135, reps: 20 }, 5, today)).toBeNull()
  })
})

/* ────────────────────────────────────────────────────────────────────
   e1RM is a reps_weight idea. Every other kind has its own unit, and a
   PR has to say which unit it is in.
   ──────────────────────────────────────────────────────────────────── */
const kindEntry = (date: string, kind: string, field: string, value: number): HistoryEntry => ({
  date, kg: 0, sets: [{ [field]: value, kind } as never],
})

describe('per-kind records', () => {
  const today = at('2026-09-18')

  it('a longer plank is a time PR, in seconds', () => {
    const history = [kindEntry('2026-06-10', 'time', 's', 60)]
    const pr = classifyPR(history, { kind: 'time', seconds: 75 }, today)
    expect(pr.kind).toBe('time')
    expect(pr.unit).toBe('s')
  })

  it('a shorter plank is not a PR', () => {
    const history = [kindEntry('2026-06-10', 'time', 's', 60)]
    expect(classifyPR(history, { kind: 'time', seconds: 45 }, today).kind).toBeNull()
  })

  it('a longer carry is a distance PR, in metres', () => {
    const history = [kindEntry('2026-06-10', 'distance', 'm', 40)]
    const pr = classifyPR(history, { kind: 'distance', metres: 60 }, today)
    expect(pr.kind).toBe('distance')
    expect(pr.unit).toBe('m')
  })

  it('more bodyweight reps is a rep PR', () => {
    const history = [kindEntry('2026-06-10', 'reps_only', 'r', 12)]
    const pr = classifyPR(history, { kind: 'reps_only', reps: 15 }, today)
    expect(pr.kind).toBe('reps')
    expect(pr.unit).toBe('reps')
  })

  it('never computes e1RM for a kind that has no load', () => {
    const history = [kindEntry('2026-06-10', 'time', 's', 60)]
    expect(classifyPR(history, { kind: 'time', seconds: 75 }, today).e1rm).toBeNull()
  })

  it('still labels a reps_weight record in pounds', () => {
    const history = [session('2026-06-10', 225, [5])]
    const pr = classifyPR(history, { weight: 245, reps: 3 }, today)
    expect(pr.kind).toBe('e1rm')
    expect(pr.unit).toBe('lb')
  })

  it('does not celebrate the first ever session of any kind', () => {
    expect(classifyPR([], { kind: 'time', seconds: 60 }, today).kind).toBeNull()
  })

  it('never lets a warm-up take a PR in any kind', () => {
    const history = [kindEntry('2026-06-10', 'time', 's', 60)]
    expect(classifyPR(history, { kind: 'time', seconds: 300, warmup: true }, today).kind).toBeNull()
  })
})

describe('assisted records run the other way', () => {
  const today = at('2026-09-18')
  const assisted = (date: string, help: number): HistoryEntry => ({
    date, kg: help, sets: [{ w: help, r: 8, assisted: true }],
  })

  it('LESS assistance is the record', () => {
    const history = [assisted('2026-06-10', 40)]
    const pr = classifyPR(history, { weight: 25, reps: 8, assisted: true }, today)
    expect(pr.kind).toBe('assist')
    expect(pr.unit).toBe('lb')
  })

  it('more assistance is not a record', () => {
    const history = [assisted('2026-06-10', 40)]
    expect(classifyPR(history, { weight: 55, reps: 8, assisted: true }, today).kind).toBeNull()
  })

  it('reaching zero assistance is a record', () => {
    const history = [assisted('2026-06-10', 20)]
    expect(classifyPR(history, { weight: 0, reps: 8, assisted: true }, today).kind).toBe('assist')
  })
})

/**
 * An Epley estimate off a barbell curl is a number, not a one-rep max.
 *
 * e1RM is the canonical record because it ranks 245x3 above 225x5 and
 * does not fire every session — that scarcity is the whole reason it
 * earns the celebration. Computing it for isolation work spends the
 * star on curls, which is precisely the inflation the e1RM-canonical
 * decision was made to stop.
 *
 * This is the per-exercise form of the ten-rep cap: both say the
 * estimate is not meaningful here, and both say it by having no
 * estimate rather than by suppressing a display.
 */
describe('e1RM only where e1RM means something', () => {
  /* Beats the best estimate AND the heaviest weight ever, so a record
     of SOME kind is certain — which is what makes the kind the claim. */
  const history = [session('2026-01-05', 100, [5, 5, 5])]
  const better = { weight: 105, reps: 5 }
  const now = at('2026-01-12')

  it('gives a compound lift the star', () => {
    expect(classifyPR(history, { ...better, e1rmValid: true }, now).kind).toBe('e1rm')
  })

  it('gives an isolation lift a weight PR and no star', () => {
    const pr = classifyPR(history, { ...better, e1rmValid: false }, now)
    expect(pr.kind).toBe('weight')
  })

  it('reports no estimate at all on a lift where it is meaningless', () => {
    /* Not merely a different kind — the number itself must not be
       handed out, or it reappears in whatever reads the field. */
    expect(classifyPR(history, { ...better, e1rmValid: false }, now).e1rm).toBeNull()
  })

  it('still lets an isolation lift set a rep record', () => {
    /* "Weight and rep PRs only" — the point is that the quiet records
       survive, not that the lift stops being tracked. */
    const pr = classifyPR(history, { weight: 100, reps: 8, e1rmValid: false }, now)
    expect(pr.kind).toBe('reps')
  })

  it('treats an absent flag as valid', () => {
    /* A custom lift the catalog has never heard of keeps its star.
       Absent field = safe default, and the safe default here is the
       behaviour every existing stored row already has. */
    expect(classifyPR(history, better, now).kind).toBe('e1rm')
  })

  it('does not hand out the celebration on a 12-month e1RM either', () => {
    /* The second door into the same claim. Blocking only the all-time
       branch would leave the star reachable through the rolling one. */
    const old = [session('2024-02-01', 200, [3]), session('2026-01-05', 100, [5])]
    const pr = classifyPR(old, { weight: 105, reps: 5, e1rmValid: false }, now)
    expect(pr.kind).not.toBe('e1rm')
  })
})

describe('history rows with holes in them', () => {
  /* The fifth module found with this defect, and the one that decides
     whether somebody gets a record. A null row in a lift's history threw
     on every read here — bestE1RM, classifyPR and the near-miss cue all
     go through the same eligibility check, and it reached straight
     through. */
  const solid = [session('2026-01-05', 200, [5, 5]), session('2026-01-12', 205, [5, 5])]

  it('sets a record past an empty row', () => {
    const rows = [null, ...solid] as never
    expect(() => classifyPR(rows, { weight: 225, reps: 5 }, at('2026-01-19'))).not.toThrow()
    expect(classifyPR(rows, { weight: 225, reps: 5 }, at('2026-01-19')).kind).toBe('e1rm')
  })

  it('reads the best estimate past an empty row', () => {
    expect(bestE1RM([null, ...solid] as never)?.weight).toBe(205)
  })

  it('reads it past a row with no date', () => {
    const rows = [{ ...session('2026-01-08', 300, [5]), date: undefined }, ...solid] as never
    expect(bestE1RM(rows)?.weight).toBe(205)
  })

  it('still finds nothing in a history that is only holes', () => {
    /* The control on the other side: stepping over everything is only
       correct when there is nothing else there. */
    expect(bestE1RM([null, null] as never)).toBeNull()
    expect(bestE1RM(solid)).not.toBeNull()
  })
})

/**
 * Records, pinned at their edges.
 *
 * 24 of 74 mutations survived here, and almost all of them were the
 * same comparison: `>` against `>=`. That difference is the whole
 * meaning of a record — MATCHING your best is not beating it, and a
 * celebration that fires on a tie fires most sessions and stops meaning
 * anything. The module this is about to be edited alongside decides
 * whether somebody gets a star, so its edges are the contract.
 */
const timed = (date: string, seconds: number): HistoryEntry =>
  ({ date, kg: 0, sets: [{ s: seconds, kind: 'time' }] } as never)
const ran = (date: string, metres: number): HistoryEntry =>
  ({ date, kg: 0, sets: [{ m: metres, kind: 'distance' }] } as never)
const repsOnly = (date: string, reps: number): HistoryEntry =>
  ({ date, kg: 0, sets: [{ r: reps, kind: 'reps_only' }] } as never)
const assisted = (date: string, help: number): HistoryEntry =>
  ({ date, kg: help, sets: [{ w: help, r: 5, assisted: true }] } as never)

describe('matching your best is not beating it', () => {
  const NOW = at('2026-09-22')

  it('a hold equal to the longest is not a record', () => {
    const h = [timed('2026-09-01', 60)]
    expect(classifyPR(h, { kind: 'time', seconds: 60 }, NOW).kind).toBeNull()
    expect(classifyPR(h, { kind: 'time', seconds: 61 }, NOW).kind).toBe('time')
  })

  it('a distance equal to the furthest is not a record', () => {
    const h = [ran('2026-09-01', 5000)]
    expect(classifyPR(h, { kind: 'distance', metres: 5000 }, NOW).kind).toBeNull()
    expect(classifyPR(h, { kind: 'distance', metres: 5001 }, NOW).kind).toBe('distance')
  })

  it('reps equal to the most is not a record', () => {
    const h = [repsOnly('2026-09-01', 20)]
    expect(classifyPR(h, { kind: 'reps_only', reps: 20 }, NOW).kind).toBeNull()
    expect(classifyPR(h, { kind: 'reps_only', reps: 21 }, NOW).kind).toBe('reps')
  })

  it('an estimate equal to the best is not a record', () => {
    const h = [session('2026-09-01', 200, [5, 5])]
    expect(classifyPR(h, { weight: 200, reps: 5 }, NOW).kind).toBeNull()
    expect(classifyPR(h, { weight: 205, reps: 5 }, NOW).kind).toBe('e1rm')
  })

  it('a weight equal to the heaviest is not a record', () => {
    /* Reached only when the estimate does not fire — above the rep cap,
       where there is no e1RM to beat. */
    const h = [session('2026-09-01', 200, [12])]
    expect(classifyPR(h, { weight: 200, reps: 12 }, NOW).kind).toBeNull()
    expect(classifyPR(h, { weight: 205, reps: 12 }, NOW).kind).toBe('weight')
  })

  it('the same reps at the same weight is not a record', () => {
    const h = [session('2026-09-01', 200, [12])]
    expect(classifyPR(h, { weight: 200, reps: 12 }, NOW).kind).toBeNull()
    expect(classifyPR(h, { weight: 200, reps: 13 }, NOW).kind).toBe('reps')
  })

  it('the same help as ever is not a record — less help is', () => {
    const h = [assisted('2026-09-01', 40)]
    expect(classifyPR(h, { weight: 40, reps: 5, assisted: true }, NOW).kind).toBeNull()
    expect(classifyPR(h, { weight: 35, reps: 5, assisted: true }, NOW).kind).toBe('assist')
    expect(classifyPR(h, { weight: 45, reps: 5, assisted: true }, NOW).kind).toBeNull()
  })
})

describe('a record needs something to beat', () => {
  const NOW = at('2026-09-22')

  it('does not celebrate the first hold ever logged', () => {
    /* `best > 0` — with no history there is no record to take, and
       calling a first session a PR makes every first session one. */
    expect(classifyPR([], { kind: 'time', seconds: 60 }, NOW).kind).toBeNull()
    expect(classifyPR([timed('2026-09-01', 30)], { kind: 'time', seconds: 60 }, NOW).kind).toBe('time')
  })

  it('does not celebrate the first run', () => {
    expect(classifyPR([], { kind: 'distance', metres: 5000 }, NOW).kind).toBeNull()
    expect(classifyPR([ran('2026-09-01', 1000)], { kind: 'distance', metres: 5000 }, NOW).kind).toBe('distance')
  })

  it('does not celebrate the first set of reps', () => {
    expect(classifyPR([], { kind: 'reps_only', reps: 20 }, NOW).kind).toBeNull()
    expect(classifyPR([repsOnly('2026-09-01', 10)], { kind: 'reps_only', reps: 20 }, NOW).kind).toBe('reps')
  })

  it('does not celebrate the first assisted set', () => {
    expect(classifyPR([], { weight: 40, reps: 5, assisted: true }, NOW).kind).toBeNull()
    expect(classifyPR([assisted('2026-09-01', 50)], { weight: 40, reps: 5, assisted: true }, NOW).kind)
      .toBe('assist')
  })
})

describe('the twelve-month record is its own scope', () => {
  const NOW = at('2026-09-22')

  it('marks a best-in-a-year even when the all-time is out of reach', () => {
    const h = [session('2020-01-01', 300, [5]), session('2026-08-01', 200, [5])]
    const pr = classifyPR(h, { weight: 210, reps: 5 }, NOW)
    expect(pr.kind).toBe('e1rm')
    expect(pr.scope).toBe('12-month')
  })

  it('does not mark one equal to the year’s best', () => {
    const h = [session('2020-01-01', 300, [5]), session('2026-08-01', 200, [5])]
    expect(classifyPR(h, { weight: 200, reps: 5 }, NOW).kind).toBeNull()
  })

  it('counts a session exactly at the edge of the window as inside it', () => {
    /* `entry.date < sinceDate` — the day the window opens is IN it, and
       moving that edge silently re-scopes every rolling record. */
    const edge = new Date(NOW - ROLLING_PR_DAYS * 86_400_000)
    const p = (n: number) => String(n).padStart(2, '0')
    const edgeDay = `${edge.getFullYear()}-${p(edge.getMonth() + 1)}-${p(edge.getDate())}`
    const h = [session('2020-01-01', 300, [5]), session(edgeDay, 250, [5])]
    /* 240 beats the all-time? No — 300 stands. And inside the window
       the 250 stands too, so nothing fires. */
    expect(classifyPR(h, { weight: 240, reps: 5 }, NOW).kind).toBeNull()
  })
})

describe('the near-miss cue', () => {
  const NOW = at('2026-09-22')
  const h = [session('2026-09-01', 200, [5])]

  it('speaks when the prefill lands just under the best', () => {
    expect(nearMissCue(h, { weight: 197, reps: 5 }, 5, NOW)).toMatch(/under your best/)
  })

  it('says nothing when the prefill would BEAT the best', () => {
    /* A deficit of zero or less is not a near miss, it is a record
       about to happen — and the cue would read as discouragement. */
    expect(nearMissCue(h, { weight: 200, reps: 5 }, 5, NOW)).toBeNull()
    expect(nearMissCue(h, { weight: 205, reps: 5 }, 5, NOW)).toBeNull()
  })

  it('says nothing when the gap is wider than one increment', () => {
    expect(nearMissCue(h, { weight: 150, reps: 5 }, 5, NOW)).toBeNull()
  })

  it('treats a gap exactly one increment wide as near', () => {
    /* The window edge: `deficit > window` excludes, so equal is in. */
    const best = 200 * (1 + 5 / 30)
    const target = best - 5
    const weight = target / (1 + 5 / 30)
    expect(nearMissCue(h, { weight, reps: 5 }, 5, NOW)).toMatch(/under your best/)
  })

  it('says nothing when the prefill has no estimate at all', () => {
    expect(nearMissCue(h, { weight: 200, reps: 30 }, 5, NOW)).toBeNull()
    expect(nearMissCue(h, { weight: 197, reps: 5 }, 5, NOW)).toMatch(/under/)
  })
})

describe('what counts toward a record at all', () => {
  const NOW = at('2026-09-22')

  it('ignores an assisted set when reading the heaviest', () => {
    /* Assistance is not load. Counting 40 lb of help as 40 lb lifted
       would make every assisted set a weight record on a new lift. */
    const h = [assisted('2026-09-01', 40)]
    expect(bestE1RM(h)).toBeNull()
  })

  it('reads an unassisted set normally', () => {
    expect(bestE1RM([session('2026-09-01', 200, [5])])?.weight).toBe(200)
  })

  it('takes the best estimate in a session, not the last', () => {
    const ramped = { date: '2026-09-01', kg: 225, sets: [{ w: 135, r: 5 }, { w: 225, r: 5 }, { w: 95, r: 8 }] }
    expect(bestE1RM([ramped as never])?.weight).toBe(225)
  })

  it('counts reps at the SAME weight, not at any weight', () => {
    /* bestRepsAtWeight compares `set.w === weight`. Matching loosely
       would measure today's eight reps at 200 against twelve at 100. */
    /* Above the rep cap so no estimate fires and the reps branch is
       actually reached. bestRepsAtWeight(200) is 5; a loose match would
       read the twelve done at 100 and refuse the record. */
    const h = [session('2026-09-01', 100, [12]), session('2026-09-02', 200, [5])]
    expect(classifyPR(h, { weight: 200, reps: 12 }, NOW).kind).toBe('reps')
  })
})

/* ------------------------------------------------------------------ *
 * PR SCOPE — the decided behaviour, not the current one.
 * See docs/two-a-day-decisions.md.
 * ------------------------------------------------------------------ */
describe('records are chronological, not day-scoped', () => {
  const NOW = at('2026-09-22')

  it.fails('measures the evening against the morning of the same day', () => {
    /* DECIDED: a record is "better than anything before it". classifyPR
       excludes the whole of today from the baseline, so an evening lift
       LIGHTER than the morning still scores — a record the athlete
       already beat at breakfast.
       Wrong today, deliberately. */
    const h = [session('2026-09-15', 135, [5]), session('2026-09-22', 245, [5])]
    expect(classifyPR(h, { weight: 230, reps: 5 }, NOW).kind).toBeNull()
  })

  it('still lets the evening take a record it genuinely beat', () => {
    /* NOT .fails: this half already holds, and it is what makes the
       assertion above a SCOPE question rather than a broken module.
       Chronological means the morning counts, not that the evening is
       excluded — so a genuine beat must keep scoring after the fix. */
    const h = [session('2026-09-15', 135, [5]), session('2026-09-22', 200, [5])]
    expect(classifyPR(h, { weight: 250, reps: 5 }, NOW).kind).toBe('e1rm')
  })

  it('CONTROL: a prior DAY is already counted today', () => {
    /* Not .fails — this works now, and must keep working. It is what
       makes the two above a scope question rather than a broken module. */
    const h = [session('2026-09-15', 200, [5])]
    expect(classifyPR(h, { weight: 190, reps: 5 }, NOW).kind).toBeNull()
    expect(classifyPR(h, { weight: 210, reps: 5 }, NOW).kind).toBe('e1rm')
  })
})

describe('the edges that were still unpinned', () => {
  const NOW = at('2026-09-22')

  it('refuses an estimate from a number that is not one', () => {
    /* Both halves of the finiteness check, independently: a NaN weight
       with sound reps must still produce null rather than NaN, or the
       NaN travels into every comparison downstream and loses silently. */
    expect(epley1RM(Number.NaN, 5)).toBeNull()
    expect(epley1RM(200, Number.NaN)).toBeNull()
    expect(epley1RM(200, 5)).toBeCloseTo(200 * (1 + 5 / 30), 5)
  })

  it('treats a gap of exactly one increment as a near miss', () => {
    /* Exact by construction: a single rep makes the estimate the weight
       itself, so the deficit is 5 with no floating point in the way. */
    const h = [session('2026-09-01', 200, [1])]
    expect(nearMissCue(h, { weight: 195, reps: 1 }, 5, NOW)).toMatch(/5 lb under your best/)
    expect(nearMissCue(h, { weight: 194, reps: 1 }, 5, NOW)).toBeNull()
  })

  it('counts a session on the first day of the rolling window', () => {
    /* `entry.date < sinceDate` excludes; the edge day itself is IN.
       Moving that boundary drops a whole day out of every 12-month
       record, and the day it drops is the oldest one that still counts. */
    const edge = new Date(NOW - ROLLING_PR_DAYS * 86_400_000)
    const p = (n: number) => String(n).padStart(2, '0')
    const edgeDay = `${edge.getFullYear()}-${p(edge.getMonth() + 1)}-${p(edge.getDate())}`
    const h = [session('2019-01-01', 300, [1]), session(edgeDay, 250, [1])]
    const pr = classifyPR(h, { weight: 260, reps: 1 }, NOW)
    expect(pr.kind).toBe('e1rm')
    expect(pr.scope).toBe('12-month')
  })

  it('reads assistance only from assisted sets', () => {
    /* leastAssistance walks every set. Without the assisted check a
       LIGHT ordinary set reads as very little help, and the athlete can
       then never beat their own "record" of ten pounds of assistance
       that nobody ever used. */
    const mixed = {
      date: '2026-09-01', kg: 40,
      sets: [{ w: 40, r: 5, assisted: true }, { w: 10, r: 5 }],
    } as never
    expect(classifyPR([mixed], { weight: 35, reps: 5, assisted: true }, NOW).kind).toBe('assist')
  })
})
