import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'

/**
 * The failure this exists to prevent, driven through the real tile: a user
 * comes back after a week away, the host store has been evicted, and the
 * app must not start them fresh on top of a history they still have.
 */

const withHistory = () => ({
  unit: 'lb', submitted: false,
  session: { date: '1970-01-01', off: false, warmup: [], cooldown: [], ex: [] },
  history: {
    bench_press: [
      { date: '2026-09-10', kg: 185, sets: [{ w: 185, r: 5 }, { w: 185, r: 5 }, { w: 185, r: 5 }] },
      { date: '2026-09-16', kg: 190, sets: [{ w: 190, r: 5 }, { w: 190, r: 5 }] },
    ],
  },
  customLib: { bench_press: { equipment: 'barbell', primary: ['Chest'] } },
  exerciseNames: { bench_press: 'Bench Press' },
  finishedDates: ['2026-09-10', '2026-09-16'],
  templates: [], shortTermGoal: '', photos: [], sessionDurations: [], liftGoals: [],
})

async function boot(load: () => Promise<unknown>, seedLocal?: unknown) {
  const logs: string[] = []
  const dom = new JSDOM(readFileSync('public/tiles/train.html', 'utf8'), {
    // a real origin: about:blank is opaque and localStorage throws there,
    // which would silently defeat the in-frame layer this test exercises
    url: 'https://train.test/',
    runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w: any) {
      if (seedLocal !== undefined) {
        w.localStorage.setItem('vitality.train.snapshots', JSON.stringify(seedLocal))
      }
      w.Vitality = {
        load, save: () => {},
        read: async () => { throw new Error('no vitals') },
        classify: async () => { throw new Error('no_key') },
        getInsight: async () => { throw new Error('no_key') },
        generateWorkout: async () => { throw new Error('no_key') },
      }
      w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
      const noop = new Proxy({}, { get: () => () => noop })
      w.HTMLCanvasElement.prototype.getContext = () => noop
    },
  })
  dom.virtualConsole.on('warn', (m: string) => logs.push(String(m)))
  dom.virtualConsole.on('info', (m: string) => logs.push(String(m)))
  await new Promise((r) => setTimeout(r, 800))
  const win = dom.window as any
  return { win, logs, state: (): any => win.eval('STATE') }
}

describe('normal boot', () => {
  it('leaves an existing history alone and takes a snapshot', async () => {
    const { state, logs } = await boot(async () => withHistory())
    expect(Object.keys(state().history)).toEqual(['bench_press'])
    expect(state().snapshots.length).toBeGreaterThan(0)
    expect(logs.some((l) => l.includes('storage —'))).toBe(true)
  })
})

describe('eviction — the host store came back empty', () => {
  it('restores from a snapshot rather than starting fresh', async () => {
    // a snapshot taken before the eviction, still in the in-frame copy
    const snapshot = [{
      v: 1, at: Date.parse('2026-09-17T12:00:00'), date: '2026-09-17', sets: 5,
      state: withHistory(),
    }]
    const { state, logs } = await boot(async () => null, snapshot)
    expect(state().history.bench_press).toHaveLength(2)
    expect(logs.some((l) => l.includes('restored 5 sets'))).toBe(true)
  })

  it('says so on screen rather than restoring silently', async () => {
    const snapshot = [{
      v: 1, at: Date.parse('2026-09-17T12:00:00'), date: '2026-09-17', sets: 5,
      state: withHistory(),
    }]
    const { win } = await boot(async () => null, snapshot)
    const note = win.document.querySelector('#readinessNote')!.textContent || ''
    expect(note).toMatch(/data was missing/i)
    expect(note).toMatch(/Restored 5 sets/)
  })

  it('starts clean when there is genuinely nothing to restore', async () => {
    const { state } = await boot(async () => null, [])
    expect(Object.keys(state().history)).toEqual([])
  })

  it('does not restore over a user who already has data', async () => {
    const stale = [{
      v: 1, at: Date.parse('2020-01-01T12:00:00'), date: '2020-01-01', sets: 99,
      state: { history: { old_lift: [] }, finishedDates: ['2020-01-01'] },
    }]
    const { state } = await boot(async () => withHistory(), stale)
    expect(state().history.old_lift).toBeUndefined()
    expect(state().history.bench_press).toBeDefined()
  })
})

describe('a corrupt snapshot', () => {
  it('falls back to empty rather than throwing the boot', async () => {
    const { state, logs } = await boot(async () => null, [{ v: 99, nonsense: true }, 'garbage'])
    expect(state()).toBeTruthy()
    expect(logs.some((l) => l.toLowerCase().includes('error'))).toBe(false)
  })

  it('skips the corrupt one and uses the good one beside it', async () => {
    const mixed = [
      { v: 99, broken: true },
      { v: 1, at: Date.parse('2026-09-17T12:00:00'), date: '2026-09-17', sets: 5, state: withHistory() },
    ]
    const { state } = await boot(async () => null, mixed)
    expect(state().history.bench_press).toHaveLength(2)
  })
})

describe('the storage report', () => {
  it('names every layer at boot', async () => {
    const { win } = await boot(async () => withHistory())
    const report = win.eval('STORAGE') as any
    expect(report).toHaveProperty('host')
    expect(report).toHaveProperty('local')
    expect(report.detail).toMatch(/snapshot/)
  })

  it('reports a failed host rather than implying it worked', async () => {
    const { win } = await boot(async () => { throw new Error('bridge down') })
    expect(win.eval('STORAGE').host).toBe('failed')
  })
})
