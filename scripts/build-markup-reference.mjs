#!/usr/bin/env node
/**
 * The tile's markup, as it actually renders.
 *
 * This is for a model that will write CSS against it, so accuracy of
 * class names and nesting is the entire point — which is why none of it
 * is hand-written. The tile is booted in jsdom, driven into each state,
 * and the real `outerHTML` of each surface is lifted out. A hand-copied
 * reference is a guess that gets stale silently; the contact sheet is
 * hand-built for exactly that reason and this file deliberately is not.
 *
 * WHAT IS STRIPPED: `style` attributes, `on*` handlers, `<script>`, and
 * the inlined engine bundle. WHAT IS KEPT: every class, every `data-*`
 * and every ARIA attribute, because those are styling hooks and a
 * selector written without them would not match.
 *
 * WHAT IS NOT PROMISED: this is one representative instance per surface,
 * not every permutation. Where a surface has states that change its
 * markup rather than just a class — a logged set row against an unlogged
 * one — each state is captured separately and labelled.
 *
 *   node scripts/build-markup-reference.mjs
 *
 * Output: docs/markup-reference.html — the current stylesheet inline, so
 * it renders exactly as the tile does today, followed by every surface
 * under a comment saying when the user sees it.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { JSDOM } from 'jsdom'

const TILE = 'public/tiles/train.html'
const OUT = 'docs/markup-reference.html'

const localToday = () => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
const dayBack = (back) => {
  const d = new Date()
  d.setDate(d.getDate() - back)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/* ---------------------------------------------------------------- *
 * A fixture rich enough that every surface has something to render.
 * ---------------------------------------------------------------- */

const lift = (id, name, over = {}) => ({
  id, name, tier: 2, sets: 3, reps: 5, kg: 185, perHand: false,
  rest: 90, lastKg: 180, pinned: false, collapsed: false, deload: false,
  note: '', log: [null, null, null], ...over,
})

function history(id, weeks, opts = {}) {
  const out = []
  let w = 140
  for (let i = weeks; i > 0; i--) {
    w += opts.flat ? 0 : 2.5
    out.push({
      date: dayBack(i * 7 + 1), kg: w,
      sets: [{ w, r: 5 }, { w, r: 5 }, { w, r: 5 }],
    })
  }
  return out
}

const state = () => ({
  unit: 'lb', submitted: false,
  session: {
    date: localToday(), off: false,
    warmup: [
      { text: 'Five minutes on the bike', done: true },
      { text: 'Band pull-aparts, two sets', done: false },
    ],
    cooldown: [{ text: 'Couch stretch, 90s a side', done: false }],
    ex: [
      lift('bench', 'Bench Press', { note: 'Left shoulder — keep elbows tucked.' }),
      lift('row', 'Barbell Row', { group: 'A' }),
      lift('squat', 'Back Squat', { collapsed: true, pinned: true }),
      lift('curl', 'Barbell Curl', { tier: 3 }),
    ],
  },
  history: {
    bench: history('bench', 30),
    row: history('row', 20),
    squat: history('squat', 26, { flat: true }),
    curl: history('curl', 12),
  },
  customLib: {
    bench: { equipment: 'Barbell', kind: 'reps_weight', incrementLb: 5,
      primary: [{ muscle: 'chest', share: 0.6 }, { muscle: 'triceps', share: 0.4 }],
      gist: 'A solid lift. Keep the reps clean and controlled.',
      steps: ['Set up tight', 'Move with control', 'Full range, every rep'],
      cues: ['Control the negative', 'Full range of motion'] },
    row: { equipment: 'Barbell', kind: 'reps_weight', incrementLb: 5, primary: [{ muscle: 'upper_back', share: 1 }] },
    squat: { equipment: 'Barbell', kind: 'reps_weight', incrementLb: 5, primary: [{ muscle: 'quads', share: 1 }] },
    curl: { equipment: 'Barbell', kind: 'reps_weight', incrementLb: 2.5, primary: [{ muscle: 'biceps', share: 1 }] },
  },
  exerciseNames: { bench: 'Bench Press', row: 'Barbell Row', squat: 'Back Squat', curl: 'Barbell Curl' },
  /* Every field here matters, and the reason is worth recording: the
     engine reads deload.sessions, deload.priorWeight and
     deload.confidence with no defaults, so a record missing any of them
     renders "deload, NaN of 2" or "holding NaN lb" straight into the
     card. A fixture shaped like a real record is the only way this
     reference shows what a user would see. */
  deloadStates: {
    squat: {
      state: 'deloading', since: dayBack(3), sessions: 0,
      kind: 'intensity', priorWeight: 205, confidence: 'measured',
    },
  },
  finishedDates: [dayBack(2), dayBack(4), dayBack(7), dayBack(9), dayBack(11), dayBack(14)],
  templates: [{ id: 't1', name: 'Push day', ex: [lift('bench', 'Bench Press')] }],
  shortTermGoal: 'Bench 225 for five',
  otherTraining: [{ date: dayBack(1), kind: 'run', minutes: 35, intensity: 'moderate' }],
  photos: [], sessionDurations: [{ date: dayBack(2), minutes: 58 }],
  liftGoals: [{ id: 'bench', target: 225, by: dayBack(-60) }],
  bodyweight: [{ date: dayBack(2), lb: 178 }],
})

/* ---------------------------------------------------------------- *
 * Cleaning and printing.
 * ---------------------------------------------------------------- */

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr'])

/** Strip the things a CSS author must not copy, keep the hooks. */
function clean(node) {
  const el = node.cloneNode(true)
  const walk = (n) => {
    if (n.nodeType !== 1) return
    n.removeAttribute('style')
    for (const attr of [...n.attributes]) {
      if (attr.name.startsWith('on')) n.removeAttribute(attr.name)
    }
    for (const kid of [...n.childNodes]) {
      if (kid.nodeType === 1 && kid.tagName === 'SCRIPT') kid.remove()
      else walk(kid)
    }
  }
  walk(el)
  return el
}

/** Indented HTML, so nesting is readable rather than one long line. */
function print(node, depth = 0) {
  const pad = '  '.repeat(depth)
  if (node.nodeType === 3) {
    const t = node.textContent.replace(/\s+/g, ' ').trim()
    return t ? pad + t + '\n' : ''
  }
  if (node.nodeType !== 1) return ''
  const tag = node.tagName.toLowerCase()
  const attrs = [...node.attributes].map((a) => ` ${a.name}="${a.value.replace(/"/g, '&quot;')}"`).join('')
  if (VOID.has(tag)) return `${pad}<${tag}${attrs} />\n`
  const kids = [...node.childNodes].map((k) => print(k, depth + 1)).join('')
  if (!kids) return `${pad}<${tag}${attrs}></${tag}>\n`
  /* An element whose only child is short text stays on one line — a
     <span class="pl">Swap</span> split across three lines is noise. */
  if (node.childNodes.length === 1 && node.firstChild.nodeType === 3) {
    const t = node.textContent.replace(/\s+/g, ' ').trim()
    if (t.length < 60) return `${pad}<${tag}${attrs}>${t}</${tag}>\n`
  }
  return `${pad}<${tag}${attrs}>\n${kids}${pad}</${tag}>\n`
}

const captured = []
const capture = (title, when, node) => {
  if (!node) { captured.push({ title, when, html: null }); return }
  captured.push({ title, when, html: print(clean(node)).trimEnd() })
}

/* ---------------------------------------------------------------- *
 * Boot and drive.
 * ---------------------------------------------------------------- */

const source = readFileSync(TILE, 'utf8')
const css = /<style[^>]*>([\s\S]*?)<\/style>/.exec(source)[1]

const dom = new JSDOM(source, {
  url: 'https://train.test/',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  beforeParse(w) {
    w.Vitality = {
      load: async () => state(),
      save: () => {},
      read: async () => { throw new Error('no vitals') },
      classify: async () => { throw new Error('no_key') },
      getInsight: async () => { throw new Error('no_key') },
      generateWorkout: async () => { throw new Error('no_key') },
    }
    w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
    const noop = new Proxy({}, { get: () => () => noop })
    w.HTMLCanvasElement.prototype.getContext = () => noop
    /* jsdom has no SVG geometry. The checklist measures its scribble path
       to animate the strike-through, and the rest ring measures itself. */
    if (w.SVGElement) w.SVGElement.prototype.getTotalLength = () => 100
    if (w.SVGGraphicsElement) w.SVGGraphicsElement.prototype.getTotalLength = () => 100
  },
})

await new Promise((r) => setTimeout(r, 900))
const win = dom.window
const doc = win.document
const run = (expr) => win.eval(expr)
const $ = (sel) => doc.querySelector(sel)

/* ---- the static skeleton, from the file rather than the DOM -------- */
{
  const stripped = source
    .replace(/<!-- TRAIN-ENGINE:START -->[\s\S]*?<!-- TRAIN-ENGINE:END -->/, '    <!-- engine bundle removed -->')
    .replace(/<script[\s\S]*?<\/script>/g, '    <!-- script removed -->')
    .replace(/<style[\s\S]*?<\/style>/g, '    <!-- stylesheet removed; it is inlined at the top of this file -->')
  captured.push({
    title: 'The static skeleton',
    when: 'Always. Everything else is rendered into these containers by JS.',
    html: stripped.replace(/\n{3,}/g, '\n\n').trim(),
  })
}

/* ---- session surfaces --------------------------------------------- */
run("setSessionMode('training'); render();")
/* Targeted by data-id, not by position. The pinned lift sorts first, so
   indexing the card list captured the wrong exercise. */
capture('Lift card — training mode', 'Every session, by default. Only Swap renders; grip, eye, pin, menu, History, Tune, What if and Warm-up are not in the DOM at all.', $('#exwrap .ex[data-id="bench"]'))
capture('Set row — unlogged', 'Every prescribed set that has not been logged. Carries the reason line and the last-session line under the first unlogged set only.', $('#exwrap .ex[data-id="bench"] .pillWrap'))

run("setSessionMode('edit'); render();")
capture('Lift card — edit mode', 'After tapping "Edit session". The full control set returns.', $('#exwrap .ex[data-id="bench"]'))
capture('Lift card — collapsed', 'After the eye is tapped in edit mode. The body is still in the DOM; .collapsed hides it.', $('#exwrap .ex[data-id="squat"]'))
capture('Lift card — superset member', 'When two lifts are linked. The group letter renders as .groupTag.', $('#exwrap .ex[data-id="row"]'))

/* Driven through the real controls rather than by assigning to ex.log,
   so the captured markup is what the logging path actually produces. */
run(`
  (function(){
    setSessionMode('training');
    var card = document.querySelector('#exwrap .ex[data-id="bench"]');
    var groups = card.querySelectorAll('.pillWrap');
    groups[0].querySelector('.pillHit').click();
    groups[1].querySelector('.pillMiss').click();
    /* Log first, THEN flag. The W control toggles s.warmup on a logged
       set; clicking it on an unlogged row does nothing. */
    card.querySelectorAll('.pillWrap')[2].querySelector('.pillHit').click();
    card.querySelectorAll('.pillWrap')[2].querySelector('[data-act="warmup"]').click();
    var first = card.querySelectorAll('.pillWrap')[0];
    var drop = first.querySelector('.pillDrop'); if (drop) drop.click();
    var ex = curSession().ex[0];
    if (ex.log[0]) ex.log[0].rpe = 8.5;
    render();
    return true;
  })()`)
const rows = doc.querySelectorAll('#exwrap .ex[data-id="bench"] .pillWrap')
capture('Set row — logged, with a drop set and an RPE', 'After tapping "Hit it". The row gains a status, a drop button, an undo, and the RPE control; the drop row renders beneath it.', rows[0])
capture('Set row — missed', 'After tapping "Miss", or logging zero reps.', rows[1])
capture('Set row — warm-up', 'When the W flag is on. Kept in history, excluded from volume, PRs and progression.', rows[2])

run("startRest && startRest(curSession().ex[0]); render();")
capture('Rest bar', 'Inside a card while that lift’s timer runs. .over flips the whole bar once the time passes zero.', $('#exwrap .restSlot .restbar') || $('.restbar'))

capture('Warm-up checklist', 'Above the exercise list, every session. Ticked mid-session.', $('#warmupSlot'))
capture('Session header and hero', 'Always, at the top of the session sheet.', $('#sheet .trainBar'))
capture('Day dots', 'Always, unless the day is a rest day. One dot per lift, four states.', $('#daydots'))
capture('Progress ring', 'Always, unless the day is a rest day.', $('#progress'))
capture('Status rail', 'Always, above the sheet.', $('#statusRail'))
capture('Top sticker and note bar', 'Always, fixed at the top. Three slots rotate on staggered intervals.', $('#topSticker'))
capture('Mini stats strip', 'Always.', $('#miniStats'))
capture('Finish row', 'Always, at the foot of the session sheet. Disabled until one set is logged.', $('#finishBtn')?.parentElement)

/* ---- dialogs ------------------------------------------------------- */
const DIALOGS = [
  ['openSettings()', 'Settings', 'The gear in the header.'],
  ['openForm(curSession().ex[0])', 'Form notes', 'The lift name, or the i beside it, in edit mode.'],
  ['openTune(curSession().ex[0])', 'Tune', 'The Tune pill on a card, edit mode only.'],
  ['openSwap(curSession().ex[0])', 'Swap', 'The Swap pill on a card. Renders in both modes.'],
  ['openSwap(null)', 'Add a lift', 'The add button at the foot of the exercise list.'],
  ['openHistory(curSession().ex[0])', 'History', 'The History pill, edit mode only.'],
  ['openRpe(curSession().ex[0], 0)', 'RPE', 'The RPE control on a logged set.'],
  ['openMenu(curSession().ex[0], curSession(), document.querySelector(".menuBtn")||document.body)', 'Card overflow menu', 'The ⋯ on a card, edit mode only.'],
  ['openTrim()', 'Trim today', 'Offered when the session is long and time is short.'],
  ['openOtherTraining()', 'Other training', 'Logging a run, a sport, anything that is not lifting.'],
  ['openTodayEquipment()', 'Today’s equipment', 'When the usual kit is not available.'],
  ['openRoutines()', 'Routines', 'Named days.'],
  ['openImport()', 'Import history', 'From Hevy or Strong.'],
  ['openBackdate()', 'Backdate a session', 'Logging a day that was missed.'],
  ['openMergeTool()', 'Merge duplicate lifts', 'When the same lift has two histories.'],
  ['openGoalEdit()', 'Short-term goal', 'The goal pill on the goal sheet.'],
  ['openOnboarding()', 'Onboarding', '400ms after first boot, and from Settings.'],
]
for (const [call, title, when] of DIALOGS) {
  try {
    run('closePop && closePop();')
    run(call)
    const pop = $('#popRoot .pop') || $('#popRoot .menuPop')
    capture(`Dialog — ${title}`, when, pop)
  } catch (err) {
    captured.push({ title: `Dialog — ${title}`, when, html: null, error: err.message })
  }
}
run('closePop && closePop();')

/* ---- progress views ------------------------------------------------ */
const VIEWS = [
  ['__e1rm', 'Strength'], ['__muscles', 'Muscles'], ['__consistency', 'Consistency'],
  ['__compare', '8 vs 8'], ['__sessions', 'Calendar'], ['__volume', 'Volume'],
  ['__records', 'Records'], ['__goals', 'Goals'], ['bench', 'A single lift'],
]
capture('Progress sheet — overview cards and chips', 'The Progress sheet, always.', $('#statsSheet'))
for (const [id, label] of VIEWS) {
  try {
    run(`statsView = { id: ${JSON.stringify(id)} }; renderStatsPicker(); drawStatsSection();`)
    capture(`Progress view — ${label}`, `The Progress sheet with the "${label}" chip selected.`, $('#statsPlot'))
  } catch (err) {
    captured.push({ title: `Progress view — ${label}`, when: '', html: null, error: err.message })
  }
}

capture('Goal sheet', 'Always, second sheet in the scroll.', $('#goalSheet'))
capture('Photos sheet', 'Always, third sheet in the scroll.', $('#photosSheet'))
capture('Coach button', 'Always, unless the day is marked a rest day.', $('#coachFab'))

try {
  run('openCoach();')
  capture('Coach overlay', 'After tapping the coach button.', $('#coachRoot .coachMorph'))
} catch (err) {
  captured.push({ title: 'Coach overlay', when: '', html: null, error: err.message })
}
capture('Celebration overlay', 'On a new best. Auto-dismisses after 1650ms.', $('#celebrate'))

/* ---------------------------------------------------------------- *
 * Write it out.
 * ---------------------------------------------------------------- */

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const missing = captured.filter((c) => !c.html)

const body = captured.map(({ title, when, html, error }) => `
<section class="mr-surface">
  <h2 class="mr-title">${esc(title)}</h2>
  <p class="mr-when">${esc(when)}</p>
${html
    ? `  <div class="mr-live">\n${html}\n  </div>\n  <details class="mr-src"><summary>markup</summary><pre>${esc(html)}</pre></details>`
    : `  <p class="mr-missing">NOT CAPTURED${error ? ` — ${esc(error)}` : ''}</p>`}
</section>`).join('\n')

const page = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Train — markup reference</title>
<!--
  GENERATED by scripts/build-markup-reference.mjs. Do not edit by hand.

  Every block below was lifted from the tile running in jsdom, not typed
  out — so the class names and the nesting are what actually renders.
  Stripped: style attributes, on* handlers, <script>. Kept: every class,
  every data-* and every ARIA attribute, because those are styling hooks.

  The stylesheet below is the tile's, verbatim, so this page renders as
  the tile does today.
-->
<style>${css}</style>
<style>
  body { margin:0; background:var(--e0); color:var(--text); font-family:var(--sans); }
  .mr-page { max-width:1000px; margin:0 auto; padding:32px 20px 120px; }
  .mr-head { font:700 26px/1.2 var(--sans); margin:0 0 6px; }
  .mr-lede { font:400 14px/1.6 var(--sans); color:var(--muted); max-width:70ch; margin:0 0 6px; }
  .mr-surface { margin:52px 0 0; }
  .mr-title { font:600 13px/1 var(--sans); letter-spacing:.14em; text-transform:uppercase;
              color:var(--muted); margin:0 0 6px; padding-bottom:10px; border-bottom:1px solid var(--hair); }
  .mr-when { font:400 13px/1.5 var(--sans); color:var(--muted-2); margin:0 0 18px; max-width:70ch; }
  .mr-live { margin-bottom:12px; }
  .mr-src summary { font:500 11px/1 var(--mono); letter-spacing:.06em; text-transform:uppercase;
                    color:var(--muted-2); cursor:pointer; padding:6px 0; }
  .mr-src pre { font:400 12px/1.5 var(--mono); color:var(--muted); background:var(--e1);
                border:1px solid var(--hair); border-radius:8px; padding:14px; overflow-x:auto; }
  .mr-missing { font:400 13px/1.5 var(--sans); color:var(--fail); }
</style>
</head>
<body>
<div id="vt-backdrop" aria-hidden="true">
  <div class="wb-atmosphere"></div><div class="wb-mist"></div><div class="wb-particles"></div>
</div>
<div class="mr-page">
  <h1 class="mr-head">Train — markup reference</h1>
  <p class="mr-lede">Structure only. Every block was lifted from the tile running in a real DOM, so the
  class names and nesting are exactly what renders. Each surface shows live, then its source under
  <em>markup</em>.</p>
  <p class="mr-lede">Stripped: <code>style</code> attributes, <code>on*</code> handlers, scripts.
  Kept: classes, <code>data-*</code> and ARIA, because those are selector hooks.</p>
${body}
</div>
</body>
</html>
`

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, page)
console.log(`markup reference → ${OUT} (${page.length} bytes, ${captured.length} surfaces)`)
if (missing.length) {
  console.log(`\n  NOT CAPTURED (${missing.length}):`)
  for (const m of missing) console.log(`    ${m.title}${m.error ? ` — ${m.error}` : ''}`)
}
dom.window.close()
