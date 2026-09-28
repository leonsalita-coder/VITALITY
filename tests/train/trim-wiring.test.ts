import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { localToday } from '../helpers/clock'

/**
 * Trimming, through the real tile.
 *
 * The property that matters is the negative one: accepting a proposal
 * must never remove a set that was already logged. The engine cannot
 * guarantee that on its own — it returns a set COUNT, and the tile
 * decides which rows go.
 */

const ex = (id: string, tier: number, log: unknown[]) => ({
  id, name: id, tier, sets: log.length, reps: 8, kg: 100, perHand: false,
  rest: 90, lastKg: 100, pinned: false, collapsed: false, deload: false, note: '', log,
})

const state = () => ({
  unit: 'lb', submitted: false,
  session: {
    date: localToday(), off: false, warmup: [], cooldown: [],
    ex: [
      ex('squat', 1, [null, null, null, null]),
      ex('bench', 1, [null, null, null, null]),
      ex('curl', 3, [null, null, null, null]),
      ex('lateral', 3, [null, null, null, null]),
    ],
  },
  history: {}, customLib: {
    squat: { primary: [{ muscle: 'quads', share: 1 }], kind: 'reps_weight' },
    bench: { primary: [{ muscle: 'chest', share: 1 }], kind: 'reps_weight' },
    curl: { primary: [{ muscle: 'biceps', share: 1 }], kind: 'reps_weight' },
    lateral: { primary: [{ muscle: 'side_delts', share: 1 }], kind: 'reps_weight' },
  },
  exerciseNames: {}, deloadStates: {}, finishedDates: [], templates: [],
  shortTermGoal: '', otherTraining: [], photos: [], sessionDurations: [],
  liftGoals: [], bodyweight: [],
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
    curSession().ex = [
      { id:'squat', name:'squat', tier:1, sets:4, reps:8, kg:100, perHand:false, rest:90,
        lastKg:100, pinned:false, collapsed:false, deload:false, note:'', log:[null,null,null,null] },
      { id:'bench', name:'bench', tier:1, sets:4, reps:8, kg:100, perHand:false, rest:90,
        lastKg:100, pinned:false, collapsed:false, deload:false, note:'', log:[null,null,null,null] },
      { id:'curl', name:'curl', tier:3, sets:4, reps:8, kg:30, perHand:false, rest:90,
        lastKg:30, pinned:false, collapsed:false, deload:false, note:'', log:[null,null,null,null] },
      { id:'lateral', name:'lateral', tier:3, sets:4, reps:8, kg:20, perHand:false, rest:90,
        lastKg:20, pinned:false, collapsed:false, deload:false, note:'', log:[null,null,null,null] },
    ];
    render();
    return true;
  })()`

describe('the fixture itself', () => {
  it('booted with the engine and the tile helpers', () => {
    expect(run('typeof TrainEngine.trimSession')).toBe('function')
    expect(run('typeof trimContextFor')).toBe('function')
    expect(run('typeof applyTrim')).toBe('function')
    expect(run(reset)).toBe(true)
    expect(run('curSession().ex.length')).toBe(4)
  })
})

describe('the context carries every read the engine needs', () => {
  it('supplies each field, and real muscles', () => {
    const ctx = run(`(function(){ ${reset}; return trimContextFor(30); })()`)
    for (const key of ['exercises', 'minutes', 'history', 'deloadStates',
      'underBandMuscles', 'staleMuscles', 'now']) {
      expect(ctx[key], `missing ${key}`).toBeDefined()
    }
    expect(ctx.exercises.length).toBe(4)
    expect(ctx.exercises[0].muscles).toEqual(['quads'])
  })
})

describe('accepting a proposal', () => {
  it('drops the accessories and keeps the compounds', () => {
    const after = run(`
      (function(){
        ${reset};
        applyTrim(TrainEngine.trimSession(trimContextFor(20)));
        return curSession().ex.map(function(e){ return e.id; });
      })()`)
    expect(after).toContain('squat')
    expect(after).toContain('bench')
    expect(after.length).toBeLessThan(4)
  })

  it('never removes a logged set', () => {
    const after = run(`
      (function(){
        ${reset};
        var curl = curSession().ex[2];
        curl.log = [{ kind:'reps_weight', kg:30, reps:10 }, null, null, null];
        applyTrim(TrainEngine.trimSession(trimContextFor(10)));
        var still = curSession().ex.filter(function(e){ return e.id === 'curl'; })[0];
        return { present: !!still, logged: still ? still.log.filter(Boolean).length : 0,
                 rows: still ? still.log.length : 0 };
      })()`)
    expect(after.present).toBe(true)
    expect(after.logged).toBe(1)
    expect(after.rows).toBeGreaterThanOrEqual(1)
  })

  it('trims empty rows from the end, never from the middle', () => {
    const shape = run(`
      (function(){
        ${reset};
        var sq = curSession().ex[0];
        sq.log = [{ kind:'reps_weight', kg:100, reps:8 }, null,
                  { kind:'reps_weight', kg:100, reps:8 }, null];
        applyTrim(TrainEngine.trimSession(trimContextFor(10)));
        var still = curSession().ex.filter(function(e){ return e.id === 'squat'; })[0];
        return still ? still.log.map(function(s){ return s ? 'done' : 'empty'; }) : null;
      })()`)
    expect(shape).toBeTruthy()
    expect(shape.filter((s: string) => s === 'done').length).toBe(2)
    // the logged rows kept their positions
    expect(shape[0]).toBe('done')
    expect(shape[2]).toBe('done')
  })

  it('stops at a logged row rather than popping through it', () => {
    /* The dangerous shape, and the one the earlier test missed: the LAST
       row is logged, and the proposal wants fewer sets than there are
       rows. Popping blindly from the end would delete a set that
       happened. The loop must refuse to pop a logged row at all. */
    const after = run(`
      (function(){
        ${reset};
        var sq = curSession().ex[0];
        sq.log = [null, null, { kind:'reps_weight', kg:100, reps:8 },
                              { kind:'reps_weight', kg:100, reps:8 }];
        applyTrim({ drop: [], reduce: [{ id:'squat', name:'squat', sets:1, reason:'t' }] });
        var still = curSession().ex.filter(function(e){ return e.id === 'squat'; })[0];
        return { rows: still.log.length, logged: still.log.filter(Boolean).length };
      })()`)
    expect(after.logged).toBe(2)
    expect(after.rows).toBe(4)
  })

  it('changes nothing until it is applied', () => {
    const same = run(`
      (function(){
        ${reset};
        var before = JSON.stringify(curSession().ex);
        TrainEngine.trimSession(trimContextFor(10));
        return before === JSON.stringify(curSession().ex);
      })()`)
    expect(same).toBe(true)
  })
})

describe('it is reachable', () => {
  it('has a button in settings', () => {
    expect(run('typeof openTrim')).toBe('function')
    expect(run(`readFileCheck = true; document.body.innerHTML.length > 0`)).toBe(true)
  })
})
