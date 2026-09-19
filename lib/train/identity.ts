/**
 * Exercise identity.
 *
 * Letting people type a name is the right interface and the wrong storage
 * model. "Bench Press", "BB Bench" and "Flat Bench" are one lift with one
 * history, and if they are not resolved onto one id then progression has
 * nothing to progress from, PRs have nothing to beat, and plateau detection
 * sees three lifts that each stalled immediately.
 *
 * It is the same bug as "Pecs" and "Chest", one level up, and it fails the
 * same way: silently, by never accumulating.
 *
 * Pure and DOM-free.
 */

import { CATALOG, type CatalogExercise } from './catalog'

/** Gym shorthand, expanded before anything is compared. */
const ABBREVIATIONS: Record<string, string> = {
  bb: 'barbell', db: 'dumbbell', kb: 'kettlebell', ohp: 'overhead press',
  rdl: 'romanian deadlift', sldl: 'stiff leg deadlift', dl: 'deadlift',
  bp: 'bench press', bw: 'bodyweight', bss: 'bulgarian split squat',
  rfess: 'rear foot elevated split squat', ez: 'ez bar',
}

/** Words that never distinguish one lift from another. */
const FILLER = new Set(['the', 'a', 'an', 'with', 'using', 'on', 'at', 'of', 'for', 'my', 'some'])

function singularize(token: string): string {
  if (token.length > 3 && token.endsWith('ies')) return `${token.slice(0, -3)}y`
  if (token.length > 3 && token.endsWith('es') && !token.endsWith('ses')) return token.slice(0, -2)
  if (token.length > 2 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1)
  return token
}

/** One canonical string for comparing names typed by a human. */
export function normalizeName(raw: unknown): string {
  const tokens = String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)

  const expanded: string[] = []
  for (const token of tokens) {
    const full = ABBREVIATIONS[token]
    if (full) expanded.push(...full.split(' '))
    else expanded.push(singularize(token))
  }
  return expanded.filter((t) => !FILLER.has(t)).join(' ')
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const curr = [i]
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = curr
  }
  return prev[b.length]
}

function jaccard(a: string, b: string): number {
  const A = new Set(a.split(' ').filter(Boolean))
  const B = new Set(b.split(' ').filter(Boolean))
  if (!A.size && !B.size) return 1
  let shared = 0
  A.forEach((t) => { if (B.has(t)) shared++ })
  return shared / (A.size + B.size - shared)
}

/**
 * The same name written in a different order is the same name.
 *
 * "Squat, Back" and "Back Squat" are one lift, and an import that compared
 * strings would fork them. Sorting the tokens keeps this an EXACT match —
 * the same words, every one of them — rather than widening into fuzz.
 */
export function tokenKey(raw: unknown): string {
  return normalizeName(raw).split(' ').filter(Boolean).sort().join(' ')
}

/** Lowercase letters and digits only — for comparing what was typed. */
function loose(raw: string): string {
  return String(raw || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function editSimilarity(a: string, b: string): number {
  if (!a && !b) return 1
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length, 1)
}

/**
 * Two readings, and the better one wins.
 *
 * The token reading compares sorted tokens so word order cannot hurt —
 * "incline bench press" and "bench press incline" are the same lift.
 *
 * The raw reading compares the letters as typed, because normalization is
 * hostile to typos: "pres" singularizes to "pre" and drifts FURTHER from
 * "press" than it started. A misspelling has to be caught on the string
 * somebody actually typed.
 */
export function similarity(a: string, b: string): number {
  const na = normalizeName(a)
  const nb = normalizeName(b)
  if (na === nb) return 1

  const sortedA = na.split(' ').filter(Boolean).sort().join(' ')
  const sortedB = nb.split(' ').filter(Boolean).sort().join(' ')
  const byToken = jaccard(na, nb) * 0.7 + Math.max(0, editSimilarity(sortedA, sortedB)) * 0.3
  const byLetter = Math.max(0, editSimilarity(loose(a), loose(b)))
  return Math.max(byToken, byLetter)
}

/** Above this we ask; below it we assume the lift is genuinely new. */
export const NEAR_THRESHOLD = 0.55

export interface ResolveCandidate {
  id: string
  name: string
  score: number
  source: 'catalog' | 'user'
}

export interface ResolveResult {
  /** exact uses it silently; near asks; unknown goes to the classifier. */
  status: 'exact' | 'near' | 'unknown'
  match?: ResolveCandidate
  candidates: ResolveCandidate[]
  /** The normalized form — store this as the alias key on confirmation. */
  normalized: string
}

export interface ResolveOptions {
  /** The athlete's own lifts: id → display name. */
  userExercises?: Record<string, string>
  /** Confirmed aliases: normalized name → canonical id. */
  aliases?: Record<string, string>
}

function catalogCandidate(def: CatalogExercise, score: number): ResolveCandidate {
  return { id: def.id, name: def.name, score, source: 'catalog' }
}

/**
 * Resolves a typed name against the catalog, the athlete's own lifts, and
 * every alias they have already confirmed.
 *
 * An exact hit costs nothing: no AI call, no new id, and the lift keeps its
 * history. That is the whole point.
 */
export function resolveExercise(raw: string, opts: ResolveOptions = {}): ResolveResult {
  const normalized = normalizeName(raw)
  const users = opts.userExercises || {}
  const aliases = opts.aliases || {}
  if (!normalized) return { status: 'unknown', candidates: [], normalized }

  /* 1. an answer they already gave. Keys are matched on their normalized
     form, so an alias stored under whatever was typed still resolves. */
  const aliasIndex: Record<string, string> = {}
  for (const key of Object.keys(aliases)) aliasIndex[normalizeName(key)] = aliases[key]
  const confirmed = aliasIndex[normalized]
  if (confirmed) {
    const def = CATALOG.find((e) => e.id === confirmed)
    if (def) return { status: 'exact', match: catalogCandidate(def, 1), candidates: [], normalized }
    if (users[confirmed]) {
      return {
        status: 'exact',
        match: { id: confirmed, name: users[confirmed], score: 1, source: 'user' },
        candidates: [], normalized,
      }
    }
  }

  // 2. an exact hit on a catalog id, name or alias
  const key = tokenKey(raw)
  for (const def of CATALOG) {
    if ([def.id, def.name, ...def.aliases].some((f) => tokenKey(f) === key)) {
      return { status: 'exact', match: catalogCandidate(def, 1), candidates: [], normalized }
    }
  }

  // 3. an exact hit on one of their own lifts
  for (const id of Object.keys(users)) {
    if (tokenKey(users[id]) === key || tokenKey(id) === key) {
      return {
        status: 'exact',
        match: { id, name: users[id], score: 1, source: 'user' },
        candidates: [], normalized,
      }
    }
  }

  // 4. near misses — surfaced for confirmation, never applied silently
  const scored: ResolveCandidate[] = []
  for (const def of CATALOG) {
    const best = [def.name, ...def.aliases].reduce((max, f) => Math.max(max, similarity(normalized, f)), 0)
    if (best >= NEAR_THRESHOLD) scored.push(catalogCandidate(def, best))
  }
  for (const id of Object.keys(users)) {
    const best = similarity(normalized, users[id])
    if (best >= NEAR_THRESHOLD) scored.push({ id, name: users[id], score: best, source: 'user' })
  }
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))

  if (scored.length) return { status: 'near', candidates: scored.slice(0, 3), normalized }
  return { status: 'unknown', candidates: [], normalized }
}

/** Builds a fresh id that collides with nothing already in use. */
export function slugFromName(raw: string, taken: Set<string>): string {
  const base =
    String(raw).toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'exercise'
  let id = base
  let n = 1
  while (taken.has(id)) id = `${base}_${++n}`
  return id
}

/* ────────────────────────────────────────────────────────────────────
   Merge — for the lifts that already forked before any of this existed.
   ──────────────────────────────────────────────────────────────────── */

export interface MergeableState {
  history?: Record<string, unknown[]>
  exerciseNames?: Record<string, string>
  customLib?: Record<string, unknown>
  aliases?: Record<string, string>
  deloadStates?: Record<string, unknown>
  painFlagged?: string[]
  liftGoals?: Array<{ id?: string }>
  session?: { ex?: Array<{ id: string; name?: string }> }
}

export interface MergeResult {
  state: MergeableState
  /** Sessions moved off the losing id. */
  moved: number
  fromName: string
  intoName: string
}

/** Same-day rows for one lift are one session's work, not two. */
function foldByDate(rows: unknown[]): unknown[] {
  const byDate = new Map<string, Record<string, unknown>>()
  for (const raw of rows) {
    const row = raw as Record<string, unknown>
    const date = String(row.date)
    const existing = byDate.get(date)
    if (existing) {
      existing.sets = [
        ...((existing.sets as unknown[]) || []),
        ...((row.sets as unknown[]) || []),
      ]
      // the heavier of the two recorded top weights survives
      if (typeof row.kg === 'number' && row.kg > (existing.kg as number || 0)) existing.kg = row.kg
    } else {
      byDate.set(date, { ...row })
    }
  }
  return [...byDate.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)))
}

/**
 * Folds one lift's identity into another.
 *
 * Never destructive: the losing id's rows MOVE, they do not vanish. Every
 * set and every date survives, which is the only reason this is safe to
 * offer for a record someone has spent years building.
 */
export function mergeExercises(state: MergeableState, fromId: string, intoId: string): MergeResult {
  if (fromId === intoId) throw new Error('cannot merge a lift into itself')

  const names = state.exerciseNames || {}
  const intoName = names[intoId] || intoId
  const fromName = names[fromId] || fromId

  const history = { ...(state.history || {}) }
  const moving = history[fromId] || []
  history[intoId] = foldByDate([...(history[intoId] || []), ...moving])
  delete history[fromId]

  const exerciseNames = { ...names }
  delete exerciseNames[fromId]

  const customLib = { ...(state.customLib || {}) }
  // keep the winner's definition; only fill gaps from the loser
  const losing = customLib[fromId] as Record<string, unknown> | undefined
  const winning = (customLib[intoId] as Record<string, unknown>) || {}
  if (losing) {
    customLib[intoId] = { ...losing, ...winning }
    delete customLib[fromId]
  }

  const aliases = { ...(state.aliases || {}) }
  for (const key of Object.keys(aliases)) {
    if (aliases[key] === fromId) aliases[key] = intoId
  }
  // the losing name itself becomes an alias, so it never forks again
  aliases[normalizeName(fromName)] = intoId

  const deloadStates = { ...(state.deloadStates || {}) }
  if (deloadStates[fromId] && !deloadStates[intoId]) deloadStates[intoId] = deloadStates[fromId]
  delete deloadStates[fromId]

  const painFlagged = [...(state.painFlagged || [])]
  if (painFlagged.includes(fromId)) {
    // a movement that hurt under one name still hurts under the other
    if (!painFlagged.includes(intoId)) painFlagged.push(intoId)
    painFlagged.splice(painFlagged.indexOf(fromId), 1)
  }

  const liftGoals = (state.liftGoals || []).map((g) => (g && g.id === fromId ? { ...g, id: intoId } : g))

  const session = state.session
    ? {
        ...state.session,
        ex: (state.session.ex || []).map((ex) =>
          ex.id === fromId ? { ...ex, id: intoId, name: intoName } : ex,
        ),
      }
    : state.session

  return {
    state: { ...state, history, exerciseNames, customLib, aliases, deloadStates, painFlagged, liftGoals, session },
    moved: moving.length,
    fromName,
    intoName,
  }
}
