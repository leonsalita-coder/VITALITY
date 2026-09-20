import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SHADOW_FEATURES, isLive, surface, recordVerdict, reviewLines, emptyLog,
  MAX_LOG_ENTRIES, SURFACEABLE, type ShadowVerdict, type ShadowLog,
} from '../../lib/train/shadow'

/**
 * A surfaceable verdict, by default.
 *
 * This used to default to `minimum_effective_dose`, which is now off the
 * SURFACEABLE list entirely and can never become a sentence — so every
 * test of the flag mechanism was quietly testing the refusal instead.
 * The refusal has its own group below.
 */
function verdict(over: Partial<ShadowVerdict> = {}): ShadowVerdict {
  return {
    feature: 'transfer_between_lifts',
    subject: 'chest',
    date: '2026-03-01',
    would: true,
    text: 'Chest: you progressed about the same on 12 sets a week as on 18.',
    effect: 0.04, p: 0.01, z: 2.9, nullMean: 0.4, nullSd: 0.2,
    iterations: 400, blocks: 20,
    inputs: { lowVolume: 12, highVolume: 18, weeks: 80 },
    confounds: [],
    ...over,
  }
}

describe('everything ships silent', () => {
  it('has every feature off', () => {
    expect(Object.values(SHADOW_FEATURES).every((v) => v === false)).toBe(true)
  })

  it('reports each feature as not live', () => {
    for (const name of Object.keys(SHADOW_FEATURES)) {
      expect(isLive(name as keyof typeof SHADOW_FEATURES)).toBe(false)
    }
  })

  it('surfaces nothing, even for a verdict that cleared', () => {
    expect(surface(verdict())).toBeNull()
  })

  it('surfaces nothing for a verdict that did not clear either', () => {
    expect(surface(verdict({ would: false }))).toBeNull()
  })
})

describe('switching on is one flag', () => {
  it('returns the text when the feature is enabled', () => {
    const live = surface(verdict(), { transfer_between_lifts: true })
    expect(live).toContain('12 sets a week as on 18')
  })

  it('still says nothing when the statistics did not clear', () => {
    expect(surface(verdict({ would: false }), { transfer_between_lifts: true })).toBeNull()
  })

  it('enabling one feature does not enable the other', () => {
    expect(surface(verdict(), { dose_resolution: true })).toBeNull()
    /* The control: the same verdict DOES surface under its own flag, so
       the null above is the flag doing its job rather than the verdict
       being unsurfaceable for some unrelated reason. */
    expect(surface(verdict(), { transfer_between_lifts: true })).toContain('12 sets')
  })
})

describe('a verdict off the surfaceable list has no flag to flip', () => {
  /**
   * The load-bearing guarantee, and the reason it is not a flag.
   *
   * Dose's verdict is an equivalence claim — "you progressed the same on
   * 12 sets as on 18" — and the calibration says it cannot tell a true
   * ratio of 1.0 from 1.25 at any sample size a real person produces. It
   * carried its own bound for that reason, and a bound is a caveat:
   * readers take the headline and discount the qualifier, and this
   * headline invites cutting a third of somebody's training.
   *
   * A default can be changed by accident. Being off the list cannot.
   */
  const dose = () => verdict({ feature: 'minimum_effective_dose' })

  it('is not on the list', () => {
    expect(SURFACEABLE).not.toContain('minimum_effective_dose')
  })

  it('stays null with its flag forced on', () => {
    expect(surface(dose(), { minimum_effective_dose: true })).toBeNull()
  })

  it('stays null with every flag forced on', () => {
    const all = Object.fromEntries(
      Object.keys(SHADOW_FEATURES).map((k) => [k, true]),
    ) as Record<string, boolean>
    expect(surface(dose(), all)).toBeNull()
    /* The control: a surfaceable verdict DOES come through that same
       call, so the nulls above are the list rather than a broken read. */
    expect(surface(verdict(), all)).toBeTruthy()
  })

  it('leaves the list non-empty, so exclusion is a decision', () => {
    expect(SURFACEABLE.length).toBeGreaterThan(0)
  })
})

describe('the log keeps the evidence, not just the answer', () => {
  it('stores the inputs, the null and the date', () => {
    const log = emptyLog()
    recordVerdict(log, verdict())
    const stored = log.entries[0]
    expect(stored.inputs).toEqual({ lowVolume: 12, highVolume: 18, weeks: 80 })
    expect(stored.nullMean).toBe(0.4)
    expect(stored.nullSd).toBe(0.2)
    expect(stored.date).toBe('2026-03-01')
  })

  it('records verdicts that would NOT have fired too', () => {
    /* A log of only the hits cannot answer "how often would this have
       spoken", which is the whole question shadow mode exists to settle. */
    const log = emptyLog()
    expect(recordVerdict(log, verdict({ would: false }))).toBe(true)
    expect(log.entries).toHaveLength(1)
  })

  it('does not write the same verdict twice', () => {
    const log = emptyLog()
    expect(recordVerdict(log, verdict())).toBe(true)
    expect(recordVerdict(log, verdict())).toBe(false)
    expect(log.entries).toHaveLength(1)
  })

  it('treats a different subject on the same day as a different verdict', () => {
    const log = emptyLog()
    recordVerdict(log, verdict())
    recordVerdict(log, verdict({ subject: 'back' }))
    expect(log.entries).toHaveLength(2)
  })

  it('keeps the log bounded', () => {
    const log = emptyLog()
    for (let i = 0; i < MAX_LOG_ENTRIES + 100; i++) {
      recordVerdict(log, verdict({ date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`, subject: `m${i}` }))
    }
    expect(log.entries).toHaveLength(MAX_LOG_ENTRIES)
  })

  it('drops the oldest first when bounded', () => {
    const log = emptyLog()
    const written = MAX_LOG_ENTRIES + 100
    for (let i = 0; i < written; i++) {
      recordVerdict(log, verdict({ subject: `m${i}`, date: '2026-01-01' }))
    }
    expect(log.entries[0].subject).not.toBe('m0')
    expect(log.entries[log.entries.length - 1].subject).toBe(`m${written - 1}`)
  })

  it('refuses a missing log rather than throwing', () => {
    expect(recordVerdict(null as unknown as ShadowLog, verdict())).toBe(false)
  })

  it('refuses a log whose entries are not a list', () => {
    expect(recordVerdict({ entries: 'nope' } as unknown as ShadowLog, verdict())).toBe(false)
  })

  it('refuses a missing verdict', () => {
    const log = emptyLog()
    expect(recordVerdict(log, null as unknown as ShadowVerdict)).toBe(false)
    expect(recordVerdict(log, verdict())).toBe(true)
  })

  it('refuses a verdict with no date', () => {
    const log = emptyLog()
    expect(recordVerdict(log, { ...verdict(), date: '' })).toBe(false)
    expect(recordVerdict(log, verdict())).toBe(true)
  })

  it('refuses a malformed verdict rather than logging a blank', () => {
    const log = emptyLog()
    expect(recordVerdict(log, { ...verdict(), subject: '' })).toBe(false)
    expect(log.entries).toHaveLength(0)
    /* The control: the same log accepts a well-formed verdict, so the
       refusal above is the validation rather than a broken log. */
    expect(recordVerdict(log, verdict())).toBe(true)
    expect(log.entries).toHaveLength(1)
  })
})

describe('the review', () => {
  const log: ShadowLog = emptyLog()
  /* A dose verdict, which the review still shows in full even though it
     can never be surfaced — the log IS the evidence for deciding whether
     that should ever change. */
  recordVerdict(log, verdict({ feature: 'minimum_effective_dose' }))
  recordVerdict(log, verdict({
    feature: 'transfer_between_lifts', subject: 'front_squat->back_squat',
    date: '2026-04-02', would: false, p: 0.31,
    text: 'Front squat and back squat moved together, about 3 weeks apart.',
    confounds: ['some of this history was imported'],
  }))

  it('prints what it would have said, and when', () => {
    const lines = reviewLines(log).join('\n')
    expect(lines).toContain('2026-03-01')
    expect(lines).toContain('you progressed about the same on 12 sets a week as on 18')
  })

  it('prints the evidence, not just the sentence', () => {
    const lines = reviewLines(log).join('\n')
    expect(lines).toContain('p=0.01')
    expect(lines).toContain('null 0.4')
  })

  it('marks which verdicts would have stayed silent', () => {
    const lines = reviewLines(log).join('\n')
    expect(lines).toMatch(/silent/i)
  })

  it('names the confounds it recorded', () => {
    expect(reviewLines(log).join('\n')).toContain('imported')
  })

  it('prints the inputs the effect was computed from', () => {
    /* The claim is that the log holds the EVIDENCE. Printing p without
       the numbers behind it is a verdict wearing evidence's clothes. */
    const lines = reviewLines(log).join('\n')
    expect(lines).toContain('lowVolume=12')
    expect(lines).toContain('highVolume=18')
    expect(lines).toContain('weeks=80')
  })

  it('includes a verdict dated exactly on the since boundary', () => {
    expect(reviewLines(log, { since: '2026-03-01' }).join('\n')).toContain('12 sets a week')
    expect(reviewLines(log, { since: '2026-03-02' }).join('\n')).not.toContain('12 sets a week')
  })

  it('orders same-day verdicts by subject so the log always reads the same', () => {
    const two = emptyLog()
    recordVerdict(two, verdict({ subject: 'quads' }))
    recordVerdict(two, verdict({ subject: 'back' }))
    const text = reviewLines(two).join('\n')
    expect(text.indexOf('back')).toBeLessThan(text.indexOf('quads'))
  })

  it('survives a missing log rather than throwing', () => {
    expect(reviewLines(null).join('\n')).toMatch(/nothing/i)
  })

  it('says so plainly when nothing has been logged', () => {
    expect(reviewLines(emptyLog()).join('\n')).toMatch(/nothing/i)
  })

  it('states that none of this reached the athlete', () => {
    expect(reviewLines(log).join('\n')).toMatch(/shadow|not shown|never shown/i)
  })

  it('can be narrowed to one feature', () => {
    const lines = reviewLines(log, { feature: 'transfer_between_lifts' }).join('\n')
    expect(lines).toContain('front_squat->back_squat')
    expect(lines).not.toContain('12 sets a week')
  })
})

describe('the review command', () => {
  it('prints a logged verdict from a file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shadow-'))
    const file = join(dir, 'log.json')
    const log = emptyLog()
    recordVerdict(log, verdict())
    writeFileSync(file, JSON.stringify(log))

    const out = execFileSync('node', ['scripts/shadow-review.mjs', file], {
      encoding: 'utf8', cwd: process.cwd(),
    })
    expect(out).toContain('2026-03-01')
    expect(out).toContain('12 sets a week')
    expect(out).toContain('p=0.01')
  }, 30_000)

  it('says what to do when there is no log yet', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shadow-'))
    const out = execFileSync('node', ['scripts/shadow-review.mjs', join(dir, 'missing.json')], {
      encoding: 'utf8', cwd: process.cwd(),
    })
    expect(out).toMatch(/no shadow log/i)
  }, 30_000)
})

describe('the log prints evidence, not zeros', () => {
  /**
   * These findings work in fractional weekly change. A detectable
   * difference of 0.0003 — three hundredths of a percent a week — IS the
   * row: it is what the test could resolve, and a reader deciding
   * whether to trust the verdict needs it. Rounding to three decimal
   * places printed the whole log as `effect 0 p=0.908 null 0 ± 0`.
   */
  const tiny = verdict({
    effect: 0.00012, nullMean: 0.00034, nullSd: 0.00021, z: 0.12, p: 0.908,
  })

  it('keeps a small effect legible', () => {
    const log = emptyLog()
    recordVerdict(log, tiny)
    const text = reviewLines(log).join('\n')
    expect(text).not.toMatch(/effect 0\s/)
    expect(text).toContain('effect 0.00012')
  })

  it('keeps a small null legible', () => {
    const log = emptyLog()
    recordVerdict(log, tiny)
    const text = reviewLines(log).join('\n')
    expect(text).not.toContain('null 0 ± 0')
    expect(text).toContain('null 0.00034 ± 0.00021')
  })

  it('still prints an exact zero as zero', () => {
    const log = emptyLog()
    recordVerdict(log, verdict({ subject: 'none', effect: 0, nullSd: 0 }))
    expect(reviewLines(log).join('\n')).toMatch(/effect 0\s/)
  })

  it('prints exactly a ten-thousandth in plain notation', () => {
    /* The boundary between plain and exponential. Without this it could
       sit one step either side forever and nothing would notice. */
    const log = emptyLog()
    recordVerdict(log, verdict({ subject: 'edge', effect: 0.0001 }))
    const text = reviewLines(log).join('\n')
    expect(text).toContain('effect 0.0001')
    expect(text).not.toContain('effect 1.00e-4')
  })

  it('drops to exponential just below it', () => {
    const log = emptyLog()
    recordVerdict(log, verdict({ subject: 'under', effect: 0.000099 }))
    expect(reviewLines(log).join('\n')).toContain('e-5')
  })

  it('does not turn readable numbers into exponents', () => {
    const log = emptyLog()
    recordVerdict(log, verdict({ subject: 'big', effect: 1.25, p: 0.01 }))
    const text = reviewLines(log).join('\n')
    expect(text).toContain('effect 1.25')
    expect(text).not.toContain('e-')
  })
})
