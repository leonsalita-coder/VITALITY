/**
 * Bundles lib/train/index.ts to a single IIFE (global `TrainEngine`) and
 * inlines it into the tile HTML between the TRAIN-ENGINE markers.
 *
 * Tiles are sealed srcDoc iframes with no network and no external files, so
 * the engine cannot be a <script src>. It has to be physically inlined, and
 * both copies of the tile have to stay identical.
 *
 * COMPUTING AND WRITING ARE SEPARATE, and that is not tidiness. The build
 * used to run on import, so a test that merely imported it rewrote the
 * shipped tile — and vitest runs test files in parallel, alongside a suite
 * that deliberately mutates engine sources on disk. The tile was rebuilt
 * from mutated source, the source was restored, and a tile carrying
 * `if (!entry && entry.off)` was left staged for commit.
 *
 *   import { buildTileHtml }   what the tile SHOULD contain, no writes
 *   node scripts/build-tile.mjs   write it
 */
import { build } from 'esbuild'
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const START = '<!-- TRAIN-ENGINE:START -->'
const END = '<!-- TRAIN-ENGINE:END -->'
export const TILES = ['public/tiles/train.html', 'tiles-library/train.html']

/** The tile HTML with the current engine inlined. Reads; never writes. */
export async function buildTileHtml() {
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
  return {
    html: source.replace(new RegExp(`${START}[\\s\\S]*?${END}`), () => block),
    bytes: code.length,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { html, bytes } = await buildTileHtml()
  for (const file of TILES) writeFileSync(file, html)
  console.log(`train engine inlined (${bytes} bytes) → ${TILES.join(', ')}`)
}
