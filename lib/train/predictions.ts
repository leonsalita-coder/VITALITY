/**
 * The engine grades itself.
 *
 * Every suggestion this app makes is a prediction — "you will do 200 for
 * five today" — and until now nothing recorded whether any of them came
 * true. No fitness app scores itself, and that is exactly why doing it
 * matters: it turns every other claim in this engine from asserted into
 * checkable. An accuracy figure the athlete can read is worth more than
 * any amount of confident phrasing.
 *
 * THE RULE THAT MAKES IT MEAN ANYTHING.
 *
 * A prediction is written ONCE, at session start, and never rewritten. A
 * prediction that can be edited after the outcome is not a prediction; it
 * is a record of the outcome wearing a prediction's name, and an accuracy
 * score computed from those would be a number that can only ever say
 * 100%. recordPrediction refuses to overwrite, and refuses in the case
 * that looks most reasonable — when the new value looks better.
 *
 * WHAT THE FOUR OUTCOMES MEAN.
 *
 *   hit           the work matched what was asked
 *   missed_high   too heavy: they loaded less, or came up short on reps
 *   missed_low    too light: they beat it comfortably
 *   not_attempted the lift was not trained; scored as neither
 *
 * The high/low distinction is the useful half. A suggestion that is
 * usually 5 lb too heavy on pressing is a specific, fixable thing to
 * know; "78% accurate" alone is not.
 *
 * Pure and DOM-free.
 */

import { topWorkingSeconds, topWorkingMetres, topWorkingWeight, workingSets } from './sets'
import type { HistoryEntry } from './sets'
import type { ProgressionBasis } from './progression'
import type { ReadinessVerdict } from './readiness'

/** Reps past target that mean the suggestion was too light. */
export const EASY_MARGIN = 3

/** Scored predictions needed before the feedback may change anything. */
export const MIN_SCORED_FOR_FEEDBACK = 10

/** Hit rate below which progression eases off. */
const POOR_RATE = 0.6

/** Share of misses that must be HIGH before easing off is the right move. */
const MOSTLY_HIGH = 0.6

export interface Prediction {
  /** Exercise id. */
  id: string
  /** Session date the prediction was made for. */
  date: string
  weight: number | null
  reps: number | null
  seconds: number | null
  metres: number | null
  basis: ProgressionBasis
  /** The deload state it was made under, for breaking accuracy down. */
  deloadState: string | null
  readiness: ReadinessVerdict
  /** When it was written. Present so an edited store is detectable. */
  madeAt: number
}

export type Outcome = 'hit' | 'missed_high' | 'missed_low' | 'not_attempted'

export type PredictionStore = Record<string, Prediction>

const keyOf = (p: Prediction) => `${p.date}:${p.id}`

/**
 * Write a prediction, if there is not one already.
 *
 * Returns whether it was written. Refusing silently would make an
 * overwrite indistinguishable from a first write, and the caller has no
 * other way to tell.
 */
export function recordPrediction(store: PredictionStore, prediction: Prediction): boolean {
  if (!store || !prediction || !prediction.id || !prediction.date) return false
  const key = keyOf(prediction)
  if (key in store) return false
  store[key] = { ...prediction }
  return true
}

/** What actually happened against what was predicted. */
export function scorePrediction(
  prediction: Prediction,
  entry: HistoryEntry | null | undefined,
): Outcome {
  if (!entry || entry.off || !workingSets(entry).length) return 'not_attempted'

  /* Each kind is judged in its own unit. Comparing a plank's seconds to a
     weight would be the same category error the typed-set work removed
     everywhere else. */
  if (prediction.seconds != null) {
    const held = topWorkingSeconds(entry)
    if (held >= prediction.seconds + EASY_MARGIN * 5) return 'missed_low'
    return held >= prediction.seconds ? 'hit' : 'missed_high'
  }
  if (prediction.metres != null) {
    const covered = topWorkingMetres(entry)
    if (covered >= prediction.metres * 1.2) return 'missed_low'
    return covered >= prediction.metres ? 'hit' : 'missed_high'
  }

  const targetWeight = prediction.weight ?? 0
  const targetReps = prediction.reps ?? 0
  const loaded = topWorkingWeight(entry)

  /* Loading less than suggested is a miss HIGH: the number asked for was
     more than they were willing or able to put on the bar. */
  if (loaded < targetWeight) return 'missed_high'

  /* The LOWEST working set decides, not the best one — a prediction of
     three sets of five is met by three sets of five, not by one. */
  const reps = workingSets(entry).map((s) => s.r || 0)
  const lowest = reps.length ? Math.min(...reps) : 0
  if (lowest >= targetReps + EASY_MARGIN) return 'missed_low'
  return lowest >= targetReps ? 'hit' : 'missed_high'
}

export interface BasisAccuracy {
  total: number
  hit: number
  rate: number | null
}

export interface Accuracy {
  /** Predictions that were attempted. Not-attempted is counted separately. */
  total: number
  hit: number
  missedHigh: number
  missedLow: number
  notAttempted: number
  rate: number | null
  byBasis: Record<string, BasisAccuracy>
  byLift: Record<string, BasisAccuracy>
  /** "usually high", or null when there is nothing to characterise. */
  whenWrong: string | null
}

const EMPTY: Accuracy = {
  total: 0, hit: 0, missedHigh: 0, missedLow: 0, notAttempted: 0,
  rate: null, byBasis: {}, byLift: {}, whenWrong: null,
}

export interface AccuracyOptions {
  /** Only score predictions on or after this date. */
  since?: string
}

/**
 * How often the engine has been right lately.
 *
 * Not-attempted is deliberately outside the rate: a session somebody
 * skipped says nothing about whether the weight was correct, and folding
 * it in would make a holiday look like a run of bad predictions.
 */
export function accuracyOver(
  store: PredictionStore | null | undefined,
  history: Record<string, HistoryEntry[]> | null | undefined,
  opts: AccuracyOptions = {},
): Accuracy {
  const predictions = Object.values(store || {})
    .filter((p) => p && (!opts.since || p.date >= opts.since))
    /* EQUIVALENT MUTANT (confirmed empirically, not by reasoning): the OR
       here can be mutated to AND with no test able to catch it, because
       Accuracy carries no ordering information anywhere in its shape —
       total/hit/byBasis/byLift/whenWrong are all order-independent sums
       and running averages. The sort has no observable effect on this
       function's return value. Checked against every real consumer
       (tests/train/predictions.test.ts, predictions-wiring.test.ts,
       two-a-day.test.ts), not just this file's own tests. */
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))
  /* EQUIVALENT MUTANT (confirmed empirically): this guard can be removed
     entirely with no observable change, because `out` is built as
     `{ ...EMPTY, byBasis:{}, byLift:{} }` right after this line anyway —
     an empty `predictions` array makes the loop below a no-op, and the
     final rate/whenWrong computation for total===0 already reproduces
     EMPTY exactly. The early return is a documented shortcut, not a
     behavioural branch. */
  if (!predictions.length) return { ...EMPTY }

  const out: Accuracy = {
    ...EMPTY, byBasis: {}, byLift: {},
  }

  for (const p of predictions) {
    const entries = (history || {})[p.id] || []
    const entry = entries.find((e) => e && e.date === p.date) || null
    const outcome = scorePrediction(p, entry)

    if (outcome === 'not_attempted') {
      out.notAttempted++
      continue
    }
    out.total++
    if (outcome === 'hit') out.hit++
    if (outcome === 'missed_high') out.missedHigh++
    if (outcome === 'missed_low') out.missedLow++

    for (const [bucket, key] of [[out.byBasis, p.basis], [out.byLift, p.id]] as const) {
      const seen = bucket[key] || { total: 0, hit: 0, rate: null }
      seen.total++
      if (outcome === 'hit') seen.hit++
      seen.rate = Math.round((seen.hit / seen.total) * 100) / 100
      bucket[key] = seen
    }
  }

  out.rate = out.total ? Math.round((out.hit / out.total) * 100) / 100 : null

  const wrong = out.missedHigh + out.missedLow
  if (wrong > 0) {
    out.whenWrong = out.missedHigh >= out.missedLow
      ? `usually too high (${out.missedHigh} of ${wrong})`
      : `usually too light (${out.missedLow} of ${wrong})`
  }
  return out
}

export interface Damping {
  /**
   * A CAP on the step multiplier, not a scale on it.
   *
   * Scaling was tried and is meaningless: the suggested weight is snapped
   * to a loadable multiple of the increment, so half an increment rounds
   * straight back to a whole one and the damping vanishes. What survives
   * rounding — and is the right intervention anyway — is refusing the
   * DOUBLE jump that an easy RPE or a big AMRAP would otherwise buy.
   * A lifter missing most of what they are handed does not need a bigger
   * step, whatever the last set suggested.
   */
  maxMultiplier: number
  reason: string
}

/**
 * Whether progression should ease off, and why.
 *
 * Gated hard and in two directions, because the wrong intervention here
 * is worse than none. It needs real volume before it moves at all; and it
 * only fires when the misses are mostly HIGH. Missing LOW means the
 * suggestions were too light, and damping them further would make a good
 * run worse.
 */
export function progressionDamping(accuracy: Accuracy | null | undefined): Damping | null {
  if (!accuracy || accuracy.total < MIN_SCORED_FOR_FEEDBACK) return null
  if (accuracy.rate == null || accuracy.rate >= POOR_RATE) return null

  const wrong = accuracy.missedHigh + accuracy.missedLow
  if (!wrong || accuracy.missedHigh / wrong < MOSTLY_HIGH) return null

  return {
    maxMultiplier: 1,
    /* Reportable, with the numbers, because an adjustment nobody can see
       the reason for is indistinguishable from the app being broken. */
    reason: `Easing off — you've missed ${accuracy.missedHigh} of the last ${accuracy.total} suggestions, ${accuracy.whenWrong}.`,
  }
}
