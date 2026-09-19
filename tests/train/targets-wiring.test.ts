import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'

/**
 * Scaled targets, driven through the real tile.
 *
 * targets.ts can be perfect and still change nothing, which is the failure
 * this engine has produced six times: correct, unreachable, green suite.
 * So every assertion here goes through the tile's own scope, and the
 * training age is set the way onboarding sets it.
 */

const state = () => ({
  unit: 'lb', submitted: false,
  session: { date: '1970-01-01', off: false, warmup: [], cooldown: [], ex: [] },
  history: {}, customLib: {}, exerciseNames: {}, deloadStates: {},
  finishedDates: [], templates: [], shortTermGoal: '',
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

/** Every assertion below evaluates inside the tile; prove it is alive. */
describe('the fixture itself', () => {
  it('booted with a usable engine and state', () => {
    expect(run('typeof TrainEngine')).toBe('object')
    expect(run('!!STATE')).toBe(true)
  })

  it('has the builders the rest of this file drives', () => {
    expect(run('typeof trainingAge')).toBe('function')
    expect(run('typeof analysisOptsFor')).toBe('function')
  })
})

describe('the streak target is the one they chose', () => {
  it('follows a stated frequency of two rather than a constant four', () => {
    expect(run("(function(){ STATE.weeklyTarget = 2; return weeklyTarget(); })()")).toBe(2)
  })

  it('holds a streak for someone training twice a week by choice', () => {
    const streak = run(`
      (function(){
        STATE.weeklyTarget = 2;
        var dates = [];
        // four full weeks at exactly two sessions, plus an in-progress week
        for (var w = 1; w <= 4; w++) {
          for (var i = 0; i < 2; i++) {
            var d = new Date(Date.now() - (w * 7 + i) * 86400000);
            dates.push(d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0')
                       + '-' + String(d.getDate()).padStart(2,'0'));
          }
        }
        STATE.finishedDates = dates;
        return currentStreak();
      })()`)
    expect(streak).toBeGreaterThanOrEqual(4)
  })

  it('breaks that same streak against the four-session default they never chose', () => {
    // the shipped bug, kept visible: the history above is a broken streak
    // only because somebody else's number was applied to it
    const streak = run("(function(){ STATE.weeklyTarget = 4; return currentStreak(); })()")
    expect(streak).toBe(0)
  })

  it('still has a sane target when they never stated one', () => {
    expect(run("(function(){ delete STATE.weeklyTarget; return weeklyTarget(); })()")).toBe(4)
  })
})

describe('the training age reaches every threshold that scales', () => {
  it('carries into the analysis options', () => {
    expect(run("(function(){ STATE.trainingAge='advanced'; return analysisOptsFor(); })()"))
      .toMatchObject({ trainingAge: 'advanced' })
  })

  it('carries into the progression input, defined rather than undefined', () => {
    const input = run(`
      (function(){
        STATE.trainingAge = 'beginner';
        var ex = { id:'sq', name:'sq', tier:2, sets:3, reps:5, kg:200, perHand:false,
                   rest:90, lastKg:null, pinned:false, collapsed:false, deload:false,
                   note:'', log:[null,null,null] };
        return progressionInputFor(ex, prescription(ex));
      })()`)
    expect(input.trainingAge).toBe('beginner')
  })

  it('changes what a deload actually prescribes, through the real suggestion path', () => {
    const cut = (age: string) => run(`
      (function(){
        STATE.trainingAge = '${age}';
        STATE.customLib.dl = { equipment:'Barbell', kind:'reps_weight' };
        STATE.exerciseNames.dl = 'dl';
        STATE.deloadStates.dl = { state:'deloading', kind:'intensity', confidence:'measured',
                                  priorWeight:200, since:'2026-09-01', plateauLength:3, sessions:0 };
        var ex = { id:'dl', name:'dl', tier:2, sets:3, reps:5, kg:200, perHand:false,
                   rest:90, lastKg:200, pinned:false, collapsed:false, deload:false,
                   note:'', log:[null,null,null] };
        curSession().ex = [ex];
        return suggestionFor(ex, prescription(ex)).weight;
      })()`)
    const beginner = cut('beginner')
    const advanced = cut('advanced')
    expect(beginner).toBeGreaterThan(advanced)
    expect(beginner).toBe(190) // 5% off 200
    expect(advanced).toBe(170) // 15% off 200
  })

  it('gives a newly classified compound a rep range that matches the athlete', () => {
    const range = (age: string) => run(
      `TrainEngine.normalizeClassification({ defaultSetKind:'reps_weight', tier:1 }, '${age}').repRange`)
    expect(range('beginner')).toEqual([5, 8])
    expect(range('advanced')).toEqual([3, 5])
  })
})

describe('the coach is told the athlete’s band, not the average lifter’s', () => {
  /* buildInsightContext is what the model actually reads. An analyse()
     call there that forgets the options is the exact failure this file
     exists to catch: engine correct, tile unchanged, suite green. */
  const patterns = (age: string) => run(`
    (function(){
      STATE.trainingAge = '${age}';
      STATE.history = {}; STATE.customLib = {};
      STATE.customLib.bp = { primary:[{muscle:'chest',share:1}], kind:'reps_weight' };
      STATE.exerciseNames.bp = 'bp';
      var days = [1, 4];
      STATE.history.bp = days.map(function(back){
        var d = new Date(Date.now() - back * 86400000);
        var sets = []; for (var i = 0; i < 8; i++) sets.push({ w:100, r:8 });
        return { date: d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0')
                       + '-' + String(d.getDate()).padStart(2,'0'), kg:100, sets:sets };
      });
      return buildInsightContext(curSession()).then(function(ctx){ return ctx.lines; });
    })()`)

  it('reports 16 sets as over the ceiling for a beginner', async () => {
    const lines: string[] = await patterns('beginner')
    const found = lines.filter((l) => /PATTERN/.test(l) && /above the/.test(l))
    expect(found.length).toBe(1)
    expect(found[0]).toContain('14-set band')
  })

  it('says nothing about it for an advanced lifter', async () => {
    const lines: string[] = await patterns('advanced')
    /* An empty filter is also what a broken fixture returns, so prove the
       context was really built before believing its silence. */
    expect(lines.some((l) => /^Streak:/.test(l))).toBe(true)
    expect(lines.filter((l) => /PATTERN/.test(l) && /above the/.test(l))).toEqual([])
  })
})

describe('the weekly review reads the athlete’s band too', () => {
  /* weeklyReviewUncached builds the context the review renders from.
     It is a second analyse() call site, and a second chance to forget. */
  const reviewFor = (age: string) => run(`
    (function(){
      STATE.trainingAge = '${age}';
      STATE.history = {}; STATE.customLib = {};
      STATE.customLib.rv = { primary:[{muscle:'chest',share:1}], kind:'reps_weight' };
      STATE.exerciseNames.rv = 'rv';
      STATE.history.rv = [1, 4].map(function(back){
        var d = new Date(Date.now() - back * 86400000);
        var sets = []; for (var i = 0; i < 8; i++) sets.push({ w:100, r:8 });
        return { date: d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0')
                       + '-' + String(d.getDate()).padStart(2,'0'), kg:100, sets:sets };
      });
      return weeklyReviewUncached();
    })()`)

  it('calls 16 sets high for a beginner', () => {
    const review = reviewFor('beginner')
    expect(review.findings.map((f: any) => f.text).join(' | ')).toMatch(/above the 14-set band/)
  })

  it('says nothing about it for an advanced lifter', () => {
    const review = reviewFor('advanced')
    // prove the review really ran before believing its silence
    expect(typeof review.headline).toBe('string')
    expect(review.findings.map((f: any) => f.text).join(' | ')).not.toMatch(/above/)
  })
})

describe('one builder carries the athlete to every context', () => {
  /* briefFor, weeklyReview and analyse each sit behind a context literal.
     Three copies of the same two fields is three chances to drop one
     silently, so there is one builder and this is the test that holds it. */
  it('carries both fields that scale to the user', () => {
    expect(run("(function(){ STATE.trainingAge='advanced'; STATE.weeklyTarget=3; return athleteContext(); })()"))
      .toEqual({ weeklyTarget: 3, trainingAge: 'advanced' })
  })

  it('is what every context builder actually spreads', () => {
    /* Reading the shipped tile: a context that builds its own copy instead
       of spreading the builder is the failure this test exists to catch. */
    const tile = readFileSync('public/tiles/train.html', 'utf8')
    const spreads = (tile.match(/\.\.\.athleteContext\(\)/g) || []).length
    expect(spreads).toBe(2) // briefFor and weeklyReview
    // and no site hand-rolls the pair any more
    expect(tile).not.toMatch(/weeklyTarget: weeklyTarget\(\),\s*\n\s*trainingAge: trainingAge\(\),/)
  })

  it('reaches the post-session note — a beginner at 16 sets has something said', () => {
    const brief = run(`
      (function(){
        STATE.trainingAge = 'beginner';
        STATE.history = {}; STATE.customLib = {};
        STATE.customLib.bf = { primary:[{muscle:'chest',share:1}], kind:'reps_weight' };
        STATE.exerciseNames.bf = 'bf';
        STATE.history.bf = [1, 4].map(function(back){
          var d = new Date(Date.now() - back * 86400000);
          var sets = []; for (var i = 0; i < 8; i++) sets.push({ w:100, r:8 });
          return { date: d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0')
                         + '-' + String(d.getDate()).padStart(2,'0'), kg:100, sets:sets };
        });
        return TrainEngine.briefFor(Object.assign({
          history: STATE.history, index: TrainEngine.indexFrom(STATE.customLib),
          now: Date.now(), today: today,
          records: [], deloadsApplied: [], plateaus: [], firsts: [],
          streak: currentStreak(),
        }, athleteContext()), '');
      })()`)
    expect(JSON.stringify(brief)).toMatch(/above the 14-set band/)
  })
})

describe('an athlete who answered nothing gets the app they had yesterday', () => {
  it('keeps the shipped rep range, deload and target', () => {
    const shipped = run(`
      (function(){
        delete STATE.trainingAge; delete STATE.weeklyTarget;
        return {
          range: TrainEngine.normalizeClassification({ defaultSetKind:'reps_weight', tier:1 }).repRange,
          deload: TrainEngine.deloadPlan({ state:'deloading', kind:'intensity',
                    confidence:'measured', priorWeight:200, since:'2026-09-01',
                    plateauLength:3, sessions:0 }, trainingAge()).weight,
          target: weeklyTarget(),
        };
      })()`)
    expect(shipped).toEqual({ range: [4, 6], deload: 180, target: 4 })
  })
})
