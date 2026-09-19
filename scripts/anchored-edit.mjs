#!/usr/bin/env node
/**
 * Anchored edits that cannot silently hit the wrong place.
 *
 * Every anchored edit in this repo goes through here. The reason is a bug
 * that shipped twice from the same cause: a replace pattern that matched
 * more than one site, landing the change on the first one and leaving a
 * duplicate key behind. JavaScript accepts duplicate keys, so the test
 * suite stayed green both times. Typecheck catches the class in .ts and
 * structurally cannot inside public/tiles/*.html, where the code is a
 * string until a browser reads it — so the edit path is the only place a
 * fix generalizes.
 *
 * The rule: an anchor must match EXACTLY the number of sites you said it
 * would, or nothing is written at all.
 *
 *   node scripts/anchored-edit.mjs edits.json
 *
 * edits.json is one object or a list of them:
 *
 *   { "file": "path", "anchor": "text to find", "replace": "new text",
 *     "expect": 1 }
 *
 * `expect` defaults to 1. Every edit in a run is validated before any of
 * them is written, so a run either applies completely or not at all.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const linesOf = (text, anchor) => {
  const out = []
  let at = text.indexOf(anchor)
  while (at !== -1) {
    out.push(text.slice(0, at).split('\n').length)
    at = text.indexOf(anchor, at + 1)
  }
  return out
}

const countOf = (text, anchor) => linesOf(text, anchor).length

function main() {
  const spec = process.argv[2]
  if (!spec) {
    console.error('usage: anchored-edit.mjs <edits.json>')
    process.exit(2)
  }
  const raw = JSON.parse(readFileSync(spec, 'utf8'))
  const edits = Array.isArray(raw) ? raw : [raw]

  /* Validate every edit against the state the previous ones leave behind,
     so two edits in a run cannot each be individually fine and jointly
     wrong. Nothing touches the disk until all of them pass. */
  const pending = new Map()
  const problems = []

  edits.forEach((edit, i) => {
    const { file, anchor, replace, expect = 1 } = edit
    const label = `edit ${i + 1} (${file})`
    if (typeof file !== 'string' || typeof anchor !== 'string' || typeof replace !== 'string') {
      problems.push(`${label}: file, anchor and replace must all be strings`)
      return
    }
    if (!pending.has(file)) {
      try {
        pending.set(file, readFileSync(file, 'utf8'))
      } catch (err) {
        problems.push(`${label}: cannot read — ${err.message}`)
        return
      }
    }
    const text = pending.get(file)
    const hits = linesOf(text, anchor)
    if (hits.length !== expect) {
      problems.push(
        `${label}: anchor matched ${hits.length} site(s), expected ${expect}` +
          (hits.length ? ` — lines ${hits.join(', ')}` : '') +
          `\n    anchor: ${JSON.stringify(anchor.slice(0, 120))}`,
      )
      return
    }
    let next = text
    for (let n = 0; n < expect; n++) next = next.replace(anchor, () => replace)
    pending.set(file, next)
  })

  if (problems.length) {
    console.error('anchored-edit: nothing written.\n  ' + problems.join('\n  '))
    process.exit(1)
  }

  for (const [file, text] of pending) {
    writeFileSync(file, text)
    console.log(`anchored-edit: ${file}`)
  }
}

/* Same guard as the audit tool: importing this must not run it. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()

export { countOf, linesOf }
