# Coach voice — the server side

Built without touching the tile or `lib/tiles/useTileHost.ts`. Nothing calls
any of this yet: wiring waits until the voice path is proven on an iPhone.

## What exists

- **`lib/coach/bridge.ts`** — the tile ↔ host protocol. Five types, exact
  field sets, text a non-empty string ≤ 2,000 chars, reason ≤ 200.
  `parseCoachMessage(raw)` refuses anything else (wrong type, missing or
  extra field, inherited field, non-string text, huge text, truthy-but-not-
  boolean `spoken`) and returns a fresh object, never the input. It checks
  shape only; *who* sent a message (`event.source`) stays the caller's job.
- **`lib/coach/talk.ts`** — the pure half of the talk route: `readTalkBody`
  (text required and capped; `context` trimmed to `{ goal?, lines? }`,
  anything else dropped), `buildTalkPrompt`, `parseTalkReply` (exactly
  `{kind:'chat',text}` or `{kind:'workout',request}`, else null).
- **`app/api/coach/talk/route.ts`** — `POST { text, context? }` →
  `{ kind: 'chat', text }` | `{ kind: 'workout', request }` | `{ error }`.
  Same raw `fetch`, endpoint, headers, model (`claude-haiku-4-5-20251001`)
  and key handling as `/api/coach/workout`; no key → `{ error: 'no_key' }`.
  Imports `lib/coach/talk` relatively because vitest has no `@/` alias and
  the route is tested directly.

`context` shape, deliberately minimal: `goal` (≤ 200 chars) and `lines`
(≤ 20 strings, ≤ 200 chars each) — the same kind of short facts the tile
already assembles for the workout coach.

## Mutation sweep

The harness only sweeps `lib/train`, and it was not to be edited tonight, so
a scratch runner imported the harness's own `mutationsFor` and applied its
operators to these files, running `tests/coach/` per mutant (killed = any
failed test or suite, the harness's rule), restoring after each.

| file | mutants | killed | left |
| --- | --- | --- | --- |
| `lib/coach/bridge.ts` | 20 | 19 | 1 |
| `lib/coach/talk.ts` | 28 | 26 | 2 |
| `app/api/coach/talk/route.ts` | 5 | 5 | 0 |

Left, with reasons:

- `bridge.ts:55` and `talk.ts:45`, `true` → `false` **inside a type
  declaration** (`{ ok: true; … }`). Types are erased, so no runtime test can
  see them — but `tsc --noEmit` rejects both (checked: 4 and 2 errors), and
  `tsc` is part of `verify`. Killed by the gate, not by vitest.
- `talk.ts:103` `if (!match) return null` removed — **equivalent**: the
  `JSON.parse(match[0])` that follows is inside the `try`, so a null match
  throws there and the `catch` returns null, the same result.

One real gap found and closed on the way: `context: null` (typeof `'object'`)
reached `.goal` on null under the `&&` → `||` mutant; now pinned.

## Key exposure

Built with `ANTHROPIC_API_KEY=sk-ant-CANARY-do-not-ship-7f3e91`, then grepped:
the client bundle (`.next/static`, 24 JS chunks) contains neither the name
`ANTHROPIC_API_KEY`, nor `sk-ant-`, nor the canary. Positive control: the
server bundle for the route does reference `process.env.ANTHROPIC_API_KEY`,
and the canary was inlined nowhere, server side included.

## Not done

The two real calls ("Hey mentor, how am I doing?" and "give me a 20 minute
leg workout") were **not** made: no `ANTHROPIC_API_KEY` exists on this
machine (no `.env.local`, not in the environment). The route sends the key
as `x-api-key`, so an OAuth login could not stand in without changing the
route. To run them: add the key to `.env.local`, `npm run dev`, then

    curl -s localhost:3000/api/coach/talk -H 'content-type: application/json' \
      -d '{"text":"Hey mentor, how am I doing?"}'
    curl -s localhost:3000/api/coach/talk -H 'content-type: application/json' \
      -d '{"text":"give me a 20 minute leg workout"}'
