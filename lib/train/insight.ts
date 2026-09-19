/**
 * Whether there is anything worth saying, and what.
 *
 * The post-session note spoke every time, which guarantees it will often
 * say something generic. A reader who gets three "great work, you hit 3
 * sets!" lines stops reading the fourth — including the one that mattered.
 * Speaking only when the maths found something is what buys the attention
 * for the times it has.
 *
 * The division of labour is strict: SIGNALS ARE DETERMINISTIC. The model
 * phrases what was found and never decides whether there was anything to
 * find. That keeps the gate honest — a model asked "is this interesting?"
 * will always say yes.
 *
 * Every signal carries the number it rests on. "Chest took 26 hard sets
 * this week, above the band" is worth reading; "you're training hard
 * lately" is not.
 *
 * Pure and DOM-free.
 */

import { analyse, type ExerciseIndex, type Finding, type History } from './analysis'
import type { TrainingAge } from './onboarding'

export type SignalKind =
  | 'deload_applied'
  | 'plateau'
  | 'ratio'
  | 'volume_ramp'
  | 'personal_record'
  | 'weekly_sets'
  | 'frequency_gap'
  | 'streak_milestone'
  | 'first_time'

export interface Signal {
  kind: SignalKind
  /** The deterministic sentence, with its number in it. */
  text: string
  /** The figure the sentence is built on, for traceability. */
  value: number | string
  estimated: boolean
}

export interface SignalContext {
  history: History
  index: ExerciseIndex
  now: number
  today: string
  /** Records set in this session. */
  records: Array<{ name: string; kind: string; value: number; unit: string }>
  /** Deloads that began as a result of this session. */
  deloadsApplied: Array<{ name: string; from: number; to: number; kind: string }>
  /** Plateaus detected on lifts trained today. */
  plateaus: Array<{ name: string; sessions: number; weight: number }>
  streak: number
  weeklyTarget: number
  /** Scales the volume bands. Absent means the shipped numbers. */
  trainingAge?: TrainingAge | null
  /** Lifts logged for the very first time today. */
  firsts: string[]
}

/**
 * Most important first.
 *
 * Things that changed the athlete's programme outrank things that merely
 * happened, and risk outranks celebration — a push:pull of 4:1 matters more
 * than a rep PR even though the PR feels better to read. The one exception
 * to "risk first" is a deload, which must be reported because the app has
 * already acted on their behalf and they are owed the reason.
 */
const PRIORITY: SignalKind[] = [
  'deload_applied',
  'plateau',
  'ratio',
  'volume_ramp',
  'personal_record',
  'weekly_sets',
  'frequency_gap',
  'streak_milestone',
  'first_time',
]

const round = (n: number) => Math.round(n * 10) / 10

function fromFinding(finding: Finding): Signal | null {
  const kind: SignalKind | null =
    finding.kind === 'ratio' ? 'ratio'
    : finding.kind === 'volume_ramp' ? 'volume_ramp'
    : finding.kind === 'weekly_sets' ? 'weekly_sets'
    : finding.kind === 'frequency_gap' ? 'frequency_gap'
    : null
  if (!kind) return null
  const number = finding.text.match(/[\d.]+/)
  return {
    kind,
    text: finding.text,
    value: number ? Number(number[0]) : finding.text,
    estimated: finding.estimated,
  }
}

/** Streaks worth remarking on, rather than every week that ticks over. */
function streakMilestone(streak: number, target: number): Signal | null {
  if (streak < 2) return null
  if (streak !== 2 && streak % 4 !== 0) return null
  return {
    kind: 'streak_milestone',
    text: `That is ${streak} weeks running at ${target}+ sessions.`,
    value: streak,
    estimated: false,
  }
}

/** Everything the maths actually found. Empty is the common case. */
export function collectSignals(ctx: SignalContext): Signal[] {
  const signals: Signal[] = []

  for (const d of ctx.deloadsApplied || []) {
    signals.push({
      kind: 'deload_applied',
      text: `${d.name} moved from ${round(d.from)} to ${round(d.to)} lb — ${d.kind === 'intensity' ? 'an' : 'a'} ${d.kind} deload, applied automatically.`,
      value: round(d.to),
      estimated: false,
    })
  }

  for (const p of ctx.plateaus || []) {
    signals.push({
      kind: 'plateau',
      text: `${p.name} has been flat at ${round(p.weight)} for ${p.sessions} sessions.`,
      value: round(p.weight),
      estimated: false,
    })
  }

  for (const r of ctx.records || []) {
    signals.push({
      kind: 'personal_record',
      text: `${r.name}: ${round(r.value)}${r.unit} is ${/^[aeiou]/i.test(r.kind) ? 'an' : 'a'} ${r.kind} record.`,
      value: round(r.value),
      estimated: false,
    })
  }

  for (const finding of analyse(ctx.history, ctx.index, ctx.now, { trainingAge: ctx.trainingAge })) {
    const signal = fromFinding(finding)
    if (signal) signals.push(signal)
  }

  const milestone = streakMilestone(ctx.streak, ctx.weeklyTarget)
  if (milestone) signals.push(milestone)

  for (const name of ctx.firsts || []) {
    signals.push({
      kind: 'first_time',
      text: `First time logging ${name}. There is a baseline now.`,
      value: name,
      estimated: false,
    })
  }

  return signals
}

/**
 * The one worth saying, or nothing.
 *
 * One per session, deliberately. A list of four observations is a report,
 * and nobody reads a report after training.
 */
export function chooseSignal(signals: Signal[]): Signal | null {
  if (!signals || !signals.length) return null
  const ranked = [...signals].sort(
    (a, b) => PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind),
  )
  return ranked[0]
}

export interface InsightBrief {
  /** The sentence the maths produced. Rendered as-is if no model answers. */
  fact: string
  /** What the model is asked to phrase. Null means do not ask at all. */
  prompt: string | null
  signal: Signal
}

/**
 * What to hand the model, or null when there is nothing to say.
 *
 * Returning null is the gate: no signal, no API call, no note. Silence is
 * the feature, not a failure to produce output.
 */
export function briefFor(ctx: SignalContext, goal: string): InsightBrief | null {
  const signal = chooseSignal(collectSignals(ctx))
  if (!signal) return null
  return {
    fact: signal.text,
    signal,
    prompt:
      `The athlete's goal: ${goal}.\n` +
      `One thing the data shows, already verified: "${signal.text}"\n` +
      'Say that back in one short sentence, in the second person, keeping the ' +
      'number exactly as given. Add nothing the sentence does not contain. ' +
      'No greeting, no encouragement, no question.',
  }
}
