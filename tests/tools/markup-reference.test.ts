import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * The markup reference goes to a model that writes CSS against it, so
 * the class names and the nesting ARE the deliverable.
 *
 * Which is why it is extracted from the tile running in a real DOM
 * rather than typed out. These tests hold the properties that make it
 * trustworthy: that it is complete, that it carries the hooks a selector
 * needs, and that it does not carry the things a CSS author must not
 * copy.
 */

const REF = 'docs/markup-reference.html'
const page = () => readFileSync(REF, 'utf8')

/** Just the extracted markup, not the page's own chrome. */
const surfaces = () =>
  [...page().matchAll(/<h2 class="mr-title">([^<]*)<\/h2>[\s\S]*?<pre>([\s\S]*?)<\/pre>/g)]
    .map((m) => ({ title: m[1], html: m[2] }))

describe('it captured every surface', () => {
  it('has no failures', () => {
    expect(page()).not.toContain('NOT CAPTURED')
  })

  it('covers the session, the dialogs and the progress views', () => {
    const titles = surfaces().map((s) => s.title)
    expect(titles.length).toBeGreaterThan(45)
    for (const needed of [
      'The static skeleton', 'Lift card — training mode', 'Lift card — edit mode',
      'Set row — unlogged', 'Set row — missed', 'Set row — warm-up', 'Rest bar',
      'Warm-up checklist', 'Dialog — Settings', 'Dialog — Tune', 'Coach overlay',
      'Progress view — Muscles', 'Celebration overlay',
    ]) {
      expect(titles, needed).toContain(needed)
    }
  })

  it('says when each surface is seen', () => {
    const whens = [...page().matchAll(/<p class="mr-when">([^<]*)<\/p>/g)].map((m) => m[1].trim())
    expect(whens.filter((w) => w.length > 10).length).toBeGreaterThan(45)
  })
})

describe('it captured real states, not empty shells', () => {
  const find = (t: string) => surfaces().find((s) => s.title === t)!.html

  it('logged a set through the real control path', () => {
    /* Assigning to ex.log produced an unlogged row that merely looked
       right. These come from clicking the buttons. */
    const logged = find('Set row — logged, with a drop set and an RPE')
    expect(logged).toContain('pill done')
    expect(logged).toContain('pillStatus')
    expect(logged).toContain('pillReset')
  })

  it('has a genuinely failed row', () => {
    expect(find('Set row — missed')).toContain('pill failed')
  })

  it('has a genuinely flagged warm-up row', () => {
    /* W toggles on a LOGGED set; clicking it first does nothing, and the
       capture silently showed an ordinary done row. */
    expect(find('Set row — warm-up')).toContain('pill done warmup')
  })

  it('shows training mode with only the one action', () => {
    const training = find('Lift card — training mode')
    expect(training).not.toContain('Drag to reorder')
    expect(training).not.toContain('data-act="menu"')
    expect(training).toContain('data-act="swap"')
  })

  it('shows edit mode with the full control set', () => {
    const edit = find('Lift card — edit mode')
    expect(edit).toContain('Drag to reorder')
    expect(edit).toContain('data-act="menu"')
  })

  it('targets cards by id rather than position', () => {
    /* The pinned lift sorts first, so indexing the card list captured the
       wrong exercise — a deloading squat labelled as the bench press. */
    expect(find('Lift card — training mode')).toContain('data-id="bench"')
  })

  it('carries no NaN anywhere', () => {
    /* Every NaN found here was a fixture missing a field the engine reads
       without a default — deload.sessions, deload.priorWeight,
       deload.confidence. A reference showing "holding NaN lb" would send
       a CSS author chasing a layout problem that is a data problem. */
    for (const s of surfaces()) expect(s.html, s.title).not.toContain('NaN')
  })

  it('names the one surface that genuinely renders undefined', () => {
    /* A REAL BUG, captured rather than papered over. SET_KINDS has seven
       kinds; the tile's KIND_LABELS and KIND_UNITS cover five. The Tune
       dialog's "How this is measured" list therefore renders two rows
       reading "undefined / undefined" — bodyweight and
       weighted_bodyweight — three taps from the session.

       Listed by name so it cannot be forgotten and so a SECOND surface
       developing the same fault fails this test rather than blending in. */
    const broken = surfaces().filter((s) => s.html.includes('undefined')).map((s) => s.title)
    expect(broken).toEqual(['Dialog — Tune'])
  })
})

describe('it keeps the hooks and drops the rest', () => {
  it('keeps data attributes and ARIA', () => {
    const all = surfaces().map((s) => s.html).join('')
    expect(all).toContain('data-act=')
    expect(all).toContain('aria-label=')
    expect(all).toContain('aria-pressed=')
    expect(all).toContain('role=')
  })

  it('drops inline styles and handlers', () => {
    /* An inline style wins every specificity argument and would fight
       anything written against this. */
    for (const s of surfaces()) {
      if (s.title === 'The static skeleton') continue
      expect(s.html, s.title).not.toMatch(/\sstyle=/)
      expect(s.html, s.title).not.toMatch(/\son[a-z]+=/)
    }
  })

  it('drops script, including the engine bundle', () => {
    const all = surfaces().map((s) => s.html).join('')
    expect(all).not.toContain('&lt;script')
    expect(all).not.toContain('TrainEngine')
  })

  it('carries the tile stylesheet so it renders as the tile does', () => {
    const tileCss = /<style[^>]*>([\s\S]*?)<\/style>/.exec(readFileSync('public/tiles/train.html', 'utf8'))![1]
    expect(page()).toContain(tileCss)
  })
})
