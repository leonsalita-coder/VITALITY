/**
 * Records — what counts as a personal record, and how loudly to say so.
 *
 * Firing on "heaviest weight" or "most reps at that weight" means a PR
 * lands almost every session in someone's first year, and a celebration
 * that plays constantly stops meaning anything. Estimated 1RM is the
 * honest single number: it ranks 245×3 above 225×5 above 205×8, which is
 * how a lifter already reads their own training.
 *
 * Pure and DOM-free; `now` is always a parameter.
 *
 * UNITS: pounds throughout.
 */

import {
  isWorkingSet,
  setWeight,
  topWorkingReps,
  topWorkingWeight,
  workingSets,
  type HistoryEntry,
} from './sets'

/**
 * Epley stops describing reality somewhere past ten reps — past that it is
 * measuring work capacity, not maximal strength. Capping is the difference
 * between a strength metric and a fantasy number off a 20-rep set.
 */
export const E1RM_MAX_REPS = 10

/** All-time records stop being reachable after a few years; this keeps one alive. */
export const ROLLING_PR_DAYS = 365

/**
 * Epley: 1RM = w × (1 + r/30). Null when the inputs cannot support one.
 *
 * A single is special-cased to the weight itself. Epley is fitted to
 * multi-rep sets and returns 1.033×w at one rep, which would quietly
 * inflate every heavy single into a record 3% above what was lifted — a
 * true one-rep max is the max, not an estimate of it.
 */
export function epley1RM(weight: number, reps: number): number | null {
  if (!Number.isFinite(weight) || !Number.isFinite(reps)) return null
  if (weight <= 0 || reps < 1 || reps > E1RM_MAX_REPS) return null
  if (reps === 1) return weight
  return weight * (1 + reps / 30)
}

export interface E1RMRecord {
  value: number
  weight: number
  reps: number
  date: string
}

export interface BestOptions {
  /** Today never competes with itself. */
  excludeDate?: string
  /** Rolling window floor, inclusive, as YYYY-MM-DD. */
  sinceDate?: string
}

function eligible(entry: HistoryEntry, opts: BestOptions): boolean {
  if (entry.off) return false
  if (opts.excludeDate && entry.date === opts.excludeDate) return false
  if (opts.sinceDate && entry.date < opts.sinceDate) return false
  return true
}

/** Best estimated 1RM on record, from working sets inside the rep cap. */
export function bestE1RM(history: HistoryEntry[], opts: BestOptions = {}): E1RMRecord | null {
  let best: E1RMRecord | null = null
  for (const entry of history || []) {
    if (!eligible(entry, opts)) continue
    for (const set of workingSets(entry)) {
      const weight = setWeight(entry, set)
      const reps = set.r || 0
      const value = epley1RM(weight, reps)
      if (value == null) continue
      if (!best || value > best.value) best = { value, weight, reps, date: entry.date }
    }
  }
  return best
}

/** Heaviest working weight on record, for the quiet weight PR. */
function bestWorkingWeight(history: HistoryEntry[], opts: BestOptions = {}): number {
  let best = 0
  for (const entry of history || []) {
    if (!eligible(entry, opts)) continue
    best = Math.max(best, topWorkingWeight(entry))
  }
  return best
}

/** Best reps seen at exactly this weight. */
function bestRepsAtWeight(history: HistoryEntry[], weight: number, opts: BestOptions = {}): number {
  let best = 0
  for (const entry of history || []) {
    if (!eligible(entry, opts)) continue
    for (const set of workingSets(entry)) {
      if (setWeight(entry, set) === weight) best = Math.max(best, set.r || 0)
    }
  }
  return best
}

/** Best reps seen anywhere, for lifts whose reps sit above the e1RM cap. */
function bestRepsAnywhere(history: HistoryEntry[], opts: BestOptions = {}): number {
  let best = 0
  for (const entry of history || []) {
    if (!eligible(entry, opts)) continue
    best = Math.max(best, topWorkingReps(entry))
  }
  return best
}

export interface PRCandidate {
  weight: number
  reps: number
  warmup?: boolean
  fail?: boolean
}

export interface PRResult {
  /** e1rm earns the celebration; weight and reps get a quiet dot. */
  kind: 'e1rm' | 'weight' | 'reps' | null
  scope: 'all-time' | '12-month' | null
  /** The candidate's estimated 1RM, when one could be computed. */
  e1rm: number | null
}

const NO_PR: PRResult = { kind: null, scope: null, e1rm: null }

function dateKey(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function shiftDays(ms: number, delta: number): string {
  const d = new Date(ms)
  d.setDate(d.getDate() + delta)
  return dateKey(d.getTime())
}

/**
 * What kind of record, if any, this set just set.
 *
 * Order matters: e1RM is the canonical claim, so it is checked first and
 * a weight or rep PR is only reported when e1RM did not fire. Warm-ups and
 * misses can never set anything.
 */
export function classifyPR(
  history: HistoryEntry[],
  candidate: PRCandidate,
  now: number,
): PRResult {
  if (!isWorkingSet(candidate)) return NO_PR

  const today = dateKey(now)
  const base: BestOptions = { excludeDate: today }
  const rolling: BestOptions = { excludeDate: today, sinceDate: shiftDays(now, -ROLLING_PR_DAYS) }

  const value = epley1RM(candidate.weight, candidate.reps)
  const allTime = bestE1RM(history, base)

  if (value != null && allTime) {
    if (value > allTime.value) return { kind: 'e1rm', scope: 'all-time', e1rm: value }
    const recent = bestE1RM(history, rolling)
    // a record can be gone from the last twelve months even when the
    // all-time number is out of reach — that one is still worth marking
    if (recent && value > recent.value) return { kind: 'e1rm', scope: '12-month', e1rm: value }
  }

  const heaviest = bestWorkingWeight(history, base)
  if (heaviest <= 0) return { ...NO_PR, e1rm: value }

  if (candidate.weight > heaviest) return { kind: 'weight', scope: 'all-time', e1rm: value }

  const repsHere = bestRepsAtWeight(history, candidate.weight, base)
  if (repsHere > 0 && candidate.reps > repsHere) {
    return { kind: 'reps', scope: 'all-time', e1rm: value }
  }
  // lifts worked above the rep cap never produce an e1RM, so their only
  // available record is raw reps
  if (value == null && candidate.reps > bestRepsAnywhere(history, base)) {
    return { kind: 'reps', scope: 'all-time', e1rm: null }
  }

  return { ...NO_PR, e1rm: value }
}

/**
 * The cue shown BEFORE a set, when the prefilled numbers land just short of
 * the best e1RM on record. Anticipation is a better motivator than
 * confetti after the fact, and it costs nothing to look at.
 */
export function nearMissCue(
  history: HistoryEntry[],
  prefill: { weight: number; reps: number },
  incrementLb: number,
  now: number,
): string | null {
  const value = epley1RM(prefill.weight, prefill.reps)
  if (value == null) return null
  const best = bestE1RM(history, { excludeDate: dateKey(now) })
  if (!best) return null
  const deficit = best.value - value
  if (deficit <= 0) return null
  const window = Math.max(incrementLb, 0)
  if (deficit > window) return null
  return `${Math.round(deficit * 10) / 10} lb under your best`
}
