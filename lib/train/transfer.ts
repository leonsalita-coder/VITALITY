/**
 * "Your front squat and your back squat moved together, about three
 * weeks apart."
 *
 * Lead-lag between lifts, on a CLOSED list of physiologically plausible
 * pairs. An open-ended search is a multiple-testing machine: twenty
 * lifts is a hundred and ninety pairs, times a dozen candidate lags, and
 * something always clears. The list is the control, and it is the only
 * reason this is a finding rather than a trawl.
 *
 * DIRECTION IS NOT CLAIMED, which is a decision rather than an
 * omission.
 *
 * "Front squat led back squat" and "back squat led front squat" are two
 * different hypotheses, and one athlete's own log cannot separate them.
 * Both lifts sit in the same programme, are trained in the same weeks,
 * and share every common cause there is — sleep, food, a bulk, a new
 * block, deload timing, and simply getting better at squatting. A peak
 * at three weeks is as well explained by a common cause sampled slightly
 * differently on the two lifts as by anything transferring between them.
 *
 * The alternative was declaring a direction per pair and testing only
 * that direction. It is WORSE, and for a specific reason: never testing
 * the reverse means never seeing that the reverse fits better, so a
 * wrong-direction report becomes structurally invisible. Testing both
 * and then gating on the declared direction winning would need a null of
 * its own and, with one athlete, would never clear.
 *
 * So both directions go into one null, the sentence gives the MAGNITUDE
 * of the offset, and the signed lag goes into the shadow log anyway. If
 * after a year the peak falls the same way for the same pair every time,
 * that is the evidence that would justify a directional sentence — which
 * is exactly what the log is for.
 *
 * WHY MAX-OVER-LAGS NEEDS NO CORRECTION. The statistic is the largest
 * correlation across every candidate lag, and the null is built by
 * recomputing that same largest-across-lags statistic on each resample.
 * The multiplicity is therefore inside the null already. A Bonferroni
 * correction on top would be counting it twice.
 *
 * SILENCE IS THE EXPECTED OUTCOME. Thirty-two weeks where both lifts
 * produced an estimate is roughly eight months of training both most
 * weeks, and most people will never reach that on most pairs. So a pair
 * that cannot be tested still writes a row recording how much overlap it
 * has against how much it needs — otherwise the log cannot tell "nothing
 * there" from "never had enough history to ask", and a year from now
 * that is the only question worth asking of it.
 *
 * Pure and DOM-free.
 */

import { catalogExercise } from './catalog'
import { weekIndexer, weeklyRelativeChange } from './liftweeks'
import { blockPermutationTest, DEFAULT_ITERATIONS, DEFAULT_MARGIN } from './resample'
import { recordVerdict, surface, type ShadowLog, type ShadowOverrides, type ShadowVerdict } from './shadow'
import { dateKey, shiftDaysBack, weekStartOf } from './windows'
import type { History } from './analysis'

export interface LiftPair {
  /** Stable id. Unordered: the two lifts are not driver and follower. */
  id: string
  a: string
  b: string
  /** Largest offset worth testing, in weeks, in EITHER direction. */
  maxLagWeeks: number
  /** Why this pair is on the list. Printed in the log, not to the athlete. */
  why: string
}

/**
 * TUNING TARGET, and the one number here chosen by measurement.
 *
 * Consecutive weeks kept together when resampling. Eight, not the four
 * a "training block is about a month" argument gives.
 *
 * Measured: two INDEPENDENT autocorrelated series, asked how often this
 * finding fires on them. It should be 5%, the margin. It was not.
 *
 *   autocorrelation   block 1   block 4   block 6   block 8
 *   phi 0.60           20.8%     5.8%      5.0%      5.0%
 *   phi 0.75           25.0%     9.2%      6.7%      5.0%
 *   phi 0.85           33.3%    15.0%      7.5%      6.7%
 *
 * Naive shuffling fires on a third of unrelated pairs. Four weeks is
 * still two to three times the nominal rate once the history is as
 * autocorrelated as real training is — a block of four is about the
 * length of the correlation itself, so most of the structure is
 * destroyed at the block boundaries anyway.
 *
 * Checked again at the sample sizes this actually runs at, since a gate
 * should be calibrated where it is weakest rather than where it is
 * comfortable (phi 0.85, 160 draws each):
 *
 *   overlap   33w    41w    49w    57w    65w    73w
 *   block 4   7.5%   8.8%  11.3%  11.3%  10.0%  11.3%
 *   block 8   3.1%   3.8%   1.3%   3.8%   4.4%   4.4%
 *
 * Eight holds at or under the margin everywhere. Raising it further
 * (ten, thirteen) only makes the test more conservative and costs
 * findings, which is a worse trade than it looks: this one is already
 * expected to be silent for most people.
 */
export const TRANSFER_BLOCK_WEEKS = 8

/**
 * TUNING TARGET. Weeks where BOTH lifts produced an estimate.
 *
 * Thirty-two, which is four blocks of eight — the floor on a permutation
 * p is one over the number of arrangements, and four blocks gives 1/24 ≈
 * 0.042, which clears a 0.05 margin only just. That is the minimum at
 * which a result can exist at all, and the calibration above says the
 * false-positive rate at exactly that boundary is 3.1% rather than the
 * 7.5% four-week blocks give, so the marginal floor is not what limits
 * this in practice.
 *
 * In practice this is about eight months of training both lifts most
 * weeks. Most people will never reach it on most pairs, and that is the
 * expected outcome rather than a fault.
 */
export const MIN_OVERLAP_WEEKS = 32

/**
 * TUNING TARGET. Pairs a single lag must rest on to be eligible.
 *
 * Half the required overlap. A lag resting on far fewer pairs than its
 * neighbours is a noisier estimate of the same quantity, and the maximum
 * across lags would tend to pick it for that reason alone — the
 * multiplicity control assumes the candidates are comparable.
 */
export const MIN_PAIRS_PER_LAG = MIN_OVERLAP_WEEKS / 2

/**
 * The closed list.
 *
 * Unordered pairs. Each is a movement that plausibly shares a limiting
 * structure with its partner — the same pattern, the same prime movers,
 * or one is a restricted version of the other. Nothing here is on the
 * list because it looked promising in somebody's data; the list is a
 * prior, written down before any data is examined, which is the only
 * thing that makes it a control.
 *
 * Lags are short. A month either way covers the plausible window for one
 * lift's strength showing up in another; beyond that any correlation is
 * far more likely to be a training block than a transfer.
 */
export const TRANSFER_PAIRS: LiftPair[] = [
  { id: 'back_squat+front_squat', a: 'back_squat', b: 'front_squat', maxLagWeeks: 4,
    why: 'the same squat pattern, both limited by the quads and the upper back' },
  { id: 'back_squat+leg_press', a: 'back_squat', b: 'leg_press', maxLagWeeks: 4,
    why: 'knee extension under load, without the trunk requirement' },
  { id: 'deadlift+romanian_deadlift', a: 'deadlift', b: 'romanian_deadlift', maxLagWeeks: 4,
    why: 'the same hinge, sharing the hamstrings and the lower back' },
  { id: 'deadlift+hip_thrust', a: 'deadlift', b: 'hip_thrust', maxLagWeeks: 4,
    why: 'loaded hip extension, which is what finishes a deadlift' },
  { id: 'bench_press+incline_bench_press', a: 'bench_press', b: 'incline_bench_press', maxLagWeeks: 4,
    why: 'the same horizontal press at a different angle' },
  { id: 'bench_press+overhead_press', a: 'bench_press', b: 'overhead_press', maxLagWeeks: 4,
    why: 'shared triceps and front delts through the lockout' },
  { id: 'bench_press+dip', a: 'bench_press', b: 'dip', maxLagWeeks: 4,
    why: 'a press sharing the chest and triceps' },
  { id: 'chin_up+pull_up', a: 'chin_up', b: 'pull_up', maxLagWeeks: 4,
    why: 'the same vertical pull, differing only in grip' },
  { id: 'pull_up+lat_pulldown', a: 'pull_up', b: 'lat_pulldown', maxLagWeeks: 4,
    why: 'the same vertical pull, one loaded by bodyweight and one by a stack' },
  { id: 'barbell_row+seated_cable_row', a: 'barbell_row', b: 'seated_cable_row', maxLagWeeks: 4,
    why: 'the same horizontal pull through the mid-back' },
  { id: 'barbell_curl+chin_up', a: 'barbell_curl', b: 'chin_up', maxLagWeeks: 4,
    why: 'elbow flexion under load, which a chin-up is partly limited by' },
]

export interface TransferContext {
  history: History
  now: number
  /** Same vocabulary weekly.ts uses, so confounds have one authority. */
  deloadDates?: string[]
  layoffDates?: string[]
  imported?: boolean
  /** The list is data. Overridable so the gates can be tested at their edges. */
  pairs?: LiftPair[]
  /**
   * Consecutive weeks kept together when resampling. Defaults to
   * TRANSFER_BLOCK_WEEKS.
   *
   * Exposed because it is the tuning knob these findings are most
   * sensitive to, and because setting it to 1 — naive shuffling — is the
   * only way to demonstrate, on a real history through the real code
   * path, that blocking is what stops this manufacturing significance.
   * A claim about the design that nothing can exercise is a comment.
   */
  blockWeeks?: number
  seed?: number
  iterations?: number
  margin?: number
}

export type TransferStatus = 'fired' | 'no_effect' | 'not_enough_overlap'

export interface TransferVerdict extends ShadowVerdict {
  feature: 'transfer_between_lifts'
  /** Magnitude of the offset, in weeks. Never signed in the sentence. */
  lagWeeks: number
  /**
   * Which lift's series came first at the peak.
   *
   * Logged and never surfaced. One athlete's log cannot establish this,
   * but if the same pair peaks the same way month after month, that
   * accumulated record is what would justify saying it out loud.
   */
  ledAtPeak: string | null
  overlapWeeks: number
  status: TransferStatus
}

const mean = (x: number[]) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : 0)
const round = (n: number, p = 4) => Math.round(n * 10 ** p) / 10 ** p

/**
 * Pearson correlation between two aligned series at a given offset.
 *
 * `lag > 0` pairs a[i] with b[i + lag]: b's week is LATER, so a moved
 * first. Weeks run oldest to newest. Missing weeks are NaN and their
 * pairs are skipped rather than treated as zeros — a week nobody trained
 * is not a week of no progress.
 *
 * Returns 0 rather than null for an unusable lag. The caller takes a
 * maximum across lags, and zero is the correct neutral: a lag with
 * nothing behind it should never win.
 */
function correlationAt(a: number[], b: number[], lag: number): number {
  const xs: number[] = []
  const ys: number[] = []
  /* `i < a.length` and `i <= a.length` are equivalent here: one step
     past the end reads undefined, which the finite check refuses. An
     equivalent mutation, not a gap. */
  for (let i = 0; i < a.length; i++) {
    /* No bounds check. Reading past either end of an array gives
       undefined, which is not finite, so the check below already refuses
       it — and mutation testing showed the bounds guard could be deleted
       outright without a single test noticing, because its neighbour
       caught everything it did. Two guards where either alone suffices
       means neither can be shown to matter. The one kept is the one that
       also handles the case that occurs in real data: a week neither
       lift was trained. */
    const value = a[i]
    const partner = b[i + lag]
    if (!Number.isFinite(value) || !Number.isFinite(partner)) continue
    xs.push(value)
    ys.push(partner)
  }
  if (xs.length < MIN_PAIRS_PER_LAG) return 0

  const mx = mean(xs)
  const my = mean(ys)
  let num = 0
  let dx = 0
  let dy = 0
  for (let i = 0; i < xs.length; i++) {
    const p = xs[i] - mx
    const q = ys[i] - my
    num += p * q
    dx += p * p
    dy += q * q
  }
  /* A flat series has no correlation with anything. Zero rather than a
     division by nothing, and it is reachable: a lifter who held the same
     weight for the whole window produces exactly this. */
  const den = Math.sqrt(dx * dy)
  return den === 0 ? 0 : num / den
}

/** Every offset worth testing, both directions, excluding zero. */
function lagsFor(maxLag: number): number[] {
  const out: number[] = []
  for (let l = -maxLag; l <= maxLag; l++) {
    /* Zero is excluded deliberately. Same-week co-movement is not
       transfer by any reading — it is two lifts having a good week, which
       is what a good week is. Including it would let the trivial case
       win the maximum almost every time. */
    if (l !== 0) out.push(l)
  }
  return out
}

interface Peak {
  value: number
  /** Zero means no lag produced a correlation at all. */
  lag: number
}

/**
 * The strongest correlation across the lag range, and where it fell.
 *
 * A zero lag is impossible to find — zero is not a candidate — so it is
 * free to mean "nothing here". That case is reachable: a lifter who held
 * the same weight all window gives a flat series, every correlation is
 * undefined, and the honest answer is that there is no peak rather than
 * whichever lag happened to be visited first.
 *
 * There was a tie-break here, breaking toward the shorter offset. It was
 * unreachable: correlations are continuous, exact ties between two
 * usable lags do not occur, and the only exact ties are the zeros
 * returned for unusable lags, which can never be the maximum unless
 * every lag is zero — which is now its own answer. Deleted rather than
 * tested, because a branch nothing can reach cannot be shown to be
 * right.
 */
function peakCorrelation(a: number[], b: number[], maxLag: number): Peak {
  let best: Peak = { value: 0, lag: 0 }
  for (const lag of lagsFor(maxLag)) {
    const value = correlationAt(a, b, lag)
    if (value > best.value) best = { value, lag }
  }
  return best
}

const nameOf = (id: string) => catalogExercise(id)?.name || id.replace(/_/g, ' ')

function confoundsFor(ctx: TransferContext, from: string, to: string): string[] {
  const found: string[] = []
  const inside = (d: string) => d >= from && d <= to
  if ((ctx.deloadDates || []).some(inside)) found.push('a deload sits inside this window')
  if ((ctx.layoffDates || []).some(inside)) found.push('a layoff sits inside this window')
  if (ctx.imported) found.push('some of this history was imported rather than logged here')
  return found
}

/**
 * One verdict per curated pair, fired or not — including the pairs that
 * do not have the history to be asked.
 *
 * Returning the untestable ones is the point. An absent row cannot say
 * whether a pair was quiet or merely unasked, and after a year that is
 * the only question worth putting to this log.
 */
export function transferVerdicts(ctx: TransferContext): TransferVerdict[] {
  if (!ctx || !ctx.now) return []
  const today = dateKey(ctx.now)
  const weekOf = weekIndexer(ctx.now)
  const history = ctx.history || {}
  const out: TransferVerdict[] = []

  /* Memoised because several pairs share a lift — bench press is in
     three of them. Deleting the cache changes nothing but the time it
     takes, so mutation testing reports it as a survivor forever. An
     equivalent mutation, not a gap. */
  const changes = new Map<string, Map<number, number>>()
  const changeFor = (id: string) => {
    const seen = changes.get(id)
    if (seen) return seen
    const built = weeklyRelativeChange(history[id], weekOf)
    changes.set(id, built)
    return built
  }

  for (const pair of ctx.pairs || TRANSFER_PAIRS) {
    const aChanges = changeFor(pair.a)
    const bChanges = changeFor(pair.b)

    const overlap = [...aChanges.keys()].filter((w) => w >= 0 && bChanges.has(w))
    const overlapWeeks = overlap.length

    /* The grid runs oldest to newest across the whole span both lifts
       touch, with NaN where a week is missing. Blocks carry the
       missingness with them when they are permuted, which is right: a
       gap is part of the shape of the history, not noise to be filled. */
    const weeks = [...new Set([...aChanges.keys(), ...bChanges.keys()])].filter((w) => w >= 0)
    const oldest = weeks.length ? Math.max(...weeks) : 0
    const newest = weeks.length ? Math.min(...weeks) : 0
    const grid: number[] = []
    const a: number[] = []
    const b: number[] = []
    for (let w = oldest; w >= newest; w--) {
      grid.push(w)
      a.push(aChanges.has(w) ? (aChanges.get(w) as number) : NaN)
      b.push(bChanges.has(w) ? (bChanges.get(w) as number) : NaN)
    }

    const from = shiftDaysBack(ctx.now, oldest * 7)
    const confounds = confoundsFor(ctx, from, today)
    const base = {
      feature: 'transfer_between_lifts' as const,
      subject: pair.id,
      date: weekStartOf(ctx.now),
      overlapWeeks,
      confounds,
    }

    if (overlapWeeks < MIN_OVERLAP_WEEKS) {
      /* Logged, not skipped. This row is the difference between "no
         effect" and "not yet", and it is the row future-you reads. */
      out.push({
        ...base,
        would: false,
        status: 'not_enough_overlap',
        text: `${nameOf(pair.a)} and ${nameOf(pair.b)}: ${overlapWeeks} of the ${MIN_OVERLAP_WEEKS} shared weeks needed.`,
        lagWeeks: 0, ledAtPeak: null,
        effect: 0, p: 1, z: 0, nullMean: 0, nullSd: 0,
        iterations: 0, blocks: 0,
        inputs: {
          why: pair.why, from, to: today,
          overlapWeeks, needed: MIN_OVERLAP_WEEKS, maxLagWeeks: pair.maxLagWeeks,
        },
      })
      continue
    }

    const statistic = (series: number[], labels: number[]) =>
      peakCorrelation(series, labels, pair.maxLagWeeks).value

    const result = blockPermutationTest({
      series: a, labels: b, statistic,
      blockSize: ctx.blockWeeks ?? TRANSFER_BLOCK_WEEKS,
      iterations: ctx.iterations ?? DEFAULT_ITERATIONS,
      seed: ctx.seed ?? 1,
      margin: ctx.margin ?? DEFAULT_MARGIN,
    })

    const peak = peakCorrelation(a, b, pair.maxLagWeeks)
    /**
     * Outside the null. There is no sign guard, and there was.
     *
     * `outside` is two-sided, so in principle an unusually WEAK
     * co-movement also clears it, and "these two lifts moved together
     * less than chance predicts" is not a finding anybody asked for. A
     * `z > 0` check sat here for that reason and could never fire:
     * measured over 400 simulated athletes — 200 with the two lifts
     * deliberately mirrored, so every lag correlates negatively, and 200
     * unrelated — the combination of `outside` and a negative z occurred
     * exactly zero times.
     *
     * It is not an accident of those fixtures. The statistic is a
     * MAXIMUM across lags, and the null of a maximum is right-skewed
     * with almost no lower tail, so a real value can essentially never
     * sit far enough BELOW the null to clear a two-sided margin. The
     * two-sidedness is therefore conservative rather than wrong, and the
     * sign guard was a check on a case the statistic cannot produce.
     *
     * A guard that has never been seen to fail is theatre. The test that
     * mirrored pairs stay quiet is kept — it just does not attribute
     * that to a guard that was doing nothing.
     */
    const moved = result.usable && result.outside

    const tail = confounds.length ? ` Worth knowing: ${confounds.join('; ')}.` : ''

    out.push({
      ...base,
      would: moved,
      status: moved ? 'fired' : 'no_effect',
      lagWeeks: Math.abs(peak.lag),
      /* Null when there was no peak to have a direction. For any real
         peak the lag is non-zero, so `>` and `>=` are equivalent here and
         mutation testing will always report that flip. */
      ledAtPeak: peak.lag === 0 ? null : (peak.lag > 0 ? pair.a : pair.b),
      /* The offset's size, never its direction. Which lift led is not
         something a single athlete's log can establish — the two share a
         programme, a diet and a sleep schedule, and a common cause
         sampled a week apart looks exactly like transfer. */
      text: `${nameOf(pair.a)} and ${nameOf(pair.b)} moved together across ${overlapWeeks} shared weeks, about ${Math.abs(peak.lag)} week${Math.abs(peak.lag) === 1 ? '' : 's'} apart. Which one led is not something your log can tell — they share a programme and everything around it. A co-occurrence, not a cause.${tail}`,
      effect: result.effect,
      p: result.p,
      z: result.z,
      nullMean: result.nullMean,
      nullSd: result.nullSd,
      iterations: result.iterations,
      blocks: result.blocks,
      inputs: {
        why: pair.why, from, to: today,
        overlapWeeks, needed: MIN_OVERLAP_WEEKS,
        spanWeeks: grid.length,
        maxLagWeeks: pair.maxLagWeeks,
        peakLag: peak.lag,
        peakCorrelation: round(peak.value),
        autocorrelation: result.autocorrelation,
      },
    })
  }

  return out.sort((a2, b2) => a2.subject.localeCompare(b2.subject))
}

/**
 * Compute every verdict and write it down. Surfaces nothing.
 *
 * Its own function because a feature that computes without recording is
 * inert, and the entire argument for shipping these silent is that
 * months of logged verdicts are what turn guessed gates into tuned ones.
 */
export function recordTransfer(log: ShadowLog, ctx: TransferContext): number {
  let written = 0
  for (const verdict of transferVerdicts(ctx)) {
    if (recordVerdict(log, verdict)) written++
  }
  return written
}

export interface TransferReadiness {
  pair: string
  overlapWeeks: number
  needed: number
  ready: boolean
}

/**
 * How far off each pair is from being askable.
 *
 * Exists so that silence has an explanation somebody can read without
 * reconstructing it from the log. "Nothing fired" and "nothing could
 * have fired" look identical from the outside, and for the first year
 * of any real history the second is the true one.
 */
export function transferReadiness(ctx: TransferContext): TransferReadiness[] {
  return transferVerdicts(ctx).map((v) => ({
    pair: v.subject,
    overlapWeeks: v.overlapWeeks,
    needed: MIN_OVERLAP_WEEKS,
    ready: v.overlapWeeks >= MIN_OVERLAP_WEEKS,
  }))
}

/**
 * The only read.
 *
 * Null while the feature is shadowed, which is today and every day until
 * a flag in shadow.ts flips. Everything above still runs.
 */
export function transferNote(ctx: TransferContext, overrides?: ShadowOverrides): string | null {
  /* Strongest co-movement first. No empty-list guard: sorting nothing
     gives undefined, and surface(undefined) is already null. */
  const best = transferVerdicts(ctx)
    .filter((v) => v.would)
    .sort((x, y) => y.z - x.z)[0]
  return surface(best, overrides)
}
