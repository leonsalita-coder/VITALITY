/**
 * What Train tells the rest of the dashboard.
 *
 * The premise of this app is that the tiles read each other, and Train
 * has been reading Vitals while publishing nothing — the richest data on
 * the board, exposed to no one. This is the other half of that read.
 *
 * TYPED VALUES, NEVER PROSE. Every consumer formats for its own surface.
 * A sentence from here would be Train deciding how another tile looks,
 * and the first consumer's phrasing would become everyone's.
 *
 * NEVER MORE THAN THE FACT. No exercise names, no per-set detail, no
 * notes, no pain flags. Another tile needs to know the session was hard,
 * not what was in it. Publishing less is the reversible choice: a field
 * withheld can be added when somebody needs it, and a field published is
 * one a consumer nobody has written yet may already depend on.
 *
 * PROVENANCE TRAVELS WITH THE VALUE. A logged number, a number computed
 * from logged numbers, and a number resting on a guess are three
 * different things. A consumer that cannot tell them apart will show a
 * guess as a measurement — which is the failure this whole engine is
 * built to avoid.
 *
 *   measured   logged by the athlete, or timed by the device
 *   derived    arithmetic over measured values
 *   estimated  rests on something self-reported or classified
 *
 * TRAIN MUST NOT KNOW WHO READS IT. No consumer-specific fields and no
 * formatting for a particular tile. It publishes what is true and stops.
 *
 * THE ASYMMETRY, RECORDED RATHER THAN FIXED. Train reads Vitals through
 * `read('vitals')`, which hands over that tile's whole private store —
 * not through this layer, which is narrow and typed and says where each
 * number came from. So the cross-read is disciplined in one direction
 * and not the other. Making Vitals publish the same way is a change to
 * another tile and a separate decision; it is noted here so the
 * difference is deliberate rather than forgotten.
 *
 * The same door is open on this tile: `read('train')` still returns
 * Train's entire saved state — exercise names, notes, photos and all —
 * because existing consumers were built against it. This module is what
 * makes closing that door possible later; it does not close it.
 *
 * Pure and DOM-free.
 */

import { attribute, type ExerciseIndex, type History } from './analysis'
import { acuteChronic } from './load'
import { readableEntries, workingSets, setWeight } from './sets'
import { SANE_BAND } from './load'
import type { OtherEntry } from './other'

/** Where a value came from. The whole point of the payload. */
export const PROVENANCE = ['measured', 'derived', 'estimated'] as const
export type Provenance = (typeof PROVENANCE)[number]

/** Whether the day was trained, deliberately rested, or simply empty. */
export const TRAINED_STATES = ['trained', 'rest', 'not_trained'] as const
export type TrainedState = (typeof TRAINED_STATES)[number]

export interface Metric {
  /** Stable, machine-readable. Never a label. */
  key: string
  /** Null where the metric is purely categorical. */
  value: number | null
  /**
   * The categorical value, where a number cannot carry it.
   *
   * `trained` is the reason this exists: a rest day and an empty day are
   * both "no training" numerically and are not the same fact about a
   * person, and flattening them would lose the distinction permanently.
   */
  state?: string
  /** Null for a ratio or a count of things with no unit. */
  unit: string | null
  /** The local day this describes, YYYY-MM-DD. */
  date: string
  provenance: Provenance
}

export interface MetricsContext {
  /** The day being described. */
  date: string
  history: History
  index: ExerciseIndex
  finishedDates: string[]
  bodyweight: Array<{ date: string; lb: number }>
  otherTraining: OtherEntry[]
  /** How many lifts are mid-deload. A count, not which ones. */
  deloadLifts: number
  /** The verdict, if the readiness read produced one. */
  readiness: string | null
  /** Seconds, where the session was actually timed. */
  sessionSeconds: number | null
  /** False for a migrated or inferred timestamp, which is not a measurement. */
  sessionTimingObserved: boolean
  /** Sessions a week the athlete said they intend to train. */
  streakTarget: number | null
  /** The kind of record set today, if any. */
  pr: string | null
  now: number
}

const round = (n: number, p = 2) => Math.round(n * 10 ** p) / 10 ** p

/** Entries logged on the day being described, rest days included. */
function entriesOn(ctx: MetricsContext) {
  const out = []
  for (const id of Object.keys(ctx.history || {})) {
    for (const entry of readableEntries(ctx.history[id], { includeOff: true })) {
      if (entry.date === ctx.date) out.push(entry)
    }
  }
  return out
}

/**
 * Trained, rested, or neither.
 *
 * A rest day is a decision and an empty day is an absence; a consumer
 * that treats them alike would congratulate somebody for resting when
 * they simply did not open the app. A day of warm-ups is not training
 * either — nothing was worked.
 */
function trainedState(ctx: MetricsContext): TrainedState {
  const today = entriesOn(ctx)
  if (today.some((e) => !e.off && workingSets(e).length > 0)) return 'trained'
  if (today.some((e) => e.off)) return 'rest'
  return 'not_trained'
}

export function publishedMetrics(ctx: MetricsContext): Metric[] {
  const date = ctx.date
  const out: Metric[] = []
  const add = (
    key: string, value: number | null, unit: string | null,
    provenance: Provenance, state?: string,
  ) => out.push({ key, value, ...(state ? { state } : {}), unit, date, provenance })

  const state = trainedState(ctx)
  add('trained', state === 'trained' ? 1 : 0, null, 'measured', state)

  /* Working sets are counted, not inferred: a logged set is a fact. */
  const worked = entriesOn(ctx).filter((e) => !e.off)
  const hardSets = worked.reduce((n, e) => n + workingSets(e).length, 0)
  add('hard_sets', hardSets, 'sets', 'measured')

  let tonnage = 0
  for (const entry of worked) {
    for (const set of workingSets(entry)) tonnage += setWeight(entry, set) * (set.r || 0)
  }
  add('tonnage', Math.round(tonnage), 'lb', 'derived')

  /* Per muscle, the split is the question. An authored contribution is
     arithmetic over logged sets; a classifier's guess about which muscle
     a name belongs to is not. */
  const rows = attribute(ctx.history || {}, ctx.index || {}).filter((r) => r.date === date)
  const byMuscle = new Map<string, { sets: number; estimated: boolean }>()
  for (const r of rows) {
    const t = byMuscle.get(r.muscle) || { sets: 0, estimated: false }
    t.sets += r.sets
    t.estimated = t.estimated || r.estimated
    byMuscle.set(r.muscle, t)
  }
  for (const [muscle, t] of [...byMuscle.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    add(`hard_sets.${muscle}`, round(t.sets, 1), 'sets', t.estimated ? 'estimated' : 'derived')
  }

  /* Only where the clock actually ran. A migrated timestamp is a guess
     wearing a measurement's shape, so it is withheld entirely rather
     than published with a caveat nobody has to read. */
  if (ctx.sessionTimingObserved && ctx.sessionSeconds != null && ctx.sessionSeconds > 0) {
    add('session_duration', Math.round(ctx.sessionSeconds), 's', 'measured')
  }

  /* Systemic load, and only when its baseline is real — an unusable
     ratio is arithmetic against a decayed denominator, which is exactly
     the returning-athlete trap. */
  const snapshot = acuteChronic({
    history: ctx.history || {}, index: ctx.index || {},
    otherTraining: ctx.otherTraining || [], now: ctx.now,
  })
  const systemic = snapshot.systemic
  if (systemic.usable) {
    const prov: Provenance = systemic.estimated ? 'estimated' : 'derived'
    const band = systemic.ratio > SANE_BAND[1] ? 'over'
      : systemic.ratio < SANE_BAND[0] ? 'under' : 'in'
    add('load_ratio', systemic.ratio, null, prov, band)
  }

  if (ctx.readiness) add('readiness', null, null, 'derived', ctx.readiness)

  /* A count, never which lifts — the shape of the programme is the
     fact; its contents are the tile's own business. */
  add('deload_lifts', Math.max(0, ctx.deloadLifts || 0), 'lifts', 'derived')

  if (ctx.pr) add('pr', 1, null, 'derived', ctx.pr)

  /* The streak against the target the athlete chose, never a default
     they never picked — see targets.ts. */
  const weekAgo = new Date(ctx.now)
  weekAgo.setDate(weekAgo.getDate() - 6)
  const from = `${weekAgo.getFullYear()}-${String(weekAgo.getMonth() + 1).padStart(2, '0')}-${String(weekAgo.getDate()).padStart(2, '0')}`
  const sessions = new Set((ctx.finishedDates || []).filter((d) => d >= from && d <= date)).size
  add('streak_sessions', sessions, 'sessions', 'measured')
  if (typeof ctx.streakTarget === 'number') {
    add('streak_target', ctx.streakTarget, 'sessions', 'measured')
  }

  const weighed = (ctx.bodyweight || []).filter((b) => b && b.date === date && typeof b.lb === 'number')
  if (weighed.length) add('bodyweight', weighed[weighed.length - 1].lb, 'lb', 'measured')

  return out
}
