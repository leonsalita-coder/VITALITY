/**
 * Train engine — pure, DOM-free training logic.
 *
 * This module is bundled to an IIFE (global `TrainEngine`) and inlined into
 * train.html by scripts/build-tile.mjs. It must never import from the Next
 * app, touch `window`/`document`, or reference `window.Vitality`.
 */
export const ENGINE_VERSION = '1.0.0'

export * from './progression'
export * from './sets'
export * from './records'
export * from './deload'
export * from './streaks'
export * from './classify'
export * from './plan'
export * from './muscles'
export * from './analysis'
export * from './catalog'
export * from './identity'
