import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { POST } from '../../app/api/coach/talk/route'
import {
  readTalkBody, buildTalkPrompt, parseTalkReply,
  MAX_GOAL, MAX_CONTEXT_LINES, MAX_LINE,
} from '../../lib/coach/talk'
import { MAX_TEXT } from '../../lib/coach/bridge'

/**
 * /api/coach/talk, with the model call mocked. Nothing here reaches the
 * network: fetch is stubbed per test and the key is a placeholder.
 */

const KEY = 'test-key-not-real'
const request = (body: unknown) =>
  new Request('http://localhost/api/coach/talk', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

/** A model response whose first text block is `text`. */
const modelSays = (text: string, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify({ content: [{ type: 'text', text }] }), { status }))

const ORIGINAL_KEY = process.env.ANTHROPIC_API_KEY
beforeEach(() => { process.env.ANTHROPIC_API_KEY = KEY })
afterEach(() => {
  vi.unstubAllGlobals()
  if (ORIGINAL_KEY === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = ORIGINAL_KEY
})

describe('the route', () => {
  it('answers chat as chat', async () => {
    vi.stubGlobal('fetch', modelSays('{"kind":"chat","text":"Three sessions in — solid week."}'))
    const res = await POST(request({ text: 'Hey mentor, how am I doing?' }))
    expect(await res.json()).toEqual({ kind: 'chat', text: 'Three sessions in — solid week.' })
  })

  it('hands a workout request back rather than building it', async () => {
    vi.stubGlobal('fetch', modelSays('{"kind":"workout","request":"20 minute leg workout"}'))
    const res = await POST(request({ text: 'give me a 20 minute leg workout' }))
    expect(await res.json()).toEqual({ kind: 'workout', request: '20 minute leg workout' })
  })

  it('calls the same endpoint, model and headers as the workout route, with the key server-side', async () => {
    const fetchMock = modelSays('{"kind":"chat","text":"ok"}')
    vi.stubGlobal('fetch', fetchMock)
    await POST(request({ text: 'hi', context: { goal: 'Get stronger', lines: ['3 sessions this week'] } }))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    const headers = init.headers as Record<string, string>
    expect(headers['x-api-key']).toBe(KEY)
    expect(headers['anthropic-version']).toBe('2023-06-01')
    const sent = JSON.parse(String(init.body))
    expect(sent.model).toBe('claude-haiku-4-5-20251001')
    expect(sent.messages[0].content).toContain('Get stronger')
    expect(sent.messages[0].content).toContain('3 sessions this week')
  })

  it('says no_key, and calls nothing, when there is no key', async () => {
    delete process.env.ANTHROPIC_API_KEY
    const fetchMock = modelSays('{"kind":"chat","text":"ok"}')
    vi.stubGlobal('fetch', fetchMock)
    expect(await (await POST(request({ text: 'hi' }))).json()).toEqual({ error: 'no_key' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a body that is not JSON, or has no usable text, without calling the model', async () => {
    const fetchMock = modelSays('{"kind":"chat","text":"ok"}')
    vi.stubGlobal('fetch', fetchMock)
    expect(await (await POST(request('not json'))).json()).toEqual({ error: 'bad_request' })
    expect(await (await POST(request({ text: '' }))).json()).toEqual({ error: 'no_text' })
    expect(await (await POST(request({ text: 'x'.repeat(MAX_TEXT + 1) }))).json()).toEqual({ error: 'no_text' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports an upstream failure as anthropic_error', async () => {
    vi.stubGlobal('fetch', modelSays('{}', 529))
    expect(await (await POST(request({ text: 'hi' }))).json()).toEqual({ error: 'anthropic_error' })
  })

  it('reports a network failure as fetch_failed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    expect(await (await POST(request({ text: 'hi' }))).json()).toEqual({ error: 'fetch_failed' })
  })

  it('reports an answer in neither shape as bad_response, never passing it on', async () => {
    vi.stubGlobal('fetch', modelSays('Sure! Here is a great leg workout: squats...'))
    expect(await (await POST(request({ text: 'hi' }))).json()).toEqual({ error: 'bad_response' })
  })
})

describe('reading the body', () => {
  it('trims the text and keeps a well-formed context', () => {
    expect(readTalkBody({ text: '  hi  ', context: { goal: ' Run a 5k ', lines: [' a ', 'b'] } }))
      .toEqual({ ok: true, text: 'hi', context: { goal: 'Run a 5k', lines: ['a', 'b'] } })
  })

  it('treats context as optional', () => {
    expect(readTalkBody({ text: 'hi' })).toEqual({ ok: true, text: 'hi', context: {} })
  })

  it('refuses a body that is not an object', () => {
    for (const body of [null, 'hi', 3, ['hi']]) expect(readTalkBody(body)).toEqual({ ok: false, error: 'bad_request' })
  })

  it('refuses missing, empty, non-string and over-long text', () => {
    for (const text of [undefined, '', '   ', 5, 'x'.repeat(MAX_TEXT + 1)]) {
      expect(readTalkBody({ text })).toEqual({ ok: false, error: 'no_text' })
    }
    // control: exactly the cap is fine
    expect(readTalkBody({ text: 'x'.repeat(MAX_TEXT) }).ok).toBe(true)
  })

  it('drops anything outside the documented context, and caps what it keeps', () => {
    const read = readTalkBody({
      text: 'hi',
      context: {
        goal: 'g'.repeat(MAX_GOAL + 50),
        lines: [...Array(MAX_CONTEXT_LINES + 5)].map((_, i) => (i === 0 ? 'l'.repeat(MAX_LINE + 50) : `line ${i}`)),
        secret: 'must not be forwarded',
      },
    })
    if (!read.ok) throw new Error('expected ok')
    expect(Object.keys(read.context).sort()).toEqual(['goal', 'lines'])
    expect(read.context.goal).toHaveLength(MAX_GOAL)
    expect(read.context.lines).toHaveLength(MAX_CONTEXT_LINES)
    expect(read.context.lines![0]).toHaveLength(MAX_LINE)
  })

  it('drops context lines that are not text, and an empty goal', () => {
    const read = readTalkBody({ text: 'hi', context: { goal: '  ', lines: [1, null, '', 'real'] } })
    expect(read).toEqual({ ok: true, text: 'hi', context: { lines: ['real'] } })
  })

  it('leaves out lines entirely when none survive', () => {
    expect(readTalkBody({ text: 'hi', context: { lines: [1, ''] } })).toEqual({ ok: true, text: 'hi', context: {} })
  })

  it('ignores a context that is not an object', () => {
    expect(readTalkBody({ text: 'hi', context: 'goal: win' })).toEqual({ ok: true, text: 'hi', context: {} })
  })

  it('treats a null context as none, rather than throwing', () => {
    /* typeof null is 'object': a caller sending context: null is the
       ordinary "nothing to add", and must not reach .goal on null. */
    expect(readTalkBody({ text: 'hi', context: null })).toEqual({ ok: true, text: 'hi', context: {} })
  })
})

describe('the prompt', () => {
  it('carries the words, and the context only when there is some', () => {
    const bare = buildTalkPrompt('how am I doing?', {})
    expect(bare).toContain('how am I doing?')
    expect(bare).not.toContain('Their overall goal')
    expect(bare).not.toContain('What you know about their training')
    const full = buildTalkPrompt('how am I doing?', { goal: 'Get strong', lines: ['3 sessions this week'] })
    expect(full).toContain('Their overall goal: Get strong')
    expect(full).toContain('- 3 sessions this week')
  })

  it('names both answer shapes', () => {
    const p = buildTalkPrompt('hi', {})
    expect(p).toContain('{"kind":"workout","request"')
    expect(p).toContain('{"kind":"chat","text"')
  })
})

describe('reading the model\'s answer', () => {
  it('accepts the two shapes, trimmed, even inside surrounding prose or fences', () => {
    expect(parseTalkReply('{"kind":"chat","text":" Nice. "}')).toEqual({ kind: 'chat', text: 'Nice.' })
    expect(parseTalkReply('```json\n{"kind":"workout","request":"legs, 20 min"}\n```'))
      .toEqual({ kind: 'workout', request: 'legs, 20 min' })
  })

  it('refuses anything else', () => {
    for (const raw of [
      '', 'no json here', '{not json}', '{"kind":"chat"}', '{"kind":"chat","text":""}',
      '{"kind":"chat","text":5}', '{"kind":"workout","text":"legs"}', '{"kind":"workout","request":"  "}',
      '{"kind":"plan","text":"x"}', `{"kind":"chat","text":"${'x'.repeat(MAX_TEXT + 1)}"}`,
    ]) {
      expect(parseTalkReply(raw)).toBeNull()
    }
    // control: the same parser accepts a well-formed one
    expect(parseTalkReply('{"kind":"chat","text":"ok"}')).not.toBeNull()
  })

  it('accepts text of exactly the cap', () => {
    expect(parseTalkReply(`{"kind":"chat","text":"${'x'.repeat(MAX_TEXT)}"}`)).not.toBeNull()
  })
})
