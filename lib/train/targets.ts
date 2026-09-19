/**
 * Targets that belong to the user rather than to the average lifter.
 *
 * Every threshold in this engine started as an intermediate-lifter number:
 * a 10-20 hard-set band, a four-session week, 4-6 rep ranges, a 10% deload.
 * Applied flatly they make the app confidently wrong about people who are
 * doing fine — a beginner doing six good sets a week is told they are under
 * the band every single week, and someone who trains twice a week by choice
 * watches a streak they never agreed to break.
 *
 * THE RULE THAT SHAPES THIS FILE:
 *
 *   A finding must never fire solely because someone trains less than a
 *   default they never chose.
 *
 * So the two ends of the band are not symmetric, and deliberately so. The
 * CEILING is absolute: too much volume is a real risk at any training age
 * and is worth saying out loud. The FLOOR is relative to the athlete's own
 * trailing average: "less than you have been doing" is a fact about them,
 * where "less than ten" is a fact about somebody else. With no trailing
 * average and no stated intent, there is no floor at all and under-volume
 * is simply not reported.
 *
 * Pure and DOM-free.
 */

import type { TrainingAge } from './onboarding'

export interface AgeProfile {
  /** Hard sets per muscle per week this athlete can absorb. */
  ceiling: number
  /** The floor used only when the athlete has stated a training age. */
  floor: number
  /** Multiplier on an intensity deload, measured and inferred. */
  deloadMeasured: number
  deloadInferred: number
  /** Rep ranges by tier: compound, secondary, accessory. */
  repRanges: [[number, number], [number, number], [number, number]]
}

/**
 * Beginners recover fast and need reps to learn a movement; advanced
 * lifters need more volume to progress and deeper cuts to recover from it.
 */
const PROFILES: Record<TrainingAge, AgeProfile> = {
  beginner: {
    ceiling: 14, floor: 5,
    deloadMeasured: 0.95, deloadInferred: 0.97,
    repRanges: [[5, 8], [8, 12], [12, 15]],
  },
  intermediate: {
    ceiling: 20, floor: 10,
    deloadMeasured: 0.9, deloadInferred: 0.95,
    repRanges: [[4, 6], [6, 10], [10, 15]],
  },
  advanced: {
    ceiling: 25, floor: 12,
    deloadMeasured: 0.85, deloadInferred: 0.92,
    repRanges: [[3, 5], [5, 8], [8, 12]],
  },
}

/** What the app assumed about everyone before it could ask. */
const UNKNOWN: AgeProfile = PROFILES.intermediate

export function profileFor(age: TrainingAge | null | undefined): AgeProfile {
  return age && PROFILES[age] ? PROFILES[age] : UNKNOWN
}

export interface BandContext {
  trainingAge?: TrainingAge | null
  /**
   * The athlete's own trailing hard sets per week for this muscle, across
   * the weeks before this one. Null when there is not enough history.
   */
  trailingSets?: number | null
}

export interface SetBand {
  /** Null means under-volume is not reported at all. */
  floor: number | null
  ceiling: number
  floorSource: 'trailing' | 'age' | 'none'
}

/** Below this the trailing average is noise rather than a norm. */
const MIN_TRAILING = 4

/** How far below their own norm counts as a real drop. */
const DROP_FRACTION = 0.6

/**
 * The band for one muscle, for this athlete.
 *
 * The ceiling comes from training age because absorbing volume is a
 * physical fact. The floor prefers the athlete's own trailing average,
 * falls back to the age profile only when they told us their training age,
 * and is otherwise absent — because reporting someone as under-trained
 * against a number they never chose is the app being wrong about a person
 * who is fine.
 */
export function weeklySetBand(ctx: BandContext = {}): SetBand {
  const profile = profileFor(ctx.trainingAge)
  const trailing = ctx.trailingSets

  if (typeof trailing === 'number' && Number.isFinite(trailing) && trailing >= MIN_TRAILING) {
    return {
      floor: Math.round(trailing * DROP_FRACTION * 10) / 10,
      ceiling: profile.ceiling,
      floorSource: 'trailing',
    }
  }
  if (ctx.trainingAge) {
    return { floor: profile.floor, ceiling: profile.ceiling, floorSource: 'age' }
  }
  return { floor: null, ceiling: profile.ceiling, floorSource: 'none' }
}

/** Intensity deload multiplier, by training age and confidence. */
export function deloadCut(
  age: TrainingAge | null | undefined,
  confidence: 'measured' | 'inferred',
): number {
  const profile = profileFor(age)
  return confidence === 'measured' ? profile.deloadMeasured : profile.deloadInferred
}

/** Starting rep range for a newly classified lift, by training age. */
export function repRangeFor(
  age: TrainingAge | null | undefined,
  tier: number,
): [number, number] {
  const ranges = profileFor(age).repRanges
  if (tier <= 1) return ranges[0]
  if (tier >= 3) return ranges[2]
  return ranges[1]
}

/**
 * The streak target.
 *
 * What they said they intend to train, never a constant. Someone who
 * chooses twice a week is succeeding at twice a week, and a four-session
 * default tells them otherwise every week forever.
 */
export function streakTarget(statedFrequency: number | null | undefined, fallback = 4): number {
  if (typeof statedFrequency !== 'number' || !Number.isFinite(statedFrequency)) return fallback
  return Math.min(14, Math.max(1, Math.round(statedFrequency)))
}
