import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'

/**
 * Every Progress view drawn from a real history, in the real tile.
 *
 * Charts are the easiest thing in this codebase to break silently: a view
 * that throws leaves the previous one on screen, and a view that renders
 * nothing looks identical to a view with no data.
 */

const ago = (n: number) => {
  const d = new Date(); d.setDate(d.getDate() - n)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
const entry = (day: number, w: number, reps: number, sets = 3) => ({
  date: ago(day), kg: w, sets: Array.from({ length: sets }, () => ({ w, r: reps })),
})

const state = () => ({
  unit: 'lb', submitted: false,
  session: { date: '1970-01-01', off: false, warmup: [], cooldown: [], ex: [] },
  history: {
    bench_press: [entry(21, 175, 5), entry(14, 180, 5), entry(7, 185, 5), entry(2, 185, 6)],
    back_squat: [entry(20, 225, 5, 4), entry(6, 235, 5, 4)],
  },
  customLib: {
    bench_press: { equipment: 'barbell', primary: ['Chest'], secondary: ['Triceps'] },
    back_squat: { equipment: 'barbell', primary: ['Quads'] },
  },
  exerciseNames: { bench_press: 'Bench Press', back_squat: 'Back Squat' },
  finishedDates: [ago(21), ago(20), ago(14), ago(7), ago(6), ago(2)],
  templates: [], shortTermGoal: '', photos: [], sessionDurations: [], liftGoals: [],
  weeklyTarget: 4,
})

let win: any
let run: (expr: string) => any

beforeAll(async () => {
  const dom = new JSDOM(readFileSync('public/tiles/train.html', 'utf8'), {
    // a real origin: about:blank is opaque, and storage the tile touches
    // throws there — a setup that fails silently is a test proving nothing
    url: 'https://train.test/',
    runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w: any) {
      w.Vitality = {
        load: async () => state(), save: () => {},
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
  win = dom.window
  run = (expr: string) => win.eval(expr)
})

/** A tile that failed to boot renders nothing, and "nothing" passes a
 *  surprising number of assertions. */
describe('the fixture itself', () => {
  it('booted with the seeded history', () => {
    expect(run('Object.keys(STATE.history).length')).toBe(2)
    expect(run('STATE.finishedDates.length')).toBe(6)
  })
})

const draw = (id: string) =>
  run(`(function(){ statsView = { id: '${id}' }; drawStatsSection();
       return { html: document.querySelector('#statsPlot').innerHTML,
                cap: document.querySelector('#statsCap').textContent }; })()`)

describe('every view draws from a real history', () => {
  it('strength — e1RM trend, the default', () => {
    const out = draw('__e1rm')
    expect(out.html).toContain('sPoint')
    expect(out.cap).toMatch(/estimated 1RM/)
  })

  it('defaults to strength on load', () => {
    expect(run('statsView.id')).toBe('__e1rm')
  })

  it('muscles — hard sets against the band', () => {
    const out = draw('__muscles')
    expect(out.html).toContain('mbFill')
    expect(out.cap).toMatch(/10–20 band/)
  })

  it('consistency — rolling sessions per week', () => {
    const out = draw('__consistency')
    expect(out.html).toContain('mbFill')
    expect(out.cap).toMatch(/rolling week/)
  })

  it('8 vs 8 — period comparison', () => {
    const out = draw('__compare')
    expect(out.html).toMatch(/Sessions/)
    expect(out.html).toMatch(/Hard sets/)
  })

  it('the calendar heatmap is kept', () => {
    expect(draw('__sessions').html.length).toBeGreaterThan(50)
  })

  it('a single lift still charts', () => {
    expect(draw('bench_press').html.length).toBeGreaterThan(20)
  })

  it('no view throws on an empty history', () => {
    for (const id of ['__e1rm', '__muscles', '__consistency', '__compare']) {
      const out = run(`(function(){
        var keep = STATE.history; STATE.history = {};
        statsView = { id: '${id}' };
        var err = null;
        try { drawStatsSection(); } catch(e) { err = String(e); }
        STATE.history = keep;
        return err;
      })()`)
      expect(out, `${id} threw`).toBeNull()
    }
  })
})

describe('estimated data is marked wherever it is shown', () => {
  it('marks the muscle view, whose splits come from the classifier', () => {
    const out = draw('__muscles')
    expect(out.cap).toMatch(/estimated muscle split/)
    expect(out.html).toContain('*')
  })

  it('does not claim estimation on the strength chart, which uses no splits', () => {
    expect(draw('__e1rm').cap).not.toMatch(/estimated muscle/)
  })
})

describe('points tap back to their session', () => {
  it('carries the source date on every point', () => {
    const dates = run(`(function(){ statsView={id:'__e1rm'}; drawStatsSection();
      return [...document.querySelectorAll('#statsPlot .sPoint')].map(b=>b.dataset.date); })()`)
    expect(dates.length).toBeGreaterThan(1)
    for (const d of dates) expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('opens what was logged that day', () => {
    const body = run(`(function(){
      statsView={id:'__e1rm'}; drawStatsSection();
      var p = document.querySelector('#statsPlot .sPoint');
      p.onclick();
      return document.querySelector('#popRoot').textContent || '';
    })()`)
    expect(body).toMatch(/Bench Press/)
  })
})

describe('the vanity cards are gone', () => {
  it('no longer shows hours trained or exercises tracked', () => {
    const html = run(`(function(){ renderOverviewCards();
      return document.querySelector('#overviewCards').innerHTML; })()`)
    expect(html).not.toMatch(/Hours trained/)
    expect(html).not.toMatch(/Exercises tracked/)
    expect(html).not.toMatch(/Sessions \/ week/)
  })

  it('keeps the ones that reward the behaviour that produces progress', () => {
    const html = run(`(function(){ renderOverviewCards();
      return document.querySelector('#overviewCards').innerHTML; })()`)
    expect(html).toMatch(/Week streak/)
    expect(html).toMatch(/Personal records/)
  })
})
