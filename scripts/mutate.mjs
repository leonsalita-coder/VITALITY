#!/usr/bin/env node
/**
 * Mutation testing — does the suite actually catch anything?
 *
 * Every failure this engine has produced has been a test that could not
 * fail. Not one has been a bug the tests caught late; they have been
 * guards asserting that code exists rather than that it runs, gates
 * masked by other gates, absence assertions against empty fixtures, a
 * boundary test written at the one time of day it had twelve hours of
 * slack, and — worst — a harness that resolved zero test files, reported
 * zero failures, and read exactly like success.
 *
 * This tool encodes each of those, so they are caught by the build rather
 * than by somebody remembering.
 *
 *   node scripts/mutate.mjs                 everything
 *   node scripts/mutate.mjs --mode=lint     absence assertions only (fast)
 *   node scripts/mutate.mjs --mode=mutate --files=weekly,timing
 *   node scripts/mutate.mjs --mode=callsites
 *   node scripts/mutate.mjs --mode=fuzz
 *   node scripts/mutate.mjs --limit=20 --json
 *
 * EXIT CODES: 0 clean, 1 survivors or lint findings, 2 harness failure.
 * A harness failure is deliberately distinct: "the tool broke" must never
 * be mistaken for "nothing survived".
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, readdirSync, mkdtempSync, cpSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const ENGINE_DIR = 'lib/train'
const TEST_DIR = 'tests/train'
const TILES = ['public/tiles/train.html', 'tiles-library/train.html']

/* ---------------------------------------------------------------- *
 * Running tests, and refusing to believe a run that did not happen.
 * ---------------------------------------------------------------- */

/**
 * The failure that makes every other check worthless.
 *
 * Passing several `.test.ts` paths to vitest made it resolve NO test
 * files; it printed "No test files found", the grep for failures matched
 * nothing, and eleven mutations were reported as survived-nothing-caught
 * when in truth nothing had run. So every result here is checked against
 * what was expected to run before it is believed.
 */
function runTests(patterns, expect = {}) {
  let stdout = ''
  try {
    /* Single-process, deliberately. The harness spawns one `vitest run`
       per mutation — thousands across a full sweep — and vitest forks a
       worker per CPU by default. That saturated the machine, and a
       saturated machine is how a clean module's baseline comes back
       "1 failing": the abort that stopped two sweeps was resource
       starvation, not a real red test. Slower per run, and the only
       version that finishes. */
    stdout = execFileSync('npx', ['vitest', 'run', '--no-file-parallelism', ...patterns], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(expect.env || {}) },
      /* A mutation can turn a loop condition into a non-terminating one.
         Without a deadline the whole run hangs on it, which reads as the
         tool being slow rather than the mutation being lethal. */
      timeout: expect.timeoutMs || 120_000,
    })
  } catch (err) {
    /* A timeout is a KILLED mutation, not a broken harness: the code no
       longer terminates, which is a behaviour change the suite noticed
       in the most emphatic way available. */
    if (err && (err.killed || err.code === 'ETIMEDOUT')) {
      return { ok: true, failed: 1, suitesFailed: 0, lethal: true, total: 1, fileCount: 1, timedOut: true }
    }
    stdout = String(err.stdout || '') + String(err.stderr || '')
  }

  return verdictFrom(stdout, expect)
}

/**
 * Turning vitest's output into a verdict — the whole safety property of
 * this tool, extracted so it can be tested without shelling out.
 *
 * It exists as its own function because the version inlined in runTests
 * could not be exercised directly, and the zero-tests check inside it —
 * the guard against precisely the failure that made this tool necessary —
 * survived mutation testing of the tool itself.
 */
function verdictFrom(stdout, expect = {}) {
  const files = /Test Files\s+(?:(\d+) failed \| )?(\d+) passed \((\d+)\)/.exec(stdout)
  const tests = /Tests\s+(?:(\d+) failed \| )?(\d+) passed \((\d+)\)/.exec(stdout)
  if (!files || !tests) {
    /* No summary at all. Which of two very different things this is
       depends on whether the IDENTICAL invocation worked a moment ago:
       if the baseline ran, the patterns are sound and the mutation has
       broken collection outright — a kill, and an emphatic one. If there
       was no baseline, the tool is being misused and must say so rather
       than score it. */
    if (expect.baselineRan) {
      return { ok: true, failed: 1, suitesFailed: 1, lethal: true, total: expect.minTests || 1, fileCount: expect.minFiles || 1, collapsed: true }
    }
    return { ok: false, reason: `no test summary in output (${firstLine(stdout)})`, failed: 0, total: 0, fileCount: 0 }
  }
  /**
   * A FAILED SUITE is a kill, and it does not appear in the Tests line.
   *
   * A mutation lethal enough to stop a file LOADING is reported as
   * `Test Files 1 failed | 1 passed` while `Tests` carries no failures
   * at all — the file never got far enough to have any. Counting only
   * test failures then sees a short run with nothing wrong, and the
   * guard below calls the tool broken. That is exactly how
   * progression.ts stayed unmutated for as long as it did.
   *
   * `failed` keeps meaning test failures, because callers and tests read
   * it that way. `lethal` is the question a sweep actually asks: did
   * anything at all go wrong?
   */
  const suitesFailed = Number(files[1] || 0)
  const testsFailed = Number(tests[1] || 0)
  const result = {
    ok: true,
    failed: testsFailed,
    suitesFailed,
    lethal: testsFailed > 0 || suitesFailed > 0,
    total: Number(tests[3]),
    fileCount: Number(files[3]),
  }
  if (result.total === 0) {
    return { ...result, ok: false, reason: 'resolved zero tests' }
  }
  /**
   * A short run with FAILURES in it is a kill, not a broken tool.
   *
   * These two guards exist to catch a run that resolved fewer tests than
   * the baseline while everything passed — which looks exactly like a
   * surviving mutation and is the failure that made this tool necessary.
   * They were checked before the failure count, and so fired on the
   * opposite case: a mutation lethal enough to abort whole test FILES
   * takes the total down with it, and the harness called itself broken
   * instead of scoring the most emphatic kill available.
   *
   * It had been doing that on lib/train/progression.ts for as long as the
   * guard has existed, so that module was never mutation-tested at all —
   * the tool reported a failure and nobody read it as a gap in coverage.
   *
   * A run where tests failed cannot be mistaken for a survivor, so the
   * count only matters when nothing failed.
   */
  if (!result.lethal && expect.minFiles && result.fileCount < expect.minFiles) {
    return { ...result, ok: false, reason: `ran ${result.fileCount} files, expected at least ${expect.minFiles}` }
  }
  if (!result.lethal && expect.minTests && result.total < expect.minTests) {
    return { ...result, ok: false, reason: `ran ${result.total} tests, expected at least ${expect.minTests}` }
  }
  return result
}

const firstLine = (s) => String(s).split('\n').find((l) => l.trim()) || 'no output'

/* ---------------------------------------------------------------- *
 * Snapshots. Never git checkout — that discarded uncommitted work in
 * six files once already, because a snapshot taken from HEAD is not a
 * snapshot of what you were editing.
 * ---------------------------------------------------------------- */

/**
 * The harness writes broken code into the working tree on purpose.
 *
 * A `finally` restores it when a run ends or throws, and covers nothing
 * else. That is not enough: a Ctrl-C or a `pkill` ends the process
 * first, and what is left on disk is a mutated engine file that looks
 * exactly like a real edit. It happened — a killed run left
 * `if (false) return record` in deload.ts and it was found three steps
 * later as a mysterious failure in a module nobody had touched.
 *
 * A `process.on('SIGTERM')` handler was written first and DOES NOT WORK
 * here, which is worth recording so nobody adds it back. `main()` is one
 * long synchronous block of execSync calls; the event loop never spins,
 * so the JS signal callback never gets a turn and the run continues to
 * completion with the signal queued. Verified, not assumed.
 *
 * What works is recovery rather than interception: the snapshot is
 * written to disk BEFORE the first mutation and removed on a clean exit,
 * and every run begins by putting back anything a previous run left
 * behind. That survives SIGTERM, SIGKILL, a closed laptop and a power
 * cut, none of which any in-process handler can.
 *
 * Restoring from a snapshot rather than `git checkout` is deliberate and
 * unchanged: checkout would also discard whatever uncommitted work the
 * author had in those files, which is far worse than a stale mutation.
 */
const SNAPSHOT_FILE = '.mutate-snapshot.json'

/** Signal 0 asks the kernel whether a pid exists without disturbing it. */
function alive(pid) {
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

/**
 * Put back anything a previous run left mutated.
 *
 * Runs before every mode, including the modes that never mutate — a
 * `--mode=lint` in the pre-commit hook is the most likely next command
 * after an interrupted run, and is therefore the best place to catch it.
 */
function recoverInterruptedRun() {
  if (!existsSync(SNAPSHOT_FILE)) return
  let saved
  try {
    saved = JSON.parse(readFileSync(SNAPSHOT_FILE, 'utf8'))
  } catch {
    console.error(`could not read ${SNAPSHOT_FILE}; delete it by hand and check git diff`)
    process.exit(2)
  }
  /* A snapshot belongs to the run that wrote it, and recovering another
     run's snapshot is worse than doing nothing: it restores the files,
     deletes the snapshot, and leaves the live sweep mutating a tree
     nothing can undo. That happened — `pkill` sent SIGTERM, a
     `--mode=lint` two seconds later tidied up, and the not-yet-dead
     sweep put `if (false) continue` into lib/train/dose.ts where a
     clean-looking `git status` hid it.

     An absent pid means a snapshot from before this was recorded, and
     the safe default there is to recover it — otherwise an old one is
     stranded forever with no way out but deleting it by hand.

     Pid reuse can strand a snapshot: a dead run's pid gets recycled and
     this reads the recycled process as the owner. That is why the
     message says what to do rather than just refusing — the failure is
     loud and one `rm` away, which is the right trade against silently
     recovering a snapshot out from under a live sweep. */
  if (saved.pid && alive(saved.pid)) {
    console.error(
      `${SNAPSHOT_FILE} belongs to pid ${saved.pid}, which is still running.\n` +
      'Another mutation run is in progress; the files on disk are its, not yours.\n' +
      'Wait for it to finish, or stop it and run this again.',
    )
    process.exit(2)
  }

  let restored = 0
  for (const [p, text] of Object.entries(saved.files || {})) {
    if (!existsSync(p) || readFileSync(p, 'utf8') !== text) {
      writeFileSync(p, text)
      restored++
    }
  }
  rmSync(SNAPSHOT_FILE, { force: true })
  console.error(
    restored
      ? `recovered from an interrupted run: restored ${restored} file(s).`
      : 'cleared a stale snapshot from an interrupted run; nothing needed restoring.',
  )
}

/**
 * `.mutate-snapshot.json` is written by every mode that mutates-and-
 * restores (callsites, fuzz's cousin modes, mutate) — its mere presence
 * says "a sweep is running" but not which one. That ambiguity is exactly
 * how a ~90-minute callsites pass got read as being deep into the
 * multi-hour mutate sweep: both write the same file, so "which mode owns
 * this" had to be inferred from elapsed time instead of just read. `mode`
 * is recorded here so it never has to be inferred again.
 */
function snapshot(paths, mode) {
  const dir = mkdtempSync(join(tmpdir(), 'mutate-'))
  const saved = new Map()
  for (const p of paths) saved.set(p, readFileSync(p, 'utf8'))
  /* On disk BEFORE the first mutation is applied. A snapshot held only
     in memory dies with the process that needed it. */
  writeFileSync(SNAPSHOT_FILE, JSON.stringify({ pid: process.pid, mode, files: Object.fromEntries(saved) }))
  return {
    dir,
    restore() {
      /* Only what actually moved. A sweep restores after every mutation,
         and two 200KB tiles rewritten 1500 times is a lot of disk for no
         change — the engine source is the only file that usually differs. */
      for (const [p, text] of saved) {
        if (readFileSync(p, 'utf8') !== text) writeFileSync(p, text)
      }
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true })
      rmSync(SNAPSHOT_FILE, { force: true })
    },
  }
}

/**
 * Coarse, mode-labelled progress for anything that iterates for a while.
 *
 * "How far in is it" used to have no answer short of guessing from
 * elapsed time. This prints at roughly every 5% (or every step, for a
 * count too small to have a meaningful 5%), so a long mode says where it
 * is without flooding the log with one line per mutation.
 */
function progress(mode, done, total) {
  if (total <= 0) return
  const step = Math.max(1, Math.floor(total / 20))
  if (done !== total && done % step !== 0) return
  process.stderr.write(`  ${mode}: ${done}/${total}\n`)
}

/* ---------------------------------------------------------------- *
 * Which tests exercise which module.
 * ---------------------------------------------------------------- */

const testFiles = () =>
  readdirSync(TEST_DIR).filter((f) => f.endsWith('.test.ts')).map((f) => join(TEST_DIR, f))

/** Test files that import this module directly. */
function testsFor(moduleName) {
  const found = []
  for (const file of testFiles()) {
    const text = readFileSync(file, 'utf8')
    if (new RegExp(`train/${moduleName}['"]`).test(text)) found.push(file)
  }
  return found
}

/** Test files that boot a tile. Any engine change can move these. */
function tileTests() {
  return testFiles().filter((f) => /JSDOM/.test(readFileSync(f, 'utf8')))
}

/* ---------------------------------------------------------------- *
 * The operators.
 * ---------------------------------------------------------------- */

/**
 * Deliberately conservative. Each of these changes behaviour in a way a
 * correct suite should notice; operators that merely rename or reorder
 * produce survivors nobody can act on, which is how a mutation score
 * becomes a number people stop reading.
 */
const OPERATORS = [
  { id: 'and-to-or', find: / && /g, put: () => ' || ' },
  { id: 'or-to-and', find: / \|\| /g, put: () => ' && ' },
  { id: 'gte-to-gt', find: / >= /g, put: () => ' > ' },
  { id: 'lte-to-lt', find: / <= /g, put: () => ' < ' },
  { id: 'gt-to-gte', find: / > /g, put: () => ' >= ' },
  { id: 'lt-to-lte', find: / < /g, put: () => ' <= ' },
  { id: 'eq-to-neq', find: / === /g, put: () => ' !== ' },
  { id: 'neq-to-eq', find: / !== /g, put: () => ' === ' },
  { id: 'true-to-false', find: /\btrue\b/g, put: () => 'false' },
  { id: 'guard-removed', find: /^(\s*)if \(([^)]{1,120})\) (return|continue)\b/gm, put: (m, indent, _cond, kw) => `${indent}if (false) ${kw}` },
]

/** Every mutation this file admits, as {file, index, id, before, after}. */
function mutationsFor(file) {
  const text = readFileSync(file, 'utf8')
  const out = []
  for (const op of OPERATORS) {
    let match
    op.find.lastIndex = 0
    while ((match = op.find.exec(text)) !== null) {
      const at = match.index
      /* Comments and doc blocks are prose; mutating them changes nothing
         and every one would be reported as a survivor. */
      if (inCommentAt(text, at)) continue
      const replaced = op.put(...match)
      if (replaced === match[0]) continue
      out.push({
        file,
        at,
        id: op.id,
        line: text.slice(0, at).split('\n').length,
        before: match[0],
        after: replaced,
      })
    }
  }
  return out
}

/** Cheap but sufficient: is this offset inside a // or /* comment? */
function inCommentAt(text, at) {
  const lineStart = text.lastIndexOf('\n', at) + 1
  const line = text.slice(lineStart, at)
  if (line.includes('//')) return true
  const openBlock = text.lastIndexOf('/*', at)
  const closeBlock = text.lastIndexOf('*/', at)
  return openBlock > closeBlock
}

function applyMutation(m) {
  const text = readFileSync(m.file, 'utf8')
  writeFileSync(m.file, text.slice(0, m.at) + m.after + text.slice(m.at + m.before.length))
}

/* ---------------------------------------------------------------- *
 * MODE: mutate
 * ---------------------------------------------------------------- */

function modeMutate(opts) {
  const modules = readdirSync(ENGINE_DIR)
    .filter((f) => f.endsWith('.ts') && f !== 'index.ts')
    .map((f) => f.replace(/\.ts$/, ''))
    .filter((name) => !opts.files.length || opts.files.includes(name))

  const survivors = []
  let killed = 0
  let considered = 0

  for (const [moduleIndex, name] of modules.entries()) {
    process.stderr.write(`  mutate: module ${moduleIndex + 1}/${modules.length} — ${name}\n`)
    const file = join(ENGINE_DIR, `${name}.ts`)
    const scope = testsFor(name)
    if (!scope.length) {
      survivors.push({ file, line: 0, id: 'no-tests', note: 'no test file imports this module' })
      continue
    }

    /* The baseline has to be green, or every mutation "survives" against
       a suite that was already failing. */
    const base = runTests(scope, { minFiles: scope.length })
    if (!base.ok) return harnessFailure(`baseline for ${name}: ${base.reason}`)
    if (base.failed) return harnessFailure(`baseline for ${name} is already red (${base.failed} failing)`)

    let all = mutationsFor(file)
    if (opts.limit) all = evenlySampled(all, opts.limit)

    /* The tiles as well as the source. The harness only ever snapshotted
       lib/train, and the tile is the thing that ships — a rebuild landing
       mid-run bakes a mutated engine into it, the source gets restored,
       and the corrupted tile stays. That happened, and reached the index. */
    const snap = snapshot([file, ...TILES], 'mutate')
    try {
      let doneInModule = 0
      for (const m of all) {
        considered++
        doneInModule++
        applyMutation(m)
        const r = runTests(scope, { minFiles: scope.length, minTests: base.total, baselineRan: true })
        snap.restore()
        if (!r.ok) return harnessFailure(`${name}:${m.line} — ${r.reason}`)
        if (r.lethal) killed++
        else survivors.push({ ...m, scope: scope.length })
        progress(`mutate:${name}`, doneInModule, all.length)
      }
    } finally {
      snap.restore()
      snap.cleanup()
    }
    process.stderr.write(`  ${name}: ${all.length} mutations, ${scope.length} test file(s)\n`)
  }
  return { considered, killed, survivors }
}

/** A spread across the file rather than the first N, which cluster. */
function evenlySampled(list, limit) {
  if (list.length <= limit) return list
  const step = list.length / limit
  return Array.from({ length: limit }, (_, i) => list[Math.floor(i * step)])
}

/* ---------------------------------------------------------------- *
 * MODE: callsites — the class that produced kind: e.kind
 * ---------------------------------------------------------------- */

/**
 * A guard satisfiable by code merely EXISTING is asserting existence, not
 * reachability. This removes each tile-side call to the engine and checks
 * that something goes red. Anything the tile can stop calling with the
 * suite still green is a wiring path nothing actually guards — which is
 * how `kind: e.kind`, the missing barrel exports, the unwired coach path
 * and analysis.ts all shipped.
 */
function modeCallsites(opts) {
  const tile = TILES[0]
  const text = readFileSync(tile, 'utf8')
  const calls = []
  const re = /TrainEngine\.([A-Za-z0-9_]+)\s*\(/g
  let match
  while ((match = re.exec(text)) !== null) {
    if (inCommentAt(text, match.index)) continue
    calls.push({ name: match[1], at: match.index, line: text.slice(0, match.index).split('\n').length })
  }

  /* One representative call per engine member: removing all twelve
     `suggestTarget` calls proves less than removing one, and costs
     twelve test runs. */
  const seen = new Set()
  let unique = calls.filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true)))
  if (opts.files.length) unique = unique.filter((c) => opts.files.includes(c.name))
  if (opts.limit) unique = evenlySampled(unique, opts.limit)

  const scope = tileTests()
  const base = runTests(scope, { minFiles: scope.length })
  if (!base.ok) return harnessFailure(`callsite baseline: ${base.reason}`)
  if (base.failed) return harnessFailure(`callsite baseline already red (${base.failed} failing)`)

  const survivors = []
  let killed = 0
  const snap = snapshot(TILES, 'callsites')
  try {
    for (const [i, call] of unique.entries()) {
      /* Replaced rather than deleted: the expression must still parse, so
         the failure is "nothing was wired here" and not a syntax error
         that would fail everything and look like a pass. */
      const current = readFileSync(tile, 'utf8')
      const mutated = current.slice(0, call.at) + '((()=>undefined))(' + current.slice(call.at + `TrainEngine.${call.name}(`.length)
      writeFileSync(tile, mutated)
      writeFileSync(TILES[1], mutated)

      const r = runTests(scope, { minFiles: scope.length, minTests: base.total, baselineRan: true })
      snap.restore()
      if (!r.ok) return harnessFailure(`callsite ${call.name}: ${r.reason}`)
      if (r.lethal) killed++
      else survivors.push({ file: tile, line: call.line, id: 'unguarded-callsite', name: call.name })
      progress('callsites', i + 1, unique.length)
    }
  } finally {
    snap.restore()
    snap.cleanup()
  }
  return { considered: unique.length, killed, survivors }
}

/* ---------------------------------------------------------------- *
 * MODE: fuzz — a DST test at noon has twelve hours of slack
 * ---------------------------------------------------------------- */

const ZONES = ['America/New_York', 'Europe/London', 'Australia/Sydney', 'UTC']
const HOURS = ['00:30', '01:30', '06:30', '12:30', '23:30']

function modeFuzz(opts) {
  let dated = testFiles().filter((f) => /Date|day\(|localMidnight|rollingWindow|dateKey/.test(readFileSync(f, 'utf8')))
  if (opts.files.length) dated = dated.filter((f) => opts.files.some((n) => f.includes(n)))

  const survivors = []
  let considered = 0
  const total = ZONES.length * HOURS.length
  for (const zone of ZONES) {
    /* The hour is supplied to the suite rather than faked here: a test
       that reads the clock will read this one. Tests that pass `now`
       explicitly are unaffected, which is the point — they are the ones
       already immune. */
    for (const hour of HOURS) {
      considered++
      const r = runTests(dated, { minFiles: dated.length, env: { TZ: zone, MUTATE_HOUR: hour } })
      if (!r.ok) return harnessFailure(`fuzz ${zone} ${hour}: ${r.reason}`)
      /* Lethal, not merely `failed`: a timezone that stops a test file
         LOADING is as time-dependent as one that makes an assertion go
         red, and reporting only the latter would miss it. */
      if (r.lethal) {
        survivors.push({ file: `${zone} @ ${hour}`, line: 0, id: 'time-dependent', failed: r.failed })
      }
      progress('fuzz', considered, total)
    }
  }
  return { considered, killed: considered - survivors.length, survivors }
}

/* ---------------------------------------------------------------- *
 * MODE: lint — absence assertions with no positive control
 * ---------------------------------------------------------------- */

/**
 * "Stays silent" is indistinguishable from "the fixture never loaded".
 * Every assertion that something is empty needs a paired assertion in the
 * same test proving there was something to be empty about.
 */
const ABSENCE = /expect\(([^;]*?)\)\s*\.(?:toEqual\(\[\]\)|toBeNull\(\)|toHaveLength\(0\))/g
/* `toBeCloseTo` counts only when the expected value is NOT zero:
   toBeCloseTo(0.05) proves the fixture produced something, while
   toBeCloseTo(0) is another way of asserting absence. */
/* A NON-ZERO expected value is a positive control: toBe(1) on a count and
   toBeCloseTo(0.05) on a gap both prove the fixture produced something.
   Zero is excluded from both, since toBe(0) is another way of asserting
   absence — which is the thing being looked for, not a control for it. */
/* `toBe('e1rm')` is the same claim as `toBe(true)` or `toBe(3)`: a
   specific, definite result came back. It was missing, so a test pairing
   "this is not a record" with "and THIS one is" read as uncontrolled —
   and the lint then pushed the control toward toMatch, which is a weaker
   assertion than the one it replaced. Empty stays excluded: '' is
   absence wearing a string. */
const CONTROL = /toBeGreaterThan|toBeTruthy|not\.toBeNull|toBe\(true\)|toContain|toMatch|not\.toEqual|toBeDefined|toBeCloseTo\((?!0[,)\s])|toBe\([1-9]|toBe\(['"][^'"]+['"]\)|toHaveLength\([1-9]/

/**
 * Only absence assertions made against a BUILT FIXTURE.
 *
 * `expect(epley1RM(NaN)).toBeNull()` needs no control: the input is
 * inline and visibly present. The dangerous shape is
 * `expect(weeklyChange(ctx)).toBeNull()`, where `ctx` is assembled by a
 * helper — because a helper that silently produced nothing gives exactly
 * the same green. Flagging both makes the lint unactionable, and a lint
 * nobody acts on is the same failure as a guard nobody can falsify.
 */
function localNames(body) {
  const names = new Set()
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/g
  let m
  while ((m = re.exec(body)) !== null) names.add(m[1])
  return names
}

function modeLint(opts) {
  const findings = []
  for (const file of testFiles()) {
    if (opts.files.length && !opts.files.some((n) => file.includes(n))) continue
    const text = readFileSync(file, 'utf8')
    for (const block of splitTests(text)) {
      if (CONTROL.test(block.body)) continue
      /* The subject has to be something THIS TEST BUILT. An absence
         assertion on a literal input — `frequencyGaps({}, INDEX, NOW)`
         is empty-in, empty-out — is self-evidently exercised, and
         flagging it buries the real ones. The dangerous shape is a
         fixture assembled in the test body and then asserted to have
         produced nothing, because a fixture that silently assembled
         nothing gives the identical green. */
      const locals = localNames(block.body)
      if (!locals.size) continue
      ABSENCE.lastIndex = 0
      let m
      while ((m = ABSENCE.exec(block.body)) !== null) {
        const subject = m[1]
        const built = [...locals].some((n) => new RegExp(`\\b${n}\\b`).test(subject))
        if (!built) continue
        findings.push({ file, line: block.line, id: 'absence-without-control', name: block.name })
        break
      }
    }
  }
  return { considered: findings.length, killed: 0, survivors: findings, lintOnly: true }
}

/** Each `it(...)` body, with its line number. */
function splitTests(text) {
  const out = []
  const re = /\bit(?:\.each\([^)]*\))?\(\s*(['"`])([\s\S]*?)\1\s*,/g
  let match
  while ((match = re.exec(text)) !== null) {
    const start = match.index
    const next = re.lastIndex
    const after = text.indexOf('\n  })', next)
    out.push({
      name: match[2].slice(0, 70),
      line: text.slice(0, start).split('\n').length,
      body: text.slice(next, after === -1 ? next + 2000 : after),
    })
  }
  return out
}

/* ---------------------------------------------------------------- */

function harnessFailure(reason) {
  return { harnessBroken: reason }
}

function report(title, result, asJson) {
  if (result.harnessBroken) {
    console.error(`\nHARNESS BROKEN — ${result.harnessBroken}`)
    console.error('  No conclusion can be drawn. The tool failed, which is')
    console.error('  not the same as nothing surviving.\n')
    process.exit(2)
  }
  if (asJson) {
    console.log(JSON.stringify({ title, ...result }, null, 2))
    return result.survivors.length
  }

  const { considered, killed, survivors } = result
  console.log(`\n${title}`)
  if (!result.lintOnly) {
    const score = considered ? Math.round((killed / considered) * 100) : 0
    console.log(`  ${killed}/${considered} caught  (${score}%)`)
  }
  if (!survivors.length) {
    console.log('  no survivors\n')
    return 0
  }
  console.log(`  ${survivors.length} SURVIVED — nothing failed when these changed:\n`)
  const byFile = new Map()
  for (const s of survivors) {
    if (!byFile.has(s.file)) byFile.set(s.file, [])
    byFile.get(s.file).push(s)
  }
  for (const [file, list] of [...byFile].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`    ${file}  (${list.length})`)
    for (const s of list.slice(0, 8)) {
      const what = s.name ? ` ${s.name}` : s.before ? ` ${JSON.stringify(s.before)} → ${JSON.stringify(s.after)}` : ''
      console.log(`      line ${String(s.line).padStart(4)}  ${s.id}${what}`)
    }
    if (list.length > 8) console.log(`      … and ${list.length - 8} more`)
  }
  console.log('')
  return survivors.length
}

/**
 * The ratchet.
 *
 * On its first run this tool found 69 lint findings and 4 unguarded call
 * sites. A gate that is red on day one gets switched off within a week,
 * and then it protects nothing — so the baseline records what was already
 * there and the gate fails only when a number gets WORSE.
 *
 * The counts are meant to fall. Lowering one is the point; raising one
 * has to be deliberate and visible in a diff, which is exactly the
 * property that was missing when a guard could be added that asserted
 * nothing.
 */
const BASELINE_FILE = '.mutation-baseline.json'

function readBaseline() {
  try {
    return JSON.parse(readFileSync(BASELINE_FILE, 'utf8'))
  } catch {
    return {}
  }
}

/**
 * Is this run's count comparable to the baseline at all?
 *
 * The baseline is a whole-engine number. A sampled run (`--limit`) or a
 * subset of modules (`--files`) produces a number measuring something
 * else, and comparing the two is arithmetic dressed as a gate:
 * `verify:full` ran `--limit=6` — about 264 of 1527 mutations — against a
 * full-sweep baseline, so it could never exceed it and never fired.
 * Blessing from one is worse: a `--bless --files=liftweeks` wrote
 * `mutate: 1` over a baseline of 492, from nine mutations.
 */
export function partialRun(opts) {
  return Boolean(opts.limit || (opts.files && opts.files.length))
}

function checkRatchet(mode, count, opts = {}) {
  const baseline = readBaseline()
  const allowed = baseline[mode]
  /**
   * `null` is DELIBERATELY UNPINNED, and it is not the same as absent.
   *
   * An absent key means nobody has measured this mode yet, which must
   * not pass silently — that is the "no baseline" case below. `null`
   * means somebody measured it, decided the number was not worth
   * gating against, and said so. By default the run reports its count
   * and stays green — that default is what pre-commit's `--mode=lint`
   * and any ad-hoc exploratory run rely on.
   *
   * `--require-pinned` removes that leniency. It exists because printing
   * "not gating" and still exiting 0 reads as a pass to anything that
   * only checks the exit code — which is every automated caller. A
   * comprehensive run (verify:full) that tolerates an unpinned mode
   * isn't comprehensive, so it opts into the stricter read instead of
   * getting it by default everywhere.
   */
  if (allowed === null) {
    if (opts.requirePinned) {
      console.error(`  REGRESSION: ${mode} is unpinned (null) — a comprehensive run requires every mode it checks to be pinned`)
      return 1
    }
    console.log(`  ${mode}: ${count} survivor(s) — unpinned, not gating`)
    return 0
  }
  if (typeof allowed !== 'number') {
    console.log(`  no baseline for ${mode}; run with --bless to record ${count}`)
    return count > 0 ? 1 : 0
  }
  if (count > allowed) {
    console.error(`  REGRESSION: ${count} survivors, baseline allows ${allowed}`)
    return 1
  }
  if (count < allowed) {
    console.log(`  improved: ${count} against a baseline of ${allowed} — lower it with --bless`)
  }
  return 0
}

function main() {
  recoverInterruptedRun()
  const args = process.argv.slice(2)
  const opts = {
    mode: (args.find((a) => a.startsWith('--mode=')) || '--mode=all').split('=')[1],
    files: (args.find((a) => a.startsWith('--files=')) || '--files=').split('=')[1].split(',').filter(Boolean),
    limit: Number((args.find((a) => a.startsWith('--limit=')) || '--limit=0').split('=')[1]) || 0,
    json: args.includes('--json'),
    requirePinned: args.includes('--require-pinned'),
  }

  const bless = args.includes('--bless')
  const partial = partialRun(opts)
  if (bless && partial) {
    console.error('refusing to record a baseline from a partial run.')
    console.error('--limit and --files measure part of the engine; the baseline is the whole of it.')
    process.exit(2)
  }
  const modes = opts.mode === 'all' ? ['lint', 'callsites', 'fuzz', 'mutate'] : [opts.mode]
  const counts = {}
  let failed = 0
  for (const mode of modes) {
    const runner = { mutate: modeMutate, callsites: modeCallsites, fuzz: modeFuzz, lint: modeLint }[mode]
    if (!runner) {
      console.error(`unknown mode: ${mode}`)
      process.exit(2)
    }
    counts[mode] = report(mode.toUpperCase(), runner(opts), opts.json)
    if (bless) continue
    if (partial) console.log(`  partial run — not scored against the baseline`)
    else failed += checkRatchet(mode, counts[mode], opts)
  }
  if (bless) {
    writeFileSync(BASELINE_FILE, JSON.stringify({ ...readBaseline(), ...counts }, null, 2) + '\n')
    console.log(`baseline written: ${JSON.stringify(counts)}`)
    process.exit(0)
  }
  process.exit(failed ? 1 : 0)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()

export { OPERATORS, mutationsFor, splitTests, inCommentAt, evenlySampled, ABSENCE, CONTROL, verdictFrom }
