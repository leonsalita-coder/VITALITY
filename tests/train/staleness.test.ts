import { describe, it, expect } from 'vitest'
import { stalenessFor, STALE_WEEKS, type StalenessContext } from '../../lib/train/staleness'
import { CATALOG } from '../../lib/train/catalog'

/**
 * "You've run the same eight lifts for fourteen weeks."
 *
 * Trivially computable, and nobody notices it about their own training.
 *
 * THE CONSTRAINT THAT MAKES IT USEFUL RATHER THAN NAGGING: an unchanged
 * routine that is still producing progress is not a problem. Staleness is
 * only ever reported ALONGSIDE a stall — otherwise the app is telling
 * somebody whose lifts are climbing to change something that is working,
 * which is the most expensive kind of wrong advice.
 *
 * And a complaint with no option attached is noise, so when it fires it
 * names specific alternatives that keep the movement and the muscles.
 */

const day = (back: number) => {
  const d = new Date(2026, 8, 19 - back)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const NOW = new Date(2026, 8, 19, 12).getTime()

/** Weekly sessions going back `weeks`, at a weight given per week. */
const runFor = (weeks: number, weightAt: (w: number) => number) =>
  Array.from({ length: weeks }, (_, i) => {
    const back = (weeks - 1 - i) * 7
    const w = weightAt(i)
    return { date: day(back), kg: w, sets: [{ w, r: 5 }, { w, r: 5 }, { w, r: 5 }] }
  })

const flat = (weeks: number) => runFor(weeks, () => 200)
const climbing = (weeks: number) => runFor(weeks, (i) => 200 + i * 5)

const ctx = (over: Partial<StalenessContext> = {}): StalenessContext => ({
  history: {}, customLib: {}, equipment: ['barbell', 'dumbbell', 'bodyweight'],
  now: NOW, ...over,
})

describe('a stale but progressing routine says nothing', () => {
  it('stays silent when the lift is still climbing', () => {
    expect(stalenessFor(ctx({
      history: { back_squat: climbing(STALE_WEEKS + 4) },
      customLib: { back_squat: { equipment: 'barbell', kind: 'reps_weight' } },
    }))).toBeNull()
  })

  it('stays silent even after a very long unchanged run, while it works', () => {
    const lib = { back_squat: { equipment: 'barbell', kind: 'reps_weight' } }
    /* Control: the SAME thirty-week run, flat instead of climbing, does
       fire. Without it, an empty answer here would be identical to
       runFor() having built nothing. */
    expect(stalenessFor(ctx({ history: { back_squat: flat(30) }, customLib: lib }))).not.toBeNull()
    expect(stalenessFor(ctx({ history: { back_squat: climbing(30) }, customLib: lib }))).toBeNull()
  })
})

describe('a stale AND stalled lift produces the finding', () => {
  const stalled = ctx({
    history: { back_squat: flat(STALE_WEEKS + 4) },
    customLib: { back_squat: { equipment: 'barbell', kind: 'reps_weight' } },
  })

  it('reports it', () => {
    const found = stalenessFor(stalled)
    expect(found).not.toBeNull()
    expect(found!.exerciseId).toBe('back_squat')
  })

  it('says how long it has been unchanged', () => {
    const found = stalenessFor(stalled)!
    expect(found.weeks).toBeGreaterThanOrEqual(STALE_WEEKS)
    expect(found.text).toMatch(new RegExp(String(found.weeks)))
  })

  it('names specific alternatives', () => {
    const found = stalenessFor(stalled)!
    expect(found.candidates.length).toBeGreaterThan(0)
    expect(found.text).toMatch(new RegExp(found.candidates[0].name))
  })

  it('offers alternatives that keep the movement and the muscles', () => {
    const found = stalenessFor(stalled)!
    const squat = CATALOG.find((c) => c.id === 'back_squat')!
    for (const candidate of found.candidates) {
      const def = CATALOG.find((c) => c.id === candidate.id)!
      const sharesPattern = def.pattern === squat.pattern
      const sharesMuscle = def.primary.some((p) =>
        squat.primary.some((q) => q.muscle === p.muscle))
      expect(sharesPattern || sharesMuscle, `${candidate.id} is unrelated`).toBe(true)
    }
  })

  it('never offers the lift it is complaining about', () => {
    const found = stalenessFor(stalled)!
    expect(found.candidates.map((c) => c.id)).not.toContain('back_squat')
  })

  it('offers only equipment that is available', () => {
    const found = stalenessFor(ctx({
      history: { back_squat: flat(STALE_WEEKS + 4) },
      customLib: { back_squat: { equipment: 'barbell', kind: 'reps_weight' } },
      equipment: ['dumbbell', 'bodyweight'],
    }))!
    expect(found.candidates.every((c) => c.equipment !== 'barbell')).toBe(true)
  })
})

describe('a recently changed routine never fires', () => {
  it('stays silent on a short run, stalled or not', () => {
    expect(stalenessFor(ctx({
      history: { back_squat: flat(STALE_WEEKS - 2) },
      customLib: { back_squat: { equipment: 'barbell', kind: 'reps_weight' } },
    }))).toBeNull()
  })

  it('stays silent when the lift was introduced recently', () => {
    /* Fourteen weeks of history, but this lift has only been in the
       rotation for three of them. */
    const lib = { back_squat: { equipment: 'barbell', kind: 'reps_weight' } }
    const full = flat(STALE_WEEKS + 4)
    const recent = full.slice(-3)
    // control: the full run fires; only the truncation silences it
    expect(stalenessFor(ctx({ history: { back_squat: full }, customLib: lib }))).not.toBeNull()
    expect(stalenessFor(ctx({ history: { back_squat: recent }, customLib: lib }))).toBeNull()
  })

  it('resets when the exercise SET changed, even if one lift is old', () => {
    /* The old lift has been there forever; a new one arrived last week,
       so the routine as a whole is not stale. */
    const lib = {
      back_squat: { equipment: 'barbell', kind: 'reps_weight' },
      front_squat: { equipment: 'barbell', kind: 'reps_weight' },
    }
    // control: the old lift alone DOES fire; the new arrival is what silences it
    expect(stalenessFor(ctx({
      history: { back_squat: flat(STALE_WEEKS + 4) }, customLib: lib,
    }))).not.toBeNull()
    expect(stalenessFor(ctx({
      history: { back_squat: flat(STALE_WEEKS + 4), front_squat: flat(1) }, customLib: lib,
    }))).toBeNull()
  })
})

describe('the gate is weeks, not sessions', () => {
  it('ignores a lift trained many times in a short span', () => {
    /* Twenty sessions inside two weeks is not a stale routine, it is a
       busy fortnight. */
    const dense = Array.from({ length: 20 }, (_, i) => ({
      date: day(13 - Math.floor(i * 13 / 20)), kg: 200,
      sets: [{ w: 200, r: 5 }],
    }))
    const lib = { back_squat: { equipment: 'barbell', kind: 'reps_weight' } }
    /* Control: FEWER sessions spread over a long span do fire — so what
       silences this is the span, not the session count or an empty
       fixture. That is the whole distinction the test is named for. */
    expect(stalenessFor(ctx({
      history: { back_squat: flat(STALE_WEEKS + 4) }, customLib: lib,
    }))).not.toBeNull()
    expect(dense.length).toBeGreaterThan(flat(STALE_WEEKS + 4).length)
    expect(stalenessFor(ctx({ history: { back_squat: dense }, customLib: lib }))).toBeNull()
  })
})

describe('it is one finding, deterministically', () => {
  const many = ctx({
    history: { back_squat: flat(STALE_WEEKS + 4), bench_press: flat(STALE_WEEKS + 6) },
    customLib: {
      back_squat: { equipment: 'barbell', kind: 'reps_weight' },
      bench_press: { equipment: 'barbell', kind: 'reps_weight' },
    },
  })

  it('returns a single finding, not a list', () => {
    const found = stalenessFor(many)
    expect(found).not.toBeNull()
    expect(Array.isArray(found)).toBe(false)
  })

  it('picks the stalest', () => {
    expect(stalenessFor(many)!.exerciseId).toBe('bench_press')
  })

  it('is deterministic', () => {
    expect(stalenessFor(many)).toEqual(stalenessFor(many))
  })

  it('survives an empty or junk history', () => {
    expect(stalenessFor(ctx())).toBeNull()
    expect(stalenessFor(ctx({ history: { x: [] } }))).toBeNull()
  })

  it('says nothing for a lift the catalog does not know', () => {
    /* No catalog entry means no alternatives to offer, and a complaint
       with no option attached is the noise this is meant to avoid. */
    expect(stalenessFor(ctx({
      history: { zercher_jump_snatch: flat(STALE_WEEKS + 4) },
      customLib: { zercher_jump_snatch: { equipment: 'barbell', kind: 'reps_weight' } },
    }))).toBeNull()
  })
})
