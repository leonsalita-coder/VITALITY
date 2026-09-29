import { describe, it, expect } from 'vitest'
import { parseCoachMessage, MAX_TEXT, MAX_REASON, COACH_MESSAGE_TYPES } from '../../lib/coach/bridge'

/**
 * The coach protocol is a closed set of five shapes. Anything else that
 * arrives over postMessage — from the tile, from a stray extension, from a
 * page that framed ours — is refused, not repaired.
 */

const accepted = (raw: unknown) => {
  const v = parseCoachMessage(raw)
  if (!v.ok) throw new Error(`expected accept, got refuse: ${v.reason}`)
  return v.message
}
const refused = (raw: unknown) => {
  const v = parseCoachMessage(raw)
  if (v.ok) throw new Error(`expected refuse, got accept: ${JSON.stringify(v.message)}`)
  return v.reason
}

describe('the five shapes are accepted', () => {
  it('lists exactly the five types', () => {
    expect([...COACH_MESSAGE_TYPES].sort()).toEqual([
      'coach:error', 'coach:heard', 'coach:listen', 'coach:reply', 'coach:workout-request',
    ])
  })

  it('accepts listen, which carries nothing', () => {
    expect(accepted({ type: 'coach:listen' })).toEqual({ type: 'coach:listen' })
  })

  it('accepts heard with its text', () => {
    expect(accepted({ type: 'coach:heard', text: 'how am I doing' }))
      .toEqual({ type: 'coach:heard', text: 'how am I doing' })
  })

  it('accepts a reply with its text and whether it is spoken, either way', () => {
    expect(accepted({ type: 'coach:reply', text: 'Solid week.', spoken: true }))
      .toEqual({ type: 'coach:reply', text: 'Solid week.', spoken: true })
    expect(accepted({ type: 'coach:reply', text: 'Solid week.', spoken: false }))
      .toEqual({ type: 'coach:reply', text: 'Solid week.', spoken: false })
  })

  it('accepts a workout request with its text', () => {
    expect(accepted({ type: 'coach:workout-request', text: '20 minute legs' }))
      .toEqual({ type: 'coach:workout-request', text: '20 minute legs' })
  })

  it('accepts an error with its reason', () => {
    expect(accepted({ type: 'coach:error', reason: 'not-allowed' }))
      .toEqual({ type: 'coach:error', reason: 'not-allowed' })
  })

  it('returns a fresh object, not the one it was handed', () => {
    const input = { type: 'coach:heard', text: 'hi' }
    const out = accepted(input)
    expect(out).toEqual(input)       // control: same content
    expect(out).not.toBe(input)
  })
})

describe('anything that is not an object is refused', () => {
  it.each([
    ['null', null], ['undefined', undefined], ['a string', 'coach:listen'], ['a number', 7],
    ['a boolean', true], ['an array', [{ type: 'coach:listen' }]],
  ])('refuses %s', (_label, raw) => {
    expect(refused(raw)).toBe('not_an_object')
  })
})

describe('a wrong or missing type is refused', () => {
  it.each([
    ['an unknown type', { type: 'coach:speak', text: 'x' }],
    ['a near miss', { type: 'coach:Listen' }],
    ['no type at all', { text: 'hello' }],
    ['a non-string type', { type: 1 }],
    ['an inherited-name type', { type: 'toString' }],
    ['the bridge shim\'s shape', { source: 'vitality-tile', type: 'save', id: 'v1' }],
  ])('refuses %s', (_label, raw) => {
    expect(refused(raw)).toBe('unknown_type')
  })
})

describe('the field set must be exact', () => {
  it('refuses a message missing its text', () => {
    expect(refused({ type: 'coach:heard' })).toBe('wrong_fields')
    expect(refused({ type: 'coach:workout-request' })).toBe('wrong_fields')
  })

  it('refuses a reply missing spoken', () => {
    expect(refused({ type: 'coach:reply', text: 'hi' })).toBe('wrong_fields')
  })

  it('refuses an error missing its reason', () => {
    expect(refused({ type: 'coach:error' })).toBe('wrong_fields')
  })

  it('refuses an extra field on every type', () => {
    expect(refused({ type: 'coach:listen', text: 'x' })).toBe('wrong_fields')
    expect(refused({ type: 'coach:heard', text: 'hi', html: '<b>hi</b>' })).toBe('wrong_fields')
    expect(refused({ type: 'coach:reply', text: 'hi', spoken: true, source: 'x' })).toBe('wrong_fields')
    expect(refused({ type: 'coach:workout-request', text: 'hi', minutes: 20 })).toBe('wrong_fields')
    expect(refused({ type: 'coach:error', reason: 'x', stack: 'at …' })).toBe('wrong_fields')
  })

  it('refuses the right number of fields with the wrong names', () => {
    /* A length check alone would pass this; the names have to match too. */
    expect(refused({ type: 'coach:heard', words: 'hi' })).toBe('wrong_fields')
    expect(refused({ type: 'coach:reply', text: 'hi', said: true })).toBe('wrong_fields')
  })

  it('does not count an inherited property as a field', () => {
    const sneaky = Object.create({ text: 'inherited' })
    sneaky.type = 'coach:heard'
    expect(refused(sneaky)).toBe('wrong_fields')
  })
})

describe('text is a real, bounded string', () => {
  it.each([
    ['a number', 42], ['null', null], ['an object', { toString: () => 'hi' }], ['an array', ['hi']],
  ])('refuses text that is %s', (_label, text) => {
    expect(refused({ type: 'coach:heard', text })).toBe('bad_text')
  })

  it('refuses empty and whitespace-only text — there is nothing to answer', () => {
    expect(refused({ type: 'coach:heard', text: '' })).toBe('bad_text')
    expect(refused({ type: 'coach:heard', text: '   \n ' })).toBe('bad_text')
  })

  it('accepts text of exactly MAX_TEXT and refuses one character more', () => {
    expect(accepted({ type: 'coach:heard', text: 'a'.repeat(MAX_TEXT) }).type).toBe('coach:heard')
    expect(refused({ type: 'coach:heard', text: 'a'.repeat(MAX_TEXT + 1) })).toBe('bad_text')
  })

  it('refuses huge text on every type that carries it', () => {
    const huge = 'x'.repeat(1_000_000)
    expect(refused({ type: 'coach:heard', text: huge })).toBe('bad_text')
    expect(refused({ type: 'coach:workout-request', text: huge })).toBe('bad_text')
    expect(refused({ type: 'coach:reply', text: huge, spoken: true })).toBe('bad_text')
  })

  it('applies the same text rules to a reply as to what was heard', () => {
    expect(refused({ type: 'coach:reply', text: '', spoken: true })).toBe('bad_text')
    expect(refused({ type: 'coach:reply', text: 5, spoken: true })).toBe('bad_text')
    expect(refused({ type: 'coach:workout-request', text: 5 })).toBe('bad_text')
  })
})

describe('spoken is a boolean, not something truthy', () => {
  it.each([['a string', 'true'], ['a number', 1], ['null', null]])('refuses spoken as %s', (_label, spoken) => {
    expect(refused({ type: 'coach:reply', text: 'hi', spoken })).toBe('bad_spoken')
  })
})

describe('an error reason is a short code', () => {
  it('accepts exactly MAX_REASON and refuses one more', () => {
    expect(accepted({ type: 'coach:error', reason: 'r'.repeat(MAX_REASON) }).type).toBe('coach:error')
    expect(refused({ type: 'coach:error', reason: 'r'.repeat(MAX_REASON + 1) })).toBe('bad_reason')
  })

  it('refuses a missing-in-spirit reason: empty, or not a string', () => {
    expect(refused({ type: 'coach:error', reason: '' })).toBe('bad_reason')
    expect(refused({ type: 'coach:error', reason: 404 })).toBe('bad_reason')
  })
})
