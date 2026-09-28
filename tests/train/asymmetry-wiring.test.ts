import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { localToday } from '../helpers/clock'

/**
 * Per-limb logging through the real tile.
 *
 * Two properties can only be checked here: that four numbers reach a
 * history row, and that arming per-limb entry drops `perSide` so volume
 * is not doubled on top of already holding both sides.
 */

const state = () => ({
  unit: 'lb', submitted: false,
  session: {
    date: localToday(), off: false, warmup: [], cooldown: [],
    ex: [{
      id: 'split', name: 'Split Squat', tier: 2, sets: 3, reps: 8, kg: 50,
      perHand: false, rest: 90, lastKg: 50, pinned: false, collapsed: false,
      deload: false, note: '', log: [null, null, null],
    }],
  },
  history: {}, customLib: { split: { equipment: 'Dumbbell', kind: 'reps_weight', perSide: true } },
  exerciseNames: { split: 'Split Squat' }, deloadStates: {}, finishedDates: [],
  templates: [], shortTermGoal: '', otherTraining: [], photos: [],
  sessionDurations: [], liftGoals: [], bodyweight: [],
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
    STATE.history = {};
    STATE.customLib.split = { equipment:'Dumbbell', kind:'reps_weight', perSide:true };
    var ex = curSession().ex[0];
    ex.log = [null, null, null]; delete ex.ramp;
    for (var k in sidesArmed) delete sidesArmed[k];
    render();
    return true;
  })()`

describe('the fixture itself', () => {
  it('booted with the engine and a unilateral lift', () => {
    expect(run('typeof TrainEngine.asymmetryFor')).toBe('function')
    expect(run('typeof sidesArmed')).toBe('object')
    expect(run(reset)).toBe(true)
    expect(run("document.querySelectorAll('.pill').length")).toBe(3)
  })
})

describe('the L/R control is offered only where it means something', () => {
  it('appears on a unilateral weighted lift', () => {
    run(reset)
    expect(run(`document.querySelector('.pill [data-act="sides"]') !== null`)).toBe(true)
  })

  it('does not appear on a bilateral lift', () => {
    const has = run(`
      (function(){
        STATE.customLib.split.perSide = false; render();
        var yes = document.querySelector('.pill [data-act="sides"]') !== null;
        STATE.customLib.split.perSide = true; render();
        return yes;
      })()`)
    expect(has).toBe(false)
  })

  it('does not appear on a plank', () => {
    const has = run(`
      (function(){
        STATE.customLib.split.kind = 'time'; render();
        var yes = document.querySelector('.pill [data-act="sides"]') !== null;
        STATE.customLib.split.kind = 'reps_weight'; render();
        return yes;
      })()`)
    expect(has).toBe(false)
  })
})

describe('arming it swaps the row to four fields', () => {
  it('renders left and right inputs', () => {
    const fields = run(`
      (function(){
        ${reset};
        document.querySelector('.pill [data-act="sides"]').click();
        var row = document.querySelectorAll('.pill')[0];
        return {
          lw: !!row.querySelector('.lw'), lr: !!row.querySelector('.lrp'),
          rw: !!row.querySelector('.rw'), rr: !!row.querySelector('.rrp'),
          plain: !!row.querySelector('.w'),
        };
      })()`)
    expect(fields).toMatchObject({ lw: true, lr: true, rw: true, rr: true, plain: false })
  })
})

describe('logging per limb', () => {
  const logUneven = `
    (function(){
      ${reset};
      document.querySelector('.pill [data-act="sides"]').click();
      var row = document.querySelectorAll('.pill')[0];
      row.querySelector('.lw').value = '60'; row.querySelector('.lrp').value = '8';
      row.querySelector('.rw').value = '50'; row.querySelector('.rrp').value = '8';
      row.querySelector('.pillHit').click();
      return STATE.history.split[0].sets[0];
    })()`

  it('stores both sides', () => {
    const stored = run(logUneven)
    expect(stored.sides).toEqual({ left: { w: 60, r: 8 }, right: { w: 50, r: 8 } })
  })

  it('drops perSide, so volume is not doubled on top', () => {
    const stored = run(logUneven)
    expect(stored.perSide).toBeUndefined()
  })

  it('counts each limb once', () => {
    const load = run(`
      (function(){
        ${logUneven};
        return TrainEngine.workingVolume(STATE.history.split[0]).load;
      })()`)
    // 60×8 + 50×8 = 880, not 1760
    expect(load).toBe(880)
  })

  it('reads the weaker side as the working weight', () => {
    const top = run(`
      (function(){ ${logUneven}; return TrainEngine.topWorkingWeight(STATE.history.split[0]); })()`)
    expect(top).toBe(50)
  })
})

describe('a single number still behaves exactly as today', () => {
  it('stores one weight and keeps perSide doubling', () => {
    const stored = run(`
      (function(){
        ${reset};
        var row = document.querySelectorAll('.pill')[0];
        row.querySelector('.w').value = '50'; row.querySelector('.r').value = '8';
        row.querySelector('.pillHit').click();
        var set = STATE.history.split[0].sets[0];
        return { set: set, load: TrainEngine.workingVolume(STATE.history.split[0]).load };
      })()`)
    expect(stored.set.sides).toBeUndefined()
    expect(stored.set.perSide).toBe(true)
    expect(stored.load).toBe(800) // 50×8 doubled
  })
})

describe('the observation reaches the coach', () => {
  it('is reported once a gap is large and persistent', async () => {
    const lines: string[] = (await run(`
      (function(){
        ${reset};
        var mk = function(back){
          var d = new Date(Date.now() - back * 86400000);
          var date = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0')
                   + '-' + String(d.getDate()).padStart(2,'0');
          var sets = [];
          for (var i = 0; i < 3; i++) sets.push({ sides:{ left:{w:65,r:8}, right:{w:50,r:8} } });
          return { date: date, kg: 50, sets: sets };
        };
        STATE.history.split = [29,22,15,8,1].map(mk);
        return buildInsightContext(curSession()).then(function(c){ return c.lines; });
      })()`))
    const said = lines.filter((l) => /^SIDES/.test(l)).join(' ')
    expect(said).toMatch(/65/)
    expect(said).toMatch(/50/)
    expect(said).not.toMatch(/injur|should|imbalance/i)
  })

  it('says nothing for an even lifter', async () => {
    const lines: string[] = (await run(`
      (function(){
        ${reset};
        var mk = function(back){
          var d = new Date(Date.now() - back * 86400000);
          var date = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0')
                   + '-' + String(d.getDate()).padStart(2,'0');
          return { date: date, kg: 50, sets: [{ sides:{ left:{w:50,r:8}, right:{w:50,r:8} } }] };
        };
        STATE.history.split = [29,22,15,8,1].map(mk);
        return buildInsightContext(curSession()).then(function(c){ return c.lines; });
      })()`))
    expect(lines.some((l) => /^Streak:/.test(l))).toBe(true)
    expect(lines.filter((l) => /^SIDES/.test(l))).toEqual([])
  })
})
