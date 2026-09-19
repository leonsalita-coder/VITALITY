import { describe, it, expect } from 'vitest'
import {
  bodyweightAt, currentBodyweight, recordBodyweight, bodyweightLoad,
} from '../../lib/train/bodyweight'

const history = [
  { date: '2026-01-10', lb: 160 },
  { date: '2026-06-10', lb: 172 },
  { date: '2026-09-10', lb: 185 },
]

describe('bodyweight is tracked, not set', () => {
  it('uses what they weighed at the time, not what they weigh now', () => {
    expect(bodyweightAt(history, '2026-02-01')).toBe(160)
    expect(bodyweightAt(history, '2026-07-01')).toBe(172)
    expect(bodyweightAt(history, '2026-09-19')).toBe(185)
  })

  it('uses a reading taken on the day itself', () => {
    expect(bodyweightAt(history, '2026-06-10')).toBe(172)
  })

  it('is null before the first reading — March does not describe January', () => {
    expect(bodyweightAt(history, '2025-12-01')).toBeNull()
    expect(bodyweightAt([], '2026-01-01')).toBeNull()
  })

  it('ignores impossible readings rather than trusting them', () => {
    const dirty = [{ date: '2026-01-01', lb: 0 }, { date: '2026-01-02', lb: NaN as number }]
    expect(bodyweightAt(dirty, '2026-02-01')).toBeNull()
  })

  it('reports the latest for anything that just needs now', () => {
    expect(currentBodyweight(history)).toBe(185)
    expect(currentBodyweight([])).toBeNull()
  })
})

describe('recording', () => {
  it('adds a reading in date order', () => {
    const out = recordBodyweight(history, '2026-03-01', 165)
    expect(out.map((e) => e.date)).toEqual(['2026-01-10', '2026-03-01', '2026-06-10', '2026-09-10'])
  })

  it('replaces the same day rather than stacking', () => {
    const out = recordBodyweight(history, '2026-09-10', 186)
    expect(out.filter((e) => e.date === '2026-09-10')).toHaveLength(1)
    expect(bodyweightAt(out, '2026-09-10')).toBe(186)
  })

  it('refuses a nonsense reading', () => {
    expect(recordBodyweight(history, '2026-09-11', 0)).toEqual(history)
    expect(recordBodyweight(history, '2026-09-11', -5)).toEqual(history)
  })
})

describe('the load a bodyweight movement moves', () => {
  it('scales by the movement factor', () => {
    expect(bodyweightLoad({ bodyweightLb: 200, factor: 0.65 })).toBe(130)
    expect(bodyweightLoad({ bodyweightLb: 200, factor: 1 })).toBe(200)
  })

  it('changes as the athlete changes — the same pull-up is not the same set', () => {
    const light = bodyweightLoad({ bodyweightLb: 160, factor: 1 })!
    const heavy = bodyweightLoad({ bodyweightLb: 185, factor: 1 })!
    expect(heavy).toBeGreaterThan(light)
  })

  it('adds a weight belt', () => {
    expect(bodyweightLoad({ bodyweightLb: 180, factor: 1, added: 45 })).toBe(225)
  })

  it('SUBTRACTS assistance — the machine is taking weight off', () => {
    expect(bodyweightLoad({ bodyweightLb: 180, factor: 1, assistance: 40 })).toBe(140)
  })

  it('never goes negative when the machine does more than the athlete', () => {
    expect(bodyweightLoad({ bodyweightLb: 180, factor: 1, assistance: 250 })).toBe(0)
  })

  it('defaults a missing factor to the whole athlete', () => {
    expect(bodyweightLoad({ bodyweightLb: 180, factor: null })).toBe(180)
  })

  it('is NULL without a bodyweight, never zero', () => {
    expect(bodyweightLoad({ bodyweightLb: null, factor: 1 })).toBeNull()
    expect(bodyweightLoad({ bodyweightLb: null, factor: 0.65, added: 45 })).toBeNull()
  })
})

/* ────────────────────────────────────────────────────────────────────
   Through the volume path, which is the point of all of it.
   ──────────────────────────────────────────────────────────────────── */
import { workingVolume, entryScore } from '../../lib/train/sets'
import type { HistoryEntry } from '../../lib/train/sets'

const pullups = (reps: number): HistoryEntry => ({
  date: '2026-09-16', kg: 0,
  sets: [{ r: reps, kind: 'bodyweight' }, { r: reps, kind: 'bodyweight' }],
})

describe('a bodyweight lift at two different bodyweights', () => {
  it('counts more load at the heavier bodyweight — the same set is not the same set', () => {
    const light = workingVolume(pullups(8), { bodyweightLb: 160, bodyweightFactor: 1 })
    const heavy = workingVolume(pullups(8), { bodyweightLb: 185, bodyweightFactor: 1 })
    expect(light.load).toBe(160 * 16)
    expect(heavy.load).toBe(185 * 16)
    expect(heavy.load).toBeGreaterThan(light.load)
  })

  it('scales by the movement factor — a push-up is not a pull-up', () => {
    const pushups: HistoryEntry = {
      date: '2026-09-16', kg: 0, sets: [{ r: 20, kind: 'bodyweight' }],
    }
    const v = workingVolume(pushups, { bodyweightLb: 200, bodyweightFactor: 0.65 })
    expect(v.load).toBe(130 * 20)
  })

  it('adds a belt for weighted bodyweight work', () => {
    const weighted: HistoryEntry = {
      date: '2026-09-16', kg: 45, sets: [{ r: 5, w: 45, kind: 'weighted_bodyweight' }],
    }
    const v = workingVolume(weighted, { bodyweightLb: 180, bodyweightFactor: 1 })
    expect(v.load).toBe(225 * 5)
  })
})

describe('assisted is bodyweight minus help', () => {
  const assisted: HistoryEntry = {
    date: '2026-09-16', kg: 40,
    sets: [{ r: 8, w: 40, assisted: true }, { r: 8, w: 40, assisted: true }],
  }

  it('computes the real load once bodyweight is known', () => {
    const v = workingVolume(assisted, { bodyweightLb: 180, bodyweightFactor: 1 })
    expect(v.load).toBe(140 * 16)
    expect(v.loadUnavailable).toBe(false)
  })

  it('scores LESS help as the better session, on real numbers', () => {
    const heavyHelp = entryScore(
      { date: '2026-09-16', kg: 60, sets: [{ r: 8, w: 60, assisted: true }] },
      { bodyweightLb: 180, bodyweightFactor: 1 },
    )
    const lightHelp = entryScore(
      { date: '2026-09-16', kg: 20, sets: [{ r: 8, w: 20, assisted: true }] },
      { bodyweightLb: 180, bodyweightFactor: 1 },
    )
    expect(lightHelp.primary).toBeGreaterThan(heavyHelp.primary)
  })
})

describe('no bodyweight on record', () => {
  it('reports the reps and says the load is unavailable, never zero', () => {
    const v = workingVolume(pullups(8), {})
    expect(v.reps).toBe(16)
    expect(v.load).toBe(0)
    expect(v.loadUnavailable).toBe(true)
  })

  it('says the same for assisted work', () => {
    const assisted: HistoryEntry = {
      date: '2026-09-16', kg: 40, sets: [{ r: 8, w: 40, assisted: true }],
    }
    const v = workingVolume(assisted, {})
    expect(v.loadUnavailable).toBe(true)
    expect(v.reps).toBe(8)
  })

  it('does not claim unavailability for a lift that genuinely has no load', () => {
    const airSquats: HistoryEntry = {
      date: '2026-09-16', kg: 0, sets: [{ r: 20, kind: 'reps_only' }],
    }
    expect(workingVolume(airSquats, {}).loadUnavailable).toBe(false)
  })

  it('falls back to scoring on reps so progression still works', () => {
    const score = entryScore(pullups(12), {})
    expect(score.primary).toBe(12)
  })
})
