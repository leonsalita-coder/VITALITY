/**
 * The test suite's one way of asking "what is today?".
 *
 * LOCAL date, never toISOString. toISOString is UTC: east of UTC it
 * returns yesterday's local date, the session never matches the tile's
 * `today`, curSession() rebuilds it empty, and every assertion silently
 * stops testing anything. Found by `npm run mutate:fuzz` — 44 tests were
 * passing vacuously in Sydney. See docs/train-verification.md.
 *
 * The clock is a parameter for the same reason lib/train/progression.ts
 * takes `now`: a hidden `new Date()` is what makes a suite
 * non-deterministic. It defaults to the real clock, so today every caller
 * still reads the system time — pinning it is a separate change.
 */
export type Clock = () => Date

export const realClock: Clock = () => new Date()

export const localToday = (clock: Clock = realClock): string => {
  const d = clock()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
