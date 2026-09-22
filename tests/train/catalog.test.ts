import { describe, it, expect } from 'vitest'
import { CATALOG, CATALOG_BY_ID, catalogExercise } from '../../lib/train/catalog'
import { MUSCLES, muscleSplitFrom, distribute } from '../../lib/train/muscles'
import { SET_KINDS } from '../../lib/train/classify'
import { loadableWeights, defaultPlateConfig, DEFAULT_BAR_LB } from '../../lib/train/plates'

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
    // compared the way resolution compares them, so a collision that only
    // appears under token-set matching cannot hide
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').sort().join(' ')
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

/**
 * Invariants, because pinning values proves nothing here.
 *
 * Mutation-testing an authored data table is vacuous by default: a test
 * asserting bench is 0.7 chest passes whether or not 0.7 is right, and
 * six flipped booleans survived a sweep of this file for exactly that
 * reason — `e1rmValid` was checked in one direction only, and
 * `unilateral` was pinned by two examples out of sixty.
 *
 * These assert properties a wrong value breaks. The catalog is upstream
 * of progression and of muscle volume, and its values are authored, so
 * nothing else in the system would ever notice them being wrong.
 */
describe('the catalog holds together as data', () => {
  it('claims e1RM on the lifts it is meaningful for', () => {
    /* The missing half. "Never claims e1RM where it is meaningless" is
       satisfied completely by claiming it nowhere — which is what
       flipping one default did, silently, across the whole table. */
    /* Compound only. An Epley estimate off a barbell curl is not a
       one-rep max, it is a number — which is why the table marks
       isolation work invalid on purpose. */
    const loaded = CATALOG.filter((e) =>
      e.loading === 'barbell' && e.defaultSetKind === 'reps_weight'
      && !e.unilateral && e.pattern !== 'isolation')
    expect(loaded.length).toBeGreaterThan(8)
    for (const e of loaded) expect(e.e1rmValid, `${e.id} should support e1RM`).toBe(true)
  })

  it('knows exactly which movements are one limb at a time', () => {
    /* A census, not two examples. Any entry flipping in either
       direction changes this set, and `unilateral` is what becomes
       perSide on a swapped-in lift — get it wrong and every rep is
       counted twice, or half of them vanish. */
    const actual = CATALOG.filter((e) => e.unilateral).map((e) => e.id).sort()
    expect(actual).toEqual([
      'bulgarian_split_squat', 'cable_woodchop', 'dumbbell_row',
      'side_plank', 'step_up', 'walking_lunge',
    ])
  })

  it('treats every lunge as unilateral, because that is what a lunge is', () => {
    /* Structural rather than authored: you cannot do a lunge on both
       legs at once, so this one cannot drift with taste. */
    for (const e of CATALOG.filter((e) => e.pattern === 'lunge')) {
      expect(e.unilateral, `${e.id} is a lunge but marked bilateral`).toBe(true)
    }
  })

  it('never marks a loaded barbell lift unilateral', () => {
    for (const e of CATALOG.filter((e) => e.equipment === 'barbell')) {
      expect(e.unilateral, `${e.id} is a barbell lift marked unilateral`).toBe(false)
    }
  })

  it('increments by an amount the bar can actually be loaded to', () => {
    /* The invariant that ties this table to the rack. A barbell lift
       incrementing by 2.5 lb asks for a 1.25 lb pair that the default
       room does not have, so the suggestion would snap straight back
       and the lift would never progress. */
    const rack = loadableWeights(defaultPlateConfig(), 400)
    for (const e of CATALOG.filter((x) => x.loading === 'barbell')) {
      expect(rack, `${e.id} increments by an unloadable ${e.incrementLb}`)
        .toContain(DEFAULT_BAR_LB + e.incrementLb)
    }
  })

  it('gives each entry a coherent muscle split', () => {
    for (const e of CATALOG) {
      const seen = new Set<string>()
      for (const c of e.primary) {
        expect(c.share, `${e.id} has a non-positive share`).toBeGreaterThan(0)
        expect(seen.has(c.muscle), `${e.id} lists ${c.muscle} twice`).toBe(false)
        seen.add(c.muscle)
      }
    }
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
