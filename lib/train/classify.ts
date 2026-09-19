/**
 * Validating what the classifier says.
 *
 * The exercise classifier is a language model, and its answer goes straight
 * into the data model that progression, plateau detection and PRs all read.
 * A hallucinated set kind would not fail loudly — it would silently route a
 * lift into a strategy that measures the wrong thing. So every field is
 * checked against a closed list or clamped into range, and anything
 * unexpected falls back to the shape that behaves exactly like the app did
 * before typed sets existed.
 *
 * Pure and DOM-free.
 */

import { DEFAULT_SET_KIND, type SetKind } from './sets'

/** The closed list. Anything outside it is not a set kind, whatever it says. */
export const SET_KINDS: SetKind[] = [
  'reps_weight',
  'reps_only',
  'bodyweight',
  'weighted_bodyweight',
  'time',
  'distance',
  'time_distance',
]

export interface ClassifiedExercise {
  kind: SetKind
  perSide: boolean
  assisted: boolean
  /** Null for kinds with no reps to climb. */
  repRange: [number, number] | null
  tier: number
  sets: number
  reps: number
  /** Pounds, despite the classifier's field being named kg. */
  weight: number
  rest: number
}

/**
 * A starting rep range, so double progression is live from the first
 * session rather than sitting inert until someone opens Tune.
 *
 * Compounds get a narrow range because their useful work is heavy and low;
 * accessories get a wide one because theirs is not. Kinds without a weight
 * to eventually add get no range at all — "climb to the top of the range,
 * then add load" has no second half for a plank.
 */
export function defaultRepRange(tier: number, kind: SetKind): [number, number] | null {
  if (kind !== 'reps_weight') return null
  if (tier <= 1) return [4, 6]
  if (tier >= 3) return [10, 15]
  return [6, 10]
}

function asKind(raw: unknown): SetKind {
  return typeof raw === 'string' && (SET_KINDS as string[]).includes(raw)
    ? (raw as SetKind)
    : DEFAULT_SET_KIND
}

/** Only a real boolean counts. "yes" and 1 are the model being creative. */
function asFlag(raw: unknown): boolean {
  return raw === true
}

function asNumber(raw: unknown, fallback: number, min: number, max: number): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback
  return Math.min(max, Math.max(min, n))
}

/** Turns whatever came back into a definition the engine can safely read. */
export function normalizeClassification(raw: unknown): ClassifiedExercise {
  const info = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<
    string,
    unknown
  >

  const kind = asKind(info.defaultSetKind)
  /* Tier is a closed list, not a range: 99 is nonsense, not "very
     accessory", and clamping it to 3 would hand a garbage answer a wide
     accessory rep range on the strength of it. */
  const tier = info.tier === 1 || info.tier === 2 || info.tier === 3 ? info.tier : 2
  const repRange = defaultRepRange(tier, kind)

  return {
    kind,
    perSide: asFlag(info.perSide),
    assisted: asFlag(info.assisted),
    repRange,
    tier,
    sets: Math.round(asNumber(info.startingSets, 3, 1, 8)),
    // the bottom of the range and the starting reps must agree, or the very
    // first session reads as already short of target
    reps: repRange ? repRange[0] : Math.round(asNumber(info.startingReps, 10, 1, 50)),
    weight: asNumber(info.startingKg, 0, 0, 2000),
    rest: Math.round(asNumber(info.restSeconds, 90, 30, 600)),
  }
}
