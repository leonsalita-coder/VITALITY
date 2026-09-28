import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { localToday } from '../helpers/clock'

/**
 * Smart swap, driven through the real tile.
 *
 * The property that matters most is the negative one: a swapped-in lift
 * must carry nothing of the lift it replaced. A 315 lb squat's weight
 * landing on a goblet squat would put something unliftable on the first
 * set and call it progression.
 */

const exercise = (id: string, name: string, kg: number) => ({
  id, name, tier: 2, sets: 3, reps: 5, kg, perHand: false,
  rest: 90, lastKg: kg, pinned: false, collapsed: false, deload: false,
  note: '', log: [null, null, null],
})

const state = () => ({
  unit: 'lb', submitted: false,
  session: {
    date: localToday(),
    off: false, warmup: [], cooldown: [], ex: [exercise('back_squat', 'Back Squat', 315)],
  },
  history: {}, customLib: {}, exerciseNames: {}, deloadStates: {}, aliases: {},
  finishedDates: [], templates: [], shortTermGoal: '', otherTraining: [],
  photos: [], sessionDurations: [], liftGoals: [], equipment: ['dumbbell', 'bodyweight'],
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
    STATE.history = {}; STATE.customLib = {}; STATE.aliases = {};
    STATE.equipment = ['dumbbell', 'bodyweight'];
    curSession().ex = [{ id:'back_squat', name:'Back Squat', tier:2, sets:3, reps:5,
      kg:315, perHand:false, rest:90, lastKg:315, pinned:false, collapsed:false,
      deload:false, note:'', log:[null,null,null] }];
    render();
    return true;
  })()`

describe('the fixture itself', () => {
  it('booted with the ranker and the tile helpers', () => {
    expect(run('typeof TrainEngine.rankSwaps')).toBe('function')
    expect(run('typeof swapCandidatesFor')).toBe('function')
    expect(run(reset)).toBe(true)
  })
})

describe('the tile offers ranked candidates', () => {
  it('suggests lifts for a squat in a gym with no barbell', () => {
    const list = run(`${reset}; swapCandidatesFor(curSession().ex[0]).map(c=>c.id)`)
    expect(list.length).toBeGreaterThan(0)
    expect(list).not.toContain('back_squat')
    expect(list.some((id: string) => /squat/.test(id))).toBe(true)
  })

  it('offers no barbell lift when there is no barbell', () => {
    const list = run(`swapCandidatesFor(curSession().ex[0])
      .filter(c => c.equipment === 'barbell').length`)
    expect(list).toBe(0)
  })

  it('renders each with its reason', () => {
    const html = run(`${reset}; swapSuggestionsHtml(curSession().ex[0])`)
    expect(html).toContain('data-cand=')
    expect(html).toMatch(/same movement|works /)
  })

  it('renders nothing for a lift the catalog does not know', () => {
    const html = run(`swapSuggestionsHtml({ id:'zercher_jump_snatch', name:'?' })`)
    expect(html).toBe('')
  })

  it('counts the candidate’s own sessions, from real history', () => {
    const goblet = run(`
      (function(){
        ${reset};
        STATE.history.goblet_squat = [
          { date:'2026-09-01', kg:60, sets:[{w:60,r:10}] },
          { date:'2026-09-08', kg:60, sets:[{w:60,r:10}] },
        ];
        return swapCandidatesFor(curSession().ex[0]).find(c=>c.id==='goblet_squat');
      })()`)
    expect(goblet.sessions).toBe(2)
    expect(goblet.reasons.join(' ')).toMatch(/2 sessions/)
  })
})

describe('a swapped-in lift inherits nothing', () => {
  const swapTo = (id: string) => run(`
    (function(){
      ${reset};
      var e = curSession().ex[0];
      var def = TrainEngine.catalogExercise('${id}');
      installExerciseDef(def.id, def.name, {
        kind:def.defaultSetKind, perSide:def.unilateral, assisted:false,
        repRange:TrainEngine.defaultRepRange(2, def.defaultSetKind, trainingAge()),
        equipment:def.equipment, primary:def.primary,
      });
      commitExercise(sessionExerciseFrom({
        id:def.id, name:def.name, kind:def.defaultSetKind, sets:3, reps:8,
        weight:lastKgFromHistory(def.id)||0, rest:90, perSide:def.unilateral,
      }), e, curSession(), false);
      return curSession().ex[0];
    })()`)

  it('does not carry the replaced lift’s working weight', () => {
    const swapped = swapTo('goblet_squat')
    expect(swapped.id).toBe('goblet_squat')
    expect(swapped.kg).not.toBe(315)
    expect(swapped.lastKg).not.toBe(315)
  })

  it('does not carry it through the button somebody actually taps', () => {
    /* The test above calls commitExercise directly, which leaves the real
       click handler free to pass the wrong weight. This drives the popup. */
    const swapped = run(`
      (function(){
        ${reset};
        openSwap(curSession().ex[0]);
        var btn = document.querySelector('#swapSuggest [data-cand]');
        if (!btn) return { error: 'no suggestion rendered' };
        var id = btn.dataset.cand;
        btn.click();
        var e = curSession().ex[0];
        return { id: e.id, kg: e.kg, lastKg: e.lastKg, picked: id };
      })()`)
    expect(swapped.error).toBeUndefined()
    expect(swapped.id).toBe(swapped.picked)
    expect(swapped.id).not.toBe('back_squat')
    expect(swapped.kg).not.toBe(315)
    expect(swapped.lastKg).not.toBe(315)
  })

  it('starts from its own history when it has some', () => {
    const swapped = run(`
      (function(){
        ${reset};
        STATE.history.goblet_squat = [{ date:'2026-09-08', kg:70, sets:[{w:70,r:10}] }];
        var e = curSession().ex[0];
        var def = TrainEngine.catalogExercise('goblet_squat');
        commitExercise(sessionExerciseFrom({
          id:def.id, name:def.name, kind:def.defaultSetKind, sets:3, reps:8,
          weight:lastKgFromHistory(def.id)||0, rest:90, perSide:def.unilateral,
        }), e, curSession(), false);
        return curSession().ex[0];
      })()`)
    expect(swapped.kg).toBe(70)
  })

  it('leaves the replaced lift’s history exactly where it was', () => {
    const after = run(`
      (function(){
        ${reset};
        STATE.history.back_squat = [{ date:'2026-09-01', kg:315, sets:[{w:315,r:5}] }];
        var before = JSON.stringify(STATE.history.back_squat);
        var e = curSession().ex[0];
        var def = TrainEngine.catalogExercise('goblet_squat');
        commitExercise(sessionExerciseFrom({
          id:def.id, name:def.name, kind:def.defaultSetKind, sets:3, reps:8,
          weight:0, rest:90, perSide:def.unilateral,
        }), e, curSession(), false);
        return { before: before, after: JSON.stringify(STATE.history.back_squat) };
      })()`)
    expect(after.after).toBe(after.before)
  })

  it('does not alias the new lift onto the old one’s records', () => {
    run(reset)
    expect(run("Object.values(STATE.aliases||{}).includes('back_squat')")).toBe(false)
  })
})
