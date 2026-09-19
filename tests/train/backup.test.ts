import { describe, it, expect } from 'vitest'
import {
  MAX_SNAPSHOTS, makeSnapshot, validateSnapshot, pushSnapshot, chooseRestore,
  stateLooksEmpty, exportJson, importJson, storageReport,
} from '../../lib/train/backup'

const NOW = new Date('2026-09-19T12:00:00').getTime()
const day = (n: number) => NOW - n * 86_400_000

const state = (lifts = 1, setsEach = 3) => ({
  unit: 'lb',
  history: Object.fromEntries(
    Array.from({ length: lifts }, (_, i) => [
      `lift${i}`,
      [{ date: '2026-09-16', kg: 185, sets: Array.from({ length: setsEach }, () => ({ w: 185, r: 5 })) }],
    ]),
  ),
  finishedDates: ['2026-09-16'],
  customLib: {},
})

describe('snapshots', () => {
  it('records when it was taken and how much work it holds', () => {
    const s = makeSnapshot(state(2, 3), NOW)
    expect(s.sets).toBe(6)
    expect(s.date).toBe('2026-09-19')
    expect(validateSnapshot(s)).toBe(true)
  })

  it('keeps a rolling set rather than only the latest', () => {
    let list: ReturnType<typeof makeSnapshot>[] = []
    for (let i = 10; i >= 0; i--) list = pushSnapshot(list, makeSnapshot(state(), day(i)))
    expect(list).toHaveLength(MAX_SNAPSHOTS)
    expect(list[0].at).toBeGreaterThan(list[1].at)
  })

  it('replaces the same day rather than evicting an older copy', () => {
    const a = pushSnapshot([], makeSnapshot(state(1), NOW))
    const b = pushSnapshot(a, makeSnapshot(state(2), NOW + 1000))
    expect(b).toHaveLength(1)
  })

  it('drops anything that does not validate', () => {
    const list = pushSnapshot([{ garbage: true } as never], makeSnapshot(state(), NOW))
    expect(list).toHaveLength(1)
  })
})

describe('a corrupt snapshot falls back rather than throwing', () => {
  const corrupt = [
    null, undefined, 'a string', 42, {},
    { v: 99, at: NOW, state: {} },
    { v: 1, at: 'nope', state: {} },
    { v: 1, at: NOW, state: null },
    { v: 1, at: NOW, state: { history: 'not an object' } },
  ]

  it('rejects every malformed shape', () => {
    for (const bad of corrupt) expect(validateSnapshot(bad), JSON.stringify(bad)).toBe(false)
  })

  it('returns null rather than throwing when nothing is usable', () => {
    expect(chooseRestore(corrupt)).toBeNull()
    expect(chooseRestore([])).toBeNull()
  })

  it('picks the newest good one past the corrupt ones', () => {
    const good = makeSnapshot(state(), day(3))
    const chosen = chooseRestore([...corrupt, good, { v: 1, at: NaN, state: {} }])!
    expect(chosen.at).toBe(good.at)
  })

  it('prefers a snapshot with work over a newer empty one', () => {
    // the empty one is what a bad boot would have written
    const empty = makeSnapshot({ history: {}, finishedDates: [] }, NOW)
    const real = makeSnapshot(state(), day(2))
    expect(chooseRestore([empty, real])!.at).toBe(real.at)
  })
})

describe('eviction — empty local state with a snapshot present', () => {
  it('recognises state that was lost rather than never created', () => {
    expect(stateLooksEmpty(null)).toBe(true)
    expect(stateLooksEmpty({ history: {}, finishedDates: [] })).toBe(true)
    expect(stateLooksEmpty([])).toBe(true)
  })

  it('does not mistake a real history for an empty one', () => {
    expect(stateLooksEmpty(state())).toBe(false)
  })

  it('has something to restore after the local copy is gone', () => {
    const snapshots = pushSnapshot([], makeSnapshot(state(3, 4), day(1)))
    const wiped = null // localStorage cleared
    expect(stateLooksEmpty(wiped)).toBe(true)
    const restore = chooseRestore(snapshots)!
    expect((restore.state as ReturnType<typeof state>).history.lift0).toBeDefined()
    expect(restore.sets).toBe(12)
  })
})

describe('JSON round-trip loses nothing', () => {
  const full = {
    ...state(2, 3),
    aliases: { 'bb bench': 'bench_press' },
    deloadStates: { bench_press: { state: 'deloading', priorWeight: 185 } },
    routines: [{ id: 'r1', name: 'Push', exercises: [{ exerciseId: 'bench_press', sets: 3, reps: 5, rest: 180 }] }],
    painFlagged: ['back_squat'],
    weeklyTarget: 5,
    plateConfig: { barLb: 45, plates: [45, 25, 10, 5, 2.5] },
  }

  it('comes back byte-identical through export and import', () => {
    const out = importJson(exportJson(full, NOW))
    expect(out.ok).toBe(true)
    expect(out.state).toEqual(full)
  })

  it('keeps every nested structure, not just history', () => {
    const back = importJson(exportJson(full, NOW)).state as typeof full
    expect(back.aliases).toEqual(full.aliases)
    expect(back.routines[0].exercises).toEqual(full.routines[0].exercises)
    expect(back.deloadStates).toEqual(full.deloadStates)
    expect(back.plateConfig).toEqual(full.plateConfig)
  })

  it('stamps what it is, so a stray file is identifiable', () => {
    const parsed = JSON.parse(exportJson(full, NOW))
    expect(parsed.app).toBe('vitality-train')
    expect(parsed.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('refuses a file it cannot vouch for, with a reason', () => {
    expect(importJson('not json').reason).toMatch(/valid JSON/)
    expect(importJson('{"app":"something-else"}').reason).toMatch(/not a Train export/)
    expect(importJson('{"app":"vitality-train"}').reason).toMatch(/no state/)
    expect(importJson('').ok).toBe(false)
  })

  it('reports how much came back', () => {
    expect(importJson(exportJson(full, NOW)).reason).toMatch(/6 sets/)
  })
})

describe('the storage report says which layers work', () => {
  it('names each layer', () => {
    const r = storageReport('ok', 'unavailable', 3)
    expect(r.detail).toMatch(/host store working/)
    expect(r.detail).toMatch(/in-frame copy unavailable/)
    expect(r.detail).toMatch(/3 snapshots/)
  })

  it('reports a failing host rather than implying it worked', () => {
    expect(storageReport('failed', 'ok', 0).detail).toMatch(/host store failed/)
  })

  it('gets the singular right, because detail matters in a warning', () => {
    expect(storageReport('ok', 'ok', 1).detail).toMatch(/1 snapshot,|1 snapshot$/)
  })
})
