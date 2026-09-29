import { describe, it, expect } from 'vitest'
import {
  DEFAULT_WEEKLY_TARGET,
  sessionsPerWeek,
  currentWeekStreak,
  longestWeekStreak,
  streakLabel,
} from '../../lib/train/streaks'

const at = (day: string) => new Date(`${day}T12:00:00`).getTime()

/** Dates counting back from an anchor, so fixtures read as "n days ago". */
const daysBefore = (anchor: string, ...offsets: number[]): string[] =>
  offsets.map((n) => {
    const d = new Date(`${anchor}T12:00:00`)
    d.setDate(d.getDate() - n)
    const pad = (x: number) => String(x).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  })

const TODAY = '2026-09-18'
const now = at(TODAY)

describe('sessionsPerWeek', () => {
  it('buckets into rolling 7-day windows ending today', () => {
    const dates = daysBefore(TODAY, 0, 2, 4, 6, 8, 10)
    const weeks = sessionsPerWeek(dates, now, 2)
    expect(weeks[0]).toBe(4) // days 0,2,4,6
    expect(weeks[1]).toBe(2) // days 8,10
  })

  it('is all zeroes with no sessions', () => {
    expect(sessionsPerWeek([], now, 3)).toEqual([0, 0, 0])
  })

  it('ignores anything in the future', () => {
    const dates = daysBefore(TODAY, -3, 0, 1)
    expect(sessionsPerWeek(dates, now, 1)[0]).toBe(2)
  })

  it('counts a date only once even if it is duplicated', () => {
    expect(sessionsPerWeek([TODAY, TODAY, TODAY], now, 1)[0]).toBe(1)
  })
})

describe('currentWeekStreak', () => {
  it('counts consecutive weeks that met the target', () => {
    // 4 sessions in each of the last three weeks
    const dates = daysBefore(TODAY, 0, 2, 4, 6, 7, 9, 11, 13, 14, 16, 18, 20)
    expect(currentWeekStreak(dates, 4, now)).toBe(3)
  })

  it('holds through interleaved rest days — they are simply not sessions', () => {
    // trained Mon/Wed/Fri/Sun, rested the days between, every week
    const dates = daysBefore(TODAY, 0, 2, 4, 6, 7, 9, 11, 13)
    expect(currentWeekStreak(dates, 4, now)).toBe(2)
  })

  it('breaks on a quiet week', () => {
    // last week fine, the week before only managed 2 against a target of 4
    const dates = daysBefore(TODAY, 0, 2, 4, 6, 8, 10)
    expect(currentWeekStreak(dates, 4, now)).toBe(1)
  })

  it('does not break on an in-progress week that has not failed yet', () => {
    // two sessions so far this week against a target of 4 — still early.
    // The completed weeks behind it must keep their credit.
    const dates = daysBefore(TODAY, 0, 1, 7, 9, 11, 13, 14, 16, 18, 20)
    expect(currentWeekStreak(dates, 4, now)).toBe(2)
  })

  it('counts the current week as soon as it does hit the target', () => {
    const dates = daysBefore(TODAY, 0, 1, 2, 3, 7, 9, 11, 13)
    expect(currentWeekStreak(dates, 4, now)).toBe(2)
  })

  it('is zero when nothing has been logged', () => {
    expect(currentWeekStreak([], 4, now)).toBe(0)
  })

  it('honours a different target', () => {
    const dates = daysBefore(TODAY, 0, 3, 7, 10, 14, 17)
    expect(currentWeekStreak(dates, 2, now)).toBe(3)
    expect(currentWeekStreak(dates, 3, now)).toBe(0)
  })

  it('defaults to four sessions a week', () => {
    expect(DEFAULT_WEEKLY_TARGET).toBe(4)
  })
})

describe('longestWeekStreak', () => {
  it('is measured in the same unit as the current streak', () => {
    // three good weeks, a bad one, then two good ones
    const dates = daysBefore(
      TODAY,
      0, 2, 4, 6,
      7, 9, 11, 13,
      21, 23, 25, 27,
      28, 30, 32, 34,
      35, 37, 39, 41,
    )
    expect(longestWeekStreak(dates, 4, now)).toBe(3)
    expect(currentWeekStreak(dates, 4, now)).toBe(2)
  })

  it('never reports less than the current streak', () => {
    const dates = daysBefore(TODAY, 0, 2, 4, 6, 7, 9, 11, 13)
    expect(longestWeekStreak(dates, 4, now)).toBeGreaterThanOrEqual(
      currentWeekStreak(dates, 4, now),
    )
  })

  it('is zero with no history', () => {
    expect(longestWeekStreak([], 4, now)).toBe(0)
  })
})

describe('streakLabel', () => {
  it('names the unit so the number is not mistaken for days', () => {
    expect(streakLabel(3, 4)).toBe('3 weeks at 4+')
    expect(streakLabel(1, 4)).toBe('1 week at 4+')
  })

  it('is empty at zero, so nothing is rendered', () => {
    expect(streakLabel(0, 4)).toBe('')
  })
})

describe('the far edge of the window', () => {
  it('returns exactly the weeks asked for, even with a session just past them', () => {
    /* Day 84 is the first day of week 12 — one past a 12-week window. */
    const weeks = sessionsPerWeek(daysBefore(TODAY, 77, 84), now, 12)
    expect(weeks).toHaveLength(12)
    expect(weeks[11]).toBe(1)   // control: day 77 is inside, in the last week
    expect(weeks.every((n) => Number.isFinite(n))).toBe(true)
  })

  it('finds the best run even when it sits in the oldest weeks on record', () => {
    /* Ten weeks at the target, at the very end of the five-year window
       (weeks 250-259), and nothing since. The tail-trim that skips a
       quiet history must stop at the first week with sessions in it, not
       run through them. */
    const offsets: number[] = []
    for (let w = 250; w <= 259; w++) for (let s = 0; s < DEFAULT_WEEKLY_TARGET; s++) offsets.push(w * 7 + s)
    expect(longestWeekStreak(daysBefore(TODAY, ...offsets), DEFAULT_WEEKLY_TARGET, now)).toBe(10)
  })
})
