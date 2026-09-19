/**
 * What you did last time.
 *
 * When the prefill says 190×8, the thing a lifter wants beside it is what
 * they actually did last time — 185×8,8,7. The app has had that all
 * along, and made people open History to see it, which is the most
 * expensive navigation in the tile because it happens between sets with a
 * rest timer running.
 *
 * THREE THINGS THIS FILE REFUSES TO DO.
 *
 * It does not render. Everything here is structured data — weights, reps,
 * flags — and not one sentence. A caller that has to parse a string back
 * into numbers to lay it out cannot lay it out well, and a string baked
 * here would be wrong in every context but the one it was written for.
 *
 * It does not include warm-ups. This is a comparison against working
 * sets; a ramp in the middle of it makes the row longer and says nothing
 * about whether last time was harder or easier than today.
 *
 * It does not return an empty result. With no history it is null, so a
 * caller renders NOTHING rather than rendering a box with nothing in it —
 * the same distinction as everywhere else here between absent and zero.
 *
 * Pure and DOM-free.
 */

import {
  entryKind, isAmrapSet,
  type HistoryEntry, type HistorySet, type SetKind,
} from './sets'

const DAY_MS = 86_400_000

export interface LastSet {
  /** Pounds. Present only for kinds that carry load. */
  weight?: number
  /** Present for kinds that count reps. */
  reps?: number
  /** Present for time and time_distance. */
  seconds?: number
  /** Present for distance and time_distance. */
  metres?: number
  /** The set was failed. Shown, not hidden — a miss is information. */
  missed: boolean
  /** Logged RPE, or null. Optional forever. */
  rpe: number | null
  /** Taken to failure, which is why the reps may look unlike the others. */
  amrap: boolean
}

export interface LastSession {
  date: string
  daysAgo: number
  kind: SetKind
  sets: LastSet[]
}

function shapeOf(set: HistorySet, kind: SetKind): LastSet {
  const base: LastSet = {
    missed: set.fail === true,
    rpe: typeof set.rpe === 'number' && Number.isFinite(set.rpe) ? set.rpe : null,
    amrap: isAmrapSet(set) || set.amrap === true,
  }
  /* Only the fields this kind actually measures. Carrying a weight of
     zero on a plank would invite a caller to render "0 lb × 60s", which
     is the app inventing a number nobody logged. */
  switch (kind) {
    case 'time':
      return { ...base, seconds: set.s || 0 }
    case 'distance':
      return { ...base, metres: set.m || 0 }
    case 'time_distance':
      return { ...base, metres: set.m || 0, seconds: set.s || 0 }
    case 'reps_only':
    case 'bodyweight':
      return { ...base, reps: set.r || 0 }
    default:
      return { ...base, weight: typeof set.w === 'number' ? set.w : 0, reps: set.r || 0 }
  }
}

/**
 * The most recent session that contained real work.
 *
 * Today is excluded: "last time" means the session before this one, and
 * showing a lifter their own half-finished session as a comparison
 * against itself is worse than showing nothing.
 *
 * A session of nothing but warm-ups is skipped rather than returned
 * empty, because a lifter who warmed up and left still wants to see the
 * last time they actually lifted.
 */
export function lastSessionFor(
  history: HistoryEntry[] | null | undefined,
  now: number,
): LastSession | null {
  const today = dateKey(now)
  const usable = (history || [])
    .filter((entry) => entry && !entry.off && entry.date && entry.date < today)
    .sort((a, b) => a.date.localeCompare(b.date))

  for (let i = usable.length - 1; i >= 0; i--) {
    const entry = usable[i]
    /* A failed set is still work for this purpose — it is exactly what a
       lifter is comparing against — so the list is every set that is not
       a warm-up, and a session with none of those is skipped.
       There is deliberately no second `workingSets` check here: a
       non-empty workingSets implies a non-empty `shown`, so it could
       never fire, and an unreachable guard is decoration. */
    const shown = (entry.sets || []).filter((set) => set.warmup !== true)
    if (!shown.length) continue

    const kind = entryKind(entry)
    return {
      date: entry.date,
      daysAgo: Math.round((localMidnight(today) - localMidnight(entry.date)) / DAY_MS),
      kind,
      sets: shown.map((set) => shapeOf(set, kind)),
    }
  }
  return null
}

function dateKey(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function localMidnight(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, (m || 1) - 1, d || 1).getTime()
}
