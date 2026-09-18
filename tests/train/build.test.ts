import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { ENGINE_VERSION } from '../../lib/train/index'

const PUBLIC_TILE = 'public/tiles/train.html'
const LIBRARY_TILE = 'tiles-library/train.html'

describe('tile build', () => {
  it('inlines the engine into both tile files and keeps them identical', () => {
    execFileSync('node', ['scripts/build-tile.mjs'], { stdio: 'pipe' })

    const pub = readFileSync(PUBLIC_TILE, 'utf8')
    const lib = readFileSync(LIBRARY_TILE, 'utf8')

    expect(pub).toBe(lib)
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
})
