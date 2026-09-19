/**
 * Acute load against chronic load.
 *
 * Sports science manages workload by comparing what somebody has done
 * recently against what they are used to doing. Almost nobody applies it
 * to lifting, for a dull reason: it needs a per-muscle volume model, and
 * almost no app has one. This engine has had one since the muscle list
 * was closed.
 *
 * WHAT THIS IS, EXACTLY.
 *
 * An exponentially weighted average of daily hard sets per muscle over
 * roughly a week (acute) against roughly a month (chronic), and their
 * ratio. Exponential rather than a flat window because the flat version
 * has a cliff: a hard session drops out of a 7-day window overnight and
 * the number jumps for no reason the athlete did anything about.
 *
 * WHAT THIS IS NOT.
 *
 * It is not injury prediction and it never says it is. The ratio is a
 * fact about training volume. What that implies for a particular body,
 * with a particular history and a particular job and a particular amount
 * of sleep, is not something this app can know — and the literature it
 * comes from is about squads of monitored athletes, not one person with a
 * phone. So it reports the number and says what it is.
 *
 * THE FAILURE MODE THAT MATTERS, and the reason for the second gate.
 *
 * After a layoff the chronic load has decayed toward nothing, so ANY
 * training produces an enormous ratio. That is arithmetic, not a finding,
 * and it fires on exactly the person least helped by being told to do
 * less. So a reading is `usable` only when the chronic figure rests on
 * enough days AND enough actual load — a trickle across three months is
 * enough calendar and not enough training.
 *
 * OTHER TRAINING, and a rule this had to be careful with.
 *
 * other.ts is emphatic that self-reported load is NEVER expressed in the
 * units of lifting, because that launders a guess into the same field as
 * a count. That rule stands here: other training reaches the SYSTEMIC
 * index — its own derived thing, in its own arbitrary units — and never a
 * muscle's hard sets. Any reading it contributed to is marked estimated.
 *
 * Pure and DOM-free.
 */

import { attribute, type ExerciseIndex, type History } from './analysis'
import { otherLoadOf, type OtherEntry } from './other'
import { daysBetween, dateKey } from './windows'
import type { Muscle } from './muscles'

/** Time constants, in days. The standard acute:chronic pairing. */
const ACUTE_DAYS = 7
const CHRONIC_DAYS = 28

/** Days of history before a chronic figure means anything. */
export const MIN_CHRONIC_DAYS = 28

/**
 * Chronic load below which the ratio is noise, in hard sets per WEEK.
 *
 * Four: below that the denominator is small enough that ordinary
 * variation produces enormous ratios, which is the returning-lifter trap
 * in another form.
 */
export const MIN_CHRONIC_LOAD = 4

/** Outside this, the ratio is worth stating. */
export const SANE_BAND: [number, number] = [0.8, 1.5]

/**
 * How much self-reported other-training load counts toward the index.
 *
 * One "set equivalent" per two minutes at a moderate intensity — a rough
 * number, deliberately, and the reason every reading it touches is marked
 * estimated. It reaches the SYSTEMIC index only; other.ts is emphatic
 * that this never becomes a muscle's hard sets, and that rule stands.
 */
const OTHER_LOAD_PER_SET = 120

export interface LoadContext {
  history: History
  index: ExerciseIndex
  otherTraining: OtherEntry[]
  now: number
}

export interface LoadReading {
  acute: number
  chronic: number
  ratio: number
  /** False when the chronic baseline is too thin to divide by. */
  usable: boolean
  /** True when self-reported other-training load contributed. */
  estimated: boolean
}

export interface LoadSnapshot {
  byMuscle: Partial<Record<Muscle, LoadReading>>
  /** Everything together, including other training. */
  systemic: LoadReading
}

/**
 * A trailing seven-day TOTAL at each day, rather than that day's own work.
 *
 * Lifting is bursty in a way the endurance literature this model comes
 * from is not: somebody training twice a week has five zero days, and an
 * exponential average of raw daily values is then dominated by whether
 * TODAY happened to be a training day. A perfectly steady block read 1.32
 * on a Saturday and would have read well under 1 on a Tuesday — the
 * number moving for a reason the athlete did nothing about, which is the
 * exact failure a flat window has and the exponential one was chosen to
 * avoid.
 *
 * Smoothing to a weekly rate first removes the weekday artefact and has
 * the side benefit that every figure below is in sets per WEEK, which is
 * the unit the rest of this engine already speaks.
 */
function weeklyRate(daily: number[]): number[] {
  const out = new Array(daily.length).fill(0)
  let running = 0
  for (let i = 0; i < daily.length; i++) {
    running += daily[i]
    if (i >= 7) running -= daily[i - 7]
    out[i] = running
  }
  return out
}

/** Exponentially weighted average of a daily series, most recent last. */
function ewma(daily: number[], days: number): number {
  if (!daily.length) return 0
  const alpha = 2 / (days + 1)
  let value = daily[0]
  for (let i = 1; i < daily.length; i++) value = daily[i] * alpha + value * (1 - alpha)
  return value
}

/** Daily totals for the last `span` days, oldest first. Absent days are 0. */
function dailySeries(
  rows: Array<{ date: string; amount: number }>,
  now: number,
  span: number,
): number[] {
  const today = dateKey(now)
  const series = new Array(span).fill(0)
  for (const row of rows) {
    const age = daysBetween(row.date, today)
    if (age < 0 || age >= span) continue
    series[span - 1 - age] += row.amount
  }
  return series
}

const round = (n: number, p = 2) => Math.round(n * 10 ** p) / 10 ** p

function readingFrom(daily: number[], observedDays: number, estimated: boolean): LoadReading {
  const rate = weeklyRate(daily)
  const acute = ewma(rate, ACUTE_DAYS)
  const chronic = ewma(rate, CHRONIC_DAYS)
  const usable = observedDays >= MIN_CHRONIC_DAYS && chronic >= MIN_CHRONIC_LOAD
  return {
    acute: round(acute),
    chronic: round(chronic),
    /* Zero chronic would divide to Infinity. Reported as 0 and marked
       unusable, which is the honest shape: there is no ratio here. */
    ratio: chronic > 0 ? round(acute / chronic) : 0,
    usable,
    estimated,
  }
}

/** Days between the first recorded training and today. */
function spanOfHistory(ctx: LoadContext): number {
  const today = dateKey(ctx.now)
  let oldest = 0
  for (const id of Object.keys(ctx.history || {})) {
    for (const entry of ctx.history[id] || []) {
      if (!entry || entry.off || !entry.date) continue
      const age = daysBetween(entry.date, today)
      if (age > oldest) oldest = age
    }
  }
  for (const other of ctx.otherTraining || []) {
    if (!other || !other.date) continue
    const age = daysBetween(other.date, today)
    if (age > oldest) oldest = age
  }
  return oldest
}

/** Acute and chronic load, per muscle and overall. */
export function acuteChronic(ctx: LoadContext): LoadSnapshot {
  const span = CHRONIC_DAYS * 2
  const observedDays = spanOfHistory(ctx)

  const attributed = attribute(ctx.history || {}, ctx.index || {})
  const byMuscle: Partial<Record<Muscle, LoadReading>> = {}

  const muscles = new Set(attributed.map((r) => r.muscle))
  for (const muscle of muscles) {
    const rows = attributed
      .filter((r) => r.muscle === muscle)
      .map((r) => ({ date: r.date, amount: r.sets }))
    /* Per-muscle readings are LIFTING ONLY. Self-reported load never
       enters a muscle's set count — see other.ts, and the systemic
       reading below, which is where it does belong. */
    byMuscle[muscle] = readingFrom(dailySeries(rows, ctx.now, span), observedDays, false)
  }

  const otherRows = (ctx.otherTraining || [])
    .filter((e) => e && e.date)
    .map((e) => ({ date: e.date, amount: otherLoadOf(e) / OTHER_LOAD_PER_SET }))
  const systemicRows = [
    ...attributed.map((r) => ({ date: r.date, amount: r.sets })),
    ...otherRows,
  ]
  const systemic = readingFrom(
    dailySeries(systemicRows, ctx.now, span),
    observedDays,
    otherRows.length > 0,
  )

  return { byMuscle, systemic }
}

export interface LoadFinding {
  muscle: Muscle
  ratio: number
  acute: number
  chronic: number
  estimated: boolean
  text: string
}

/**
 * Muscles whose recent load is well away from what they are used to.
 *
 * This REPLACES the old volumeRamp threshold — a week-over-week cutoff
 * that fired on a single jump and said nothing about how used to the work
 * the athlete was. Both numbers are stated, because "1.8" alone is not a
 * thing anybody can act on.
 */
export function loadFindings(ctx: LoadContext): LoadFinding[] {
  const snapshot = acuteChronic(ctx || ({} as LoadContext))
  const out: LoadFinding[] = []

  for (const muscle of Object.keys(snapshot.byMuscle) as Muscle[]) {
    const reading = snapshot.byMuscle[muscle] as LoadReading
    if (!reading.usable) continue
    if (reading.ratio >= SANE_BAND[0] && reading.ratio <= SANE_BAND[1]) continue

    const label = muscle.replace(/_/g, ' ')
    const direction = reading.ratio > SANE_BAND[1] ? 'above' : 'below'
    out.push({
      muscle,
      ratio: reading.ratio,
      acute: reading.acute,
      chronic: reading.chronic,
      estimated: reading.estimated,
      /* A load observation, in its own terms. No injury, no advice, no
         verdict — what the ratio means for one body is not something this
         engine can know, and the literature behind it is about monitored
         squads rather than one person with a phone. */
      text: `${label}: about ${reading.acute} hard sets a week lately against a usual ${reading.chronic} — ${direction} your normal range.`,
    })
  }
  return out.sort((a, b) => b.ratio - a.ratio || a.muscle.localeCompare(b.muscle))
}

/**
 * The whole-body reading, where other training belongs.
 *
 * Per-muscle load is lifting only, deliberately — self-reported effort
 * never becomes a muscle's hard sets. This is the reading it DOES belong
 * in, and it exists because folding it into the context without anywhere
 * for it to surface would be plumbing with no effect: a change nobody
 * could observe, which is the same shape as a guard nobody can falsify.
 *
 * Null inside the band, without a usable baseline, or with nothing to
 * say — which is most of the time.
 */
export function systemicLoadNote(ctx: LoadContext): string | null {
  const { systemic } = acuteChronic(ctx || ({} as LoadContext))
  if (!systemic.usable) return null
  if (systemic.ratio >= SANE_BAND[0] && systemic.ratio <= SANE_BAND[1]) return null

  const direction = systemic.ratio > SANE_BAND[1] ? 'above' : 'below'
  const caveat = systemic.estimated
    ? ' That includes other training you logged, which is self-reported.'
    : ''
  return `Total load: about ${systemic.acute} set-equivalents a week lately against a usual ${systemic.chronic} — ${direction} your normal range.${caveat}`
}
