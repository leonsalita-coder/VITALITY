import { describe, it, expect, afterEach } from 'vitest'
import { localToday, realClock } from './clock'

/**
 * localToday() is what "today" means for 22 test files, so it gets pinned.
 *
 * The failure it guards against is a tidy-up: someone swaps the three
 * getters for `toISOString().slice(0, 10)`. That is UTC, so the date moves
 * by a day for everyone far enough from Greenwich at the wrong hour — and
 * the tests that use it keep passing, vacuously, because the tile's
 * `today` no longer matches anything they seeded.
 *
 * Every case runs in a named zone, set here, rather than whatever zone
 * the machine is in. On a host that is already UTC, local and UTC agree
 * and a test relying on the host's zone could never tell them apart.
 * Node re-reads process.env.TZ on assignment, so the zone genuinely
 * changes for the Date constructor and the getters.
 */

const ORIGINAL_TZ = process.env.TZ
const inZone = <T>(zone: string, fn: () => T): T => {
  process.env.TZ = zone
  return fn()
}
afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ
  else process.env.TZ = ORIGINAL_TZ
})

describe('localToday reads the LOCAL calendar date', () => {
  it('east of UTC, just after local midnight, is already the new day', () => {
    inZone('Australia/Sydney', () => {
      const at = new Date(2026, 0, 1, 0, 30) // 00:30 local, 13:30 the day before in UTC
      expect(at.toISOString().slice(0, 10)).toBe('2025-12-31') // the control: UTC really disagrees
      expect(localToday(() => at)).toBe('2026-01-01')
    })
  })

  it('west of UTC, just before local midnight, is still the old day', () => {
    inZone('America/Los_Angeles', () => {
      const at = new Date(2026, 0, 1, 23, 30) // 23:30 local, 07:30 the day after in UTC
      expect(at.toISOString().slice(0, 10)).toBe('2026-01-02')
      expect(localToday(() => at)).toBe('2026-01-01')
    })
  })

  it('pads month and day to two digits', () => {
    inZone('UTC', () => {
      expect(localToday(() => new Date(2026, 2, 5, 12))).toBe('2026-03-05')
    })
  })
})

describe('the default clock is the real one', () => {
  /* Bracketed rather than compared once: a run that straddles midnight
     would otherwise fail for a reason that has nothing to do with the
     helper. If the date changed between the two readings, either answer
     is right. */
  it('with no argument, matches the real local date', () => {
    /* Computed independently of the helper — comparing localToday() with
       localToday(() => new Date()) would check the function against
       itself and could never fail. */
    const ymd = (d: Date) =>
      [d.getFullYear(), d.getMonth() + 1, d.getDate()].map((n, i) => String(n).padStart(i ? 2 : 4, '0')).join('-')
    const before = ymd(new Date())
    const got = localToday()
    const after = ymd(new Date())
    expect([before, after]).toContain(got)
  })

  it('realClock returns the current time', () => {
    const lo = Date.now()
    const t = realClock().getTime()
    expect(t).toBeGreaterThanOrEqual(lo)
    expect(t).toBeLessThanOrEqual(Date.now())
  })
})
