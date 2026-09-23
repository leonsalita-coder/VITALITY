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

  it('carries no px font size anywhere, stylesheet or markup', () => {
    /* The baseline is zero. Every size in the tile — including the ten
       that lived in inline style attributes inside dialog markup — is on
       the eight-role ramp. */
    const source = readFileSync(TILE, 'utf8')
    const { rules } = splitCss(source)
    expect(rules.match(/font-size\s*:\s*[0-9.]+px/g)).toBeNull()
    const inline = inlineStyles(source).flatMap((d: string) => d.match(/font-size:[0-9.]+px/g) || [])
    expect(inline).toEqual([])
  })

  it('has a baseline of zero', () => {
    expect(BASELINE).toBe(0)
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

describe('the type ramp', () => {
  const tokens = () => splitCss(readFileSync(TILE, 'utf8')).tokens
  const ROLES = ['micro', 'label', 'caption', 'body', 'subhead', 'title', 'display', 'hero']

  it('names every role, and nothing by its size', () => {
    /* A scale named by its numbers is still nineteen decisions with
       better spelling. */
    for (const r of ROLES) expect(tokens(), r).toContain(`--fs-${r}:`)
    expect(tokens()).not.toMatch(/--fs-\d/)
  })

  it('carries a line height and a weight for each role', () => {
    for (const r of ROLES) {
      expect(tokens(), r).toContain(`--lh-${r}:`)
      expect(tokens(), r).toContain(`--fw-${r}:`)
    }
  })

  it('has a floor of 11px', () => {
    /* 8px text on a dimmed screen at arm's length in a gym is
       decoration, not information. Nine sizes, not eight: --fs-giant is
       the one deliberate step above hero (.daytitle only, see its
       comment at :root), not a ninth ordinary role — the ramp itself is
       still the same eight, and the floor claim still holds regardless
       of a token that only ever raises the ceiling. */
    const sizes = [...tokens().matchAll(/--fs-\w+:\s*([\d.]+)px/g)].map((m) => parseFloat(m[1]))
    expect(sizes).toHaveLength(9)
    expect(Math.min(...sizes)).toBe(11)
  })

  it('uses only role tokens for size in the stylesheet, plus the one named exception', () => {
    const { rules } = splitCss(readFileSync(TILE, 'utf8'))
    const used = [...rules.matchAll(/font-size\s*:\s*var\(--fs-([\w-]+)\)/g)].map((m) => m[1])
    expect(used.length).toBeGreaterThan(30)
    /* giant is the only token allowed outside ROLES, and only because
       :root documents it as the sole exception above hero. A second
       unlisted name here is still a value that escaped the ramp. */
    expect([...new Set(used)].filter((u) => !ROLES.includes(u))).toEqual(['giant'])
  })

  it('sizes every font from the ramp or the glyph scale, and nothing else', () => {
    /* Two families, and a font-size that names neither is a value that
       escaped both. */
    const { rules } = splitCss(readFileSync(TILE, 'utf8'))
    const sizes = [...rules.matchAll(/font-size\s*:\s*([^;]+)/g)].map((m) => m[1].trim())
    const stray = sizes.filter((v) => !/^var\(--(fs|glyph)-/.test(v) && !/^[\d.]+em$/.test(v) && v !== 'inherit')
    expect(stray).toEqual([])
  })
})

describe('glyphs are not text', () => {
  const tokens = () => splitCss(readFileSync(TILE, 'utf8')).tokens
  const rules = () => splitCss(readFileSync(TILE, 'utf8')).rules

  it('keeps a glyph scale separate from the reading scale', () => {
    /* The moon in a switch thumb is a graphic. Sizing a graphic by a
       reading scale is a category error, and it produced an 11px glyph
       inside a 14x14 thumb. */
    expect(tokens()).toContain('--glyph-base:')
    expect(tokens()).toContain('--glyph-mini:')
  })

  it('lets a glyph go below the ramp floor, which is the point', () => {
    const glyphs = [...tokens().matchAll(/--glyph-\w+:\s*([\d.]+)px/g)].map((m) => parseFloat(m[1]))
    const ramp = [...tokens().matchAll(/--fs-\w+:\s*([\d.]+)px/g)].map((m) => parseFloat(m[1]))
    expect(Math.min(...glyphs)).toBeLessThan(Math.min(...ramp))
  })

  it('fits the mini thumb it broke', () => {
    /* 8px in a 14x14 box. The ramp's floor of 11 does not fit. */
    const mini = parseFloat(/--glyph-mini:\s*([\d.]+)px/.exec(tokens())![1])
    const thumb = parseFloat(/\.bouncyTrack\.mini \.bouncyThumb\s*\{[^}]*width:\s*([\d.]+)px/.exec(rules())![1])
    expect(mini).toBeLessThan(thumb)
    expect(rules()).toContain('.deloadRow .bouncyDot { font-size:var(--glyph-mini)')
  })

  it('exempts only glyphs that sit in a fixed-size box', () => {
    /* The test for exemption is narrow. .noteEmo is an emoji too, has no
       such box, and stays on the ramp. */
    expect(rules()).toMatch(/\.noteEmo\s*\{[^}]*var\(--fs-/)
  })
})

describe('the token block', () => {
  const tokens = () => splitCss(readFileSync(TILE, 'utf8')).tokens

  it('exists and defines the palette', () => {
    for (const t of ['--e0', '--text', '--muted', '--signal', '--sans', '--mono', '--sp4', '--r-md',
                     '--mint', '--bg', '--muted-strong', '--danger']) {
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
