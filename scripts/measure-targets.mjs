#!/usr/bin/env node
/**
 * How big is a tap target, actually?
 *
 * measure-logging.mjs reports the first `height:` it finds in the first
 * rule matching a selector. That was fine when almost nothing was styled
 * and is wrong now: it read `border-bottom-width:4px` on .pillHit as a
 * height, and kept reporting .pillWarm at 22x22 after a later rule had
 * resized it. A measurement that reads the wrong declaration is worse
 * than no measurement, because it looks like an answer.
 *
 * This resolves the cascade instead: every rule whose selector matches,
 * in source order, with later declarations winning — then computes the
 * box from width/height, min-width/min-height, padding, border and the
 * line box, and adds any hit area a ::before/::after extends it by.
 *
 * IT IS DERIVED FROM DECLARATIONS, NOT RENDERED. There is no headless
 * browser here, so nothing below accounts for flexbox stretching, text
 * measurement, or a parent that constrains the child. Where a number
 * depends on content width it says `auto` rather than inventing one.
 * Treat these as what the stylesheet asks for, which is exactly what was
 * missing when every one of these read "not declared".
 *
 *   node scripts/measure-targets.mjs
 *   node scripts/measure-targets.mjs --json
 */

import { readFileSync } from 'node:fs'

const TILE = 'public/tiles/train.html'
/** Apple HIG and WCAG 2.5.5 both land here. */
export const MIN_TARGET = 44

const TARGETS = [
  '.pillHit', '.pillMiss', '.pillWarm', '.pillReset', '.pillDrop', '.pillInput',
  '.actionPill', '.popX', '.pbtn', '.finishBtn', '.freshbtn', '.chip', '.step',
  '.swapItem', '.wcAddBtn', '.cvSend', '.bouncyToggle', '.wcCheck', '.wcX',
]

function styleBlock(source = readFileSync(TILE, 'utf8')) {
  return /<style[^>]*>([\s\S]*?)<\/style>/.exec(source)[1]
}

/** Top-level rules, brace-matched, at-rule contents skipped. */
function rules(css) {
  const out = []
  let i = 0
  while (i < css.length) {
    while (i < css.length && /\s/.test(css[i])) i++
    if (css.startsWith('/*', i)) { i = css.indexOf('*/', i) + 2; continue }
    const open = css.indexOf('{', i)
    if (open < 0) break
    const prelude = css.slice(i, open).trim()
    let depth = 0, k = open
    for (; k < css.length; k++) {
      if (css[k] === '{') depth++
      else if (css[k] === '}') { depth--; if (!depth) break }
    }
    if (!prelude.startsWith('@')) {
      out.push({ prelude, body: css.slice(open + 1, k) })
    }
    i = k + 1
  }
  return out
}

const tokens = (css) => {
  const root = /:root\s*\{([\s\S]*?)\n\s*\}/.exec(css)
  const map = {}
  for (const m of root[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) map[m[1]] = m[2].trim()
  return map
}

/** `var(--fs-12)` -> `12px`, one level deep, which is all this needs. */
function resolve(value, tok) {
  let v = value
  for (let n = 0; n < 4 && v.includes('var('); n++) {
    v = v.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)/g, (_, name, fallback) =>
      tok[name] !== undefined ? tok[name] : (fallback || ''))
  }
  return v.trim()
}

const px = (v) => {
  const m = /^(-?[\d.]+)px$/.exec((v || '').trim())
  return m ? parseFloat(m[1]) : null
}

/**
 * Does this rule target the element itself?
 *
 * Deliberately narrow: the bare selector, or the selector with a state or
 * compound class attached. A descendant rule like `.pill.done .pillReset`
 * is counted too, because it does reach the element — but only its box
 * properties are read, and no attempt is made to model which state the
 * element is actually in.
 */
function matches(prelude, sel) {
  const name = sel.slice(1)
  return prelude.split(',').some((part) => {
    const p = part.trim()
    const last = p.split(/\s+|>/).filter(Boolean).pop() || ''
    if (!last.includes(sel)) return false
    const after = last.slice(last.indexOf(sel) + sel.length)
    return /^([.:#[][\w\-[\]="'():.,\s]*)?$/.test(after) && !/^[\w-]/.test(after)
      || after === '' || after.startsWith(':') || after.startsWith('.') || after.startsWith('[')
  }) && new RegExp(`\\.${name}(?![\\w-])`).test(prelude)
}

function declared(css, tok, sel, pseudo = '') {
  const want = pseudo ? sel + pseudo : sel
  const box = {}
  for (const { prelude, body } of rules(css)) {
    const hasPseudo = /::(before|after)/.test(prelude)
    if (pseudo ? !prelude.includes(pseudo) : hasPseudo) continue
    if (!matches(prelude.replace(/::(before|after)/g, ''), sel)) continue
    for (const m of body.matchAll(/([a-z-]+)\s*:\s*([^;]+)/g)) {
      box[m[1]] = resolve(m[2], tok)
    }
  }
  return Object.keys(box).length ? box : null
}

const pad = (box, side) => {
  const p = box[`padding-${side}`] ?? null
  if (p != null) return px(p) ?? 0
  const short = box.padding
  if (!short) return 0
  const parts = short.split(/\s+/).map(px)
  if (parts.length === 1) return parts[0] ?? 0
  if (parts.length === 2) return (side === 'top' || side === 'bottom' ? parts[0] : parts[1]) ?? 0
  if (parts.length === 3) return (side === 'top' ? parts[0] : side === 'bottom' ? parts[2] : parts[1]) ?? 0
  return ({ top: parts[0], right: parts[1], bottom: parts[2], left: parts[3] }[side]) ?? 0
}

const borderW = (box) => {
  const b = box['border-width'] ?? (box.border ? box.border.split(/\s+/).find((t) => px(t) != null) : null)
  return px(b) ?? 0
}

/** How far a ::before/::after extends past the border box, per axis. */
function outset(box) {
  if (!box) return { y: 0, x: 0 }
  const vals = (box.inset || '').split(/\s+/).map(px)
  let top = 0, side = 0
  if (vals.length === 1 && vals[0] != null) { top = side = -vals[0] }
  else if (vals.length >= 2) { top = -(vals[0] ?? 0); side = -(vals[1] ?? 0) }
  for (const [k, sign] of [['top', 'y'], ['bottom', 'y'], ['left', 'x'], ['right', 'x']]) {
    const v = px(box[k])
    if (v != null && v < 0) { if (sign === 'y') top = Math.max(top, -v); else side = Math.max(side, -v) }
  }
  return { y: Math.max(0, top) * 2, x: Math.max(0, side) * 2 }
}

export function measure(source = readFileSync(TILE, 'utf8')) {
  const css = styleBlock(source)
  const tok = tokens(css)
  return TARGETS.map((sel) => {
    const box = declared(css, tok, sel)
    if (!box) return { sel, styled: false }
    const fs = px(box['font-size']) ?? px((box.font || '').split(/[\s/]+/).map((t) => t).find((t) => px(t) != null)) ?? 16
    const lh = px(box['line-height']) ?? fs * 1.2
    const bw = borderW(box)
    const h = px(box.height)
    const w = px(box.width)
    const boxH = Math.max(px(box['min-height']) ?? 0, (h ?? lh + pad(box, 'top') + pad(box, 'bottom') + bw * 2))
    const boxW = w != null ? Math.max(px(box['min-width']) ?? 0, w + bw * 2) : (px(box['min-width']) ?? null)
    const before = outset(declared(css, tok, sel, '::before'))
    const after = outset(declared(css, tok, sel, '::after'))
    const grow = { y: Math.max(before.y, after.y), x: Math.max(before.x, after.x) }
    return {
      sel, styled: true,
      boxW, boxH: Math.round(boxH * 10) / 10,
      hitW: boxW != null ? boxW + grow.x : null,
      hitH: Math.round((boxH + grow.y) * 10) / 10,
      grew: grow.y > 0 || grow.x > 0,
    }
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = measure()
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(rows, null, 2))
  } else {
    console.log('TAP TARGETS — computed from declarations, not rendered.')
    console.log(`Minimum sought: ${MIN_TARGET}px. "auto" = width follows content.\n`)
    console.log(`  ${'selector'.padEnd(16)} ${'painted'.padEnd(14)} ${'hit area'.padEnd(14)} `)
    console.log('  ' + '-'.repeat(48))
    for (const r of rows) {
      if (!r.styled) { console.log(`  ${r.sel.padEnd(16)} no rule`); continue }
      const f = (w, h) => `${w == null ? 'auto' : w} x ${h}`
      const ok = r.hitH >= MIN_TARGET ? ' ok' : ' UNDER'
      console.log(`  ${r.sel.padEnd(16)} ${f(r.boxW, r.boxH).padEnd(14)} ${f(r.hitW, r.hitH).padEnd(14)}${ok}${r.grew ? '  (extended)' : ''}`)
    }
  }
}
