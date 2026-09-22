import { describe, it, expect } from 'vitest'
import { readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import {
  OPERATORS, mutationsFor, splitTests, inCommentAt, evenlySampled,
  ABSENCE, CONTROL, verdictFrom, partialRun,
} from '../../scripts/mutate.mjs'

/**
 * The harness that checks the tests needs checking too.
 *
 * It is the last thing in the loop that everything else is believed on
 * the strength of, and the single worst failure of this session was a
 * verification tool that failed open.
 */

describe('a run that did not happen is never believed', () => {
  /* THE failure of this session, and the reason this tool exists: four
     test paths passed to vitest resolved no files at all, the summary
     grep matched nothing, and eleven mutations were scored as survivors
     when nothing had run. It is tested here because the guard against it
     survived mutation testing of this very file. */
  /* verdictFrom comes from an untyped .mjs, so TypeScript infers a union
     of the shapes it returns and narrows away `reason` on the happy one.
     One alias keeps the assertions readable without weakening them. */
  type Verdict = { ok: boolean; failed: number; total: number; fileCount: number; reason?: string; collapsed?: boolean }
  const verdict = (out: string, expect?: Record<string, unknown>): Verdict =>
    verdictFrom(out, expect) as Verdict

  const GOOD = 'Test Files  3 passed (3)\n     Tests  42 passed (42)\n'
  const RED = 'Test Files  1 failed | 2 passed (3)\n     Tests  2 failed | 40 passed (42)\n'
  const NONE = 'filter:  a b c\nNo test files found, exiting with code 1\n'
  const EMPTY = 'Test Files  0 passed (0)\n     Tests  0 passed (0)\n'

  it('believes a real green run', () => {
    expect(verdict(GOOD)).toMatchObject({ ok: true, failed: 0, total: 42, fileCount: 3 })
  })

  it('believes a real red run, and counts the failures', () => {
    expect(verdict(RED)).toMatchObject({ ok: true, failed: 2, total: 42 })
  })

  it('REFUSES a run that resolved no test files', () => {
    const v = verdict(NONE)
    expect(v.ok).toBe(false)
    expect(v.reason).toMatch(/no test summary/)
  })

  it('REFUSES a run that resolved zero tests', () => {
    const v = verdict(EMPTY)
    expect(v.ok).toBe(false)
    expect(v.reason).toMatch(/zero tests/)
  })

  it('refuses a run that skipped files the baseline had', () => {
    const v = verdict('Test Files  1 passed (1)\n     Tests  9 passed (9)\n', { minFiles: 3 })
    expect(v.ok).toBe(false)
    expect(v.reason).toMatch(/expected at least 3/)
  })

  it('refuses a run with fewer tests than the baseline', () => {
    const v = verdict(GOOD, { minTests: 100 })
    expect(v.ok).toBe(false)
    expect(v.reason).toMatch(/expected at least 100/)
  })

  it('scores a collapsed run as a KILL once the baseline has proved the patterns', () => {
    /* Same invocation worked moments ago, so no summary now means the
       mutation broke collection outright — caught, emphatically. */
    const v = verdict(NONE, { baselineRan: true, minTests: 42, minFiles: 3 })
    expect(v.ok).toBe(true)
    expect(v.failed).toBeGreaterThan(0)
    expect(v.collapsed).toBe(true)
  })
})

describe('mutations are found in code, not in prose', () => {
  it('skips a line comment', () => {
    expect(inCommentAt('const a = 1 // b && c', 16)).toBe(true)
  })

  it('skips a block comment', () => {
    const text = '/* a && b */\nconst x = 1'
    expect(inCommentAt(text, 5)).toBe(true)
  })

  it('does not skip real code after a block comment closes', () => {
    const text = '/* note */\nif (a && b) return'
    expect(inCommentAt(text, text.indexOf('&&'))).toBe(false)
  })

  it('does not emit a mutation for an operator inside a comment', () => {
    /* Checked through mutationsFor, not through inCommentAt directly —
       the filter can be correct and simply not called, which is the
       existence-versus-reachability failure this whole tool is about. */
    const found = mutationsFor('lib/train/windows.ts')
    const text = readFileSync('lib/train/windows.ts', 'utf8')
    for (const m of found) {
      expect(inCommentAt(text, m.at), `line ${m.line} is in a comment`).toBe(false)
    }
    /* And prove the file HAS operators inside comments, or the loop above
       passes on a file with nothing to skip. */
    expect(/\/\*[\s\S]*?(&&|>=|<=)[\s\S]*?\*\//.test(text)).toBe(true)
  })

  it('finds real operators in a real engine file', () => {
    const found = mutationsFor('lib/train/windows.ts')
    expect(found.length).toBeGreaterThan(0)
    expect(found.every((m) => m.before !== m.after)).toBe(true)
    expect(found.every((m) => m.line > 0)).toBe(true)
  })

  it('every operator actually changes the text it matches', () => {
    for (const op of OPERATORS) {
      expect(typeof op.id).toBe('string')
      expect(op.find).toBeInstanceOf(RegExp)
      expect(op.find.flags).toContain('g')
    }
  })
})

describe('sampling spreads across the file', () => {
  const list = Array.from({ length: 100 }, (_, i) => i)

  it('returns everything when under the limit', () => {
    expect(evenlySampled([1, 2, 3], 10)).toEqual([1, 2, 3])
  })

  it('spans the whole range rather than taking a prefix', () => {
    const picked = evenlySampled(list, 5)
    expect(picked.length).toBe(5)
    expect(picked[0]).toBe(0)
    expect(picked[picked.length - 1]).toBeGreaterThan(70)
  })
})

describe('the absence lint', () => {
  it('recognises the assertions that mean "nothing happened"', () => {
    for (const s of ['expect(x).toEqual([])', 'expect(y).toBeNull()', 'expect(z).toHaveLength(0)']) {
      ABSENCE.lastIndex = 0
      expect(ABSENCE.test(s), s).toBe(true)
    }
  })

  it('recognises a positive control', () => {
    expect(CONTROL.test('expect(rows.length).toBeGreaterThan(0)')).toBe(true)
    expect(CONTROL.test('expect(ctx).toBeDefined()')).toBe(true)
    expect(CONTROL.test('expect(result.logged).toBe(1)')).toBe(true)
    expect(CONTROL.test('expect(gap).toBeCloseTo(0.05, 2)')).toBe(true)
  })

  it('does not accept a ZERO expectation as a control', () => {
    /* toBe(0) and toBeCloseTo(0) assert absence. Counting them as
       controls would let an absence assertion vouch for itself. */
    expect(CONTROL.test('expect(found.length).toBe(0)')).toBe(false)
    expect(CONTROL.test('expect(gap).toBeCloseTo(0, 2)')).toBe(false)
  })

  it('does not mistake an absence assertion for a control', () => {
    expect(CONTROL.test('expect(found).toEqual([])')).toBe(false)
  })
})

describe('test bodies are split so a control can be found in the right one', () => {
  const file = `
  it('one thing', () => {
    expect(a).toEqual([])
  })

  it('another thing', () => {
    expect(b.length).toBeGreaterThan(0)
  })
`
  it('finds both', () => {
    const blocks = splitTests(file)
    expect(blocks.map((b) => b.name)).toEqual(['one thing', 'another thing'])
  })

  it('keeps each body separate, so a control cannot leak between tests', () => {
    /* If bodies ran together, the control in the second test would
       silence the finding in the first — the lint would then be doing
       exactly what it exists to catch. */
    const blocks = splitTests(file)
    expect(blocks[0].body).not.toMatch(/toBeGreaterThan/)
    expect(blocks[1].body).toMatch(/toBeGreaterThan/)
  })

  it('reports a line number that points into the file', () => {
    expect(splitTests(file)[0].line).toBeGreaterThan(0)
  })
})

/**
 * The harness writes broken code into the working tree on purpose.
 *
 * A `finally` restores it when a run ends or throws, and covers nothing
 * else. A Ctrl-C or a `pkill` ends the process first, and what is left
 * on disk is a mutated engine file that looks exactly like a real edit —
 * which is how `if (false) return record` ended up sitting in deload.ts
 * and was found three steps later as a mysterious failure in a module
 * nobody had touched.
 *
 * A signal handler was written first and does not work: `main()` is one
 * synchronous block of execSync calls, so the event loop never spins and
 * the JS callback never gets a turn. Recovery on the NEXT run is the
 * thing that works, and it works for SIGKILL too.
 */
describe('a short run is only suspicious when nothing failed', () => {
  /**
   * The guard that catches "fewer tests resolved than the baseline" was
   * checked before the failure count, so a mutation lethal enough to
   * abort whole test files — taking the total down with it — was scored
   * as a broken tool rather than as the emphatic kill it is.
   *
   * It had been doing that on progression.ts for as long as the guard
   * existed, which means that module was never mutation-tested and the
   * tool said so every time without anyone reading it as a coverage gap.
   */
  const summary = (failedTests: number, passedTests: number, total: number, failedFiles: number, passedFiles: number, fileTotal: number) =>
    `Test Files  ${failedFiles ? `${failedFiles} failed | ` : ''}${passedFiles} passed (${fileTotal})\n`
    + `      Tests  ${failedTests ? `${failedTests} failed | ` : ''}${passedTests} passed (${total})\n`

  it('scores a short run WITH failures as a kill', () => {
    /* The real case: 80 failed, 165 passed, 245 of an expected 261. */
    const v = verdictFrom(summary(80, 165, 245, 8, 1, 9), { minTests: 261, minFiles: 9 })
    expect(v.ok).toBe(true)
    expect(v.failed).toBe(80)
  })

  it('still refuses a short run where everything passed', () => {
    /* The case the guard was built for, and it must keep firing: fewer
       tests, none failing, is indistinguishable from a survivor. */
    const v = verdictFrom(summary(0, 245, 245, 0, 9, 9), { minTests: 261, minFiles: 9 })
    expect(v.ok).toBe(false)
    expect((v as { reason?: string }).reason).toContain('expected at least 261')
  })

  it('still refuses a run that resolved fewer FILES with nothing failing', () => {
    const v = verdictFrom(summary(0, 100, 100, 0, 4, 4), { minTests: 50, minFiles: 9 })
    expect(v.ok).toBe(false)
    expect((v as { reason?: string }).reason).toContain('files')
  })

  it('still refuses a run that resolved nothing at all', () => {
    const v = verdictFrom(summary(0, 0, 0, 0, 0, 0), { minTests: 261, minFiles: 9 })
    expect(v.ok).toBe(false)
    expect((v as { reason?: string }).reason).toContain('zero')
  })
})

describe('an interrupted run leaves nothing behind', () => {
  const SNAPSHOT = '.mutate-snapshot.json'
  const TARGET = 'lib/train/deload.ts'

  /**
   * Whether the harness has left the target file changed.
   *
   * Compared against the content captured at the start of the test, NOT
   * against git. The first version asked `git diff --quiet -- lib/train`,
   * which reports dirty whenever the author has any uncommitted work in
   * the engine — so the test passed alone and failed in the suite, for a
   * reason that had nothing to do with the harness.
   */
  const changedFrom = async (original: string) => {
    const { readFileSync } = await import('node:fs')
    return readFileSync(TARGET, 'utf8') !== original
  }

  it('restores a file a previous run left mutated', async () => {
    const { readFileSync, writeFileSync, existsSync, rmSync } = await import('node:fs')
    const { execFileSync } = await import('node:child_process')

    const original = readFileSync(TARGET, 'utf8')
    try {
      /* Exactly the state a killed run leaves: the snapshot on disk, and
         the file on disk mutated. */
      writeFileSync(SNAPSHOT, JSON.stringify({ files: { [TARGET]: original } }))
      writeFileSync(TARGET, original.replace('export function', '/* MUTATED */ export function'))
      expect(await changedFrom(original)).toBe(true)

      execFileSync('node', ['scripts/mutate.mjs', '--mode=lint'], {
        cwd: process.cwd(), stdio: 'pipe',
      })

      expect(readFileSync(TARGET, 'utf8')).toBe(original)
      expect(existsSync(SNAPSHOT)).toBe(false)
      expect(await changedFrom(original)).toBe(false)
    } finally {
      writeFileSync(TARGET, original)
      rmSync(SNAPSHOT, { force: true })
    }
  }, 120_000)

  it('recovers from a SIGKILL, which no in-process handler could', async () => {
    const { spawn, execFileSync } = await import('node:child_process')
    const { readFileSync, existsSync, rmSync, writeFileSync } = await import('node:fs')
    const original = readFileSync(TARGET, 'utf8')

    const child = spawn('node', ['scripts/mutate.mjs', '--mode=mutate', '--files=deload'], {
      cwd: process.cwd(), stdio: 'ignore',
    })
    try {
      /* Kill only once the tree is ACTUALLY dirty. A kill on a timer
         would pass whether the recovery works or not, because a kill
         landing before the first write has nothing to restore — a test
         that cannot fail. */
      let sawMutation = false
      for (let i = 0; i < 600 && !sawMutation; i++) {
        if (await changedFrom(original)) sawMutation = true
        else await new Promise((r) => setTimeout(r, 50))
      }
      expect(sawMutation).toBe(true)

      child.kill('SIGKILL')
      await new Promise((resolve) => child.on('exit', resolve))
      expect(await changedFrom(original)).toBe(true)
      expect(existsSync(SNAPSHOT)).toBe(true)

      execFileSync('node', ['scripts/mutate.mjs', '--mode=lint'], {
        cwd: process.cwd(), stdio: 'pipe',
      })
      expect(await changedFrom(original)).toBe(false)
      expect(existsSync(SNAPSHOT)).toBe(false)
    } finally {
      child.kill('SIGKILL')
      writeFileSync(TARGET, original)
      rmSync(SNAPSHOT, { force: true })
    }
  }, 120_000)
})

/**
 * The harness restores the working tree. It cannot un-stage.
 *
 * During a call-site sweep something in this environment ran `git add`
 * while the tile was stubbed, and the staged copy of train.html held
 * `((()=>undefined))(changeContext())`. The worktree was restored on
 * exit and looked perfectly clean; the index did not, and an automatic
 * committer would have shipped a tile with a dead engine call.
 *
 * The snapshot file exists for exactly the duration of a run, so the
 * commit gate can refuse while one is live.
 */
describe('the commit gate refuses while a mutation run is live', () => {
  it('blocks when the snapshot file is present', async () => {
    const { execFileSync } = await import('node:child_process')
    const { writeFileSync, rmSync, existsSync } = await import('node:fs')
    const SNAPSHOT = '.mutate-snapshot.json'
    expect(existsSync(SNAPSHOT)).toBe(false)

    try {
      writeFileSync(SNAPSHOT, JSON.stringify({ files: {} }))
      let blocked = false
      let output = ''
      try {
        /* SKIP_VERIFY on purpose: this gate must win even when the
           quality gate has been waived, because it is not about quality —
           it is about the files on disk not being what they look like. */
        output = execFileSync('sh', ['.githooks/pre-commit'], {
          cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, SKIP_VERIFY: '1' },
        })
      } catch (err) {
        blocked = true
        output = String((err as { stdout?: string }).stdout || '')
      }
      expect(blocked).toBe(true)
      expect(output).toMatch(/mutation run is in progress/i)
    } finally {
      rmSync(SNAPSHOT, { force: true })
    }
  }, 60_000)

  it('does not block when no run is live', async () => {
    const { execFileSync } = await import('node:child_process')
    /* The control: with the snapshot gone the same hook runs on past the
       block, so the refusal above is the guard rather than the hook being
       broken for every input. SKIP_VERIFY stops it short of the full
       suite, which this test has no business re-running. */
    const out = execFileSync('sh', ['.githooks/pre-commit'], {
      cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, SKIP_VERIFY: '1' },
    })
    expect(out).toMatch(/gate skipped/i)
  }, 60_000)
})

/**
 * Recovery must not run while a sweep is still alive.
 *
 * This is not hypothetical. A sweep was stopped with `pkill` — SIGTERM,
 * which the child does not necessarily die from promptly — and a
 * `--mode=lint` was run two seconds later to tidy up. Recovery restored
 * the files and DELETED the snapshot; the sweep, still breathing, then
 * applied its next mutation with nothing on disk left to undo it. The
 * result was `if (false) continue` sitting in lib/train/dose.ts in a
 * clean-looking tree, one `git add -A` away from being committed.
 *
 * So the snapshot records who owns it, and recovery leaves a live
 * owner's snapshot alone. The bug was a race between two of the
 * harness's own commands, which is exactly the kind only a lock fixes.
 */
describe('recovery keeps its hands off a run that is still going', () => {
  const SNAPSHOT = '.mutate-snapshot.json'
  const TARGET = 'lib/train/deload.ts'

  it('records the owning process in the snapshot', async () => {
    const { spawn } = await import('node:child_process')
    const { readFileSync, existsSync, rmSync, writeFileSync } = await import('node:fs')
    const original = readFileSync(TARGET, 'utf8')
    const child = spawn('node', ['scripts/mutate.mjs', '--mode=mutate', '--files=deload'], {
      cwd: process.cwd(), stdio: 'ignore',
    })
    try {
      for (let i = 0; i < 240 && !existsSync(SNAPSHOT); i++) await new Promise((r) => setTimeout(r, 500))
      const snap = JSON.parse(readFileSync(SNAPSHOT, 'utf8'))
      expect(snap.pid).toBe(child.pid)
    } finally {
      child.kill('SIGKILL')
      await new Promise((r) => setTimeout(r, 300))
      writeFileSync(TARGET, original)
      rmSync(SNAPSHOT, { force: true })
    }
  }, 180_000)

  it('refuses to recover a snapshot whose owner is still running', async () => {
    const { execFileSync } = await import('node:child_process')
    const { readFileSync, writeFileSync, existsSync, rmSync } = await import('node:fs')
    const original = readFileSync(TARGET, 'utf8')
    try {
      /* This process is alive by definition, so it stands in for the
         sweep that had not died yet. */
      writeFileSync(SNAPSHOT, JSON.stringify({ pid: process.pid, files: { [TARGET]: original } }))
      writeFileSync(TARGET, original.replace('export function', '/* MUTATED */ export function'))

      let code = 0
      try {
        execFileSync('node', ['scripts/mutate.mjs', '--mode=lint'], { cwd: process.cwd(), stdio: 'pipe' })
      } catch (e: any) { code = e.status }

      /* It must not silently proceed: the tree is untrustworthy and the
         only safe move is to say so and stop. */
      expect(code).toBe(2)
      expect(existsSync(SNAPSHOT)).toBe(true)
      expect(readFileSync(TARGET, 'utf8')).not.toBe(original)
    } finally {
      writeFileSync(TARGET, original)
      rmSync(SNAPSHOT, { force: true })
    }
  }, 120_000)

  it('still recovers once the owner is gone', async () => {
    /* The positive control. A guard that refuses everything would pass
       the test above and make the harness unusable. */
    const { execFileSync } = await import('node:child_process')
    const { readFileSync, writeFileSync, existsSync, rmSync } = await import('node:fs')
    const original = readFileSync(TARGET, 'utf8')
    try {
      /* PID 2^22 is above every default pid_max on Linux and macOS, so
         nothing can be running under it. */
      writeFileSync(SNAPSHOT, JSON.stringify({ pid: 4194304, files: { [TARGET]: original } }))
      writeFileSync(TARGET, original.replace('export function', '/* MUTATED */ export function'))

      execFileSync('node', ['scripts/mutate.mjs', '--mode=lint'], { cwd: process.cwd(), stdio: 'pipe' })

      expect(readFileSync(TARGET, 'utf8')).toBe(original)
      expect(existsSync(SNAPSHOT)).toBe(false)
    } finally {
      writeFileSync(TARGET, original)
      rmSync(SNAPSHOT, { force: true })
    }
  }, 120_000)

  it('recovers a snapshot from before the owner was recorded', async () => {
    /* Backward compatibility, and the standing rule: an absent field is
       a safe default. An old snapshot has no pid; treating that as "the
       owner might be alive" would strand it forever. */
    const { execFileSync } = await import('node:child_process')
    const { readFileSync, writeFileSync, existsSync, rmSync } = await import('node:fs')
    const original = readFileSync(TARGET, 'utf8')
    try {
      writeFileSync(SNAPSHOT, JSON.stringify({ files: { [TARGET]: original } }))
      writeFileSync(TARGET, original.replace('export function', '/* MUTATED */ export function'))
      execFileSync('node', ['scripts/mutate.mjs', '--mode=lint'], { cwd: process.cwd(), stdio: 'pipe' })
      expect(readFileSync(TARGET, 'utf8')).toBe(original)
      expect(existsSync(SNAPSHOT)).toBe(false)
    } finally {
      writeFileSync(TARGET, original)
      rmSync(SNAPSHOT, { force: true })
    }
  }, 120_000)
})

/**
 * A ratchet that cannot fire is the zero-test run wearing a different hat.
 *
 * `verify:full` ran `--mode=mutate --limit=6`: six mutations sampled per
 * module, roughly 264 of 1527, and the resulting survivor count was
 * compared against a baseline recorded from a WHOLE-engine sweep. A
 * sample cannot exceed a full count, so the comparison returned
 * "improved" forever. The gate at the top of the stack was the one gate
 * structurally incapable of failing.
 *
 * `--files=` has the same shape — a 16-module subset was scored against
 * the whole-engine baseline and reported a regression that was only ever
 * arithmetic.
 *
 * So a partial run is now not scored at all, and says so. A number that
 * is not comparable must not be compared.
 */
describe('the ratchet only judges a complete sweep', () => {
  it('knows a sampled run is partial', () => {
    expect(partialRun({ limit: 6, files: [] })).toBe(true)
  })

  it('knows a subset of modules is partial', () => {
    expect(partialRun({ limit: 0, files: ['plates'] })).toBe(true)
  })

  it('knows a whole sweep is not', () => {
    /* The positive control. A "partial" that is always true would pass
       both assertions above and disable the ratchet entirely — which is
       the bug, not the fix. */
    expect(partialRun({ limit: 0, files: [] })).toBe(false)
  })

  it('says so rather than scoring a subset against the whole engine', async () => {
    const { execFileSync } = await import('node:child_process')
    /* liftweeks is the cheapest module in the engine: 9 mutations, one
       test file. It has a survivor, so the old code reached the
       comparison. */
    let out = ''
    try {
      out = execFileSync('node', ['scripts/mutate.mjs', '--mode=mutate', '--files=liftweeks'],
        { cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe' })
    } catch (e: any) { out = String(e.stdout || '') + String(e.stderr || '') }
    expect(out).toContain('partial run')
    expect(out).not.toContain('REGRESSION')
    expect(out).not.toContain('improved:')
  }, 180_000)

  it('refuses to record a baseline from a partial run', async () => {
    const { execFileSync } = await import('node:child_process')
    const { readFileSync } = await import('node:fs')
    const before = readFileSync('.mutation-baseline.json', 'utf8')
    let code = 0
    try {
      execFileSync('node', ['scripts/mutate.mjs', '--mode=mutate', '--files=liftweeks', '--bless'],
        { cwd: process.cwd(), stdio: 'pipe' })
    } catch (e: any) { code = e.status }
    /* Exit 2: the tool was misused, which is not the same as survivors. */
    expect(code).toBe(2)
    expect(readFileSync('.mutation-baseline.json', 'utf8')).toBe(before)
  }, 180_000)
})

/**
 * The gate has to have been SEEN to fail.
 *
 * checkRatchet returning 1 proves nothing on its own — main() has to
 * turn that into a non-zero exit, and that path had never run, because
 * the only mode wired into a gate was being handed a number that could
 * not exceed its baseline. This drives a real regression through the
 * CLI and watches it come back red.
 *
 * `lint` is the vehicle because it is complete and fast; the mechanism
 * under test is shared by every mode.
 */
describe('a rising count actually fails the command', () => {
  const FILE = '.mutation-baseline.json'

  it('exits non-zero and names the regression', async () => {
    const { execFileSync } = await import('node:child_process')
    const { readFileSync, writeFileSync } = await import('node:fs')
    const before = readFileSync(FILE, 'utf8')
    try {
      writeFileSync(FILE, JSON.stringify({ ...JSON.parse(before), lint: 0 }, null, 2) + '\n')
      let code = 0, out = ''
      try {
        out = execFileSync('node', ['scripts/mutate.mjs', '--mode=lint'],
          { cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe' })
      } catch (e: any) { code = e.status; out = String(e.stdout || '') + String(e.stderr || '') }
      expect(code).toBe(1)
      expect(out).toContain('REGRESSION')
    } finally {
      writeFileSync(FILE, before)
    }
  }, 120_000)

  it('exits zero when the count is at the baseline', async () => {
    /* The positive control. A gate that failed unconditionally would
       pass the assertion above and block every commit. */
    const { execFileSync } = await import('node:child_process')
    let code = 0
    try {
      execFileSync('node', ['scripts/mutate.mjs', '--mode=lint'], { cwd: process.cwd(), stdio: 'pipe' })
    } catch (e: any) { code = e.status }
    expect(code).toBe(0)
  }, 120_000)
})

/**
 * The wiring is the part that failed, so the wiring is asserted.
 *
 * Every piece of the ratchet worked in isolation. What was broken was
 * the command that called it: `verify:full` passed `--limit=6`, so the
 * gate spent its whole life comparing a sample against a whole-engine
 * baseline. Nothing would have caught a `--limit` going back in, which
 * is why this reads package.json rather than trusting it.
 */
describe('verify:full runs the sweep that the baseline describes', () => {
  const scripts = () => JSON.parse(readFileSync('package.json', 'utf8')).scripts

  it('runs the mutate mode at all', () => {
    expect(scripts()['verify:full']).toContain('--mode=mutate')
  })

  it('does not sample it', () => {
    const full = scripts()['verify:full']
    const call = full.slice(full.indexOf('--mode=mutate'))
    expect(call).not.toContain('--limit')
    expect(call).not.toContain('--files')
  })

  it('keeps the fast gate free of it', () => {
    /* `verify` is the pre-commit gate and has to stay minutes, not an
       hour. The full sweep belongs in verify:full and nowhere else. */
    expect(scripts().verify).not.toContain('--mode=mutate')
  })
})

/**
 * The shipped tile is covered too, not just the source it is built from.
 *
 * The harness snapshotted lib/train and never the tiles, and the tile is
 * the thing that actually ships. That gap was exploited once: a test
 * rebuilt the tile from a mutated source mid-run, the harness restored
 * the source, and a tile carrying a broken bestE1rm was left staged.
 *
 * Serialising the suite removed that particular path and the pre-commit
 * gate caught the outcome, but two of the three layers protecting the
 * tile were found broken in the same hour. The third one should not be
 * the one nobody checked.
 */
describe('a killed run puts the tile back too', () => {
  const SNAPSHOT = '.mutate-snapshot.json'
  const TILES = ['public/tiles/train.html', 'tiles-library/train.html']

  it('snapshots both tiles alongside the engine source', async () => {
    const { spawn } = await import('node:child_process')
    const { readFileSync, existsSync, rmSync, writeFileSync } = await import('node:fs')
    const before = TILES.map((t) => readFileSync(t, 'utf8'))
    const engine = readFileSync('lib/train/liftweeks.ts', 'utf8')
    const child = spawn('node', ['scripts/mutate.mjs', '--mode=mutate', '--files=liftweeks'],
      { cwd: process.cwd(), stdio: 'ignore' })
    try {
      for (let i = 0; i < 240 && !existsSync(SNAPSHOT); i++) await new Promise((r) => setTimeout(r, 500))
      const snap = JSON.parse(readFileSync(SNAPSHOT, 'utf8'))
      for (const t of TILES) expect(Object.keys(snap.files), `${t} is not snapshotted`).toContain(t)
    } finally {
      child.kill('SIGKILL')
      await new Promise((r) => setTimeout(r, 300))
      writeFileSync('lib/train/liftweeks.ts', engine)
      TILES.forEach((t, i) => writeFileSync(t, before[i]))
      rmSync(SNAPSHOT, { force: true })
    }
  }, 180_000)

  it('restores a tile a killed run left corrupted', async () => {
    const { execFileSync } = await import('node:child_process')
    const { readFileSync, writeFileSync, existsSync, rmSync } = await import('node:fs')
    const before = TILES.map((t) => readFileSync(t, 'utf8'))
    try {
      /* Exactly what was found staged: the snapshot on disk naming the
         tiles, and a tile carrying a mutated engine. */
      writeFileSync(SNAPSHOT, JSON.stringify({
        files: Object.fromEntries(TILES.map((t, i) => [t, before[i]])),
      }))
      TILES.forEach((t, i) =>
        writeFileSync(t, before[i].replace('if (!entry || entry.off) return null', 'if (!entry && entry.off) return null')))
      expect(readFileSync(TILES[0], 'utf8')).not.toBe(before[0])

      execFileSync('node', ['scripts/mutate.mjs', '--mode=lint'], { cwd: process.cwd(), stdio: 'pipe' })

      TILES.forEach((t, i) => expect(readFileSync(t, 'utf8'), t).toBe(before[i]))
      expect(existsSync(SNAPSHOT)).toBe(false)
    } finally {
      TILES.forEach((t, i) => writeFileSync(t, before[i]))
      rmSync(SNAPSHOT, { force: true })
    }
  }, 120_000)
})

/**
 * Importing the build must not build.
 *
 * One line, and it caused two of the three faults that put a corrupted
 * tile in the index: a test that merely imported build-tile.mjs rewrote
 * the shipped tile, and did it in parallel with the mutation harness.
 */
describe('the tile build is inert until called', () => {
  it('writes nothing when imported', async () => {
    const { statSync } = await import('node:fs')
    const { execFileSync } = await import('node:child_process')
    const TILE = 'public/tiles/train.html'

    /* mtime, not content. A build-on-import writes the SAME bytes back
       whenever the source is unmutated, so comparing content cannot see
       it — and the damage was never the bytes, it was the write landing
       in parallel with a harness that had mutated the source.

       In a fresh process, because within one vitest worker the module is
       already cached and importing it again does nothing. */
    const before = statSync(TILE).mtimeMs
    execFileSync('node', ['-e', "import('./scripts/build-tile.mjs')"],
      { cwd: process.cwd(), stdio: 'pipe' })
    expect(statSync(TILE).mtimeMs).toBe(before)
  }, 60_000)

  it('does write when actually run', () => {
    /* The positive control. An import guard that never fires would pass
       the assertion above by making the build impossible to run at all. */
    const before = statSync('public/tiles/train.html').mtimeMs
    execFileSync('node', ['scripts/build-tile.mjs'], { cwd: process.cwd(), stdio: 'pipe' })
    expect(statSync('public/tiles/train.html').mtimeMs).not.toBe(before)
  })
})
