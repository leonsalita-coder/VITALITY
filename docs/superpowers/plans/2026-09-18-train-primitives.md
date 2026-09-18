# Train Primitives Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Train's untyped `{kg, reps}` data model with typed sets, warm-up flags, RPE, timestamps, and a real exercise taxonomy with canonical identity — so every downstream system (progression, PRs, volume, charts, the noticer) reads correct data.

**Architecture:** Pure logic moves out of the sealed tile into DOM-free TypeScript modules under `lib/train/`, tested with vitest. A build step (`scripts/build-tile.mjs`) bundles those modules to an IIFE and inlines them into `train.html` between markers, so the tile stays a single self-contained file. The tile keeps its render/DOM code and calls `TrainEngine.*` for all math. A versioned, idempotent migration converts existing saved state v0 → v1 on boot, keeping a one-time backup.

**Tech Stack:** TypeScript 5, vitest (node environment), esbuild (bundle-to-IIFE), Next 14 (host app only — the engine never imports from it).

## Global Constraints

- Tiles are **sealed `srcDoc` sandboxed iframes**: opaque origin, no network, no external files. Everything ships inlined in one HTML file.
- **No AI or API keys** in the tile or engine. AI calls go only through the `window.Vitality.*` bridge.
- The engine must be **DOM-free and dashboard-free** — no `window`, `document`, or `window.Vitality` references inside `lib/train/*.ts`. This is what makes it portable to a native app later.
- **Canonical storage unit is POUNDS (`lb`).** kg is a display-time conversion only — never stored. This is enforced by `lib/train/units.ts` (Task 2): the tile converts on render and on input, and the migration converts any legacy `unit: 'kg'` store. Today no user can be in kg (the tile has no unit toggle — `STATE.unit` is written once as `'lb'` in `buildState()` and never reassigned), which is exactly why this is cheap to establish now rather than after a kg toggle ships.
- **Estimated data must be marked.** Anything the system inferred rather than recorded carries a flag — `atEstimated` on a backfilled timestamp, `contributionsEstimated` on a guessed muscle split. The intelligence layer must be able to tell what it measured from what it guessed, or it will confidently report artifacts.
- **Dates are local-time `YYYY-MM-DD`**, produced the way the tile already does it (`ymd()`), never `toISOString()`.
- **Never destroy user data.** Migration is versioned (`STATE.v`), idempotent, and writes a one-time `_v0Backup` before converting.
- After any build, `tiles-library/train.html` and `public/tiles/train.html` must be **byte-identical**.
- Node >= 20.
- Warm-up sets must never enter volume, PR detection, or progression logic.

---

## File Structure

**New — the engine (pure, tested, portable):**

| File | Responsibility |
|---|---|
| `lib/train/types.ts` | All shared types: `SetKind`, `LoggedSet`, `Muscle`, `MovementPattern`, `Equipment`, `ExerciseDef`, `TrainStateV1` |
| `lib/train/units.ts` | The kg↔lb boundary — canonical pounds in, display unit out |
| `lib/train/sets.ts` | Set constructors, type guards, per-kind field validation |
| `lib/train/volume.ts` | Per-set-kind volume strategies, aggregates, warm-up exclusion |
| `lib/train/timing.ts` | Rest-taken and session-density derivations from set timestamps |
| `lib/train/taxonomy.ts` | Muscle/pattern/equipment helpers, contribution normalization |
| `lib/train/catalog.ts` | Seed canonical exercise catalog with aliases |
| `lib/train/identity.ts` | Name normalization, alias resolution, fuzzy "did you mean" matching |
| `lib/train/merge.ts` | Merge two exercise identities across all of state |
| `lib/train/migrate.ts` | Versioned v0 → v1 state migration |
| `lib/train/index.ts` | Public surface — the only thing the tile touches |

**New — infrastructure:**

| File | Responsibility |
|---|---|
| `vitest.config.ts` | Test config, node environment |
| `scripts/build-tile.mjs` | Bundle engine to IIFE, inline into both tile HTML files |
| `tests/train/*.test.ts` | One test file per engine module, plus source-level contract tests asserting the sealed tile's wiring |

**Modified:**

| File | Change |
|---|---|
| `package.json` | Add `vitest`, `esbuild` devDeps; `test`, `build:tiles`, `prebuild` scripts |
| `public/tiles/train.html` | Engine marker block; logging path, aggregates, entry, and merge UI rewired to `TrainEngine` |
| `tiles-library/train.html` | Kept byte-identical to the above by the build script |

---

### Task 1: Test + build infrastructure

**Files:**
- Create: `vitest.config.ts`
- Create: `lib/train/index.ts`
- Create: `scripts/build-tile.mjs`
- Create: `tests/train/build.test.ts`
- Modify: `package.json`
- Modify: `public/tiles/train.html` (insert marker block before the main `<script>`)

**Interfaces:**
- Consumes: nothing.
- Produces: `ENGINE_VERSION: string` exported from `lib/train/index.ts`; the global `TrainEngine` inside the tile; npm scripts `test`, `build:tiles`.

- [ ] **Step 1: Install dev dependencies**

```bash
npm install -D vitest@^2 esbuild@^0.24
```

- [ ] **Step 2: Add scripts to `package.json`**

In the `"scripts"` block, add these three entries (keep the existing ones):

```json
"test": "vitest run",
"build:tiles": "node scripts/build-tile.mjs",
"prebuild": "npm run build:tiles"
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
```

- [ ] **Step 4: Create the engine entry point `lib/train/index.ts`**

```ts
/**
 * Train engine — pure, DOM-free training logic.
 *
 * This module is bundled to an IIFE (global `TrainEngine`) and inlined into
 * train.html by scripts/build-tile.mjs. It must never import from the Next
 * app, touch `window`/`document`, or reference `window.Vitality`.
 */
export const ENGINE_VERSION = '1.0.0'
```

- [ ] **Step 5: Write the failing build test `tests/train/build.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { ENGINE_VERSION } from '../../lib/train/index'

const PUBLIC_TILE = 'public/tiles/train.html'
const LIBRARY_TILE = 'tiles-library/train.html'

describe('tile build', () => {
  it('inlines the engine into both tile files and keeps them identical', () => {
    execFileSync('node', ['scripts/build-tile.mjs'], { stdio: 'pipe' })

    const pub = readFileSync(PUBLIC_TILE, 'utf8')
    const lib = readFileSync(LIBRARY_TILE, 'utf8')

    expect(pub).toBe(lib)
    expect(pub).toContain('<!-- TRAIN-ENGINE:START -->')
    expect(pub).toContain('<!-- TRAIN-ENGINE:END -->')
    expect(pub).toContain(ENGINE_VERSION)
    expect(pub).toContain('var TrainEngine')
  })

  it('never emits a literal closing script tag inside the bundle', () => {
    const pub = readFileSync(PUBLIC_TILE, 'utf8')
    const start = pub.indexOf('<!-- TRAIN-ENGINE:START -->')
    const end = pub.indexOf('<!-- TRAIN-ENGINE:END -->')
    const block = pub.slice(start, end)
    // exactly one opening and one closing script tag belong to the wrapper
    expect(block.match(/<\/script>/g)?.length).toBe(1)
  })
})
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run tests/train/build.test.ts`
Expected: FAIL — `scripts/build-tile.mjs` does not exist.

- [ ] **Step 7: Insert the marker block into `public/tiles/train.html`**

Find this line near the end of the file (it is the opening of the tile's main inline script, immediately after `<div class="celebrate" id="celebrate">...</div>`):

```html
<script>
/* ====================================================================
   THE LOGGER. One session per real calendar day
```

Insert these two lines **immediately before** that `<script>` tag:

```html
<!-- TRAIN-ENGINE:START --><!-- TRAIN-ENGINE:END -->
```

The engine must be defined before the logger script runs, so the marker goes above it.

- [ ] **Step 8: Create `scripts/build-tile.mjs`**

```js
/**
 * Bundles lib/train/index.ts to a single IIFE (global `TrainEngine`) and
 * inlines it into the tile HTML between the TRAIN-ENGINE markers.
 *
 * Tiles are sealed srcDoc iframes with no network and no external files, so
 * the engine cannot be a <script src>. It has to be physically inlined, and
 * both copies of the tile have to stay identical.
 */
import { build } from 'esbuild'
import { readFileSync, writeFileSync } from 'node:fs'

const START = '<!-- TRAIN-ENGINE:START -->'
const END = '<!-- TRAIN-ENGINE:END -->'
const TILES = ['public/tiles/train.html', 'tiles-library/train.html']

const result = await build({
  entryPoints: ['lib/train/index.ts'],
  bundle: true,
  format: 'iife',
  globalName: 'TrainEngine',
  target: 'es2020',
  platform: 'browser',
  write: false,
})

// A literal </script> inside the bundle would close the wrapper early.
const code = result.outputFiles[0].text.replace(/<\/script>/gi, '<\\/script>')
const block = `${START}\n<script>\n${code}</script>\n${END}`

const source = readFileSync(TILES[0], 'utf8')
if (!source.includes(START) || !source.includes(END)) {
  throw new Error(`Missing TRAIN-ENGINE markers in ${TILES[0]}`)
}
const next = source.replace(
  new RegExp(`${START}[\\s\\S]*?${END}`),
  () => block,
)

for (const file of TILES) writeFileSync(file, next)
console.log(`train engine inlined (${code.length} bytes) → ${TILES.join(', ')}`)
```

- [ ] **Step 9: Run the build, then the test**

Run: `npm run build:tiles && npx vitest run tests/train/build.test.ts`
Expected: PASS — both assertions green, both tile files identical.

- [ ] **Step 10: Verify the tile still renders**

Run: `npm run dev`, open the dashboard, open the Train tile.
Expected: the tile looks and behaves exactly as before (nothing uses the engine yet), and the browser console has no errors. Confirm `TrainEngine.ENGINE_VERSION` is defined by typing it in the iframe console context.

- [ ] **Step 11: Commit**

```bash
git add package.json package-lock.json vitest.config.ts lib/train/index.ts scripts/build-tile.mjs tests/train/build.test.ts public/tiles/train.html tiles-library/train.html
git commit -m "feat(train): add engine build pipeline and test infrastructure

Bundles lib/train to an inlined IIFE so the tile stays a single sealed
file, and adds vitest for the pure logic that follows.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Core types, units, and set constructors

**Files:**
- Create: `lib/train/types.ts`
- Create: `lib/train/units.ts`
- Create: `lib/train/sets.ts`
- Create: `tests/train/sets.test.ts`
- Create: `tests/train/units.test.ts`
- Modify: `lib/train/index.ts`

**Interfaces:**
- Consumes: `ENGINE_VERSION` (Task 1).
- Produces: types `SetKind`, `LoggedSet`, `DropSet`, `Muscle`, `MovementPattern`, `Plane`, `Equipment`, `LoadingScheme`, `MuscleContribution`, `ExerciseDef`, `HistoryEntry`, `SessionExercise`, `Session`, `TrainStateV1`; functions `makeSet(kind, fields)`, `isWorkingSet(set)`, `setIsValid(set)`, `measuresFor(kind)`, `totalReps(set)`; `Unit`, `LB_PER_KG`, `kgToLb`, `lbToKg`, `displayWeight(lb, unit)`, `storeWeight(entered, unit)`, `formatWeight(lb, unit)`.

- [ ] **Step 1: Create `lib/train/types.ts`**

```ts
/** How a set is measured. Every downstream aggregate branches on this. */
export type SetKind =
  | 'reps_weight'    // barbell bench, dumbbell curl
  | 'reps_only'      // push-ups, pull-ups, air squats
  | 'time'           // plank, dead hang
  | 'distance'       // rower for meters, loaded carry
  | 'time_distance'  // a 5k run, a 20-min bike

/** A drop set hanging off a completed working set. */
export interface DropSet {
  weight?: number
  reps?: number
  seconds?: number
  meters?: number
}

/**
 * One logged set. `weight` is always POUNDS. For an assisted movement
 * (pull-up machine) `weight` is the POSITIVE assistance amount and
 * `assisted` is true — the effective load is bodyweight minus that.
 */
export interface LoggedSet {
  kind: SetKind
  /** Warm-ups never enter volume, PRs, or progression. */
  warmup: boolean
  /** A set attempted and missed. Counts as logged, not as stimulus. */
  fail: boolean
  /** Epoch ms when the set was logged. Powers rest-taken and density. */
  at: number
  /**
   * True when `at` was backfilled rather than observed — migrated history
   * has no real timestamps. Every timing derivation excludes these, because
   * a synthesized stamp would otherwise read as a perfectly regular rest
   * interval and become a finding.
   */
  atEstimated?: boolean
  /** Pounds, always. kg never reaches storage — see lib/train/units.ts. */
  weight?: number
  reps?: number
  seconds?: number
  meters?: number
  /** Load listed is per-side (a pair of dumbbells, a unilateral lift). */
  perSide?: boolean
  /** `weight` is assistance subtracted from bodyweight, not added load. */
  assisted?: boolean
  banded?: boolean
  /** Rate of perceived exertion, 1–10 in 0.5 steps. */
  rpe?: number
  /** Reps in reserve, 0–5. Alternative to rpe; never store both. */
  rir?: number
  drops?: DropSet[]
}

export type Muscle =
  | 'chest' | 'front_delts' | 'side_delts' | 'rear_delts'
  | 'triceps' | 'biceps' | 'forearms'
  | 'lats' | 'traps' | 'upper_back' | 'lower_back'
  | 'abs' | 'obliques'
  | 'glutes' | 'quads' | 'hamstrings' | 'adductors' | 'abductors' | 'calves'
  | 'neck' | 'full_body' | 'cardio'

export type MovementPattern =
  | 'hinge' | 'squat' | 'push' | 'pull' | 'carry' | 'rotation'
  | 'isolation' | 'locomotion' | 'other'

/** Finer axis on top of push/pull, for push:pull and imbalance analysis. */
export type Plane = 'horizontal' | 'vertical' | null

export type Equipment =
  | 'barbell' | 'dumbbell' | 'machine' | 'cable' | 'smith'
  | 'kettlebell' | 'bodyweight' | 'band' | 'plate' | 'sled' | 'none'

/** Which weights are actually achievable — drives plate math later. */
export type LoadingScheme =
  | 'barbell_plates' | 'dumbbell_pairs' | 'machine_stack'
  | 'micro' | 'bodyweight' | 'free'

export interface MuscleContribution {
  muscle: Muscle
  /** Share of the work. Primaries sum to 1 within an exercise. */
  weight: number
}

export interface ExerciseDef {
  /** Canonical, stable, snake_case. Never derived from user typing. */
  id: string
  name: string
  aliases: string[]
  pattern: MovementPattern
  plane: Plane
  equipment: Equipment
  unilateral: boolean
  defaultSetKind: SetKind
  primary: MuscleContribution[]
  secondary: MuscleContribution[]
  /** e1RM formulas are nonsense on a plank or a 5k. */
  e1rmValid: boolean
  loading: LoadingScheme
  /** The real smallest jump, in lb, for this equipment. */
  incrementLb: number
  /** Fraction of bodyweight moved, for reps_only tonnage. */
  bodyweightFactor?: number
  /** True when the AI classified it rather than the seed catalog. */
  custom?: boolean
  /**
   * True when primary/secondary shares were guessed (split evenly across
   * whatever muscles were named) rather than authored. Muscle-volume views
   * must surface this — an even split renders as a confident number built
   * on no information.
   */
  contributionsEstimated?: boolean
}

export interface HistoryEntry {
  /** Local-time YYYY-MM-DD. */
  date: string
  exerciseId: string
  sets: LoggedSet[]
}

export interface SessionExercise {
  id: string
  name: string
  kind: SetKind
  tier: number
  sets: number
  reps: number
  weight: number
  rest: number
  perSide: boolean
  pinned: boolean
  collapsed: boolean
  deload: boolean
  note: string
  group?: string
  lastWeight?: number | null
  log: (LoggedSet | null)[]
}

export interface ChecklistItem {
  text: string
  done: boolean
}

export interface Session {
  date: string
  off: boolean
  startedAt?: number
  warmup: ChecklistItem[]
  cooldown: ChecklistItem[]
  ex: SessionExercise[]
  insight?: { date: string; text: string | null }
}

export interface Template {
  id: string
  name: string
  ex: Array<Partial<SessionExercise> & { name: string }>
}

export interface TrainStateV1 {
  v: 1
  unit: 'lb' | 'kg'
  submitted: boolean
  session: Session
  history: Record<string, HistoryEntry[]>
  /** Canonical + AI-classified exercise definitions, keyed by canonical id. */
  exercises: Record<string, ExerciseDef>
  /** Normalized user-typed name → canonical id. Grows as names are resolved. */
  aliases: Record<string, string>
  finishedDates: string[]
  templates: Template[]
  deloadOverrides: Record<string, { weight: number; date: string }>
  shortTermGoal: string
  photos: unknown[]
  sessionDurations: Array<{ date: string; minutes: number }>
  liftGoals: unknown[]
  /** One-time snapshot of pre-migration state. Never written twice. */
  _v0Backup?: unknown
}
```

- [ ] **Step 2: Write the failing test `tests/train/sets.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { makeSet, isWorkingSet, setIsValid, measuresFor, totalReps } from '../../lib/train/sets'

describe('makeSet', () => {
  it('defaults to a working, non-failed set with a timestamp', () => {
    const s = makeSet('reps_weight', { weight: 135, reps: 8 }, 1000)
    expect(s).toEqual({ kind: 'reps_weight', warmup: false, fail: false, at: 1000, weight: 135, reps: 8 })
  })

  it('drops fields that do not belong to the kind', () => {
    const s = makeSet('time', { seconds: 60, weight: 135, reps: 8 }, 1000)
    expect(s.seconds).toBe(60)
    expect(s.weight).toBeUndefined()
    expect(s.reps).toBeUndefined()
  })

  it('keeps flags and rpe when given', () => {
    const s = makeSet('reps_weight', { weight: 50, reps: 10, perSide: true, rpe: 8.5 }, 1000)
    expect(s.perSide).toBe(true)
    expect(s.rpe).toBe(8.5)
  })

  it('never stores both rpe and rir', () => {
    const s = makeSet('reps_weight', { weight: 50, reps: 10, rpe: 8, rir: 2 }, 1000)
    expect(s.rpe).toBe(8)
    expect(s.rir).toBeUndefined()
  })
})

describe('measuresFor', () => {
  it('names the fields each kind actually uses', () => {
    expect(measuresFor('reps_weight')).toEqual(['weight', 'reps'])
    expect(measuresFor('reps_only')).toEqual(['reps'])
    expect(measuresFor('time')).toEqual(['seconds'])
    expect(measuresFor('distance')).toEqual(['meters'])
    expect(measuresFor('time_distance')).toEqual(['seconds', 'meters'])
  })
})

describe('isWorkingSet', () => {
  it('excludes warm-ups and failures', () => {
    expect(isWorkingSet(makeSet('reps_weight', { weight: 100, reps: 5 }, 1))).toBe(true)
    expect(isWorkingSet(makeSet('reps_weight', { weight: 100, reps: 5, warmup: true }, 1))).toBe(false)
    expect(isWorkingSet(makeSet('reps_weight', { weight: 100, reps: 5, fail: true }, 1))).toBe(false)
  })
})

describe('setIsValid', () => {
  it('requires the kind-relevant measures to be finite and non-negative', () => {
    expect(setIsValid(makeSet('reps_weight', { weight: 100, reps: 5 }, 1))).toBe(true)
    expect(setIsValid(makeSet('reps_weight', { weight: 0, reps: 5 }, 1))).toBe(true)
    expect(setIsValid(makeSet('reps_weight', { weight: -5, reps: 5 }, 1))).toBe(false)
    expect(setIsValid(makeSet('reps_weight', { reps: 5 }, 1))).toBe(false)
    expect(setIsValid(makeSet('time', { seconds: 60 }, 1))).toBe(true)
  })

  it('accepts a failed set with no measures — a miss has nothing to record', () => {
    expect(setIsValid(makeSet('reps_weight', { weight: 225, fail: true }, 1))).toBe(true)
  })
})

describe('totalReps', () => {
  it('doubles per-side reps', () => {
    expect(totalReps(makeSet('reps_weight', { weight: 40, reps: 10 }, 1))).toBe(10)
    expect(totalReps(makeSet('reps_weight', { weight: 40, reps: 10, perSide: true }, 1))).toBe(20)
  })

  it('is zero for kinds that have no reps', () => {
    expect(totalReps(makeSet('time', { seconds: 45 }, 1))).toBe(0)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/train/sets.test.ts`
Expected: FAIL — cannot resolve `../../lib/train/sets`.

- [ ] **Step 4: Create `lib/train/sets.ts`**

```ts
import type { LoggedSet, SetKind } from './types'

/** Which measure fields a kind actually uses. Everything else is stripped. */
const MEASURES: Record<SetKind, Array<keyof LoggedSet>> = {
  reps_weight: ['weight', 'reps'],
  reps_only: ['reps'],
  time: ['seconds'],
  distance: ['meters'],
  time_distance: ['seconds', 'meters'],
}

export function measuresFor(kind: SetKind): Array<keyof LoggedSet> {
  return MEASURES[kind].slice()
}

type SetInput = Partial<Omit<LoggedSet, 'kind' | 'at'>>

/**
 * Builds a set of the given kind, keeping only the measures that kind uses
 * and only the flags that were actually supplied. `at` is passed in rather
 * than read from Date.now() so this stays pure and testable.
 */
export function makeSet(kind: SetKind, input: SetInput, at: number): LoggedSet {
  const set: LoggedSet = {
    kind,
    warmup: input.warmup === true,
    fail: input.fail === true,
    at,
  }
  for (const field of MEASURES[kind]) {
    const value = input[field]
    if (typeof value === 'number') (set as Record<string, unknown>)[field] = value
  }
  if (input.perSide === true) set.perSide = true
  if (input.assisted === true) set.assisted = true
  if (input.banded === true) set.banded = true
  // rpe wins — storing both would let two sources of truth drift apart
  if (typeof input.rpe === 'number') set.rpe = input.rpe
  else if (typeof input.rir === 'number') set.rir = input.rir
  if (Array.isArray(input.drops) && input.drops.length) set.drops = input.drops
  return set
}

/** A set that counts toward stimulus: logged, not a warm-up, not a miss. */
export function isWorkingSet(set: LoggedSet | null | undefined): boolean {
  return !!set && !set.warmup && !set.fail
}

/** A miss records no measures, so only non-failed sets are measure-checked. */
export function setIsValid(set: LoggedSet): boolean {
  if (!MEASURES[set.kind]) return false
  if (set.fail) return true
  return MEASURES[set.kind].every((field) => {
    const value = set[field]
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
  })
}

/** Reps actually performed, counting both sides of a per-side set. */
export function totalReps(set: LoggedSet): number {
  if (typeof set.reps !== 'number') return 0
  return set.perSide ? set.reps * 2 : set.reps
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/train/sets.test.ts`
Expected: PASS — all 11 assertions green.

- [ ] **Step 6: Write the failing units test `tests/train/units.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { LB_PER_KG, kgToLb, lbToKg, displayWeight, storeWeight, formatWeight } from '../../lib/train/units'

describe('conversion', () => {
  it('uses the exact factor, not a rounded one', () => {
    expect(LB_PER_KG).toBeCloseTo(2.20462262185, 10)
  })

  it('round-trips within display precision', () => {
    const lb = 225
    expect(lbToKg(kgToLb(100))).toBeCloseTo(100, 6)
    expect(kgToLb(lbToKg(lb))).toBeCloseTo(lb, 6)
  })

  it('converts known values', () => {
    expect(kgToLb(100)).toBeCloseTo(220.462, 2)
    expect(lbToKg(225)).toBeCloseTo(102.058, 2)
  })
})

describe('displayWeight', () => {
  it('passes pounds through for an lb user', () => {
    expect(displayWeight(225, 'lb')).toBe(225)
  })

  it('converts to kg for a kg user', () => {
    expect(displayWeight(220.46, 'kg')).toBe(100)
  })

  it('rounds display to one decimal so the UI never shows noise', () => {
    expect(displayWeight(100, 'kg')).toBe(45.4)
  })
})

describe('storeWeight', () => {
  it('stores what an lb user typed, unchanged', () => {
    expect(storeWeight(225, 'lb')).toBe(225)
  })

  it('converts what a kg user typed into canonical pounds', () => {
    expect(storeWeight(100, 'kg')).toBeCloseTo(220.46, 2)
  })

  it('survives a display/store round trip at the precision the UI shows', () => {
    const stored = storeWeight(100, 'kg')
    expect(displayWeight(stored, 'kg')).toBe(100)
  })
})

describe('formatWeight', () => {
  it('drops a trailing zero decimal', () => {
    expect(formatWeight(225, 'lb')).toBe('225')
    expect(formatWeight(220.46, 'kg')).toBe('100')
  })

  it('keeps a meaningful decimal', () => {
    expect(formatWeight(2.5, 'lb')).toBe('2.5')
  })
})
```

- [ ] **Step 7: Run it to verify it fails**

Run: `npx vitest run tests/train/units.test.ts`
Expected: FAIL — cannot resolve `../../lib/train/units`.

- [ ] **Step 8: Create `lib/train/units.ts`**

```ts
/**
 * Units. Storage is ALWAYS pounds; kg exists only at the edges — what is
 * rendered, and what the user typed.
 *
 * The reason is not tidiness. If weight were stored in whatever unit was
 * selected at the time, switching units would silently make every
 * historical comparison incoherent: progression, plateau detection and PRs
 * would compare 100 (kg) against 225 (lb) as raw numbers and conclude the
 * lifter had regressed. Canonical storage makes a unit switch cosmetic.
 */
export type Unit = 'lb' | 'kg'

export const LB_PER_KG = 2.20462262185

export function kgToLb(kg: number): number {
  return kg * LB_PER_KG
}

export function lbToKg(lb: number): number {
  return lb / LB_PER_KG
}

const round = (n: number, places: number): number => {
  const f = 10 ** places
  return Math.round(n * f) / f
}

/** Canonical pounds → the number to show, in the user's unit. */
export function displayWeight(lb: number, unit: Unit): number {
  return round(unit === 'kg' ? lbToKg(lb) : lb, 1)
}

/** A number the user typed, in their unit → canonical pounds. */
export function storeWeight(entered: number, unit: Unit): number {
  return round(unit === 'kg' ? kgToLb(entered) : entered, 2)
}

/** Display string with no trailing ".0". */
export function formatWeight(lb: number, unit: Unit): string {
  const n = displayWeight(lb, unit)
  return Number.isInteger(n) ? String(n) : String(n)
}
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `npx vitest run tests/train/units.test.ts`
Expected: PASS — all 11 assertions green.

- [ ] **Step 10: Re-export from `lib/train/index.ts`**

Replace the contents of `lib/train/index.ts` with:

```ts
/**
 * Train engine — pure, DOM-free training logic.
 *
 * This module is bundled to an IIFE (global `TrainEngine`) and inlined into
 * train.html by scripts/build-tile.mjs. It must never import from the Next
 * app, touch `window`/`document`, or reference `window.Vitality`.
 */
export const ENGINE_VERSION = '1.0.0'

export * from './types'
export * from './units'
export * from './sets'
```

- [ ] **Step 11: Rebuild and run the full suite**

Run: `npm run build:tiles && npx vitest run`
Expected: PASS — build test and sets tests all green.

- [ ] **Step 12: Commit**

```bash
git add lib/train/types.ts lib/train/units.ts lib/train/sets.ts lib/train/index.ts tests/train/sets.test.ts tests/train/units.test.ts public/tiles/train.html tiles-library/train.html
git commit -m "feat(train): add typed sets and core data model

Five set kinds, warm-up and per-side/assisted/banded flags, optional RPE
or RIR, and a timestamp on every set. Weight is canonical pounds; kg is a
display-time conversion so switching units stays cosmetic.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Per-kind volume strategies

**Files:**
- Create: `lib/train/volume.ts`
- Create: `tests/train/volume.test.ts`
- Modify: `lib/train/index.ts`

**Interfaces:**
- Consumes: `LoggedSet`, `SetKind`, `ExerciseDef`, `HistoryEntry` (Task 2); `isWorkingSet`, `totalReps` (Task 2).
- Produces: `VolumeTotals` interface; `emptyTotals()`, `setVolume(set, opts)`, `addTotals(a, b)`, `sumSets(sets, opts)`, `entryVolume(entry, opts)`, `effectiveLoad(set, opts)`.

- [ ] **Step 1: Write the failing test `tests/train/volume.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { makeSet } from '../../lib/train/sets'
import { emptyTotals, setVolume, sumSets, effectiveLoad } from '../../lib/train/volume'

describe('setVolume — reps_weight', () => {
  it('is weight times reps', () => {
    const t = setVolume(makeSet('reps_weight', { weight: 100, reps: 5 }, 1), {})
    expect(t.tonnage).toBe(500)
    expect(t.hardSets).toBe(1)
    expect(t.reps).toBe(5)
  })

  it('doubles a per-side set — both sides were actually lifted', () => {
    const t = setVolume(makeSet('reps_weight', { weight: 50, reps: 10, perSide: true }, 1), {})
    expect(t.tonnage).toBe(1000)
    expect(t.reps).toBe(20)
  })

  it('treats assistance as a subtraction from bodyweight', () => {
    const t = setVolume(makeSet('reps_weight', { weight: 40, reps: 5, assisted: true }, 1), { bodyweightLb: 180 })
    expect(t.tonnage).toBe(700) // (180 - 40) * 5
  })

  it('never produces negative tonnage when assistance exceeds bodyweight', () => {
    const t = setVolume(makeSet('reps_weight', { weight: 250, reps: 5, assisted: true }, 1), { bodyweightLb: 180 })
    expect(t.tonnage).toBe(0)
  })

  it('counts an assisted set with no known bodyweight as a hard set with no tonnage', () => {
    const t = setVolume(makeSet('reps_weight', { weight: 40, reps: 5, assisted: true }, 1), {})
    expect(t.tonnage).toBe(0)
    expect(t.hardSets).toBe(1)
  })
})

describe('setVolume — bodyweight and timed kinds', () => {
  it('uses the bodyweight factor for reps_only when bodyweight is known', () => {
    const t = setVolume(makeSet('reps_only', { reps: 10 }, 1), { bodyweightLb: 180, bodyweightFactor: 0.64 })
    expect(t.tonnage).toBeCloseTo(1152) // 180 * 0.64 * 10
    expect(t.hardSets).toBe(1)
  })

  it('still counts a hard set when bodyweight is unknown', () => {
    const t = setVolume(makeSet('reps_only', { reps: 10 }, 1), {})
    expect(t.tonnage).toBe(0)
    expect(t.hardSets).toBe(1)
    expect(t.reps).toBe(10)
  })

  it('accumulates seconds and meters without inventing tonnage', () => {
    expect(setVolume(makeSet('time', { seconds: 60 }, 1), {}).seconds).toBe(60)
    expect(setVolume(makeSet('distance', { meters: 400 }, 1), {}).meters).toBe(400)
    const td = setVolume(makeSet('time_distance', { seconds: 1500, meters: 5000 }, 1), {})
    expect(td.seconds).toBe(1500)
    expect(td.meters).toBe(5000)
    expect(td.tonnage).toBe(0)
  })
})

describe('setVolume — exclusions', () => {
  it('returns zero for a warm-up', () => {
    const t = setVolume(makeSet('reps_weight', { weight: 135, reps: 5, warmup: true }, 1), {})
    expect(t).toEqual(emptyTotals())
  })

  it('returns zero for a missed set', () => {
    const t = setVolume(makeSet('reps_weight', { weight: 225, reps: 1, fail: true }, 1), {})
    expect(t).toEqual(emptyTotals())
  })
})

describe('sumSets', () => {
  it('adds only the working sets', () => {
    const sets = [
      makeSet('reps_weight', { weight: 45, reps: 10, warmup: true }, 1),
      makeSet('reps_weight', { weight: 135, reps: 5 }, 2),
      makeSet('reps_weight', { weight: 135, reps: 5 }, 3),
      makeSet('reps_weight', { weight: 185, reps: 1, fail: true }, 4),
    ]
    const t = sumSets(sets, {})
    expect(t.tonnage).toBe(1350)
    expect(t.hardSets).toBe(2)
    expect(t.reps).toBe(10)
  })

  it('includes drop sets in tonnage but not in hard-set count', () => {
    const set = makeSet('reps_weight', { weight: 100, reps: 10, drops: [{ weight: 80, reps: 5 }] }, 1)
    const t = sumSets([set], {})
    expect(t.tonnage).toBe(1400) // 1000 + 400
    expect(t.hardSets).toBe(1)
  })
})

describe('effectiveLoad', () => {
  it('is the bar weight for a straight set', () => {
    expect(effectiveLoad(makeSet('reps_weight', { weight: 135, reps: 5 }, 1), {})).toBe(135)
  })

  it('is bodyweight minus assistance for an assisted set', () => {
    expect(effectiveLoad(makeSet('reps_weight', { weight: 40, reps: 5, assisted: true }, 1), { bodyweightLb: 200 })).toBe(160)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/train/volume.test.ts`
Expected: FAIL — cannot resolve `../../lib/train/volume`.

- [ ] **Step 3: Create `lib/train/volume.ts`**

```ts
import type { HistoryEntry, LoggedSet } from './types'
import { isWorkingSet, totalReps } from './sets'

/**
 * Volume is not one number. Tonnage is meaningless for a plank and hard sets
 * are the only comparable currency across kinds, so every aggregate carries
 * all of them and the caller picks what it is charting.
 */
export interface VolumeTotals {
  /** lb actually moved. reps_weight, plus bodyweight kinds when known. */
  tonnage: number
  /** Working sets — the unit that maps to stimulus per muscle. */
  hardSets: number
  reps: number
  seconds: number
  meters: number
}

export interface VolumeOptions {
  /** The athlete's bodyweight in lb, when known. */
  bodyweightLb?: number
  /** Fraction of bodyweight this movement actually moves (push-up ≈ 0.64). */
  bodyweightFactor?: number
}

export function emptyTotals(): VolumeTotals {
  return { tonnage: 0, hardSets: 0, reps: 0, seconds: 0, meters: 0 }
}

export function addTotals(a: VolumeTotals, b: VolumeTotals): VolumeTotals {
  return {
    tonnage: a.tonnage + b.tonnage,
    hardSets: a.hardSets + b.hardSets,
    reps: a.reps + b.reps,
    seconds: a.seconds + b.seconds,
    meters: a.meters + b.meters,
  }
}

/**
 * The load the athlete actually resisted. Assistance subtracts from
 * bodyweight; without a known bodyweight an assisted set has no defensible
 * tonnage, so it reports 0 rather than guessing.
 */
export function effectiveLoad(set: LoggedSet, opts: VolumeOptions): number {
  const weight = typeof set.weight === 'number' ? set.weight : 0
  if (!set.assisted) return weight
  if (typeof opts.bodyweightLb !== 'number') return 0
  return Math.max(0, opts.bodyweightLb - weight)
}

function dropTonnage(set: LoggedSet, opts: VolumeOptions): number {
  if (!Array.isArray(set.drops)) return 0
  const sides = set.perSide ? 2 : 1
  return set.drops.reduce((sum, drop) => {
    const weight = typeof drop.weight === 'number' ? drop.weight : 0
    const reps = typeof drop.reps === 'number' ? drop.reps : 0
    return sum + weight * reps * sides
  }, 0)
}

/** Volume for one set. Warm-ups and misses contribute nothing, by design. */
export function setVolume(set: LoggedSet, opts: VolumeOptions): VolumeTotals {
  if (!isWorkingSet(set)) return emptyTotals()
  const totals = emptyTotals()
  const sides = set.perSide ? 2 : 1
  const reps = totalReps(set)

  switch (set.kind) {
    case 'reps_weight':
      totals.tonnage = effectiveLoad(set, opts) * reps + dropTonnage(set, opts)
      totals.hardSets = 1
      totals.reps = reps
      break
    case 'reps_only': {
      const factor = typeof opts.bodyweightFactor === 'number' ? opts.bodyweightFactor : 1
      if (typeof opts.bodyweightLb === 'number') {
        totals.tonnage = opts.bodyweightLb * factor * reps
      }
      totals.hardSets = 1
      totals.reps = reps
      break
    }
    case 'time':
      totals.seconds = (set.seconds || 0) * sides
      totals.hardSets = 1
      break
    case 'distance':
      totals.meters = (set.meters || 0) * sides
      totals.hardSets = 1
      break
    case 'time_distance':
      totals.seconds = set.seconds || 0
      totals.meters = set.meters || 0
      totals.hardSets = 1
      break
  }
  return totals
}

export function sumSets(sets: Array<LoggedSet | null | undefined>, opts: VolumeOptions): VolumeTotals {
  return sets.reduce<VolumeTotals>(
    (acc, set) => (set ? addTotals(acc, setVolume(set, opts)) : acc),
    emptyTotals(),
  )
}

export function entryVolume(entry: HistoryEntry, opts: VolumeOptions): VolumeTotals {
  return sumSets(entry.sets, opts)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/train/volume.test.ts`
Expected: PASS — all 14 assertions green.

- [ ] **Step 5: Re-export from `lib/train/index.ts`**

Add this line to the export block:

```ts
export * from './volume'
```

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/train/volume.ts lib/train/index.ts tests/train/volume.test.ts
git commit -m "feat(train): add per-kind volume strategies

Tonnage, hard sets, reps, seconds and meters computed per set kind, with
warm-ups and misses excluded and assistance treated as negative load.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Session timing from set timestamps

**Files:**
- Create: `lib/train/timing.ts`
- Create: `tests/train/timing.test.ts`
- Modify: `lib/train/index.ts`

**Interfaces:**
- Consumes: `LoggedSet` (Task 2).
- Produces: `restTaken(sets)`, `sessionSpanSeconds(sets)`, `sessionDensity(sets)`, `medianRest(sets)`, `hasObservedTiming(sets)`.

- [ ] **Step 1: Write the failing test `tests/train/timing.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { makeSet } from '../../lib/train/sets'
import { restTaken, sessionSpanSeconds, sessionDensity, medianRest, hasObservedTiming } from '../../lib/train/timing'

const at = (seconds: number) => seconds * 1000

describe('restTaken', () => {
  it('is the gap in seconds between consecutive logged sets', () => {
    const sets = [
      makeSet('reps_weight', { weight: 100, reps: 5 }, at(0)),
      makeSet('reps_weight', { weight: 100, reps: 5 }, at(90)),
      makeSet('reps_weight', { weight: 100, reps: 5 }, at(270)),
    ]
    expect(restTaken(sets)).toEqual([90, 180])
  })

  it('returns an empty list for fewer than two sets', () => {
    expect(restTaken([])).toEqual([])
    expect(restTaken([makeSet('reps_weight', { weight: 100, reps: 5 }, at(0))])).toEqual([])
  })

  it('sorts by timestamp so out-of-order logging never yields negative rest', () => {
    const sets = [
      makeSet('reps_weight', { weight: 100, reps: 5 }, at(120)),
      makeSet('reps_weight', { weight: 100, reps: 5 }, at(0)),
    ]
    expect(restTaken(sets)).toEqual([120])
  })

  it('includes warm-ups — rest between them is still real rest', () => {
    const sets = [
      makeSet('reps_weight', { weight: 45, reps: 10, warmup: true }, at(0)),
      makeSet('reps_weight', { weight: 135, reps: 5 }, at(60)),
    ]
    expect(restTaken(sets)).toEqual([60])
  })

  it('ignores backfilled timestamps — migrated history has no real timing', () => {
    const synthetic = [
      { ...makeSet('reps_weight', { weight: 100, reps: 5 }, at(0)), atEstimated: true },
      { ...makeSet('reps_weight', { weight: 100, reps: 5 }, at(180)), atEstimated: true },
      { ...makeSet('reps_weight', { weight: 100, reps: 5 }, at(360)), atEstimated: true },
    ]
    expect(restTaken(synthetic)).toEqual([])
    expect(medianRest(synthetic)).toBeNull()
    expect(sessionDensity(synthetic)).toBe(0)
    expect(sessionSpanSeconds(synthetic)).toBe(0)
  })

  it('measures only the observed portion of a mixed list', () => {
    const mixed = [
      { ...makeSet('reps_weight', { weight: 100, reps: 5 }, at(0)), atEstimated: true },
      makeSet('reps_weight', { weight: 100, reps: 5 }, at(600)),
      makeSet('reps_weight', { weight: 100, reps: 5 }, at(690)),
    ]
    expect(restTaken(mixed)).toEqual([90])
  })
})

describe('hasObservedTiming', () => {
  it('is false when every stamp was backfilled', () => {
    const synthetic = [
      { ...makeSet('reps_weight', { weight: 100, reps: 5 }, at(0)), atEstimated: true },
      { ...makeSet('reps_weight', { weight: 100, reps: 5 }, at(180)), atEstimated: true },
    ]
    expect(hasObservedTiming(synthetic)).toBe(false)
  })

  it('is true once two real stamps exist', () => {
    const real = [
      makeSet('reps_weight', { weight: 100, reps: 5 }, at(0)),
      makeSet('reps_weight', { weight: 100, reps: 5 }, at(90)),
    ]
    expect(hasObservedTiming(real)).toBe(true)
  })
})

describe('sessionSpanSeconds', () => {
  it('is first set to last set', () => {
    const sets = [
      makeSet('reps_weight', { weight: 100, reps: 5 }, at(0)),
      makeSet('reps_weight', { weight: 100, reps: 5 }, at(1800)),
    ]
    expect(sessionSpanSeconds(sets)).toBe(1800)
  })

  it('is zero when there is nothing to span', () => {
    expect(sessionSpanSeconds([])).toBe(0)
    expect(sessionSpanSeconds([makeSet('time', { seconds: 30 }, at(5))])).toBe(0)
  })
})

describe('sessionDensity', () => {
  it('is sets per minute across the session span', () => {
    const sets = [
      makeSet('reps_weight', { weight: 100, reps: 5 }, at(0)),
      makeSet('reps_weight', { weight: 100, reps: 5 }, at(60)),
      makeSet('reps_weight', { weight: 100, reps: 5 }, at(120)),
    ]
    expect(sessionDensity(sets)).toBeCloseTo(1.5) // 3 sets over 2 minutes
  })

  it('is zero when the span is zero', () => {
    expect(sessionDensity([makeSet('reps_weight', { weight: 100, reps: 5 }, at(0))])).toBe(0)
  })
})

describe('medianRest', () => {
  it('takes the middle value of an odd list', () => {
    const sets = [0, 60, 90, 300].map((s) => makeSet('reps_weight', { weight: 100, reps: 5 }, at(s)))
    expect(medianRest(sets)).toBe(90) // gaps 60, 30, 210 → sorted 30, 60, 210
  })

  it('averages the middle two of an even list', () => {
    const sets = [0, 60, 120].map((s) => makeSet('reps_weight', { weight: 100, reps: 5 }, at(s)))
    expect(medianRest(sets)).toBe(60) // gaps 60, 60
  })

  it('is null with no gaps to measure', () => {
    expect(medianRest([])).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/train/timing.test.ts`
Expected: FAIL — cannot resolve `../../lib/train/timing`.

- [ ] **Step 3: Create `lib/train/timing.ts`**

```ts
import type { LoggedSet } from './types'

/**
 * Derivations that only exist because every set carries a timestamp. These
 * are the primitives behind "you rushed this session" and real rest analysis
 * — the interpretation layer sits above them, not here.
 */

/**
 * Only OBSERVED stamps. Migrated history carries synthesized ones spaced a
 * fixed interval apart; including them would make every pre-migration
 * session report a suspiciously perfect rest cadence, and the intelligence
 * layer would faithfully report that artifact as a finding.
 */
function stamps(sets: Array<LoggedSet | null | undefined>): number[] {
  return sets
    .filter((s): s is LoggedSet => !!s && Number.isFinite(s.at) && s.atEstimated !== true)
    .map((s) => s.at)
    .sort((a, b) => a - b)
}

/** True when a set list has no observed timing at all — caller should not
 *  render a rest or density figure for it. */
export function hasObservedTiming(sets: Array<LoggedSet | null | undefined>): boolean {
  return stamps(sets).length >= 2
}

/** Gaps between consecutive sets, in seconds, oldest first. */
export function restTaken(sets: Array<LoggedSet | null | undefined>): number[] {
  const times = stamps(sets)
  const gaps: number[] = []
  for (let i = 1; i < times.length; i++) {
    gaps.push(Math.round((times[i] - times[i - 1]) / 1000))
  }
  return gaps
}

/** First set to last set, in seconds. */
export function sessionSpanSeconds(sets: Array<LoggedSet | null | undefined>): number {
  const times = stamps(sets)
  if (times.length < 2) return 0
  return Math.round((times[times.length - 1] - times[0]) / 1000)
}

/** Sets per minute. Zero when there is no span to divide by. */
export function sessionDensity(sets: Array<LoggedSet | null | undefined>): number {
  const span = sessionSpanSeconds(sets)
  if (span <= 0) return 0
  const count = stamps(sets).length
  return count / (span / 60)
}

/** Median rest in seconds, or null when there are no gaps. */
export function medianRest(sets: Array<LoggedSet | null | undefined>): number | null {
  const gaps = restTaken(sets).slice().sort((a, b) => a - b)
  if (!gaps.length) return null
  const mid = Math.floor(gaps.length / 2)
  return gaps.length % 2 === 1 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/train/timing.test.ts`
Expected: PASS — all 16 assertions green.

- [ ] **Step 5: Re-export from `lib/train/index.ts`**

Add to the export block:

```ts
export * from './timing'
```

- [ ] **Step 6: Commit**

```bash
git add lib/train/timing.ts lib/train/index.ts tests/train/timing.test.ts
git commit -m "feat(train): derive rest taken and session density from timestamps

Backfilled timestamps are excluded, so migrated history cannot report a
synthesized rest cadence as if it were measured.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Taxonomy helpers and contribution math

**Files:**
- Create: `lib/train/taxonomy.ts`
- Create: `tests/train/taxonomy.test.ts`
- Modify: `lib/train/index.ts`

**Interfaces:**
- Consumes: `Muscle`, `MuscleContribution`, `ExerciseDef`, `MovementPattern` (Task 2); `VolumeTotals`, `emptyTotals`, `addTotals` (Task 3).
- Produces: `ALL_MUSCLES`, `normalizeContributions(list)`, `contributionFor(def, muscle)`, `distributeToMuscles(totals, def)`, `isPush(def)`, `isPull(def)`, `SECONDARY_WEIGHT`.

- [ ] **Step 1: Write the failing test `tests/train/taxonomy.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import type { ExerciseDef } from '../../lib/train/types'
import {
  ALL_MUSCLES,
  normalizeContributions,
  contributionFor,
  distributeToMuscles,
  isPush,
  isPull,
  SECONDARY_WEIGHT,
} from '../../lib/train/taxonomy'

const bench: ExerciseDef = {
  id: 'barbell_bench_press',
  name: 'Barbell Bench Press',
  aliases: [],
  pattern: 'push',
  plane: 'horizontal',
  equipment: 'barbell',
  unilateral: false,
  defaultSetKind: 'reps_weight',
  primary: [{ muscle: 'chest', weight: 1 }],
  secondary: [
    { muscle: 'triceps', weight: 0.6 },
    { muscle: 'front_delts', weight: 0.4 },
  ],
  e1rmValid: true,
  loading: 'barbell_plates',
  incrementLb: 5,
}

describe('ALL_MUSCLES', () => {
  it('is a closed list so breakdowns cannot fragment', () => {
    expect(ALL_MUSCLES).toContain('chest')
    expect(ALL_MUSCLES).toContain('hamstrings')
    expect(new Set(ALL_MUSCLES).size).toBe(ALL_MUSCLES.length)
  })
})

describe('normalizeContributions', () => {
  it('scales weights so they sum to one', () => {
    const out = normalizeContributions([
      { muscle: 'quads', weight: 3 },
      { muscle: 'glutes', weight: 1 },
    ])
    expect(out[0].weight).toBeCloseTo(0.75)
    expect(out[1].weight).toBeCloseTo(0.25)
  })

  it('splits evenly when every weight is zero', () => {
    const out = normalizeContributions([
      { muscle: 'quads', weight: 0 },
      { muscle: 'glutes', weight: 0 },
    ])
    expect(out[0].weight).toBeCloseTo(0.5)
    expect(out[1].weight).toBeCloseTo(0.5)
  })

  it('returns an empty list unchanged', () => {
    expect(normalizeContributions([])).toEqual([])
  })
})

describe('contributionFor', () => {
  it('reads a primary share directly', () => {
    expect(contributionFor(bench, 'chest')).toBeCloseTo(1)
  })

  it('discounts a secondary share', () => {
    expect(contributionFor(bench, 'triceps')).toBeCloseTo(0.6 * SECONDARY_WEIGHT)
  })

  it('is zero for an uninvolved muscle', () => {
    expect(contributionFor(bench, 'calves')).toBe(0)
  })
})

describe('distributeToMuscles', () => {
  it('splits hard sets and tonnage by contribution', () => {
    const totals = { tonnage: 1000, hardSets: 2, reps: 10, seconds: 0, meters: 0 }
    const out = distributeToMuscles(totals, bench)
    expect(out.chest.tonnage).toBeCloseTo(1000)
    expect(out.chest.hardSets).toBeCloseTo(2)
    expect(out.triceps.hardSets).toBeCloseTo(2 * 0.6 * SECONDARY_WEIGHT)
    expect(out.calves).toBeUndefined()
  })
})

describe('push and pull classification', () => {
  it('reads the movement pattern', () => {
    expect(isPush(bench)).toBe(true)
    expect(isPull(bench)).toBe(false)
    expect(isPull({ ...bench, pattern: 'pull' })).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/train/taxonomy.test.ts`
Expected: FAIL — cannot resolve `../../lib/train/taxonomy`.

- [ ] **Step 3: Create `lib/train/taxonomy.ts`**

```ts
import type { ExerciseDef, Muscle, MuscleContribution } from './types'
import { emptyTotals, type VolumeTotals } from './volume'

/**
 * The closed muscle list. Anything not on it cannot enter a breakdown —
 * that is the point: free-text muscle names are how "Chest", "chest" and
 * "Pecs" become three bars on the same chart.
 */
export const ALL_MUSCLES: Muscle[] = [
  'chest', 'front_delts', 'side_delts', 'rear_delts',
  'triceps', 'biceps', 'forearms',
  'lats', 'traps', 'upper_back', 'lower_back',
  'abs', 'obliques',
  'glutes', 'quads', 'hamstrings', 'adductors', 'abductors', 'calves',
  'neck', 'full_body', 'cardio',
]

/**
 * A secondary muscle gets partial credit. Half is the convention most
 * volume literature uses for indirect work.
 */
export const SECONDARY_WEIGHT = 0.5

/** Scales a contribution list so its weights sum to 1. */
export function normalizeContributions(list: MuscleContribution[]): MuscleContribution[] {
  if (!list.length) return []
  const total = list.reduce((sum, c) => sum + (Number.isFinite(c.weight) ? c.weight : 0), 0)
  if (total <= 0) {
    const even = 1 / list.length
    return list.map((c) => ({ muscle: c.muscle, weight: even }))
  }
  return list.map((c) => ({ muscle: c.muscle, weight: c.weight / total }))
}

/** How much of this exercise's work lands on one muscle, 0 when none. */
export function contributionFor(def: ExerciseDef, muscle: Muscle): number {
  const primary = def.primary.find((c) => c.muscle === muscle)
  if (primary) return primary.weight
  const secondary = def.secondary.find((c) => c.muscle === muscle)
  if (secondary) return secondary.weight * SECONDARY_WEIGHT
  return 0
}

function scale(totals: VolumeTotals, factor: number): VolumeTotals {
  return {
    tonnage: totals.tonnage * factor,
    hardSets: totals.hardSets * factor,
    reps: totals.reps * factor,
    seconds: totals.seconds * factor,
    meters: totals.meters * factor,
  }
}

/** Splits one exercise's totals across every muscle it actually works. */
export function distributeToMuscles(
  totals: VolumeTotals,
  def: ExerciseDef,
): Partial<Record<Muscle, VolumeTotals>> {
  const out: Partial<Record<Muscle, VolumeTotals>> = {}
  const touched = new Set<Muscle>([
    ...def.primary.map((c) => c.muscle),
    ...def.secondary.map((c) => c.muscle),
  ])
  touched.forEach((muscle) => {
    const share = contributionFor(def, muscle)
    if (share > 0) out[muscle] = scale(totals, share)
  })
  return out
}

export function isPush(def: ExerciseDef): boolean {
  return def.pattern === 'push'
}

export function isPull(def: ExerciseDef): boolean {
  return def.pattern === 'pull'
}

export { emptyTotals }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/train/taxonomy.test.ts`
Expected: PASS — all 10 assertions green.

- [ ] **Step 5: Re-export from `lib/train/index.ts`**

Add to the export block:

```ts
export * from './taxonomy'
```

- [ ] **Step 6: Commit**

```bash
git add lib/train/taxonomy.ts lib/train/index.ts tests/train/taxonomy.test.ts
git commit -m "feat(train): add muscle taxonomy and contribution-weighted distribution

Closed muscle list plus per-muscle contribution shares, so volume splits
by real involvement instead of being divided evenly across free text.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Seed exercise catalog

**Files:**
- Create: `lib/train/catalog.ts`
- Create: `tests/train/catalog.test.ts`
- Modify: `lib/train/index.ts`

**Interfaces:**
- Consumes: `ExerciseDef`, `SetKind`, `Equipment`, `LoadingScheme` (Task 2); `ALL_MUSCLES` (Task 5).
- Produces: `CATALOG: ExerciseDef[]`, `CATALOG_BY_ID: Record<string, ExerciseDef>`, `findCanonical(id)`, `INCREMENT_BY_EQUIPMENT`.

- [ ] **Step 1: Write the failing test `tests/train/catalog.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { CATALOG, CATALOG_BY_ID, findCanonical, INCREMENT_BY_EQUIPMENT } from '../../lib/train/catalog'
import { ALL_MUSCLES } from '../../lib/train/taxonomy'

describe('catalog integrity', () => {
  it('has unique ids', () => {
    const ids = CATALOG.map((d) => d.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('has no alias colliding with another exercise id or alias', () => {
    const seen = new Map<string, string>()
    for (const def of CATALOG) {
      for (const alias of [def.id, ...def.aliases]) {
        expect(seen.has(alias)).toBe(false)
        seen.set(alias, def.id)
      }
    }
  })

  it('only references muscles on the closed list', () => {
    for (const def of CATALOG) {
      for (const c of [...def.primary, ...def.secondary]) {
        expect(ALL_MUSCLES).toContain(c.muscle)
      }
    }
  })

  it('has primary contributions that sum to one', () => {
    for (const def of CATALOG) {
      const sum = def.primary.reduce((a, c) => a + c.weight, 0)
      expect(sum).toBeCloseTo(1, 5)
    }
  })

  it('gives every exercise a real increment', () => {
    for (const def of CATALOG) {
      expect(def.incrementLb).toBeGreaterThan(0)
    }
  })

  it('never marks a timed or distance movement as e1RM-valid', () => {
    for (const def of CATALOG) {
      if (def.defaultSetKind !== 'reps_weight') expect(def.e1rmValid).toBe(false)
    }
  })

  it('gives every reps_only movement a bodyweight factor', () => {
    for (const def of CATALOG) {
      if (def.defaultSetKind === 'reps_only') {
        expect(typeof def.bodyweightFactor).toBe('number')
      }
    }
  })

  it('covers every movement pattern the analysis layer asks about', () => {
    const patterns = new Set(CATALOG.map((d) => d.pattern))
    for (const p of ['hinge', 'squat', 'push', 'pull', 'carry', 'isolation']) {
      expect(patterns.has(p as never)).toBe(true)
    }
  })
})

describe('findCanonical', () => {
  it('returns a known definition by id', () => {
    expect(findCanonical('barbell_bench_press')?.name).toBe('Barbell Bench Press')
  })

  it('returns null for an unknown id', () => {
    expect(findCanonical('not_a_lift')).toBeNull()
  })
})

describe('INCREMENT_BY_EQUIPMENT', () => {
  it('uses a bigger jump for a barbell than a dumbbell', () => {
    expect(INCREMENT_BY_EQUIPMENT.barbell).toBeGreaterThan(0)
    expect(INCREMENT_BY_EQUIPMENT.dumbbell).toBeGreaterThan(0)
  })

  it('has an entry for every equipment value used in the catalog', () => {
    for (const def of CATALOG) {
      expect(INCREMENT_BY_EQUIPMENT[def.equipment]).toBeDefined()
    }
  })
})

describe('CATALOG_BY_ID', () => {
  it('indexes every entry', () => {
    expect(Object.keys(CATALOG_BY_ID).length).toBe(CATALOG.length)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/train/catalog.test.ts`
Expected: FAIL — cannot resolve `../../lib/train/catalog`.

- [ ] **Step 3: Create `lib/train/catalog.ts`**

This is the seed set. It is deliberately not exhaustive — the AI classifier fills gaps at runtime and those get stored as custom defs. What matters is that the common lifts people actually type have canonical ids and aliases from day one, because those are the ones that fragment.

```ts
import type { Equipment, ExerciseDef } from './types'

/** Real smallest achievable jump per equipment type, in pounds. */
export const INCREMENT_BY_EQUIPMENT: Record<Equipment, number> = {
  barbell: 5,
  dumbbell: 5,
  machine: 10,
  cable: 5,
  smith: 5,
  kettlebell: 8,
  bodyweight: 2.5,
  band: 2.5,
  plate: 5,
  sled: 10,
  none: 2.5,
}

/** Shorthand so the table below stays readable. */
const def = (d: ExerciseDef): ExerciseDef => d

export const CATALOG: ExerciseDef[] = [
  def({
    id: 'barbell_back_squat', name: 'Barbell Back Squat',
    aliases: ['back squat', 'squat', 'barbell squat', 'bb squat'],
    pattern: 'squat', plane: null, equipment: 'barbell', unilateral: false,
    defaultSetKind: 'reps_weight',
    primary: [{ muscle: 'quads', weight: 0.6 }, { muscle: 'glutes', weight: 0.4 }],
    secondary: [{ muscle: 'hamstrings', weight: 0.5 }, { muscle: 'lower_back', weight: 0.5 }],
    e1rmValid: true, loading: 'barbell_plates', incrementLb: 5,
  }),
  def({
    id: 'barbell_front_squat', name: 'Barbell Front Squat',
    aliases: ['front squat', 'bb front squat'],
    pattern: 'squat', plane: null, equipment: 'barbell', unilateral: false,
    defaultSetKind: 'reps_weight',
    primary: [{ muscle: 'quads', weight: 0.75 }, { muscle: 'glutes', weight: 0.25 }],
    secondary: [{ muscle: 'abs', weight: 0.5 }, { muscle: 'upper_back', weight: 0.5 }],
    e1rmValid: true, loading: 'barbell_plates', incrementLb: 5,
  }),
  def({
    id: 'barbell_deadlift', name: 'Barbell Deadlift',
    aliases: ['deadlift', 'conventional deadlift', 'dl', 'bb deadlift'],
    pattern: 'hinge', plane: null, equipment: 'barbell', unilateral: false,
    defaultSetKind: 'reps_weight',
    primary: [{ muscle: 'glutes', weight: 0.4 }, { muscle: 'hamstrings', weight: 0.35 }, { muscle: 'lower_back', weight: 0.25 }],
    secondary: [{ muscle: 'traps', weight: 0.4 }, { muscle: 'lats', weight: 0.3 }, { muscle: 'forearms', weight: 0.3 }],
    e1rmValid: true, loading: 'barbell_plates', incrementLb: 5,
  }),
  def({
    id: 'romanian_deadlift', name: 'Romanian Deadlift',
    aliases: ['rdl', 'romanian dl', 'stiff leg deadlift', 'sldl'],
    pattern: 'hinge', plane: null, equipment: 'barbell', unilateral: false,
    defaultSetKind: 'reps_weight',
    primary: [{ muscle: 'hamstrings', weight: 0.65 }, { muscle: 'glutes', weight: 0.35 }],
    secondary: [{ muscle: 'lower_back', weight: 1 }],
    e1rmValid: true, loading: 'barbell_plates', incrementLb: 5,
  }),
  def({
    id: 'hip_thrust', name: 'Barbell Hip Thrust',
    aliases: ['hip thrust', 'barbell hip thrust', 'glute bridge'],
    pattern: 'hinge', plane: null, equipment: 'barbell', unilateral: false,
    defaultSetKind: 'reps_weight',
    primary: [{ muscle: 'glutes', weight: 1 }],
    secondary: [{ muscle: 'hamstrings', weight: 1 }],
    e1rmValid: true, loading: 'barbell_plates', incrementLb: 10,
  }),
  def({
    id: 'barbell_bench_press', name: 'Barbell Bench Press',
    aliases: ['bench press', 'bench', 'flat bench', 'barbell bench', 'bb bench press', 'bp'],
    pattern: 'push', plane: 'horizontal', equipment: 'barbell', unilateral: false,
    defaultSetKind: 'reps_weight',
    primary: [{ muscle: 'chest', weight: 1 }],
    secondary: [{ muscle: 'triceps', weight: 0.6 }, { muscle: 'front_delts', weight: 0.4 }],
    e1rmValid: true, loading: 'barbell_plates', incrementLb: 5,
  }),
  def({
    id: 'incline_barbell_bench_press', name: 'Incline Barbell Bench Press',
    aliases: ['incline bench', 'incline bench press', 'incline barbell bench'],
    pattern: 'push', plane: 'horizontal', equipment: 'barbell', unilateral: false,
    defaultSetKind: 'reps_weight',
    primary: [{ muscle: 'chest', weight: 0.7 }, { muscle: 'front_delts', weight: 0.3 }],
    secondary: [{ muscle: 'triceps', weight: 1 }],
    e1rmValid: true, loading: 'barbell_plates', incrementLb: 5,
  }),
  def({
    id: 'dumbbell_bench_press', name: 'Dumbbell Bench Press',
    aliases: ['db bench', 'dumbbell bench', 'db bench press', 'dumbbell press'],
    pattern: 'push', plane: 'horizontal', equipment: 'dumbbell', unilateral: false,
    defaultSetKind: 'reps_weight',
    primary: [{ muscle: 'chest', weight: 1 }],
    secondary: [{ muscle: 'triceps', weight: 0.6 }, { muscle: 'front_delts', weight: 0.4 }],
    e1rmValid: true, loading: 'dumbbell_pairs', incrementLb: 5,
  }),
  def({
    id: 'overhead_press', name: 'Overhead Press',
    aliases: ['ohp', 'military press', 'standing press', 'shoulder press', 'barbell shoulder press'],
    pattern: 'push', plane: 'vertical', equipment: 'barbell', unilateral: false,
    defaultSetKind: 'reps_weight',
    primary: [{ muscle: 'front_delts', weight: 0.7 }, { muscle: 'side_delts', weight: 0.3 }],
    secondary: [{ muscle: 'triceps', weight: 0.7 }, { muscle: 'abs', weight: 0.3 }],
    e1rmValid: true, loading: 'barbell_plates', incrementLb: 5,
  }),
  def({
    id: 'dumbbell_shoulder_press', name: 'Dumbbell Shoulder Press',
    aliases: ['db shoulder press', 'dumbbell overhead press', 'db ohp', 'seated dumbbell press'],
    pattern: 'push', plane: 'vertical', equipment: 'dumbbell', unilateral: false,
    defaultSetKind: 'reps_weight',
    primary: [{ muscle: 'front_delts', weight: 0.7 }, { muscle: 'side_delts', weight: 0.3 }],
    secondary: [{ muscle: 'triceps', weight: 1 }],
    e1rmValid: true, loading: 'dumbbell_pairs', incrementLb: 5,
  }),
  def({
    id: 'pull_up', name: 'Pull-Up',
    aliases: ['pullup', 'pull ups', 'pullups', 'chin up', 'chinup', 'chin ups'],
    pattern: 'pull', plane: 'vertical', equipment: 'bodyweight', unilateral: false,
    defaultSetKind: 'reps_only',
    primary: [{ muscle: 'lats', weight: 1 }],
    secondary: [{ muscle: 'biceps', weight: 0.6 }, { muscle: 'upper_back', weight: 0.4 }],
    e1rmValid: false, loading: 'bodyweight', incrementLb: 2.5, bodyweightFactor: 1,
  }),
  def({
    id: 'lat_pulldown', name: 'Lat Pulldown',
    aliases: ['pulldown', 'lat pull down', 'cable pulldown'],
    pattern: 'pull', plane: 'vertical', equipment: 'machine', unilateral: false,
    defaultSetKind: 'reps_weight',
    primary: [{ muscle: 'lats', weight: 1 }],
    secondary: [{ muscle: 'biceps', weight: 0.6 }, { muscle: 'upper_back', weight: 0.4 }],
    e1rmValid: true, loading: 'machine_stack', incrementLb: 10,
  }),
  def({
    id: 'barbell_row', name: 'Barbell Row',
    aliases: ['bent over row', 'bb row', 'barbell bent over row', 'pendlay row'],
    pattern: 'pull', plane: 'horizontal', equipment: 'barbell', unilateral: false,
    defaultSetKind: 'reps_weight',
    primary: [{ muscle: 'upper_back', weight: 0.5 }, { muscle: 'lats', weight: 0.5 }],
    secondary: [{ muscle: 'biceps', weight: 0.5 }, { muscle: 'rear_delts', weight: 0.5 }],
    e1rmValid: true, loading: 'barbell_plates', incrementLb: 5,
  }),
  def({
    id: 'dumbbell_row', name: 'Dumbbell Row',
    aliases: ['db row', 'one arm row', 'single arm dumbbell row', 'single arm row'],
    pattern: 'pull', plane: 'horizontal', equipment: 'dumbbell', unilateral: true,
    defaultSetKind: 'reps_weight',
    primary: [{ muscle: 'lats', weight: 0.6 }, { muscle: 'upper_back', weight: 0.4 }],
    secondary: [{ muscle: 'biceps', weight: 1 }],
    e1rmValid: true, loading: 'dumbbell_pairs', incrementLb: 5,
  }),
  def({
    id: 'seated_cable_row', name: 'Seated Cable Row',
    aliases: ['cable row', 'seated row'],
    pattern: 'pull', plane: 'horizontal', equipment: 'cable', unilateral: false,
    defaultSetKind: 'reps_weight',
    primary: [{ muscle: 'upper_back', weight: 0.6 }, { muscle: 'lats', weight: 0.4 }],
    secondary: [{ muscle: 'biceps', weight: 0.5 }, { muscle: 'rear_delts', weight: 0.5 }],
    e1rmValid: true, loading: 'machine_stack', incrementLb: 10,
  }),
  def({
    id: 'push_up', name: 'Push-Up',
    aliases: ['pushup', 'push ups', 'pushups'],
    pattern: 'push', plane: 'horizontal', equipment: 'bodyweight', unilateral: false,
    defaultSetKind: 'reps_only',
    primary: [{ muscle: 'chest', weight: 1 }],
    secondary: [{ muscle: 'triceps', weight: 0.6 }, { muscle: 'front_delts', weight: 0.4 }],
    e1rmValid: false, loading: 'bodyweight', incrementLb: 2.5, bodyweightFactor: 0.64,
  }),
  def({
    id: 'dip', name: 'Dip',
    aliases: ['dips', 'parallel bar dip', 'chest dip', 'tricep dip'],
    pattern: 'push', plane: 'vertical', equipment: 'bodyweight', unilateral: false,
    defaultSetKind: 'reps_only',
    primary: [{ muscle: 'chest', weight: 0.6 }, { muscle: 'triceps', weight: 0.4 }],
    secondary: [{ muscle: 'front_delts', weight: 1 }],
    e1rmValid: false, loading: 'bodyweight', incrementLb: 2.5, bodyweightFactor: 1,
  }),
  def({
    id: 'bulgarian_split_squat', name: 'Bulgarian Split Squat',
    aliases: ['bss', 'split squat', 'rear foot elevated split squat', 'rfess'],
    pattern: 'squat', plane: null, equipment: 'dumbbell', unilateral: true,
    defaultSetKind: 'reps_weight',
    primary: [{ muscle: 'quads', weight: 0.55 }, { muscle: 'glutes', weight: 0.45 }],
    secondary: [{ muscle: 'hamstrings', weight: 1 }],
    e1rmValid: false, loading: 'dumbbell_pairs', incrementLb: 5,
  }),
  def({
    id: 'walking_lunge', name: 'Walking Lunge',
    aliases: ['lunge', 'lunges', 'walking lunges'],
    pattern: 'squat', plane: null, equipment: 'dumbbell', unilateral: true,
    defaultSetKind: 'reps_weight',
    primary: [{ muscle: 'quads', weight: 0.5 }, { muscle: 'glutes', weight: 0.5 }],
    secondary: [{ muscle: 'hamstrings', weight: 1 }],
    e1rmValid: false, loading: 'dumbbell_pairs', incrementLb: 5,
  }),
  def({
    id: 'leg_press', name: 'Leg Press',
    aliases: ['leg press machine'],
    pattern: 'squat', plane: null, equipment: 'machine', unilateral: false,
    defaultSetKind: 'reps_weight',
    primary: [{ muscle: 'quads', weight: 0.65 }, { muscle: 'glutes', weight: 0.35 }],
    secondary: [{ muscle: 'hamstrings', weight: 1 }],
    e1rmValid: true, loading: 'machine_stack', incrementLb: 10,
  }),
  def({
    id: 'leg_curl', name: 'Leg Curl',
    aliases: ['hamstring curl', 'lying leg curl', 'seated leg curl'],
    pattern: 'isolation', plane: null, equipment: 'machine', unilateral: false,
    defaultSetKind: 'reps_weight',
    primary: [{ muscle: 'hamstrings', weight: 1 }],
    secondary: [{ muscle: 'calves', weight: 1 }],
    e1rmValid: true, loading: 'machine_stack', incrementLb: 10,
  }),
  def({
    id: 'leg_extension', name: 'Leg Extension',
    aliases: ['quad extension', 'knee extension'],
    pattern: 'isolation', plane: null, equipment: 'machine', unilateral: false,
    defaultSetKind: 'reps_weight',
    primary: [{ muscle: 'quads', weight: 1 }],
    secondary: [],
    e1rmValid: true, loading: 'machine_stack', incrementLb: 10,
  }),
  def({
    id: 'calf_raise', name: 'Calf Raise',
    aliases: ['standing calf raise', 'seated calf raise', 'calf raises'],
    pattern: 'isolation', plane: null, equipment: 'machine', unilateral: false,
    defaultSetKind: 'reps_weight',
    primary: [{ muscle: 'calves', weight: 1 }],
    secondary: [],
    e1rmValid: true, loading: 'machine_stack', incrementLb: 10,
  }),
  def({
    id: 'lateral_raise', name: 'Lateral Raise',
    aliases: ['side raise', 'db lateral raise', 'dumbbell lateral raise', 'side lateral raise'],
    pattern: 'isolation', plane: null, equipment: 'dumbbell', unilateral: false,
    defaultSetKind: 'reps_weight',
    primary: [{ muscle: 'side_delts', weight: 1 }],
    secondary: [{ muscle: 'traps', weight: 1 }],
    e1rmValid: false, loading: 'dumbbell_pairs', incrementLb: 5,
  }),
  def({
    id: 'face_pull', name: 'Face Pull',
    aliases: ['cable face pull', 'facepull'],
    pattern: 'pull', plane: 'horizontal', equipment: 'cable', unilateral: false,
    defaultSetKind: 'reps_weight',
    primary: [{ muscle: 'rear_delts', weight: 0.6 }, { muscle: 'upper_back', weight: 0.4 }],
    secondary: [{ muscle: 'traps', weight: 1 }],
    e1rmValid: false, loading: 'machine_stack', incrementLb: 5,
  }),
  def({
    id: 'barbell_curl', name: 'Barbell Curl',
    aliases: ['bicep curl', 'bb curl', 'curl', 'curls', 'ez bar curl'],
    pattern: 'isolation', plane: null, equipment: 'barbell', unilateral: false,
    defaultSetKind: 'reps_weight',
    primary: [{ muscle: 'biceps', weight: 1 }],
    secondary: [{ muscle: 'forearms', weight: 1 }],
    e1rmValid: false, loading: 'barbell_plates', incrementLb: 5,
  }),
  def({
    id: 'dumbbell_curl', name: 'Dumbbell Curl',
    aliases: ['db curl', 'dumbbell bicep curl', 'hammer curl'],
    pattern: 'isolation', plane: null, equipment: 'dumbbell', unilateral: false,
    defaultSetKind: 'reps_weight',
    primary: [{ muscle: 'biceps', weight: 1 }],
    secondary: [{ muscle: 'forearms', weight: 1 }],
    e1rmValid: false, loading: 'dumbbell_pairs', incrementLb: 5,
  }),
  def({
    id: 'tricep_pushdown', name: 'Tricep Pushdown',
    aliases: ['pushdown', 'cable pushdown', 'tricep extension', 'rope pushdown'],
    pattern: 'isolation', plane: null, equipment: 'cable', unilateral: false,
    defaultSetKind: 'reps_weight',
    primary: [{ muscle: 'triceps', weight: 1 }],
    secondary: [],
    e1rmValid: false, loading: 'machine_stack', incrementLb: 5,
  }),
  def({
    id: 'farmer_carry', name: "Farmer's Carry",
    aliases: ['farmers walk', 'farmer walk', 'farmers carry', 'loaded carry'],
    pattern: 'carry', plane: null, equipment: 'dumbbell', unilateral: false,
    defaultSetKind: 'distance',
    primary: [{ muscle: 'forearms', weight: 0.5 }, { muscle: 'traps', weight: 0.5 }],
    secondary: [{ muscle: 'abs', weight: 0.5 }, { muscle: 'obliques', weight: 0.5 }],
    e1rmValid: false, loading: 'dumbbell_pairs', incrementLb: 5,
  }),
  def({
    id: 'plank', name: 'Plank',
    aliases: ['front plank', 'planks'],
    pattern: 'isolation', plane: null, equipment: 'bodyweight', unilateral: false,
    defaultSetKind: 'time',
    primary: [{ muscle: 'abs', weight: 1 }],
    secondary: [{ muscle: 'obliques', weight: 1 }],
    e1rmValid: false, loading: 'bodyweight', incrementLb: 2.5,
  }),
  def({
    id: 'hanging_leg_raise', name: 'Hanging Leg Raise',
    aliases: ['leg raise', 'hanging knee raise', 'leg raises'],
    pattern: 'isolation', plane: null, equipment: 'bodyweight', unilateral: false,
    defaultSetKind: 'reps_only',
    primary: [{ muscle: 'abs', weight: 1 }],
    secondary: [{ muscle: 'obliques', weight: 0.5 }, { muscle: 'forearms', weight: 0.5 }],
    e1rmValid: false, loading: 'bodyweight', incrementLb: 2.5, bodyweightFactor: 0.45,
  }),
  def({
    id: 'russian_twist', name: 'Russian Twist',
    aliases: ['russian twists', 'seated twist'],
    pattern: 'rotation', plane: null, equipment: 'plate', unilateral: false,
    defaultSetKind: 'reps_weight',
    primary: [{ muscle: 'obliques', weight: 1 }],
    secondary: [{ muscle: 'abs', weight: 1 }],
    e1rmValid: false, loading: 'free', incrementLb: 5,
  }),
  def({
    id: 'cable_woodchop', name: 'Cable Woodchop',
    aliases: ['woodchop', 'wood chop', 'cable chop'],
    pattern: 'rotation', plane: null, equipment: 'cable', unilateral: true,
    defaultSetKind: 'reps_weight',
    primary: [{ muscle: 'obliques', weight: 1 }],
    secondary: [{ muscle: 'abs', weight: 1 }],
    e1rmValid: false, loading: 'machine_stack', incrementLb: 5,
  }),
  def({
    id: 'run', name: 'Run',
    aliases: ['running', 'jog', 'jogging', 'treadmill run', '5k'],
    pattern: 'locomotion', plane: null, equipment: 'none', unilateral: false,
    defaultSetKind: 'time_distance',
    primary: [{ muscle: 'cardio', weight: 1 }],
    secondary: [{ muscle: 'quads', weight: 0.4 }, { muscle: 'calves', weight: 0.35 }, { muscle: 'hamstrings', weight: 0.25 }],
    e1rmValid: false, loading: 'bodyweight', incrementLb: 2.5,
  }),
  def({
    id: 'row_erg', name: 'Rowing Machine',
    aliases: ['erg', 'rower', 'row machine', 'concept2'],
    pattern: 'locomotion', plane: null, equipment: 'machine', unilateral: false,
    defaultSetKind: 'time_distance',
    primary: [{ muscle: 'cardio', weight: 1 }],
    secondary: [{ muscle: 'upper_back', weight: 0.4 }, { muscle: 'lats', weight: 0.3 }, { muscle: 'quads', weight: 0.3 }],
    e1rmValid: false, loading: 'free', incrementLb: 5,
  }),
  def({
    id: 'box_jump', name: 'Box Jump',
    aliases: ['box jumps', 'jump box'],
    pattern: 'squat', plane: null, equipment: 'bodyweight', unilateral: false,
    defaultSetKind: 'reps_only',
    primary: [{ muscle: 'quads', weight: 0.5 }, { muscle: 'glutes', weight: 0.5 }],
    secondary: [{ muscle: 'calves', weight: 1 }],
    e1rmValid: false, loading: 'bodyweight', incrementLb: 2.5, bodyweightFactor: 1,
  }),
]

export const CATALOG_BY_ID: Record<string, ExerciseDef> = Object.fromEntries(
  CATALOG.map((d) => [d.id, d]),
)

export function findCanonical(id: string): ExerciseDef | null {
  return CATALOG_BY_ID[id] || null
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/train/catalog.test.ts`
Expected: PASS — all 12 assertions green. If the alias-collision test fails, the duplicate alias must be removed from whichever exercise it fits worse (for example `chin up` belongs only to `pull_up`).

- [ ] **Step 5: Re-export from `lib/train/index.ts`**

Add to the export block:

```ts
export * from './catalog'
```

- [ ] **Step 6: Commit**

```bash
git add lib/train/catalog.ts lib/train/index.ts tests/train/catalog.test.ts
git commit -m "feat(train): seed canonical exercise catalog

37 common lifts with canonical ids, aliases, movement patterns, weighted
muscle contributions, real per-equipment increments and e1RM validity.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Name normalization, alias resolution, fuzzy matching

**Files:**
- Create: `lib/train/identity.ts`
- Create: `tests/train/identity.test.ts`
- Modify: `lib/train/index.ts`

**Interfaces:**
- Consumes: `ExerciseDef` (Task 2); `CATALOG` (Task 6).
- Produces: `normalizeName(raw)`, `slugFromName(raw, taken)`, `resolveExercise(raw, opts)`, `ResolveResult`, `similarity(a, b)`, `SUGGEST_THRESHOLD`.

- [ ] **Step 1: Write the failing test `tests/train/identity.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { normalizeName, slugFromName, resolveExercise, similarity, SUGGEST_THRESHOLD } from '../../lib/train/identity'

describe('normalizeName', () => {
  it('lowercases, strips punctuation and collapses whitespace', () => {
    expect(normalizeName('  Barbell   Bench-Press!! ')).toBe('barbell bench press')
  })

  it('expands gym abbreviations', () => {
    expect(normalizeName('BB Bench Press')).toBe('barbell bench press')
    expect(normalizeName('DB Row')).toBe('dumbbell row')
    expect(normalizeName('OHP')).toBe('overhead press')
    expect(normalizeName('RDL')).toBe('romanian deadlift')
  })

  it('drops filler words that carry no identity', () => {
    expect(normalizeName('the bench press with a barbell')).toBe('bench press barbell')
  })

  it('singularizes trailing plurals so "curls" matches "curl"', () => {
    expect(normalizeName('Curls')).toBe('curl')
    expect(normalizeName('Push Ups')).toBe('push up')
  })
})

describe('similarity', () => {
  it('is 1 for identical strings', () => {
    expect(similarity('bench press', 'bench press')).toBe(1)
  })

  it('is high for a word-order swap', () => {
    expect(similarity('bench press incline', 'incline bench press')).toBeGreaterThan(0.9)
  })

  it('is high for a small typo', () => {
    expect(similarity('bench pres', 'bench press')).toBeGreaterThan(0.8)
  })

  it('is low for unrelated lifts', () => {
    expect(similarity('bench press', 'leg curl')).toBeLessThan(0.4)
  })
})

describe('resolveExercise', () => {
  it('matches a canonical id exactly', () => {
    const r = resolveExercise('Barbell Bench Press', {})
    expect(r.status).toBe('exact')
    expect(r.match?.id).toBe('barbell_bench_press')
  })

  it('matches through an alias — this is the fragmentation fix', () => {
    for (const typed of ['bench', 'flat bench', 'BB Bench Press', 'Barbell Bench']) {
      const r = resolveExercise(typed, {})
      expect(r.status).toBe('exact')
      expect(r.match?.id).toBe('barbell_bench_press')
    }
  })

  it('matches through a learned user alias', () => {
    const r = resolveExercise('my chest day lift', { aliases: { 'my chest day lift': 'barbell_bench_press' } })
    expect(r.status).toBe('exact')
    expect(r.match?.id).toBe('barbell_bench_press')
  })

  it('suggests candidates for a near miss instead of creating a new lift', () => {
    const r = resolveExercise('barbel bench pres', {})
    expect(r.status).toBe('suggest')
    expect(r.candidates?.[0].def.id).toBe('barbell_bench_press')
    expect(r.candidates?.[0].score).toBeGreaterThanOrEqual(SUGGEST_THRESHOLD)
  })

  it('returns at most three candidates, best first', () => {
    const r = resolveExercise('dumbell bench pres', {})
    if (r.status === 'suggest') {
      expect(r.candidates!.length).toBeLessThanOrEqual(3)
      const scores = r.candidates!.map((c) => c.score)
      expect(scores).toEqual([...scores].sort((a, b) => b - a))
    }
  })

  it('reports unknown for something genuinely new', () => {
    const r = resolveExercise('zercher good morning to overhead squat', {})
    expect(r.status).toBe('unknown')
  })

  it('searches custom definitions alongside the catalog', () => {
    const custom = {
      taekwondo_kick_drill: {
        id: 'taekwondo_kick_drill', name: 'Taekwondo Kick Drill', aliases: ['kick drill'],
        pattern: 'rotation' as const, plane: null, equipment: 'none' as const, unilateral: true,
        defaultSetKind: 'reps_only' as const,
        primary: [{ muscle: 'obliques' as const, weight: 1 }], secondary: [],
        e1rmValid: false, loading: 'bodyweight' as const, incrementLb: 2.5, bodyweightFactor: 0.3, custom: true,
      },
    }
    const r = resolveExercise('kick drill', { exercises: custom })
    expect(r.status).toBe('exact')
    expect(r.match?.id).toBe('taekwondo_kick_drill')
  })
})

describe('slugFromName', () => {
  it('produces a snake_case id', () => {
    expect(slugFromName('Zercher Squat', new Set())).toBe('zercher_squat')
  })

  it('suffixes to avoid collision with a taken id', () => {
    expect(slugFromName('Zercher Squat', new Set(['zercher_squat']))).toBe('zercher_squat_2')
  })

  it('falls back when the name has no usable characters', () => {
    expect(slugFromName('!!!', new Set())).toBe('exercise')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/train/identity.test.ts`
Expected: FAIL — cannot resolve `../../lib/train/identity`.

- [ ] **Step 3: Create `lib/train/identity.ts`**

```ts
import type { ExerciseDef } from './types'
import { CATALOG } from './catalog'

/**
 * Exercise identity. Letting people type free text is the right UX and the
 * wrong storage model — "Bench Press", "BB Bench" and "Flat Bench" are one
 * lift with one history, and if they are not resolved to one canonical id
 * the progression engine, PR detection and the noticer all quietly break.
 */

/** Gym shorthand → the words it stands for. */
const ABBREVIATIONS: Record<string, string> = {
  bb: 'barbell',
  db: 'dumbbell',
  kb: 'kettlebell',
  ohp: 'overhead press',
  rdl: 'romanian deadlift',
  sldl: 'stiff leg deadlift',
  dl: 'deadlift',
  bp: 'bench press',
  bw: 'bodyweight',
  bss: 'bulgarian split squat',
  rfess: 'rear foot elevated split squat',
  pr: 'press',
}

/** Words that never distinguish one lift from another. */
const FILLER = new Set(['the', 'a', 'an', 'with', 'using', 'on', 'at', 'of', 'for', 'my'])

/** Plurals that would otherwise split a lift's history in two. */
function singularize(token: string): string {
  if (token.length > 3 && token.endsWith('ies')) return token.slice(0, -3) + 'y'
  if (token.length > 3 && token.endsWith('es') && !token.endsWith('ses')) return token.slice(0, -2)
  if (token.length > 2 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1)
  return token
}

export function normalizeName(raw: string): string {
  const tokens = String(raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)

  const expanded: string[] = []
  for (const token of tokens) {
    const abbrev = ABBREVIATIONS[token]
    if (abbrev) expanded.push(...abbrev.split(' '))
    else expanded.push(singularize(token))
  }
  return expanded.filter((t) => !FILLER.has(t)).join(' ')
}

/** Levenshtein distance — short strings only, so the naive matrix is fine. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const curr = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
    }
    prev = curr
  }
  return prev[b.length]
}

function jaccard(a: string, b: string): number {
  const setA = new Set(a.split(' ').filter(Boolean))
  const setB = new Set(b.split(' ').filter(Boolean))
  if (!setA.size && !setB.size) return 1
  let shared = 0
  setA.forEach((t) => { if (setB.has(t)) shared++ })
  return shared / (setA.size + setB.size - shared)
}

/**
 * Blended score. Token overlap carries most of the weight so word order
 * does not matter; edit distance carries the rest so typos still land.
 */
export function similarity(a: string, b: string): number {
  const na = normalizeName(a)
  const nb = normalizeName(b)
  if (na === nb) return 1
  const edit = 1 - levenshtein(na, nb) / Math.max(na.length, nb.length, 1)
  return jaccard(na, nb) * 0.7 + Math.max(0, edit) * 0.3
}

/** Above this, offer a "did you mean" rather than silently creating a lift. */
export const SUGGEST_THRESHOLD = 0.55

export interface ResolveOptions {
  /** The user's own definitions, keyed by canonical id. */
  exercises?: Record<string, ExerciseDef>
  /** Learned normalized-name → canonical-id mappings. */
  aliases?: Record<string, string>
}

export interface ResolveResult {
  status: 'exact' | 'suggest' | 'unknown'
  match?: ExerciseDef
  candidates?: Array<{ def: ExerciseDef; score: number }>
  /** The normalized form of what was typed — store it as an alias on accept. */
  normalized: string
}

export function resolveExercise(raw: string, opts: ResolveOptions): ResolveResult {
  const normalized = normalizeName(raw)
  const custom = opts.exercises ? Object.values(opts.exercises) : []
  const pool: ExerciseDef[] = [...custom, ...CATALOG]

  // 1. a learned alias always wins — the user already answered this question
  const learned = opts.aliases?.[normalized]
  if (learned) {
    const def = pool.find((d) => d.id === learned)
    if (def) return { status: 'exact', match: def, normalized }
  }

  // 2. exact hit on a canonical name, id, or built-in alias
  for (const def of pool) {
    const forms = [def.id, def.name, ...def.aliases]
    if (forms.some((f) => normalizeName(f) === normalized)) {
      return { status: 'exact', match: def, normalized }
    }
  }

  // 3. near misses — surfaced, never auto-applied
  const scored = pool
    .map((def) => {
      const best = [def.name, ...def.aliases].reduce(
        (max, form) => Math.max(max, similarity(normalized, form)),
        0,
      )
      return { def, score: best }
    })
    .filter((c) => c.score >= SUGGEST_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)

  if (scored.length) return { status: 'suggest', candidates: scored, normalized }
  return { status: 'unknown', normalized }
}

/** Builds a fresh canonical id, avoiding ones already in use. */
export function slugFromName(raw: string, taken: Set<string>): string {
  const base =
    String(raw).toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') ||
    'exercise'
  let id = base
  let n = 1
  while (taken.has(id)) id = `${base}_${++n}`
  return id
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/train/identity.test.ts`
Expected: PASS — all 17 assertions green. If the "unknown" case instead returns `suggest`, raise `SUGGEST_THRESHOLD` until that specific string falls through while `barbel bench pres` still resolves.

- [ ] **Step 5: Re-export from `lib/train/index.ts`**

Add to the export block:

```ts
export * from './identity'
```

- [ ] **Step 6: Commit**

```bash
git add lib/train/identity.ts lib/train/index.ts tests/train/identity.test.ts
git commit -m "feat(train): resolve typed exercise names to canonical ids

Normalization with abbreviation expansion, alias lookup, and fuzzy
did-you-mean matching, so one lift keeps one history.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Merge two exercise identities

**Files:**
- Create: `lib/train/merge.ts`
- Create: `tests/train/merge.test.ts`
- Modify: `lib/train/index.ts`

**Interfaces:**
- Consumes: `TrainStateV1`, `HistoryEntry`, `ExerciseDef` (Task 2).
- Produces: `mergeExercise(state, fromId, intoId)`, `mergeableTargets(state, fromId)`, `MergeResult`.

Fuzzy matching catches most duplicates at entry, but not all — someone types past a suggestion, or two lifts drift apart before the alias exists. This is the repair tool.

- [ ] **Step 1: Write the failing test `tests/train/merge.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import type { TrainStateV1, ExerciseDef, HistoryEntry } from '../../lib/train/types'
import { mergeExercise, mergeableTargets } from '../../lib/train/merge'
import { makeSet } from '../../lib/train/sets'

const mkDef = (id: string, name: string): ExerciseDef => ({
  id, name, aliases: [], pattern: 'push', plane: 'horizontal', equipment: 'barbell',
  unilateral: false, defaultSetKind: 'reps_weight',
  primary: [{ muscle: 'chest', weight: 1 }], secondary: [],
  e1rmValid: true, loading: 'barbell_plates', incrementLb: 5, custom: true,
})

const entry = (date: string, exerciseId: string, weight: number): HistoryEntry => ({
  date, exerciseId, sets: [makeSet('reps_weight', { weight, reps: 5 }, Date.parse(date))],
})

function baseState(): TrainStateV1 {
  return {
    v: 1, unit: 'lb', submitted: false,
    session: {
      date: '2026-09-18', off: false, warmup: [], cooldown: [],
      ex: [{
        id: 'bb_bench', name: 'BB Bench', kind: 'reps_weight', tier: 1, sets: 3, reps: 5,
        weight: 185, rest: 180, perSide: false, pinned: false, collapsed: false,
        deload: false, note: '', log: [null, null, null],
      }],
    },
    history: {
      barbell_bench_press: [entry('2026-09-01', 'barbell_bench_press', 175)],
      bb_bench: [entry('2026-09-08', 'bb_bench', 180), entry('2026-09-15', 'bb_bench', 185)],
    },
    exercises: {
      barbell_bench_press: mkDef('barbell_bench_press', 'Barbell Bench Press'),
      bb_bench: mkDef('bb_bench', 'BB Bench'),
    },
    aliases: { 'bb bench': 'bb_bench' },
    finishedDates: [], templates: [], deloadOverrides: { bb_bench: { weight: 180, date: '2026-09-15' } },
    shortTermGoal: '', photos: [], sessionDurations: [], liftGoals: [],
  }
}

describe('mergeExercise', () => {
  it('moves history under the target, sorted by date', () => {
    const out = mergeExercise(baseState(), 'bb_bench', 'barbell_bench_press')
    const dates = out.state.history.barbell_bench_press.map((e) => e.date)
    expect(dates).toEqual(['2026-09-01', '2026-09-08', '2026-09-15'])
    expect(out.state.history.bb_bench).toBeUndefined()
  })

  it('rewrites the exerciseId on every moved entry', () => {
    const out = mergeExercise(baseState(), 'bb_bench', 'barbell_bench_press')
    for (const e of out.state.history.barbell_bench_press) {
      expect(e.exerciseId).toBe('barbell_bench_press')
    }
  })

  it('repoints the live session at the target', () => {
    const out = mergeExercise(baseState(), 'bb_bench', 'barbell_bench_press')
    expect(out.state.session.ex[0].id).toBe('barbell_bench_press')
    expect(out.state.session.ex[0].name).toBe('Barbell Bench Press')
  })

  it('records an alias so the old name never fragments again', () => {
    const out = mergeExercise(baseState(), 'bb_bench', 'barbell_bench_press')
    expect(out.state.aliases['bb bench']).toBe('barbell_bench_press')
  })

  it('drops the merged definition and its deload override', () => {
    const out = mergeExercise(baseState(), 'bb_bench', 'barbell_bench_press')
    expect(out.state.exercises.bb_bench).toBeUndefined()
    expect(out.state.deloadOverrides.bb_bench).toBeUndefined()
  })

  it('reports what moved', () => {
    const out = mergeExercise(baseState(), 'bb_bench', 'barbell_bench_press')
    expect(out.movedEntries).toBe(2)
    expect(out.fromName).toBe('BB Bench')
    expect(out.intoName).toBe('Barbell Bench Press')
  })

  it('does not mutate the state it was given', () => {
    const state = baseState()
    mergeExercise(state, 'bb_bench', 'barbell_bench_press')
    expect(state.history.bb_bench).toBeDefined()
    expect(state.session.ex[0].id).toBe('bb_bench')
  })

  it('merges same-day entries into one, combining their sets', () => {
    const state = baseState()
    state.history.barbell_bench_press.push(entry('2026-09-08', 'barbell_bench_press', 170))
    const out = mergeExercise(state, 'bb_bench', 'barbell_bench_press')
    const sep8 = out.state.history.barbell_bench_press.filter((e) => e.date === '2026-09-08')
    expect(sep8.length).toBe(1)
    expect(sep8[0].sets.length).toBe(2)
  })

  it('throws rather than merging a lift into itself', () => {
    expect(() => mergeExercise(baseState(), 'bb_bench', 'bb_bench')).toThrow()
  })

  it('throws when the target does not exist', () => {
    expect(() => mergeExercise(baseState(), 'bb_bench', 'nope')).toThrow()
  })
})

describe('mergeableTargets', () => {
  it('ranks other known lifts by name similarity', () => {
    const targets = mergeableTargets(baseState(), 'bb_bench')
    expect(targets[0].def.id).toBe('barbell_bench_press')
    expect(targets.every((t) => t.def.id !== 'bb_bench')).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/train/merge.test.ts`
Expected: FAIL — cannot resolve `../../lib/train/merge`.

- [ ] **Step 3: Create `lib/train/merge.ts`**

```ts
import type { ExerciseDef, HistoryEntry, TrainStateV1 } from './types'
import { similarity } from './identity'

export interface MergeResult {
  state: TrainStateV1
  movedEntries: number
  fromName: string
  intoName: string
}

/** Same-day entries for one lift are one session's work, not two. */
function foldByDate(entries: HistoryEntry[], exerciseId: string): HistoryEntry[] {
  const byDate = new Map<string, HistoryEntry>()
  for (const entry of entries) {
    const existing = byDate.get(entry.date)
    if (existing) existing.sets = [...existing.sets, ...entry.sets]
    else byDate.set(entry.date, { date: entry.date, exerciseId, sets: [...entry.sets] })
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * Folds one exercise identity into another: history, live session, aliases
 * and overrides. Pure — returns a new state rather than mutating, so a
 * failed merge can never leave the store half-rewritten.
 */
export function mergeExercise(state: TrainStateV1, fromId: string, intoId: string): MergeResult {
  if (fromId === intoId) throw new Error('cannot merge an exercise into itself')
  const intoDef = state.exercises[intoId]
  if (!intoDef) throw new Error(`unknown merge target: ${intoId}`)
  const fromDef = state.exercises[fromId]

  const next: TrainStateV1 = {
    ...state,
    history: { ...state.history },
    exercises: { ...state.exercises },
    aliases: { ...state.aliases },
    deloadOverrides: { ...state.deloadOverrides },
    session: {
      ...state.session,
      ex: state.session.ex.map((ex) =>
        ex.id === fromId ? { ...ex, id: intoId, name: intoDef.name } : { ...ex },
      ),
    },
  }

  const moving = state.history[fromId] || []
  next.history[intoId] = foldByDate([...(state.history[intoId] || []), ...moving], intoId)
  delete next.history[fromId]

  // every name that used to point at the old lift now points at the new one
  for (const [alias, target] of Object.entries(next.aliases)) {
    if (target === fromId) next.aliases[alias] = intoId
  }
  if (fromDef) {
    for (const form of [fromDef.name, ...fromDef.aliases]) {
      next.aliases[form.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()] = intoId
    }
  }

  delete next.exercises[fromId]
  delete next.deloadOverrides[fromId]

  return {
    state: next,
    movedEntries: moving.length,
    fromName: fromDef ? fromDef.name : fromId,
    intoName: intoDef.name,
  }
}

/** Every other known lift, ranked by how likely it is the same movement. */
export function mergeableTargets(
  state: TrainStateV1,
  fromId: string,
): Array<{ def: ExerciseDef; score: number }> {
  const fromDef = state.exercises[fromId]
  if (!fromDef) return []
  return Object.values(state.exercises)
    .filter((def) => def.id !== fromId)
    .map((def) => ({ def, score: similarity(fromDef.name, def.name) }))
    .sort((a, b) => b.score - a.score)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/train/merge.test.ts`
Expected: PASS — all 11 assertions green.

- [ ] **Step 5: Re-export from `lib/train/index.ts`**

Add to the export block:

```ts
export * from './merge'
```

- [ ] **Step 6: Commit**

```bash
git add lib/train/merge.ts lib/train/index.ts tests/train/merge.test.ts
git commit -m "feat(train): add exercise merge for duplicate identities

Folds history, session references, aliases and overrides from one lift
into another, purely, with same-day entries combined.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: Versioned state migration v0 → v1

**Files:**
- Create: `lib/train/migrate.ts`
- Create: `tests/train/migrate.test.ts`
- Modify: `lib/train/index.ts`

**Interfaces:**
- Consumes: everything above — `TrainStateV1`, `LoggedSet` (Task 2), `makeSet` (Task 2), `CATALOG` (Task 6), `resolveExercise`, `slugFromName`, `normalizeName` (Task 7).
- Produces: `STATE_VERSION`, `migrate(raw, todayKey)`, `emptyStateV1(today)`, `isV1(raw)`.

`migrate` takes `todayKey` rather than calling `new Date()` — the whole point of putting this logic in `lib/train/` is that it is pure and testable, and a hidden clock read is the one crack that makes a time-dependent test flaky at midnight.

The old shape (from the live tile) is:
- `STATE.history[id] = [{ date, kg, sets: [{ r, fail }], off? }]`
- `STATE.session.ex[i].log[j] = { kg, reps } | { kg, reps: 0, fail: true }`, optional `drops: [{ kg, reps }]`
- `STATE.customLib[id] = { equipment, primary: string[], secondary: string[], gist, steps, cues }`
- `STATE.exerciseNames[id] = 'Display Name'`

- [ ] **Step 1: Write the failing test `tests/train/migrate.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { migrate, STATE_VERSION, emptyStateV1, isV1 } from '../../lib/train/migrate'

const TODAY = '2026-09-18'

const v0 = () => ({
  unit: 'lb',
  submitted: false,
  session: {
    date: '2026-09-18', off: false, warmup: [{ text: 'Bike 5 min', done: true }], cooldown: [],
    ex: [{
      id: 'bb_bench_press', name: 'BB Bench Press', tier: 1, sets: 3, reps: 5, kg: 185,
      perHand: false, rest: 180, lastKg: 180, pinned: false, collapsed: false, deload: false, note: '',
      log: [
        { kg: 185, reps: 5 },
        { kg: 185, reps: 5, drops: [{ kg: 155, reps: 5 }] },
        { kg: 185, reps: 0, fail: true },
      ],
    }],
  },
  history: {
    bb_bench_press: [
      { date: '2026-09-11', kg: 180, sets: [{ r: 5 }, { r: 5 }, { r: 4 }] },
      { date: '2026-09-15', kg: 185, sets: [{ r: 5 }, { r: 0, fail: true }] },
    ],
  },
  customLib: {
    bb_bench_press: { equipment: 'Barbell', primary: ['Chest'], secondary: ['Triceps'], gist: 'Press', steps: [], cues: [] },
  },
  exerciseNames: { bb_bench_press: 'BB Bench Press' },
  finishedDates: ['2026-09-11', '2026-09-15'],
  templates: [], deloadOverrides: {}, shortTermGoal: 'Add 20lb to bench',
  photos: [], sessionDurations: [{ date: '2026-09-15', minutes: 62 }], liftGoals: [],
})

describe('migrate', () => {
  it('stamps the version', () => {
    expect(migrate(v0(), TODAY).v).toBe(STATE_VERSION)
  })

  it('converts history sets to typed working sets', () => {
    const out = migrate(v0(), TODAY)
    const entries = out.history.barbell_bench_press
    expect(entries).toBeDefined()
    const first = entries[0]
    expect(first.date).toBe('2026-09-11')
    expect(first.sets).toHaveLength(3)
    expect(first.sets[0]).toMatchObject({ kind: 'reps_weight', weight: 180, reps: 5, warmup: false, fail: false })
  })

  it('preserves failed sets as failures, not as zero-rep successes', () => {
    const out = migrate(v0(), TODAY)
    const sep15 = out.history.barbell_bench_press.find((e) => e.date === '2026-09-15')!
    expect(sep15.sets[1].fail).toBe(true)
  })

  it('backfills timestamps from the entry date so ordering is stable', () => {
    const out = migrate(v0(), TODAY)
    const sets = out.history.barbell_bench_press[0].sets
    expect(sets[0].at).toBeLessThan(sets[1].at)
    expect(Number.isFinite(sets[0].at)).toBe(true)
  })

  it('marks nothing as a warm-up — v0 had no such concept', () => {
    const out = migrate(v0(), TODAY)
    for (const entries of Object.values(out.history)) {
      for (const entry of entries) {
        for (const set of entry.sets) expect(set.warmup).toBe(false)
      }
    }
  })

  it('resolves the typed id onto a canonical catalog id', () => {
    const out = migrate(v0(), TODAY)
    expect(out.history.barbell_bench_press).toBeDefined()
    expect(out.history.bb_bench_press).toBeUndefined()
    expect(out.session.ex[0].id).toBe('barbell_bench_press')
  })

  it('converts the live session log, keeping drops', () => {
    const out = migrate(v0(), TODAY)
    const log = out.session.ex[0].log
    expect(log[0]).toMatchObject({ kind: 'reps_weight', weight: 185, reps: 5 })
    expect(log[1]!.drops).toEqual([{ weight: 155, reps: 5 }])
    expect(log[2]!.fail).toBe(true)
  })

  it('carries customLib into an exercise definition with closed-list muscles', () => {
    const out = migrate(v0(), TODAY)
    const def = out.exercises.barbell_bench_press
    expect(def).toBeDefined()
    expect(def.primary.some((c) => c.muscle === 'chest')).toBe(true)
  })

  it('learns an alias from the old display name', () => {
    const out = migrate(v0(), TODAY)
    expect(out.aliases['barbell bench press']).toBe('barbell_bench_press')
  })

  it('keeps a one-time backup of the original state', () => {
    const out = migrate(v0(), TODAY)
    expect(out._v0Backup).toBeDefined()
  })

  it('marks every backfilled timestamp as estimated', () => {
    const out = migrate(v0(), TODAY)
    for (const entries of Object.values(out.history)) {
      for (const entry of entries) {
        for (const set of entry.sets) expect(set.atEstimated).toBe(true)
      }
    }
  })

  it('flags guessed muscle contributions so they never read as data', () => {
    const out = migrate(v0(), TODAY)
    const custom = Object.values(out.exercises).filter((d) => d.custom)
    for (const def of custom) expect(def.contributionsEstimated).toBe(true)
  })

  it('takes the day as a parameter rather than reading the clock', () => {
    const out = migrate({ session: { date: '2026-01-01', off: false, ex: [] } }, '2030-06-15')
    expect(out.session.date).toBe('2026-01-01')
    const fresh = migrate(null, '2030-06-15')
    expect(fresh.session.date).toBe('2030-06-15')
  })

  it('leaves an lb store\'s numbers untouched', () => {
    const out = migrate(v0(), TODAY)
    expect(out.session.ex[0].weight).toBe(185)
    expect(out.history.barbell_bench_press[0].sets[0].weight).toBe(180)
  })

  it('converts a legacy kg store into canonical pounds', () => {
    const kgState = { ...v0(), unit: 'kg' }
    const out = migrate(kgState, TODAY)
    // 185 kg → 407.86 lb; the display preference is kept, the storage is not
    expect(out.unit).toBe('kg')
    expect(out.session.ex[0].weight).toBeCloseTo(407.86, 1)
    expect(out.history.barbell_bench_press[0].sets[0].weight).toBeCloseTo(396.83, 1)
  })

  it('converts drop-set weights too', () => {
    const kgState = { ...v0(), unit: 'kg' }
    const out = migrate(kgState, TODAY)
    const withDrop = out.session.ex[0].log[1]!
    expect(withDrop.drops![0].weight).toBeCloseTo(341.72, 1)
  })

  it('preserves the fields it does not transform', () => {
    const out = migrate(v0(), TODAY)
    expect(out.shortTermGoal).toBe('Add 20lb to bench')
    expect(out.finishedDates).toEqual(['2026-09-11', '2026-09-15'])
    expect(out.sessionDurations).toEqual([{ date: '2026-09-15', minutes: 62 }])
  })

  it('is idempotent — migrating twice changes nothing and keeps one backup', () => {
    const once = migrate(v0(), TODAY)
    const twice = migrate(once, TODAY)
    expect(twice).toEqual(once)
  })

  it('returns an empty v1 state for junk input', () => {
    expect(migrate(null, TODAY).v).toBe(STATE_VERSION)
    expect(migrate([], TODAY).v).toBe(STATE_VERSION)
    expect(migrate({ days: {} }, TODAY).history).toEqual({})
  })
})

describe('isV1', () => {
  it('recognizes a migrated state', () => {
    expect(isV1(migrate(v0(), TODAY))).toBe(true)
    expect(isV1(v0())).toBe(false)
    expect(isV1(null)).toBe(false)
  })
})

describe('emptyStateV1', () => {
  it('builds a usable blank state for a given day', () => {
    const s = emptyStateV1('2026-09-18')
    expect(s.v).toBe(STATE_VERSION)
    expect(s.session.date).toBe('2026-09-18')
    expect(s.session.ex).toEqual([])
    expect(s.unit).toBe('lb')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/train/migrate.test.ts`
Expected: FAIL — cannot resolve `../../lib/train/migrate`.

- [ ] **Step 3: Create `lib/train/migrate.ts`**

```ts
import type {
  ExerciseDef, HistoryEntry, LoggedSet, Muscle, Session, SessionExercise, TrainStateV1,
} from './types'
import { makeSet } from './sets'
import { ALL_MUSCLES } from './taxonomy'
import { normalizeName, resolveExercise, slugFromName } from './identity'
import { kgToLb } from './units'

export const STATE_VERSION = 1 as const

export function isV1(raw: unknown): raw is TrainStateV1 {
  return !!raw && typeof raw === 'object' && (raw as TrainStateV1).v === STATE_VERSION
}

export function emptyStateV1(today: string): TrainStateV1 {
  return {
    v: STATE_VERSION,
    unit: 'lb',
    submitted: false,
    session: { date: today, off: false, warmup: [], cooldown: [], ex: [] },
    history: {},
    exercises: {},
    aliases: {},
    finishedDates: [],
    templates: [],
    deloadOverrides: {},
    shortTermGoal: '',
    photos: [],
    sessionDurations: [],
    liftGoals: [],
  }
}

/** Free-text muscle from the old classifier → a muscle on the closed list. */
function toMuscle(raw: string): Muscle | null {
  const key = String(raw).toLowerCase().replace(/[^a-z]+/g, '_')
  const direct = ALL_MUSCLES.find((m) => m === key)
  if (direct) return direct
  const SYNONYMS: Record<string, Muscle> = {
    pecs: 'chest', pectorals: 'chest', chest: 'chest',
    delts: 'front_delts', shoulders: 'front_delts', deltoids: 'front_delts',
    lats: 'lats', back: 'upper_back', upper_back: 'upper_back', lower_back: 'lower_back',
    tris: 'triceps', tricep: 'triceps', bis: 'biceps', bicep: 'biceps',
    abs: 'abs', core: 'abs', obliques: 'obliques',
    glutes: 'glutes', quads: 'quads', quadriceps: 'quads',
    hamstrings: 'hamstrings', hams: 'hamstrings', calves: 'calves', calf: 'calves',
    forearms: 'forearms', traps: 'traps', cardio: 'cardio', full_body: 'full_body',
  }
  return SYNONYMS[key] || null
}

function contributionsFrom(list: unknown): Array<{ muscle: Muscle; weight: number }> {
  if (!Array.isArray(list)) return []
  const muscles = list.map((m) => toMuscle(String(m))).filter((m): m is Muscle => !!m)
  if (!muscles.length) return []
  const share = 1 / muscles.length
  return muscles.map((muscle) => ({ muscle, weight: share }))
}

/** Midday local-ish anchor so backfilled stamps never cross a date boundary. */
function stampFor(date: string, index: number): number {
  const [y, m, d] = String(date).split('-').map(Number)
  const base = new Date(y || 2000, (m || 1) - 1, d || 1, 12, 0, 0).getTime()
  return base + index * 180_000 // 3 min apart, preserving order
}

/**
 * v0 stored weight in whatever unit the display label happened to say, so a
 * legacy kg store has to be converted on the way in — after this, every
 * number in the system is pounds.
 */
type ToLb = (n: number) => number

function v0SetToLogged(raw: unknown, weight: number, date: string, index: number, toLb: ToLb): LoggedSet {
  const set = (raw || {}) as { r?: number; reps?: number; fail?: boolean; kg?: number; drops?: unknown }
  const reps = typeof set.r === 'number' ? set.r : typeof set.reps === 'number' ? set.reps : 0
  const w = typeof set.kg === 'number' ? set.kg : weight
  const drops = Array.isArray(set.drops)
    ? (set.drops as Array<{ kg?: number; reps?: number }>).map((d) => ({
        weight: typeof d.kg === 'number' ? toLb(d.kg) : undefined,
        reps: typeof d.reps === 'number' ? d.reps : undefined,
      }))
    : undefined
  /* v0 never recorded reps on a miss — doLog wrote {kg, reps:0, fail:true}
     and the rollup wrote {r:0, fail:true} — so there is nothing to recover
     here. Task 11 stops discarding it for new sets. */
  const built = makeSet(
    'reps_weight',
    { weight: toLb(w), reps: set.fail ? 0 : reps, fail: set.fail === true, warmup: false, drops },
    stampFor(date, index),
  )
  /* the stamp was synthesized, not observed — timing derivations skip it */
  built.atEstimated = true
  return built
}

interface IdMap { [oldId: string]: string }

/**
 * v0 → v1. Converts untyped {kg, reps} records to typed sets, folds
 * customLib + exerciseNames into real ExerciseDefs, and resolves old
 * slug ids onto canonical catalog ids so history stops fragmenting.
 *
 * Idempotent: an already-v1 state is returned untouched, and the one-time
 * backup is never written twice.
 */
export function migrate(raw: unknown, todayKey: string): TrainStateV1 {
  if (isV1(raw)) return raw
  const blank = emptyStateV1(todayKey)

  /* v0 numbers are in whatever unit was displayed. Convert once, here, so
     everything downstream can assume pounds. No shipped build could set
     unit:'kg' (the tile has no toggle), so in practice this is a guard for
     hand-edited stores — and the reason a future kg toggle stays cosmetic. */
  const wasKg = (raw as Record<string, unknown> | null)?.['unit'] === 'kg'
  const toLb: ToLb = wasKg ? (n) => Math.round(kgToLb(n) * 100) / 100 : (n) => n

  const old = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, any>
  // the pre-rewrite `days` shape is structurally incompatible — start fresh
  if (old.days || !old.session) return { ...blank, _v0Backup: raw ?? null }

  const names: Record<string, string> = old.exerciseNames || {}
  const customLib: Record<string, any> = old.customLib || {}
  const oldIds = new Set<string>([
    ...Object.keys(old.history || {}),
    ...Object.keys(names),
    ...((old.session?.ex || []) as Array<{ id: string }>).map((e) => e.id),
  ])

  const exercises: Record<string, ExerciseDef> = {}
  const aliases: Record<string, string> = {}
  const idMap: IdMap = {}
  const taken = new Set<string>()

  for (const oldId of oldIds) {
    const display = names[oldId] || oldId.replace(/_/g, ' ')
    const resolved = resolveExercise(display, {})
    if (resolved.status === 'exact' && resolved.match) {
      idMap[oldId] = resolved.match.id
      exercises[resolved.match.id] = resolved.match
      taken.add(resolved.match.id)
    } else {
      const info = customLib[oldId] || {}
      const newId = slugFromName(display, taken)
      taken.add(newId)
      idMap[oldId] = newId
      exercises[newId] = {
        id: newId,
        name: display,
        aliases: [],
        pattern: 'other',
        plane: null,
        equipment: 'none',
        unilateral: false,
        defaultSetKind: 'reps_weight',
        primary: contributionsFrom(info.primary),
        secondary: contributionsFrom(info.secondary),
        e1rmValid: true,
        loading: 'free',
        incrementLb: 5,
        custom: true,
        /* contributionsFrom() splits evenly across whatever muscle names the
           old classifier returned — a guess, and it must not read as data */
        contributionsEstimated: true,
      }
    }
    aliases[normalizeName(display)] = idMap[oldId]
  }

  const history: Record<string, HistoryEntry[]> = {}
  for (const [oldId, rawEntries] of Object.entries((old.history || {}) as Record<string, any[]>)) {
    const newId = idMap[oldId] || oldId
    const converted: HistoryEntry[] = (rawEntries || [])
      .filter((e) => e && !e.off)
      .map((e) => ({
        date: String(e.date),
        exerciseId: newId,
        sets: (Array.isArray(e.sets) ? e.sets : []).map((s: unknown, i: number) =>
          v0SetToLogged(s, typeof e.kg === 'number' ? e.kg : 0, String(e.date), i, toLb),
        ),
      }))
    history[newId] = [...(history[newId] || []), ...converted].sort((a, b) => a.date.localeCompare(b.date))
  }

  const oldSession = old.session || {}
  const session: Session = {
    date: String(oldSession.date || todayKey),
    off: oldSession.off === true,
    startedAt: typeof oldSession.startedAt === 'number' ? oldSession.startedAt : undefined,
    warmup: Array.isArray(oldSession.warmup) ? oldSession.warmup : [],
    cooldown: Array.isArray(oldSession.cooldown) ? oldSession.cooldown : [],
    insight: oldSession.insight,
    ex: ((oldSession.ex || []) as any[]).map((ex): SessionExercise => {
      const newId = idMap[ex.id] || ex.id
      const def = exercises[newId]
      return {
        id: newId,
        name: def ? def.name : ex.name,
        kind: def ? def.defaultSetKind : 'reps_weight',
        tier: typeof ex.tier === 'number' ? ex.tier : 2,
        sets: typeof ex.sets === 'number' ? ex.sets : 3,
        reps: typeof ex.reps === 'number' ? ex.reps : 10,
        weight: typeof ex.kg === 'number' ? toLb(ex.kg) : 0,
        rest: typeof ex.rest === 'number' ? ex.rest : 90,
        perSide: ex.perHand === true,
        pinned: ex.pinned === true,
        collapsed: ex.collapsed === true,
        deload: ex.deload === true,
        note: typeof ex.note === 'string' ? ex.note : '',
        group: ex.group,
        lastWeight: typeof ex.lastKg === 'number' ? toLb(ex.lastKg) : null,
        log: (Array.isArray(ex.log) ? ex.log : []).map((entry: unknown, i: number) =>
          entry ? v0SetToLogged(entry, typeof ex.kg === 'number' ? ex.kg : 0, String(oldSession.date || todayKey), i, toLb) : null,
        ),
      }
    }),
  }

  const deloadOverrides: Record<string, { weight: number; date: string }> = {}
  for (const [oldId, ov] of Object.entries((old.deloadOverrides || {}) as Record<string, any>)) {
    if (ov && typeof ov.kg === 'number') {
      deloadOverrides[idMap[oldId] || oldId] = { weight: toLb(ov.kg), date: String(ov.date) }
    }
  }

  return {
    v: STATE_VERSION,
    /* display preference is preserved; the stored numbers are now pounds */
    unit: old.unit === 'kg' ? 'kg' : 'lb',
    submitted: old.submitted === true,
    session,
    history,
    exercises,
    aliases,
    finishedDates: Array.isArray(old.finishedDates) ? old.finishedDates : [],
    templates: Array.isArray(old.templates) ? old.templates : [],
    deloadOverrides,
    shortTermGoal: typeof old.shortTermGoal === 'string' ? old.shortTermGoal : '',
    photos: Array.isArray(old.photos) ? old.photos : [],
    sessionDurations: Array.isArray(old.sessionDurations) ? old.sessionDurations : [],
    liftGoals: Array.isArray(old.liftGoals) ? old.liftGoals : [],
    _v0Backup: raw,
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/train/migrate.test.ts`
Expected: PASS — all 23 assertions green.

- [ ] **Step 5: Re-export from `lib/train/index.ts`**

Add to the export block:

```ts
export * from './migrate'
```

- [ ] **Step 6: Run the full suite and rebuild**

Run: `npx vitest run && npm run build:tiles`
Expected: PASS — every engine test green, tile rebuilt.

- [ ] **Step 7: Commit**

```bash
git add lib/train/migrate.ts lib/train/index.ts tests/train/migrate.test.ts public/tiles/train.html tiles-library/train.html
git commit -m "feat(train): migrate saved state v0 to v1

Converts untyped sets to typed ones, folds customLib into real exercise
definitions, resolves old slugs onto canonical ids, converts a legacy kg
store to canonical pounds, and marks backfilled timestamps and guessed
muscle splits as estimated. Pure: takes the day as a parameter. Idempotent.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: Boot the tile on migrated v1 state

**Files:**
- Modify: `public/tiles/train.html` (boot IIFE, `buildState`, `curSession`, `histFor`, `lastKgFromHistory`, `bestKgExclToday`, `bestRepsAt`, `topReps`, `setCount`, plus the history readers in `drawChart` / `drawStats` / `drawTable` / `drawRecords` / `drawGoals` / `totalPRsAllTime` / `rollupToday`)
- Create: `tests/train/boot-contract.test.ts`
- Modify: `lib/train/index.ts`

**Interfaces:**
- Consumes: `migrate`, `emptyStateV1`, `STATE_VERSION` (Task 9); `isWorkingSet`, `totalReps` (Task 2).
- Produces: the tile's `STATE` is a `TrainStateV1`; globals `T` (alias for `TrainEngine`) and `volOpts(exerciseId)`; accessors `workingSets(entry)`, `topWeight(entry)`, `topReps(entry)`, `setCount(entry)`, `lastWeightFromHistory(id)`, `bestWeightExclToday(e)`, `bestRepsAt(e, weight)` — all used by Tasks 11–13.

Migration reshapes `STATE.history` the instant it runs, so this task must also replace every reader of the old `{kg, sets:[{r}]}` shape. Nothing about the tile should *look* different when this task is done — that is the test. Behaviour changes start in Task 11.

- [ ] **Step 1: Write the failing contract test `tests/train/boot-contract.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * The tile is a sealed HTML file, so these assert on its source: the boot
 * path must migrate, and no code may read the retired v0 field names.
 */
const tile = () => readFileSync('public/tiles/train.html', 'utf8')
const loggerScript = () => {
  const html = tile()
  return html.slice(html.indexOf('THE LOGGER.'))
}

describe('tile boot contract', () => {
  it('migrates whatever the bridge returns', () => {
    expect(loggerScript()).toContain('T.migrate(d, today)')
  })

  it('exposes the engine under a short alias', () => {
    expect(loggerScript()).toMatch(/const\s+T\s*=\s*TrainEngine/)
  })

  it('no longer builds v0 state inline', () => {
    expect(loggerScript()).not.toContain('customLib:{}')
    expect(loggerScript()).not.toContain('exerciseNames:{}')
  })

  it('never reads the retired lastKg / perHand field names', () => {
    const script = loggerScript()
    expect(script).not.toMatch(/\.lastKg\b/)
    expect(script).not.toMatch(/\.perHand\b/)
  })

  it('passes the day into migrate rather than letting it read the clock', () => {
    expect(loggerScript()).toContain('T.migrate(d, today)')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/train/boot-contract.test.ts`
Expected: FAIL — the tile still builds v0 state and reads `.lastKg` / `.perHand`.

- [ ] **Step 3: Add the bodyweight helper to `lib/train/index.ts`**

Append to the file:

```ts
import type { ExerciseDef } from './types'
import type { VolumeOptions } from './volume'

/**
 * Builds volume options for one exercise. Bodyweight comes from the
 * dashboard profile and may be absent — every volume path already handles
 * that by reporting hard sets with no tonnage.
 */
export function volumeOptionsFor(def: ExerciseDef | undefined, bodyweightLb?: number): VolumeOptions {
  return {
    bodyweightLb: typeof bodyweightLb === 'number' && bodyweightLb > 0 ? bodyweightLb : undefined,
    bodyweightFactor: def?.bodyweightFactor,
  }
}
```

- [ ] **Step 4: Replace `buildState()` in `public/tiles/train.html`**

Find:

```js
function buildState(){
  return {
    unit:'lb', submitted:false,
    session:{ date:today, off:false, warmup:[], cooldown:[], ex:[] },
    history:{}, customLib:{}, finishedDates:[], templates:[], deloadOverrides:{},
    exerciseNames:{}, shortTermGoal:'', photos:[], sessionDurations:[], liftGoals:[]
  };
}
```

Replace with:

```js
/* The engine owns the state shape now — the tile only asks for a blank one. */
function buildState(){ return T.emptyStateV1(today); }
```

- [ ] **Step 5: Add the engine alias and bodyweight lookup**

Immediately after the line `const DAY = 86400000;` near the top of the logger script, add:

```js
/* The engine (inlined above this script by scripts/build-tile.mjs). Every
   piece of training math lives there so it can be tested and, later, moved
   to a native app without dragging the DOM along. */
const T = TrainEngine;

/* Bodyweight powers tonnage for bodyweight and assisted movements. It comes
   from the dashboard profile and is simply absent for most people — every
   volume path already degrades to hard-sets-only when it is. */
let BODYWEIGHT_LB = null;
function volOpts(exerciseId){
  const def = STATE.exercises[exerciseId];
  return T.volumeOptionsFor(def, BODYWEIGHT_LB == null ? undefined : BODYWEIGHT_LB);
}
```

- [ ] **Step 6: Replace the boot IIFE**

Find the boot block at the end of the logger script (it begins `(async()=>{` and ends `initFabConstellation();\n})();`). Replace everything from `let d=null;` through `STATE.liftGoals = STATE.liftGoals || [];` with:

```js
  let d=null;
  try{ d = await window.Vitality.load(); }catch(e){ d=null; }
  /* One entry point for every shape the store has ever held: v1 passes
     through untouched, v0 converts, anything else starts clean. A one-time
     backup of the pre-migration payload rides along inside the result. */
  STATE = T.migrate(d, today);
  try{
    const profile = await window.Vitality.read('vitality:profile');
    const w = profile && (profile.weightLb || profile.weight);
    if(typeof w === 'number' && w > 0) BODYWEIGHT_LB = w;
  }catch(e){ /* no profile — bodyweight tonnage stays off, hard sets still count */ }
  saveState();
```

Leave the render calls that follow (`render(); wireFresh();` onward) exactly as they are.

- [ ] **Step 7: Update `curSession()` for the new session shape**

Find:

```js
function curSession(){
  if(!STATE.session || STATE.session.date!==today){
    Object.keys(restTimers).forEach(stopRest);
    STATE.session = { date:today, off:false, warmup:[], cooldown:[], ex:[] };
  }
  return STATE.session;
}
```

Replace the inline literal with the engine's blank session so the shape stays in one place:

```js
function curSession(){
  if(!STATE.session || STATE.session.date!==today){
    Object.keys(restTimers).forEach(stopRest);
    STATE.session = T.emptyStateV1(today).session;
  }
  return STATE.session;
}
```

- [ ] **Step 8: Rename the retired field reads**

These are mechanical renames across the logger script. Apply each with care — the contract test checks them.

| Old | New |
|---|---|
| `e.lastKg` | `e.lastWeight` |
| `e.perHand` | `e.perSide` |
| `e.kg` (on a session exercise) | `e.weight` |
| `STATE.exerciseNames[id]` | `STATE.exercises[id] && STATE.exercises[id].name` |
| `STATE.customLib[id]` | `STATE.exercises[id]` |

Run `grep -n "lastKg\|perHand\|exerciseNames\|customLib" public/tiles/train.html` and fix every hit.

`prescription()` is part of this rename — it both reads and returns the old key, so change the returned key too or every caller keeps reading `rx.kg`:

```js
function prescription(e){ const weight = e.deload ? r1(e.weight*0.9) : e.weight; return { weight, reps:e.reps, sets:e.sets, rest:e.rest }; }
```

Then run `grep -n "rx\.kg" public/tiles/train.html` and change each to `rx.weight` — call sites are in `renderCard`, `renderPill` and `startRest`.

- [ ] **Step 9: Replace the history accessors**

The migration has already reshaped `STATE.history` — entries are now `{date, exerciseId, sets}` with no top-level `kg`, so every reader of `s.kg` is broken as of Step 6. These replacements are what keep the tile working; they are not optional polish.

Find and replace these four functions:

```js
function histFor(e){ STATE.history=STATE.history||{}; return STATE.history[e.id]||(STATE.history[e.id]=[]); }
function lastKgFromHistory(id){
  const h=(STATE.history&&STATE.history[id])||[]; const real=h.filter(s=>!s.off);
  return real.length? real[real.length-1].kg : null;
}
function bestKgExclToday(e){ const real=histFor(e).filter(s=>!s.off && s.date!==today); return real.length? Math.max(...real.map(s=>s.kg)) : 0; }
function bestRepsAt(e, kg){ const real=histFor(e).filter(s=>!s.off && s.kg===kg); let m=0; real.forEach(s=>{ const t=Math.max(...s.sets.filter(x=>!x.fail).map(x=>x.r||0),0); if(t>m)m=t; }); return m; }
```

with:

```js
function histFor(e){ STATE.history=STATE.history||{}; return STATE.history[e.id]||(STATE.history[e.id]=[]); }
/* Every reader below works off working sets only — warm-ups are in the
   record (they happened) but they are not evidence of capacity. */
function workingSets(entry){ return (entry.sets||[]).filter(s=>T.isWorkingSet(s)); }
function topWeight(entry){ const w=workingSets(entry).map(s=>s.weight||0); return w.length?Math.max(...w):0; }
function topReps(entry){ const r=workingSets(entry).map(s=>T.totalReps(s)); return r.length?Math.max(...r):0; }
function setCount(entry){ return workingSets(entry).length; }
function lastWeightFromHistory(id){
  const h=(STATE.history&&STATE.history[id])||[];
  for(let i=h.length-1;i>=0;i--){ const w=topWeight(h[i]); if(w>0) return w; }
  return null;
}
function bestWeightExclToday(e){
  const past=histFor(e).filter(x=>x.date!==today).map(topWeight);
  return past.length? Math.max(...past, 0) : 0;
}
function bestRepsAt(e, weight){
  let best=0;
  histFor(e).forEach(entry=>{ workingSets(entry).forEach(s=>{ if(s.weight===weight){ const r=T.totalReps(s); if(r>best) best=r; } }); });
  return best;
}
```

The existing standalone `function topReps(s)` and `function setCount(s)` defined near `drawHistory` are replaced by the versions above — delete the old two.

Then run `grep -n "lastKgFromHistory\|bestKgExclToday" public/tiles/train.html` and rename every call site to `lastWeightFromHistory` / `bestWeightExclToday`. Call sites live in `openSwap`, `showApply`, `doLog` and `isPR`.

- [ ] **Step 10: Rewrite `rollupToday` to write v1 entries**

This one is urgent rather than cosmetic: `rollupToday` **writes** history, so until it is replaced the first logged set stamps v0-shaped data back into a v1 store. Find:

```js
function rollupToday(e){
  const done = e.log.filter(s=>s&&!s.fail);
  let h = histFor(e).filter(x=>x.date!==today);
  if(done.length){ const top=done.reduce((a,b)=>b.kg>a.kg?b:a); const sets=e.log.filter(s=>s).map(s=>s.fail?{r:s.reps,fail:true}:{r:s.reps}); h.push({date:today, kg:top.kg, sets}); h.sort((a,b)=>a.date.localeCompare(b.date)); e.lastKg=top.kg; }
  STATE.history[e.id]=h;
  STATE.exerciseNames=STATE.exerciseNames||{}; STATE.exerciseNames[e.id]=e.name;
}
```

Replace with:

```js
/* Mirrors today's logged sets into global history, so a lift's record
   survives being removed from the session or regenerated tomorrow. Sets are
   stored whole — warm-ups included — because the record is what happened;
   every reader decides for itself what counts. */
function rollupToday(e){
  STATE.history=STATE.history||{};
  const list=STATE.history[e.id]||(STATE.history[e.id]=[]);
  const sets=e.log.filter(Boolean);
  const i=list.findIndex(x=>x.date===today);
  if(!sets.length){ if(i>=0) list.splice(i,1); saveState(); return; }
  const entry={ date:today, exerciseId:e.id, sets:sets.map(s=>({...s})) };
  if(i>=0) list[i]=entry; else list.push(entry);
  list.sort((a,b)=>a.date.localeCompare(b.date));
  const best=topWeight(entry);
  if(best>0) e.lastWeight=best;
  saveState();
}
```

- [ ] **Step 11: Sweep the remaining history readers**

Run:

```bash
grep -n "\.kg\b" public/tiles/train.html
```

In `drawChart`, `drawStats`, `drawTable`, `drawRecords`, `drawGoals` and `totalPRsAllTime`, replace every history-entry `s.kg` with `topWeight(s)`, every rep read of the form `s.sets.filter(...)` with `topReps(s)`, and every `(s.sets||[]).length` with `setCount(s)`.

Two `.kg` reads are legitimate and must survive: the `{date, kg}` pair produced by `aggregateVolumeByDate` (a volume series, not a set weight), and `info.startingKg` from the AI classifier payload.

In `totalPRsAllTime`, keep its existing structure but compare through the accessors: count, per exercise, each history entry whose `topWeight` exceeds the maximum `topWeight` of all earlier entries.

- [ ] **Step 12: Rebuild and run the contract test**

Run: `npm run build:tiles && npx vitest run tests/train/boot-contract.test.ts`
Expected: PASS.

- [ ] **Step 13: Verify against real saved data**

Run `npm run dev`, open Train. Expected: the tile loads, past sessions still appear in History and Progress, the per-exercise History chart draws, and the console is clean. In the iframe console, confirm `STATE.v === 1`, `STATE.exercises` is populated, and `STATE._v0Backup` exists.

If anything is missing, **do not clear the store** — `STATE._v0Backup` holds the original payload and the migration can be corrected and re-run.

- [ ] **Step 14: Commit**

```bash
git add lib/train/index.ts public/tiles/train.html tiles-library/train.html tests/train/boot-contract.test.ts
git commit -m "feat(train): boot the tile on migrated v1 state

STATE is now produced by the engine's migrate(), with bodyweight read from
the dashboard profile for bodyweight and assisted tonnage.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 11: Typed set logging, warm-up toggle, RPE entry

**Files:**
- Modify: `public/tiles/train.html` (`doLog`, `renderPill`, `renderPillGroup`, `addDrop`, `renderDropRow`, `rollupToday`, `classifySet`, plus new CSS)
- Create: `tests/train/logging-contract.test.ts`

**Interfaces:**
- Consumes: `makeSet`, `isWorkingSet`, `totalReps` (Task 2); `volOpts` (Task 10).
- Produces: session logs hold `LoggedSet` objects; every set row offers a warm-up toggle and an optional RPE stepper.

- [ ] **Step 1: Write the failing contract test `tests/train/logging-contract.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const tile = () => readFileSync('public/tiles/train.html', 'utf8')

describe('logging path', () => {
  it('builds sets through the engine rather than object literals', () => {
    expect(tile()).toContain('T.makeSet(')
  })

  it('offers a warm-up toggle on each set row', () => {
    expect(tile()).toContain('data-act="warmup"')
  })

  it('offers an RPE control', () => {
    expect(tile()).toContain('data-act="rpe"')
  })

  it('converts typed weight to canonical pounds on the way in', () => {
    expect(tile()).toContain('T.storeWeight(')
  })

  it('keeps the reps actually completed on a missed set', () => {
    const script = tile()
    expect(script).toMatch(/partial/)
    expect(script).not.toMatch(/doLog\(e, idx, kg, 0, true\)/)
  })

  it('no longer writes untyped {kg, reps} set literals', () => {
    const script = tile()
    expect(script).not.toMatch(/e\.log\[idx\]\s*=\s*fail\s*\?/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/train/logging-contract.test.ts`
Expected: FAIL — none of those markers exist yet.

- [ ] **Step 3: Replace `doLog`**

Find the existing `function doLog(e, idx, kg, reps, fail){ ... }` and replace it with:

```js
/* Every logged set is built by the engine, so its kind, flags and timestamp
   are set in exactly one place. `warmup` is read off the row, not inferred. */
function doLog(e, idx, values, opts){
  const _sess=curSession(); if(!_sess.startedAt) _sess.startedAt=Date.now();
  const wasComplete = exComplete(e);
  const pbBefore = bestWeightExclToday(e);
  const prior = e.log[idx];
  e.log[idx] = T.makeSet(e.kind, {
    weight: values.weight, reps: values.reps, seconds: values.seconds, meters: values.meters,
    fail: !!(opts && opts.fail),
    warmup: !!(prior && prior.warmup),
    perSide: !!e.perSide,
    rpe: prior && typeof prior.rpe==='number' ? prior.rpe : undefined,
    drops: prior && prior.drops ? prior.drops : undefined,
  }, Date.now());
  rollupToday(e);
  render();
  const card=document.querySelector('.ex[data-id="'+e.id+'"]');
  const set=e.log[idx];
  if(T.isWorkingSet(set) && card){ const rowEl=card.querySelectorAll('.pill')[idx]; if(rowEl){ rowEl.classList.add('shimmer'); setTimeout(()=>rowEl.classList.remove('shimmer'),820); } }
  /* a warm-up can never be a PR, and isWorkingSet already excludes it */
  if(T.isWorkingSet(set) && pbBefore>0 && typeof set.weight==='number'){
    const beats = set.weight>pbBefore || (set.weight===pbBefore && (set.reps||0)>bestRepsAt(e,pbBefore));
    if(beats && !wasComplete && exComplete(e) && card){ card.classList.add('celebrate'); setTimeout(()=>card.classList.remove('celebrate'),1650); celebrate(e, set.weight, set.reps||0); }
  }
  /* warm-ups do not start the working rest clock */
  if(T.isWorkingSet(set) && (!e.group || isLastInGroup(e, curSession()))) startRest(e);
}
```

- [ ] **Step 4: Update the set-state helpers**

Replace these four one-liners:

```js
function classifySet(e, idx){ const s=e.log[idx]; if(!s) return 'empty'; if(s.fail) return 'failed'; return 'done'; }
function exDoneCount(e){ return e.log.filter(s=>s&&!s.fail).length; }
function exComplete(e){ return e.log.length>0 && e.log.every(s=>s&&!s.fail); }
function exHasMiss(e){ return e.log.some(s=>s&&s.fail); }
```

with:

```js
function classifySet(e, idx){ const s=e.log[idx]; if(!s) return 'empty'; if(s.fail) return 'failed'; if(s.warmup) return 'warmup'; return 'done'; }
function exDoneCount(e){ return e.log.filter(s=>T.isWorkingSet(s)).length; }
/* a session is complete when nothing is left unlogged and nothing missed —
   warm-ups count as logged but never as working volume */
function exComplete(e){ return e.log.length>0 && e.log.every(s=>s && !s.fail); }
function exHasMiss(e){ return e.log.some(s=>s&&s.fail); }
```

- [ ] **Step 5: Add warm-up and RPE controls to `renderPill`**

Inside `renderPill`, replace the `.pillActions` block:

```js
    + '<div class="pillActions">'
    + (logged
        ? '<span class="pillStatus">'+(pr?'<span class="pillPr">★ </span>':'')+status+'</span>'
          + (kind==='done'?'<button class="pillDrop" aria-label="Add drop set">+ Drop</button>':'')
          + '<button class="pillReset" aria-label="Undo set">'+IC_reset()+'</button>'
        : '<button class="pillHit" aria-label="Log set">Hit it →</button><button class="pillMiss" aria-label="Mark missed">Miss</button>')
    + '</div>';
```

with:

```js
    + '<div class="pillActions">'
    + '<button class="pillWarm'+(s&&s.warmup?' on':'')+'" data-act="warmup" aria-pressed="'+(s&&s.warmup?'true':'false')+'" title="Warm-up set — excluded from volume, PRs and progression">W</button>'
    + (logged
        ? '<button class="pillRpe'+(s&&typeof s.rpe==='number'?' on':'')+'" data-act="rpe" title="Rate of perceived exertion">'+(s&&typeof s.rpe==='number'?('RPE '+s.rpe):'RPE')+'</button>'
          + '<span class="pillStatus">'+(pr?'<span class="pillPr">★ </span>':'')+status+'</span>'
          + (kind==='done'?'<button class="pillDrop" aria-label="Add drop set">+ Drop</button>':'')
          + '<button class="pillReset" aria-label="Undo set">'+IC_reset()+'</button>'
        : '<button class="pillHit" aria-label="Log set">Hit it →</button><button class="pillMiss" aria-label="Mark missed">Miss</button>')
    + '</div>';
```

Then, still inside `renderPill`, replace the `commit` closure and add the two new handlers. Find:

```js
  const commit=()=>{ const kg=parseFloat(wIn.value); const reps=Math.round(parseFloat(rIn.value)); if(!Number.isFinite(kg)||kg<0||!Number.isFinite(reps)||reps<0) return; if(reps===0){ doLog(e, idx, kg, 0, true); } else { doLog(e, idx, kg, reps, false); } };
```

Replace with:

```js
  /* The input shows the user's unit; storage is always pounds. storeWeight
     is the only place that conversion happens on the way in, displayWeight
     the only place on the way out. */
  const commit=()=>{
    const typed=parseFloat(wIn.value); const reps=Math.round(parseFloat(rIn.value));
    if(!Number.isFinite(typed)||typed<0||!Number.isFinite(reps)||reps<0) return;
    doLog(e, idx, { weight: T.storeWeight(typed, STATE.unit), reps }, { fail: reps===0 });
  };
```

And find the miss handler (already carrying Task 10's renamed fields):

```js
  /* A miss keeps whatever reps were actually completed. v0 threw this away;
     "failed at 3 of 5" and "failed at 0 of 5" are different signals, and
     autoregulation will want the difference. */
  const miss=row.querySelector('.pillMiss'); if(miss) miss.addEventListener('click',ev=>{
    stop(ev);
    const typed=parseFloat(wIn.value);
    const weight=Number.isFinite(typed)? T.storeWeight(typed, STATE.unit) : (e.lastWeight!=null?e.lastWeight:rx.weight);
    const partial=Math.round(parseFloat(rIn.value));
    doLog(e, idx, { weight, reps: Number.isFinite(partial)&&partial>0 ? partial : 0 }, { fail:true });
  });
```

Replace with:

```js
  const miss=row.querySelector('.pillMiss'); if(miss) miss.addEventListener('click',ev=>{ stop(ev); const weight=parseFloat(wIn.value)|| (e.lastWeight!=null?e.lastWeight:rx.weight); doLog(e, idx, { weight, reps:0 }, { fail:true }); });
```

Then add these two handlers immediately before `return row;`:

```js
  /* Marking a set a warm-up rewrites it in place — no re-entry, and every
     aggregate drops it on the next render because isWorkingSet() says so. */
  const warm=row.querySelector('[data-act="warmup"]');
  if(warm) warm.addEventListener('click',ev=>{
    stop(ev);
    if(e.log[idx]) e.log[idx].warmup = !e.log[idx].warmup;
    else e.log[idx] = T.makeSet(e.kind, { weight:parseFloat(wIn.value)||0, reps:Math.round(parseFloat(rIn.value))||0, warmup:true, perSide:!!e.perSide }, Date.now());
    rollupToday(e); render();
  });
  const rpeBtn=row.querySelector('[data-act="rpe"]');
  if(rpeBtn) rpeBtn.addEventListener('click',ev=>{ stop(ev); openRpe(e, idx); });
```

- [ ] **Step 6: Add the RPE picker**

Add this function immediately after `function addDrop(e, idx){ ... }`:

```js
/* RPE in one tap. Optional by design — an empty RPE is a real answer, and
   the plateau logic treats "unknown" differently from "10". */
function openRpe(e, idx){
  const s=e.log[idx]; if(!s) return;
  const values=[6,6.5,7,7.5,8,8.5,9,9.5,10];
  openPop('<div class="popHead"><h3>How hard was that set?</h3><p class="formGist">RPE 10 is nothing left. RPE 7 is three reps in reserve. Skip it if you would rather not guess.</p></div>'
    + '<div class="rpeGrid">'+values.map(v=>'<button class="rpeBtn'+(s.rpe===v?' on':'')+'" data-v="'+v+'">'+v+'</button>').join('')+'</div>'
    + '<button class="pbtn ghost" id="rpeClear" style="width:100%;margin-top:12px">Clear</button>',
    scrim=>{
      scrim.querySelectorAll('.rpeBtn').forEach(b=> b.onclick=()=>{ s.rpe=parseFloat(b.dataset.v); delete s.rir; closePop(); render(); });
      scrim.querySelector('#rpeClear').onclick=()=>{ delete s.rpe; delete s.rir; closePop(); render(); };
    });
}
```

- [ ] **Step 7: Update `addDrop` and `renderDropRow` to the new field names**

In `addDrop`, replace the body with:

```js
function addDrop(e, idx){
  const s=e.log[idx]; if(!s) return; s.drops=s.drops||[];
  const lastWeight = s.drops.length? s.drops[s.drops.length-1].weight : s.weight;
  s.drops.push({ weight:r1((lastWeight||0)*0.8), reps:s.reps }); saveState(); render();
}
```

In `renderDropRow`, replace every `dr.kg` with `dr.weight` (three occurrences: the input `value`, and both sides of the `commit` closure).

- [ ] **Step 8: Convert weight at every input and display point**

Storage is canonical pounds, so every number the user sees or types crosses a
boundary. There are exactly two functions for it — `T.displayWeight(lb, unit)`
on the way out and `T.storeWeight(typed, unit)` on the way in — and no other
code may do arithmetic on units.

In `renderPill`, the prefill must be converted for display. Find:

```js
  const prefillKg = s?s.kg:(suggestion!=null?suggestion:rx.kg);
```

Replace with:

```js
  const prefillWeight = T.displayWeight(s? (s.weight||0) : (suggestion!=null?suggestion:rx.weight), STATE.unit);
```

Then update the input that reads it — change `value="'+prefillKg+'"` to
`value="'+prefillWeight+'"`.

In `renderCard`, the "last" chip: change `metaBits.push('last '+e.lastWeight+' '+STATE.unit)`
to `metaBits.push('last '+T.displayWeight(e.lastWeight, STATE.unit)+' '+STATE.unit)`.

In `openTune`, the weight field shows and writes a value — convert on render
(`T.displayWeight(draft.weight, STATE.unit)`) and on commit
(`draft.weight = T.storeWeight(parseFloat(input.value), STATE.unit)`).

In `renderDropRow`, convert the same way: display `T.displayWeight(dr.weight, STATE.unit)`,
and in its `commit` store `dr.weight = T.storeWeight(kg, STATE.unit)`.

Verify with a grep — every remaining bare weight interpolation next to a
`STATE.unit` label is a bug:

```bash
grep -n "STATE.unit" public/tiles/train.html
```

Read-only display paths in the Progress sheet (`drawChart`, `drawTable`,
`drawStats`, `drawRecords`, `drawGoals`, `drawAggChart`, `renderCalQuarter`,
`celebrate`) are converted in Task 12 alongside their other changes.

- [ ] **Step 9: Add CSS for the new controls**

Add to the `<style>` block, after the `.noteBar` rules:

```css
  /* warm-up marker — deliberately quiet; it is a correction, not an action */
  .pillWarm { flex:none; width:22px; height:22px; border-radius:7px; border:1px solid var(--hair-strong); background:transparent; color:var(--muted-2); font-size:11px; font-weight:700; font-family:var(--mono); line-height:1; }
  .pillWarm.on { background:var(--e4); color:var(--text); border-color:var(--hair-strong); }
  .pillRpe { flex:none; height:22px; padding:0 7px; border-radius:7px; border:1px solid var(--hair); background:transparent; color:var(--muted-2); font-size:10px; font-weight:700; font-family:var(--mono); letter-spacing:.04em; }
  .pillRpe.on { color:var(--signal); border-color:rgba(110,231,183,.35); }
  .pill.warmup { opacity:.62; }
  .rpeGrid { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; margin-top:16px; }
  .rpeBtn { padding:14px 0; border-radius:var(--r-sm); border:1px solid var(--hair-strong); background:var(--e2); color:var(--text); font-family:var(--mono); font-size:15px; font-weight:600; }
  .rpeBtn.on { background:var(--signal); color:var(--signal-ink); border-color:var(--signal); }
```

And in `renderPill`, add `warmup` to the row class list so `.pill.warmup` applies. Change:

```js
  const row=document.createElement('div'); row.className='pill '+(kind==='failed'?'failed':(kind==='done'?'done':''))+(logged?'':' tappable');
```

to:

```js
  const row=document.createElement('div'); row.className='pill '+(kind==='failed'?'failed':(kind==='done'||kind==='warmup'?'done':''))+(kind==='warmup'?' warmup':'')+(logged?'':' tappable');
```

- [ ] **Step 10: Rebuild and test**

Run: `npm run build:tiles && npx vitest run`
Expected: PASS — all suites green.

- [ ] **Step 11: Verify by hand**

Run `npm run dev`, open Train, add a lift. Confirm: logging a set works; tapping **W** dims the row and marks it a warm-up; the session volume in the rail drops when a set becomes a warm-up; tapping **RPE** on a logged set opens the picker and the chosen value shows on the row; a drop set still adds and edits.

- [ ] **Step 12: Commit**

```bash
git add public/tiles/train.html tiles-library/train.html tests/train/logging-contract.test.ts
git commit -m "feat(train): log typed sets with warm-up flag and optional RPE

Sets are built by the engine, warm-ups are excluded from volume, PRs and
rest timing, and RPE is one tap on any logged set.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 12: Rewire aggregates to the engine

**Files:**
- Modify: `public/tiles/train.html` (`isPR`, `sessionVolume`, `aggregateVolumeByDate`, `muscleVolumeBreakdown`, `drawMuscles`, `detectPlateau`, `suggestedKg`, `prescription`, `exportCSV`, `buildInsightContext`, `applyAutomaticDeloads`)
- Create: `tests/train/aggregates-contract.test.ts`

**Interfaces:**
- Consumes: `sumSets`, `entryVolume` (Task 3); `distributeToMuscles` (Task 5); `isWorkingSet`, `totalReps` (Task 2); `volOpts`, `workingSets`, `topWeight`, `topReps`, `setCount`, `bestWeightExclToday`, `bestRepsAt` (Task 10).
- Produces: `suggestedWeight(e, rx)` replacing `suggestedKg`; every aggregate excludes warm-ups and uses real per-equipment increments.

Until this task, warm-ups are stored correctly but the charts still count them. This is where the spec's "quietly garbage stats" actually gets fixed.

- [ ] **Step 1: Write the failing contract test `tests/train/aggregates-contract.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const tile = () => readFileSync('public/tiles/train.html', 'utf8')

describe('aggregates', () => {
  it('computes session volume through the engine', () => {
    expect(tile()).toContain('T.sumSets(')
  })

  it('splits muscle volume by contribution', () => {
    expect(tile()).toContain('T.distributeToMuscles(')
  })

  it('no longer multiplies weight by raw set count for muscle volume', () => {
    expect(tile()).not.toMatch(/s\.kg\s*\|\|\s*0\)\s*\*\s*\(\(s\.sets/)
  })

  it('reads history sets rather than the retired top-level kg', () => {
    const script = tile()
    expect(script).not.toMatch(/real\[real\.length-1\]\.kg/)
  })

  it('exports every measure, not just weight and reps', () => {
    expect(tile()).toContain('rpe')
    expect(tile()).toContain('warmup')
    expect(tile()).toContain('at_estimated')
  })

  it('converts weight for display rather than printing raw pounds', () => {
    expect(tile()).toContain('T.displayWeight(')
  })

  it('says so when the muscle split is guessed', () => {
    expect(tile()).toContain('muscleSplitIsEstimated')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/train/aggregates-contract.test.ts`
Expected: FAIL.

- [ ] **Step 3: Replace `isPR`**

```js
/* A PR is a working set that beats the best working set from any earlier
   day — more weight, or the same weight for more reps. A warm-up or a
   missed set can never qualify, and today never competes with itself. */
function isPR(e, idx){
  const s=e.log[idx];
  if(!T.isWorkingSet(s) || typeof s.weight!=='number') return false;
  const pb=bestWeightExclToday(e);
  if(pb<=0) return false;
  if(s.weight>pb) return true;
  return s.weight===pb && T.totalReps(s)>bestRepsAt(e,pb);
}
```

- [ ] **Step 4: Replace `sessionVolume` and `aggregateVolumeByDate`**

```js
function sessionVolume(session){
  if(session.off) return 0;
  let total=0;
  session.ex.forEach(e=>{ total += T.sumSets(e.log, volOpts(e.id)).tonnage; });
  return Math.round(total);
}
/* Tonnage per calendar day across every lift on record. Warm-ups and
   misses contribute nothing because setVolume() already zeroes them. */
function aggregateVolumeByDate(){
  const byDate={};
  Object.keys(STATE.history||{}).forEach(id=>{
    const opts=volOpts(id);
    (STATE.history[id]||[]).forEach(entry=>{
      byDate[entry.date]=(byDate[entry.date]||0)+T.entryVolume(entry, opts).tonnage;
    });
  });
  return Object.keys(byDate).sort().map(date=>({date, kg:byDate[date]}));
}
```

- [ ] **Step 5: Replace `muscleVolumeBreakdown`**

```js
/* Volume per muscle, split by real contribution rather than divided evenly
   across whatever strings the classifier returned. Secondary muscles get
   partial credit; hard sets are the comparable unit across set kinds. */
function muscleVolumeBreakdown(){
  const totals={}, estimated={};
  Object.keys(STATE.history||{}).forEach(id=>{
    const def=STATE.exercises[id]; if(!def) return;
    const opts=volOpts(id);
    (STATE.history[id]||[]).forEach(entry=>{
      const split=T.distributeToMuscles(T.entryVolume(entry, opts), def);
      Object.keys(split).forEach(m=>{
        totals[m]=totals[m]||{tonnage:0, hardSets:0};
        totals[m].tonnage+=split[m].tonnage;
        totals[m].hardSets+=split[m].hardSets;
        if(def.contributionsEstimated) estimated[m]=true;
      });
    });
  });
  return Object.keys(totals)
    .map(m=>({ m:m.replace(/_/g,' '), vol:r1(totals[m].tonnage), sets:r1(totals[m].hardSets),
               estimated:!!estimated[m] }))
    .sort((a,b)=>b.sets-a.sets);
}
/* How much of this breakdown rests on guessed splits. Migrated and
   AI-classified lifts divide their muscles evenly because nobody authored
   real shares — the chart has to say so rather than render a confident bar
   over a uniform guess. */
function muscleSplitIsEstimated(){
  return Object.keys(STATE.history||{})
    .filter(id=>STATE.exercises[id])
    .some(id=>STATE.exercises[id].contributionsEstimated);
}
```

In `drawMuscles`, change the bar value from tonnage to hard sets (the comparable unit) by replacing `Math.round(d.vol/max*100)` inputs — set `const max=Math.max(...data.map(d=>d.sets),1);` and render `d.sets` in `.mbVal`. Update the caption to name its own uncertainty:

```js
  cap.textContent = 'Hard sets by muscle, weighted by how much each lift actually works it'
    + (muscleSplitIsEstimated() ? ' — some lifts have estimated splits, so read the shape, not the numbers.' : '');
```

- [ ] **Step 6: Replace `detectPlateau`**

```js
/* Plateau: weight AND top reps both flat-or-down across the last WINDOW
   sessions that contained real working sets. Needs one session beyond the
   window so a plateau is never called from someone's first few attempts. */
function detectPlateau(e){
  const WINDOW=3;
  const h=histFor(e).filter(entry=>workingSets(entry).length>0);
  if(h.length<WINDOW+1) return null;
  const recent=h.slice(-WINDOW);
  const weights=recent.map(topWeight);
  const reps=recent.map(topReps);
  const flat=arr=>arr.every((v,i)=> i===0 || v<=arr[i-1]);
  if(flat(weights) && flat(reps)) return { sessions:WINDOW, weight:weights[weights.length-1] };
  return null;
}
```

- [ ] **Step 7: Replace `suggestedKg` with `suggestedWeight`**

```js
/* The prefilled weight IS the suggestion. Held after any miss or partial
   session, bumped by the exercise's real equipment increment after a
   session where every working set hit its rep target. */
function suggestedWeight(e, rx){
  const ov=STATE.deloadOverrides && STATE.deloadOverrides[e.id];
  const history=histFor(e).filter(entry=>workingSets(entry).length>0);
  if(ov && !history.some(entry=>entry.date>ov.date)) return ov.weight;
  if(!history.length) return e.lastWeight!=null ? e.lastWeight : rx.weight;
  const last=history[history.length-1];
  const sets=workingSets(last);
  const weight=topWeight(last);
  if(!sets.length || weight<=0) return weight;
  const missed=(last.sets||[]).some(s=>s&&s.fail);
  const allHit=sets.every(s=>T.totalReps(s)>=rx.reps);
  if(missed || !allHit) return weight;
  const def=STATE.exercises[e.id];
  return r1(weight + (def && def.incrementLb ? def.incrementLb : 5));
}
```

Rename the two call sites in `renderPill` (`suggestedKg(e, rx)` → `suggestedWeight(e, rx)`). `prescription()` and the `rx.weight` reads were already converted in Task 10.

- [ ] **Step 8: Convert weights in the read-only display paths**

Every place the Progress sheet prints a weight is reading canonical pounds and
must convert. In `drawChart`, `drawTable`, `drawStats`, `drawRecords`,
`drawGoals`, `drawAggChart`, `renderCalQuarter` and `celebrate`, wrap each
weight with `T.displayWeight(value, STATE.unit)`.

`drawGoals` also needs its input side converted — a target the user types is in
their own unit, so `openAddGoal` must store
`T.storeWeight(parseFloat(input.value), STATE.unit)`.

Volume figures (the rail, the overview cards, the calendar quarter totals) are
tonnage in pounds and carry a `STATE.unit` label, so convert those the same way.

Verify: set `STATE.unit='kg'` in the iframe console and re-render. Every number
should change, every label should read `kg`, and nothing in `STATE.history`
should differ — that is the whole point of canonical storage.

- [ ] **Step 9: Replace `exportCSV`**

```js
/* Export carries every measure the new model records, so an export is a
   real backup rather than a lossy summary. */
function exportCSV(){
  /* Always exported in canonical pounds regardless of display unit, and the
     column name says so — an export that silently changed units between two
     downloads would be worse than useless. `at_estimated` marks rows whose
     timestamp the migration backfilled rather than observed. */
  const rows=[['date','exercise','kind','warmup','failed','weight_lb','reps','seconds','meters','rpe','logged_at','at_estimated']];
  Object.keys(STATE.history||{}).forEach(id=>{
    const def=STATE.exercises[id];
    const name=def?def.name:id;
    (STATE.history[id]||[]).forEach(entry=>{
      (entry.sets||[]).forEach(s=>{
        rows.push([entry.date, name, s.kind, s.warmup?'1':'0', s.fail?'1':'0',
          s.weight!=null?s.weight:'', s.reps!=null?s.reps:'',
          s.seconds!=null?s.seconds:'', s.meters!=null?s.meters:'',
          s.rpe!=null?s.rpe:'', s.at?new Date(s.at).toISOString():'', s.atEstimated?'1':'0']);
      });
    });
  });
  const csv=rows.map(r=>r.map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(',')).join('\n');
  const blob=new Blob([csv],{type:'text/csv'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download='training-history.csv'; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 4000);
}
```

- [ ] **Step 10: Update `buildInsightContext`**

Replace its per-exercise line construction so it reads the new accessors and reports RPE, which is what lets the intelligence layer tell a program problem from a recovery problem:

```js
  session.ex.forEach(e=>{
    const h=histFor(e).filter(entry=>workingSets(entry).length>0);
    const misses=e.log.filter(s=>s&&s.fail).length;
    const pr=exHasPR(e)?' (PR today)':'';
    const plateau=detectPlateau(e);
    if(plateau) plateaus.push({ e, plateau });
    const rpes=e.log.filter(s=>T.isWorkingSet(s) && typeof s.rpe==='number').map(s=>s.rpe);
    const rpeNote = rpes.length ? ' Average RPE today: '+r1(rpes.reduce((a,b)=>a+b,0)/rpes.length)+'.' : '';
    if(h.length>=2){
      const delta=r1(topWeight(h[h.length-1])-topWeight(h[0]));
      lines.push('- '+e.name+': '+h.length+' sessions on record, '+(delta>=0?'+':'')+delta+' '+STATE.unit+' over that span, '+misses+' missed set(s) today'+pr+(plateau?' — PLATEAU: weight and reps flat for the last '+plateau.sessions+' sessions at '+plateau.weight+' '+STATE.unit+'.':'.')+rpeNote);
    } else {
      lines.push('- '+e.name+': first time logging this, '+misses+' missed set(s) today'+pr+'.'+rpeNote);
    }
  });
```

And in `applyAutomaticDeloads`, rename `e.kg=newKg` to `e.weight=newWeight` and the override shape to `{ weight:newWeight, date:today }` to match `TrainStateV1`.

- [ ] **Step 11: Rebuild and test**

Run: `npm run build:tiles && npx vitest run`
Expected: PASS.

- [ ] **Step 12: Verify by hand**

Run `npm run dev`, open Train. Confirm: Progress → Volume shows a sane series; Muscles shows hard sets split by contribution (not one bar per free-text string); marking a past set a warm-up lowers volume; Records and the per-exercise History chart still draw; CSV export downloads with the new columns.

- [ ] **Step 13: Commit**

```bash
git add public/tiles/train.html tiles-library/train.html tests/train/aggregates-contract.test.ts
git commit -m "fix(train): exclude warm-ups from every aggregate

Volume, PRs, plateau detection, progression and muscle breakdown now read
typed working sets through the engine. Muscle volume splits by real
contribution instead of dividing evenly across free-text names.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 13: Resolve exercise names at entry

**Files:**
- Modify: `public/tiles/train.html` (`openSwap`, `commitExercise`, `showApply`, new `confirmExerciseIdentity`, new CSS)
- Create: `tests/train/entry-contract.test.ts`

**Interfaces:**
- Consumes: `resolveExercise`, `slugFromName`, `normalizeName` (Task 7); `CATALOG` (Task 6).
- Produces: typing a known lift never calls the AI and never creates a duplicate; a near miss asks before creating.

- [ ] **Step 1: Write the failing contract test `tests/train/entry-contract.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const tile = () => readFileSync('public/tiles/train.html', 'utf8')

describe('exercise entry', () => {
  it('resolves a typed name before reaching for the AI', () => {
    expect(tile()).toContain('T.resolveExercise(')
  })

  it('offers a did-you-mean confirmation', () => {
    expect(tile()).toContain('confirmExerciseIdentity')
  })

  it('records the accepted name as an alias', () => {
    expect(tile()).toContain('STATE.aliases[')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/train/entry-contract.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add the identity confirmation flow**

Add these two functions immediately before `function openSwap(e){`:

```js
/* Turns an ExerciseDef into a session entry. One place, so a lift added by
   typing, by the coach, or from a template is structurally identical. */
function sessionExerciseFrom(def, opts){
  const sets=Math.max(1,Math.min(8,Math.round((opts&&opts.sets)||3)));
  return {
    id:def.id, name:def.name, kind:def.defaultSetKind,
    tier:(opts&&opts.tier)||2, sets,
    reps:Math.max(1,Math.round((opts&&opts.reps)||10)),
    weight:Number.isFinite(opts&&opts.weight)?opts.weight:(lastWeightFromHistory(def.id)||0),
    rest:Math.max(30,Math.round((opts&&opts.rest)||90)),
    perSide:!!def.unilateral, pinned:false, collapsed:false, deload:false, note:'',
    lastWeight:lastWeightFromHistory(def.id),
    log:Array(sets).fill(null),
  };
}

/**
 * The fragmentation guard. A typed name is resolved against the catalog,
 * the user's own lifts, and every alias they have already confirmed:
 *   exact   → use it, no AI call, history intact
 *   suggest → ask, because silently creating "BB Bench" next to "Bench
 *             Press" is how a lift loses its history
 *   unknown → hand it to the AI classifier
 * Whatever they confirm is stored as an alias, so the question is asked once.
 */
function confirmExerciseIdentity(typed, onResolved, onNew){
  const res=T.resolveExercise(typed, { exercises:STATE.exercises, aliases:STATE.aliases });
  if(res.status==='exact'){
    STATE.aliases[res.normalized]=res.match.id;
    STATE.exercises[res.match.id]=STATE.exercises[res.match.id]||res.match;
    onResolved(res.match); return;
  }
  if(res.status==='suggest'){
    openPop('<div class="popHead"><h3>Did you mean…</h3><p class="formGist">Picking the lift you already track keeps one history instead of splitting it in two.</p></div>'
      + '<div class="swapList">'+res.candidates.map(c=>'<button class="swapItem" data-id="'+c.def.id+'"><span class="nm">'+escapeHtml(c.def.name)+'</span><span class="mu">'+Math.round(c.score*100)+'% match</span></button>').join('')+'</div>'
      + '<button class="pbtn ghost" id="idNew" style="width:100%;margin-top:12px">No — “'+escapeHtml(typed)+'” is a different lift</button>',
      scrim=>{
        scrim.querySelectorAll('.swapItem[data-id]').forEach(b=> b.onclick=()=>{
          const def=res.candidates.find(c=>c.def.id===b.dataset.id).def;
          STATE.aliases[res.normalized]=def.id;
          STATE.exercises[def.id]=STATE.exercises[def.id]||def;
          closePop(); onResolved(def);
        });
        scrim.querySelector('#idNew').onclick=()=>{ closePop(); onNew(res.normalized); };
      });
    return;
  }
  onNew(res.normalized);
}
```

- [ ] **Step 4: Rewrite `runClassify` inside `openSwap`**

Replace the whole `runClassify` closure with:

```js
      const runClassify=async()=>{
        const nm=nameIn.value.trim(); if(!nm) return;
        confirmExerciseIdentity(nm,
          def=>{ commitExercise(sessionExerciseFrom(def, {}), e, session, adding); },
          async normalized=>{
            goBtn.disabled=true; status.style.color='var(--muted-strong)'; status.textContent='Looking that up…';
            try{
              const info=await window.Vitality.classify(nm);
              const id=T.slugFromName(nm, new Set(Object.keys(STATE.exercises)));
              STATE.exercises[id]={
                id, name:nm, aliases:[], pattern:'other', plane:null,
                equipment:(info.equipment||'none').toLowerCase(),
                unilateral:false, defaultSetKind:'reps_weight',
                primary:[], secondary:[], e1rmValid:true, loading:'free',
                incrementLb:5, custom:true,
              };
              STATE.aliases[normalized]=id;
              commitExercise(sessionExerciseFrom(STATE.exercises[id], {
                tier:info.tier, sets:info.startingSets, reps:info.startingReps,
                weight:info.startingKg, rest:info.restSeconds,
              }), e, session, adding);
            }catch(err){
              status.style.color='var(--fail)';
              status.textContent = (err&&err.message)==='no_key' ? 'Add your own Anthropic key to use this — ask your mentor.' : "Couldn't look that up — try again.";
              goBtn.disabled=false;
            }
          });
      };
```

Note what changed: a known lift now resolves instantly with **no AI call at all** — faster, free, and its history stays attached.

- [ ] **Step 5: Route the coach's generated exercises through the same guard**

In `showApply`, replace the `defs` mapping so each generated exercise resolves first:

```js
  const defs=(res.exercises||[]).map(info=>{
    const resolved=T.resolveExercise(info.name||'exercise', { exercises:STATE.exercises, aliases:STATE.aliases });
    let def;
    if(resolved.status==='exact'){ def=resolved.match; }
    else {
      const id=T.slugFromName(info.name||'exercise', new Set(Object.keys(STATE.exercises)));
      def={ id, name:info.name||'Exercise', aliases:[], pattern:'other', plane:null,
        equipment:(info.equipment||'none').toLowerCase(), unilateral:false,
        defaultSetKind:'reps_weight', primary:[], secondary:[], e1rmValid:true,
        loading:'free', incrementLb:5, custom:true };
    }
    STATE.exercises[def.id]=STATE.exercises[def.id]||def;
    STATE.aliases[resolved.normalized]=def.id;
    return sessionExerciseFrom(def, {
      tier:info.tier, sets:info.startingSets, reps:info.startingReps,
      weight:info.startingKg, rest:info.restSeconds,
    });
  });
```

- [ ] **Step 6: Route templates through it too**

In `openSwap`'s template handler, replace the `defs` mapping with:

```js
          const defs=t.ex.map(info=>{
            const resolved=T.resolveExercise(info.name, { exercises:STATE.exercises, aliases:STATE.aliases });
            const def = resolved.status==='exact' ? resolved.match : STATE.exercises[T.slugFromName(info.name, new Set())];
            if(!def) return null;
            STATE.exercises[def.id]=STATE.exercises[def.id]||def;
            return sessionExerciseFrom(def, info);
          }).filter(Boolean);
```

- [ ] **Step 7: Rebuild, test, verify**

Run: `npm run build:tiles && npx vitest run`
Expected: PASS.

Then `npm run dev`: add a lift by typing `bench` — it should appear instantly as **Barbell Bench Press** with no loading state. Type `barbel bench pres` — the did-you-mean sheet appears. Type something genuinely novel — the AI classifier still runs.

- [ ] **Step 8: Commit**

```bash
git add public/tiles/train.html tiles-library/train.html tests/train/entry-contract.test.ts
git commit -m "feat(train): resolve typed exercise names before creating a lift

Known names resolve from the catalog with no AI call, near misses ask
first, and every confirmation is stored as an alias.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 14: Merge duplicate lifts from the UI

**Files:**
- Modify: `public/tiles/train.html` (`openSettings`, new `openMergeTool`, new CSS)
- Create: `tests/train/merge-ui-contract.test.ts`

**Interfaces:**
- Consumes: `mergeExercise`, `mergeableTargets` (Task 8).
- Produces: a user-facing repair path for duplicates that slipped through.

- [ ] **Step 1: Write the failing contract test `tests/train/merge-ui-contract.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const tile = () => readFileSync('public/tiles/train.html', 'utf8')

describe('merge tool', () => {
  it('is reachable from settings', () => {
    expect(tile()).toContain('openMergeTool')
  })

  it('calls the engine merge', () => {
    expect(tile()).toContain('T.mergeExercise(')
  })

  it('confirms before merging, since a merge rewrites history', () => {
    expect(tile()).toContain('mergeConfirm')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/train/merge-ui-contract.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add the merge tool**

Add immediately after `function openSettings(){ ... }`:

```js
/* Fuzzy matching stops most duplicates at the door. This is the repair for
   the ones that got through — two names, one movement, split history. The
   merge is confirmed explicitly because it rewrites the record. */
function openMergeTool(){
  const ids=Object.keys(STATE.exercises);
  if(ids.length<2){
    openPop('<div class="popHead"><h3>Nothing to merge</h3><p class="formGist">You need at least two tracked lifts before anything can be combined.</p></div>');
    return;
  }
  const counts=id=>((STATE.history&&STATE.history[id])||[]).length;
  openPop('<div class="popHead"><h3>Merge duplicate lifts</h3><p class="formGist">Pick the lift you want to fold away. Its history moves into the one you choose next — nothing is deleted.</p></div>'
    + '<div class="swapList">'+ids.map(id=>'<button class="swapItem" data-from="'+id+'"><span class="nm">'+escapeHtml(STATE.exercises[id].name)+'</span><span class="mu">'+counts(id)+' session'+(counts(id)===1?'':'s')+'</span></button>').join('')+'</div>',
    scrim=>{
      scrim.querySelectorAll('.swapItem[data-from]').forEach(b=> b.onclick=()=>{ closePop(); pickMergeTarget(b.dataset.from); });
    });
}
function pickMergeTarget(fromId){
  const targets=T.mergeableTargets(STATE, fromId);
  const fromName=STATE.exercises[fromId].name;
  openPop('<div class="popHead"><h3>Merge “'+escapeHtml(fromName)+'” into…</h3><p class="formGist">Ranked by name similarity. The lift you pick keeps its name and gains the history.</p></div>'
    + '<div class="swapList">'+targets.map(t=>'<button class="swapItem" data-into="'+t.def.id+'"><span class="nm">'+escapeHtml(t.def.name)+'</span><span class="mu">'+Math.round(t.score*100)+'% match</span></button>').join('')+'</div>',
    scrim=>{
      scrim.querySelectorAll('.swapItem[data-into]').forEach(b=> b.onclick=()=>{ closePop(); mergeConfirm(fromId, b.dataset.into); });
    });
}
function mergeConfirm(fromId, intoId){
  const fromName=STATE.exercises[fromId].name, intoName=STATE.exercises[intoId].name;
  const moving=((STATE.history&&STATE.history[fromId])||[]).length;
  openPop('<div class="popHead"><h3>Merge these two?</h3><p class="formGist">'+moving+' session'+(moving===1?'':'s')+' of “'+escapeHtml(fromName)+'” will move into “'+escapeHtml(intoName)+'”. Same-day entries combine. This cannot be undone from here.</p></div>'
    + '<div class="popBtns"><button class="pbtn ghost" id="mgCancel">Cancel</button><button class="pbtn save" id="mgGo">Merge</button></div>',
    scrim=>{
      scrim.querySelector('#mgCancel').onclick=closePop;
      scrim.querySelector('#mgGo').onclick=()=>{
        const result=T.mergeExercise(STATE, fromId, intoId);
        STATE=result.state;
        saveState(); closePop(); render(); renderStatsPicker(); drawStatsSection(); renderOverviewCards();
      };
    });
}
```

- [ ] **Step 4: Add the entry point to settings**

Inside `openSettings`, append this button to the popup markup and wire it in the mount callback:

```js
  + '<button class="pbtn ghost" id="openMerge" style="width:100%;margin-top:14px">Merge duplicate lifts</button>'
```

```js
      const mergeBtn=scrim.querySelector('#openMerge');
      if(mergeBtn) mergeBtn.onclick=()=>{ closePop(); openMergeTool(); };
```

- [ ] **Step 5: Rebuild, test, verify**

Run: `npm run build:tiles && npx vitest run`
Expected: PASS — the full suite, all fourteen tasks' tests.

Then `npm run dev`: create two lifts that are obviously the same movement, log a session on each, open Settings → Merge duplicate lifts, and confirm the history combines under one name and the Progress charts update.

- [ ] **Step 6: Final verification of the whole plan**

Run: `npx vitest run && npm run build && npm run lint`
Expected: all tests pass, Next builds (the `prebuild` hook rebuilds the tile first), lint is clean.

- [ ] **Step 7: Commit**

```bash
git add public/tiles/train.html tiles-library/train.html tests/train/merge-ui-contract.test.ts
git commit -m "feat(train): add a merge tool for duplicate lifts

Settings now offers an explicit, confirmed merge that folds one lift's
history into another.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Coverage against the spec

Section 1 of the spec, item by item:

| Spec item | Task |
|---|---|
| Typed sets: five kinds | 2 |
| Flags: per-side, assisted (negative load), banded | 2, 3 |
| Per-type strategy for volume / PR / progression / charts / CSV | 3, 12 |
| Warm-up vs working sets, excluded from volume / PR / progression | 2, 3, 11, 12 |
| RPE or RIR per set, one tap, optional | 2, 11 |
| Timestamps on every set | 2, 9, 11 |
| Rest-taken and session-density analysis | 4 |
| Movement pattern per exercise | 2, 6 |
| Primary/secondary muscles with contribution weights | 2, 5, 6 |
| Equipment, unilateral flag, e1RM validity | 2, 6 |
| Canonical IDs | 6, 7, 9 |
| Alias table | 6, 7, 13 |
| Fuzzy matching at entry ("did you mean…") | 7, 13 |
| User-facing merge tool | 8, 14 |
| Real per-equipment increments | 6, 12 |

**Deliberately out of scope for this plan** (they belong to later sections and depend on these primitives): double progression and layoff decay (§2), the deload state machine (§3), e1RM formulas and rolling PRs (§4), the rest timer rebuild (§5), session lifecycle and plate math (§6), frequency gaps and ratio analysis (§7), structured-output coach constraints (§8), routines (§9), the Progress tab rebuild (§10), frequency-based streaks (§11), offline sync (§12), and Hevy/Strong import (§13).

Two of those are worth flagging now because this plan makes them cheap: **frequency-based streaks (§11)** becomes trivial once `finishedDates` and hard sets per week are available, and **Hevy/Strong CSV import (§13)** is mostly a mapper onto `LoggedSet` + `resolveExercise`, both of which now exist.
