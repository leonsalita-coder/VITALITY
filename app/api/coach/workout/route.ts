/**
 * Conversational workout generator — a real back-and-forth with the coach,
 * not a form. Takes the chat so far plus the athlete's goal; the model
 * either asks ONE short clarifying question or builds a full session
 * (warm-up + exercises, each in the same shape /api/coach/exercise uses +
 * cooldown) in one shot, biased hard toward just building rather than
 * interrogating.
 *
 * Server-side so the Anthropic key never reaches the browser (same pattern
 * as the other coach/keyed routes). No key → { error: 'no_key' }. The train
 * tile calls this through the host bridge (window.Vitality.generateWorkout)
 * — a sealed tile can't fetch, and this is a real paid call, so it only
 * fires when the athlete actually sends a message.
 */
export async function POST(req: Request): Promise<Response> {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) return Response.json({ error: 'no_key' })

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'bad_request' })
  }
  const b = body as { goal?: unknown; messages?: unknown }
  const goal = String(b?.goal || 'general fitness').trim().slice(0, 200)
  const rawMessages = Array.isArray(b?.messages) ? b.messages : []
  const messages = rawMessages
    .slice(-12)
    .map((m) => {
      const mm = m as { role?: unknown; text?: unknown }
      return { role: mm?.role === 'assistant' ? 'assistant' : 'user', text: String(mm?.text || '').slice(0, 500) }
    })
  if (!messages.length) return Response.json({ error: 'no_messages' })

  const transcript = messages.map((m) => (m.role === 'user' ? 'Athlete: ' : 'Coach: ') + m.text).join('\n')

  const prompt = `You are an athletic coach in a running conversation with your athlete. Their overall goal: ${goal}.

Conversation so far:
${transcript}

Decide ONE of two things, and return ONLY a valid JSON object (no markdown fences, no commentary):

1. If you have enough to build a real session — even from a short message, using sensible defaults for anything unstated (assume bodyweight-only and about 30-45 minutes if not said) — return:
{"kind":"workout","reply":"one short sentence describing what you built","warmup":["short warm-up item","short warm-up item"],"cooldown":["short cooldown item","short cooldown item"],"exercises":[{"name":"Exercise name","tier":1,"equipment":"Barbell","primary":["Quads"],"secondary":["Glutes"],"gist":"One sentence on what this move is for.","steps":["Setup step","Execution step","Finish step"],"cues":["Cue one","Cue two"],"startingSets":3,"startingReps":10,"startingKg":20,"restSeconds":90,"defaultSetKind":"reps_weight","perSide":false,"assisted":false}]}
Include 4 to 7 exercises, ordered with the most important first. "startingKg" is actually POUNDS (lb) — a reasonable starting weight for an intermediate athlete (0 if bodyweight-only). "defaultSetKind" is EXACTLY one of "reps_weight" (loaded reps — most lifts), "reps_only" (bodyweight reps, e.g. push-ups, box jumps), "time" (held or worked for a duration, e.g. plank, dead hang), "distance" (covered a distance, e.g. farmer's carry, sled push) or "time_distance" (both matter, e.g. a sprint or shuttle run). "perSide" is true when one side is logged at a time (single-arm rows, lunges, a one-arm carry). "assisted" is true when a machine or band REMOVES weight (assisted pull-up or dip) — the logged number is then the assistance, not the load.

2. ONLY if the message is genuinely too vague to act on at all (no activity, sport, or goal signal whatsoever), ask ONE short clarifying question instead:
{"kind":"question","text":"your one short question"}

Bias strongly toward option 1 — almost every message has enough to work with. Never ask more than one question in a row. Return ONLY the JSON object.`

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
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }],
      }),
    })
    if (!r.ok) return Response.json({ error: 'anthropic_error' })
    const j = await r.json()
    const text: string = j?.content?.[0]?.text || ''
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return Response.json({ error: 'bad_response' })
    const parsed = JSON.parse(match[0])
    if (parsed?.kind === 'question' && typeof parsed.text === 'string') return Response.json(parsed)
    if (parsed?.kind === 'workout' && Array.isArray(parsed.exercises) && parsed.exercises.length) return Response.json(parsed)
    return Response.json({ error: 'bad_response' })
  } catch {
    return Response.json({ error: 'fetch_failed' })
  }
}
