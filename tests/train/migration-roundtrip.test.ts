import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { indexFrom, analyse } from '../../lib/train/analysis'
import { acuteChronic } from '../../lib/train/load'
import { bestE1RM } from '../../lib/train/records'
import { e1rmSeries } from '../../lib/train/series'
import { workingVolume } from '../../lib/train/sets'
import { currentWeekStreak } from '../../lib/train/streaks'
import type { History } from '../../lib/train/analysis'
import { localToday } from '../helpers/clock'

/**
 * The session-id migration, proved against a year of real-shaped data.
 *
 * Every user's stored history is, right now, exactly what RAW_HISTORY
 * below is: rows with no sessionId at all, because the field did not
 * exist until this feature shipped. migrateHistorySessionIds() stamps
 * `sessionId = date` on every one of them at boot, and the whole promise
 * of that migration is that it is LOSSLESS — every number derived from
 * history has to read identically before and after.
 *
 * This is not asserted by reasoning about the code. BEFORE is computed
 * directly against the raw, un-migrated fixture through the pure engine
 * functions — no tile, no boot, nothing that could apply the migration.
 * AFTER is read back from a real booted tile that loaded that same
 * fixture and migrated it. If migration ever changes a number, drops a
 * row, or reorders one, this is the test that notices.
 */

const today = localToday()
const dayBack = (n: number) => {
  const d = new Date(); d.setDate(d.getDate() - n)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * A year of PRE-sessionId history — three lifts, twice a week, 52 weeks —
 * exactly the shape every real user's stored data is in right now.
 * Deliberately carries no `sessionId` field anywhere.
 */
function yearOfHistory(): History {
  const lifts: History = { squat: [], bench: [], deadlift: [] }
  for (let w = 0; w < 52; w++) {
    for (const [id, base] of [['squat', 225], ['bench', 185], ['deadlift', 315]] as const) {
      const day = w * 7 + 2
      if (day >= 365) continue
      ;(lifts[id] as unknown[]).push({
        date: dayBack(day), kg: base,
        sets: [{ w: base, r: 5 }, { w: base, r: 5 }, { w: base, r: 5 }],
      })
    }
  }
  return lifts
}

const RAW_HISTORY = yearOfHistory()
const FINISHED_DATES = Object.values(RAW_HISTORY).flat().map((e) => (e as { date: string }).date)
const CUSTOM_LIB = {
  squat: { equipment: 'Barbell', kind: 'reps_weight', primary: ['Quads'] },
  bench: { equipment: 'Barbell', kind: 'reps_weight', primary: ['Chest'] },
  deadlift: { equipment: 'Barbell', kind: 'reps_weight', primary: ['Lower Back'] },
}
const INDEX = indexFrom(CUSTOM_LIB)
const NOW = new Date(`${today}T12:00:00`).getTime()

/** Every metric the migration must not move, computed the pure way. */
function metricsFor(history: History) {
  const squat = history.squat as never[]
  return {
    volume: workingVolume(squat[squat.length - 1] as never, {}),
    tonnage: squat.reduce(
      (t, e: never) => t + (e as { sets: { w: number; r: number }[] }).sets.reduce((s, x) => s + x.w * x.r, 0), 0),
    streak: currentWeekStreak(FINISHED_DATES, 4, NOW),
    e1rm: bestE1RM(squat as never),
    e1rmSeriesLength: e1rmSeries(squat as never).length,
    analyseCount: analyse(history, INDEX, NOW).length,
    loadRatios: Object.fromEntries(
      Object.entries(acuteChronic({ history, index: INDEX, otherTraining: [], now: NOW }).byMuscle)
        .map(([m, r]) => [m, r ? { acute: r.acute, chronic: r.chronic, ratio: r.ratio, usable: r.usable } : null])),
  }
}

// BEFORE: computed directly on the raw, un-migrated fixture — no tile,
// no boot, no migration has ever touched this object.
const BEFORE = metricsFor(RAW_HISTORY)

let run: (e: string) => any

beforeAll(async () => {
  const dom = new JSDOM(readFileSync('public/tiles/train.html', 'utf8'), {
    url: 'https://train.test/', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w: any) {
      w.Vitality = {
        // A fresh, structurally IDENTICAL copy each load — the fixture
        // above must never be mutated by anything the tile does to it.
        load: async () => ({
          unit: 'lb', submitted: false,
          session: { date: today, off: false, warmup: [], cooldown: [], ex: [] },
          history: JSON.parse(JSON.stringify(RAW_HISTORY)),
          customLib: CUSTOM_LIB,
          exerciseNames: { squat: 'Squat', bench: 'Bench Press', deadlift: 'Deadlift' },
          deloadStates: {}, finishedDates: [...FINISHED_DATES],
          templates: [], shortTermGoal: '', otherTraining: [], photos: [],
          sessionDurations: [], liftGoals: [], bodyweight: [],
        }),
        save: () => {}, read: async () => { throw new Error('no vitals') },
        classify: async () => { throw new Error('no_key') },
        getInsight: async () => { throw new Error('no_key') },
        generateWorkout: async () => { throw new Error('no_key') },
        publish: () => {},
      }
      w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
      const noop = new Proxy({}, { get: () => () => noop })
      w.HTMLCanvasElement.prototype.getContext = () => noop
    },
  })
  await new Promise((r) => setTimeout(r, 900))
  run = (e: string) => dom.window.eval(e)
})

it('stamps sessionId = date on every pre-existing row, losslessly', () => {
  const rows = JSON.parse(run(`JSON.stringify(STATE.history)`))
  let count = 0
  for (const id of Object.keys(rows)) {
    for (const row of rows[id]) {
      count++
      expect(row.sessionId, `${id} ${row.date}`).toBe(row.date)
    }
  }
  expect(count).toBe(Object.values(RAW_HISTORY).reduce((n, rows) => n + (rows as never[]).length, 0))
})

it('BEFORE vs AFTER: every derived metric is byte-identical post-migration', () => {
  const migratedHistory = JSON.parse(run(`JSON.stringify(STATE.history)`)) as History
  const after = metricsFor(migratedHistory)
  expect(after).toEqual(BEFORE)
})

it('does not touch anything but sessionId — same sets, same weights, same reps', () => {
  const before = RAW_HISTORY.squat as never[]
  const after = JSON.parse(run(`JSON.stringify(STATE.history.squat)`))
  expect(after).toHaveLength(before.length)
  for (let i = 0; i < before.length; i++) {
    const b = before[i] as { date: string; kg: number; sets: unknown[] }
    expect(after[i].date).toBe(b.date)
    expect(after[i].kg).toBe(b.kg)
    expect(after[i].sets).toEqual(b.sets)
  }
})
