/**
 * A null built from the athlete's own history.
 *
 * Every other gate in this engine is a constant somebody chose. Most of
 * them are defensible — an increment is loadable or it is not — but the
 * two findings this module exists for are not that shape. "You progressed
 * the same on twelve sets as on eighteen" and "your front squat led your
 * back squat by three weeks" both need an effect size, and there is no
 * honest way to pick one: what counts as a real difference for somebody
 * adding ten pounds a week is noise for somebody adding two and a half.
 *
 * So no constant is picked. The observed effect is compared against a
 * distribution of effects resampled from THIS person's own record, with
 * the link between cause and outcome broken. If the real number sits
 * inside that distribution, the same number would routinely arise from
 * their history by chance, and there is nothing to say.
 *
 * WHY BLOCKS, AND WHY THIS IS THE WHOLE DESIGN.
 *
 * Training history is autocorrelated: this week resembles last week,
 * because bodies and programmes have momentum. Shuffling individual
 * weeks destroys that structure and produces a null far smoother and
 * far TIGHTER than anything the athlete's history could actually
 * produce — so almost any real effect clears it. That is manufacturing
 * significance, and it is the standard way this analysis is got wrong.
 *
 * Permuting BLOCKS of consecutive weeks keeps the local structure intact
 * and breaks only the alignment between the labels and the outcome,
 * which is the thing actually under test. `blockSize: 1` is naive
 * shuffling by another name, and there is a test holding the difference
 * so nobody quietly lowers it.
 *
 * WHAT COMES BACK IS AN EFFECT AND AN UNCERTAINTY, not a verdict. A
 * caller that wants a yes/no can read `outside`, but the size of the
 * effect and the spread of the null are on the result, because "your
 * progression differed by 0.4 lb a week, and chance alone produces
 * differences of 0.3" is a fact somebody can weigh and "significant" is
 * not.
 *
 * Pure, DOM-free, and deterministic: no Math.random anywhere.
 */

/**
 * TUNING TARGET. Resamples per test.
 *
 * 400 puts the smallest reportable p at 1/401 ≈ 0.0025, comfortably
 * below the margin, and costs a few milliseconds on series this short.
 * Raising it narrows the granularity of p; it cannot change a verdict
 * that was not already borderline.
 */
export const DEFAULT_ITERATIONS = 400

/**
 * TUNING TARGET. How far outside the null an effect must fall.
 *
 * 0.05 two-sided is convention, not physiology, and it is the one number
 * here that is genuinely arbitrary. It is defensible as a STARTING point
 * because it is at least a stated, checkable rule rather than a guessed
 * effect size — and because shadow mode means the first months of real
 * verdicts can be read back and this number moved against evidence
 * instead of taste. See docs/train-verification.md.
 */
export const DEFAULT_MARGIN = 0.05

/**
 * TUNING TARGET. Blocks needed before a permutation test means anything.
 *
 * With b blocks there are b! arrangements, and the smallest achievable
 * p is about 1/b!. Four blocks gives 24 and a floor of ~0.04, which only
 * just clears a 0.05 margin — so four is the absolute minimum at which a
 * result can exist at all, and anything below it is reported unusable
 * rather than silently impossible.
 */
export const MIN_BLOCKS = 4

/*
 * There is deliberately no shared BLOCK_WEEKS here.
 *
 * There was one, on the reasoning that a training block is about a
 * month and both findings resample the same kind of weekly series. That
 * reasoning is fine and the number it produced was wrong, in opposite
 * directions for the two features — see the calibration tables in
 * docs/train-verification.md. Each owns its own, measured against a
 * simulated null rather than argued from first principles.
 */

/**
 * A seeded generator, because a finding that changes when you look at it
 * twice is not a finding.
 *
 * mulberry32: small, fast, and good enough for resampling. The important
 * property is not statistical excellence but reproducibility — the same
 * history must always produce the same verdict, or the shadow log is
 * recording noise about itself.
 */
export function seededRandom(seed: number): () => number {
  let a = (seed >>> 0) || 1
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Reorder whole blocks of consecutive observations.
 *
 * Every value survives — this is a permutation, not a bootstrap — so the
 * marginal distribution of the series is exactly preserved and only the
 * ordering changes. A block size at or above the series length returns
 * the series untouched, which is the honest behaviour: there is one
 * block and nothing to permute.
 */
export function blockPermute<T>(series: T[], blockSize: number, rand: () => number): T[] {
  const size = Math.max(1, Math.floor(blockSize))
  const blocks: T[][] = []
  for (let i = 0; i < series.length; i += size) blocks.push(series.slice(i, i + size))

  /* Fisher-Yates. `i > 0` and `i >= 0` are genuinely equivalent here —
     the extra pass swaps block 0 with itself and no draws follow it — so
     mutation testing reports that flip as a survivor forever. It is an
     equivalent mutation, not a gap. */
  for (let i = blocks.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[blocks[i], blocks[j]] = [blocks[j], blocks[i]]
  }
  return ([] as T[]).concat(...blocks)
}

/**
 * Lag-one autocorrelation.
 *
 * Present so the block-permutation claim is testable rather than
 * asserted: a blocked resample should keep this near the real value
 * where a naive shuffle drives it to zero.
 */
export function lag1Autocorrelation(series: number[]): number {
  /* No length guard. There was one — `series.length < 3`, then `< 2` —
     and mutation testing showed it could be deleted outright without a
     single test noticing, because the `den === 0` return below already
     answers every case it did: one point has no spread, and an empty
     series has no spread either. Two guards where either alone suffices
     means neither can be shown to matter, and the one kept is the one
     that fires on real data (a lifter who held the same weight all
     block) rather than only on degenerate input. Fourth instance of this
     pattern; see docs/train-verification.md. */
  const mean = series.reduce((a, b) => a + b, 0) / series.length
  let num = 0
  let den = 0
  for (let i = 0; i < series.length; i++) {
    const d = series[i] - mean
    den += d * d
    if (i + 1 < series.length) num += d * (series[i + 1] - mean)
  }
  return den === 0 ? 0 : num / den
}

export interface ResampleOptions {
  /** The outcome, ordered oldest first. One value per period. */
  series: number[]
  /** The thing it is being related to, aligned with `series`. */
  labels: number[]
  /** The effect being tested, in whatever units the caller thinks in. */
  statistic: (series: number[], labels: number[]) => number
  /** Consecutive periods kept together. Never 1 on real data. */
  blockSize: number
  iterations?: number
  seed?: number
  margin?: number
}

export interface ResampleResult {
  /** The observed effect, in the statistic's own units. */
  effect: number
  nullMean: number
  nullSd: number
  /** Resamples actually performed. Counted, not echoed back. */
  p: number
  /** The effect in null standard deviations. 0 when the null is flat. */
  z: number
  /** Empirical lower edge of the null at the margin. */
  nullLow: number
  /** Empirical upper edge of the null at the margin. */
  nullHigh: number
  /**
   * Half the width of that band: the smallest effect this test could
   * have told apart from chance.
   *
   * The reason it is here rather than derived by callers: a finding that
   * claims NO difference is only honest if a difference would have been
   * visible, and that check needs the band in the same units as the
   * effect. A standard deviation would assume the null is normal, which
   * a block permutation over a handful of blocks is not.
   */
  detectable: number
  /**
   * Lag-one autocorrelation of the outcome series.
   *
   * Recorded because it is the number that decides whether blocking
   * mattered at all. A history with an autocorrelation near zero would
   * give much the same null under a naive shuffle; one near 0.8 would
   * not, and the gap between those two cases is what the block size is
   * being tuned against. Without it in the log, `BLOCK_WEEKS` could only
   * ever be argued about.
   */
  autocorrelation: number
  /** p below the margin, and enough blocks for that to mean anything. */
  outside: boolean
  /** False when the history is too short or the inputs do not line up. */
  usable: boolean
  /**
   * Resamples actually performed.
   *
   * Counted from the null distribution rather than echoed back from the
   * argument. Echoing it is a second source of truth: a loop that ran a
   * different number of times than it was asked to would still report
   * the number it was asked for, and the p it divided by would be wrong
   * in a way nothing could observe.
   */
  iterations: number
  blocks: number
  /** Why it is unusable, when it is. */
  reason: string | null
}

/**
 * Keep the number's information, not its decimal places.
 *
 * This rounded to four decimal places, and that quantised the results to
 * nothing: these findings work in fractional weekly change, so an effect
 * of 0.00004 — four thousandths of a percent a week — became exactly 0
 * before it ever reached the log. A verdict recorded with its evidence
 * zeroed out is a verdict recorded without its evidence.
 *
 * Significant figures let the scale of the quantity decide the
 * precision, which is what is wanted when the same function formats a
 * p-value and a weekly progression rate.
 */
export const significant = (n: number, digits = 4): number =>
  /* No finite or zero guard. There was one, and mutation testing showed
     it could be inverted without a single test noticing, because
     toPrecision handles every case it was written for: zero gives
     "0.000", NaN gives "NaN", an infinity gives "Infinity", and Number
     parses all three straight back. A guard for cases the operation
     already handles cannot be shown to do anything. */
  Number(n.toPrecision(digits))

const round = significant

/** Compare an observed effect against the athlete's own resampled history. */
export function blockPermutationTest(opts: ResampleOptions): ResampleResult {
  const series = opts.series || []
  const labels = opts.labels || []
  const iterations = Math.max(1, Math.floor(opts.iterations ?? DEFAULT_ITERATIONS))
  const margin = opts.margin ?? DEFAULT_MARGIN
  const size = Math.max(1, Math.floor(opts.blockSize || 1))
  const blocks = Math.ceil(series.length / size)

  const empty = (reason: string): ResampleResult => ({
    effect: 0, nullMean: 0, nullSd: 0, p: 1, z: 0,
    nullLow: 0, nullHigh: 0, detectable: 0, autocorrelation: 0,
    outside: false, usable: false, iterations, blocks, reason,
  })

  /* Mismatched inputs are a caller bug, and guessing which one is right
     would turn it into a silent wrong answer. */
  if (series.length !== labels.length) return empty('series and labels differ in length')
  if (blocks < MIN_BLOCKS) return empty(`only ${blocks} blocks; ${MIN_BLOCKS} needed`)

  const effect = opts.statistic(series, labels)
  const rand = seededRandom(opts.seed ?? 1)

  const nulls: number[] = []
  for (let i = 0; i < iterations; i++) {
    nulls.push(opts.statistic(blockPermute(series, size, rand), labels))
  }

  const ran = nulls.length
  const nullMean = nulls.reduce((a, b) => a + b, 0) / ran
  const variance = nulls.reduce((a, b) => a + (b - nullMean) ** 2, 0) / nulls.length
  const nullSd = Math.sqrt(variance)

  /* Two-sided, and centred on the null's own mean rather than on zero —
     a statistic with a structural offset would otherwise look extreme in
     one direction for a reason that has nothing to do with the athlete.
     The +1 on both sides is the standard correction: a permutation test
     cannot honestly report p = 0, because the observed arrangement is
     itself one of the arrangements. */
  const observed = Math.abs(effect - nullMean)
  const atLeastAsExtreme = nulls.filter((n) => Math.abs(n - nullMean) >= observed).length
  const p = (atLeastAsExtreme + 1) / (ran + 1)

  const sorted = [...nulls].sort((a, b) => a - b)
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))]
  const nullLow = at(margin / 2)
  const nullHigh = at(1 - margin / 2)

  return {
    effect: round(effect),
    nullMean: round(nullMean),
    nullSd: round(nullSd),
    nullLow: round(nullLow),
    nullHigh: round(nullHigh),
    detectable: round((nullHigh - nullLow) / 2),
    autocorrelation: significant(lag1Autocorrelation(series), 3),
    p: round(p),
    z: nullSd > 0 ? significant((effect - nullMean) / nullSd, 3) : 0,
    /* Strictly below. Landing exactly ON the margin is not clearing it,
       and the conservative direction is the right one for a finding
       somebody may cut a third of their training over. */
    outside: p < margin,
    usable: true,
    iterations: ran,
    blocks,
    reason: null,
  }
}
