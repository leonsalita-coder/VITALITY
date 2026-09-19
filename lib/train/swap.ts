/**
 * Smart swap.
 *
 * Swapping a lift used to mean typing a name into a text field, which is
 * the app asking the lifter to do the one job it is actually equipped for:
 * the catalog carries movement patterns, muscle contributions weighted by
 * how much of the work each muscle takes, equipment, and a session count
 * per lift. That is enough to offer movements that are genuinely
 * equivalent instead of hoping somebody remembers the name of one.
 *
 * THE JUDGMENT THAT SHAPES THE RANKING.
 *
 * History is worth more than a marginally better match. A swap that resets
 * progression costs a working weight, a PR reference and a plateau read,
 * and none of that is bought back by a movement that is five percent
 * closer on paper. So a lift with real sessions behind it climbs, and a
 * novel one has to be clearly better to beat it.
 *
 * But only so far. Two hundred sessions of curls does not make a curl a
 * squat: history is a bonus on a candidate that already matches, never a
 * substitute for matching. The weights below encode exactly that, and the
 * pattern term is deliberately the largest.
 *
 * WHAT IT MUST NOT DO.
 *
 * A candidate carries nothing of the lift it would replace. No history, no
 * records, no carried-over weight — a swap is a different exercise, and
 * inheriting a 315 lb squat's numbers onto a goblet squat would put a
 * weight nobody can lift on the first set and call it progression.
 *
 * Pure and DOM-free.
 */

import { CATALOG, type CatalogExercise } from './catalog'
import type { MuscleContribution } from './muscles'

/**
 * What each term is worth.
 *
 * Pattern dominates because that is what "equivalent movement" means.
 * Muscles refine within a pattern and rescue a decent cross-pattern
 * substitute. History is a thumb on the scale, not a scale.
 */
export const SWAP_WEIGHTS = {
  pattern: 1,
  muscles: 0.6,
  history: 0.25,
  equipment: 0.4,
} as const

/** Sessions at which the history bonus is fully earned. */
const HISTORY_SATURATION = 10

/** Equipment available wherever the athlete is standing. */
const ALWAYS_AVAILABLE = ['bodyweight', 'none', '']

export interface SwapContext {
  /** Equipment on record or available today. Empty means unknown. */
  equipment: string[]
  /** Sessions logged per exercise id. */
  sessions: Record<string, number>
  /** The lifts that may be offered. Defaults to the whole catalog. */
  known?: CatalogExercise[]
}

export interface SwapCandidate {
  id: string
  name: string
  equipment: string
  pattern: string
  /** This candidate's OWN sessions. Never the replaced lift's. */
  sessions: number
  score: number
  /** Why it was offered, in the same voice as every other reason here. */
  reasons: string[]
}

/** Total share of the work these two movements put on the same muscles. */
function muscleOverlap(a: CatalogExercise, b: CatalogExercise): number {
  const share = (list: MuscleContribution[], secondary: MuscleContribution[]) => {
    const out = new Map<string, number>()
    for (const c of list || []) out.set(c.muscle, (out.get(c.muscle) || 0) + c.share)
    /* Secondary work counts for half, matching how volume attributes it —
       one rule for "this muscle is involved but not the point". */
    for (const c of secondary || []) out.set(c.muscle, (out.get(c.muscle) || 0) + c.share * 0.5)
    return out
  }
  const left = share(a.primary, a.secondary)
  const right = share(b.primary, b.secondary)

  /* Overlap is the shared minimum, not the count of shared names: two
     lifts both listing 'quads' are not equally similar when one puts 65%
     of the work there and the other 5%. */
  let total = 0
  for (const [muscle, value] of left) {
    const other = right.get(muscle)
    if (other != null) total += Math.min(value, other)
  }
  return Math.min(1, total)
}

function equipmentAvailable(equipment: string, available: string[]): boolean {
  const want = String(equipment || '').toLowerCase()
  if (ALWAYS_AVAILABLE.includes(want)) return true
  return (available || []).some((have) => String(have).toLowerCase() === want)
}

/** The muscles this movement puts the most work into, for the reason line. */
function headline(exercise: CatalogExercise): string[] {
  return [...(exercise.primary || [])]
    .sort((a, b) => b.share - a.share)
    .slice(0, 2)
    .map((c) => c.muscle.replace(/_/g, ' '))
}

/**
 * Lifts that could stand in for this one, best first.
 *
 * Returns an empty list rather than a guess when there is nothing to
 * reason from — free text entry remains the fallback in the tile, and an
 * empty list is what tells it to show that instead.
 */
export function rankSwaps(
  replacing: CatalogExercise | null | undefined,
  context: SwapContext,
): SwapCandidate[] {
  if (!replacing || !replacing.id) return []
  const catalog = context.known && context.known.length ? context.known : CATALOG
  const available = context.equipment || []
  const knowsEquipment = available.length > 0
  const sessionsOf = context.sessions || {}

  const candidates: SwapCandidate[] = []

  for (const exercise of catalog) {
    if (!exercise || exercise.id === replacing.id) continue
    /* Equipment is a hard filter only when we actually know what is in the
       room. With nothing on record, filtering would silently return
       nothing and look like "no swaps exist". */
    if (knowsEquipment && !equipmentAvailable(exercise.equipment, available)) continue

    const samePattern = exercise.pattern === replacing.pattern
    const overlap = muscleOverlap(replacing, exercise)
    const sessions = Math.max(0, sessionsOf[exercise.id] || 0)
    const familiarity = Math.min(1, sessions / HISTORY_SATURATION)

    /* A candidate has to resemble the lift on its own terms before
       anything else counts. Without this, history alone would float an
       unrelated movement up the list. */
    if (!samePattern && overlap < 0.2) continue

    const reasons: string[] = []
    let score = 0

    if (samePattern) {
      score += SWAP_WEIGHTS.pattern
      reasons.push(`same movement — ${replacing.pattern.replace(/_/g, ' ')}`)
    }
    if (overlap > 0) {
      score += SWAP_WEIGHTS.muscles * overlap
      const muscles = headline(exercise)
      if (muscles.length) reasons.push(`works ${muscles.join(' and ')}`)
    }
    if (sessions > 0) {
      score += SWAP_WEIGHTS.history * familiarity
      reasons.push(`${sessions} sessions on record — keeps your progression`)
    }
    if (knowsEquipment && equipmentAvailable(exercise.equipment, available)) {
      score += SWAP_WEIGHTS.equipment
      if (!ALWAYS_AVAILABLE.includes(exercise.equipment)) {
        reasons.push(`${exercise.equipment} — equipment you have`)
      }
    }
    if (!reasons.length) continue

    candidates.push({
      id: exercise.id,
      name: exercise.name,
      equipment: exercise.equipment,
      pattern: exercise.pattern,
      sessions,
      score: Math.round(score * 1000) / 1000,
      reasons,
    })
  }

  // id as the tiebreak, so the same input always produces the same list
  return candidates.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
}
