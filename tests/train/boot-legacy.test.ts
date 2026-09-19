import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'

/**
 * Boots the real tile against a realistic PRE-refactor store.
 *
 * Everything here is the old shape: history rows with no per-set weight, no
 * warm-up flag and no RPE, plus a live deloadOverrides entry. The bridge
 * rejects every AI call and has no Vitals to read, which is the common case
 * for someone who never added a key.
 *
 * The contract being pinned: the tile boots without throwing, the migration
 * converts rather than discards, and no historical number moves.
 */

const legacyState = () => ({
  unit: 'lb',
  submitted: false,
  session: { date: '1970-01-01', off: false, warmup: [], cooldown: [], ex: [] },
  history: {
    bench: [
      { date: '2026-08-20', kg: 185, sets: [{ r: 5 }, { r: 5 }, { r: 5 }] },
      { date: '2026-08-27', kg: 185, sets: [{ r: 5 }, { r: 5 }, { r: 4 }] },
      { date: '2026-09-03', kg: 185, sets: [{ r: 5 }, { r: 0, fail: true }] },
      { date: '2026-09-10', kg: 185, sets: [{ r: 5 }, { r: 5 }, { r: 5 }] },
    ],
  },
  customLib: { bench: { equipment: 'Barbell', primary: ['Chest'] } },
  exerciseNames: { bench: 'Bench Press' },
  finishedDates: ['2026-08-20', '2026-08-27', '2026-09-03', '2026-09-10'],
  templates: [],
  deloadOverrides: { bench: { kg: 166.5, date: '2026-09-10' } },
  shortTermGoal: '',
  photos: [],
  sessionDurations: [],
  liftGoals: [],
})

let win: any
let errors: string[]
let saves: unknown[]
/**
 * `STATE` is a top-level `let` in a classic script, so it lives in the
 * global lexical environment and never appears on `window`. Global eval can
 * see it; a property read cannot.
 */
let state: any

beforeAll(async () => {
  errors = []
  saves = []
  const dom = new JSDOM(readFileSync('public/tiles/train.html', 'utf8'), {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(w: any) {
      // the bridge a user with no key and no Vitals actually has
      w.Vitality = {
        load: async () => legacyState(),
        save: (s: unknown) => saves.push(s),
        read: async () => {
          throw new Error('no vitals connected')
        },
        classify: async () => {
          throw new Error('no_key')
        },
        getInsight: async () => {
          throw new Error('no_key')
        },
        generateWorkout: async () => {
          throw new Error('no_key')
        },
      }
      w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
      w.HTMLCanvasElement.prototype.getContext = () => null
    },
  })
  dom.virtualConsole.on('jsdomError', (e: Error) => errors.push(e.message))
  await new Promise((r) => setTimeout(r, 800))
  win = dom.window
  state = win.eval('STATE')
})

describe('booting on a legacy store', () => {
  it('does not throw', () => {
    expect(errors).toEqual([])
  })

  it('loads state and exposes the engine', () => {
    expect(state).toBeTruthy()
    expect(win.TrainEngine).toBeTruthy()
  })

  it('persists through the bridge', () => {
    expect(saves.length).toBeGreaterThan(0)
  })

  it('renders with every AI call failing', () => {
    expect((win.document.body.textContent || '').length).toBeGreaterThan(200)
  })
})

describe('the override migration converts rather than discards', () => {
  it('produces a deloading record', () => {
    const rec = state.deloadStates.bench
    expect(rec).toBeTruthy()
    expect(rec.state).toBe('deloading')
    expect(rec.kind).toBe('intensity')
  })

  it('removes the retired key', () => {
    expect(state.deloadOverrides).toBeUndefined()
  })

  it('reproduces the weight the lifter was already being shown', () => {
    const plan = win.TrainEngine.deloadPlan(state.deloadStates.bench)
    expect(Math.abs(plan.weight - 166.5)).toBeLessThan(0.6)
  })
})

describe('historical numbers do not shift', () => {
  it('reads legacy rows as working sets — absent warmup is false', () => {
    const entry = state.history.bench[0]
    expect(win.TrainEngine.workingSets(entry)).toHaveLength(3)
  })

  it('computes the same volume it always did', () => {
    const entry = state.history.bench[0]
    expect(win.TrainEngine.workingVolume(entry)).toBe(185 * 15)
  })

  it('falls back to the entry weight where no per-set weight exists', () => {
    expect(win.TrainEngine.topWorkingWeight(state.history.bench[0])).toBe(185)
  })

  it('still excludes a missed set', () => {
    expect(win.TrainEngine.workingSets(state.history.bench[2])).toHaveLength(1)
  })
})

describe('degrading with no recovery data and no RPE', () => {
  it('reports an unknown plateau cause rather than guessing one', () => {
    const p = win.TrainEngine.detectPlateau(state.history.bench, { excluded: [] })
    expect(p).not.toBeNull()
    expect(p.cause).toBe('unknown')
  })

  it('still produces a suggestion', () => {
    const s = win.TrainEngine.suggestWeight(
      state.history.bench,
      { reps: 5, loading: 'barbell' },
      Date.parse('2026-09-12T12:00:00'),
    )
    expect(typeof s.weight).toBe('number')
    expect(s.reason.length).toBeGreaterThan(0)
  })

  it('initialises the new state keys', () => {
    expect(state.weeklyTarget).toBe(4)
    expect(Array.isArray(state.deloadExclusions)).toBe(true)
  })
})
