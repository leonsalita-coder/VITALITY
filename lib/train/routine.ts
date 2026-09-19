/**
 * The routine layer.
 *
 * Sessions start empty every day, so anyone following a programme retypes
 * or regenerates it constantly — friction no other logger has. It also
 * leaves progression with no rhythm to attach to: if bench lands on random
 * days, "bump after a clean session" has no cadence to bump along.
 *
 * This is deliberately NOT a periodization engine. It answers one question,
 * "today is probably push day", and then gets out of the way. Everything it
 * pre-fills is editable, and it never touches a set that has been logged.
 *
 * Routines reference canonical exercise ids rather than names, so a routine
 * survives a rename and a merge.
 *
 * Pure and DOM-free.
 */

export interface RoutineExercise {
  exerciseId: string
  sets: number
  reps: number
  repRange?: [number, number] | null
  rest: number
}

export interface Routine {
  id: string
  name: string
  exercises: RoutineExercise[]
}

/** Weekday (0 = Sunday) to routine id. Absent means a free day. */
export type RoutineAssignment = Record<number, string>

function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y, (m || 1) - 1, d || 1).getDay()
}

/**
 * The routine assigned to a date, or null.
 *
 * Null is the default and must stay cheap: with no routine set, nothing
 * pre-fills and the tile behaves exactly as it always has.
 */
export function routineForDate(
  routines: Routine[],
  assignment: RoutineAssignment,
  date: string,
): Routine | null {
  const id = (assignment || {})[weekdayOf(date)]
  if (!id) return null
  return (routines || []).find((r) => r.id === id) || null
}

/**
 * What to add to a session that is already part-built.
 *
 * Anything already present is left alone — including a lift the athlete
 * added themselves, and especially one with sets logged against it. A
 * pre-fill that clobbers work is worse than no pre-fill.
 */
export function prefillPlan(
  routine: Routine | null,
  presentIds: string[],
): RoutineExercise[] {
  if (!routine) return []
  const present = new Set(presentIds || [])
  return routine.exercises.filter((e) => !present.has(e.exerciseId))
}

/** True when a session has any logged work, and so must not be rebuilt. */
export function hasLoggedWork(session: { ex?: Array<{ log?: Array<unknown | null> }> }): boolean {
  return (session.ex || []).some((ex) => (ex.log || []).some((s) => s != null))
}

/**
 * Repoints every routine after two lifts are merged.
 *
 * Without this a routine would keep referencing an id that no longer
 * exists, and the day it names would quietly stop pre-filling — the same
 * silent-drift failure as everywhere else in this codebase.
 */
export function remapRoutines(routines: Routine[], fromId: string, intoId: string): Routine[] {
  return (routines || []).map((routine) => {
    const seen = new Set<string>()
    const exercises: RoutineExercise[] = []
    for (const exercise of routine.exercises) {
      const id = exercise.exerciseId === fromId ? intoId : exercise.exerciseId
      // a routine holding both sides of a merge collapses to one entry
      if (seen.has(id)) continue
      seen.add(id)
      exercises.push({ ...exercise, exerciseId: id })
    }
    return { ...routine, exercises }
  })
}
