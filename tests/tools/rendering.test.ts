import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Elements that were rendering as run-together text.
 *
 * "compound·3 × 5·last 185 lbdeloadingsuperset A" is one string where
 * three distinct things should be. None of these classes had a rule at
 * all — they were outside every list recovered so far — so the browser
 * laid them out as bare inline text on a dark ground.
 *
 * What is asserted here is that a SEPARATION exists: a margin, a gap, a
 * padding or a display that is not plain inline. Not how it looks — that
 * is a judgement — but that two adjacent things cannot render welded
 * together, which is not.
 */

const TILE = 'public/tiles/train.html'
/* Comments stripped: without that, a rule preceded by one has the whole
   comment swallowed into its selector text and no lookup matches it. */
const css = () =>
  /<style[^>]*>([\s\S]*?)<\/style>/.exec(readFileSync(TILE, 'utf8'))![1]
    .replace(/\/\*[\s\S]*?\*\//g, '')

/** Every declaration reaching a selector, later rules winning. */
function declFor(selector: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of css().matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const prelude = m[1].trim()
    if (prelude.startsWith('@') || prelude.startsWith('/*')) continue
    if (!prelude.split(',').some((p) => p.trim() === selector)) continue
    for (const d of m[2].matchAll(/([a-z-]+)\s*:\s*([^;]+)/g)) out[d[1]] = d[2].trim()
  }
  return out
}

/**
 * Does this container hold its children apart?
 *
 * The separation lives on the CONTAINER, not on each child — that is how
 * these layouts are built, and a first version of this test checked the
 * children and reported six false failures on rules that were correct.
 * `.metaSep` carries no margin because `.exMeta` is a flex row with a
 * gap, which is the right place for it.
 */
const spacesChildren = (sel: string) => {
  const d = declFor(sel)
  const flexish = d.display && /flex|grid/.test(d.display)
  const gap = d.gap || d['column-gap']
  return Boolean(flexish && gap && !/^0\b/.test(gap))
}

describe('nothing renders welded to its neighbour', () => {
  it.each([
    ['.exMeta', 'tier · sets · last, plus the deload and superset tags'],
    ['.exName', 'the lift name and its info affordance'],
    ['.formCues', 'the cue pills'],
    ['.mbRow', 'a muscle band: label, bar, value'],
    ['.exNote', 'the note dot and the note text'],
    ['.exHead', 'grip, eye, name, pin, overflow'],
    ['.menuPop button', 'a menu row: icon and label'],
  ])('%s spaces its children — %s', (sel) => {
    expect(declFor(sel), `${sel} has no rule at all`).not.toEqual({})
    expect(spacesChildren(sel), `${sel} is not a flex/grid with a gap`).toBe(true)
  })

  it('finds a container that does NOT space its children', () => {
    /* The control. Every assertion above is a property holding; if
       spacesChildren returned true for anything it would prove nothing.
       .pillValue is inline-flex with no gap, on purpose — "185 × 5" is
       one number and must not be spaced apart. */
    expect(spacesChildren('.pillValue')).toBe(false)
  })

  it('renders the two tags as pills, not as text', () => {
    /* A pill has a border, a padding and a radius. Without all three,
       "deloading" and "superset A" are just more words in the meta line
       and the card reads "last 185 lbdeloadingsuperset A". */
    for (const sel of ['.deloadTag', '.groupTag']) {
      const d = declFor(sel)
      expect(d.border || d['border-width'], `${sel} has no border`).toBeTruthy()
      expect(d.padding, `${sel} has no padding`).toBeTruthy()
      expect(d['border-radius'], `${sel} has no radius`).toBeTruthy()
    }
  })

  it('gives the info affordance a box of its own', () => {
    /* It rendered as "Bench Pressi" — a letter welded to the name. */
    const d = declFor('.exInfo')
    expect(d.width, '.exInfo has no width').toBeTruthy()
    expect(d.display).toContain('flex')
  })

  it('gives the muscle band an actual bar', () => {
    /* The bars were not rendering at all: the track had no size, so the
       fill had nothing to fill. */
    const track = declFor('.mbTrack')
    expect(track.height, '.mbTrack has no height').toBeTruthy()
    expect(parseFloat(track.height)).toBeGreaterThan(0)
    expect(declFor('.mbFill').background, '.mbFill has no fill').toBeTruthy()
  })

  it('reserves room for the label and the value either side of it', () => {
    /* "chest26" was the label and the value with nothing between them. */
    expect(declFor('.mbLbl').width).toBeTruthy()
    expect(declFor('.mbVal').width).toBeTruthy()
  })

  it('colours the note dot apart from the note text', () => {
    expect(declFor('.exNote .ndot').color).toBeTruthy()
  })
})

describe('native controls are not left bare', () => {
  it.each(['.grip', '.exEye', '.pinBtn', '.menuBtn', '.menuPop', '.menuPop button',
    '.goalPill', '.searchRow', '.searchRow input', '.freshbtn', '.photoX'])(
    '%s is styled rather than a system default', (sel) => {
      const d = declFor(sel)
      expect(d, `${sel} has no rule`).not.toEqual({})
      /* A bare <button> or <input> renders as a white system control on
         this dark ground. Declaring a background or a border is the
         minimum that stops that. */
      const owned = d.background || d['background-color'] || d.border || d['border-width'] || d.color
      expect(owned, `${sel} declares no background, border or colour`).toBeTruthy()
    })
})

describe('states read as states', () => {
  it('fixes a logged set’s fields', () => {
    const d = declFor('.pillInput:disabled')
    expect(d, 'no disabled rule').not.toEqual({})
    expect(d.opacity || d.cursor).toBeTruthy()
  })

  it('takes the fill off a disabled button entirely', () => {
    /* Keeping the signal fill at reduced opacity still reads as the
       thing to press. */
    const d = declFor('.pbtn:disabled')
    expect(d.background).toBe('none')
    expect(d.color).toContain('muted')
    /* And the same for the filled variant, which is the one that looked
       available while disabled. */
    expect(declFor('.pbtn.save:disabled').background).toBe('none')
  })

  it('makes the switch legible without colour', () => {
    /* Position does the work; colour reinforces. A thumb that moves the
       width of the track survives greyscale, a hue change does not. */
    const on = declFor('#moonbtn.on .bouncyThumb')
    expect(on.transform, 'the thumb does not move').toContain('translateX')
    expect(declFor('.deloadRow.on .bouncyTrack')['border-width'],
      'the track does not change weight').toBeTruthy()
    /* And the mini variant in the card menu moves its thumb too. */
    expect(declFor('.deloadRow.on .bouncyThumb').transform).toContain('translateX')
  })

  it('hides the tick on an unticked checklist item', () => {
    /* It was painted regardless, so every row read as done and the
       header count disagreed with the screen. */
    expect(declFor('.wcCheck .wcCheckMark').opacity).toBe('0')
    expect(declFor('.wcCheck.on .wcCheckMark').opacity).toBe('1')
  })

  it('keeps the strikethrough to the width of the text', () => {
    /* .wcTxt was flex:1, so a scribble at 100% spanned the whole row. */
    expect(declFor('.wcTxt').flex).toBe('0 1 auto')
    expect(declFor('.wcTxt')['margin-right']).toBe('auto')
  })
})

describe('the sparkline is a sparkline', () => {
  it('is constrained rather than filling the card', () => {
    /* It was aspect-ratio:16/9 at full card width — a panel, not a
       sparkline. The ratio is gone rather than overridden, so there is
       one rule for this selector and no question about which wins. */
    const d = declFor('.sChart')
    expect(d['aspect-ratio']).toBeUndefined()
    expect(parseFloat(d.height)).toBeLessThanOrEqual(48)
    expect(parseFloat(d['max-height'])).toBeLessThanOrEqual(48)
  })

  it('leaves room for the last point', () => {
    /* The endpoint marker sits at the right edge and was half outside. */
    expect(declFor('.sChart')['padding-right']).toBeTruthy()
  })

  it('draws small dots, with the latest one emphasised', () => {
    const dot = parseFloat(declFor('.sPoint').width)
    const last = parseFloat(declFor('.sPoint:last-of-type').width)
    expect(dot).toBeLessThan(8)
    expect(last).toBeGreaterThan(dot)
  })
})

describe('the celebration has a treatment', () => {
  it('is more than plain text', () => {
    /* The app's one reward moment. The rules existed in August and were
       simply never extracted. */
    expect(declFor('.celebrate .ch1')['font-size']).toContain('--fs-hero')
    expect(declFor('.celebrate .ch1').color).toContain('gold')
    expect(declFor('.celebrate .bstar svg').fill).toContain('gold')
    expect(declFor('.celebrate .burst').transform).toContain('scale')
  })
})
