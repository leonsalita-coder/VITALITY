import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'

/* LOCAL date, never toISOString — see docs/train-verification.md. */
const localToday = () => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * Fitted parameters through the real tile.
 *
 * The property that matters: a user below the gate gets EXACTLY today's
 * engine. That cannot be checked in the engine alone, because the tile
 * decides what reaches progression.
 */

const state = () => ({
  unit: 'lb', submitted: false,
  session: {
    date: localToday(), off: false, warmup: [], cooldown: [],
    ex: [{
      id: 'back_squat', name: 'Back Squat', tier: 1, sets: 2, reps: 5, kg: 300,
      perHand: false, rest: 180, lastKg: 300, pinned: false, collapsed: false,
      deload: false, note: '', log: [null, null],
    }],
  },
  history: {}, customLib: { back_squat: { equipment: 'barbell', kind: 'reps_weight' } },
  exerciseNames: { back_squat: 'Back Squat' }, deloadStates: {}, finishedDates: [],
  templates: [], shortTermGoal: '', otherTraining: [], photos: [],
  sessionDurations: [], liftGoals: [], bodyweight: [], predictions: {},
  parameterResets: [],
})

let run: (expr: string) => any

beforeAll(async () => {
  const dom = new JSDOM(readFileSync('public/tiles/train.html', 'utf8'), {
    url: 'https://train.test/', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w: any) {
      w.Vitality = {
        load: async () => state(), save: () => {},
        read: async () => { throw new Error('no vitals') },
        classify: async () => { throw new Error('no_key') },
        getInsight: async () => { throw new Error('no_key') },
        generateWorkout: async () => { throw new Error('no_key') },
      }
      w.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })
      const noop = new Proxy({}, { get: () => () => noop })
      w.HTMLCanvasElement.prototype.getContext = () => noop
    },
  })
  await new Promise((r) => setTimeout(r, 700))
  run = (expr: string) => dom.window.eval(expr)
})

/** `n` weekly sessions on back squat climbing by `step`. */
const seed = (n: number, step: number) => `
  (function(){
    STATE.history.back_squat = [];
    STATE.parameterResets = [];
    delete STATE.customLib.back_squat.incrementLb;
    for (var i = 0; i < ${n}; i++) {
      var d = new Date(Date.now() - (${n} - 1 - i) * 7 * 86400000);
      var date = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0')
               + '-' + String(d.getDate()).padStart(2,'0');
      var w = 200 + i * ${step};
      STATE.history.back_squat.push({ date: date, kg: w, sets: [{w:w,r:5},{w:w,r:5}] });
    }
    invalidateFitted(); clearSuggestions(); render();
    return STATE.history.back_squat.length;
  })()`

describe('the fixture itself', () => {
  it('booted with the fitter', () => {
    expect(run('typeof TrainEngine.fitParameters')).toBe('function')
    expect(run('typeof fittedParams')).toBe('function')
    expect(run(seed(12, 10))).toBe(12)
  })
})

describe('below the gate the engine is exactly today’s', () => {
  it('fits nothing from a thin history', () => {
    run(seed(3, 10))
    expect(run('fittedParams().fitted')).toBe(false)
  })

  it('leaves the increment undefined, as before', () => {
    run(seed(3, 10))
    expect(run(`incrementFor(curSession().ex[0])`)).toBeUndefined()
  })
})

describe('a clear pattern reaches progression', () => {
  it('fits a larger increment for a fast-moving squat', () => {
    run(seed(12, 10))
    expect(run('fittedParams().fitted')).toBe(true)
    expect(run(`incrementFor(curSession().ex[0])`)).toBeGreaterThan(5)
  })

  it('changes the weight the lift actually suggests', () => {
    const weights = run(`
      (function(){
        ${seed(12, 10)};
        var ex = curSession().ex[0];
        var fittedW = suggestionFor(ex, prescription(ex)).weight;
        STATE.parameterResets = ['squat'];
        invalidateFitted(); clearSuggestions();
        var defaultW = suggestionFor(ex, prescription(ex)).weight;
        return { fitted: fittedW, reset: defaultW };
      })()`)
    expect(weights.fitted).toBeGreaterThan(weights.reset)
  })
})

describe('an explicit increment always wins', () => {
  it('uses what the athlete set, not what was fitted', () => {
    const got = run(`
      (function(){
        ${seed(12, 10)};
        STATE.customLib.back_squat.incrementLb = 2.5;
        return incrementFor(curSession().ex[0]);
      })()`)
    expect(got).toBe(2.5)
  })
})

describe('a reset stays reset', () => {
  it('does not quietly refit on the next render', () => {
    const after = run(`
      (function(){
        ${seed(12, 10)};
        STATE.parameterResets = ['squat'];
        invalidateFitted(); render(); render();
        return { fitted: fittedParams().fitted, inc: incrementFor(curSession().ex[0]) };
      })()`)
    expect(after.fitted).toBe(false)
    expect(after.inc).toBeUndefined()
  })
})

describe('the coach is told what was fitted', () => {
  it('reports it with the sample size', async () => {
    const lines: string[] = (await run(`
      (function(){
        ${seed(12, 10)};
        return buildInsightContext(curSession()).then(function(c){ return c.lines; });
      })()`))
    const said = lines.filter((l) => /FITTED TO YOU/.test(l)).join(' ')
    expect(said).toMatch(/squat/i)
    expect(said).toMatch(/observed jumps/)
  })

  it('says nothing when nothing was fitted', async () => {
    const lines: string[] = (await run(`
      (function(){
        ${seed(3, 10)};
        return buildInsightContext(curSession()).then(function(c){ return c.lines; });
      })()`))
    expect(lines.some((l) => /^Streak:/.test(l))).toBe(true)
    expect(lines.filter((l) => /FITTED TO YOU/.test(l))).toEqual([])
  })
})
