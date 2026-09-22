import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { validateMetric, validatePublish, MAX_METRICS_PER_PUBLISH } from '../../lib/tiles/metricsContract'

/**
 * The metrics payload crosses an iframe boundary from a sealed tile,
 * which makes it an untrusted sender by construction — not because the
 * tile is hostile, but because a tile with a bug must not be able to
 * write nonsense into a store other tiles read as fact.
 */

const ok = { key: 'hard_sets', value: 12, unit: 'sets', date: '2026-09-19', provenance: 'measured' }

describe('a metric the host will accept', () => {
  it('takes a well-formed one', () => {
    expect(validateMetric(ok).ok).toBe(true)
  })

  it('takes a categorical one with no number', () => {
    expect(validateMetric({ key: 'trained', value: null, state: 'rest', unit: null, date: '2026-09-19', provenance: 'measured' }).ok).toBe(true)
  })

  it('takes a dotted key', () => {
    expect(validateMetric({ ...ok, key: 'hard_sets.rear_delts' }).ok).toBe(true)
  })
})

describe('a metric the host refuses', () => {
  const bad = (over: Record<string, unknown>) => validateMetric({ ...ok, ...over })

  it('refuses a key that is really a label', () => {
    expect(bad({ key: 'Hard Sets' }).ok).toBe(false)
    expect(bad({ key: '' }).ok).toBe(false)
  })

  it('refuses prose in a state', () => {
    /* A state is an enum member. A sentence here would be the publisher
       deciding how somebody else's surface reads. */
    expect(bad({ value: null, state: 'you trained hard today' }).ok).toBe(false)
  })

  it('refuses a metric that says nothing at all', () => {
    expect(bad({ value: null }).ok).toBe(false)
  })

  it('refuses a value that is not finite', () => {
    expect(bad({ value: Number.NaN }).ok).toBe(false)
    expect(bad({ value: Number.POSITIVE_INFINITY }).ok).toBe(false)
  })

  it('refuses a date that is not a local day', () => {
    expect(bad({ date: '2026-09-19T12:00:00Z' }).ok).toBe(false)
    expect(bad({ date: 'today' }).ok).toBe(false)
  })

  it('refuses a missing or invented provenance', () => {
    expect(bad({ provenance: undefined }).ok).toBe(false)
    expect(bad({ provenance: 'probably' }).ok).toBe(false)
  })

  it('refuses something that is not an object', () => {
    for (const v of [null, 7, 'hard_sets', []]) expect(validateMetric(v).ok).toBe(false)
  })
})

describe('a whole payload', () => {
  it('keeps the sound metrics and names the rest', () => {
    const { metrics, rejected } = validatePublish([ok, { ...ok, provenance: 'vibes' }, ok])
    expect(metrics).toHaveLength(2)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]).toMatch(/provenance/)
  })

  it('refuses a payload that is not a list', () => {
    expect(validatePublish({ key: 'hard_sets' }).metrics).toEqual([])
    expect(validatePublish(null).rejected[0]).toMatch(/not an array/)
  })

  it('truncates a runaway payload and says so', () => {
    /* A publish in a loop must cost one capped write, not the store. */
    const many = Array.from({ length: MAX_METRICS_PER_PUBLISH + 5 }, () => ok)
    const { metrics, rejected } = validatePublish(many)
    expect(metrics).toHaveLength(MAX_METRICS_PER_PUBLISH)
    expect(rejected.some((r) => /truncated/.test(r))).toBe(true)
  })

  it('drops nothing from a clean payload', () => {
    /* The control: a validator that rejected everything would satisfy
       most of the assertions above. */
    const { metrics, rejected } = validatePublish([ok, ok, ok])
    expect(metrics).toHaveLength(3)
    expect(rejected).toEqual([])
  })
})

describe('the host wires the channel it validates', () => {

  it('exposes publish on the bridge', () => {
    const bridge = readFileSync('lib/tiles/tileBridge.ts', 'utf8')
    expect(bridge).toContain("publish: function (metrics)")
    expect(bridge).toContain("type: 'publish'")
  })

  it('validates the payload host-side rather than trusting it', () => {
    const host = readFileSync('lib/tiles/useTileHost.ts', 'utf8')
    expect(host).toContain("msg.type === 'publish'")
    expect(host).toContain('validatePublish(msg.metrics)')
  })

  it('writes under the SENDER id, never the iframe claim', () => {
    /* A tile must only ever be able to publish as itself. */
    const host = readFileSync('lib/tiles/useTileHost.ts', 'utf8')
    expect(host).toContain('`${tileId}:metrics`')
    expect(host).not.toContain('msg.tileId')
  })

  it('makes the published slot readable by other tiles', () => {
    const host = readFileSync('lib/tiles/useTileHost.ts', 'utf8')
    expect(host).toContain("'train:metrics'")
  })
})
