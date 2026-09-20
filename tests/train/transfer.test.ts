import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  transferVerdicts, transferNote, transferReadiness,
  TRANSFER_PAIRS, MIN_OVERLAP_WEEKS, MIN_PAIRS_PER_LAG, TRANSFER_BLOCK_WEEKS,
  type TransferContext, type LiftPair,
} from '../../lib/train/transfer'
import { lag1Autocorrelation, seededRandom, MIN_BLOCKS } from '../../lib/train/resample'
import { catalogExercise } from '../../lib/train/catalog'
import type { HistoryEntry } from '../../lib/train/sets'

/**
 * "Your front squat and your back squat moved together, about three
 * weeks apart."
 *
 * DIRECTION IS NOT CLAIMED, and these tests hold that shut rather than
 * treating it as a detail. One athlete's log cannot separate "A led B"
 * from "B led A": both lifts sit in the same programme, are trained in
 * the same weeks, and share every common cause there is. So both
 * directions go into one null, the sentence names the MAGNITUDE of the
 * offset, and the signed lag is logged for a future that has enough
 * data to make the directional claim honestly.
 *
 * SILENCE IS THE EXPECTED OUTCOME, which is why the untestable pairs are
 * logged too. Thirty-two shared weeks is about eight months of training
 * both lifts most weeks, and most people will never reach it on most
 * pairs. A log that omitted those pairs could not tell "nothing there"
 * from "never had enough history to ask" — the only question worth
 * putting to it after a year.
 */

const day = (back: number) => {
  const d = new Date(2026, 8, 19 - back)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const NOW = new Date(2026, 8, 19, 12).getTime()

/**
 * A lift logged once a week for `weeks` weeks.
 *
 * `step(w)` is the fractional gain applied in week w. Compounding keeps
 * the RELATIVE change flat; a fixed increment on a growing bar makes
 * relative change decline over time, and that trend would correlate with
 * anything else that also trends.
 */
function weekly(weeks: number, step: (w: number) => number, start = 100): HistoryEntry[] {
  const out: HistoryEntry[] = []
  let weight = start
  for (let w = 0; w < weeks; w++) {
    weight *= 1 + step(w)
    const kg = Math.round(weight * 1000) / 1000
    out.push({ date: day((weeks - 1 - w) * 7), kg, sets: [{ w: kg, r: 5 }] })
  }
  return out
}

/**
 * An autocorrelated series with no relationship to any other.
 *
 * The first version of this was `sin(w * 2.399 + phase)` with different
 * phases, which is not an unrelated pair at all — it is the SAME wave
 * shifted, so the two series correlate perfectly at the lag equal to the
 * phase difference. The negative control fired, correctly, and the
 * engine was blamed for it.
 *
 * AR(1) from a seeded generator gives what was actually wanted: a series
 * that looks like training (this week resembles last week) and shares
 * nothing with a series built from a different seed. That combination is
 * the whole reason for block permutation — a naive shuffle of two
 * autocorrelated series manufactures a relationship between them.
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

const ctx = (history: Record<string, HistoryEntry[]>, over: Partial<TransferContext> = {}): TransferContext => ({
  history, now: NOW, seed: 5, ...over,
})

const PAIR: LiftPair = {
  id: 'back_squat+front_squat', a: 'back_squat', b: 'front_squat',
  maxLagWeeks: 4, why: 'test pair',
}
const only = (c: TransferContext) => transferVerdicts({ ...c, pairs: [PAIR] })[0]

describe('the curated list is a prior, not a search', () => {
  it('names only lifts that exist in the catalog', () => {
    for (const pair of TRANSFER_PAIRS) {
      expect(catalogExercise(pair.a), pair.a).toBeTruthy()
      expect(catalogExercise(pair.b), pair.b).toBeTruthy()
    }
  })

  it('has a reason recorded for every pair', () => {
    for (const pair of TRANSFER_PAIRS) {
      expect(pair.why.length).toBeGreaterThan(10)
    }
  })

  it('has no duplicate pair, in either order', () => {
    const seen = new Set<string>()
    for (const pair of TRANSFER_PAIRS) {
      const key = [pair.a, pair.b].sort().join('+')
      expect(seen.has(key), key).toBe(false)
      seen.add(key)
    }
  })

  it('never pairs a lift with itself', () => {
    for (const pair of TRANSFER_PAIRS) expect(pair.a).not.toBe(pair.b)
  })

  it('keeps every lag range short', () => {
    /* Beyond about a month, any correlation is far more likely to be a
       training block than a transfer. */
    for (const pair of TRANSFER_PAIRS) {
      expect(pair.maxLagWeeks).toBeGreaterThan(0)
      expect(pair.maxLagWeeks).toBeLessThanOrEqual(6)
    }
  })

  it('is short enough to be a control', () => {
    /* The list is the entire multiple-testing control. If it grows to
       the point where something always clears, it has stopped being
       one. */
    expect(TRANSFER_PAIRS.length).toBeLessThanOrEqual(20)
  })
})

describe('a manufactured effect clears the resampled null', () => {
  /* Front squat follows back squat by exactly three weeks: the same
     wave, shifted. */
  const LAG = 3
  const wave = (w: number) => Math.sin(w / 3.5) * 0.012
  const linked = () => ctx({
    back_squat: weekly(70, (w) => 0.004 + wave(w)),
    front_squat: weekly(70, (w) => 0.004 + wave(w - LAG)),
  })

  it('produces a verdict', () => {
    expect(only(linked())).toBeTruthy()
  })

  it('would have fired', () => {
    expect(only(linked())!.would).toBe(true)
  })

  it('finds the offset that was put there', () => {
    expect(only(linked())!.lagWeeks).toBe(LAG)
  })

  it('clears the null', () => {
    const v = only(linked())!
    expect(v.p).toBeLessThan(0.05)
    expect(v.z).toBeGreaterThan(0)
  })

  it('reports the effect and the uncertainty, not only a verdict', () => {
    const v = only(linked())!
    expect(v.effect).toBeGreaterThan(0)
    expect(v.nullSd).toBeGreaterThan(0)
    expect(v.inputs.peakCorrelation).toBeGreaterThan(0)
    expect(v.blocks).toBeGreaterThanOrEqual(MIN_OVERLAP_WEEKS / TRANSFER_BLOCK_WEEKS)
  })
})

const WEEKS = 70
const driftA = ar1(WEEKS, 11)
const driftB = ar1(WEEKS, 97)

describe('the same effect inside the null produces nothing', () => {
  /* Two lifts progressing steadily, each wandering on its own. Both
     climb, which is what makes this the right negative control: a naive
     correlation on two rising, autocorrelated series finds a
     relationship almost every time. */
  const unrelated = () => ctx({
    back_squat: weekly(WEEKS, (w) => 0.004 + driftA[w]),
    front_squat: weekly(WEEKS, (w) => 0.004 + driftB[w]),
  })

  it('is built from series that really are autocorrelated', () => {
    /* The fixture, checked. Without this the negative control could pass
       by being white noise, which nothing would manufacture significance
       from and which no training history looks like. */
    expect(lag1Autocorrelation(driftA)).toBeGreaterThan(0.5)
    expect(lag1Autocorrelation(driftB)).toBeGreaterThan(0.5)
  })

  it('produces a verdict', () => {
    expect(only(unrelated())).toBeTruthy()
  })

  it('does not fire', () => {
    expect(only(unrelated())!.would).toBe(false)
  })

  it('would have fired under naive shuffling, and does not under blocks', () => {
    /* The claim the whole design rests on, exercised on a real history
       through the real code path rather than asserted in a comment.
       Training histories are autocorrelated; shuffling single weeks
       destroys that structure and produces a null far tighter than
       anything this athlete could actually produce, so an ordinary
       wander in two unrelated lifts clears it. Permuting blocks of weeks
       keeps the structure and the same pair says nothing.

       If this ever fails in the blocked direction, the block size is too
       small for the histories being seen. */
    const naive = only(ctx({
      back_squat: weekly(WEEKS, (w) => 0.004 + driftA[w]),
      front_squat: weekly(WEEKS, (w) => 0.004 + driftB[w]),
    }, { blockWeeks: 1 }))!
    const blocked = only(unrelated())!

    expect(naive.p).toBeLessThan(blocked.p)
    expect(naive.nullSd).toBeLessThan(blocked.nullSd)
    expect(blocked.would).toBe(false)
  })

  it('records it as evaluated, not as unaskable', () => {
    expect(only(unrelated())!.status).toBe('no_effect')
  })
})

describe('direction is recorded and never claimed', () => {
  const LAG = 3
  const wave = (w: number) => Math.sin(w / 3.5) * 0.012
  const aLeads = () => only(ctx({
    back_squat: weekly(70, (w) => 0.004 + wave(w)),
    front_squat: weekly(70, (w) => 0.004 + wave(w - LAG)),
  }))!
  const bLeads = () => only(ctx({
    back_squat: weekly(70, (w) => 0.004 + wave(w - LAG)),
    front_squat: weekly(70, (w) => 0.004 + wave(w)),
  }))!

  it('logs which series came first', () => {
    expect(aLeads().ledAtPeak).toBe('back_squat')
    expect(bLeads().ledAtPeak).toBe('front_squat')
  })

  it('says the same thing either way round', () => {
    /* The only difference between these two histories is which lift
       moved first. If the sentence differed, it would be asserting a
       direction the data cannot support. */
    expect(aLeads().text).toBe(bLeads().text)
  })

  it('never names a leader in the sentence', () => {
    /* Targeted at a directional CLAIM, not at the word. The first
       version banned /\bled\b/ outright and failed on the sentence's own
       disclaimer — "which one led is not something your log can tell" —
       which is the opposite of the thing being guarded against. */
    for (const v of [aLeads(), bLeads()]) {
      expect(v.text).not.toMatch(/(Back|Front) Squat (led|drove|caused|came first)/i)
      expect(v.text).not.toMatch(/\bfollowed\b|\bbecause of\b/i)
    }
  })

  it('says out loud that direction is unknowable here', () => {
    expect(aLeads().text).toMatch(/not something your log can tell/i)
  })

  it('states it as a co-occurrence', () => {
    expect(aLeads().text).toMatch(/co-occurrence, not a cause/i)
  })

  it('reports the offset as a magnitude', () => {
    expect(aLeads().text).toContain('about 3 weeks apart')
    expect(bLeads().text).toContain('about 3 weeks apart')
  })
})

describe('same-week co-movement is not transfer', () => {
  it('never reports a zero-week offset', () => {
    /* Two lifts moving in lockstep every week is what a good week looks
       like. If lag zero were a candidate it would win the maximum almost
       every time and the finding would fire constantly. */
    const lockstep = ctx({
      back_squat: weekly(70, (w) => 0.004 + driftA[w]),
      front_squat: weekly(70, (w) => 0.004 + driftA[w]),
    })
    const v = only(lockstep)!
    expect(v.lagWeeks).toBeGreaterThan(0)
    expect(v.inputs.peakLag).not.toBe(0)
  })
})

describe('thin history is logged, not skipped', () => {
  const thin = () => ctx({
    back_squat: weekly(20, (w) => 0.004 + driftA[w]),
    front_squat: weekly(20, (w) => 0.004 + driftB[w]),
  })

  it('still produces a verdict', () => {
    expect(only(thin())).toBeTruthy()
  })

  it('marks it unaskable rather than quiet', () => {
    expect(only(thin())!.status).toBe('not_enough_overlap')
    expect(only(thin())!.would).toBe(false)
  })

  it('records how far off it is', () => {
    const v = only(thin())!
    expect(v.overlapWeeks).toBe(19)
    expect(v.inputs.needed).toBe(MIN_OVERLAP_WEEKS)
  })

  it('says so in words a person could read', () => {
    expect(only(thin())!.text).toContain(`${MIN_OVERLAP_WEEKS} shared weeks needed`)
  })

  it('never claims a lag it did not measure', () => {
    expect(only(thin())!.lagWeeks).toBe(0)
    expect(only(thin())!.ledAtPeak).toBeNull()
  })

  it('counts only weeks BOTH lifts produced an estimate', () => {
    /* One lift with years of history and the other with a month is a
       month of overlap, however long the first has been running. */
    const lopsided = ctx({
      back_squat: weekly(120, (w) => 0.004 + ar1(120, 11)[w]),
      front_squat: weekly(10, (w) => 0.004 + driftB[w]),
    })
    expect(only(lopsided)!.overlapWeeks).toBe(9)
    expect(only(lopsided)!.status).toBe('not_enough_overlap')
  })

  it('handles a lift that was never trained at all', () => {
    const missing = ctx({ back_squat: weekly(WEEKS, (w) => 0.004 + driftA[w]) })
    expect(only(missing)!.overlapWeeks).toBe(0)
    expect(only(missing)!.status).toBe('not_enough_overlap')
  })
})

describe('readiness answers "no effect" against "not yet"', () => {
  const mixed = () => ctx({
    back_squat: weekly(WEEKS, (w) => 0.004 + driftA[w]),
    front_squat: weekly(WEEKS, (w) => 0.004 + driftB[w]),
    bench_press: weekly(WEEKS, (w) => 0.004 + ar1(WEEKS, 5)[w]),
    overhead_press: weekly(8, (w) => 0.004 + ar1(8, 31)[w]),
  })

  it('reports every curated pair', () => {
    expect(transferReadiness(mixed())).toHaveLength(TRANSFER_PAIRS.length)
  })

  it('marks the pairs that have enough history', () => {
    const rows = transferReadiness(mixed())
    expect(rows.find((r) => r.pair === 'back_squat+front_squat')!.ready).toBe(true)
  })

  it('marks the pairs that do not', () => {
    const rows = transferReadiness(mixed())
    const thin = rows.find((r) => r.pair === 'bench_press+overhead_press')!
    expect(thin.ready).toBe(false)
    expect(thin.overlapWeeks).toBe(7)
    expect(thin.needed).toBe(MIN_OVERLAP_WEEKS)
  })

  it('reports nothing ready for a fresh athlete', () => {
    const rows = transferReadiness(ctx({}))
    expect(rows.every((r) => !r.ready)).toBe(true)
    /* The control: the same call DOES report ready rows when the history
       is there, so "nothing ready" above is the history rather than a
       function that always says no. */
    expect(transferReadiness(mixed()).some((r) => r.ready)).toBe(true)
  })
})

describe('confounds are named, not hidden', () => {
  const LAG = 3
  const wave = (w: number) => Math.sin(w / 3.5) * 0.012
  const linked = (over: Partial<TransferContext> = {}) => only(ctx({
    back_squat: weekly(70, (w) => 0.004 + wave(w)),
    front_squat: weekly(70, (w) => 0.004 + wave(w - LAG)),
  }, over))!

  it('records a deload inside the window', () => {
    expect(linked({ deloadDates: [day(100)] }).confounds.join(' ')).toMatch(/deload/)
  })

  it('records imported history', () => {
    expect(linked({ imported: true }).confounds.join(' ')).toMatch(/imported/)
  })

  it('puts them in the sentence', () => {
    expect(linked({ deloadDates: [day(100)] }).text).toMatch(/deload/)
  })

  it('leaves them empty when there are none', () => {
    expect(linked().confounds).toEqual([])
  })

  it('ignores a confound outside the window', () => {
    expect(linked({ deloadDates: [day(5000)] }).confounds).toEqual([])
    /* The control, so the empty list above is the window rather than
       confounds being broken for every input. */
    expect(linked({ deloadDates: [day(100)] }).confounds).toHaveLength(1)
  })
})

describe('shadow mode — it computes and says nothing', () => {
  const LAG = 3
  const wave = (w: number) => Math.sin(w / 3.5) * 0.012
  const live = () => ctx({
    back_squat: weekly(70, (w) => 0.004 + wave(w)),
    front_squat: weekly(70, (w) => 0.004 + wave(w - LAG)),
  }, { pairs: [PAIR] })

  it('has a verdict that would have fired', () => {
    expect(transferVerdicts(live())[0].would).toBe(true)
  })

  it('surfaces nothing to the athlete', () => {
    expect(transferNote(live())).toBeNull()
  })

  it('surfaces it under the flag, and only under the flag', () => {
    expect(transferNote(live(), { transfer_between_lifts: true })).toContain('weeks apart')
    expect(transferNote(live(), { transfer_between_lifts: false })).toBeNull()
  })

  it('is not enabled by the other feature\'s flag', () => {
    expect(transferNote(live(), { minimum_effective_dose: true })).toBeNull()
  })

  it('is never called from the tile', () => {
    const tile = readFileSync('public/tiles/train.html', 'utf8')
    /* Outside the engine block: the whole engine is inlined, so the
       DEFINITION is in the file by construction and searching the whole
       thing would assert something that can never be true. */
    const own = tile.split('<!-- TRAIN-ENGINE:END -->')[1] || ''
    expect(own).not.toContain('transferNote')
    /* The control: the tile's own code does call the engine. */
    expect(own).toContain('TrainEngine.')
  })
})

describe('inputs it must not choke on', () => {
  it('survives a missing context', () => {
    expect(transferVerdicts(null as unknown as TransferContext)).toEqual([])
  })

  it('survives an empty history', () => {
    expect(transferVerdicts(ctx({})).every((v) => v.status === 'not_enough_overlap')).toBe(true)
  })

  it('ignores sessions dated in the future', () => {
    const base = only(ctx({
      back_squat: weekly(WEEKS, (w) => 0.004 + driftA[w]),
      front_squat: weekly(WEEKS, (w) => 0.004 + driftB[w]),
    }))!
    const ahead = only(ctx({
      back_squat: [...weekly(WEEKS, (w) => 0.004 + driftA[w]), { date: day(-14), kg: 999, sets: [{ w: 999, r: 5 }] }],
      front_squat: [...weekly(WEEKS, (w) => 0.004 + driftB[w]), { date: day(-14), kg: 999, sets: [{ w: 999, r: 5 }] }],
    }))!
    expect(ahead.overlapWeeks).toBe(base.overlapWeeks)
    expect(ahead.effect).toBe(base.effect)
  })

  it('refuses a lag resting on too few pairs', () => {
    /* A lag range nearly as long as the history leaves almost no pairs
       at its extremes. Those lags are noisier estimates of the same
       quantity and would win the maximum for that reason alone, which
       breaks the assumption the multiplicity control rests on. */
    const wide: LiftPair = { ...PAIR, id: 'wide', maxLagWeeks: 40 }
    const history = {
      back_squat: weekly(50, (w) => 0.004 + ar1(50, 11)[w]),
      front_squat: weekly(50, (w) => 0.004 + ar1(50, 97)[w]),
    }
    const v = transferVerdicts({ ...ctx(history), pairs: [wide] })[0]
    expect(Math.abs(v.inputs.peakLag as number)).toBeLessThanOrEqual(50 - MIN_PAIRS_PER_LAG)
  })

  it('reports a flat lift as no correlation rather than dividing by nothing', () => {
    /* Somebody who held the same weight all block. The correlation is
       undefined, not infinite. */
    const flat = ctx({
      back_squat: weekly(WEEKS, () => 0),
      front_squat: weekly(WEEKS, (w) => 0.004 + driftA[w]),
    })
    const v = only(flat)!
    expect(Number.isFinite(v.effect)).toBe(true)
    expect(v.would).toBe(false)
  })
})

describe('the shape of the gates', () => {
  it('needs enough blocks for a permutation p to exist below the margin', () => {
    /* With b blocks the floor on p is 1/b!. Four blocks gives 1/24 ≈
       0.042, which clears a 0.05 margin only just — that is the minimum
       at which a result can exist at all, and it is what the required
       overlap is set to. It reads as tight, and the calibration says it
       is not what limits this: at exactly that boundary the measured
       false-positive rate is 3.1%, under the nominal 5%. */
    expect(MIN_OVERLAP_WEEKS / TRANSFER_BLOCK_WEEKS).toBeGreaterThanOrEqual(MIN_BLOCKS)
  })

  it('requires each lag to rest on a real sample', () => {
    expect(MIN_PAIRS_PER_LAG).toBeGreaterThan(0)
    expect(MIN_PAIRS_PER_LAG).toBeLessThan(MIN_OVERLAP_WEEKS)
  })
})

describe('gaps, edges and lifts it has never heard of', () => {
  const WIDE: LiftPair = { ...PAIR, id: 'wide', maxLagWeeks: 40 }

  it('skips weeks where either lift was not trained', () => {
    /* The grid runs across the whole span with a hole where a week is
       missing. Treating a hole as a zero would read a week nobody
       trained as a week of no progress, and pair it with a real one. */
    const full = weekly(WEEKS, (w) => 0.004 + driftA[w])
    const gappy = weekly(WEEKS, (w) => 0.004 + driftB[w]).filter((_, i) => i % 5 !== 2)
    const v = only(ctx({ back_squat: full, front_squat: gappy }))!
    expect(Number.isFinite(v.effect)).toBe(true)
    expect(Number.isNaN(v.effect)).toBe(false)
    expect(v.overlapWeeks).toBeLessThan(WEEKS - 1)
    expect(v.overlapWeeks).toBeGreaterThan(0)
  })

  it('refuses a lag that only a handful of weeks support', () => {
    /* Two series that match PERFECTLY, but only at an offset so long
       that barely any weeks overlap there. A lag rested on nine pairs is
       a far noisier estimate than one rested on sixty, and the maximum
       across lags would pick it for that reason alone — which breaks the
       assumption the multiplicity control rests on.

       WHITE NOISE, not AR(1). The first version of this built both
       series from the same autocorrelated process, which correlates them
       at every nearby lag too — shifting an AR(1) by 40 still leaves
       0.75 at an offset of 39 — so the planted lag was never the only
       signal and the test failed for a reason that had nothing to do
       with the guard. With no autocorrelation in the base, the planted
       offset is the only place the two series match at all. */
    const LONG = 60
    const base = ar1(WEEKS + LONG, 3, 0)
    const v = transferVerdicts({
      ...ctx({
        back_squat: weekly(WEEKS, (w) => 0.004 + base[w]),
        front_squat: weekly(WEEKS, (w) => 0.004 + base[w + LONG]),
      }),
      pairs: [{ ...WIDE, maxLagWeeks: LONG + 2 }],
    })[0]
    /* Asserted on the peak rather than on whether it fired: the planted
       correlation is 1.0 and would be unmissable, so its absence from
       the result is the guard and nothing else. */
    expect(Math.abs(v.inputs.peakLag as number)).not.toBe(LONG)
    expect(v.inputs.peakCorrelation).toBeLessThan(0.9)
  })

  it('can find a peak sitting exactly at the end of the lag range', () => {
    /* The largest declared offset has to be a candidate. An off-by-one
       in the range would silently make it unreachable, and nothing else
       in this file would notice. */
    const LAG = 3
    const wave = (w: number) => Math.sin(w / 3.5) * 0.012
    const edge: LiftPair = { ...PAIR, maxLagWeeks: LAG }
    const v = transferVerdicts({
      ...ctx({
        back_squat: weekly(70, (w) => 0.004 + wave(w)),
        front_squat: weekly(70, (w) => 0.004 + wave(w - LAG)),
      }),
      pairs: [edge],
    })[0]
    expect(v.lagWeeks).toBe(LAG)
    expect(v.would).toBe(true)
  })

  it('reports no peak at all when one lift never moved', () => {
    const flat = only(ctx({
      back_squat: weekly(WEEKS, () => 0),
      front_squat: weekly(WEEKS, (w) => 0.004 + driftA[w]),
    }))!
    expect(flat.lagWeeks).toBe(0)
    expect(flat.ledAtPeak).toBeNull()
    expect(flat.would).toBe(false)
    /* The control: the same pair with both lifts moving DOES find a
       peak, so the zeros above are the flat lift rather than a verdict
       that never finds anything. */
    const moving = only(ctx({
      back_squat: weekly(WEEKS, (w) => 0.004 + driftA[w]),
      front_squat: weekly(WEEKS, (w) => 0.004 + driftB[w]),
    }))!
    expect(moving.lagWeeks).toBeGreaterThan(0)
    expect(moving.ledAtPeak).toBeTruthy()
  })

  it('does not report two lifts that moved OPPOSITELY as moving together', () => {
    /* Every lag correlates negatively here: one lift is the other's
       mirror. The statistic is a maximum, so its null is right-skewed
       with almost no lower tail and a result this weak never reaches the
       margin — measured at zero occurrences in 400 simulated athletes,
       which is why the sign guard that used to sit in the engine was
       deleted as theatre rather than kept and tested. The BEHAVIOUR is
       still worth holding, whatever produces it. */
    /* A slow wave rather than the AR(1) drift: over a period of 120
       weeks the correlation at every candidate lag is about -0.98, so
       the mirror is exact at all of them. The AR(1) version left one lag
       fractionally POSITIVE by sampling accident, which made the fixture
       not actually the case it claimed to be. */
    const slow = (w: number) => Math.sin((2 * Math.PI * w) / 120) * 0.01
    const mirrored = only(ctx({
      back_squat: weekly(WEEKS, (w) => 0.004 + slow(w)),
      front_squat: weekly(WEEKS, (w) => 0.004 - slow(w)),
    }))!
    /* No lag found any co-movement at all, which is reported as no peak
       rather than as whichever lag was least negative. */
    expect(mirrored.inputs.peakCorrelation).toBe(0)
    expect(mirrored.lagWeeks).toBe(0)
    expect(mirrored.ledAtPeak).toBeNull()
    expect(mirrored.would).toBe(false)
    /* The control: un-mirror one of them and the same wave at the same
       lags correlates positively, so the zeros above are the sign of the
       relationship rather than a statistic that always returns nothing. */
    const aligned = only(ctx({
      back_squat: weekly(WEEKS, (w) => 0.004 + slow(w)),
      front_squat: weekly(WEEKS, (w) => 0.004 + slow(w)),
    }))!
    expect(aligned.inputs.peakCorrelation).toBeGreaterThan(0.9)
  })

  it('accepts a lag resting on exactly the minimum number of pairs', () => {
    /* The boundary itself. `<` and `<=` differ only here, and without
       this the gate could be off by one forever — silently discarding
       the longest usable lag on every pair. */
    const overlap = WEEKS - 1
    const LONG = overlap - MIN_PAIRS_PER_LAG
    const base = ar1(WEEKS + LONG, 3, 0)
    const v = transferVerdicts({
      ...ctx({
        back_squat: weekly(WEEKS, (w) => 0.004 + base[w]),
        front_squat: weekly(WEEKS, (w) => 0.004 + base[w + LONG]),
      }),
      pairs: [{ ...WIDE, maxLagWeeks: LONG + 2 }],
    })[0]
    expect(v.inputs.peakLag).toBe(-LONG)
    expect(v.inputs.peakCorrelation).toBeGreaterThan(0.9)
  })

  it('names a lift it has no catalog entry for', () => {
    const custom: LiftPair = {
      id: 'x', a: 'my_weird_press', b: 'front_squat', maxLagWeeks: 4, why: 'test',
    }
    const v = transferVerdicts({
      ...ctx({ front_squat: weekly(WEEKS, (w) => 0.004 + driftB[w]) }),
      pairs: [custom],
    })[0]
    expect(v.text).toContain('my weird press')
    /* The control: a known lift still gets its proper name. */
    expect(v.text).toContain('Front Squat')
  })

  it('evaluates a pair with exactly the required overlap', () => {
    /* One week more than the minimum of logged weeks, because the oldest
       week carries no progression observation. */
    const exact = ctx({
      back_squat: weekly(MIN_OVERLAP_WEEKS + 1, (w) => 0.004 + driftA[w]),
      front_squat: weekly(MIN_OVERLAP_WEEKS + 1, (w) => 0.004 + driftB[w]),
    })
    const v = only(exact)!
    expect(v.overlapWeeks).toBe(MIN_OVERLAP_WEEKS)
    expect(v.status).not.toBe('not_enough_overlap')
    expect(transferReadiness({ ...exact, pairs: [PAIR] })[0].ready).toBe(true)
  })

  it('refuses a pair one week short of it', () => {
    const short = ctx({
      back_squat: weekly(MIN_OVERLAP_WEEKS, (w) => 0.004 + driftA[w]),
      front_squat: weekly(MIN_OVERLAP_WEEKS, (w) => 0.004 + driftB[w]),
    })
    expect(only(short)!.status).toBe('not_enough_overlap')
    expect(transferReadiness({ ...short, pairs: [PAIR] })[0].ready).toBe(false)
  })

  it('names a confound dated exactly on either edge of the window', () => {
    /* Read off the verdict rather than recomputed here: the window
       starts at the oldest week carrying a progression observation,
       which is not the oldest session. */
    const plain = only(ctx({
      back_squat: weekly(WEEKS, (w) => 0.004 + driftA[w]),
      front_squat: weekly(WEEKS, (w) => 0.004 + driftB[w]),
    }))!
    for (const edge of [plain.inputs.from as string, plain.inputs.to as string]) {
      const v = only(ctx({
        back_squat: weekly(WEEKS, (w) => 0.004 + driftA[w]),
        front_squat: weekly(WEEKS, (w) => 0.004 + driftB[w]),
      }, { deloadDates: [edge] }))!
      expect(v.confounds, edge).toHaveLength(1)
    }
  })
})
