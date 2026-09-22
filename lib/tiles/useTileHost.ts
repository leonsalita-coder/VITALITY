'use client'

import { useCallback, useEffect, useRef } from 'react'
import { validatePublish, isReadableSlot } from './metricsContract'
import { tileStore } from './tileStore'
import { syncEnabled, syncSave, syncLoad } from '@/lib/sync'
import { supa } from './tileSupabase'

/**
 * useTileHost is the host side of the Vitality bridge, fixed for MANY tiles.
 *
 * The bug it fixes: the BUILD71 host closed a single storage key over one
 * message listener, so ANY tile's save overwrote whatever the host last
 * pointed at. Render two tiles and they clobber each other.
 *
 * The fix: keep a live Window to tileId map keyed by each iframe's
 * contentWindow. That WindowProxy is a stable reference and it equals
 * event.source for messages that frame posts, so every save/load is routed to
 * the tile whose window actually sent it. N tiles on one page each resolve to
 * their own key. No clobber.
 *
 * register(win, tileId) is called from each iframe instance (see TilePreview),
 * which captures its own tileId, so a late onLoad can never bind a window to
 * the wrong tile. unregister(win) drops a window when its iframe unmounts.
 *
 * The map is reset whenever userId changes, so a stale window mapping from a
 * previous user can never route one user's data into another's namespace.
 */
export function useTileHost(
  userId: string,
  onActivity?: (info: { tileId: string; type: 'save' | 'load' | 'report' | 'publish'; count: number }) => void,
  /**
   * Injected handler for a tile's Vitality.report() stream (one numeric life-stream
   * into Vee). Passed in (not imported) so this hook stays decoupled from the
   * server action; the create page wires reportStream here. The host only routes
   * and forwards; the server action validates + RLS-writes.
   */
  onReport?: (stream: unknown, tileId: string) => void,
) {
  const reg = useRef<WeakMap<Window, string>>(new WeakMap())

  // reset the map synchronously when the user changes (before any new register)
  const lastUser = useRef(userId)
  if (lastUser.current !== userId) {
    reg.current = new WeakMap()
    lastUser.current = userId
  }

  const activity = useRef(onActivity)
  activity.current = onActivity

  const report = useRef(onReport)
  report.current = onReport

  const register = useCallback((win: Window | null, tileId: string) => {
    if (win) reg.current.set(win, tileId)
  }, [])

  const unregister = useCallback((win: Window | null) => {
    if (win) reg.current.delete(win)
  }, [])

  useEffect(() => {
    async function onMessage(e: MessageEvent) {
      const msg = e.data
      if (!msg || msg.source !== 'vitality-tile') return
      const src = e.source as Window | null
      if (!src) return

      // TikTok follower lookup — the host fetches on the sealed tile's behalf,
      // since tiles can't reach the network themselves. Keyless + public
      // (tikwm), returns only a follower COUNT, touches no user storage, so it
      // needs no tileId and runs before the registry gate. This is the demo's
      // zero-setup live-data door — no MCP connector, no /sweep required.
      if (msg.type === 'tiktok') {
        const handle = String(msg.handle || '').replace(/^@+/, '').trim()
        if (!handle) {
          src.postMessage({ source: 'vitality-host', type: 'tiktok:error', id: msg.id, reason: 'no_handle' }, '*')
          return
        }
        try {
          const r = await fetch('https://www.tikwm.com/api/user/info?unique_id=' + encodeURIComponent(handle))
          const j = await r.json()
          const count = j?.data?.stats?.followerCount
          if (typeof count === 'number' && count >= 0) {
            src.postMessage({ source: 'vitality-host', type: 'tiktok:result', id: msg.id, count }, '*')
          } else {
            src.postMessage({ source: 'vitality-host', type: 'tiktok:error', id: msg.id, reason: String(j?.msg || 'no_data') }, '*')
          }
        } catch {
          src.postMessage({ source: 'vitality-host', type: 'tiktok:error', id: msg.id, reason: 'fetch_failed' }, '*')
        }
        return
      }

      // YouTube subscribers — routed through /api/youtube/subs so the API key
      // stays server-side (YouTube is keyed, unlike TikTok). no_key → the tile
      // tells the user to add a free key.
      if (msg.type === 'youtube') {
        const handle = String(msg.handle || '').replace(/^@+/, '').trim()
        if (!handle) {
          src.postMessage({ source: 'vitality-host', type: 'youtube:error', id: msg.id, reason: 'no_handle' }, '*')
          return
        }
        try {
          const r = await fetch('/api/youtube/subs?handle=' + encodeURIComponent(handle))
          const j = await r.json()
          if (typeof j?.count === 'number') {
            src.postMessage({ source: 'vitality-host', type: 'youtube:result', id: msg.id, count: j.count }, '*')
          } else {
            src.postMessage({ source: 'vitality-host', type: 'youtube:error', id: msg.id, reason: String(j?.error || 'no_data') }, '*')
          }
        } catch {
          src.postMessage({ source: 'vitality-host', type: 'youtube:error', id: msg.id, reason: 'fetch_failed' }, '*')
        }
        return
      }

      // Stock price — routed through /api/finance/quote so the Finnhub key stays
      // server-side. Returns the latest price for one symbol.
      if (msg.type === 'stock') {
        const symbol = String(msg.symbol || '').toUpperCase().replace(/[^A-Z0-9.:\-]/g, '').trim()
        if (!symbol) {
          src.postMessage({ source: 'vitality-host', type: 'stock:error', id: msg.id, reason: 'no_symbol' }, '*')
          return
        }
        try {
          const r = await fetch('/api/finance/quote?symbol=' + encodeURIComponent(symbol))
          const j = await r.json()
          if (typeof j?.price === 'number') {
            src.postMessage({ source: 'vitality-host', type: 'stock:result', id: msg.id, price: j.price }, '*')
          } else {
            src.postMessage({ source: 'vitality-host', type: 'stock:error', id: msg.id, reason: String(j?.error || 'no_data') }, '*')
          }
        } catch {
          src.postMessage({ source: 'vitality-host', type: 'stock:error', id: msg.id, reason: 'fetch_failed' }, '*')
        }
        return
      }

      // Exercise classify — routed through /api/coach/exercise so the
      // Anthropic key stays server-side. Turns a free-typed exercise name
      // into the Train tile's library shape (tier, muscles, form, starting
      // numbers). This is a real paid call, so the tile is responsible for
      // caching results and never re-classifying the same name.
      if (msg.type === 'classify') {
        const name = String(msg.name || '').trim().slice(0, 80)
        if (!name) {
          src.postMessage({ source: 'vitality-host', type: 'classify:error', id: msg.id, reason: 'no_name' }, '*')
          return
        }
        try {
          const r = await fetch('/api/coach/exercise?name=' + encodeURIComponent(name))
          const j = await r.json()
          if (j?.exercise) {
            src.postMessage({ source: 'vitality-host', type: 'classify:result', id: msg.id, exercise: j.exercise }, '*')
          } else {
            src.postMessage({ source: 'vitality-host', type: 'classify:error', id: msg.id, reason: String(j?.error || 'no_data') }, '*')
          }
        } catch {
          src.postMessage({ source: 'vitality-host', type: 'classify:error', id: msg.id, reason: 'fetch_failed' }, '*')
        }
        return
      }

      // Conversational workout generator — routed through /api/coach/workout
      // (POST, not GET: it carries the whole chat, not a few flat fields) so
      // the Anthropic key stays server-side. Returns either a clarifying
      // question or a full session; the tile decides which from `kind`.
      // Also a real paid call — only fires when the athlete sends a message.
      if (msg.type === 'generateWorkout') {
        try {
          const r = await fetch('/api/coach/workout', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ goal: msg.goal, messages: msg.messages }),
          })
          const j = await r.json()
          if (j?.kind === 'question' || j?.kind === 'workout') {
            src.postMessage({ source: 'vitality-host', type: 'generateWorkout:result', id: msg.id, result: j }, '*')
          } else {
            src.postMessage({ source: 'vitality-host', type: 'generateWorkout:error', id: msg.id, reason: String(j?.error || 'no_data') }, '*')
          }
        } catch {
          src.postMessage({ source: 'vitality-host', type: 'generateWorkout:error', id: msg.id, reason: 'fetch_failed' }, '*')
        }
        return
      }

      // Post-session note — routed through /api/coach/note so the Anthropic
      // key stays server-side. A compact digest in, one short observation
      // out (the mentor's "noticer" role, automated for Train). Also a real
      // paid call — the tile only fires it once per finished session.
      if (msg.type === 'getInsight') {
        try {
          const r = await fetch('/api/coach/note', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ goal: msg.goal, digest: msg.digest }),
          })
          const j = await r.json()
          if (typeof j?.note === 'string') {
            src.postMessage({ source: 'vitality-host', type: 'getInsight:result', id: msg.id, note: j.note }, '*')
          } else {
            src.postMessage({ source: 'vitality-host', type: 'getInsight:error', id: msg.id, reason: String(j?.error || 'no_data') }, '*')
          }
        } catch {
          src.postMessage({ source: 'vitality-host', type: 'getInsight:error', id: msg.id, reason: 'fetch_failed' }, '*')
        }
        return
      }

      // Progress photo — the host (not the sealed tile) uploads the image
      // bytes straight to the owner's own Supabase Storage bucket
      // (progress-photos, from supabase/photos.sql) using the same anon-key
      // client every other Supabase write in this app uses, then asks
      // /api/coach/photo for one training-relevant observation. If Storage
      // isn't set up yet the upload just no-ops (url stays null) — the tile
      // shows that plainly rather than pretending it saved.
      if (msg.type === 'addProgressPhoto') {
        try {
          const base64 = String(msg.base64 || '')
          const mime = String(msg.mime || 'image/jpeg')
          if (!base64) {
            src.postMessage({ source: 'vitality-host', type: 'addProgressPhoto:error', id: msg.id, reason: 'no_image' }, '*')
            return
          }
          let url: string | null = null
          const c = supa()
          if (c) {
            try {
              const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0))
              const ext = mime.split('/')[1] || 'jpg'
              const path = userId + '/' + Date.now() + '.' + ext
              const { error: upErr } = await c.storage.from('progress-photos').upload(path, bytes, { contentType: mime })
              if (!upErr) url = c.storage.from('progress-photos').getPublicUrl(path).data?.publicUrl ?? null
            } catch {
              url = null
            }
          }
          const r = await fetch('/api/coach/photo', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ base64, mime, goal: msg.goal }),
          })
          const j = await r.json()
          src.postMessage({ source: 'vitality-host', type: 'addProgressPhoto:result', id: msg.id, url, analysis: typeof j?.analysis === 'string' ? j.analysis : null }, '*')
        } catch {
          src.postMessage({ source: 'vitality-host', type: 'addProgressPhoto:error', id: msg.id, reason: 'fetch_failed' }, '*')
        }
        return
      }

      // WHOOP connect — a sealed tile can't navigate itself (sandbox has no
      // allow-top-navigation), and a popup opened from this async handler
      // would get blocked by most browsers anyway. So the host navigates the
      // WHOLE tab to the OAuth start; WHOOP sends it back to /api/whoop/callback,
      // which redirects to '/' when done.
      if (msg.type === 'connectWhoop') {
        src.postMessage({ source: 'vitality-host', type: 'connectWhoop:result', id: msg.id }, '*')
        window.location.href = '/api/whoop/authorize'
        return
      }

      // WHOOP sync — refreshes the access token if stale and pulls the
      // athlete's real recovery scores into the 'vitals' row. Safe to call on
      // every Vitals mount: if WHOOP was never connected it just reports
      // { connected: false } without touching WHOOP's API at all.
      if (msg.type === 'whoopSync') {
        try {
          const r = await fetch('/api/whoop/sync', { method: 'POST' })
          const j = await r.json()
          src.postMessage({ source: 'vitality-host', type: 'whoopSync:result', id: msg.id, result: j }, '*')
        } catch {
          src.postMessage({ source: 'vitality-host', type: 'whoopSync:result', id: msg.id, result: { connected: false, synced: 0, todayRecovery: null } }, '*')
        }
        return
      }

      // Cross-tile READ — the host hands a tile another slot's saved data so
      // tiles can react to each other client-side (e.g. Peak reshaping from the
      // Vitals recovery) with no /sweep and no connector. Read-only, the user's
      // OWN data, and whitelisted to the data slots (never 'vee' or internals).
      if (msg.type === 'read') {
        const slot = String(msg.slot || '')
        /* `<tile>:metrics` is the disciplined way to read another tile:
           typed daily values with provenance, written by publish(). The
           whole-store reads are the old way in and survive only where a
           consumer already depends on one — see metricsContract. */
        if (!isReadableSlot(slot)) {
          src.postMessage({ source: 'vitality-host', type: 'read:error', id: msg.id, reason: 'slot_not_allowed' }, '*')
          return
        }
        let data = await tileStore.loadData(userId, slot)
        if (syncEnabled()) {
          const remote = await syncLoad(slot)
          if (remote != null) data = remote as typeof data
        }
        src.postMessage({ source: 'vitality-host', type: 'read:result', id: msg.id, data }, '*')
        return
      }

      const tileId = reg.current.get(src)
      if (!tileId) {
        // Sender is not in our registry (a race, or the registry was reset while
        // a tile was open). Still settle any id-bearing request so the tile's
        // `await window.Vitality.save/load(...)` can never hang forever.
        if (msg.id && msg.type === 'save') {
          src.postMessage({ source: 'vitality-host', type: 'save:error', id: msg.id, reason: 'unregistered_sender' }, '*')
        } else if (msg.id && msg.type === 'load') {
          src.postMessage({ source: 'vitality-host', type: 'load:result', id: msg.id, data: [] }, '*')
        }
        return
      }

      if (msg.type === 'save') {
        const ok = await tileStore.saveData(userId, tileId, msg.data)
        if (!ok) {
          // the write was dropped (over the per-tile cap or the storage quota).
          // Tell the tile instead of silently letting it believe it saved.
          src.postMessage({ source: 'vitality-host', type: 'save:error', id: msg.id, reason: 'too_large_or_full' }, '*')
          return
        }
        // ack success so a tile's `await window.Vitality.save(...)` resolves truthfully
        src.postMessage({ source: 'vitality-host', type: 'save:ok', id: msg.id }, '*')
        // then mirror to the owner's Supabase (if configured) so the same data shows
        // up on their other devices. Fire-and-forget — never blocks the tile.
        if (syncEnabled()) void syncSave(tileId, msg.data, new Date().toISOString())
        const count = Array.isArray(msg.data) ? msg.data.length : 0
        activity.current?.({ tileId, type: 'save', count })
        return
      }

      if (msg.type === 'load') {
        // Prefer the cloud copy when sync is on (so a fresh device — the phone —
        // gets the real data); fall back to this browser's local copy otherwise.
        let data = await tileStore.loadData(userId, tileId)
        if (syncEnabled()) {
          const remote = await syncLoad(tileId)
          if (remote != null) data = remote as typeof data
        }
        // reply to the exact sender, never a broadcast. targetOrigin stays '*'
        // because a sealed srcDoc tile has an opaque (null) origin; the sender
        // is already verified via the registered e.source, and the payload is
        // the tile's own data going back to it.
        src.postMessage({ source: 'vitality-host', type: 'load:result', id: msg.id, data }, '*')
        const count = Array.isArray(data) ? data.length : 0
        activity.current?.({ tileId, type: 'load', count })
        return
      }

      if (msg.type === 'publish') {
        /* Typed daily metrics for other tiles, written under the SENDER's
           own `<tileId>:metrics` slot — the id comes from our registry,
           never from the iframe's claim, so a tile can only ever publish
           as itself. Validated here because the payload crossed an
           iframe boundary from a sealed sender. */
        const { metrics, rejected } = validatePublish(msg.metrics)
        if (rejected.length) {
          console.warn(`[tiles] ${tileId} published ${rejected.length} unusable metric(s):`, rejected)
        }
        if (metrics.length) {
          await tileStore.saveData(userId, `${tileId}:metrics`, metrics as never)
          if (syncEnabled()) void syncSave(`${tileId}:metrics`, metrics as never, new Date().toISOString())
        }
        activity.current?.({ tileId, type: 'publish', count: metrics.length })
        return
      }

      if (msg.type === 'report') {
        // One numeric life-stream into Vee. The host only forwards the raw stream
        // plus the SENDER's tileId (from our own registry, never the iframe's
        // claim) so the stream's per-tile identity is trustworthy; the injected
        // handler (the server action) validates it and RLS-writes it under the
        // session user. Fire-and-forget: a tile never blocks on Vee.
        report.current?.(msg.stream, tileId)
        activity.current?.({ tileId, type: 'report', count: 1 })
      }
    }

    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [userId])

  return { register, unregister }
}
