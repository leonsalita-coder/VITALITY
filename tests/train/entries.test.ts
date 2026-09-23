import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { readableEntries, type HistoryEntry } from '../../lib/train/sets'

/**
 * One reader for history rows, because four modules got it wrong.
 *
 * The same defect was found in four separate private traversals across
 * three passes: a null row, or a row with no date, arrives from an
 * import and the walk reaches straight through it. analysis.attribute
 * threw; so did all three of series'. Each was fixed by hand, which
 * fixes the instance and leaves the pattern.
 *
 * A row that cannot be placed on a calendar cannot be counted, charted,
 * windowed or compared — every caller would have to skip it anyway — so
 * refusing it once here is the whole guard.
 */
describe('rows that can be read at all', () => {
  const ok = { date: '2026-09-19', kg: 100, sets: [{ w: 100, r: 5 }] }
  /* What a well-formed row comes back AS: readableEntries stamps a
     sessionId on anything that lacks one (see 'the migration' below),
     so every expected shape here carries it. */
  const okStamped = { ...ok, sessionId: ok.date }

  it('yields a well-formed row', () => {
    expect([...readableEntries([ok])]).toEqual([okStamped])
  })

  it('skips an empty slot', () => {
    expect([...readableEntries([null, ok] as never)]).toEqual([okStamped])
  })

  it('skips a row with no date', () => {
    expect([...readableEntries([{ ...ok, date: undefined }, ok] as never)]).toEqual([okStamped])
  })

  it('skips a row whose date is not a string', () => {
    expect([...readableEntries([{ ...ok, date: 20260919 }, ok] as never)]).toEqual([okStamped])
  })

  it('skips something that is not a row at all', () => {
    expect([...readableEntries(['2026-09-19', 7, true, ok] as never)]).toEqual([okStamped])
  })

  it('skips a rest day by default', () => {
    expect([...readableEntries([{ ...ok, off: true }, ok])]).toEqual([okStamped])
  })

  it('yields rest days when asked for them', () => {
    /* Some reads count the days somebody deliberately took off, which is
       training information of its own. */
    const rest = { ...ok, off: true }
    expect([...readableEntries([rest, ok], { includeOff: true })])
      .toEqual([{ ...rest, sessionId: rest.date }, okStamped])
  })

  it('handles a missing list without complaint', () => {
    expect([...readableEntries(undefined)]).toEqual([])
    expect([...readableEntries(null as never)]).toEqual([])
    expect([...readableEntries([])]).toEqual([])
  })

  it('keeps the order it was given', () => {
    const rows: HistoryEntry[] = [
      { date: '2026-09-03', kg: 1 }, { date: '2026-09-01', kg: 2 }, { date: '2026-09-02', kg: 3 },
    ]
    expect([...readableEntries(rows)].map((e) => e.date))
      .toEqual(['2026-09-03', '2026-09-01', '2026-09-02'])
  })

  it('does not swallow a row merely for having no sets', () => {
    /* An empty session is a real thing — somebody opened the lift and
       logged nothing — and callers that care count its sets themselves.
       Dropping it here would silently change what "a session" means. */
    expect([...readableEntries([{ date: '2026-09-19', kg: 0 }])]).toHaveLength(1)
  })
})

/**
 * The migration: a row with no session on it gets its own date as one.
 *
 * True by construction for every row ever written before this field
 * existed — a date was the only identity a row had, and defaulting to
 * it groups every pre-existing row with every OTHER row on that same
 * date, exactly as history has always behaved. This is the ONE place
 * that default lives; every caller across the engine sees it applied,
 * without needing its own `?? date` fallback.
 */
describe('the migration', () => {
  it('stamps sessionId = date on a row that has none', () => {
    const [entry] = [...readableEntries([{ date: '2026-09-19', kg: 100 }])]
    expect(entry.sessionId).toBe('2026-09-19')
  })

  it('leaves a real sessionId untouched', () => {
    /* A row a live session actually wrote must not be silently
       reassigned to its date — that would collapse two real sessions
       on one day back into the very collision this exists to prevent. */
    const withId = { date: '2026-09-19', kg: 100, sessionId: 'evening-abc123' }
    const [entry] = [...readableEntries([withId])]
    expect(entry.sessionId).toBe('evening-abc123')
  })

  it('gives two rows on the same date DIFFERENT session identity when they have it', () => {
    const morning = { date: '2026-09-19', kg: 225, sessionId: 'morning-1' }
    const evening = { date: '2026-09-19', kg: 185, sessionId: 'evening-2' }
    const [a, b] = [...readableEntries([morning, evening])]
    expect(a.sessionId).not.toBe(b.sessionId)
  })

  it('gives two OLD rows on the same date the SAME identity — their shared date', () => {
    /* The control: two pre-migration rows sharing a date are exactly
       the ordinary, non-collision case this whole system has always
       had — one date, one session, full stop. */
    const a = { date: '2026-09-19', kg: 225 }
    const b = { date: '2026-09-19', kg: 185 }
    const [ra, rb] = [...readableEntries([a, b])]
    expect(ra.sessionId).toBe(rb.sessionId)
  })
})

/**
 * No module walks a lift's history on its own terms.
 *
 * The four instances were each fixed where they were found, which is
 * what left the pattern intact: the next module to write its own walk
 * starts with the same hole, and nothing notices until a row with a gap
 * in it reaches a user. Asserted structurally rather than audited,
 * because the hand audit is what missed them for seven passes.
 */
describe('history is read through one reader', () => {
  const ENGINE = 'lib/train'
  const sources = readdirSync(ENGINE)
    .filter((f) => f.endsWith('.ts') && f !== 'index.ts' && f !== 'sets.ts')
    .map((f) => ({ file: `${ENGINE}/${f}`, text: readFileSync(`${ENGINE}/${f}`, 'utf8') }))

  it('has sources to check', () => {
    /* The control. An empty list passes every assertion below. */
    expect(sources.length).toBeGreaterThan(20)
  })

  it('never walks a lift history without the reader', () => {
    /* The two shapes all five defects wore: iterating a history array
       without passing through the reader first. The expression has to
       BEGIN with a history reference — `Object.keys(history)` and
       `readableEntries(history[id])` are not walks of the rows.

       The regex is exercised against a sample in this same body, because
       one that matched nothing would pass forever — precisely the kind
       of green tick this whole exercise is about. */
    const DIRECT = /for \(const \w+ of ((?:\w+\.)?history(?:\[[^\]]*\])?)(?: \|\| \[\])?\)/g
    const sample = `
      for (const entry of history || []) { if (entry.off) continue }
      for (const entry of ctx.history[id]) { use(entry) }
      for (const id of Object.keys(history || {})) { ok(id) }
      for (const entry of readableEntries(history[id])) { fine(entry) }
    `
    const caught = [...sample.matchAll(DIRECT)].map((m) => m[1])
    expect(caught).toHaveLength(2)
    expect(caught).toEqual(['history', 'ctx.history[id]'])

    const offenders: string[] = []
    for (const { file, text } of sources) {
      for (const m of text.matchAll(DIRECT)) offenders.push(`${file}: for (… of ${m[1]})`)
    }
    expect(offenders, `walk these through readableEntries:\n${offenders.join('\n')}`).toEqual([])
  })
})
