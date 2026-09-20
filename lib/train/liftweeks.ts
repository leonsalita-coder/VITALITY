/**
 * A lift's week-by-week progress, in one place.
 *
 * Two findings need the same thing — how much a lift moved, week over
 * week, as a fraction of itself — and they needed it for different
 * reasons: minimum effective dose averages it across the lifts that
 * train a muscle, transfer between lifts correlates one lift's against
 * another's. Computing it twice would be two answers to "did this lift
 * go up this week", which is how two screens come to disagree.
 *
 * RELATIVE, NOT ABSOLUTE. A press and a squat cannot be averaged or
 * correlated in pounds; five pounds is a fortnight on one and a session
 * on the other. Fractions of the lift's own weight are comparable.
 *
 * ESTIMATED 1RM RATHER THAN BARE WEIGHT. Five reps at 200 is progress
 * over three reps at 200, and a weight-only measure calls that a flat
 * week. The absolute e1RM of a lateral raise is meaningless — which is
 * why no e1rm-validity filter applies here — but its week-over-week
 * fractional change is not.
 *
 * Pure and DOM-free.
 */

import { epley1RM } from './records'
import { workingSets, type HistoryEntry } from './sets'
import { dateKey, daysBetween } from './windows'

/**
 * Weeks ago, as a whole number. 0 is this week, larger is older.
 *
 * Built from `now` rather than read from the clock, like everything else
 * in this engine — it is what makes a finding replayable over a history
 * that has not happened yet.
 */
export function weekIndexer(now: number): (date: string) => number {
  const today = dateKey(now)
  return (date: string) => Math.floor(daysBetween(date, today) / 7)
}

/**
 * Best estimated one-rep max among an entry's working sets, or null.
 *
 * Null means nothing here produced an estimate — a bodyweight set, a
 * timed hold, an empty session. epley1RM refuses a non-positive weight,
 * so a real set always leaves a positive number and the two cases cannot
 * be confused.
 */
export function bestE1rm(entry: HistoryEntry | null | undefined): number | null {
  if (!entry || entry.off) return null
  let best = 0
  for (const set of workingSets(entry)) {
    const e1 = epley1RM(set.w ?? entry.kg ?? 0, set.r ?? 0)
    /* `>` and `>=` are equivalent here — both leave the same number when
       two sets tie — so mutation testing reports that flip as a
       permanent survivor. Equivalent mutation, not a gap. */
    if (e1 != null && e1 > best) best = e1
  }
  return best > 0 ? best : null
}

/** The best estimate each week carried, keyed by weeks-ago. */
export function weeklyBestE1rm(
  entries: HistoryEntry[] | null | undefined,
  weekOf: (date: string) => number,
): Map<number, number> {
  const best = new Map<number, number>()
  for (const entry of entries || []) {
    if (!entry || !entry.date) continue
    const e1 = bestE1rm(entry)
    if (e1 == null) continue
    const w = weekOf(entry.date)
    best.set(w, Math.max(best.get(w) ?? 0, e1))
  }
  return best
}

/**
 * How much the lift moved each week, as a fraction of the week before.
 *
 * Measured against the last week the lift was TRAINED rather than the
 * calendar week before: a fortnight's gap is one step, not one step and
 * a missing one. A lifter who trains a movement every third week is
 * still progressing on it, and treating the blank weeks as zero would
 * report them as stalled.
 *
 * Walked as pairs rather than by index. The index version had an
 * off-by-one nothing could see — reading one past the end produced a
 * change keyed on `undefined` with a value of NaN, which no lookup would
 * ever ask for. There is no division guard either: every value came from
 * epley1RM, which refuses a non-positive weight, so a zero denominator
 * is unreachable and a check for it could never be shown to do anything.
 */
export function weeklyRelativeChange(
  entries: HistoryEntry[] | null | undefined,
  weekOf: (date: string) => number,
): Map<number, number> {
  const best = weeklyBestE1rm(entries, weekOf)
  const changes = new Map<number, number>()
  let previousWeek: number | null = null
  for (const week of [...best.keys()].sort((a, b) => b - a)) {
    if (previousWeek != null) {
      const previous = best.get(previousWeek) as number
      changes.set(week, ((best.get(week) as number) - previous) / previous)
    }
    previousWeek = week
  }
  return changes
}
