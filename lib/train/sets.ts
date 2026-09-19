/**
 * Set-level primitives.
 *
 * The distinction that matters here is working vs. everything else. A
 * warm-up is a real thing that happened and belongs in the session record,
 * but counting it as training is how volume inflates, PRs fire every
 * session, and the progression engine is fed weights nobody was working at.
 *
 * UNITS: pounds. The stored field is named `kg` for historical reasons and
 * holds pounds regardless. No conversion exists anywhere in this system.
 */

export interface HistorySet {
  /** Reps completed. */
  r?: number
  /**
   * Weight for this set specifically, in pounds. Older rows predate
   * per-set weight and fall back to the entry's top weight — see
   * setWeight().
   */
  w?: number
  fail?: boolean
  /**
   * Excluded from volume, PRs, progression and plateau detection.
   *
   * Absent means false. That is deliberately how existing history
   * migrates: nothing is rewritten and nothing is guessed. A light set
   * sitting next to heavy ones is *probably* a warm-up, and we still do
   * not say so — only the flag counts.
   */
  warmup?: boolean
}

export interface HistoryEntry {
  /** Local-time YYYY-MM-DD. */
  date: string
  /** Top working weight for the session, in pounds. */
  kg: number
  sets?: HistorySet[]
  /** A logged rest day — carries no training information. */
  off?: boolean
}

export interface VolumeOptions {
  /** A per-side lift moves its load twice per rep. */
  perSide?: boolean
}

/** Logged, not missed, not a warm-up. */
export function isWorkingSet(set: HistorySet | null | undefined): boolean {
  return !!set && set.fail !== true && set.warmup !== true
}

/** The sets that count as training. The stored list is left intact. */
export function workingSets(entry: HistoryEntry): HistorySet[] {
  return (entry.sets || []).filter(isWorkingSet)
}

/**
 * What this set was actually loaded with. Rows written before per-set
 * weight existed only recorded the session's top weight, so that is the
 * best available answer for them.
 */
export function setWeight(entry: HistoryEntry, set: HistorySet): number {
  return typeof set.w === 'number' ? set.w : entry.kg || 0
}

/** Pounds moved in the sets that count. */
export function workingVolume(entry: HistoryEntry, opts: VolumeOptions = {}): number {
  const sides = opts.perSide ? 2 : 1
  return workingSets(entry).reduce(
    (sum, set) => sum + setWeight(entry, set) * (set.r || 0) * sides,
    0,
  )
}

/** Heaviest working set, ignoring a heavy warm-up single. */
export function topWorkingWeight(entry: HistoryEntry): number {
  const weights = workingSets(entry).map((set) => setWeight(entry, set))
  return weights.length ? Math.max(...weights) : 0
}

/** Best rep count among the working sets. */
export function topWorkingReps(entry: HistoryEntry): number {
  const reps = workingSets(entry).map((set) => set.r || 0)
  return reps.length ? Math.max(...reps) : 0
}
