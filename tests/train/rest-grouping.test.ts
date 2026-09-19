import { describe, it, expect } from 'vitest'
import { restTrend, medianRest } from '../../lib/train/timing'
import { detectPlateau, plateauAdvice } from '../../lib/train/deload'

/**
 * Rest compression must not fire on a change of structure.
 *
 * A superset's rest between two sets of A contains a set of B, so the
 * measured gap is roughly double. That means switching FROM supersets TO
 * straight sets makes median rest collapse — which is precisely the
 * fingerprint of rest compression, on somebody who changed nothing about
 * how hard they are resting.
 *
 * It is the dangerous direction because it is a CONFIDENT finding about a
 * person who did nothing wrong, and it fires exactly when they have made
 * a deliberate programming change and are most likely to be paying
 * attention.
 *
 * So the trend compares like to like, and refuses to read across a
 * structural change at all.
 */

const day = (back: number) => {
  const d = new Date(2026, 8, 19 - back)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** A session at `gap` seconds between sets, optionally in a superset. */
const session = (back: number, gap: number, group?: string) => {
  const start = new Date(`${day(back)}T18:00:00`).getTime()
  return {
    date: day(back), kg: 200,
    ...(group ? { group } : {}),
    sets: [0, 1, 2].map((i) => ({ w: 200, r: 5, at: start + i * gap * 1000 })),
  }
}

describe('the fixtures really do differ', () => {
  it('a superset reads roughly double the gap', () => {
    expect(medianRest(session(0, 180, 'A'))).toBe(180)
    expect(medianRest(session(0, 90))).toBe(90)
  })
})

describe('switching from supersets to straight sets is not compression', () => {
  /* Four weeks supersetted at 180s, then three weeks straight at 90s.
     Median rest halves, and nothing about the athlete's resting changed. */
  const switched = [
    session(42, 180, 'A'), session(35, 180, 'A'), session(28, 180, 'A'),
    session(21, 90), session(14, 90), session(7, 90), session(0, 90),
  ]

  it('reports the grouping change rather than a collapse', () => {
    const trend = restTrend(switched)!
    expect(trend).toBeTruthy()
    expect(trend.groupingChanged).toBe(true)
    expect(trend.compressing).toBe(false)
  })

  it('produces no rest-compression plateau cause', () => {
    const plateau = detectPlateau(switched, {})
    expect(plateau).toBeTruthy()
    expect(plateau!.cause).not.toBe('rest_compression')
    expect(plateau!.restCompressing).toBe(false)
  })

  it('does not advise resting longer', () => {
    expect(plateauAdvice(detectPlateau(switched, {})!)).not.toMatch(/rest longer/i)
  })
})

describe('the reverse direction is not compression either', () => {
  const adopted = [
    session(42, 90), session(35, 90), session(28, 90),
    session(21, 180, 'A'), session(14, 180, 'A'), session(7, 180, 'A'), session(0, 180, 'A'),
  ]

  it('says the grouping changed rather than reading rest going up', () => {
    const trend = restTrend(adopted)!
    expect(trend.groupingChanged).toBe(true)
    expect(trend.compressing).toBe(false)
  })
})

describe('a real compression within consistent grouping still fires', () => {
  const rushedStraight = [180, 160, 130, 100, 75, 60, 55].map((gap, i) =>
    session(42 - i * 7, gap))

  it('reports it when nothing was ever grouped', () => {
    const trend = restTrend(rushedStraight)!
    expect(trend.groupingChanged).toBe(false)
    expect(trend.compressing).toBe(true)
  })

  it('reaches the plateau diagnosis', () => {
    const plateau = detectPlateau(rushedStraight, {})!
    expect(plateau.cause).toBe('rest_compression')
    expect(plateauAdvice(plateau)).toMatch(/rest/i)
  })

  it('fires the same way inside a consistent superset', () => {
    /* Grouped throughout, and still rushing it — the gap shrinks from
       300s to 120s without the structure changing at all. */
    const rushedSuperset = [300, 260, 220, 180, 150, 130, 120].map((gap, i) =>
      session(42 - i * 7, gap, 'A'))
    const trend = restTrend(rushedSuperset)!
    expect(trend.groupingChanged).toBe(false)
    expect(trend.compressing).toBe(true)
    expect(detectPlateau(rushedSuperset, {})!.cause).toBe('rest_compression')
  })
})

describe('the group LETTER is not the structure', () => {
  /* Letters come from whichever is free when the pair is made, so a
     lifter who rebuilds the same superset next week may get B instead of
     A. That is the same structure and the same rest cost, and treating
     it as a change would silence a real finding for no reason. */
  const relabelled = [300, 260, 220, 180, 150, 130, 120].map((gap, i) =>
    session(42 - i * 7, gap, i < 3 ? 'A' : 'B'))

  it('does not call a relabel a structural change', () => {
    expect(restTrend(relabelled)!.groupingChanged).toBe(false)
  })

  it('so a real compression inside it still fires', () => {
    expect(restTrend(relabelled)!.compressing).toBe(true)
    expect(detectPlateau(relabelled, {})!.cause).toBe('rest_compression')
  })

  it('while moving OUT of the superset still counts', () => {
    // control: the same run, ending ungrouped, is a change
    const leaves = relabelled.map((e, i) =>
      i < 5 ? e : { ...e, group: undefined })
    expect(restTrend(leaves)!.groupingChanged).toBe(true)
  })
})

describe('sessions with no grouping recorded at all', () => {
  /* Every row logged before grouping was captured has no `group` field.
     Absent must read as "not grouped", not as "changed". */
  const legacy = [180, 160, 130, 100, 75, 60, 55].map((gap, i) => {
    const s = session(42 - i * 7, gap)
    return s
  })

  it('treats absence as ungrouped rather than as a change', () => {
    const trend = restTrend(legacy)!
    expect(trend.groupingChanged).toBe(false)
    expect(trend.compressing).toBe(true)
  })

  it('does not flag a change when only SOME rows predate the capture', () => {
    /* Older rows have no field; newer rows say ungrouped explicitly.
       Nothing about the training changed. */
    const mixed = legacy.map((e, i) => (i < 3 ? e : { ...e, group: undefined }))
    expect(restTrend(mixed)!.groupingChanged).toBe(false)
  })
})

describe('the confound is named where it matters', () => {
  const switched = [
    session(42, 180, 'A'), session(35, 180, 'A'), session(28, 180, 'A'),
    session(21, 90), session(14, 90), session(7, 90), session(0, 90),
  ]

  it('carries the grouping change on the trend for a caller to report', () => {
    const trend = restTrend(switched)!
    expect(trend.groupingChanged).toBe(true)
    expect(trend.from).toBeGreaterThan(trend.to)
  })

  it('still stays silent rather than reporting a softened version', () => {
    /* Reporting "rest fell, but you changed structure" is worse than
       nothing: it is still a finding about rest, and the reader takes the
       headline. */
    expect(detectPlateau(switched, {})!.cause).not.toBe('rest_compression')
  })
})
