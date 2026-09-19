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

export type ProgressionBasis = 'clean' | 'miss' | 'deload' | 'layoff' | 'new' | 'amrap'

/** How weight can physically be added to this movement. */
export type LoadingStyle = 'barbell' | 'dumbbell' | 'stack' | 'free'

import {
  DEFAULT_SET_KIND, entryKind, rangeSets, setWeight, topWorkingMetres, topWorkingReps,
  topWorkingSeconds, topWorkingWeight, workingRpe, workingSets,
  type HistoryEntry, type HistorySet, type SetKind,
} from './sets'
import { deloadPlan, DELOAD_HOLD_SESSIONS as DELOAD_HOLD, type DeloadRecord } from './deload'
import { countsForProgression } from './session'
import { snapToLoadable, type PlateConfig } from './plates'
import type { TrainingAge } from './onboarding'
import { amrapSignal } from './amrap'

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
  /** How this movement is measured. Absent means reps_weight. */
  kind?: SetKind
  /** `weight` is ASSISTANCE, and progress removes it. */
  assisted?: boolean
  /** Scales how deep a deload cuts. Absent means the shipped 10%. */
  trainingAge?: TrainingAge | null
  /** Seconds added to a time movement after a clean session. */
  incrementSeconds?: number
  /** Metres added to a distance movement after a clean session. */
  incrementMetres?: number
  /**
   * The bar and plates actually available. When present, a barbell
   * suggestion snaps to a total that can be built rather than to an
   * arithmetic multiple — 187 lb is a real number and not a real weight.
   */
  plates?: PlateConfig
  /**
   * The lift's deload state machine. While deloading or re-approaching it
   * owns the suggestion outright — otherwise a clean session at the reduced
   * weight bumps straight back and walks into the same plateau.
   */
  deload?: DeloadRecord | null
}

/** The answer for a reps_weight movement, before it is generalised. */
interface LoadSuggestion {
  weight: number
  reps: number
  reason: string
  basis: ProgressionBasis
}

/**
 * A target in whatever unit the movement is actually measured in.
 *
 * Fields that do not apply come back NULL rather than zero: null says "this
 * kind has no weight", zero would say "bodyweight", and those are different
 * answers.
 */
export interface Suggestion {
  kind: SetKind
  weight: number | null
  reps: number | null
  seconds: number | null
  metres: number | null
  /** Rendered verbatim by the tile. */
  reason: string
  basis: ProgressionBasis
}

/** Default steps for the kinds that are not measured in pounds. */
const DEFAULT_SECONDS_STEP = 5
const DEFAULT_METRES_STEP = 10

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
  /* Real plate math wins over an arithmetic grid when the rack is known. */
  if (exercise.plates && exercise.loading === 'barbell') {
    return snapToLoadable(weight, exercise.plates)
  }
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
function suggestLoad(
  history: HistoryEntry[],
  exercise: ProgressionExercise,
  now: number,
): LoadSuggestion {
  const sessions = realSessions(history)
  const last = sessions.length ? sessions[sessions.length - 1] : null
  const [minReps, maxReps] = rangeFor(exercise)
  const hasRange = maxReps > minReps

  /**
   * A live deload outranks everything, including a clean session. That is
   * the entire point of giving it a duration: progression must not be able
   * to undo it one session later.
   */
  const plan = deloadPlan(exercise.deload || null, exercise.trainingAge)
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
  /* The sets double progression is allowed to measure. An AMRAP is a
     working set, but it is not evidence about the rep range — it
     overshoots by design and undershoots when the lifter is cooked, and
     both would be read as statements about the range. */
  const ranged = rangeSets(last)
  const missedLast = (last.sets || []).some((set) => set.fail)
  /* With no working sets to read, fall back to the weight the session
     recorded — holding there beats dropping to bodyweight. */
  /* For an assisted movement the best set is the one that needed the LEAST
     help, and progress means less of it still. Reading the max here would
     treat the hardest set as the working weight and then add to it. */
  const assisted = exercise.assisted === true || (last.sets || []).some((set) => set.assisted)
  const assistUsed = sets.length ? Math.min(...sets.map((set) => setWeight(last, set))) : 0
  const held = assisted ? tidy(assistUsed) : tidy(topWorkingWeight(last) || last.kg || 0)

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

  /**
   * An unfinished session is not evidence the load was earned. Two clean
   * sets out of five looks identical to a completed session from here, and
   * bumping off it is how the next one becomes a miss.
   */
  if (!countsForProgression(last)) {
    return {
      weight: held,
      reps: minReps,
      basis: 'miss',
      reason: `holding at ${describeWeight(held)} — last session was left unfinished`,
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

  const lowest = ranged.length
    ? Math.min(...ranged.map((set) => set.r || 0))
    : Math.min(...sets.map((set) => set.r || 0))
  if (lowest < minReps) {
    return {
      weight: held,
      reps: minReps,
      basis: 'miss',
      reason: `holding at ${describeWeight(held)} — short of ${minReps} reps last time`,
    }
  }

  // sets × reps, matching how the card and the linear wording read
  const shape = `${(ranged.length || sets.length)}×${lowest}`

  /* Measured output beats inferred state, so the AMRAP is read before
     RPE and overrides it. A lifter who went to failure and got five past
     the target has told us something RPE can only guess at. */
  const amrap = amrapSignal(last, lowest)
  if (amrap && amrap.verdict === 'struggling') {
    /* All out and still short. Adding weight to this is how a bad week
       becomes a bad month; hold, and let the next session answer. */
    return {
      weight: held,
      reps: minReps,
      basis: 'amrap',
      reason: `holding at ${describeWeight(held)} — ${amrap.reps} reps to failure, under the ${amrap.target} you were chasing`,
    }
  }

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

  /* AMRAP first: it measured the load, where RPE estimated the lifter. */
  const multiplier = amrap && amrap.verdict === 'under_loaded'
    ? amrap.multiplier
    : rpe != null && rpe <= EASY_RPE ? 2 : 1
  if (assisted) {
    // less assistance is the improvement; it can reach zero but not pass it
    const eased = Math.max(0, snapWeight(Math.max(0, held - step * multiplier), exercise, held))
    const removed = tidy(held - eased)
    return {
      weight: eased,
      reps: minReps,
      basis: 'clean',
      reason: eased === 0
        ? `unassisted — clean ${shape} with only ${held} lb of help last time`
        : `−${removed} lb assistance — clean ${shape} last time`,
    }
  }
  const next = snapWeight(held + step * multiplier, exercise, held)
  const delta = tidy(next - held)

  if (multiplier > 1) {
    return {
      weight: next,
      reps: minReps,
      basis: 'clean',
      reason: amrap && amrap.verdict === 'under_loaded'
        ? `+${delta} lb — ${amrap.reps} reps to failure on a ${amrap.target}-rep target, that was too light`
        : `+${delta} lb — ${shape} at RPE ${tidy(rpe as number)}, room to move`,
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

/**
 * Progression for the kinds that are not measured in pounds.
 *
 * A plank gains seconds, a carry gains metres, bodyweight work gains reps.
 * Suggesting a weight for any of them would be meaningless.
 */
function suggestNonLoad(
  kind: SetKind,
  sessions: HistoryEntry[],
  exercise: ProgressionExercise,
): Suggestion {
  const real = sessions.filter((entry) => workingSets(entry).length > 0)
  const read =
    kind === 'reps_only' ? topWorkingReps : kind === 'time' ? topWorkingSeconds : topWorkingMetres
  const unit = kind === 'reps_only' ? ' reps' : kind === 'time' ? 's' : 'm'
  const step =
    kind === 'reps_only'
      ? 1
      : kind === 'time'
        ? exercise.incrementSeconds || DEFAULT_SECONDS_STEP
        : exercise.incrementMetres || DEFAULT_METRES_STEP

  const put = (value: number, basis: ProgressionBasis, reason: string): Suggestion => ({
    kind,
    weight: null,
    reps: kind === 'reps_only' ? value : null,
    seconds: kind === 'time' || kind === 'time_distance' ? value : null,
    metres: kind === 'distance' || kind === 'time_distance' ? value : null,
    basis,
    reason,
  })

  if (!real.length) {
    return put(step, 'new', `starting at ${step}${unit} — first time logging this`)
  }
  const last = real[real.length - 1]
  const current = read(last)
  const sets = workingSets(last).length

  if ((last.sets || []).some((set) => set.fail)) {
    return put(current, 'miss', `holding at ${current}${unit} — missed the last set`)
  }
  const previous = real.length > 1 ? read(real[real.length - 2]) : 0
  if (previous > 0 && current < previous) {
    return put(current, 'miss', `holding at ${current}${unit} — down from ${previous}${unit} last time`)
  }
  return put(current + step, 'clean', `+${step}${unit} — clean ${sets}×${current}${unit} last time`)
}

/**
 * The target for the next session, in whatever unit this movement uses.
 *
 * History decides the kind, because what was actually logged is better
 * evidence than what the definition claims; both fall back to reps_weight,
 * so every existing lift behaves exactly as it did.
 */
export function suggestTarget(
  history: HistoryEntry[],
  exercise: ProgressionExercise,
  now: number,
): Suggestion {
  const all = realSessions(history)
  /**
   * A declared kind wins over what history happens to contain, because
   * changing a lift's kind is a statement about what it is NOW.
   *
   * History under the old kind is then deliberately filtered out rather
   * than reinterpreted: 185 lb and 60 seconds are not comparable
   * quantities, and quietly treating one as the other is how a plank ends
   * up being told to add five pounds. The rows themselves are never
   * rewritten — they stay readable under the kind they were logged with.
   */
  const declared = exercise.kind
  const kind: SetKind = declared || (all.length ? entryKind(all[all.length - 1]) : DEFAULT_SET_KIND)
  const sessions = declared ? all.filter((entry) => entryKind(entry) === kind) : all

  if (kind !== 'reps_weight') return suggestNonLoad(kind, sessions, exercise)

  const answer = suggestLoad(sessions, exercise, now)
  return {
    kind: 'reps_weight',
    weight: answer.weight,
    reps: answer.reps,
    seconds: null,
    metres: null,
    basis: answer.basis,
    reason: answer.reason,
  }
}
