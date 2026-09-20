/**
 * "You've progressed the same on 12 sets of chest as on 18."
 *
 * The most actionable sentence this engine can produce, and therefore
 * the most dangerous one. Somebody who reads it may cut a third of their
 * training on the strength of it, so every part of this file is built
 * around not saying it unless the athlete's own record genuinely
 * supports it — and then saying it as a co-occurrence rather than a
 * prescription, with the confounds named out loud.
 *
 * THE STATISTICS RUN BACKWARDS FROM EVERY OTHER FINDING HERE.
 *
 * Every other finding fires when an effect lands OUTSIDE the resampled
 * null. This one claims there is NO difference between two doses, so it
 * fires when the effect lands INSIDE. That asymmetry has a trap in it:
 * "no difference found" is the same output as "not enough data", and
 * reporting the first when the second is true would be the app telling
 * a beginner with three months of noisy logs to halve their volume.
 *
 * So there are two gates, not one:
 *
 *   1. The observed gap sits inside the null — no difference detected.
 *   2. The null band is NARROWER than the athlete's own progression
 *      rate — a difference worth acting on WOULD have been visible.
 *
 * Without the second, silence and equivalence are indistinguishable.
 *
 * WHAT PROGRESSION MEANS HERE. The relative week-over-week change in the
 * best working set's estimated one-rep max, set-weighted across the
 * lifts that trained the muscle. Relative, because a lifter's press and
 * their squat cannot be averaged in pounds. Estimated 1RM rather than
 * bare weight because five reps at 200 is progress over three reps at
 * 200, and a weight-only measure calls that a flat week. The absolute
 * e1RM of a lateral raise is meaningless, but its week-over-week
 * fractional change is not, which is why no e1rm-validity filter applies.
 *
 * SHADOW MODE. Nothing here reaches a person. doseVerdicts computes and
 * logs; doseNote is the only read, and it goes through shadow.surface,
 * which returns null until a flag flips. See shadow.ts.
 *
 * Pure and DOM-free.
 */

import { attribute, type ExerciseIndex, type History } from './analysis'
import { weekIndexer, weeklyRelativeChange } from './liftweeks'
import { blockPermutationTest, significant, DEFAULT_ITERATIONS, DEFAULT_MARGIN } from './resample'
import { recordVerdict, surface, type ShadowLog, type ShadowOverrides, type ShadowVerdict } from './shadow'
import { dateKey, shiftDaysBack, weekStartOf } from './windows'
import type { Muscle } from './muscles'

/**
 * TUNING TARGET. Consecutive weeks kept together when resampling.
 *
 * Four — and deliberately NOT the eight that transfer.ts measured its
 * way to, because this finding's error runs the other way.
 *
 * Transfer claims a relationship, so a null that is too tight makes it
 * fire on nothing. This one claims the ABSENCE of one, so a tight null
 * makes it fire LESS. Measured: how often does it claim equivalence when
 * the high-volume weeks genuinely progressed faster (80 draws each)?
 *
 *   true ratio   block 2   block 4   block 6   block 8
 *   1.0x (equal)   90%       95%       93%       94%     ← should be high
 *   1.5x           29%       43%       46%       65%     ← should be low
 *   2.0x            0%        3%        3%        8%
 *
 * Bigger blocks are strictly worse here. Two is better still, but a
 * two-week block keeps almost none of the structure this is supposed to
 * preserve, so it would be getting the right answer by accident. Four
 * keeps a month of it and is the smallest size that is still doing the
 * job it is there for.
 */
export const DOSE_BLOCK_WEEKS = 4

/**
 * TUNING TARGET. Trained weeks before this may speak at all.
 *
 * Thirty-two, up from twenty-four. Eight blocks of four: the permutation
 * floor is one over the number of arrangements, and the power gate below
 * is close to noise at sample sizes much under this — at forty weeks it
 * fires on 6% of genuinely equal histories and 10% of histories with a
 * real 25% difference, which is the wrong way round and well inside
 * Monte Carlo error either way.
 */
export const MIN_TRAINED_WEEKS = 32

/**
 * TUNING TARGET, and the most important number in this file.
 *
 * The null band must be narrower than the athlete's weekly progression
 * rate divided by this, before an equivalence may be claimed.
 *
 * It was 1 — "the test could have seen a difference the size of your
 * whole progression rate" — and 1 is far too loose. Measured, at four-
 * week blocks, over 80 draws (the figure is how often it claims the two
 * doses were equivalent):
 *
 *   true ratio    /1    /2    /3    /4
 *   1.0x   40w    84%   26%    6%    0%
 *   1.0x   80w    95%   75%   24%    5%
 *   1.0x  120w    96%   93%   55%   11%
 *   1.5x   40w    71%   38%    8%    0%
 *   1.5x   80w    43%   40%   19%    8%
 *   1.5x  120w    28%   28%   18%    6%
 *   2.0x   80w     3%    3%    3%    0%
 *
 * At /1 this tells somebody their volume made no difference on nearly
 * half the histories where it made a 50% difference. At /3 that falls to
 * around a fifth while a genuinely equal history over two years still
 * speaks more than half the time. /4 silences it almost entirely.
 *
 * WHAT THE TABLE ALSO SAYS, and it belongs in this comment rather than
 * buried: at a true ratio of 1.25x the rates are indistinguishable from
 * the equal case at every sample size a real person will ever produce.
 * This finding cannot tell "the same" from "a quarter more", and the
 * sentence it prints says what it COULD resolve for exactly that reason.
 */
export const POWER_MARGIN = 3

/**
 * TUNING TARGET. How much bigger the high dose must be.
 *
 * The one genuinely arbitrary number that survived, and it is a
 * READABILITY gate rather than a statistical one: the sentence names two
 * figures, and "you progressed the same on 5 sets as on 6" is a rounding
 * artefact wearing a finding's clothes. 1.4 is the smallest gap where
 * the two numbers read as different doses. The statistics do not depend
 * on it — a real difference at 1.1 would simply be reported as a
 * difference — so moving it changes which sentences are worth printing,
 * not which ones are true.
 */
export const MIN_DOSE_RATIO = 1.4

export interface DoseContext {
  history: History
  index: ExerciseIndex
  now: number
  /** Same vocabulary weekly.ts uses, so confounds have one authority. */
  deloadDates?: string[]
  layoffDates?: string[]
  imported?: boolean
  seed?: number
  iterations?: number
  margin?: number
  /**
   * Consecutive weeks kept together when resampling. Defaults to
   * DOSE_BLOCK_WEEKS.
   *
   * Exposed because it is the knob this finding is most sensitive to,
   * and because a calibration that cannot be re-run is a claim rather
   * than a measurement.
   */
  blockWeeks?: number
}

export interface DoseVerdict extends ShadowVerdict {
  feature: 'minimum_effective_dose'
  /** The smallest difference this test could have seen. */
  detectable: number
}

const mean = (x: number[]) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : 0)
/* Significant figures, from the one place that decides them. A weekly
   progression rate quantised to four decimal places is a rate of zero. */
const round = significant

interface WeekRow {
  /** Hard sets for this muscle that week. */
  sets: number
  /** Set-weighted relative change in e1RM. */
  progression: number
}

/**
 * Weekly volume and progression, per muscle, oldest first.
 *
 * Only weeks the muscle was actually trained appear. A week off is a
 * real event, but folding it in would pair zero volume with zero
 * progression and manufacture the very correlation under test.
 */
function weeklyRows(ctx: DoseContext): Map<Muscle, Map<number, WeekRow>> {
  const weekOf = weekIndexer(ctx.now)

  /* Volume, straight from the shared attribution. A second answer to
     "which muscle did this set belong to" is how two screens come to
     disagree. */
  const volume = new Map<Muscle, Map<number, number>>()
  const liftSets = new Map<string, Map<number, Map<Muscle, number>>>()
  for (const row of attribute(ctx.history || {}, ctx.index || {})) {
    const w = weekOf(row.date)
    const byWeek = volume.get(row.muscle) || new Map<number, number>()
    byWeek.set(w, (byWeek.get(w) || 0) + row.sets)
    volume.set(row.muscle, byWeek)

    const perLift = liftSets.get(row.exerciseId) || new Map<number, Map<Muscle, number>>()
    const perWeek = perLift.get(w) || new Map<Muscle, number>()
    perWeek.set(row.muscle, (perWeek.get(row.muscle) || 0) + row.sets)
    perLift.set(w, perWeek)
    liftSets.set(row.exerciseId, perLift)
  }

  /* Relative change per lift, from the shared authority. Transfer
     between lifts correlates the same quantity across two lifts; two
     implementations of "did this lift go up this week" is how two
     findings come to disagree about the same history. */
  const liftChange = new Map<string, Map<number, number>>()
  for (const id of Object.keys(ctx.history || {})) {
    liftChange.set(id, weeklyRelativeChange(ctx.history[id], weekOf))
  }

  const out = new Map<Muscle, Map<number, WeekRow>>()
  for (const [muscle, byWeek] of volume) {
    const rows = new Map<number, WeekRow>()
    for (const [w, sets] of byWeek) {
      /* Future-dated rows, filtered ONCE. There were two of these, one in
         each loop above, and each masked the other: with either removed
         the other still kept the week out, so neither could be shown to
         matter. Here it is the single place a negative week can reach a
         result, so removing it changes an answer. */
      if (w < 0) continue
      let weighted = 0
      let weight = 0
      for (const [id, perLift] of liftSets) {
        const share = perLift.get(w)?.get(muscle)
        const change = liftChange.get(id)?.get(w)
        if (!share || change == null) continue
        weighted += share * change
        weight += share
      }
      if (!weight) continue
      rows.set(w, { sets, progression: weighted / weight })
    }
    out.set(muscle, rows)
  }
  return out
}

interface DoseSplit {
  /** Progression in the high-dose weeks. */
  hi: number[]
  lo: number[]
  /** Mean weekly sets in each group, rounded to whole sets. */
  highVolume: number
  lowVolume: number
}

/**
 * High-dose weeks against low-dose weeks, in ONE place.
 *
 * This was written out three times — once in the statistic, once for the
 * gate, once for the sentence — and mutation testing lit up every
 * boundary in all three. Three answers to "which weeks were the heavy
 * ones" is three chances for the sentence to name volumes the statistic
 * never tested.
 *
 * The cut is the MEAN rather than the median: with an even number of
 * weeks split evenly between two regimes the median IS one of the two
 * values, so `> median` selects nothing and the whole comparison
 * silently collapses to a constant.
 */
function splitByDose(series: number[], labels: number[]): DoseSplit {
  const cut = mean(labels)
  const hiAt: number[] = []
  const loAt: number[] = []
  const hiLabels: number[] = []
  const loLabels: number[] = []
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] > cut) { hiAt.push(series[i]); hiLabels.push(labels[i]) }
    else { loAt.push(series[i]); loLabels.push(labels[i]) }
  }
  return {
    hi: hiAt, lo: loAt,
    highVolume: Math.round(mean(hiLabels)),
    lowVolume: Math.round(mean(loLabels)),
  }
}

/**
 * Mean progression at the high dose minus mean at the low dose.
 *
 * No empty-side guard. The labels are identical on every resample — only
 * the outcome series is permuted — so if the split is usable once it is
 * usable every time, and doseVerdicts refuses a degenerate split before
 * this is ever called. A check here could not be made to fire.
 */
function doseGap(series: number[], labels: number[]): number {
  const { hi, lo } = splitByDose(series, labels)
  return mean(hi) - mean(lo)
}

function confoundsFor(ctx: DoseContext, from: string, to: string): string[] {
  const found: string[] = []
  const inside = (d: string) => d >= from && d <= to
  if ((ctx.deloadDates || []).some(inside)) found.push('a deload sits inside this window')
  if ((ctx.layoffDates || []).some(inside)) found.push('a layoff sits inside this window')
  if (ctx.imported) found.push('some of this history was imported rather than logged here')
  return found
}

/**
 * A weekly rate, as a percentage somebody can read.
 *
 * Exported so its boundaries can be tested directly. The alternative was
 * reaching them through a manufactured history whose progression happens
 * to land on exactly 0.1% a week, which tests the fixture rather than
 * the function.
 *
 * Two significant figures, not one decimal place. The resolution figure
 * this sentence quotes is routinely a few hundredths of a percent a
 * week, and one decimal place printed it as "0%" — a sentence claiming
 * the two doses were the same "to within 0%", which is both meaningless
 * and the strongest possible version of a claim this deliberately
 * bounds.
 */
export function weeklyPercent(x: number): string {
  const percent = x * 100
  /* No zero case. `(0).toFixed(3)` is "0.000" and Number turns that back
     into 0, so the general path already prints "0%" — a special case for
     it could never be shown to change an answer. */
  /* Both `<` here are equivalent to `<=` and mutation testing will
     always report them as survivors. At exactly 0.1 the two branches
     give "0.100" and "0.10", and at exactly 1 they give "1.00" and
     "1.0" — Number strips the trailing zeros either way, so the
     boundary value is the one place the branches cannot differ.
     Equivalent mutations, not gaps. */
  const places = Math.abs(percent) < 0.1 ? 3 : Math.abs(percent) < 1 ? 2 : 1
  return `${Number(percent.toFixed(places))}%`
}

const pct = weeklyPercent

/**
 * One verdict per muscle with enough history, fired or not.
 *
 * Returns the silent ones too. A log of only the hits cannot answer "how
 * often would this have spoken", which is the question shadow mode
 * exists to settle.
 */
export function doseVerdicts(ctx: DoseContext): DoseVerdict[] {
  if (!ctx || !ctx.now) return []
  const today = dateKey(ctx.now)
  const out: DoseVerdict[] = []

  for (const [muscle, rows] of weeklyRows(ctx)) {
    const weeks = [...rows.keys()].sort((a, b) => b - a) // oldest first
    if (weeks.length < MIN_TRAINED_WEEKS) continue

    const series = weeks.map((w) => (rows.get(w) as WeekRow).progression)
    const labels = weeks.map((w) => (rows.get(w) as WeekRow).sets)

    const split = splitByDose(series, labels)
    if (!split.hi.length || !split.lo.length) continue
    const { highVolume, lowVolume } = split

    const result = blockPermutationTest({
      series, labels, statistic: doseGap,
      blockSize: ctx.blockWeeks ?? DOSE_BLOCK_WEEKS,
      iterations: ctx.iterations ?? DEFAULT_ITERATIONS,
      seed: ctx.seed ?? 1,
      margin: ctx.margin ?? DEFAULT_MARGIN,
    })

    /* The athlete's own yardstick. Not a constant: the question is
       whether the gap between doses is small compared with how fast THIS
       person is moving, and somebody adding 0.1% a week and somebody
       adding 1% a week do not share an answer. */
    const overall = mean(series)

    /* No `lowVolume > 0` here. Every week in this series was a week the
       muscle was trained, so its mean set count cannot round to zero and
       the division cannot blow up — a check for it could never fire. */
    const enoughSeparation = highVolume / lowVolume >= MIN_DOSE_RATIO

    /**
     * THE POWER GATE, and it carries "are they progressing at all" too.
     *
     * Without it, silence and equivalence are the same output, and a
     * thin noisy log reads as proof that volume does not matter. It also
     * subsumes the separate `overall > 0` check that used to sit beside
     * it: `detectable` is a half-width and so never negative, which
     * makes this false whenever overall is zero or negative. Two guards
     * where one can never fire alone is the pattern this codebase keeps
     * finding; the one kept is the one that means something on its own.
     */
    const couldHaveSeen = result.detectable < overall / POWER_MARGIN

    /* Calendar days, not milliseconds. Eighty weeks back crosses the
       clock change twice, and the millisecond version lands the window
       boundary on the wrong date — which showed up as a deload dated
       exactly on the edge going unnamed. */
    const from = shiftDaysBack(ctx.now, weeks[0] * 7)
    const confounds = confoundsFor(ctx, from, today)
    const tail = confounds.length ? ` Worth knowing: ${confounds.join('; ')}.` : ''

    out.push({
      feature: 'minimum_effective_dose',
      subject: muscle,
      /* Dated to the week, not the day. Three sessions a week would
         otherwise write three near-identical rows and fill the log four
         times as fast for no extra answer. */
      date: weekStartOf(ctx.now),
      would: result.usable && !result.outside && enoughSeparation && couldHaveSeen,
      /* A co-occurrence in their own log, with both numbers and the rate
         attached. It does not tell anybody to train less, because this
         engine has no way to know that — two volumes and one outcome is
         an observation, and calling it a dose-response would be the app
         asserting causation from a sample size of one person. */
      /* The claim is BOUNDED, out loud. "The same" on its own invites the
         reader to hear "and so the extra sets did nothing", which is a
         stronger statement than any amount of this data supports — the
         calibration on POWER_MARGIN says a 25% difference is invisible
         here at every sample size a person will produce. Naming what the
         log could resolve is what lets somebody weigh it. */
      text: `${muscle.replace(/_/g, ' ')}: across ${weeks.length} weeks you gained about ${pct(mean(split.lo))} a week on ${lowVolume} hard sets and ${pct(mean(split.hi))} a week on ${highVolume} — the same, to within the ${pct(result.detectable)} a week your log can resolve. A smaller difference than that would not show up here. A co-occurrence, not a prescription.${tail}`,
      effect: result.effect,
      p: result.p,
      z: result.z,
      nullMean: result.nullMean,
      nullSd: result.nullSd,
      detectable: result.detectable,
      iterations: result.iterations,
      blocks: result.blocks,
      inputs: {
        lowVolume, highVolume, weeks: weeks.length,
        /* The period this is about. In the log because "which weeks?" is
           the first question anybody reading a verdict back will ask, and
           because it is not guessable from the outside: the window starts
           at the oldest week that carries a progression observation,
           which is one week after the oldest session. */
        from, to: today,
        weeklyProgression: round(overall),
        /* What the test could resolve, logged beside what it found. A
           verdict read back in a year is only interpretable next to the
           resolution it was made at. */
        detectable: result.detectable,
        autocorrelation: result.autocorrelation,
        separation: round(highVolume / lowVolume, 2),
      },
      confounds,
    })
  }

  return out.sort((a, b) => a.subject.localeCompare(b.subject))
}

/**
 * The only read.
 *
 * Null while the feature is shadowed, which is today and every day until
 * a flag in shadow.ts flips. Everything above still runs.
 */
/**
 * Compute every verdict and write it down. Surfaces nothing.
 *
 * This is the call the app makes. It exists as its own function because
 * a feature that computes without recording is inert: the whole argument
 * for shipping these silent is that months of logged verdicts are what
 * turn the gates from guesses into something tuned, and a log nobody
 * writes to answers nothing.
 */
export function recordDose(log: ShadowLog, ctx: DoseContext): number {
  let written = 0
  for (const verdict of doseVerdicts(ctx)) {
    if (recordVerdict(log, verdict)) written++
  }
  return written
}

export function doseNote(ctx: DoseContext, overrides?: ShadowOverrides): string | null {
  /* The clearest one: furthest inside the null relative to what the test
     could resolve, which is the verdict with the most evidence behind its
     claim of no difference. No empty-list guard — sorting nothing gives
     undefined, and surface(undefined) is already null, so a check here
     could never change an answer.

     No `|| 1` on the divisor either: a fired verdict has passed
     `detectable < overall` with overall positive, so detectable is
     positive by construction. */
  const best = [...doseVerdicts(ctx)]
    .filter((v) => v.would)
    .sort((a, b) => Math.abs(a.effect) / a.detectable - Math.abs(b.effect) / b.detectable)[0]
  return surface(best, overrides)
}
