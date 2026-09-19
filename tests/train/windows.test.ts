import { describe, it, expect } from 'vitest'
import {
  rollingWindow, baselineWindow, inWindow, deltaOf, asPercent,
  daysBetween, dateKey, localMidnight,
} from '../../lib/train/windows'

/**
 * The shared window.
 *
 * Three readers depend on this now — volumeRamp, periodComparison and the
 * weekly change analysis — which is the point of it existing, and also
 * why it needs its own tests. An off-by-one here is an off-by-one in all
 * three at once, and each of their own tests would still pass because
 * they would all be wrong together.
 */

const NOON = new Date(2026, 8, 19, 12).getTime()
const MIDNIGHT = new Date(2026, 8, 19, 0, 0, 1).getTime()
const LATE = new Date(2026, 8, 19, 23, 59).getTime()

describe('a rolling week', () => {
  it('is seven days INCLUDING today', () => {
    const w = rollingWindow(NOON)
    expect(w.to).toBe('2026-09-19')
    expect(w.from).toBe('2026-09-13')
    expect(w.days).toBe(7)
    expect(daysBetween(w.from, w.to)).toBe(6)
  })

  it('is the same window whatever time of day it is asked', () => {
    /* A window that shifts at noon would move a session between weeks
       depending on when the screen was opened. */
    expect(rollingWindow(MIDNIGHT)).toEqual(rollingWindow(NOON))
    expect(rollingWindow(LATE)).toEqual(rollingWindow(NOON))
  })

  it('steps back cleanly, with no gap and no overlap', () => {
    const week = rollingWindow(NOON)
    const before = rollingWindow(NOON, 7)
    expect(before.to).toBe('2026-09-12')
    expect(daysBetween(before.to, week.from)).toBe(1)
    expect(inWindow(before.to, week)).toBe(false)
    expect(inWindow(week.from, before)).toBe(false)
  })

  it('takes a length other than a week', () => {
    const w = rollingWindow(NOON, 0, 28)
    expect(w.from).toBe('2026-08-23')
    expect(w.days).toBe(28)
  })
})

describe('the baseline', () => {
  it('is the four weeks before this one, not including it', () => {
    const week = rollingWindow(NOON)
    const base = baselineWindow(NOON)
    expect(base.days).toBe(28)
    expect(base.to).toBe('2026-09-12')
    expect(inWindow(week.from, base)).toBe(false)
    expect(daysBetween(base.to, week.from)).toBe(1)
  })

  it('shifts further back when a hypothesis declares a lag', () => {
    const lagged = baselineWindow(NOON, 4, 8)
    expect(lagged.to).toBe('2026-09-11')
  })
})

describe('inWindow', () => {
  const w = rollingWindow(NOON)

  it('includes both ends', () => {
    expect(inWindow(w.from, w)).toBe(true)
    expect(inWindow(w.to, w)).toBe(true)
  })

  it('excludes the day either side', () => {
    expect(inWindow('2026-09-12', w)).toBe(false)
    expect(inWindow('2026-09-20', w)).toBe(false)
  })

  it('says no to a missing date rather than throwing', () => {
    expect(inWindow('', w)).toBe(false)
    expect(inWindow(undefined as never, w)).toBe(false)
  })
})

describe('a delta keeps "no baseline" distinct from "no change"', () => {
  it('reports a rise', () => {
    expect(deltaOf(12, 10)).toMatchObject({ ratio: 1.2, change: 0.2 })
  })

  it('reports a fall', () => {
    expect(deltaOf(8, 10)).toMatchObject({ ratio: 0.8, change: -0.2 })
  })

  it('reports no change as zero', () => {
    expect(deltaOf(10, 10).change).toBe(0)
  })

  it('reports NULL when there is nothing to divide by', () => {
    /* Returning 0 here is how a first week of training gets reported as
       perfectly steady. */
    expect(deltaOf(10, 0).change).toBeNull()
    expect(deltaOf(10, 0).ratio).toBeNull()
  })

  it('refuses nonsense rather than propagating it', () => {
    expect(deltaOf(NaN, 10).change).toBeNull()
    expect(deltaOf(10, NaN).change).toBeNull()
    expect(deltaOf(Infinity, 10).change).toBeNull()
  })
})

describe('asPercent', () => {
  it('says which way', () => {
    expect(asPercent(0.18)).toBe('up 18%')
    expect(asPercent(-0.18)).toBe('down 18%')
  })

  it('says nothing for a null change', () => {
    expect(asPercent(null)).toBe('')
  })
})

describe('dates round-trip', () => {
  it('survives midnight in local time', () => {
    expect(dateKey(localMidnight('2026-09-19'))).toBe('2026-09-19')
  })

  it('counts days in the direction it says', () => {
    expect(daysBetween('2026-09-13', '2026-09-19')).toBe(6)
    expect(daysBetween('2026-09-19', '2026-09-13')).toBe(-6)
  })

  it('crosses a month boundary correctly', () => {
    expect(daysBetween('2026-08-31', '2026-09-01')).toBe(1)
    expect(rollingWindow(new Date(2026, 8, 2, 12).getTime()).from).toBe('2026-08-27')
  })

  it('crosses a DST change without losing or gaining a day', () => {
    const after = new Date(2026, 10, 3, 12).getTime()
    const w = rollingWindow(after)
    expect(w.to).toBe('2026-11-03')
    expect(w.from).toBe('2026-10-28')
    expect(daysBetween(w.from, w.to)).toBe(6)
  })

  it('is still SEVEN days in the week after the clocks go forward', () => {
    /* The real edge, and a genuine bug before this test existed.
       Subtracting six times 86_400_000 ms from a time early on 2026-03-09
       lands on March 2 rather than March 3, because the intervening
       Sunday was only 23 hours long. The window becomes eight days, once
       a year, silently inflating every weekly figure computed in it.
       Windows are stepped by CALENDAR days for exactly this reason. */
    for (const hour of [0, 1, 6, 12, 23]) {
      const t = new Date(2026, 2, 9, hour, 30).getTime()
      const w = rollingWindow(t)
      expect(w.to, `hour ${hour}`).toBe('2026-03-09')
      expect(w.from, `hour ${hour}`).toBe('2026-03-03')
      expect(daysBetween(w.from, w.to), `hour ${hour}`).toBe(6)
    }
  })

  it('keeps the baseline exactly 28 days across the same change', () => {
    const t = new Date(2026, 2, 9, 0, 30).getTime()
    const base = baselineWindow(t)
    expect(base.to).toBe('2026-03-02')
    expect(daysBetween(base.from, base.to)).toBe(27)
  })
})
