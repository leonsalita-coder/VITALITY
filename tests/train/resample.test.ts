import { describe, it, expect } from 'vitest'
import {
  blockPermutationTest, blockPermute, lag1Autocorrelation, seededRandom,
  DEFAULT_ITERATIONS, DEFAULT_MARGIN, MIN_BLOCKS,
} from '../../lib/train/resample'

/**
 * A null built from the athlete's own history.
 *
 * The alternative is picking a magic effect size, and there is no honest
 * way to pick one: an effect that matters for a beginner adding ten
 * pounds a week is noise for somebody adding two and a half. Comparing
 * the observed effect against a distribution resampled from THIS
 * person's own record sidesteps the question entirely.
 *
 * WHY BLOCKS. Training history is autocorrelated — this week looks like
 * last week, because bodies and programmes have momentum. Shuffling
 * individual sessions destroys that structure and produces a null far
 * tighter than reality, which manufactures significance: almost any real
 * effect clears a null built from noise that is smoother than the data.
 * Permuting BLOCKS of consecutive weeks keeps the local structure and
 * only breaks the alignment between cause and effect, which is the thing
 * actually under test.
 */

describe('the random source is seeded', () => {
  it('gives the same sequence for the same seed', () => {
    const a = seededRandom(42)
    const b = seededRandom(42)
    expect([a(), a(), a()]).toEqual([b(), b(), b()])
  })

  it('gives a different sequence for a different seed', () => {
    const a = seededRandom(1)
    const b = seededRandom(2)
    expect(a()).not.toBe(b())
  })

  it('stays inside [0, 1)', () => {
    const r = seededRandom(7)
    for (let i = 0; i < 200; i++) {
      const v = r()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})

describe('block permutation keeps the shape of the data', () => {
  /* A strongly autocorrelated series: a slow wave, which is what a
     training block actually looks like. */
  const wave = Array.from({ length: 48 }, (_, i) => Math.sin(i / 6) * 10 + 20)

  it('preserves every value, just reordered', () => {
    const permuted = blockPermute(wave, 6, seededRandom(1))
    expect([...permuted].sort((a, b) => a - b)).toEqual([...wave].sort((a, b) => a - b))
  })

  it('keeps autocorrelation far better than naive shuffling', () => {
    const real = lag1Autocorrelation(wave)
    const blocked = lag1Autocorrelation(blockPermute(wave, 8, seededRandom(3)))

    const naive = [...wave]
    const rand = seededRandom(3)
    for (let i = naive.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1))
      ;[naive[i], naive[j]] = [naive[j], naive[i]]
    }
    const shuffled = lag1Autocorrelation(naive)

    expect(real).toBeGreaterThan(0.8)
    expect(blocked).toBeGreaterThan(shuffled + 0.3)
  })

  it('is deterministic for a given seed', () => {
    expect(blockPermute(wave, 6, seededRandom(9)))
      .toEqual(blockPermute(wave, 6, seededRandom(9)))
  })

  it('gives the same permutation it gave last month', () => {
    /* A pinned value, deliberately. The shadow log records a verdict with
       the null it was judged against, and the whole point of that log is
       that it can be re-derived from the same history months later. Any
       change to the generator, to how many draws the shuffle consumes,
       or to how the blocks are cut silently makes every logged verdict
       incomparable with every new one — a drift nothing else can see.
       If this test fails, the log's history must be treated as a
       different experiment, not merged with what comes after. */
    expect(blockPermute([1, 2, 3, 4, 5, 6, 7, 8], 2, seededRandom(1)))
      .toEqual([7, 8, 3, 4, 1, 2, 5, 6])
  })

  it('has a lag-one value for two points, which do have a pair', () => {
    /* Falsifiable at its own boundary, which the old `< 3` floor was not:
       two points give a defined answer, so a test can tell the guard
       from an off-by-one. */
    expect(lag1Autocorrelation([1, 2])).not.toBe(0)
    expect(lag1Autocorrelation([5])).toBe(0)
  })

  it('reports a flat series as zero rather than dividing by nothing', () => {
    expect(lag1Autocorrelation([4, 4, 4, 4])).toBe(0)
  })

  it('returns the series unchanged when a block covers all of it', () => {
    expect(blockPermute([1, 2, 3], 10, seededRandom(1))).toEqual([1, 2, 3])
  })
})

describe('the test itself', () => {
  /**
   * Two years of weeks, in thirteen-week regimes of low and high volume.
   *
   * Long deliberately. An earlier version of this fixture used 40 weeks
   * with a block size of 8, which gives five blocks and 120 possible
   * arrangements — a floor of p = 1/120 — and worse, a block size
   * synchronised with the regime length, so the only arrangements that
   * scored highly were the ones that put the regimes back where they
   * started. The test would have failed on a correct engine.
   */
  const n = 104
  const regime = 13
  const volume = Array.from({ length: n }, (_, i) => (Math.floor(i / regime) % 2 ? 18 : 8))
  const tracking = volume.map((v, i) => v * 0.5 + Math.sin(i / 5))
  const unrelated = Array.from({ length: n }, (_, i) => Math.sin(i / 5) * 3 + 10)
  const BLOCK = 4

  /**
   * Mean outcome in high-volume weeks minus mean in low-volume weeks.
   *
   * Split on the MEAN of the labels, not the median. The first version
   * used the median, and with 52 low weeks and 52 high weeks the median
   * IS the high value — so `> median` selected nothing, the statistic was
   * a constant, and every resampled null had zero spread. A fixture that
   * cannot vary cannot test a test for variation.
   */
  const mean = (x: number[]) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : 0)
  const meanGap = (series: number[], labels: number[]) => {
    const cut = mean(labels)
    const hi = series.filter((_, i) => labels[i] > cut)
    const lo = series.filter((_, i) => labels[i] <= cut)
    if (!hi.length || !lo.length) return 0
    return mean(hi) - mean(lo)
  }

  it('reports a manufactured effect as outside the null', () => {
    const result = blockPermutationTest({
      series: tracking, labels: volume, statistic: meanGap,
      blockSize: BLOCK, iterations: 400, seed: 11, margin: DEFAULT_MARGIN,
    })
    expect(result.usable).toBe(true)
    expect(result.outside).toBe(true)
    expect(result.p).toBeLessThan(DEFAULT_MARGIN)
  })

  it('reports the effect AND the uncertainty, not just a verdict', () => {
    const result = blockPermutationTest({
      series: tracking, labels: volume, statistic: meanGap,
      blockSize: BLOCK, iterations: 400, seed: 11, margin: DEFAULT_MARGIN,
    })
    /* The real gap is five: high weeks carry 18 * 0.5, low weeks 8 * 0.5. */
    expect(result.effect).toBeCloseTo(5, 0)
    expect(result.nullSd).toBeGreaterThan(0)
    expect(Math.abs(result.z)).toBeGreaterThan(2)
    expect(result.iterations).toBe(400)
    expect(result.blocks).toBe(26)
  })

  it('reports the same effect inside the null as nothing', () => {
    const result = blockPermutationTest({
      series: unrelated, labels: volume, statistic: meanGap,
      blockSize: BLOCK, iterations: 400, seed: 11, margin: DEFAULT_MARGIN,
    })
    expect(result.usable).toBe(true)
    expect(result.outside).toBe(false)
  })

  it('is deterministic', () => {
    const opts = {
      series: tracking, labels: volume, statistic: meanGap,
      blockSize: BLOCK, iterations: 100, seed: 5, margin: DEFAULT_MARGIN,
    }
    expect(blockPermutationTest(opts)).toEqual(blockPermutationTest(opts))
  })

  it('refuses a series too short to resample', () => {
    const result = blockPermutationTest({
      series: [1, 2, 3], labels: [1, 2, 3], statistic: meanGap,
      blockSize: 8, iterations: 100, seed: 1, margin: DEFAULT_MARGIN,
    })
    expect(result.usable).toBe(false)
    expect(result.outside).toBe(false)
    expect(result.reason).toContain('blocks')
  })

  it('refuses mismatched series and labels rather than guessing', () => {
    const result = blockPermutationTest({
      series: [1, 2, 3, 4], labels: [1, 2], statistic: meanGap,
      blockSize: 1, iterations: 50, seed: 1, margin: DEFAULT_MARGIN,
    })
    expect(result.usable).toBe(false)
    expect(result.reason).toContain('length')
  })

  it('accepts exactly the minimum number of blocks', () => {
    /* The boundary itself. `< MIN_BLOCKS` and `<= MIN_BLOCKS` differ only
       here, and without this the gate could be off by one forever. */
    const result = blockPermutationTest({
      series: [1, 2, 3, 4], labels: [4, 3, 2, 1], statistic: (a) => a[0],
      blockSize: 1, iterations: 50, seed: 1, margin: DEFAULT_MARGIN,
    })
    expect(result.blocks).toBe(MIN_BLOCKS)
    expect(result.usable).toBe(true)
  })

  it('counts the resamples it ran rather than echoing the request', () => {
    const result = blockPermutationTest({
      series: tracking, labels: volume, statistic: meanGap,
      blockSize: BLOCK, iterations: 37, seed: 3, margin: DEFAULT_MARGIN,
    })
    expect(result.iterations).toBe(37)
  })

  it('never calls a constant statistic significant', () => {
    /* Every resample ties with the observed value. A permutation test
       that counted only STRICTLY more extreme nulls would report p =
       1/(n+1) here and call pure noise a finding — ties are "at least as
       extreme", and this is the case that proves it. */
    const result = blockPermutationTest({
      series: tracking, labels: volume, statistic: () => 7,
      blockSize: BLOCK, iterations: 200, seed: 3, margin: DEFAULT_MARGIN,
    })
    expect(result.p).toBe(1)
    expect(result.outside).toBe(false)
    /* And the z it reports is 0, not NaN: the null has no spread to
       divide by, which is a fact rather than an error. */
    expect(result.z).toBe(0)
    expect(Number.isNaN(result.z)).toBe(false)
  })

  it('does not fire on a p that merely equals the margin', () => {
    /* A margin set to the smallest achievable p makes every result a tie
       with the gate. Strictly-below means nothing fires; `<=` would fire
       on the largest effect in the fixture. */
    const iterations = 399
    const result = blockPermutationTest({
      series: tracking, labels: volume, statistic: meanGap,
      blockSize: BLOCK, iterations, seed: 11, margin: 1 / (iterations + 1),
    })
    expect(result.p).toBe(1 / (iterations + 1))
    expect(result.outside).toBe(false)
  })

  it('has a default iteration count worth using', () => {
    expect(DEFAULT_ITERATIONS).toBeGreaterThanOrEqual(200)
  })

  it('reports the null as a band, not only a spread', () => {
    const result = blockPermutationTest({
      series: unrelated, labels: volume, statistic: meanGap,
      blockSize: BLOCK, iterations: 400, seed: 11, margin: DEFAULT_MARGIN,
    })
    /* The band is what a caller needs to ask "could this test have SEEN a
       difference worth acting on" — a standard deviation assumes a shape
       the null does not have to have. */
    expect(result.nullLow).toBeLessThan(result.nullHigh)
    expect(result.detectable).toBeGreaterThan(0)
    expect(result.detectable).toBeCloseTo((result.nullHigh - result.nullLow) / 2, 3)
  })

  it('widens the band as the margin loosens', () => {
    const base = {
      series: unrelated, labels: volume, statistic: meanGap,
      blockSize: BLOCK, iterations: 400, seed: 11,
    }
    const tight = blockPermutationTest({ ...base, margin: 0.2 })
    const loose = blockPermutationTest({ ...base, margin: 0.01 })
    expect(loose.detectable).toBeGreaterThan(tight.detectable)
  })

  it('does not quantise a tiny effect away to nothing', () => {
    /* These findings work in fractional weekly change: an effect of a
       few thousandths of a percent a week is a real number and is what
       the shadow log exists to record. Four decimal places zeroed it at
       the source, before any printer could be blamed. */
    const small = tracking.map((v) => v * 1e-5)
    const result = blockPermutationTest({
      series: small, labels: volume, statistic: meanGap,
      blockSize: BLOCK, iterations: 200, seed: 11, margin: DEFAULT_MARGIN,
    })
    expect(result.effect).not.toBe(0)
    expect(result.nullSd).toBeGreaterThan(0)
    expect(result.detectable).toBeGreaterThan(0)
    /* The control: the ordinary-sized version of the same fixture is
       still reported at a readable precision rather than as a long tail
       of digits. */
    const normal = blockPermutationTest({
      series: tracking, labels: volume, statistic: meanGap,
      blockSize: BLOCK, iterations: 200, seed: 11, margin: DEFAULT_MARGIN,
    })
    expect(String(normal.effect).replace('-', '').replace('.', '').length).toBeLessThanOrEqual(5)
  })

  it('never reports a p of zero, which a permutation test cannot honestly do', () => {
    const result = blockPermutationTest({
      series: tracking, labels: volume, statistic: meanGap,
      blockSize: BLOCK, iterations: 400, seed: 11, margin: DEFAULT_MARGIN,
    })
    expect(result.p).toBeGreaterThan(0)
  })
})

describe('a naive shuffle would have manufactured the effect', () => {
  it('is why the block size matters', () => {
    /* The same unrelated pair, tested with a block size of ONE — which
       is naive shuffling by another name. The null collapses and the
       effect looks significant. This is the failure being avoided, held
       as a test so nobody quietly lowers the block size. */
    const n = 104
    const volume = Array.from({ length: n }, (_, i) => (Math.floor(i / 13) % 2 ? 18 : 8))
    const drifting = Array.from({ length: n }, (_, i) => i * 0.5)
    const mean = (x: number[]) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : 0)
    const meanGap = (series: number[], labels: number[]) => {
      const cut = mean(labels)
      return mean(series.filter((_, i) => labels[i] > cut))
        - mean(series.filter((_, i) => labels[i] <= cut))
    }
    const opts = {
      series: drifting, labels: volume, statistic: meanGap,
      iterations: 300, seed: 21, margin: DEFAULT_MARGIN,
    }
    const naive = blockPermutationTest({ ...opts, blockSize: 1 })
    const blocked = blockPermutationTest({ ...opts, blockSize: 13 })
    expect(naive.nullSd).toBeLessThan(blocked.nullSd)
  })
})
