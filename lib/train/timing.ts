/**
 * Rest taken, read from what actually happened.
 *
 * Rushing rest is one of the most common real reasons a lift stops
 * moving, and nothing in this engine could see it, because nothing
 * recorded when a set happened. The rest timer knew the moment and threw
 * it away.
 *
 * TWO RULES.
 *
 * A timing figure comes only from OBSERVED timestamps. Imported history
 * carries `atEstimated`, migrated history carries no `at` at all, and
 * neither may ever contribute — a median rest computed from invented
 * timestamps would be a confident number about something nobody measured,
 * and it would be indistinguishable from a real one downstream. This is
 * the same rule as `estimated` on a muscle split and on other-training
 * load: the flag travels with the value, and the value is refused where
 * the flag says it is not real.
 *
 * ABSENT IS NOT ZERO. `hasObservedTiming` reports whether there was
 * anything to read, exactly as `loadUnavailable` does for bodyweight
 * volume. Without it, a session nobody timed and a session with no rest
 * between sets would produce the same number, and the second is a finding
 * while the first is silence.
 *
 * Pure and DOM-free.
 */

import { readableEntries, isWorkingSet, type HistoryEntry, type HistorySet } from './sets'

/**
 * Longer than this is not rest.
 *
 * Fifteen minutes between working sets is a phone call, a conversation,
 * or somebody leaving and coming back. Counting it would say a lifter
 * takes eleven minutes between sets and quietly make every trend
 * meaningless.
 */
export const MAX_REST_SECONDS = 900

/** Timed sessions needed before a direction means anything. */
export const MIN_TIMED_SESSIONS = 3

/**
 * How much rest has to fall to count as compressing.
 *
 * Twenty percent: enough that a lifter would notice if told, and far
 * enough outside the noise of rounding and a slightly busy gym that it is
 * not firing on nothing.
 */
export const REST_COMPRESSION = 0.8

/** A timestamp that was actually observed, rather than inferred. */
function observedAt(set: HistorySet | null | undefined): number | null {
  /* EQUIVALENT MUTANT (confirmed empirically, not by reasoning — applied
     and run against the full real test suite, including every other
     consumer of restTrend: deload.ts's readCause, weekly.ts's
     median_rest metric). This function is private, and its one caller
     (restTaken's loop, below) only ever passes members of `working`,
     already filtered through isWorkingSet(), which returns false on
     null/undefined before this function is ever reached. The guard
     cannot fire on a reachable input. */
  if (!set) return null
  if (set.atEstimated === true) return null
  const at = set.at
  /* EQUIVALENT MUTANT (confirmed empirically, including the fixture that
     looked like it should catch it: a NaN and an Infinity `at` on a
     middle set, tried directly). `&&` can become `||` here with nothing
     able to catch it — a non-finite `at` that slips past this check does
     not stay unnoticed, it poisons the subtraction in restTaken's gap
     calculation into NaN or Infinity, and restTaken's own
     `seconds > 0 && seconds <= MAX_REST_SECONDS` bounds check rejects
     every non-finite result independently, on the way in from any
     source. There is no reachable `at` for which this check's outcome
     changes what ends up in `gaps`. */
  return typeof at === 'number' && Number.isFinite(at) ? at : null
}

export interface RestReading {
  /** Seconds between consecutive observed working sets. */
  gaps: number[]
  /** Middle gap, or null when nothing was observed. */
  median: number | null
  /** False means nothing was measured — NOT that no rest was taken. */
  hasObservedTiming: boolean
}

const EMPTY: RestReading = { gaps: [], median: null, hasObservedTiming: false }

function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

/**
 * Rest between the working sets of one session.
 *
 * Warm-ups are excluded, consistent with every other read here: the gap
 * between two ramp sets is not rest, it is loading plates.
 */
export function restTaken(entry: HistoryEntry | null | undefined): RestReading {
  if (!entry || entry.off) return EMPTY
  const working = (entry.sets || []).filter(isWorkingSet)

  /* An unobserved set BREAKS THE CHAIN rather than being stepped over.
     Both ends of a gap have to be real: one measured timestamp beside an
     estimated one produces a number that is part measurement and part
     fiction, and skipping the unobserved set instead would silently
     invent a gap spanning it — a plausible-looking figure for rest
     nobody took. Written as a chain so a null can never reach the
     arithmetic at all. */
  const gaps: number[] = []
  let previous: number | null = null
  for (const set of working) {
    const at = observedAt(set)
    if (at == null) {
      previous = null
      continue
    }
    if (previous != null) {
      const seconds = Math.round((at - previous) / 1000)
      if (seconds > 0 && seconds <= MAX_REST_SECONDS) gaps.push(seconds)
    }
    previous = at
  }
  return { gaps, median: median(gaps), hasObservedTiming: gaps.length > 0 }
}

/** The middle rest of one session, or null when nothing was timed. */
export function medianRest(entry: HistoryEntry | null | undefined): number | null {
  return restTaken(entry).median
}

/** Whether any session in this history was really timed. */
export function hasObservedTiming(history: HistoryEntry[] | null | undefined): boolean {
  return (history || []).some((entry) => restTaken(entry).hasObservedTiming)
}

export interface RestTrend {
  /** Median rest in the earliest timed session, seconds. */
  from: number
  /** In the latest. */
  to: number
  /** Timed sessions the trend rests on. */
  sessions: number
  compressing: boolean
  /**
   * The lift moved into or out of a superset inside this window.
   *
   * When true, `compressing` is always false: rest before and after a
   * structural change is not the same measurement, and the drop is
   * arithmetic rather than behaviour.
   */
  groupingChanged: boolean
}

/**
 * Where rest has been going across sessions.
 *
 * Null until MIN_TIMED_SESSIONS sessions carry real timing — one rushed
 * day is a day, and calling it a trend is how a finding earns the right
 * to be ignored.
 */
export function restTrend(history: HistoryEntry[] | null | undefined): RestTrend | null {
  const medians: number[] = []
  const shapes: string[] = []
  for (const entry of readableEntries(history)) {
    const value = medianRest(entry)
    if (value == null) continue
    medians.push(value)
    /* Absent means ungrouped, which is what every row logged before
       grouping was captured means — and what it actually was. Normalising
       undefined and '' to the same token is what stops the arrival of the
       field looking like a change of structure. */
    shapes.push(entry.group ? `g:${entry.group}` : 'none')
  }
  if (medians.length < MIN_TIMED_SESSIONS) return null

  /**
   * Did the lift move into or out of a superset inside the window?
   *
   * Only grouped-versus-ungrouped matters, not WHICH group: a superset
   * relabelled from A to B is the same structure and the same rest cost.
   */
  /* EQUIVALENT MUTANT (confirmed empirically): `!==` here can become
     `===` with nothing able to catch it. groupingChanged only asks
     whether every element of `grouped` agrees with the first one —
     negating EVERY element (which is what this mutation does, since the
     comparison inside the map is applied uniformly to every shape) never
     changes whether the array is uniform, only which uniform value it
     holds. `grouped` is used nowhere else. */
  const grouped = shapes.map((s) => s !== 'none')
  const groupingChanged = grouped.some((g) => g !== grouped[0])

  const from = medians[0]
  const to = medians[medians.length - 1]
  return {
    from,
    to,
    sessions: medians.length,
    /* A structural change makes the two ends incomparable. Reporting a
       softened version — "rest fell, but you changed things" — would be
       worse than silence, because the reader takes the headline. */
    /* EQUIVALENT MUTANT (confirmed empirically): `from > 0` can become
       `from >= 0` with nothing able to catch it. `from` is `medians[0]`,
       and every value in `medians` comes from medianRest() on a gap
       list where every gap already passed `seconds > 0` above — the
       median of one or more strictly-positive numbers is itself always
       positive, so `from === 0` is not a reachable input through
       restTrend, the only caller. */
    compressing: !groupingChanged && from > 0 && to / from <= REST_COMPRESSION,
    groupingChanged,
  }
}
