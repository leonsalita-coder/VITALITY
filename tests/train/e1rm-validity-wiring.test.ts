import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { localToday } from '../helpers/clock'

/**
 * The star, through the real tile.
 *
 * classifyPR now refuses an e1RM record where the estimate is
 * meaningless, but the engine only learns that if the tile tells it —
 * and a field the engine reads while nothing passes it is exactly the
 * unwired state this whole change came out of. `e1rmValid` sat on sixty
 * catalog entries and was consulted by no code at all.
 *
 * So this asserts the wire, not the function: two lifts, identical
 * numbers, the same new best, and only the compound one celebrates.
 */

const past = '2026-01-05'

const ex = (id: string, name: string) => ({
  id, name, tier: 1, sets: 3, reps: 5, kg: 105,
  perHand: false, rest: 120, lastKg: 100, pinned: false, collapsed: false,
  deload: false, note: '', log: [null, null, null],
})

const state = () => ({
  unit: 'lb', submitted: false,
  session: {
    date: localToday(), off: false, warmup: [], cooldown: [],
    ex: [ex('bench_press', 'Bench Press'), ex('barbell_curl', 'Barbell Curl')],
  },
  /* One prior session on each, identical: 100 lb for 5. A set at 105x5
     beats both the estimate and the heaviest weight, so SOME record is
     certain — which is what makes the kind the whole claim. */
  history: {
    bench_press: [{ date: past, kg: 100, sets: [{ w: 100, r: 5 }, { w: 100, r: 5 }] }],
    barbell_curl: [{ date: past, kg: 100, sets: [{ w: 100, r: 5 }, { w: 100, r: 5 }] }],
  },
  customLib: {}, exerciseNames: {}, deloadStates: {}, finishedDates: [],
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

/** Log the same set on both lifts, then read back what each one scored. */
const log = `
  (function(){
    var s = curSession();
    s.ex.forEach(function(e){ e.log = [{ kg:105, reps:5 }, null, null]; });
    render();
    return s.ex.map(function(e){ return prFor(e, 0).kind; });
  })()`

describe('the fixture itself', () => {
  it('booted with both lifts and a catalog that knows them', () => {
    expect(run('typeof prFor')).toBe('function')
    expect(run("TrainEngine.catalogExercise('bench_press').e1rmValid")).toBe(true)
    expect(run("TrainEngine.catalogExercise('barbell_curl').e1rmValid")).toBe(false)
  })
})

describe('the celebration stays scarce', () => {
  it('gives the compound lift the star and the isolation lift a quiet dot', () => {
    const [bench, curl] = run(log)
    expect(bench).toBe('e1rm')
    expect(curl).toBe('weight')
  })

  it('still calls the isolation set a record', () => {
    /* Not suppressed — reclassified. A lifter who just put 5 lb on their
       curl has done something, and it still shows. */
    run(log)
    expect(run('isPR(curSession().ex[1], 0)')).toBe(true)
    expect(run('isBigPR(curSession().ex[1], 0)')).toBe(false)
  })

  it('passes the flag rather than defaulting it', () => {
    /* The wire itself. If prCandidateFor stopped reading the catalog,
       every assertion above would still pass for bench and fail only
       for curl — this one names the cause directly. */
    expect(run("prCandidateFor(curSession().ex[1], 0).e1rmValid")).toBe(false)
    expect(run("prCandidateFor(curSession().ex[0], 0).e1rmValid")).toBe(true)
  })

  it('keeps the star for a lift the catalog has never heard of', () => {
    const kind = run(`
      (function(){
        var s = curSession();
        s.ex[1].id = 'homebrew_thing';
        STATE.history.homebrew_thing = STATE.history.barbell_curl;
        s.ex[1].log = [{ kg:105, reps:5 }, null, null];
        var k = prFor(s.ex[1], 0).kind;
        s.ex[1].id = 'barbell_curl';
        return k;
      })()`)
    expect(kind).toBe('e1rm')
  })
})
