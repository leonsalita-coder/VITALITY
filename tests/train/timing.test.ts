import { describe, it, expect } from 'vitest'
import {
  restTaken, medianRest, restTrend, hasObservedTiming,
  MIN_TIMED_SESSIONS, REST_COMPRESSION, MAX_REST_SECONDS,
} from '../../lib/train/timing'
import { detectPlateau, nextDeloadState, plateauAdvice } from '../../lib/train/deload'

/**
 * Rest taken, and rushing it as a cause of a stall.
 *
 * Rushing rest is one of the most common real reasons a lift stops
 * moving, and nothing else here could see it because nothing recorded
 * when a set happened.
 *
 * Two rules run this file:
 *
 *   A timing figure is only ever produced from OBSERVED timestamps.
 *   Imported and migrated history carries atEstimated or no `at` at all,
 *   and must never contribute — a median rest computed from invented
 *   timestamps would be a confident number about something nobody
 *   measured.
 *
 *   Absent is not zero. hasObservedTiming says whether there was anything
 *   to read, exactly as loadUnavailable does for bodyweight volume, so a
 *   caller can tell "no data" from "no rest".
 */

const MIN = 60_000
/** A session whose working sets are `gap` seconds apart. */
const timed = (date: string, weight: number, gap: number, count = 3, extra: Record<string, unknown> = {}) => {
  const start = new Date(`${date}T18:00:00`).getTime()
  return {
    date, kg: weight,
    sets: Array.from({ length: count }, (_, i) => ({
      w: weight, r: 5, at: start + i * gap * 1000, ...extra,
    })),
  }
}
/** The same session with no timestamps at all — a migrated row. */
const untimed = (date: string, weight: number, count = 3) => ({
  date, kg: weight,
  sets: Array.from({ length: count }, () => ({ w: weight, r: 5 })),
})

describe('rest taken between working sets', () => {
  it('reads the gaps', () => {
    const reading = restTaken(timed('2026-09-19', 200, 90))
    expect(reading.gaps).toEqual([90, 90])
    expect(reading.median).toBe(90)
    expect(reading.hasObservedTiming).toBe(true)
  })

  it('needs two sets to have a gap at all', () => {
    const reading = restTaken(timed('2026-09-19', 200, 90, 1))
    expect(reading.gaps).toEqual([])
    expect(reading.median).toBeNull()
    expect(reading.hasObservedTiming).toBe(false)
  })

  it('takes the median, so one interruption does not move it', () => {
    const start = new Date('2026-09-19T18:00:00').getTime()
    const entry = { date: '2026-09-19', kg: 200, sets: [
      { w: 200, r: 5, at: start },
      { w: 200, r: 5, at: start + 90_000 },
      { w: 200, r: 5, at: start + 180_000 },
      { w: 200, r: 5, at: start + 600_000 }, // took a phone call
    ] }
    expect(medianRest(entry)).toBe(90)
  })

  it('ignores a gap too long to be rest', () => {
    const start = new Date('2026-09-19T18:00:00').getTime()
    const entry = { date: '2026-09-19', kg: 200, sets: [
      { w: 200, r: 5, at: start },
      { w: 200, r: 5, at: start + (MAX_REST_SECONDS + 60) * 1000 },
    ] }
    expect(restTaken(entry).gaps).toEqual([])
    expect(restTaken(entry).hasObservedTiming).toBe(false)
  })

  it('excludes warm-ups, like everything else here', () => {
    const start = new Date('2026-09-19T18:00:00').getTime()
    const entry = { date: '2026-09-19', kg: 200, sets: [
      { w: 95, r: 8, at: start, warmup: true },
      { w: 200, r: 5, at: start + 30_000 },
      { w: 200, r: 5, at: start + 150_000 },
    ] }
    // the only WORKING gap is the 120s one; the 30s ramp gap is not rest
    expect(restTaken(entry).gaps).toEqual([120])
  })
})

describe('an estimated or missing timestamp never produces a figure', () => {
  it('reads nothing from a migrated session', () => {
    const reading = restTaken(untimed('2026-09-19', 200))
    expect(reading.median).toBeNull()
    expect(reading.hasObservedTiming).toBe(false)
  })

  it('reads nothing from an imported session, however precise its timestamps look', () => {
    const imported = timed('2026-09-19', 200, 90, 3, { atEstimated: true })
    expect(restTaken(imported).median).toBeNull()
    expect(restTaken(imported).hasObservedTiming).toBe(false)
  })

  it('skips a gap where either end is estimated', () => {
    const start = new Date('2026-09-19T18:00:00').getTime()
    const entry = { date: '2026-09-19', kg: 200, sets: [
      { w: 200, r: 5, at: start },
      { w: 200, r: 5, at: start + 90_000, atEstimated: true },
      { w: 200, r: 5, at: start + 180_000 },
    ] }
    /* And specifically NOT the 180-second gap that spanning the estimated
       set would produce — that is rest nobody took, and it looks entirely
       plausible, which is what makes it worth a test. */
    expect(restTaken(entry).gaps).toEqual([])
    expect(restTaken(entry).median).toBeNull()
  })

  it('skips a gap where a set has no timestamp at all', () => {
    const start = new Date('2026-09-19T18:00:00').getTime()
    const entry = { date: '2026-09-19', kg: 200, sets: [
      { w: 200, r: 5, at: start },
      { w: 200, r: 5 },
      { w: 200, r: 5, at: start + 180_000 },
    ] }
    expect(restTaken(entry).gaps).toEqual([])
  })

  it('says so for a fully imported history', () => {
    const history = ['2026-09-01', '2026-09-08', '2026-09-15'].map(
      (d) => timed(d, 200, 90, 3, { atEstimated: true }))
    expect(hasObservedTiming(history)).toBe(false)
  })

  it('says so for a history that has any real timing', () => {
    const history = [
      timed('2026-09-01', 200, 90, 3, { atEstimated: true }),
      timed('2026-09-08', 200, 90),
    ]
    expect(hasObservedTiming(history)).toBe(true)
  })
})

describe('the trend across sessions', () => {
  const falling = ['2026-08-15', '2026-08-22', '2026-08-29', '2026-09-05', '2026-09-12']
    .map((d, i) => timed(d, 200, 180 - i * 30))
  const steady = ['2026-08-15', '2026-08-22', '2026-08-29', '2026-09-05', '2026-09-12']
    .map((d) => timed(d, 200, 180))

  it('reports rest coming down', () => {
    const trend = restTrend(falling)!
    expect(trend.from).toBe(180)
    expect(trend.to).toBe(60)
    expect(trend.compressing).toBe(true)
  })

  it('does not report steady rest as compressing', () => {
    expect(restTrend(steady)!.compressing).toBe(false)
  })

  it('needs enough timed sessions to be a trend rather than one rushed day', () => {
    expect(restTrend(falling.slice(-1))).toBeNull()
    expect(restTrend(falling.slice(-(MIN_TIMED_SESSIONS - 1)))).toBeNull()
    expect(restTrend(falling.slice(-MIN_TIMED_SESSIONS))).not.toBeNull()
  })

  it('is null when nothing was ever timed', () => {
    expect(restTrend(['2026-09-01', '2026-09-08', '2026-09-15'].map((d) => untimed(d, 200)))).toBeNull()
  })

  it('needs a real drop, not a rounding wobble', () => {
    const wobble = ['2026-08-15', '2026-08-22', '2026-08-29', '2026-09-05']
      .map((d, i) => timed(d, 200, 180 - i))
    expect(restTrend(wobble)!.compressing).toBe(false)
    expect(REST_COMPRESSION).toBeLessThan(1)
  })
})

/* ------------------ the plateau cause ------------------ */

describe('a stall with compressing rest reads differently', () => {
  const dates = ['2026-08-15', '2026-08-22', '2026-08-29', '2026-09-05', '2026-09-12', '2026-09-19']
  const rushed = dates.map((d, i) => timed(d, 200, Math.max(45, 180 - i * 30)))
  const unhurried = dates.map((d) => timed(d, 200, 180))

  it('names rushing the rest as the cause', () => {
    const plateau = detectPlateau(rushed, {})!
    expect(plateau).toBeTruthy()
    expect(plateau.cause).toBe('rest_compression')
    expect(plateau.restCompressing).toBe(true)
  })

  it('diagnoses the same stall with steady rest some other way', () => {
    const plateau = detectPlateau(unhurried, {})!
    expect(plateau).toBeTruthy()
    expect(plateau.cause).not.toBe('rest_compression')
    expect(plateau.restCompressing).toBe(false)
  })

  it('never fires on imported history', () => {
    const imported = dates.map((d, i) =>
      timed(d, 200, Math.max(45, 180 - i * 30), 3, { atEstimated: true }))
    expect(detectPlateau(imported, {})!.cause).not.toBe('rest_compression')
  })

  it('never fires on history with no timestamps', () => {
    expect(detectPlateau(dates.map((d) => untimed(d, 200)), {})!.cause).not.toBe('rest_compression')
  })
})

describe('it is a cause, not a deload trigger', () => {
  const dates = ['2026-08-15', '2026-08-22', '2026-08-29', '2026-09-05', '2026-09-12', '2026-09-19']
  const rushed = dates.map((d, i) => timed(d, 200, Math.max(45, 180 - i * 30)))

  it('does not flag the lift for a weight cut', () => {
    const plateau = detectPlateau(rushed, {})!
    const record = nextDeloadState(null, {
      history: rushed, today: '2026-09-19', recovery: null, rpe: null, sessionLogged: true,
    })
    expect(plateau.cause).toBe('rest_compression')
    expect(record === null || record.state === 'normal').toBe(true)
  })

  it('stays out of the deload state machine however many times it is seen', () => {
    let record = null as any
    for (const today of ['2026-09-19', '2026-09-26', '2026-10-03']) {
      record = nextDeloadState(record, {
        history: rushed, today, recovery: null, rpe: null, sessionLogged: true,
      })
    }
    expect(record === null || record.state === 'normal').toBe(true)
  })

  it('says rest longer, not cut the weight', () => {
    const advice = plateauAdvice(detectPlateau(rushed, {})!)
    expect(advice).toMatch(/rest/i)
    expect(advice).not.toMatch(/cut|drop|reduce|deload/i)
  })

  it('still advises the ordinary thing for an ordinary stall', () => {
    const steady = dates.map((d) => timed(d, 200, 180))
    expect(plateauAdvice(detectPlateau(steady, {})!)).not.toMatch(/rest longer/i)
  })
})

describe('the edges of what counts as rest', () => {
  it('counts a gap of exactly MAX_REST_SECONDS — only LONGER is not rest', () => {
    const r = restTaken(timed('2026-09-01', 185, MAX_REST_SECONDS, 2))
    expect(r.hasObservedTiming).toBe(true)
    expect(r.gaps).toEqual([MAX_REST_SECONDS])
    // control: one second more and it is a phone call, not rest
    expect(restTaken(timed('2026-09-01', 185, MAX_REST_SECONDS + 1, 2)).gaps).toEqual([])
  })

  it('does not read two sets stamped the same second as zero rest', () => {
    /* A double tap or a duplicated row. Zero is not a rest anyone took,
       and letting it in would halve a median and fake a compression. */
    const r = restTaken(timed('2026-09-01', 185, 0, 2))
    expect(r.hasObservedTiming).toBe(false)
    expect(r.median).toBeNull()
    // control: the same pair a minute apart is read
    expect(restTaken(timed('2026-09-01', 185, 60, 2)).median).toBe(60)
  })

  it('reads nothing from a day marked off, however it was stamped', () => {
    const off = { ...timed('2026-09-01', 185, 90, 3), off: true }
    expect(restTaken(off).hasObservedTiming).toBe(false)
    // control: the same sets on a training day are read
    expect(restTaken({ ...off, off: false }).median).toBe(90)
  })

  it('takes a missing entry as nothing timed rather than throwing', () => {
    /* The signature accepts null; callers pass whatever history holds. */
    expect(restTaken(null)).toEqual({ gaps: [], median: null, hasObservedTiming: false })
    expect(restTaken(undefined).hasObservedTiming).toBe(false)
  })
})
