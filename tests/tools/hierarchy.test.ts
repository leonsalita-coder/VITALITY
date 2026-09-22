import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Mid-session hierarchy, and the accents that carry it.
 *
 * Every completed set used to render as a solid signal fill. One row
 * looked good; twenty-five made a wall of green in which the next
 * unlogged row — the only thing you act on — was the quietest element on
 * screen. That inverts the hierarchy exactly when it matters.
 *
 * These assert the ordering and the accent budget, both of which are
 * properties rather than opinions. How it looks is a judgement; which
 * row is lighter than which is not.
 */

const TILE = 'public/tiles/train.html'
const css = () =>
  /<style[^>]*>([\s\S]*?)<\/style>/.exec(readFileSync(TILE, 'utf8'))![1]
    .replace(/\/\*[\s\S]*?\*\//g, '')

const norm = (s: string) => s.trim().replace(/\s*,\s*/g, ', ').replace(/\s+/g, ' ')

/**
 * Every declaration reaching a selector, later rules winning.
 *
 * A query may name one selector or the whole comma group a rule was
 * written with — `.pill.done .pillValue, .pill.done .pillInput` is one
 * declaration in the stylesheet and asking for it by its single left half
 * should find it too.
 */
function declFor(selector: string): Record<string, string> {
  const want = norm(selector)
  const parts = want.split(', ')
  const out: Record<string, string> = {}
  for (const m of css().matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const prelude = norm(m[1])
    if (prelude.startsWith('@')) continue
    const group = prelude.split(', ')
    const hit = prelude === want || parts.every((p) => group.includes(p))
    if (!hit) continue
    for (const d of m[2].matchAll(/([a-z-]+)\s*:\s*([^;]+)/g)) out[d[1]] = d[2].trim()
  }
  return out
}

/** Where a token sits on the elevation ladder. Lower is darker. */
const LADDER = ['--e0', '--e1', '--e2', '--e3', '--e4']
const step = (v: string) => LADDER.indexOf(/var\((--e\d)\)/.exec(v || '')?.[1] ?? '')

describe('the rows separate by lightness alone', () => {
  const rows = {
    'warm-up': declFor('.pill.warmup').background,
    done: declFor('.pill.done').background,
    unlogged: declFor('.pill').background,
  }

  it('puts every row on the elevation ladder', () => {
    /* Not opacity. Opacity blends toward whatever is behind, which worked
       while done was a bright fill and broke the moment it became a
       recessed surface on a card of nearly the same value. */
    for (const [name, v] of Object.entries(rows)) {
      expect(step(v!), `${name} is not a ladder step: ${v}`).toBeGreaterThanOrEqual(0)
    }
  })

  it('recedes a completed set below the card it sits on', () => {
    const card = step(declFor('.ex').background)
    expect(step(rows.done!)).toBeLessThan(card)
  })

  it('raises the unlogged row above the card', () => {
    const card = step(declFor('.ex').background)
    expect(step(rows.unlogged!)).toBeGreaterThan(card)
  })

  it('recedes a warm-up further than an ordinary completed set', () => {
    expect(step(rows['warm-up']!)).toBeLessThan(step(rows.done!))
  })

  it('orders them warm-up, done, unlogged with no ties', () => {
    const order = [step(rows['warm-up']!), step(rows.done!), step(rows.unlogged!)]
    expect(new Set(order).size).toBe(3)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('leaves a failed row distinct without relying on its colour', () => {
    /* It keeps its treatment, which reads well. The line-through is the
       part that survives greyscale. */
    expect(declFor('.pill.failed .pillValue')['text-decoration']).toContain('line-through')
  })
})

describe('the completed row is marked, not filled', () => {
  it('carries no fill at all', () => {
    expect(declFor('.pill.done').background).not.toContain('--signal')
  })

  it('marks completion with a rail instead', () => {
    const d = declFor('.pill.done')
    expect(d['border-left-color']).toContain('--signal')
    expect(parseFloat(d['border-left-width'])).toBeGreaterThan(0)
  })

  it('mutes the values it is no longer shouting', () => {
    expect(declFor('.pill.done .pillValue, .pill.done .pillInput').color).toContain('muted-strong')
  })

  it('keeps the green flash, but only while it is transient', () => {
    /* The class is added when a set is logged and removed 820ms later,
       so it never accumulates — which is exactly why it still works as
       the reward. */
    expect(declFor('.pill.shimmer').background).toContain('--signal')
    const tile = readFileSync(TILE, 'utf8')
    expect(tile).toContain("classList.add('shimmer')")
    expect(tile).toMatch(/remove\('shimmer'\)/)
  })
})

describe('a record is the loudest thing in the app', () => {
  it('turns the row rail gold', () => {
    expect(declFor('.pill.done:has(.pillPr)')['border-left-color']).toContain('--gold')
  })

  it('sets the star at a real size, not a squeezed glyph', () => {
    const star = declFor('.pill.done .pillPr')
    expect(star.color).toContain('--gold')
    expect(star['font-size']).toContain('--fs-subhead')
    /* Larger than the status text it sits beside. */
    expect(declFor('.pillStatus')['font-size']).toContain('--fs-label')
  })

  it('leaves the weight/rep dot quiet', () => {
    /* Two marks that read the same are one mark. */
    const dot = declFor('.pillPrDot')
    expect(parseFloat(dot.width)).toBeLessThan(8)
    expect(declFor('.pill.done:has(.pillPrDot)')).toEqual({})
  })
})

describe('gold means a record and nothing else', () => {
  const goldUsers = () => {
    const out: string[] = []
    for (const m of css().matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      if (m[1].trim().startsWith('@')) continue
      if (/var\(--gold\)/.test(m[2])) out.push(m[1].trim().replace(/\s+/g, ' '))
    }
    return out
  }

  /* Each of these is an absence assertion, so each names the property
     that must still be SET. Renaming .pillNear out of existence passed
     the bare "does not contain gold" check — a rule that is gone is not
     a rule that was restrained. */
  it.each([
    ['.miniCard b', 'color', 'the week streak, and every figure beside it'],
    ['.pillNear', 'color', 'the near-miss cue'],
    ['.restbar.over .restTime', 'color', 'rest overtime'],
    ['.restbar.over .restLabel', 'color', 'rest overtime'],
    ['.restbar.over .restRingFill', 'stroke', 'the rest ring past zero'],
  ])('%s is still painted, just not gold — %s', (sel, prop) => {
    const d = declFor(sel)
    expect(d[prop], `${sel} sets no ${prop} at all`).toBeTruthy()
    expect(d[prop]).not.toContain('--gold')
  })

  it('no longer colour-codes the reason lines', () => {
    /* The words already carry the distinction. Colour-coding five bases
       spends two accents on explanatory text. */
    expect(declFor('.pillWhy').color).toContain('muted-strong')
    expect(css()).not.toContain('.pillWhy.why-clean')
    expect(css()).not.toContain('.pillWhy.why-layoff')
  })

  it('keeps it where a record actually is', () => {
    /* The control: the assertions above are gold being withdrawn, not
       gold being deleted. */
    const users = goldUsers().join(' ')
    expect(users).toContain('.pill.done .pillPr')
    expect(users).toContain('.pillPrDot')
  })
})

describe('fail means a missed set and nothing else', () => {
  it.each(['verdict-rest_advised', 'verdict-reduced_volume', 'verdict-reduced_intensity'])(
    '%s carries no colour', (v) => {
      const d = declFor(`.readinessNote.${v}`)
      const all = Object.values(d).join(' ')
      expect(all).not.toContain('--fail')
      expect(all).not.toContain('--gold')
      expect(d.color).toContain('muted-strong')
    })

  it('distinguishes rest_advised by its rail, not its hue', () => {
    expect(declFor('.readinessNote.verdict-rest_advised')['border-left']).toContain('--text')
    expect(declFor('.readinessNote.verdict-reduced_volume, .readinessNote.verdict-reduced_intensity')['border-left'])
      .toContain('--hair-strong')
  })

  it('keeps it on a genuinely missed set', () => {
    expect(declFor('.pill.failed .pillIdx, .pill.failed .pillStatus').color).toContain('--fail')
  })
})

describe('the glow is gone', () => {
  it('leaves no signal-coloured shadow anywhere', () => {
    /* Signal on near-black is already maximum contrast. The glow made
       every primary shout, and several are on screen at once. */
    const glows = [...css().matchAll(/box-shadow:[^;]*rgba\(110,\s*231,\s*183[^;]*/g)].map((m) => m[0])
    expect(glows).toEqual([])
  })

  it('still leaves the primary action filled', () => {
    /* The control: the glow was removed, not the button. */
    expect(declFor('.pillHit').background).toContain('--signal')
    expect(declFor('.finishBtn').background).toContain('--signal')
  })
})

/**
 * The header does not compete with the row being acted on.
 *
 * The mini cards sit on the SESSION sheet, the same surface as the set
 * rows — so three signal figures above a deliberately recessed list pull
 * the eye up and away from the only thing on screen to act on. The
 * streak went to text for this reason; the others follow for the same
 * one. They are reference, not action.
 */
describe('the session header recedes with the rows', () => {
  it('paints every mini-card figure in text', () => {
    expect(declFor('.miniCard b').color).toContain('--text')
  })

  it('keeps no variant that says the same thing twice', () => {
    /* `.miniCard b.gold` existed to exempt the streak from signal. With
       the base in text it duplicates it exactly, and a rule that cannot
       change anything is one more place to look. */
    expect(declFor('.miniCard b.gold')).toEqual({})
  })

  it('still paints them', () => {
    /* The control: deleting the colour entirely would satisfy both. */
    expect(declFor('.miniCard b')['font-size']).toContain('--fs-title')
    expect(declFor('.miniCard b').color).toBeTruthy()
  })
})

/**
 * A drop set attaches to a completed set, and only to one.
 *
 * `+ Drop` is rendered inside `kind === 'done'` and nowhere else, so it
 * could never appear on an unlogged row — which made its signal base
 * and its signal-tinted hover dead styling, overridden on every row that
 * could ever show them. This asserts the reachability claim rather than
 * trusting the reading of it, because "this cannot render there" is
 * exactly the kind of statement that rots silently.
 */
describe('the drop-set button only exists on a completed row', () => {
  const tile = () => readFileSync(TILE, 'utf8')

  it('is rendered only where the set is done', () => {
    expect(tile()).toContain("kind==='done'?'<button class=\"pillDrop\"")
  })

  it('is not rendered on the unlogged branch', () => {
    /* The unlogged branch of the same ternary offers Hit it and Miss.
       If pillDrop ever joins them, the base colour stops being dead and
       this pass's reasoning stops holding. */
    const src = tile()
    const branch = src.slice(src.indexOf(": (nearMiss?'<span class=\"pillNear\">"),
                             src.indexOf('aria-label="Mark missed"') + 90)
    expect(branch).toContain('pillHit')
    expect(branch).toContain('pillMiss')
    expect(branch).not.toContain('pillDrop')
  })

  it('classifies a set as exactly one of three kinds', () => {
    /* The claim rests on `done` being the only kind that renders it, so
       the set of kinds is part of the claim. */
    expect(tile()).toContain("if(!s) return 'empty'; if(s.fail) return 'failed'; return 'done'")
  })

  it('carries no signal, on the row or under the cursor', () => {
    expect(declFor('.pillDrop').color).toContain('--muted')
    const hover = Object.values(declFor('.pillDrop:hover')).join(' ')
    expect(hover).not.toContain('110,231,183')
    expect(hover).not.toContain('--signal')
  })

  it('says it once rather than twice', () => {
    /* The done-scoped copies said what the base now says. */
    expect(declFor('.pill.done .pillDrop')).toEqual({})
    expect(declFor('.pill.done .pillDrop:hover')).toEqual({})
  })

  it('is still a visible button', () => {
    /* The control for the two absence checks above. */
    expect(declFor('.pillDrop')['border-radius']).toBeTruthy()
    expect(declFor('.pillDrop:hover').background).toContain('--e3')
  })
})
