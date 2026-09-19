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
  DEFAULT_SET_KIND,
  isWorkingSet,
  setKind,
  setWeight,
  topWorkingMetres,
  topWorkingReps,
  topWorkingSeconds,
  topWorkingWeight,
  workingSets,
  type HistoryEntry,
  type SetKind,
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
      // e1RM is a reps_weight idea; assistance is not load
      if (setKind(set) !== 'reps_weight' || set.assisted) continue
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
  /** Absent means reps_weight, like everywhere else. */
  kind?: SetKind
  weight?: number
  reps?: number
  seconds?: number
  metres?: number
  /** `weight` is assistance; less of it is the record. */
  assisted?: boolean
  /**
   * Taken to failure. Carried so a candidate can be built straight from a
   * logged set; a record stands or falls on the numbers either way, and an
   * all-out set is exactly where a rep record tends to come from.
   */
  amrap?: boolean
  warmup?: boolean
  fail?: boolean
}

export interface PRResult {
  /**
   * e1rm earns the celebration; everything else is a quiet dot. 'assist'
   * is a reps_weight record running the other way — less help than ever.
   */
  kind: 'e1rm' | 'weight' | 'reps' | 'time' | 'distance' | 'assist' | null
  scope: 'all-time' | '12-month' | null
  /** The candidate's estimated 1RM, when the kind supports one. */
  e1rm: number | null
  /** Which unit the record is in, so it can be reported honestly. */
  unit: 'lb' | 's' | 'm' | 'reps' | null
}

const NO_PR: PRResult = { kind: null, scope: null, e1rm: null, unit: null }

/** Best value across history for one per-entry accessor. */
function bestBy(
  history: HistoryEntry[],
  pick: (entry: HistoryEntry) => number,
  opts: BestOptions,
): number {
  let best = 0
  for (const entry of history || []) {
    if (!eligible(entry, opts)) continue
    best = Math.max(best, pick(entry))
  }
  return best
}

/** Least assistance ever used — the record for an assisted movement. */
function leastAssistance(history: HistoryEntry[], opts: BestOptions): number | null {
  let best: number | null = null
  for (const entry of history || []) {
    if (!eligible(entry, opts)) continue
    for (const set of workingSets(entry)) {
      if (!set.assisted) continue
      const help = setWeight(entry, set)
      if (best == null || help < best) best = help
    }
  }
  return best
}

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
  const kind = candidate.kind || DEFAULT_SET_KIND

  /* Kinds with no load have no estimated 1RM — only their own unit. */
  if (kind === 'time') {
    const best = bestBy(history, topWorkingSeconds, base)
    const value = candidate.seconds || 0
    if (best > 0 && value > best) return { kind: 'time', scope: 'all-time', e1rm: null, unit: 's' }
    return NO_PR
  }
  if (kind === 'distance' || kind === 'time_distance') {
    const best = bestBy(history, topWorkingMetres, base)
    const value = candidate.metres || 0
    if (best > 0 && value > best) return { kind: 'distance', scope: 'all-time', e1rm: null, unit: 'm' }
    return NO_PR
  }
  if (kind === 'reps_only') {
    const best = bestBy(history, topWorkingReps, base)
    const value = candidate.reps || 0
    if (best > 0 && value > best) return { kind: 'reps', scope: 'all-time', e1rm: null, unit: 'reps' }
    return NO_PR
  }

  /* Assisted work: the record is the least help ever needed. */
  if (candidate.assisted) {
    const best = leastAssistance(history, base)
    const value = candidate.weight || 0
    if (best != null && value < best) {
      return { kind: 'assist', scope: 'all-time', e1rm: null, unit: 'lb' }
    }
    return NO_PR
  }

  const weight = candidate.weight || 0
  const reps = candidate.reps || 0
  const rolling: BestOptions = { excludeDate: today, sinceDate: shiftDays(now, -ROLLING_PR_DAYS) }
  const value = epley1RM(weight, reps)
  const allTime = bestE1RM(history, base)

  if (value != null && allTime) {
    if (value > allTime.value) return { kind: 'e1rm', scope: 'all-time', e1rm: value, unit: 'lb' }
    const recent = bestE1RM(history, rolling)
    // a record can be gone from the last twelve months even when the
    // all-time number is out of reach — that one is still worth marking
    if (recent && value > recent.value) {
      return { kind: 'e1rm', scope: '12-month', e1rm: value, unit: 'lb' }
    }
  }

  const heaviest = bestBy(history, topWorkingWeight, base)
  if (heaviest <= 0) return { ...NO_PR, e1rm: value }

  if (weight > heaviest) return { kind: 'weight', scope: 'all-time', e1rm: value, unit: 'lb' }

  const repsHere = bestRepsAtWeight(history, weight, base)
  if (repsHere > 0 && reps > repsHere) {
    return { kind: 'reps', scope: 'all-time', e1rm: value, unit: 'reps' }
  }
  // lifts worked above the rep cap never produce an e1RM, so their only
  // available record is raw reps
  if (value == null && reps > bestRepsAnywhere(history, base)) {
    return { kind: 'reps', scope: 'all-time', e1rm: null, unit: 'reps' }
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
