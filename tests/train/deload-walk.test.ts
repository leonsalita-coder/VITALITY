import { describe, it, expect } from 'vitest'
import {
  nextDeloadState, deloadPlan, detectPlateau,
  DELOAD_HOLD_SESSIONS, RECOVERY_FLOOR, HIGH_RPE,
  type DeloadRecord, type DeloadContext,
} from '../../lib/train/deload'
import { suggestTarget } from '../../lib/train/progression'
import type { HistoryEntry } from '../../lib/train/sets'

/**
 * The state machine, walked end to end — and every transition that
 * should NOT fire.
 *
 * The negative cases were weaker than the positive ones across the whole
 * machine: a reapproach record with no prior weight was reported as
 * undescribable for the wrong reason, because it fell through to a later
 * check rather than being caught by its own. A machine is only correct if
 * it refuses the wrong moves as reliably as it makes the right ones.
 */

const day = (n: number) => `2026-09-${String(n).padStart(2, '0')}`
const session = (date: string, w: number, reps = 5, sets = 3, over: Record<string, unknown> = {}): HistoryEntry =>
  ({ date, kg: w, sets: Array.from({ length: sets }, () => ({ w, r: reps })), ...over })

/** Four sessions stuck at the same weight and reps. */
const stalled = [session('2026-08-20', 185), session('2026-08-27', 185),
  session('2026-09-03', 185), session('2026-09-10', 185)]

/**
 * Stalled at a comfortable, steady effort.
 *
 * The cause is read from the RPE recorded on the SETS, not from the
 * context — flat weight at RPE 6 and flat weight at RPE 10 are the same
 * chart and opposite problems. Two readings are the minimum for a trend;
 * one is 'unknown', which still flags.
 */
const comfortable = stalled.map((e) => ({
  ...e, sets: e.sets!.map((x) => ({ ...x, rpe: 6 })),
}))

/** Climbing — no stall to treat. */
const climbing = [session('2026-08-20', 175), session('2026-08-27', 180),
  session('2026-09-03', 185), session('2026-09-10', 190)]

const ctx = (over: Partial<DeloadContext> = {}): DeloadContext => ({
  history: stalled, today: '2026-09-17', recovery: 40, rpe: HIGH_RPE, ...over,
})

const record = (over: Partial<DeloadRecord> = {}): DeloadRecord => ({
  state: 'normal', kind: null, priorWeight: 185, since: '2026-09-01',
  sessions: 0, confidence: 'measured', ...over,
})

describe('the fixtures themselves', () => {
  it('has a history that really is a plateau', () => {
    expect(detectPlateau(stalled)).not.toBeNull()
  })

  it('has a history that really is not', () => {
    /* Without this the negative cases below pass because nothing ever
       flags, not because the machine refused. */
    expect(detectPlateau(climbing)).toBeNull()
  })
})

describe('normal — the moves it makes', () => {
  it('flags a stall with evidence behind it', () => {
    const next = nextDeloadState(record(), ctx())
    expect(next.state).toBe('flagged')
    expect(next.priorWeight).toBeGreaterThan(0)
  })

  it('records what it thinks is wrong at the moment it flags', () => {
    /* A flagged record already carries a diagnosis, so the card can say
       something before anything is acted on. */
    const next = nextDeloadState(record(), ctx())
    expect(next.kind).toBeTruthy()
    expect(next.confidence).toBeTruthy()
  })
})

describe('normal — the moves it refuses', () => {
  it('stays put with no stall', () => {
    expect(nextDeloadState(record(), ctx({ history: climbing })).state).toBe('normal')
  })

  it('stays put inside the cooldown after a previous deload', () => {
    /* Otherwise the machine oscillates instead of resolving. */
    const next = nextDeloadState(record({ cooldownUntil: '2026-09-30' }), ctx())
    expect(next.state).toBe('normal')
  })

  it('acts again once the cooldown has passed', () => {
    /* The control: the refusal above is the cooldown, not a record that
       can never flag again. */
    const next = nextDeloadState(record({ cooldownUntil: '2026-09-10' }), ctx())
    expect(next.state).toBe('flagged')
  })

  it('stays put when the stall is a programming problem', () => {
    /* Comfortable RPE at a flat load is capacity going unused. Deloading
       removes stimulus they are already short of. */
    const next = nextDeloadState(record(), ctx({ history: comfortable, recovery: 90, rpe: 6 }))
    expect(next.state).toBe('normal')
  })

  it('flags the same stall when the effort is high instead', () => {
    /* The control: the refusal above is the diagnosis, not a history
       that never flags. Same weights, same dates, harder sets. */
    const grinding = stalled.map((e) => ({ ...e, sets: e.sets!.map((x) => ({ ...x, rpe: 9.5 })) }))
    expect(nextDeloadState(record(), ctx({ history: grinding })).state).toBe('flagged')
  })
})

describe('flagged — watch one more session, then act', () => {
  it('begins the deload when the stall is still there', () => {
    const next = nextDeloadState(record({ state: 'flagged' }), ctx())
    expect(next.state).toBe('deloading')
    expect(next.sessions).toBe(0)
  })

  it('returns to normal when the stall broke on its own', () => {
    const next = nextDeloadState(record({ state: 'flagged' }), ctx({ history: climbing }))
    expect(next.state).toBe('normal')
    expect(next.kind).toBeNull()
    /* The control: the same flagged record with the stall still there
       goes the other way, so the reset above is the stall breaking and
       not a state that always clears. */
    expect(nextDeloadState(record({ state: 'flagged' }), ctx()).state).toMatch(/^deloading$/)
  })
})

describe('deloading — holds for its full duration', () => {
  it('does not count a day with no session logged', () => {
    /* The hold is measured in sessions, not in days. Without this, time
       passing would end a deload nobody trained through. */
    const next = nextDeloadState(record({ state: 'deloading', sessions: 0 }), ctx({ sessionLogged: false }))
    expect(next.state).toBe('deloading')
    expect(next.sessions).toBe(0)
  })

  it('counts a session that was logged', () => {
    const next = nextDeloadState(record({ state: 'deloading', sessions: 0 }), ctx({ sessionLogged: true }))
    expect(next.state).toBe('deloading')
    expect(next.sessions).toBe(1)
  })

  it('holds right up to the last session of the hold', () => {
    const next = nextDeloadState(
      record({ state: 'deloading', sessions: DELOAD_HOLD_SESSIONS - 2 }), ctx({ sessionLogged: true }))
    expect(next.state).toBe('deloading')
  })

  it('moves to reapproach once the hold is served', () => {
    const next = nextDeloadState(
      record({ state: 'deloading', sessions: DELOAD_HOLD_SESSIONS - 1 }), ctx({ sessionLogged: true }))
    expect(next.state).toBe('reapproach')
    expect(next.sessions).toBe(0)
  })

  it('is not interrupted by the stall breaking mid-hold', () => {
    /* The stall breaking IS the deload working. Ending early would undo
       it one session later, which is the whole reason it has a duration. */
    const next = nextDeloadState(
      record({ state: 'deloading', sessions: 0 }), ctx({ history: climbing, sessionLogged: true }))
    expect(next.state).toBe('deloading')
  })
})

describe('reapproach — eases out once, then stops', () => {
  it('waits for a session before resolving', () => {
    const next = nextDeloadState(record({ state: 'reapproach' }), ctx({ sessionLogged: false }))
    expect(next.state).toBe('reapproach')
  })

  it('returns to normal after one', () => {
    const next = nextDeloadState(record({ state: 'reapproach' }), ctx({ sessionLogged: true }))
    expect(next.state).toBe('normal')
    expect(next.kind).toBeNull()
    /* The control: without a session logged it stays put, so the
       resolution above is the session and not the passage of time. */
    expect(nextDeloadState(record({ state: 'reapproach' }), ctx({ sessionLogged: false })).state)
      .toMatch(/^reapproach$/)
  })

  it('sets a cooldown so it cannot immediately re-flag', () => {
    const next = nextDeloadState(record({ state: 'reapproach' }), ctx({ sessionLogged: true }))
    expect(next.cooldownUntil).toBeTruthy()
    expect(next.cooldownUntil! > '2026-09-17').toBe(true)
  })

  it('and that cooldown actually holds on the next evaluation', () => {
    /* The walk closed: out of a deload and straight back into one is the
       oscillation the cooldown exists to prevent. */
    const resolved = nextDeloadState(record({ state: 'reapproach' }), ctx({ sessionLogged: true }))
    expect(nextDeloadState(resolved, ctx()).state).toBe('normal')
  })
})

describe('the whole walk, in order', () => {
  it('goes normal → flagged → deloading → reapproach → normal and no further', () => {
    const seen: string[] = []
    let r = record()
    const step = (over: Partial<DeloadContext> = {}) => {
      r = nextDeloadState(r, ctx({ sessionLogged: true, ...over }))
      seen.push(r.state)
    }
    step(); step()
    for (let i = 0; i < DELOAD_HOLD_SESSIONS; i++) step()
    step(); step()
    expect(seen[0]).toBe('flagged')
    expect(seen[1]).toBe('deloading')
    expect(seen).toContain('reapproach')
    expect(seen[seen.length - 1]).toBe('normal')
    /* And it settles: the cooldown stops it walking straight back in. */
    expect(seen[seen.length - 2]).toBe('normal')
  })
})

/* ================================================================== *
 * Three mechanisms, one suggestion
 * ================================================================== */

/**
 * A deload, a layoff ramp and the self-correction cap can each modify a
 * weight, and nothing had proven what happens when two apply at once.
 *
 * The order is stated in the source: deload outranks everything, because
 * it is an instruction already recorded and progression must not be able
 * to undo it one session later. Layoff comes next, because time away
 * explains everything else on the first session back. The damping cap is
 * not a competitor — it can only ever make a step smaller.
 */
describe('when more than one mechanism applies', () => {
  const NOW = new Date(2026, 8, 20, 12).getTime()
  const d = (back: number) => {
    const x = new Date(2026, 8, 20 - back)
    const p = (n: number) => String(n).padStart(2, '0')
    return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`
  }
  const hist = (backs: number[], w: number): HistoryEntry[] =>
    backs.map((b) => ({ date: d(b), kg: w, sets: [{ w, r: 5 }, { w, r: 5 }, { w, r: 5 }] }))

  const live = { state: 'deloading', kind: 'intensity', priorWeight: 200,
    since: d(3), sessions: 0, confidence: 'measured' } as DeloadRecord

  it('lets the deload win over a layoff', () => {
    /* Both apply: a long break AND a recorded deload. The deload is an
       instruction already given; the ramp is an inference. */
    const s = suggestTarget(hist([60, 45], 200),
      { id: 'squat', kg: 200, reps: 5, sets: 3, deload: live } as never, NOW)
    expect(s.basis).toBe('deload')
  })

  it('holds the deloaded weight rather than the ramp weight', () => {
    const withDeload = suggestTarget(hist([60, 45], 200),
      { id: 'squat', kg: 200, reps: 5, sets: 3, deload: live } as never, NOW).weight!
    const planned = deloadPlan(live)!.weight!
    expect(Math.abs(withDeload - planned)).toBeLessThanOrEqual(5)
  })

  it('falls back to the ramp when the deload record cannot describe itself', () => {
    /* The precedence is not unconditional: a record with no prior weight
       names no weight, so the layoff — which can — takes over. */
    const broken = { state: 'deloading', kind: 'intensity', since: d(3) } as unknown as DeloadRecord
    const s = suggestTarget(hist([60, 45], 200),
      { id: 'squat', kg: 200, reps: 5, sets: 3, deload: broken } as never, NOW)
    expect(s.basis).toBe('layoff')
    expect(s.reason).not.toContain('NaN')
  })

  it('never lets the cap turn a step into a cut', () => {
    /* The cap only ever shrinks a step. A lifter missing most of what
       they are handed should get a smaller jump, never a reduction. */
    const clean = hist([14, 7], 185)
    const capped = suggestTarget(clean,
      { id: 'bench', kg: 185, reps: 5, sets: 3, damping: { maxMultiplier: 1, reason: 'x' } } as never, NOW)
    expect(capped.weight!).toBeGreaterThanOrEqual(185)
  })

  it('caps a double step back to a single one', () => {
    /* An easy RPE buys a double jump; the cap takes it away. */
    const easy = hist([14, 7], 185)
    easy[1].sets = easy[1].sets!.map((x) => ({ ...x, rpe: 6 }))
    const free = suggestTarget(easy, { id: 'bench', kg: 185, reps: 5, sets: 3 } as never, NOW).weight!
    const capped = suggestTarget(easy,
      { id: 'bench', kg: 185, reps: 5, sets: 3, damping: { maxMultiplier: 1, reason: 'x' } } as never, NOW).weight!
    expect(free).toBeGreaterThan(capped)
    expect(capped).toBeGreaterThan(185)
  })

  it('leaves a deload alone no matter what the cap says', () => {
    /* The cap applies to a step. A deload is not a step. */
    const withCap = suggestTarget(hist([14, 7], 200),
      { id: 'squat', kg: 200, reps: 5, sets: 3, deload: live,
        damping: { maxMultiplier: 1, reason: 'x' } } as never, NOW)
    expect(withCap.basis).toBe('deload')
    expect(withCap.weight!).toBeLessThan(200)
  })

  it('leaves a layoff ramp alone no matter what the cap says', () => {
    const withCap = suggestTarget(hist([60, 45], 200),
      { id: 'squat', kg: 200, reps: 5, sets: 3,
        damping: { maxMultiplier: 1, reason: 'x' } } as never, NOW)
    expect(withCap.basis).toBe('layoff')
    expect(withCap.weight!).toBeLessThan(200)
  })
})
