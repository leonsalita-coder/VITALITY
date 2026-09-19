/**
 * Where a goal actually lands.
 *
 * A lift goal was a number and a progress bar: no answer to the only
 * question worth asking about a goal, which is whether it is coming. The
 * e1RM series already exists, so the slope is free.
 *
 * THE RULE THAT SHAPES THIS FILE.
 *
 * An honest "not on this trajectory" beats a fake date. Fitting a line
 * through six noisy points and announcing March 2031 is the app being
 * precise about something it does not know, and a lifter only has to
 * check one of those against reality before they stop believing anything
 * else it says.
 *
 * So there are three ways to be silent and one way to produce a date:
 *
 *   too little history   — a slope through two points is a rumour
 *   no movement          — say it has not moved, and for how long
 *   movement too slow    — say it is not on this trajectory, no date
 *
 * The most useful of those is the second. "Your bench goal hasn't moved
 * in seven weeks" is a fact a lifter can act on today; a date eighteen
 * months out is one they cannot.
 *
 * Pure and DOM-free — `now` is passed in like everywhere else.
 */

import type { Point } from './series'

/** Points below which a slope is a rumour. */
export const MIN_PROJECTION_POINTS = 4

/** Weeks without movement before it is worth saying so. */
export const STATIC_WEEKS = 6

/**
 * How far ahead a date may be placed.
 *
 * A year. Beyond that the honest answer is not a date but "not at this
 * rate": the trend that produced it will not survive the projection, and
 * nobody plans a training block around a Tuesday next autumn.
 */
export const MAX_PROJECTION_DAYS = 365

/** Points older than this say nothing about the current trajectory. */
const STALE_DAYS = 180

/** Movement smaller than this per week is noise, not progress. */
const NOISE_PER_WEEK = 0.01

const DAY_MS = 86_400_000

export type GoalVerdict = 'on_track' | 'static' | 'unreachable' | 'reached'

export interface GoalProjection {
  verdict: GoalVerdict
  /** ISO date the goal is projected to arrive, or null. */
  date: string | null
  /** Weeks until then, or null. */
  weeks: number | null
  /** Units gained per week on the trailing trend. */
  perWeek: number
  /** Weeks the value has been flat, when that is the finding. */
  staticWeeks: number | null
  /** One sentence, ready to render. */
  text: string
}

export interface ProjectionOptions {
  /** What the numbers are. Defaults to pounds, like everything else. */
  unit?: 'lb' | 'seconds' | 'metres'
}

function localMidnight(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, (m || 1) - 1, d || 1).getTime()
}

function isoOf(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function unitLabel(unit: ProjectionOptions['unit']): string {
  if (unit === 'seconds') return 'seconds'
  if (unit === 'metres') return 'metres'
  return 'lb'
}

/**
 * Least-squares slope in units per DAY.
 *
 * `t` arrives as epoch milliseconds, so it is converted first — running
 * the regression on raw milliseconds gives a slope per millisecond, which
 * rounds to zero and reports every climbing lift as static.
 */
function slopePerDay(points: Array<{ t: number; v: number }>): number {
  return slopeOf(points.map((p) => ({ t: p.t / DAY_MS, v: p.v })))
}

function slopeOf(points: Array<{ t: number; v: number }>): number {
  const n = points.length
  const meanT = points.reduce((sum, p) => sum + p.t, 0) / n
  const meanV = points.reduce((sum, p) => sum + p.v, 0) / n
  let top = 0
  let bottom = 0
  for (const p of points) {
    top += (p.t - meanT) * (p.v - meanV)
    bottom += (p.t - meanT) ** 2
  }
  return bottom === 0 ? 0 : top / bottom
}

/**
 * Where this goal is heading.
 *
 * Null — total silence — whenever there is not enough to reason from.
 * A caller rendering nothing is the correct outcome; a caller rendering
 * "unknown" would be the app taking up space to say it has no idea.
 */
export function projectGoal(
  series: Point[] | null | undefined,
  target: number,
  now: number,
  opts: ProjectionOptions = {},
): GoalProjection | null {
  if (typeof target !== 'number' || !Number.isFinite(target) || target <= 0) return null

  const points = (series || [])
    .filter((p) => p && typeof p.value === 'number' && Number.isFinite(p.value) && p.date)
    .map((p) => ({ t: localMidnight(p.date), v: p.value }))
    .filter((p) => Number.isFinite(p.t) && (now - p.t) / DAY_MS <= STALE_DAYS && p.t <= now)
    .sort((a, b) => a.t - b.t)

  if (points.length < MIN_PROJECTION_POINTS) return null

  const latest = points[points.length - 1]
  const earliest = points[0]
  const unit = unitLabel(opts.unit)
  const perDay = slopePerDay(points)
  const perWeek = Math.round(perDay * 7 * 100) / 100

  /* Already there. Projecting an arrival for something that arrived is
     the app failing to notice the thing the lifter came to see. */
  if (latest.v >= target) {
    return {
      verdict: 'reached',
      date: null,
      weeks: null,
      perWeek,
      staticWeeks: null,
      text: `Goal reached — ${Math.round(latest.v)} ${unit} against a ${Math.round(target)} target.`,
    }
  }

  const spanWeeks = Math.round((latest.t - earliest.t) / DAY_MS / 7)

  /* Flat or falling. Not a date, and not silence either: how long it has
     been stuck is the single most actionable thing here. */
  if (perWeek <= NOISE_PER_WEEK) {
    if (spanWeeks < STATIC_WEEKS) return null
    return {
      verdict: 'static',
      date: null,
      weeks: null,
      perWeek,
      staticWeeks: spanWeeks,
      text: `Hasn't moved in ${spanWeeks} weeks — still ${Math.round(target - latest.v)} ${unit} short.`,
    }
  }

  const remaining = target - latest.v
  const days = remaining / perDay

  if (!Number.isFinite(days) || days > MAX_PROJECTION_DAYS) {
    return {
      verdict: 'unreachable',
      date: null,
      weeks: null,
      perWeek,
      staticWeeks: null,
      text: `Not on this trajectory — ${perWeek} ${unit} a week leaves ${Math.round(remaining)} ${unit} to go.`,
    }
  }

  /* Stepped by calendar days, like every other date this engine builds.
     Adding milliseconds drifts an hour across a daylight-saving change,
     which can show an arrival a day off — small against the uncertainty
     of the projection itself, but there is no reason to be wrong. */
  const arrival = new Date(now)
  arrival.setDate(arrival.getDate() + Math.round(days))
  const weeks = Math.max(1, Math.round(days / 7))
  return {
    verdict: 'on_track',
    date: isoOf(arrival.getTime()),
    weeks,
    perWeek,
    staticWeeks: null,
    text: `About ${weeks} week${weeks === 1 ? '' : 's'} away at ${perWeek} ${unit} a week.`,
  }
}
