import { describe, it, expect } from 'vitest'
import {
  NEAR_THRESHOLD, normalizeName, similarity, resolveExercise, slugFromName, mergeExercises,
} from '../../lib/train/identity'

describe('normalizeName', () => {
  it('collapses case, punctuation and spacing', () => {
    expect(normalizeName('  Barbell   Bench-Press!! ')).toBe('barbell bench press')
  })

  it('expands the shorthand lifters type', () => {
    expect(normalizeName('BB Bench')).toBe('barbell bench')
    expect(normalizeName('DB Row')).toBe('dumbbell row')
    expect(normalizeName('OHP')).toBe('overhead press')
    expect(normalizeName('RDL')).toBe('romanian deadlift')
  })

  it('singularizes so "curls" and "curl" are one name', () => {
    expect(normalizeName('Curls')).toBe('curl')
    expect(normalizeName('Push Ups')).toBe('push up')
  })
})

describe('the fork this exists to stop', () => {
  it('lands every spelling of the bench on one id, with no AI call', () => {
    for (const typed of ['Bench Press', 'bench', 'BB Bench', 'flat bench', 'barbell bench', 'bp']) {
      const r = resolveExercise(typed)
      expect(r.status, typed).toBe('exact')
      expect(r.match!.id, typed).toBe('bench_press')
    }
  })

  it('resolves squat, deadlift and pull-up shorthand too', () => {
    expect(resolveExercise('squat').match!.id).toBe('back_squat')
    expect(resolveExercise('DL').match!.id).toBe('deadlift')
    expect(resolveExercise('pullups').match!.id).toBe('pull_up')
  })

  it('never returns a candidate for an exact hit — nothing to ask', () => {
    expect(resolveExercise('bench').candidates).toEqual([])
  })
})

describe('near matches ask instead of forking', () => {
  it('offers the real lift for a typo', () => {
    const r = resolveExercise('barbel bench pres')
    expect(r.status).toBe('near')
    expect(r.candidates[0].id).toBe('bench_press')
    expect(r.candidates[0].score).toBeGreaterThanOrEqual(NEAR_THRESHOLD)
  })

  it('returns at most three, best first', () => {
    const r = resolveExercise('dumbell bench pres')
    if (r.status === 'near') {
      expect(r.candidates.length).toBeLessThanOrEqual(3)
      const scores = r.candidates.map((c) => c.score)
      expect(scores).toEqual([...scores].sort((a, b) => b - a))
    }
  })

  it('treats a genuinely new movement as unknown, for the classifier', () => {
    expect(resolveExercise('zercher good morning to overhead squat').status).toBe('unknown')
  })
})

describe('the athlete’s own lifts and confirmed aliases', () => {
  const opts = {
    userExercises: { taekwondo_kick: 'Taekwondo Kick Drill' },
    aliases: { 'my chest lift': 'bench_press' },
  }

  it('finds one of their own lifts by name', () => {
    const r = resolveExercise('Taekwondo Kick Drill', opts)
    expect(r.status).toBe('exact')
    expect(r.match!.source).toBe('user')
  })

  it('honours a confirmed alias, so the question is asked once', () => {
    const r = resolveExercise('my chest lift', opts)
    expect(r.status).toBe('exact')
    expect(r.match!.id).toBe('bench_press')
  })

  it('offers their own lift as a near candidate', () => {
    const r = resolveExercise('taekwondo kick dril', opts)
    expect(r.candidates.some((c) => c.id === 'taekwondo_kick')).toBe(true)
  })
})

describe('similarity scoring', () => {
  it('is 1 for the same name', () => expect(similarity('bench press', 'bench press')).toBe(1))
  it('is high across word order', () => expect(similarity('bench press incline', 'incline bench press')).toBeGreaterThan(0.9))
  it('is high for a typo', () => expect(similarity('bench pres', 'bench press')).toBeGreaterThan(0.8))
  it('is low for unrelated lifts', () => expect(similarity('bench press', 'leg curl')).toBeLessThan(0.4))
  it('does NOT pretend to score "BB Bench" against "Bench Press"', () => {
    // these are related by domain knowledge, not by their letters, which is
    // exactly why the alias table exists — scoring is for typos, and a
    // scorer stretched to cover synonyms would match unrelated lifts too
    expect(similarity('bb bench', 'Bench Press')).toBeLessThan(NEAR_THRESHOLD)
    expect(resolveExercise('BB Bench').match!.id).toBe('bench_press')
  })
})

describe('slugFromName', () => {
  it('makes a snake_case id', () => expect(slugFromName('Zercher Squat', new Set())).toBe('zercher_squat'))
  it('avoids a collision', () => expect(slugFromName('Zercher Squat', new Set(['zercher_squat']))).toBe('zercher_squat_2'))
  it('falls back when there is nothing usable', () => expect(slugFromName('!!!', new Set())).toBe('exercise'))
})

describe('merge never loses anything', () => {
  const state = () => ({
    history: {
      bench_press: [
        { date: '2026-09-01', kg: 175, sets: [{ w: 175, r: 5 }] },
        { date: '2026-09-08', kg: 180, sets: [{ w: 180, r: 5 }] },
      ],
      bb_bench: [
        { date: '2026-09-08', kg: 185, sets: [{ w: 185, r: 3 }] },
        { date: '2026-09-15', kg: 185, sets: [{ w: 185, r: 5 }, { w: 185, r: 4 }] },
      ],
    },
    exerciseNames: { bench_press: 'Bench Press', bb_bench: 'BB Bench' },
    customLib: { bench_press: { equipment: 'Barbell' }, bb_bench: { equipment: 'Barbell', kind: 'reps_weight' } },
    aliases: { 'bb bench press': 'bb_bench' },
    deloadStates: { bb_bench: { state: 'deloading' } },
    painFlagged: ['bb_bench'],
    liftGoals: [{ id: 'bb_bench', target: 225 }],
    session: { ex: [{ id: 'bb_bench', name: 'BB Bench' }] },
  })

  it('moves every session onto the winner', () => {
    const out = mergeExercises(state(), 'bb_bench', 'bench_press')
    expect(out.state.history!.bb_bench).toBeUndefined()
    expect(out.state.history!.bench_press).toHaveLength(3) // 09-08 folded into one
    expect(out.moved).toBe(2)
  })

  it('loses NOT ONE set', () => {
    const before = state()
    const countSets = (h: Record<string, unknown[]>) =>
      Object.values(h).flat().reduce((n, e) => n + ((e as any).sets?.length || 0), 0)
    const out = mergeExercises(before, 'bb_bench', 'bench_press')
    expect(countSets(out.state.history as never)).toBe(countSets(state().history as never))
  })

  it('keeps every date', () => {
    const out = mergeExercises(state(), 'bb_bench', 'bench_press')
    const dates = out.state.history!.bench_press.map((e: any) => e.date)
    expect(dates).toEqual(['2026-09-01', '2026-09-08', '2026-09-15'])
  })

  it('combines two sessions logged on the same day', () => {
    const out = mergeExercises(state(), 'bb_bench', 'bench_press')
    const sep8 = out.state.history!.bench_press.find((e: any) => e.date === '2026-09-08') as any
    expect(sep8.sets).toHaveLength(2)
    expect(sep8.kg).toBe(185) // the heavier record survives
  })

  it('repoints the live session', () => {
    const out = mergeExercises(state(), 'bb_bench', 'bench_press')
    expect(out.state.session!.ex![0].id).toBe('bench_press')
    expect(out.state.session!.ex![0].name).toBe('Bench Press')
  })

  it('carries aliases, the deload record, the pain flag and the goal across', () => {
    const out = mergeExercises(state(), 'bb_bench', 'bench_press')
    expect(out.state.aliases!['bb bench press']).toBe('bench_press')
    expect(out.state.aliases!['barbell bench']).toBe('bench_press') // the losing name itself
    expect(out.state.deloadStates!.bench_press).toBeDefined()
    expect(out.state.painFlagged).toEqual(['bench_press'])
    expect((out.state.liftGoals as any)[0].id).toBe('bench_press')
  })

  it('does not mutate the state it was handed', () => {
    const before = state()
    const snapshot = JSON.stringify(before)
    mergeExercises(before, 'bb_bench', 'bench_press')
    expect(JSON.stringify(before)).toBe(snapshot)
  })

  it('refuses to merge a lift into itself', () => {
    expect(() => mergeExercises(state(), 'bb_bench', 'bb_bench')).toThrow()
  })
})
