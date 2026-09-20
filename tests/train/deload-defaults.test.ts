import { describe, it, expect } from 'vitest'
import { deloadPlan, deloadDescribable, type DeloadRecord } from '../../lib/train/deload'
import { suggestTarget } from '../../lib/train/progression'

/**
 * A stored record written by an older engine is what a migration hands
 * you eventually.
 *
 * Three fields were read with no default — sessions, priorWeight and
 * confidence — and a record missing any of them rendered "deload, NaN of
 * 2" or "holding NaN lb" straight onto the card. That is worse than
 * wrong: it looks like the engine is broken.
 *
 * The rule this restores is the one the rest of the engine already
 * follows: never rewrite stored rows, map on read, and an absent field
 * takes a safe default. Where no safe default exists — a weight cannot
 * be guessed — the finding goes SILENT rather than partial. A half
 * sentence about somebody's training is worth less than no sentence.
 */

/** What an older version of this record looked like. */
const older = (over: Partial<DeloadRecord> = {}) => ({
  state: 'deloading', kind: 'intensity', since: '2026-09-01', ...over,
} as unknown as DeloadRecord)

const complete = (over: Partial<DeloadRecord> = {}): DeloadRecord => ({
  state: 'deloading', kind: 'intensity', since: '2026-09-01',
  sessions: 0, priorWeight: 205, confidence: 'measured', ...over,
})

describe('a record with no prior weight cannot name one', () => {
  it('plans no weight rather than NaN', () => {
    const plan = deloadPlan(older())
    expect(plan.weight).toBeNull()
    expect(Number.isNaN(plan.weight as unknown as number)).toBe(false)
    /* The control: the same call on a complete record does produce a
       weight, so the null above is the missing field rather than a plan
       that never names one. */
    expect(deloadPlan(complete()).weight).toBeGreaterThan(0)
  })

  it('still plans a weight when the record has one', () => {
    /* The control: the null above is the missing field, not a plan that
       never produces a weight. */
    expect(deloadPlan(complete()).weight).toBeGreaterThan(0)
  })

  it('names no weight on a reapproach either', () => {
    expect(deloadPlan(older({ state: 'reapproach' })).weight).toBeNull()
    expect(deloadPlan(complete({ state: 'reapproach' })).weight).toBeGreaterThan(0)
  })

  it('keeps the set reduction on a volume deload, which needs no weight', () => {
    /* "Same weight, fewer sets" is honest without knowing the weight, so
       the set factor survives even when the weight cannot. */
    const plan = deloadPlan(older({ kind: 'volume' }))
    expect(plan.weight).toBeNull()
    expect(plan.setsFactor).toBeLessThan(1)
    /* The control: with a prior weight the same volume record names one,
       and keeps the same set cut. */
    const full = deloadPlan(complete({ kind: 'volume' }))
    expect(full.weight).toBeGreaterThan(0)
    expect(full.setsFactor).toBe(plan.setsFactor)
  })
})

describe('what can be described, and what cannot', () => {
  it('describes nothing for a missing record', () => {
    expect(deloadDescribable(null)).toBe(false)
  })

  it('describes a complete record', () => {
    expect(deloadDescribable(complete())).toBe(true)
  })

  it('refuses an intensity deload with no prior weight', () => {
    /* Its sentence names a weight. Without one there is no sentence. */
    expect(deloadDescribable(older())).toBe(false)
  })

  it('refuses a reapproach with no prior weight', () => {
    expect(deloadDescribable(older({ state: 'reapproach' }))).toBe(false)
    /* The control, and the reason it is here: without it, deleting the
       reapproach branch entirely still passed — a record in that state
       would fall through to the deloading check and report false, which
       is the right answer for the wrong reason. */
    expect(deloadDescribable(complete({ state: 'reapproach' }))).toBe(true)
  })

  it('accepts a volume deload with no prior weight', () => {
    /* Its sentence mentions no numbers at all. */
    expect(deloadDescribable(older({ kind: 'volume' }))).toBe(true)
  })

  it('accepts a flagged record, which also names no numbers', () => {
    expect(deloadDescribable(older({ state: 'flagged' }))).toBe(true)
  })

  it('describes nothing in the normal state', () => {
    expect(deloadDescribable(complete({ state: 'normal' }))).toBe(false)
  })
})

describe('the suggestion says nothing rather than half a sentence', () => {
  const history = [
    { date: '2026-09-01', kg: 205, sets: [{ w: 205, r: 5 }, { w: 205, r: 5 }, { w: 205, r: 5 }] },
    { date: '2026-09-08', kg: 205, sets: [{ w: 205, r: 5 }, { w: 205, r: 5 }, { w: 205, r: 5 }] },
  ]
  const now = new Date(2026, 8, 15, 12).getTime()
  const ask = (deload: unknown) =>
    suggestTarget(history as never, { id: 'squat', kg: 205, reps: 5, sets: 3, deload } as never, now)

  it('never prints NaN', () => {
    expect(ask(older()).reason).not.toContain('NaN')
  })

  it('falls back to an ordinary suggestion on an undescribable record', () => {
    expect(ask(older()).basis).not.toBe('deload')
  })

  it('still deloads on a complete record', () => {
    /* The control. If the guard were simply refusing every deload, the
       assertion above would pass while the feature was dead. */
    const s = ask(complete())
    expect(s.basis).toBe('deload')
    expect(s.reason).toContain('holding at')
  })

  it('counts from one when the session count is missing', () => {
    /* sessions is the one field with a safe default: a record that does
       not say how far in it is, is at the start. */
    const s = ask(complete({ sessions: undefined as unknown as number }))
    expect(s.reason).toContain('1 of')
    expect(s.reason).not.toContain('NaN')
  })

  it('takes the gentler cut when confidence is missing', () => {
    /* No recovery data means no evidence for a hard cut. */
    const withConfidence = deloadPlan(complete({ confidence: 'measured' })).weight as number
    const without = deloadPlan(complete({ confidence: undefined as unknown as 'measured' })).weight as number
    expect(Number.isFinite(without)).toBe(true)
    expect(without).toBeGreaterThanOrEqual(withConfidence)
  })
})
