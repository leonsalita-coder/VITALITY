import { describe, it, expect } from 'vitest'
import { parseCsv, detectSource, importCsv, LB_PER_KG } from '../../lib/train/import'

/** A real-shaped Hevy export: kilograms, warm-up rows, a timed hold. */
const HEVY = [
  'title,start_time,end_time,exercise_title,set_index,set_type,weight_kg,reps,distance_km,duration_seconds,rpe',
  'Push Day,2026-09-14 18:02:00,2026-09-14 19:10:00,Bench Press,0,warmup,40,10,,,',
  'Push Day,2026-09-14 18:02:00,2026-09-14 19:10:00,Bench Press,1,normal,84,5,,,8',
  'Push Day,2026-09-14 18:02:00,2026-09-14 19:10:00,Bench Press,2,normal,84,5,,,8.5',
  'Push Day,2026-09-14 18:02:00,2026-09-14 19:10:00,Overhead Press,1,normal,45,8,,,',
  'Push Day,2026-09-14 18:02:00,2026-09-14 19:10:00,Plank,1,normal,,,,60,',
  'Pull Day,2026-09-16 18:00:00,2026-09-16 19:00:00,Barbell Row,1,normal,70,8,,,',
].join('\n')

/** A real-shaped Strong export: pounds, a comma inside a name. */
const STRONG = [
  'Date,Workout Name,Exercise Name,Set Order,Weight,Reps,Distance,Seconds,Notes,RPE',
  '2026-09-15 07:30:00,Morning,"Squat, Back",1,225,5,,,,',
  '2026-09-15 07:30:00,Morning,"Squat, Back",2,225,5,,,,8',
  '2026-09-15 07:30:00,Morning,Deadlift,1,315,3,,,,9',
  '2026-09-17 07:30:00,Morning,Deadlift,1,320,3,,,,',
].join('\n')

describe('parseCsv', () => {
  it('keeps a comma inside a quoted field', () => {
    const rows = parseCsv('a,b\n"Squat, Back",5')
    expect(rows[1][0]).toBe('Squat, Back')
  })

  it('ends the last cell where the file ends', () => {
    /* Reading one character past the end appends the literal string
       "undefined" to the final cell of every file and adds a phantom
       row. It hides completely when the last column is empty — which
       every export fixture here happens to have, because exporters
       write a trailing comma for an optional field. */
    expect(parseCsv('a,b\n1,2')).toEqual([['a', 'b'], ['1', '2']])
    expect(parseCsv('a,b\n1,2\n')).toEqual([['a', 'b'], ['1', '2']])
    expect(parseCsv('')).toEqual([])
  })

  it('ends it correctly when the last cell was quoted', () => {
    expect(parseCsv('a,b\n1,"x,y"')).toEqual([['a', 'b'], ['1', 'x,y']])
  })

  it('handles escaped quotes and blank lines', () => {
    expect(parseCsv('a\n"say ""hi"""\n\n')[1][0]).toBe('say "hi"')
  })
})

describe('detectSource', () => {
  it('recognises each export from its header', () => {
    expect(detectSource(parseCsv(HEVY)[0])).toBe('hevy')
    expect(detectSource(parseCsv(STRONG)[0])).toBe('strong')
    expect(detectSource(['name', 'value'])).toBe('unknown')
  })

  it('imports nothing from a file it does not recognise', () => {
    const out = importCsv('name,value\nfoo,1')
    expect(out.entries).toEqual([])
    expect(out.report.source).toBe('unknown')
  })
})

describe('a Hevy export', () => {
  const out = importCsv(HEVY)

  it('reports what came in', () => {
    expect(out.report.source).toBe('hevy')
    expect(out.report.sessions).toBe(2)
    expect(out.report.from).toBe('2026-09-14')
    expect(out.report.to).toBe('2026-09-16')
  })

  it('converts kilograms to pounds at the boundary', () => {
    const bench = out.entries.find((e) => e.exerciseId === 'bench_press')!
    const working = bench.sets.find((s) => !s.warmup)!
    expect(working.w).toBeCloseTo(84 * LB_PER_KG, 1)
  })

  it('keeps warm-ups flagged rather than counted as work', () => {
    const bench = out.entries.find((e) => e.exerciseId === 'bench_press')!
    expect(bench.sets.filter((s) => s.warmup)).toHaveLength(1)
    expect(bench.sets.filter((s) => !s.warmup)).toHaveLength(2)
  })

  it('records the top WORKING weight on the entry', () => {
    const bench = out.entries.find((e) => e.exerciseId === 'bench_press')!
    expect(bench.kg).toBeCloseTo(84 * LB_PER_KG, 1)
  })

  it('carries RPE through', () => {
    const bench = out.entries.find((e) => e.exerciseId === 'bench_press')!
    expect(bench.sets.find((s) => s.rpe === 8.5)).toBeDefined()
  })

  it('reads a timed hold as a time set', () => {
    const plank = out.entries.find((e) => e.exerciseId === 'plank')!
    expect(plank.sets[0].kind).toBe('time')
    expect(plank.sets[0].s).toBe(60)
  })

  it('resolves names onto canonical ids', () => {
    expect(out.entries.map((e) => e.exerciseId).sort())
      .toEqual(['barbell_row', 'bench_press', 'overhead_press', 'plank'])
  })

  it('marks every set with its provenance', () => {
    for (const entry of out.entries) for (const set of entry.sets) expect(set.imported).toBe('hevy')
  })
})

describe('a Strong export', () => {
  const out = importCsv(STRONG)

  it('reads pounds as pounds by default', () => {
    const squat = out.entries.find((e) => e.exerciseId === 'back_squat')!
    expect(squat.sets[0].w).toBe(225)
  })

  it('converts when the export was in kilograms', () => {
    const kg = importCsv(STRONG, { strongUnit: 'kg' })
    const squat = kg.entries.find((e) => e.exerciseId === 'back_squat')!
    expect(squat.sets[0].w).toBeCloseTo(225 * LB_PER_KG, 1)
  })

  it('resolves a name with a comma in it', () => {
    expect(out.entries.some((e) => e.exerciseId === 'back_squat')).toBe(true)
  })

  it('groups sets by lift and day', () => {
    const squat = out.entries.find((e) => e.exerciseId === 'back_squat')!
    expect(squat.sets).toHaveLength(2)
    expect(out.report.sessions).toBe(2)
  })
})

describe('it refuses to invent an identity', () => {
  const withUnknown = [
    'Date,Workout Name,Exercise Name,Set Order,Weight,Reps',
    '2026-09-15 07:30:00,A,Reverse Zercher Jerk,1,100,5',
    '2026-09-15 07:30:00,A,Reverse Zercher Jerk,2,100,5',
    '2026-09-15 07:30:00,A,Deadlift,1,315,3',
  ].join('\n')

  it('surfaces the name instead of forking a new lift', () => {
    const out = importCsv(withUnknown)
    expect(out.entries.map((e) => e.exerciseId)).toEqual(['deadlift'])
    expect(out.report.unresolved[0]).toEqual({ name: 'Reverse Zercher Jerk', rows: 2 })
  })

  it('does not trust a near match either — an import is the wrong moment to guess', () => {
    const near = [
      'Date,Workout Name,Exercise Name,Set Order,Weight,Reps',
      '2026-09-15 07:30:00,A,Bench Pres Barbel,1,185,5',
    ].join('\n')
    const out = importCsv(near)
    expect(out.entries).toEqual([])
    expect(out.report.unresolved).toHaveLength(1)
  })

  it('resolves against the athlete’s own lifts too', () => {
    const custom = [
      'Date,Workout Name,Exercise Name,Set Order,Weight,Reps',
      '2026-09-15 07:30:00,A,Taekwondo Kick Drill,1,0,20',
    ].join('\n')
    const out = importCsv(custom, { userExercises: { kick: 'Taekwondo Kick Drill' } })
    expect(out.entries[0].exerciseId).toBe('kick')
  })
})

describe('importing twice changes nothing', () => {
  it('skips a date already present for that lift', () => {
    const first = importCsv(HEVY)
    const existing: Record<string, Array<{ date: string }>> = {}
    for (const entry of first.entries) {
      existing[entry.exerciseId] = [...(existing[entry.exerciseId] || []), { date: entry.date }]
    }
    const second = importCsv(HEVY, { existing })
    expect(second.entries).toEqual([])
    expect(second.report.duplicates).toBeGreaterThan(0)
  })

  it('still imports rows that are genuinely new', () => {
    const existing = { bench_press: [{ date: '2026-09-14' }] }
    const out = importCsv(HEVY, { existing })
    expect(out.entries.map((e) => e.exerciseId)).not.toContain('bench_press')
    expect(out.entries.map((e) => e.exerciseId)).toContain('barbell_row')
  })
})

describe('it never claims a timestamp it did not observe', () => {
  it('leaves every imported set without an observed time', () => {
    const out = importCsv(HEVY)
    for (const entry of out.entries) {
      for (const set of entry.sets) expect((set as unknown as Record<string, unknown>).at).toBeUndefined()
    }
  })
})

/**
 * The importer is about to be edited for session ids, and it runs over a
 * year of somebody's real history in one pass. 31 of its 75 mutations
 * survived, so almost none of the decisions below were actually pinned:
 * which app wrote the file, what a date means, which measure a row
 * carries, and which weight becomes the session's.
 *
 * A migration guided by tests that miss four mutations in ten is how you
 * corrupt data quietly. These are the assertions the migration will lean
 * on.
 */
describe('recognising the file before trusting a word of it', () => {
  const header = (cols: string[]) => detectSource(cols)

  it('needs BOTH Hevy markers, not either', () => {
    /* A file with exercise_title but no set_index is not a Hevy export,
       and reading it as one takes every column from the wrong place. */
    expect(header(['exercise_title', 'set_index'])).toBe('hevy')
    expect(header(['exercise_title'])).toBe('unknown')
    expect(header(['set_index'])).toBe('unknown')
  })

  it('needs the Strong name column AND one of its two shapes', () => {
    expect(header(['exercise_name', 'set_order'])).toBe('strong')
    expect(header(['exercise_name', 'workout_name'])).toBe('strong')
    expect(header(['exercise_name'])).toBe('unknown')
    expect(header(['set_order'])).toBe('unknown')
  })

  it('imports nothing at all from an unknown header', () => {
    /* Paired with the recognised file in the same body: "imports
       nothing" is satisfied by an importer that imports nothing ever. */
    expect(importCsv(HEVY).entries.length).toBeGreaterThan(0)
    const r = importCsv('a,b,c\n1,2,3')
    expect(r.entries).toEqual([])
    expect(r.report.source).toBe('unknown')
  })

  it('imports nothing from a recognised header with no rows under it', () => {
    /* A header-only export is a real thing people produce. */
    expect(importCsv(HEVY).entries.length).toBeGreaterThan(0)
    const r = importCsv('title,start_time,exercise_title,set_index,weight_kg,reps')
    expect(r.entries).toEqual([])
    expect(r.report.sets).toBe(0)
  })
})

describe('a date is the day it says', () => {
  const entriesFor = (raw: string) => {
    const csv = [
      'title,start_time,end_time,exercise_title,set_index,set_type,weight_kg,reps,distance_km,duration_seconds,rpe',
      `Day,${raw},${raw},Bench Press,1,normal,84,5,,,`,
    ].join('\n')
    return importCsv(csv).entries
  }
  /* The DATE of the imported row — and `entriesFor` beside it, because
     a row imported with a null date also satisfies `?? null`. Dropping
     the row and importing it undated are different failures. */
  const dayOf = (raw: string) => entriesFor(raw)[0]?.date ?? null

  it('reads an ISO timestamp as its own day', () => {
    expect(dayOf('2026-09-14 18:02:00')).toBe('2026-09-14')
  })

  it('reads a bare ISO date', () => {
    expect(dayOf('2026-09-14')).toBe('2026-09-14')
  })

  it('reads the slash form some exports use', () => {
    /* Not a parse of convenience: without it these fall through to
       `new Date`, which reads 2026/09/14 in the host timezone and can
       land a day either side. */
    expect(dayOf('2026/09/14')).toBe('2026-09-14')
  })

  it('drops a row whose date cannot be read at all', () => {
    expect(entriesFor('last Tuesday')).toEqual([])
    expect(dayOf('last Tuesday')).toBeNull()
  })

  it('drops a row with no date', () => {
    expect(entriesFor('')).toEqual([])
    expect(dayOf('')).toBeNull()
  })

  it('drops a row with no exercise name', () => {
    const row = (name: string) => [
      'title,start_time,end_time,exercise_title,set_index,set_type,weight_kg,reps,distance_km,duration_seconds,rpe',
      `Day,2026-09-14 18:02:00,2026-09-14 19:00:00,${name},1,normal,84,5,,,`,
    ].join('\n')
    /* The same row WITH a name imports, so the silence is the missing
       name rather than the fixture. */
    expect(importCsv(row('Bench Press')).entries).toHaveLength(1)
    expect(importCsv(row('')).entries).toEqual([])
  })
})

describe('which measure a row actually carries', () => {
  const kindOfRow = (cols: { w?: string; reps?: string; km?: string; secs?: string }) => {
    const csv = [
      'title,start_time,end_time,exercise_title,set_index,set_type,weight_kg,reps,distance_km,duration_seconds,rpe',
      `Day,2026-09-14 18:02:00,2026-09-14 19:00:00,Plank,1,normal,${cols.w ?? ''},${cols.reps ?? ''},${cols.km ?? ''},${cols.secs ?? ''},`,
    ].join('\n')
    const e = importCsv(csv).entries[0]
    return e?.sets[0]?.kind ?? 'reps_weight'
  }

  it('calls seconds with distance a time_distance set', () => {
    expect(kindOfRow({ secs: '600', km: '2' })).toBe('time_distance')
  })

  it('calls distance alone a distance set', () => {
    expect(kindOfRow({ km: '2' })).toBe('distance')
  })

  it('calls seconds without reps a time set', () => {
    expect(kindOfRow({ secs: '60' })).toBe('time')
  })

  it('does not call seconds WITH reps a time set', () => {
    /* A weighted carry logs both. Reading it as a hold loses the reps. */
    expect(kindOfRow({ secs: '60', reps: '10', w: '40' })).toBe('reps_weight')
  })

  it('calls reps with no weight a reps_only set', () => {
    expect(kindOfRow({ reps: '12' })).toBe('reps_only')
  })

  it('calls a ZERO weight the same as no weight', () => {
    /* Exports write 0 for bodyweight work. Treating 0 as a load makes
       every pull-up a 0 lb reps_weight set. */
    expect(kindOfRow({ reps: '12', w: '0' })).toBe('reps_only')
  })

  it('calls a zero duration no duration', () => {
    expect(kindOfRow({ secs: '0', reps: '12', w: '0' })).toBe('reps_only')
  })

  it('does not turn a distance into a time_distance on a zero duration', () => {
    /* `seconds !== undefined && seconds > 0` — the two halves only come
       apart when a row carries an explicit 0 BESIDE a distance, which
       is what every treadmill export writes. */
    expect(kindOfRow({ secs: '0', km: '2' })).toBe('distance')
  })

  it('calls a zero distance no distance', () => {
    expect(kindOfRow({ km: '0', reps: '12', w: '100' })).toBe('reps_weight')
  })

  it('calls weight with reps a reps_weight set', () => {
    expect(kindOfRow({ w: '84', reps: '5' })).toBe('reps_weight')
  })
})

describe('the numbers that come off a row', () => {
  it('reads a numeric string', () => {
    const e = importCsv(HEVY).entries.find((x) => x.displayName.match(/Bench/))
    expect(e?.sets.some((s) => s.r === 5)).toBe(true)
  })

  it('leaves a field that is not a number undefined rather than zero', () => {
    /* NaN reaching a set would make every read of it silently wrong;
       undefined is the honest shape and every consumer already handles
       it. */
    const csv = [
      'title,start_time,end_time,exercise_title,set_index,set_type,weight_kg,reps,distance_km,duration_seconds,rpe',
      'Day,2026-09-14 18:02:00,2026-09-14 19:00:00,Bench Press,1,normal,heavy,5,,,',
    ].join('\n')
    const set = importCsv(csv).entries[0].sets[0]
    expect(set.w).toBeUndefined()
    expect(set.r).toBe(5)
  })

  it('omits a measure the row did not carry, rather than writing zero', () => {
    const e = importCsv(HEVY).entries.find((x) => x.displayName === 'Plank')!
    expect(e.sets[0].s).toBe(60)
    expect(e.sets[0].w).toBeUndefined()
    expect(e.sets[0].r).toBeUndefined()
  })

  it('converts a distance in kilometres to metres', () => {
    const csv = [
      'title,start_time,end_time,exercise_title,set_index,set_type,weight_kg,reps,distance_km,duration_seconds,rpe',
      'Day,2026-09-14 18:02:00,2026-09-14 19:00:00,Run,1,normal,,,5,1800,',
    ].join('\n')
    expect(importCsv(csv).entries[0].sets[0].m).toBe(5000)
  })
})

describe('the weight that becomes the session weight', () => {
  it('takes the heaviest WORKING set, not the heaviest set', () => {
    /* A warm-up heavier than the work is rare but real — a top single
       followed by back-offs. Counting it would make the next
       suggestion read from a set nobody worked. */
    const csv = [
      'title,start_time,end_time,exercise_title,set_index,set_type,weight_kg,reps,distance_km,duration_seconds,rpe',
      'Day,2026-09-14 18:02:00,2026-09-14 19:00:00,Bench Press,0,warmup,100,3,,,',
      'Day,2026-09-14 18:02:00,2026-09-14 19:00:00,Bench Press,1,normal,80,5,,,',
    ].join('\n')
    const e = importCsv(csv).entries[0]
    expect(e.kg).toBe(Math.round(80 * LB_PER_KG * 100) / 100)
  })

  it('takes the heaviest of several working sets', () => {
    const csv = [
      'title,start_time,end_time,exercise_title,set_index,set_type,weight_kg,reps,distance_km,duration_seconds,rpe',
      'Day,2026-09-14 18:02:00,2026-09-14 19:00:00,Bench Press,1,normal,80,5,,,',
      'Day,2026-09-14 18:02:00,2026-09-14 19:00:00,Bench Press,2,normal,90,3,,,',
      'Day,2026-09-14 18:02:00,2026-09-14 19:00:00,Bench Press,3,normal,70,8,,,',
    ].join('\n')
    expect(importCsv(csv).entries[0].kg).toBe(Math.round(90 * LB_PER_KG * 100) / 100)
  })

  it('leaves the session weight at zero when every set was a warm-up', () => {
    const csv = [
      'title,start_time,end_time,exercise_title,set_index,set_type,weight_kg,reps,distance_km,duration_seconds,rpe',
      'Day,2026-09-14 18:02:00,2026-09-14 19:00:00,Bench Press,0,warmup,100,3,,,',
    ].join('\n')
    expect(importCsv(csv).entries[0].kg).toBe(0)
  })
})

describe('a name it cannot resolve exactly is never guessed at', () => {
  it('counts an unresolved name rather than importing it', () => {
    const csv = [
      'title,start_time,end_time,exercise_title,set_index,set_type,weight_kg,reps,distance_km,duration_seconds,rpe',
      'Day,2026-09-14 18:02:00,2026-09-14 19:00:00,Zercher Yoke Carry,1,normal,100,5,,,',
    ].join('\n')
    const r = importCsv(csv)
    expect(r.entries).toEqual([])
    expect(r.report.unresolved.length).toBeGreaterThan(0)
  })

  it('imports the rows it CAN resolve from the same file', () => {
    /* The control: refusing everything would satisfy the line above. */
    const csv = [
      'title,start_time,end_time,exercise_title,set_index,set_type,weight_kg,reps,distance_km,duration_seconds,rpe',
      'Day,2026-09-14 18:02:00,2026-09-14 19:00:00,Zercher Yoke Carry,1,normal,100,5,,,',
      'Day,2026-09-14 18:02:00,2026-09-14 19:00:00,Bench Press,1,normal,84,5,,,',
    ].join('\n')
    const r = importCsv(csv)
    expect(r.entries).toHaveLength(1)
    expect(r.report.unresolved).toHaveLength(1)
  })
})
