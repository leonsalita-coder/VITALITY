import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The edit path itself.
 *
 * A replace pattern that matched two sites, landed on the first and left a
 * duplicate key behind has now shipped twice. That is a tool problem, not
 * a code problem, so the tool is what gets the guard: an anchor matches
 * exactly what you said it would, or nothing is written.
 */

let dir: string
const run = (spec: unknown) => {
  const file = join(dir, 'edits.json')
  writeFileSync(file, JSON.stringify(spec))
  try {
    const stdout = execFileSync('node', ['scripts/anchored-edit.mjs', file], { encoding: 'utf8' })
    return { ok: true, out: stdout, err: '' }
  } catch (e: any) {
    return { ok: false, out: String(e.stdout || ''), err: String(e.stderr || '') }
  }
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'anchored-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const write = (name: string, body: string) => {
  const p = join(dir, name)
  writeFileSync(p, body)
  return p
}

describe('an anchor that matches exactly once', () => {
  it('applies the edit', () => {
    const file = write('a.js', 'const a = 1;\nconst b = 2;\n')
    const r = run({ file, anchor: 'const b = 2;', replace: 'const b = 3;' })
    expect(r.ok).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('const a = 1;\nconst b = 3;\n')
  })
})

describe('an anchor that matches more than once', () => {
  /* The exact shape of the bug: an object literal appearing twice, the
     edit landing on the first, and a duplicate key left in the second. */
  const twice = 'x = { weeklyTarget: t };\ny = { weeklyTarget: t };\n'

  it('writes nothing at all', () => {
    const file = write('b.js', twice)
    const r = run({ file, anchor: '{ weeklyTarget: t }', replace: '{ weeklyTarget: t, age: a }' })
    expect(r.ok).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe(twice)
  })

  it('says how many sites matched, and where', () => {
    const file = write('c.js', twice)
    const r = run({ file, anchor: '{ weeklyTarget: t }', replace: 'z' })
    expect(r.err).toMatch(/matched 2 site\(s\), expected 1/)
    expect(r.err).toMatch(/lines 1, 2/)
  })

  it('applies both when both were intended', () => {
    const file = write('d.js', twice)
    const r = run({ file, anchor: '{ weeklyTarget: t }', replace: '{ t }', expect: 2 })
    expect(r.ok).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('x = { t };\ny = { t };\n')
  })
})

describe('an anchor that matches nothing', () => {
  it('fails rather than reporting a successful no-op', () => {
    const file = write('e.js', 'const a = 1;\n')
    const r = run({ file, anchor: 'const zzz = 9;', replace: 'x' })
    expect(r.ok).toBe(false)
    expect(r.err).toMatch(/matched 0 site\(s\)/)
    expect(readFileSync(file, 'utf8')).toBe('const a = 1;\n')
  })
})

describe('a run of several edits', () => {
  it('applies them all', () => {
    const file = write('f.js', 'a\nb\nc\n')
    const r = run([
      { file, anchor: 'a', replace: '1' },
      { file, anchor: 'c', replace: '3' },
    ])
    expect(r.ok).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('1\nb\n3\n')
  })

  it('writes none of them when any one is ambiguous', () => {
    const before = 'a\nb\nb\n'
    const file = write('g.js', before)
    const r = run([
      { file, anchor: 'a', replace: '1' },
      { file, anchor: 'b', replace: '2' },
    ])
    expect(r.ok).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it('validates each edit against what the previous ones left behind', () => {
    /* Two edits that are each fine alone and jointly wrong: the first
       creates a second site for the second one's anchor. */
    const before = 'keep\ntarget\n'
    const file = write('h.js', before)
    const r = run([
      { file, anchor: 'keep', replace: 'target' },
      { file, anchor: 'target', replace: 'done' },
    ])
    expect(r.ok).toBe(false)
    expect(r.err).toMatch(/matched 2 site\(s\)/)
    expect(readFileSync(file, 'utf8')).toBe(before)
  })
})

describe('a replacement containing regex-special text', () => {
  it('is inserted literally, not interpreted', () => {
    const file = write('i.js', 'const x = OLD;\n')
    const r = run({ file, anchor: 'OLD', replace: '"$& $1 $$"' })
    expect(r.ok).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('const x = "$& $1 $$";\n')
  })
})
