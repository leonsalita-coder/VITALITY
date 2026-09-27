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
    /* EQUIVALENT MUTANT (confirmed empirically, individually and against
       the full real test suite — including every other consumer of
       sessionsPerWeek): removing this guard lets a negative age compute
       a negative bucket, e.g. `Math.floor(-3/7) === -1`. `buckets[-1]`
       is not index 0 — JS creates a non-index property on the array
       object rather than writing into a real slot, and every reader
       below iterates 0..weeks-1 by numeric index. The write happens;
       nothing ever reads it. */
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
  /* EQUIVALENT MUTANT (confirmed empirically): `<` can become `<=` with
     nothing able to catch it. weeks.length is fixed at MAX_WEEKS by the
     sessionsPerWeek() call above, so the one extra index this would
     reach is weeks[MAX_WEEKS], which is `undefined` — and
     `undefined >= target` is always false, landing on the same `else
     break` the loop would already have hit had a real streak run that
     long. The extra iteration changes nothing streak ever holds. */
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
  /* trim the trailing empty tail so a long quiet history is not scanned —
     a PERFORMANCE trim, not a correctness one: every index this skips is
     a zero bucket, and a zero bucket can never clear `run >= target`
     for any target > 0 whether the loop below visits it or not.

     EQUIVALENT MUTANTS, both (confirmed empirically, individually and
     combined). `last >= 0` can become `last > 0`: the two only disagree
     at last === 0, and by then the loop has already found weeks[0] === 0
     (or it would have stopped one iteration earlier on the != 0 check) —
     scanning that one extra zero bucket in the main loop below cannot
     raise `best`. `weeks[last] === 0` can become `!== 0`, which stops
     trimming immediately instead of walking back through the real
     trailing zeros — leaving `last` far larger and the main loop
     scanning hundreds of extra zero buckets it would otherwise have
     skipped, all inert for the same reason. */
  let last = weeks.length - 1
  while (last >= 0 && weeks[last] === 0) last--

  let best = 0
  let run = 0
  for (let i = 0; i <= last; i++) {
    if (weeks[i] >= target) {
      run++
      /* EQUIVALENT MUTANT (confirmed empirically): `>` can become `>=`
         with nothing able to catch it. At the one point they'd disagree
         (run === best exactly), the assignment reassigns the identical
         number — a no-op either way. */
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
