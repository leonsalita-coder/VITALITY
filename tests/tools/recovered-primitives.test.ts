import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * The nine primitives, recovered from 731e891.
 *
 * Commit 191c04a deleted 1,252 lines of this stylesheet in August. The
 * components had already been ported from 21st.dev before that, so this
 * was a recovery rather than a restyle — every rule lifted byte for byte,
 * nothing invented, nothing outside the nine class lists.
 *
 * What these tests hold is the recovery's integrity, not its taste: that
 * each primitive has rules, that the recovered set does not collide with
 * the rules re-added since the loss, and that nothing recovered points at
 * a token or a keyframe that no longer exists. A rule that silently
 * resolves to nothing is the failure mode the deletion already produced
 * once.
 */

const TILE = 'public/tiles/train.html'
const css = () => /<style[^>]*>([\s\S]*?)<\/style>/.exec(readFileSync(TILE, 'utf8'))![1]
const MARK = 'RECOVERED — the nine primitives'

const split = () => {
  const all = css()
  const at = all.indexOf(MARK)
  return { before: all.slice(0, at), recovered: all.slice(at) }
}

const selectorsOf = (block: string) =>
  [...block.matchAll(/([^{}]+)\{/g)]
    .map((m) => m[1].trim())
    /* Keyframe steps are not selectors. `from`, `to` and `0%`/`100%`
       all sit before a brace and would otherwise read as rules that
       every animated block "collides" on. */
    .filter((s) => s && !s.startsWith('@') && !s.startsWith('/*'))
    .filter((s) => !/^(from|to)$/.test(s) && !/^[\d.]+%$/.test(s))
    .map((s) => s.replace(/\s+/g, ' '))

const PRIMITIVES: Array<[string, string[]]> = [
  ['popup shell', ['scrim', 'pop', 'popHead', 'eyebrow', 'popTitle', 'popX', 'popBtns']],
  ['button', ['pbtn', 'actionPill', 'finishBtn', 'freshbtn', 'wcAddBtn', 'cvSend', 'photoX']],
  ['input', ['pillInput', 'wInput', 'field', 'wcIn', 'cvInputRow', 'wUnit']],
  ['switch', ['bouncyRow', 'bouncyLabel', 'bouncyToggle', 'bouncyTrack', 'bouncyThumb', 'bouncyDot']],
  ['stepper', ['stepper', 'step', 'stepVal']],
  ['selectable row', ['swapItem', 'nm', 'mu']],
  ['chip', ['chip', 'range', 'rangeInd']],
  ['card', ['ex', 'miniCard', 'ovCard', 'chart-card', 'photoCard']],
  ['sheet', ['sheet', 'eyebrow']],
]

describe('every primitive came back', () => {
  it.each(PRIMITIVES)('%s has a rule for every class', (_name, classes) => {
    const all = css()
    for (const c of classes) {
      expect(new RegExp(`\\.${c}\\b`).test(all), c).toBe(true)
    }
  })

  it('brought back a substantial amount of CSS', () => {
    /* 55 classes had rules before this; the recovery more than doubles
       it. A recovery that moved almost nothing would mean the extraction
       missed the rules rather than that they were not there. */
    const classes = new Set([...css().matchAll(/\.([A-Za-z][\w-]*)/g)].map((m) => m[1]))
    expect(classes.size).toBeGreaterThan(120)
  })
})

describe('the recovery does not collide with what was re-added since', () => {
  it('shares no selector with the pre-existing rules', () => {
    /* The rest bar, note cards, weekly review and readiness verdicts were
       written after the deletion and are the newer intent. If a recovered
       rule used the same selector it would win on source order and
       silently revert eight months of work. */
    const { before, recovered } = split()
    const older = new Set(selectorsOf(before))
    const clashes = selectorsOf(recovered).filter((s) => older.has(s))
    expect(clashes).toEqual([])
  })

  it('is appended, not interleaved', () => {
    /* Source order is the whole reason the check above is sufficient. */
    const all = css()
    expect(all.indexOf(MARK)).toBeGreaterThan(all.indexOf(':root'))
  })
})

describe('nothing recovered points at something that no longer exists', () => {
  it('references only tokens that are defined or set at runtime', () => {
    const tile = readFileSync(TILE, 'utf8')
    const { recovered } = split()
    /* Read the whole :root block: it packs several tokens onto one line
       (`--e0:#030304; --e1:#0a0a0d; …`), so a line-anchored match finds
       only the first of each line and reports the rest as undefined. */
    const root = /:root\s*\{([\s\S]*?)\n\s*\}/.exec(css())![1]
    const defined = new Set([...root.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]))
    const runtime = new Set([...tile.matchAll(/setProperty\(\s*['"](--[\w-]+)/g)].map((m) => m[1]))
    const used = new Set([...recovered.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]))
    expect([...used].filter((t) => !defined.has(t) && !runtime.has(t))).toEqual([])
  })

  it('references only keyframes that are defined', () => {
    const all = css()
    const { recovered } = split()
    const defined = new Set([...all.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]))
    const named = new Set([...recovered.matchAll(/animation\s*:\s*([\w-]+)/g)].map((m) => m[1]))
    expect(named.size).toBeGreaterThan(0)
    expect([...named].filter((n) => !defined.has(n))).toEqual([])
  })

  it('guards its animations behind prefers-reduced-motion', () => {
    const { recovered } = split()
    expect(recovered).toContain('prefers-reduced-motion')
    for (const sel of ['.sheet', '.pop', '.scrim']) expect(recovered, sel).toContain(sel)
  })
})
