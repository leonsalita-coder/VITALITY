import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { localToday } from '../helpers/clock'

/**
 * Timestamp capture, driven through the real tile.
 *
 * This is the half that can silently not happen. timing.ts can be
 * flawless and read nothing forever if doLog never stamps the moment, and
 * a suite full of hand-built fixtures with `at` on them would never
 * notice. So these log sets the way a lifter does and read what was
 * actually stored.
 */

const exercise = (id: string, name: string) => ({
  id, name, tier: 2, sets: 3, reps: 5, kg: 200, perHand: false,
  rest: 90, lastKg: 200, pinned: false, collapsed: false, deload: false,
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

const reset = `
  (function(){
    STATE.history = {};
    STATE.customLib.bench = { equipment:'Barbell', kind:'reps_weight', incrementLb:5 };
    STATE.exerciseNames.bench = 'Bench Press';
    var ex = curSession().ex[0];
    ex.log = [null, null, null]; delete ex.ramp;
    render();
    return true;
  })()`

describe('the fixture itself', () => {
  it('booted with the timing engine and a rendered card', () => {
    expect(run('typeof TrainEngine.restTaken')).toBe('function')
    expect(run('typeof TrainEngine.plateauAdvice')).toBe('function')
    expect(run(reset)).toBe(true)
    expect(run("document.querySelectorAll('.pill').length")).toBe(3)
  })
})

describe('logging a set records when it happened', () => {
  const logged = () => run(`
    (function(){
      ${reset};
      var before = Date.now();
      for (var i = 0; i < 3; i++) {
        document.querySelectorAll('.pill')[i].querySelector('.pillHit').click();
      }
      return { sets: STATE.history.bench[0].sets, before: before, after: Date.now() };
    })()`)

  it('stamps every logged set', () => {
    const r = logged()
    expect(r.sets.length).toBe(3)
    expect(r.sets.every((s: any) => typeof s.at === 'number')).toBe(true)
  })

  it('stamps a real moment, not a placeholder', () => {
    const r = logged()
    for (const set of r.sets) {
      expect(set.at).toBeGreaterThanOrEqual(r.before)
      expect(set.at).toBeLessThanOrEqual(r.after)
    }
  })

  it('does not claim the timestamp is estimated', () => {
    expect(logged().sets.every((s: any) => s.atEstimated === undefined)).toBe(true)
  })

  it('so the timing engine can read it', () => {
    /* Three clicks in a test land in the same millisecond, and a
       zero-second gap is correctly not rest. The clock is advanced
       between sets so this measures capture rather than how fast the
       machine is. */
    const reading = run(`
      (function(){
        ${reset};
        var real = Date.now;
        var clock = real.call(Date);
        Date.now = function(){ return clock; };
        try {
          for (var i = 0; i < 3; i++) {
            document.querySelectorAll('.pill')[i].querySelector('.pillHit').click();
            clock += 90000; // ninety seconds of rest
          }
        } finally { Date.now = real; }
        return TrainEngine.restTaken(STATE.history.bench[0]);
      })()`)
    expect(reading.hasObservedTiming).toBe(true)
    expect(reading.gaps).toEqual([90, 90])
    expect(reading.median).toBe(90)
  })
})

describe('imported history is refused', () => {
  it('reads no timing from rows the importer stamped', () => {
    const reading = run(`
      (function(){
        ${reset};
        var t = Date.now();
        STATE.history.bench = [{ date:'2026-09-01', kg:200, sets:[
          { w:200, r:5, at:t, atEstimated:true },
          { w:200, r:5, at:t+90000, atEstimated:true },
        ]}];
        return {
          reading: TrainEngine.restTaken(STATE.history.bench[0]),
          anyObserved: TrainEngine.hasObservedTiming(STATE.history.bench),
        };
      })()`)
    expect(reading.reading.hasObservedTiming).toBe(false)
    expect(reading.reading.median).toBeNull()
    expect(reading.anyObserved).toBe(false)
  })

  it('carries atEstimated through the rollup, so it keeps refusing them', () => {
    const stored = run(`
      (function(){
        ${reset};
        var ex = curSession().ex[0];
        ex.log = [{ kind:'reps_weight', kg:200, reps:5, at: Date.now(), atEstimated:true }, null, null];
        rollupToday(ex);
        return STATE.history.bench[0].sets[0];
      })()`)
    expect(stored.atEstimated).toBe(true)
  })
})

describe('the coach is told what the stall calls for', () => {
  it('says rest longer for a rushed stall, not cut the weight', async () => {
    const lines: string[] = (await run(`
      (function(){
        ${reset};
        var base = new Date('2026-09-19T18:00:00').getTime();
        var dates = ['2026-08-15','2026-08-22','2026-08-29','2026-09-05','2026-09-12','2026-09-19'];
        STATE.history.bench = dates.map(function(d, i){
          var gap = Math.max(45, 180 - i * 30) * 1000;
          var start = new Date(d + 'T18:00:00').getTime();
          return { date:d, kg:200, sets:[
            { w:200, r:5, at:start },
            { w:200, r:5, at:start + gap },
            { w:200, r:5, at:start + gap * 2 },
          ]};
        });
        return buildInsightContext(curSession()).then(function(c){ return c.lines; });
      })()`))
    const plateau = lines.filter((l) => /^PLATEAU \(/.test(l)).join(' ')
    expect(plateau).toMatch(/Rest between sets has been getting shorter/)
    expect(plateau).not.toMatch(/cut|drop the weight|deload/i)
  })
})
