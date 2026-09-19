import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { JSDOM } from 'jsdom'

/**
 * The engine/tile boundary, asserted structurally.
 *
 * Four times a fully green suite has hidden a wiring gap here: index.ts not
 * exporting deload and streaks, `kind: e.kind` reading a field that has
 * never existed on a session exercise, and the coach path building
 * exercises without validating them. Every time the engine was correct and
 * simply unreachable, and every time only a test driving the real tile
 * found it.
 *
 * The shape is always the same — a second path into the same data that the
 * wiring pass did not visit — so these tests check the boundary itself
 * rather than any one instance of the bug.
 */

const ENGINE_DIR = 'lib/train'
const TILES = ['public/tiles/train.html', 'tiles-library/train.html']

function loggerOf(path: string): string {
  const html = readFileSync(path, 'utf8')
  return html.slice(html.indexOf('<!-- TRAIN-ENGINE:END -->'))
}

/* ══════════════════════════════════════════════════════════════════
   1. Every engine export is reachable.

   Asserted, not audited — the hand audit counted only cross-module
   callers and reported nine false positives.
   ══════════════════════════════════════════════════════════════════ */
describe('every engine export has a caller', () => {
  const sources = readdirSync(ENGINE_DIR)
    .filter((f) => f.endsWith('.ts') && f !== 'index.ts')
    .map((f) => ({ file: `${ENGINE_DIR}/${f}`, text: readFileSync(`${ENGINE_DIR}/${f}`, 'utf8') }))

  const exports_: Array<{ file: string; name: string }> = []
  for (const { file, text } of sources) {
    for (const m of text.matchAll(/export (?:async )?function (\w+)/g)) {
      exports_.push({ file, name: m[1] })
    }
    for (const m of text.matchAll(/export const (\w+)/g)) {
      exports_.push({ file, name: m[1] })
    }
  }

  it('finds exports to check', () => {
    expect(exports_.length).toBeGreaterThan(20)
  })

  it('has no export that nothing anywhere calls', () => {
    const logger = loggerOf(TILES[0])
    const unreachable = exports_.filter(({ file, name }) => {
      if (logger.includes(`TrainEngine.${name}`)) return false
      /* Any engine module counts, INCLUDING the defining one — a helper
         exported for tests but used at home is reachable, not dead. The
         declaration itself is stripped first so a symbol cannot count as
         its own caller. */
      return !sources.some(({ text }) => {
        const body = text
          .replace(new RegExp(`export (?:async )?function ${name}\\b`), '')
          .replace(new RegExp(`export const ${name}\\b`), '')
        return new RegExp(`\\b${name}\\b`).test(body)
      })
    })
    expect(unreachable.map((u) => `${u.file}::${u.name}`)).toEqual([])
  })

  it('exports every engine module from the barrel, so the tile can reach it', () => {
    const barrel = readFileSync(`${ENGINE_DIR}/index.ts`, 'utf8')
    const missing = readdirSync(ENGINE_DIR)
      .filter((f) => f.endsWith('.ts') && f !== 'index.ts')
      .map((f) => f.replace(/\.ts$/, ''))
      .filter((mod) => !barrel.includes(`'./${mod}'`))
    expect(missing).toEqual([])
  })
})

/* ══════════════════════════════════════════════════════════════════
   2. Nothing the tile calls is missing from the bundle.
   ══════════════════════════════════════════════════════════════════ */
describe.each(TILES)('%s — the bundle answers every call', (path) => {
  it('resolves every TrainEngine member the tile reaches for', () => {
    const html = readFileSync(path, 'utf8')
    const bundle = html.match(/<!-- TRAIN-ENGINE:START -->\s*<script>([\s\S]*?)<\/script>/)!
    // eslint-disable-next-line no-eval
    const engine = eval(`${bundle[1]}; TrainEngine`) as Record<string, unknown>
    const used = new Set([...loggerOf(path).matchAll(/TrainEngine\.(\w+)/g)].map((m) => m[1]))
    expect([...used].filter((n) => engine[n] === undefined)).toEqual([])
  })
})

/* ══════════════════════════════════════════════════════════════════
   3. What the tile KNOWS reaches the engine.

   This is the `kind: e.kind` class. The tile holds a value, builds an
   argument object, and the field arrives undefined — no error, no failing
   module test, just a feature that silently never runs. Each case below
   sets a distinctive value in the tile's own store, calls the tile's real
   wrapper, and captures what the engine actually received.
   ══════════════════════════════════════════════════════════════════ */
describe('values the tile holds arrive at the engine', () => {
  let win: any
  let run: (expr: string) => any

  beforeAll(async () => {
    const dom = new JSDOM(readFileSync(TILES[0], 'utf8'), {
      // a real origin: about:blank is opaque, and storage the tile touches
    // throws there — a setup that fails silently is a test proving nothing
    url: 'https://train.test/',
    runScripts: 'dangerously',
      pretendToBeVisual: true,
      beforeParse(w: any) {
        w.Vitality = {
          load: async () => ({
            unit: 'lb', submitted: false,
            session: { date: '1970-01-01', off: false, warmup: [], cooldown: [], ex: [] },
            history: {}, customLib: {}, exerciseNames: {},
            finishedDates: [], templates: [], shortTermGoal: '',
            photos: [], sessionDurations: [], liftGoals: [],
          }),
          save: () => {},
          read: async () => { throw new Error('no vitals') },
          classify: async () => { throw new Error('no_key') },
          getInsight: async () => { throw new Error('no_key') },
          generateWorkout: async () => { throw new Error('no_key') },
        }
        w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
        const noop = new Proxy({}, { get: () => () => noop })
      w.HTMLCanvasElement.prototype.getContext = () => noop
      },
    })
    await new Promise((r) => setTimeout(r, 700))
    win = dom.window
    run = (expr: string) => win.eval(expr)
  })

  /**
   * Every optional property set to a distinctive value, so a field that
   * arrives undefined at the engine cannot be mistaken for one the tile
   * simply never had.
   */
  const liftWithEverything = `
    STATE.customLib.probe = {
      equipment:'Machine', kind:'time', perSide:true, assisted:true,
      repRange:[7,11], incrementLb:7, incrementSeconds:15, incrementMetres:25,
    };
    STATE.exerciseNames.probe = 'probe';
    STATE.deloadExclusions = [{ from:'2026-01-01', to:'2026-01-09' }];
    STATE.deloadStates.probe = { state:'flagged', kind:'intensity', priorWeight:60,
                                 since:'2026-01-01', sessions:0, confidence:'measured' };
    var ex = { id:'probe', name:'probe', tier:2, sets:2, reps:5, kg:60, perHand:true,
               rest:90, lastKg:55, pinned:false, collapsed:false, deload:false, note:'',
               log:[{ kind:'time', s:60, assisted:true }, null] };
    curSession().ex = [ex];
  `

  const build = (expr: string) => run(`(function(){ ${liftWithEverything} return ${expr}; })()`)

  it('hands progression the stored kind, not a field that never existed', () => {
    expect(build('progressionInputFor(ex, prescription(ex))').kind).toBe('time')
  })

  it('hands progression the stored rep range', () => {
    expect(build('progressionInputFor(ex, prescription(ex))').repRange).toEqual([7, 11])
  })

  it('hands progression the stored assisted flag', () => {
    expect(build('progressionInputFor(ex, prescription(ex))').assisted).toBe(true)
  })

  it('hands progression a loading style derived from the equipment', () => {
    expect(build('progressionInputFor(ex, prescription(ex))').loading).toBe('stack')
  })

  it('hands progression every stored increment', () => {
    const arg = build('progressionInputFor(ex, prescription(ex))')
    expect(arg.incrementLb).toBe(7)
    expect(arg.incrementSeconds).toBe(15)
    expect(arg.incrementMetres).toBe(25)
  })

  it('hands progression the live deload record', () => {
    expect(build('progressionInputFor(ex, prescription(ex))').deload.state).toBe('flagged')
  })

  /**
   * The general form of the bug, rather than a list of its instances: the
   * tile has a value for all of these, so any of them arriving undefined is
   * a severed wire and not an omitted default.
   */
  it('leaves NO field undefined that the tile had a value for', () => {
    const arg = build('progressionInputFor(ex, prescription(ex))')
    const severed = ['kind', 'assisted', 'repRange', 'loading', 'incrementLb',
                     'incrementSeconds', 'incrementMetres', 'deload', 'reps', 'sets', 'kg', 'lastKg']
      .filter((f) => arg[f] === undefined || arg[f] === null)
    expect(severed).toEqual([])
  })

  it('hands plateau detection the stored exclusion windows', () => {
    expect(build('plateauOptsFor()').excluded).toEqual([{ from: '2026-01-01', to: '2026-01-09' }])
  })

  it('hands PR classification the logged set’s own kind and flags', () => {
    const c = build('prCandidateFor(ex, 0)')
    expect(c.kind).toBe('time')
    expect(c.seconds).toBe(60)
    expect(c.assisted).toBe(true)
  })

  it('hands the streak the configured target rather than a hardcoded one', () => {
    expect(run('(function(){ STATE.weeklyTarget = 6; return weeklyTarget(); })()')).toBe(6)
  })
})

/* ══════════════════════════════════════════════════════════════════
   4. Both paths that create an exercise validate it.

   The classifier path was wired and the coach path was not, which is how
   every coach-generated plank became a reps_weight lift.
   ══════════════════════════════════════════════════════════════════ */
describe('every path that creates an exercise validates it', () => {
  const logger = loggerOf(TILES[0])

  it('finds both creation paths', () => {
    expect(logger).toContain('function showApply')
    expect(logger).toContain('Vitality.classify')
  })

  it('validates in the classifier path', () => {
    const start = logger.indexOf('Vitality.classify')
    expect(logger.slice(start, start + 900)).toContain('normalizeClassification')
  })

  it('validates in the coach path, through the constrained planner', () => {
    // the coach path validates via planSession, which runs the same
    // normalizeClassification internally and enforces the session caps on
    // top of it — a superset of what the classifier path does
    expect(logger).toContain('TrainEngine.planSession(')
    const start = logger.indexOf('function showApply')
    const body = logger.slice(start, start + 1200)
    expect(body).toContain('plan.exercises')
  })

  it('never lets the coach path touch the raw model response', () => {
    const start = logger.indexOf('function showApply')
    const body = logger.slice(start, start + 1200)
    // the old bug: reading res.exercises[].name/sets straight into a lift
    expect(body).not.toMatch(/res\.exercises/)
    expect(body).not.toMatch(/info\.(name|tier|equipment)/)
  })

  it('builds every exercise definition through one installer', () => {
    expect(logger).toContain('function installExerciseDef')
    // CALLS, not the declaration — counting the definition is how this
    // assertion would pass while only one path actually used it
    const calls = (logger.match(/installExerciseDef\(/g) || []).length
      - (logger.match(/function installExerciseDef\(/g) || []).length
    expect(calls).toBeGreaterThanOrEqual(2)
  })

  it('has no path that writes a definition around the installer', () => {
    /* A direct customLib assignment is a second writer by another name.
       The installer's own lazy-init line is the one legitimate case, so
       its body is cut out before looking. */
    const start = logger.indexOf('function installExerciseDef')
    const outside = logger.slice(0, start) + logger.slice(logger.indexOf('function sessionExerciseFrom'))
    const direct = outside.match(/STATE\.customLib\[\w+\]\s*=\s*\{/g) || []
    expect(direct).toEqual([])
  })

  it('never builds an exercise straight off a raw model field', () => {
    // startingSets/Reps/Kg are the classifier's own field names; reading
    // them outside normalizeClassification means a path skipped validation
    expect(logger).not.toMatch(/info\.starting(Sets|Reps|Kg)/)
  })
})
