import { describe, it, expect } from 'vitest'
import {
  routineForDate, prefillPlan, hasLoggedWork, remapRoutines,
} from '../../lib/train/routine'
import type { Routine } from '../../lib/train/routine'
import { mergeExercises } from '../../lib/train/identity'

const push: Routine = {
  id: 'push', name: 'Push',
  exercises: [
    { exerciseId: 'bench_press', sets: 3, reps: 5, repRange: [5, 8], rest: 180 },
    { exerciseId: 'overhead_press', sets: 3, reps: 8, rest: 120 },
  ],
}
const pull: Routine = {
  id: 'pull', name: 'Pull',
  exercises: [{ exerciseId: 'barbell_row', sets: 3, reps: 8, rest: 120 }],
}
const routines = [push, pull]
// 2026-09-21 is a Monday
const assignment = { 1: 'push', 3: 'pull' }

describe('assignment picks the right day', () => {
  it('pre-fills Monday from the push routine', () => {
    expect(routineForDate(routines, assignment, '2026-09-21')!.id).toBe('push')
  })

  it('pre-fills Wednesday from the pull routine', () => {
    expect(routineForDate(routines, assignment, '2026-09-23')!.id).toBe('pull')
  })

  it('leaves an unassigned day free', () => {
    expect(routineForDate(routines, assignment, '2026-09-22')).toBeNull()
  })

  it('returns null with no routines at all — nothing changes for anyone', () => {
    expect(routineForDate([], {}, '2026-09-21')).toBeNull()
    expect(prefillPlan(null, [])).toEqual([])
  })

  it('returns null when the assignment points at a routine that is gone', () => {
    expect(routineForDate(routines, { 1: 'deleted' }, '2026-09-21')).toBeNull()
  })
})

describe('an edited session is never clobbered', () => {
  it('skips a lift already in the session', () => {
    const plan = prefillPlan(push, ['bench_press'])
    expect(plan.map((e) => e.exerciseId)).toEqual(['overhead_press'])
  })

  it('adds nothing when everything is already there', () => {
    expect(prefillPlan(push, ['bench_press', 'overhead_press'])).toEqual([])
  })

  it('leaves a lift the athlete added themselves alone', () => {
    const plan = prefillPlan(push, ['some_custom_lift'])
    expect(plan.map((e) => e.exerciseId)).toEqual(['bench_press', 'overhead_press'])
    expect(plan.map((e) => e.exerciseId)).not.toContain('some_custom_lift')
  })

  it('knows when a session has work that must not be rebuilt', () => {
    expect(hasLoggedWork({ ex: [{ log: [null, null] }] })).toBe(false)
    expect(hasLoggedWork({ ex: [{ log: [{ w: 185, r: 5 }, null] }] })).toBe(true)
    expect(hasLoggedWork({ ex: [] })).toBe(false)
  })

  it('carries the routine’s own sets, reps, range and rest', () => {
    const plan = prefillPlan(push, [])
    expect(plan[0]).toMatchObject({ sets: 3, reps: 5, repRange: [5, 8], rest: 180 })
  })
})

describe('a routine survives a merge', () => {
  it('repoints to the surviving id', () => {
    const out = remapRoutines(routines, 'bench_press', 'incline_bench_press')
    expect(out[0].exercises[0].exerciseId).toBe('incline_bench_press')
  })

  it('collapses a routine that held both sides of the merge', () => {
    const both: Routine = {
      id: 'both', name: 'Both',
      exercises: [
        { exerciseId: 'bench_press', sets: 3, reps: 5, rest: 180 },
        { exerciseId: 'bb_bench', sets: 4, reps: 8, rest: 120 },
      ],
    }
    const out = remapRoutines([both], 'bb_bench', 'bench_press')
    expect(out[0].exercises).toHaveLength(1)
    expect(out[0].exercises[0].exerciseId).toBe('bench_press')
  })

  it('leaves untouched routines alone', () => {
    const out = remapRoutines(routines, 'bench_press', 'incline_bench_press')
    expect(out[1]).toEqual(pull)
  })

  it('still pre-fills the right day after the merge', () => {
    const merged = mergeExercises(
      {
        history: { bb_bench: [{ date: '2026-09-01', kg: 185, sets: [{ w: 185, r: 5 }] }] },
        exerciseNames: { bench_press: 'Bench Press', bb_bench: 'BB Bench' },
      },
      'bb_bench', 'bench_press',
    )
    const withBoth = [{ ...push, exercises: [{ exerciseId: 'bb_bench', sets: 3, reps: 5, rest: 180 }] }]
    const remapped = remapRoutines(withBoth, 'bb_bench', 'bench_press')
    expect(routineForDate(remapped, assignment, '2026-09-21')!.exercises[0].exerciseId).toBe('bench_press')
    expect(merged.state.history!.bench_press).toHaveLength(1)
  })
})
