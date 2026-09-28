import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { localToday } from '../helpers/clock'

/**
 * Training mode and edit mode.
 *
 * Mid-session a lift card carried eight controls beyond the set rows, for
 * somebody sweaty, breathing hard, holding a phone one-handed, forty
 * seconds into a rest timer. Seven of those belong to planning a session
 * rather than doing one.
 *
 * These assert which controls RENDER. Nothing here is about styling, so
 * they stand however the tile's stylesheet is resolved later.
 */

const exercise = (id: string, name: string) => ({
  id, name, tier: 2, sets: 3, reps: 5, kg: 185, perHand: false,
  rest: 90, lastKg: 185, pinned: false, collapsed: false, deload: false,
  note: '', log: [null, null, null],
})

const state = () => ({
  unit: 'lb', submitted: false,
  session: {
    date: localToday(),
    off: false, warmup: [], cooldown: [],
    ex: [exercise('bench', 'Bench Press'), exercise('row', 'Barbell Row')],
  },
  history: {}, customLib: {}, exerciseNames: {}, deloadStates: {},
  finishedDates: [], templates: [], shortTermGoal: '', otherTraining: [],
  photos: [], sessionDurations: [], liftGoals: [],
})

let win: any
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
  win = dom.window
  run = (expr: string) => win.eval(expr)
})

/**
 * Every control on the first lift card that is neither part of a set row
 * nor part of the rest timer.
 *
 * Both of those are things training mode KEEPS, so counting them as
 * clutter would make the reduction look smaller than it is — and the rest
 * bar only exists once a set has been logged, which would make the number
 * depend on test order.
 */
const cardControls = (): string[] =>
  run(`(function(){
    var card = document.querySelector('.ex');
    if (!card) return null;
    return [].slice.call(card.querySelectorAll('button, input'))
      .filter(function(el){ return !el.closest('.pill') && !el.closest('.restSlot'); })
      .map(function(el){ return el.dataset.act || el.className.split(' ')[0]; });
  })()`)

describe('the fixture itself', () => {
  it('booted with a rendered lift card and the mode helpers', () => {
    expect(run('typeof sessionMode')).toBe('function')
    expect(run('typeof setSessionMode')).toBe('function')
    expect(run("!!document.querySelector('.ex')")).toBe(true)
    // a card with no controls at all would make every assertion below pass
    expect(run("curSession().mode='edit'; render(); document.querySelectorAll('.ex button').length"))
      .toBeGreaterThan(0)
    run("setSessionMode('training')")
  })
})

describe('training mode is the default', () => {
  it('starts there with nothing stored', () => {
    run('delete curSession().mode; render();')
    expect(run('sessionMode()')).toBe('training')
  })

  it('renders log, the rest timer and swap, and nothing else', () => {
    run("setSessionMode('training')")
    expect(cardControls()).toEqual(['swap'])
  })

  it('still logs a set in one tap', () => {
    const logged = run(`(function(){
      var before = curSession().ex[0].log.filter(Boolean).length;
      document.querySelector('.pill.tappable .pillHit').click();
      return curSession().ex[0].log.filter(Boolean).length - before;
    })()`)
    expect(logged).toBe(1)
  })

  it('keeps the rest timer, which is the other thing you use mid-session', () => {
    expect(run("!!document.querySelector('.ex .restSlot')")).toBe(true)
  })

  it('keeps Finish, which is how a session ends', () => {
    expect(run("!!document.querySelector('#finishBtn')")).toBe(true)
  })

  it('still shows the lift’s name — it is hidden as a BUTTON, not as a name', () => {
    expect(run("document.querySelector('.ex .nameTxt').textContent")).toBe('Bench Press')
  })

  it('cannot start a drag — there is no grip, which is what drag keys off', () => {
    expect(run("!!document.querySelector('.ex .grip')")).toBe(false)
    /* Prove the mechanism rather than the absence: reordering happens on
       pointerdown on the grip, so with no grip there is nothing to press
       and the session order cannot move. */
    const order = run(`(function(){
      var before = curSession().ex.map(function(x){ return x.id; }).join(',');
      var card = document.querySelector('.ex');
      card.dispatchEvent(new PointerEvent('pointerdown', { bubbles:true }));
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles:true }));
      return { before: before, after: curSession().ex.map(function(x){ return x.id; }).join(',') };
    })()`)
    expect(order.after).toBe(order.before)
  })

  it('arms it again in edit mode, where the grip is', () => {
    run("setSessionMode('edit')")
    expect(run("!!document.querySelector('.ex .grip')")).toBe(true)
    run("setSessionMode('training')")
  })
})

describe('edit mode holds everything else', () => {
  it('renders the full set of controls', () => {
    run("setSessionMode('edit')")
    expect(cardControls()!.sort()).toEqual(
      ['eye', 'form', 'grip', 'history', 'menu', 'pin', 'ramp', 'swap', 'tune', 'whatif'].sort(),
    )
  })

  it('is one deliberate action away from training mode, and back', () => {
    run("setSessionMode('training')")
    expect(run('sessionMode()')).toBe('training')
    run("document.querySelector('#modeBtn').click()")
    expect(run('sessionMode()')).toBe('edit')
    run("document.querySelector('#modeBtn').click()")
    expect(run('sessionMode()')).toBe('training')
  })

  it('says which way the one action goes', () => {
    run("setSessionMode('training')")
    expect(run("document.querySelector('#modeBtn').textContent")).toBe('Edit session')
    run("setSessionMode('edit')")
    expect(run("document.querySelector('#modeBtn').textContent")).toBe('Done editing')
  })

  it('cuts the mid-session card from eight controls to one', () => {
    run("setSessionMode('edit')")
    const edit = cardControls()!.length
    run("setSessionMode('training')")
    const training = cardControls()!.length
    /* Nine since the warm-up ramp joined edit mode. Training mode is
       still the one thing it was: swap. */
    expect([edit, training]).toEqual([10, 1])
  })
})

describe('the mode does not leak across a session rollover', () => {
  it('opens tomorrow in training mode, whatever yesterday ended in', () => {
    const after = run(`(function(){
      setSessionMode('edit');
      // the day rolls over: curSession() builds a fresh session object
      STATE.session.date = '2000-01-01';
      var fresh = curSession();
      return { mode: sessionMode(), stored: fresh.mode, date: fresh.date };
    })()`)
    expect(after.mode).toBe('training')
    expect(after.stored).toBeUndefined()
    expect(after.date).not.toBe('2000-01-01')
  })

  it('is stored on the session rather than globally', () => {
    /* A global flag would survive the rollover above and leave somebody
       editing a session they meant to train. */
    run("setSessionMode('edit')")
    expect(run('curSession().mode')).toBe('edit')
    expect(run("STATE.mode === undefined && STATE.editMode === undefined")).toBe(true)
  })

  it('survives a reload within the same day', () => {
    run("setSessionMode('edit'); render();")
    expect(run('sessionMode()')).toBe('edit')
    expect(run('JSON.parse(JSON.stringify(STATE)).session.mode')).toBe('edit')
  })
})
