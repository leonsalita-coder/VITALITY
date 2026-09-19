/**
 * The weekly review.
 *
 * Same engine as the post-session note, a wider window, and the only thing
 * that speaks on the days you do not train.
 *
 * Returned as DATA rather than a rendered string, so the same review can be
 * shown in the tile, written into the note, or pushed as a notification
 * later without any of it being rewritten. A function that returns prose
 * has already decided where the prose goes.
 *
 * Deterministic first: every number here comes from analysis.ts. A model,
 * if one is asked at all, writes the sentence around figures it did not
 * choose.
 *
 * Pure and DOM-free.
 */

import {
  analyse, indexFrom, WEEKLY_SET_BAND,
  type ExerciseIndex, type Finding, type History,
} from './analysis'
import { distribute, type Muscle, type MuscleSplit } from './muscles'
import { topWorkingWeight, workingSets, type HistoryEntry } from './sets'
import type { TrainingAge } from './onboarding'


export type Band = 'under' | 'in' | 'over'

export interface MuscleWeek {
  muscle: Muscle
  sets: number
  band: Band
}

export interface LiftMovement {
  exerciseId: string
  name: string
  from: number
  to: number
}

export interface WeeklyReview {
  from: string
  to: string
  /** Sessions finished in the window, against the athlete's target. */
  sessions: number
  target: number
  metTarget: boolean
  hardSetsByMuscle: MuscleWeek[]
  /** Lifts whose working weight went up inside the window. */
  moved: LiftMovement[]
  /** Muscles trained before but not in this window. */
  quiet: Muscle[]
  findings: Finding[]
  /** True when there is genuinely nothing worth reporting. */
  quiet_week: boolean
  /** The deterministic one-liner. Never invented. */
  headline: string
  /** Whether any figure rests on a guessed muscle split. */
  estimated: boolean
}

function dateKey(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function shift(now: number, days: number): string {
  const d = new Date(now)
  d.setDate(d.getDate() + days)
  return dateKey(d.getTime())
}

function bandOf(sets: number): Band {
  if (sets > WEEKLY_SET_BAND[1]) return 'over'
  if (sets < WEEKLY_SET_BAND[0]) return 'under'
  return 'in'
}

export interface ReviewContext {
  history: History
  customLib: Record<string, unknown>
  exerciseNames: Record<string, string>
  finishedDates: string[]
  weeklyTarget: number
  /** Scales the volume bands. Absent means the shipped numbers. */
  trainingAge?: TrainingAge | null
  now: number
}

const round = (n: number) => Math.round(n * 10) / 10

/** The rolling seven days, as data. */
export function weeklyReview(ctx: ReviewContext): WeeklyReview {
  const to = dateKey(ctx.now)
  const from = shift(ctx.now, -6)
  const index: ExerciseIndex = indexFrom(ctx.customLib || {})

  const inWindow = (date: string) => date >= from && date <= to
  const sessions = new Set((ctx.finishedDates || []).filter(inWindow)).size

  /* Hard sets per muscle, and which lifts moved, in one pass. */
  const perMuscle = new Map<Muscle, number>()
  const moved: LiftMovement[] = []
  const trainedEver = new Set<Muscle>()
  const trainedNow = new Set<Muscle>()
  let estimated = false

  for (const id of Object.keys(ctx.history || {})) {
    const split: MuscleSplit | undefined = index[id]
    const rows = (ctx.history[id] || []).filter((e) => e && !e.off) as HistoryEntry[]
    if (!rows.length) continue

    if (split && (split.primary.length || split.secondary.length)) {
      split.primary.forEach((c) => trainedEver.add(c.muscle))
      for (const entry of rows) {
        const sets = workingSets(entry).length
        if (!sets || !inWindow(entry.date)) continue
        if (split.estimated) estimated = true
        const spread = distribute(sets, split)
        for (const muscle of Object.keys(spread) as Muscle[]) {
          perMuscle.set(muscle, (perMuscle.get(muscle) || 0) + (spread[muscle] || 0))
          trainedNow.add(muscle)
        }
      }
    }

    const window = rows.filter((e) => inWindow(e.date))
    if (window.length >= 2) {
      const first = topWorkingWeight(window[0])
      const last = topWorkingWeight(window[window.length - 1])
      if (last > first && first > 0) {
        moved.push({ exerciseId: id, name: ctx.exerciseNames[id] || id, from: first, to: last })
      }
    }
  }

  const hardSetsByMuscle: MuscleWeek[] = [...perMuscle.entries()]
    .map(([muscle, sets]) => ({ muscle, sets: round(sets), band: bandOf(sets) }))
    .sort((a, b) => b.sets - a.sets)

  const quiet = [...trainedEver].filter((m) => !trainedNow.has(m)).sort()
  const findings = analyse(ctx.history, index, ctx.now, { trainingAge: ctx.trainingAge })

  /* A week is quiet when nothing happened AND nothing was found. Reporting
     "you did nothing" at length is padding; saying it once is honest. */
  const quiet_week = sessions === 0 && !findings.length && !moved.length

  const headline = quiet_week
    ? 'No sessions this week and nothing new in the numbers.'
    : `${sessions} of ${ctx.weeklyTarget} sessions` +
      (moved.length ? `, ${moved.length} lift${moved.length === 1 ? '' : 's'} up` : '') +
      (findings.length ? `, ${findings.length} thing${findings.length === 1 ? '' : 's'} to note` : '')

  return {
    from,
    to,
    sessions,
    target: ctx.weeklyTarget,
    metTarget: sessions >= ctx.weeklyTarget,
    hardSetsByMuscle,
    moved: moved.sort((a, b) => b.to - b.from - (a.to - a.from)),
    quiet,
    findings,
    quiet_week,
    headline,
    estimated,
  }
}

/** Whether the review is worth surfacing at all. */
export function reviewWorthSending(review: WeeklyReview): boolean {
  return !review.quiet_week
}
