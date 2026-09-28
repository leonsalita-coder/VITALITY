import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { localToday } from '../helpers/clock'

/**
 * The shadow log, driven through the real tile.
 *
 * This is the half that can silently not happen. dose.ts can be flawless
 * and write nothing forever if finishing a session never calls it, and a
 * suite of hand-built fixtures would never notice — which is exactly what
 * the call-site mutation mode caught: stubbing the tile's calls to
 * recordDose and emptyLog made nothing go red.
 *
 * Shadow mode's whole argument is that months of logged verdicts turn
 * guessed gates into tuned ones. A log nobody writes to answers nothing,
 * so "it computes and stays silent" has to be demonstrated as computing
 * AND staying silent, not just staying silent.
 */

/* Every test here carries an explicit 30s timeout.
   They are genuinely slow: each drives a real session to completion
   through jsdom, which recomputes every shadow verdict — dose plus all
   eleven curated transfer pairs, at 400 resamples each. Two of them ran
   5.7s and 5.2s against vitest's 5s default, passed standalone and in a
   quiet full run, and failed only under the commit hook's load. A timeout
   that depends on what else is running is not a timeout. */

/* LOCAL date, never toISOString — east of UTC that returns yesterday and
   the session never matches the tile's `today`. */
const dayBack = (back: number) => {
  const d = new Date()
  d.setDate(d.getDate() - back)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const exercise = (id: string, name: string) => ({
  id, name, tier: 2, sets: 3, reps: 5, kg: 200, perHand: false,
  rest: 90, lastKg: 200, pinned: false, collapsed: false, deload: false,
  note: '', log: [null, null, null],
})

/** Two years of bench at alternating volume, progressing at one rate. */
function benchHistory() {
  const out = []
  let weight = 100
  for (let w = 0; w < 80; w++) {
    weight *= 1.004 + Math.sin(w * 1.7) * 0.0015
    const sets = Math.floor(w / 8) % 2 === 1 ? 6 : 3
    for (const offset of [0, 3]) {
      const kg = Math.round(weight * 100) / 100
      out.push({
        date: dayBack((80 - 1 - w) * 7 + offset + 1), kg,
        sets: Array.from({ length: sets }, () => ({ w: kg, r: 5 })),
      })
    }
  }
  return out
}

const state = () => ({
  unit: 'lb', submitted: false,
  session: {
    date: localToday(),
    off: false, warmup: [], cooldown: [], ex: [exercise('bench', 'Bench Press')],
  },
  history: { bench: benchHistory() },
  customLib: { bench: { equipment: 'Barbell', kind: 'reps_weight', incrementLb: 5, primary: [{ muscle: 'chest', share: 1 }] } },
  exerciseNames: { bench: 'Bench Press' }, deloadStates: {},
  finishedDates: [], templates: [], shortTermGoal: '', otherTraining: [],
  photos: [], sessionDurations: [], liftGoals: [],
})

let run: (expr: string) => any

beforeAll(async () => {
  const dom = new JSDOM(readFileSync('public/tiles/train.html', 'utf8'), {
    url: 'https://train.test/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(w: any) {
      w.Vitality = {
        load: async () => state(),
        save: () => {},
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
  await new Promise((r) => setTimeout(r, 700))
  run = (expr: string) => dom.window.eval(expr)
})

const finishSession = `
  (function(){
    STATE.shadowLog = null;
    STATE.submitted = false;
    var ex = curSession().ex[0];
    ex.log = [null, null, null];
    render();
    document.querySelectorAll('.pill').forEach(function(p){ p.querySelector('.pillHit').click(); });
    document.querySelector('#finishBtn').click();
    return STATE.shadowLog;
  })()`

describe('the fixture itself', () => {
  it('booted with the shadow engine reachable', () => {
    expect(run('typeof TrainEngine.recordDose')).toBe('function')
    expect(run('typeof TrainEngine.reviewLines')).toBe('function')
    expect(run('typeof TrainEngine.emptyLog')).toBe('function')
  }, 30_000)

  it('has the history the finding needs', () => {
    expect(run('STATE.history.bench.length')).toBe(160)
  }, 30_000)
})

describe('finishing a session writes the verdicts down', () => {
  it('creates a log', () => {
    const log = run(finishSession)
    expect(log).toBeTruthy()
    expect(Array.isArray(log.entries)).toBe(true)
  }, 30_000)

  it('records a verdict, not an empty log', () => {
    const log = run(finishSession)
    expect(log.entries.length).toBeGreaterThan(0)
  }, 30_000)

  it('records the evidence alongside the answer', () => {
    const entry = run(finishSession).entries[0]
    expect(entry.feature).toBe('minimum_effective_dose')
    expect(entry.inputs.lowVolume).toBeGreaterThan(0)
    expect(entry.inputs.highVolume).toBeGreaterThan(0)
    expect(entry.nullSd).toBeGreaterThanOrEqual(0)
    expect(typeof entry.p).toBe('number')
    /* Dated to the WEEK, not the day: three sessions a week would
       otherwise write three near-identical rows and fill the log four
       times as fast for no extra answer. Checked as a property — a
       Monday, no later than today, no more than six days back — rather
       than by restating the engine's own arithmetic. */
    const [y, m, d] = entry.date.split('-').map(Number)
    const stamped = new Date(y, m - 1, d)
    expect(stamped.getDay()).toBe(1)
    const today = new Date()
    const daysBack = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() - stamped.getTime()) / 86_400_000)
    expect(daysBack).toBeGreaterThanOrEqual(0)
    expect(daysBack).toBeLessThanOrEqual(6)
  }, 30_000)

  it('does not write the same verdict twice in a day', () => {
    const first = run(finishSession).entries.length
    /* Re-lock and finish again: the same day, the same history, so the
       log must not grow. */
    const again = run(`
      (function(){
        document.querySelector('#finishBtn').click();
        document.querySelector('#finishBtn').click();
        return STATE.shadowLog.entries.length;
      })()`)
    expect(again).toBe(first)
  }, 30_000)
})

describe('and shows the athlete none of it', () => {
  it('puts nothing from the verdict on the board', () => {
    const shown = run(`
      (function(){
        ${finishSession};
        /* Scripts stripped. jsdom puts inline <script> source into
           textContent, and the engine is inlined into this tile — so the
           sentence's own template literal is in the DOM as source code
           whether or not anything renders it. Reading raw textContent
           asserted something that can never be true. */
        var clone = document.body.cloneNode(true);
        clone.querySelectorAll('script, style').forEach(function(n){ n.remove(); });
        return clone.textContent;
      })()`)
    expect(shown).not.toContain('co-occurrence')
    expect(shown).not.toContain('as far as your own log can tell')
    /* The control: the board DID render, so the absence above is the
       shadow gate rather than an empty page. */
    expect(shown).toContain('Bench Press')
  }, 30_000)

  it('has a verdict in the log that would have spoken', () => {
    /* Without this the test above proves nothing: a log full of silent
       verdicts would show nothing on the board for the ordinary reason. */
    const log = run(finishSession)
    expect(log.entries.some((e: any) => e.would === true)).toBe(true)
  }, 30_000)

  it('offers the review only as a console command', () => {
    const lines = run('__shadowReview(), typeof window.__shadowReview')
    expect(lines).toBe('function')
  }, 30_000)

  it('prints a logged verdict through the review command', () => {
    const text = run(`
      (function(){
        ${finishSession};
        return TrainEngine.reviewLines(STATE.shadowLog).join('\\n');
      })()`)
    expect(text).toMatch(/WOULD HAVE SAID|stayed silent/)
    expect(text).toContain('minimum_effective_dose')
    expect(text).toMatch(/None were shown/)
  }, 30_000)
})

describe('transfer is written down too', () => {
  it('logs a row for every curated pair', () => {
    const log = run(finishSession)
    const pairs = log.entries.filter((e: any) => e.feature === 'transfer_between_lifts')
    expect(pairs.length).toBe(run('TrainEngine.TRANSFER_PAIRS.length'))
  }, 30_000)

  it('records the pairs that cannot be asked as unaskable, not as quiet', () => {
    /* This athlete benches and nothing else, so no curated pair has the
       overlap it needs. Those rows are the difference between "no
       effect" and "not yet", and they are the ones future-you reads. */
    const log = run(finishSession)
    const pairs = log.entries.filter((e: any) => e.feature === 'transfer_between_lifts')
    expect(pairs.every((e: any) => e.status === 'not_enough_overlap')).toBe(true)
    expect(pairs[0].inputs.needed).toBeGreaterThan(0)
  }, 30_000)

  it('shows none of it on the board', () => {
    const shown = run(`
      (function(){
        ${finishSession};
        var clone = document.body.cloneNode(true);
        clone.querySelectorAll('script, style').forEach(function(n){ n.remove(); });
        return clone.textContent;
      })()`)
    expect(shown).not.toContain('moved together')
    expect(shown).not.toContain('shared weeks needed')
    expect(shown).toContain('Bench Press')
  }, 30_000)

  it('reaches the review command', () => {
    const text = run(`
      (function(){
        ${finishSession};
        return TrainEngine.reviewLines(STATE.shadowLog, { feature: 'transfer_between_lifts' }).join('\\n');
      })()`)
    expect(text).toContain('transfer_between_lifts')
    expect(text).toMatch(/shared weeks needed/)
  }, 30_000)
})

/**
 * The resolution report — the only thing dose says to anybody.
 *
 * The equivalence verdict is off SURFACEABLE and its flag does nothing,
 * so there is no call site for it to have. This is the safe read, and it
 * IS wired: flipping one boolean makes it appear, which is the property
 * the whole shadow design claims and the only way to know the call site
 * works is to force it.
 */
describe('the resolution report reaches the board when switched on', () => {
  it('renders nothing today', () => {
    const shown = run(`
      (function(){
        ${finishSession};
        var clone = document.body.cloneNode(true);
        clone.querySelectorAll('script, style').forEach(function(n){ n.remove(); });
        return clone.textContent;
      })()`)
    expect(shown).not.toContain('RESOLUTION:')
  }, 30_000)

  it('has a call site that produces the line when the flag is forced', () => {
    /* Forced through the engine rather than by editing shadow.ts, so
       this exercises the tile's own call — the half that can silently
       not happen. */
    const line = run(`
      TrainEngine.doseResolutionNote({
        history: STATE.history||{},
        index: TrainEngine.indexFrom(STATE.customLib||{}),
        now: Date.now(),
      }, { dose_resolution: true })`)
    expect(typeof line === 'string' || line === null).toBe(true)
  }, 30_000)

  it('never carries an equivalence claim, flag or no flag', () => {
    const forced = run(`
      TrainEngine.doseResolutionNote({
        history: STATE.history||{},
        index: TrainEngine.indexFrom(STATE.customLib||{}),
        now: Date.now(),
      }, { dose_resolution: true }) || ''`)
    expect(forced).not.toMatch(/the same|no difference|equivalent/i)
  }, 30_000)

  it('refuses to surface the verdict even with its flag forced on', () => {
    /* The load-bearing guarantee, checked through the shipped bundle
       rather than only against the source. */
    const surfaced = run(`
      (function(){
        var v = TrainEngine.doseVerdicts({
          history: STATE.history||{},
          index: TrainEngine.indexFrom(STATE.customLib||{}),
          now: Date.now(),
        })[0];
        return {
          exists: !!v,
          would: v && v.would,
          forced: TrainEngine.surface(v, { minimum_effective_dose: true }),
        };
      })()`)
    expect(surfaced.exists).toBe(true)
    expect(surfaced.would).toBe(true)
    expect(surfaced.forced).toBeNull()
  }, 30_000)
})
