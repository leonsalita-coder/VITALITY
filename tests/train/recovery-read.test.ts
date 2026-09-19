import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'

/**
 * The Vitals read has three outcomes and they must stay apart.
 *
 * Before this, all three collapsed into `recovery = null` inside a silent
 * catch. The consequence was not a missing feature but a hidden one: every
 * deload came out `inferred` at the gentle 95% cut, the measured path never
 * ran even once, and a genuinely broken read looked exactly like a user who
 * had simply never connected Vitals.
 */

const HISTORY = {
  bench: [
    { date: '2026-08-20', kg: 185, sets: [{ w: 185, r: 5 }, { w: 185, r: 5 }] },
    { date: '2026-08-27', kg: 185, sets: [{ w: 185, r: 5 }, { w: 185, r: 5 }] },
    { date: '2026-09-03', kg: 185, sets: [{ w: 185, r: 5 }, { w: 185, r: 5 }] },
    { date: '2026-09-10', kg: 185, sets: [{ w: 185, r: 5 }, { w: 185, r: 5 }] },
  ],
}

const baseState = () => ({
  unit: 'lb', submitted: false,
  session: { date: '1970-01-01', off: false, warmup: [], cooldown: [], ex: [] },
  history: HISTORY,
  customLib: { bench: { equipment: 'Barbell' } },
  exerciseNames: { bench: 'Bench Press' },
  finishedDates: [], templates: [], shortTermGoal: '',
  photos: [], sessionDurations: [], liftGoals: [],
})

/** Seven days of Vitals rows at a given recovery score. */
const vitalsAt = (score: number) =>
  Object.fromEntries(
    ['09-04', '09-05', '09-06', '09-07', '09-08', '09-09', '09-10'].map((d) => [
      `2026-${d}`,
      { whoopRecovery: score },
    ]),
  )

interface Booted {
  win: any
  warns: string[]
  infos: string[]
}

async function boot(read: () => Promise<unknown>): Promise<Booted> {
  const warns: string[] = []
  const infos: string[] = []
  const dom = new JSDOM(readFileSync('public/tiles/train.html', 'utf8'), {
    // a real origin: about:blank is opaque, and storage the tile touches
    // throws there — a setup that fails silently is a test proving nothing
    url: 'https://train.test/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(w: any) {
      w.Vitality = {
        load: async () => baseState(),
        save: () => {},
        read,
        classify: async () => { throw new Error('no_key') },
        getInsight: async () => { throw new Error('no_key') },
        generateWorkout: async () => { throw new Error('no_key') },
      }
      w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
      w.HTMLCanvasElement.prototype.getContext = () => null
    },
  })
  dom.virtualConsole.on('warn', (m: string) => warns.push(String(m)))
  dom.virtualConsole.on('info', (m: string) => infos.push(String(m)))
  await new Promise((r) => setTimeout(r, 600))
  return { win: dom.window, warns, infos }
}

describe('case 1 — no connection', () => {
  it('reports no_connection when the read throws', async () => {
    const { win } = await boot(async () => {
      throw new Error('no vitals connected')
    })
    const rec = await win.eval('readRecovery()')
    expect(rec.status).toBe('no_connection')
    expect(rec.avg).toBeNull()
    expect(rec.detail).toContain('no vitals')
  })

  it('says so out loud rather than swallowing it', async () => {
    const { win, warns } = await boot(async () => {
      throw new Error('no vitals connected')
    })
    await win.eval('(async () => noteRecovery(await readRecovery()))()')
    expect(warns.some((w) => w.includes('no_connection'))).toBe(true)
  })

  it('leaves a diagnosable record on state', async () => {
    const { win } = await boot(async () => {
      throw new Error('boom')
    })
    await win.eval('(async () => noteRecovery(await readRecovery()))()')
    expect(win.eval('STATE.recoveryStatus').status).toBe('no_connection')
  })
})

describe('case 2 — connected, no data', () => {
  it('distinguishes an empty read from a failed one', async () => {
    const { win } = await boot(async () => ({}))
    const rec = await win.eval('readRecovery()')
    expect(rec.status).toBe('connected_no_data')
    expect(rec.avg).toBeNull()
  })

  it('treats rows with no usable recovery fields the same way', async () => {
    const { win } = await boot(async () => ({ '2026-09-10': { steps: 8000 } }))
    expect((await win.eval('readRecovery()')).status).toBe('connected_no_data')
  })

  it('warns, because connected-but-empty is still worth knowing', async () => {
    const { win, warns } = await boot(async () => ({}))
    await win.eval('(async () => noteRecovery(await readRecovery()))()')
    expect(warns.some((w) => w.includes('connected_no_data'))).toBe(true)
  })
})

describe('case 3 — connected with data', () => {
  it('returns a real average', async () => {
    const { win } = await boot(async () => vitalsAt(42))
    const rec = await win.eval('readRecovery()')
    expect(rec.status).toBe('connected')
    expect(rec.avg).toBe(42)
    expect(rec.days).toBe(7)
  })

  it('logs at info rather than warning', async () => {
    const { win, infos, warns } = await boot(async () => vitalsAt(42))
    await win.eval('(async () => noteRecovery(await readRecovery()))()')
    expect(infos.some((m) => m.includes('connected'))).toBe(true)
    expect(warns.some((m) => m.includes('recovery'))).toBe(false)
  })

  it('produces a MEASURED volume deload when recovery is genuinely low', async () => {
    const { win } = await boot(async () => vitalsAt(42))
    const rec = await win.eval('readRecovery()')
    const walk = win.eval(`(function(recovery){
      const ctx = { history: STATE.history.bench, today:'2026-09-17', recovery, rpe:null, excluded:[] };
      const flagged = TrainEngine.nextDeloadState(null, ctx);
      return TrainEngine.nextDeloadState(flagged, Object.assign({}, ctx, { today:'2026-09-18' }));
    })`)(rec.avg)
    expect(walk.confidence).toBe('measured')
    expect(walk.kind).toBe('volume')
  })

  it('produces a MEASURED intensity deload at the 90% cut, not the 95% fallback', async () => {
    const { win } = await boot(async () => vitalsAt(80))
    const rec = await win.eval('readRecovery()')
    const result = win.eval(`(function(recovery){
      const ctx = { history: STATE.history.bench, today:'2026-09-17', recovery, rpe:9.5, excluded:[] };
      const flagged = TrainEngine.nextDeloadState(null, ctx);
      const rec2 = TrainEngine.nextDeloadState(flagged, Object.assign({}, ctx, { today:'2026-09-18' }));
      return { rec: rec2, plan: TrainEngine.deloadPlan(rec2) };
    })`)(rec.avg)
    expect(result.rec.confidence).toBe('measured')
    expect(result.rec.kind).toBe('intensity')
    expect(result.plan.weight).toBe(166.5) // 185 * 0.90 — the measured cut
  })
})

describe('the two unknown cases stay conservative', () => {
  it('falls back to the gentler 95% cut when recovery is unavailable', async () => {
    const { win } = await boot(async () => {
      throw new Error('no vitals connected')
    })
    const rec = await win.eval('readRecovery()')
    const recovery = rec.status === 'connected' ? rec.avg : null
    const result = win.eval(`(function(recovery){
      const ctx = { history: STATE.history.bench, today:'2026-09-17', recovery, rpe:null, excluded:[] };
      const flagged = TrainEngine.nextDeloadState(null, ctx);
      const rec2 = TrainEngine.nextDeloadState(flagged, Object.assign({}, ctx, { today:'2026-09-18' }));
      return { rec: rec2, plan: TrainEngine.deloadPlan(rec2) };
    })`)(recovery)
    expect(result.rec.confidence).toBe('inferred')
    expect(result.plan.weight).toBe(175.75) // 185 * 0.95
  })
})
