/**
 * Importing a training history from Hevy or Strong.
 *
 * Everything good in this app needs history. On a fresh install the whole
 * intelligence layer is inert — no plateau to detect, no baseline to
 * compare against, no records to beat — which is exactly the moment someone
 * decides whether to keep it. Import flips that on day one.
 *
 * It is mostly a mapper onto types that already exist. The interesting
 * parts are the three refusals: it will not invent an exercise identity, it
 * will not claim a timestamp it did not observe, and it will not double a
 * history because somebody imported the same file twice.
 *
 * UNITS: this is the one place a conversion is correct. Hevy exports
 * kilograms and the store is pounds, so the boundary converts. Nothing
 * inside the app converts anything.
 *
 * Pure and DOM-free.
 */

import { resolveExercise, type ResolveOptions } from './identity'
import type { HistorySet, SetKind } from './sets'

export const LB_PER_KG = 2.2046226218

export type ImportSource = 'hevy' | 'strong' | 'unknown'

export interface ImportedSet extends HistorySet {
  /** Where this row came from. Never inferred later. */
  imported: ImportSource
}

export interface ImportedEntry {
  date: string
  exerciseId: string
  displayName: string
  kg: number
  sets: ImportedSet[]
}

export interface UnresolvedName {
  name: string
  rows: number
}

export interface ImportReport {
  source: ImportSource
  sessions: number
  lifts: number
  sets: number
  from: string | null
  to: string | null
  /** Names that need a decision rather than a silent new lift. */
  unresolved: UnresolvedName[]
  /** Rows skipped because they were already in the history. */
  duplicates: number
}

export interface ImportResult {
  entries: ImportedEntry[]
  report: ImportReport
}

/* ── CSV ──────────────────────────────────────────────────────────── */

/** A quote-aware split. Exercise names contain commas surprisingly often. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  const src = String(text || '').replace(/\r\n?/g, '\n')

  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++ } else quoted = false
      } else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else field += c
  }
  if (field.length || row.length) { row.push(field); rows.push(row) }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''))
}

function headerIndex(header: string[]): Record<string, number> {
  const out: Record<string, number> = {}
  header.forEach((name, i) => {
    out[String(name).trim().toLowerCase().replace(/[\s-]+/g, '_')] = i
  })
  return out
}

/** Which app produced this file, from its header alone. */
export function detectSource(header: string[]): ImportSource {
  const cols = headerIndex(header)
  if ('exercise_title' in cols && 'set_index' in cols) return 'hevy'
  if ('exercise_name' in cols && ('set_order' in cols || 'workout_name' in cols)) return 'strong'
  return 'unknown'
}

function toDate(raw: string): string | null {
  const text = String(raw || '').trim()
  if (!text) return null
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  // Strong writes "2026-09-16 18:30:00"; some exports use slashes
  const slash = text.match(/^(\d{4})\/(\d{2})\/(\d{2})/)
  if (slash) return `${slash[1]}-${slash[2]}-${slash[3]}`
  const parsed = new Date(text)
  if (Number.isNaN(parsed.getTime())) return null
  const p = (n: number) => String(n).padStart(2, '0')
  return `${parsed.getFullYear()}-${p(parsed.getMonth() + 1)}-${p(parsed.getDate())}`
}

function num(raw: unknown): number | undefined {
  const n = typeof raw === 'string' ? parseFloat(raw) : typeof raw === 'number' ? raw : NaN
  return Number.isFinite(n) ? n : undefined
}

const round = (n: number) => Math.round(n * 100) / 100

interface RawRow {
  date: string
  name: string
  weightLb?: number
  reps?: number
  seconds?: number
  metres?: number
  rpe?: number
  warmup: boolean
}

function readRows(rows: string[][], source: ImportSource, strongUnit: 'lb' | 'kg'): RawRow[] {
  const cols = headerIndex(rows[0] || [])
  const at = (row: string[], key: string) => (cols[key] === undefined ? '' : row[cols[key]])
  const out: RawRow[] = []

  for (const row of rows.slice(1)) {
    const date = toDate(source === 'hevy' ? at(row, 'start_time') : at(row, 'date'))
    const name = String(source === 'hevy' ? at(row, 'exercise_title') : at(row, 'exercise_name')).trim()
    if (!date || !name) continue

    const setType = String(at(row, 'set_type') || '').toLowerCase()
    const warmup = setType === 'warmup' || setType === 'warm up'

    let weightLb: number | undefined
    if (source === 'hevy') {
      const kg = num(at(row, 'weight_kg'))
      weightLb = kg === undefined ? undefined : round(kg * LB_PER_KG)
    } else {
      const w = num(at(row, 'weight'))
      weightLb = w === undefined ? undefined : strongUnit === 'kg' ? round(w * LB_PER_KG) : w
    }

    const km = num(at(row, 'distance_km'))
    const distance = num(at(row, 'distance'))
    out.push({
      date,
      name,
      weightLb,
      reps: num(at(row, 'reps')),
      seconds: num(source === 'hevy' ? at(row, 'duration_seconds') : at(row, 'seconds')),
      metres: km !== undefined ? round(km * 1000) : distance,
      rpe: num(at(row, 'rpe')),
      warmup,
    })
  }
  return out
}

/** The kind a row describes, from which measures it actually carries. */
function kindOf(row: RawRow): SetKind {
  const hasTime = row.seconds !== undefined && row.seconds > 0
  const hasDistance = row.metres !== undefined && row.metres > 0
  if (hasTime && hasDistance) return 'time_distance'
  if (hasDistance) return 'distance'
  if (hasTime && !row.reps) return 'time'
  if (row.weightLb === undefined || row.weightLb === 0) {
    return row.reps ? 'reps_only' : 'time'
  }
  return 'reps_weight'
}

export interface ImportOptions extends ResolveOptions {
  /** Strong exports in the athlete's chosen unit and does not always say. */
  strongUnit?: 'lb' | 'kg'
  /** Existing history, so a second import of the same file changes nothing. */
  existing?: Record<string, Array<{ date: string }>>
}

/**
 * Parses an export into history entries.
 *
 * Three refusals, each deliberate:
 *
 *   A name that does not resolve is REPORTED, not turned into a new lift.
 *   Silently creating "Bench Press (Barbell)" beside an existing bench is
 *   the fork this codebase spent a whole pass eliminating.
 *
 *   Timestamps are never claimed. Imported sets carry atEstimated, so the
 *   rest-taken and density reads skip them rather than reporting a cadence
 *   nobody observed.
 *
 *   A date already present for a lift is skipped. Importing the same file
 *   twice must not double a history.
 */
export function importCsv(text: string, opts: ImportOptions = {}): ImportResult {
  const rows = parseCsv(text)
  const source = detectSource(rows[0] || [])
  const empty: ImportReport = {
    source, sessions: 0, lifts: 0, sets: 0, from: null, to: null, unresolved: [], duplicates: 0,
  }
  if (source === 'unknown' || rows.length < 2) return { entries: [], report: empty }

  const raw = readRows(rows, source, opts.strongUnit || 'lb')
  const unresolved = new Map<string, number>()
  const byKey = new Map<string, ImportedEntry>()
  const existing = opts.existing || {}
  let duplicates = 0

  for (const row of raw) {
    const resolved = resolveExercise(row.name, opts)
    /* Only an exact hit is trusted. A near match is a question, and an
       import is the worst possible moment to answer it on someone's behalf
       — it would be answered once and wrong for a thousand rows. */
    if (resolved.status !== 'exact' || !resolved.match) {
      unresolved.set(row.name, (unresolved.get(row.name) || 0) + 1)
      continue
    }
    const id = resolved.match.id

    if ((existing[id] || []).some((e) => e.date === row.date)) { duplicates++; continue }

    const key = `${id}@${row.date}`
    const entry = byKey.get(key) || {
      date: row.date, exerciseId: id, displayName: resolved.match.name, kg: 0, sets: [],
    }
    const kind = kindOf(row)
    const set: ImportedSet = { imported: source, warmup: row.warmup || undefined }
    if (kind !== 'reps_weight') set.kind = kind
    if (row.weightLb !== undefined) set.w = row.weightLb
    if (row.reps !== undefined) set.r = row.reps
    if (row.seconds !== undefined) set.s = row.seconds
    if (row.metres !== undefined) set.m = row.metres
    if (row.rpe !== undefined) set.rpe = row.rpe
    entry.sets.push(set)
    if (!row.warmup && (row.weightLb || 0) > entry.kg) entry.kg = row.weightLb || 0
    byKey.set(key, entry)
  }

  const entries = [...byKey.values()].sort(
    (a, b) => a.date.localeCompare(b.date) || a.exerciseId.localeCompare(b.exerciseId),
  )
  const dates = entries.map((e) => e.date)
  return {
    entries,
    report: {
      source,
      sessions: new Set(dates).size,
      lifts: new Set(entries.map((e) => e.exerciseId)).size,
      sets: entries.reduce((n, e) => n + e.sets.length, 0),
      from: dates.length ? dates[0] : null,
      to: dates.length ? dates[dates.length - 1] : null,
      unresolved: [...unresolved.entries()]
        .map(([name, count]) => ({ name, rows: count }))
        .sort((a, b) => b.rows - a.rows),
      duplicates,
    },
  }
}
