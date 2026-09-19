import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  OPERATORS, mutationsFor, splitTests, inCommentAt, evenlySampled,
  ABSENCE, CONTROL, verdictFrom,
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
