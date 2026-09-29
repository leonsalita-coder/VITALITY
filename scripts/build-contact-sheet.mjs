#!/usr/bin/env node
/**
 * The contact sheet: every primitive, every state, one page.
 *
 * Nine primitives cannot be reviewed by hunting through the app — the
 * popup shell alone serves twenty dialogs, and half the states (disabled,
 * failed, warm-up, deload, over-time) need a session in exactly the right
 * condition to appear at all.
 *
 * IT CANNOT DRIFT, which is the only reason it is worth having. The
 * <style> block is copied VERBATIM from public/tiles/train.html at build
 * time and a test asserts the copy is byte-identical. A contact sheet
 * with its own stylesheet is a lie that gets more convincing over time.
 *
 * The page adds structural CSS of its own — grid, labels, section rules —
 * under a `cs-` prefix. A test asserts that block never targets a tile
 * class, so the sheet can lay itself out without quietly restyling the
 * thing it is supposed to be showing.
 *
 * Pseudo-states are NOT faked. hover, active and focus-visible are shown
 * by real interactive instances you hover and tab through; there is no
 * `.is-hover` helper, because a helper would be the contact sheet's own
 * CSS pretending to be the tile's.
 *
 *   node scripts/build-contact-sheet.mjs
 *
 * Output: docs/contact-sheet.html — open it in a browser. Not shipped in
 * the tile, not loaded by it, referenced by nothing at runtime.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const TILE = 'public/tiles/train.html'
const OUT = 'docs/contact-sheet.html'

/** The tile's stylesheet, verbatim. Never edited, never reformatted. */
export function tileCss(source = readFileSync(TILE, 'utf8')) {
  const m = /<style[^>]*>([\s\S]*?)<\/style>/.exec(source)
  if (!m) throw new Error(`no <style> block in ${TILE}`)
  return m[1]
}

/** Structural CSS for the sheet itself. Must never name a tile class. */
const SHEET_CSS = `
  .cs-page { max-width:1100px; margin:0 auto; padding:32px 20px 120px; }
  .cs-title { font:600 26px/1.2 var(--sans); color:var(--text); margin:0 0 4px; }
  .cs-lede { font:400 14px/1.5 var(--sans); color:var(--muted); margin:0 0 8px; max-width:60ch; }
  .cs-sec { margin:56px 0 0; }
  .cs-sec > h2 { font:600 13px/1 var(--sans); letter-spacing:.14em; text-transform:uppercase;
                 color:var(--muted); margin:0 0 6px; padding-bottom:10px; border-bottom:1px solid var(--hair); }
  .cs-note { font:400 13px/1.5 var(--sans); color:var(--muted); margin:10px 0 18px; max-width:70ch; }
  .cs-grid { display:grid; gap:18px; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); align-items:start; margin-top:18px; }
  .cs-cell { display:flex; flex-direction:column; gap:8px; min-width:0; }
  .cs-lbl { font:500 11px/1 var(--mono); letter-spacing:.06em; color:var(--muted-2); text-transform:uppercase; }
  .cs-stack { display:flex; flex-direction:column; gap:14px; margin-top:18px; }
  .cs-row { display:flex; flex-wrap:wrap; gap:12px; align-items:center; margin-top:18px; }
  .cs-swatch { height:54px; border-radius:8px; border:1px solid var(--hair); }
  .cs-mono { font:400 12px/1.5 var(--mono); color:var(--muted); }
  .cs-warn { font:400 13px/1.5 var(--sans); color:var(--fail); margin:10px 0 0; }
  .cs-ruler { background:var(--muted-2); height:10px; border-radius:2px; }
  .cs-box { border:1px solid var(--hair); border-radius:8px; padding:16px; }
  .cs-kbd { font:500 11px/1 var(--mono); border:1px solid var(--hair-strong); border-radius:4px;
            padding:3px 5px; color:var(--text); }
  /* A transformed ancestor makes position:fixed resolve against it, so an
     overlay can be shown in place instead of taking over the page. */
  .cs-stage { position:relative; transform:translateZ(0); height:340px; overflow:hidden;
              border:1px solid var(--hair); border-radius:8px; }
`

const TOKEN_GROUPS = [
  ['elevation', ['--e0', '--e1', '--e2', '--e3', '--e4', '--hair', '--hair-strong']],
  ['signal', ['--signal', '--signal-ink', '--gold', '--fail']],
  ['text', ['--text', '--muted', '--muted-2']],
]
const SPACING = ['--sp1', '--sp2', '--sp3', '--sp4', '--sp5', '--sp6', '--sp7', '--sp8', '--sp9']
const RADII = ['--r-sm', '--r-md', '--r-lg', '--r-pill']
const MOTION = ['--d1', '--d2', '--d3', '--d4', '--d5']

const cell = (label, html) => `<div class="cs-cell"><div class="cs-lbl">${label}</div>${html}</div>`
const sec = (id, title, note, html) =>
  `<section class="cs-sec" id="${id}"><h2>${title}</h2>${note ? `<p class="cs-note">${note}</p>` : ''}${html}</section>`

/* ---------------------------------------------------------------- *
 * The set row, assembled the way renderPill assembles it.
 * ---------------------------------------------------------------- */

const inputs = (bump = false) =>
  `<input class="pillInput w${bump ? ' bump' : ''}" type="number" inputmode="decimal" value="185" aria-label="Weight — 45 + 25 per side" />`
  + `<span class="pillUnit">lb</span><span class="pillTimes">×</span>`
  + `<input class="pillInput r" type="number" inputmode="numeric" value="5" aria-label="Reps" />`

const sideInputs = () =>
  `<span class="pillSide">L</span><input class="pillInput lw" type="number" inputmode="decimal" value="60" aria-label="Left weight" />`
  + `<span class="pillTimes">×</span><input class="pillInput lrp" type="number" inputmode="numeric" value="8" aria-label="Left reps" />`
  + `<span class="pillSide">R</span><input class="pillInput rw" type="number" inputmode="decimal" value="55" aria-label="Right weight" />`
  + `<span class="pillTimes">×</span><input class="pillInput rrp" type="number" inputmode="numeric" value="7" aria-label="Right reps" />`

const flagBtns = ({ warm = false, sides = false, amrap = false, rpe = null } = {}) =>
  `<button class="pillWarm${warm ? ' on' : ''}" aria-pressed="${warm}" title="Warm-up — kept in history, excluded from volume, PRs and progression">W</button>`
  + (sides ? `<button class="pillWarm on" aria-pressed="true" title="Log each side separately.">L/R</button>` : '')
  + (amrap ? `<button class="pillWarm on" aria-pressed="true" title="AMRAP — taken to failure.">A</button>` : '')
  + (rpe !== null ? `<button class="pillWarm on" title="How hard was that set? Optional.">${rpe}</button>` : '')

const unloggedRow = ({ idx = 'I', bump = false, near = null, warm = false, sides = false, amrap = false } = {}) =>
  `<div class="pill tappable"><span class="pillIdx">${idx}</span>`
  + `<span class="pillValue">${sides ? sideInputs() : inputs(bump)}</span>`
  + `<span class="pillSpacer"></span><div class="pillActions">${flagBtns({ warm, sides, amrap })}`
  + (near ? `<span class="pillNear">${near}</span>` : '')
  + `<button class="pillHit" aria-label="Log set">Hit it →</button><button class="pillMiss" aria-label="Mark missed">Miss</button></div></div>`

const loggedRow = ({ idx = 'I', kind = 'done', status = 'done', pr = null, warm = false, rpe = null } = {}) =>
  `<div class="pill ${kind}${warm ? ' warmup' : ''}"><span class="pillIdx">${idx}</span>`
  + `<span class="pillValue">${inputs()}</span><span class="pillSpacer"></span><div class="pillActions">`
  + flagBtns({ warm, rpe })
  + `<span class="pillStatus">`
  + (pr === 'e1rm' ? '<span class="pillPr">★ </span>' : '')
  + (pr === 'dot' ? '<span class="pillPrDot" title="Heaviest yet"></span>' : '')
  + `${status}</span>`
  + (kind === 'done' ? '<button class="pillDrop" aria-label="Add drop set">+ Drop</button>' : '')
  + `<button class="pillReset" aria-label="Undo set">↺</button></div></div>`

const dropRow = () =>
  `<div class="drops"><div class="dropRow"><span class="dropArrow">↳</span>`
  + `<input class="pillInput w small" type="number" inputmode="decimal" value="135" aria-label="Drop weight" />`
  + `<span class="pillUnit">lb</span><span class="pillTimes">×</span>`
  + `<input class="pillInput r small" type="number" inputmode="numeric" value="8" aria-label="Drop reps" />`
  + `<button class="dropX" aria-label="Remove drop">×</button></div></div>`

/* The on-state rules are scoped to #moonbtn and .deloadRow — a bare
   .bouncyToggle matches neither, so the sheet showed a switch whose two
   states were identical and it read as a design fault rather than a
   fixture one. The id is unique per page, so only the live one carries
   it and the others use the .deloadRow scope the card menu uses. */
const switchHtml = (on, mini = false, live = false) =>
  `<div class="${mini ? 'deloadRow' : 'bouncyRow'}${on ? ' on' : ''}">`
  + `<span class="bouncyLabel${on ? ' on' : ''}">${mini ? 'Deload this lift' : 'Rest day'}</span>`
  + `<button class="bouncyToggle${on ? ' on' : ''}"${live ? ' id="moonbtn"' : ''} role="switch" aria-checked="${on}" title="Mark today a rest day">`
  + `<span class="bouncyTrack${mini ? ' mini' : ''}"><span class="bouncyThumb"><span class="bouncyDot">🌙</span></span></span></button></div>`

const stepper = (value) =>
  `<div class="stepper"><button class="step minus" data-t="-1">−</button>`
  + `<span class="stepVal">${value}</span><button class="step" data-t="1">+</button></div>`

const swapItem = (name, meta, on = false) =>
  `<button class="swapItem${on ? ' on' : ''}"><span class="nm">${name}</span><span class="mu">${meta}</span></button>`

const noteCard = (type, emoji, text) =>
  `<div class="noteCard note-${type}"><span class="noteDot"></span><span class="noteEmo">${emoji}</span><span class="noteTxt">${text}</span></div>`

const restBar = (over) =>
  `<div class="restbar${over ? ' over' : ''}"><button class="restStep" data-d="-15">−15</button>`
  + `<div class="restMid"><svg class="restRing" viewBox="0 0 36 36" aria-hidden="true">`
  + `<circle class="restRingTrack" cx="18" cy="18" r="15"/>`
  + `<circle class="restRingFill" cx="18" cy="18" r="15" style="stroke-dasharray:94.2;stroke-dashoffset:${over ? 0 : 30}"/></svg>`
  + `<div class="restTime">${over ? '+0:12' : '1:24'}</div><div class="restLabel">Bench Press</div></div>`
  + `<button class="restStep" data-d="15">+15</button><button class="restX" aria-label="Dismiss">×</button></div>`

const liftCard = (edit) =>
  `<div class="ex"><div class="exHead">`
  + (edit ? `<button class="grip" aria-label="Drag to reorder">⠿</button>` : '')
  + (edit ? `<button class="exEye" aria-label="Hide">👁</button>` : '')
  + (edit
    ? `<button class="exName"><span class="nameTxt">Bench Press</span><span class="exInfo" aria-label="Form notes">i</span></button>`
    : `<div class="exName"><span class="nameTxt">Bench Press</span></div>`)
  + (edit ? `<button class="pinBtn" aria-label="Pin to top">☆</button>` : '')
  + (edit ? `<button class="menuBtn" aria-label="More">⋯</button>` : '')
  + `</div><div class="exMeta"><span>compound</span><span class="metaSep">·</span><span>3 × 5</span>`
  + `<span class="metaSep">·</span><span>last 185 lb</span>`
  + `<span class="deloadTag" title="Two sessions flat, so the load steps back.">deloading</span>`
  + `<span class="groupTag">superset A</span></div>`
  + `<div class="exNote"><span class="ndot">•</span><span>Left shoulder — keep elbows tucked.</span></div>`
  + `<div class="exActions"><button class="actionPill"><span class="pl">Swap</span></button>`
  + (edit ? `<button class="actionPill"><span class="pl">History</span></button>
             <button class="actionPill"><span class="pl">Tune</span></button>
             <button class="actionPill"><span class="pl">What if</span></button>` : '')
  + `</div><div class="restSlot"></div><div class="pills"></div></div>`

/* ---------------------------------------------------------------- *
 * The page.
 * ---------------------------------------------------------------- */

export function contactSheet(css = tileCss()) {
  /* Flat: a label row, then a grid of swatches. The first version nested
     a .cs-grid inside a .cs-cell inside a .cs-stack, and the nesting
     overlapped one of the labels. */
  const tokenSwatches = TOKEN_GROUPS.map(([group, names]) =>
    `<div class="cs-lbl" style="margin-top:22px">${group}</div>`
    + `<div class="cs-grid">`
    + names.map((n) => cell(n, `<div class="cs-swatch" style="background:var(${n})"></div>`)).join('')
    + `</div>`).join('')

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Train — contact sheet</title>
<!-- GENERATED by scripts/build-contact-sheet.mjs. Do not edit by hand. -->
<!-- CSS BELOW IS COPIED VERBATIM FROM public/tiles/train.html -->
<style>${css}</style>
<style>${SHEET_CSS}</style>
</head>
<body>
<div id="vt-backdrop" aria-hidden="true">
  <div class="wb-atmosphere"></div>
  <div class="wb-mountains"><svg viewBox="0 0 1600 420" preserveAspectRatio="none"><path d="M0,300 L320,180 L680,210 L1100,180 L1600,220 L1600,420 L0,420 Z" fill="#0d1a17"/></svg></div>
  <div class="wb-mist"></div><div class="wb-particles"></div>
</div>
<div class="cs-page">
  <h1 class="cs-title">Train — contact sheet</h1>
  <p class="cs-lede">Every primitive, every state that a class or attribute can express. The stylesheet
  is copied verbatim from the tile, so this page cannot drift from what ships.</p>
  <p class="cs-lede">Hover, active and focus-visible are <strong>not simulated</strong> — the instances below are
  real. Hover them; press <span class="cs-kbd">Tab</span> to walk focus through the page.</p>

${sec('tokens', '1 · Tokens', 'Everything below resolves from this block. A light mode should be a swap here and nothing else.', `
  ${tokenSwatches}
  <div class="cs-cell" style="margin-top:22px"><div class="cs-lbl">spacing ladder</div>
    <div class="cs-stack">${SPACING.map((n) => `<div class="cs-cell"><div class="cs-lbl">${n}</div><div class="cs-ruler" style="width:var(${n})"></div></div>`).join('')}</div>
  </div>
  <div class="cs-grid" style="margin-top:22px">
    ${RADII.map((n) => cell(n, `<div class="cs-swatch" style="background:var(--e3);border-radius:var(${n})"></div>`)).join('')}
  </div>
  <div class="cs-grid" style="margin-top:22px">
    ${cell('--sans', '<div style="font:400 16px/1.4 var(--sans);color:var(--text)">Hit it — 185 lb × 5</div>')}
    ${cell('--serif', '<div style="font:400 16px/1.4 var(--serif);color:var(--text)">Hit it — 185 lb × 5</div>')}
    ${cell('--mono', '<div style="font:400 16px/1.4 var(--mono);color:var(--text)">185 × 5 · 1:24</div>')}
    ${cell('.num (tabular)', '<div class="num" style="font:400 16px/1.4 var(--mono);color:var(--text)">1111 / 8888</div>')}
  </div>
  <div class="cs-row">${MOTION.map((n) => `<span class="cs-mono">${n}</span>`).join('')}</div>
`)}

${sec('popup', '2 · Popup shell', 'Serves twenty dialogs. The header must hold while the body scrolls.', `
  <div class="cs-stack">
    <div class="scrim" style="position:relative;inset:auto">
      <div class="pop" role="dialog" aria-modal="true">
        <div class="popHead"><div><div class="eyebrow">How hard was that?</div><div class="popTitle">RPE — optional</div></div>
        <button class="popX" aria-label="Close">×</button></div>
        <p class="formGist">10 is nothing left. 7 is about three reps in reserve. Skip it if you would rather not guess.</p>
        <div class="swapList">${swapItem('RPE 8', '2 left')}${swapItem('RPE 9', '1 left', true)}${swapItem('RPE 10', 'all out')}</div>
        <div class="popBtns"><button class="pbtn ghost">Skip</button><button class="pbtn save">Save</button></div>
      </div>
    </div>
  </div>
`)}

${sec('button', '3 · Button', 'finishBtn has a real disabled state — locked until a set is logged.', `
  <div class="cs-grid">
    ${cell('pbtn save', '<button class="pbtn save">Save</button>')}
    ${cell('pbtn ghost', '<button class="pbtn ghost">Download a full backup</button>')}
    ${cell('pbtn danger', '<button class="pbtn danger">Remove from day</button>')}
    ${cell('pbtn disabled', '<button class="pbtn save" disabled>Save</button>')}
    ${cell('actionPill', '<button class="actionPill"><span class="pl">Swap</span></button>')}
    ${cell('finishBtn', '<button class="finishBtn">Finish session</button>')}
    ${cell('finishBtn disabled', '<button class="finishBtn" disabled>Finish session</button>')}
    ${cell('finishBtn locked', '<button class="finishBtn locked">Re-lock session</button>')}
    ${cell('freshbtn', '<button class="freshbtn">Start fresh</button>')}
    ${cell('wcAddBtn', '<button class="wcAddBtn">+</button>')}
    ${cell('cvSend', '<button class="cvSend" aria-label="Send">↑</button>')}
    ${cell('photoX', '<button class="photoX" title="Export CSV">Export ⇩</button>')}
  </div>
`)}

${sec('input', '4 · Input', 'The set-row variant is the one that matters: large, one-handed, numeric.', `
  <div class="cs-grid">
    ${cell('pillInput w + r', `<span class="pillValue">${inputs()}</span>`)}
    ${cell('pillInput bump', `<span class="pillValue">${inputs(true)}</span>`)}
    ${cell('pillInput L/R', `<span class="pillValue">${sideInputs()}</span>`)}
    ${cell('pillInput sec', '<span class="pillValue"><input class="pillInput sec" type="number" inputmode="numeric" value="60" aria-label="Seconds" /><span class="pillUnit">s</span></span>')}
    ${cell('pillInput met', '<span class="pillValue"><input class="pillInput met" type="number" inputmode="numeric" value="400" aria-label="Metres" /><span class="pillUnit">m</span></span>')}
    ${cell('pillInput /ea', '<span class="pillValue"><input class="pillInput w" type="number" inputmode="decimal" value="40" aria-label="Weight" /><span class="pillUnit">lb<span class="pillPerHand">/ea</span></span></span>')}
    ${cell('pillInput small', dropRow())}
    ${cell('pillInput empty', '<span class="pillValue"><input class="pillInput w" type="number" inputmode="decimal" value="" placeholder="0" aria-label="Weight" /></span>')}
    ${cell('pillInput disabled', '<span class="pillValue"><input class="pillInput w" type="number" value="185" disabled aria-label="Weight" /></span>')}
    ${cell('wInput + field label', '<div class="field"><span class="lbl">Weight</span><input class="wInput" type="number" inputmode="decimal" step="0.5" value="185" /><span class="wUnit">lb</span></div>')}
    ${cell('wcIn', '<div class="wcAdd"><input class="wcIn" placeholder="Add item" /><button class="wcAddBtn">+</button></div>')}
    ${cell('searchRow', '<div class="searchRow"><input placeholder="e.g. Zercher squat, 5k run" autocomplete="off" /></div>')}
  </div>
`)}

${sec('switch', '5 · Switch', 'role="switch" with aria-checked. On and off must differ without relying on colour.', `
  <div class="cs-grid">
    ${cell('off', switchHtml(false))}
    ${cell('on — live (#moonbtn)', switchHtml(true, false, true))}
    ${cell('mini — off', switchHtml(false, true))}
    ${cell('mini — on', switchHtml(true, true))}
  </div>
`)}

${sec('stepper', '6 · Stepper', 'Tune’s Top reps reads "off" rather than a number, so the value slot has to hold a word.', `
  <div class="cs-grid">
    ${cell('number', stepper('3'))}
    ${cell('word', stepper('off'))}
    ${cell('time', stepper('1:30'))}
    ${cell('in a row', `<div class="settingsRow"><span class="bouncyLabel on">Target</span>${stepper('4')}</div>`)}
  </div>
`)}

${sec('row', '7 · Selectable row', 'Primary label plus muted secondary — match %, unit, reps-in-reserve gloss.', `
  <div class="cs-stack">
    <div class="swapList">
      ${swapItem('Incline Bench Press', '92% match')}
      ${swapItem('Dumbbell Bench Press', '88% match', true)}
      ${swapItem('Weight × reps', 'lb × reps')}
      ${swapItem('Time only', 'seconds')}
    </div>
    <p class="emptyHist">No saved templates yet.</p>
  </div>
`)}

${sec('chip', '8 · Chip', 'Selected state is load-bearing — it is the only indication of which Progress view is showing.', `
  <div class="cs-stack">
    <div class="chipRow">
      <button class="chip on">Strength</button><button class="chip">Muscles</button>
      <button class="chip">Consistency</button><button class="chip">8 vs 8</button>
      <button class="chip">Calendar</button><button class="chip">Volume</button>
      <button class="chip">Records</button><button class="chip">Goals</button>
    </div>
    <div class="range"><button class="chip on">4w</button><button class="chip">12w</button><button class="chip">1y</button><button class="chip">All</button><span class="rangeInd"></span></div>
    <div class="formCues"><span class="cuePill">Control the negative</span><span class="cuePill">Full range of motion</span></div>
    <div class="formMuscles"><span class="primary">chest</span><span class="metaSep">·</span><span class="secondary">triceps</span></div>
  </div>
`)}

${sec('card', '9 · Card', 'One elevation and radius system, not six.', `
  <div class="cs-stack">
    ${cell('ex — training mode (Swap only)', liftCard(false))}
    ${cell('ex — edit mode (full controls)', liftCard(true))}
  </div>
  <div class="cs-grid">
    ${cell('miniCard', '<div class="statStrip"><div class="miniCard"><b>128</b><span>Sessions</span></div><div class="miniCard"><b class="gold">6</b><span>wk streak</span></div></div>')}
    ${cell('ovCard', '<div class="ovCard"><div class="ovNum">128</div><div class="ovLbl">Sessions</div><div class="ovDesc"><b>+2</b> vs last week</div></div>')}
    ${cell('chart-card', '<div class="chart-card"><div class="plot" style="height:90px"></div><div class="delta-cap">+12 lb over 8 weeks</div></div>')}
    ${cell('photoCard', '<div class="photoCard"><div class="photoImg photoImg--pending skeleton-shimmer" style="height:120px"></div></div>')}
  </div>
  <div class="cs-cell" style="margin-top:22px"><div class="cs-lbl">noteCard — four types</div>
    <div class="noteBar">
      <div class="noteSlot">${noteCard('gold', '★', 'Heaviest bench yet — 195 for 5.')}</div><div class="noteDiv"></div>
      <div class="noteSlot">${noteCard('mint', '✓', 'Three weeks running at 4+ sessions.')}</div><div class="noteDiv"></div>
      <div class="noteSlot">${noteCard('plain', '·', 'Chest took 26 hard sets this week.')}</div>
    </div>
    <div class="noteBar" style="margin-top:10px"><div class="noteSlot">${noteCard('fail', '!', 'Squat has been flat at 275 for four sessions.')}</div></div>
  </div>
`)}

${sec('checklist', '9b · Warm-up checklist', 'Ticked mid-session. Neither control was styled in August or now.', `
  <div class="wcSection">
    <button class="wcHead"><span class="wcCaret">▾</span><span class="wcTitle">Warm-up</span><span class="wcCount">1/2</span></button>
    <div class="wcBody open"><div class="wcBodyInner">
      <div class="wcItem">
        <button class="wcCheck on" aria-pressed="true"><svg class="wcCheckMark" viewBox="0 0 12 12" fill="none"><path d="M2 6.5 L4.6 9 L10 3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        <span class="wcTxt done"><svg class="wcScribble" viewBox="0 0 340 32" preserveAspectRatio="none"><path class="wcScribblePath" d="M4 18 C 80 10, 160 24, 336 14" fill="none" stroke-width="2" stroke-linecap="round"/></svg>Five minutes on the bike</span>
        <button class="wcX" aria-label="Remove">×</button>
      </div>
      <div class="wcItem">
        <button class="wcCheck" aria-pressed="false"><svg class="wcCheckMark" viewBox="0 0 12 12" fill="none"><path d="M2 6.5 L4.6 9 L10 3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        <span class="wcTxt">Band pull-aparts, two sets</span>
        <button class="wcX" aria-label="Remove">×</button>
      </div>
      <div class="wcAdd"><input class="wcIn" placeholder="Add item" /><button class="wcAddBtn">+</button></div>
    </div></div>
  </div>
`)}

${sec('sheet', '10 · Sheet', 'Four stacked in one scroll, no tab bar. They must read as separate sections.', `
  <div class="cs-stack">
    <div class="sheet"><div class="eyebrow">Short-term goal</div>
      <div style="margin-top:14px"><button class="goalPill empty">Set a short-term goal (optional)</button></div></div>
    <div class="sheet"><div class="eyebrow">Progress photos</div><p class="emptyHist">No progress photos yet.</p></div>
  </div>
`)}

${sec('chrome', '10b · Header, menu, coach and overlays', 'Surfaces that live outside the session sheet, plus the transient states JS applies mid-animation.', `
  <div class="cs-stack">
    ${cell('topSticker + noteBar', '<header class="topSticker"><div class="stickerGreet">Welcome Piglet</div><div class="noteBar"><div class="noteSlot">' + noteCard('mint', '✓', 'Three weeks running at 4+ sessions.') + '</div></div></header>')}
    ${cell('menuPop — the card overflow menu', '<div class="menuPop">'
      + '<button class="deloadRow on" role="switch" aria-checked="true"><span class="menuRowLabel">Deload active</span><span class="bouncyTrack mini"><span class="bouncyThumb"><span class="bouncyDot">⬇️</span></span></span></button>'
      + '<button>This hurts — stop suggesting it</button>'
      + '<button>Add a note</button>'
      + '<div class="sep"></div>'
      + '<button class="danger">Remove from day</button></div>')}
    ${cell('coachFab — floating trigger', '<div class="cs-stage"><button class="coachFab" title="Talk to your coach" aria-label="Talk to your coach"><canvas id="coachFabCanvas"></canvas></button></div>')}
    ${cell('cvInputRow — coach', '<div class="cvInputRow"><input placeholder="e.g. 30 min, dumbbells only" /><button class="cvSend" aria-label="Send">↑</button></div>')}
    ${cell('cvInputRow — disabled while replying', '<div class="cvInputRow"><input placeholder="Thinking…" disabled /><button class="cvSend" aria-label="Send" disabled>↑</button></div>')}
    ${cell('goalRow', '<div class="goalRow"><span class="nm">Bench Press to 225</span><button class="photoX">Edit</button></div>')}
    ${cell('sChart — sparkline', '<div class="ovCard"><div class="ovNum">128</div><div class="ovLbl">Sessions</div>'
      + '<div class="sChart">'
      + [82, 66, 71, 48, 55, 34, 40, 22, 28, 10].map((top, i) =>
          `<button class="sPoint" style="left:${i * 11}%;top:${top}%" title="week ${i + 1}"></button>`).join('')
      + '</div></div>')}
    ${cell('ex — collapsed', '<div class="ex collapsed"><div class="exHead"><div class="exName"><span class="nameTxt">Barbell Row</span></div></div><div class="exMeta"><span>accessory</span></div><div class="collapsedNote">2 of 3 sets logged · tap the eye to expand</div><div class="exActions"></div><div class="pills"></div></div>')}
    ${cell('ex — being dragged', '<div class="ex dragging"><div class="exHead"><div class="exName"><span class="nameTxt">Barbell Curl</span></div></div><div class="exMeta"><span>accessory</span></div><div class="exActions"></div><div class="pills"></div></div>')}
    ${cell('ex — drag ghost (mid-drag)', '<div class="ex drag-ghost"><div class="exHead"><div class="exName"><span class="nameTxt">Back Squat</span></div></div><div class="exMeta"><span>compound</span></div><div class="exActions"></div><div class="pills"></div></div>')}
    ${cell('pill — shimmer (just logged)', '<div class="pill done shimmer"><span class="pillIdx">I</span><span class="pillValue">' + inputs() + '</span><span class="pillSpacer"></span><div class="pillActions"><span class="pillStatus">done</span></div></div>')}
    ${cell('noteCard — entering / leaving', '<div class="noteBar"><div class="noteSlot">' + noteCard('gold', '★', 'Entering') .replace('noteCard note-gold','noteCard note-gold entering') + '</div><div class="noteDiv"></div><div class="noteSlot">' + noteCard('plain', '·', 'Leaving').replace('noteCard note-plain','noteCard note-plain leaving') + '</div></div>')}
    ${cell('freshbtn — armed', '<button class="freshbtn arm">Tap again to wipe</button>')}
    ${cell('celebrate — new best', '<div class="cs-stage">'
      + '<div class="celebrate on"><div class="burst">'
      + '<div class="bstar"><svg viewBox="0 0 24 24"><path d="M12 2l2.9 6.1 6.6 .9-4.8 4.6 1.2 6.6L12 18.5 6.1 20.8l1.2-6.6L2.5 9.6l6.6-.9z"/></svg></div>'
      + '<div class="ch1">New best</div>'
      + '<div class="ch2">Bench Press — <span class="goal">195 × 5</span></div>'
      + '<div class="tap">tap to close</div>'
      + '</div></div></div>')}
  </div>
`)}

${sec('frame', '10c · The frame that is the argument', 'A card with eight logged sets and one unlogged. The unlogged row must be the most prominent thing here.', `
  <div class="ex">
    <div class="exHead"><div class="exName"><span class="nameTxt">Bench Press</span></div></div>
    <div class="exMeta"><span>compound</span><span class="metaSep">·</span><span>9 × 5</span></div>
    <div class="exActions"><button class="actionPill"><span class="pl">Swap</span></button></div>
    <div class="restSlot"></div>
    <div class="pills">
      ${['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'].map((n, i) =>
        `<div class="pillWrap">${loggedRow({ idx: n, status: 'done', pr: i === 5 ? 'e1rm' : null })}</div>`).join('')}
      <div class="pillWrap">${unloggedRow({ idx: 'IX', bump: true })}
        <div class="pillWhy why-clean">Three clean sessions — up 5 lb.</div></div>
    </div>
  </div>
  <p class="cs-note">Sixth row carries an e1RM record: its rail is gold and the star is set at a real size.
  Every other completed row recedes below the card; the unlogged row sits above it and carries the only filled control.</p>
`)}

${sec('setrow', '11 · Set row — the composite', 'The most-tapped surface in the tile. done, failed and warmup must be distinguishable in greyscale.', `
  <div class="cs-stack">
    ${cell('unlogged', unloggedRow({ idx: 'I' }))}
    ${cell('unlogged + suggestion bump', unloggedRow({ idx: 'I', bump: true }))}
    ${cell('unlogged + near-miss cue', unloggedRow({ idx: 'I', near: '5 lb under your best' }))}
    ${cell('unlogged + reason line + last session', `<div class="pillWrap">${unloggedRow({ idx: 'I', bump: true })}<div class="pillWhy why-clean">Three clean sessions — up 5 lb.</div><div class="pillWhy pillLast">Last time: 180 × 5, 5, 4</div></div>`)}
    ${cell('why-deload', `<div class="pillWrap">${unloggedRow({ idx: 'I' })}<div class="pillWhy why-deload">Deloading — back to 165 for two sessions.</div></div>`)}
    ${cell('why-layoff', `<div class="pillWrap">${unloggedRow({ idx: 'I' })}<div class="pillWhy why-layoff">Three weeks off — starting lighter.</div></div>`)}
    ${cell('L/R armed (four fields)', unloggedRow({ idx: 'II', sides: true }))}
    ${cell('AMRAP armed (last set)', unloggedRow({ idx: 'III', amrap: true }))}
    ${cell('warm-up armed', unloggedRow({ idx: 'I', warm: true }))}
    ${cell('done', loggedRow({ idx: 'I', status: 'done' }))}
    ${cell('done + over target', loggedRow({ idx: 'II', status: 'done <span class="sub">· +2</span>' }))}
    ${cell('done + under target', loggedRow({ idx: 'II', status: 'done <span class="sub">· 3 reps</span>' }))}
    ${cell('done, no record — beside the one below', loggedRow({ idx: 'I', status: 'done' }))}
    ${cell('done + weight PR (dot)', loggedRow({ idx: 'III', status: 'done', pr: 'dot' }))}
    ${cell('done + e1RM PR (star)', loggedRow({ idx: 'III', status: 'done', pr: 'e1rm' }))}
    ${cell('done + RPE recorded', loggedRow({ idx: 'I', status: 'done', rpe: 8.5 }))}
    ${cell('failed', loggedRow({ idx: 'II', kind: 'failed', status: 'missed' }))}
    ${cell('warm-up logged', loggedRow({ idx: 'I', status: 'done', warm: true }))}
    ${cell('done + drop set', `<div class="pillWrap">${loggedRow({ idx: 'III', status: 'done' })}${dropRow()}</div>`)}
  </div>
  <p class="cs-warn">Greyscale check: view this section with a greyscale filter. done / failed / warmup must stay
  tellable apart.</p>
`)}

${sec('rest', '12 · Rest bar', 'Runs inside a card. over flips the whole bar once remaining time passes zero.', `
  <div class="cs-stack">
    ${cell('running', restBar(false))}
    ${cell('over', restBar(true))}
  </div>
`)}

${sec('verdicts', '13 · Engine-driven states', 'Classes the engine composes by name. Every one must read distinctly.', `
  <div class="cs-stack">
    ${cell('verdict-rest_advised', '<div class="readinessNote verdict-rest_advised">Two nights under six hours and recovery at 41% — a rest day is the honest call.</div>')}
    ${cell('verdict-reduced_volume', '<div class="readinessNote verdict-reduced_volume">Recovery is low. Two working sets instead of four today.</div>')}
    ${cell('verdict-reduced_intensity', '<div class="readinessNote verdict-reduced_intensity">Hard conditioning yesterday — same sets, 10% off the bar.</div>')}
    ${cell('weeklyReview', '<div class="weeklyReview"><div class="wrHead">This week</div><div class="wrLine">Four sessions, 28,400 lb, two personal records.</div><div class="wrLine mu">chest 26 sets (over band) · quads 4 sets (under band)</div><div class="wrLine mu">Quiet: hamstrings, calves</div></div>')}
    ${cell('muscle bands', '<div class="muscleBars"><div class="mbRow"><span class="mbLbl">chest</span><span class="mbTrack"><span class="mbFill band-over" style="width:88%"></span></span><span class="mbVal">26</span></div><div class="mbRow"><span class="mbLbl">back</span><span class="mbTrack"><span class="mbFill ok band-in" style="width:62%"></span></span><span class="mbVal">18</span></div><div class="mbRow"><span class="mbLbl">quads</span><span class="mbTrack"><span class="mbFill band-under" style="width:14%"></span></span><span class="mbVal">4</span></div></div>')}
  </div>
`)}

${sec('frame', '14 · The frame', 'Recovered from 731e891 with documented deviations — see the comment block above .shell in the tile stylesheet. rail is shown at rest; its position:sticky only shows itself against a real scrolling page.', `
  <div class="cs-stack">
    ${cell('shell', '<div class="shell" style="background:var(--e1);border:1px dashed var(--hair-strong)">page content lives here, max 600px, var(--sp5) gutter</div>')}
    ${cell('trainBar + wordmark', '<div class="trainBar"><span class="wordmark">TRAIN<span class="wmDot"> · </span><span id="sessionNum">Session 214</span></span></div>')}
  </div>
  <div class="cs-grid" style="margin-top:18px">
    ${cell('rail', `<div class="rail" style="position:relative"><span class="railDate">TUE SEP 22</span><span class="railSpacer"></span>
      <span class="railStat"><span class="railStatVal">4</span><span class="railStatLbl">sets</span></span>
      <span class="railDivider"></span>
      <span class="railStat"><span class="railStatVal lit">1,240</span><span class="railStatLbl">lb</span></span>
    </div>`)}
    ${cell('daydots', '<div class="daydots"><span class="dd done"></span><span class="dd done"></span><span class="dd pr"></span><span class="dd miss"></span><span class="dd"></span><span class="dd"></span><span class="dd"></span></div>')}
    ${cell('daytitle', '<div class="daytitle">Day 214</div>')}
  </div>
`)}

${sec('fan', '15 · Fan browser', 'Two unrelated surfaces share the fan- prefix: a paginated photo stepper (fanWrap/fanNav/fanArrow/fanDots/fanCount) and an SVG line-and-dot chart with a hover tooltip (fan/fanHit/fanDot/fanLabel/fanCard). Colours reuse --gold/--signal/--muted-2 for high/mid/low, the same meaning they carry everywhere else.', `
  <div class="cs-stack">
    ${cell('photo stepper', '<div class="fanWrap" style="height:auto"><div class="fanStage" style="position:relative;height:0"></div><div class="fanCaption"><div class="capRow"><span class="photoDate">SEP 22</span></div></div><div class="fanNav"><button class="fanArrow" aria-label="Previous">‹</button><div class="fanDots"><span class="fanCount">3 / 12</span></div><button class="fanArrow" aria-label="Next">›</button></div></div>')}
    ${cell('SVG line + dots + labels', '<svg width="220" height="90" viewBox="0 0 220 90"><path class="fanHit" d="M10 70 L110 30 L210 50"/><path class="fan high" d="M10 70 L110 30 L210 50"/><circle class="fanDot high" cx="10" cy="70" r="3.4"/><circle class="fanDot mid" cx="110" cy="30" r="3.4"/><circle class="fanDot low" cx="210" cy="50" r="3.4"/><text class="fanLabel high" x="17" y="73">225</text><text class="fanLabel mid" x="117" y="33">245</text><text class="fanLabel low" x="217" y="53">210</text></svg>')}
    ${cell('fanCard tooltip', '<div class="fanCard on" style="position:relative;opacity:1"><div class="v">245 lb</div><div class="c">Feb 14</div></div>')}
  </div>
`)}

${sec('photos', '16 · Progress photos', '.photoCard already exists — recovered earlier with the card primitive. These are the pieces added since.', `
  <div class="cs-grid">
    ${cell('photoImg (pending)', '<div class="photoImg photoImg--pending skeleton-shimmer" style="position:relative;width:88px;height:124px;border-radius:var(--r-sm)"></div>')}
    ${cell('capRow: photoDate', '<div class="capRow"><span class="photoDate">SEP 22</span></div>')}
    ${cell('photoNote', '<p class="photoNote">Good lighting, same angle as last time.</p>')}
    ${cell('photoNote muted', '<p class="photoNote muted">No analysis available for this one.</p>')}
    ${cell('photoStatus', '<div class="photoStatus">Saved</div>')}
    ${cell('photoBtnRow', '<div class="photoBtnRow"><button class="pbtn ghost">Skip</button><button class="pbtn save addLift">Save photo</button></div>')}
  </div>
`)}

${sec('settings', '17 · Settings row', 'settingsBtn opens the popup; settingsRow and settingsNote are used repeatedly inside it.', `
  <div class="cs-stack">
    ${cell('settingsBtn', '<button class="settingsBtn" aria-label="Settings"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82"/></svg></button>')}
    ${cell('settingsRow', '<div class="settingsRow"><span class="bouncyLabel on">Target</span><div class="stepper"><button class="step minus" data-t="-1">−</button><span class="stepVal">4</span><button class="step" data-t="1">+</button></div></div>')}
    ${cell('settingsNote', '<p class="settingsNote">Pull-ups, dips and push-ups move a known share of you, so this is what turns them into real volume.</p>')}
  </div>
`)}

${sec('calendar', '18 · The calendar', 'Rounded per tests/tools/recovered-primitives.test.ts, "the calendar came back". .ctLbl used to read two lines ("LB" / "THIS QTR") that only fit the 42px box at a below-floor 7px — the second line was dropped as redundant with .calTitle above it, rather than the box resized or the text shrunk back down.', `
  <div class="cs-stack">
    <div class="calShell">
      <button class="fanArrow calArrow dis" aria-label="Previous quarter" disabled>‹</button>
      <div class="calBody">
        <div class="calHead"><span class="calTitle">Q3 2026 <b class="hv">· Jul–Sep</b></span></div>
        <div class="calGridRow">
          <div class="calDayLbls"><span></span><span>Mon</span><span></span><span>Wed</span><span></span><span>Fri</span><span></span></div>
          <div class="calMain">
            <div class="calMonths" style="grid-template-columns:repeat(3,13px)"><span>Jul</span><span>Aug</span><span>Sep</span></div>
            <div class="cal hot" style="grid-template-columns:repeat(3,13px)">
              <span class="cd pad"></span><span class="cd l1"></span><span class="cd l2 hotcell"></span>
              <span class="cd l3"></span><span class="cd l4"></span><span class="cd pad"></span>
              <span class="cd l2"></span><span class="cd l1"></span><span class="cd l4"></span>
            </div>
          </div>
          <div class="calTotal"><div class="ctNum">2.4k</div><div class="ctLbl">lb</div></div>
        </div>
      </div>
      <button class="fanArrow calArrow" aria-label="Next quarter">›</button>
    </div>
    <div class="calLegend">Less<i class="l0"></i><i class="l1"></i><i class="l2"></i><i class="l3"></i><i class="l4"></i>More</div>
    <div class="cs-row">
      ${cell('calTotal.hot', '<div class="calTotal hot"><div class="ctNum">2.4k</div><div class="ctLbl">lb</div></div>')}
      <div style="position:relative;width:132px;height:70px">${cell('calPop', '<div class="calPop on" style="position:relative;right:auto;top:auto;transform:none;opacity:1"><div class="cpCap">growth this quarter</div></div>')}</div>
    </div>
  </div>
`)}

${sec('heatmap', '18b · The heatmap (first slice)', 'docs/plans/heatmap.md — grid shell only, volume-bucketed. --hm1–--hm4 is a NEW ramp (not elevation), neutral by design; --signal appears exactly once, on today, regardless of that day’s own value. Rest/no-data is drawn (hairline outline, no fill), never dimmed.', `
  <div class="hmHead" style="width:max-content">${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((w) => `<div class="hmWd">${w}</div>`).join('')}</div>
  <div class="hmBody" style="width:max-content;max-height:none;grid-template-rows:repeat(2,42px)">
    <button class="hmCell"></button><button class="hmCell l1"></button><button class="hmCell l2"></button>
    <button class="hmCell l3"></button><button class="hmCell l4"></button><button class="hmCell today"></button>
    <button class="hmCell l2 today"></button>
    <button class="hmCell"></button><button class="hmCell"></button><button class="hmCell l1"></button>
    <button class="hmCell l3"></button><button class="hmCell"></button><button class="hmCell l4"></button>
    <button class="hmCell l2"></button>
  </div>
`)}

${sec('overview', '19 · Overview cards &amp; weekday bars', 'Signal shows up twice here — .ovNum.mint and .wdFill’s gradient — flagged, not changed, in the same pass that ported these.', `
  <div class="ovGrid" style="margin-top:0">
    ${cell('ovCard, gold', '<div class="ovCard"><div class="ovNum gold">6</div><div class="ovLbl">Longest run</div><div class="ovDesc">weeks at 3+ sessions</div></div>')}
    ${cell('ovCard, mint + chart', '<div class="ovCard"><div class="ovNum mint">128,400</div><div class="ovLbl">Total lb lifted</div><div class="ovChart"><div class="ovBar" style="height:40%"></div><div class="ovBar" style="height:65%"></div><div class="ovBar" style="height:50%"></div><div class="ovBar now" style="height:80%"></div></div><div class="ovCap">8-week trend</div></div>')}
  </div>
  <div class="cs-stack">
    ${cell('wdBars', '<div class="wdBars">'+['M','T','W','T','F','S','S'].map((d,i)=>'<div class="wdBar"><div class="wdTrack"><div class="wdFill" style="height:'+[30,55,20,70,45,10,0][i]+'%"></div></div><span class="wdLbl">'+d+'</span></div>').join('')+'</div>')}
    ${cell('stats / stat', '<div class="stats"><div class="stat"><div class="k">Week streak</div><div class="v gold">4</div></div><div class="stat"><div class="k">Total sessions</div><div class="v">86</div></div><div class="stat"><div class="k">Lifts tracked</div><div class="v up">12</div></div></div>')}
    ${cell('statStrip', '<div class="statStrip"><div class="stat"><div class="k">Sets</div><div class="v">4</div></div><div class="stat"><div class="k">Volume</div><div class="v">1,240</div></div><div class="stat"><div class="k">PRs</div><div class="v gold">1</div></div></div>')}
  </div>
`)}

${sec('hero', '20 · Hero &amp; progress ring', 'The circular "today’s session" completion ring, separate from .daytitle/.daydots. --signal is the ring fill (.prFill) and the streak figure inside .heroSub.', `
  <div class="cs-stack">
    <div class="heroCap">Today&rsquo;s session<span class="streakPill" style="display:inline-block">4 day streak</span></div>
    <div class="heroRow">
      <div class="progRing">
        <svg viewBox="0 0 88 88"><circle class="prTrack" cx="44" cy="44" r="38"/><circle class="prFill pulse" cx="44" cy="44" r="38" style="stroke-dasharray:238.8;stroke-dashoffset:80"/></svg>
        <div class="prCenter"><div class="prPct">66%</div><div class="plabel"><b class="num">4</b> of 6 logged</div></div>
      </div>
      <div class="heroText">
        <div class="daytitle" style="font-size:28px">Push Day</div>
        <div class="heroSub">Longest set streak: <b>12</b></div>
      </div>
    </div>
  </div>
`)}

${sec('trend', '21 · Trend-chart SVG primitives', 'A weight/volume-over-time chart, separate from the fan browser’s SVG. --signal is the line, the unqualified dot, and the area fill (var(--mint) in the markup that builds this).', `
  ${cell('the full chart', '<div class="plot" style="height:160px"><svg viewBox="0 0 300 160" preserveAspectRatio="none"><defs><linearGradient id="cs-fill-demo" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--mint);stop-opacity:.22"/><stop offset="1" style="stop-color:var(--mint);stop-opacity:0"/></linearGradient></defs><line class="grid" x1="30" y1="30" x2="290" y2="30"/><text class="axis-label" x="20" y="34" text-anchor="end">225</text><line class="grid" x1="30" y1="90" x2="290" y2="90"/><text class="axis-label" x="20" y="94" text-anchor="end">185</text><path class="area" fill="url(#cs-fill-demo)" d="M30,120 L100,90 L180,60 L260,40 L260,140 L30,140 Z"/><polyline class="line" points="30,120 100,90 180,60 260,40"/><circle class="dot off" cx="30" cy="120" r="5"/><circle class="dot" cx="100" cy="90" r="5"/><circle class="dot best" cx="260" cy="40" r="5"/><text class="xlab" x="30" y="154" text-anchor="start">Jan 1</text><text class="xlab best" x="260" y="154" text-anchor="end">today</text></svg></div>')}
`)}

${sec('form', '22 · Step-by-step form flow', 'formGist is the lede under a popup title; formSteps/formStep number a short how-it-works list. .formStep .n is signal-coloured.', `
  <div class="cs-stack">
    ${cell('formEquip', '<div class="formEquip">Barbell &middot; Rack</div>')}
    ${cell('formGist', '<p class="formGist">Built from your own lifts, over eight weeks, starting from your real history.</p>')}
    ${cell('formSteps', '<div class="formSteps"><div class="formStep"><span class="n">I</span><span class="t">Pick the lifts you want to change.</span></div><div class="formStep"><span class="n">II</span><span class="t">Choose a direction &mdash; more volume, less, or a deload.</span></div><div class="formStep"><span class="n">III</span><span class="t">Review the projection before you accept it.</span></div></div>')}
  </div>
`)}

${sec('addlift', '23 · Add-lift label &amp; ring', '.addLift itself already has a rule (ported with the photos group); these are its icon ring and text label. Both are signal-coloured.', `
  <div class="cs-row">
    ${cell('addLift, take a photo', '<button class="addLift"><span class="addLiftRing"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z"/><circle cx="12" cy="13" r="3.5"/></svg></span><span class="addLiftLabel">Take a photo</span></button>')}
    ${cell('addLift, add a lift', '<button class="addLift"><span class="addLiftRing"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg></span><span class="addLiftLabel">Add a lift</span></button>')}
  </div>
`)}

${sec('misc', '24 · Miscellaneous', 'No shared theme &mdash; small pieces from across the tile. streakPill, best-w, noteEdit’s focus/button states, miniSpinner and miniCheck all carry --signal.', `
  <div class="cs-stack">
    ${cell('starterTag', '<div class="starterTag">&#10022; starter &mdash; the value is what you build</div>')}
    ${cell('streakPill', '<span class="streakPill" style="display:inline-block">4 day streak</span>')}
    ${cell('chrome', '<div class="chrome"><span class="wordmark">TRAIN</span></div>')}
    ${cell('exwrap (holds .ex cards)', '<div class="exwrap" style="min-height:8px;border:1px dashed var(--hair-strong);border-radius:8px"></div>')}
    ${cell('restPanel', '<div class="restPanel"><div class="moon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg></div><h3>Today is a rest day.</h3><p>You marked today off. Tap below to bring your session back.</p><button class="undo">bring the session back</button></div>')}
    ${cell('finishRow', '<div class="finishRow"><button class="finishBtn">Finish session</button></div>')}
    ${cell('store-note', '<p class="store-note">Saved to your Vitality dashboard.</p>')}
    ${cell('chipRow', '<div class="chipRow"><button class="chip">7D</button><button class="chip">1M</button><button class="chip">All</button></div>')}
    ${cell('goalTop (inside goalRow)', '<div class="goalRow"><div class="goalTop"><span>Bench Press</span><span>185 / 225 lb</span></div></div>')}
    ${cell('insightBox', '<div class="insightBox">You’re 12 lb from a squat PR at this rep range.</div>')}
    ${cell('best-w', '<span class="best-w"><svg viewBox="0 0 24 24" fill="var(--gold)"><path d="M12 3.5l2.5 5.1 5.6.8-4 3.9 1 5.6L12 16.9 6.9 18.9l1-5.6-4-3.9 5.6-.8z"/></svg><span class="num">225</span> <span class="u">lb</span></span>')}
    ${cell('emptyHist', '<p class="emptyHist">No saved templates yet.</p>')}
    ${cell('secLbl', '<div class="secLbl">Bodyweight</div>')}
    ${cell('swapList / swapItem', '<div class="swapList">'+swapItem('Barbell', '—')+swapItem('Dumbbells', 'yes', true)+'</div>')}
    ${cell('noteEdit', '<div class="noteEdit"><input value="Left shoulder, keep elbows tucked" /><button>Save</button></div>')}
    ${cell('miniSpinner / miniCheck', '<div><span class="miniSpinner"></span>Uploading&hellip;</div><div style="margin-top:6px"><span class="miniCheck">&#10003;</span>Saved</div>')}
    ${cell('skeleton-shimmer', '<div class="photoImg photoImg--pending skeleton-shimmer" style="width:88px;height:60px;border-radius:var(--r-sm)"></div>')}
  </div>
`)}

</div>
</body>
</html>
`
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const html = contactSheet()
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, html)
  console.log(`contact sheet → ${OUT} (${html.length} bytes)`)
}
