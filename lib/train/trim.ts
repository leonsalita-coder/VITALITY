/**
 * Shortening a session that already exists.
 *
 * The coach honours a time budget when it GENERATES a session, which
 * helps nobody already standing in the gym with forty minutes and a
 * session built for ninety. Being short on time is one of the most common
 * reasons a session gets skipped entirely, and skipped entirely is the
 * worse outcome by a distance — a trimmed session is training, and no
 * session is not.
 *
 * A PROPOSAL, NEVER A MUTATION. Nothing here touches the session. It
 * returns what it would do and why; accepting it is the athlete's, and
 * the tile applies it. That separation is not politeness — a function
 * that both decides and edits cannot be asked "what would you do" by a
 * screen that wants to show the answer before doing it.
 *
 * WHAT IT CUTS FIRST, and why that order.
 *
 * Tier before everything: a squat is the session and a lateral raise is
 * the garnish. Then muscles that need the work — a muscle under its
 * weekly band or untrained lately is the last thing to cut, because
 * cutting it is how an imbalance the app already noticed gets worse.
 * Then reduce before dropping, because three sets of something beats
 * none of it.
 *
 * WHAT IT WILL NOT DO. It never removes a logged set — those happened —
 * and never reduces a lift below the sets already in the log. It avoids
 * dropping a lift mid-deload or mid-reapproach, because the state machine
 * assumes that lift gets trained and a skipped session silently stalls
 * the sequence; where it has no choice, it says so out loud.
 *
 * Pure and DOM-free.
 */

import { restTaken } from './timing'
import type { DeloadRecord } from './deload'
import type { History } from './analysis'

/** Working time per set when nothing better is known. */
export const DEFAULT_SECONDS_PER_SET = 45

/**
 * Observed rest gaps needed before the measurement beats the default.
 *
 * Two, not more: the default is a flat guess for everybody, so even a
 * thin measurement of THIS athlete is better than it. The bar that
 * matters is not quantity, it is that the timestamps were observed
 * rather than invented — see restTaken, which refuses estimated ones.
 */
const MIN_TIMED_GAPS = 2

export interface TrimExercise {
  id: string
  name: string
  tier: number
  sets: number
  rest: number
  /** Logged sets; nulls are unlogged. Never shortened past these. */
  log: Array<unknown | null>
  /** Muscles this lift trains, for the priority reads. */
  muscles?: string[]
}

export interface TrimContext {
  exercises: TrimExercise[]
  /** The budget, in minutes. */
  minutes: number
  history: History
  deloadStates: Record<string, DeloadRecord | null>
  /** Muscles currently under their weekly band. */
  underBandMuscles: string[]
  /** Muscles not trained recently. */
  staleMuscles: string[]
  now: number
}

export interface TrimDecision {
  id: string
  name: string
  /** Sets after the proposal. Equal to the original for a kept lift. */
  sets: number
  reason: string
}

export interface TrimPlan {
  keep: TrimDecision[]
  reduce: TrimDecision[]
  drop: TrimDecision[]
  /** Minutes the session takes as it stands. */
  before: number
  /** Minutes the proposal would take. */
  estimatedMinutes: number
  /** Where the per-set figure came from. */
  basis: 'observed' | 'default'
  secondsPerSet: number
  /** Things the athlete should know before accepting. */
  warnings: string[]
}

/**
 * Seconds a working set actually takes this athlete.
 *
 * Read from observed timestamps where there are enough of them, and
 * refused where they are estimated — an imported history carries
 * plausible-looking times nobody measured, and a budget computed from
 * those is a confident number about a stranger.
 */
function perSetSeconds(ctx: TrimContext): { seconds: number; basis: 'observed' | 'default' } {
  const gaps: number[] = []
  for (const id of Object.keys(ctx.history || {})) {
    for (const entry of ctx.history[id] || []) {
      /* restTaken already refuses estimated timestamps and breaks the
         chain around missing ones, so its gaps are observed by
         construction. A `hasObservedTiming` check here would be a second
         guard saying the same thing, and one nothing could falsify. */
      gaps.push(...restTaken(entry).gaps)
    }
  }
  if (gaps.length < MIN_TIMED_GAPS) {
    return { seconds: DEFAULT_SECONDS_PER_SET, basis: 'default' }
  }
  /* The observed gap is work PLUS rest, so the per-set working time is
     what is left after the prescribed rest — floored, because a gap
     shorter than the rest means they were not resting, not that the set
     took negative time. */
  const median = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)]
  const rests = ctx.exercises.map((e) => e.rest || 0)
  const typicalRest = rests.length ? rests.reduce((a, b) => a + b, 0) / rests.length : 0
  return { seconds: Math.max(10, Math.round(median - typicalRest)), basis: 'observed' }
}

const minutesFor = (sets: number, rest: number, perSet: number) =>
  (sets * (perSet + (rest || 0))) / 60

const round = (n: number) => Math.round(n * 10) / 10

/** Sets already logged. The floor below which nothing may be reduced. */
const loggedSets = (e: TrimExercise) => (e.log || []).filter(Boolean).length

function midDeload(ctx: TrimContext, id: string): string | null {
  const record = (ctx.deloadStates || {})[id]
  if (!record) return null
  if (record.state === 'deloading') return 'deload'
  if (record.state === 'reapproach') return 'reapproach'
  return null
}

/**
 * How reluctant we are to lose this lift. Higher survives longer.
 *
 * Deliberately a total order rather than a set of rules applied in turn:
 * rules applied in turn need a tiebreak anyway, and an explicit score is
 * something a reason string can be written from.
 */
function keepScore(e: TrimExercise, ctx: TrimContext): { score: number; why: string } {
  let score = 0
  const why: string[] = []

  if (loggedSets(e) > 0) {
    score += 1000
    why.push('already part-logged')
  }
  if (midDeload(ctx, e.id)) {
    score += 500
    why.push(`mid-${midDeload(ctx, e.id)}`)
  }
  /* Tier 1 is the session; tier 3 is the garnish. */
  score += (4 - Math.min(3, Math.max(1, e.tier || 2))) * 100

  const muscles = e.muscles || []
  if (muscles.some((m) => (ctx.underBandMuscles || []).includes(m))) {
    score += 60
    why.push('under its weekly band')
  }
  if (muscles.some((m) => (ctx.staleMuscles || []).includes(m))) {
    score += 40
    why.push('not trained lately')
  }
  return { score, why: why.join(', ') }
}

/**
 * What to cut to fit the budget.
 *
 * Reduce first across everything reducible, then drop from the least
 * defensible upward — in that order because three sets of a lift beats
 * none of it, and because a session that keeps its shape is one somebody
 * will actually do.
 */
export function trimSession(ctx: TrimContext): TrimPlan {
  const exercises = (ctx.exercises || []).slice()
  const { seconds: perSet, basis } = perSetSeconds(ctx)
  const budget = typeof ctx.minutes === 'number' && Number.isFinite(ctx.minutes) && ctx.minutes > 0
    ? ctx.minutes
    : 0

  const before = round(
    exercises.reduce((total, e) => total + minutesFor(e.sets, e.rest, perSet), 0),
  )

  const base: TrimPlan = {
    keep: [], reduce: [], drop: [],
    before, estimatedMinutes: before, basis, secondsPerSet: perSet, warnings: [],
  }

  const scored = exercises.map((e) => ({ e, ...keepScore(e, ctx) }))
  /* Least defensible first, id as the tiebreak so the same session always
     produces the same proposal. */
  const order = [...scored].sort((a, b) => a.score - b.score || a.e.id.localeCompare(b.e.id))

  const planned = new Map(exercises.map((e) => [e.id, e.sets]))
  const total = () =>
    exercises.reduce((sum, e) => sum + minutesFor(planned.get(e.id) as number, e.rest, perSet), 0)

  if (!budget || total() <= budget) {
    for (const { e, why } of scored) {
      base.keep.push({ id: e.id, name: e.name, sets: e.sets, reason: why || 'fits the time' })
    }
    base.estimatedMinutes = round(total())
    return base
  }

  /**
   * One cut at a time, always the least defensible lift, until it fits.
   *
   * Reducing everything before dropping anything was the first version
   * and it was wrong: six lifts at one set each fits inside thirty
   * minutes, and is worse training than three lifts at three sets. An
   * accessory is dropped outright, and a compound is shaved a set — so
   * the session keeps its shape rather than being evenly diluted.
   */
  const dropped = new Set<string>()
  const ACCESSORY_TIER = 3
  let guard = exercises.length * 20

  while (total() > budget && guard-- > 0) {
    let cut = false
    for (const { e } of order) {
      if (dropped.has(e.id)) continue
      const current = planned.get(e.id) as number
      const logged = loggedSets(e)

      /* An accessory nobody has touched goes whole, rather than being
         thinned to a single token set — but only while other work would
         survive it. One set of the last lift standing beats none of it,
         and a proposal that empties the session is one nobody accepts. */
      const surviving = exercises.filter(
        (x) => !dropped.has(x.id) && (planned.get(x.id) as number) > 0,
      ).length
      if ((e.tier || 2) >= ACCESSORY_TIER && logged === 0 && surviving > 1) {
        dropped.add(e.id)
        planned.set(e.id, 0)
        cut = true
        break
      }
      if (current > Math.max(1, logged)) {
        planned.set(e.id, current - 1)
        cut = true
        break
      }
    }
    if (cut) continue

    /* Nothing left to shave. Drop the least defensible untouched lift —
       a compound, by this point — rather than reporting a plan that does
       not fit. */
    const next = order.find(({ e }) => !dropped.has(e.id) && loggedSets(e) === 0)
    if (!next) break
    dropped.add(next.e.id)
    planned.set(next.e.id, 0)
  }

  const warnings: string[] = []
  for (const id of dropped) {
    const state = midDeload(ctx, id)
    if (state) {
      const e = exercises.find((x) => x.id === id) as TrimExercise
      warnings.push(
        `${e.name} is mid-${state} — the programme expects it trained, and skipping it holds that sequence where it is.`,
      )
    }
  }
  if (total() > budget) {
    warnings.push('Even trimmed, this runs over — every remaining lift is either logged or the last set of something.')
  }

  for (const { e, why } of scored) {
    const sets = planned.get(e.id) as number
    if (sets === 0) {
      base.drop.push({ id: e.id, name: e.name, sets: 0, reason: dropReason(e, ctx, why) })
    } else if (sets < e.sets) {
      base.reduce.push({
        id: e.id, name: e.name, sets,
        reason: `${e.sets} sets down to ${sets}${why ? ` — ${why}` : ''}`,
      })
    } else {
      base.keep.push({ id: e.id, name: e.name, sets, reason: why || 'kept in full' })
    }
  }
  base.estimatedMinutes = round(total())
  base.warnings = warnings
  return base
}

function dropReason(e: TrimExercise, ctx: TrimContext, why: string): string {
  const state = midDeload(ctx, e.id)
  if (state) return `dropped for time, but it is mid-${state}`
  if (why) return `dropped for time, despite being ${why}`
  return (e.tier || 2) >= 3 ? 'accessory, dropped for time' : 'dropped for time'
}
