import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Two implementations of the same decision will drift and disagree, and a
 * disagreement between them is silent — the user sees a deload that the
 * chart says should not have happened, or a plateau the engine never
 * detected. These assertions exist so the duplicate paths cannot come back.
 *
 * Everything is checked against the LOGGER script specifically: the inlined
 * engine bundle legitimately contains the canonical implementations, and a
 * naive whole-file grep would match those and pass for the wrong reason.
 */

const TILES = ['public/tiles/train.html', 'tiles-library/train.html']

/** The tile's own script, with the inlined engine bundle excluded. */
function loggerScript(path: string): string {
  const html = readFileSync(path, 'utf8')
  const end = html.indexOf('<!-- TRAIN-ENGINE:END -->')
  expect(end).toBeGreaterThan(-1)
  return html.slice(end)
}

describe.each(TILES)('%s — one source of truth', (path) => {
  it('does not define its own plateau detector', () => {
    expect(loggerScript(path)).not.toMatch(/function\s+detectPlateau\b/)
  })

  it('calls the engine for plateau detection', () => {
    expect(loggerScript(path)).toContain('TrainEngine.detectPlateau(')
  })

  it('references the retired override only to convert it, never to decide with', () => {
    const script = loggerScript(path)
    const migration = script.slice(
      script.indexOf('function migrateDeloadOverrides'),
      script.indexOf('/* ---- build / load state'),
    )
    expect(migration.length).toBeGreaterThan(0)

    // every mention must live inside the migration; a decision path reading
    // the old shape is exactly the drift this is guarding against
    const all = script.match(/deloadOverrides/g) || []
    const inMigration = migration.match(/deloadOverrides/g) || []
    expect(all.length).toBe(inMigration.length)
  })

  it('drives deloads through the state machine instead', () => {
    const script = loggerScript(path)
    expect(script).toContain('TrainEngine.nextDeloadState(')
    expect(script).toContain('deloadStates')
  })

  it('converts existing override data rather than dropping it', () => {
    expect(loggerScript(path)).toContain('migrateDeloadOverrides')
  })

  it('caps how many lifts deload at once through the engine', () => {
    expect(loggerScript(path)).toContain('TrainEngine.limitDeloads(')
  })
})

describe('engine surface', () => {
  it('no longer accepts the old override shape', () => {
    const progression = readFileSync('lib/train/progression.ts', 'utf8')
    expect(progression).not.toMatch(/deloadOverride\b/)
  })

  it('exposes exactly one plateau detector', () => {
    const files = ['lib/train/progression.ts', 'lib/train/deload.ts', 'lib/train/records.ts']
    const definitions = files.filter((f) =>
      /export function detectPlateau\b/.test(readFileSync(f, 'utf8')),
    )
    expect(definitions).toEqual(['lib/train/deload.ts'])
  })
})

/**
 * Source-text assertions cannot tell whether a symbol the tile calls
 * actually exists in the bundle. This one evaluates the inlined engine and
 * checks every TrainEngine.* the tile reaches for is really there — the
 * failure mode it guards against is a call site that type-checks, greps
 * clean, and is undefined at runtime.
 */
describe.each(TILES)('%s — the bundle answers what the tile calls', (path) => {
  it('exposes every TrainEngine member the tile uses', () => {
    const html = readFileSync(path, 'utf8')
    const bundle = html.match(/<!-- TRAIN-ENGINE:START -->\s*<script>([\s\S]*?)<\/script>/)
    expect(bundle).not.toBeNull()

    // eslint-disable-next-line no-eval
    const engine = eval(`${bundle![1]}; TrainEngine`) as Record<string, unknown>
    const used = new Set(
      [...loggerScript(path).matchAll(/TrainEngine\.(\w+)/g)].map((m) => m[1]),
    )
    expect(used.size).toBeGreaterThan(0)
    // constants count too — the tile reads DEFAULT_WEEKLY_TARGET, not just
    // functions, and "exists" is the property that actually matters here
    const missing = [...used].filter((name) => engine[name] === undefined)
    expect(missing).toEqual([])
  })
})
