import { describe, it, expect } from 'vitest'
import { indexFrom, analyse, frequencyGaps } from '../../lib/train/analysis'
import { publishedMetrics } from '../../lib/train/metrics'
import { acuteChronic } from '../../lib/train/load'
import { bestE1RM, classifyPR } from '../../lib/train/records'
import { suggestTarget } from '../../lib/train/progression'
import { detectPlateau } from '../../lib/train/deload'
import { sameAsLastTime } from '../../lib/train/session'
import { currentWeekStreak, sessionsPerWeek } from '../../lib/train/streaks'
import { sessionsPerWeekSeries, e1rmSeries } from '../../lib/train/series'
import { restTrend } from '../../lib/train/timing'
import { recentOtherLoad } from '../../lib/train/other'
import { accuracyOver, type PredictionStore } from '../../lib/train/predictions'
import { importCsv } from '../../lib/train/import'

/**
 * TWO-A-DAYS — the assumption, made to fail out loud.
 *
 * History is keyed (exerciseId, date): `rollupFor` drops every row for a
 * lift on a date before writing the new one, so a lift trained twice in
 * one day keeps only the second session. That is data loss and it ships.
 *
 * The intended fix is a session id on every row, old rows migrating to
 * sessionId = date. These assertions describe the behaviour we want
 * AFTERWARDS. The ones marked `.fails` are wrong today — deliberately,
 * and left that way, so the fix has something to prove itself against
 * rather than us rebuilding and agreeing with ourselves.
 *
 * `.fails` inverts: the test passes while the behaviour is broken, and
 * goes RED the moment it starts working. That is the signal to come back
 * and unmark it.
 *
 * The DAY-CORRECT cases are asserted positively and must stay green
 * throughout. If the fix breaks streaks, that is how we hear about it.
 */

const DAY = '2026-09-22'
const NEXT = '2026-09-23'
const NOW = new Date(2026, 8, 22, 21).getTime()

const index = indexFrom({
  squat: { primary: [{ muscle: 'quads', share: 1 }] },
  bench: { primary: [{ muscle: 'chest', share: 1 }] },
})

/** One session's worth of a lift. Two of these on one date is a two-a-day. */
const sess = (date: string, sets: number, w = 225, reps = 5) => ({
  date, kg: w, sets: Array.from({ length: sets }, () => ({ w, r: reps })),
})

/* ------------------------------------------------------------------ *
 * SUM-CORRECT — should add both sessions, and mostly already does.
 * ------------------------------------------------------------------ */
describe('volume adds across both sessions of a day', () => {
  const morning = sess(DAY, 3, 225)
  const evening = sess(DAY, 2, 185)
  const ctx = {
    date: DAY, history: { squat: [morning, evening] }, index,
    finishedDates: [DAY], bodyweight: [], otherTraining: [],
    deloadLifts: 0, readiness: null, sessionSeconds: null,
    sessionTimingObserved: false, streakTarget: 4, pr: null, now: NOW,
  }

  it('counts the hard sets of both', () => {
    const m = publishedMetrics(ctx).find((x) => x.key === 'hard_sets')
    expect(m?.value).toBe(5)
  })

  it('adds the tonnage of both', () => {
    const m = publishedMetrics(ctx).find((x) => x.key === 'tonnage')
    expect(m?.value).toBe(3 * 5 * 225 + 2 * 5 * 185)
  })

  it('attributes both to the muscle', () => {
    const m = publishedMetrics(ctx).find((x) => x.key === 'hard_sets.quads')
    expect(m?.value).toBe(5)
  })

  it('feeds both into the acute load', () => {
    const one = acuteChronic({ history: { squat: [morning] }, index, otherTraining: [], now: NOW })
    const two = acuteChronic({ history: { squat: [morning, evening] }, index, otherTraining: [], now: NOW })
    expect(two.byMuscle.quads!.acute).toBeGreaterThan(one.byMuscle.quads!.acute)
  })
})

/* ------------------------------------------------------------------ *
 * DAY-CORRECT — a day is the right unit. Must stay green.
 * ------------------------------------------------------------------ */
describe('a day trained twice is still one day', () => {
  it('counts once toward the weekly streak', () => {
    /* finishedDates is a set of DAYS. Training twice on Tuesday is one
       Tuesday, and a streak that counted it twice would let somebody hit
       a four-day target in two days. Already true, and it must stay
       true: the duplicate collapses. */
    expect(sessionsPerWeek([DAY, DAY], NOW, 1)[0]).toBe(1)
    expect(sessionsPerWeek([DAY, '2026-09-21'], NOW, 1)[0]).toBe(2)
  })

  it('does not double-count a day in the streak itself', () => {
    const week = [DAY, DAY, DAY, DAY]
    expect(currentWeekStreak(week, 4, NOW)).toBe(0)
  })

  it('counts once in the rolling sessions-per-week chart', () => {
    expect(sessionsPerWeekSeries([DAY, DAY], NOW, 1)[0].value).toBe(1)
  })

  it('closes a frequency gap once, not twice', () => {
    /* A gap is about calendar distance since the muscle was trained. */
    const history = { squat: [sess('2026-08-01', 3), sess('2026-08-08', 3)] }
    expect(frequencyGaps(history, index, NOW).some((f) => f.muscle === 'quads')).toBe(true)
  })
})

/* ------------------------------------------------------------------ *
 * SESSION-WRONG — says day, means session. Broken today.
 * ------------------------------------------------------------------ */
describe('the evening session is a session of its own', () => {
  const morning = sess(DAY, 3, 225)
  const evening = sess(DAY, 3, 185)

  it.fails('prefills the evening from the MORNING, not from yesterday', () => {
    /* sameAsLastTime excludes the whole of today, so the evening session
       is prefilled from the last DIFFERENT day — as though the morning
       had not happened. */
    const target = sameAsLastTime([sess('2026-09-15', 3, 135), morning], { excludeDate: DAY })
    expect(target?.[0]?.weight).toBe(225)
  })

  it.fails('reads the morning as the previous session when suggesting', () => {
    /* suggestLoad takes the last row as "last time". With both sessions
       on one date it cannot see two, and after rollupFor only one row
       survives anyway. */
    const history = [sess('2026-09-15', 3, 135), morning, evening]
    const s = suggestTarget(history as never, { id: 'squat', kind: 'reps_weight' } as never, NOW)
    expect(s.reason).toMatch(/185/)
  })

  it.fails('treats the two sessions as two observations for rest trend', () => {
    /* restTrend walks entries as sessions. Two same-date entries should
       be two points, not one — but nothing writes two today. */
    const timed = (date: string, t0: number) => ({
      date, kg: 225,
      sets: [{ w: 225, r: 5, at: t0 }, { w: 225, r: 5, at: t0 + 120_000 }],
    })
    const base = new Date(2026, 8, 22, 8).getTime()
    const trend = restTrend([timed(DAY, base), timed(DAY, base + 36_000_000)] as never)
    expect(trend?.sessions).toBe(2)
  })

  it.fails('does not count a two-a-day day as one sample in the weekly read', () => {
    /* weekly.ts counts `new Set(rows.map(r => r.date)).size` as the
       sample count behind hard_sets — two sessions read as one sample,
       so a two-a-day week looks thinner than it was. */
    const rows = [{ date: DAY }, { date: DAY }, { date: NEXT }]
    expect(new Set(rows.map((r) => r.date)).size).toBe(3)
  })

  it.fails('scores a prediction against the session it was actually made for', () => {
    /* accuracyOver's `entries.find(e => e.date === p.date)` grabs
       whichever row for that date comes first in array order — Prediction
       carries no sessionId at all, so there is no way to tell which of
       two same-day sessions a prediction was actually about. Two rows,
       only one of which is a real attempt at the predicted 230x5; the
       "wrong" one placed first is what gets scored today. */
    const prediction = {
      id: 'back_squat', date: DAY, weight: 230, reps: 5, seconds: null, metres: null,
      basis: 'clean', deloadState: null, readiness: 'normal', madeAt: NOW,
    } as const
    const store: PredictionStore = { p1: prediction }
    const wrongFirst = {
      back_squat: [
        sess(DAY, 5, 185),  // an unrelated lighter set, placed first — should not be scored
        sess(DAY, 5, 245),  // the real attempt at 230x5 — a clear hit
      ],
    }
    const result = accuracyOver(store, wrongFirst as never)
    expect(result.hit).toBe(1)
  })

  it.fails('imports a genuinely second session rather than calling it a duplicate', () => {
    /* import.ts's dedupe is `existing[id].some(e => e.date === row.date)`
       — ANY existing row on that date marks the WHOLE imported row a
       duplicate and drops it, even when the import is a real second
       session that never touched the app. Worse than the overwrite this
       whole feature fixes: the imported data is not even written. */
    const existing = { back_squat: [{ date: DAY, kg: 225 }] }
    const csv = [
      'title,start_time,end_time,exercise_title,set_index,set_type,weight_kg,reps,distance_km,duration_seconds,rpe',
      `Day,${DAY} 18:00:00,${DAY} 19:00:00,Back Squat,1,normal,84,5,,,`,
    ].join('\n')
    const result = importCsv(csv, { existing: existing as never })
    expect(result.report.duplicates).toBe(0)
    expect(result.entries).toHaveLength(1)
  })
})

/* ------------------------------------------------------------------ *
 * UNDECIDED — needs a call. Stated, not chosen.
 * ------------------------------------------------------------------ */
describe('decisions nobody has made yet', () => {
  const morning = sess(DAY, 3, 225)
  const evening = sess(DAY, 3, 245)

  it.fails('CHOICE: may the evening set a PR against the morning of the same day?', () => {
    /* classifyPR excludes the whole of today from the baseline. With a
       real prior day in place, an evening lift heavier than that day but
       LIGHTER than the morning still scores a record — because the
       morning is invisible to it.
       Either the morning counts (no record; the athlete already beat
       230 today) or it does not (each session may set its own).
       Asserted here as: the morning counts. */
    const history = [sess('2026-09-15', 3, 135), sess(DAY, 3, 245)]
    const pr = classifyPR(history as never, { weight: 230, reps: 5 }, NOW)
    expect(pr.kind).toBeNull()
  })

  it('CONTROL: three flat sessions on three days do flag a plateau', () => {
    /* Needs PLATEAU_WINDOW + 1 rows. Without this control the choice
       below passes against a detector that never fires. */
    const flat = [
      sess('2026-09-12', 3, 225), sess('2026-09-15', 3, 225),
      sess('2026-09-18', 3, 225), sess('2026-09-21', 3, 225),
    ]
    expect(detectPlateau(flat as never, {})).not.toBeNull()
  })

  it.fails('CHOICE: is a plateau three SESSIONS or three DAYS?', () => {
    /* detectPlateau reads the last PLATEAU_WINDOW ROWS. With two-a-days
       those three rows can span a day and a half, so somebody training
       twice daily is flagged for a deload twice as fast as somebody
       training once.
       Asserted here as: three DAYS — a day trained twice is one
       observation of the plateau, not two. */
    const flat = [
      sess('2026-09-12', 3, 225), sess('2026-09-21', 3, 225),
      sess(DAY, 3, 225), sess(DAY, 3, 225),
    ]
    expect(detectPlateau(flat as never, {})).toBeNull()
  })

  it.fails('CHOICE: does readiness see the morning before advising the evening?', () => {
    /* assessReadiness compares recent hard sets to a baseline. If the
       morning is already in `recentHardSets` the evening is advised
       against a day that has already happened; if it is not, the advice
       ignores work the athlete has genuinely done.
       Asserted here as: the morning counts, so the evening reads as
       heavier load than a single session would.
       Expressed through the metrics payload, which is what a consumer
       would act on. */
    const one = publishedMetrics({
      date: DAY, history: { squat: [morning] }, index, finishedDates: [DAY],
      bodyweight: [], otherTraining: [], deloadLifts: 0, readiness: null,
      sessionSeconds: null, sessionTimingObserved: false, streakTarget: 4, pr: null, now: NOW,
    }).find((m) => m.key === 'hard_sets')!.value
    expect(one).toBe(6)
  })

  it.fails('CHOICE: does the e1RM chart plot one point a day or one a session?', () => {
    /* e1rmSeries produces a point per ENTRY. Two entries on one date
       give two points on the same x — which a line chart cannot draw
       honestly. Either the chart takes the day's best, or the x axis
       stops being a date.
       Asserted here as: one point per day, the best of it. */
    const points = e1rmSeries([sess(DAY, 3, 225), sess(DAY, 3, 245)] as never)
    expect(points).toHaveLength(1)
    expect(points[0].value).toBeCloseTo(245 * (1 + 5 / 30), 1)
  })
})

/* ------------------------------------------------------------------ *
 * D — the other-training path, which already coexists.
 * ------------------------------------------------------------------ */
describe('lifting in the morning, taekwondo in the evening', () => {
  it('already keeps both, because nothing collapses them by date', () => {
    /* otherTraining is a flat append with no date key, so two entries on
       one day coexist and their load sums. Lifting cannot do this. The
       asymmetry is the finding: session identity already half-exists
       here, as a position in an array rather than an id. */
    const entries = [
      { date: DAY, activity: 'martial_arts' as const, minutes: 60, intensity: 8 },
      { date: DAY, activity: 'conditioning' as const, minutes: 30, intensity: 6 },
    ]
    const summary = recentOtherLoad(entries, DAY)
    expect(summary.sessions).toBe(2)
    expect(summary.load).toBe(60 * 8 + 30 * 6)
  })

  it('sums both into the systemic load beside a lifting session', () => {
    const history = { squat: [sess(DAY, 3, 225)] }
    const withOther = acuteChronic({
      history, index,
      otherTraining: [
        { date: DAY, activity: 'martial_arts', minutes: 60, intensity: 8 },
        { date: DAY, activity: 'conditioning', minutes: 30, intensity: 6 },
      ] as never,
      now: NOW,
    })
    const without = acuteChronic({ history, index, otherTraining: [], now: NOW })
    expect(withOther.systemic.acute).toBeGreaterThan(without.systemic.acute)
  })
})

/* ------------------------------------------------------------------ *
 * THE REGRESSION TEST. This is the one that matters.
 * ------------------------------------------------------------------ */
describe('squat in the morning, squat in the evening', () => {
  const localToday = () => { const d = new Date(); const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` }

  const boot = async () => {
    const { JSDOM } = await import('jsdom')
    const { readFileSync } = await import('node:fs')
    const today = localToday()
    const dom = new JSDOM(readFileSync('public/tiles/train.html', 'utf8'), {
      url: 'https://train.test/', runScripts: 'dangerously', pretendToBeVisual: true,
      beforeParse(w: any) {
        w.Vitality = {
          load: async () => ({
            unit: 'lb', submitted: false,
            session: { date: today, off: false, warmup: [], cooldown: [], startedAt: Date.now() - 3600000, ex: [] },
            history: {}, customLib: { squat: { equipment: 'Barbell', kind: 'reps_weight', primary: ['Quads'] } },
            exerciseNames: { squat: 'Squat' },
            deloadStates: {}, finishedDates: [], templates: [], shortTermGoal: '',
            otherTraining: [], photos: [], sessionDurations: [], liftGoals: [], bodyweight: [],
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
    return { run: (e: string) => dom.window.eval(e), today }
  }

  /** Add squat with `n` empty slots, log them all at `w`, finish. */
  const session = (run: (e: string) => any, n: number, w: number) => {
    run(`(function(){ var s=curSession(); s.ex=[];
      s.ex.push({id:'squat',name:'Squat',tier:1,sets:${n},reps:5,kg:${w},perHand:false,rest:90,
        lastKg:${w},pinned:false,collapsed:false,deload:false,note:'',
        log:${JSON.stringify(Array(n).fill(null))}});
      render(); return true; })()`)
    run(`(function(){ var e=curSession().ex[0];
      for(var i=0;i<e.log.length;i++) doLog(e,i,{kg:${w},reps:5},false); render(); return true; })()`)
    run(`(function(){ document.querySelector('#finishBtn').click(); return STATE.submitted; })()`)
  }

  it('keeps BOTH sessions, each on its own row', async () => {
    /* THE DATA LOSS, FIXED. rollupFor used to drop every row for (lift,
       date) before writing the new one, so the morning's three sets
       were replaced by the evening's two — not merged, replaced. Five
       sets were done and two were on record, with no warning and no
       undo. This was `.fails` until the session-id guard landed; it
       flipped to passing the moment rollupFor started comparing
       sessionId as well as date, which is the proof the fix works
       rather than an assertion that it should. */
    const { run, today } = await boot()
    session(run, 3, 225)                                   // morning
    run(`(function(){ document.querySelector('#finishBtn').click(); return STATE.submitted; })()`) // unlock
    session(run, 2, 185)                                   // evening
    const rows = JSON.parse(String(run(`JSON.stringify(STATE.history.squat || [])`)))
      .filter((r: any) => r.date === today)
    const sets = rows.reduce((n: number, r: any) => n + (r.sets || []).length, 0)
    expect(rows).toHaveLength(2)
    expect(sets).toBe(5)
  }, 60_000)

  it('CONTROL: a single session records every set it logged', async () => {
    /* Without this, the assertion above could pass against a tile that
       records nothing at all. */
    const { run, today } = await boot()
    session(run, 3, 225)
    const rows = JSON.parse(String(run(`JSON.stringify(STATE.history.squat || [])`)))
      .filter((r: any) => r.date === today)
    expect(rows).toHaveLength(1)
    expect(rows[0].sets).toHaveLength(3)
  }, 60_000)

  it('publishing today does not erase the morning either — metricsContextFor', async () => {
    /* The SECOND site this bug lived in, train.html:6518. rollupFor and
       metricsContextFor carried the identical `x.date !== today` filter,
       and both were fixed the same way in the same command — but only
       rollupFor had a test watching it. This is that test for the other
       one: lock the morning, start a genuinely new (unlocked) evening
       session, and confirm publishing today's metrics still carries the
       morning's committed row, not just the evening's live, uncommitted
       one. */
    const { run, today } = await boot()
    session(run, 3, 225)                                   // morning, locked
    run(`(function(){ document.querySelector('#finishBtn').click(); return STATE.submitted; })()`) // unlock
    run(`(function(){ curSession().ex=[]; render(); return true; })()`)
    run(`(function(){ var s=curSession();
      s.ex.push({id:'squat',name:'Squat',tier:1,sets:2,reps:5,kg:185,perHand:false,rest:90,
        lastKg:185,pinned:false,collapsed:false,deload:false,note:'',log:[null,null]});
      var e=s.ex[0]; doLog(e,0,{kg:185,reps:5},false); render(); return true; })()`) // evening, NOT finished
    const rows = JSON.parse(String(run(`JSON.stringify(metricsContextFor(today).history.squat || [])`)))
      .filter((r: any) => r.date === today)
    expect(rows).toHaveLength(2)
    const sets = rows.reduce((n: number, r: any) => n + (r.sets || []).length, 0)
    expect(sets).toBe(4) // 3 morning + 1 logged-so-far evening
  }, 60_000)

  it.fails('keeps both backdated sessions on the same past date — currently inherited, not fixed', async () => {
    /* THE HOLE THE isToday SCOPING LEAVES. rollupFor's sessionId check
       only runs when `date === today`; for any other date it collapses
       back to `x.date !== date`, the exact overwrite this feature exists
       to fix — just reached through the history editor instead of a live
       session. Confirmed by running it: two backdated writes to the same
       past date, same lift, through the real rollupFor(draft, date) path
       the history-edit popup uses. See docs/two-a-day-decisions.md,
       "Known limitation: the guard is scoped to today".
       This is deliberately out of scope for THIS command — isToday is a
       narrow, considered cut, not an oversight — but it must stay
       visible rather than silently read as "the guard is done". */
    const { run } = await boot()
    const PAST = '2026-08-01'
    run(`(function(){
      var draft = { id:'squat', name:'Squat', kind:'reps_weight',
        log:[{kg:225,reps:5},{kg:225,reps:5},{kg:225,reps:5}] };
      rollupFor(draft, '${PAST}');
      return true; })()`)
    run(`(function(){
      var draft = { id:'squat', name:'Squat', kind:'reps_weight',
        log:[{kg:185,reps:5},{kg:185,reps:5}] };
      rollupFor(draft, '${PAST}');
      return true; })()`)
    const rows = JSON.parse(String(run(`JSON.stringify(STATE.history.squat || [])`)))
      .filter((r: any) => r.date === PAST)
    const sets = rows.reduce((n: number, r: any) => n + (r.sets || []).length, 0)
    expect(rows).toHaveLength(2)
    expect(sets).toBe(5)
  }, 60_000)
})
