import { describe, it, expect } from 'vitest'
import { simulate, compareScenarios, type Scenario } from '../../lib/train/simulate'
import * as progression from '../../lib/train/progression'
import { readFileSync } from 'node:fs'

/**
 * Replaying the engine forward over a synthetic history.
 *
 * This is possible only because the engine is pure and takes `now` as an
 * argument: every function it needs can be run against a history that has
 * not happened. An app with this logic tangled into its UI cannot do it
 * at all.
 *
 * TWO RULES.
 *
 * It uses the REAL engine. A separate simulation path that drifts from
 * the shipped one is worse than no simulation, because it produces
 * confident answers about an engine nobody is running.
 *
 * Its output is a PROJECTION and is never mixed into real history, or
 * into any read that touches records, plateaus or analysis.
 */

const day = (back: number) => {
  const d = new Date(2026, 8, 19 - back)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const NOW = new Date(2026, 8, 19, 12).getTime()

/** Four weeks of clean sessions to start from. */
const seed = [28, 21, 14, 7].map((b) => ({
  date: day(b), kg: 200, sets: [{ w: 200, r: 5 }, { w: 200, r: 5 }, { w: 200, r: 5 }],
}))

const scenario = (over: Partial<Scenario> = {}): Scenario => ({
  name: 'base',
  weeks: 8,
  sessionsPerWeek: 3,
  setsPerSession: 3,
  exercise: { id: 'bench', reps: 5, sets: 3, incrementLb: 5, muscles: ['chest'] },
  ...over,
})

describe('it runs the real engine, not a copy', () => {
  it('calls the same suggestTarget the app calls', () => {
    /* Read from the source rather than spied at runtime: the export is a
       frozen getter in the bundle and cannot be reassigned, so a spy
       would silently observe nothing and pass. */
    const source = readFileSync('lib/train/simulate.ts', 'utf8')
    expect(source).toMatch(/from '\.\/progression'/)
    expect(source).toMatch(/suggestTarget\(/)
    expect(typeof progression.suggestTarget).toBe('function')
  })

  it('does not define a second progression rule of its own', () => {
    const source = readFileSync('lib/train/simulate.ts', 'utf8')
    /* No arithmetic on increments here — if the projection wants to know
       what the next weight is, it has to ask. */
    expect(source).not.toMatch(/incrementLb\s*\*/)
    expect(source).not.toMatch(/\+\s*increment/)
  })
})

describe('a projection is deterministic', () => {
  it('gives identical output for identical input', () => {
    expect(simulate(seed, scenario(), NOW)).toEqual(simulate(seed, scenario(), NOW))
  })

  it('projects the number of weeks asked for', () => {
    const run = simulate(seed, scenario({ weeks: 6 }), NOW)
    expect(run.weeks).toBe(6)
    expect(run.sessions.length).toBe(6 * 3)
  })

  it('starts from the real history rather than from nothing', () => {
    const run = simulate(seed, scenario(), NOW)
    expect(run.startingE1rm).toBeGreaterThan(200)
    expect(simulate([], scenario(), NOW).sessions.length).toBeGreaterThan(0)
  })
})

describe('changing the schedule changes the projection', () => {
  it('projects more weekly volume at a higher frequency', () => {
    const low = simulate(seed, scenario({ sessionsPerWeek: 2 }), NOW)
    const high = simulate(seed, scenario({ sessionsPerWeek: 4 }), NOW)
    expect(high.weeklyVolumeByMuscle.chest).toBeGreaterThan(low.weeklyVolumeByMuscle.chest)
  })

  it('projects more volume at more sets per session', () => {
    const few = simulate(seed, scenario({ setsPerSession: 2 }), NOW)
    const many = simulate(seed, scenario({ setsPerSession: 5 }), NOW)
    expect(many.weeklyVolumeByMuscle.chest).toBeGreaterThan(few.weeklyVolumeByMuscle.chest)
  })

  it('projects a different path with a different rep range', () => {
    const low = simulate(seed, scenario({ exercise: { ...scenario().exercise, repRange: [3, 5] } }), NOW)
    const high = simulate(seed, scenario({ exercise: { ...scenario().exercise, repRange: [8, 12] } }), NOW)
    expect(low.projectedE1rm).not.toBe(high.projectedE1rm)
  })

  it('projects further without a deload than with one', () => {
    const withDeload = simulate(seed, scenario({ deloadEvery: 4 }), NOW)
    const without = simulate(seed, scenario({ deloadEvery: null }), NOW)
    expect(without.projectedE1rm).toBeGreaterThanOrEqual(withDeload.projectedE1rm)
  })
})

describe('comparing two scenarios', () => {
  const three = scenario({ name: '3 days', sessionsPerWeek: 3 })
  const four = scenario({ name: '4 days', sessionsPerWeek: 4 })

  it('reports the difference in projected e1RM and weekly volume', () => {
    const diff = compareScenarios(seed, three, four, NOW)
    expect(diff.a.name).toBe('3 days')
    expect(diff.b.name).toBe('4 days')
    expect(typeof diff.e1rmDelta).toBe('number')
    expect(diff.volumeDelta.chest).toBeGreaterThan(0)
  })

  it('says it in a sentence, as a projection', () => {
    const diff = compareScenarios(seed, three, four, NOW)
    expect(diff.text).toMatch(/project/i)
    expect(diff.text).toMatch(/4 days/)
  })

  it('is symmetric in the sense that swapping flips the sign', () => {
    const ab = compareScenarios(seed, three, four, NOW)
    const ba = compareScenarios(seed, four, three, NOW)
    expect(ba.volumeDelta.chest).toBeCloseTo(-ab.volumeDelta.chest, 4)
  })
})

describe('a projection is never mistaken for history', () => {
  const run = simulate(seed, scenario(), NOW)

  it('marks every projected session', () => {
    expect(run.projected).toBe(true)
    expect(run.sessions.every((s) => s.projected === true)).toBe(true)
  })

  it('leaves the history it was given untouched', () => {
    const before = JSON.stringify(seed)
    simulate(seed, scenario(), NOW)
    expect(JSON.stringify(seed)).toBe(before)
  })

  it('projects dates in the FUTURE, so it can never be confused for a log', () => {
    for (const session of run.sessions) {
      expect(session.date > day(0)).toBe(true)
    }
  })

  it('returns sessions that carry the projected flag into any consumer', () => {
    /* Anything that did merge these into a real read would find the flag
       on every row, which is what makes the mistake detectable rather
       than silent. */
    expect(run.sessions[0]).toHaveProperty('projected', true)
  })
})
