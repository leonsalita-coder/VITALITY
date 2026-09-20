import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { splitCss, inlineStyles } from '../../scripts/style-lint.mjs'

/**
 * Colour and type live in the token block or they do not live.
 *
 * A restyle that scatters hex values and px font sizes through the
 * stylesheet cannot be themed, cannot be reviewed as a system, and turns
 * "light mode" from a token swap into a rewrite.
 *
 * A RATCHET, not a wall — the count today is written down and may only go
 * down. A gate that fails on day one gets disabled on day one, and the
 * point is to hold the line while the restyle lands, not to fail the
 * build before it starts.
 */

const TILE = 'public/tiles/train.html'
const BASELINE = JSON.parse(readFileSync('.style-baseline.json', 'utf8')).values

describe('values outside the token block', () => {
  it('never increases', () => {
    /* Exit code is the assertion: the script itself fails on regression,
       so the gate and the report are the same thing rather than two
       implementations that can disagree. */
    const out = execFileSync('node', ['scripts/style-lint.mjs'], { encoding: 'utf8' })
    expect(out).not.toMatch(/REGRESSION/)
  }, 60_000)

  it('has a baseline worth holding', () => {
    expect(BASELINE).toBeGreaterThanOrEqual(0)
  })

  it('carries no px font size in the stylesheet', () => {
    /* Also absolute now. All 74 went onto the --fs-* scale; what remains
       in the baseline is inline style attributes in dialog markup, which
       are markup rather than stylesheet and were not in this pass. */
    const { rules } = splitCss(readFileSync(TILE, 'utf8'))
    expect(rules.match(/font-size\s*:\s*[0-9.]+px/g)).toBeNull()
  })

  it('leaves no token referenced but undefined', () => {
    /* --mint computed to black on a near-black ground for months because
       nothing checked this. */
    const source = readFileSync(TILE, 'utf8')
    const { css } = splitCss(source)
    const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]))
    const runtime = new Set([...source.matchAll(/setProperty\(\s*['"](--[\w-]+)/g)].map((m) => m[1]))
    const used = new Set([...source.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]))
    expect([...used].filter((t) => !defined.has(t) && !runtime.has(t))).toEqual([])
  })

  it('carries no hardcoded hex colour in the stylesheet', () => {
    /* Absolute again. It was briefly a ratchet naming two exceptions,
       because recovering the August rules brought back #f4a09c and
       #f2f2f0 and the absolute I had written was drawn from a sample
       that predated them. Both are now tokens — --danger and --text —
       so the rule can go back to meaning what it says. */
    const { rules } = splitCss(readFileSync(TILE, 'utf8'))
    expect(rules.match(/#[0-9a-fA-F]{3,8}\b/g)).toBeNull()
  })

  it('carries no hardcoded hex colour in an inline style attribute', () => {
    const hits = inlineStyles(readFileSync(TILE, 'utf8'))
      .flatMap((d: string) => d.match(/#[0-9a-fA-F]{3,8}\b/g) || [])
    expect(hits).toEqual([])
  })

  it('finds violations when there are any, so the check can fail', () => {
    /* The control. Every assertion above is an absence, and an absence
       check that cannot detect a present value proves nothing. */
    const planted = '<style>:root{--x:1px}</style><p style="font-size:13px;color:#ff0000">x</p>'
    const { rules } = splitCss(planted)
    expect(rules).not.toContain('#ff0000')
    const hits = inlineStyles(planted).flatMap((d: string) => d.match(/#[0-9a-fA-F]{3,8}\b/g) || [])
    expect(hits).toEqual(['#ff0000'])
  })
})

describe('the token block', () => {
  const tokens = () => splitCss(readFileSync(TILE, 'utf8')).tokens

  it('exists and defines the palette', () => {
    for (const t of ['--e0', '--text', '--muted', '--signal', '--sans', '--mono', '--sp4', '--r-md',
                     '--mint', '--bg', '--muted-strong', '--danger', '--fs-12', '--fs-19']) {
      expect(tokens(), t).toContain(t)
    }
  })

  it('is the only place tokens are defined', () => {
    /* A second :root elsewhere would make the light-mode swap a search
       rather than an edit. */
    const { rules } = splitCss(readFileSync(TILE, 'utf8'))
    expect(/^\s*--[\w-]+\s*:/m.test(rules)).toBe(false)
  })
})
