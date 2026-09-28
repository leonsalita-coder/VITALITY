import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { localToday } from '../helpers/clock'

/**
 * Goal projection, driven through the real tile.
 *
 * The engine can be right about a trajectory and show nothing, so these
 * build real history, render the goals view, and read what a lifter would
 * actually see.
 */

const state = () => ({
  unit: 'lb', submitted: false,
  session: {
    date: localToday(),
    off: false, warmup: [], cooldown: [], ex: [],
  },
  history: {}, customLib: {}, exerciseNames: { bench: 'Bench Press', plank: 'Plank' },
  deloadStates: {}, finishedDates: [], templates: [], shortTermGoal: '', otherTraining: [],
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

/** Weekly sessions on `id`, climbing by `step` from `from`. */
const seed = (id: string, kind: string, from: number, step: number, weeks: number) => `
  (function(){
    STATE.customLib['${id}'] = { equipment:'Barbell', kind:'${kind}' };
    STATE.history['${id}'] = [];
    for (var i = 0; i < ${weeks}; i++) {
      var d = new Date(Date.now() - (${weeks} - 1 - i) * 7 * 86400000);
      var date = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0')
               + '-' + String(d.getDate()).padStart(2,'0');
      var v = ${from} + i * ${step};
      /* The set carries its own kind, exactly as the tile's rollup
         writes it — topWorkingSeconds reads the SET's kind, not the
         library's, so a fixture without it measures nothing. */
      var set = '${kind}' === 'time' ? { kind:'time', s: v } : { w: v, r: 5 };
      STATE.history['${id}'].push({ date: date, kg: ('${kind}'==='time'?0:v), sets: [set, set] });
    }
    return STATE.history['${id}'].length;
  })()`

describe('the fixture itself', () => {
  it('booted with the projector and the goal helpers', () => {
    expect(run('typeof TrainEngine.projectGoal')).toBe('function')
    expect(run('typeof goalProjectionFor')).toBe('function')
    expect(run('typeof goalSeriesFor')).toBe('function')
    expect(run(seed('bench', 'reps_weight', 200, 5, 10))).toBe(10)
  })
})

describe('a rising lift gets a date on screen', () => {
  it('projects it', () => {
    const proj = run(`
      (function(){
        ${seed('bench', 'reps_weight', 200, 5, 10)};
        STATE.liftGoals = [{ id:'bench', target: 320 }];
        return goalProjectionFor(STATE.liftGoals[0]);
      })()`)
    expect(proj).toBeTruthy()
    expect(proj.verdict).toBe('on_track')
    expect(proj.date).toBeTruthy()
  })

  it('renders the sentence into the goals view', () => {
    const html = run(`
      (function(){
        ${seed('bench', 'reps_weight', 200, 5, 10)};
        STATE.liftGoals = [{ id:'bench', target: 320 }];
        drawGoals();
        return document.querySelector('#statsPlot').innerHTML;
      })()`)
    expect(html).toContain('goalProj')
    expect(html).toMatch(/weeks? away/)
  })
})

describe('a stalled goal says so instead of guessing', () => {
  it('reports static, with no date', () => {
    const proj = run(`
      (function(){
        ${seed('bench', 'reps_weight', 225, 0, 10)};
        STATE.liftGoals = [{ id:'bench', target: 275 }];
        return goalProjectionFor(STATE.liftGoals[0]);
      })()`)
    expect(proj.verdict).toBe('static')
    expect(proj.date).toBeNull()
    expect(proj.text).toMatch(/hasn['’]t moved/i)
  })
})

describe('thin history renders nothing at all', () => {
  it('returns null rather than an empty row', () => {
    const proj = run(`
      (function(){
        ${seed('bench', 'reps_weight', 200, 5, 2)};
        STATE.liftGoals = [{ id:'bench', target: 320 }];
        return goalProjectionFor(STATE.liftGoals[0]);
      })()`)
    expect(proj).toBeNull()
  })

  it('renders the goal row without a projection line', () => {
    const html = run(`
      (function(){
        ${seed('bench', 'reps_weight', 200, 5, 2)};
        STATE.liftGoals = [{ id:'bench', target: 320 }];
        drawGoals();
        return document.querySelector('#statsPlot').innerHTML;
      })()`)
    expect(html).toContain('goalRow')
    expect(html).not.toContain('goalProj')
  })

  it('returns null for a lift with no history at all', () => {
    expect(run(`goalProjectionFor({ id:'nothing_here', target: 200 })`)).toBeNull()
  })
})

describe('a goal on a kind without e1RM projects in its own unit', () => {
  it('projects a plank in seconds', () => {
    const proj = run(`
      (function(){
        ${seed('plank', 'time', 60, 5, 10)};
        STATE.liftGoals = [{ id:'plank', target: 150 }];
        return goalProjectionFor(STATE.liftGoals[0]);
      })()`)
    expect(proj).toBeTruthy()
    expect(proj.text).toMatch(/seconds/)
    expect(proj.text).not.toMatch(/\blb\b/)
  })

  it('reads the plank series in seconds, not pounds', () => {
    const series = run(`goalSeriesFor('plank')`)
    expect(series.unit).toBe('seconds')
    expect(series.points.every((p: any) => p.value >= 60)).toBe(true)
  })
})
