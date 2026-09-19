/**
 * Muscles, as a closed list.
 *
 * This is the exercise-identity problem one level down. The classifier
 * returns free text, so "Pecs" and "Chest" were two different muscles and
 * neither ever reached a threshold — which silently broke the recent-volume
 * constraint, the muscle breakdown, and anything reasoning about balance.
 * Nothing announced it, because a muscle that never accumulates volume
 * looks exactly like a muscle you are not training.
 *
 * Unmappable input is reported rather than dropped, for the same reason:
 * a name nobody handles should surface as a gap in the mapping, not vanish
 * into a bucket nothing reads.
 *
 * Pure and DOM-free.
 */

export type Muscle =
  | 'chest'
  | 'front_delts' | 'side_delts' | 'rear_delts'
  | 'triceps' | 'biceps' | 'forearms'
  | 'lats' | 'traps' | 'upper_back' | 'lower_back'
  | 'abs' | 'obliques'
  | 'glutes' | 'quads' | 'hamstrings' | 'adductors' | 'abductors' | 'calves'
  | 'neck' | 'full_body' | 'cardio'

export const MUSCLES: Muscle[] = [
  'chest', 'front_delts', 'side_delts', 'rear_delts',
  'triceps', 'biceps', 'forearms',
  'lats', 'traps', 'upper_back', 'lower_back',
  'abs', 'obliques',
  'glutes', 'quads', 'hamstrings', 'adductors', 'abductors', 'calves',
  'neck', 'full_body', 'cardio',
]

/** A secondary muscle gets partial credit for the work. */
export const SECONDARY_SHARE = 0.5

/**
 * Free text to the closed list.
 *
 * Generic terms are mapped to the head they most often mean in context —
 * "shoulders" in a pressing programme is almost always the front delt — and
 * flagged as inexact, so a split built on them is marked estimated rather
 * than presented as though someone specified it.
 */
const SYNONYMS: Record<string, Muscle> = {
  chest: 'chest', pecs: 'chest', pectorals: 'chest', pectoral: 'chest',
  front_delts: 'front_delts', front_delt: 'front_delts', anterior_deltoid: 'front_delts',
  side_delts: 'side_delts', lateral_deltoid: 'side_delts', medial_delts: 'side_delts',
  rear_delts: 'rear_delts', posterior_deltoid: 'rear_delts', rear_delt: 'rear_delts',
  triceps: 'triceps', tricep: 'triceps', tris: 'triceps',
  biceps: 'biceps', bicep: 'biceps', bis: 'biceps',
  forearms: 'forearms', forearm: 'forearms', grip: 'forearms',
  lats: 'lats', lat: 'lats', latissimus: 'lats',
  traps: 'traps', trapezius: 'traps',
  upper_back: 'upper_back', rhomboids: 'upper_back', mid_back: 'upper_back',
  lower_back: 'lower_back', erectors: 'lower_back', spinal_erectors: 'lower_back',
  abs: 'abs', core: 'abs', abdominals: 'abs', rectus_abdominis: 'abs',
  obliques: 'obliques', oblique: 'obliques',
  glutes: 'glutes', glute: 'glutes', butt: 'glutes',
  quads: 'quads', quadriceps: 'quads', quad: 'quads',
  hamstrings: 'hamstrings', hamstring: 'hamstrings', hams: 'hamstrings',
  adductors: 'adductors', inner_thigh: 'adductors',
  abductors: 'abductors', outer_thigh: 'abductors',
  calves: 'calves', calf: 'calves', soleus: 'calves', gastrocnemius: 'calves',
  neck: 'neck',
  full_body: 'full_body', total_body: 'full_body',
  cardio: 'cardio', conditioning: 'cardio', aerobic: 'cardio',
}

/** Generic names that had to be resolved to a specific head by guessing. */
const AMBIGUOUS: Record<string, Muscle> = {
  shoulders: 'front_delts', shoulder: 'front_delts', delts: 'front_delts', deltoids: 'front_delts',
  back: 'upper_back', upper_body: 'full_body', lower_body: 'quads', legs: 'quads',
  arms: 'biceps', hips: 'glutes', posterior_chain: 'hamstrings',
}

function normalizeName(raw: unknown): string {
  return String(raw || '').toLowerCase().trim().replace(/[\s-]+/g, '_').replace(/[^a-z_]/g, '')
}

export interface MuscleMatch {
  muscle: Muscle | null
  /** False when a generic term was resolved to a specific head by guessing. */
  exact: boolean
}

/** One free-text name to the closed list, or null when nothing fits. */
export function mapMuscle(raw: unknown): MuscleMatch {
  const key = normalizeName(raw)
  if (!key) return { muscle: null, exact: false }
  if (SYNONYMS[key] && MUSCLES.includes(SYNONYMS[key])) return { muscle: SYNONYMS[key], exact: true }
  if (AMBIGUOUS[key]) return { muscle: AMBIGUOUS[key], exact: false }
  // a plural or singular the table missed
  const singular = key.replace(/s$/, '')
  if (SYNONYMS[singular] && MUSCLES.includes(SYNONYMS[singular])) {
    return { muscle: SYNONYMS[singular], exact: true }
  }
  return { muscle: null, exact: false }
}

export interface MuscleContribution {
  muscle: Muscle
  /** Share of the work. Shares within a list sum to 1. */
  share: number
}

export interface MuscleSplit {
  primary: MuscleContribution[]
  secondary: MuscleContribution[]
  /**
   * True when the shares were inferred rather than authored — a flat list
   * from the classifier carries no weighting, so an even split is a guess
   * and the intelligence layer must be able to say so.
   */
  estimated: boolean
  /** Names nothing could be done with. Surfaced, never silently dropped. */
  unmapped: string[]
}

/** Scales a list so its shares sum to 1. */
export function normalizeShares(list: MuscleContribution[]): MuscleContribution[] {
  if (!list.length) return []
  const total = list.reduce((sum, c) => sum + (Number.isFinite(c.share) ? c.share : 0), 0)
  if (total <= 0) {
    const even = 1 / list.length
    return list.map((c) => ({ muscle: c.muscle, share: even }))
  }
  return list.map((c) => ({ muscle: c.muscle, share: c.share / total }))
}

function collect(raw: unknown): { list: MuscleContribution[]; unmapped: string[]; exact: boolean } {
  const names = Array.isArray(raw) ? raw : []
  const seen = new Map<Muscle, number>()
  const unmapped: string[] = []
  let exact = true
  for (const name of names) {
    const { muscle, exact: hit } = mapMuscle(name)
    if (!muscle) {
      const label = String(name || '').trim()
      if (label) unmapped.push(label)
      continue
    }
    if (!hit) exact = false
    seen.set(muscle, (seen.get(muscle) || 0) + 1)
  }
  const list = [...seen.entries()].map(([muscle, count]) => ({ muscle, share: count }))
  return { list: normalizeShares(list), unmapped, exact }
}

/**
 * Builds a split from a stored exercise definition.
 *
 * Mapping happens on READ. Nothing in customLib is rewritten, for the same
 * reason nothing else in this engine rewrites stored rows: the record is
 * what happened, and a migration that edits it in place can only ever lose
 * information.
 */
export function muscleSplitFrom(info: unknown): MuscleSplit {
  const def = (info && typeof info === 'object' ? info : {}) as Record<string, unknown>
  const primary = collect(def.primary)
  const secondary = collect(def.secondary)

  /* Authored shares would arrive as objects with a share; a flat list of
     names is the classifier's shape and can only be split evenly, which is
     a guess however reasonable. */
  const authored = Array.isArray(def.primary)
    && (def.primary as unknown[]).some((m) => m && typeof m === 'object' && 'share' in (m as object))

  return {
    primary: primary.list,
    secondary: secondary.list,
    estimated: !authored || !primary.exact || !secondary.exact,
    unmapped: [...primary.unmapped, ...secondary.unmapped],
  }
}

/** How much of one exercise's work lands on each muscle. */
export function distribute(sets: number, split: MuscleSplit): Partial<Record<Muscle, number>> {
  const out: Partial<Record<Muscle, number>> = {}
  const add = (muscle: Muscle, amount: number) => {
    out[muscle] = (out[muscle] || 0) + amount
  }
  split.primary.forEach((c) => add(c.muscle, sets * c.share))
  split.secondary.forEach((c) => add(c.muscle, sets * c.share * SECONDARY_SHARE))
  return out
}

/** Muscles that a pressing movement drives, for push:pull balance. */
export const PUSH_MUSCLES: Muscle[] = ['chest', 'front_delts', 'side_delts', 'triceps']
/** Muscles that a pulling movement drives. */
export const PULL_MUSCLES: Muscle[] = ['lats', 'upper_back', 'rear_delts', 'biceps', 'traps']
