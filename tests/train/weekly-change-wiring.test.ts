import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'

/**
 * The weekly change analysis, driven through the real tile.
 *
 * Two things can only be checked here: that every metric the engine reads
 * is actually SUPPLIED — an absent one reads as "no data" and is silently
 * never reported — and that a finding reaches the screen.
 */

const state = () => ({
  unit: 'lb', submitted: false,
  session: { date: new Date().toISOString().slice(0, 10), off: false, warmup: [], cooldown: [], ex: [] },
  history: {}, customLib: {}, exerciseNames: {}, deloadStates: {},
  finishedDates: [], templates: [], shortTermGoal: '', otherTraining: [],
  photos: [], sessionDurations: [], liftGoals: [], bodyweight: [],
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
      w.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })
      const noop = new Proxy({}, { get: () => () => noop })
      w.HTMLCanvasElement.prototype.getContext = () => noop
    },
  })
  await new Promise((r) => setTimeout(r, 700))
  run = (expr: string) => dom.window.eval(expr)
})

/** Four baseline weeks at `base` sets/week, this week at `now` sets. */
const seed = (base: number, now: number, sleepBase: number, sleepNow: number) => `
  (function(){
    STATE.customLib.bench = { primary:[{muscle:'chest',share:1}], kind:'reps_weight' };
    STATE.exerciseNames.bench = 'Bench Press';
    STATE.history.bench = []; STATE.finishedDates = []; STATE.vitalsDaily = [];
    var d = function(back){
      var x = new Date(Date.now() - back * 86400000);
      return x.getFullYear() + '-' + String(x.getMonth()+1).padStart(2,'0')
           + '-' + String(x.getDate()).padStart(2,'0');
    };
    var mk = function(back, sets){
      var s = []; for (var i=0;i<sets;i++) s.push({ w:185, r:5 });
      return { date: d(back), kg:185, sets: s };
    };
    for (var w = 1; w <= 4; w++) {
      STATE.history.bench.push(mk(w*7, ${base}/2), mk(w*7+3, ${base}/2));
      STATE.finishedDates.push(d(w*7), d(w*7+3));
    }
    STATE.history.bench.push(mk(1, ${now}/2), mk(4, ${now}/2));
    STATE.finishedDates.push(d(1), d(4));
    for (var i = 1; i <= 40; i++) {
      STATE.vitalsDaily.push({ date: d(i), sleepHours: i <= 8 ? ${sleepNow} : ${sleepBase} });
    }
    invalidateChange();
    return true;
  })()`

describe('the fixture itself', () => {
  it('booted with the engine and the context builder', () => {
    expect(run('typeof TrainEngine.weeklyChange')).toBe('function')
    expect(run('typeof changeContext')).toBe('function')
    expect(run('typeof weeklyChangeFor')).toBe('function')
  })
})

describe('every metric the engine reads is supplied', () => {
  /* A missing key is not an error — it reads as "no data" and that
     hypothesis silently never fires. This is the only place that can
     catch it. */
  it('supplies every field the context declares', () => {
    const ctx = run('changeContext()')
    for (const key of ['history', 'index', 'finishedDates', 'bodyweight',
      'otherTraining', 'vitals', 'deloadDates', 'layoffDates', 'now']) {
      expect(ctx[key], `missing ${key}`).toBeDefined()
    }
  })

  it('builds a real muscle index rather than an empty one', () => {
    const ctx = run(`(function(){ ${seed(8, 16, 6.4, 7.8)}; return changeContext(); })()`)
    expect(Object.keys(ctx.index).length).toBeGreaterThan(0)
  })

  it('collects deload dates from the state machine', () => {
    const dates = run(`
      (function(){
        STATE.deloadStates = { bench: { state:'deloading', since:'2026-09-15',
          kind:'intensity', confidence:'measured', priorWeight:185, sessions:0 } };
        var d = changeContext().deloadDates;
        STATE.deloadStates = {};
        return d;
      })()`)
    expect(dates).toEqual(['2026-09-15'])
  })
})

describe('a real finding reaches the screen', () => {
  it('produces one', () => {
    const finding = run(`(function(){ ${seed(8, 16, 6.4, 7.8)}; return weeklyChangeFor(); })()`)
    expect(finding).not.toBeNull()
    expect(finding.hypothesis).toBe('sleep_output')
  })

  it('renders into the weekly review', () => {
    const html = run(`
      (function(){
        ${seed(8, 16, 6.4, 7.8)};
        renderWeeklyReview();
        return document.querySelector('#weeklyReview').innerHTML;
      })()`)
    expect(html).toMatch(/7\.8/)
    expect(html).toMatch(/6\.4/)
    expect(html).not.toMatch(/because/i)
  })

  it('renders nothing extra on a quiet week', () => {
    const html = run(`
      (function(){
        ${seed(16, 16, 7, 7)};
        renderWeeklyReview();
        return changeLineHtml();
      })()`)
    expect(html).toBe('')
  })
})

describe('the memo does not outlive a change', () => {
  it('recomputes once a session is logged', () => {
    const differs = run(`
      (function(){
        ${seed(8, 16, 6.4, 7.8)};
        var first = weeklyChangeFor();
        ${seed(16, 16, 7, 7)};
        var second = weeklyChangeFor();
        return { first: !!first, second: !!second };
      })()`)
    expect(differs.first).toBe(true)
    expect(differs.second).toBe(false)
  })
})
