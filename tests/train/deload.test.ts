import { describe, it, expect } from 'vitest'
import {
  DELOAD_HOLD_SESSIONS,
  RECOVERY_FLOOR,
  HIGH_RPE,
  isExcluded,
  detectPlateau,
  nextDeloadState,
  deloadPlan,
  limitDeloads,
} from '../../lib/train/deload'
import type { DeloadRecord } from '../../lib/train/deload'
import type { HistoryEntry } from '../../lib/train/sets'

const session = (date: string, w: number, reps = 5, sets = 3): HistoryEntry => ({
  date,
  kg: w,
  sets: Array.from({ length: sets }, () => ({ w, r: reps })),
})

/** Four sessions stuck at the same weight and reps. */
const stalled: HistoryEntry[] = [
  session('2026-08-20', 185),
  session('2026-08-27', 185),
  session('2026-09-03', 185),
  session('2026-09-10', 185),
]

const ctx = (over: Partial<Parameters<typeof nextDeloadState>[1]> = {}) => ({
  history: stalled,
  today: '2026-09-17',
  recovery: null as number | null,
  rpe: null as number | null,
  excluded: [] as Array<{ from: string; to: string }>,
  ...over,
})

describe('isExcluded', () => {
  const windows = [{ from: '2026-09-01', to: '2026-09-07' }]

  it('covers the whole window inclusively', () => {
    expect(isExcluded('2026-09-01', windows)).toBe(true)
    expect(isExcluded('2026-09-04', windows)).toBe(true)
    expect(isExcluded('2026-09-07', windows)).toBe(true)
  })

  it('leaves dates outside it alone', () => {
    expect(isExcluded('2026-08-31', windows)).toBe(false)
    expect(isExcluded('2026-09-08', windows)).toBe(false)
  })

  it('is false with no windows', () => {
    expect(isExcluded('2026-09-04', [])).toBe(false)
  })
})

describe('detectPlateau', () => {
  it('sees weight and reps flat across the window', () => {
    expect(detectPlateau(stalled)).not.toBeNull()
  })

  it('needs more than the window itself, so a first few sessions never stall', () => {
    expect(detectPlateau(stalled.slice(0, 3))).toBeNull()
  })

  it('is not a plateau when the weight is still climbing', () => {
    const climbing = [
      session('2026-08-20', 175),
      session('2026-08-27', 180),
      session('2026-09-03', 185),
      session('2026-09-10', 190),
    ]
    expect(detectPlateau(climbing)).toBeNull()
  })

  it('is not a plateau when reps are climbing at the same weight', () => {
    const repsUp = [
      session('2026-08-20', 185, 5),
      session('2026-08-27', 185, 6),
      session('2026-09-03', 185, 7),
      session('2026-09-10', 185, 8),
    ]
    expect(detectPlateau(repsUp)).toBeNull()
  })

  it('ignores warm-ups when reading the working weight', () => {
    const withWarmups: HistoryEntry[] = stalled.map((e) => ({
      ...e,
      sets: [{ w: 315, r: 1, warmup: true }, ...(e.sets || [])],
    }))
    expect(detectPlateau(withWarmups)).not.toBeNull()
  })

  it('skips an excluded stretch — the escape hatch', () => {
    // sick for two weeks in the middle; without excluding it, the flat
    // stretch reads as a plateau
    const windows = [{ from: '2026-08-25', to: '2026-09-08' }]
    expect(detectPlateau(stalled, { excluded: windows })).toBeNull()
  })
})

describe('nextDeloadState — the walk', () => {
  it('flags a plateau before acting on it', () => {
    const r = nextDeloadState(null, ctx())
    expect(r.state).toBe('flagged')
    expect(r.priorWeight).toBe(185)
  })

  it('goes from flagged into deloading while the plateau persists', () => {
    const flagged = nextDeloadState(null, ctx())
    const r = nextDeloadState(flagged, ctx({ today: '2026-09-18' }))
    expect(r.state).toBe('deloading')
  })

  it('returns to normal from flagged if the stall broke on its own', () => {
    const flagged = nextDeloadState(null, ctx())
    const progressing = [...stalled, session('2026-09-17', 190)]
    const r = nextDeloadState(flagged, ctx({ history: progressing, today: '2026-09-18' }))
    expect(r.state).toBe('normal')
  })

  it('holds the deload for a set number of sessions', () => {
    let r: DeloadRecord = { state: 'deloading', kind: 'intensity', priorWeight: 185, since: '2026-09-18', sessions: 0, confidence: 'measured' }
    for (let i = 1; i < DELOAD_HOLD_SESSIONS; i++) {
      r = nextDeloadState(r, ctx({ today: '2026-09-19', sessionLogged: true }))
      expect(r.state).toBe('deloading')
    }
    r = nextDeloadState(r, ctx({ today: '2026-09-20', sessionLogged: true }))
    expect(r.state).toBe('reapproach')
  })

  it('finishes re-approach back at normal', () => {
    const reapproach: DeloadRecord = { state: 'reapproach', kind: 'intensity', priorWeight: 185, since: '2026-09-20', sessions: 0, confidence: 'measured' }
    const r = nextDeloadState(reapproach, ctx({ today: '2026-09-22', sessionLogged: true }))
    expect(r.state).toBe('normal')
  })

  it('does not re-flag immediately after finishing — no instant loop', () => {
    const justFinished: DeloadRecord = { state: 'normal', kind: null, priorWeight: 185, since: '2026-09-22', sessions: 0, confidence: 'measured', cooldownUntil: '2026-10-06' }
    const r = nextDeloadState(justFinished, ctx({ today: '2026-09-24' }))
    expect(r.state).toBe('normal')
  })
})

describe('nextDeloadState — diagnosis', () => {
  it('cuts volume when recovery is the problem', () => {
    const r = nextDeloadState(null, ctx({ recovery: 40 }))
    expect(r.kind).toBe('volume')
  })

  it('cuts intensity when recovery is fine but the lifter is grinding', () => {
    const r = nextDeloadState(null, ctx({ recovery: 80, rpe: HIGH_RPE + 0.5 }))
    expect(r.kind).toBe('intensity')
  })

  it('treats recovery above the floor as not-a-recovery-problem', () => {
    const r = nextDeloadState(null, ctx({ recovery: RECOVERY_FLOOR + 10, rpe: 9.5 }))
    expect(r.kind).toBe('intensity')
  })

  it('marks a deload inferred when there is no recovery or RPE data at all', () => {
    const r = nextDeloadState(null, ctx())
    expect(r.confidence).toBe('inferred')
    expect(r.kind).toBe('intensity')
  })

  it('marks it measured when real signal drove it', () => {
    expect(nextDeloadState(null, ctx({ recovery: 40 })).confidence).toBe('measured')
  })
})

describe('deloadPlan', () => {
  const rec = (over: Partial<DeloadRecord>): DeloadRecord => ({
    state: 'deloading', kind: 'intensity', priorWeight: 200,
    since: '2026-09-18', sessions: 0, confidence: 'measured', ...over,
  })

  it('cuts weight for an intensity deload and leaves sets alone', () => {
    const plan = deloadPlan(rec({ kind: 'intensity' }))
    expect(plan.weight).toBe(180)
    expect(plan.setsFactor).toBe(1)
  })

  it('cuts sets for a volume deload and leaves the weight alone', () => {
    const plan = deloadPlan(rec({ kind: 'volume' }))
    expect(plan.weight).toBe(200)
    expect(plan.setsFactor).toBeLessThan(1)
  })

  it('is gentler when the deload was only inferred', () => {
    const measured = deloadPlan(rec({ kind: 'intensity', confidence: 'measured' }))
    const inferred = deloadPlan(rec({ kind: 'intensity', confidence: 'inferred' }))
    expect(inferred.weight!).toBeGreaterThan(measured.weight!)
  })

  it('re-approaches just under the prior working weight', () => {
    const plan = deloadPlan(rec({ state: 'reapproach' }))
    expect(plan.weight).toBe(190)
  })

  it('leaves everything alone in normal and flagged', () => {
    expect(deloadPlan(rec({ state: 'normal' })).weight).toBeNull()
    expect(deloadPlan(rec({ state: 'flagged' })).weight).toBeNull()
  })
})

describe('limitDeloads', () => {
  const cand = (id: string, weight: number, length: number) => ({ id, weight, plateauLength: length })

  it('never drops more than two lifts at once', () => {
    const picked = limitDeloads([cand('a', 200, 5), cand('b', 150, 4), cand('c', 100, 6), cand('d', 300, 3)])
    expect(picked).toHaveLength(2)
  })

  it('picks the longest-running stalls first', () => {
    const picked = limitDeloads([cand('a', 200, 3), cand('b', 150, 8), cand('c', 100, 6)])
    expect(picked).toEqual(['b', 'c'])
  })

  it('breaks a tie on the heavier lift, where a stall costs most', () => {
    const picked = limitDeloads([cand('a', 100, 5), cand('b', 300, 5), cand('c', 200, 5)])
    expect(picked[0]).toBe('b')
  })

  it('passes through when there is nothing to limit', () => {
    expect(limitDeloads([])).toEqual([])
    expect(limitDeloads([cand('a', 100, 4)])).toEqual(['a'])
  })

  it('honours a caller-supplied maximum', () => {
    expect(limitDeloads([cand('a', 1, 9), cand('b', 1, 8), cand('c', 1, 7)], 1)).toEqual(['a'])
  })
})

/* ────────────────────────────────────────────────────────────────────
   RPE is what separates a programming stall from a fatigue stall. The
   same flat weights and reps mean opposite things at RPE 7 and RPE 10.
   ──────────────────────────────────────────────────────────────────── */
const rpeSession = (date: string, w: number, rpe: number | null, reps = 5, sets = 3): HistoryEntry => ({
  date,
  kg: w,
  sets: Array.from({ length: sets }, () => ({ w, r: reps, ...(rpe == null ? {} : { rpe }) })),
})

describe('plateau cause from RPE', () => {
  const flat = (rpes: Array<number | null>) =>
    ['2026-08-20', '2026-08-27', '2026-09-03', '2026-09-10'].map((d, i) => rpeSession(d, 185, rpes[i]))

  it('reads rising RPE at a flat load as fatigue', () => {
    const p = detectPlateau(flat([7, 8, 9, 9.5]))
    expect(p!.cause).toBe('fatigue')
  })

  it('reads steady low RPE at a flat load as a programming stall', () => {
    const p = detectPlateau(flat([7, 7, 7, 7]))
    expect(p!.cause).toBe('programming')
  })

  it('reads steady high RPE as fatigue — grinding every session', () => {
    const p = detectPlateau(flat([9.5, 9.5, 9.5, 9.5]))
    expect(p!.cause).toBe('fatigue')
  })

  it('says unknown when RPE was never logged', () => {
    const p = detectPlateau(flat([null, null, null, null]))
    expect(p!.cause).toBe('unknown')
  })

  it('says unknown on a single data point — a trend needs two', () => {
    const p = detectPlateau(flat([null, null, null, 9]))
    expect(p!.cause).toBe('unknown')
  })

  it('never takes RPE from a warm-up', () => {
    const warmOnly: HistoryEntry[] = ['2026-08-20', '2026-08-27', '2026-09-03', '2026-09-10'].map((d) => ({
      date: d, kg: 185,
      sets: [{ w: 95, r: 5, rpe: 10, warmup: true }, { w: 185, r: 5 }],
    }))
    expect(detectPlateau(warmOnly)!.cause).toBe('unknown')
  })

  it('produces different causes from otherwise identical histories', () => {
    const tired = detectPlateau(flat([7, 8.5, 9.5, 10]))!
    const bored = detectPlateau(flat([7, 7, 7, 7]))!
    expect(tired.weight).toBe(bored.weight)
    expect(tired.sessions).toBe(bored.sessions)
    expect(tired.cause).not.toBe(bored.cause)
  })
})

describe('RPE drives the deload diagnosis', () => {
  const flat = (rpes: number[]) =>
    ['2026-08-20', '2026-08-27', '2026-09-03', '2026-09-10'].map((d, i) => rpeSession(d, 185, rpes[i]))

  const walk = (history: HistoryEntry[], over = {}) => {
    const base = { history, today: '2026-09-17', recovery: null as number | null, rpe: null as number | null, excluded: [], ...over }
    const flagged = nextDeloadState(null, base)
    return nextDeloadState(flagged, { ...base, today: '2026-09-18' })
  }

  it('cuts intensity when the lifter is grinding', () => {
    const r = walk(flat([7, 8.5, 9.5, 10]), { rpe: 9.5 })
    expect(r.kind).toBe('intensity')
    expect(r.confidence).toBe('measured')
  })

  it('does not deload a programming stall at all — the answer is more, not less', () => {
    const r = walk(flat([7, 7, 7, 7]), { rpe: 7 })
    expect(r.state).toBe('normal')
  })

  it('still prefers a recovery signal when there is one', () => {
    const r = walk(flat([7, 8.5, 9.5, 10]), { rpe: 9.5, recovery: 40 })
    expect(r.kind).toBe('volume')
  })

  it('gives identical histories opposite plans on RPE alone', () => {
    const grinding = deloadPlan(walk(flat([7, 8.5, 9.5, 10]), { rpe: 9.5 }))
    const coasting = walk(flat([7, 7, 7, 7]), { rpe: 7 })
    expect(grinding.weight).toBeLessThan(185)
    expect(coasting.state).toBe('normal')
    expect(deloadPlan(coasting).weight).toBeNull()
  })

  it('behaves exactly as before for a history with no RPE at all', () => {
    const r = walk(flat([]).map((e) => ({ ...e, sets: (e.sets || []).map(({ rpe, ...rest }) => rest) })))
    expect(r.state).toBe('deloading')
    expect(r.confidence).toBe('inferred')
    expect(r.kind).toBe('intensity')
  })
})
