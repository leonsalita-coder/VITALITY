import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'

/**
 * The two cases that matter: a user who answered gets a real suggestion on
 * session one, and a user who skipped gets exactly today's behaviour.
 */

const fresh = () => ({
  unit: 'lb', submitted: false,
  session: { date: '1970-01-01', off: false, warmup: [], cooldown: [], ex: [] },
  history: {}, customLib: {}, exerciseNames: {},
  finishedDates: [], templates: [], shortTermGoal: '',
  photos: [], sessionDurations: [], liftGoals: [],
})

async function boot() {
  const dom = new JSDOM(readFileSync('public/tiles/train.html', 'utf8'), {
    url: 'https://train.test/',
    runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w: any) {
      w.Vitality = {
        load: async () => fresh(), save: () => {},
        read: async () => { throw new Error('no vitals') },
        classify: async () => { throw new Error('no_key') },
        getInsight: async () => { throw new Error('no_key') },
        generateWorkout: async () => { throw new Error('no_key') },
      }
      w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
      w.HTMLCanvasElement.prototype.getContext = () => null
    },
  })
  await new Promise((r) => setTimeout(r, 800))
  const win = dom.window as any
  return { win, run: (e: string): any => win.eval(e) }
}

describe('the fixture itself', () => {
  it('boots a genuinely fresh user', async () => {
    const { run } = await boot()
    expect(run('Object.keys(STATE.history).length')).toBe(0)
  })
})

describe('a user who answered gets a real session one', () => {
  it('suggests the weight they gave, with no history behind it', async () => {
    const { run } = await boot()
    const out = run(`(function(){
      var res = TrainEngine.applyOnboarding(STATE, {
        bodyweightLb: 178,
        startingLifts: [{ exerciseId: 'bench_press', weightLb: 155 }],
        equipment: ['barbell'],
        sessionsPerWeek: 3,
        trainingAge: 'beginner',
      }, today);
      Object.assign(STATE, res.state);
      var def = TrainEngine.catalogExercise('bench_press');
      installExerciseDef(def.id, def.name, { kind:def.defaultSetKind, equipment:def.equipment, primary:def.primary });
      var ex = sessionExerciseFrom({ id:'bench_press', name:def.name, kind:def.defaultSetKind,
                                     sets:3, reps:5, weight:0, rest:180, perSide:false });
      curSession().ex = [ex];
      return { kg: ex.kg, suggestion: suggestionFor(ex, prescription(ex)),
               target: weeklyTarget(), equip: equipmentAvailable() };
    })()`)
    expect(out.kg).toBe(155)
    expect(out.suggestion.weight).toBe(155)
    expect(out.suggestion.basis).toBe('new')
    expect(out.target).toBe(3)
    expect(out.equip.source).toBe('stated')
  })

  it('does not fabricate a session to do it', async () => {
    const { run } = await boot()
    const out = run(`(function(){
      var res = TrainEngine.applyOnboarding(STATE, {
        startingLifts: [{ exerciseId: 'bench_press', weightLb: 155 }],
      }, today);
      Object.assign(STATE, res.state);
      return { lifts: Object.keys(STATE.history).length, days: STATE.finishedDates.length };
    })()`)
    expect(out.lifts).toBe(0)
    expect(out.days).toBe(0)
  })
})

describe('a user who skipped gets today’s behaviour, exactly', () => {
  it('changes no setting', async () => {
    const { run } = await boot()
    const out = run(`(function(){
      var before = JSON.stringify({
        bw: STATE.bodyweight, sw: STATE.startingWeights, eq: STATE.equipment,
        target: STATE.weeklyTarget, age: STATE.trainingAge, pain: STATE.painFlagged,
      });
      var res = TrainEngine.applyOnboarding(STATE, {}, today);
      Object.assign(STATE, res.state);
      var after = JSON.stringify({
        bw: STATE.bodyweight, sw: STATE.startingWeights, eq: STATE.equipment,
        target: STATE.weeklyTarget, age: STATE.trainingAge, pain: STATE.painFlagged,
      });
      return { same: before === after, answered: TrainEngine.anythingAnswered(res.seeded) };
    })()`)
    expect(out.same).toBe(true)
    expect(out.answered).toBe(false)
  })

  it('leaves the streak target at the default', async () => {
    const { run } = await boot()
    const target = run(`(function(){
      Object.assign(STATE, TrainEngine.applyOnboarding(STATE, {}, today).state);
      return weeklyTarget();
    })()`)
    expect(target).toBe(4)
  })

  it('leaves equipment inferred from history, as before', async () => {
    const { run } = await boot()
    const source = run(`(function(){
      Object.assign(STATE, TrainEngine.applyOnboarding(STATE, {}, today).state);
      STATE.customLib.x = { equipment: 'barbell' };
      return equipmentAvailable().source;
    })()`)
    expect(source).toBe('history')
  })

  it('is not asked again', async () => {
    const { run } = await boot()
    const needed = run(`(function(){
      Object.assign(STATE, TrainEngine.applyOnboarding(STATE, {}, today).state);
      return TrainEngine.onboardingNeeded(STATE);
    })()`)
    expect(needed).toBe(false)
  })
})

describe('what is in the room today', () => {
  it('overrides the stated kit for one day only', async () => {
    const { run } = await boot()
    const out = run(`(function(){
      STATE.equipment = ['barbell','machine'];
      STATE.equipmentToday = { date: today, list: ['bodyweight'] };
      var todayKit = equipmentAvailable();
      STATE.equipmentToday = { date: '1999-01-01', list: ['bodyweight'] };
      var staleKit = equipmentAvailable();
      return { todayKit: todayKit, staleKit: staleKit };
    })()`)
    expect(out.todayKit.equipment).toEqual(['bodyweight'])
    expect(out.todayKit.source).toBe('today')
    expect(out.staleKit.source).toBe('stated')
  })

  it('reaches the coach constraints', async () => {
    const { run } = await boot()
    const equip = run(`(function(){
      STATE.equipment = ['barbell'];
      STATE.equipmentToday = { date: today, list: ['bodyweight'] };
      return planConstraints().equipment;
    })()`)
    expect(equip).toEqual(['bodyweight'])
  })
})
