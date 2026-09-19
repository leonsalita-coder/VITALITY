#!/usr/bin/env node
/**
 * How many taps does logging a set actually cost?
 *
 * Written BEFORE changing anything, so the "after" has something honest to
 * be compared against. A claim that logging got faster is worth nothing
 * without a number that was taken the same way twice.
 *
 * What counts as a tap: one `click` on a real element, plus one for
 * focusing a field you have to type into. Keystrokes are counted
 * separately — changing 185 to 190 is one field tap and three keystrokes,
 * and those are different costs to a person holding a phone at a rack.
 *
 *   node scripts/measure-logging.mjs
 *   node scripts/measure-logging.mjs --json      (for diffing runs)
 *
 * It drives public/tiles/train.html in jsdom, the same way the wiring
 * tests do, so it measures the shipped tile rather than a model of it.
 */

import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'

const TILE = 'public/tiles/train.html'

const exercise = (id, name) => ({
  id, name, tier: 2, sets: 3, reps: 5, kg: 185, perHand: false,
  rest: 90, lastKg: 185, pinned: false, collapsed: false, deload: false,
  note: '', log: [null, null, null],
})

const baseState = () => ({
  unit: 'lb', submitted: false,
  session: {
    date: new Date().toISOString().slice(0, 10),
    off: false, warmup: [], cooldown: [],
    ex: [exercise('bench', 'Bench Press'), exercise('row', 'Barbell Row'), exercise('squat', 'Back Squat')],
  },
  history: {}, customLib: {}, exerciseNames: {}, deloadStates: {},
  finishedDates: [], templates: [], shortTermGoal: '', otherTraining: [],
  photos: [], sessionDurations: [], liftGoals: [],
})

async function boot() {
  const dom = new JSDOM(readFileSync(TILE, 'utf8'), {
    url: 'https://train.test/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(w) {
      w.Vitality = {
        load: async () => baseState(),
        save: () => {},
        read: async () => { throw new Error('no vitals') },
        classify: async () => { throw new Error('no_key') },
        getInsight: async () => { throw new Error('no_key') },
        generateWorkout: async () => { throw new Error('no_key') },
      }
      w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
      /* The tile's background canvas is decoration, and jsdom has no 2d
         context to give it. Returning null makes the tile throw before a
         single tap is counted, so it gets a no-op context instead —
         stubbing the dependency rather than swallowing the crash. */
      const noop = new Proxy({}, { get: () => () => noop })
      w.HTMLCanvasElement.prototype.getContext = () => noop
    },
  })
  await new Promise((r) => setTimeout(r, 700))
  return dom
}

/** Counts every interaction the scenario performs. */
function counter(dom) {
  const tally = { taps: 0, keystrokes: 0 }
  return {
    tally,
    /** One tap on an element. Throws if it is not there — a scenario that
        silently skips a step would report a cheaper flow than exists. */
    tap(el, what) {
      if (!el) throw new Error(`nothing to tap: ${what}`)
      tally.taps++
      el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    },
    /** Focusing a field, then typing into it. */
    type(el, value, what) {
      if (!el) throw new Error(`nothing to type into: ${what}`)
      tally.taps++ // the tap that puts the cursor in the field
      tally.keystrokes += String(value).length
      el.value = String(value)
      el.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    },
    press(el, key) {
      tally.keystrokes++
      el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    },
  }
}

const firstPill = (doc) => doc.querySelector('.pill.tappable')
const loggedCount = (win) =>
  win.eval('curSession().ex.reduce((n,e)=>n+e.log.filter(Boolean).length,0)')

/* ---------------------------------------------------------------- */

const scenarios = {
  /** The common case: the app guessed right and you just did the set. */
  async prefill_correct(dom) {
    const { window: win } = dom
    const c = counter(dom)
    const before = loggedCount(win)
    c.tap(firstPill(win.document).querySelector('.pillHit'), 'Hit it')
    return { ...c.tally, logged: loggedCount(win) - before }
  },

  /** The app guessed right, and you tap the row rather than the button. */
  async prefill_correct_row(dom) {
    const { window: win } = dom
    const c = counter(dom)
    const before = loggedCount(win)
    c.tap(firstPill(win.document), 'the row itself')
    return { ...c.tally, logged: loggedCount(win) - before }
  },

  /** You moved up and the app had not caught up yet. */
  async weight_change(dom) {
    const { window: win } = dom
    const c = counter(dom)
    const before = loggedCount(win)
    const pill = firstPill(win.document)
    c.type(pill.querySelector('.w'), 195, 'weight')
    c.tap(pill.querySelector('.pillHit'), 'Hit it')
    return { ...c.tally, logged: loggedCount(win) - before }
  },

  /** Weight and reps both off. */
  async weight_and_reps_change(dom) {
    const { window: win } = dom
    const c = counter(dom)
    const before = loggedCount(win)
    const pill = firstPill(win.document)
    c.type(pill.querySelector('.w'), 195, 'weight')
    c.type(pill.querySelector('.r'), 8, 'reps')
    c.tap(pill.querySelector('.pillHit'), 'Hit it')
    return { ...c.tally, logged: loggedCount(win) - before }
  },

  /** The set that did not happen. */
  async mark_miss(dom) {
    const { window: win } = dom
    const c = counter(dom)
    const before = loggedCount(win)
    c.tap(firstPill(win.document).querySelector('.pillMiss'), 'Miss')
    return { ...c.tally, logged: loggedCount(win) - before }
  },

  /** Flagging a warm-up, then logging it. */
  async warmup_set(dom) {
    const { window: win } = dom
    const c = counter(dom)
    const before = loggedCount(win)
    c.tap(firstPill(win.document).querySelector('[data-act="warmup"]'), 'W')
    return { ...c.tally, logged: loggedCount(win) - before }
  },

  /** Nine sets across three lifts, every prefill correct. */
  async full_session_9_sets(dom) {
    const { window: win } = dom
    const c = counter(dom)
    const before = loggedCount(win)
    for (let i = 0; i < 9; i++) {
      const pill = firstPill(win.document)
      if (!pill) break
      c.tap(pill.querySelector('.pillHit'), `set ${i + 1}`)
    }
    const logged = loggedCount(win) - before
    return { ...c.tally, logged, perSet: +(c.tally.taps / Math.max(1, logged)).toFixed(2) }
  },

  /** Adding the RPE the app asks for after a set. */
  async log_then_rpe(dom) {
    const { window: win } = dom
    const c = counter(dom)
    const before = loggedCount(win)
    c.tap(firstPill(win.document).querySelector('.pillHit'), 'Hit it')
    const rpeBtn = win.document.querySelector('[data-act="rpe"]')
    c.tap(rpeBtn, 'RPE')
    c.tap(win.document.querySelector('.swapItem[data-v="8"]'), 'RPE 8')
    return { ...c.tally, logged: loggedCount(win) - before }
  },
}

/**
 * How crowded ONE exercise is while you are training on it.
 *
 * The card's class is `.ex`. An earlier version of this looked for
 * `.exCard`, found nothing, silently fell back to document.body and
 * reported the whole board as though it were one lift — a measurement
 * that fails open is worse than no measurement, so this throws instead.
 */
function density(win) {
  const card = win.document.querySelector('.ex')
  if (!card) throw new Error('no .ex card rendered — nothing to measure')
  const all = [...card.querySelectorAll('button, input')]
  /* The set rows and the rest timer are both things training mode keeps,
     so they are not clutter and are counted separately. The rest bar also
     only exists once a set is logged, and a number that moved with test
     order would not be a measurement. */
  const kept = (el) => el.closest('.pill') || el.closest('.restSlot')
  const extra = all.filter((el) => !kept(el))
  return {
    controls_per_exercise: all.length,
    controls_outside_the_set_rows: extra.length,
    set_rows: card.querySelectorAll('.pill').length,
    controls_outside_set_rows_listed: extra.map(
      (el) => el.dataset.act || el.className.split(' ')[0] || el.tagName.toLowerCase(),
    ),
  }
}

/** Declared minimum tap-target sizes, read from the tile's own CSS. */
function targets(html) {
  const css = (html.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || ''
  const find = (selector) => {
    const block = new RegExp(`\\${'.'}${selector}\\b[^{]*\\{([^}]*)\\}`).exec(css)
    if (!block) return null
    const h = /(?:min-height|height)\s*:\s*([0-9.]+)px/.exec(block[1])
    const w = /(?:min-width|width)\s*:\s*([0-9.]+)px/.exec(block[1])
    if (!h && !w) return null
    return { height: h ? +h[1] : null, width: w ? +w[1] : null }
  }
  const out = {}
  for (const s of ['pillHit', 'pillMiss', 'pillWarm', 'pillInput', 'pillReset', 'actionPill']) {
    out[s] = find(s)
  }
  return out
}

/**
 * Which inputmode each field asks the phone keyboard for.
 *
 * Scoped to one set row. Scanning the document picks up the plate-config
 * and goal fields too, which are not what anyone taps mid-set.
 */
function keyboards(win) {
  const row = win.document.querySelector('.pill')
  if (!row) throw new Error('no .pill row rendered — nothing to measure')
  const out = {}
  for (const input of row.querySelectorAll('.pillInput')) {
    out[input.getAttribute('aria-label')?.split(' —')[0] || '?'] = input.getAttribute('inputmode')
  }
  return out
}

async function main() {
  const asJson = process.argv.includes('--json')
  const html = readFileSync(TILE, 'utf8')
  const results = {}

  for (const [name, run] of Object.entries(scenarios)) {
    const dom = await boot()
    try {
      results[name] = await run(dom)
    } catch (err) {
      results[name] = { error: err.message }
    }
    dom.window.close()
  }

  const dom = await boot()
  const shape = { ...density(dom.window), keyboards: keyboards(dom.window) }
  /* The same card with everything on it, so the training-mode number has
     something to be a reduction OF. */
  dom.window.eval("curSession().mode='edit'; render();")
  const editShape = density(dom.window)
  dom.window.close()

  const report = { scenarios: results, shape, edit_mode: editShape, tap_targets_px: targets(html) }

  if (asJson) {
    console.log(JSON.stringify(report, null, 2))
    return
  }

  console.log('\nLOGGING COST — ' + TILE + '\n')
  console.log('  scenario                        taps  keys  sets logged')
  console.log('  ' + '-'.repeat(56))
  for (const [name, r] of Object.entries(results)) {
    if (r.error) {
      console.log(`  ${name.padEnd(30)}  FAILED: ${r.error}`)
      continue
    }
    const per = r.perSet != null ? `   (${r.perSet}/set)` : ''
    console.log(
      `  ${name.padEnd(30)}  ${String(r.taps).padStart(4)}  ${String(r.keystrokes).padStart(4)}  ${String(r.logged).padStart(11)}${per}`,
    )
  }
  console.log('\n  one exercise — controls beyond the set rows:')
  console.log(`    training mode ................... ${shape.controls_outside_the_set_rows}  [${shape.controls_outside_set_rows_listed.join(', ')}]`)
  console.log(`    edit mode ....................... ${editShape.controls_outside_the_set_rows}  [${editShape.controls_outside_set_rows_listed.join(', ')}]`)
  console.log(`    controls on the card, training .. ${shape.controls_per_exercise}`)
  console.log(`    set rows ........................ ${shape.set_rows}`)
  console.log('\n  phone keyboard per field:')
  for (const [field, mode] of Object.entries(shape.keyboards)) {
    console.log(`    ${field.padEnd(10)} inputmode="${mode}"`)
  }
  console.log('\n  declared tap targets (px):')
  for (const [sel, size] of Object.entries(report.tap_targets_px)) {
    console.log(`    .${sel.padEnd(12)} ${size ? `${size.width ?? '—'} x ${size.height ?? '—'}` : 'not declared'}`)
  }
  console.log('')
}

main()
