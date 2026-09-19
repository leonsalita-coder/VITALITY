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
