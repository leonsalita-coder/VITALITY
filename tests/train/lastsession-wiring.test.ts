import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { localToday } from '../helpers/clock'

/**
 * Last session inline, driven through the real tile.
 *
 * The entire point of this piece is that it is VISIBLE beside the prefill
 * mid-session. An engine function returning perfect data that never
 * reaches the card would leave History exactly as expensive as it was.
 */

const exercise = (id: string, name: string) => ({
  id, name, tier: 2, sets: 3, reps: 5, kg: 190, perHand: false,
  rest: 90, lastKg: 185, pinned: false, collapsed: false, deload: false,
  note: '', log: [null, null, null],
})

const state = () => ({
  unit: 'lb', submitted: false,
  session: {
    date: localToday(),
    off: false, warmup: [], cooldown: [], ex: [exercise('bench', 'Bench Press')],
  },
  history: {}, customLib: {}, exerciseNames: {}, deloadStates: {},
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

/** A session `back` days ago with the given sets. */
const seed = (back: number, sets: string) => `
  (function(){
    STATE.customLib.bench = { equipment:'Barbell', kind:'reps_weight', incrementLb:5 };
    STATE.exerciseNames.bench = 'Bench Press';
    var d = new Date(Date.now() - ${back} * 86400000);
    var date = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0')
             + '-' + String(d.getDate()).padStart(2,'0');
    STATE.history.bench = [{ date: date, kg: 185, sets: ${sets} }];
    var ex = curSession().ex[0]; ex.log = [null, null, null]; delete ex.ramp;
    render();
    return true;
  })()`

describe('the fixture itself', () => {
  it('booted with the engine and the formatter', () => {
    expect(run('typeof TrainEngine.lastSessionFor')).toBe('function')
    expect(run('typeof lastSessionText')).toBe('function')
    expect(run(seed(3, '[{w:185,r:8},{w:185,r:8},{w:185,r:7}]'))).toBe(true)
  })
})

describe('it renders beside the prefill', () => {
  it('appears on the card', () => {
    run(seed(3, '[{w:185,r:8},{w:185,r:8},{w:185,r:7}]'))
    const text = run(`
      (function(){
        var el = document.querySelector('.pillLast');
        return el ? el.textContent : null;
      })()`)
    expect(text).toBeTruthy()
    expect(text).toContain('Last time')
    expect(text).toContain('185×8')
  })

  it('collapses repeated weights the way a lifter would say them', () => {
    run(seed(3, '[{w:185,r:8},{w:185,r:8},{w:185,r:7}]'))
    expect(run("document.querySelector('.pillLast').textContent"))
      .toBe('Last time (3 days ago): 185×8, 8, 7')
  })

  it('says yesterday rather than 1 days ago', () => {
    run(seed(1, '[{w:185,r:5}]'))
    expect(run("document.querySelector('.pillLast').textContent")).toContain('yesterday')
  })

  it('appears only once, on the next unlogged set', () => {
    run(seed(3, '[{w:185,r:8}]'))
    expect(run("document.querySelectorAll('.pillLast').length")).toBe(1)
  })

  it('moves down as sets are logged', () => {
    const where = run(`
      (function(){
        ${seed(3, '[{w:185,r:8}]')};
        document.querySelectorAll('.pill')[0].querySelector('.pillHit').click();
        var pills = [].slice.call(document.querySelectorAll('.pill'));
        var last = document.querySelector('.pillLast');
        return { count: document.querySelectorAll('.pillLast').length, present: !!last };
      })()`)
    expect(where.count).toBe(1)
    expect(where.present).toBe(true)
  })
})

describe('nothing renders when there is nothing to show', () => {
  it('renders no element at all with no history', () => {
    run(`(function(){
      STATE.history = {};
      var ex = curSession().ex[0]; ex.log = [null,null,null];
      render(); return true;
    })()`)
    expect(run("document.querySelector('.pillLast')")).toBeNull()
  })

  it('renders nothing when last session was all warm-ups', () => {
    run(seed(3, '[{w:95,r:10,warmup:true}]'))
    expect(run("document.querySelector('.pillLast')")).toBeNull()
  })
})

describe('the shape follows the kind, on the card', () => {
  it('shows seconds for a plank and no weight', () => {
    run(`(function(){
      STATE.customLib.bench = { equipment:'Bodyweight', kind:'time' };
      var d = new Date(Date.now() - 2 * 86400000);
      var date = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0')
               + '-' + String(d.getDate()).padStart(2,'0');
      STATE.history.bench = [{ date: date, kg: 0, sets: [{kind:'time',s:60},{kind:'time',s:55}] }];
      var ex = curSession().ex[0]; ex.log = [null,null,null];
      render(); return true;
    })()`)
    const text = run("document.querySelector('.pillLast').textContent")
    expect(text).toContain('60s')
    expect(text).toContain('55s')
    expect(text).not.toMatch(/×/)
  })

  it('marks a missed set and an all-out one', () => {
    run(`(function(){
      STATE.customLib.bench = { equipment:'Barbell', kind:'reps_weight' };
      var d = new Date(Date.now() - 2 * 86400000);
      var date = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0')
               + '-' + String(d.getDate()).padStart(2,'0');
      STATE.history.bench = [{ date: date, kg: 185, sets: [
        {w:185,r:8}, {w:185,r:2,fail:true}, {w:185,r:12,amrap:true} ] }];
      var ex = curSession().ex[0]; ex.log = [null,null,null];
      render(); return true;
    })()`)
    const text = run("document.querySelector('.pillLast').textContent")
    expect(text).toContain('✗')
    expect(text).toContain('+')
  })
})
