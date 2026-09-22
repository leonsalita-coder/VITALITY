/**
 * Bodyweight, as a tracked value rather than a setting.
 *
 * A pull-up done at 160 lb and the same pull-up at 185 lb are not the same
 * set, and a single stored number would silently rewrite years of history
 * every time someone's weight changed. Volume is computed against what they
 * actually weighed on the day.
 *
 * Everything degrades. With no bodyweight on record, bodyweight lifts report
 * their reps and say the load is UNAVAILABLE — not zero. Zero is a claim,
 * and it is the wrong one.
 *
 * Pure and DOM-free. Pounds, like everything else.
 */

export interface BodyweightEntry {
  /** Local YYYY-MM-DD. */
  date: string
  lb: number
}

/**
 * What they weighed on a given day.
 *
 * The most recent reading on or before that date — a weight recorded in
 * March does not describe a session in January. Null when nothing precedes
 * it, which callers must treat as "unknown" rather than "zero".
 */
export function bodyweightAt(readings: BodyweightEntry[], date: string): number | null {
  let best: BodyweightEntry | null = null
  /* `readings`, not `history`: these are weight entries, not sessions —
     a different shape with a different guard, and naming it history put
     it under a rule about lift rows that does not apply to it. */
  for (const entry of readings || []) {
    if (!entry || typeof entry.lb !== 'number' || !Number.isFinite(entry.lb) || entry.lb <= 0) continue
    if (entry.date > date) continue
    if (!best || entry.date > best.date) best = entry
  }
  return best ? best.lb : null
}

/** The latest reading, for anything that just needs "now". */
export function currentBodyweight(history: BodyweightEntry[]): number | null {
  const sorted = (history || []).filter((e) => e && e.lb > 0).sort((a, b) => a.date.localeCompare(b.date))
  return sorted.length ? sorted[sorted.length - 1].lb : null
}

/** Records a reading, replacing any already held for that day. */
export function recordBodyweight(
  history: BodyweightEntry[],
  date: string,
  lb: number,
): BodyweightEntry[] {
  if (!Number.isFinite(lb) || lb <= 0) return history || []
  const rest = (history || []).filter((e) => e && e.date !== date)
  return [...rest, { date, lb: Math.round(lb * 10) / 10 }].sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * The load a bodyweight movement actually moves.
 *
 * `factor` is how much of the athlete the movement lifts — a push-up is
 * roughly two-thirds, a pull-up is all of it. `added` is a weight belt;
 * `assistance` is a machine taking weight off, and it subtracts.
 *
 * Null when bodyweight is unknown, so a caller cannot mistake an absent
 * figure for a light one.
 */
export function bodyweightLoad(opts: {
  bodyweightLb: number | null
  factor: number | null | undefined
  added?: number
  assistance?: number
}): number | null {
  if (opts.bodyweightLb == null || !Number.isFinite(opts.bodyweightLb)) return null
  const factor = typeof opts.factor === 'number' && opts.factor > 0 ? opts.factor : 1
  const base = opts.bodyweightLb * factor
  const load = base + (opts.added || 0) - (opts.assistance || 0)
  // assistance can exceed what the movement lifts; the athlete is still
  // moving something, but not a negative amount of it
  return Math.max(0, Math.round(load * 10) / 10)
}
