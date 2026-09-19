/**
 * Streaks, measured in weeks that hit a target rather than consecutive days.
 *
 * A consecutive-day streak and a rest-day toggle are at war with each other:
 * taking a correctly programmed rest day breaks the number, which teaches
 * people to fake-log to protect it. Counting sessions per week rewards the
 * behaviour that actually drives progress and is indifferent to which days
 * they land on.
 *
 * A rest day never breaks a streak here, because a rest day is simply not a
 * session. A quiet week does.
 *
 * Pure and DOM-free; `now` is always a parameter.
 */

/** Sessions per week most people can hold and still recover. */
export const DEFAULT_WEEKLY_TARGET = 4

const DAY_MS = 86_400_000

function localMidnight(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, (m || 1) - 1, d || 1).getTime()
}

function startOfDay(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/**
 * Sessions in each rolling 7-day window ending today, most recent first.
 * Rolling rather than calendar weeks: a Sunday boundary would let someone
 * train Thu–Sat and Mon–Wed and score zero good weeks for six sessions.
 */
export function sessionsPerWeek(finishedDates: string[], now: number, weeks: number): number[] {
  const today = startOfDay(now)
  const buckets = new Array(weeks).fill(0)
  const seen = new Set<string>()
  for (const date of finishedDates || []) {
    if (!date || seen.has(date)) continue
    seen.add(date)
    const age = Math.round((today - localMidnight(date)) / DAY_MS)
    if (age < 0) continue // a future date is not evidence of anything
    const bucket = Math.floor(age / 7)
    if (bucket < weeks) buckets[bucket] += 1
  }
  return buckets
}

/** How many weeks back we are willing to look for a streak. */
const MAX_WEEKS = 260

/**
 * Consecutive recent weeks that met the target.
 *
 * The in-progress week is special: two sessions into a week with a target of
 * four has not failed, it is merely unfinished. Counting it as a break would
 * make the number flicker downward every Monday, so an incomplete current
 * week is skipped rather than treated as a miss.
 */
export function currentWeekStreak(
  finishedDates: string[],
  target: number = DEFAULT_WEEKLY_TARGET,
  now: number = Date.now(),
): number {
  const weeks = sessionsPerWeek(finishedDates, now, MAX_WEEKS)
  let streak = 0
  let start = 0
  if (weeks[0] < target) start = 1 // still in progress — no credit, no penalty
  for (let i = start; i < weeks.length; i++) {
    if (weeks[i] >= target) streak++
    else break
  }
  return streak
}

/**
 * The best run of target-meeting weeks on record, in the same unit as the
 * current streak so the two can sit side by side and be compared.
 */
export function longestWeekStreak(
  finishedDates: string[],
  target: number = DEFAULT_WEEKLY_TARGET,
  now: number = Date.now(),
): number {
  const weeks = sessionsPerWeek(finishedDates, now, MAX_WEEKS)
  // trim the trailing empty tail so a long quiet history is not scanned
  let last = weeks.length - 1
  while (last >= 0 && weeks[last] === 0) last--

  let best = 0
  let run = 0
  for (let i = 0; i <= last; i++) {
    if (weeks[i] >= target) {
      run++
      if (run > best) best = run
    } else {
      run = 0
    }
  }
  return Math.max(best, currentWeekStreak(finishedDates, target, now))
}

/** Names its own unit, so the number is never read as days. */
export function streakLabel(streak: number, target: number = DEFAULT_WEEKLY_TARGET): string {
  if (streak <= 0) return ''
  return `${streak} ${streak === 1 ? 'week' : 'weeks'} at ${target}+`
}
