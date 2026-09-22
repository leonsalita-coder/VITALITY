/**
 * The reads the closed muscle list makes possible.
 *
 * Every one of these was impossible while "Pecs" and "Chest" were separate
 * muscles: nothing ever accumulated enough volume under a single name to
 * cross a threshold, so every check silently returned nothing.
 *
 * Four rules run the whole file:
 *
 *   deterministic  — same input, same findings, no clock read inside
 *   pure           — no DOM, no storage, `now` passed in
 *   gated          — nothing is said until there is enough data to mean it
 *   silent         — no finding is better than a vague one
 *
 * That last rule is the load-bearing one. An observation that fires on thin
 * data teaches the athlete to ignore observations.
 */

import { distribute, muscleSplitFrom, PULL_MUSCLES, PUSH_MUSCLES, type Muscle, type MuscleSplit } from './muscles'
import { readableEntries, workingSets, type HistoryEntry } from './sets'
import { weeklySetBand } from './targets'
import type { TrainingAge } from './onboarding'
import { deltaOf, inWindow, rollingWindow } from './windows'
import { loadFindings } from './load'
import type { OtherEntry } from './other'

/** Days without training a muscle before that is worth mentioning. */
export const GAP_DAYS = 14

/**
 * Weekly hard sets per muscle that most people grow on.
 *
 * Retained as the shape of the shipped default only. The live band comes
 * from `weeklySetBand`, which scales it to the athlete — see targets.ts
 * for why the floor and the ceiling are deliberately not symmetric.
 */
export const WEEKLY_SET_BAND: [number, number] = [10, 20]

/** What the analysis needs to know about the person it is analysing. */
export interface AnalysisOptions {
  trainingAge?: TrainingAge | null
  /**
   * Self-reported training that isn't lifting.
   *
   * Reaches the systemic load index only — never a muscle's hard sets.
   * See other.ts, which is emphatic about why.
   */
  otherTraining?: OtherEntry[]
}

/** A ratio outside this in either direction is worth flagging. */
export const RATIO_BAND: [number, number] = [0.6, 1.7]

/* RAMP_LIMIT lived here and is gone: the week-over-week threshold it
   named was replaced by the acute-versus-chronic model in load.ts, and a
   constant nothing reads is a claim about behaviour that no longer
   happens. See volumeRamp below, which delegates. */

const DAY_MS = 86_400_000

export interface Finding {
  kind: 'frequency_gap' | 'weekly_sets' | 'ratio' | 'volume_ramp'
  muscle?: Muscle
  /** One sentence, ready to render. */
  text: string
  /** True when it rests on guessed muscle splits. */
  estimated: boolean
}

/** Everything the analysis needs to know about one exercise. */
export interface ExerciseIndex {
  [exerciseId: string]: MuscleSplit
}

/** Builds the index from stored definitions, mapping on read. */
export function indexFrom(customLib: Record<string, unknown>): ExerciseIndex {
  const out: ExerciseIndex = {}
  for (const id of Object.keys(customLib || {})) out[id] = muscleSplitFrom(customLib[id])
  return out
}

function localMidnight(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, (m || 1) - 1, d || 1).getTime()
}

function startOfDay(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

function daysAgo(dateStr: string, now: number): number {
  return Math.round((startOfDay(now) - localMidnight(dateStr)) / DAY_MS)
}

export interface History {
  [exerciseId: string]: HistoryEntry[]
}

export interface Attribution {
  /**
   * The lift the sets came from.
   *
   * Carried so a caller can weight a muscle's reading by which lifts
   * contributed, without re-deriving the split. The alternative was a
   * second answer to "which muscle did this set belong to", which is
   * how two screens come to disagree.
   */
  exerciseId: string
  muscle: Muscle
  sets: number
  date: string
  estimated: boolean
}

/**
 * Every muscle-set the record contains, one row per muscle per session.
 *
 * Exported because the weekly change analysis reads the same attribution
 * rather than computing its own — a second implementation of "which
 * muscle did this set belong to" is how two screens come to disagree.
 */
export function attribute(history: History, index: ExerciseIndex): Attribution[] {
  const rows: Attribution[] = []
  for (const id of Object.keys(history || {})) {
    const split = index[id]
    if (!split || (!split.primary.length && !split.secondary.length)) continue
    for (const entry of readableEntries(history[id])) {
      const sets = workingSets(entry).length
      if (!sets) continue
      const spread = distribute(sets, split)
      for (const muscle of Object.keys(spread) as Muscle[]) {
        rows.push({ exerciseId: id, muscle, sets: spread[muscle] || 0, date: entry.date, estimated: split.estimated })
      }
    }
  }
  return rows
}

const round = (n: number) => Math.round(n * 10) / 10

/**
 * Muscles that were being trained and then stopped.
 *
 * Gated on having been trained at least twice: once is not a habit, and
 * calling a single session six weeks ago a "gap" is noise.
 */
export function frequencyGaps(history: History, index: ExerciseIndex, now: number): Finding[] {
  const rows = attribute(history, index)
  const byMuscle = new Map<Muscle, { dates: Set<string>; last: string; estimated: boolean }>()
  for (const row of rows) {
    const seen = byMuscle.get(row.muscle) || { dates: new Set<string>(), last: row.date, estimated: false }
    seen.dates.add(row.date)
    if (row.date > seen.last) seen.last = row.date
    seen.estimated = seen.estimated || row.estimated
    byMuscle.set(row.muscle, seen)
  }

  const findings: Finding[] = []
  for (const [muscle, seen] of byMuscle) {
    if (seen.dates.size < 2) continue // not yet a habit to have broken
    const gap = daysAgo(seen.last, now)
    if (gap < GAP_DAYS) continue
    findings.push({
      kind: 'frequency_gap',
      muscle,
      text: `${label(muscle)} haven't been trained in ${gap} days.`,
      estimated: seen.estimated,
    })
  }
  return findings.sort((a, b) => a.text.localeCompare(b.text))
}

/**
 * The athlete's own hard sets per week for one muscle, across the four
 * weeks BEFORE this one.
 *
 * Null until there is enough record to call it a norm — two covered weeks
 * minimum, and weeks before their first ever session are not counted as
 * zeroes, because "you did nothing in a week you had not started yet" is
 * not evidence about anybody.
 */
function trailingAverage(rows: Attribution[], muscle: Muscle, now: number): number | null {
  const mine = rows.filter((r) => r.muscle === muscle)
  /* No empty check: with no rows the oldest is 0, the first week already
     predates it, and `covered < 2` returns null on its own. */
  const oldest = mine.reduce((max, r) => Math.max(max, daysAgo(r.date, now)), 0)

  let total = 0
  let covered = 0
  for (let week = 1; week <= 4; week++) {
    const from = week * 7
    if (from > oldest) break // this week predates their first session
    covered++
    total += mine
      .filter((r) => {
        const age = daysAgo(r.date, now)
        return age >= from && age <= from + 6
      })
      .reduce((n, r) => n + r.sets, 0)
  }
  if (covered < 2) return null
  return total / covered
}

/**
 * Hard sets per muscle over the last seven days, against a band that
 * belongs to this athlete.
 *
 * The ceiling is absolute and the floor is theirs: see targets.ts. When
 * there is no floor to speak of, under-volume is simply not reported —
 * telling a beginner they are under a number they never chose is the app
 * being confidently wrong about someone who is doing fine.
 */
export function weeklySets(
  history: History,
  index: ExerciseIndex,
  now: number,
  opts: AnalysisOptions = {},
): Finding[] {
  const all = attribute(history, index)
  const rows = all.filter((r) => daysAgo(r.date, now) <= 6 && daysAgo(r.date, now) >= 0)

  const totals = new Map<Muscle, { sets: number; estimated: boolean }>()
  for (const row of rows) {
    const t = totals.get(row.muscle) || { sets: 0, estimated: false }
    t.sets += row.sets
    t.estimated = t.estimated || row.estimated
    totals.set(row.muscle, t)
  }

  const findings: Finding[] = []
  for (const [muscle, t] of totals) {
    const sets = round(t.sets)
    const band = weeklySetBand({
      trainingAge: opts.trainingAge,
      trailingSets: trailingAverage(all, muscle, now),
    })

    if (sets > band.ceiling) {
      findings.push({
        kind: 'weekly_sets',
        muscle,
        text: `${label(muscle)} took ${sets} hard sets this week, above the ${band.ceiling}-set band.`,
        estimated: t.estimated,
      })
      continue
    }
    if (band.floor == null || sets <= 0 || sets >= band.floor) continue
    if (band.floorSource === 'trailing') {
      findings.push({
        kind: 'weekly_sets',
        muscle,
        text: `${label(muscle)} got ${sets} hard sets this week, well under your recent average of ${round(band.floor / 0.6)}.`,
        estimated: t.estimated,
      })
      continue
    }
    /* An age-profile floor is still somebody else's number, softened by
       the gate that shipped: it only means something once they train
       enough for "under" to be a choice rather than a starting point. */
    if (totals.size >= 3) {
      findings.push({
        kind: 'weekly_sets',
        muscle,
        text: `${label(muscle)} got ${sets} hard sets this week, under the ${band.floor}-set band.`,
        estimated: t.estimated,
      })
    }
  }
  return findings.sort((a, b) => a.text.localeCompare(b.text))
}

function sumOf(rows: Attribution[], muscles: Muscle[]): number {
  return rows.filter((r) => muscles.includes(r.muscle)).reduce((n, r) => n + r.sets, 0)
}

/**
 * Push against pull, and quad against hamstring, over a rolling window.
 *
 * Gated on the PAIR carrying real volume rather than on each side doing
 * so, because a month of pressing with almost no pulling is precisely the
 * finding — requiring a minimum from the weak side would silence it.
 */
export function ratios(history: History, index: ExerciseIndex, now: number, days = 28): Finding[] {
  const rows = attribute(history, index).filter((r) => {
    const age = daysAgo(r.date, now)
    return age >= 0 && age <= days
  })
  const estimated = rows.some((r) => r.estimated)

  const findings: Finding[] = []
  /**
   * Gated on the PAIR carrying real volume, not on each side doing so.
   * Requiring a minimum from the weaker side would silence the one case
   * most worth saying out loud — a month of pressing with almost no
   * pulling is the finding, not a reason to withhold it.
   */
  /* High enough that one session cannot produce a verdict on someone's
     balance: 20 combined hard sets across a movement pair inside the
     window is a pattern, 12 is a Tuesday. */
  const MIN_TOTAL = 20
  const MIN_STRONG = 6
  const check = (aName: string, bName: string, a: Muscle[], b: Muscle[]) => {
    const left = sumOf(rows, a)
    const right = sumOf(rows, b)
    if (left + right < MIN_TOTAL) return
    if (Math.max(left, right) < MIN_STRONG) return
    if (right < 1 || left < 1) {
      const [busy, idle, busyName, idleName] =
        left > right ? [left, right, aName, bName] : [right, left, bName, aName]
      findings.push({
        kind: 'ratio',
        text: `${round(busy)} sets of ${busyName.toLowerCase()} work in ${days} days and almost none of ${idleName.toLowerCase()}.`,
        estimated,
      })
      return
    }
    const ratio = left / right
    if (ratio >= RATIO_BAND[0] && ratio <= RATIO_BAND[1]) return
    findings.push({
      kind: 'ratio',
      text: `${aName} to ${bName} is running ${round(ratio)}:1 over the last ${days} days (${round(left)} vs ${round(right)} sets).`,
      estimated,
    })
  }
  check('Push', 'pull', PUSH_MUSCLES, PULL_MUSCLES)
  check('Quads', 'hamstrings', ['quads'], ['hamstrings'])
  return findings
}

/**
 * Muscles whose recent load is well away from what they are used to.
 *
 * This DELEGATES to the acute-versus-chronic model rather than keeping a
 * week-over-week threshold of its own. The old version fired when this
 * week was 1.5x last week, which says nothing about how used to the work
 * the athlete is: doubling from two sets to four tripped it, and a lifter
 * on twenty sets a week absorbing a jump to twenty-six did not. The
 * replacement compares recent load against a month of it, and states both
 * numbers.
 *
 * Kept as a name because `analyse` and the tile both call it, and because
 * one authority for "is this muscle's volume unusual" is the whole point —
 * a second implementation beside it is how two screens come to disagree.
 */
export function volumeRamp(
  history: History,
  index: ExerciseIndex,
  now: number,
  otherTraining: OtherEntry[] = [],
): Finding[] {
  return loadFindings({ history, index, otherTraining, now }).map((found) => ({
    kind: 'volume_ramp' as const,
    muscle: found.muscle,
    text: found.text,
    estimated: found.estimated,
  }))
}

/** Every finding worth making, or an empty list when there is nothing to say. */
export function analyse(
  history: History,
  index: ExerciseIndex,
  now: number,
  opts: AnalysisOptions = {},
): Finding[] {
  return [
    ...frequencyGaps(history, index, now),
    ...weeklySets(history, index, now, opts),
    ...volumeRamp(history, index, now, opts.otherTraining || []),
    ...ratios(history, index, now),
  ]
}

function label(muscle: Muscle): string {
  return muscle.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}
