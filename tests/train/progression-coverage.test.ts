import { describe, it, expect } from 'vitest'
import { suggestTarget, LAYOFF_DAYS } from '../../lib/train/progression'
import type { HistoryEntry } from '../../lib/train/sets'

/**
 * The module that decides every weight this app suggests, swept properly
 * for the first time.
 *
 * It had 53 surviving mutations because the harness refused to draw any
 * conclusion about it — a guard fired on the wrong side and reported a
 * broken tool instead of a kill, every run, for as long as the guard
 * existed. Everything built since sits on this code.
 *
 * These assert BEHAVIOUR. A test that pins the number 5 breaks when the
 * increment changes and proves nothing about whether a clean session at
 * the bottom of a rep range adds reps rather than load.
 */

const NOW = new Date(2026, 8, 20, 12).getTime()
const day = (back: number) => {
  const d = new Date(2026, 8, 20 - back)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const set = (w: number, r: number, over: Record<string, unknown> = {}) => ({ w, r, ...over })
const session = (back: number, w: number, r = 5, n = 3, over: Record<string, unknown> = {}): HistoryEntry =>
  ({ date: day(back), kg: w, sets: Array.from({ length: n }, () => set(w, r)), ...over })

const lift = (over: Record<string, unknown> = {}) =>
  ({ id: 'bench', kg: 185, reps: 5, sets: 3, ...over }) as never

const ask = (history: HistoryEntry[], over: Record<string, unknown> = {}) =>
  suggestTarget(history, lift(over), NOW)

/* ================================================================== *
 * Increments — what a step is worth
 * ================================================================== */

describe('the size of a step', () => {
  const clean = [session(14, 185), session(7, 185)]

  it('uses an explicit increment when the lift carries one', () => {
    /* Asserted as a relationship, not a number: the result is snapped to
       a multiple of the step, so a 10 lb increment on 185 lands on 190 or
       200 depending on the grid. What must hold is that a bigger declared
       increment moves further, and that the result sits on the grid. */
    const big = ask(clean, { incrementLb: 10 }).weight!
    const small = ask(clean, { incrementLb: 2.5 }).weight!
    expect(big).toBeGreaterThan(small)
    expect(big % 10).toBe(0)
    expect(small % 2.5).toBe(0)
  })

  it('ignores an increment that is not a number', () => {
    /* A stored value of the wrong type must not become the step. Without
       the type check it is used directly and the arithmetic produces a
       weight nobody can load. */
    const s = ask(clean, { incrementLb: '10' as unknown as number })
    expect(Number.isFinite(s.weight!)).toBe(true)
    expect(s.weight).toBeGreaterThan(185)
  })

  it('ignores an increment of zero', () => {
    /* Zero as a step divides by nothing when the result is snapped. The
       suggestion has to remain a real, loadable weight. */
    const s = ask(clean, { incrementLb: 0 })
    expect(Number.isFinite(s.weight!)).toBe(true)
    expect(s.weight).toBeGreaterThan(185)
  })

  it('steps an empty bar in plate-sized jumps, not pound-sized ones', () => {
    /* 45 lb is the boundary in the fallback grid. At exactly the bar, a
       lift still moves in 2.5 lb jumps — a 1 lb step is not loadable on
       any rack and reads as the app inventing precision. */
    const atBar = [session(14, 45), session(7, 45)]
    const s = suggestTarget(atBar, lift({ kg: 45 }), NOW)
    expect(s.weight! - 45).toBeGreaterThanOrEqual(2.5)
  })
})

describe('a lift with no load stays unloaded', () => {
  /* snapToLoadable returns the BAR when asked for anything at or below
     it, so without the zero guard a push-up is suggested at 45 lb. */
  const plates = { barLb: 45, plates: [45, 25, 10, 5, 2.5] }

  it('never suggests the bar for a bodyweight lift', () => {
    const bw = [session(14, 0, 12), session(7, 0, 12)]
    const s = suggestTarget(bw, lift({ kg: 0, loading: 'barbell', plates }), NOW)
    expect(s.weight).toBe(0)
  })

  it('calls zero bodyweight rather than "0 lb"', () => {
    const bw = [session(14, 0, 12), session(7, 0, 12)]
    const s = suggestTarget(bw, lift({ kg: 0, loading: 'barbell', plates }), NOW)
    expect(s.reason).toContain('bodyweight')
    expect(s.reason).not.toContain('0 lb')
  })

  it('still names a real weight when there is one', () => {
    /* The control: the two assertions above are the zero case, not a
       reason line that never mentions a weight. */
    expect(ask([session(14, 185), session(7, 185)]).reason).toContain('lb')
  })
})

/* ================================================================== *
 * Layoff — the climb back
 * ================================================================== */

describe('how far back a layoff drops you', () => {
  const after = (days: number) =>
    suggestTarget([session(days + 21, 200), session(days, 200)], lift({ kg: 200 }), NOW)

  it('drops further the longer the break', () => {
    /* The direction is the claim, not the exact factors. */
    const three = after(21).weight!
    const six = after(42).weight!
    const twelve = after(84).weight!
    expect(six).toBeLessThan(three)
    expect(twelve).toBeLessThan(six)
  })

  it.each([21, 42, 84])('treats exactly %i days off as that band, not the gentler one', (days) => {
    /* Each boundary is inclusive. One day short of it must be lighter
       handling, not heavier — a returning lifter meeting the harder
       ramp because their break was exactly twelve weeks is the failure. */
    expect(after(days).weight!).toBeLessThan(after(days - 1).weight!)
  })

  it('says how long the break was', () => {
    const s = after(30)
    expect(s.basis).toBe('layoff')
    expect(s.reason).toContain('30 days off')
  })
})

describe('the ramp back up', () => {
  /**
   * A break, then `back` sessions logged since.
   *
   * The sessions since the break must be RECENT: findLayoff looks at the
   * trailing gap first, so a "back" session three weeks ago is itself a
   * fresh layoff and the ramp restarts at step zero. The first version of
   * this fixture put them 20 days out and every ramp assertion read the
   * first session back.
   */
  const returning = (back: number, weights: number[]) => {
    const h = [session(60, 200), session(45, 200)]
    weights.slice(0, back).forEach((w, i) => h.push(session(back - 1 - i, w)))
    return h
  }

  it('holds the dropped weight for a second session', () => {
    const s = suggestTarget(returning(1, [170]), lift({ kg: 200 }), NOW)
    expect(s.basis).toBe('layoff')
    expect(s.reason).toContain('second session back')
  })

  it('climbs rather than repeating once the hold is done', () => {
    const first = suggestTarget(returning(1, [170]), lift({ kg: 200 }), NOW).weight!
    const third = suggestTarget(returning(2, [170, 170]), lift({ kg: 200 }), NOW).weight!
    expect(third).toBeGreaterThan(first)
  })

  it('abandons the ramp once they are back at the old weight', () => {
    /* A ramp is a plan, not a rule. Suggesting a climb back to somewhere
       they have just worked ignores the evidence in front of it —
       including when they land EXACTLY on the prior weight. */
    const s = suggestTarget(returning(1, [200]), lift({ kg: 200 }), NOW)
    expect(s.basis).not.toBe('layoff')
    expect(s.weight!).toBeGreaterThanOrEqual(200)
  })

  it('never runs off the end of the ramp', () => {
    /* Past the last step there is no entry to read, and reading one
       produces a suggestion with no weight in it at all. */
    const s = suggestTarget(returning(6, [170, 170, 185, 200, 200, 205]), lift({ kg: 200 }), NOW)
    expect(Number.isFinite(s.weight!)).toBe(true)
    expect(s.weight).toBeGreaterThan(0)
  })

  it('stops the ramp when they miss on the way back', () => {
    const h = [session(60, 200), session(45, 200), session(2, 170, 5, 3)]
    h[2].sets = [set(170, 5), set(170, 2, { fail: true })]
    const s = suggestTarget(h, lift({ kg: 200 }), NOW)
    expect(s.basis).toBe('miss')
  })

  it('forgives a miss on the very first session back', () => {
    /* Time off explains it. Only once they are climbing is a miss real
       information. */
    const h = [session(60, 200), session(45, 200)]
    h[1].sets = [set(200, 5), set(200, 1, { fail: true })]
    const s = suggestTarget(h, lift({ kg: 200 }), NOW)
    expect(s.basis).toBe('layoff')
  })

  it('does not call a short gap a layoff', () => {
    const s = suggestTarget(
      [session(LAYOFF_DAYS + 7, 200), session(LAYOFF_DAYS - 1, 200)], lift({ kg: 200 }), NOW)
    expect(s.basis).not.toBe('layoff')
  })
})

/* ================================================================== *
 * Reading the last session
 * ================================================================== */

describe('what counts as a clean session', () => {
  it('holds when the weakest set fell short of the range', () => {
    /* The LOWEST set decides. Three sets of five and one of three is not
       three sets of five. */
    const h = [session(14, 185), session(7, 185)]
    h[1].sets = [set(185, 5), set(185, 5), set(185, 3)]
    const s = ask(h, { repRange: [5, 8] })
    expect(s.basis).toBe('miss')
    expect(s.weight).toBe(185)
  })

  it('reads a set with no rep count as zero, not as passing', () => {
    /* A malformed row must not read as a clean set. */
    const h = [session(14, 185), session(7, 185)]
    h[1].sets = [set(185, 5), { w: 185 } as never]
    expect(ask(h).basis).toBe('miss')
  })

  it('advances reps before load inside a range', () => {
    /* The whole point of double progression, asserted as behaviour
       rather than as a number. */
    const h = [session(14, 185, 5), session(7, 185, 5)]
    const s = ask(h, { repRange: [5, 8] })
    expect(s.weight).toBe(185)
    expect(s.reps!).toBeGreaterThan(5)
  })

  it('adds load once the top of the range is cleared', () => {
    const h = [session(14, 185, 8), session(7, 185, 8)]
    const s = ask(h, { repRange: [5, 8] })
    expect(s.weight!).toBeGreaterThan(185)
    expect(s.reps).toBe(5)
  })

  it('treats a range whose ends are equal as a fixed target', () => {
    /* [5,5] is a range with no room in it. It must behave like a linear
       target rather than being discarded for the lift's own reps. */
    const h = [session(14, 185, 5), session(7, 185, 5)]
    const s = ask(h, { reps: 8, repRange: [5, 5] })
    expect(s.reps).toBe(5)
  })

  it('counts the sets it actually measured in the reason', () => {
    const h = [session(14, 185, 5, 3), session(7, 185, 5, 3)]
    expect(ask(h).reason).toContain('3×5')
  })
})

describe('assistance runs the other way', () => {
  /* Less help is the improvement. Reading an assisted lift as a normal
     one makes the engine ADD assistance, which is backwards. */
  const assistedHistory = [session(14, 40, 8), session(7, 40, 8)]

  it('reduces assistance on a clean session', () => {
    const s = suggestTarget(assistedHistory, lift({ kg: 40, assisted: true }), NOW)
    expect(s.weight!).toBeLessThan(40)
  })

  it('reads the flag on the lift, not only on each set', () => {
    /* The lift carries `assisted`; the individual sets here do not. */
    const s = suggestTarget(assistedHistory, lift({ kg: 40, assisted: true }), NOW)
    expect(s.weight!).toBeLessThan(40)
  })

  it('reads the flag on a set when the lift does not carry it', () => {
    const h = [session(14, 40, 8), session(7, 40, 8)]
    h.forEach((e) => { e.sets = e.sets!.map((x) => ({ ...x, assisted: true })) })
    expect(suggestTarget(h, lift({ kg: 40 }), NOW).weight!).toBeLessThan(40)
  })

  it('adds load on a lift that is not assisted at all', () => {
    /* The control. If everything were treated as assisted, every clean
       session would suggest LESS weight. */
    expect(ask([session(14, 185), session(7, 185)]).weight!).toBeGreaterThan(185)
  })

  it('never drives assistance below zero', () => {
    const h = [session(14, 2.5, 8), session(7, 2.5, 8)]
    expect(suggestTarget(h, lift({ kg: 2.5, assisted: true }), NOW).weight!).toBeGreaterThanOrEqual(0)
  })
})

describe('effort changes the size of the step', () => {
  const at = (rpe: number) => {
    const h = [session(14, 185), session(7, 185)]
    h[1].sets = h[1].sets!.map((x) => ({ ...x, rpe }))
    return ask(h)
  }

  it('holds when the last session was a grind', () => {
    /* Clean but grinding is not a green light. */
    expect(at(9).weight).toBe(185)
    expect(at(9).reason).toContain('grinding')
  })

  it('still adds weight just below the grind line', () => {
    expect(at(8.5).weight!).toBeGreaterThan(185)
  })

  it('doubles the step when the session was easy', () => {
    const easy = at(7).weight! - 185
    const ordinary = at(8).weight! - 185
    expect(easy).toBeGreaterThan(ordinary)
  })

  it('does not double it just above the easy line', () => {
    expect(at(7.5).weight! - 185).toBe(at(8).weight! - 185)
  })
})

/* ================================================================== *
 * Movements with no load
 * ================================================================== */

describe('lifts measured in something other than pounds', () => {
  /* Each SET carries its own kind — that is what setKind reads, and a
     set without one is not counted as timed work at all. */
  const timed = (secs: number[]) =>
    secs.map((s, i) => ({
      date: day((secs.length - i) * 3), kg: 0, sets: [{ s, kind: 'time' }],
    })) as unknown as HistoryEntry[]

  it('suggests seconds for a timed lift and puts them in the seconds field', () => {
    const s = suggestTarget(timed([60, 60]), lift({ kind: 'time', kg: 0 }), NOW)
    expect(s.seconds).toBeGreaterThan(60)
    expect(s.metres).toBeNull()
    expect(s.weight).toBeNull()
  })

  it('suggests metres for a distance lift and puts them in the metres field', () => {
    const h = [{ date: day(6), kg: 0, sets: [{ m: 400, kind: 'distance' }] },
      { date: day(3), kg: 0, sets: [{ m: 400, kind: 'distance' }] }] as unknown as HistoryEntry[]
    const s = suggestTarget(h, lift({ kind: 'distance', kg: 0 }), NOW)
    expect(s.metres).toBeGreaterThan(400)
    expect(s.seconds).toBeNull()
  })

  it('names the right unit in the reason', () => {
    expect(suggestTarget(timed([60, 60]), lift({ kind: 'time', kg: 0 }), NOW).reason).toContain('s ')
    const reps = [{ date: day(6), kg: 0, sets: [{ r: 12, kind: 'reps_only' }] },
      { date: day(3), kg: 0, sets: [{ r: 12, kind: 'reps_only' }] }] as unknown as HistoryEntry[]
    expect(suggestTarget(reps, lift({ kind: 'reps_only', kg: 0 }), NOW).reason).toContain('reps')
  })

  it('ignores a session with nothing logged in it', () => {
    /* An empty entry read as the last session makes the current value
       zero and the suggestion start again from the bottom. */
    const h = [...timed([60, 60]), { date: day(0), kg: 0, sets: [] } as HistoryEntry]
    expect(suggestTarget(h, lift({ kind: 'time', kg: 0 }), NOW).seconds!).toBeGreaterThan(60)
  })

  it('holds after a missed set', () => {
    /* One good set and one failed one. A session of ONLY failed sets has
       no working sets at all, so it is filtered out before this is
       reached and the session before it is read instead — which is
       correct, and means the fail branch needs a session that is
       partially completed to be exercised. */
    const h = timed([60, 60])
    h[1].sets = [{ s: 60, kind: 'time' }, { s: 20, kind: 'time', fail: true }] as never
    const s = suggestTarget(h, lift({ kind: 'time', kg: 0 }), NOW)
    expect(s.basis).toBe('miss')
  })

  it('holds when the last session went backwards', () => {
    const s = suggestTarget(timed([90, 60]), lift({ kind: 'time', kg: 0 }), NOW)
    expect(s.basis).toBe('miss')
    expect(s.seconds).toBe(60)
  })

  it('still advances when the last session merely matched the one before', () => {
    /* Equal is not a decline. Treating it as one stalls a lift that is
       holding steady. */
    const s = suggestTarget(timed([60, 60]), lift({ kind: 'time', kg: 0 }), NOW)
    expect(s.basis).toBe('clean')
  })

  it('advances from the first session when there is only one', () => {
    const s = suggestTarget(timed([60]), lift({ kind: 'time', kg: 0 }), NOW)
    expect(s.seconds!).toBeGreaterThan(60)
  })
})

/* ================================================================== *
 * The remaining paths, each reached deliberately
 * ================================================================== */

describe('a weight of zero never becomes an empty bar', () => {
  /* snapToLoadable returns the BAR for anything at or below it, so a
     result that reaches zero must be refused before it is snapped. The
     clean bodyweight branch returns earlier, so the path that actually
     reaches snapWeight with zero is assistance running out. */
  const plates = { barLb: 45, plates: [45, 25, 10, 5, 2.5] }

  it('lets assistance reach zero without landing on the bar', () => {
    const h = [session(14, 2.5, 8), session(7, 2.5, 8)]
    const s = suggestTarget(h,
      lift({ kg: 2.5, assisted: true, loading: 'barbell', plates, incrementLb: 2.5 }), NOW)
    expect(s.weight).toBe(0)
  })

  it('still snaps a real weight to the rack', () => {
    /* The control: the zero above is the guard, not a lift that never
       reaches the plate maths. */
    const h = [session(14, 135), session(7, 135)]
    const s = suggestTarget(h, lift({ kg: 135, loading: 'barbell', plates }), NOW)
    expect(s.weight! % 2.5).toBe(0)
    expect(s.weight!).toBeGreaterThan(135)
  })
})

describe('a bodyweight lift is described as bodyweight everywhere', () => {
  it('says so when holding after a miss, not "0 lb"', () => {
    /* The clean branch has its own wording; this is the miss branch,
       which builds the sentence from the weight itself. */
    const h = [session(14, 0, 12), session(7, 0, 12)]
    h[1].sets = [set(0, 12), set(0, 3, { fail: true })]
    const s = suggestTarget(h, lift({ kg: 0 }), NOW)
    expect(s.basis).toBe('miss')
    expect(s.reason).toContain('bodyweight')
    expect(s.reason).not.toContain('0 lb')
  })
})

describe('the ramp takes as few sessions as it needs', () => {
  /* A drop small enough that the halfway point snaps back onto it would
     otherwise put the same weight in the plan twice, and a returning
     lifter spends an extra session going nowhere. */
  const from = (prior: number, gapDays: number, increment: number, back: number[]) => {
    const h = [session(gapDays + 30, prior), session(gapDays, prior)]
    back.forEach((w, i) => h.push(session(back.length - 1 - i, w)))
    return suggestTarget(h, lift({ kg: prior, incrementLb: increment }), NOW)
  }

  it('reaches the old weight without an extra hold', () => {
    /* 105 dropped by a fifteenth lands on 100; halfway back from there
       rounds to 100 again. The plan must be drop, hold, return — three
       sessions, not four. */
    expect(from(105, 21, 10, [100, 100]).weight).toBe(105)
  })

  it('collapses to a single step when the drop snaps back to where it was', () => {
    /* 30 lb cut by fifteen percent is 25.5, which on a 10 lb increment
       rounds straight back to 30 — the whole ramp is one entry. One
       session back, then ordinary progression, not a second identical
       session labelled "holding". */
    const first = from(30, 21, 10, [])
    expect(first.basis).toBe('layoff')
    /* The second session must come back BELOW the plan, or the
       already-back rule abandons the ramp first and the collapse is
       never the thing being tested. */
    const second = from(30, 21, 10, [25])
    expect(second.basis).not.toBe('layoff')
    expect(second.reason).not.toContain('second session back')
  })

  it('never reads past the end of the ramp', () => {
    /* Four sessions back on a four-step ramp, none of them yet at the old
       weight — so the ramp is spent but the break is not "history" by the
       already-back rule either. There is no entry at that index, and
       reading one produces a suggestion carrying no weight at all. */
    const s = from(105, 21, 10, [90, 90, 100])
    expect(s.basis).not.toBe('layoff')
    expect(Number.isFinite(s.weight!)).toBe(true)
    expect(s.weight!).toBeGreaterThanOrEqual(100)
  })
})

describe('an all-out set is not evidence about the rep range', () => {
  /* rangeSets excludes AMRAPs by construction: they overshoot by design
     and undershoot when the lifter is cooked, and both would read as
     statements about the range. */
  const withAmrap = () => {
    const h = [session(14, 185, 5, 3), session(7, 185, 5, 3)]
    h[1].sets = [set(185, 5), set(185, 5), set(185, 12, { amrap: true })]
    return h
  }

  it('counts only the measured sets in the reason', () => {
    /* Three sets were done; two of them say anything about the range. */
    expect(ask(withAmrap(), { repRange: [5, 8] }).reason).toContain('2×5')
  })

  it('still reads a session whose every set was all-out', () => {
    /* With nothing ranged to measure, the working sets are the fallback —
       and reading them as zero reps turns every such session into a miss. */
    const h = [session(14, 185, 5, 3), session(7, 185, 5, 1)]
    h[1].sets = [set(185, 8, { amrap: true })]
    expect(ask(h, { repRange: [5, 8] }).basis).not.toBe('miss')
  })
})

describe('a session with no work in it is not a session', () => {
  /* entryKind reads the first WORKING set, so an entry with none reports
     the default kind and a declared-kind lift filters it out before this
     matters. It survives only when the lift declares no kind and the kind
     is inferred from the last entry — and then it sits in the middle of
     the list, where it does not change which session is last but does
     change which one is BEFORE last. */
  const warmupOnly = { date: day(6), kg: 0, sets: [{ s: 20, kind: 'time', warmup: true }] }

  it('does not hide a decline behind a warm-up-only day', () => {
    const h = [
      { date: day(9), kg: 0, sets: [{ s: 90, kind: 'time' }] },
      warmupOnly,
      { date: day(3), kg: 0, sets: [{ s: 60, kind: 'time' }] },
    ] as unknown as HistoryEntry[]
    const s = suggestTarget(h, lift({ kg: 0 }), NOW)
    expect(s.basis).toBe('miss')
    expect(s.seconds).toBe(60)
  })

  it('still advances when the real sessions are climbing', () => {
    /* The control: the miss above is the decline, not a warm-up entry
       that makes everything read as a miss. */
    const h = [
      { date: day(9), kg: 0, sets: [{ s: 60, kind: 'time' }] },
      warmupOnly,
      { date: day(3), kg: 0, sets: [{ s: 90, kind: 'time' }] },
    ] as unknown as HistoryEntry[]
    expect(suggestTarget(h, lift({ kg: 0 }), NOW).basis).toBe('clean')
  })
})
