/**
 * Progression — what weight to suggest next, and why.
 *
 * The "why" is the point. A prefilled number with no explanation is a black
 * box: users forgive a suggestion they understand and abandon one that is
 * silently wrong. So every suggestion carries the sentence the tile renders
 * verbatim — the tile never composes copy, which keeps the wording testable
 * here rather than scattered through DOM code.
 *
 * Pure and DOM-free: no `window`, no `document`, and no clock. `now` is a
 * parameter because a hidden `Date.now()` is the one thing that would make
 * these tests flaky at midnight.
 *
 * UNITS: every weight is POUNDS. The stored field is named `kg` for
 * historical reasons and holds pounds regardless. There is no conversion
 * anywhere in this system and none is introduced here.
 */

export type ProgressionBasis = 'clean' | 'miss' | 'deload' | 'layoff' | 'new'

/** How weight can physically be added to this movement. */
export type LoadingStyle = 'barbell' | 'dumbbell' | 'stack' | 'free'

import { topWorkingWeight, workingRpe, workingSets, type HistoryEntry, type HistorySet } from './sets'
import { deloadPlan, DELOAD_HOLD_SESSIONS as DELOAD_HOLD, type DeloadRecord } from './deload'

export type { HistoryEntry, HistorySet }

export interface ProgressionExercise {
  /** Currently prescribed weight, pounds. */
  kg?: number
  /** Weight carried over from a previous incarnation of this lift. */
  lastKg?: number | null
  /** Target reps per set. Bottom of the range when `repRange` is absent. */
  reps: number
  /**
   * Rep range for double progression, e.g. [8, 10]. Reps climb inside the
   * range before weight moves. Omitted means [reps, reps] — plain linear
   * progression, which is what every existing lift gets.
   */
  repRange?: [number, number]
  /** Target sets — used only to phrase the reason. */
  sets?: number
  /** Smallest jump this equipment can actually make, in pounds. */
  incrementLb?: number
  /** Defaults to 'free', which keeps the legacy weight-scaled step. */
  loading?: LoadingStyle
  /**
   * The lift's deload state machine. While deloading or re-approaching it
   * owns the suggestion outright — otherwise a clean session at the reduced
   * weight bumps straight back and walks into the same plateau.
   */
  deload?: DeloadRecord | null
}

export interface Suggestion {
  weight: number
  /** Target reps for the coming session — bottom of the range, or one more. */
  reps: number
  /** Rendered verbatim by the tile. */
  reason: string
  basis: ProgressionBasis
}

/**
 * Days away before a lift is treated as needing a ramp back rather than a
 * continuation. Two weeks is deliberately shorter than the "detrained"
 * literature: the cost of suggesting slightly too little is one easy set,
 * and the cost of suggesting too much is a missed session on the day
 * someone just came back.
 */
export const LAYOFF_DAYS = 14

/**
 * What each loading style can actually make. Zero means "no fixed grid" —
 * fall back to a weight-scaled step, which is what a lift with no equipment
 * recorded has always used.
 */
const DEFAULT_INCREMENT: Record<LoadingStyle, number> = {
  barbell: 5, // 2.5 lb plate pairs
  dumbbell: 5, // racks jump in 5s, and only in pairs
  stack: 10, // typical selectorized machine
  free: 0,
}

/**
 * Autoregulation thresholds.
 *
 * A clean session only says the weight was manageable. RPE says by how
 * much: at or below EASY the lifter left several reps in reserve and has
 * earned more than the default nudge, while a clean session at GRIND was
 * exactly that, and adding to it invites the miss next time. Both degrade
 * to the plain increment when RPE was never logged.
 */
const EASY_RPE = 7
const GRIND_RPE = 9

/**
 * Smallest jump worth making. An explicit increment wins, then the
 * equipment's grid, then the legacy weight-scaled fallback — because +5 lb
 * is 2% on a squat and over 10% on a curl, and only the equipment knows
 * which of those it is.
 */
function stepFor(weight: number, exercise: ProgressionExercise): number {
  if (typeof exercise.incrementLb === 'number' && exercise.incrementLb > 0) {
    return exercise.incrementLb
  }
  const preset = DEFAULT_INCREMENT[exercise.loading || 'free']
  if (preset > 0) return preset
  if (weight >= 135) return 5
  if (weight >= 45) return 2.5
  return 1
}

/** Trim float noise without forcing a decimal onto a whole number. */
function tidy(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Snap to a weight that can actually be loaded — never 187 lb on a bar.
 *
 * The step comes from `reference`, the weight the lift is normally worked
 * at, not from the result. A 135 lb barbell lift still moves in 5 lb jumps
 * after a layoff scales it to 128.25; rounding on the scaled number would
 * suggest 127.5, which needs 1.25 lb pairs most racks do not have.
 */
function snapWeight(weight: number, exercise: ProgressionExercise, reference: number): number {
  if (weight <= 0) return 0
  const step = stepFor(reference, exercise)
  return tidy(Math.round(weight / step) * step)
}

function localMidnight(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, (m || 1) - 1, d || 1).getTime()
}

function daysSince(dateStr: string, now: number): number {
  const then = localMidnight(dateStr)
  const nowDate = new Date(now)
  const today = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()).getTime()
  return Math.round((today - then) / 86_400_000)
}

/**
 * How much to give back after time off. Coarse on purpose — the honest
 * signal is "start lighter", and pretending to know the exact decay curve
 * for one person from a date gap would be false precision.
 */
function layoffFactor(days: number): number {
  if (days >= 84) return 0.7
  if (days >= 42) return 0.8
  if (days >= 21) return 0.85
  return 0.95
}

/** A weight as it appears in a sentence: "135 lb", or "bodyweight" at zero. */
function describeWeight(weight: number): string {
  return weight > 0 ? `${tidy(weight)} lb` : 'bodyweight'
}

function realSessions(history: HistoryEntry[]): HistoryEntry[] {
  return (history || []).filter((entry) => entry && !entry.off)
}

/** The rep range in play. No range means linear: the target, twice. */
function rangeFor(exercise: ProgressionExercise): [number, number] {
  const r = exercise.repRange
  if (Array.isArray(r) && r.length === 2 && r[1] >= r[0]) return [r[0], r[1]]
  return [exercise.reps, exercise.reps]
}

interface LayoffState {
  days: number
  /** What they were working at before the gap. */
  priorWeight: number
  /** Real sessions logged since coming back. 0 means none yet. */
  sessionsSince: number
}

/** The most recent break long enough to matter, if there is one. */
function findLayoff(sessions: HistoryEntry[], now: number): LayoffState | null {
  if (!sessions.length) return null
  const last = sessions[sessions.length - 1]
  const trailing = daysSince(last.date, now)
  if (trailing >= LAYOFF_DAYS) {
    return { days: trailing, priorWeight: topWorkingWeight(last), sessionsSince: 0 }
  }
  for (let i = sessions.length - 1; i > 0; i--) {
    const gap = daysSince(sessions[i - 1].date, localMidnight(sessions[i].date))
    if (gap >= LAYOFF_DAYS) {
      return { days: gap, priorWeight: topWorkingWeight(sessions[i - 1]), sessionsSince: sessions.length - i }
    }
  }
  return null
}

/**
 * The climb back: drop, hold the drop once, then close the gap over a
 * session or two. Jumping straight back to the old working weight is how a
 * returning lifter misses on their second session and stops coming.
 */
function rampWeights(prior: number, days: number, exercise: ProgressionExercise): number[] {
  if (prior <= 0) return [0]
  const dropped = snapWeight(prior * layoffFactor(days), exercise, prior)
  const mid = snapWeight(dropped + (prior - dropped) / 2, exercise, prior)
  const target = tidy(prior)

  const plan: number[] = []
  for (const w of [dropped, dropped, mid, target]) {
    // the first two entries are the deliberate hold; past that, a repeat is
    // just stalling and reads to the lifter as the app losing track
    if (plan.length >= 2 && plan[plan.length - 1] === w) continue
    plan.push(w)
  }
  const done = plan.indexOf(target)
  return done >= 0 ? plan.slice(0, done + 1) : plan
}

/**
 * Suggests the next working weight, the rep target, and the one-line reason.
 *
 * Precedence, most to least authoritative:
 *   deload  — an explicit instruction already recorded
 *   layoff  — time away explains everything else on the first session back
 *   new     — nothing to go on
 *   miss    — hold, and say what happened
 *   clean   — earned a step: another rep, or more weight
 */
export function suggestWeight(
  history: HistoryEntry[],
  exercise: ProgressionExercise,
  now: number,
): Suggestion {
  const sessions = realSessions(history)
  const last = sessions.length ? sessions[sessions.length - 1] : null
  const [minReps, maxReps] = rangeFor(exercise)
  const hasRange = maxReps > minReps

  /**
   * A live deload outranks everything, including a clean session. That is
   * the entire point of giving it a duration: progression must not be able
   * to undo it one session later.
   */
  const plan = deloadPlan(exercise.deload || null)
  if (plan.weight != null && exercise.deload) {
    const weight = snapWeight(plan.weight, exercise, plan.weight)
    if (exercise.deload.state === 'reapproach') {
      return {
        weight,
        reps: minReps,
        basis: 'deload',
        reason: `back to ${describeWeight(weight)} — easing out of the deload`,
      }
    }
    if (exercise.deload.kind === 'volume') {
      const cut = Math.round((1 - plan.setsFactor) * 100)
      return {
        weight,
        reps: minReps,
        basis: 'deload',
        reason: `holding at ${describeWeight(weight)} — ${cut}% fewer sets while recovery catches up`,
      }
    }
    return {
      weight,
      reps: minReps,
      basis: 'deload',
      reason: `holding at ${describeWeight(weight)} — deload, ${exercise.deload.sessions + 1} of ${DELOAD_HOLD}`,
    }
  }

  if (!last) {
    const weight = tidy(exercise.lastKg != null ? exercise.lastKg : exercise.kg || 0)
    return {
      weight,
      reps: minReps,
      basis: 'new',
      reason: `starting at ${describeWeight(weight)} — first time logging this`,
    }
  }

  /* Warm-ups are in the record but are not evidence: counting them lets a
     light ramp-up set read as a failed working session and a heavy warm-up
     single read as the working weight. A miss is still read off the raw
     list, because a missed set is information even though it is not work. */
  const sets = workingSets(last)
  const missedLast = (last.sets || []).some((set) => set.fail)
  /* With no working sets to read, fall back to the weight the session
     recorded — holding there beats dropping to bodyweight. */
  const held = tidy(topWorkingWeight(last) || last.kg || 0)

  const layoff = findLayoff(sessions, now)
  if (layoff) {
    const ramp = rampWeights(layoff.priorWeight, layoff.days, exercise)
    const step = layoff.sessionsSince
    /**
     * A ramp is a plan, not a rule. If they have already come back and
     * worked at or above the pre-break weight, the break is history —
     * suggesting a climb back to somewhere they have just been would
     * ignore the evidence sitting in front of us.
     */
    const alreadyBack = step > 0 && held >= layoff.priorWeight
    if (step < ramp.length && !alreadyBack) {
      // On the very first session back, time off explains a miss — but once
      // they are climbing, a miss is real information and stops the ramp.
      if (step > 0 && missedLast) {
        return {
          weight: held,
          reps: minReps,
          basis: 'miss',
          reason: `holding at ${describeWeight(held)} — missed the last set`,
        }
      }
      const weight = ramp[step]
      if (step === 0) {
        return {
          weight,
          reps: minReps,
          basis: 'layoff',
          reason: `back to ${describeWeight(weight)} — first session after ${layoff.days} days off`,
        }
      }
      if (weight === ramp[step - 1]) {
        return {
          weight,
          reps: minReps,
          basis: 'layoff',
          reason: `holding at ${describeWeight(weight)} — second session back`,
        }
      }
      const delta = tidy(weight - ramp[step - 1])
      return {
        weight,
        reps: minReps,
        basis: 'layoff',
        reason: `+${delta} lb — easing back to your ${describeWeight(layoff.priorWeight)} working weight`,
      }
    }
  }

  if (!sets.length) {
    return {
      weight: held,
      reps: minReps,
      basis: 'miss',
      reason: `holding at ${describeWeight(held)} — nothing logged last time`,
    }
  }

  if (missedLast) {
    return {
      weight: held,
      reps: minReps,
      basis: 'miss',
      reason: `holding at ${describeWeight(held)} — missed the last set`,
    }
  }

  const lowest = Math.min(...sets.map((set) => set.r || 0))
  if (lowest < minReps) {
    return {
      weight: held,
      reps: minReps,
      basis: 'miss',
      reason: `holding at ${describeWeight(held)} — short of ${minReps} reps last time`,
    }
  }

  // sets × reps, matching how the card and the linear wording read
  const shape = `${sets.length}×${lowest}`

  // still room inside the range: another rep before another plate
  if (lowest < maxReps) {
    return {
      weight: held,
      reps: lowest + 1,
      basis: 'clean',
      reason: `same weight, chase ${lowest + 1} reps — hit ${shape} last time`,
    }
  }

  // top of the range on every set: add weight, drop back to the bottom
  if (held <= 0) {
    return {
      weight: 0,
      reps: minReps,
      basis: 'clean',
      reason: `bodyweight — clean ${shape} last time`,
    }
  }
  const step = stepFor(held, exercise)
  const rpe = workingRpe(last)

  /* Grinding every set at the top of the range is not a green light. */
  if (rpe != null && rpe >= GRIND_RPE) {
    return {
      weight: held,
      reps: minReps,
      basis: 'clean',
      reason: `holding at ${describeWeight(held)} — clean ${shape} but grinding at RPE ${tidy(rpe)}`,
    }
  }

  const multiplier = rpe != null && rpe <= EASY_RPE ? 2 : 1
  const next = snapWeight(held + step * multiplier, exercise, held)
  const delta = tidy(next - held)

  if (multiplier > 1) {
    return {
      weight: next,
      reps: minReps,
      basis: 'clean',
      reason: `+${delta} lb — ${shape} at RPE ${tidy(rpe as number)}, room to move`,
    }
  }
  return {
    weight: next,
    reps: minReps,
    basis: 'clean',
    reason: hasRange
      ? `+${delta} lb, back to ${minReps} reps — hit ${shape} last time`
      : `+${delta} lb — clean ${shape} last time`,
  }
}
