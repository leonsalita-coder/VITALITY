import { describe, it, expect } from 'vitest'
import { rankSwaps, SWAP_WEIGHTS } from '../../lib/train/swap'
import { CATALOG, catalogExercise } from '../../lib/train/catalog'

/**
 * Smart swap.
 *
 * Swap was a text field. The catalog now carries movement patterns, muscle
 * contributions weighted by how much of the work each takes, and
 * equipment — which is enough to offer lifts that are actually equivalent
 * rather than making somebody type one.
 *
 * The judgment that shapes the ranking: HISTORY IS WORTH MORE THAN A
 * SLIGHTLY BETTER MATCH. A swap that resets progression costs the lifter
 * a baseline, a PR reference and a plateau read, and a marginally closer
 * movement does not buy that back.
 */

const squat = catalogExercise('back_squat')!
const bench = catalogExercise('bench_press')!

const ctx = (over: Record<string, unknown> = {}) => ({
  equipment: ['barbell', 'dumbbell', 'bodyweight'],
  sessions: {} as Record<string, number>,
  known: CATALOG,
  ...over,
})

const ids = (list: Array<{ id: string }>) => list.map((c) => c.id)

describe('the fixture itself', () => {
  it('has the catalog entries these tests reason about', () => {
    expect(squat.pattern).toBe('squat')
    expect(bench.pattern).toBe('horizontal_push')
    expect(catalogExercise('goblet_squat')).toBeTruthy()
    expect(catalogExercise('bulgarian_split_squat')).toBeTruthy()
  })
})

describe('a barbell squat with no rack available', () => {
  const rackless = ctx({ equipment: ['dumbbell', 'bodyweight'] })

  it('offers squat-pattern lifts you can actually do', () => {
    const ranked = rankSwaps(squat, rackless)
    expect(ranked.length).toBeGreaterThan(0)
    expect(ranked.every((c) => c.id !== 'back_squat')).toBe(true)
  })

  it('ranks goblet and split squat above bench', () => {
    const ranked = ids(rankSwaps(squat, rackless))
    const goblet = ranked.indexOf('goblet_squat')
    const benchAt = ranked.indexOf('bench_press')
    expect(goblet).toBeGreaterThanOrEqual(0)
    expect(benchAt === -1 || goblet < benchAt).toBe(true)
  })

  it('does not offer a barbell lift that needs the rack it does not have', () => {
    const ranked = rankSwaps(squat, rackless)
    expect(ranked.every((c) => c.equipment !== 'barbell')).toBe(true)
  })

  it('always allows bodyweight, which needs nothing', () => {
    /* Equipment IS known here and bodyweight is not on the list — an
       empty list disables filtering entirely, so it would prove nothing. */
    const ranked = rankSwaps(squat, ctx({ equipment: ['dumbbell'] }))
    expect(ranked.length).toBeGreaterThan(0)
    expect(ranked.some((c) => c.equipment === 'bodyweight')).toBe(true)
  })
})

describe('history outranks a marginally better match', () => {
  it('lifts a candidate with sessions above an EQUALLY matched one without', () => {
    /* Two lifts identical in every way the ranking can see, so the only
       thing separating them is history. Built rather than picked from the
       catalog: any two real lifts differ slightly, and then the test
       would be measuring that difference instead of the property. */
    const twin = (id: string) => ({ ...squat, id, name: id, aliases: [] })
    const pair = [twin('a_twin'), twin('b_twin')]

    const level = rankSwaps(squat, ctx({ known: pair }))
    expect(level[0].score).toBe(level[1].score)
    expect(ids(level)).toEqual(['a_twin', 'b_twin']) // id tiebreak only

    const tilted = rankSwaps(squat, ctx({ known: pair, sessions: { b_twin: 12 } }))
    expect(ids(tilted)).toEqual(['b_twin', 'a_twin'])
    expect(tilted[0].score).toBeGreaterThan(tilted[1].score)
  })

  it('raises a candidate’s score whenever it has history, wherever it lands', () => {
    const gym = { equipment: ['barbell', 'dumbbell', 'bodyweight', 'machine'] }
    const without = rankSwaps(squat, ctx(gym))
    const middle = without[3]
    const moved = rankSwaps(squat, ctx({ ...gym, sessions: { [middle.id]: 40 } }))
      .find((c) => c.id === middle.id)!
    expect(moved.score).toBeGreaterThan(middle.score)
    /* Deliberately not asserting it overtakes: history is a thumb on the
       scale, and a same-pattern lift you own the equipment for SHOULD
       still beat a distant one you happen to have done. */
  })

  it('can put a slightly worse movement first when it has real history', () => {
    const ranked = ids(rankSwaps(squat, ctx({ sessions: { goblet_squat: 60 } })))
    expect(ranked[0]).toBe('goblet_squat')
  })

  it('does not offer a completely unrelated lift at all, however much history it has', () => {
    /* A swap is still a swap. Two hundred sessions of curls does not make
       a curl a squat, and offering one at any rank would be the app not
       knowing what the word means. */
    const ranked = ids(rankSwaps(squat, ctx({ sessions: { barbell_curl: 200, dumbbell_curl: 200 } })))
    expect(ranked.filter((id) => /curl/.test(id))).toEqual([])
    expect(ranked.length).toBeGreaterThan(0) // and it still offered something
  })
})

describe('with no equipment on record it falls back to pattern and muscle', () => {
  const blind = ctx({ equipment: [] })

  it('still ranks squat-pattern lifts first for a squat', () => {
    const top = ids(rankSwaps(squat, blind)).slice(0, 5)
    const patterns = top.map((id) => catalogExercise(id)!.pattern)
    expect(patterns.filter((p) => p === 'squat').length).toBeGreaterThanOrEqual(3)
  })

  it('still ranks pressing lifts first for a bench', () => {
    const top = ids(rankSwaps(bench, blind)).slice(0, 5)
    const patterns = top.map((id) => catalogExercise(id)!.pattern)
    expect(patterns.filter((p) => /push/.test(p)).length).toBeGreaterThanOrEqual(3)
  })

  it('says it is reasoning without equipment', () => {
    expect(rankSwaps(squat, blind)[0].reasons.join(' ')).not.toMatch(/equipment you have/)
  })
})

describe('every candidate says why it was offered', () => {
  const ranked = rankSwaps(squat, ctx({ sessions: { goblet_squat: 12 } }))

  it('gives a reason for each', () => {
    expect(ranked.every((c) => c.reasons.length > 0)).toBe(true)
  })

  it('names the pattern when the pattern matched', () => {
    const goblet = ranked.find((c) => c.id === 'goblet_squat')!
    expect(goblet.reasons.join(' ')).toMatch(/same movement|squat/i)
  })

  it('names the history when there is history', () => {
    const goblet = ranked.find((c) => c.id === 'goblet_squat')!
    expect(goblet.reasons.join(' ')).toMatch(/12 sessions/)
  })

  it('names the muscles when the overlap is what earned it', () => {
    expect(ranked.some((c) => /quads|glutes/i.test(c.reasons.join(' ')))).toBe(true)
  })

  it('never offers a bare score with no explanation', () => {
    for (const c of ranked) {
      expect(c.reasons.every((r) => typeof r === 'string' && r.trim().length > 0)).toBe(true)
    }
  })
})

describe('the scoring itself', () => {
  it('weights the pattern most heavily, then muscles, then history', () => {
    expect(SWAP_WEIGHTS.pattern).toBeGreaterThan(SWAP_WEIGHTS.muscles)
    expect(SWAP_WEIGHTS.muscles).toBeGreaterThan(SWAP_WEIGHTS.history)
  })

  it('is deterministic', () => {
    expect(ids(rankSwaps(squat, ctx()))).toEqual(ids(rankSwaps(squat, ctx())))
  })

  it('never offers the lift being replaced', () => {
    expect(ids(rankSwaps(squat, ctx())).includes('back_squat')).toBe(false)
  })

  it('returns nothing rather than noise for an unknown lift', () => {
    expect(rankSwaps(null, ctx())).toEqual([])
  })

  it('weights muscle overlap by contribution, not by shared names', () => {
    /* The two candidates are built so the two rules DISAGREE, which is
       the only way to tell which one is running.
       A back squat is quads .55 / glutes .3 / lower_back .1 / hams .05.
         deep — quads .95: one shared muscle, but the one that matters.
         wide — three shared muscles, none of them carrying much.
       By contribution deep wins (.55 vs .40). By counting shared names
       wide wins, three to one. Both are the same pattern, so the pattern
       term cancels and cannot carry the result. */
    const deep = { ...squat, id: 'deep', name: 'deep', aliases: [], secondary: [],
      primary: [{ muscle: 'quads' as const, share: 0.95 },
                { muscle: 'calves' as const, share: 0.05 }] }
    const wide = { ...squat, id: 'wide', name: 'wide', aliases: [], secondary: [],
      primary: [{ muscle: 'glutes' as const, share: 0.25 },
                { muscle: 'lower_back' as const, share: 0.25 },
                { muscle: 'hamstrings' as const, share: 0.25 },
                { muscle: 'calves' as const, share: 0.25 }] }

    const ranked = rankSwaps(squat, ctx({ known: [deep, wide] }))
    expect(ids(ranked)).toEqual(['deep', 'wide'])
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score)
  })
})

describe('a swap never inherits the replaced lift’s past', () => {
  it('carries no history, no records and no starting weight', () => {
    const candidate = rankSwaps(squat, ctx({ sessions: { goblet_squat: 12 } }))[0]
    const asRecord = candidate as unknown as Record<string, unknown>
    expect(asRecord.history).toBeUndefined()
    expect(asRecord.records).toBeUndefined()
    expect(asRecord.lastKg).toBeUndefined()
    expect(asRecord.kg).toBeUndefined()
  })

  it('reports only the candidate’s OWN session count', () => {
    const ranked = rankSwaps(squat, ctx({ sessions: { back_squat: 200, goblet_squat: 3 } }))
    expect(ranked.find((c) => c.id === 'goblet_squat')!.sessions).toBe(3)
  })
})
