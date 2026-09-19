/**
 * Durability.
 *
 * Tile data already leaves the iframe — window.Vitality.save posts to the
 * host, which writes to the host app's localStorage and mirrors to Supabase
 * when sync is configured. So the opaque-origin iframe is not the exposure.
 *
 * The real exposure is that WITHOUT SYNC THERE IS EXACTLY ONE COPY, on an
 * origin Safari still evicts after roughly seven days without a visit. A
 * user who travels, or takes a deload week, can come back to nothing. That
 * is the only failure in this app capable of making someone hate it, and a
 * silent one is the worst version of it.
 *
 * So: rolling snapshots rather than a single latest, a restore path that
 * never silently starts fresh on top of someone with history, a JSON
 * round-trip that loses nothing, and an honest report of which layers are
 * actually working — the same posture as the recovery read.
 *
 * Pure and DOM-free.
 */

export const SNAPSHOT_VERSION = 1

/** Rolling copies kept. A corrupt write must not be the only copy. */
export const MAX_SNAPSHOTS = 5

export interface Snapshot {
  v: number
  /** Epoch ms the snapshot was taken. */
  at: number
  /** Local date, for showing the user what they would restore. */
  date: string
  /** Cheap integrity signal — not security, just "did this survive intact". */
  sets: number
  state: unknown
}

export type LayerStatus = 'ok' | 'unavailable' | 'failed'

export interface StorageReport {
  /** The host bridge — the primary store. */
  host: LayerStatus
  /** The iframe's own localStorage, if an opaque origin permits it. */
  local: LayerStatus
  /** Snapshots currently held. */
  snapshots: number
  /** Human-readable, for surfacing rather than hiding. */
  detail: string
}

function countSets(state: unknown): number {
  const s = state as { history?: Record<string, Array<{ sets?: unknown[] }>> } | null
  if (!s || typeof s !== 'object' || !s.history) return 0
  let n = 0
  for (const rows of Object.values(s.history)) {
    for (const entry of rows || []) n += (entry.sets || []).length
  }
  return n
}

function dateKey(ms: number): string {
  const d = new Date(ms)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function makeSnapshot(state: unknown, now: number): Snapshot {
  return { v: SNAPSHOT_VERSION, at: now, date: dateKey(now), sets: countSets(state), state }
}

/**
 * A snapshot worth restoring from.
 *
 * Deliberately strict: an unusable snapshot must be rejected here rather
 * than thrown at the caller mid-boot, because the caller's fallback is to
 * start empty and that is the outcome this exists to prevent.
 */
export function validateSnapshot(raw: unknown): raw is Snapshot {
  if (!raw || typeof raw !== 'object') return false
  const s = raw as Snapshot
  if (s.v !== SNAPSHOT_VERSION) return false
  if (typeof s.at !== 'number' || !Number.isFinite(s.at)) return false
  if (!s.state || typeof s.state !== 'object') return false
  const state = s.state as { history?: unknown }
  return !state.history || typeof state.history === 'object'
}

/** Newest first, capped. Identical states do not stack up. */
export function pushSnapshot(
  existing: Snapshot[],
  snapshot: Snapshot,
  max = MAX_SNAPSHOTS,
): Snapshot[] {
  const list = (existing || []).filter(validateSnapshot)
  const newest = list[0]
  // a day's second save replaces that day's snapshot rather than evicting
  // an older one — five copies of today is not five copies
  const rest = newest && newest.date === snapshot.date ? list.slice(1) : list
  return [snapshot, ...rest].slice(0, max)
}

/**
 * The best snapshot to restore from.
 *
 * Most recent that both validates AND carries work. A valid-but-empty
 * snapshot is exactly what a bad boot would have written, so restoring it
 * over a user with history would be the bug wearing the fix's clothes.
 */
export function chooseRestore(candidates: unknown[]): Snapshot | null {
  const usable = (candidates || []).filter(validateSnapshot) as Snapshot[]
  const withWork = usable.filter((s) => s.sets > 0)
  const pool = withWork.length ? withWork : usable
  if (!pool.length) return null
  return pool.reduce((best, s) => (s.at > best.at ? s : best))
}

/** Whether live state looks like it was lost rather than never created. */
export function stateLooksEmpty(state: unknown): boolean {
  if (!state || typeof state !== 'object') return true
  const s = state as { history?: Record<string, unknown[]>; finishedDates?: unknown[] }
  const lifts = s.history ? Object.keys(s.history).length : 0
  const days = Array.isArray(s.finishedDates) ? s.finishedDates.length : 0
  return lifts === 0 && days === 0
}

export interface ExportFile {
  app: 'vitality-train'
  v: number
  exportedAt: string
  state: unknown
}

/** JSON round-trips; CSV is for reading. */
export function exportJson(state: unknown, now: number): string {
  const file: ExportFile = {
    app: 'vitality-train',
    v: SNAPSHOT_VERSION,
    exportedAt: new Date(now).toISOString(),
    state,
  }
  return JSON.stringify(file, null, 2)
}

export interface RestoreResult {
  ok: boolean
  state: unknown | null
  reason: string
}

/** Reads an exported file back, refusing anything it cannot vouch for. */
export function importJson(text: string): RestoreResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(String(text || ''))
  } catch {
    return { ok: false, state: null, reason: 'not valid JSON' }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, state: null, reason: 'not an export file' }
  }
  const file = parsed as ExportFile
  if (file.app !== 'vitality-train') {
    return { ok: false, state: null, reason: 'not a Train export' }
  }
  if (!file.state || typeof file.state !== 'object') {
    return { ok: false, state: null, reason: 'the file carries no state' }
  }
  return { ok: true, state: file.state, reason: `${countSets(file.state)} sets` }
}

/** What actually works right now, said out loud rather than assumed. */
export function storageReport(
  host: LayerStatus,
  local: LayerStatus,
  snapshots: number,
): StorageReport {
  const parts: string[] = []
  parts.push(host === 'ok' ? 'host store working' : `host store ${host}`)
  parts.push(local === 'ok' ? 'in-frame copy working' : `in-frame copy ${local}`)
  parts.push(`${snapshots} snapshot${snapshots === 1 ? '' : 's'}`)
  return { host, local, snapshots, detail: parts.join(', ') }
}
