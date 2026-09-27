/**
 * Session lifecycle.
 *
 * A meaningful share of real sessions simply stop — three sets in, the gym
 * closes, a kid needs collecting. Until now there was no answer for what
 * that half-finished session meant, and the ambiguity flowed straight into
 * streaks, volume, plateau detection and every weekly read.
 *
 * THE DECISION, stated once and applied everywhere:
 *
 *   An abandoned session is REAL WORK THAT WAS NOT FINISHED.
 *
 *   counts toward  — volume, PRs, plateau detection, weekly sets, ratios,
 *                    ramps, frequency. The sets were performed; pretending
 *                    otherwise understates training load and would make the
 *                    ramp and recovery reads wrong in the dangerous
 *                    direction.
 *   does NOT count — streaks. A streak measures showing up and finishing;
 *                    abandoning is not finishing, and a streak that counts
 *                    it stops meaning anything.
 *   does NOT count — a progression bump. Two clean sets out of five is not
 *                    evidence the load was earned, and bumping off it is
 *                    how the next session becomes a miss.
 *
 * A session with no logged sets is NOT a rest day. A rest day is a decision
 * the athlete made; an empty session is a day that did not happen. Letting
 * them collapse would let an abandoned intention masquerade as planned
 * recovery, which is exactly the fake-logging pressure the frequency streak
 * was built to remove.
 *
 * Pure and DOM-free.
 */

import { isWorkingSet, type HistoryEntry } from './sets'

export type SessionState = 'not_started' | 'in_progress' | 'complete' | 'abandoned' | 'rest'

export interface SessionLike {
  date: string
  /** The athlete marked this a rest day. A decision, not an absence. */
  off?: boolean
  ex?: Array<{ log?: Array<unknown | null> }>
}

export interface LifecycleOptions {
  /** Today, so a past session can be judged as rolled over. */
  today: string
  /** Whether the athlete pressed finish. */
  finished: boolean
}

/** How many sets carry a logged entry, warm-ups included. */
export function loggedSetCount(session: SessionLike): number {
  return (session.ex || []).reduce(
    (n, ex) => n + (ex.log || []).filter((s) => s != null).length,
    0,
  )
}

/** Sets that count as training — logged, not a warm-up, not a miss. */
export function workingSetCount(session: SessionLike): number {
  return (session.ex || []).reduce(
    (n, ex) => n + (ex.log || []).filter((s) => isWorkingSet(s as never)).length,
    0,
  )
}

/**
 * Where a session stands.
 *
 * `abandoned` is deliberately narrow: sets were logged, finish was never
 * pressed, and the day has rolled over. A session still open today is
 * in progress, however late it is — the athlete may yet come back to it.
 */
export function sessionState(session: SessionLike, opts: LifecycleOptions): SessionState {
  if (session.off) return 'rest'
  const logged = loggedSetCount(session)
  if (opts.finished) return 'complete'
  if (logged === 0) return 'not_started'
  return session.date < opts.today ? 'abandoned' : 'in_progress'
}

/** What each state contributes, in one place so nothing drifts. */
export interface StateContribution {
  volume: boolean
  plateau: boolean
  records: boolean
  streak: boolean
  progression: boolean
}

const CONTRIBUTIONS: Record<SessionState, StateContribution> = {
  complete: { volume: true, plateau: true, records: true, streak: true, progression: true },
  // the sets happened; the session did not finish
  abandoned: { volume: true, plateau: true, records: true, streak: false, progression: false },
  in_progress: { volume: true, plateau: true, records: true, streak: false, progression: false },
  not_started: { volume: false, plateau: false, records: false, streak: false, progression: false },
  rest: { volume: false, plateau: false, records: false, streak: false, progression: false },
}

export function contributionOf(state: SessionState): StateContribution {
  return CONTRIBUTIONS[state]
}

/**
 * Whether a history entry may drive a progression bump.
 *
 * Stored entries carry `abandoned` once the day rolls over without a
 * finish. An entry without the flag is treated as complete, which is how
 * every row written before this existed keeps behaving exactly as it did.
 */
export function countsForProgression(entry: HistoryEntry & { abandoned?: boolean }): boolean {
  return entry.abandoned !== true
}

/* ────────────────────────────────────────────────────────────────────
   Same as last time
   ──────────────────────────────────────────────────────────────────── */

export interface RepeatTarget {
  weight?: number
  reps?: number
  seconds?: number
  metres?: number
  kind?: string
  perSide?: boolean
  assisted?: boolean
}

/**
 * The previous session's working sets, ready to drop straight in.
 *
 * The fastest path for anyone not chasing progression that day: repeat what
 * you did. Returns null when there is nothing to repeat, so the caller can
 * hide the option rather than offering an empty one.
 */
export function sameAsLastTime(
  history: Array<HistoryEntry & { abandoned?: boolean }>,
  opts: { excludeDate?: string } = {},
): RepeatTarget[] | null {
  const usable = (history || []).filter(
    (e) => e && !e.off && e.date !== opts.excludeDate && (e.sets || []).some((s) => isWorkingSet(s)),
  )
  if (!usable.length) return null
  const last = usable[usable.length - 1]
  const sets = (last.sets || []).filter((s) => isWorkingSet(s))
  /* EQUIVALENT MUTANT (confirmed empirically): this guard can be removed
     with nothing able to catch it. `last` is drawn from `usable`, and
     `usable`'s own filter above already requires
     `(e.sets || []).some((s) => isWorkingSet(s))` — every entry that
     reaches `last` is guaranteed at least one working set, so filtering
     `last.sets` by the same predicate can never produce an empty array
     here. There is no reachable input where this guard fires. */
  if (!sets.length) return null
  return sets.map((s) => ({
    weight: s.w,
    reps: s.r,
    seconds: s.s,
    metres: s.m,
    kind: s.kind,
    perSide: s.perSide,
    assisted: s.assisted,
  }))
}
