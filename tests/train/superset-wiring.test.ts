import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'

/* LOCAL date, never toISOString — see docs/train-verification.md. */
const localToday = () => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * Supersets in the tile: rest, timestamps, and the alternating prompt.
 *
 * The engine handles a linked pair correctly because each entry holds
 * only its own sets — interleaving in TIME cannot interleave the data.
 * What the engine cannot answer is what the tile does with rest, which is
 * the one thing a superset genuinely shares.
 */

const ex = (id: string, rest: number, group?: string) => ({
  id, name: id, tier: 2, sets: 3, reps: 5, kg: 100, perHand: false,
  rest, lastKg: 100, pinned: false, collapsed: false, deload: false,
  note: '', log: [null, null, null], ...(group ? { group } : {}),
})

const state = () => ({
  unit: 'lb', submitted: false,
  session: {
    date: localToday(), off: false, warmup: [], cooldown: [],
    ex: [ex('a', 60, 'A'), ex('b', 180, 'A'), ex('solo', 120)],
  },
  history: {}, customLib: {
    a: { kind: 'reps_weight' }, b: { kind: 'reps_weight' }, solo: { kind: 'reps_weight' },
  },
  exerciseNames: {}, deloadStates: {}, finishedDates: [], templates: [],
  shortTermGoal: '', otherTraining: [], photos: [], sessionDurations: [],
  liftGoals: [], bodyweight: [],
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

const reset = `
  (function(){
    STATE.history = {};
    curSession().ex.forEach(function(e){ e.log = [null, null, null]; });
    Object.keys(restTimers).forEach(stopRest);
    render();
    return curSession().ex.map(function(e){ return e.id + ':' + (e.group || '-'); });
  })()`

describe('the fixture itself', () => {
  it('booted with a linked pair and a solo lift', () => {
    expect(run(reset)).toEqual(['a:A', 'b:A', 'solo:-'])
    expect(run('typeof isLastInGroup')).toBe('function')
  })
})

describe('rest applies once to the group, not per exercise', () => {
  it('does not start a timer on the first lift of a pair', () => {
    const result = run(`
      (function(){
        ${reset};
        var pill = document.querySelector('.ex[data-id="a"] .pill .pillHit');
        pill.click();
        /* Control: the set really was logged. An empty timer list is
           also what you get when the click found nothing. */
        return { timers: Object.keys(restTimers),
                 logged: curSession().ex[0].log.filter(Boolean).length };
      })()`)
    expect(result.logged).toBe(1)
    expect(result.timers).toEqual([])
  })

  it('starts one on the last lift of the pair', () => {
    const timers = run(`
      (function(){
        ${reset};
        document.querySelector('.ex[data-id="b"] .pill .pillHit').click();
        return Object.keys(restTimers);
      })()`)
    expect(timers).toEqual(['b'])
  })

  it('starts one immediately for an unlinked lift', () => {
    const timers = run(`
      (function(){
        ${reset};
        document.querySelector('.ex[data-id="solo"] .pill .pillHit').click();
        return Object.keys(restTimers);
      })()`)
    expect(timers).toEqual(['solo'])
  })

  it('runs for the LAST lift’s rest, which is the group’s rest', () => {
    /* A genuine design question rather than a bug: the pair rests once,
       and the value used is whichever lift finishes the round. Recorded
       here so a change to it is deliberate. */
    const total = run(`
      (function(){
        ${reset};
        document.querySelector('.ex[data-id="b"] .pill .pillHit').click();
        return restTimers.b.total;
      })()`)
    expect(total).toBe(180)
  })

  it('shows the group on the rest bar, not one lift’s name', () => {
    const label = run(`
      (function(){
        ${reset};
        document.querySelector('.ex[data-id="b"] .pill .pillHit').click();
        var el = document.querySelector('.restLabel');
        return el ? el.textContent : null;
      })()`)
    expect(label).toBe('Superset A')
  })
})

describe('timestamps interleave in time without interleaving the data', () => {
  it('keeps each lift’s sets in its own history entry', () => {
    const stored = run(`
      (function(){
        ${reset};
        var real = Date.now; var clock = real.call(Date);
        Date.now = function(){ return clock; };
        try {
          for (var i = 0; i < 3; i++) {
            document.querySelectorAll('.ex[data-id="a"] .pill .pillHit')[0].click();
            clock += 90000;
            document.querySelectorAll('.ex[data-id="b"] .pill .pillHit')[0].click();
            clock += 90000;
          }
        } finally { Date.now = real; }
        return {
          a: STATE.history.a[0].sets.length,
          b: STATE.history.b[0].sets.length,
          aGaps: TrainEngine.restTaken(STATE.history.a[0]).gaps,
          bGaps: TrainEngine.restTaken(STATE.history.b[0]).gaps,
        };
      })()`)
    expect(stored.a).toBe(3)
    expect(stored.b).toBe(3)
    /* Each lift's own rest spans the partner's set — 180s, not 90. That
       is what a superset costs, and it is a fact about the training. */
    expect(stored.aGaps).toEqual([180, 180])
    expect(stored.bGaps).toEqual([180, 180])
  })

  it('does not attribute a partner’s set to this lift', () => {
    const volumes = run(`
      (function(){
        return { a: TrainEngine.workingVolume(STATE.history.a[0]).load,
                 b: TrainEngine.workingVolume(STATE.history.b[0]).load };
      })()`)
    expect(volumes.a).toBe(volumes.b)
    expect(volumes.a).toBe(100 * 5 * 3)
  })
})

describe('ungrouping restores ordinary behaviour', () => {
  it('starts a timer on every lift again', () => {
    const timers = run(`
      (function(){
        ${reset};
        curSession().ex.forEach(function(e){ delete e.group; });
        render();
        document.querySelector('.ex[data-id="a"] .pill .pillHit').click();
        return Object.keys(restTimers);
      })()`)
    expect(timers).toEqual(['a'])
  })
})
