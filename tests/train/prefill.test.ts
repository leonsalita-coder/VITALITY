import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'

/* LOCAL date, never toISOString.
   toISOString is UTC: east of UTC it returns yesterday's local date, the
   session never matches the tile's `today`, curSession() rebuilds it
   empty, and every assertion below silently stops testing anything.
   Found by `npm run mutate:fuzz` — 44 tests were passing vacuously in
   Sydney. */
const localToday = () => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * Progression happens BETWEEN sessions, not within one.
 *
 * The bug this file exists to prevent: logging a clean set wrote today's
 * partial entry into history, the next unlogged row recomputed its
 * suggestion from that, and the prescription climbed an increment per set.
 * Three clean sets of 315 were logged as 315, 320, 325.
 *
 * That is not a display problem. Those weights were WRITTEN — into
 * history, into volume, into e1RM, into the plateau read, into every
 * record that has been set since. A suggestion is computed once per
 * exercise per session from history as of session start, and logging
 * cannot move it.
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

/** Prior sessions at a flat weight, then a fresh empty session today. */
const reset = (kg = 315, priorWeeks = 2) => `
  (function(){
    STATE.customLib.squat = { equipment:'Barbell', kind:'reps_weight', incrementLb:5 };
    STATE.exerciseNames.squat = 'Back Squat';
    STATE.history.squat = [];
    for (var i = 0; i < ${priorWeeks}; i++) {
      var d = new Date(Date.now() - (${priorWeeks} - i) * 7 * 86400000);
      var date = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0')
               + '-' + String(d.getDate()).padStart(2,'0');
      STATE.history.squat.push({ date: date, kg: ${kg},
        sets: [{w:${kg},r:5},{w:${kg},r:5},{w:${kg},r:5}] });
    }
    /* The whole exercise is rebuilt, not patched. Half-resetting leaks
       an earlier test's rep range or reps into this one and it answers
       the previous question — which is exactly how the first version of
       this fixture reported a suggestion of 315 for a 320 lb session. */
    delete STATE.trainingAge;
    STATE.deloadStates = {};
    curSession().ex = [{ id:'squat', name:'Back Squat', tier:2, sets:3, reps:5,
      kg:${kg}, perHand:false, rest:90, lastKg:${kg}, pinned:false,
      collapsed:false, deload:false, note:'', log:[null,null,null] }];
    clearSuggestions();
    render();
    return true;
  })()`

/** The weight each row is prefilled with right now. */
const prefills = () => run(`
  [].slice.call(document.querySelectorAll('.pill')).map(function(p){
    var w = p.querySelector('.w'); return w ? +w.value : null;
  })`)

describe('the fixture itself', () => {
  it('booted with three rows and prior history', () => {
    expect(run(reset())).toBe(true)
    expect(run("document.querySelectorAll('.pill').length")).toBe(3)
    expect(run('STATE.history.squat.length')).toBe(2)
  })
})

describe('three clean sets all prefill the same weight', () => {
  it('starts every row at the same number', () => {
    run(reset())
    const all = prefills()
    expect(all).toEqual([all[0], all[0], all[0]])
  })

  it('does not move as sets are logged', () => {
    run(reset())
    const before = prefills()[0]
    const during: number[] = []
    for (let i = 0; i < 3; i++) {
      during.push(prefills()[i])
      run(`document.querySelectorAll('.pill')[${i}].querySelector('.pillHit').click()`)
    }
    expect(during).toEqual([before, before, before])
  })

  it('writes all three into history at the same weight', () => {
    const stored = run(`
      (function(){
        ${reset()};
        for (var i = 0; i < 3; i++) {
          document.querySelectorAll('.pill')[i].querySelector('.pillHit').click();
        }
        return STATE.history.squat[STATE.history.squat.length - 1].sets.map(function(s){ return s.w; });
      })()`)
    expect(stored).toEqual([320, 320, 320])
  })
})

describe('the next session moves once, not three times', () => {
  it('advances a single increment after three clean sets', () => {
    const result = run(`
      (function(){
        ${reset()};
        var startedAt = suggestionFor(curSession().ex[0], prescription(curSession().ex[0])).weight;
        for (var i = 0; i < 3; i++) {
          document.querySelectorAll('.pill')[i].querySelector('.pillHit').click();
        }
        var logged = STATE.history.squat[STATE.history.squat.length - 1];
        /* Tomorrow: a fresh session reading the completed one. */
        var next = TrainEngine.suggestTarget(
          STATE.history.squat,
          progressionInputFor(curSession().ex[0], { kg: logged.kg, reps:5, sets:3, rest:90 }),
          Date.now() + 86400000);
        return { startedAt: startedAt, loggedAt: logged.kg, next: next.weight };
      })()`)
    // started at 320 (one step up from 315), logged at 320, next is 325
    expect(result.loggedAt).toBe(result.startedAt)
    expect(result.next - result.loggedAt).toBe(5)
  })
})

describe('the suggestion reads history as of session start', () => {
  it('ignores today’s own entry entirely', () => {
    const same = run(`
      (function(){
        ${reset()};
        var ex = curSession().ex[0];
        var before = suggestionFor(ex, prescription(ex)).weight;
        document.querySelectorAll('.pill')[0].querySelector('.pillHit').click();
        var after = suggestionFor(ex, prescription(ex)).weight;
        return { before: before, after: after };
      })()`)
    expect(same.after).toBe(same.before)
  })

  it('is unmoved by undoing a set, too', () => {
    const same = run(`
      (function(){
        ${reset()};
        var ex = curSession().ex[0];
        var before = suggestionFor(ex, prescription(ex)).weight;
        document.querySelectorAll('.pill')[0].querySelector('.pillHit').click();
        document.querySelectorAll('.pill')[0].querySelector('.pillReset').click();
        return { before: before, after: suggestionFor(ex, prescription(ex)).weight };
      })()`)
    expect(same.after).toBe(same.before)
  })

  it('still recomputes when the prescription itself changes', () => {
    /* Memoising must not freeze the suggestion against real edits — a
       changed rep range in Tune has to be reflected immediately. */
    const moved = run(`
      (function(){
        ${reset()};
        var ex = curSession().ex[0];
        var before = suggestionFor(ex, prescription(ex));
        STATE.customLib.squat.repRange = [8, 12];
        ex.reps = 8;
        var after = suggestionFor(ex, prescription(ex));
        return { before: before.reps, after: after.reps };
      })()`)
    expect(moved.after).not.toBe(moved.before)
  })

  it('is computed ONCE per exercise, not once per row', () => {
    /* Excluding today's history is what makes the prefill correct; this
       is the other half of the spec, and it needs its own test because
       correctness alone would not notice three identical computations. */
    /* Counted by wrapping the tile's own input builder. TrainEngine's
       members are esbuild getters and cannot be reassigned — patching one
       silently does nothing and the spy reports zero, which looks like a
       pass for the wrong reason. */
    const calls = run(`
      (function(){
        ${reset()};
        var real = progressionInputFor;
        var n = 0;
        progressionInputFor = function(){ n++; return real.apply(null, arguments); };
        try { clearSuggestions(); render(); } finally { progressionInputFor = real; }
        return { calls: n, rows: document.querySelectorAll('.pill').length };
      })()`)
    expect(calls.rows).toBe(3)
    expect(calls.calls).toBe(1)
  })

  it('does not climb on a lift being logged for the first time', () => {
    /* No prior history at all, so the suggestion comes off lastKg — the
       field the rollup moves as sets land. A reload mid-session drops the
       memo and recomputes, and it must still prescribe the same weight. */
    const rows = run(`
      (function(){
        ${reset()};
        STATE.history.squat = [];          // first ever session
        var ex = curSession().ex[0];
        ex.lastKg = null;
        clearSuggestions(); render();
        var first = +document.querySelectorAll('.pill')[0].querySelector('.w').value;
        document.querySelectorAll('.pill')[0].querySelector('.pillHit').click();
        clearSuggestions(); render();
        var second = +document.querySelectorAll('.pill')[1].querySelector('.w').value;
        return { first: first, second: second, lastKgNow: ex.lastKg };
      })()`)
    expect(rows.second).toBe(rows.first)
  })

  it('holds the session-start answer even if the cache is lost mid-session', () => {
    /* A reload mid-session drops the memo. The answer must come back the
       same, which it only does if the INPUTS are session-start inputs —
       so this is what proves lastKg is read from before today rather
       than from the value the rollup has been moving. */
    const same = run(`
      (function(){
        ${reset()};
        var ex = curSession().ex[0];
        var before = suggestionFor(ex, prescription(ex)).weight;
        document.querySelectorAll('.pill')[0].querySelector('.pillHit').click();
        clearSuggestions();            // the reload
        return { before: before, after: suggestionFor(ex, prescription(ex)).weight,
                 lastKgNow: ex.lastKg };
      })()`)
    // the rollup did move e.lastKg; the suggestion must not have followed it
    expect(same.lastKgNow).toBe(320)
    expect(same.after).toBe(same.before)
  })

  it('recomputes when only the rep range changes', () => {
    const moved = run(`
      (function(){
        ${reset()};
        var ex = curSession().ex[0];
        var before = suggestionFor(ex, prescription(ex));
        STATE.customLib.squat.repRange = [3, 5];   // nothing else touched
        return { before: before.reps, after: suggestionFor(ex, prescription(ex)).reps };
      })()`)
    expect(moved.after).not.toBe(moved.before)
  })

  it('recomputes when only the training age changes', () => {
    const moved = run(`
      (function(){
        ${reset()};
        STATE.deloadStates.squat = { state:'deloading', kind:'intensity',
          confidence:'measured', priorWeight:315, since:'2026-09-01',
          plateauLength:3, sessions:0 };
        var ex = curSession().ex[0];
        STATE.trainingAge = 'beginner';
        var beginner = suggestionFor(ex, prescription(ex)).weight;
        STATE.trainingAge = 'advanced';           // nothing else touched
        var advanced = suggestionFor(ex, prescription(ex)).weight;
        delete STATE.trainingAge; delete STATE.deloadStates.squat;
        return { beginner: beginner, advanced: advanced };
      })()`)
    expect(moved.beginner).toBeGreaterThan(moved.advanced)
  })

  it('does not serve one session’s answer to another', () => {
    /* The memo is keyed on the session, so two different sessions cannot
       share an entry. Compared as keys rather than as answers, because
       the two answers may legitimately be the same number and that would
       make the test pass whether or not the memo was shared. */
    const shared = run(`
      (function(){
        ${reset()};
        var ex = curSession().ex[0];
        var a = suggestionKey(ex, prescription(ex));
        var realDate = STATE.session.date;
        STATE.session.date = '2030-01-01';
        var b = suggestionKey(ex, prescription(ex));
        STATE.session.date = realDate;
        return a === b;
      })()`)
    expect(shared).toBe(false)
  })

  it('moves on once yesterday’s session is in the past', () => {
    /* A faithful rollover: the logged session becomes yesterday's, so it
       is now prior history and the suggestion may finally advance off it.
       Changing only the session date would not do — curSession() rebuilds
       to today, and the logged entry carries today's date too. */
    const moved = run(`
      (function(){
        ${reset()};
        var ex = curSession().ex[0];
        var before = suggestionFor(ex, prescription(ex)).weight;
        for (var i = 0; i < 3; i++) {
          document.querySelectorAll('.pill')[i].querySelector('.pillHit').click();
        }
        var logged = STATE.history.squat[STATE.history.squat.length - 1];
        var d = new Date(Date.now() - 86400000);
        logged.date = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0')
                    + '-' + String(d.getDate()).padStart(2,'0');
        ex.log = [null, null, null];
        clearSuggestions();
        return { before: before, after: suggestionFor(ex, prescription(ex)).weight };
      })()`)
    expect(moved.after).toBeGreaterThan(moved.before)
    expect(moved.after - moved.before).toBe(5)
  })

})
