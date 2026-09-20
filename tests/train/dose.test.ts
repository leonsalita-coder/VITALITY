import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  doseVerdicts, doseResolutions, doseResolutionNote, weeklyPercent,
  MIN_TRAINED_WEEKS, MIN_DOSE_RATIO, DOSE_BLOCK_WEEKS, RESOLUTION_TARGET,
  type DoseContext,
} from '../../lib/train/dose'
import { indexFrom } from '../../lib/train/analysis'
import { collectSignals } from '../../lib/train/insight'
import { surface, SURFACEABLE } from '../../lib/train/shadow'
import { seededRandom } from '../../lib/train/resample'
import type { HistoryEntry } from '../../lib/train/sets'

/**
 * "You've progressed the same on 12 sets of chest as on 18."
 *
 * A co-occurrence in one person's own log, never a prescription. It is
 * also the single most ACTIONABLE thing this engine can say — somebody
 * told it may cut a third of their training — which is exactly why it
 * ships silent, why the gate is a resampled null rather than a number
 * somebody picked, and why the confounds are named out loud.
 *
 * THE STATISTICS ARE BACKWARDS FROM EVERY OTHER FINDING HERE, and that
 * is the thing to keep hold of while reading these tests. Every other
 * finding fires when an effect is OUTSIDE the null. This one claims
 * there is NO difference, so it fires when the effect is INSIDE — and
 * "no difference found" is worthless without knowing a difference would
 * have been visible. Hence the power gate: the null band must be
 * narrower than the athlete's own progression rate, or the honest
 * answer is silence rather than equivalence.
 */

const WEEKS = 80
const day = (back: number) => {
  const d = new Date(2026, 8, 19 - back)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const NOW = new Date(2026, 8, 19, 12).getTime()

const index = indexFrom({ bench: { primary: [{ muscle: 'chest', share: 1 }] } })

/** Low-volume regimes run 3 sets a session, high run 6. Eight weeks each. */
const isHighWeek = (w: number) => Math.floor(w / 8) % 2 === 1

/**
 * A bench log across `WEEKS` weeks of alternating volume.
 *
 * `rate(w)` is the fractional weight gain applied in week w, so a caller
 * decides whether progression tracks the volume regime or ignores it.
 * Weight compounds, which keeps the RELATIVE change flat — an absolute
 * increment on a growing bar makes relative change decline over time,
 * and that trend would correlate with the regimes by accident.
 */
function bench(rate: (w: number) => number, opts: { weeks?: number } = {}): HistoryEntry[] {
  const weeks = opts.weeks ?? WEEKS
  const out: HistoryEntry[] = []
  let weight = 100
  for (let w = 0; w < weeks; w++) {
    weight *= 1 + rate(w)
    const sets = isHighWeek(w) ? 6 : 3
    for (const offset of [0, 3]) {
      const back = (weeks - 1 - w) * 7 + offset
      const kg = Math.round(weight * 100) / 100
      out.push({
        date: day(back), kg,
        sets: Array.from({ length: sets }, () => ({ w: kg, r: 5 })),
      })
    }
  }
  return out
}

/** Deterministic wobble, independent of the volume regime. */
const wobble = (w: number) => Math.sin(w * 1.7) * 0.0015

const ctx = (history: HistoryEntry[], over: Partial<DoseContext> = {}): DoseContext => ({
  history: { bench: history }, index, now: NOW, seed: 7, ...over,
})

const chestOf = (c: DoseContext) => doseVerdicts(c).find((v) => v.subject === 'chest')

describe('the effect is inside the null — equal progression at unequal doses', () => {
  /* Same compounding rate whatever the volume. The claim is true here. */
  const same = () => ctx(bench((w) => 0.004 + wobble(w)))

  it('produces a verdict', () => {
    expect(chestOf(same())).toBeTruthy()
  })

  it('would have fired', () => {
    expect(chestOf(same())!.would).toBe(true)
  })

  it('names both volumes, in sets a week', () => {
    const text = chestOf(same())!.text
    expect(text).toContain('6')
    expect(text).toContain('12')
  })

  it('states it as a co-occurrence, not a prescription', () => {
    const text = chestOf(same())!.text
    expect(text).toMatch(/your own log|not a prescription|co-?occur/i)
    expect(text).not.toMatch(/you should|cut back|reduce your|do less/i)
  })

  it('quotes a resolution the sentence can actually state', () => {
    /* The bound is the honest half of this claim, and it is routinely a
       few hundredths of a percent a week. Printed at one decimal place
       it read "the same, to within 0% a week" — which is meaningless,
       and is the unbounded claim this sentence exists to avoid. */
    const v = chestOf(same())!
    expect(v.detectable).toBeGreaterThan(0)
    expect(v.text).toMatch(/to within the [\d.]+% a week/)
    expect(v.text).not.toContain('to within the 0% a week')
  })

  it('carries the effect and the uncertainty, not only the answer', () => {
    const v = chestOf(same())!
    expect(Math.abs(v.effect)).toBeLessThan(v.detectable)
    expect(v.detectable).toBeGreaterThan(0)
    expect(v.p).toBeGreaterThan(0)
  })

  it('records the numbers it rests on', () => {
    const v = chestOf(same())!
    expect(v.inputs.lowVolume).toBe(6)
    expect(v.inputs.highVolume).toBe(12)
    expect(v.inputs.weeks).toBeGreaterThanOrEqual(MIN_TRAINED_WEEKS)
  })

  it('resamples in blocks of weeks, not single weeks', () => {
    expect(DOSE_BLOCK_WEEKS).toBeGreaterThan(1)
    expect(chestOf(same())!.blocks).toBe(Math.ceil(80 / DOSE_BLOCK_WEEKS))
  })
})

describe('the effect is outside the null — more volume really did more', () => {
  /* Four times the progression rate in the high-volume regimes. */
  const different = () => ctx(bench((w) => (isHighWeek(w) ? 0.008 : 0.002) + wobble(w)))

  it('produces a verdict', () => {
    expect(chestOf(different())).toBeTruthy()
  })

  it('does NOT claim the doses were equivalent', () => {
    expect(chestOf(different())!.would).toBe(false)
  })

  it('clears the null in the ordinary direction', () => {
    expect(chestOf(different())!.p).toBeLessThan(0.05)
  })
})

describe('silence is the default', () => {
  it('logs a thin history as unaskable rather than skipping it', () => {
    /* Logged, not skipped, the same way transfer logs its untestable
       pairs. An absent row cannot say whether a muscle was quiet or
       merely never asked, and the resolution report is built from the
       row — so it has to exist before the history is long enough for a
       verdict. */
    const v = chestOf(ctx(bench(() => 0.004, { weeks: MIN_TRAINED_WEEKS - 1 })))!
    expect(v.status).toBe('thin_history')
    expect(v.would).toBe(false)
  })

  it('says nothing when the two doses are barely different', () => {
    /* Eight sets a week against ten. Not "12 against 18": the sentence
       would be a rounding artefact wearing a finding's clothes. The
       first version of this fixture used 4 against 6, which is a 50%
       difference and genuinely two doses — it failed, correctly. */
    const flat: HistoryEntry[] = []
    let weight = 100
    for (let w = 0; w < WEEKS; w++) {
      weight *= 1.004
      const sets = isHighWeek(w) ? 5 : 4
      for (const offset of [0, 3]) {
        const kg = Math.round(weight * 100) / 100
        flat.push({
          date: day((WEEKS - 1 - w) * 7 + offset), kg,
          sets: Array.from({ length: sets }, () => ({ w: kg, r: 5 })),
        })
      }
    }
    const v = chestOf(ctx(flat))
    expect(v?.would ?? false).toBe(false)
  })

  it('says nothing when nothing was progressing at all', () => {
    /* "You progressed the same on 6 as on 12" is not a finding when the
       answer on both is zero. */
    expect(chestOf(ctx(bench(() => 0)))?.would ?? false).toBe(false)
  })

  it('says nothing when the test had no resolution to see a difference', () => {
    /* Progression so noisy that the null band is wider than the whole
       progression rate. No difference was found, and none could have
       been — which is not the same claim. */
    const noisy = ctx(bench((w) => 0.001 + Math.sin(w * 1.9) * 0.02))
    expect(chestOf(noisy)?.would ?? false).toBe(false)
  })

  it('produces no verdict at all for an empty history', () => {
    expect(doseVerdicts(ctx([], { history: {} }))).toEqual([])
  })
})

describe('confounds are named, not hidden', () => {
  const withConfounds = () => ctx(bench((w) => 0.004 + wobble(w)), {
    deloadDates: [day(100)], imported: true,
  })

  it('records them on the verdict', () => {
    expect(chestOf(withConfounds())!.confounds.join(' ')).toMatch(/deload/)
    expect(chestOf(withConfounds())!.confounds.join(' ')).toMatch(/imported/)
  })

  it('puts them in the sentence a person would read', () => {
    expect(chestOf(withConfounds())!.text).toMatch(/deload|imported/)
  })

  it('leaves them empty when there are none', () => {
    expect(chestOf(ctx(bench((w) => 0.004 + wobble(w))))!.confounds).toEqual([])
  })
})

describe('shadow mode — it computes and says nothing', () => {
  const live = () => ctx(bench((w) => 0.004 + wobble(w)))

  it('has a verdict that would have fired', () => {
    expect(chestOf(live())!.would).toBe(true)
  })

  it('cannot be surfaced, even with its own flag forced on', () => {
    /* THE LOAD-BEARING TEST. The verdict is an equivalence claim, and
       the calibration says it cannot tell a true ratio of 1.0 from 1.25
       at any sample size a person will produce. It carried its own bound
       for that reason — and a bound is a caveat, which readers discount.
       The action this headline invites is cutting a third of somebody's
       training.

       So it is not gated on a flag. It is off the SURFACEABLE list, and
       flipping the flag does nothing. */
    const verdict = chestOf(live())!
    expect(verdict.would).toBe(true)
    expect(surface(verdict)).toBeNull()
    expect(surface(verdict, { minimum_effective_dose: true })).toBeNull()
  })

  it('is still computed and still logged', () => {
    /* Shadow mode's whole argument is that months of logged verdicts
       turn guessed gates into tuned ones. Refusing to SAY it is not a
       reason to stop measuring it — and it is what would justify
       revisiting the decision later, on evidence. */
    const v = chestOf(live())!
    expect(v.status).toBe('equivalent')
    expect(v.text).toContain('the same')
    expect(v.detectable).toBeGreaterThan(0)
  })

  it('never reaches the post-session insight', () => {
    const c = live()
    const signals = collectSignals({
      history: c.history, index, now: NOW, today: day(0),
      records: [], deloadsApplied: [], plateaus: [],
      streak: 0, weeklyTarget: 3, firsts: [],
    })
    const text = signals.map((s) => s.text).join(' ')
    expect(text).not.toContain('sets a week')
    /* The control: the insight IS producing signals over this history,
       so the absence above is the shadow gate rather than an empty
       pipeline that would report clean whatever happened. */
    expect(signals.length).toBeGreaterThan(0)
  })

  it('is not on the list of verdicts that may ever be surfaced', () => {
    expect(SURFACEABLE).not.toContain('minimum_effective_dose')
    /* The control: the list is not simply empty — transfer IS on it, so
       the exclusion above is a decision about this finding rather than a
       switch nobody wired. */
    expect(SURFACEABLE).toContain('transfer_between_lifts')
  })

  it('is never called from the tile', () => {
    /* The engine gate is one flag; this is the other half of the claim —
       no UI reaches for it at all, so turning it on is a deliberate act
       in two places rather than an accident in one. */
    const tile = readFileSync('public/tiles/train.html', 'utf8')
    /* Outside the engine block, deliberately. The whole engine is inlined
       into the tile, so the DEFINITION of doseNote is in there by
       construction — searching the whole file would assert something
       that can never be true. What matters is whether the tile's own
       code reaches for it. */
    const own = tile.split('<!-- TRAIN-ENGINE:END -->')[1] || ''
    expect(own).not.toContain('doseVerdicts')
    /* The control: the tile's own code DOES call the engine, so the
       absence above is a decision rather than an empty haystack. */
    expect(own).toContain('TrainEngine.')
  })
})

describe('the shape of the gates', () => {
  it('needs a real difference in dose before it will speak', () => {
    expect(MIN_DOSE_RATIO).toBeGreaterThan(1)
  })

  it('needs months of history', () => {
    expect(MIN_TRAINED_WEEKS).toBeGreaterThanOrEqual(DOSE_BLOCK_WEEKS * 4)
  })
})

describe('what it reads, and what it ignores', () => {
  const same = (extra: HistoryEntry[] = []) => ctx([...bench((w) => 0.004 + wobble(w)), ...extra])

  it('takes the best working set of a session, not the last', () => {
    /* A heavy top set followed by a FIXED back-off set at 60 lb. Reading
       the last set would measure a weight that never moves, so
       progression would read as flat and the finding would vanish.
       A back-off set scaled to the top set would not test this: it
       climbs at the same relative rate, so last-wins and best-wins give
       the same answer. */
    const withBackoff = bench((w) => 0.004 + wobble(w)).map((e) => ({
      ...e, sets: [...(e.sets || []), { w: 60, r: 8 }],
    }))
    expect(chestOf(ctx(withBackoff))!.would).toBe(true)
  })

  it('ignores a session marked off', () => {
    const base = chestOf(same())!
    const withOff = chestOf(same([{ date: day(2), kg: 999, off: true, sets: [{ w: 999, r: 5 }] }]))!
    expect(withOff.effect).toBe(base.effect)
  })

  it('ignores an entry with no date', () => {
    const base = chestOf(same())!
    const undated = chestOf(same([{ date: '', kg: 999, sets: [{ w: 999, r: 5 }] } as HistoryEntry]))!
    expect(undated.effect).toBe(base.effect)
  })

  it('ignores a session dated in the future', () => {
    const base = chestOf(same())!
    const ahead = chestOf(same([{ date: day(-7), kg: 999, sets: [{ w: 999, r: 5 }] }]))!
    expect(ahead.effect).toBe(base.effect)
    expect(ahead.inputs.weeks).toBe(base.inputs.weeks)
  })

  it('ignores a set with no load, which has no estimated 1RM', () => {
    const base = chestOf(same())!
    const bodyweight = chestOf(same([{ date: day(2), kg: 0, sets: [{ w: 0, r: 20 }] }]))!
    expect(bodyweight.effect).toBe(base.effect)
  })

  it('survives a missing context rather than throwing', () => {
    expect(doseVerdicts(null as unknown as DoseContext)).toEqual([])
    expect(doseVerdicts({ history: {}, index, now: 0 })).toEqual([])
  })
})

describe('the boundaries themselves', () => {
  /* Every gate in this file is a comparison, and a comparison nobody
     tests at its own edge can be off by one forever. */

  const weeklyBench = (weeks: number, setsHigh: number, setsLow: number): HistoryEntry[] => {
    const out: HistoryEntry[] = []
    let weight = 100
    for (let w = 0; w < weeks; w++) {
      weight *= 1.004 + wobble(w)
      const sets = isHighWeek(w) ? setsHigh : setsLow
      const kg = Math.round(weight * 100) / 100
      out.push({
        date: day((weeks - 1 - w) * 7), kg,
        sets: Array.from({ length: sets }, () => ({ w: kg, r: 5 })),
      })
    }
    return out
  }

  it('speaks at exactly the minimum number of trained weeks', () => {
    /* The first week has no week before it, so it carries no progression
       observation — MIN_TRAINED_WEEKS rows needs one more week of log. */
    const v = chestOf(ctx(bench((w) => 0.004 + wobble(w), { weeks: MIN_TRAINED_WEEKS + 1 })))!
    expect(v.inputs.weeks).toBe(MIN_TRAINED_WEEKS)
    expect(v.status).not.toBe('thin_history')
  })

  it('will not speak one week below it', () => {
    const v = chestOf(ctx(bench((w) => 0.004 + wobble(w), { weeks: MIN_TRAINED_WEEKS })))!
    expect(v.status).toBe('thin_history')
    expect(v.would).toBe(false)
  })

  it('speaks at exactly the minimum dose ratio', () => {
    /* Seven sets against five is 1.4 exactly. */
    const v = chestOf(ctx(weeklyBench(80, 7, 5)))!
    expect(v.inputs.separation).toBe(MIN_DOSE_RATIO)
    expect(v.would).toBe(true)
  })

  it('stays silent just below the minimum dose ratio', () => {
    /* Six against five is 1.2. */
    expect(chestOf(ctx(weeklyBench(80, 6, 5)))!.would).toBe(false)
  })

  /* Read off the verdict rather than recomputed here. The window starts
     at the oldest week carrying a progression observation, which is one
     week later than the oldest session — a test that recomputed it would
     be asserting my arithmetic against itself. */
  const windowOf = () => {
    const v = chestOf(ctx(bench((w) => 0.004 + wobble(w))))!
    return { from: v.inputs.from as string, to: v.inputs.to as string }
  }

  it('names a confound dated exactly on the first day of the window', () => {
    const c = ctx(bench((w) => 0.004 + wobble(w)), { deloadDates: [windowOf().from] })
    expect(chestOf(c)!.confounds.join(' ')).toMatch(/deload/)
  })

  it('names a confound dated exactly on the last day of the window', () => {
    const c = ctx(bench((w) => 0.004 + wobble(w)), { deloadDates: [windowOf().to] })
    expect(chestOf(c)!.confounds.join(' ')).toMatch(/deload/)
  })

  it('ignores a confound dated before the window starts', () => {
    const before = day(WEEKS * 7 + 30)
    const c = ctx(bench((w) => 0.004 + wobble(w)), { deloadDates: [before] })
    expect(chestOf(c)!.confounds).toEqual([])
    /* The control: the same date INSIDE the window is named, so the empty
       list above is the window doing its job rather than confounds being
       broken for every input. */
    const inside = ctx(bench((w) => 0.004 + wobble(w)), { deloadDates: [windowOf().from] })
    expect(chestOf(inside)!.confounds).toHaveLength(1)
  })

  it('ignores a confound dated after today', () => {
    const c = ctx(bench((w) => 0.004 + wobble(w)), { deloadDates: [day(-5)] })
    expect(chestOf(c)!.confounds).toEqual([])
    const inside = ctx(bench((w) => 0.004 + wobble(w)), { deloadDates: [windowOf().to] })
    expect(chestOf(inside)!.confounds).toHaveLength(1)
  })
})

describe('the degenerate cases that make a split meaningless', () => {
  /** Unvarying volume: every week sits exactly on the mean. */
  const constantVolume = (): HistoryEntry[] => {
    const out: HistoryEntry[] = []
    let weight = 100
    for (let w = 0; w < WEEKS; w++) {
      weight *= 1.004 + wobble(w)
      const kg = Math.round(weight * 100) / 100
      out.push({
        date: day((WEEKS - 1 - w) * 7), kg,
        sets: Array.from({ length: 5 }, () => ({ w: kg, r: 5 })),
      })
    }
    return out
  }

  it('produces no verdict when every week carried the same volume', () => {
    /* There are no two doses to compare, so there is nothing the sentence
       could even name. */
    expect(chestOf(ctx(constantVolume()))).toBeUndefined()
  })

  it('puts a week sitting exactly on the mean in the LOW group', () => {
    /* Three regimes of 4, 6 and 8 sets: the mean is 6, so the middle
       regime lands exactly on the cut. It belongs with the low dose —
       "you did no more than average" is not a high dose. Without this,
       the boundary could flip and the sentence would name volumes the
       statistic never tested. */
    /* 82 weeks so that the 81 weeks carrying a progression observation
       (the oldest has no week before it) divide evenly into three
       regimes — 27 each — and the mean lands on exactly 6. With uneven
       counts the mean is 6.02 and no week sits on the cut at all, so the
       boundary under test is never exercised. */
    const out: HistoryEntry[] = []
    let weight = 100
    const weeks = 82
    for (let w = 0; w < weeks; w++) {
      weight *= 1.004 + wobble(w)
      const kg = Math.round(weight * 100) / 100
      const sets = [4, 6, 8][w % 3]
      out.push({
        date: day((weeks - 1 - w) * 7), kg,
        sets: Array.from({ length: sets }, () => ({ w: kg, r: 5 })),
      })
    }
    const v = chestOf(ctx(out))!
    expect(v.inputs.highVolume).toBe(8)
    expect(v.inputs.lowVolume).toBe(5)
  })

  it('takes the heaviest set when the ramp runs light to heavy', () => {
    /* A FIXED warm-up before the working set — 60 lb every session,
       forever. Keeping the first e1RM rather than the best would measure
       the warm-up, and the warm-up never moves, so progression would
       read as flat and the finding would vanish. A proportional warm-up
       would not test this: it climbs at the same RELATIVE rate as the
       working set, so first-wins and best-wins give the same answer. */
    const ramped = bench((w) => 0.004 + wobble(w)).map((e) => ({
      ...e, sets: [{ w: 60, r: 5 }, ...(e.sets || [])],
    }))
    expect(chestOf(ctx(ramped))!.would).toBe(true)
  })

  it('skips a week whose only work carried no load', () => {
    /* No estimated 1RM exists for a set with no weight, so that week has
       no progression observation. Treating it as a zero would make the
       NEXT week's change a division by nothing. */
    /* BOTH sessions that week, not one. Blanking only the Monday left
       the Thursday carrying a real estimate, so the week still had one
       and the case was never reached — the test passed for the wrong
       reason. */
    const history = bench((w) => 0.004 + wobble(w))
    const blankDates = [day(40 * 7), day(40 * 7 + 3)]
    const blanked = history.map((e) =>
      blankDates.includes(e.date) ? { ...e, kg: 0, sets: [{ w: 0, r: 20 }] } : e)
    const v = chestOf(ctx(blanked))!
    expect(Number.isFinite(v.effect)).toBe(true)
    expect(v.would).toBe(true)
  })
})

describe('the rate a sentence quotes', () => {
  /* The bound is the honest half of the claim, so the number carrying it
     has to survive being printed. One decimal place turned a resolution
     of three hundredths of a percent a week into "0%", which reads as
     the unbounded claim this sentence exists to avoid. */

  it('keeps three places below a tenth of a percent', () => {
    expect(weeklyPercent(0.00034)).toBe('0.034%')
  })

  it('switches to two places at exactly a tenth of a percent', () => {
    expect(weeklyPercent(0.001)).toBe('0.1%')
    expect(weeklyPercent(0.00099)).toBe('0.099%')
  })

  it('switches to one place at exactly one percent', () => {
    expect(weeklyPercent(0.01)).toBe('1%')
    expect(weeklyPercent(0.0099)).toBe('0.99%')
  })

  it('prints a plain zero as zero', () => {
    expect(weeklyPercent(0)).toBe('0%')
  })

  it('keeps the sign', () => {
    expect(weeklyPercent(-0.004)).toBe('-0.4%')
  })
})

/**
 * What dose actually says, which is nothing about what it found.
 *
 * The verdict was bounded out loud — "the same, to within the 0.03% a
 * week your log can resolve" — and a bound is a caveat. Readers take the
 * headline and discount the qualifier, and the headline here invites
 * cutting a third of somebody's training on a claim the calibration says
 * cannot be supported at 1.25x.
 *
 * A statement about RESOLUTION is unactionable in that direction.
 */
describe('the resolution report', () => {
  /**
   * A history with REALISTIC noise, which the rest of this file does not
   * have.
   *
   * `wobble` is a tiny deterministic ripple, and a log that clean is
   * already precise enough to resolve a quarter of the athlete's rate at
   * forty-five weeks — so the resolution report correctly had nothing to
   * say and every test below failed. Real progression wanders: this is
   * the AR(1) drift the calibration in docs/train-verification.md was
   * measured against, at the same scale.
   */
  const drift = (() => {
    const rand = seededRandom(17)
    const out: number[] = []
    let x = 0
    for (let i = 0; i < 300; i++) {
      x = 0.75 * x + (rand() - 0.5) * 2 * 0.003
      out.push(x)
    }
    return out
  })()
  const noisy = (weeks: number) => ctx(bench((w) => 0.004 + drift[w], { weeks }))

  const underPowered = () => noisy(45)
  const resolutionOf = (c: DoseContext) => doseResolutions(c).find((r) => r.muscle === 'chest')

  it('reports on a muscle whose question is still open', () => {
    expect(resolutionOf(underPowered())).toBeTruthy()
  })

  it('never claims the doses were equivalent', () => {
    const text = resolutionOf(underPowered())!.text
    expect(text).not.toMatch(/the same|no difference|equivalent|made no difference/i)
  })

  it('never reads as permission to train less', () => {
    const text = resolutionOf(underPowered())!.text
    expect(text).not.toMatch(/you (should|could|can) (cut|drop|reduce)|train less|enough sets/i)
  })

  it('says the question is open rather than answered in the negative', () => {
    expect(resolutionOf(underPowered())!.text).toMatch(/open question, not a no/i)
  })

  it('names both volumes and what the log can resolve', () => {
    const r = resolutionOf(underPowered())!
    const text = r.text
    expect(text).toContain(String(r.lowVolume))
    expect(text).toContain(String(r.highVolume))
    expect(text).toContain(weeklyPercent(r.detectable))
    expect(text).toContain(weeklyPercent(r.weeklyProgression))
  })

  it('says how much more history it would take', () => {
    const r = resolutionOf(underPowered())!
    expect(r.weeksNeeded).toBeGreaterThan(0)
    expect(r.text).toContain(`${r.weeksNeeded} more weeks`)
  })

  it('asks for less history the longer the log already is', () => {
    /* The band narrows with weeks, so the remaining wait has to shrink.
       A projection that grew with more data would be reading noise. */
    const shorter = resolutionOf(noisy(45))!
    const longer = resolutionOf(noisy(120))!
    expect(longer.weeksNeeded).toBeLessThan(shorter.weeksNeeded)
  })

  it('quotes a wait longer than an inverse-square-root would', () => {
    /* Measured at weeks^-0.42, not weeks^-0.5, because autocorrelation
       makes effective sample size grow slower than the calendar. Assuming
       the textbook exponent understates the wait, which tells somebody an
       answer is closer than it is. */
    const r = resolutionOf(underPowered())!
    const ratio = r.detectable / (r.weeklyProgression / RESOLUTION_TARGET)
    const sqrtEstimate = r.weeks * ratio ** 2 - r.weeks
    expect(r.weeksNeeded).toBeGreaterThan(sqrtEstimate)
  })

  it('says nothing about a muscle whose volumes are barely different', () => {
    /* Volume that varies, but not enough to be called two doses — so
       there is no pending question to be under-powered about.

       Deliberately NOT a constant volume: with every week identical the
       split is degenerate and no verdict is created at all, so the
       'volume_too_similar' path is never reached and a test using it
       would pass without exercising anything. */
    const narrow: HistoryEntry[] = []
    let weight = 100
    for (let w = 0; w < 60; w++) {
      weight *= 1 + 0.004 + drift[w]
      const sets = isHighWeek(w) ? 5 : 4
      for (const offset of [0, 3]) {
        const kg = Math.round(weight * 100) / 100
        narrow.push({ date: day((60 - 1 - w) * 7 + offset), kg, sets: Array.from({ length: sets }, () => ({ w: kg, r: 5 })) })
      }
    }
    expect(chestOf(ctx(narrow))!.status).toBe('volume_too_similar')
    expect(resolutionOf(ctx(narrow))).toBeUndefined()
    /* The control: genuinely varied volume over the same span DOES
       produce one. */
    expect(resolutionOf(noisy(60))).toBeTruthy()
  })

  it('says nothing about a muscle that is not progressing at all', () => {
    /* No rate to measure a difference against, and dividing by it would
       project an infinite wait. */
    const stalled = ctx(bench(() => 0, { weeks: 60 }))
    expect(chestOf(stalled)).toBeTruthy()
    expect(resolutionOf(stalled)).toBeUndefined()
  })

  it('speaks EARLY, before there is enough history for a verdict', () => {
    /* Twenty-eight weeks is below the verdict minimum but well above
       what a resample needs, so the band is real and the projection is
       meaningful. This is the most useful time to hear it: the question
       is open, and here is roughly what would close it. */
    const early = ctx(bench((w) => 0.004 + drift[w], { weeks: MIN_TRAINED_WEEKS - 4 }))
    expect(chestOf(early)!.status).toBe('thin_history')
    expect(resolutionOf(early)!.weeksNeeded).toBeGreaterThan(0)
  })

  it('says nothing when there was not even enough history to measure a band', () => {
    /* Twelve weeks gives three blocks, below what a permutation test
       needs, so no band was ever measured — and a projection needs a
       measurement of how precise the log is NOW to project from. */
    const tiny = ctx(bench((w) => 0.004 + drift[w], { weeks: 12 }))
    expect(chestOf(tiny)!.detectable).toBe(0)
    expect(resolutionOf(tiny)).toBeUndefined()
  })

  it('gives two equally distant muscles a stable order', () => {
    /* Identical histories on two lifts, so the projected waits tie.
       The order comes from the verdicts, which are already sorted by
       muscle, plus a stable sort — there is deliberately no tiebreak
       here, because one could never change an answer. */
    const shared = bench((w) => 0.004 + drift[w], { weeks: 45 })
    const rows = doseResolutions({
      history: { bench: shared, squat: shared.map((e) => ({ ...e })) },
      index: indexFrom({
        bench: { primary: [{ muscle: 'chest', share: 1 }] },
        squat: { primary: [{ muscle: 'quads', share: 1 }] },
      }),
      now: NOW, seed: 7,
    })
    expect(rows).toHaveLength(2)
    expect(rows[0].weeksNeeded).toBe(rows[1].weeksNeeded)
    expect(rows[0].muscle).toBe('chest')
    expect(rows[1].muscle).toBe('quads')
  })

  it('says nothing once the log is already fine enough', () => {
    /* There is nothing safe left to add: what it FOUND is the verdict,
       and the verdict is deliberately unsurfaceable. The row stays in the
       shadow log for a person to weigh.

       The quiet fixture the rest of this file uses is exactly this case —
       a log clean enough to resolve a quarter of the athlete's rate
       inside a year. */
    const resolved = ctx(bench((w) => 0.004 + wobble(w), { weeks: 45 }))
    const verdict = chestOf(resolved)!
    expect(verdict.detectable).toBeLessThanOrEqual(
      (verdict.inputs.weeklyProgression as number) / RESOLUTION_TARGET,
    )
    expect(resolutionOf(resolved)).toBeUndefined()
  })

  it('says nothing on an empty history', () => {
    expect(doseResolutions(ctx([], { history: {} }))).toEqual([])
  })
})

describe('the resolution report is the safe read, and still off', () => {
  const drift = (() => {
    const rand = seededRandom(17)
    const out: number[] = []
    let x = 0
    for (let i = 0; i < 300; i++) {
      x = 0.75 * x + (rand() - 0.5) * 2 * 0.003
      out.push(x)
    }
    return out
  })()
  const underPowered = () => ctx(bench((w) => 0.004 + drift[w], { weeks: 45 }))

  it('surfaces nothing today', () => {
    expect(doseResolutionNote(underPowered())).toBeNull()
  })

  it('surfaces under its own flag, and only its own', () => {
    expect(doseResolutionNote(underPowered(), { dose_resolution: true })).toContain('more weeks')
    expect(doseResolutionNote(underPowered(), { minimum_effective_dose: true })).toBeNull()
  })

  it('carries no verdict even when switched on', () => {
    /* The point of the whole change: turning this on is safe, because
       there is no claim in it to be wrong about. */
    const live = doseResolutionNote(underPowered(), { dose_resolution: true })!
    expect(live).not.toMatch(/the same|no difference|equivalent/i)
  })

  it('leads with the muscle closest to being answerable', () => {
    const rows = doseResolutions(underPowered())
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1].weeksNeeded).toBeLessThanOrEqual(rows[i].weeksNeeded)
    }
  })
})
