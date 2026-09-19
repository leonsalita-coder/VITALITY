/**
 * The canonical exercise catalog — hand-authored, not classified.
 *
 * Two things depend on this existing.
 *
 * First, `estimated: false`. Until now every muscle split came from a flat
 * list of names the classifier produced, so an even split was the only
 * option and every finding was equally a guess. A flag that is always true
 * carries no information. These entries carry real contribution weights,
 * which is what makes the flag mean something on the ones that do not.
 *
 * Second, identity. "BB Bench" and "Bench Press" were two lifts with two
 * histories and neither accumulated enough to progress from — the same bug
 * as "Pecs" and "Chest", one level up. Aliases here are what let a typed
 * name land on the lift it actually is.
 *
 * Contribution weights are expressed on `primary` and sum to 1, covering
 * assistance as well as prime movers: a bench press is 0.7 chest, 0.15
 * triceps, 0.15 front delts. `secondary` is left empty because the
 * weighting already encodes relative involvement.
 *
 * Pure data. No DOM, no imports beyond types.
 */

import type { MuscleContribution } from './muscles'
import type { SetKind } from './sets'
import type { LoadingStyle } from './progression'

export type MovementPattern =
  | 'squat' | 'hinge' | 'lunge'
  | 'horizontal_push' | 'vertical_push'
  | 'horizontal_pull' | 'vertical_pull'
  | 'carry' | 'rotation' | 'isolation' | 'jump' | 'sprint' | 'core'

export interface CatalogExercise {
  id: string
  name: string
  aliases: string[]
  pattern: MovementPattern
  equipment: string
  unilateral: boolean
  defaultSetKind: SetKind
  /** e1RM is only meaningful on a loaded movement worked in low reps. */
  e1rmValid: boolean
  loading: LoadingStyle
  incrementLb: number
  primary: MuscleContribution[]
  secondary: MuscleContribution[]
  /**
   * How much of the athlete this movement lifts, for bodyweight kinds.
   * Authored, not estimated: a push-up is about two thirds, a pull-up is
   * all of it, a back extension is the torso alone.
   */
  bodyweightFactor?: number
}

const m = (muscle: string, share: number) => ({ muscle, share }) as MuscleContribution

/** Shorthand for the common case: a loaded barbell lift. */
const bar = (o: Partial<CatalogExercise>): CatalogExercise => ({
  id: '', name: '', aliases: [], pattern: 'squat', equipment: 'barbell',
  unilateral: false, defaultSetKind: 'reps_weight', e1rmValid: true,
  loading: 'barbell', incrementLb: 5, primary: [], secondary: [],
  ...o,
} as CatalogExercise)

export const CATALOG: CatalogExercise[] = [
  // ── squat ─────────────────────────────────────────────────────────
  bar({ id: 'back_squat', name: 'Back Squat', aliases: ['squat', 'bb squat', 'barbell squat', 'high bar squat'],
    pattern: 'squat', primary: [m('quads', 0.55), m('glutes', 0.3), m('lower_back', 0.1), m('hamstrings', 0.05)] }),
  bar({ id: 'front_squat', name: 'Front Squat', aliases: ['fs', 'bb front squat'],
    pattern: 'squat', primary: [m('quads', 0.65), m('glutes', 0.2), m('abs', 0.1), m('upper_back', 0.05)] }),
  bar({ id: 'goblet_squat', name: 'Goblet Squat', aliases: ['db goblet squat'],
    pattern: 'squat', equipment: 'dumbbell', loading: 'dumbbell', e1rmValid: false,
    primary: [m('quads', 0.6), m('glutes', 0.3), m('abs', 0.1)] }),
  bar({ id: 'leg_press', name: 'Leg Press', aliases: ['machine leg press'],
    pattern: 'squat', equipment: 'machine', loading: 'stack', incrementLb: 10,
    primary: [m('quads', 0.65), m('glutes', 0.3), m('hamstrings', 0.05)] }),

  // ── hinge ─────────────────────────────────────────────────────────
  bar({ id: 'deadlift', name: 'Deadlift', aliases: ['dl', 'conventional deadlift', 'bb deadlift'],
    pattern: 'hinge', primary: [m('glutes', 0.3), m('hamstrings', 0.25), m('lower_back', 0.2), m('traps', 0.15), m('forearms', 0.1)] }),
  bar({ id: 'romanian_deadlift', name: 'Romanian Deadlift', aliases: ['rdl', 'romanian dl', 'stiff leg deadlift', 'sldl'],
    pattern: 'hinge', primary: [m('hamstrings', 0.55), m('glutes', 0.3), m('lower_back', 0.15)] }),
  bar({ id: 'hip_thrust', name: 'Hip Thrust', aliases: ['barbell hip thrust', 'glute bridge'],
    pattern: 'hinge', incrementLb: 10, primary: [m('glutes', 0.75), m('hamstrings', 0.25)] }),
  bar({ id: 'back_extension', name: 'Back Extension', aliases: ['hyperextension', '45 degree back extension'],
    pattern: 'hinge', equipment: 'bodyweight', loading: 'free', defaultSetKind: 'bodyweight',
    e1rmValid: false, incrementLb: 2.5, primary: [m('lower_back', 0.5), m('glutes', 0.3), m('hamstrings', 0.2)], bodyweightFactor: 0.45 }),
  bar({ id: 'kettlebell_swing', name: 'Kettlebell Swing', aliases: ['kb swing', 'swing'],
    pattern: 'hinge', equipment: 'kettlebell', loading: 'free', e1rmValid: false, incrementLb: 8,
    primary: [m('glutes', 0.5), m('hamstrings', 0.3), m('lower_back', 0.2)] }),

  // ── lunge / unilateral ────────────────────────────────────────────
  bar({ id: 'walking_lunge', name: 'Walking Lunge', aliases: ['lunge', 'lunges', 'db lunge'],
    pattern: 'lunge', equipment: 'dumbbell', loading: 'dumbbell', unilateral: true, e1rmValid: false,
    primary: [m('quads', 0.45), m('glutes', 0.4), m('hamstrings', 0.15)] }),
  bar({ id: 'bulgarian_split_squat', name: 'Bulgarian Split Squat', aliases: ['bss', 'rear foot elevated split squat', 'rfess', 'split squat'],
    pattern: 'lunge', equipment: 'dumbbell', loading: 'dumbbell', unilateral: true, e1rmValid: false,
    primary: [m('quads', 0.45), m('glutes', 0.4), m('hamstrings', 0.15)] }),
  bar({ id: 'step_up', name: 'Step-Up', aliases: ['box step up', 'db step up'],
    pattern: 'lunge', equipment: 'dumbbell', loading: 'dumbbell', unilateral: true, e1rmValid: false,
    primary: [m('quads', 0.45), m('glutes', 0.45), m('calves', 0.1)] }),

  // ── horizontal push ───────────────────────────────────────────────
  bar({ id: 'bench_press', name: 'Bench Press', aliases: ['bench', 'bb bench', 'barbell bench', 'flat bench', 'bb bench press', 'bp'],
    pattern: 'horizontal_push', primary: [m('chest', 0.7), m('triceps', 0.15), m('front_delts', 0.15)] }),
  bar({ id: 'incline_bench_press', name: 'Incline Bench Press', aliases: ['incline bench', 'incline barbell bench', 'incline press'],
    pattern: 'horizontal_push', primary: [m('chest', 0.55), m('front_delts', 0.3), m('triceps', 0.15)] }),
  bar({ id: 'dumbbell_bench_press', name: 'Dumbbell Bench Press', aliases: ['db bench', 'db bench press', 'dumbbell press', 'db press'],
    pattern: 'horizontal_push', equipment: 'dumbbell', loading: 'dumbbell',
    primary: [m('chest', 0.68), m('triceps', 0.16), m('front_delts', 0.16)] }),
  bar({ id: 'push_up', name: 'Push-Up', aliases: ['pushup', 'push ups', 'pressup'],
    pattern: 'horizontal_push', equipment: 'bodyweight', loading: 'free',
    defaultSetKind: 'bodyweight', e1rmValid: false, incrementLb: 2.5,
    primary: [m('chest', 0.65), m('triceps', 0.2), m('front_delts', 0.15)], bodyweightFactor: 0.65 }),
  bar({ id: 'chest_fly', name: 'Chest Fly', aliases: ['fly', 'flye', 'pec deck', 'cable fly', 'db fly'],
    pattern: 'isolation', equipment: 'cable', loading: 'stack', e1rmValid: false,
    primary: [m('chest', 0.85), m('front_delts', 0.15)] }),

  // ── vertical push ─────────────────────────────────────────────────
  bar({ id: 'overhead_press', name: 'Overhead Press', aliases: ['ohp', 'military press', 'standing press', 'shoulder press', 'strict press'],
    pattern: 'vertical_push', primary: [m('front_delts', 0.55), m('side_delts', 0.2), m('triceps', 0.2), m('abs', 0.05)] }),
  bar({ id: 'dumbbell_shoulder_press', name: 'Dumbbell Shoulder Press', aliases: ['db shoulder press', 'db ohp', 'seated db press'],
    pattern: 'vertical_push', equipment: 'dumbbell', loading: 'dumbbell',
    primary: [m('front_delts', 0.55), m('side_delts', 0.2), m('triceps', 0.25)] }),
  bar({ id: 'lateral_raise', name: 'Lateral Raise', aliases: ['side raise', 'db lateral raise', 'lat raise', 'side lateral raise'],
    pattern: 'isolation', equipment: 'dumbbell', loading: 'dumbbell', e1rmValid: false,
    primary: [m('side_delts', 0.85), m('traps', 0.15)] }),
  bar({ id: 'dip', name: 'Dip', aliases: ['dips', 'parallel bar dip', 'chest dip', 'tricep dip'],
    pattern: 'vertical_push', equipment: 'bodyweight', loading: 'free',
    defaultSetKind: 'bodyweight', e1rmValid: false, incrementLb: 2.5,
    primary: [m('chest', 0.45), m('triceps', 0.4), m('front_delts', 0.15)], bodyweightFactor: 1.0 }),

  // ── vertical pull ─────────────────────────────────────────────────
  bar({ id: 'pull_up', name: 'Pull-Up', aliases: ['pullup', 'pull ups', 'pullups'],
    pattern: 'vertical_pull', equipment: 'bodyweight', loading: 'free',
    defaultSetKind: 'bodyweight', e1rmValid: false, incrementLb: 2.5,
    primary: [m('lats', 0.6), m('upper_back', 0.2), m('biceps', 0.2)], bodyweightFactor: 1.0 }),
  bar({ id: 'chin_up', name: 'Chin-Up', aliases: ['chinup', 'chin ups', 'chinups'],
    pattern: 'vertical_pull', equipment: 'bodyweight', loading: 'free',
    defaultSetKind: 'bodyweight', e1rmValid: false, incrementLb: 2.5,
    primary: [m('lats', 0.5), m('biceps', 0.35), m('upper_back', 0.15)], bodyweightFactor: 1.0 }),
  bar({ id: 'lat_pulldown', name: 'Lat Pulldown', aliases: ['pulldown', 'lat pull down', 'cable pulldown'],
    pattern: 'vertical_pull', equipment: 'machine', loading: 'stack', incrementLb: 10,
    primary: [m('lats', 0.6), m('upper_back', 0.2), m('biceps', 0.2)] }),

  // ── horizontal pull ───────────────────────────────────────────────
  bar({ id: 'barbell_row', name: 'Barbell Row', aliases: ['bb row', 'bent over row', 'pendlay row', 'row'],
    pattern: 'horizontal_pull', primary: [m('upper_back', 0.35), m('lats', 0.35), m('rear_delts', 0.15), m('biceps', 0.15)] }),
  bar({ id: 'dumbbell_row', name: 'Dumbbell Row', aliases: ['db row', 'one arm row', 'single arm row'],
    pattern: 'horizontal_pull', equipment: 'dumbbell', loading: 'dumbbell', unilateral: true,
    primary: [m('lats', 0.45), m('upper_back', 0.3), m('biceps', 0.25)] }),
  bar({ id: 'seated_cable_row', name: 'Seated Cable Row', aliases: ['cable row', 'seated row'],
    pattern: 'horizontal_pull', equipment: 'cable', loading: 'stack', incrementLb: 10,
    primary: [m('upper_back', 0.45), m('lats', 0.3), m('biceps', 0.25)] }),
  bar({ id: 'face_pull', name: 'Face Pull', aliases: ['cable face pull', 'facepull'],
    pattern: 'horizontal_pull', equipment: 'cable', loading: 'stack', e1rmValid: false, incrementLb: 5,
    primary: [m('rear_delts', 0.5), m('upper_back', 0.3), m('traps', 0.2)] }),

  // ── arms ──────────────────────────────────────────────────────────
  bar({ id: 'barbell_curl', name: 'Barbell Curl', aliases: ['bb curl', 'bicep curl', 'ez bar curl', 'curl'],
    pattern: 'isolation', e1rmValid: false, primary: [m('biceps', 0.85), m('forearms', 0.15)] }),
  bar({ id: 'dumbbell_curl', name: 'Dumbbell Curl', aliases: ['db curl', 'dumbbell bicep curl'],
    pattern: 'isolation', equipment: 'dumbbell', loading: 'dumbbell', e1rmValid: false,
    primary: [m('biceps', 0.85), m('forearms', 0.15)] }),
  bar({ id: 'hammer_curl', name: 'Hammer Curl', aliases: ['db hammer curl', 'neutral curl'],
    pattern: 'isolation', equipment: 'dumbbell', loading: 'dumbbell', e1rmValid: false,
    primary: [m('biceps', 0.6), m('forearms', 0.4)] }),
  bar({ id: 'tricep_pushdown', name: 'Tricep Pushdown', aliases: ['pushdown', 'cable pushdown', 'rope pushdown', 'tricep extension'],
    pattern: 'isolation', equipment: 'cable', loading: 'stack', e1rmValid: false, incrementLb: 5,
    primary: [m('triceps', 1)] }),
  bar({ id: 'skullcrusher', name: 'Skullcrusher', aliases: ['lying tricep extension', 'skull crusher'],
    pattern: 'isolation', e1rmValid: false, primary: [m('triceps', 1)] }),

  // ── legs, isolation ───────────────────────────────────────────────
  bar({ id: 'leg_curl', name: 'Leg Curl', aliases: ['hamstring curl', 'lying leg curl', 'seated leg curl'],
    pattern: 'isolation', equipment: 'machine', loading: 'stack', e1rmValid: false, incrementLb: 10,
    primary: [m('hamstrings', 0.9), m('calves', 0.1)] }),
  bar({ id: 'leg_extension', name: 'Leg Extension', aliases: ['quad extension', 'knee extension'],
    pattern: 'isolation', equipment: 'machine', loading: 'stack', e1rmValid: false, incrementLb: 10,
    primary: [m('quads', 1)] }),
  bar({ id: 'calf_raise', name: 'Calf Raise', aliases: ['standing calf raise', 'seated calf raise', 'calf raises'],
    pattern: 'isolation', equipment: 'machine', loading: 'stack', e1rmValid: false, incrementLb: 10,
    primary: [m('calves', 1)] }),

  // ── core ──────────────────────────────────────────────────────────
  bar({ id: 'plank', name: 'Plank', aliases: ['front plank', 'planks'],
    pattern: 'core', equipment: 'bodyweight', loading: 'free', defaultSetKind: 'time',
    e1rmValid: false, incrementLb: 2.5, primary: [m('abs', 0.7), m('obliques', 0.3)] }),
  bar({ id: 'side_plank', name: 'Side Plank', aliases: ['side planks'],
    pattern: 'core', equipment: 'bodyweight', loading: 'free', defaultSetKind: 'time',
    unilateral: true, e1rmValid: false, incrementLb: 2.5, primary: [m('obliques', 0.75), m('abs', 0.25)] }),
  bar({ id: 'hanging_leg_raise', name: 'Hanging Leg Raise', aliases: ['leg raise', 'hanging knee raise', 'leg raises'],
    pattern: 'core', equipment: 'bodyweight', loading: 'free', defaultSetKind: 'bodyweight',
    e1rmValid: false, incrementLb: 2.5, primary: [m('abs', 0.7), m('obliques', 0.15), m('forearms', 0.15)], bodyweightFactor: 0.4 }),
  bar({ id: 'cable_woodchop', name: 'Cable Woodchop', aliases: ['woodchop', 'wood chop', 'cable chop'],
    pattern: 'rotation', equipment: 'cable', loading: 'stack', unilateral: true, e1rmValid: false, incrementLb: 5,
    primary: [m('obliques', 0.7), m('abs', 0.3)] }),

  // ── explosiveness: what taekwondo and soccer actually need ────────
  bar({ id: 'box_jump', name: 'Box Jump', aliases: ['box jumps', 'jump box'],
    pattern: 'jump', equipment: 'bodyweight', loading: 'free', defaultSetKind: 'bodyweight',
    e1rmValid: false, incrementLb: 2.5, primary: [m('quads', 0.45), m('glutes', 0.4), m('calves', 0.15)], bodyweightFactor: 1.0 }),
  bar({ id: 'broad_jump', name: 'Broad Jump', aliases: ['standing broad jump', 'long jump'],
    pattern: 'jump', equipment: 'bodyweight', loading: 'free', defaultSetKind: 'distance',
    e1rmValid: false, incrementLb: 2.5, primary: [m('glutes', 0.4), m('quads', 0.35), m('hamstrings', 0.25)] }),
  bar({ id: 'sprint', name: 'Sprint', aliases: ['sprints', 'shuttle run', 'shuttles', 'run'],
    pattern: 'sprint', equipment: 'bodyweight', loading: 'free', defaultSetKind: 'time_distance',
    e1rmValid: false, incrementLb: 2.5,
    primary: [m('hamstrings', 0.3), m('quads', 0.25), m('glutes', 0.25), m('calves', 0.2)] }),
  bar({ id: 'sled_push', name: 'Sled Push', aliases: ['prowler push', 'sled'],
    pattern: 'sprint', equipment: 'sled', loading: 'free', defaultSetKind: 'distance',
    e1rmValid: false, incrementLb: 10,
    primary: [m('quads', 0.4), m('glutes', 0.3), m('calves', 0.2), m('abs', 0.1)] }),
  bar({ id: 'farmer_carry', name: "Farmer's Carry", aliases: ['farmers walk', 'farmer walk', 'loaded carry', 'farmers carry'],
    pattern: 'carry', equipment: 'dumbbell', loading: 'dumbbell', defaultSetKind: 'distance',
    e1rmValid: false, primary: [m('forearms', 0.35), m('traps', 0.3), m('abs', 0.2), m('obliques', 0.15)] }),
]

export const CATALOG_BY_ID: Record<string, CatalogExercise> = Object.fromEntries(
  CATALOG.map((e) => [e.id, e]),
)

export function catalogExercise(id: string): CatalogExercise | null {
  return CATALOG_BY_ID[id] || null
}
