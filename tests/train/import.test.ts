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
