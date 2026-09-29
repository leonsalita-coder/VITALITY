import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { splitCss } from '../../scripts/style-lint.mjs'

/**
 * Replaces gold-mint-guard.test.ts. That lint, and Test B before it
 * (static-markup-css.test.ts), both asked "what string is in the
 * source" — a class literal, an object property. Both had a live bug
 * escape them for the same reason: `.addLift` was emitted from a JS
 * template string Test B never scans, and `.heroSub b`'s zero-volume
 * gold was a descendant CSS rule with no class literal for the other
 * lint to find at all. Neither asked the only question that actually
 * matters: what colour does the browser's cascade actually paint this
 * pixel. This guard asks that question directly — it boots the real
 * tile, renders it against real fixtures, and reads
 * getComputedStyle(el).color on the actual rendered elements. It cannot
 * be evaded by a new code shape, because it never looks at code shape.
 *
 * This only works because of one fact, asserted below as the guard's
 * own PRECONDITION rather than assumed: every colour in this tile is
 * `var(--token)`, never a raw hex, enforced separately by
 * scripts/style-lint.mjs. getComputedStyle in JSDOM does NOT resolve
 * var() to an rgb() value (confirmed directly — see the commit that
 * added this file) — it returns the literal string "var(--gold)". That
 * is exactly enough information for this guard, AS LONG AS the premise
 * holds. If it stops holding, a raw-hex element computes to rgb(...)
 * instead, matching none of the achievement-colour strings — the guard
 * would go quiet, not fail. So it checks its own premise first, loudly.
 */

const TILE = 'public/tiles/train.html'

const ago = (n: number) => {
  const d = new Date(); d.setDate(d.getDate() - n)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
const session = (day: number, kg: number, reps = 5, sets = 3) => ({
  date: ago(day), kg, sets: Array.from({ length: sets }, () => ({ w: kg, r: reps })),
})
const baseState = (history: Record<string, unknown[]>, finishedDates: string[]) => ({
  unit: 'lb', submitted: false,
  session: { date: '1970-01-01', off: false, warmup: [], cooldown: [], ex: [] },
  history,
  customLib: { squat: { equipment: 'barbell', kind: 'reps_weight', primary: ['Quads'] } },
  exerciseNames: { squat: 'Squat' },
  finishedDates, deloadStates: {}, templates: [], shortTermGoal: '',
  otherTraining: [], photos: [], sessionDurations: [], liftGoals: [], bodyweight: [],
})

/** No history at all for the one defined lift — the fresh-profile shape
 * every one of the eleven fixed sites fell back to zero on. */
const emptyFixture = () => baseState({ squat: [] }, [])
/** One logged session. Not a record by construction (nothing precedes
 * it), but a real, non-zero number everywhere a value is shown. */
const oneSessionFixture = () => baseState({ squat: [session(3, 185)] }, [ago(3)])
/** Two sessions, the second genuinely heavier — a real PR, so
 * totalPRsAllTime()/exHasPR() have something true to report, and this
 * fixture can prove the guard does not flag a LEGITIMATE gold. */
const genuinePrFixture = () => baseState({ squat: [session(10, 185), session(3, 205)] }, [ago(10), ago(3)])

/** Boots a fresh tile instance against one fixture. Each fixture gets
 * its own JSDOM — STATE is a global the tile owns, and reusing one
 * instance across fixtures would let an earlier render's DOM nodes leak
 * into a later scan. */
async function boot(state: () => object) {
  const dom = new JSDOM(readFileSync(TILE, 'utf8'), {
    url: 'https://train.test/', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w: any) {
      w.Vitality = {
        load: async () => state(), save: () => {},
        read: async () => { throw new Error('no vitals') },
        classify: async () => { throw new Error('no_key') },
        getInsight: async () => { throw new Error('no_key') },
        generateWorkout: async () => { throw new Error('no_key') },
      }
      /* prefers-reduced-motion: reduce — every animated render path in
         this tile (animateCounts' count-up, revealOverviewCards, the
         constellation canvases) checks this and jumps straight to the
         FINAL state when it matches, instead of starting a
         requestAnimationFrame loop. Without it, a synchronous scan right
         after calling a render function catches animateCounts mid-flight
         at frame 0 — which briefly sets a correctly-gold-coloured
         element's TEXT to "0" (the animation's own start value) before
         counting up to the real number. That produced real-looking
         "0 lb"-in-gold offenders in early runs of this exact guard that
         were an artifact of this test's synchronous timing, not a bug in
         the tile — confirmed by checking: the fixture's real value was
         185/205, never 0. Reduced motion sidesteps the whole class of
         timing artifact by never starting the animation. */
      w.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} })
      const noop = new Proxy({}, { get: () => () => noop })
      w.HTMLCanvasElement.prototype.getContext = () => noop
    },
  })
  await new Promise((r) => setTimeout(r, 800))
  return (expr: string): any => dom.window.eval(expr)
}

/** Evaluated INSIDE the tile's own window: every rendered HTML leaf
 * element (no element children, so its own textContent is exactly what
 * it shows) whose value is empty/zero, checked against the three
 * achievement-colour custom properties by their LITERAL computed string
 * — see the module comment for why that's valid here. Checks BOTH
 * `color` and the `background` SHORTHAND (not `backgroundColor` —
 * verified directly: JSDOM never resolves `background-color` from a
 * `background: var(...)` shorthand declaration at all, computing it as
 * the transparent default regardless of what's actually declared; only
 * reading the shorthand property itself returns the literal
 * `"var(--token)"` string, the same way `color` does), because a value
 * can be painted either way — the eleven original sites all used text
 * colour, but the heatmap (docs/plans/heatmap.md) encodes its value as a
 * cell's FILL, with no text in the cell at all.
 *
 * "Zero" is detected two ways, because a value-bearing element doesn't
 * always carry its value as visible text:
 *   - the element's own text reduces to the number 0 (the original
 *     eleven sites' shape), or
 *   - the element carries `data-vol="0"` (the heatmap's shape — its
 *     cells are empty <button>s; data-vol is what the tile itself
 *     already emits as the "what value does this cell represent" fact,
 *     not a check-only artifact bolted on after the fact).
 *
 * Scoped by three things learned empirically, not assumed, while first
 * running this against the real tile:
 *   - SVG elements are excluded. Decorative chart/icon strokes (a
 *     trend-line's `stroke`, a celebration star's `fill`) are graphics,
 *     not value displays, and SVG's `className` is an SVGAnimatedString
 *     object, not a string — a different shape entirely.
 *   - display:none elements are excluded. `#streakPill` is CSS-default
 *     display:none and gold — correctly, since nothing is ever visually
 *     painted there when hidden. Checking computed colour on an invisible
 *     element measures nothing a viewer could see.
 *   - EMPTY text with no data-vol attribute is not treated as "zero"
 *     (the instruction's "zero-or-empty" was narrowed here after running
 *     it for real): `.noteDot` is a purely decorative 4px bullet
 *     (`background:currentColor`, no text ever) whose colour comes
 *     correctly from an already-guarded parent (`.note-gold` requires
 *     totals.total>0) — it isn't a value display and flagging it is
 *     noise unrelated to the real bugs, every one of which was either a
 *     literal "0" or an explicit data-vol="0", never a bare empty string.
 *
 * Deliberately does NOT check box-shadow/border — the heatmap's "today"
 * ring is --signal by design (docs/plans/heatmap.md decision 2: "signal
 * spent exactly once, on today"), regardless of that day's own value.
 * That's a time marker, not a value colour, and uses a different CSS
 * property for exactly this reason — checking it here would make this
 * guard fail on the tile's own intended design.
 *
 * Returns plain data (not DOM nodes) so it survives the eval() boundary.
 */
const SCAN_SRC = `(function(){
  var BAD = ['var(--gold)', 'var(--mint)', 'var(--signal)'];
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var offenders = [];
  document.querySelectorAll('body *').forEach(function(el){
    if (el.namespaceURI === SVG_NS) return;
    if (el.children.length > 0) return;
    if (getComputedStyle(el).display === 'none') return;
    var text = (el.textContent || '').trim();
    var volAttr = el.getAttribute('data-vol');
    var isZero = false;
    if (volAttr !== null) {
      isZero = volAttr === '0';
    } else if (text !== '') {
      var m = text.match(/^[+-]?[\\d,]+(?:\\.\\d+)?/);
      isZero = !!m && parseFloat(m[0].replace(/,/g,'')) === 0;
    }
    if (!isZero) return;
    var cs = getComputedStyle(el);
    var label = el.tagName.toLowerCase() + (el.id?'#'+el.id:'') + (el.getAttribute('class')?'.'+el.getAttribute('class').replace(/\\s+/g,'.'):'') + ' text="' + text + '" data-vol=' + volAttr;
    if (BAD.indexOf(cs.color) !== -1) offenders.push(label + ' color=' + cs.color);
    if (BAD.indexOf(cs.background) !== -1) offenders.push(label + ' background=' + cs.background);
  });
  return offenders;
})()`

/** Every render path that touches one of the eleven sites fixed for this
 * bug class, plus the history popup (openHistory — the real entry point;
 * drawStats() alone throws, since #hstats only exists once the popup
 * shell openHistory builds is mounted). */
const SCENES = [
  `renderHeroExtras(); renderOverviewCards(); renderStreak();`,
  `openHistory({id:'squat', name:'Squat'});`,
  `drawExerciseChart('squat');`,
  `statsView={id:'__volume'}; drawStatsSection();`,
  `statsView={id:'__sessions'}; drawStatsSection();`,
  `statsView={id:'__heatmap'}; drawStatsSection();`,
]

describe('PRECONDITION — this guard is only meaningful while colours are all var()', () => {
  it('has no raw hex colour outside :root (if this fails, the guard below is BLIND, not merely tripped)', () => {
    /* Mirrors scripts/style-lint.mjs's own HEX check, deliberately not
       imported from it — this guard must stand even if style-lint is
       never run, changed, or bypassed. Redeclared, not reused. */
    const HEX = /#[0-9a-fA-F]{3,8}\b/g
    /* The control, in the SAME test as the absence check below: prove
       HEX finds a real hex before trusting it to find none in the file. */
    expect('.probe { color: #ff00aa; }'.match(HEX)).toHaveLength(1)

    const { rules } = splitCss(readFileSync(TILE, 'utf8'))
    const hits = rules.match(HEX) || []
    expect(
      hits,
      'A raw hex colour exists outside :root. This guard recognises gold/mint/signal ' +
      'ONLY by matching the literal string getComputedStyle returns for a var() ' +
      "reference (JSDOM does not resolve var() to rgb()) — a raw hex computes to " +
      "rgb(...) instead and matches none of those strings. THE ACHIEVEMENT-COLOUR " +
      'CHECK BELOW WOULD GO SILENTLY BLIND TO THIS COLOUR, not fail — fix the hex ' +
      'to a var(--token) before trusting anything else in this file: ' + JSON.stringify(hits),
    ).toEqual([])
  })
})

describe('no zero or empty value ever computes to an achievement colour', () => {
  it('empty profile — every fallback-to-zero renders neutral', async () => {
    const run = await boot(emptyFixture)
    /* The control, in the SAME test as the absence check below: plant a
       known-bad element in the LIVE page (same DOM, same SCAN_SRC) and
       prove the scan finds it, before trusting it to find nothing real. */
    run(`document.body.insertAdjacentHTML('beforeend', '<div class="ovNum mint" id="controlProbe">0</div>')`)
    expect(run(SCAN_SRC).length).toBeGreaterThan(0)
    run(`document.getElementById('controlProbe').remove()`)

    const offenders: string[] = []
    for (const scene of SCENES) offenders.push(...run(`${scene} ${SCAN_SRC}`))
    expect(offenders).toEqual([])
  })

  it('one ordinary session — real, non-zero values are untouched; anything still zero stays neutral', async () => {
    const run = await boot(oneSessionFixture)
    run(`document.body.insertAdjacentHTML('beforeend', '<div class="stat"><div class="v gold" id="controlProbe">0</div></div>')`)
    expect(run(SCAN_SRC).length).toBeGreaterThan(0)
    run(`document.getElementById('controlProbe').parentElement.remove()`)

    const offenders: string[] = []
    for (const scene of SCENES) offenders.push(...run(`${scene} ${SCAN_SRC}`))
    expect(offenders).toEqual([])
  })

  it('a genuine PR — the guard does not flag legitimate gold, only zero gold', async () => {
    const run = await boot(genuinePrFixture)
    /* The control, in the SAME test as the absence check below: prove
       this fixture actually produced a real, non-zero PR — a guard that
       never sees any gold at all would trivially "pass" every case,
       proving nothing about false positives. */
    const prCount = run('totalPRsAllTime()')
    expect(prCount).toBeGreaterThan(0)

    const offenders: string[] = []
    for (const scene of SCENES) offenders.push(...run(`${scene} ${SCAN_SRC}`))
    expect(offenders).toEqual([])
  })
})
