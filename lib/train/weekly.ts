/**
 * When a week is different, say what else was different.
 *
 * THE LINE THIS FILE WALKS, and why it is drawn where it is.
 *
 * Every metric here is already tracked, so an open-ended correlation
 * search over them is a few lines of code — and it would manufacture a
 * finding every single week. With a dozen metrics and a handful of
 * windows there are hundreds of pairs, and some pair always moves
 * together. A finding that turns out to be nonsense once teaches the
 * athlete to ignore the next twenty, including the one that mattered.
 *
 * So: a CLOSED LIST of physiologically plausible links, declared below,
 * tested and nothing else. Each carries its own lag, its own minimum
 * sample and its own minimum effect, because "enough evidence" is not the
 * same quantity for sleep and for bodyweight.
 *
 * CO-OCCURRENCE, NEVER CAUSATION. Two numbers moved. Both are stated, in
 * their own units, in one sentence, and the sentence never contains
 * "because". A week is one observation; it cannot support more than that,
 * and pretending otherwise is the app being confidently wrong in a way
 * the athlete cannot check.
 *
 * LAG. Today's session is downstream of last night's sleep and the last
 * few days of load — not of the same day's. Each hypothesis declares how
 * far back its driver window sits, and reading the driver over the same
 * window as the outcome would find the effect in the wrong place or miss
 * it entirely.
 *
 * NAME THE CONFOUNDS. A twenty percent volume drop in a week that
 * contained a prescribed deload is not a finding, it is the app failing to
 * know its own history. Deloads, layoffs and imported data are named
 * beside the finding rather than left as a mystery.
 *
 * ONE FINDING, OR NONE. The most important thing that happened, or
 * silence. Padding is how a weekly read becomes wallpaper.
 *
 * Pure and DOM-free.
 */

import { attribute, type ExerciseIndex, type History } from './analysis'
import { readableEntries, amrapOf } from './sets'
import { medianRest } from './timing'
import { otherLoadOf, type OtherEntry } from './other'
import { workingRpe, workingSets, setWeight } from './sets'
import {
  asPercent, baselineWindow, daysBetween, inWindow, rollingWindow,
  deltaOf, type Delta, type Window,
} from './windows'

/** Everything a weekly read may look at. */
export interface WeeklyContext {
  history: History
  index: ExerciseIndex
  finishedDates: string[]
  bodyweight: Array<{ date: string; lb: number }>
  otherTraining: OtherEntry[]
  /** Daily Vitals, where connected. Absent days are simply absent. */
  vitals: Array<{ date: string; recovery?: number; sleepHours?: number }>
  /** Sessions the programme prescribed a deload for. */
  deloadDates: string[]
  /** Dates a layoff was detected, if any. */
  layoffDates: string[]
  /** True when any of this history came from an import. */
  imported?: boolean
  now: number
}

/** A metric this engine knows how to read over a window. */
export type MetricId =
  | 'hard_sets' | 'tonnage' | 'sessions' | 'e1rm' | 'median_rest'
  | 'rpe' | 'amrap' | 'bodyweight' | 'other_load' | 'recovery' | 'sleep'
  | 'relative_strength' | 'progression'

export interface Reading {
  value: number
  /** Observations behind it. A mean of one is not a mean. */
  samples: number
  estimated: boolean
}

const NOTHING: Reading = { value: 0, samples: 0, estimated: false }

/**
 * Metrics that ACCUMULATE, and so must be read as a rate.
 *
 * The baseline is four weeks long and the week is one. Comparing their
 * totals says every week is a seventy-five percent collapse, which is
 * arithmetic rather than a finding. Additive metrics are divided by the
 * weeks in their window; averages — sleep, RPE, rest, bodyweight, e1RM —
 * are already rates and are left alone.
 */
const ADDITIVE: MetricId[] = ['hard_sets', 'tonnage', 'sessions', 'other_load']

function perWeek(metric: MetricId, value: number, w: Window): number {
  if (!ADDITIVE.includes(metric)) return value
  const weeks = w.days / 7
  /* EQUIVALENT MUTANT (confirmed empirically): `weeks > 0` can become
     `weeks >= 0` with nothing able to catch it. Every Window reaching
     this function is built by rollingWindow/baselineWindow with a fixed,
     positive `days` (7, or weeks*7 for a multi-week baseline) — `weeks`
     is never zero through weeklyChange, the only exported caller, so
     the two comparisons never disagree on a reachable input. */
  return weeks > 0 ? value / weeks : value
}

const mean = (values: number[]): number =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0

const round = (n: number, places = 1) => {
  const f = 10 ** places
  return Math.round(n * f) / f
}

/* ---------------------------------------------------------------- *
 * Reading each metric over a window. One function, one metric, and
 * every one of them reports its sample count so a gate can refuse it.
 *
 * EQUIVALENT MUTANTS (confirmed empirically, not by reasoning — every
 * one below was checked by applying it and running the full real test
 * suite, tests/train/weekly-change.test.ts and weekly-change-wiring.test.ts,
 * not just this file's own fixtures).
 *
 * The eight simple `if (!xs.length) return NOTHING` guards in the switch
 * below (hard_sets, tonnage, median_rest, rpe, amrap, bodyweight,
 * other_load, recovery/sleep) can each be removed with no test able to
 * catch it, because every one of their `return` statements after the
 * guard uses that SAME collection's `.length` (or a value trivially
 * derived from it) for `samples`, and `mean([])`/`reduce` on an empty
 * collection already equal 0 — so a "removed" guard reconstructs the
 * NOTHING constant by arithmetic rather than by the early return. The
 * one exception in this group is `other_load`, whose `estimated` field
 * is hardcoded `true` rather than derived — a genuine, if inert,
 * difference. It never reaches an observer: every hypothesis gates on
 * `samples < minSamples` (minSamples is always >= 1) before `estimated`
 * is ever read, and samples is 0 either way.
 * ---------------------------------------------------------------- */

function entriesIn(ctx: WeeklyContext, w: Window) {
  const out: Array<{ id: string; entry: History[string][number] }> = []
  for (const id of Object.keys(ctx.history || {})) {
    for (const entry of readableEntries(ctx.history[id])) {
      if (!inWindow(entry.date, w)) continue
      out.push({ id, entry })
    }
  }
  return out
}

function readMetric(metric: MetricId, ctx: WeeklyContext, w: Window): Reading {
  const raw = readRaw(metric, ctx, w)
  return { ...raw, value: round(perWeek(metric, raw.value, w), 2) }
}

function readRaw(metric: MetricId, ctx: WeeklyContext, w: Window): Reading {
  switch (metric) {
    case 'hard_sets': {
      const rows = attribute(ctx.history, ctx.index).filter((r) => inWindow(r.date, w))
      if (!rows.length) return NOTHING
      const sessions = new Set(rows.map((r) => r.date)).size
      return {
        value: round(rows.reduce((n, r) => n + r.sets, 0)),
        samples: sessions,
        estimated: rows.some((r) => r.estimated),
      }
    }
    case 'tonnage': {
      const found = entriesIn(ctx, w)
      if (!found.length) return NOTHING
      let total = 0
      for (const { entry } of found) {
        for (const set of workingSets(entry)) total += setWeight(entry, set) * (set.r || 0)
      }
      return { value: Math.round(total), samples: found.length, estimated: false }
    }
    case 'sessions': {
      const dates = new Set((ctx.finishedDates || []).filter((d) => inWindow(d, w)))
      return { value: dates.size, samples: dates.size, estimated: false }
    }
    case 'e1rm': {
      const found = entriesIn(ctx, w)
      const best = new Map<string, number>()
      for (const { id, entry } of found) {
        for (const set of workingSets(entry)) {
          const reps = set.r || 0
          if (!reps || reps > 10) continue
          const e1 = setWeight(entry, set) * (1 + reps / 30)
          /* EQUIVALENT MUTANT (confirmed empirically): `>` can become
             `>=` with nothing able to catch it. This only changes which
             set WINS a tie for the best estimate — and a tie means the
             two candidate e1 values are numerically equal, so the map
             ends up holding the same number either way. There is no way
             to observe which one "won". */
          if (e1 > (best.get(id) || 0)) best.set(id, e1)
        }
      }
      if (!best.size) return NOTHING
      return { value: round(mean([...best.values()])), samples: found.length, estimated: false }
    }
    case 'median_rest': {
      const values = entriesIn(ctx, w)
        .map(({ entry }) => medianRest(entry))
        .filter((v): v is number => v != null)
      if (!values.length) return NOTHING
      return { value: round(mean(values)), samples: values.length, estimated: false }
    }
    case 'rpe': {
      const values = entriesIn(ctx, w)
        .map(({ entry }) => workingRpe(entry))
        .filter((v): v is number => v != null)
      if (!values.length) return NOTHING
      return { value: round(mean(values)), samples: values.length, estimated: false }
    }
    case 'amrap': {
      const values: number[] = []
      for (const { entry } of entriesIn(ctx, w)) {
        const set = amrapOf(entry)
        if (set && typeof set.r === 'number') values.push(set.r)
      }
      if (!values.length) return NOTHING
      return { value: round(mean(values)), samples: values.length, estimated: false }
    }
    case 'bodyweight': {
      const values = (ctx.bodyweight || [])
        .filter((b) => b && inWindow(b.date, w) && typeof b.lb === 'number')
        .map((b) => b.lb)
      if (!values.length) return NOTHING
      return { value: round(mean(values)), samples: values.length, estimated: false }
    }
    case 'other_load': {
      const rows = (ctx.otherTraining || []).filter((e) => e && inWindow(e.date, w))
      if (!rows.length) return NOTHING
      return {
        value: rows.reduce((n, e) => n + otherLoadOf(e), 0),
        samples: rows.length,
        /* Self-reported intensity times duration, always. */
        estimated: true,
      }
    }
    case 'recovery':
    case 'sleep': {
      const pick = (v: WeeklyContext['vitals'][number]) =>
        metric === 'recovery' ? v.recovery : v.sleepHours
      const values = (ctx.vitals || [])
        .filter((v) => v && inWindow(v.date, w))
        .map(pick)
        .filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
      if (!values.length) return NOTHING
      return { value: round(mean(values), 2), samples: values.length, estimated: false }
    }
    case 'relative_strength': {
      /* Composed from metrics that are already rates, so readMetric is
         the right entry point — readRaw would skip the normalisation the
         composition depends on. */
      const e1 = readMetric('e1rm', ctx, w)
      const bw = readMetric('bodyweight', ctx, w)
      /* EQUIVALENT MUTANTS, all four (confirmed empirically — applied
         individually and combined, against the full real test suite,
         including deliberately hostile fixtures: bw averaging to exactly
         zero, and a negative bodyweight reading, both checked directly).
         Every corruption this guard prevents lands on one of two
         mechanisms elsewhere that already absorb it:
           - !e1.samples===0 always means e1.value===0 too (e1rm's own
             empty case returns value:0), so a bypassed guard still
             divides 0 by something, landing on 0 — and Math.min with a
             0 sample count still yields 0. Matches NOTHING regardless.
           - !bw.samples===0 always means bw.value===0 too, for the same
             reason — so "!bw.samples" never fires on an input where
             "bw.value <= 0" wouldn't already have fired it, making that
             disjunct redundant with the third one in EVERY reachable
             case, not just some.
           - bw.value <= 0 (including the <= vs < boundary at exactly
             zero) divides by zero or a negative number. Either result is
             non-finite or a real negative ratio, but deltaOf() (windows.ts)
             independently rejects any non-finite current/baseline before
             a Delta is built, and the negative case was checked directly
             and produced no observable difference either — nothing
             downstream of readRaw ever sees the corrupted value. */
      if (!e1.samples || !bw.samples || bw.value <= 0) return NOTHING
      return {
        value: round(e1.value / bw.value, 3),
        samples: Math.min(e1.samples, bw.samples),
        estimated: false,
      }
    }
    case 'progression': {
      /* How much the best set moved across the window, per session. */
      const e1 = readMetric('e1rm', ctx, w)
      const sessions = readMetric('sessions', ctx, w)
      /* EQUIVALENT MUTANTS, both (confirmed empirically, individually and
         combined). Same two mechanisms as relative_strength above:
         !e1.samples===0 implies e1.value===0, so a bypassed guard still
         divides 0 by sessions.value and lands on 0, matching NOTHING;
         and !sessions.value===0 divides by zero, but deltaOf() rejects
         the resulting non-finite value before it can become a Delta. */
      if (!e1.samples || !sessions.value) return NOTHING
      return { value: round(e1.value / sessions.value, 2), samples: e1.samples, estimated: false }
    }
    default:
      return NOTHING
  }
}

/* ---------------------------------------------------------------- *
 * The closed list.
 * ---------------------------------------------------------------- */

export interface Hypothesis {
  id: string
  outcome: MetricId
  driver: MetricId
  /**
   * How far back the driver window sits, in days. Today's session is
   * downstream of last night's sleep, not of tonight's.
   */
  lagDays: number
  /** Observations the OUTCOME needs before it may be reported. */
  minSamples: number
  /** Fractional change the outcome must clear. */
  minEffect: number
  /** Fractional change the driver must clear to count as co-occurring. */
  minDriverEffect: number
  /** Both moved the same way, or opposite ways? */
  direction: 'same' | 'opposite'
  /** Higher is more worth saying. */
  priority: number
  say: (o: Delta, d: Delta) => string
}

const pct = (d: Delta) => asPercent(d.change)

export const HYPOTHESES: Hypothesis[] = [
  {
    id: 'sleep_output',
    outcome: 'hard_sets', driver: 'sleep',
    lagDays: 1, minSamples: 2, minEffect: 0.15, minDriverEffect: 0.1,
    direction: 'same', priority: 3,
    say: (o, d) =>
      `Volume ${pct(o)} in a week you averaged ${d.current}h sleep against your usual ${d.baseline}.`,
  },
  {
    id: 'recovery_e1rm',
    outcome: 'e1rm', driver: 'recovery',
    lagDays: 1, minSamples: 2, minEffect: 0.04, minDriverEffect: 0.1,
    direction: 'same', priority: 4,
    say: (o, d) =>
      `Best sets ${pct(o)} in a week recovery averaged ${d.current} against your usual ${d.baseline}.`,
  },
  {
    id: 'rest_compression_reps',
    outcome: 'amrap', driver: 'median_rest',
    lagDays: 0, minSamples: 2, minEffect: 0.1, minDriverEffect: 0.15,
    direction: 'same', priority: 5,
    say: (o, d) =>
      `All-out reps ${pct(o)} in a week you rested ${d.current}s between sets against your usual ${d.baseline}s.`,
  },
  {
    id: 'other_load_volume',
    outcome: 'hard_sets', driver: 'other_load',
    lagDays: 0, minSamples: 2, minEffect: 0.15, minDriverEffect: 0.25,
    direction: 'opposite', priority: 3,
    say: (o, d) =>
      `Lifting volume ${pct(o)} in a week your other training was ${pct(d)} — that load is self-reported.`,
  },
  {
    id: 'bodyweight_relative_strength',
    outcome: 'relative_strength', driver: 'bodyweight',
    lagDays: 0, minSamples: 2, minEffect: 0.04, minDriverEffect: 0.02,
    direction: 'opposite', priority: 2,
    say: (o, d) =>
      `Strength per pound ${pct(o)} in a week you averaged ${d.current} lb against your usual ${d.baseline}.`,
  },
  {
    id: 'frequency_progression',
    outcome: 'progression', driver: 'sessions',
    lagDays: 7, minSamples: 2, minEffect: 0.08, minDriverEffect: 0.2,
    direction: 'same', priority: 3,
    say: (o, d) =>
      `Best sets per session ${pct(o)} after a week of ${d.current} sessions against your usual ${d.baseline}.`,
  },
]

/* ---------------------------------------------------------------- */

export interface WeeklyFinding {
  hypothesis: string
  text: string
  outcome: { metric: MetricId; current: number; baseline: number; change: number }
  /** Null when the finding is a confounded change with nothing paired. */
  driver: { metric: MetricId; current: number; baseline: number; change: number; lagDays: number } | null
  /** Named, so a prescribed drop is never reported as a mystery. */
  confounds: string[]
  estimated: boolean
  priority: number
}

function confoundsIn(ctx: WeeklyContext, w: Window): string[] {
  const found: string[] = []
  if ((ctx.deloadDates || []).some((d) => inWindow(d, w))) found.push('deload')
  if ((ctx.layoffDates || []).some((d) => inWindow(d, w))) found.push('layoff')
  if (ctx.imported) found.push('imported history')
  return found
}

/** A change big enough to be worth explaining, when there is an explanation. */
const CONFOUNDED_EFFECT = 0.2

const moved = (delta: Delta, minimum: number): boolean =>
  delta.change != null && Math.abs(delta.change) >= minimum

/**
 * The one thing worth saying about this week, or nothing.
 *
 * Every hypothesis is evaluated, those that clear their gates are ranked,
 * and exactly one comes back. A week where nothing clears produces null,
 * which is the common case and is meant to be.
 */
export function weeklyChange(ctx: WeeklyContext): WeeklyFinding | null {
  if (!ctx || !ctx.now) return null
  const week = rollingWindow(ctx.now)
  const baseline = baselineWindow(ctx.now)

  const candidates: WeeklyFinding[] = []

  for (const h of HYPOTHESES) {
    const outNow = readMetric(h.outcome, ctx, week)
    const outBase = readMetric(h.outcome, ctx, baseline)
    if (outNow.samples < h.minSamples || outBase.samples < h.minSamples) continue

    const outcome = deltaOf(outNow.value, outBase.value)
    if (!moved(outcome, h.minEffect)) continue

    /* The driver is read over a window shifted back by its own lag: the
       nights before these sessions, not the nights after them. */
    const driverWeek = rollingWindow(ctx.now, h.lagDays)
    const driverBase = baselineWindow(ctx.now, 4, 7 + h.lagDays)
    const drvNow = readMetric(h.driver, ctx, driverWeek)
    const drvBase = readMetric(h.driver, ctx, driverBase)
    if (drvNow.samples < h.minSamples || drvBase.samples < h.minSamples) continue

    const driver = deltaOf(drvNow.value, drvBase.value)
    if (!moved(driver, h.minDriverEffect)) continue

    /* The two have to have moved the way this hypothesis says they do.
       Accepting either direction would make every pair a match and turn
       the closed list back into a search. */
    /* EQUIVALENT MUTANT (confirmed empirically): `> 0` can become `>= 0`
       with nothing able to catch it. By this point both `moved(outcome,
       h.minEffect)` and `moved(driver, h.minDriverEffect)` have already
       passed, and every minEffect/minDriverEffect in HYPOTHESES is a
       positive number — so both change values are already proven
       |non-zero| by construction, and their product can never land
       exactly on zero for the two comparisons to disagree about. */
    const together = (outcome.change as number) * (driver.change as number) > 0
    if (h.direction === 'same' && !together) continue
    if (h.direction === 'opposite' && together) continue

    const confounds = confoundsIn(ctx, week)
    const estimated = outNow.estimated || drvNow.estimated || ctx.imported === true
    const tail = confounds.length ? ` This week included a ${confounds.join(' and a ')}.` : ''

    candidates.push({
      hypothesis: h.id,
      text: h.say(outcome, driver) + tail,
      outcome: {
        metric: h.outcome, current: outNow.value, baseline: outBase.value,
        change: outcome.change as number,
      },
      driver: {
        metric: h.driver, current: drvNow.value, baseline: drvBase.value,
        change: driver.change as number, lagDays: h.lagDays,
      },
      confounds,
      estimated,
      priority: h.priority,
    })
  }

  /**
   * A big move the athlete's own history already explains.
   *
   * No hypothesis fired, so there is no co-occurrence to report — but a
   * fifty percent volume drop in a week that contained a prescribed
   * deload still must not go unmentioned, because the alternative is the
   * athlete seeing the drop elsewhere in the app and wondering. This is
   * the "failing to know its own history" case: report the change and
   * name the reason. Without a confound it stays silent, since a bare
   * outcome change with nothing beside it is not a finding.
   */
  if (!candidates.length) {
    const confounds = confoundsIn(ctx, week)
    if (!confounds.length) return null

    for (const metric of ['hard_sets', 'tonnage', 'sessions'] as MetricId[]) {
      const now = readMetric(metric, ctx, week)
      const base = readMetric(metric, ctx, baseline)
      if (now.samples < 2 || base.samples < 2) continue
      const outcome = deltaOf(now.value, base.value)
      if (!moved(outcome, CONFOUNDED_EFFECT)) continue

      const what = metric === 'sessions' ? 'Sessions' : metric === 'tonnage' ? 'Tonnage' : 'Volume'
      return {
        hypothesis: 'confounded_change',
        text: `${what} ${asPercent(outcome.change)} on the week — that week included a ${confounds.join(' and a ')}.`,
        outcome: {
          metric, current: now.value, baseline: base.value,
          change: outcome.change as number,
        },
        driver: null,
        confounds,
        estimated: now.estimated || ctx.imported === true,
        priority: 1,
      }
    }
    return null
  }

  /* Ranked: the programme-changing over the merely-interesting, then the
     larger effect, then the id so the same week always reads the same. */
  candidates.sort(
    (a, b) =>
      b.priority - a.priority ||
      Math.abs(b.outcome.change) - Math.abs(a.outcome.change) ||
      a.hypothesis.localeCompare(b.hypothesis),
  )
  return candidates[0]
}
