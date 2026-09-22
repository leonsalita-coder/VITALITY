import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { validatePublish } from '../../lib/tiles/metricsContract'

/* LOCAL date, never toISOString — see docs/train-verification.md. */
const localToday = () => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * Train publishing, through the real tile.
 *
 * publishedMetrics is pure and swept; this is the other half — that the
 * tile actually calls it, at the right moments and not at the wrong
 * ones. An engine function nothing invokes looks exactly like a working
 * feature, which is the failure this codebase keeps producing.
 *
 * Every payload here is also run through the HOST's validator, because
 * a metric the host would reject is a metric that was never published.
 */

const today = localToday()
const state = () => ({
  unit: 'lb', submitted: false,
  session: {
    date: today, off: false, warmup: [], cooldown: [], startedAt: Date.now() - 3600_000,
    ex: [{
      id: 'bench_press', name: 'Bench Press', tier: 1, sets: 3, reps: 5, kg: 185,
      perHand: false, rest: 120, lastKg: 185, pinned: false, collapsed: false,
      deload: false, note: 'left shoulder twinge', log: [null, null, null],
    }],
  },
  history: {
    bench_press: Array.from({ length: 20 }, (_, i) => ({
      date: (() => { const d = new Date(); d.setDate(d.getDate() - (i * 3 + 2))
        const p = (n: number) => String(n).padStart(2, '0')
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` })(),
      kg: 185, sets: [{ w: 185, r: 5 }, { w: 185, r: 5 }],
    })),
  },
  customLib: { bench_press: { equipment: 'Barbell', kind: 'reps_weight', primary: ['Chest'] } },
  exerciseNames: { bench_press: 'Bench Press' },
  deloadStates: {}, finishedDates: [], templates: [], shortTermGoal: '',
  otherTraining: [], photos: [], sessionDurations: [], liftGoals: [], bodyweight: [],
})

let run: (expr: string) => any
let published: unknown[][]

beforeAll(async () => {
  published = []
  const dom = new JSDOM(readFileSync('public/tiles/train.html', 'utf8'), {
    url: 'https://train.test/', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w: any) {
      w.Vitality = {
        load: async () => state(), save: () => {},
        read: async () => { throw new Error('no vitals') },
        classify: async () => { throw new Error('no_key') },
        getInsight: async () => { throw new Error('no_key') },
        generateWorkout: async () => { throw new Error('no_key') },
        publish: (metrics: unknown[]) => { published.push(metrics) },
      }
      w.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })
      const noop = new Proxy({}, { get: () => () => noop })
      w.HTMLCanvasElement.prototype.getContext = () => noop
    },
  })
  await new Promise((r) => setTimeout(r, 900))
  run = (expr: string) => dom.window.eval(expr)
})

describe('the fixture itself', () => {
  it('booted with the bridge and the engine', () => {
    expect(run('typeof window.Vitality.publish')).toBe('function')
    expect(run('typeof TrainEngine.publishedMetrics')).toBe('function')
    expect(run('typeof publishMetrics')).toBe('function')
  })
})

describe('it publishes on rollover, once', () => {
  it('published on boot, because nothing had been published before', () => {
    /* An absent marker is a day that was never closed out. */
    expect(published.length).toBeGreaterThan(0)
  })

  it('records the day it published so the next boot is quiet', () => {
    expect(run('STATE.lastPublishedDate')).toBe(today)
  })

  it('does not publish again for the same day', () => {
    const before = published.length
    run('render(); renderOverviewCards(); drawStatsSection();')
    expect(published.length).toBe(before)
  })

  it('stays silent on a second boot of the same day', async () => {
    /* The real rollover case, which a re-render cannot stand in for:
       the tile boots again with the day already closed out. Publishing
       here would write on every page load forever. */
    const seen: unknown[][] = []
    const dom = new JSDOM(readFileSync('public/tiles/train.html', 'utf8'), {
      url: 'https://train.test/', runScripts: 'dangerously', pretendToBeVisual: true,
      beforeParse(w: any) {
        w.Vitality = {
          load: async () => ({ ...state(), lastPublishedDate: today }),
          save: () => {},
          read: async () => { throw new Error('no vitals') },
          classify: async () => { throw new Error('no_key') },
          getInsight: async () => { throw new Error('no_key') },
          generateWorkout: async () => { throw new Error('no_key') },
          publish: (m: unknown[]) => { seen.push(m) },
        }
        w.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })
        const noop = new Proxy({}, { get: () => () => noop })
        w.HTMLCanvasElement.prototype.getContext = () => noop
      },
    })
    await new Promise((r) => setTimeout(r, 900))
    expect(dom.window.eval('STATE.lastPublishedDate')).toBe(today)
    expect(seen).toEqual([])
  }, 30_000)

  it('publishes on a boot whose day has moved on', async () => {
    /* The control for the silence above — and the rollover itself. */
    const seen: unknown[][] = []
    const dom = new JSDOM(readFileSync('public/tiles/train.html', 'utf8'), {
      url: 'https://train.test/', runScripts: 'dangerously', pretendToBeVisual: true,
      beforeParse(w: any) {
        w.Vitality = {
          load: async () => ({ ...state(), lastPublishedDate: '2020-01-01' }),
          save: () => {},
          read: async () => { throw new Error('no vitals') },
          classify: async () => { throw new Error('no_key') },
          getInsight: async () => { throw new Error('no_key') },
          generateWorkout: async () => { throw new Error('no_key') },
          publish: (m: unknown[]) => { seen.push(m) },
        }
        w.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })
        const noop = new Proxy({}, { get: () => () => noop })
        w.HTMLCanvasElement.prototype.getContext = () => noop
      },
    })
    await new Promise((r) => setTimeout(r, 900))
    expect(seen.length).toBe(1)
    expect(dom.window.eval('STATE.lastPublishedDate')).toBe(today)
  }, 30_000)
})

describe('the payload is a closed set of keys', () => {
  it('emits only keys this contract names', () => {
    /* The engine builds the payload from scratch rather than projecting
       whatever it was handed, which is what makes a stray field in the
       context unable to leak. Asserted, because that is a property of
       the code rather than of the shape. */
    const ALLOWED = /^(trained|hard_sets|tonnage|session_duration|load_ratio|readiness|deload_lifts|pr|streak_sessions|streak_target|bodyweight|hard_sets\.[a-z_]+)$/
    for (const payload of published) {
      for (const m of payload as Array<Record<string, unknown>>) {
        expect(String(m.key), String(m.key)).toMatch(ALLOWED)
      }
    }
  })

  it('emits only the fields the contract defines', () => {
    for (const payload of published) {
      for (const m of payload as Array<Record<string, unknown>>) {
        for (const field of Object.keys(m)) {
          expect(['key', 'value', 'state', 'unit', 'date', 'provenance'], field).toContain(field)
        }
      }
    }
  })
})

describe('it does not publish on a render', () => {
  it('stays silent across repeated repaints', () => {
    /* A render is not an event in anybody's life. Publishing from one
       would write a payload every time a chart repainted. */
    const before = published.length
    for (let i = 0; i < 5; i++) run('render();')
    run('renderReadiness(); renderOverviewCards(); renderStatsPicker();')
    expect(published.length).toBe(before)
  })
})

describe('it publishes when a session is finished', () => {
  it('writes a payload on finish', () => {
    const before = published.length
    run(`
      (function(){
        var e = curSession().ex[0];
        e.log = [{ kg:185, reps:5 }, { kg:185, reps:5 }, { kg:185, reps:5 }];
        render();
        document.querySelector('#finishBtn').click();
        return true;
      })()`)
    expect(published.length).toBeGreaterThan(before)
  })

  it('reports the day as trained', () => {
    const latest = published[published.length - 1] as Array<Record<string, unknown>>
    const trained = latest.find((m) => m.key === 'trained')
    expect(trained?.state).toBe('trained')
    expect(trained?.date).toBe(today)
  })

  it('counts the hard sets that were logged', () => {
    const latest = published[published.length - 1] as Array<Record<string, unknown>>
    expect(latest.find((m) => m.key === 'hard_sets')?.value).toBe(3)
  })
})

describe('what crosses the boundary is what the host will accept', () => {
  it('passes the host validator with nothing rejected', () => {
    /* A metric the host drops was never published, however correct it
       looked on this side. */
    for (const payload of published) {
      const { metrics, rejected } = validatePublish(payload)
      expect(rejected, JSON.stringify(rejected)).toEqual([])
      expect(metrics.length).toBe((payload as unknown[]).length)
    }
  })

  it('carries provenance on every metric', () => {
    for (const payload of published) {
      for (const m of payload as Array<Record<string, unknown>>) {
        expect(['measured', 'derived', 'estimated'], m.key as string).toContain(m.provenance)
      }
    }
  })
})

describe('what never leaves the tile', () => {
  const blob = () => JSON.stringify(published)

  it('publishes no exercise name', () => {
    expect(blob()).not.toContain('bench_press')
    expect(blob()).not.toContain('Bench Press')
  })

  it('publishes nothing the athlete typed', () => {
    expect(blob()).not.toContain('shoulder')
    expect(blob()).not.toContain('twinge')
  })

  it('publishes no per-set detail', () => {
    expect(blob()).not.toContain('185')
    expect(blob()).not.toMatch(/"reps"/)
  })

  it('still published something', () => {
    /* The control for all three. */
    expect(published.flat().length).toBeGreaterThan(5)
  })
})

describe('the classifier guess travels as a guess', () => {
  it('marks a per-muscle figure estimated when the split was inferred', () => {
    /* The fixture's lift carries `primary: ['Chest']` — a name, not a
       contribution, which is what the classifier produces. */
    const latest = published[published.length - 1] as Array<Record<string, unknown>>
    const perMuscle = latest.filter((m) => String(m.key).startsWith('hard_sets.'))
    expect(perMuscle.length).toBeGreaterThan(0)
    for (const m of perMuscle) expect(m.provenance, m.key as string).toBe('estimated')
  })

  it('still calls the counted total measured', () => {
    const latest = published[published.length - 1] as Array<Record<string, unknown>>
    expect(latest.find((m) => m.key === 'hard_sets')?.provenance).toBe('measured')
  })
})
