import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { localToday } from '../helpers/clock'

/** Acute vs chronic load through the real tile. */

const state = () => ({
  unit: 'lb', submitted: false,
  session: { date: localToday(), off: false, warmup: [], cooldown: [], ex: [] },
  history: {}, customLib: { bench: { primary: [{ muscle: 'chest', share: 1 }], kind: 'reps_weight' } },
  exerciseNames: { bench: 'Bench Press' }, deloadStates: {}, finishedDates: [],
  templates: [], shortTermGoal: '', otherTraining: [], photos: [],
  sessionDurations: [], liftGoals: [], bodyweight: [], predictions: {}, parameterResets: [],
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

/** Ten weeks of steady training, optionally with hard other training. */
const seed = (setsPer: number, otherDays: number) => `
  (function(){
    STATE.history.bench = []; STATE.otherTraining = [];
    var d = function(back){
      var x = new Date(Date.now() - back * 86400000);
      return x.getFullYear() + '-' + String(x.getMonth()+1).padStart(2,'0')
           + '-' + String(x.getDate()).padStart(2,'0');
    };
    for (var w = 0; w < 10; w++) {
      [0, 3].forEach(function(off){
        var sets = [];
        for (var i = 0; i < ${setsPer}; i++) sets.push({ w:100, r:8 });
        STATE.history.bench.push({ date: d(w*7 + off), kg:100, sets: sets });
      });
    }
    for (var i = 1; i <= ${otherDays}; i++) {
      STATE.otherTraining.push(TrainEngine.normalizeOtherEntry({
        date: d(i), activity:'martial_arts', minutes:120, intensity:9 }));
    }
    invalidateChange(); render();
    return STATE.history.bench.length;
  })()`

describe('the fixture itself', () => {
  it('booted with the load engine', () => {
    expect(run('typeof TrainEngine.acuteChronic')).toBe('function')
    expect(run('typeof TrainEngine.systemicLoadNote')).toBe('function')
    expect(run(seed(6, 0))).toBe(20)
  })
})

describe('the analysis path carries other training', () => {
  it('supplies it in the analysis options', () => {
    const opts = run(`(function(){ ${seed(6, 6)}; return analysisOptsFor(); })()`)
    expect(Array.isArray(opts.otherTraining)).toBe(true)
    expect(opts.otherTraining.length).toBe(6)
  })
})

describe('the whole-body reading reaches the coach', () => {
  it('speaks when a lot of other training lands on a steady block', async () => {
    const lines: string[] = (await run(`
      (function(){
        ${seed(6, 12)};
        return buildInsightContext(curSession()).then(function(c){ return c.lines; });
      })()`))
    const said = lines.filter((l) => /^LOAD:/.test(l)).join(' ')
    expect(said).toMatch(/set-equivalents/)
    expect(said).toMatch(/self-reported/i)
    expect(said).not.toMatch(/injur|should|risk/i)
  })

  it('says nothing on a steady block with no other training', async () => {
    const lines: string[] = (await run(`
      (function(){
        ${seed(6, 0)};
        return buildInsightContext(curSession()).then(function(c){ return c.lines; });
      })()`))
    expect(lines.some((l) => /^Streak:/.test(l))).toBe(true)
    expect(lines.filter((l) => /^LOAD:/.test(l))).toEqual([])
  })
})

describe('the per-muscle read stays lifting-only', () => {
  it('does not move when other training is added', () => {
    const both = run(`
      (function(){
        ${seed(6, 0)};
        var without = TrainEngine.acuteChronic({ history: STATE.history,
          index: TrainEngine.indexFrom(STATE.customLib), otherTraining: [], now: Date.now() });
        ${seed(6, 12)};
        var with_ = TrainEngine.acuteChronic({ history: STATE.history,
          index: TrainEngine.indexFrom(STATE.customLib), otherTraining: otherEntries(), now: Date.now() });
        return { a: without.byMuscle.chest.acute, b: with_.byMuscle.chest.acute,
                 sysA: without.systemic.acute, sysB: with_.systemic.acute };
      })()`)
    expect(both.b).toBe(both.a)
    expect(both.sysB).toBeGreaterThan(both.sysA)
  })
})
