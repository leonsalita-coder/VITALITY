/**
 * The series the Progress tab draws.
 *
 * Computed here rather than in the tile so each one is testable, and so a
 * chart cannot quietly disagree with the finding that sits beside it.
 *
 * Every point carries the date it came from, because a chart you cannot tap
 * back to its source session is a picture rather than a record.
 *
 * Pure and DOM-free.
 */

import { WEEKLY_SET_BAND, type ExerciseIndex, type History } from './analysis'
import { distribute, type Muscle } from './muscles'
import { epley1RM } from './records'
import { setWeight, workingSets, type HistoryEntry } from './sets'

const DAY_MS = 86_400_000

export interface Point {
  date: string
  value: number
  /** True when the figure rests on a guessed muscle split. */
  estimated?: boolean
}

function dateKey(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function localMidnight(date: string): number {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y, (m || 1) - 1, d || 1).getTime()
}

function daysAgo(date: string, now: number): number {
  const today = localMidnight(dateKey(now))
  return Math.round((today - localMidnight(date)) / DAY_MS)
}

/**
 * Best estimated 1RM per session for one lift.
 *
 * The single most useful line in a training app: it moves when either
 * weight or reps improve, so a session that added a rep shows progress
 * where a weight-only chart would look flat.
 */
export function e1rmSeries(entries: HistoryEntry[]): Point[] {
  const points: Point[] = []
  for (const entry of entries || []) {
    if (entry.off) continue
    let best = 0
    for (const set of workingSets(entry)) {
      const value = epley1RM(setWeight(entry, set), set.r || 0)
      if (value != null && value > best) best = value
    }
    if (best > 0) points.push({ date: entry.date, value: Math.round(best * 10) / 10 })
  }
  return points.sort((a, b) => a.date.localeCompare(b.date))
}

export interface MuscleWeekPoint {
  muscle: Muscle
  sets: number
  band: 'under' | 'in' | 'over'
  estimated: boolean
}

/** Hard sets per muscle over the last seven days, against the band. */
export function muscleWeekSeries(
  history: History,
  index: ExerciseIndex,
  now: number,
): MuscleWeekPoint[] {
  const totals = new Map<Muscle, { sets: number; estimated: boolean }>()
  for (const id of Object.keys(history || {})) {
    const split = index[id]
    if (!split || (!split.primary.length && !split.secondary.length)) continue
    for (const entry of history[id] || []) {
      if (entry.off) continue
      const age = daysAgo(entry.date, now)
      if (age < 0 || age > 6) continue
      const spread = distribute(workingSets(entry).length, split)
      for (const muscle of Object.keys(spread) as Muscle[]) {
        const t = totals.get(muscle) || { sets: 0, estimated: false }
        t.sets += spread[muscle] || 0
        t.estimated = t.estimated || split.estimated
        totals.set(muscle, t)
      }
    }
  }
  return [...totals.entries()]
    .map(([muscle, t]) => ({
      muscle,
      sets: Math.round(t.sets * 10) / 10,
      band: (t.sets > WEEKLY_SET_BAND[1] ? 'over' : t.sets < WEEKLY_SET_BAND[0] ? 'under' : 'in') as
        'under' | 'in' | 'over',
      estimated: t.estimated,
    }))
    .sort((a, b) => b.sets - a.sets)
}

/** Sessions per rolling week, oldest first — the consistency metric. */
export function sessionsPerWeekSeries(
  finishedDates: string[],
  now: number,
  weeks = 12,
): Point[] {
  const points: Point[] = []
  const seen = new Set(finishedDates || [])
  for (let w = weeks - 1; w >= 0; w--) {
    let count = 0
    let label = ''
    for (let d = 0; d < 7; d++) {
      const age = w * 7 + d
      const day = new Date(now)
      day.setDate(day.getDate() - age)
      const key = dateKey(day.getTime())
      if (d === 6) label = key
      if (seen.has(key)) count++
    }
    points.push({ date: label, value: count })
  }
  return points
}

export interface PeriodComparison {
  current: { from: string; to: string; sessions: number; sets: number; tonnage: number }
  previous: { from: string; to: string; sessions: number; sets: number; tonnage: number }
  /** Ratios, or null when the previous period has nothing to compare to. */
  change: { sessions: number | null; sets: number | null; tonnage: number | null }
}

/** This block of weeks against the one before it. */
export function periodComparison(
  history: History,
  finishedDates: string[],
  now: number,
  weeks = 8,
): PeriodComparison {
  const span = weeks * 7
  const shift = (days: number) => {
    const d = new Date(now)
    d.setDate(d.getDate() - days)
    return dateKey(d.getTime())
  }
  const windows = [
    { from: shift(span - 1), to: shift(0) },
    { from: shift(span * 2 - 1), to: shift(span) },
  ]

  const measure = (from: string, to: string) => {
    let sets = 0
    let tonnage = 0
    for (const id of Object.keys(history || {})) {
      for (const entry of history[id] || []) {
        if (entry.off || entry.date < from || entry.date > to) continue
        for (const set of workingSets(entry)) {
          sets++
          tonnage += setWeight(entry, set) * (set.r || 0)
        }
      }
    }
    const sessions = new Set((finishedDates || []).filter((d) => d >= from && d <= to)).size
    return { from, to, sessions, sets, tonnage: Math.round(tonnage) }
  }

  const current = measure(windows[0].from, windows[0].to)
  const previous = measure(windows[1].from, windows[1].to)
  const ratio = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) / 100 : null)

  return {
    current,
    previous,
    change: {
      sessions: ratio(current.sessions, previous.sessions),
      sets: ratio(current.sets, previous.sets),
      tonnage: ratio(current.tonnage, previous.tonnage),
    },
  }
}
