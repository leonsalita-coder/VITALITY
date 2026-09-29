import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import * as acorn from 'acorn'
import { splitCss } from '../../scripts/style-lint.mjs'

/**
 * The horizontal-scroll bug this file exists to catch was a canvas with no
 * CSS at all: `makeConstellation`'s resize() set canvas.width/height from a
 * DPR-scaled backing store, and with nothing constraining the CSS box back
 * down, the canvas's OWN intrinsic size (a browser default of 300×150,
 * scaled) became the button's rendered size — 616px wide on a 393px phone.
 * `.coachFab` and `#coachFabCanvas` had zero matching rules anywhere in the
 * stylesheet; only the universal `*` reset and the generic `button` rule
 * touched them, neither of which constrains size.
 *
 * Two different tests, because it's really two different bugs wearing one
 * symptom:
 *
 *   Test A drives the actual mechanism directly: resize() setting a
 *   backing-store size without pinning the CSS size back down. An earlier
 *   version of this test guarded a literal oversized `width` ATTRIBUTE in
 *   the static markup instead — based on a misreading of the live DOM.
 *   canvas.width/height are reflected IDL attributes, so `canvas.width=600`
 *   set by JS is indistinguishable, once inspected, from `width="600"`
 *   authored in the file — there was never a literal attribute on disk, so
 *   that version of the test had no regression value here.
 *
 *   Test B catches the actual shape of this bug and would have caught it
 *   directly: a class or id that's live in the tile's markup with NO rule
 *   anywhere in the stylesheet targeting it — a component whose CSS got
 *   deferred (or deleted) while its markup kept shipping. This is the
 *   general form of a defect that also caused a large part of the
 *   five-week stylesheet deletion documented elsewhere in docs/.
 */

const TILE = 'public/tiles/train.html'
const ENGINE_START = '<!-- TRAIN-ENGINE:START -->'
const ENGINE_END = '<!-- TRAIN-ENGINE:END -->'

/** Everything in the tile except the generated engine bundle — the part a
 * human actually hand-edits, and the only part this file's markup/CSS
 * checks care about. */
function outsideEngine(html: string): string {
  const a = html.indexOf(ENGINE_START)
  const b = html.indexOf(ENGINE_END)
  return a >= 0 && b > a ? html.slice(0, a) + html.slice(b + ENGINE_END.length) : html
}

interface CssRule { selectors: string[]; body: string }

/**
 * Every `selector-list { body }` block in already comment-stripped CSS
 * text. An `@media`/`@keyframes` wrapper's own `{` breaks this regex (it
 * can't cross a nested `{`), so the wrapper itself never becomes a "rule" —
 * but the rules NESTED inside it still match individually on the next pass
 * over the string, which is all either test below needs: whether ANY rule
 * anywhere targets a given class or id. Selector lists are split on a bare
 * `,`, which only holds for this file because nothing here uses a
 * comma-taking pseudo-class like `:is(a, b)` — confirmed by grep, asserted
 * below by the self-test.
 */
function cssRules(css: string): CssRule[] {
  const rules: CssRule[] = []
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1].split(',').map((s) => s.trim()).filter(Boolean)
    rules.push({ selectors, body: m[2] })
  }
  return rules
}

/** The rightmost simple/compound selector in a combinator chain — the part
 * that actually determines which elements a rule applies to. `.foo .bar`
 * targets `.bar`, not `.foo`; a rule that only reaches an element's
 * DESCENDANTS must not count as styling the element itself. */
function targetSelector(selector: string): string {
  const parts = selector.trim().split(/\s*[>+~]\s*|\s+/).filter(Boolean)
  return parts[parts.length - 1] || ''
}

function escapeReg(s: string): string {
  return s.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')
}

function selectorTargetsClass(selector: string, className: string): boolean {
  return new RegExp('\\.' + escapeReg(className) + '(?![\\w-])').test(targetSelector(selector))
}
function selectorTargetsId(selector: string, id: string): boolean {
  return new RegExp('#' + escapeReg(id) + '(?![\\w-])').test(targetSelector(selector))
}

describe('cssRules / selector matching — self-test', () => {
  const SAMPLE = `
    @media (prefers-color-scheme: dark) { :root { --e0: #111; } }
    .foo, .bar[data-state="on"] { color: red; }
    .foo .child { color: blue; }
    button:not(:disabled).save:hover { width: 40px; }
    @keyframes spin { from { opacity: 0; } to { opacity: 1; } }
    #panel.open { width: 200px; }
  `
  const rules = cssRules(SAMPLE)

  it('finds the un-nested rules, and the rules nested inside at-rule wrappers', () => {
    const bodies = rules.map((r) => r.body.trim())
    expect(bodies).toContain('color: red;')
    expect(bodies).toContain('width: 200px;')
    expect(bodies).toContain('--e0: #111;') // from inside @media
    expect(bodies).toContain('opacity: 1;') // from inside @keyframes
  })

  it('a class only reached as an ancestor does not count as targeting it', () => {
    expect(rules.some((r) => r.selectors.some((s) => selectorTargetsClass(s, 'foo') && /color: blue/.test(r.body))))
      .toBe(false)
    // .foo itself IS targeted by the first rule
    expect(rules.some((r) => r.selectors.some((s) => selectorTargetsClass(s, 'foo')))).toBe(true)
  })

  it('a comma-separated selector list matches on any member', () => {
    expect(rules.some((r) => r.selectors.some((s) => selectorTargetsClass(s, 'bar')))).toBe(true)
  })

  it('pseudo-classes and compound selectors do not hide the class they qualify', () => {
    expect(rules.some((r) => r.selectors.some((s) => selectorTargetsClass(s, 'save')))).toBe(true)
  })

  it('an id rule is found the same way', () => {
    expect(rules.some((r) => r.selectors.some((s) => selectorTargetsId(s, 'panel')))).toBe(true)
  })

  it('does not confuse a longer class name for a shorter one it starts with', () => {
    expect(selectorTargetsClass('.savey', 'save')).toBe(false)
    expect(selectorTargetsClass('.save', 'save')).toBe(true)
  })
})

/**
 * Extracts `function makeConstellation(...){...}`'s own source text from
 * whichever inline <script> block in the tile defines it, via a real parse
 * (acorn) rather than brace-counting — the function's body has plenty of
 * string literals with stray-looking punctuation, and a parser doesn't
 * care.
 */
function extractFunctionSource(html: string, name: string): string {
  for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
    const code = m[1]
    let ast: any
    try { ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script' }) } catch { continue }
    for (const node of ast.body) {
      if (node.type === 'FunctionDeclaration' && node.id?.name === name) return code.slice(node.start, node.end)
    }
  }
  throw new Error(`function ${name} not found in any <script> block of the tile`)
}

/**
 * Runs the real, unmodified makeConstellation source in a throwaway sandbox
 * — no JSDOM, no layout engine, because resize()'s bug and fix are pure
 * arithmetic on whatever getBoundingClientRect() and devicePixelRatio say,
 * and a stub canvas object supplies both directly. requestAnimationFrame is
 * stubbed to never fire, so frame() (which needs a real 2D context) never
 * runs; resize() runs synchronously inside makeConstellation() itself.
 */
function loadMakeConstellation(html: string) {
  const src = extractFunctionSource(html, 'makeConstellation')
  const factory = new Function('window', 'requestAnimationFrame', 'cancelAnimationFrame', `${src}\nreturn makeConstellation;`)
  return (fakeWindow: {
    devicePixelRatio: number
    matchMedia: () => { matches: boolean }
    addEventListener: () => void
    removeEventListener: () => void
  }) => factory(fakeWindow, () => 0, () => {})
}

function stubCanvas(cssWidth: number, cssHeight: number) {
  return {
    width: 0,
    height: 0,
    style: {} as Record<string, string>,
    getContext: () => new Proxy({}, { get: () => () => undefined }),
    getBoundingClientRect: () => ({ width: cssWidth, height: cssHeight }),
  }
}

describe('makeConstellation resize() pins the CSS box, independent of the backing store (Test A, replaced)', () => {
  const html = readFileSync(TILE, 'utf8')
  const makeConstellation = loadMakeConstellation(html)

  it.each([1, 2, 3, 4])('at devicePixelRatio %d, the CSS box stays 56×56 and the backing store is capped at 3×', (dpr) => {
    const canvas: any = stubCanvas(56, 56)
    makeConstellation({ devicePixelRatio: dpr, matchMedia: () => ({ matches: false }), addEventListener: () => {}, removeEventListener: () => {} })(canvas, { count: 3 })
    expect(canvas.style.width).toBe('56px')
    expect(canvas.style.height).toBe('56px')
    const cap = Math.min(dpr, 3)
    expect(canvas.width).toBe(Math.round(56 * cap))
    expect(canvas.height).toBe(Math.round(56 * cap))
  })

  it('does the same for a non-square box, at a DPR above the cap', () => {
    const canvas: any = stubCanvas(300, 150)
    makeConstellation({ devicePixelRatio: 4, matchMedia: () => ({ matches: false }), addEventListener: () => {}, removeEventListener: () => {} })(canvas, { count: 3 })
    expect(canvas.style.width).toBe('300px')
    expect(canvas.style.height).toBe('150px')
    expect(canvas.width).toBe(900) // 300 * min(4, 3)
    expect(canvas.height).toBe(450) // 150 * min(4, 3)
  })
})

describe('every class/id live in static markup has a matching rule (Test B)', () => {
  const html = readFileSync(TILE, 'utf8')
  const { css } = splitCss(html)
  const rules = cssRules(css)
  const dom = new JSDOM(outsideEngine(html))
  const elements = [...dom.window.document.querySelectorAll('[id], [class]')]

  /* Ids and classes used purely as JS/SVG-reference hooks, on elements that
     legitimately carry NO visual presentation of their own — reviewed by
     hand, one line of justification each. If this list needs to grow past
     ~15, that means more components lost their CSS while their markup kept
     shipping, and it's worth seeing the list rather than the count. */
  const ALLOWLIST = new Set<string>([
    'vt-mt-far',    // SVG <linearGradient> def, referenced via url(#id) — never selected by CSS
    'vt-mt-near',   // same
    'progress',     // pure show/hide wrapper (renderProgress toggles display); real sizing is on the child .progRing, which IS styled
    'goalBubble',   // empty container — every node ever put in it via innerHTML carries its own styled classes
    'photoGallery', // same — photo cards carry their own classes
    'photoInput',   // native file input, style="display:none" inline; deliberately never visually presented
    'cameraInput',  // same
    'statsCap',     // caption text (class delta-cap); inherits ambient type, only its nested .mu span needs an override
    'popRoot',      // empty dialog-injection container — every dialog injected into it (.scrim, .pop, ...) carries its own classes
    'coachRoot',    // same, for the coach overlay
  ])

  it('has elements to check — an empty list would pass everything below', () => {
    expect(elements.length).toBeGreaterThan(20)
  })

  it('keeps the allowlist small — more entries means more deferred components leaked live markup', () => {
    expect(ALLOWLIST.size).toBeLessThanOrEqual(15)
  })

  it('has no live element with neither a matching class rule nor a matching id rule', () => {
    /* The control, in the SAME test as the absence check below: prove the
       matching logic finds a real positive on real data — `.coachFab`
       itself, now that it has a rule — before trusting it to report zero
       orphans elsewhere in the file. This is the exact test that catches
       the historical bug: run against the tile as committed before this
       fix, it names `button#coachFab.coachFab` and `canvas#coachFabCanvas`
       as offenders (verified by hand against that commit; not re-asserted
       here since a fixed regression fixture would defeat its own point). */
    expect(rules.some((r) => r.selectors.some((s) => selectorTargetsClass(s, 'coachFab')))).toBe(true)

    const offenders: string[] = []
    for (const el of elements) {
      const id = el.getAttribute('id')
      if (id && ALLOWLIST.has(id)) continue
      const classes = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean)
      const matched =
        (id != null && rules.some((r) => r.selectors.some((s) => selectorTargetsId(s, id)))) ||
        classes.some((c) => rules.some((r) => r.selectors.some((s) => selectorTargetsClass(s, c))))
      if (!matched) {
        const tag = el.tagName.toLowerCase()
        offenders.push(tag + (id ? '#' + id : '') + classes.map((c) => '.' + c).join(''))
      }
    }
    expect(offenders).toEqual([])
  })
})
