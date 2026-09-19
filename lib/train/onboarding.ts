/**
 * What the app asks once, so it is not useless on day one.
 *
 * Import solves the cold start for switchers. Everyone else arrives with no
 * progression basis, no records, no plateau detection and readiness silent
 * for a month — the app is at its weakest exactly when someone is deciding
 * whether to keep it.
 *
 * Every answer is optional, and a skipped one must leave behaviour EXACTLY
 * as it is today. That is the constraint that shapes the whole file: every
 * field is nullable, nothing is defaulted into existence, and `apply` only
 * writes what was actually answered.
 *
 * A starting weight is stored as a starting weight — NOT as a fabricated
 * history row. A seeded session would count toward volume, streaks, records
 * and the ramp reads, which would make the app's first week a lie in
 * exchange for a suggestion it can get honestly.
 *
 * Pure and DOM-free.
 */

import { recordBodyweight, type BodyweightEntry } from './bodyweight'

export type TrainingAge = 'beginner' | 'intermediate' | 'advanced'

export interface StartingLift {
  exerciseId: string
  /** What they can work with today, in pounds. */
  weightLb: number
}

export interface OnboardingAnswers {
  bodyweightLb?: number | null
  startingLifts?: StartingLift[] | null
  /** Equipment they actually have. Becomes the primary signal. */
  equipment?: string[] | null
  /** Exercise ids that hurt. Pre-sets the pain flags. */
  avoid?: string[] | null
  sessionsPerWeek?: number | null
  trainingAge?: TrainingAge | null
}

export interface OnboardingState {
  bodyweight?: BodyweightEntry[]
  /** Working weights with no history behind them yet. */
  startingWeights?: Record<string, number>
  equipment?: string[]
  painFlagged?: string[]
  weeklyTarget?: number
  trainingAge?: TrainingAge
  /** Recorded so the questions are asked once, however little was answered. */
  onboardedAt?: string
}

export interface ApplyResult {
  state: OnboardingState
  /** What was actually taken from the answers, for reporting back. */
  seeded: {
    bodyweight: boolean
    lifts: number
    equipment: number
    avoided: number
    target: number | null
    trainingAge: TrainingAge | null
  }
}

const AGES: TrainingAge[] = ['beginner', 'intermediate', 'advanced']

function cleanStrings(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return [...new Set(raw.map((x) => String(x || '').trim().toLowerCase()).filter(Boolean))]
}

/**
 * Folds the answers into state.
 *
 * Nothing unanswered is written. A field left blank leaves whatever was
 * there — including nothing — so a fully skipped onboarding is
 * indistinguishable from never having run it.
 */
export function applyOnboarding(
  state: OnboardingState,
  answers: OnboardingAnswers,
  today: string,
): ApplyResult {
  const next: OnboardingState = { ...state, onboardedAt: today }
  const seeded: ApplyResult['seeded'] = {
    bodyweight: false, lifts: 0, equipment: 0, avoided: 0, target: null, trainingAge: null,
  }

  const bw = answers.bodyweightLb
  if (typeof bw === 'number' && Number.isFinite(bw) && bw > 0) {
    next.bodyweight = recordBodyweight(state.bodyweight || [], today, bw)
    seeded.bodyweight = true
  }

  const lifts = Array.isArray(answers.startingLifts) ? answers.startingLifts : []
  const weights: Record<string, number> = { ...(state.startingWeights || {}) }
  for (const lift of lifts) {
    if (!lift || !lift.exerciseId) continue
    const w = lift.weightLb
    if (typeof w !== 'number' || !Number.isFinite(w) || w <= 0) continue
    weights[lift.exerciseId] = Math.round(w * 10) / 10
    seeded.lifts++
  }
  if (seeded.lifts) next.startingWeights = weights

  const equipment = cleanStrings(answers.equipment)
  if (equipment.length) {
    next.equipment = equipment
    seeded.equipment = equipment.length
  }

  const avoid = cleanStrings(answers.avoid)
  if (avoid.length) {
    next.painFlagged = [...new Set([...(state.painFlagged || []), ...avoid])]
    seeded.avoided = avoid.length
  }

  const target = answers.sessionsPerWeek
  if (typeof target === 'number' && Number.isFinite(target) && target >= 1 && target <= 14) {
    next.weeklyTarget = Math.round(target)
    seeded.target = next.weeklyTarget
  }

  const age = answers.trainingAge
  if (age && AGES.includes(age)) {
    next.trainingAge = age
    seeded.trainingAge = age
  }

  return { state: next, seeded }
}

/** Whether the questions have been put to them at all. */
export function onboardingNeeded(state: OnboardingState): boolean {
  return !state || !state.onboardedAt
}

/** Did any answer actually land? A skipped run is still a completed run. */
export function anythingAnswered(seeded: ApplyResult['seeded']): boolean {
  return (
    seeded.bodyweight || seeded.lifts > 0 || seeded.equipment > 0 ||
    seeded.avoided > 0 || seeded.target != null || seeded.trainingAge != null
  )
}

/**
 * The working weight to start a lift at when it has no history.
 *
 * This is what turns an answered onboarding into a real suggestion on
 * session one without inventing a session that never happened.
 */
export function startingWeightFor(state: OnboardingState, exerciseId: string): number | null {
  const w = (state.startingWeights || {})[exerciseId]
  return typeof w === 'number' && w > 0 ? w : null
}

/**
 * Equipment available, most specific first.
 *
 * A same-day override beats the stated kit, which beats what the history
 * implies. Travel and a different gym are the common real failure, and an
 * inferred list is wrong in precisely that case.
 */
export function availableEquipment(opts: {
  todayOverride?: string[] | null
  stated?: string[] | null
  fromHistory?: string[] | null
}): { equipment: string[]; source: 'today' | 'stated' | 'history' | 'none' } {
  const today = cleanStrings(opts.todayOverride)
  if (today.length) return { equipment: today, source: 'today' }
  const stated = cleanStrings(opts.stated)
  if (stated.length) return { equipment: stated, source: 'stated' }
  const history = cleanStrings(opts.fromHistory)
  if (history.length) return { equipment: history, source: 'history' }
  return { equipment: [], source: 'none' }
}
