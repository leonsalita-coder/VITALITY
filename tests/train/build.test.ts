import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildTileHtml } from '../../scripts/build-tile.mjs'
import { ENGINE_VERSION } from '../../lib/train/index'

const PUBLIC_TILE = 'public/tiles/train.html'
const LIBRARY_TILE = 'tiles-library/train.html'

/**
 * The tile is the thing that ships, so the test must not rewrite it.
 *
 * This used to run build-tile.mjs and then assert the result, which made
 * it incapable of noticing the one thing worth noticing: a tile checked
 * in without the engine rebuilt. It rebuilt, then agreed with itself.
 *
 * Worse, it wrote into the repo as a side effect, and vitest runs files
 * in parallel. tests/tools/mutate.test.ts deliberately mutates engine
 * sources on disk; while it did, this file rebuilt the tiles from the
 * mutated source, the harness restored the source, and a tile carrying
 * `if (!entry && entry.off)` was left staged. The pre-commit gate caught
 * it, which is the only reason it is a story and not a shipped bug.
 *
 * So: compute what the build would produce and compare. No writes.
 */
describe('tile build', () => {
  it('is checked in already built', async () => {
    const { html } = await buildTileHtml()
    expect(readFileSync(PUBLIC_TILE, 'utf8')).toBe(html)
  })

  it('keeps both copies identical', () => {
    expect(readFileSync(PUBLIC_TILE, 'utf8')).toBe(readFileSync(LIBRARY_TILE, 'utf8'))
  })

  it('carries the engine, its version and its markers', () => {
    const pub = readFileSync(PUBLIC_TILE, 'utf8')
    expect(pub).toContain('<!-- TRAIN-ENGINE:START -->')
    expect(pub).toContain('<!-- TRAIN-ENGINE:END -->')
    expect(pub).toContain(ENGINE_VERSION)
    expect(pub).toContain('var TrainEngine')
  })

  it('never emits a literal closing script tag inside the bundle', () => {
    const pub = readFileSync(PUBLIC_TILE, 'utf8')
    const start = pub.indexOf('<!-- TRAIN-ENGINE:START -->')
    const end = pub.indexOf('<!-- TRAIN-ENGINE:END -->')
    const block = pub.slice(start, end)
    // exactly one opening and one closing script tag belong to the wrapper
    expect(block.match(/<\/script>/g)?.length).toBe(1)
  })

  it('does not rewrite the tile just by being asked what it should be', async () => {
    /* The property that broke, asserted as behaviour rather than by
       reading the script's text — the import line alone mentions
       writeFileSync, so grepping for it proves nothing.

       A test that regenerates a shipped artefact races every other test
       that touches its inputs, and vitest runs them in parallel. */
    const before = readFileSync(PUBLIC_TILE, 'utf8')
    await buildTileHtml()
    await buildTileHtml()
    expect(readFileSync(PUBLIC_TILE, 'utf8')).toBe(before)
  })
})

/**
 * The suite runs one file at a time, and that is load-bearing.
 *
 * Asserted rather than trusted for the same reason `verify:full` is: the
 * wiring is what fails, silently, and nothing else would notice it going
 * back. Turning this on again makes the tile build race the mutation
 * harness, which has already staged a poisoned tile once.
 */
describe('the suite does not race itself', () => {
  it('runs test files sequentially', async () => {
    const config = await import('../../vitest.config')
    expect((config.default as any).test.fileParallelism).toBe(false)
  })
})
