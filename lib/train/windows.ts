/**
 * Rolling windows and deltas — one authority.
 *
 * Three places were computing "this week against the week before" with
 * their own arithmetic: volumeRamp bucketed by `daysAgo <= 6` and
 * `<= 13`, periodComparison shifted dates by a span, and the weekly
 * change analysis wanted a third. Three implementations of the same idea
 * drift, and then two screens disagree about what week it is.
 *
 * So the window is defined once here and everything else asks for it.
 *
 * Pure and DOM-free — `now` is passed in, as everywhere.
 */

export interface Window {
  /** Inclusive, YYYY-MM-DD. */
  from: string
  /** Inclusive. */
  to: string
  days: number
}

const DAY_MS = 86_400_000

export function dateKey(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function localMidnight(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, (m || 1) - 1, d || 1).getTime()
}

/** Whole days between two dates, positive when `to` is later. */
export function daysBetween(from: string, to: string): number {
  return Math.round((localMidnight(to) - localMidnight(from)) / DAY_MS)
}

/** `n` calendar days before this date — NOT n × 86,400,000 milliseconds. */
function shiftDays(ms: number, back: number): Date {
  const d = new Date(ms)
  d.setDate(d.getDate() - back)
  return d
}

/**
 * A window of `days` ending `endingDaysAgo` days before now.
 *
 * `rollingWindow(now)` is the last seven days including today.
 * `rollingWindow(now, 7)` is the seven days before that.
 *
 * Stepped by CALENDAR days, and that is not a detail. Subtracting
 * milliseconds drifts across a daylight-saving change: six times
 * 86,400,000 back from early on the Monday after the clocks go forward
 * lands a day too far, because the intervening Sunday was 23 hours long.
 * The window silently becomes eight days, once a year, inflating every
 * weekly figure computed inside it — volume, sets, sessions, and the
 * baseline every change is measured against.
 */
export function rollingWindow(now: number, endingDaysAgo = 0, days = 7): Window {
  const end = shiftDays(now, endingDaysAgo)
  const start = shiftDays(end.getTime(), days - 1)
  return { from: dateKey(start.getTime()), to: dateKey(end.getTime()), days }
}

/**
 * The baseline a week is judged against: the `weeks` windows before it.
 *
 * A single previous week is a poor baseline — one deload or one holiday
 * makes everything after it look like a breakthrough. Four weeks of
 * trailing history is enough for a typical week to be typical.
 */
export function baselineWindow(now: number, weeks = 4, skipDays = 7): Window {
  return rollingWindow(now, skipDays, weeks * 7)
}

export function inWindow(date: string, window: Window): boolean {
  return !!date && date >= window.from && date <= window.to
}

export interface Delta {
  current: number
  baseline: number
  /** current / baseline, or null when there is no baseline to divide by. */
  ratio: number | null
  /** Fractional change: +0.18 is eighteen percent up. Null likewise. */
  change: number | null
}

/**
 * A change, with the "no baseline" case kept distinct from "no change".
 *
 * Returning 0 for a missing baseline is how a first week of training gets
 * reported as perfectly steady.
 */
export function deltaOf(current: number, baseline: number): Delta {
  if (!Number.isFinite(current) || !Number.isFinite(baseline) || baseline === 0) {
    return { current, baseline, ratio: null, change: null }
  }
  const ratio = current / baseline
  return {
    current,
    baseline,
    ratio: Math.round(ratio * 1000) / 1000,
    change: Math.round((ratio - 1) * 1000) / 1000,
  }
}

/** Percent, for a sentence. */
export function asPercent(change: number | null): string {
  if (change == null) return ''
  const pct = Math.round(Math.abs(change) * 100)
  return `${change >= 0 ? 'up' : 'down'} ${pct}%`
}
