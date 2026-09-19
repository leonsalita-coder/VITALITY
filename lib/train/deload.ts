/**
 * Deload as a state machine.
 *
 * Dropping the weight once and walking away is a loop, not a fix: the next
 * session is clean at the reduced weight, normal progression bumps it
 * straight back, and three sessions later the lifter is standing in the
 * same plateau with the same drop about to fire again. The cure has to have
 * a duration and a planned way out.
 *
 *   normal → flagged → deloading (held N sessions) → reapproach → normal
 *
 * `flagged` exists so a one-off bad week is not treated as a stall: the
 * plateau has to still be there next time we look. `reapproach` exists so
 * the lifter walks back up to their working weight instead of being
 * teleported into the plateau they just left.
 *
 * Pure and DOM-free. Every date is a local YYYY-MM-DD string.
 *
 * UNITS: pounds.
 */

import { entryScore, workingRpe, type HistoryEntry, type SetKind } from './sets'
import { deloadCut } from './targets'
import type { TrainingAge } from './onboarding'
import { amrapTrend } from './amrap'
import { restTrend } from './timing'

/** Sessions to sit at the reduced load before climbing back. */
export const DELOAD_HOLD_SESSIONS = 2

/** Below this, a stall is fatigue rather than a programming problem. */
export const RECOVERY_FLOOR = 55

/** At or above this, the lifter is grinding and the weight is the problem. */
export const HIGH_RPE = 9

/** Sessions of the same weight and reps that count as stalled. */
const PLATEAU_WINDOW = 3

/** After finishing a deload, do not re-flag the same lift for this long. */
const COOLDOWN_DAYS = 14

export type DeloadState = 'normal' | 'flagged' | 'deloading' | 'reapproach'

/**
 * Two different diagnoses that happen to look identical on a chart.
 * Low recovery means the lifter cannot absorb the work they are already
 * doing, so the answer is less work at the same load. A technical stall at
 * high RPE means the load is past what they can move well, so the answer is
 * less load. Prescribing one for the other makes things worse.
 */
export type DeloadKind = 'volume' | 'intensity'

/** Whether real signal drove this, or only the shape of the history. */
export type DeloadConfidence = 'measured' | 'inferred'

export interface DeloadRecord {
  state: DeloadState
  kind: DeloadKind | null
  /** The working weight to climb back to. */
  priorWeight: number
  /** Date this state was entered. */
  since: string
  /** Sessions logged in this state. */
  sessions: number
  confidence: DeloadConfidence
  /** No re-flagging before this date, so the machine cannot cycle. */
  cooldownUntil?: string
}

export interface ExclusionWindow {
  from: string
  to: string
}

export interface DeloadContext {
  history: HistoryEntry[]
  today: string
  /** Rolling recovery score 0–100, or null when nothing is connected. */
  recovery: number | null
  /** Average RPE of the last session's working sets, or null. */
  rpe: number | null
  /** Stretches the lifter marked as sick or travelling. */
  excluded?: ExclusionWindow[]
  /** True when a session was logged since the last evaluation. */
  sessionLogged?: boolean
}

/** Inclusive on both ends — a window the lifter drew around a bad stretch. */
export function isExcluded(date: string, windows: ExclusionWindow[] = []): boolean {
  return (windows || []).some((w) => date >= w.from && date <= w.to)
}

/**
 * Why the lift stopped moving. Flat weight at RPE 7 and flat weight at
 * RPE 10 are the same chart and opposite problems: one lifter is not being
 * pushed, the other cannot absorb what they are already doing.
 */
export type PlateauCause = 'fatigue' | 'programming' | 'unknown' | 'rest_compression'

export interface Plateau {
  sessions: number
  /** The stalled value, in the unit this kind measures — lb, seconds,
   *  metres, reps, or pounds of assistance. */
  weight: number
  kind: SetKind
  cause: PlateauCause
  /** Mean RPE across the window, or null when it was never logged. */
  rpe: number | null
  /**
   * The all-out set has been going down across the window.
   *
   * A clearer stall signal than flat working sets, because flat working
   * sets are what a lifter produces when they are FOLLOWING the
   * programme — the number that moves is the one nobody was pacing.
   * False when nothing was flagged, so a lifter who never uses AMRAP
   * reads exactly as before.
   */
  amrapFalling: boolean
  /**
   * Rest between working sets has been falling across the stall.
   *
   * False when nothing was timed, which is not the same as false when
   * rest was steady — see cause, which only says 'rest_compression' on
   * observed timing.
   */
  restCompressing: boolean
}

/** A rise of this much across the window reads as accumulating fatigue. */
const RPE_RISE = 1

function readCause(
  window: HistoryEntry[],
): { cause: PlateauCause; rpe: number | null; amrapFalling: boolean; restCompressing: boolean } {
  const values = window.map(workingRpe).filter((v): v is number => v != null)
  const mean = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null

  /* Output first. A falling all-out set at a constant load is a lifter
     getting weaker under a weight that looks perfectly stable in the log,
     and it is measured rather than self-reported — so it outranks the RPE
     read below rather than being averaged with it. */
  const trend = amrapTrend(window)
  if (trend && trend.falling) {
    return { cause: 'fatigue', rpe: mean, amrapFalling: true, restCompressing: false }
  }

  /* Rushing the rest, which is measured too and which nothing else here
     could see. It is checked before the RPE read because the answer is
     different in kind: the lift is not too heavy, the lifter is not
     recovering between sets, and cutting the weight would treat a
     stopwatch problem as a strength problem. */
  const rest = restTrend(window)
  if (rest && rest.compressing) {
    return { cause: 'rest_compression', rpe: mean, amrapFalling: false, restCompressing: true }
  }

  // a trend needs at least two points; one lonely RPE proves nothing
  if (values.length < 2) {
    return {
      cause: 'unknown', rpe: values.length ? values[0] : null,
      amrapFalling: false, restCompressing: false,
    }
  }
  const rising = values[values.length - 1] - values[0] >= RPE_RISE
  if (rising || (mean as number) >= HIGH_RPE) {
    return { cause: 'fatigue', rpe: mean, amrapFalling: false, restCompressing: false }
  }
  return { cause: 'programming', rpe: mean, amrapFalling: false, restCompressing: false }
}

/**
 * Weight AND top reps flat-or-down across the window. Needs one session
 * beyond it so a stall is never called from someone's first few attempts,
 * and reads working sets only — a warm-up never proves anything.
 */
export function detectPlateau(
  history: HistoryEntry[],
  opts: {
    excluded?: ExclusionWindow[]
    /** Lets bodyweight lifts be scored on real load rather than reps. */
    bodyweightLb?: number | null
    bodyweightFactor?: number | null
  } = {},
): Plateau | null {
  const usable = (history || []).filter(
    (entry) => entry && !entry.off && !isExcluded(entry.date, opts.excluded),
  )
  if (usable.length < PLATEAU_WINDOW + 1) return null
  const recent = usable.slice(-PLATEAU_WINDOW)
  /**
   * entryScore normalises every kind so higher is always better, including
   * assisted work where LESS assistance is the improvement. Comparing raw
   * weights here instead would read a lifter dropping from 40 lb of help to
   * 20 as a decline, and deload them for getting stronger.
   */
  /* Explicit arrow, not a bare reference: map passes the index as the
     second argument, which would land in the options slot. */
  const scores = recent.map((entry) => entryScore(entry, {
    bodyweightLb: opts.bodyweightLb,
    bodyweightFactor: opts.bodyweightFactor,
  }))
  const flat = (arr: number[]) => arr.every((v, i) => i === 0 || v <= arr[i - 1])
  const primary = scores.map((s) => s.primary)
  const secondary = scores.map((s) => s.secondary)
  if (flat(primary) && flat(secondary)) {
    const { cause, rpe, amrapFalling, restCompressing } = readCause(recent)
    const last = scores[scores.length - 1]
    return {
      sessions: PLATEAU_WINDOW,
      // reported in the kind's own unit; assisted scores are negated
      weight: Math.abs(last.primary),
      kind: last.kind,
      cause,
      rpe,
      amrapFalling,
      restCompressing,
    }
  }
  return null
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const dt = new Date(y, (m || 1) - 1, d || 1)
  dt.setDate(dt.getDate() + days)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`
}

function diagnose(
  ctx: DeloadContext,
  plateau: Plateau | null,
): { kind: DeloadKind; confidence: DeloadConfidence } {
  if (typeof ctx.recovery === 'number' && ctx.recovery < RECOVERY_FLOOR) {
    return { kind: 'volume', confidence: 'measured' }
  }
  if (typeof ctx.rpe === 'number' && ctx.rpe >= HIGH_RPE) {
    return { kind: 'intensity', confidence: 'measured' }
  }
  /* RPE across the stall itself, when the lifter has been logging it. */
  if (plateau && plateau.cause === 'fatigue') {
    return { kind: 'intensity', confidence: 'measured' }
  }
  /**
   * No recovery data and no RPE. The plateau is real but the cause is a
   * guess, so this is marked inferred — which buys a gentler cut in
   * deloadPlan() rather than a different decision here. Being wrong about
   * *why* is cheap; being aggressive about it is not.
   */
  return { kind: 'intensity', confidence: 'inferred' }
}

const NORMAL = (weight: number, today: string): DeloadRecord => ({
  state: 'normal',
  kind: null,
  priorWeight: weight,
  since: today,
  sessions: 0,
  confidence: 'measured',
})

/** Advances one lift's deload state. Call once per evaluation, not per set. */
export function nextDeloadState(
  current: DeloadRecord | null,
  ctx: DeloadContext,
): DeloadRecord {
  const plateau = detectPlateau(ctx.history, { excluded: ctx.excluded })
  const record: DeloadRecord =
    current || NORMAL(plateau ? plateau.weight : 0, ctx.today)

  switch (record.state) {
    case 'normal': {
      if (!plateau) return record
      if (record.cooldownUntil && ctx.today < record.cooldownUntil) return record
      /**
       * Steady, comfortable RPE at a flat load is not fatigue — the lifter
       * has capacity and is simply not being asked for it. Deloading them
       * would take away stimulus they already are not getting enough of.
       * Only act when there is real evidence; 'unknown' still flags.
       */
      if (plateau.cause === 'programming') return record
      /* Rushing rest is a stopwatch problem, not a strength problem. The
         lift is not too heavy; the lifter is not recovering between sets.
         Cutting the weight would "fix" it by removing the stimulus, the
         rest would stay rushed, and the next stall would arrive lighter.
         So this never reaches the state machine at all. */
      if (plateau.cause === 'rest_compression') return record
      /* Diagnose on the way in as well as on the way out, so a flagged
         record already says what it thinks is wrong. It is re-diagnosed at
         the moment of acting, which is where the freshest data lives. */
      const flagDx = diagnose(ctx, plateau)
      return {
        ...record,
        state: 'flagged',
        kind: flagDx.kind,
        confidence: flagDx.confidence,
        priorWeight: plateau.weight,
        since: ctx.today,
        sessions: 0,
      }
    }

    case 'flagged': {
      // the stall broke on its own — nothing to treat
      if (!plateau) return { ...record, state: 'normal', kind: null, since: ctx.today, sessions: 0 }
      const { kind, confidence } = diagnose(ctx, plateau)
      return {
        ...record,
        state: 'deloading',
        kind,
        confidence,
        priorWeight: plateau.weight,
        since: ctx.today,
        sessions: 0,
      }
    }

    case 'deloading': {
      if (!ctx.sessionLogged) return record
      const sessions = record.sessions + 1
      if (sessions < DELOAD_HOLD_SESSIONS) return { ...record, sessions }
      return { ...record, state: 'reapproach', since: ctx.today, sessions: 0 }
    }

    case 'reapproach': {
      if (!ctx.sessionLogged) return record
      return {
        ...record,
        state: 'normal',
        kind: null,
        since: ctx.today,
        sessions: 0,
        // a lift that just finished a deload must not immediately re-flag,
        // or the machine oscillates instead of resolving
        cooldownUntil: addDays(ctx.today, COOLDOWN_DAYS),
      }
    }
  }
  return record
}

export interface DeloadPlan {
  /** Suggested weight, or null when this state does not touch it. */
  weight: number | null
  /** Multiplier on the prescribed set count. */
  setsFactor: number
}

const VOLUME_CUT = 2 / 3
const REAPPROACH = 0.95

/** What the current state actually prescribes. */
export function deloadPlan(
  record: DeloadRecord | null,
  trainingAge?: TrainingAge | null,
): DeloadPlan {
  if (!record) return { weight: null, setsFactor: 1 }
  const round = (n: number) => Math.round(n * 100) / 100

  if (record.state === 'reapproach') {
    return { weight: round(record.priorWeight * REAPPROACH), setsFactor: 1 }
  }
  if (record.state !== 'deloading') return { weight: null, setsFactor: 1 }

  if (record.kind === 'volume') {
    // same load, less of it — the lifter can move this weight, they just
    // cannot currently absorb this much of it
    return { weight: round(record.priorWeight), setsFactor: VOLUME_CUT }
  }
  return {
    weight: round(record.priorWeight * deloadCut(trainingAge, record.confidence)),
    setsFactor: 1,
  }
}

/**
 * What this stall calls for, in one sentence.
 *
 * The rest-compression case is the reason this exists: every other cause
 * ends in some version of "do less", and this one ends in "wait longer" —
 * saying the wrong one would send a lifter to cut a weight they can
 * actually lift.
 */
export function plateauAdvice(plateau: Plateau | null): string {
  if (!plateau) return ''
  if (plateau.cause === 'rest_compression') {
    return 'Rest between sets has been getting shorter. Rest longer before the next set — the weight is not the problem.'
  }
  if (plateau.cause === 'fatigue') {
    return plateau.amrapFalling
      ? 'Your all-out set has been falling at the same weight. That is fatigue, not programming.'
      : 'Effort has been climbing at the same weight. That is fatigue.'
  }
  if (plateau.cause === 'programming') {
    return 'Steady effort at a flat weight — there is capacity here that is not being asked for.'
  }
  return 'Flat for a while, with nothing logged that says why.'
}

export interface DeloadCandidate {
  id: string
  weight: number
  plateauLength: number
}

/**
 * At most two lifts drop in one session.
 *
 * A session where four exercises all came down reads as failure no matter
 * how defensible each individual drop was, and the lifter stops trusting
 * the system that did it to them. Longest-running stalls go first, ties
 * broken by the heavier lift, where standing still costs the most.
 */
export function limitDeloads(candidates: DeloadCandidate[], max = 2): string[] {
  return (candidates || [])
    .slice()
    .sort((a, b) => b.plateauLength - a.plateauLength || b.weight - a.weight)
    .slice(0, max)
    .map((c) => c.id)
}
