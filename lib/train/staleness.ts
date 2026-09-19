/**
 * "You've run the same eight lifts for fourteen weeks."
 *
 * Trivially computable from what is already stored, and almost nobody
 * notices it about their own training — a routine becomes invisible by
 * being familiar.
 *
 * THE CONSTRAINT THAT MAKES THIS USEFUL RATHER THAN NAGGING.
 *
 * An unchanged routine that is still producing progress is NOT a problem.
 * Telling somebody whose lifts are climbing to change what they are doing
 * is the most expensive kind of wrong advice: they either ignore it, or
 * they take it and stop progressing. So staleness is never reported on
 * its own. It is reported only alongside a stall, where "you have been
 * doing this a long time" is an explanation rather than a complaint.
 *
 * AND A COMPLAINT WITH NO OPTION ATTACHED IS NOISE. When it fires it
 * names specific alternatives — from the same ranking smart swap uses, so
 * they keep the movement pattern and the muscles and respect the
 * equipment on hand. A lift with no catalog entry produces no finding at
 * all, because there is nothing to offer instead.
 *
 * WEEKS, NOT SESSIONS. Twenty sessions inside a fortnight is a busy
 * fortnight, not a stale routine.
 *
 * Pure and DOM-free.
 */

import { catalogExercise } from './catalog'
import { detectPlateau } from './deload'
import { rankSwaps, type SwapCandidate } from './swap'
import { daysBetween, dateKey } from './windows'
import type { History } from './analysis'

/** Weeks a lift must have been in rotation unchanged before it is stale. */
export const STALE_WEEKS = 12

/** Alternatives worth naming. More than a few is a menu, not a suggestion. */
const MAX_CANDIDATES = 3

export interface StalenessContext {
  history: History
  /** Stored definitions, for equipment and the swap ranking. */
  customLib: Record<string, unknown>
  /** Equipment on record or available today. */
  equipment: string[]
  now: number
}

export interface Staleness {
  exerciseId: string
  /** Weeks this lift has been in rotation unchanged. */
  weeks: number
  /** Alternatives that keep the movement and the muscles. */
  candidates: SwapCandidate[]
  /** One sentence, with the alternatives named. */
  text: string
}

const realSessions = (entries: History[string]) =>
  (entries || []).filter((e) => e && !e.off && e.date).sort((a, b) => a.date.localeCompare(b.date))

/**
 * Weeks since this lift entered the rotation.
 *
 * Measured from its FIRST session, not from the count of them — the
 * question is how long it has been there, and a lift trained twenty times
 * in a fortnight has been there a fortnight.
 */
function weeksInRotation(entries: History[string], now: number): number {
  const sessions = realSessions(entries)
  if (!sessions.length) return 0
  return Math.floor(daysBetween(sessions[0].date, dateKey(now)) / 7)
}

/**
 * Weeks since ANY lift was added to the routine.
 *
 * A routine where something arrived last week is not stale, however long
 * its oldest member has been there — the athlete is already changing
 * things, and saying otherwise would be the app not watching.
 */
function weeksSinceAnythingNew(history: History, now: number): number {
  let newest = 0
  for (const id of Object.keys(history || {})) {
    const sessions = realSessions(history[id])
    if (!sessions.length) continue
    const weeks = weeksInRotation(history[id], now)
    if (newest === 0 || weeks < newest) newest = weeks
  }
  return newest
}

/**
 * The stalest lift that has also stopped moving, or null.
 *
 * Null is the ordinary case: most routines are either young enough,
 * still working, or both.
 */
export function stalenessFor(ctx: StalenessContext): Staleness | null {
  const history = ctx.history || {}
  const ids = Object.keys(history)
  if (!ids.length) return null

  /* Nothing new anywhere for long enough. Checked first because it is one
     cheap read that disqualifies every lift at once. */
  if (weeksSinceAnythingNew(history, ctx.now) < STALE_WEEKS) return null

  const found: Staleness[] = []
  for (const id of ids) {
    const weeks = weeksInRotation(history[id], ctx.now)
    if (weeks < STALE_WEEKS) continue

    /* The whole point: still progressing is not a problem. */
    const plateau = detectPlateau(history[id], {})
    if (!plateau) continue

    const sessions: Record<string, number> = {}
    for (const other of ids) sessions[other] = realSessions(history[other]).length

    /* ONE gate, not two. A `!def` check and a `!candidates.length` check
       masked each other under mutation — with either removed the other
       still caught the unknown-lift case, so neither could be shown to
       matter. rankSwaps returns nothing for a null lift, so the empty
       list covers both: no catalog entry and no alternatives are the same
       fact, which is that there is nothing to offer instead. And a
       complaint with no option attached is the noise this avoids. */
    const def = catalogExercise(id)
    const candidates = def
      ? rankSwaps(def, { equipment: ctx.equipment || [], sessions }).slice(0, MAX_CANDIDATES)
      : []
    if (!candidates.length) continue

    const names = candidates.map((c) => c.name)
    found.push({
      exerciseId: id,
      weeks,
      candidates,
      /* States the fact and hands over the options. It does not say the
         routine is wrong — it says it has been the same for a long time
         and the lift has stopped moving, which are both true. */
      text: `${(def as NonNullable<typeof def>).name} has been in rotation ${weeks} weeks and has stopped moving. Same pattern, different stimulus: ${names.join(', ')}.`,
    })
  }

  if (!found.length) return null
  // the stalest, id as a tiebreak so the same history always reads the same
  found.sort((a, b) => b.weeks - a.weeks || a.exerciseId.localeCompare(b.exerciseId))
  return found[0]
}
