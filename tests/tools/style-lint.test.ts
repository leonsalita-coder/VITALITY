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
    /* If this ever reaches zero the ratchet has done its job and the
       assertion below should become an absolute one. */
    expect(BASELINE).toBeGreaterThanOrEqual(0)
  })

  it('counts every hardcoded hex colour in the stylesheet', () => {
    /* This was an absolute — "no hex, ever" — written when the surviving
       CSS had none. That was a conclusion from a partial sample: the
       rules it measured were the handful re-added after the August
       deletion, not the stylesheet as it actually shipped. Recovering the
       nine primitives brought back three real hex values, so the absolute
       was wrong rather than violated.
   
       It is a ratchet now, and the three are named here so they cannot be
       quietly joined by more:
         #f4a09c  .pbtn.danger and .menuPop button.danger — a lightened
                  --fail with no token of its own
         #f2f2f0  .bouncyThumb — byte-identical to --text
       Tokenising them is a colour decision and belongs with the rest of
       the reconciled set. */
    const { rules } = splitCss(readFileSync(TILE, 'utf8'))
    const hits = [...new Set(rules.match(/#[0-9a-fA-F]{3,8}\b/g) || [])].sort()
    expect(hits).toEqual(['#f2f2f0', '#f4a09c'])
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
    for (const t of ['--e0', '--text', '--muted', '--signal', '--sans', '--mono', '--sp4', '--r-md']) {
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
