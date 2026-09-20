#!/usr/bin/env node
/**
 * Print the shadow log: what the silent findings would have said, when,
 * and on what evidence.
 *
 * Usage:  node scripts/shadow-review.mjs [path] [--feature=<name>] [--since=YYYY-MM-DD]
 *
 * Default path is ~/vitality-inbox/train-shadow.json, which is where a
 * sweep or the connector drops an export of the `vitality:train:shadow`
 * slot. The tile is sealed and this is node, so there is no way to read
 * the store directly — the log has to come out through the same courier
 * path as every other piece of data.
 *
 * The formatting is NOT duplicated here. It bundles lib/train/shadow.ts
 * and calls reviewLines, because a second renderer would drift from the
 * one the engine uses and then confidently print something nobody ships.
 */
import { build } from 'esbuild'
import { readFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const flags = Object.fromEntries(
  args.filter((a) => a.startsWith('--')).map((a) => {
    const [k, v = 'true'] = a.slice(2).split('=')
    return [k, v]
  }),
)
const path = resolve(args.find((a) => !a.startsWith('--')) || join(homedir(), 'vitality-inbox', 'train-shadow.json'))

if (!existsSync(path)) {
  console.log(`No shadow log at ${path}.`)
  console.log('')
  console.log('Nothing has been exported yet. The log fills as sessions are logged;')
  console.log('export the `vitality:train:shadow` slot to that path and run this again.')
  process.exit(0)
}

let log
try {
  log = JSON.parse(readFileSync(path, 'utf8'))
} catch (err) {
  console.error(`Could not read ${path}: ${err.message}`)
  process.exit(2)
}

const out = mkdtempSync(join(tmpdir(), 'shadow-review-'))
const bundle = join(out, 'shadow.mjs')
await build({
  entryPoints: [resolve('lib/train/shadow.ts')],
  bundle: true, format: 'esm', platform: 'node', outfile: bundle, logLevel: 'silent',
})
const { reviewLines } = await import(pathToFileURL(bundle).href)

const opts = {}
if (flags.feature) opts.feature = flags.feature
if (flags.since) opts.since = flags.since

console.log(reviewLines(log, opts).join('\n'))
