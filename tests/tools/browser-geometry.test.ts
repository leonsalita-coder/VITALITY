import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'

/**
 * Three geometric tripwires this suite could not build before, because
 * nothing else in it renders. JSDOM has no layout engine —
 * getBoundingClientRect() returns zeros, computed dimensions don't
 * reflect the cascade's actual box math — so a tap target, a cell size,
 * or a horizontal overflow has never been directly measurable here. Two
 * real bugs this week were geometry a real browser caught that this
 * suite structurally could not: the 616px horizontal overflow from an
 * unstyled canvas, and the heatmap's tap target measuring 42 instead of
 * 44 through three separate "fixed" attempts, each one checked by
 * reasoning about the CSS rather than by rendering it.
 *
 * WHAT THIS FILE DOES NOT COVER — read this before trusting it for
 * anything beyond the three assertions below. These are three specific
 * tripwires, not general layout coverage. Of the five geometric bugs
 * found this week, these three assertions would have caught exactly
 * two (the overflow, and the tap target) — the other three are
 * invisible to everything here:
 *   - A devicePixelRatio backing store capped at 2x instead of reading
 *     the device's real value: a canvas RESOLUTION bug, not a box-model
 *     one. Nothing here inspects a canvas's pixel buffer.
 *   - An unstyled button computing to UA ButtonFace and reading 33%
 *     louder than the primary CTA: a COLOUR/contrast bug. Covered by
 *     computed-color-guard.test.ts, not this file, and only for the
 *     specific gold/mint/signal pattern that guard checks — general
 *     contrast is not checked anywhere in this suite.
 *   - Four future days rendered as indistinguishable rest-day cells: a
 *     DATA/behaviour bug (which dates get included), not a geometry bug
 *     — the cells that render are correctly sized and positioned; the
 *     problem was which dates existed at all.
 * A green run here is a claim about overflow, tap-target size, and
 * stylesheet reach specifically — nothing else.
 *
 * FONTS ARE THE FLAKE VECTOR for assertion (a). The tile's font stack
 * starts `-apple-system`; on a non-Apple machine that falls back to a
 * different font with different metrics, text can run wider, and a
 * horizontal-overflow check can fail for a reason that has nothing to
 * do with any layout bug. This is a standing, accepted assumption, not
 * an oversight: there is no CI for this repo (confirmed — no
 * `.github/workflows` or equivalent exists) and both machines that run
 * this are macOS, so the font stack's first choice always resolves.
 * Whoever hits this on a non-Apple machine later should read it as "the
 * font changed," not "the layout broke."
 */

const TILE = resolve('public/tiles/train.html')
const BASELINE_FILE = '.tap-target-baseline.json'

const ago = (n: number) => {
  const d = new Date(); d.setDate(d.getDate() - n)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
const session = (day: number, kg: number, reps = 5, sets = 3) => ({
  date: ago(day), kg, sets: Array.from({ length: sets }, () => ({ w: kg, r: reps })),
})
const state = {
  unit: 'lb', submitted: false,
  session: { date: '1970-01-01', off: false, warmup: [], cooldown: [], ex: [] },
  history: {
    squat: [session(200, 185), session(150, 190), session(100, 205), session(50, 215), session(10, 225), session(3, 230)],
    bench: [session(90, 135), session(60, 140), session(30, 145), session(5, 150)],
  },
  customLib: {
    squat: { equipment: 'barbell', kind: 'reps_weight', primary: ['Quads'] },
    bench: { equipment: 'barbell', kind: 'reps_weight', primary: ['Chest'] },
  },
  exerciseNames: { squat: 'Squat', bench: 'Bench Press' },
  finishedDates: [200, 150, 100, 50, 10, 3, 90, 60, 30, 5].map(ago),
  templates: [], shortTermGoal: '', otherTraining: [], photos: [], sessionDurations: [],
  liftGoals: [], bodyweight: [], deloadStates: {},
}

let browser: Browser
let page: Page

beforeAll(async () => {
  browser = await chromium.launch()
  page = await browser.newPage({ viewport: { width: 393, height: 852 } })
  await page.addInitScript((st) => {
    ;(window as any).Vitality = {
      load: async () => st, save: () => {},
      read: async () => { throw new Error('no vitals') },
      classify: async () => { throw new Error('no_key') },
      getInsight: async () => { throw new Error('no_key') },
      generateWorkout: async () => { throw new Error('no_key') },
    }
  }, state)
}, 30_000)

afterAll(async () => {
  await browser.close()
})

/** Boots a fresh copy of the tile and drives it through three scenes —
 * the default boot (what every session opens on), a real popup
 * (settings — exercises a dialog, not just the main flow), and the
 * heatmap (the newest, most recently fragile surface) — calling the
 * given measurement function once at each. All three of (a)/(b)/(c)
 * are built from the same three scenes, so this is the one place that
 * pattern is defined. */
async function overThreeScenes<T>(measure: () => Promise<T>): Promise<{ boot: T; afterPopup: T; afterHeatmap: T }> {
  await page.goto('file://' + TILE)
  await page.waitForTimeout(1000)
  const clientWidth = await page.evaluate(() => document.documentElement.clientWidth)
  if (clientWidth !== 393) throw new Error(`tile did not render at the requested viewport — clientWidth was ${clientWidth}, not 393`)
  const boot = await measure()

  await page.evaluate(() => (document.querySelector('#settingsBtn') as HTMLElement)?.click())
  await page.waitForTimeout(100)
  const afterPopup = await measure()
  await page.evaluate(() => { if (typeof (window as any).closePop === 'function') (window as any).closePop() })
  await page.waitForTimeout(100)

  await page.evaluate(() => { (window as any).statsView = { id: '__heatmap' }; (window as any).drawStatsSection() })
  await page.waitForTimeout(100)
  const afterHeatmap = await measure()

  return { boot, afterPopup, afterHeatmap }
}

const readOverflow = () => page.evaluate(() => ({
  scrollWidth: document.documentElement.scrollWidth,
  clientWidth: document.documentElement.clientWidth,
}))

/** Every interactive element's real hit box, at the page's CURRENT
 * state. Not derived from declarations (scripts/measure-targets.mjs
 * already does that, and says so in its own header) — this reads
 * getBoundingClientRect() on the actual rendered, cascade-resolved,
 * flex/grid-laid-out box. */
const sweepHitTargets = () => page.evaluate(() => {
  const MIN = 44
  const sel = 'button, a[href], input, select, textarea, [role="button"], [tabindex]:not([tabindex="-1"])'
  const els = [...document.querySelectorAll(sel)]
  const bad: string[] = []
  for (const el of els) {
    const style = getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden') continue
    const r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) continue // not laid out at all — not a real target on screen
    if (r.width < MIN || r.height < MIN) {
      bad.push((el.id ? '#' + el.id : el.tagName.toLowerCase()) + (el.className ? '.' + String(el.className).trim().replace(/\s+/g, '.') : ''))
    }
  }
  return { total: els.length, bad }
})

/** Every rule in the tile's own stylesheet (the real, browser-parsed
 * CSSOM — not a regex re-parse of the source text) that matches at
 * least one element currently in the DOM. Interaction-state pseudo-
 * classes (:hover, :focus, ::before, …) are stripped before matching:
 * querySelectorAll evaluates :hover against the ACTUAL live hover
 * state, which is never true in a script-driven page, so a rule that
 * only ever reaches its target via :hover would read as "unmatched"
 * for a reason that has nothing to do with the stylesheet being
 * broken. Structural pseudo-classes (:not(), :first-child, …) are left
 * alone — querySelectorAll evaluates those correctly against the
 * static DOM. */
const matchedSelectors = () => page.evaluate(() => {
  const SKIP_PSEUDO = /:(?:hover|active|focus(?:-visible|-within)?|disabled|checked|placeholder-shown|empty)\b|::(?:before|after|placeholder|selection)/g
  const sheet = [...document.styleSheets][0]
  const selectors: string[] = []
  ;(function collect(rules: any) {
    for (const r of rules) {
      if (r.selectorText) selectors.push(r.selectorText)
      else if (r.cssRules) collect(r.cssRules)
    }
  })(sheet.cssRules)
  const matched = new Set<string>()
  const total = new Set<string>()
  for (const selText of selectors) {
    for (const part of selText.split(',')) {
      const cleaned = part.replace(SKIP_PSEUDO, '').trim()
      if (!cleaned) continue
      total.add(cleaned)
      try { if (document.querySelectorAll(cleaned).length > 0) matched.add(cleaned) } catch { /* not a queryable selector on its own */ }
    }
  }
  return { totalSelectors: total.size, matched: [...matched] }
})

describe('(a) no horizontal overflow at 393px', () => {
  it('scrollWidth never exceeds clientWidth — at boot, after a popup, and on the heatmap', async () => {
    const { boot, afterPopup, afterHeatmap } = await overThreeScenes(readOverflow)
    /* The control: a page that failed to render would also show
       scrollWidth === clientWidth (both zero), which would pass this
       check for the wrong reason. overThreeScenes() already throws if
       clientWidth isn't the real 393 viewport width, so reaching this
       line at all is proof the tile actually rendered. */
    expect(boot.clientWidth).toBe(393)
    expect(boot.scrollWidth).toBe(boot.clientWidth)
    expect(afterPopup.scrollWidth, 'after opening and closing a popup').toBe(afterPopup.clientWidth)
    expect(afterHeatmap.scrollWidth, 'after opening the heatmap').toBe(afterHeatmap.clientWidth)
  }, 30_000)
})

describe('(b) every interactive element clears the 44px tap-target minimum — a RATCHET, not a gate', () => {
  /* Baseline measured across the same three scenes (a)/(c) use. SUMMED
     per scene, not deduplicated across them — a persistent element
     (like #settingsBtn) genuinely gets encountered on every one of
     these representative screens, and a sum reflects that directly
     rather than hiding it behind cross-scene identity logic. To lower
     this number: fix real violations, re-measure, and edit the JSON by
     hand — there is no separate --bless script for one file. */
  const BASELINE = JSON.parse(readFileSync(BASELINE_FILE, 'utf8')).values

  it('has a baseline worth holding', () => {
    expect(BASELINE).toBeGreaterThan(0)
  })

  it('does not exceed the baseline', async () => {
    const { boot, afterPopup, afterHeatmap } = await overThreeScenes(sweepHitTargets)
    /* The control, in the SAME test as the count below: an empty sweep
       (0 elements found at all) would pass "no violations" for the
       wrong reason — prove the sweep is actually finding real
       interactive elements before trusting its violation count. */
    expect(boot.total).toBeGreaterThan(20)

    const total = boot.bad.length + afterPopup.bad.length + afterHeatmap.bad.length
    expect(total, `violations: ${[...boot.bad, ...afterPopup.bad, ...afterHeatmap.bad].join(', ')}`).toBeLessThanOrEqual(BASELINE)
  }, 30_000)
})

describe('(c) the tile renders with its stylesheet intact', () => {
  /* Not "a <style> tag exists" — the five-week stylesheet deletion left
     the tag in place and empty of the rules that mattered, which a
     tag-presence check would not have caught. This counts how many of
     the stylesheet's own selectors actually reach a rendered element,
     UNIONED across the same three scenes (a)/(b) use — union, not sum,
     because a rule either reaches something on one of these screens or
     it doesn't; summing would double-count nothing meaningful. Floor
     chosen from a real measurement, not a guess: the union across
     these three scenes measured 156 (out of 470 total selectors in the
     stylesheet) on the tile as it stands today. 120 is comfortably
     below that — real margin for which exact selectors match without
     the floor itself drifting — and nowhere near what a near-total
     deletion would produce (a handful of :root-only rules, effectively
     0 matched). */
  const FLOOR = 120

  it('checks a meaningful number of selectors', async () => {
    const { boot } = await overThreeScenes(matchedSelectors)
    /* The control, in the SAME test as the floor check below: a
       stylesheet that failed to parse at all would report 0 total
       selectors, which would make "reaches the floor" meaningless. */
    expect(boot.totalSelectors).toBeGreaterThan(400)
  }, 30_000)

  it('reaches at least the floor across boot, a popup, and the heatmap', async () => {
    const { boot, afterPopup, afterHeatmap } = await overThreeScenes(matchedSelectors)
    const union = new Set([...boot.matched, ...afterPopup.matched, ...afterHeatmap.matched])
    expect(union.size).toBeGreaterThanOrEqual(FLOOR)
  }, 30_000)
})
