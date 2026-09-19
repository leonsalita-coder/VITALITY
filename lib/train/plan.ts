/**
 * Constraining a generated session.
 *
 * The coach is a second writer into the athlete's training data, and until
 * now it was unconstrained in every dimension: it could invent exercises,
 * program equipment that is not in the room, ignore a stated time budget,
 * hammer a muscle worked yesterday, and re-suggest the movement that hurts.
 * At one user that is an annoyance. It is also the most likely way this app
 * hands someone a session that injures them.
 *
 * So nothing the model says is taken on trust. It chooses from a supplied
 * list, and every limit is enforced AFTER it answers — a model asked nicely
 * to stay under a cap is not a cap.
 *
 * Pure and DOM-free.
 */

import { normalizeClassification } from './classify'
import { DEFAULT_SET_KIND, type SetKind } from './sets'

/** Ceilings a generated session may never exceed, whatever the model says. */
export const MAX_WORKING_SETS = 30
export const MAX_SETS_PER_MUSCLE = 12

/** Hard sets on one muscle in the recent window that make it off-limits. */
export const RECENT_HEAVY_SETS = 8

/** Rough working time per set, for estimating a session against the clock. */
const SECONDS_PER_SET = 45

/** Equipment that is available wherever the athlete is standing. */
const ALWAYS_AVAILABLE = ['bodyweight', 'none', '']

export interface KnownExercise {
  id: string
  name: string
  equipment: string
  /** Primary muscles, lower-case. */
  muscles: string[]
  kind: SetKind
  /** Sessions on record. History is what makes a lift a safe choice. */
  sessions: number
  sets: number
  reps: number
  weight: number
  rest: number
  perSide?: boolean
  assisted?: boolean
  repRange?: [number, number] | null
}

export interface PlanConstraints {
  /** Equipment actually on record. */
  equipment: string[]
  /** Minutes available, when the athlete said. */
  minutes?: number
  /** Exercise ids that hurt. Excluded until explicitly cleared. */
  painFlagged: string[]
  /** Muscle → hard sets in the recent window. */
  recentMuscleVolume: Record<string, number>
  /** The only exercises the model may choose from. */
  known: KnownExercise[]
}

export interface PlannedExercise {
  id: string
  name: string
  kind: SetKind
  sets: number
  reps: number
  weight: number
  rest: number
  perSide: boolean
  assisted: boolean
  repRange: [number, number] | null
  muscles: string[]
  equipment: string
  /** Sessions on record, used when deciding what to cut. */
  sessions: number
}

export interface PlanResult {
  ok: boolean
  exercises: PlannedExercise[]
  /** What was rejected and why — diagnosable, not silent. */
  violations: string[]
  source: 'model' | 'template'
}

/** Work plus rest across every prescribed set. */
export function estimateMinutes(exercises: Array<{ sets: number; rest: number }>): number {
  const seconds = (exercises || []).reduce(
    (total, e) => total + (e.sets || 0) * (SECONDS_PER_SET + (e.rest || 0)),
    0,
  )
  return Math.round((seconds / 60) * 10) / 10
}

function equipmentAllowed(equipment: string, allowed: string[]): boolean {
  const want = String(equipment || '').toLowerCase()
  if (ALWAYS_AVAILABLE.includes(want)) return true
  return (allowed || []).some((have) => String(have).toLowerCase() === want)
}

/** Turns one known exercise plus the model's numbers into a planned entry. */
function planned(def: KnownExercise, raw: Record<string, unknown>): PlannedExercise {
  /* The same validator a typed exercise goes through — one entry point, so
     a generated lift cannot arrive shaped differently from a classified
     one. The KIND is taken from the library, never from the model: the
     library knows a plank is measured in seconds and the model is guessing. */
  const c = normalizeClassification({
    tier: raw.tier,
    startingSets: raw.sets ?? def.sets,
    startingReps: raw.reps ?? def.reps,
    startingKg: raw.weight ?? def.weight,
    restSeconds: raw.rest ?? def.rest,
    defaultSetKind: def.kind,
    perSide: def.perSide === true,
    assisted: def.assisted === true,
  })
  return {
    id: def.id,
    name: def.name,
    kind: def.kind || DEFAULT_SET_KIND,
    sets: c.sets,
    reps: c.reps,
    weight: c.weight,
    rest: c.rest,
    perSide: c.perSide,
    assisted: c.assisted,
    repRange: def.repRange ?? c.repRange,
    muscles: def.muscles || [],
    equipment: def.equipment || '',
    sessions: def.sessions || 0,
  }
}

/** Finds the known exercise a model entry refers to, by id or exact name. */
function resolve(raw: unknown, known: KnownExercise[]): { def: KnownExercise | null; label: string } {
  if (!raw || typeof raw !== 'object') return { def: null, label: String(raw) }
  const entry = raw as Record<string, unknown>
  const id = typeof entry.id === 'string' ? entry.id : ''
  const name = typeof entry.name === 'string' ? entry.name : ''
  const byId = known.find((k) => k.id === id)
  if (byId) return { def: byId, label: id }
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const byName = name ? known.find((k) => norm(k.name) === norm(name)) : undefined
  return { def: byName || null, label: id || name || 'unnamed' }
}

/**
 * Trims a plan down to every ceiling, cutting the least-established lifts
 * first. A novel movement has no baseline, no PR reference and dilutes
 * plateau detection, so when something has to go it goes before the lift
 * with two years of history behind it.
 */
function applyCaps(
  exercises: PlannedExercise[],
  constraints: PlanConstraints,
  violations: string[],
): PlannedExercise[] {
  const ordered = exercises
    .map((e, i) => ({ e, i }))
    .sort((a, b) => b.e.sessions - a.e.sessions || a.i - b.i)
    .map((o) => o.e)

  const kept: PlannedExercise[] = []
  const perMuscle: Record<string, number> = {}
  let totalSets = 0

  for (const exercise of ordered) {
    if (totalSets + exercise.sets > MAX_WORKING_SETS) {
      violations.push(`${exercise.id}: dropped, session over ${MAX_WORKING_SETS} working sets`)
      continue
    }
    const overloaded = exercise.muscles.find(
      (m) => (perMuscle[m] || 0) + exercise.sets > MAX_SETS_PER_MUSCLE,
    )
    if (overloaded) {
      violations.push(`${exercise.id}: dropped, ${overloaded} over ${MAX_SETS_PER_MUSCLE} sets`)
      continue
    }
    if (typeof constraints.minutes === 'number' && constraints.minutes > 0) {
      if (estimateMinutes([...kept, exercise]) > constraints.minutes) {
        violations.push(`${exercise.id}: dropped, session over ${constraints.minutes} minutes`)
        continue
      }
    }
    kept.push(exercise)
    totalSets += exercise.sets
    exercise.muscles.forEach((m) => {
      perMuscle[m] = (perMuscle[m] || 0) + exercise.sets
    })
  }
  // restore the order the caller asked for, minus whatever was cut
  return exercises.filter((e) => kept.includes(e))
}

/** Which exercises are permitted at all, before any numbers are considered. */
function permitted(def: KnownExercise, c: PlanConstraints, violations: string[]): boolean {
  if ((c.painFlagged || []).includes(def.id)) {
    violations.push(`${def.id}: excluded, flagged as painful`)
    return false
  }
  if (!equipmentAllowed(def.equipment, c.equipment)) {
    violations.push(`${def.id}: excluded, ${def.equipment} equipment not on record`)
    return false
  }
  const hammered = (def.muscles || []).find(
    (m) => (c.recentMuscleVolume || {})[m] >= RECENT_HEAVY_SETS,
  )
  if (hammered) {
    violations.push(`${def.id}: excluded, ${hammered} worked hard recently`)
    return false
  }
  return true
}

/**
 * A session built from the library alone, with no model involved.
 *
 * This is what the app falls back to offline, rate-limited, or without a
 * key, so it has to obey exactly the same ceilings the model is held to —
 * a fallback that quietly breaks the rules is worse than no fallback.
 */
export function templatePlan(constraints: PlanConstraints): PlanResult {
  const violations: string[] = []
  const usable = (constraints.known || [])
    .filter((def) => permitted(def, constraints, violations))
    // most-established first, id as a tiebreak so the same input always
    // produces the same session
    .sort((a, b) => b.sessions - a.sessions || a.id.localeCompare(b.id))

  const exercises = applyCaps(
    usable.slice(0, 6).map((def) => planned(def, {})),
    constraints,
    violations,
  )
  return { ok: exercises.length > 0, exercises, violations, source: 'template' }
}

/**
 * Validates a model's session against every constraint, and falls back to
 * the deterministic template when nothing usable survives.
 */
export function planSession(raw: unknown, constraints: PlanConstraints): PlanResult {
  const violations: string[] = []
  const list = Array.isArray(raw) ? raw : null
  if (!list || !list.length) {
    const fallback = templatePlan(constraints)
    return { ...fallback, violations: ['response was not a list of exercises', ...fallback.violations] }
  }

  const chosen: PlannedExercise[] = []
  const seen = new Set<string>()
  for (const entry of list) {
    const { def, label } = resolve(entry, constraints.known || [])
    if (!def) {
      violations.push(`${label}: not a known exercise`)
      continue
    }
    if (seen.has(def.id)) continue
    if (!permitted(def, constraints, violations)) continue
    seen.add(def.id)
    chosen.push(planned(def, entry as Record<string, unknown>))
  }

  const exercises = applyCaps(chosen, constraints, violations)
  if (!exercises.length) {
    const fallback = templatePlan(constraints)
    return { ...fallback, violations: [...violations, ...fallback.violations] }
  }
  return { ok: true, exercises, violations, source: 'model' }
}
