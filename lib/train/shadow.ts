/**
 * Compute everything. Show nothing. Keep the receipts.
 *
 * The two findings that use this — minimum effective dose and transfer
 * between lifts — are the two most likely to be ACTED on. Somebody told
 * "you progressed the same on twelve sets as on eighteen" may cut their
 * training by a third. That is a large intervention to make on the back
 * of a gate nobody has ever validated, and the only way to validate one
 * is to watch it run against real histories for months.
 *
 * So both run from day one and surface nothing. Every verdict is written
 * down with its inputs, the resampled null it was judged against, and the
 * date. A review command prints the log: what it would have said, when,
 * and on what evidence. After enough of that there is something real to
 * tune against, and turning a feature on is one boolean.
 *
 * THE ONE DOOR. `surface()` is the only function in the engine that turns
 * a verdict into a sentence anybody reads. Nothing else may read
 * `verdict.text`. That is what makes "switching on is one flag, not a
 * rewrite" true rather than aspirational: there is exactly one place the
 * flag is consulted, and exactly one place it could be bypassed.
 *
 * Pure and DOM-free.
 */

/**
 * The flags. Both false, and both stay false until a shadow log says
 * otherwise.
 *
 * Flipping one of these here is the entire change required to ship a
 * feature — no call sites move, no plumbing is added. The `overrides`
 * argument on isLive/surface exists so tests can exercise the live path
 * without editing this object, which would make the shipped default
 * un-testable.
 */
export const SHADOW_FEATURES = {
  minimum_effective_dose: false,
  transfer_between_lifts: false,
  dose_resolution: false,
} as const

export type ShadowFeature = keyof typeof SHADOW_FEATURES
export type ShadowOverrides = Partial<Record<ShadowFeature, boolean>>

/**
 * Features whose VERDICT may ever become a sentence an athlete reads.
 *
 * minimum_effective_dose is deliberately absent, and this is the load-
 * bearing line rather than a preference.
 *
 * Its verdict is an equivalence claim — "you progressed the same on 12
 * sets as on 18" — and the calibration says it cannot tell a true ratio
 * of 1.0 from 1.25 at any sample size a real person will produce. The
 * sentence carried its own bound for that reason, and a bound is a
 * caveat: people read the headline and discount the qualifier, and the
 * action this particular headline invites is cutting a third of their
 * training. A verdict whose correctness depends on the reader honouring
 * a caveat is not a verdict worth shipping.
 *
 * So dose reports RESOLUTION instead — what its log can and cannot tell
 * apart, and what would make the question answerable. That is true,
 * useful, and unactionable in the dangerous direction. The verdict is
 * still computed and still logged, so the shadow log can answer later
 * whether the band ever narrows; putting it back is a deliberate
 * decision made on that evidence, and it starts here.
 */
export const SURFACEABLE: ShadowFeature[] = ['transfer_between_lifts']


export interface ShadowVerdict {
  feature: ShadowFeature
  /** What the verdict is about: a muscle, or a pair of lifts. */
  subject: string
  /** The date it was computed for. */
  date: string
  /** Whether the statistics cleared. Logged either way. */
  would: boolean
  /** What it WOULD have said. Read only by surface() and the review. */
  text: string
  effect: number
  p: number
  z: number
  nullMean: number
  nullSd: number
  iterations: number
  blocks: number
  /** The numbers the effect was computed from, for reading back later. */
  inputs: Record<string, unknown>
  /** Named, not hidden: deloads, layoffs, programme changes, imports. */
  confounds: string[]
}

export interface ShadowLog {
  entries: ShadowVerdict[]
}

/**
 * TUNING TARGET. Verdicts kept.
 *
 * Roughly sixteen rows a week in practice — a handful of muscles with
 * enough history for dose, plus eleven curated pairs for transfer,
 * dated weekly. A thousand is about fifteen months of that, at maybe
 * 350KB, which is a lot for one slot but is the whole dataset these two
 * features are meant to be tuned against.
 *
 * Fifteen months is also the point at which the log starts dropping its
 * oldest rows, so exporting it is part of the tuning workflow rather
 * than an afterthought. See docs/train-verification.md.
 */
export const MAX_LOG_ENTRIES = 1000

export const emptyLog = (): ShadowLog => ({ entries: [] })

/** Whether a feature may speak. False for everything, today. */
export function isLive(feature: ShadowFeature, overrides?: ShadowOverrides): boolean {
  if (overrides && feature in overrides) return !!overrides[feature]
  return !!SHADOW_FEATURES[feature]
}

/**
 * The only door from a verdict to a sentence.
 *
 * Null while shadowed, null when the statistics did not clear, and the
 * text otherwise. A caller cannot accidentally leak a shadow verdict by
 * forgetting a check, because reading the text at all means coming
 * through here.
 */
export function surface(
  verdict: ShadowVerdict | null | undefined,
  overrides?: ShadowOverrides,
): string | null {
  if (!verdict || !verdict.would) return null
  /* Checked BEFORE the flag, and that order is the point: a feature left
     off this list cannot be switched on by flipping its flag, which is
     what makes the exclusion above a guarantee rather than a default. */
  if (!SURFACEABLE.includes(verdict.feature)) return null
  if (!isLive(verdict.feature, overrides)) return null
  return verdict.text
}

const keyOf = (v: ShadowVerdict) => `${v.feature}:${v.subject}:${v.date}`

/**
 * Write a verdict down, once.
 *
 * Returns whether it was written, the same way recordPrediction does —
 * a silent refusal is indistinguishable from a write, and the caller has
 * no other way to tell.
 */
export function recordVerdict(log: ShadowLog, verdict: ShadowVerdict): boolean {
  if (!log || !Array.isArray(log.entries)) return false
  if (!verdict || !verdict.feature || !verdict.subject || !verdict.date) return false

  const key = keyOf(verdict)
  if (log.entries.some((e) => keyOf(e) === key)) return false

  log.entries.push({ ...verdict, confounds: [...(verdict.confounds || [])] })
  /* Oldest out. A log that drops the NEWEST when full would go quietly
     stale and keep answering questions about last year. */
  while (log.entries.length > MAX_LOG_ENTRIES) log.entries.shift()
  return true
}

export interface ReviewOptions {
  feature?: ShadowFeature
  /** Only verdicts on or after this date. */
  since?: string
}

/**
 * A number, printed without throwing its information away.
 *
 * Rounding to three decimal places was the first version, and it turned
 * a whole log into zeros: the quantities these findings work in are
 * fractional weekly changes, so a detectable difference of 0.0003 —
 * three hundredths of a percent a week, the entire point of the row —
 * printed as `0`. A log is evidence, and evidence that rounds to nothing
 * is not evidence.
 *
 * Significant figures rather than decimal places, so the scale of the
 * number decides how it is shown.
 */
const n = (x: number) => {
  if (!Number.isFinite(x)) return '?'
  if (x === 0) return '0'
  const rounded = Number(x.toPrecision(3))
  /* Plain notation for anything a person reads as a number; exponent
     only where the alternative is a screenful of zeros. */
  return Math.abs(rounded) < 1e-4 ? rounded.toExponential(2) : String(rounded)
}

/**
 * The log, as lines somebody can read.
 *
 * Deliberately prints the verdicts that would have stayed SILENT as well.
 * A review of only the hits cannot answer the question that matters —
 * how often would this have spoken, and on what — and a feature that
 * fires every week is as wrong as one that never fires.
 */
export function reviewLines(log: ShadowLog | null | undefined, opts: ReviewOptions = {}): string[] {
  const all = (log && Array.isArray(log.entries) ? log.entries : [])
    .filter((e) => !opts.feature || e.feature === opts.feature)
    .filter((e) => !opts.since || e.date >= opts.since)
    .sort((a, b) => a.date.localeCompare(b.date) || a.subject.localeCompare(b.subject))

  const head = opts.feature
    ? `Shadow log — ${opts.feature.replace(/_/g, ' ')}`
    : 'Shadow log — everything below was computed and never shown to you.'

  if (!all.length) {
    return [head, '', 'Nothing logged yet. These findings need months of history before they can say anything.']
  }

  const out: string[] = [head, '']
  for (const e of all) {
    out.push(`${e.date}  ${e.feature}  ${e.subject}`)
    out.push(`  ${e.would ? 'WOULD HAVE SAID' : 'stayed silent'}: ${e.text}`)
    out.push(`  effect ${n(e.effect)}  p=${n(e.p)}  z=${n(e.z)}  null ${n(e.nullMean)} ± ${n(e.nullSd)}  (${e.blocks} blocks, ${e.iterations} resamples)`)
    const inputs = Object.entries(e.inputs || {}).map(([k, v]) => `${k}=${String(v)}`).join('  ')
    if (inputs) out.push(`  from: ${inputs}`)
    if ((e.confounds || []).length) out.push(`  confounds: ${e.confounds.join('; ')}`)
    out.push('')
  }

  const fired = all.filter((e) => e.would).length
  out.push(`${all.length} verdicts logged, ${fired} would have fired. None were shown.`)
  return out
}
