import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'

/**
 * Kind and rep range, driven through the real tile rather than the engine.
 *
 * A typed-set engine nothing can reach is a reps_weight app with extra
 * code, so these assert the wiring itself: a classification reaching the
 * store, an input rendering in the right unit, a set logging into the right
 * field, and a suggestion coming back in that same unit.
 */

const state = () => ({
  unit: 'lb', submitted: false,
  session: { date: '1970-01-01', off: false, warmup: [], cooldown: [], ex: [] },
  history: {}, customLib: {}, exerciseNames: {},
  finishedDates: [], templates: [], shortTermGoal: '',
  photos: [], sessionDurations: [], liftGoals: [],
})

let win: any
/** Runs an expression inside the tile's own scope. */
let run: (expr: string) => any

beforeAll(async () => {
  const dom = new JSDOM(readFileSync('public/tiles/train.html', 'utf8'), {
    // a real origin: about:blank is opaque, and storage the tile touches
    // throws there — a setup that fails silently is a test proving nothing
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
      w.HTMLCanvasElement.prototype.getContext = () => null
    },
  })
  await new Promise((r) => setTimeout(r, 700))
  win = dom.window
  run = (expr: string) => win.eval(expr)
})

/** Every assertion below evaluates inside the tile; prove it is alive. */
describe('the fixture itself', () => {
  it('booted with a usable engine and state', () => {
    expect(run('typeof TrainEngine')).toBe('object')
    expect(run('!!STATE')).toBe(true)
  })
})

/** Registers a lift of a given kind and returns a session-exercise for it. */
const makeLift = (id: string, kind: string, extra = '{}') => `
  (function(){
    STATE.customLib['${id}'] = Object.assign({ equipment:'Barbell', kind:'${kind}' }, ${extra});
    STATE.exerciseNames['${id}'] = '${id}';
    var ex = { id:'${id}', name:'${id}', tier:2, sets:2, reps:5, kg:0, perHand:false,
               rest:90, lastKg:null, pinned:false, collapsed:false, deload:false, note:'',
               log:[null,null] };
    curSession().ex = [ex];
    return ex;
  })()`

describe('the tile reads a lift’s kind', () => {
  it('returns the stored kind', () => {
    run(makeLift('plank', 'time'))
    expect(run("kindFor(curSession().ex[0])")).toBe('time')
  })

  it('falls back to reps_weight for a lift with nothing stored', () => {
    run(makeLift('squat', 'reps_weight'))
    expect(run("kindFor(curSession().ex[0])")).toBe('reps_weight')
  })

  it('refuses a kind that is not on the closed list', () => {
    run("STATE.customLib.bogus = { kind:'isometric' }; STATE.exerciseNames.bogus='bogus';")
    expect(run("kindFor({ id:'bogus' })")).toBe('reps_weight')
  })
})

describe('the input follows the kind', () => {
  const inputsFor = (kind: string) =>
    run(`pillInputsFor({ id:'x', perHand:false }, '${kind}', { weight:100, reps:5, seconds:60, metres:40 }, false)`)

  it('offers seconds for a plank, and no weight', () => {
    const html = inputsFor('time')
    expect(html).toContain('aria-label="Seconds"')
    expect(html).not.toContain('aria-label="Weight"')
  })

  it('offers metres for a carry', () => {
    const html = inputsFor('distance')
    expect(html).toContain('aria-label="Metres"')
    expect(html).not.toContain('aria-label="Weight"')
  })

  it('offers reps alone for bodyweight work', () => {
    const html = inputsFor('reps_only')
    expect(html).toContain('aria-label="Reps"')
    expect(html).not.toContain('aria-label="Weight"')
  })

  it('offers both for a sprint', () => {
    const html = inputsFor('time_distance')
    expect(html).toContain('aria-label="Metres"')
    expect(html).toContain('aria-label="Seconds"')
  })

  it('still offers weight and reps for an ordinary lift', () => {
    const html = inputsFor('reps_weight')
    expect(html).toContain('aria-label="Weight"')
    expect(html).toContain('aria-label="Reps"')
  })
})

describe('each kind logs into its own field and progresses in its own unit', () => {
  const cycle = (id: string, kind: string, logExpr: string) => `
    (function(){
      ${makeLift(id, kind)};
      var ex = curSession().ex[0];
      ${logExpr}
      rollupToday(ex);
      var hist = STATE.history['${id}'];
      var suggestion = suggestionFor(ex, prescription(ex));
      return { stored: hist[0].sets, kind: TrainEngine.entryKind(hist[0]), suggestion: suggestion };
    })()`

  it('a plank stores seconds and is told to hold longer', () => {
    const r = run(cycle('plank2', 'time', "doLog(ex,0,{kind:'time',s:60},false); doLog(ex,1,{kind:'time',s:60},false);"))
    expect(r.kind).toBe('time')
    expect(r.stored[0].s).toBe(60)
    expect(r.stored[0].w).toBeUndefined()
    expect(r.suggestion.seconds).toBe(65)
    expect(r.suggestion.weight).toBeNull()
  })

  it('a carry stores metres and is told to go further', () => {
    const r = run(cycle('carry2', 'distance', "doLog(ex,0,{kind:'distance',m:40},false); doLog(ex,1,{kind:'distance',m:40},false);"))
    expect(r.kind).toBe('distance')
    expect(r.stored[0].m).toBe(40)
    expect(r.suggestion.metres).toBe(50)
    expect(r.suggestion.weight).toBeNull()
  })

  it('box jumps store reps and are told to add one', () => {
    const r = run(cycle('jumps2', 'reps_only', "doLog(ex,0,{kind:'reps_only',reps:8},false); doLog(ex,1,{kind:'reps_only',reps:8},false);"))
    expect(r.kind).toBe('reps_only')
    expect(r.stored[0].r).toBe(8)
    expect(r.suggestion.reps).toBe(9)
    expect(r.suggestion.weight).toBeNull()
  })

  it('a sprint stores both', () => {
    const r = run(cycle('sprint2', 'time_distance', "doLog(ex,0,{kind:'time_distance',m:20,s:4},false); doLog(ex,1,{kind:'time_distance',m:20,s:4},false);"))
    expect(r.stored[0].m).toBe(20)
    expect(r.stored[0].s).toBe(4)
  })

  it('an ordinary lift is unchanged', () => {
    const r = run(cycle('squat2', 'reps_weight', "doLog(ex,0,{kind:'reps_weight',kg:185,reps:5},false); doLog(ex,1,{kind:'reps_weight',kg:185,reps:5},false);"))
    expect(r.kind).toBe('reps_weight')
    expect(r.stored[0].w).toBe(185)
    expect(r.stored[0].r).toBe(5)
    expect(typeof r.suggestion.weight).toBe('number')
  })
})

describe('changing kind on a lift with history', () => {
  it('knows which kinds a lift has actually been logged under', () => {
    const kinds = run(`
      (function(){
        ${makeLift('switcher', 'reps_weight')};
        STATE.history.switcher = [{ date:'2026-09-10', kg:185, sets:[{ w:185, r:5 }] }];
        return historyKinds({ id:'switcher' });
      })()`)
    expect([...kinds]).toEqual(['reps_weight'])
  })

  it('leaves the old rows exactly as they were after the change', () => {
    const r = run(`
      (function(){
        ${makeLift('switcher2', 'reps_weight')};
        STATE.history.switcher2 = [{ date:'2026-09-10', kg:185, sets:[{ w:185, r:5 }] }];
        var before = JSON.stringify(STATE.history.switcher2);
        setExerciseField({ id:'switcher2' }, 'kind', 'time');
        return { before: before, after: JSON.stringify(STATE.history.switcher2),
                 kind: kindFor({ id:'switcher2' }) };
      })()`)
    expect(r.after).toBe(r.before)
    expect(r.kind).toBe('time')
  })

  it('starts fresh in the new unit rather than reading pounds as seconds', () => {
    const s = run(`
      (function(){
        ${makeLift('switcher3', 'reps_weight')};
        var ex = curSession().ex[0];
        STATE.history.switcher3 = [{ date:'2026-09-10', kg:185, sets:[{ w:185, r:5 }] }];
        setExerciseField({ id:'switcher3' }, 'kind', 'time');
        return suggestionFor(ex, prescription(ex));
      })()`)
    expect(s.kind).toBe('time')
    expect(s.basis).toBe('new')
    expect(s.weight).toBeNull()
  })
})

describe('a classification reaches the store safely', () => {
  it('writes a validated kind, flags and rep range', () => {
    const stored = run(`
      (function(){
        var c = TrainEngine.normalizeClassification({
          defaultSetKind:'time', perSide:true, assisted:'yes', tier:2,
        });
        STATE.customLib.classified = { kind:c.kind, perSide:c.perSide||undefined,
                                       assisted:c.assisted||undefined, repRange:c.repRange||undefined };
        return STATE.customLib.classified;
      })()`)
    expect(stored.kind).toBe('time')
    expect(stored.perSide).toBe(true)
    expect(stored.assisted).toBeUndefined() // 'yes' is not true
    expect(stored.repRange).toBeUndefined() // a plank has no rep range
  })

  it('gives a new weighted lift a live rep range, so double progression runs', () => {
    const range = run(`
      (function(){
        var c = TrainEngine.normalizeClassification({ defaultSetKind:'reps_weight', tier:3 });
        STATE.customLib.acc = { kind:c.kind, repRange:c.repRange };
        STATE.exerciseNames.acc = 'acc';
        return repRangeFor({ id:'acc' });
      })()`)
    expect(range).toEqual([10, 15])
  })

  it('falls back to reps_weight when the model invents a kind', () => {
    expect(run("TrainEngine.normalizeClassification({ defaultSetKind:'explosive_hold' }).kind")).toBe('reps_weight')
  })
})
