import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'

/* LOCAL date, never toISOString — see docs/train-verification.md. */
const localToday = () => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Staleness through the real tile: it must reach the coach, once. */

const state = () => ({
  unit: 'lb', submitted: false,
  session: {
    date: localToday(), off: false, warmup: [], cooldown: [],
    ex: [{
      id: 'back_squat', name: 'Back Squat', tier: 1, sets: 3, reps: 5, kg: 200,
      perHand: false, rest: 180, lastKg: 200, pinned: false, collapsed: false,
      deload: false, note: '', log: [null, null, null],
    }],
  },
  history: {}, customLib: {}, exerciseNames: { back_squat: 'Back Squat' },
  deloadStates: {}, finishedDates: [], templates: [], shortTermGoal: '',
  otherTraining: [], photos: [], sessionDurations: [], liftGoals: [],
  bodyweight: [], equipment: ['barbell', 'dumbbell', 'bodyweight'],
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

/** `weeks` of weekly sessions, at a weight per week. */
const seed = (weeks: number, climbing: boolean) => `
  (function(){
    STATE.customLib.back_squat = { equipment:'barbell', kind:'reps_weight' };
    STATE.history.back_squat = [];
    for (var i = 0; i < ${weeks}; i++) {
      var d = new Date(Date.now() - (${weeks} - 1 - i) * 7 * 86400000);
      var date = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0')
               + '-' + String(d.getDate()).padStart(2,'0');
      var w = ${climbing} ? 200 + i * 5 : 200;
      STATE.history.back_squat.push({ date: date, kg: w,
        sets: [{w:w,r:5},{w:w,r:5},{w:w,r:5}] });
    }
    return STATE.history.back_squat.length;
  })()`

describe('the fixture itself', () => {
  it('booted with the engine and the note builder', () => {
    expect(run('typeof TrainEngine.stalenessFor')).toBe('function')
    expect(run('typeof staleNoteFor')).toBe('function')
    expect(run(seed(16, false))).toBe(16)
  })
})

describe('the context carries what the engine needs', () => {
  it('supplies real equipment, not an empty list', () => {
    const eq = run('equipmentAvailable().equipment')
    expect(Array.isArray(eq)).toBe(true)
    expect(eq.length).toBeGreaterThan(0)
  })

  it('produces a finding for a long stalled run', () => {
    run(seed(16, false))
    const found = run('staleNoteFor()')
    expect(found).not.toBeNull()
    expect(found.exerciseId).toBe('back_squat')
    expect(found.candidates.length).toBeGreaterThan(0)
  })

  it('offers only equipment the athlete actually has', () => {
    /* The tile supplies the equipment list. Passing an empty one would
       disable filtering entirely and still produce plausible-looking
       candidates — which is a finding that quietly recommends a barbell
       to somebody in a hotel room. */
    const barbells = run(`
      (function(){
        ${seed(16, false)};
        STATE.equipment = ['dumbbell', 'bodyweight'];
        delete STATE.equipmentToday;
        var found = staleNoteFor();
        return found ? found.candidates.filter(function(c){
          return c.equipment === 'barbell'; }).length : -1;
      })()`)
    expect(barbells).toBe(0)
  })

  it('produces nothing while the lift is still climbing', () => {
    run(seed(16, true))
    expect(run('staleNoteFor()')).toBeNull()
  })
})

describe('the coach is told, once', () => {
  it('includes the note with alternatives named', async () => {
    const lines: string[] = (await run(`
      (function(){
        ${seed(16, false)};
        return buildInsightContext(curSession()).then(function(c){ return c.lines; });
      })()`))
    const said = lines.filter((l) => /^STALE:/.test(l))
    expect(said.length).toBe(1)
    expect(said[0]).toMatch(/16 weeks|weeks/)
    expect(said[0]).toMatch(/Squat|Press|Lunge|Leg/i)
  })

  it('says nothing at all while progress continues', async () => {
    const lines: string[] = (await run(`
      (function(){
        ${seed(16, true)};
        return buildInsightContext(curSession()).then(function(c){ return c.lines; });
      })()`))
    // control: the context really was built
    expect(lines.some((l) => /^Streak:/.test(l))).toBe(true)
    expect(lines.filter((l) => /^STALE:/.test(l))).toEqual([])
  })

  it('does not repeat itself across several lifts', async () => {
    const lines: string[] = (await run(`
      (function(){
        ${seed(16, false)};
        STATE.customLib.bench_press = { equipment:'barbell', kind:'reps_weight' };
        STATE.history.bench_press = STATE.history.back_squat.map(function(e){
          return { date:e.date, kg:150, sets:[{w:150,r:5},{w:150,r:5},{w:150,r:5}] };
        });
        curSession().ex.push({ id:'bench_press', name:'Bench Press', tier:1, sets:3,
          reps:5, kg:150, perHand:false, rest:180, lastKg:150, pinned:false,
          collapsed:false, deload:false, note:'', log:[null,null,null] });
        return buildInsightContext(curSession()).then(function(c){ return c.lines; });
      })()`))
    expect(lines.filter((l) => /^STALE:/.test(l)).length).toBe(1)
  })
})
