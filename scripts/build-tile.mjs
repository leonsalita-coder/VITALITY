/**
 * Bundles lib/train/index.ts to a single IIFE (global `TrainEngine`) and
 * inlines it into the tile HTML between the TRAIN-ENGINE markers.
 *
 * Tiles are sealed srcDoc iframes with no network and no external files, so
 * the engine cannot be a <script src>. It has to be physically inlined, and
 * both copies of the tile have to stay identical.
 */
import { build } from 'esbuild'
import { readFileSync, writeFileSync } from 'node:fs'

const START = '<!-- TRAIN-ENGINE:START -->'
const END = '<!-- TRAIN-ENGINE:END -->'
const TILES = ['public/tiles/train.html', 'tiles-library/train.html']

const result = await build({
  entryPoints: ['lib/train/index.ts'],
  bundle: true,
  format: 'iife',
  globalName: 'TrainEngine',
  target: 'es2020',
  platform: 'browser',
  write: false,
})

// A literal </script> inside the bundle would close the wrapper early.
const code = result.outputFiles[0].text.replace(/<\/script>/gi, '<\\/script>')
const block = `${START}\n<script>\n${code}</script>\n${END}`

const source = readFileSync(TILES[0], 'utf8')
if (!source.includes(START) || !source.includes(END)) {
  throw new Error(`Missing TRAIN-ENGINE markers in ${TILES[0]}`)
}
const next = source.replace(
  new RegExp(`${START}[\\s\\S]*?${END}`),
  () => block,
)

for (const file of TILES) writeFileSync(file, next)
console.log(`train engine inlined (${code.length} bytes) → ${TILES.join(', ')}`)
