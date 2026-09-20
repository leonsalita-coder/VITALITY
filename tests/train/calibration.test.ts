import { describe, it, expect } from 'vitest'
import { doseVerdicts, DOSE_BLOCK_WEEKS, POWER_MARGIN } from '../../lib/train/dose'
import { transferVerdicts, TRANSFER_BLOCK_WEEKS, type LiftPair } from '../../lib/train/transfer'
import { seededRandom, lag1Autocorrelation } from '../../lib/train/resample'
import { indexFrom } from '../../lib/train/analysis'
import type { HistoryEntry } from '../../lib/train/sets'

/**
 * The evidence for the constants, kept executable.
 *
 * Every gate in these two findings is a resampled null rather than a
 * number somebody picked — except the handful of numbers that decide HOW
 * to resample, and those were picked, and picking them badly is the
 * whole failure mode this design exists to avoid. So they were measured:
 * simulate histories where the truth is known, and count how often each
 * finding gets it wrong.
 *
 * The full tables are in the comments on DOSE_BLOCK_WEEKS,
 * TRANSFER_BLOCK_WEEKS and POWER_MARGIN, and in
 * docs/train-verification.md. What is here is the headline of each,
 * held so that a change to the resampling cannot quietly stop being
 * justified — a calibration that cannot be re-run is a claim, not a
 * measurement.
 *
 * These run more slowly than the rest of the suite. That is what they
 * are: a few hundred simulated athletes.
 */

const day = (back: number) => {
  const d = new Date(2026, 8, 19 - back)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const NOW = new Date(2026, 8, 19, 12).getTime()
const index = indexFrom({ bench: { primary: [{ muscle: 'chest', share: 1 }] } })

/**
 * A wandering series that looks like training: this week resembles last
 * week. Two built from different seeds share nothing.
 *
 * phi 0.75 is the middle of the range the full table covers. It is the
 * autocorrelation that matters, not the scale — correlation is
 * scale-free.
 */
function ar1(n: number, seed: number, phi = 0.75, scale = 0.006): number[] {
  const rand = seededRandom(seed)
  const out: number[] = []
  let x = 0
  for (let i = 0; i < n; i++) {
    x = phi * x + (rand() - 0.5) * 2 * scale
    out.push(x)
  }
  return out
}

function weekly(weeks: number, step: (w: number) => number): HistoryEntry[] {
  const out: HistoryEntry[] = []
  let weight = 100
  for (let w = 0; w < weeks; w++) {
    weight *= 1 + step(w)
    const kg = Math.round(weight * 1000) / 1000
    out.push({ date: day((weeks - 1 - w) * 7), kg, sets: [{ w: kg, r: 5 }] })
  }
  return out
}

const PAIR: LiftPair = {
  id: 'back_squat+front_squat', a: 'back_squat', b: 'front_squat',
  maxLagWeeks: 4, why: 'calibration pair',
}

describe('transfer: how often it fires on two unrelated lifts', () => {
  const WEEKS = 70
  const DRAWS = 80

  /** Share of independent pairs this finding wrongly reports, as a %. */
  const fireRate = (blockWeeks: number) => {
    let fired = 0
    for (let i = 0; i < DRAWS; i++) {
      const a = ar1(WEEKS, 1000 + i * 7)
      const b = ar1(WEEKS, 50_000 + i * 13)
      const v = transferVerdicts({
        history: {
          back_squat: weekly(WEEKS, (w) => 0.004 + a[w]),
          front_squat: weekly(WEEKS, (w) => 0.004 + b[w]),
        },
        now: NOW, seed: 5, pairs: [PAIR], iterations: 200, blockWeeks,
      })[0]
      if (v.would) fired++
    }
    return (fired / DRAWS) * 100
  }

  it('builds pairs that really are autocorrelated and really are unrelated', () => {
    /* The fixture, checked. A negative control made of white noise would
       pass every assertion below while testing nothing: white noise is
       the one case naive shuffling handles correctly. */
    const a = ar1(WEEKS, 1007)
    const b = ar1(WEEKS, 50_013)
    expect(lag1Autocorrelation(a)).toBeGreaterThan(0.5)
    expect(lag1Autocorrelation(b)).toBeGreaterThan(0.5)
  })

  it('manufactures findings under naive shuffling', () => {
    /* Block size one is naive shuffling by another name. This is the
       number that justifies the whole design, and it is enormous. */
    expect(fireRate(1)).toBeGreaterThan(15)
  }, 120_000)

  it('stays near the margin under the block size it ships with', () => {
    /* Nominal is 5%. Some slack for 80 draws, which carry a standard
       error of about 2.4 points. */
    expect(fireRate(TRANSFER_BLOCK_WEEKS)).toBeLessThanOrEqual(9)
  }, 120_000)

  it('is worse at four weeks, which is why it does not use four', () => {
    /* The size a "training block is about a month" argument gives. It is
       roughly the length of the autocorrelation itself, so most of the
       structure is destroyed at the block boundaries anyway. */
    expect(fireRate(4)).toBeGreaterThan(fireRate(TRANSFER_BLOCK_WEEKS))
  }, 180_000)
})

describe('dose: how often it claims equivalence', () => {
  const DRAWS = 60
  const isHigh = (w: number) => Math.floor(w / 8) % 2 === 1

  /** A bench log where the high-volume weeks progress `ratio` times faster. */
  function bench(weeks: number, seed: number, ratio: number): HistoryEntry[] {
    const drift = ar1(weeks, seed, 0.75, 0.003)
    const out: HistoryEntry[] = []
    let weight = 100
    for (let w = 0; w < weeks; w++) {
      weight *= 1 + (isHigh(w) ? 0.004 * ratio : 0.004) + drift[w]
      const sets = isHigh(w) ? 6 : 3
      for (const offset of [0, 3]) {
        const kg = Math.round(weight * 1000) / 1000
        out.push({
          date: day((weeks - 1 - w) * 7 + offset), kg,
          sets: Array.from({ length: sets }, () => ({ w: kg, r: 5 })),
        })
      }
    }
    return out
  }

  const claimRate = (weeks: number, ratio: number) => {
    let fired = 0
    for (let i = 0; i < DRAWS; i++) {
      const v = doseVerdicts({
        history: { bench: bench(weeks, 400 + i * 11, ratio) },
        index, now: NOW, seed: 5, iterations: 200,
      }).find((x) => x.subject === 'chest')
      if (v?.would) fired++
    }
    return (fired / DRAWS) * 100
  }

  it('speaks on a history where the doses really were equivalent', () => {
    /* The finding has to be able to happen. A gate tuned until nothing
       ever clears it is not a careful gate, it is a deleted feature. */
    expect(claimRate(120, 1)).toBeGreaterThan(30)
  }, 120_000)

  it('rarely claims equivalence against a doubled progression rate', () => {
    expect(claimRate(80, 2)).toBeLessThan(10)
  }, 120_000)

  it('claims equivalence less often as the real difference grows', () => {
    /* The direction that matters. An absolute rate can be argued about;
       a finding that fired MORE as the difference grew would be reading
       noise. */
    expect(claimRate(120, 2)).toBeLessThan(claimRate(120, 1))
  }, 180_000)

  it('cannot tell equal from a quarter more, and the numbers say so', () => {
    /* Recorded rather than hidden. The rates at 1.0x and 1.25x sit
       within Monte Carlo error of each other at every sample size a real
       person will produce, which is exactly why the sentence states what
       the log could resolve instead of saying "the same" and stopping.

       This is a LIMIT, not a bug, and if it ever stops being true —
       because the statistic improved — this test should be the thing
       that notices. */
    const equal = claimRate(120, 1)
    const quarterMore = claimRate(120, 1.25)
    expect(Math.abs(equal - quarterMore)).toBeLessThan(25)
  }, 180_000)
})

describe('the constants are the ones that were measured', () => {
  it('uses a different block size for each finding', () => {
    /* They resample the same kind of series and want opposite things
       from it: transfer claims a relationship, so a tight null makes it
       fire on nothing; dose claims the absence of one, so a tight null
       makes it fire less. One shared number was wrong for both. */
    expect(TRANSFER_BLOCK_WEEKS).not.toBe(DOSE_BLOCK_WEEKS)
    expect(TRANSFER_BLOCK_WEEKS).toBeGreaterThan(DOSE_BLOCK_WEEKS)
  })

  it('demands real resolution before claiming equivalence', () => {
    expect(POWER_MARGIN).toBeGreaterThan(1)
  })
})
