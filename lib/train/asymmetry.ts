/**
 * Left against right.
 *
 * `perSide` records ONE limb's work and doubles it for volume. Logging
 * each limb independently is a different thing, and it surfaces something
 * nothing else here can see: a sustained difference between sides.
 *
 * THE LINE THIS FILE DOES NOT CROSS.
 *
 * It reports a difference. It says nothing about injury, offers no
 * advice, and does not call the difference a problem. A dominant side is
 * stronger in almost everyone — reporting that as a finding would be the
 * app pathologising being normal, and an athlete who is told their body
 * is wrong once stops reading.
 *
 * So the gate is deliberately high in both dimensions: the gap has to be
 * LARGE, and it has to be there in most sessions rather than one. One bad
 * set on a tired side is a bad set.
 *
 * Pure and DOM-free.
 */

import { isWorkingSet, sidesOf, type HistoryEntry } from './sets'

/** Below this, a difference between limbs is ordinary. */
export const MIN_LOAD_GAP = 0.12

/** Sessions with per-limb data before a direction means anything. */
export const MIN_ASYMMETRY_SESSIONS = 4

/** Share of those sessions the gap must appear in to be persistent. */
const PERSISTENCE = 0.7

export interface SideGap {
  left: number
  right: number
  stronger: 'left' | 'right' | 'even'
  /** Fractional difference in load, relative to the weaker side. */
  loadGap: number
  /** Difference in reps at the top set. */
  repGap: number
}

const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0)

/** The gap in one session, or null when it was not logged per limb. */
export function sideGapOf(entry: HistoryEntry | null | undefined): SideGap | null {
  if (!entry || entry.off) return null
  const pairs = (entry.sets || [])
    .filter(isWorkingSet)
    .map(sidesOf)
    .filter((s): s is NonNullable<ReturnType<typeof sidesOf>> => s != null)
  if (!pairs.length) return null

  const left = mean(pairs.map((p) => p.left.w))
  const right = mean(pairs.map((p) => p.right.w))
  const leftReps = mean(pairs.map((p) => p.left.r))
  const rightReps = mean(pairs.map((p) => p.right.r))

  const weaker = Math.min(left, right)
  const loadGap = weaker > 0 ? Math.abs(left - right) / weaker : 0
  return {
    left: Math.round(left * 10) / 10,
    right: Math.round(right * 10) / 10,
    stronger: left === right ? 'even' : left > right ? 'left' : 'right',
    loadGap: Math.round(loadGap * 1000) / 1000,
    repGap: Math.round(Math.abs(leftReps - rightReps) * 10) / 10,
  }
}

export interface Asymmetry {
  stronger: 'left' | 'right'
  /** Mean load on each side across the sessions read. */
  left: number
  right: number
  loadGap: number
  sessions: number
  /** One sentence. An observation, with both numbers, and nothing else. */
  text: string
}

/**
 * A difference big enough and steady enough to mention.
 *
 * Null in every other case, which is nearly all of them.
 */
export function asymmetryFor(history: HistoryEntry[] | null | undefined): Asymmetry | null {
  const gaps = (history || [])
    .map(sideGapOf)
    .filter((g): g is SideGap => g != null)
  if (gaps.length < MIN_ASYMMETRY_SESSIONS) return null

  const sides: Array<'left' | 'right'> = ['left', 'right']
  for (const side of sides) {
    /* Persistent means most sessions, not the average of all of them —
       one session at forty percent would drag a mean past the threshold
       on its own, and that is exactly the noise this is meant to reject. */
    const showing = gaps.filter((g) => g.stronger === side && g.loadGap >= MIN_LOAD_GAP)
    if (showing.length < Math.ceil(gaps.length * PERSISTENCE)) continue

    const left = Math.round(mean(gaps.map((g) => g.left)) * 10) / 10
    const right = Math.round(mean(gaps.map((g) => g.right)) * 10) / 10
    const loadGap = Math.round(mean(showing.map((g) => g.loadGap)) * 1000) / 1000
    return {
      stronger: side,
      left,
      right,
      loadGap,
      sessions: gaps.length,
      /* Both numbers, the word "difference", and no verdict. It is not
         this file's business whether that difference matters. */
      text: `Across ${gaps.length} sessions logged per side, your left has averaged ${left} and your right ${right} — a difference of ${Math.round(loadGap * 100)}%.`,
    }
  }
  return null
}
