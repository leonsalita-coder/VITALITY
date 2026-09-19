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
 * Simulation through the real tile.
 *
 * The property only checkable here: running a projection must not touch
 * history, predictions, or anything else the app reads for real.
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
  history: {}, customLib: { bench: { kind: 'reps_weight', incrementLb: 5, primary: [{ muscle: 'chest', share: 1 }] } },
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

const seed = `
  (function(){
    STATE.history.bench = [];
    for (var i = 4; i >= 1; i--) {
      var d = new Date(Date.now() - i * 7 * 86400000);
      var date = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0')
               + '-' + String(d.getDate()).padStart(2,'0');
      STATE.history.bench.push({ date: date, kg: 200,
        sets: [{w:200,r:5},{w:200,r:5},{w:200,r:5}] });
    }
    setSessionMode('edit'); render();
    return STATE.history.bench.length;
  })()`

describe('the fixture itself', () => {
  it('booted with the simulator and a scenario builder', () => {
    expect(run('typeof TrainEngine.simulate')).toBe('function')
    expect(run('typeof simScenarioFor')).toBe('function')
    expect(run('typeof openSimulate')).toBe('function')
    expect(run(seed)).toBe(4)
  })
})

describe('the scenario is built from the real lift', () => {
  it('carries the lift, its muscles and its increment', () => {
    const s = run(`simScenarioFor('x', 3, curSession().ex[0])`)
    expect(s.exercise.id).toBe('bench')
    expect(s.exercise.muscles).toEqual(['chest'])
    expect(s.exercise.incrementLb).toBe(5)
    expect(s.sessionsPerWeek).toBe(3)
  })
})

describe('running a projection touches nothing real', () => {
  it('leaves history, predictions and the session unchanged', () => {
    const same = run(`
      (function(){
        ${seed};
        var before = JSON.stringify({ h: STATE.history, p: STATE.predictions,
                                      s: curSession().ex });
        TrainEngine.compareScenarios(historyBeforeToday(curSession().ex[0]),
          simScenarioFor('a', 3, curSession().ex[0]),
          simScenarioFor('b', 5, curSession().ex[0]), Date.now());
        return before === JSON.stringify({ h: STATE.history, p: STATE.predictions,
                                           s: curSession().ex });
      })()`)
    expect(same).toBe(true)
  })

  it('projects more volume for more days a week', () => {
    const diff = run(`
      (function(){
        ${seed};
        return TrainEngine.compareScenarios(historyBeforeToday(curSession().ex[0]),
          simScenarioFor('3 days', 3, curSession().ex[0]),
          simScenarioFor('5 days', 5, curSession().ex[0]), Date.now());
      })()`)
    expect(diff.volumeDelta.chest).toBeGreaterThan(0)
    expect(diff.text).toMatch(/project/i)
  })

  it('marks every projected session', () => {
    const flags = run(`
      (function(){
        ${seed};
        var p = TrainEngine.simulate(historyBeforeToday(curSession().ex[0]),
          simScenarioFor('x', 3, curSession().ex[0]), Date.now());
        return { top: p.projected, all: p.sessions.every(function(s){ return s.projected === true; }) };
      })()`)
    expect(flags.top).toBe(true)
    expect(flags.all).toBe(true)
  })
})

describe('it is reachable from the card, in edit mode only', () => {
  it('has a What if control in edit mode', () => {
    run(`${seed}; setSessionMode('edit'); render();`)
    expect(run(`document.querySelector('.ex [data-act="whatif"]') !== null`)).toBe(true)
  })

  it('has none in training mode', () => {
    run(`setSessionMode('training'); render();`)
    expect(run(`document.querySelector('.ex [data-act="whatif"]')`)).toBeNull()
    run(`setSessionMode('edit'); render();`)
  })
})
