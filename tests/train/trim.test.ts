import { describe, it, expect } from 'vitest'
import { trimSession, DEFAULT_SECONDS_PER_SET, type TrimContext } from '../../lib/train/trim'

/**
 * Shortening a session that already exists.
 *
 * The coach honours a time budget when it GENERATES, which helps nobody
 * who is already standing in the gym with forty minutes and a session
 * built for ninety. Being short on time is one of the most common reasons
 * a session is skipped entirely rather than shortened, and skipping it
 * entirely is the worse outcome by a distance.
 *
 * A PROPOSAL, NEVER A MUTATION. Nothing here touches the session. It
 * returns what it would do and why; accepting is the athlete's.
 */

const ex = (id: string, over: Record<string, unknown> = {}) => ({
  id, name: id, tier: 2, sets: 4, reps: 8, rest: 90, kg: 100,
  log: [null, null, null, null], muscles: ['chest'], ...over,
})

const ctx = (over: Partial<TrimContext> = {}): TrimContext => ({
  exercises: [], minutes: 30, history: {}, deloadStates: {},
  underBandMuscles: [], staleMuscles: [], now: Date.now(), ...over,
})

describe('a sixty-minute session trimmed to thirty', () => {
  const session = [
    ex('squat', { tier: 1, muscles: ['quads'] }),
    ex('bench', { tier: 1, muscles: ['chest'] }),
    ex('row', { tier: 2, muscles: ['lats'] }),
    ex('curl', { tier: 3, muscles: ['biceps'] }),
    ex('lateral', { tier: 3, muscles: ['side_delts'] }),
    ex('calf', { tier: 3, muscles: ['calves'] }),
  ]

  it('comes in under the budget', () => {
    const plan = trimSession(ctx({ exercises: session, minutes: 30 }))
    expect(plan.estimatedMinutes).toBeLessThanOrEqual(30)
    expect(plan.before).toBeGreaterThan(30)
  })

  it('keeps the compounds', () => {
    const plan = trimSession(ctx({ exercises: session, minutes: 30 }))
    expect(plan.keep.map((k) => k.id)).toEqual(expect.arrayContaining(['squat', 'bench']))
  })

  it('drops accessories before anything else', () => {
    const plan = trimSession(ctx({ exercises: session, minutes: 30 }))
    const dropped = plan.drop.map((d) => d.id)
    expect(dropped.length).toBeGreaterThan(0)
    for (const id of dropped) {
      expect(['curl', 'lateral', 'calf'], `dropped ${id}`).toContain(id)
    }
  })

  it('says why each lift went', () => {
    const plan = trimSession(ctx({ exercises: session, minutes: 30 }))
    for (const d of [...plan.drop, ...plan.reduce]) {
      expect(d.reason.length).toBeGreaterThan(0)
    }
  })

  it('reduces sets rather than dropping, when that is enough', () => {
    const plan = trimSession(ctx({ exercises: session.slice(0, 3), minutes: 20 }))
    expect(plan.reduce.length).toBeGreaterThan(0)
    for (const r of plan.reduce) expect(r.sets).toBeLessThan(4)
  })

  it('proposes nothing when the session already fits', () => {
    const plan = trimSession(ctx({ exercises: session.slice(0, 2), minutes: 90 }))
    /* The control: the same two lifts against a tight budget DO produce
       cuts. Without it, an empty drop list would look identical to a
       trimSession that silently received no exercises at all. */
    const tight = trimSession(ctx({ exercises: session.slice(0, 2), minutes: 5 }))
    expect(tight.reduce.length + tight.drop.length).toBeGreaterThan(0)

    expect(plan.drop).toEqual([])
    expect(plan.reduce).toEqual([])
    expect(plan.keep.length).toBe(2)
  })
})

describe('it prefers not to cut a muscle that needs the work', () => {
  const session = [
    ex('curl', { tier: 3, muscles: ['biceps'] }),
    ex('lateral', { tier: 3, muscles: ['side_delts'] }),
  ]

  it('cuts the other accessory when one muscle is under its band', () => {
    const plan = trimSession(ctx({
      exercises: session, minutes: 8, underBandMuscles: ['biceps'],
    }))
    expect(plan.drop.map((d) => d.id)).toContain('lateral')
    expect(plan.drop.map((d) => d.id)).not.toContain('curl')
  })

  it('does the same for a muscle that has not been trained lately', () => {
    /* Protecting `curl` is the case that discriminates: curl sorts FIRST
       by id, so with staleness counting for nothing the tiebreak cuts it
       — and asserting that lateral goes instead can only pass if the
       stale bonus actually moved the order. Protecting lateral would
       have agreed with the tiebreak and proved nothing. */
    const plan = trimSession(ctx({
      exercises: session, minutes: 8, staleMuscles: ['biceps'],
    }))
    expect(plan.drop.map((d) => d.id)).toContain('lateral')
    expect(plan.drop.map((d) => d.id)).not.toContain('curl')
  })

  it('says that was the reason it survived', () => {
    const plan = trimSession(ctx({
      exercises: session, minutes: 8, underBandMuscles: ['biceps'],
    }))
    /* Surviving includes being reduced — trimmed to three sets is still
       not dropped, and the reason has to travel with it either way. */
    const survived = [...plan.keep, ...plan.reduce].find((k) => k.id === 'curl')!
    expect(survived, 'curl was dropped').toBeTruthy()
    expect(survived.reason).toMatch(/under|band/i)
  })
})

describe('a lift mid-deload is never dropped quietly', () => {
  const deloading = {
    squat: {
      state: 'deloading' as const, kind: 'intensity' as const,
      confidence: 'measured' as const, priorWeight: 300,
      since: '2026-09-01', plateauLength: 3, sessions: 0,
    },
  }
  const session = [
    ex('squat', { tier: 3, muscles: ['quads'] }),
    ex('curl', { tier: 3, muscles: ['biceps'] }),
    ex('lateral', { tier: 3, muscles: ['side_delts'] }),
  ]

  it('prefers to cut something else', () => {
    const plan = trimSession(ctx({ exercises: session, minutes: 10, deloadStates: deloading }))
    expect(plan.drop.map((d) => d.id)).not.toContain('squat')
  })

  it('warns when it has to drop one anyway', () => {
    const plan = trimSession(ctx({
      exercises: [ex('squat', { tier: 3 })], minutes: 1, deloadStates: deloading,
    }))
    if (plan.drop.some((d) => d.id === 'squat')) {
      expect(plan.warnings.join(' ')).toMatch(/deload/i)
    } else {
      expect(plan.keep.map((k) => k.id)).toContain('squat')
    }
  })

  it('warns the same way for a lift mid-reapproach', () => {
    const reapproach = {
      squat: { ...deloading.squat, state: 'reapproach' as const },
    }
    const plan = trimSession(ctx({
      exercises: [ex('squat', { tier: 3 })], minutes: 1, deloadStates: reapproach,
    }))
    expect(
      plan.warnings.join(' ').match(/reapproach|deload/i) !== null ||
      plan.keep.some((k) => k.id === 'squat'),
    ).toBe(true)
  })
})

describe('nothing logged is ever removed', () => {
  const partly = [
    ex('squat', { tier: 1, log: [{ kg: 300, reps: 5 }, { kg: 300, reps: 5 }, null, null] }),
    ex('curl', { tier: 3, log: [{ kg: 30, reps: 10 }, null, null, null] }),
    ex('lateral', { tier: 3 }),
  ]

  it('never drops a lift with a logged set', () => {
    const plan = trimSession(ctx({ exercises: partly, minutes: 5 }))
    expect(plan.drop.map((d) => d.id)).not.toContain('squat')
    expect(plan.drop.map((d) => d.id)).not.toContain('curl')
  })

  it('never reduces a lift below what is already logged', () => {
    const plan = trimSession(ctx({ exercises: partly, minutes: 5 }))
    for (const r of plan.reduce) {
      const source = partly.find((p) => p.id === r.id)!
      const logged = source.log.filter(Boolean).length
      expect(r.sets, `${r.id} below its ${logged} logged sets`).toBeGreaterThanOrEqual(logged)
    }
  })

  it('reduces a part-logged lift LAST, after everything else has given', () => {
    /* The explicit logged-set checks stop it being dropped. This is the
       other half — that being part-logged also puts it at the back of
       the queue for losing sets, which nothing else asserts. */
    const session = [
      ex('aaa', { tier: 2, log: [{ kg: 100, reps: 8 }, null, null, null] }),
      ex('bbb', { tier: 2 }),
    ]
    const plan = trimSession(ctx({ exercises: session, minutes: 14 }))
    const partLogged = [...plan.keep, ...plan.reduce].find((x) => x.id === 'aaa')!
    const untouched = [...plan.keep, ...plan.reduce].find((x) => x.id === 'bbb')!
    expect(partLogged.sets).toBeGreaterThan(untouched.sets)
  })

  it('drops the untouched lift instead', () => {
    const plan = trimSession(ctx({ exercises: partly, minutes: 5 }))
    expect(plan.drop.map((d) => d.id)).toContain('lateral')
  })
})

describe('the duration estimate says where it came from', () => {
  const session = [ex('squat'), ex('bench')]

  it('uses a declared default with no timing data', () => {
    const plan = trimSession(ctx({ exercises: session, minutes: 30 }))
    expect(plan.basis).toBe('default')
    expect(plan.secondsPerSet).toBe(DEFAULT_SECONDS_PER_SET)
  })

  it('uses observed timings when the history has them', () => {
    const start = new Date('2026-09-12T18:00:00').getTime()
    const history = {
      squat: [{
        date: '2026-09-12', kg: 300,
        sets: [
          { w: 300, r: 5, at: start },
          { w: 300, r: 5, at: start + 200_000 },
          { w: 300, r: 5, at: start + 400_000 },
        ],
      }],
    }
    const plan = trimSession(ctx({ exercises: session, minutes: 30, history }))
    expect(plan.basis).toBe('observed')
    expect(plan.secondsPerSet).toBeGreaterThan(0)
  })

  it('refuses imported timings and falls back cleanly', () => {
    const start = new Date('2026-09-12T18:00:00').getTime()
    const history = {
      squat: [{
        date: '2026-09-12', kg: 300,
        sets: [
          { w: 300, r: 5, at: start, atEstimated: true },
          { w: 300, r: 5, at: start + 200_000, atEstimated: true },
        ],
      }],
    }
    const plan = trimSession(ctx({ exercises: session, minutes: 30, history }))
    expect(plan.basis).toBe('default')
  })
})

describe('it is a proposal, not a mutation', () => {
  it('leaves the session it was handed untouched', () => {
    const session = [ex('squat', { tier: 1 }), ex('curl', { tier: 3 })]
    const before = JSON.stringify(session)
    trimSession(ctx({ exercises: session, minutes: 5 }))
    expect(JSON.stringify(session)).toBe(before)
  })

  it('returns every lift in exactly one bucket', () => {
    const session = [ex('a', { tier: 1 }), ex('b', { tier: 2 }), ex('c', { tier: 3 }), ex('d', { tier: 3 })]
    const plan = trimSession(ctx({ exercises: session, minutes: 12 }))
    const seen = [...plan.keep, ...plan.reduce, ...plan.drop].map((x) => x.id).sort()
    expect(seen).toEqual(['a', 'b', 'c', 'd'])
  })

  it('is deterministic', () => {
    const session = [ex('a', { tier: 1 }), ex('b', { tier: 3 }), ex('c', { tier: 3 })]
    const c = ctx({ exercises: session, minutes: 12 })
    expect(trimSession(c)).toEqual(trimSession(c))
  })

  it('says nothing useful for a budget of nothing, rather than throwing', () => {
    for (const bad of [0, -5, NaN, null, undefined]) {
      const plan = trimSession(ctx({ exercises: [ex('a')], minutes: bad as never }))
      expect(plan).toBeTruthy()
      expect(plan.keep.length + plan.drop.length + plan.reduce.length).toBe(1)
    }
  })
})
