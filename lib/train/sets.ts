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

/**
 * How a set is measured. Absent means 'reps_weight', which is how every
 * existing row migrates: nothing stored is rewritten, exactly as with the
 * warm-up flag.
 */
export type SetKind = 'reps_weight' | 'reps_only' | 'time' | 'distance' | 'time_distance'

export const DEFAULT_SET_KIND: SetKind = 'reps_weight'

export interface HistorySet {
  /** Reps completed. */
  r?: number
  /**
   * Weight for this set specifically, in pounds. Older rows predate
   * per-set weight and fall back to the entry's top weight — see
   * setWeight().
   */
  w?: number
  /**
   * Rate of perceived exertion, 6-10 in half steps. Optional forever —
   * logging a set must never require it, and every consumer degrades to
   * its pre-RPE behaviour when it is absent.
   */
  /** Seconds held or worked — time and time_distance. */
  s?: number
  /** Metres covered — distance and time_distance. */
  m?: number
  /** Absent means reps_weight. */
  kind?: SetKind
  /**
   * One side's work was logged, not the sum. Volume counts it twice; the
   * logged number itself is never touched.
   */
  perSide?: boolean
  /**
   * `w` is ASSISTANCE, not load — a pull-up or dip machine taking weight
   * off. Less of it is progress, so every comparison inverts. This is the
   * flag that gets written backwards.
   */
  assisted?: boolean
  banded?: boolean
  rpe?: number
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
  /** Exercise-level default, used only when the set itself says nothing. */
  perSide?: boolean
}

/**
 * Volume, kept in separate units on purpose.
 *
 * Adding lb·reps to seconds produces a number that means nothing and moves
 * for the wrong reasons, so there is deliberately no combined total. A
 * caller that wants "volume" has to say volume of what.
 */
export interface VolumeTotals {
  /** lb x reps, from reps_weight. */
  load: number
  /** Reps, from reps_only. */
  reps: number
  /** Seconds, from time and time_distance. */
  seconds: number
  /** Metres, from distance and time_distance. */
  metres: number
}

export function emptyVolume(): VolumeTotals {
  return { load: 0, reps: 0, seconds: 0, metres: 0 }
}

export function setKind(set: HistorySet): SetKind {
  return set.kind || DEFAULT_SET_KIND
}

/** An entry's kind, taken from its working sets so a warm-up cannot set it. */
export function entryKind(entry: HistoryEntry): SetKind {
  const first = workingSets(entry)[0]
  return first ? setKind(first) : DEFAULT_SET_KIND
}

/** Whether this set counts its work twice. The set wins over the exercise. */
function isPerSide(set: HistorySet, opts: VolumeOptions): boolean {
  return set.perSide !== undefined ? set.perSide === true : opts.perSide === true
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

/**
 * Work done in the sets that count, bucketed by unit.
 *
 * An assisted set contributes reps but no load: `w` is how much weight was
 * taken OFF, and without a bodyweight we cannot say what was actually
 * moved. Reporting zero is honest; reporting the assistance as load would
 * be exactly backwards.
 */
export function workingVolume(entry: HistoryEntry, opts: VolumeOptions = {}): VolumeTotals {
  const totals = emptyVolume()
  for (const set of workingSets(entry)) {
    const sides = isPerSide(set, opts) ? 2 : 1
    const reps = (set.r || 0) * sides
    switch (setKind(set)) {
      case 'reps_weight':
        if (set.assisted) totals.reps += reps
        else totals.load += setWeight(entry, set) * reps
        break
      case 'reps_only':
        totals.reps += reps
        break
      case 'time':
        totals.seconds += (set.s || 0) * sides
        break
      case 'distance':
        totals.metres += (set.m || 0) * sides
        break
      case 'time_distance':
        totals.seconds += (set.s || 0) * sides
        totals.metres += (set.m || 0) * sides
        break
    }
  }
  return totals
}

/** Best working seconds on an entry, zero when its kind measures no time. */
export function topWorkingSeconds(entry: HistoryEntry): number {
  const values = workingSets(entry)
    .filter((set) => setKind(set) === 'time' || setKind(set) === 'time_distance')
    .map((set) => set.s || 0)
  return values.length ? Math.max(...values) : 0
}

/** Best working metres on an entry, zero when its kind measures no distance. */
export function topWorkingMetres(entry: HistoryEntry): number {
  const values = workingSets(entry)
    .filter((set) => setKind(set) === 'distance' || setKind(set) === 'time_distance')
    .map((set) => set.m || 0)
  return values.length ? Math.max(...values) : 0
}

/**
 * One entry reduced to two numbers where HIGHER IS ALWAYS BETTER, whatever
 * the kind.
 *
 * Normalising here is what keeps `assisted` from being written backwards in
 * four separate places: progression, plateau detection, PRs and the deload
 * diagnosis all read this instead of re-deriving "which way is up" from the
 * kind and flags themselves.
 */
export function entryScore(entry: HistoryEntry): {
  kind: SetKind
  primary: number
  secondary: number
} {
  const kind = entryKind(entry)
  const sets = workingSets(entry)
  const best = (pick: (s: HistorySet) => number) =>
    sets.length ? Math.max(...sets.map(pick)) : 0

  switch (kind) {
    case 'reps_only':
      return { kind, primary: best((s) => s.r || 0), secondary: best((s) => s.r || 0) }
    case 'time':
      return { kind, primary: best((s) => s.s || 0), secondary: 0 }
    case 'distance':
      return { kind, primary: best((s) => s.m || 0), secondary: 0 }
    case 'time_distance': {
      const metres = best((s) => s.m || 0)
      // further is better, and over the same distance faster is better, so
      // the time term is negated to keep "higher is better" true
      const seconds = sets.length ? Math.min(...sets.map((s) => s.s || Infinity)) : 0
      return { kind, primary: metres, secondary: Number.isFinite(seconds) ? -seconds : 0 }
    }
    default: {
      const assisted = sets.some((s) => s.assisted)
      if (assisted) {
        // the least assistance used is the best set, so the score is its
        // negation — dropping from 40 lb of help to 20 is progress
        const least = sets.length ? Math.min(...sets.map((s) => setWeight(entry, s))) : 0
        return { kind, primary: -least, secondary: best((s) => s.r || 0) }
      }
      // with no working sets at all, fall back to the entry's recorded
      // weight so a legacy row keeps reading the way it always did
      const weight = sets.length ? best((s) => setWeight(entry, s)) : entry.kg || 0
      return { kind, primary: weight, secondary: best((s) => s.r || 0) }
    }
  }
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

/**
 * Mean RPE across the working sets that carry one, or null.
 *
 * Warm-ups cannot contribute by construction — they are not working sets —
 * which matters because a warm-up is easy by design and would drag the
 * average toward "plenty left in the tank" on every single session.
 */
export function workingRpe(entry: HistoryEntry): number | null {
  const values = workingSets(entry)
    .map((set) => set.rpe)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  if (!values.length) return null
  return values.reduce((a, b) => a + b, 0) / values.length
}
