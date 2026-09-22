import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { validateMetric, validatePublish, isReadableSlot, MAX_METRICS_PER_PUBLISH } from '../../lib/tiles/metricsContract'

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

  it('decides readable slots through the shared rule', () => {
    /* The host must not carry its own copy of the list, or the rule and
       the enforcement drift apart silently. */
    const host = readFileSync('lib/tiles/useTileHost.ts', 'utf8')
    expect(host).toContain('isReadableSlot(slot)')
    expect(host).not.toContain("const READABLE =")
  })
})

/**
 * The door that was open.
 *
 * `read('train')` returned Train's entire saved store — exercise names,
 * session notes, progress photos — to any tile that asked, and nothing
 * in the host or in any of the nine tiles ever asked. The most sensitive
 * data in the app was the most freely available, for no consumer at all.
 *
 * Now it publishes what it means to share and nothing else.
 */
describe('a tile publishes what it means to share', () => {
  it('refuses a whole-store read of train', () => {
    expect(isReadableSlot('train')).toBe(false)
  })

  it('still serves train\'s published metrics', () => {
    /* The control the negative needs: a bridge that refused everything
       would pass the assertion above and break the feature. */
    expect(isReadableSlot('train:metrics')).toBe(true)
  })

  it('keeps the one whole-store read that has a consumer', () => {
    /* peak.html and train.html both read `vitals` for a recovery
       signal. Narrowing it is a change to that tile, not this one. */
    expect(isReadableSlot('vitals')).toBe(true)
  })

  it('offers a metrics slot for every tile, published or not', () => {
    for (const tile of ['train', 'fuel', 'vitals', 'brand', 'peak', 'finance']) {
      expect(isReadableSlot(`${tile}:metrics`), tile).toBe(true)
    }
  })

  it('refuses a slot nobody named', () => {
    for (const slot of ['', 'vee', 'reading', 'train:state', 'train:', ':metrics', '../train']) {
      expect(isReadableSlot(slot), slot).toBe(false)
    }
  })

  it('refuses a metrics slot for a tile that is not on the board', () => {
    expect(isReadableSlot('mystery:metrics')).toBe(false)
  })
})

describe('nothing was reading the door that closed', () => {
  const tiles = readdirSync('public/tiles').filter((f) => f.endsWith('.html'))

  it('finds the tiles to check', () => {
    expect(tiles.length).toBeGreaterThan(5)
  })

  it('has no consumer of a whole-store train read anywhere', () => {
    /* Asserted rather than audited: this is the claim the removal rests
       on, and it is the kind that rots the moment somebody adds a tile. */
    const callers: string[] = []
    for (const f of tiles) {
      const text = readFileSync(`public/tiles/${f}`, 'utf8')
      for (const m of text.matchAll(/\.read\(\s*'([^']+)'\s*\)/g)) {
        if (m[1] === 'train') callers.push(`${f}: read('train')`)
      }
    }
    expect(callers, `move these onto train:metrics:\n${callers.join('\n')}`).toEqual([])
  })

  it('catches such a read when there is one', () => {
    /* The regex, exercised — one that matched nothing would pass the
       assertion above forever. */
    const sample = `const v = await BRIDGE.read('vitals'); const t = await window.Vitality.read('train');`
    const found = [...sample.matchAll(/\.read\(\s*'([^']+)'\s*\)/g)].map((m) => m[1])
    expect(found).toEqual(['vitals', 'train'])
  })
})
