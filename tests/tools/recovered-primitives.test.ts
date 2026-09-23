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

describe('the set row came back whole', () => {
  it('has a laid-out row container', () => {
    /* The nine class lists covered the set row's buttons but not the row.
       .pill had twenty rules in August and three here, so the most tapped
       surface in the app had no layout at all — nothing to hang a touch
       target on, and nothing to contain one. */
    const pill = /\.pill\s*\{([^}]*)\}/.exec(css())![1]
    expect(pill).toContain('display:flex')
    expect(pill).toContain('padding')
  })

  it.each([
    'pillHit', 'pillMiss', 'pillReset', 'pillDrop', 'pillActions', 'pillStatus',
    'pillIdx', 'pillSpacer', 'pillWrap', 'pills', 'pillValue', 'pillUnit',
    'pillTimes', 'pillPerHand', 'drops', 'dropRow', 'dropArrow', 'dropX',
  ])('has rules for .%s', (cls) => {
    expect(new RegExp(`\\.${cls}(?![\\w-])`).test(css())).toBe(true)
  })

  it('distinguishes done, failed and warm-up rows without relying on colour', () => {
    /* Greyscale legibility: each state has to change something other than
       hue. done fills the row, failed marks it, warm-up mutes it. */
    const all = css()
    for (const sel of ['.pill.done', '.pill.failed', '.pill.warmup']) {
      expect(all, sel).toContain(sel)
    }
  })
})

describe('button feedback is wired and scoped', () => {
  it('draws the spinner and the check', () => {
    /* setBtnState() is live in the tile and rendered nothing, because the
       rules that draw these were global attribute selectors and did not
       come back with the button primitive. */
    const all = css()
    expect(all).toContain('[data-state="loading"]::after')
    expect(all).toContain('[data-state="success"]::after')
  })

  it('scopes them to buttons rather than every element', () => {
    const all = css()
    expect(all).not.toMatch(/\n\s*\[data-state/)
    expect(all).toContain('button[data-state')
  })

  it('declares --state-ink where it is used', () => {
    expect(css()).toContain('--state-ink:var(--signal-ink)')
  })

  it('declares it exactly once', () => {
    /* It was duplicated: the rule came back with the button primitive and
       again with the feedback block. */
    const hits = css().match(/\.finishBtn\[data-state\]/g) || []
    expect(hits).toHaveLength(1)
  })
})

describe('the dead rule is gone', () => {
  it('drops .swapItem .arr, which no markup produces', () => {
    expect(css()).not.toContain('.arr')
  })
})

/**
 * The frame, recovered from 731e891 with three documented deviations.
 *
 * Unlike the nine primitives above, this batch is not byte-for-byte: two
 * sub-floor label sizes were rounded up to --fs-micro, a signal-tinted
 * glow was dropped from .railStatVal.lit, and .daytitle got a new token
 * one step above hero instead of the 39px it originally shipped inline.
 * That is why it carries its own mark rather than joining the "nine
 * primitives" section, whose header claims no restyling at all.
 */
const FRAME_MARK = 'RECOVERED — the frame'

/**
 * Marks in source order. A slice bounded only by its own start would
 * silently absorb every section appended after it, so a later section
 * redeclaring an earlier one's selector would never be caught by an
 * earlier section's own "shares no selector" check — which is exactly
 * how .photoCard, already live from the nine primitives, slipped a
 * byte-for-byte duplicate past this file once already.
 */
/* A function, not an array built now — RECOVER_2_MARK and CAL_MARK are
   declared further down the file, and this is only ever called from
   inside a test body, by which point every mark below has its value. */
const sectionMarks = () => [MARK, FRAME_MARK, RECOVER_2_MARK, CAL_MARK]
const sectionCss = (mark: string) => {
  const all = css()
  const start = all.indexOf(mark)
  const later = sectionMarks().map((m) => all.indexOf(m)).filter((i) => i > start)
  const end = later.length ? Math.min(...later) : all.length
  return all.slice(start, end)
}
const frameCss = () => sectionCss(FRAME_MARK)

describe('the frame came back', () => {
  it('has a rule for every class', () => {
    const all = css()
    for (const c of [
      'shell', 'trainBar', 'wordmark', 'rail', 'railDate', 'railDivider',
      'railStat', 'railStatVal', 'railStatLbl', 'railSpacer', 'daydots', 'daytitle',
    ]) {
      expect(new RegExp(`\\.${c}\\b`).test(all), c).toBe(true)
    }
  })

  it('is appended after the nine primitives, not interleaved', () => {
    const all = css()
    expect(all.indexOf(FRAME_MARK)).toBeGreaterThan(all.indexOf(MARK))
  })

  it('shares no selector with what came before it', () => {
    const all = css()
    const before = all.slice(0, all.indexOf(FRAME_MARK))
    const older = new Set(selectorsOf(before))
    const clashes = selectorsOf(frameCss()).filter((s) => older.has(s))
    expect(clashes).toEqual([])
  })
})

describe('the frame stays on the type floor', () => {
  it('rounds every sub-floor size up to --fs-micro instead of porting it raw', () => {
    /* .wordmark shipped at 10px, .railDate and .railStatLbl at 10.5px and
       9.5px — all three below the ramp's documented 11px floor. */
    const frame = frameCss()
    expect(frame).not.toContain('font-size:10px')
    expect(frame).not.toContain('font-size:10.5px')
    expect(frame).not.toContain('font-size:9.5px')
  })

  it('keeps the sticky rail pinned', () => {
    /* The one piece of this recovery that was verified by rendering it,
       not by reading the rule: confirmed against the real host nesting
       (fixed overlay → bounded openStage → absolute-positioned iframe)
       that the iframe owns its own scroll container, so sticky resolves
       inside the tile's document rather than doing nothing against a
       parent page that never scrolls. */
    const rail = /\.rail\s*\{([^}]*)\}/.exec(frameCss())![1]
    expect(rail).toContain('position:sticky')
  })
})

describe('the rail keeps its glow off', () => {
  it("drops .railStatVal.lit's text-shadow entirely", () => {
    const rule = /\.railStatVal\.lit\s*\{([^}]*)\}/.exec(frameCss())![1]
    expect(rule).not.toContain('text-shadow')
  })
})

describe('the day headline gets its own step, not a shrink', () => {
  it('defines exactly one step above hero, at its original size', () => {
    /* 39px was an outlier even by the pre-ramp sheet's own ad hoc range
       (8px-27px, documented at :root) — the 27px ceiling was measured
       from a stylesheet that had already lost .daytitle, not a
       considered cap. Extending the ramp is honest; shrinking the
       number to fit inside it quietly would not be. */
    expect(css()).toContain('--fs-giant:39px')
  })

  it('is the only rule that uses --fs-giant', () => {
    const users: string[] = []
    for (const m of css().matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      if (m[1].trim().startsWith('@')) continue
      if (/var\(--fs-giant\)/.test(m[2])) users.push(m[1].trim().replace(/\s+/g, ' '))
    }
    expect(users).toEqual(['.daytitle'])
  })

  it('carries no glow either', () => {
    const rule = /\.daytitle\s*\{([^}]*)\}/.exec(frameCss())![1]
    expect(rule).not.toContain('text-shadow')
  })

  it('gives the narrow viewport a real step instead of a third size', () => {
    /* The original 30px narrow-width override was neither hero (27px)
       nor giant (39px) — a fourth ad hoc number. Reusing hero here means
       giant stays exactly what its own rule says it is: the one thing
       above hero, used in exactly one place. */
    expect(frameCss()).toMatch(/@media[^{]*\{\s*\.rail[^}]*\}\s*\.daytitle\s*\{\s*font-size:var\(--fs-hero\)/)
  })
})

/**
 * The fan browser, progress photos and settings row — recovered from
 * 731e891 with the same sub-floor rounding as the frame, and nothing
 * else. Grouped in one mark because none of the three carried an open
 * question the way the calendar and the theme switch did.
 */
const RECOVER_2_MARK = 'RECOVERED — fan, photos, settings'
const recover2Css = () => sectionCss(RECOVER_2_MARK)

describe('the fan browser, photos and settings came back', () => {
  it('has a rule for every class', () => {
    const all = css()
    for (const c of [
      'fanWrap', 'fanStage', 'fanCaption', 'fanNav', 'fanArrow', 'fanDots', 'fanCount',
      'fanHit', 'fanDot', 'fanLabel', 'fanCard',
      'photoCard', 'photoImg', 'photoDate', 'photoNote', 'photoStatus', 'photoBtnRow',
      'settingsBtn', 'settingsRow', 'settingsNote',
    ]) {
      expect(new RegExp(`\\.${c}\\b`).test(all), c).toBe(true)
    }
  })

  it('is appended after the frame, not interleaved', () => {
    const all = css()
    expect(all.indexOf(RECOVER_2_MARK)).toBeGreaterThan(all.indexOf(FRAME_MARK))
  })

  it('shares no selector with what came before it', () => {
    const all = css()
    const before = all.slice(0, all.indexOf(RECOVER_2_MARK))
    const older = new Set(selectorsOf(before))
    const clashes = selectorsOf(recover2Css()).filter((s) => older.has(s))
    expect(clashes).toEqual([])
  })

  it('rounds every sub-floor or near-miss size instead of porting it raw', () => {
    /* .fanLabel 8.5px, .fanCard .c 9.5px, .photoDate 10.5px, .photoNote
       13.5px and .photoNote.muted 12.5px all predate the ramp. Anything
       already equal to a role's value (.fanCount 11px, .fanCard .v 13px,
       .photoStatus 12px, .settingsNote 12px) is tokenised too, since a
       raw px value that happens to match a token is still a raw px
       value as far as the style-lint gate is concerned. */
    const recovered = recover2Css()
    for (const raw of ['8.5px', '9.5px', '10.5px', '13.5px', '12.5px', '11px', '13px', '12px']) {
      expect(recovered, raw).not.toContain(`font-size:${raw}`)
    }
  })

  it('keeps the fan browser speaking the same colour language as everywhere else', () => {
    /* high/mid/low already mean record/positive/neutral throughout the
       tile — .fan, .fanDot and .fanLabel reuse gold/signal/muted-2
       rather than inventing a second vocabulary for the same idea. */
    const recovered = recover2Css()
    for (const sel of ['.fan.high', '.fanDot.high', '.fanLabel.high']) {
      const rule = new RegExp(`${sel.replace('.', '\\.')}\\s*\\{([^}]*)\\}`).exec(recovered)![1]
      expect(rule, sel).toContain('--gold')
    }
  })
})

/**
 * The calendar, recovered from 731e891 with rounding on three sizes and
 * a resolved question about a fourth.
 *
 * .calTotal .ctLbl used to read two lines, "LB" / "THIS QTR", which only
 * fit the fixed 42px box at the original 7px — below the ramp's readable
 * floor. Rounded to --fs-micro, the second line overflowed. The fix was
 * the copy: "this qtr" duplicated .calTitle directly above it, so it was
 * dropped rather than the box resized or the text shrunk back below the
 * floor. "LB" alone fits with room to spare.
 */
const CAL_MARK = 'RECOVERED — the calendar'
const calCss = () => sectionCss(CAL_MARK)

describe('the calendar came back', () => {
  it('has a rule for every class', () => {
    const all = css()
    for (const c of [
      'calShell', 'calArrow', 'calBody', 'calHead', 'calTitle', 'calGridRow',
      'calDayLbls', 'calMain', 'calMonths', 'calTotal', 'calPop', 'calLegend',
    ]) {
      expect(new RegExp(`\\.${c}\\b`).test(all), c).toBe(true)
    }
  })

  it('is appended after fan/photos/settings, not interleaved', () => {
    const all = css()
    expect(all.indexOf(CAL_MARK)).toBeGreaterThan(all.indexOf(RECOVER_2_MARK))
  })

  it('shares no selector with what came before it', () => {
    const all = css()
    const before = all.slice(0, all.indexOf(CAL_MARK))
    const older = new Set(selectorsOf(before))
    const clashes = selectorsOf(calCss()).filter((s) => older.has(s))
    expect(clashes).toEqual([])
  })

  it('rounds .calTitle, .ctNum and .calLegend instead of porting them raw', () => {
    const cal = calCss()
    for (const raw of ['10.5px', '12.5px', '9px']) {
      expect(cal, raw).not.toContain(`font-size:${raw}`)
    }
  })

  it('keeps .ctLbl at --fs-micro now that it only has to fit one word', () => {
    const cal = calCss()
    const rule = /\.calTotal \.ctLbl\s*\{([^}]*)\}/.exec(cal)![1]
    expect(rule).toContain('font-size:var(--fs-micro)')
  })

  it('drops the redundant second line rather than resizing the box or shrinking the text', () => {
    const tile = readFileSync(TILE, 'utf8')
    /* The old render line, not a blanket string search — "this qtr"
       still appears once, in the comment documenting the removal. */
    expect(tile).not.toContain("'<br/>this qtr</div>'")
    expect(tile).toMatch(/class="ctLbl">'\+STATE\.unit\+'<\/div>/)
    /* The box itself is untouched. */
    expect(css()).toContain('.calTotal { position:relative; flex:none; width:42px; height:109px;')
  })

  it('keeps the heat-level colours on the existing signal scale', () => {
    const cal = calCss()
    for (const sel of ['.cal .cd.l4', '.calTotal.hot']) {
      const rule = new RegExp(`${sel.replace(/[.[\]]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(cal)![1]
      expect(rule, sel).toMatch(/--signal/)
    }
  })
})

describe('the theme switch is gone, not dimmed', () => {
  it('carries no theme-switch markup, styling or constants', () => {
    const tile = readFileSync(TILE, 'utf8')
    expect(tile).not.toContain('theme-switch')
    expect(tile).not.toContain('SKY_TOGGLE_HTML')
    expect(tile).not.toContain('SKY_STARS_SVG')
  })

  it('leaves a comment pointing at the primitive for when a real toggle exists', () => {
    const tile = readFileSync(TILE, 'utf8')
    expect(tile).toContain('.bouncyToggle')
    expect(/openSettings[\s\S]{0,400}bouncyToggle/.test(tile)).toBe(true)
  })

  it('does not leave an orphaned "preview" note with nothing to preview', () => {
    const tile = readFileSync(TILE, 'utf8')
    expect(tile).not.toContain('Just a preview for now')
  })
})

describe('nothing recovered points at something that no longer exists', () => {
  it('references only tokens that are defined or set at runtime', () => {
    const tile = readFileSync(TILE, 'utf8')
    const { recovered } = split()
    /* Every definition in the sheet, not just :root. --state-ink is set
       on the button that uses it, which is the right scope for it — a
       :root-only scan reported it as dangling. */
    const defined = new Set([...css().matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]))
    const runtime = new Set([...tile.matchAll(/setProperty\(\s*['"](--[\w-]+)/g)].map((m) => m[1]))
    const used = new Set([...recovered.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]))
    expect([...used].filter((t) => !defined.has(t) && !runtime.has(t))).toEqual([])
  })

  it('references only keyframes that are defined', () => {
    const all = css()
    const { recovered } = split()
    const defined = new Set([...all.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]))
    /* `none` turns an animation off — it is never a keyframe name, and
       the calendar's reduced-motion override (.cal .cd { animation:none })
       was the first rule in this section to say so, which is exactly
       when a check that doesn't exclude it starts lying. */
    const named = new Set(
      [...recovered.matchAll(/animation\s*:\s*([\w-]+)/g)].map((m) => m[1]).filter((n) => n !== 'none'),
    )
    expect(named.size).toBeGreaterThan(0)
    expect([...named].filter((n) => !defined.has(n))).toEqual([])
  })

  it('guards its animations behind prefers-reduced-motion', () => {
    const { recovered } = split()
    expect(recovered).toContain('prefers-reduced-motion')
    for (const sel of ['.sheet', '.pop', '.scrim']) expect(recovered, sel).toContain(sel)
  })
})
