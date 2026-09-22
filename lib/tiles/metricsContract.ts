/**
 * The tile-to-tile metrics contract.
 *
 * Vitality's premise is that the tiles read each other. `read(slot)` has
 * always been the way IN, and until now there was no disciplined way OUT:
 * a tile either published nothing, or a consumer read its entire private
 * state and helped itself.
 *
 * This is the narrow waist for the way out. A tile publishes typed daily
 * metrics; a consumer reads them and formats for its own surface.
 *
 * Two rules the shape enforces rather than documents:
 *
 * PROVENANCE IS NOT OPTIONAL. A logged number, a number computed from
 * logged numbers, and a number resting on a guess are three different
 * things, and a consumer that cannot tell them apart will render a guess
 * as a measurement. Every value says which it is.
 *
 * VALUES, NEVER PROSE. A sentence would be the publisher deciding how
 * somebody else's surface reads, and the first publisher's phrasing
 * would quietly become the house style.
 *
 * Validated here because the payload crosses an iframe boundary from a
 * sealed tile, which is an untrusted sender by construction. Never
 * throws; a bad metric is dropped and named.
 */

export const PROVENANCE = ['measured', 'derived', 'estimated'] as const
export type Provenance = (typeof PROVENANCE)[number]

export interface PublishedMetric {
  /** Stable and machine-readable — a key, never a label. */
  key: string
  /** Null where the metric is purely categorical. */
  value: number | null
  /** The categorical value, where a number cannot carry it. */
  state?: string
  /** Null for a ratio or a unitless count. */
  unit: string | null
  /** Local YYYY-MM-DD. */
  date: string
  provenance: Provenance
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
/** Keys are identifiers: letters, digits, underscore, and dots for nesting. */
const KEY_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/
/** A state is an enum member, not a sentence. */
const STATE_RE = /^[a-z][a-z0-9_]*$/

export type MetricResult =
  | { ok: true; metric: PublishedMetric }
  | { ok: false; error: string }

export function validateMetric(input: unknown): MetricResult {
  if (typeof input !== 'object' || input === null) return { ok: false, error: 'not an object' }
  const o = input as Record<string, unknown>

  if (typeof o.key !== 'string' || !KEY_RE.test(o.key)) {
    return { ok: false, error: 'key must be a lowercase identifier, optionally dotted' }
  }
  if (o.key.length > 64) return { ok: false, error: 'key must be 64 characters or fewer' }

  if (o.value !== null && (typeof o.value !== 'number' || !Number.isFinite(o.value))) {
    return { ok: false, error: 'value must be a finite number or null' }
  }
  if (typeof o.value === 'number' && Math.abs(o.value) > 1e9) {
    return { ok: false, error: 'value is out of range' }
  }
  if (o.value === null && o.state === undefined) {
    /* A metric with neither a number nor a category says nothing at all,
       and a consumer would render an empty row for it. */
    return { ok: false, error: 'a metric with no value must carry a state' }
  }
  if (o.state !== undefined && (typeof o.state !== 'string' || !STATE_RE.test(o.state))) {
    return { ok: false, error: 'state must be a lowercase identifier' }
  }
  if (o.unit !== null && (typeof o.unit !== 'string' || o.unit.length > 16)) {
    return { ok: false, error: 'unit must be a short string or null' }
  }
  if (typeof o.date !== 'string' || !DATE_RE.test(o.date)) {
    return { ok: false, error: 'date must be YYYY-MM-DD' }
  }
  if (typeof o.provenance !== 'string' || !(PROVENANCE as readonly string[]).includes(o.provenance)) {
    return { ok: false, error: 'provenance must be measured, derived or estimated' }
  }

  return {
    ok: true,
    metric: {
      key: o.key,
      value: o.value as number | null,
      ...(o.state !== undefined ? { state: o.state as string } : {}),
      unit: o.unit as string | null,
      date: o.date,
      provenance: o.provenance as Provenance,
    },
  }
}

/** The most a tile may publish for one day. A guard against a loop. */
export const MAX_METRICS_PER_PUBLISH = 64

export interface PublishResult {
  metrics: PublishedMetric[]
  /** Why each rejected entry was dropped, for a diagnosable log. */
  rejected: string[]
}

/** Validate a whole payload, keeping what is sound and naming what is not. */
export function validatePublish(input: unknown): PublishResult {
  if (!Array.isArray(input)) return { metrics: [], rejected: ['payload is not an array'] }
  const metrics: PublishedMetric[] = []
  const rejected: string[] = []
  for (const entry of input.slice(0, MAX_METRICS_PER_PUBLISH)) {
    const r = validateMetric(entry)
    if (r.ok) metrics.push(r.metric)
    else rejected.push(r.error)
  }
  if (input.length > MAX_METRICS_PER_PUBLISH) {
    rejected.push(`payload truncated at ${MAX_METRICS_PER_PUBLISH}`)
  }
  return { metrics, rejected }
}
