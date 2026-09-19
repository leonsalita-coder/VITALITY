/**
 * Parameters fitted to the person, not to the average lifter.
 *
 * Increments, sessions-to-stall and the recovery interval are constants.
 * They are reasonable and they are wrong for most individuals: somebody
 * whose squat climbs ten pounds a week and whose press climbs two and a
 * half is being handed the same number for both, and then told they
 * missed when the press does not follow.
 *
 * NOT MACHINE LEARNING, and the distinction is the point. This is
 * parameter fitting with explicit gates — each parameter declares the
 * sample it needs before it may move off its default at all, the fit is a
 * median of observed steps rather than anything opaque, and every value
 * can be read back in a sentence and put back with one call.
 *
 * BELOW THE GATE, BEHAVIOUR IS EXACTLY TODAY'S. That is most people most
 * of the time, and it is what makes this safe to ship: a new user, a user
 * with a thin history, and a user who has reset everything all get the
 * engine they had before, byte for byte.
 *
 * FITTED IS MARKED, the same way estimated data is marked everywhere
 * else. A number derived from somebody's own history is better than a
 * default but it is not a measurement of a law, and anything built on it
 * should be able to say where it came from.
 *
 * Pure and DOM-free.
 */

import { catalogExercise, type MovementPattern } from './catalog'
import { topWorkingWeight } from './sets'
import type { History } from './analysis'

/**
 * What each parameter needs before it may move.
 *
 * Sessions, not weeks: the question is how many observations of a STEP
 * there are, and a step is the gap between two sessions.
 */
export const PARAMETER_GATES = {
  increment: 8,
} as const

/** Nothing outside this is a plausible weekly step on any lift. */
const MIN_PLAUSIBLE_STEP = 1
const MAX_PLAUSIBLE_STEP = 25

export interface FittedValue {
  value: number
  /** Observations the fit rests on. */
  samples: number
  /** Always true on a fitted value. */
  fitted: true
  /** Always false — present so the distinction is explicit at the type. */
  default: false
  /** What it learned, in a sentence. */
  text: string
}

export interface FittedParameters {
  /** Fitted increment per movement pattern. */
  increments: Partial<Record<MovementPattern, FittedValue>>
  /** True when anything at all has been fitted. */
  fitted: boolean
}

export interface FittingContext {
  history: History
  customLib: Record<string, unknown>
  now: number
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Fit what there is evidence for, and nothing else.
 *
 * Only UPWARD steps are counted. A lifter coming back from a layoff or
 * working through a deload produces large downward moves that say nothing
 * about how fast they add weight, and folding those in would fit a
 * number to the shape of their worst month.
 */
export function fitParameters(ctx: FittingContext): FittedParameters {
  const stepsByPattern = new Map<MovementPattern, number[]>()

  for (const id of Object.keys(ctx.history || {})) {
    const def = catalogExercise(id)
    if (!def) continue

    const sessions = (ctx.history[id] || [])
      .filter((e) => e && !e.off && e.date)
      .sort((a, b) => a.date.localeCompare(b.date))

    for (let i = 1; i < sessions.length; i++) {
      const before = topWorkingWeight(sessions[i - 1])
      const after = topWorkingWeight(sessions[i])
      const step = after - before
      /* Upward, real, and not a typo. A hundred pounds in a week is data
         entry; zero is a session that held, which is information about
         stalling rather than about step size. */
      if (step < MIN_PLAUSIBLE_STEP || step > MAX_PLAUSIBLE_STEP) continue
      const list = stepsByPattern.get(def.pattern) || []
      list.push(step)
      stepsByPattern.set(def.pattern, list)
    }
  }

  const increments: FittedParameters['increments'] = {}
  for (const [pattern, steps] of stepsByPattern) {
    if (steps.length < PARAMETER_GATES.increment) continue
    /* No second range check on the median. Every step that reached this
       list is already inside [MIN, MAX], so the median of them is too —
       a check here could never fire, and it masked the per-step filter
       under mutation testing while being masked by it in return. One
       gate, at the point where a value can actually be out of range. */
    const value = Math.round(median(steps) * 2) / 2
    increments[pattern] = {
      value,
      samples: steps.length,
      fitted: true,
      default: false,
      text: `${pattern.replace(/_/g, ' ')}: ${value} lb a step, from ${steps.length} observed jumps.`,
    }
  }

  return { increments, fitted: Object.keys(increments).length > 0 }
}

/**
 * The increment for this lift: fitted where there is evidence, otherwise
 * exactly the default that would have been used before any of this.
 */
export function fittedIncrementFor(
  parameters: FittedParameters | null | undefined,
  exerciseId: string,
  fallback: number,
): number {
  const def = catalogExercise(exerciseId)
  if (!def || !parameters) return fallback
  const found = parameters.increments[def.pattern]
  return found ? found.value : fallback
}

/**
 * Put a parameter back.
 *
 * Returns a new set rather than editing in place: a reset that mutates
 * the thing it was handed cannot be offered as "preview what this would
 * do", and every other decision in this engine is separable from its
 * application.
 */
export function resetParameter(
  parameters: FittedParameters,
  kind: 'increment' | 'all',
  scope?: string,
): FittedParameters {
  if (kind === 'all') return { increments: {}, fitted: false }

  const increments = { ...parameters.increments }
  if (scope) delete increments[scope as MovementPattern]
  else return { increments: {}, fitted: false }

  return { increments, fitted: Object.keys(increments).length > 0 }
}

/** Everything fitted, as lines somebody can read and act on. */
export function describeParameters(parameters: FittedParameters | null | undefined): string[] {
  if (!parameters || !parameters.fitted) return []
  return Object.values(parameters.increments)
    .filter((v): v is FittedValue => !!v)
    .map((v) => v.text)
    .sort()
}
