/**
 * "What if I trained three days instead of four?"
 *
 * This engine can answer that and most cannot, for one structural reason:
 * every function in it is pure and takes `now` as an argument, so the
 * whole thing can be replayed forward over a history that has not
 * happened. An app with its progression rules tangled into a React
 * component has nothing to replay.
 *
 * TWO RULES.
 *
 * IT USES THE REAL ENGINE. suggestTarget decides every projected weight
 * here, exactly as it does in the app. A separate simulation path is
 * worse than no simulation at all: it drifts, and then it produces
 * confident answers about an engine nobody is running. There is
 * deliberately no increment arithmetic anywhere in this file — when the
 * projection wants to know the next weight, it asks.
 *
 * IT IS A PROJECTION, and says so on every row. Projected sessions carry
 * `projected: true` and are dated in the future, so a read that ever did
 * merge them into real history would find the flag on every one. The
 * mistake is detectable rather than silent.
 *
 * Pure and DOM-free.
 */

import { suggestTarget, type ProgressionExercise } from './progression'
import { epley1RM } from './records'
import { dateKey } from './windows'
import type { HistoryEntry } from './sets'

const DAY_MS = 86_400_000

export interface SimulatedExercise extends ProgressionExercise {
  id: string
  /** Muscles this lift trains, for the volume projection. */
  muscles?: string[]
}

export interface Scenario {
  name: string
  weeks: number
  sessionsPerWeek: number
  setsPerSession: number
  exercise: SimulatedExercise
  /**
   * Deload every N weeks, or null for none.
   *
   * A scenario without one is not a recommendation — it is the question
   * "what would the numbers look like", which is a thing worth being able
   * to ask before deciding.
   */
  deloadEvery?: number | null
}

export interface ProjectedSession {
  date: string
  weight: number
  reps: number
  sets: number
  /** Always true. Present on every row so a mix-up cannot be silent. */
  projected: true
}

export interface Projection {
  name: string
  weeks: number
  sessions: ProjectedSession[]
  startingE1rm: number
  projectedE1rm: number
  /** Mean weekly hard sets per muscle across the projection. */
  weeklyVolumeByMuscle: Record<string, number>
  /** Always true. */
  projected: true
}

/** Deload weeks drop the load; the engine is asked what to do after. */
const DELOAD_FACTOR = 0.9

/**
 * Run the engine forward.
 *
 * Each projected session is appended to a working copy of the history and
 * the next suggestion is read from it, which is precisely what the app
 * does one session at a time — the only difference is that nobody is
 * lifting.
 */
export function simulate(
  history: HistoryEntry[] | null | undefined,
  scenario: Scenario,
  now: number,
): Projection {
  /* A copy, always. Simulating must not touch the history it was handed —
     that is the difference between a projection and a corruption. */
  const working: HistoryEntry[] = (history || []).map((e) => ({
    ...e, sets: (e.sets || []).map((s) => ({ ...s })),
  }))

  const startingE1rm = bestE1rm(working)
  const sessions: ProjectedSession[] = []
  const weeks = Math.max(1, Math.floor(scenario.weeks || 1))
  const perWeek = Math.max(1, Math.floor(scenario.sessionsPerWeek || 1))
  const setCount = Math.max(1, Math.floor(scenario.setsPerSession || 1))
  const spacing = Math.max(1, Math.floor(7 / perWeek))

  let dayOffset = 1
  for (let week = 0; week < weeks; week++) {
    const deloadWeek = !!scenario.deloadEvery && (week + 1) % scenario.deloadEvery === 0

    for (let i = 0; i < perWeek; i++) {
      const date = dateKey(now + dayOffset * DAY_MS)
      dayOffset += spacing

      /* THE REAL ENGINE decides the weight. Every scenario knob changes
         the history it reads, never the rule it applies. */
      const suggestion = suggestTarget(working, { ...scenario.exercise, sets: setCount }, now + dayOffset * DAY_MS)
      const weight = deloadWeek
        ? Math.round((suggestion.weight ?? scenario.exercise.kg ?? 0) * DELOAD_FACTOR)
        : suggestion.weight ?? scenario.exercise.kg ?? 0
      const reps = suggestion.reps ?? scenario.exercise.reps

      sessions.push({ date, weight, reps, sets: setCount, projected: true })
      working.push({
        date, kg: weight,
        sets: Array.from({ length: setCount }, () => ({ w: weight, r: reps })),
      })
    }
  }

  /* Counted FROM the projected sessions, not recomputed from the knobs
     that produced them. Deriving it arithmetically was the first version
     and it was a second source of truth: a change to what the projection
     actually contains could not move the volume figure, which is the
     duplicate-authority problem in miniature. */
  const muscles = scenario.exercise.muscles || []
  const projectedSets = sessions.reduce((n, s) => n + s.sets, 0)
  const weeklyVolumeByMuscle: Record<string, number> = {}
  for (const muscle of muscles) {
    weeklyVolumeByMuscle[muscle] = Math.round((projectedSets / weeks) * 10) / 10
  }

  return {
    name: scenario.name,
    weeks,
    sessions,
    startingE1rm,
    projectedE1rm: bestE1rm(working),
    weeklyVolumeByMuscle,
    projected: true,
  }
}

function bestE1rm(entries: HistoryEntry[]): number {
  let best = 0
  for (const entry of entries) {
    for (const set of entry.sets || []) {
      if (set.warmup) continue
      const e1 = epley1RM(set.w ?? entry.kg ?? 0, set.r ?? 0)
      if (e1 != null && e1 > best) best = e1
    }
  }
  return Math.round(best * 10) / 10
}

export interface ScenarioComparison {
  a: Projection
  b: Projection
  /** b minus a. */
  e1rmDelta: number
  volumeDelta: Record<string, number>
  text: string
}

/**
 * Two futures, side by side.
 *
 * Both are projections and the sentence says so. A comparison phrased as
 * fact — "four days gets you twenty pounds" — would be the app asserting
 * something no model can know.
 */
export function compareScenarios(
  history: HistoryEntry[] | null | undefined,
  a: Scenario,
  b: Scenario,
  now: number,
): ScenarioComparison {
  const left = simulate(history, a, now)
  const right = simulate(history, b, now)

  const volumeDelta: Record<string, number> = {}
  const muscles = new Set([
    ...Object.keys(left.weeklyVolumeByMuscle),
    ...Object.keys(right.weeklyVolumeByMuscle),
  ])
  for (const muscle of muscles) {
    volumeDelta[muscle] = Math.round(
      ((right.weeklyVolumeByMuscle[muscle] || 0) - (left.weeklyVolumeByMuscle[muscle] || 0)) * 10,
    ) / 10
  }

  const e1rmDelta = Math.round((right.projectedE1rm - left.projectedE1rm) * 10) / 10
  const direction = e1rmDelta === 0 ? 'the same' : e1rmDelta > 0 ? `${e1rmDelta} lb higher` : `${Math.abs(e1rmDelta)} lb lower`

  return {
    a: left,
    b: right,
    e1rmDelta,
    volumeDelta,
    text: `Over ${right.weeks} weeks, "${b.name}" projects ${direction} than "${a.name}". Both are projections from your own numbers, not promises.`,
  }
}
