import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { SET_KINDS } from '../../lib/train/classify'

/**
 * Every set kind needs a label and a unit, or the Tune dialog says
 * "undefined".
 *
 * SET_KINDS had seven entries; the tile's KIND_LABELS and KIND_UNITS
 * covered five. `bodyweight` and `weighted_bodyweight` rendered as two
 * rows reading "undefined / undefined" in the "How this is measured"
 * list — three taps from a session, and nothing failed.
 *
 * Read out of the RUNNING tile rather than parsed from source, so this
 * checks the values the dialog actually uses.
 */

let run: (expr: string) => unknown

beforeAll(async () => {
  const dom = new JSDOM(readFileSync('public/tiles/train.html', 'utf8'), {
    url: 'https://train.test/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(w: never) {
      const win = w as unknown as Record<string, unknown> & { HTMLCanvasElement: { prototype: Record<string, unknown> }, SVGElement?: { prototype: Record<string, unknown> } }
      win.Vitality = {
        load: async () => ({ unit: 'lb', session: { date: '2026-01-01', off: false, warmup: [], cooldown: [], ex: [] }, history: {}, customLib: {} }),
        save: () => {},
        read: async () => { throw new Error('no vitals') },
        classify: async () => { throw new Error('no_key') },
        getInsight: async () => { throw new Error('no_key') },
        generateWorkout: async () => { throw new Error('no_key') },
      }
      win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
      const noop = new Proxy({}, { get: () => () => noop })
      win.HTMLCanvasElement.prototype.getContext = () => noop
      if (win.SVGElement) win.SVGElement.prototype.getTotalLength = () => 100
    },
  })
  await new Promise((r) => setTimeout(r, 700))
  run = (expr: string) => dom.window.eval(expr)
}, 30_000)

describe('the kind maps cover every kind', () => {
  it('reads the maps out of the running tile', () => {
    expect(run('typeof KIND_LABELS')).toBe('object')
    expect(run('typeof KIND_UNITS')).toBe('object')
    expect(run('TrainEngine.SET_KINDS.length')).toBe(SET_KINDS.length)
  })

  it.each(SET_KINDS)('labels %s', (kind) => {
    const label = run(`KIND_LABELS[${JSON.stringify(kind)}]`)
    expect(typeof label, `${kind} has no label`).toBe('string')
    expect((label as string).length).toBeGreaterThan(0)
  })

  it.each(SET_KINDS)('gives %s a unit entry', (kind) => {
    /* An entry, not necessarily a non-empty one: bodyweight has no load
       to name, and an empty slot is the honest rendering of that. What
       must never happen is a MISSING key, which prints "undefined". */
    const units = run('KIND_UNITS') as Record<string, unknown>
    expect(Object.prototype.hasOwnProperty.call(units, kind), `${kind} missing from KIND_UNITS`).toBe(true)
    expect(typeof units[kind]).toBe('string')
  })

  it('says what the number means, not only how it is measured', () => {
    /* The pattern "lb help" already set for assisted lifts. */
    expect(run('KIND_UNITS.weighted_bodyweight')).toBe('lb added')
    expect(run('KIND_UNITS.bodyweight')).toBe('')
  })

  it('renders the Tune list with no undefined in it', () => {
    /* The whole point, checked through the dialog that was broken. */
    const html = run(`
      TrainEngine.SET_KINDS.map(function(k){
        return KIND_LABELS[k] + '|' + KIND_UNITS[k];
      }).join(' ')`) as string
    expect(html).not.toContain('undefined')
    expect(html).toContain('Weighted bodyweight|lb added')
  })
})
