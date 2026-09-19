#!/usr/bin/env node
/**
 * Find sessions whose weights climbed set-by-set because of the prefill bug.
 *
 * THE BUG. Until it was fixed, logging a clean set wrote today's partial
 * session into history, and the next unlogged row recomputed its
 * suggestion from that — so the prescription advanced one increment per
 * set. Three clean sets of 315 were logged as 315, 320, 325.
 *
 * Those weights were WRITTEN. Volume, estimated 1RM, records, the plateau
 * read and every weekly figure since are computed from them.
 *
 * THIS TOOL ONLY REPORTS. It never edits anything. Deciding what to do
 * about a corrupted session is the athlete's call, not a script's — the
 * sets may have genuinely happened at the climbing weights, because a
 * lifter who saw 320 on the screen may well have loaded 320.
 *
 *   node scripts/audit-prefill-climb.mjs <export.json>
 *   node scripts/audit-prefill-climb.mjs <export.json> --json
 *
 * The file is a Vitality export ({ app, v, exportedAt, state }) or a bare
 * state object. Export one from the tile: Settings → Export.
 *
 * THE FINGERPRINT, and its limits. The bug produces working sets whose
 * weight rises by a CONSTANT step while the reps stay the same — because
 * every row was prescribed the same rep target and one more increment.
 * A deliberate ascending or pyramid set almost always drops the reps as
 * the weight rises, so those are reported separately rather than counted.
 * Neither list is a verdict; both are places to look.
 */

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const isWorking = (set) => set && set.fail !== true && set.warmup !== true
const weightOf = (entry, set) => (typeof set.w === 'number' ? set.w : entry.kg || 0)

/** Does this entry look like the bug? */
function inspect(entry) {
  const working = (entry.sets || []).filter(isWorking)
  if (working.length < 2) return null

  const weights = working.map((s) => weightOf(entry, s))
  const reps = working.map((s) => s.r)

  const steps = []
  for (let i = 1; i < weights.length; i++) steps.push(weights[i] - weights[i - 1])
  if (!steps.every((s) => s > 0)) return null

  const constantStep = steps.every((s) => Math.abs(s - steps[0]) < 0.001)
  if (!constantStep) return null

  const repsHeld = reps.every((r) => r === reps[0])
  return {
    date: entry.date,
    weights,
    reps,
    step: steps[0],
    sets: working.length,
    /* The reps are the tell. Same reps at a rising weight is the bug's
       signature; falling reps is somebody choosing to go up. */
    likelyBug: repsHeld,
  }
}

function main() {
  const path = process.argv[2]
  const asJson = process.argv.includes('--json')
  if (!path) {
    console.error('usage: audit-prefill-climb.mjs <export.json> [--json]')
    process.exit(2)
  }

  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    console.error(`cannot read ${path}: ${err.message}`)
    process.exit(1)
  }
  const state = parsed && parsed.state ? parsed.state : parsed
  const history = (state && state.history) || {}
  const names = (state && state.exerciseNames) || {}

  const suspect = []
  const ascending = []
  let entries = 0

  for (const id of Object.keys(history)) {
    for (const entry of history[id] || []) {
      if (!entry || entry.off) continue
      entries++
      const found = inspect(entry)
      if (!found) continue
      const row = { id, name: names[id] || id, ...found }
      ;(found.likelyBug ? suspect : ascending).push(row)
    }
  }

  const report = {
    sessionsChecked: entries,
    liftsChecked: Object.keys(history).length,
    likelyAffected: suspect,
    ascendingButRepsFell: ascending,
  }

  if (asJson) {
    console.log(JSON.stringify(report, null, 2))
    return
  }

  console.log(`\nPREFILL-CLIMB AUDIT — ${path}`)
  console.log(`  ${entries} sessions across ${report.liftsChecked} lifts\n`)

  if (!suspect.length) {
    console.log('  No sessions match the bug signature (rising weight, same reps).')
  } else {
    console.log(`  ${suspect.length} session(s) match the signature:\n`)
    for (const row of suspect) {
      const shape = row.weights.map((w, i) => `${w}×${row.reps[i]}`).join(', ')
      console.log(`    ${row.date}  ${row.name.padEnd(22)} ${shape}   (+${row.step} per set)`)
    }
    console.log(
      '\n  These weights are in volume, e1RM, records and every weekly read.',
    )
    console.log('  Nothing has been changed. The sets may have happened as logged —')
    console.log('  a lifter who saw 320 on the screen may well have loaded 320.')
  }

  if (ascending.length) {
    console.log(`\n  ${ascending.length} session(s) rise but drop reps — probably deliberate:`)
    for (const row of ascending.slice(0, 10)) {
      const shape = row.weights.map((w, i) => `${w}×${row.reps[i]}`).join(', ')
      console.log(`    ${row.date}  ${row.name.padEnd(22)} ${shape}`)
    }
    if (ascending.length > 10) console.log(`    … and ${ascending.length - 10} more`)
  }
  console.log('')
}

/* Only when run as a command. Importing this for its fingerprint must
   not parse argv and exit — a module with a side effect on import cannot
   be tested, and this one is worth testing. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()

export { inspect }
