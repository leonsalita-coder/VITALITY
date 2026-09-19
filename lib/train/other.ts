/**
 * Training that isn't lifting.
 *
 * People run, spar, play five-a-side and carry bricks, and a training app
 * that pretends none of that happened is wrong about the athlete in a way
 * they can feel: it prescribes a heavy session the day after two hours of
 * sparring and calls the resulting bad session a plateau.
 *
 * Two constraints shape every line of this file.
 *
 * THE LOAD CONTRIBUTION IS ESTIMATED.
 *
 * Self-reported intensity times duration is a crude proxy with no
 * objective anchor. "Hard" means different things on different days to the
 * same person, and nothing here can check. That is the same class of
 * number as a classifier's muscle split, and it is handled the same way:
 * flagged at the source, carried through every summary, and said out loud
 * wherever it reaches the athlete. `estimated` is typed as the literal
 * `true` because there is no circumstance under which this number is
 * measured, and a flag that could be false invites somebody to set it.
 *
 * It is never converted into hard sets. Expressing sparring in the units
 * of lifting would launder a guess into the same field as a count, and
 * every downstream read would lose the ability to tell them apart.
 *
 * IT SUPPRESSES, IT DOES NOT PRESCRIBE.
 *
 * Systemic fatigue is real, so this may hold a session back. It may not
 * reach a specific lift. The causal chain from "two hours of sparring" to
 * "your bench is stalled" is far too weak to act on, and a wrong deload
 * attributed to something the athlete only roughly described is the
 * fastest way to lose trust in the whole mechanism — including the deloads
 * that were right.
 *
 * That constraint is kept structurally, not by care. These entries live in
 * their own store, they are not history rows, and nothing in this file is
 * an argument to detectPlateau, nextDeloadState or classifyPR — there is no
 * path from here to a lift's prescribed weight.
 *
 * This file deliberately cannot suppress anything either. It supplies the
 * vocabulary — what happened, how much, how sure — and readiness.ts owns
 * what may be done with it, because readiness already refuses to speak
 * when a lift is mid-deload and that refusal has to cover this too. The
 * first version of this had suppression living here, and it could not tell
 * "silent because the athlete is fine" from "silent because a lift is
 * already being cut" — so it stacked a second cut onto a deload. Putting
 * the rule behind that gate is what makes forgetting impossible rather
 * than merely unlikely.
 *
 * Pure and DOM-free.
 */

export type OtherActivity =
  | 'conditioning'
  | 'sport'
  | 'endurance'
  | 'martial_arts'
  | 'mobility'
  | 'labour'
  | 'other'

export const OTHER_ACTIVITIES: OtherActivity[] = [
  'conditioning', 'sport', 'endurance', 'martial_arts', 'mobility', 'labour', 'other',
]

export interface OtherEntry {
  date: string
  activity: OtherActivity
  /** Minutes of actual work. */
  minutes: number
  /** Self-reported 1-10. There is nothing to check this against. */
  intensity: number
  note?: string
}

/**
 * How long fatigue from something else plausibly bears on today.
 *
 * Short, because the honest claim is narrow. Yesterday's sparring is a
 * reason to ease off; the sparring from last Tuesday is a story.
 */
export const SYSTEMIC_WINDOW_DAYS = 3

/** Load that warrants easing the weight. */
export const MODERATE_OTHER_LOAD = 300
/** Load that warrants cutting the volume. */
export const HARD_OTHER_LOAD = 600

/** Longest single entry worth recording, in minutes. */
const MAX_MINUTES = 600

function asActivity(raw: unknown): OtherActivity {
  const key = String(raw || '').toLowerCase().trim().replace(/[\s-]+/g, '_')
  return (OTHER_ACTIVITIES as string[]).includes(key) ? (key as OtherActivity) : 'other'
}

function clamp(raw: unknown, fallback: number, min: number, max: number): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/**
 * Whatever was typed into whatever the store held, as something safe.
 *
 * An unrecognised activity becomes 'other' rather than being rejected —
 * the activity is a label, and losing a session because nobody had
 * anticipated the word for it would be the app disbelieving the athlete.
 * A missing DATE is fatal, because nothing downstream can place it.
 */
export function normalizeOtherEntry(raw: unknown): OtherEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const info = raw as Record<string, unknown>
  const date = typeof info.date === 'string' ? info.date.trim() : ''
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null

  const entry: OtherEntry = {
    date,
    activity: asActivity(info.activity),
    minutes: clamp(info.minutes, 30, 1, MAX_MINUTES),
    intensity: clamp(info.intensity, 5, 1, 10),
  }
  const note = typeof info.note === 'string' ? info.note.trim() : ''
  if (note) entry.note = note.slice(0, 200)
  return entry
}

/**
 * Arbitrary units. Comparable only to other entries from this same file,
 * and never to anything measured.
 */
export function otherLoadOf(entry: OtherEntry): number {
  return entry.minutes * entry.intensity
}

export interface OtherLoadSummary {
  /** Arbitrary units, in the sense above. */
  load: number
  sessions: number
  days: number
  /**
   * Always true. There is no version of this number that is measured, and
   * the type says so, so nothing downstream can be written as though there
   * might be.
   */
  estimated: true
  /** The single hardest entry in the window, for saying what happened. */
  hardest: OtherEntry | null
}

function daysBetween(a: string, b: string): number {
  const parse = (s: string) => {
    const [y, m, d] = s.split('-').map(Number)
    return new Date(y, (m || 1) - 1, d || 1).getTime()
  }
  return Math.round((parse(b) - parse(a)) / 86_400_000)
}

/** Everything that plausibly still bears on today. */
export function recentOtherLoad(
  entries: OtherEntry[],
  today: string,
  days: number = SYSTEMIC_WINDOW_DAYS,
): OtherLoadSummary {
  const inWindow = (entries || []).filter((e) => {
    if (!e || typeof e.date !== 'string') return false
    const age = daysBetween(e.date, today)
    return age >= 0 && age < days
  })

  let load = 0
  let hardest: OtherEntry | null = null
  for (const e of inWindow) {
    const each = otherLoadOf(e)
    load += each
    if (!hardest || each > otherLoadOf(hardest)) hardest = e
  }
  return { load, sessions: inWindow.length, days, estimated: true, hardest }
}

/** What happened, in the athlete's own terms. */
export function describeOther(hardest: OtherEntry | null): string {
  if (!hardest) return 'other training'
  const name = hardest.activity.replace(/_/g, ' ')
  return `${hardest.minutes} minutes of ${name} at ${hardest.intensity}/10`
}

/**
 * What the coach is allowed to know, marked as the estimate it is.
 *
 * The flag is useless if it stops at the type boundary: a model handed
 * "training load 1440" will reason about it exactly as confidently as it
 * reasons about a set count. So the words carry the caveat too.
 */
export function otherTrainingLines(summary: OtherLoadSummary): string[] {
  if (!summary || !summary.sessions) return []
  const lines = [
    `Other training in the last ${summary.days} days: ${summary.sessions} session(s), ` +
      `hardest was ${describeOther(summary.hardest)}.`,
    'That load is SELF-REPORTED and estimated — duration times how hard they said it felt. ' +
      'It is a reason to ease a session, never a reason to change a specific lift.',
  ]
  return lines
}

/**
 * Days the athlete trained, counting everything.
 *
 * A frequency streak asks "did you train this week", and a run is training.
 * Returns a new sorted list; the lifting record is never mutated.
 */
export function trainingDates(finishedDates: string[], entries: OtherEntry[]): string[] {
  const all = new Set<string>(finishedDates || [])
  for (const e of entries || []) if (e && typeof e.date === 'string') all.add(e.date)
  return [...all].sort()
}
