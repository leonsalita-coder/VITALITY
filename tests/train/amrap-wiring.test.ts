import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'

/**
 * AMRAP, driven through the real tile.
 *
 * The engine can read an all-out set perfectly and change nothing if the
 * flag never reaches a history row. So these go through the tile's own
 * logging path: arm the flag, log the set, read what was stored, and
 * check the next suggestion moved.
 */

const exercise = (id: string, name: string) => ({
  id, name, tier: 2, sets: 3, reps: 5, kg: 200, perHand: false,
  rest: 90, lastKg: 200, pinned: false, collapsed: false, deload: false,
  note: '', log: [null, null, null],
})

const state = () => ({
  unit: 'lb', submitted: false,
  session: {
    date: new Date().toISOString().slice(0, 10),
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

const reset = `
  (function(){
    STATE.history = {};
    STATE.customLib.bench = { equipment:'Barbell', kind:'reps_weight', incrementLb:5 };
    STATE.exerciseNames.bench = 'Bench Press';
    var ex = curSession().ex[0];
    ex.log = [null, null, null];
    ex.kg = 200; ex.lastKg = 200; ex.reps = 5; ex.sets = 3;
    for (var k in amrapArmed) delete amrapArmed[k];
    render();
    return true;
  })()`

describe('the fixture itself', () => {
  it('booted with the engine, the arm map and a rendered card', () => {
    expect(run('typeof TrainEngine.amrapSignal')).toBe('function')
    expect(run('typeof amrapArmed')).toBe('object')
    expect(run(reset)).toBe(true)
    expect(run("document.querySelectorAll('.pill').length")).toBe(3)
  })
})

describe('the flag is reachable, and only where it means something', () => {
  it('offers AMRAP on the last set', () => {
    run(reset)
    expect(run(`document.querySelectorAll('.pill')[2].querySelector('[data-act="amrap"]') !== null`)).toBe(true)
  })

  it('does not offer it on the first two', () => {
    expect(run(`document.querySelectorAll('.pill')[0].querySelector('[data-act="amrap"]')`)).toBeNull()
    expect(run(`document.querySelectorAll('.pill')[1].querySelector('[data-act="amrap"]')`)).toBeNull()
  })

  it('does not offer it on a plank, which has no reps to run out of', () => {
    const offered = run(`
      (function(){
        STATE.customLib.bench.kind = 'time';
        render();
        var last = document.querySelectorAll('.pill')[2];
        var has = last.querySelector('[data-act="amrap"]') !== null;
        STATE.customLib.bench.kind = 'reps_weight';
        render();
        return has;
      })()`)
    expect(offered).toBe(false)
  })
})

describe('arming it carries the flag into history', () => {
  it('stores amrap on the logged set', () => {
    const stored = run(`
      (function(){
        ${reset};
        var pills = document.querySelectorAll('.pill');
        pills[0].querySelector('.pillHit').click();
        pills[1].querySelector('.pillHit').click();
        var last = document.querySelectorAll('.pill')[2];
        last.querySelector('[data-act="amrap"]').click();
        document.querySelectorAll('.pill')[2].querySelector('.r').value = '12';
        document.querySelectorAll('.pill')[2].querySelector('.pillHit').click();
        return STATE.history.bench[0].sets;
      })()`)
    expect(stored.length).toBe(3)
    expect(stored[0].amrap).toBeUndefined()
    expect(stored[2].amrap).toBe(true)
    expect(stored[2].r).toBe(12)
  })

  it('an unarmed session stores no flag anywhere', () => {
    const stored = run(`
      (function(){
        ${reset};
        var pills = document.querySelectorAll('.pill');
        for (var i = 0; i < 3; i++) document.querySelectorAll('.pill')[i].querySelector('.pillHit').click();
        return STATE.history.bench[0].sets;
      })()`)
    expect(stored.every((s: any) => s.amrap === undefined)).toBe(true)
  })
})

describe('the flag changes the next suggestion, through the tile', () => {
  /** Two clean sessions, then a third whose AMRAP lands where we say. */
  const withAmrap = (amrapReps: number | null) => `
    (function(){
      ${reset};
      var mk = function(back, amrap){
        var d = new Date(Date.now() - back * 86400000);
        var date = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0')
                 + '-' + String(d.getDate()).padStart(2,'0');
        var sets = [{ w:200, r:5 }, { w:200, r:5 }];
        sets.push(amrap == null ? { w:200, r:5 } : { w:200, r:amrap, amrap:true });
        return { date: date, kg:200, sets: sets };
      };
      STATE.history.bench = [mk(15, null), mk(8, null), mk(1, ${amrapReps == null ? 'null' : amrapReps})];
      var ex = curSession().ex[0];
      return suggestionFor(ex, prescription(ex));
    })()`

  it('jumps more than one increment after a clearly under-loaded AMRAP', () => {
    const over = run(withAmrap(12))
    expect(over.weight).toBeGreaterThan(205)
    expect(over.reason).toMatch(/12 reps to failure/)
  })

  it('holds after an AMRAP that came in under target', () => {
    const under = run(withAmrap(3))
    expect(under.weight).toBe(200)
    expect(under.basis).toBe('amrap')
  })

  it('moves the ordinary increment with no AMRAP at all', () => {
    const plain = run(withAmrap(null))
    expect(plain.weight).toBe(205)
    expect(plain.basis).toBe('clean')
  })
})
