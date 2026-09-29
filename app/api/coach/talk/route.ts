/**
 * The coach, talking — the default answer to anything the athlete says or
 * types. Either a warm, brief reply ({ kind: 'chat', text }) or, when they
 * are asking for a workout, the request handed back ({ kind: 'workout',
 * request }) so the tile can run it through its own generateWorkout path.
 * The logic lives in lib/coach/talk.ts; this file is the network edge.
 *
 * Input: { text, context? } — see TalkContext for the context shape.
 *
 * Server-side so the Anthropic key never reaches the browser (same pattern
 * and model as /api/coach/workout). No key → { error: 'no_key' }. Nothing
 * calls this yet: wiring waits until the voice path is proven on a phone.
 */
/* Relative, not '@/lib': vitest has no path alias, and this route is tested
   directly (tests/coach/talk-route.test.ts). */
import { readTalkBody, buildTalkPrompt, parseTalkReply } from '../../../../lib/coach/talk'

export async function POST(req: Request): Promise<Response> {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) return Response.json({ error: 'no_key' })

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'bad_request' })
  }
  const read = readTalkBody(body)
  if (!read.ok) return Response.json({ error: read.error })

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        messages: [{ role: 'user', content: buildTalkPrompt(read.text, read.context) }],
      }),
    })
    if (!r.ok) return Response.json({ error: 'anthropic_error' })
    const j = await r.json()
    const reply = parseTalkReply(j?.content?.[0]?.text || '')
    if (!reply) return Response.json({ error: 'bad_response' })
    return Response.json(reply)
  } catch {
    return Response.json({ error: 'fetch_failed' })
  }
}
