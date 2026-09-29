/**
 * The coach's tile ↔ host message protocol, and the one gate every message
 * passes through.
 *
 * The Train tile is a sealed iframe: it cannot reach the microphone, the
 * speech engine or the network, so the host does those on its behalf and
 * the two talk by postMessage. postMessage will carry anything, from
 * anyone, so the rule here is the one the rest of the bridge follows:
 * NOTHING IS TRUSTED BY SHAPE. A message is a closed set of types with an
 * exact set of fields; text is a string under a hard cap; everything else
 * — a wrong type, a missing field, an extra field, a number where text
 * should be, a novel-length string — is refused, not repaired. Repairing
 * would mean guessing what a malformed sender meant, and the sender may
 * be hostile.
 *
 * This module checks shape only. WHO sent a message (event.source against
 * the tile's own window) is the caller's job, and is not something a pure
 * function can see.
 *
 * Pure and DOM-free.
 */

/** Longest text any coach message may carry, in characters. */
export const MAX_TEXT = 2000

/** Longest error reason, in characters. A reason is a code, not prose. */
export const MAX_REASON = 200

export type CoachMessage =
  /** Tile → host: the athlete tapped the mic. Start one utterance. */
  | { type: 'coach:listen' }
  /** Host → tile: what the speech engine heard. */
  | { type: 'coach:heard'; text: string }
  /** Host → tile: the coach's answer, and whether the host is speaking it. */
  | { type: 'coach:reply'; text: string; spoken: boolean }
  /** Host → tile: the athlete asked for a workout; the tile builds it. */
  | { type: 'coach:workout-request'; text: string }
  /** Either way: something failed. `reason` is a short code. */
  | { type: 'coach:error'; reason: string }

export type CoachMessageType = CoachMessage['type']

/** Every field each type carries, exactly — no more, no fewer. */
const FIELDS: Record<CoachMessageType, readonly string[]> = {
  'coach:listen': ['type'],
  'coach:heard': ['type', 'text'],
  'coach:reply': ['type', 'text', 'spoken'],
  'coach:workout-request': ['type', 'text'],
  'coach:error': ['type', 'reason'],
}

export const COACH_MESSAGE_TYPES = Object.keys(FIELDS) as CoachMessageType[]

export type Validation =
  | { ok: true; message: CoachMessage }
  | { ok: false; reason: string }

const refuse = (reason: string): Validation => ({ ok: false, reason })

/** A non-empty string no longer than `max`. */
function boundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max
}

/**
 * Accept a message only if it is exactly one of the five shapes.
 *
 * Returns a fresh object built from the checked fields, never the input,
 * so nothing that rode along on the original can reach the caller.
 */
export function parseCoachMessage(raw: unknown): Validation {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return refuse('not_an_object')
  const input = raw as Record<string, unknown>

  const type = input.type
  if (typeof type !== 'string' || !Object.prototype.hasOwnProperty.call(FIELDS, type)) {
    return refuse('unknown_type')
  }
  const expected = FIELDS[type as CoachMessageType]

  const keys = Object.keys(input)
  if (keys.length !== expected.length || !keys.every((k) => expected.includes(k))) {
    return refuse('wrong_fields')
  }

  switch (type as CoachMessageType) {
    case 'coach:listen':
      return { ok: true, message: { type: 'coach:listen' } }
    case 'coach:heard':
    case 'coach:workout-request':
      if (!boundedText(input.text, MAX_TEXT)) return refuse('bad_text')
      return { ok: true, message: { type: type as 'coach:heard' | 'coach:workout-request', text: input.text } }
    case 'coach:reply':
      if (!boundedText(input.text, MAX_TEXT)) return refuse('bad_text')
      if (typeof input.spoken !== 'boolean') return refuse('bad_spoken')
      return { ok: true, message: { type: 'coach:reply', text: input.text, spoken: input.spoken } }
    case 'coach:error':
      if (!boundedText(input.reason, MAX_REASON)) return refuse('bad_reason')
      return { ok: true, message: { type: 'coach:error', reason: input.reason } }
  }
}
