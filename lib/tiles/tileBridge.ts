/**
 * tileBridge injects the Vitality bridge into every sealed tile at mount.
 *
 * A tile is a sandboxed srcDoc iframe: opaque origin, no network, and no
 * localStorage (it throws). The ONLY way a tile persists is by calling
 * window.Vitality.save/load, which this shim defines by postMessaging the host
 * (useTileHost) and matching each reply by id. Tiles stay pure feature code;
 * the bridge lives and upgrades here in one place.
 */

const SHIM = `<script>
(function () {
  var pending = {}, seq = 0;
  window.addEventListener('message', function (e) {
    var m = e.data;
    if (!m || m.source !== 'vitality-host') return;
    var p = pending[m.id];
    if (!p) return;
    delete pending[m.id];
    if (m.type === 'load:result') p.resolve(m.data);
    else if (m.type === 'save:ok') p.resolve(true);
    else if (m.type === 'save:error') p.reject(new Error(m.reason || 'save_failed'));
    else if (m.type === 'tiktok:result') p.resolve(m.count);
    else if (m.type === 'tiktok:error') p.reject(new Error(m.reason || 'tiktok_failed'));
    else if (m.type === 'read:result') p.resolve(m.data);
    else if (m.type === 'read:error') p.reject(new Error(m.reason || 'read_failed'));
    else if (m.type === 'youtube:result') p.resolve(m.count);
    else if (m.type === 'youtube:error') p.reject(new Error(m.reason || 'youtube_failed'));
    else if (m.type === 'stock:result') p.resolve(m.price);
    else if (m.type === 'stock:error') p.reject(new Error(m.reason || 'stock_failed'));
    else if (m.type === 'classify:result') p.resolve(m.exercise);
    else if (m.type === 'classify:error') p.reject(new Error(m.reason || 'classify_failed'));
    else if (m.type === 'generateWorkout:result') p.resolve(m.result);
    else if (m.type === 'generateWorkout:error') p.reject(new Error(m.reason || 'generate_failed'));
    else if (m.type === 'getInsight:result') p.resolve(m.note);
    else if (m.type === 'getInsight:error') p.reject(new Error(m.reason || 'insight_failed'));
    else if (m.type === 'addProgressPhoto:result') p.resolve({ url: m.url, analysis: m.analysis });
    else if (m.type === 'addProgressPhoto:error') p.reject(new Error(m.reason || 'photo_failed'));
    else if (m.type === 'connectWhoop:result') p.resolve(true);
    else if (m.type === 'whoopSync:result') p.resolve(m.result);
  });
  function call(type, extra) {
    return new Promise(function (resolve, reject) {
      var id = 'v' + (++seq);
      pending[id] = { resolve: resolve, reject: reject };
      var msg = { source: 'vitality-tile', type: type, id: id };
      if (extra) for (var k in extra) msg[k] = extra[k];
      parent.postMessage(msg, '*');
      // backstop: never let a tile hang if a reply is somehow lost.
      setTimeout(function () {
        if (!pending[id]) return;
        delete pending[id];
        if (type === 'load') resolve([]);
        else if (type === 'read') resolve(null);
        else reject(new Error('vitality_timeout'));
      }, 8000);
    });
  }
  window.Vitality = {
    save: function (data) { return call('save', { data: data }); },
    load: function () { return call('load', {}); },
    tiktok: function (handle) { return call('tiktok', { handle: handle }); },
    youtube: function (handle) { return call('youtube', { handle: handle }); },
    stock: function (symbol) { return call('stock', { symbol: symbol }); },
    classify: function (name) { return call('classify', { name: name }); },
    generateWorkout: function (opts) { return call('generateWorkout', opts || {}); },
    getInsight: function (opts) { return call('getInsight', opts || {}); },
    addProgressPhoto: function (opts) { return call('addProgressPhoto', opts || {}); },
    connectWhoop: function () { return call('connectWhoop', {}); },
    whoopSync: function () { return call('whoopSync', {}); },
    read: function (slot) { return call('read', { slot: slot }); },
    report: function (stream) {
      parent.postMessage({ source: 'vitality-tile', type: 'report', stream: stream }, '*');
    },
    // Typed daily metrics for OTHER TILES to read, distinct from report()
    // which feeds one numeric life-stream into Vee. Fire-and-forget: a
    // tile never blocks on publishing, and a dropped payload costs the
    // next write, not the session.
    publish: function (metrics) {
      parent.postMessage({ source: 'vitality-tile', type: 'publish', metrics: metrics }, '*');
    }
  };
})();
</script>`

/** Prepend the bridge shim so window.Vitality exists inside the sealed tile. */
export function withBridge(html: string): string {
  if (html.includes('<head>')) return html.replace('<head>', '<head>' + SHIM)
  if (html.includes('<body>')) return html.replace('<body>', '<body>' + SHIM)
  return SHIM + html
}
