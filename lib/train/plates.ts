/**
 * Plate math.
 *
 * Suggesting 187 lb when the rack makes 185 or 190 is small, and it reads
 * as an app that has never loaded a bar. Every reps_weight suggestion snaps
 * to a total that can actually be built from the bar and the plates in the
 * room.
 *
 * Pure and DOM-free.
 */

/** A commercial gym's default. */
export const DEFAULT_BAR_LB = 45

/** Pairs on hand, heaviest first. One of each number means one PAIR. */
export const DEFAULT_PLATES_LB = [45, 35, 25, 10, 5, 2.5]

export interface PlateConfig {
  /** The bar itself. Zero for a movement loaded without one. */
  barLb: number
  /** Plate denominations available, as pairs. */
  plates: number[]
}

export function defaultPlateConfig(): PlateConfig {
  return { barLb: DEFAULT_BAR_LB, plates: [...DEFAULT_PLATES_LB] }
}

const tidy = (n: number) => Math.round(n * 100) / 100

/**
 * Every total the bar can actually be loaded to, ascending.
 *
 * Capped rather than unbounded: the point is to snap a suggestion, and a
 * lifter is never one nudge away from a thousand pounds.
 */
export function loadableWeights(config: PlateConfig, maxLb = 1000): number[] {
  const bar = Math.max(0, config.barLb || 0)
  const plates = (config.plates || []).filter((p) => p > 0).sort((a, b) => a - b)

  /* Every plate denomination can go on more than once, so this walks
     reachable per-side loads rather than assuming a single pair of each.
     With no plates at all the loop simply never adds anything and the
     bar falls out of it, so there is no empty-list case to special-case. */
  const perSide = new Set<number>([0])
  const limit = (maxLb - bar) / 2
  let frontier = [0]
  while (frontier.length) {
    const next: number[] = []
    for (const load of frontier) {
      for (const plate of plates) {
        const candidate = tidy(load + plate)
        if (candidate > limit || perSide.has(candidate)) continue
        perSide.add(candidate)
        next.push(candidate)
      }
    }
    frontier = next
    if (perSide.size > 4000) break // plenty for any real rack
  }
  return [...perSide].map((side) => tidy(bar + side * 2)).sort((a, b) => a - b)
}

/**
 * The nearest loadable total to a target.
 *
 * Ties go DOWN. Being handed slightly less than asked for costs one easy
 * rep; being handed slightly more is how a marginal set becomes a miss.
 */
export function snapToLoadable(target: number, config: PlateConfig): number {
  /* Always at least [bar], so there is no empty case below. Below the
     bar there is nothing to snap to either — the bar is the smallest
     option, so the search returns it without needing to be told. */
  const options = loadableWeights(config, Math.max(target * 2, 1000))

  let best = options[0]
  let bestGap = Math.abs(options[0] - target)
  for (const option of options) {
    const gap = Math.abs(option - target)
    if (gap < bestGap || (gap === bestGap && option < best)) {
      best = option
      bestGap = gap
    }
  }
  return tidy(best)
}

/** The plates to hang on each side, heaviest first, or null if unloadable. */
export function plateBreakdown(total: number, config: PlateConfig): number[] | null {
  const bar = Math.max(0, config.barLb || 0)
  if (tidy(total) === tidy(bar)) return []
  let remaining = tidy((total - bar) / 2)
  if (remaining < 0) return null
  const plates = (config.plates || []).filter((p) => p > 0).sort((a, b) => b - a)
  const used: number[] = []
  for (const plate of plates) {
    while (remaining >= plate - 1e-9) {
      used.push(plate)
      remaining = tidy(remaining - plate)
    }
  }
  return remaining <= 1e-9 ? used : null
}
