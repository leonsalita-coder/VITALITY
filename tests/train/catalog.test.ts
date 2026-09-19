import { describe, it, expect } from 'vitest'
import { CATALOG, CATALOG_BY_ID, catalogExercise } from '../../lib/train/catalog'
import { MUSCLES, muscleSplitFrom, distribute } from '../../lib/train/muscles'
import { SET_KINDS } from '../../lib/train/classify'

describe('catalog integrity', () => {
  it('covers the training this app is actually for', () => {
    expect(CATALOG.length).toBeGreaterThanOrEqual(35)
    for (const id of ['back_squat', 'deadlift', 'bench_press', 'pull_up', 'plank', 'sprint', 'box_jump']) {
      expect(CATALOG_BY_ID[id], `${id} missing`).toBeDefined()
    }
  })

  it('has unique ids', () => {
    const ids = CATALOG.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('has no alias colliding with another lift’s id, name or alias', () => {
    const owner = new Map<string, string>()
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    for (const e of CATALOG) {
      for (const form of [e.id, e.name, ...e.aliases]) {
        const key = norm(form)
        expect(owner.has(key) && owner.get(key) !== e.id, `"${form}" claimed by ${owner.get(key)} and ${e.id}`).toBe(false)
        owner.set(key, e.id)
      }
    }
  })

  it('only references muscles on the closed list', () => {
    for (const e of CATALOG) {
      for (const c of [...e.primary, ...e.secondary]) {
        expect(MUSCLES, `${e.id} -> ${c.muscle}`).toContain(c.muscle)
      }
    }
  })

  it('has contribution weights that sum to one', () => {
    for (const e of CATALOG) {
      const sum = e.primary.reduce((n, c) => n + c.share, 0)
      expect(sum, `${e.id} sums to ${sum}`).toBeCloseTo(1, 5)
    }
  })

  it('weights the prime mover heaviest — a bench is mostly chest', () => {
    const bench = CATALOG_BY_ID.bench_press
    const chest = bench.primary.find((c) => c.muscle === 'chest')!
    expect(chest.share).toBeGreaterThan(0.5)
    for (const other of bench.primary.filter((c) => c.muscle !== 'chest')) {
      expect(other.share).toBeLessThan(chest.share)
    }
  })

  it('uses a real set kind on every entry', () => {
    for (const e of CATALOG) expect(SET_KINDS).toContain(e.defaultSetKind)
  })

  it('never claims e1RM applies to a movement with no load in reps', () => {
    for (const e of CATALOG) {
      if (e.defaultSetKind !== 'reps_weight') expect(e.e1rmValid, e.id).toBe(false)
    }
  })

  it('gives every entry a real increment', () => {
    for (const e of CATALOG) expect(e.incrementLb).toBeGreaterThan(0)
  })

  it('marks the unilateral movements', () => {
    expect(CATALOG_BY_ID.bulgarian_split_squat.unilateral).toBe(true)
    expect(CATALOG_BY_ID.back_squat.unilateral).toBe(false)
  })
})

describe('this is what makes estimated mean something', () => {
  it('reports a catalog lift as NOT estimated, through the real split path', () => {
    const split = muscleSplitFrom(CATALOG_BY_ID.bench_press)
    expect(split.estimated).toBe(false)
    expect(split.unmapped).toEqual([])
  })

  it('keeps a classifier-derived lift estimated', () => {
    expect(muscleSplitFrom({ primary: ['Chest', 'Triceps'] }).estimated).toBe(true)
  })

  it('carries the authored weights all the way through distribution', () => {
    const split = muscleSplitFrom(CATALOG_BY_ID.bench_press)
    const spread = distribute(10, split)
    expect(spread.chest).toBeCloseTo(7)
    expect(spread.triceps).toBeCloseTo(1.5)
    expect(spread.front_delts).toBeCloseTo(1.5)
  })

  it('is NOT an even split, which is the whole point', () => {
    const spread = distribute(10, muscleSplitFrom(CATALOG_BY_ID.bench_press))
    expect(spread.chest).not.toBeCloseTo(spread.triceps!)
  })
})

describe('catalogExercise', () => {
  it('finds a lift by id', () => {
    expect(catalogExercise('deadlift')?.name).toBe('Deadlift')
  })

  it('returns null for an unknown id', () => {
    expect(catalogExercise('nope')).toBeNull()
  })
})
