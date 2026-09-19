/**
 * Exercise classifier — turns a free-typed exercise name into the same shape
 * Train's built-in library uses (tier, equipment, muscles, form, starting
 * numbers), so "add a lift" isn't limited to a handful of presets.
 *
 * Server-side so the Anthropic key never reaches the browser — same pattern
 * as YOUTUBE_API_KEY / FINNHUB_API_KEY. Reads ANTHROPIC_API_KEY (.env.local
 * locally, Vercel env in prod). No key → { error: 'no_key' } so the tile can
 * tell the user to add their own. The train tile calls this through the host
 * bridge (window.Vitality.classify) — a sealed tile can't fetch, and this is
 * a real paid call, so the tile caches the result and never re-classifies
 * the same exercise name twice.
 */
export async function GET(req: Request): Promise<Response> {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) return Response.json({ error: 'no_key' })

  const name = (new URL(req.url).searchParams.get('name') || '').trim()
  if (!name) return Response.json({ error: 'no_name' })

  const prompt = `You are a strength & conditioning database. Given one exercise name, return ONLY a valid JSON object (no markdown fences, no commentary) with exactly this shape:
{
  "tier": 1,
  "equipment": "Barbell",
  "primary": ["Chest"],
  "secondary": ["Triceps"],
  "gist": "One sentence on what this lift is for.",
  "steps": ["Setup step", "Execution step", "Finish step"],
  "cues": ["Coaching cue one", "Coaching cue two"],
  "startingSets": 3,
  "startingReps": 10,
  "startingKg": 20,
  "restSeconds": 90,
  "defaultSetKind": "reps_weight",
  "perSide": false,
  "assisted": false
}
Rules: "tier" is 1 for a primary compound/heavy lift, 2 for a secondary compound/moderate lift, 3 for an isolation/accessory lift. "defaultSetKind" is EXACTLY one of "reps_weight" (loaded reps — most lifts), "reps_only" (bodyweight reps, e.g. push-ups, box jumps), "time" (held or worked for a duration, e.g. plank, dead hang), "distance" (covered a distance, e.g. farmer's carry, sled push) or "time_distance" (both matter, e.g. a sprint or a timed run). "perSide" is true when one side is logged at a time (single-arm rows, lunges, a one-arm carry). "assisted" is true when a machine or band REMOVES weight (assisted pull-up or dip) — in that case the logged number is the assistance, not the load. "steps" has exactly 3 short entries. "cues" has exactly 2 short entries. "startingKg" is actually POUNDS (lb) — a reasonable STARTING weight for an intermediate lifter (0 if bodyweight-only, ignore for cardio/mobility movements and just estimate a token value). Keep every string short and plain.

Exercise name: "${name.replace(/"/g, "'")}"

Return ONLY the JSON object.`

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
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      }),
    })
    if (!r.ok) return Response.json({ error: 'anthropic_error' })
    const j = await r.json()
    const text: string = j?.content?.[0]?.text || ''
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return Response.json({ error: 'bad_response' })
    const parsed = JSON.parse(match[0])
    return Response.json({ exercise: parsed })
  } catch {
    return Response.json({ error: 'fetch_failed' })
  }
}
