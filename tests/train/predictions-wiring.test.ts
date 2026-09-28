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
 * Self-grading through the real tile.
 *
 * The property that can only be checked here: a prediction is written
 * BEFORE any work is logged, and survives re-render, reload and the
 * outcome itself unchanged.
 */

const state = () => ({
  unit: 'lb', submitted: false,
  session: {
    date: localToday(), off: false, warmup: [], cooldown: [],
    ex: [{
      id: 'bench', name: 'Bench Press', tier: 1, sets: 3, reps: 5, kg: 200,
      perHand: false, rest: 120, lastKg: 200, pinned: false, collapsed: false,
      deload: false, note: '', log: [null, null, null],
    }],
  },
  history: {}, customLib: { bench: { kind: 'reps_weight', incrementLb: 5 } },
  exerciseNames: { bench: 'Bench Press' }, deloadStates: {}, finishedDates: [],
  templates: [], shortTermGoal: '', otherTraining: [], photos: [],
  sessionDurations: [], liftGoals: [], bodyweight: [], predictions: {},
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

const reset = `
  (function(){
    STATE.history = {}; STATE.predictions = {};
    var ex = curSession().ex[0];
    ex.log = [null, null, null]; ex.kg = 200; ex.lastKg = 200; delete ex.ramp;
    clearSuggestions(); render();
    return true;
  })()`

describe('the fixture itself', () => {
  it('booted with the engine and the recorder', () => {
    expect(run('typeof TrainEngine.recordPrediction')).toBe('function')
    expect(run('typeof recordPredictionFor')).toBe('function')
    expect(run('typeof accuracyNow')).toBe('function')
    expect(run(reset)).toBe(true)
  })
})

describe('a prediction is written before any work', () => {
  it('exists as soon as the card renders', () => {
    const stored = run(`(function(){ ${reset}; return STATE.predictions; })()`)
    const keys = Object.keys(stored)
    expect(keys.length).toBe(1)
    expect(stored[keys[0]]).toMatchObject({ id: 'bench', weight: expect.any(Number) })
  })

  it('records the basis and the state it was made under', () => {
    const p = run(`(function(){ ${reset}; return Object.values(STATE.predictions)[0]; })()`)
    expect(typeof p.basis).toBe('string')
    expect(p.readiness).toBeTruthy()
    expect(p.madeAt).toBeGreaterThan(0)
  })
})

describe('it is never rewritten', () => {
  it('survives logging the work', () => {
    const same = run(`
      (function(){
        ${reset};
        var before = JSON.stringify(Object.values(STATE.predictions)[0]);
        for (var i = 0; i < 3; i++) {
          document.querySelectorAll('.pill')[i].querySelector('.pillHit').click();
        }
        return { before: before, after: JSON.stringify(Object.values(STATE.predictions)[0]),
                 count: Object.keys(STATE.predictions).length };
      })()`)
    expect(same.after).toBe(same.before)
    expect(same.count).toBe(1)
  })

  it('survives a re-render after the outcome is known', () => {
    const same = run(`
      (function(){
        var before = JSON.stringify(STATE.predictions);
        clearSuggestions(); render(); render();
        return before === JSON.stringify(STATE.predictions);
      })()`)
    expect(same).toBe(true)
  })

  it('is not replaced by a later, better-looking suggestion', () => {
    const kept = run(`
      (function(){
        var key = Object.keys(STATE.predictions)[0];
        var original = STATE.predictions[key].weight;
        TrainEngine.recordPrediction(STATE.predictions, {
          id:'bench', date: sessionDate(), weight: 999, reps: 5, seconds:null,
          metres:null, basis:'clean', deloadState:null, readiness:'normal', madeAt: Date.now() });
        return { original: original, now: STATE.predictions[key].weight };
      })()`)
    expect(kept.now).toBe(kept.original)
  })
})

describe('the outcome is scored against it', () => {
  it('scores a met prediction as a hit', () => {
    const acc = run(`
      (function(){
        ${reset};
        for (var i = 0; i < 3; i++) {
          document.querySelectorAll('.pill')[i].querySelector('.pillHit').click();
        }
        return accuracyNow();
      })()`)
    expect(acc.total).toBe(1)
    expect(acc.hit).toBe(1)
    expect(acc.rate).toBe(1)
  })

  it('scores a short session as missed high', () => {
    const acc = run(`
      (function(){
        ${reset};
        var row = document.querySelectorAll('.pill')[0];
        row.querySelector('.r').value = '2';
        row.querySelector('.pillHit').click();
        return accuracyNow();
      })()`)
    expect(acc.missedHigh).toBe(1)
    expect(acc.whenWrong).toMatch(/high/i)
  })

  it('does not count an untrained lift against the rate', () => {
    const acc = run(`(function(){ ${reset}; return accuracyNow(); })()`)
    expect(acc.total).toBe(0)
    expect(acc.notAttempted).toBe(1)
    expect(acc.rate).toBeNull()
  })
})

describe('the coach is told, and only with enough scored', () => {
  it('says nothing below five scored predictions', async () => {
    const lines: string[] = (await run(`
      (function(){
        ${reset};
        return buildInsightContext(curSession()).then(function(c){ return c.lines; });
      })()`))
    expect(lines.some((l) => /^Streak:/.test(l))).toBe(true)
    expect(lines.filter((l) => /MY OWN ACCURACY/.test(l))).toEqual([])
  })

  it('reports the rate once there is a record', async () => {
    const lines: string[] = (await run(`
      (function(){
        ${reset};
        var d = function(back){
          var x = new Date(Date.now() - back * 86400000);
          return x.getFullYear() + '-' + String(x.getMonth()+1).padStart(2,'0')
               + '-' + String(x.getDate()).padStart(2,'0');
        };
        STATE.history.bench = []; STATE.predictions = {};
        for (var i = 1; i <= 8; i++) {
          STATE.predictions[d(i) + ':bench'] = { id:'bench', date:d(i), weight:200, reps:5,
            seconds:null, metres:null, basis:'clean', deloadState:null,
            readiness:'normal', madeAt: 1 };
          STATE.history.bench.push({ date:d(i), kg:200, sets:[{w:200,r:5},{w:200,r:5}] });
        }
        return buildInsightContext(curSession()).then(function(c){ return c.lines; });
      })()`))
    const said = lines.filter((l) => /MY OWN ACCURACY/.test(l)).join(' ')
    expect(said).toMatch(/100%/)
    expect(said).toMatch(/8 suggestions/)
  })

  /* Unguarded callsite: nothing previously exercised buildInsightContext
     with accuracy bad enough to trigger TrainEngine.progressionDamping's
     truthy branch (rate < 60%, mostly missed high, >=10 scored) — every
     existing fixture here is a clean 100% hit rate, so stubbing that
     callsite out changed nothing any test could see. */
  it('eases off when accuracy is poor and the misses are mostly high', async () => {
    const lines: string[] = (await run(`
      (function(){
        ${reset};
        var d = function(back){
          var x = new Date(Date.now() - back * 86400000);
          return x.getFullYear() + '-' + String(x.getMonth()+1).padStart(2,'0')
               + '-' + String(x.getDate()).padStart(2,'0');
        };
        STATE.history.bench = []; STATE.predictions = {};
        for (var i = 1; i <= 10; i++) {
          /* Predicted 250, only ever loaded 200 — loaded < targetWeight
             is scored missed_high regardless of reps, so all ten miss
             the same direction. */
          STATE.predictions[d(i) + ':bench'] = { id:'bench', date:d(i), weight:250, reps:5,
            seconds:null, metres:null, basis:'clean', deloadState:null,
            readiness:'normal', madeAt: 1 };
          STATE.history.bench.push({ date:d(i), kg:200, sets:[{w:200,r:5},{w:200,r:5}] });
        }
        return buildInsightContext(curSession()).then(function(c){ return c.lines; });
      })()`))
    const said = lines.filter((l) => /^SELF-CORRECTION:/.test(l)).join(' ')
    expect(said).toMatch(/Easing off/)
    expect(said).toMatch(/missed 10 of the last 10/)
  })
})
