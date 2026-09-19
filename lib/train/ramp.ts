/**
 * Warm-up ramp generation.
 *
 * Working out what to put on the bar on the way up to a working set is the
 * most tedious arithmetic anybody does in a gym, and it is arithmetic this
 * engine already has every input for: the working weight, the bar, and the
 * plates on hand. So it does it.
 *
 * THE CONSTRAINT THAT SHAPES THIS FILE.
 *
 * Every set generated here is flagged `warmup: true` at the moment it is
 * created. That is not a courtesy — it is the only reason a generated ramp
 * is safe to add. A ramp set that reached volume would inflate it every
 * session; one that reached records would fire a PR off an empty bar on a
 * lifter's first day; one that reached progression would hand the next
 * suggestion a weight nobody was working at. Flagging at creation means
 * those failures cannot happen because the lifter forgot to press W.
 *
 * Nothing here is ever auto-logged. A ramp is a suggestion: generated,
 * editable, skippable, and absent entirely for anyone who does not want
 * one.
 *
 * Pure and DOM-free.
 */

import { snapToLoadable, type PlateConfig } from './plates'
import { DEFAULT_SET_KIND, type SetKind } from './sets'

/**
 * The climb, as fractions of the working weight, by how many sets it takes.
 *
 * Roughly 40/60/80 at full length, with the bar underneath. The LADDER is
 * chosen rather than the rungs being dropped, because dropping rungs from
 * a fixed ladder gives a light lift an oddly top-heavy ramp — 95 lb would
 * warm up at 55 and 75, which is two sets to travel fifty pounds.
 *
 * Descending reps throughout: the point of the light sets is movement, and
 * the point of the heavy ones is getting used to the weight without
 * spending anything on it.
 */
export const RAMP_LADDERS: Record<number, Array<{ fraction: number; reps: number }>> = {
  2: [{ fraction: 0.6, reps: 5 }],
  3: [{ fraction: 0.5, reps: 5 }, { fraction: 0.75, reps: 3 }],
  4: [{ fraction: 0.4, reps: 5 }, { fraction: 0.6, reps: 3 }, { fraction: 0.8, reps: 2 }],
  5: [
    { fraction: 0.4, reps: 5 }, { fraction: 0.55, reps: 4 },
    { fraction: 0.7, reps: 3 }, { fraction: 0.85, reps: 2 },
  ],
}

/** Nobody needs more than this many sets to get warm. */
export const MAX_RAMP_SETS = 5
/** Below this there is nothing worth calling a ramp. */
const MIN_RAMP_SETS = 2

/** Reps on the empty bar, where the weight is not the point. */
const BAR_REPS = 8

/**
 * How many sets this ramp is worth, counting the bar.
 *
 * Measured in bar-loads of distance to travel: a lift one bar-load above
 * the bar needs two sets, and a lift eight bar-loads up needs the lot.
 * Scaling by distance rather than by absolute weight keeps it right for a
 * lighter bar, where 155 lb is a long way up and not a warm-up set.
 */
function rungsFor(working: number, bar: number): number {
  if (bar <= 0) return MAX_RAMP_SETS
  const barLoads = (working - bar) / bar
  return Math.min(MAX_RAMP_SETS, Math.max(MIN_RAMP_SETS, 1 + Math.round(barLoads)))
}

/** Kinds that carry external load, and so have something to ramp. */
const LOADED_KINDS: SetKind[] = ['reps_weight', 'weighted_bodyweight']

export interface RampSet {
  /** Pounds, despite the name — as everywhere in this engine. */
  kg: number
  reps: number
  /**
   * Always true. A ramp set is a warm-up from the instant it exists, so
   * every downstream read excludes it without being told to.
   */
  warmup: true
}

export interface RampRequest {
  /** Today's working weight, in pounds. */
  workingLb: number
  /** How the lift is measured. Kinds with no load get no ramp. */
  kind?: SetKind
  plates: PlateConfig
}

/**
 * The ramp for one lift today.
 *
 * Scales to the load by construction rather than by a rule: each rung is
 * snapped to a loadable total, and rungs that collapse onto the bar or
 * onto each other are dropped. A 95 lb squat has nothing between the bar
 * and the work, so it gets one or two sets; a 405 gets the full climb.
 */
export function warmupRamp(request: RampRequest): RampSet[] {
  const kind = request.kind || DEFAULT_SET_KIND
  if (!LOADED_KINDS.includes(kind)) return []

  const working = request.workingLb
  if (typeof working !== 'number' || !Number.isFinite(working) || working <= 0) return []

  const config = request.plates
  const bar = Math.max(0, (config && config.barLb) || 0)

  /* Working at or below the bar means there is nothing to work up to.
     Bar, bar, bar is not a warm-up, it is three sets of standing there. */
  if (working <= bar) return []

  const out: RampSet[] = []
  const seen = new Set<number>()

  const push = (weightLb: number, reps: number) => {
    const snapped = snapToLoadable(weightLb, config)
    /* Never at or above the work: a "warm-up" at the working weight is a
       working set with a flag on it, and it would make the real set the
       second one. */
    if (snapped > working) return
    if (seen.has(snapped)) return
    seen.add(snapped)
    out.push({ kg: snapped, reps, warmup: true })
  }

  if (bar > 0) push(bar, BAR_REPS)
  for (const rung of RAMP_LADDERS[rungsFor(working, bar)] || []) {
    push(working * rung.fraction, rung.reps)
  }

  return out.sort((a, b) => a.kg - b.kg)
}
