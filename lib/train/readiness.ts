/**
 * Pre-session readiness.
 *
 * Everything intelligent this app does happens after the fact: it notices a
 * plateau after three flat sessions and reports a deload once you have
 * already trained. The more valuable move is adjusting the session BEFORE
 * it starts — preventing the bad session rather than explaining it.
 *
 * Three constraints shape the whole file.
 *
 *   It reports, it does not ask. The session arrives already scaled with
 *   the reason stated as fact, exactly like the deload.
 *
 *   It stays silent without real signal. A readiness call that fires on
 *   nothing teaches you to ignore readiness calls, and then it is worse
 *   than absent.
 *
 *   It never stacks with a deload. A lift already being deloaded is
 *   already adjusted; scaling it twice is how a 10% cut becomes 30%.
 *
 * Pure and DOM-free.
 */

import {
  HARD_OTHER_LOAD, MODERATE_OTHER_LOAD, describeOther, type OtherLoadSummary,
} from './other'

/** Below this, training hard today is the wrong call. */
export const REST_FLOOR = 35
/** Below this, the athlete cannot absorb a normal volume. */
export const LOW_RECOVERY = 55
/** Below this, they can work but not at full load. */
export const MODERATE_RECOVERY = 70

/** Hard sets this week over the usual week that counts as a spike. */
export const LOAD_SPIKE = 1.5

/** Rest may be advised at most this often. */
export const REST_ADVICE_COOLDOWN_DAYS = 7

export type ReadinessVerdict = 'normal' | 'reduced_volume' | 'reduced_intensity' | 'rest_advised'

export interface ReadinessResult {
  verdict: ReadinessVerdict
  /** Multiplier on prescribed sets. */
  setsFactor: number
  /** Multiplier on prescribed weight. */
  weightFactor: number
  /** Stated as fact, or null when there is nothing to say. */
  reason: string | null
  confidence: 'measured' | 'inferred'
}

export interface ReadinessContext {
  /** Rolling recovery 0-100, or null when nothing is connected. */
  recovery: number | null
  /** Hard sets in the last seven days, or null when unknown. */
  recentHardSets: number | null
  /** The athlete's usual week, or null when there is not enough history. */
  baselineHardSets: number | null
  /** True when any lift today is mid-deload. */
  activeDeload: boolean
  /** Dates rest has already been advised on. */
  restAdvisedDates: string[]
  today: string
  /**
   * Self-reported training that isn't lifting, or null when there is none.
   *
   * It lives in the CONTEXT rather than in a function of its own on
   * purpose. Suppression has to sit behind the same deload gate every
   * other rule here sits behind, and a separate entry point is a separate
   * thing to remember to guard — which is exactly how the first attempt
   * stacked a cut onto a lift that was already being cut.
   */
  otherLoad?: OtherLoadSummary | null
}

const SILENT: ReadinessResult = {
  verdict: 'normal', setsFactor: 1, weightFactor: 1, reason: null, confidence: 'inferred',
}

function daysBetween(a: string, b: string): number {
  const parse = (s: string) => {
    const [y, m, d] = s.split('-').map(Number)
    return new Date(y, (m || 1) - 1, d || 1).getTime()
  }
  return Math.round((parse(b) - parse(a)) / 86_400_000)
}

/** Rest was advised recently enough that advising it again would be noise. */
function restIsCapped(ctx: ReadinessContext): boolean {
  return (ctx.restAdvisedDates || []).some(
    (date) => daysBetween(date, ctx.today) < REST_ADVICE_COOLDOWN_DAYS,
  )
}

/**
 * Today's verdict.
 *
 * Order matters: the deload check comes first because an adjustment already
 * in flight is the adjustment, and the silence gate comes next because
 * everything after it is an inference that needs something to infer from.
 */
export function assessReadiness(ctx: ReadinessContext): ReadinessResult {
  /* One adjustment, never two. A lift mid-deload is already carrying a cut
     and scaling it again compounds into something nobody prescribed. */
  if (ctx.activeDeload) return SILENT

  const hasRecovery = typeof ctx.recovery === 'number'
  const hasLoad =
    typeof ctx.recentHardSets === 'number' &&
    typeof ctx.baselineHardSets === 'number' &&
    ctx.baselineHardSets > 0
  const other = ctx.otherLoad || null
  const hasOther = !!other && other.load >= MODERATE_OTHER_LOAD

  // nothing to reason from; saying anything here would be invention
  if (!hasRecovery && !hasLoad && !hasOther) return SILENT

  const recovery = ctx.recovery as number
  const ratio = hasLoad ? (ctx.recentHardSets as number) / (ctx.baselineHardSets as number) : 1

  if (hasRecovery && recovery < REST_FLOOR) {
    /* A system that keeps telling you to rest gets overridden, and then
       ignored. Capped, it degrades to the next strongest call instead. */
    if (!restIsCapped(ctx)) {
      return {
        verdict: 'rest_advised',
        setsFactor: 0,
        weightFactor: 1,
        reason: `Recovery is ${Math.round(recovery)}/100. Today is a rest day.`,
        confidence: 'measured',
      }
    }
    return {
      verdict: 'reduced_volume',
      setsFactor: 0.5,
      weightFactor: 1,
      reason: `Recovery is ${Math.round(recovery)}/100 and you rested recently. Today is half the usual sets.`,
      confidence: 'measured',
    }
  }

  if (hasRecovery && recovery < LOW_RECOVERY) {
    return {
      verdict: 'reduced_volume',
      setsFactor: 0.6,
      weightFactor: 1,
      reason: `Recovery is ${Math.round(recovery)}/100. Today is scaled to 60% of the usual sets.`,
      confidence: 'measured',
    }
  }

  if (hasLoad && ratio >= LOAD_SPIKE) {
    const percent = Math.round((ratio - 1) * 100)
    return {
      verdict: 'reduced_volume',
      setsFactor: 0.75,
      weightFactor: 1,
      reason: `Hard sets are up ${percent}% on your usual week. Today is scaled back.`,
      confidence: hasRecovery ? 'measured' : 'inferred',
    }
  }

  if (hasRecovery && recovery < MODERATE_RECOVERY) {
    return {
      verdict: 'reduced_intensity',
      setsFactor: 1,
      weightFactor: 0.9,
      reason: `Recovery is ${Math.round(recovery)}/100. Weights are eased 10% today.`,
      confidence: 'measured',
    }
  }

  /* LAST, and only from silence.
   *
   * Everything above rests on a measurement. This rests on somebody
   * telling me how hard something felt, which is a crude proxy with no
   * objective anchor, so it may only speak when nothing measured had
   * anything to say. It can hold a session back; it can never advise
   * rest, because rest is the strongest call this app makes and it should
   * not turn on a self-report. And it is reached only after the
   * activeDeload gate at the top, so a lift already being cut is never
   * cut twice on the strength of an estimate. */
  if (hasOther) return suppression(other as OtherLoadSummary)

  return { ...SILENT, confidence: hasRecovery ? 'measured' : 'inferred' }
}

/**
 * What self-reported training is allowed to do, which is hold a session
 * back and nothing else. Always 'inferred', whatever else was measured
 * today — the verdict is only as sound as the number behind it.
 */
function suppression(other: OtherLoadSummary): ReadinessResult {
  const what = describeOther(other.hardest)
  const also = other.sessions > 1 ? `, plus ${other.sessions - 1} more` : ''
  /* Attributed to what they told me, in their words, because the number
     behind this is their estimate and the note must not read like a
     measurement. */
  if (other.load >= HARD_OTHER_LOAD) {
    return {
      verdict: 'reduced_volume',
      setsFactor: 0.75,
      weightFactor: 1,
      reason: `You told me about ${what}${also}. Today is scaled back.`,
      confidence: 'inferred',
    }
  }
  return {
    verdict: 'reduced_intensity',
    setsFactor: 1,
    weightFactor: 0.9,
    reason: `You told me about ${what}${also}. Weights are eased 10% today.`,
    confidence: 'inferred',
  }
}
