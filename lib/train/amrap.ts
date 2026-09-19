/**
 * AMRAP — the last set taken to technical failure.
 *
 * Everything else this engine uses to judge how a lifter is doing is
 * either inferred (RPE, a self-report), unavailable (recovery, needs a
 * wearable), or backward-looking (a plateau, three sessions after the
 * fact). An AMRAP is none of those. It is a measurement of output, taken
 * in the gym, by somebody with no wearable and no RPE habit, and it
 * answers the only question progression actually cares about: was this
 * weight right?
 *
 * Reps against the target say so directly. Well over, and the load was
 * too light — the next jump should be bigger than one increment, because
 * one increment will still be too light. Well under, and something is
 * wrong that adding weight will not fix.
 *
 * TWO THINGS THIS MUST NOT DO.
 *
 * It must not become required. A lifter who never flags a set gets exactly
 * the app they had before — every function here returns null on absence,
 * and every caller keeps its pre-AMRAP behaviour on null.
 *
 * It must not distort the rep range. Double progression asks whether every
 * working set reached the top of the range; a set deliberately taken past
 * the range answers that wrongly in both directions. The exclusion lives
 * in sets.ts as rangeSets(), so it holds by construction rather than by
 * each caller remembering.
 *
 * Pure and DOM-free.
 */

import { amrapOf, type HistoryEntry } from './sets'

/**
 * Reps over target that read as under-loaded.
 *
 * Three, because one or two over is a good day and everybody has those.
 * Three past a target you were supposed to reach exactly is the load being
 * wrong rather than the lifter being fresh.
 */
export const AMRAP_OVER = 3

/** The biggest jump an AMRAP may ever justify, in increments. */
export const AMRAP_MAX_MULTIPLIER = 4

export type AmrapVerdict = 'under_loaded' | 'on_target' | 'struggling'

export interface AmrapSignal {
  /** Reps actually achieved. */
  reps: number
  /** Reps the set was prescribed. */
  target: number
  /** reps − target. Negative means they came up short. */
  surplus: number
  verdict: AmrapVerdict
  /**
   * How many increments the next jump is worth. 1 is the ordinary step,
   * so an on-target AMRAP changes nothing.
   */
  multiplier: number
}

/**
 * What the last all-out set says about the load.
 *
 * Null when nothing was flagged, which is the common case and must stay
 * cheap and silent.
 */
export function amrapSignal(
  entry: HistoryEntry | null | undefined,
  target: number,
): AmrapSignal | null {
  if (!entry) return null
  const set = amrapOf(entry)
  if (!set || typeof set.r !== 'number' || !Number.isFinite(set.r)) return null
  if (!Number.isFinite(target) || target <= 0) return null

  const reps = set.r
  const surplus = reps - target

  if (surplus < 0) {
    /* Short of a target they were meant to reach even going all out.
       Adding weight to this is how a bad week becomes a bad month. */
    return { reps, target, surplus, verdict: 'struggling', multiplier: 1 }
  }
  if (surplus < AMRAP_OVER) {
    return { reps, target, surplus, verdict: 'on_target', multiplier: 1 }
  }
  /* Each further AMRAP_OVER reps of overshoot buys another increment, so
     a lifter who is badly under-loaded catches up in a session or two
     instead of creeping up five pounds at a time for a month. */
  const multiplier = Math.min(AMRAP_MAX_MULTIPLIER, 1 + Math.floor(surplus / AMRAP_OVER))
  return { reps, target, surplus, verdict: 'under_loaded', multiplier }
}

export interface AmrapTrend {
  /** Reps in the earliest session that carried an AMRAP. */
  from: number
  /** Reps in the latest. */
  to: number
  /** Sessions in the trend. */
  sessions: number
  falling: boolean
}

/**
 * Where the AMRAP has been going.
 *
 * A falling AMRAP at a constant load is a clearer stall signal than flat
 * working sets, because flat working sets are what a lifter produces when
 * they are following the programme correctly — the number that moves is
 * the one nobody was pacing. Null until there are two points, since one
 * all-out set has no direction.
 */
export function amrapTrend(history: HistoryEntry[] | null | undefined): AmrapTrend | null {
  const reps: number[] = []
  for (const entry of history || []) {
    if (!entry || entry.off) continue
    const set = amrapOf(entry)
    if (set && typeof set.r === 'number' && Number.isFinite(set.r)) reps.push(set.r)
  }
  if (reps.length < 2) return null
  const from = reps[0]
  const to = reps[reps.length - 1]
  return { from, to, sessions: reps.length, falling: to < from }
}
