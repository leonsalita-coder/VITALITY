import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'

/**
 * The warm-up ramp, driven through the real tile.
 *
 * The property that matters is not that a ramp appears — it is that the
 * ramp's sets are invisible to every downstream read WITHOUT the lifter
 * doing anything. So these log a full session including a generated ramp
 * and then check what the history actually contains.
 */

const exercise = (id: string, name: string, kg: number) => ({
  id, name, tier: 2, sets: 3, reps: 5, kg, perHand: false,
  rest: 90, lastKg: kg, pinned: false, collapsed: false, deload: false,
  note: '', log: [null, null, null],
})

const state = () => ({
  unit: 'lb', submitted: false,
  session: {
    date: new Date().toISOString().slice(0, 10),
    off: false, warmup: [], cooldown: [], ex: [exercise('squat', 'Back Squat', 315)],
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

const reset = (kg = 315) => `
  (function(){
    STATE.history = {};
    STATE.customLib.squat = { equipment:'Barbell', kind:'reps_weight', incrementLb:5 };
    STATE.exerciseNames.squat = 'Back Squat';
    var ex = curSession().ex[0];
    ex.log = [null, null, null]; ex.kg = ${kg}; ex.lastKg = ${kg};
    /* The ramp is per-exercise state and leaks between tests otherwise —
       a fixture that half-resets reports the previous test's answer. */
    delete ex.ramp;
    setSessionMode('edit');
    render();
    return true;
  })()`

describe('the fixture itself', () => {
  it('booted with the generator and a rendered card', () => {
    expect(run('typeof TrainEngine.warmupRamp')).toBe('function')
    expect(run('typeof addWarmupRamp')).toBe('function')
    expect(run(reset())).toBe(true)
    expect(run("document.querySelectorAll('.pill').length")).toBe(3)
  })
})

describe('generating a ramp', () => {
  it('adds rows in front of the working sets, logging none of them', () => {
    const shape = run(`
      (function(){
        ${reset()};
        var added = addWarmupRamp(curSession().ex[0]);
        var log = curSession().ex[0].log;
        return {
          added: added,
          total: log.length,
          /* Nothing at all is logged: a generated ramp is a prescription,
             and every row still has to be tapped. */
          loggedRows: log.filter(Boolean).length,
          rampLength: (curSession().ex[0].ramp||[]).length,
          weights: (curSession().ex[0].ramp||[]).map(function(s){ return s.kg; }),
          prefilled: [].slice.call(document.querySelectorAll('.pill'))
            .slice(0, added).map(function(p){ return +p.querySelector('.w').value; }),
        };
      })()`)
    expect(shape.added).toBeGreaterThan(0)
    expect(shape.total).toBe(3 + shape.added)
    expect(shape.loggedRows).toBe(0) // nothing was auto-logged
    expect(shape.rampLength).toBe(shape.added)
    expect(shape.weights).toEqual([...shape.weights].sort((a: number, b: number) => a - b))
    // the rows really do render prefilled with the ramp, not the work
    expect(shape.prefilled).toEqual(shape.weights)
    expect(shape.prefilled.every((w: number) => w < 315)).toBe(true)
  })

  it('is reachable from the card', () => {
    run(reset())
    expect(run(`document.querySelector('.ex [data-act="ramp"]') !== null`)).toBe(true)
  })

  it('offers no ramp for a lift working at the bar', () => {
    run(reset(45))
    expect(run(`document.querySelector('.ex [data-act="ramp"]')`)).toBeNull()
  })

  it('keeps a ramp set the lifter actually did, and drops the rest', () => {
    const after = run(`
      (function(){
        ${reset()};
        var added = addWarmupRamp(curSession().ex[0]);
        // the lifter does the first ramp set, then clears the rest
        document.querySelectorAll('.pill')[0].querySelector('.pillHit').click();
        clearWarmupRamp(curSession().ex[0]);
        var log = curSession().ex[0].log;
        return {
          added: added,
          total: log.length,
          kept: log.filter(Boolean).length,
          keptIsWarmup: !!(log[0] && log[0].warmup),
          rampGone: !curSession().ex[0].ramp,
        };
      })()`)
    // one done warm-up plus the three working sets
    expect(after.total).toBe(4)
    expect(after.kept).toBe(1)
    expect(after.keptIsWarmup).toBe(true)
    expect(after.rampGone).toBe(true)
  })
})

describe('a ramp is invisible to every downstream read', () => {
  const logged = () => run(`
    (function(){
      ${reset()};
      addWarmupRamp(curSession().ex[0]);
      var ex = curSession().ex[0];
      var n = ex.log.length;
      for (var i = 0; i < n; i++) {
        var pill = document.querySelectorAll('.pill')[i];
        if (pill && pill.querySelector('.pillHit')) pill.querySelector('.pillHit').click();
      }
      return {
        sets: STATE.history.squat[0].sets,
        volume: TrainEngine.workingVolume(STATE.history.squat[0]),
        suggestion: suggestionFor(ex, prescription(ex)),
      };
    })()`)

  it('stores the ramp rows as warm-ups, without anybody pressing W', () => {
    const r = logged()
    const warmups = r.sets.filter((s: any) => s.warmup)
    expect(warmups.length).toBeGreaterThan(0)
    expect(warmups.every((s: any) => s.w < 315)).toBe(true)
  })

  it('counts only the working sets toward volume', () => {
    const r = logged()
    const working = r.sets.filter((s: any) => !s.warmup)
    const expected = working.reduce((n: number, s: any) => n + s.w * s.r, 0)
    expect(r.volume.load).toBe(expected)
    /* Not a fixed total, because the tile's prefill climbs WITHIN a
       session — set two of a clean session prefills five pounds above set
       one. That is pre-existing and unrelated to the ramp (it reproduces
       with no ramp generated at all); asserting a flat 315×15 here would
       have been asserting a bug is absent when it is not. What this test
       is for is that not one pound of the ramp is in that number. */
    expect(r.volume.load).toBe(r.sets.filter((s: any) => !s.warmup)
      .reduce((n: number, s: any) => n + s.w * s.r, 0))
    expect(working.every((s: any) => s.w >= 315)).toBe(true)
  })

  it('leaves the next suggestion reading the work, not the bar', () => {
    expect(logged().suggestion.weight).toBeGreaterThanOrEqual(315)
  })
})
