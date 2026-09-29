/**
 * The coach's everyday voice: the pure half of /api/coach/talk.
 *
 * Two ways to answer anything the athlete says or types. The default is
 * chat — a warm, brief friend who knows their training. The exception is a
 * request for a workout, which this route does NOT build: it hands the
 * request back as `{ kind: 'workout', request }` so the tile can send it
 * down its existing generateWorkout path, which alone knows the athlete's
 * exercises, equipment and time. Building workouts in two places is how
 * two answers come to disagree.
 *
 * Split from the route so it can be tested without a network or a key,
 * and because a Next.js route file may only export its handlers.
 *
 * Pure and DOM-free.
 */

import { MAX_TEXT } from './bridge'

/**
 * What the tile may send alongside the words — all of it optional.
 *
 * Deliberately small: the tile already assembles the lines it gives the
 * workout coach (patterns, accuracy, other training), and the same lines
 * are what this voice needs. Nothing here is structured enough to act on;
 * it is context to talk from.
 *
 *   goal   the athlete's overall goal, one sentence
 *   lines  up to MAX_CONTEXT_LINES short facts, e.g. "3 sessions this week"
 */
export interface TalkContext {
  goal?: string
  lines?: string[]
}

export const MAX_GOAL = 200
export const MAX_CONTEXT_LINES = 20
export const MAX_LINE = 200

export type TalkReply =
  | { kind: 'chat'; text: string }
  | { kind: 'workout'; request: string }

export type TalkBody =
  | { ok: true; text: string; context: TalkContext }
  | { ok: false; error: 'bad_request' | 'no_text' }

/**
 * The request body, checked. Text is required and capped like every coach
 * message; context is trimmed to its documented shape and anything else
 * in it is dropped rather than forwarded to the model.
 */
export function readTalkBody(body: unknown): TalkBody {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'bad_request' }
  const b = body as { text?: unknown; context?: unknown }
  if (typeof b.text !== 'string' || !b.text.trim() || b.text.length > MAX_TEXT) return { ok: false, error: 'no_text' }

  const context: TalkContext = {}
  const c = (b.context && typeof b.context === 'object' ? b.context : {}) as { goal?: unknown; lines?: unknown }
  if (typeof c.goal === 'string' && c.goal.trim()) context.goal = c.goal.trim().slice(0, MAX_GOAL)
  if (Array.isArray(c.lines)) {
    const lines = c.lines
      .filter((l): l is string => typeof l === 'string' && l.trim().length > 0)
      .slice(0, MAX_CONTEXT_LINES)
      .map((l) => l.trim().slice(0, MAX_LINE))
    if (lines.length) context.lines = lines
  }
  return { ok: true, text: b.text.trim(), context }
}

/** The single prompt sent to the model. */
export function buildTalkPrompt(text: string, context: TalkContext): string {
  const known = [
    context.goal ? `Their overall goal: ${context.goal}` : '',
    context.lines?.length ? `What you know about their training:\n${context.lines.map((l) => `- ${l}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n')

  return `You are the athlete's coach, and you talk like a warm, brief friend who knows their training: plain words, one to three short sentences, no lists, no headings. Never invent numbers you were not given. If you do not know something, say so briefly.
${known ? `\n${known}\n` : ''}
The athlete just said:
"""
${text}
"""

Decide ONE of two things, and return ONLY a valid JSON object (no markdown fences, no commentary):

1. If they are asking you to build, plan or give them a workout or session, do NOT write the workout. Return their request, restated in one short line with every detail they gave (time, body part, equipment, focus):
{"kind":"workout","request":"the request in one line"}

2. Otherwise, answer them:
{"kind":"chat","text":"your reply"}

Return ONLY the JSON object.`
}

/**
 * The model's answer, checked. Returns null for anything that is not
 * exactly one of the two shapes with a usable, bounded string — the route
 * turns null into an error rather than passing on something half-formed.
 */
export function parseTalkReply(raw: string): TalkReply | null {
  const match = String(raw || '').match(/\{[\s\S]*\}/)
  if (!match) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(match[0])
  } catch {
    return null
  }
  const p = parsed as { kind?: unknown; text?: unknown; request?: unknown }
  const usable = (s: unknown): s is string => typeof s === 'string' && s.trim().length > 0 && s.length <= MAX_TEXT
  if (p?.kind === 'chat' && usable(p.text)) return { kind: 'chat', text: p.text.trim() }
  if (p?.kind === 'workout' && usable(p.request)) return { kind: 'workout', request: p.request.trim() }
  return null
}
