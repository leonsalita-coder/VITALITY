import { describe, it, expect } from 'vitest'
import {
  projectGoal, MIN_PROJECTION_POINTS, STATIC_WEEKS, MAX_PROJECTION_DAYS,
} from '../../lib/train/projection'

/**
 * Where a goal actually lands.
 *
 * liftGoals were targets with no trajectory: a number, a bar, and no
 * answer to the only question worth asking about a goal, which is whether
 * it is coming.
 *
 * THE RULE THAT SHAPES THIS FILE: an honest "not on this trajectory"
 * beats a fake date. Fitting a line through noise and reporting "March
 * 2031" is the app being precise about something it does not know, and
 * the lifter only has to check it once against reality to stop believing
 * anything else it says. So there are three ways to be silent — too
 * little history, no movement, and movement too slow to matter — and only
 * one way to produce a date.
 */

const NOW = new Date(2026, 8, 19, 12).getTime()
const day = (back: number) => {
  const d = new Date(2026, 8, 19 - back)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** A point per week, climbing by `step` each time. */
const climbing = (weeks: number, from: number, step: number) =>
  Array.from({ length: weeks }, (_, i) => ({ date: day((weeks - 1 - i) * 7), value: from + i * step }))

const flat = (weeks: number, value: number) => climbing(weeks, value, 0)

describe('a rising trend produces a date', () => {
  const series = climbing(10, 200, 5) // 200 → 245, five a week

  it('says when the goal arrives', () => {
    const result = projectGoal(series, 275, NOW)!
    expect(result.verdict).toBe('on_track')
    expect(result.date).toBeTruthy()
    expect(result.weeks).toBeGreaterThan(0)
  })

  it('puts the date in the future, in the right ballpark', () => {
    const result = projectGoal(series, 275, NOW)!
    // 245 now, 275 wanted, five a week — about six weeks
    expect(result.weeks).toBeGreaterThanOrEqual(4)
    expect(result.weeks).toBeLessThanOrEqual(9)
    expect(new Date(result.date!).getTime()).toBeGreaterThan(NOW)
  })

  it('reports a goal already reached rather than projecting one', () => {
    const result = projectGoal(series, 210, NOW)!
    expect(result.verdict).toBe('reached')
    expect(result.date).toBeNull()
  })

  it('says it in a sentence', () => {
    expect(projectGoal(series, 275, NOW)!.text).toMatch(/\d/)
  })
})

describe('a flat trend says static, never a date', () => {
  it('names how long it has not moved', () => {
    const result = projectGoal(flat(9, 225), 275, NOW)!
    expect(result.verdict).toBe('static')
    expect(result.date).toBeNull()
    expect(result.text).toMatch(/hasn['’]t moved|no movement/i)
    expect(result.text).toMatch(/\d+ weeks/)
  })

  it('needs the flatness to have lasted before saying so', () => {
    const shortFlat = flat(MIN_PROJECTION_POINTS, 225)
    const result = projectGoal(shortFlat, 275, NOW)
    // enough points to read, but not enough weeks to call it static
    expect(result === null || result.verdict !== 'static').toBe(true)
  })

  it('calls a falling trend static too — it is certainly not arriving', () => {
    const falling = climbing(10, 260, -4)
    const result = projectGoal(falling, 300, NOW)!
    expect(result.date).toBeNull()
    expect(['static', 'unreachable']).toContain(result.verdict)
  })
})

describe('a trend too slow to matter is unreachable, not a date years out', () => {
  it('refuses to name a date past the horizon', () => {
    // a quarter pound a week against a fifty pound gap
    const crawling = climbing(12, 200, 0.25)
    const result = projectGoal(crawling, 260, NOW)!
    expect(result.verdict).toBe('unreachable')
    expect(result.date).toBeNull()
    expect(result.text).toMatch(/not on this|at this rate/i)
  })

  it('still names a date just inside the horizon', () => {
    const series = climbing(10, 200, 5)
    const result = projectGoal(series, 245 + 5 * 20, NOW)!
    expect(result.verdict).toBe('on_track')
    expect(result.weeks!).toBeLessThanOrEqual(MAX_PROJECTION_DAYS / 7)
  })
})

describe('thin history is silent', () => {
  it('says nothing with one point', () => {
    expect(projectGoal([{ date: day(0), value: 200 }], 275, NOW)).toBeNull()
  })

  it('says nothing below the minimum', () => {
    expect(projectGoal(climbing(MIN_PROJECTION_POINTS - 1, 200, 5), 275, NOW)).toBeNull()
  })

  it('speaks at the minimum', () => {
    expect(projectGoal(climbing(MIN_PROJECTION_POINTS, 200, 5), 275, NOW)).not.toBeNull()
  })

  it('says nothing for an empty or missing series', () => {
    expect(projectGoal([], 275, NOW)).toBeNull()
    expect(projectGoal(null, 275, NOW)).toBeNull()
  })

  it('says nothing for a target that is not a number', () => {
    const series = climbing(10, 200, 5)
    for (const bad of [0, -5, NaN, null, undefined]) {
      expect(projectGoal(series, bad as never, NOW)).toBeNull()
    }
  })

  it('ignores points so old they say nothing about now', () => {
    const ancient = climbing(6, 100, 5).map((p) => ({ ...p, date: '2020-01-0' + ((+p.date.slice(-1)) + 1) }))
    expect(projectGoal(ancient, 275, NOW)).toBeNull()
  })
})

describe('a goal on a kind without e1RM projects in its own unit', () => {
  it('projects seconds for a plank', () => {
    const series = climbing(10, 60, 5) // holding five seconds longer a week
    const result = projectGoal(series, 120, NOW, { unit: 'seconds' })!
    expect(result.verdict).toBe('on_track')
    expect(result.text).toMatch(/seconds|s\b/)
    expect(result.text).not.toMatch(/\blb\b/)
  })

  it('projects metres for a carry', () => {
    const result = projectGoal(climbing(10, 40, 4), 100, NOW, { unit: 'metres' })!
    expect(result.text).toMatch(/metres|m\b/)
  })

  it('defaults to pounds, like everything else here', () => {
    expect(projectGoal(climbing(10, 200, 5), 275, NOW)!.text).toMatch(/lb/)
  })
})

describe('the projection is honest about itself', () => {
  it('is deterministic', () => {
    const series = climbing(10, 200, 5)
    expect(projectGoal(series, 275, NOW)).toEqual(projectGoal(series, 275, NOW))
  })

  it('reads the clock only from `now`', () => {
    const series = climbing(10, 200, 5)
    const later = projectGoal(series, 275, NOW + 86_400_000 * 30)
    const sooner = projectGoal(series, 275, NOW)
    expect(later).not.toEqual(sooner)
  })

  it('carries the slope it reasoned from, so a caller can say how fast', () => {
    const result = projectGoal(climbing(10, 200, 5), 275, NOW)!
    expect(result.perWeek).toBeGreaterThan(3)
    expect(result.perWeek).toBeLessThan(7)
  })

  it('names the weeks of silence on a static goal', () => {
    const result = projectGoal(flat(STATIC_WEEKS + 2, 225), 275, NOW)!
    expect(result.verdict).toBe('static')
    expect(result.staticWeeks).toBeGreaterThanOrEqual(STATIC_WEEKS)
  })
})
