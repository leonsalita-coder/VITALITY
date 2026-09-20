#!/usr/bin/env node
/**
 * Colour and type live in the token block or they do not live.
 *
 * A restyle that scatters `#1f1f24` and `font-size:13px` through the
 * stylesheet is a restyle that cannot be themed, cannot be reviewed as a
 * system, and turns "light mode" from a token swap into a rewrite. This
 * is the check that keeps the reconciled set honest once it exists.
 *
 * WHAT COUNTS AS A VIOLATION
 *   - a hex colour anywhere but :root
 *   - a px font-size anywhere but :root
 *   - either of those in an inline style= attribute in the tile markup
 *
 * Inline styles are included deliberately. They are the hardest to see,
 * they win every specificity argument, and the tile currently carries a
 * pile of them inside dialog markup — including four that reference
 * tokens which do not exist (--bg, --mint, --muted-strong, --vt-mono)
 * and therefore already do nothing.
 *
 * A RATCHET, not a wall. The count today is what it is; it is written to
 * .style-baseline.json and may only go down. That is how the mutation
 * harness is wired and for the same reason — a gate that fails on day one
 * gets disabled on day one.
 *
 *   node scripts/style-lint.mjs
 *   node scripts/style-lint.mjs --json
 *   node scripts/style-lint.mjs --bless     (after a real reduction)
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const TILES = ['public/tiles/train.html', 'tiles-library/train.html']
const BASELINE_FILE = '.style-baseline.json'

const HEX = /#[0-9a-fA-F]{3,8}\b/g
const PX_FONT = /font-size\s*:\s*[0-9.]+px|font\s*:\s*[^;"']*?\b[0-9.]+px/g

/** The <style> block, split into the :root token block and everything else. */
export function splitCss(source) {
  const m = /<style[^>]*>([\s\S]*?)<\/style>/.exec(source)
  if (!m) throw new Error('no <style> block')
  /* Comments stripped first. The check flagged a `#fff` that appeared in
     a comment explaining that the #fff fallbacks had been replaced — the
     lint reading its own documentation as a violation. */
  const css = m[1].replace(/\/\*[\s\S]*?\*\//g, '')
  const root = /:root\s*\{[\s\S]*?\n\s*\}/.exec(css)
  return {
    css,
    tokens: root ? root[0] : '',
    rules: root ? css.slice(0, root.index) + css.slice(root.index + root[0].length) : css,
  }
}

/** Inline style="…" attributes outside the inlined engine bundle. */
export function inlineStyles(source) {
  const a = source.indexOf('<!-- TRAIN-ENGINE:START -->')
  const b = source.indexOf('<!-- TRAIN-ENGINE:END -->')
  const own = a >= 0 && b > a ? source.slice(0, a) + source.slice(b) : source
  return [...own.matchAll(/style\s*=\s*"([^"]*)"/g)].map((m) => m[1])
    .concat([...own.matchAll(/style\s*=\s*'([^']*)'/g)].map((m) => m[1]))
}

function scan(file) {
  const source = readFileSync(file, 'utf8')
  const { css, rules } = splitCss(source)
  const found = []
  const push = (where, kind, hits) => hits.forEach((h) => found.push({ file, where, kind, text: h }))

  push('stylesheet', 'hex', rules.match(HEX) || [])
  push('stylesheet', 'px-font', rules.match(PX_FONT) || [])
  for (const decl of inlineStyles(source)) {
    push('inline', 'hex', decl.match(HEX) || [])
    push('inline', 'px-font', decl.match(PX_FONT) || [])
  }
  /* Reported, not counted: a token referenced but never defined resolves
     to nothing, so the declaration using it is already inert.

     Tokens may be defined outside :root — `--state-ink` is set on the
     button that uses it, which is the correct scope for it. Looking only
     at :root reported it as dangling. */
  const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]))
  const runtime = new Set([...source.matchAll(/setProperty\(\s*['"](--[\w-]+)/g)].map((m) => m[1]))
  const used = new Set([...source.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]))
  const dangling = [...used].filter((t) => !defined.has(t) && !runtime.has(t)).sort()
  return { found, dangling }
}

function main() {
  const json = process.argv.includes('--json')
  const bless = process.argv.includes('--bless')

  const all = []
  let dangling = []
  for (const file of TILES) {
    const r = scan(file)
    all.push(...r.found)
    if (file === TILES[0]) dangling = r.dangling
  }
  const count = all.length

  if (json) {
    console.log(JSON.stringify({ count, dangling, violations: all }, null, 2))
  } else {
    const byKind = {}
    for (const v of all) {
      const key = `${v.where}/${v.kind}`
      byKind[key] = (byKind[key] || 0) + 1
    }
    console.log('STYLE LINT')
    console.log(`  ${count} value(s) outside the token block`)
    for (const [k, n] of Object.entries(byKind).sort()) console.log(`    ${k.padEnd(20)} ${n}`)
    if (dangling.length) {
      console.log(`\n  tokens referenced but never defined: ${dangling.join(' ')}`)
      console.log('    (these resolve to nothing — the declarations using them are inert)')
    }
  }

  const baseline = existsSync(BASELINE_FILE)
    ? JSON.parse(readFileSync(BASELINE_FILE, 'utf8')).values
    : null

  if (bless) {
    writeFileSync(BASELINE_FILE, JSON.stringify({ values: count }, null, 2) + '\n')
    console.log(`\n  baseline written: ${count}`)
    process.exit(0)
  }
  if (baseline == null) {
    console.log('\n  no baseline yet — run with --bless')
    process.exit(0)
  }
  if (count > baseline) {
    console.log(`\n  REGRESSION: ${count} values, baseline allows ${baseline}`)
    process.exit(1)
  }
  console.log(count < baseline
    ? `\n  improved: ${count} against a baseline of ${baseline} — lower it with --bless`
    : `\n  holding at the baseline of ${baseline}`)
  process.exit(0)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
