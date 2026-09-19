import { describe, it, expect } from 'vitest'
import {
  MAX_WORKING_SETS,
  MAX_SETS_PER_MUSCLE,
  RECENT_HEAVY_SETS,
  estimateMinutes,
  templatePlan,
  planSession,
} from '../../lib/train/plan'
import type { KnownExercise, PlanConstraints } from '../../lib/train/plan'

const known = (over: Partial<KnownExercise> = {}): KnownExercise => ({
  id: 'squat',
  name: 'Back Squat',
  equipment: 'barbell',
  muscles: ['quads'],
  kind: 'reps_weight',
  sessions: 5,
  sets: 3,
  reps: 5,
  weight: 185,
  rest: 180,
  ...over,
})

const LIBRARY: KnownExercise[] = [
  known({ id: 'squat', name: 'Back Squat', muscles: ['quads'], sessions: 12 }),
  known({ id: 'bench', name: 'Bench Press', muscles: ['chest'], sessions: 9 }),
  known({ id: 'row', name: 'Barbell Row', muscles: ['back'], sessions: 4 }),
  known({ id: 'curl', name: 'Dumbbell Curl', equipment: 'dumbbell', muscles: ['biceps'], sessions: 0 }),
  known({ id: 'pushup', name: 'Push-Up', equipment: 'bodyweight', muscles: ['chest'], kind: 'reps_only', sessions: 2, weight: 0 }),
  known({ id: 'plank', name: 'Plank', equipment: 'bodyweight', muscles: ['abs'], kind: 'time', sessions: 3, weight: 0 }),
]

const constraints = (over: Partial<PlanConstraints> = {}): PlanConstraints => ({
  equipment: ['barbell', 'dumbbell', 'bodyweight'],
  minutes: 60,
  painFlagged: [],
  recentMuscleVolume: {},
  known: LIBRARY,
  ...over,
})

const modelPlan = (ids: string[], over: Record<string, unknown> = {}) =>
  ids.map((id) => ({ id, sets: 3, reps: 5, ...over }))

describe('the model may only choose from known exercises', () => {
  it('accepts a plan built from ids on the list', () => {
    const r = planSession(modelPlan(['squat', 'bench']), constraints())
    expect(r.ok).toBe(true)
    expect(r.source).toBe('model')
    expect(r.exercises.map((e) => e.id)).toEqual(['squat', 'bench'])
  })

  it('drops an exercise it invented', () => {
    const r = planSession(modelPlan(['squat', 'zercher_jump_snatch']), constraints())
    expect(r.exercises.map((e) => e.id)).toEqual(['squat'])
    expect(r.violations.join(' ')).toContain('zercher_jump_snatch')
  })

  it('never lets free text in through the name field', () => {
    const r = planSession([{ name: 'Some Invented Lift', sets: 3, reps: 5 }], constraints())
    expect(r.source).toBe('template')
  })

  it('matches a known exercise by exact name as well as id', () => {
    const r = planSession([{ name: 'Bench Press', sets: 3, reps: 5 }], constraints())
    expect(r.exercises.map((e) => e.id)).toEqual(['bench'])
  })
})

describe('equipment on record', () => {
  it('drops a barbell lift in a hotel room', () => {
    const r = planSession(modelPlan(['squat', 'pushup', 'plank']), constraints({ equipment: ['bodyweight'] }))
    expect(r.exercises.map((e) => e.id)).toEqual(['pushup', 'plank'])
    expect(r.violations.join(' ')).toMatch(/equipment/i)
  })

  it('falls back to a template when nothing survives', () => {
    const r = planSession(modelPlan(['squat', 'bench']), constraints({ equipment: ['bodyweight'] }))
    expect(r.source).toBe('template')
    expect(r.exercises.every((e) => e.equipment === 'bodyweight')).toBe(true)
  })

  it('always allows bodyweight, which needs nothing', () => {
    const r = planSession(modelPlan(['pushup']), constraints({ equipment: [] }))
    expect(r.exercises.map((e) => e.id)).toEqual(['pushup'])
  })
})

describe('pain flags are remembered, not re-suggested', () => {
  it('excludes a flagged movement from a generated plan', () => {
    const r = planSession(modelPlan(['squat', 'bench']), constraints({ painFlagged: ['squat'] }))
    expect(r.exercises.map((e) => e.id)).toEqual(['bench'])
    expect(r.violations.join(' ')).toMatch(/pain/i)
  })

  it('excludes it from the deterministic template too — the fallback must not reintroduce it', () => {
    const r = templatePlan(constraints({ painFlagged: ['squat', 'bench', 'row'] }))
    expect(r.exercises.map((e) => e.id)).not.toContain('squat')
    expect(r.exercises.map((e) => e.id)).not.toContain('bench')
  })

  it('stays excluded until cleared, however many times it is asked for', () => {
    const c = constraints({ painFlagged: ['squat'] })
    for (let i = 0; i < 3; i++) {
      expect(planSession(modelPlan(['squat']), c).exercises.map((e) => e.id)).not.toContain('squat')
    }
    const cleared = constraints({ painFlagged: [] })
    expect(planSession(modelPlan(['squat']), cleared).exercises.map((e) => e.id)).toContain('squat')
  })
})

describe('recent volume', () => {
  it('does not program a muscle hard two days running', () => {
    const r = planSession(
      modelPlan(['squat', 'bench']),
      constraints({ recentMuscleVolume: { quads: RECENT_HEAVY_SETS } }),
    )
    expect(r.exercises.map((e) => e.id)).toEqual(['bench'])
    expect(r.violations.join(' ')).toMatch(/recent/i)
  })

  it('leaves a lightly worked muscle alone', () => {
    const r = planSession(
      modelPlan(['squat']),
      constraints({ recentMuscleVolume: { quads: RECENT_HEAVY_SETS - 1 } }),
    )
    expect(r.exercises.map((e) => e.id)).toEqual(['squat'])
  })
})

describe('hard caps the model cannot exceed', () => {
  it('trims a session past the total working-set ceiling', () => {
    const greedy = LIBRARY.map((e) => ({ id: e.id, sets: 10, reps: 5 }))
    const r = planSession(greedy, constraints())
    const total = r.exercises.reduce((n, e) => n + e.sets, 0)
    expect(total).toBeLessThanOrEqual(MAX_WORKING_SETS)
  })

  it('trims a single muscle worked past its ceiling', () => {
    const chestOnly = [
      { id: 'bench', sets: 8, reps: 5 },
      { id: 'pushup', sets: 8, reps: 15 },
    ]
    const r = planSession(chestOnly, constraints())
    const chestSets = r.exercises
      .filter((e) => e.muscles.includes('chest'))
      .reduce((n, e) => n + e.sets, 0)
    expect(chestSets).toBeLessThanOrEqual(MAX_SETS_PER_MUSCLE)
  })

  it('respects a stated time budget', () => {
    const r = planSession(LIBRARY.map((e) => ({ id: e.id, sets: 5, reps: 5 })), constraints({ minutes: 20 }))
    expect(estimateMinutes(r.exercises)).toBeLessThanOrEqual(20)
  })

  it('keeps the lifts with history when it has to cut', () => {
    const r = planSession(
      [{ id: 'curl', sets: 5, reps: 10 }, { id: 'squat', sets: 5, reps: 5 }],
      constraints({ minutes: 12 }),
    )
    // squat has 12 sessions of history, curl has none
    expect(r.exercises.map((e) => e.id)).toContain('squat')
  })

  it('reports what it cut rather than silently shrinking the session', () => {
    const r = planSession(LIBRARY.map((e) => ({ id: e.id, sets: 9, reps: 5 })), constraints({ minutes: 15 }))
    expect(r.violations.length).toBeGreaterThan(0)
  })
})

describe('malformed responses', () => {
  const junk = [null, undefined, 'a workout', 42, {}, { exercises: 'lots' }, []]

  it('falls back to a template on anything unusable', () => {
    for (const bad of junk) {
      const r = planSession(bad, constraints())
      expect(r.source).toBe('template')
      expect(r.ok).toBe(true)
      expect(r.exercises.length).toBeGreaterThan(0)
    }
  })

  it('survives entries that are not objects', () => {
    const r = planSession(['squat', null, 7], constraints())
    expect(r.ok).toBe(true)
  })

  it('clamps absurd set and rep counts rather than storing them', () => {
    const r = planSession([{ id: 'squat', sets: 999, reps: -4 }], constraints())
    expect(r.exercises[0].sets).toBeLessThanOrEqual(8)
    expect(r.exercises[0].reps).toBeGreaterThanOrEqual(1)
  })
})

describe('the deterministic fallback', () => {
  it('produces a usable session with no model involved at all', () => {
    const r = templatePlan(constraints())
    expect(r.ok).toBe(true)
    expect(r.exercises.length).toBeGreaterThan(0)
    expect(r.source).toBe('template')
  })

  it('is deterministic — the same constraints give the same session', () => {
    const a = templatePlan(constraints())
    const b = templatePlan(constraints())
    expect(a.exercises.map((e) => e.id)).toEqual(b.exercises.map((e) => e.id))
  })

  it('prefers the lifts with the most history', () => {
    const r = templatePlan(constraints())
    expect(r.exercises[0].id).toBe('squat') // 12 sessions, the most on record
  })

  it('obeys the same caps it enforces on the model', () => {
    const r = templatePlan(constraints({ minutes: 20 }))
    expect(estimateMinutes(r.exercises)).toBeLessThanOrEqual(20)
    expect(r.exercises.reduce((n, e) => n + e.sets, 0)).toBeLessThanOrEqual(MAX_WORKING_SETS)
  })

  it('returns an honest empty plan when nothing at all is permitted', () => {
    const r = templatePlan(constraints({ known: [] }))
    expect(r.ok).toBe(false)
    expect(r.exercises).toEqual([])
  })
})

describe('every planned exercise is fully specified', () => {
  it('carries the kind, flags and numbers the tile needs to write it', () => {
    const r = planSession(modelPlan(['plank', 'squat']), constraints())
    for (const e of r.exercises) {
      expect(e.id).toBeTruthy()
      expect(e.name).toBeTruthy()
      expect(e.kind).toBeTruthy()
      expect(Number.isFinite(e.sets)).toBe(true)
      expect(Number.isFinite(e.reps)).toBe(true)
      expect(Number.isFinite(e.weight)).toBe(true)
      expect(Number.isFinite(e.rest)).toBe(true)
      expect(typeof e.perSide).toBe('boolean')
      expect(typeof e.assisted).toBe('boolean')
    }
  })

  it('takes the kind from the library, never from the model', () => {
    const r = planSession([{ id: 'plank', sets: 3, reps: 5, defaultSetKind: 'reps_weight' }], constraints())
    expect(r.exercises[0].kind).toBe('time')
  })
})

describe('estimateMinutes', () => {
  it('counts work and rest across every set', () => {
    const one = [{ sets: 3, rest: 60 } as never]
    expect(estimateMinutes(one)).toBeGreaterThan(3)
  })

  it('is zero for an empty session', () => {
    expect(estimateMinutes([])).toBe(0)
  })
})
