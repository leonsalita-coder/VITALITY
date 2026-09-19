export * from './swap'
export * from './ramp'
export * from './amrap'
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
export * from './session'
export * from './plates'
export * from './readiness'
export * from './insight'
export * from './review'
export * from './routine'
export * from './import'
export * from './series'
export * from './backup'
export * from './bodyweight'
export * from './onboarding'
export * from './other'
export * from './targets'
