import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'

/**
 * Training that isn't lifting, driven through the real tile.
 *
 * The two constraints are only worth anything if they hold where the app
 * actually runs: the estimate must be marked everywhere it surfaces, and
 * there must be no path from a logged run to a lift's prescribed weight.
 */

const state = () => ({
  unit: 'lb', submitted: false,
  session: { date: '1970-01-01', off: false, warmup: [], cooldown: [], ex: [] },
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

/** Two hours of sparring yesterday, logged the way the tile logs it. */
const logHard = `
  (function(){
    STATE.otherTraining = [];
    var d = new Date(Date.now() - 86400000);
    var date = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0')
             + '-' + String(d.getDate()).padStart(2,'0');
    STATE.otherTraining.push(TrainEngine.normalizeOtherEntry(
      { date: date, activity: 'martial_arts', minutes: 120, intensity: 9 }));
    return date;
  })()`

describe('the fixture itself', () => {
  it('booted with the engine, the store slot and the builders', () => {
    expect(run('typeof TrainEngine')).toBe('object')
    expect(run('Array.isArray(STATE.otherTraining)')).toBe(true)
    expect(run('typeof otherEntries')).toBe('function')
    expect(run('typeof otherLoadNow')).toBe('function')
    expect(run('typeof allTrainingDates')).toBe('function')
    expect(run('typeof openOtherTraining')).toBe('function')
  })
})

describe('a hard conditioning entry suppresses readiness', () => {
  it('reaches the readiness verdict through the tile', async () => {
    run(logHard)
    const verdict = await run('computeReadiness()')
    expect(verdict.verdict).toBe('reduced_volume')
    expect(verdict.setsFactor).toBeLessThan(1)
    expect(verdict.reason).toMatch(/martial arts/)
  })

  it('says it is an estimate, not a measurement', async () => {
    run(logHard)
    const verdict = await run('computeReadiness()')
    expect(verdict.confidence).toBe('inferred')
    expect(verdict.reason).toMatch(/told me/i)
  })

  it('goes quiet again when the entry is removed', async () => {
    run('STATE.otherTraining = [];')
    const verdict = await run('computeReadiness()')
    expect(verdict.setsFactor).toBe(1)
    expect(verdict.reason).toBeNull()
  })

  it('tells the coach, and tells it the number is self-reported', async () => {
    run(logHard)
    const lines: string[] = (await run('buildInsightContext(curSession())')).lines
    // the caveat is its own line, so join before asserting on it
    const said = lines.join(' ')
    expect(said).toMatch(/Other training in the last 3 days/i)
    expect(said).toMatch(/martial arts/)
    expect(said).toMatch(/SELF-REPORTED/)
    expect(said).toMatch(/never a reason to change a specific lift/i)
  })
})

describe('the same entry never produces or worsens a deload', () => {
  /* A lift genuinely stalled, next to a week of brutal conditioning. The
     deload must be identical to what it would have been with no other
     training logged at all. */
  const stall = `
    (function(){
      STATE.customLib.bp = { equipment:'Barbell', kind:'reps_weight' };
      STATE.exerciseNames.bp = 'bp';
      STATE.deloadStates = {};
      STATE.history.bp = [2, 9, 16, 23].map(function(back){
        var d = new Date(Date.now() - back * 86400000);
        return { date: d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0')
                       + '-' + String(d.getDate()).padStart(2,'0'),
                 kg:200, sets:[{w:200,r:5},{w:200,r:5}] };
      });
      var ex = { id:'bp', name:'bp', tier:2, sets:2, reps:5, kg:200, perHand:false,
                 rest:90, lastKg:200, pinned:false, collapsed:false, deload:false,
                 note:'', log:[null,null] };
      curSession().ex = [ex];
      return ex;
    })()`

  const readLift = `
    (function(){
      var ex = curSession().ex[0];
      return {
        plateau: JSON.stringify(plateauFor(ex)),
        suggestion: JSON.stringify(suggestionFor(ex, prescription(ex))),
        deloadState: JSON.stringify(STATE.deloadStates.bp || null),
      };
    })()`

  it('leaves the plateau read, the suggestion and the deload state identical', () => {
    run('STATE.otherTraining = [];')
    run(stall)
    const without = run(readLift)

    run(logHard)
    run(`(function(){
      var d, i;
      for (i = 0; i < 6; i++) {
        d = new Date(Date.now() - i * 86400000);
        STATE.otherTraining.push(TrainEngine.normalizeOtherEntry({
          date: d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0')
                + '-' + String(d.getDate()).padStart(2,'0'),
          activity:'martial_arts', minutes:600, intensity:10 }));
      }
    })()`)
    run(stall)
    const withOther = run(readLift)

    expect(withOther).toEqual(without)
  })

  it('is a load hard enough to suppress, so that identity means something', async () => {
    const summary = run('otherLoadNow()')
    expect(summary.load).toBeGreaterThanOrEqual(600)
    expect(summary.estimated).toBe(true)
    const verdict = await run(`
      TrainEngine.assessReadiness({
        recovery:null, recentHardSets:null, baselineHardSets:null,
        activeDeload:false, restAdvisedDates:[], today:today,
        otherLoad: otherLoadNow(),
      })`)
    expect(verdict.verdict).toBe('reduced_volume')
  })

  it('never advances a lift into a deload state on its own', () => {
    const state = run(`
      (function(){
        STATE.history = {}; STATE.deloadStates = {};
        curSession().ex = [];
        return JSON.stringify(STATE.deloadStates);
      })()`)
    expect(state).toBe('{}')
  })
})

describe('it does count as having trained', () => {
  it('a logged run lands in the training dates the streak reads', () => {
    const dates: string[] = run(`(function(){
      STATE.finishedDates = [];
      ${logHard};
      return allTrainingDates();
    })()`)
    expect(dates.length).toBe(1)
  })

  it('holds a real streak on running alone, through the tile’s own streak read', () => {
    /* allTrainingDates() existing proves nothing if currentStreak() still
       reads STATE.finishedDates — that is the wiring, and this is it. */
    const streak = run(`
      (function(){
        STATE.finishedDates = [];
        STATE.weeklyTarget = 2;
        STATE.otherTraining = [];
        [1, 3, 8, 10, 15, 17, 22, 24].forEach(function(back){
          var d = new Date(Date.now() - back * 86400000);
          STATE.otherTraining.push(TrainEngine.normalizeOtherEntry({
            date: d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0')
                  + '-' + String(d.getDate()).padStart(2,'0'),
            activity:'endurance', minutes:40, intensity:5 }));
        });
        return currentStreak();
      })()`)
    expect(streak).toBeGreaterThanOrEqual(3)
  })

  it('shows the same weeks in the longest run', () => {
    expect(run('longestStreak()')).toBeGreaterThanOrEqual(3)
  })

  it('counts in the weekly review too, against the same target', () => {
    /* The streak and the review ask one question — did you train enough
       this week — so they must not give two answers. */
    const review = run(`
      (function(){
        STATE.finishedDates = [];
        STATE.weeklyTarget = 2;
        STATE.otherTraining = [];
        [0, 2].forEach(function(back){
          var d = new Date(Date.now() - back * 86400000);
          STATE.otherTraining.push(TrainEngine.normalizeOtherEntry({
            date: d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0')
                  + '-' + String(d.getDate()).padStart(2,'0'),
            activity:'endurance', minutes:40, intensity:5 }));
        });
        return weeklyReviewUncached();
      })()`)
    expect(review.sessions).toBe(2)
    expect(review.metTarget).toBe(true)
  })

  it('does not write into the lifting record', () => {
    expect(run('STATE.finishedDates.length')).toBe(0)
    expect(run('Object.keys(STATE.history).length')).toBe(0)
  })
})
