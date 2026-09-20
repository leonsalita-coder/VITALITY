import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { tileCss, contactSheet } from '../../scripts/build-contact-sheet.mjs'

/**
 * The contact sheet is only worth having if it cannot lie.
 *
 * A review page with its own stylesheet drifts from the app the moment
 * anybody touches either, and then it is worse than nothing: it shows a
 * design that does not ship, convincingly. So the tile's <style> block is
 * copied verbatim, and that is asserted rather than trusted.
 *
 * The page does need CSS of its own — grid, labels, section rules — and
 * that is the other half of the risk: sheet-only CSS that reaches a tile
 * class would be the review page quietly restyling the thing it exists to
 * show. It is namespaced `cs-` and held there.
 */

const TILE = 'public/tiles/train.html'
const SHEET = 'docs/contact-sheet.html'

const blocks = (html: string) =>
  [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1])

describe('the contact sheet cannot drift from the tile', () => {
  it('is checked in and up to date', () => {
    /* Regenerating must be a no-op. Otherwise the file in the repo is a
       snapshot of some earlier stylesheet and every review after that
       reviews the wrong thing. */
    expect(readFileSync(SHEET, 'utf8')).toBe(contactSheet())
  })

  it('carries the tile stylesheet byte for byte', () => {
    const [ported] = blocks(readFileSync(SHEET, 'utf8'))
    expect(ported).toBe(tileCss(readFileSync(TILE, 'utf8')))
  })

  it('keeps its own CSS out of the tile namespace', () => {
    const [, own] = blocks(readFileSync(SHEET, 'utf8'))
    /* Every class selector in the sheet-only block must be `cs-`. A rule
       on `.pillHit` here would make the review page show a button the
       tile does not have. */
    const selectors = [...own.matchAll(/\.([A-Za-z][\w-]*)/g)].map((m) => m[1])
    expect(selectors.length).toBeGreaterThan(5)
    expect(selectors.filter((s) => !s.startsWith('cs-'))).toEqual([])
  })

  it('reads tokens rather than redeclaring them', () => {
    /* The sheet may USE var(--text); it may not define one. A redefined
       token would silently repaint every primitive on the page. */
    const [, own] = blocks(readFileSync(SHEET, 'utf8'))
    expect(own).toContain('var(--')
    expect(/^\s*--[\w-]+\s*:/m.test(own)).toBe(false)
  })

  it('is not shipped inside the tile', () => {
    /* It is a review artefact. If it ever reached the sealed iframe it
       would be dead weight in a 200KB file. */
    const tile = readFileSync(TILE, 'utf8')
    expect(tile).not.toContain('cs-page')
    expect(tile).not.toContain('contact-sheet')
  })
})

describe('it shows the states that are hard to reach in the app', () => {
  const html = () => readFileSync(SHEET, 'utf8')

  it('renders every set-row state', () => {
    const page = html()
    for (const cls of ['pill tappable', 'pill done', 'pill failed', 'warmup', 'pillNear', 'pillPr', 'pillPrDot', 'dropRow']) {
      expect(page, cls).toContain(cls)
    }
  })

  it('renders every reason-line basis the engine can emit', () => {
    const page = html()
    for (const basis of ['why-clean', 'why-deload', 'why-layoff']) expect(page, basis).toContain(basis)
  })

  it('renders every readiness verdict', () => {
    const page = html()
    for (const v of ['verdict-rest_advised', 'verdict-reduced_volume', 'verdict-reduced_intensity']) {
      expect(page, v).toContain(v)
    }
  })

  it('renders every note type', () => {
    const page = html()
    for (const t of ['note-gold', 'note-mint', 'note-plain', 'note-fail']) expect(page, t).toContain(t)
  })

  it('renders every muscle band', () => {
    const page = html()
    for (const b of ['band-in', 'band-over', 'band-under']) expect(page, b).toContain(b)
  })

  it('renders the lift card in both modes', () => {
    /* Training mode renders one action; edit mode renders the full set.
       Showing only one of them would hide half the card's surface. */
    const page = html()
    expect(page).toContain('Drag to reorder')
    expect((page.match(/class="actionPill"/g) || []).length).toBeGreaterThan(3)
  })

  it('renders the disabled states that need a real attribute', () => {
    expect(html()).toContain('disabled')
  })

  it('does not fake hover, active or focus', () => {
    /* Simulating them would mean sheet-only classes the tile never sets —
       a picture of a button rather than the button. */
    const page = html()
    expect(page).not.toContain('is-hover')
    expect(page).not.toContain('is-active')
    expect(page).not.toContain('force-focus')
  })
})
