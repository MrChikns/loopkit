// Live-reply client (WI-053): after a capture round-trip the page renders a captured
// confirmation banner (`.opsui-composer__captured`, the item id linked as
// `/timeline?item=<id>`). This opens the server's read-only SSE tail
// (`/item/<id>/live`) and, on the first reply, hands off to the existing
// `opsui:live-reply` handler in opsui-shell.js (which re-labels the banner to
// "reply received"). Progressive enhancement: with no JS the banner still links to
// the item's timeline — this only upgrades a stale confirmation to a live one.
//
// Bounded to match the server: the source closes itself after the first reply and at
// the server's own ~2min cap; this closes its side on the first reply too so a
// forgotten tab never holds the stream open. No framework, no inline script (CSP:
// external file served at /ui/live.js + allowlist only).
(function () {
  'use strict';

  function capturedBanner() {
    return document.querySelector('.opsui-composer__captured');
  }

  // The captured item id lives in the banner's link href (`/timeline?item=<id>`) —
  // the same marker the server-rendered confirmation emits after `?captured=<id>`.
  function capturedItemId() {
    var el = capturedBanner();
    if (!el) return null;
    var link = el.querySelector('a[href*="item="]');
    if (!link) return null;
    var href = link.getAttribute('href') || '';
    var m = /[?&]item=([^&]+)/.exec(href);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function start() {
    if (typeof EventSource === 'undefined') return; // no SSE support → banner stays static
    var id = capturedItemId();
    if (!id) return; // no fresh capture on this page

    var source;
    try {
      source = new EventSource('/item/' + encodeURIComponent(id) + '/live');
    } catch (e) {
      return;
    }

    function done() {
      try { source.close(); } catch (e) { /* already closed */ }
    }

    // The server tails msg.out as a named `reply` event ({id, ts, text}). The shell's
    // `opsui:live-reply` handler reads no detail (it just re-labels the banner), but we
    // forward the parsed payload anyway for any future listener. Dispatched on `window`
    // to match where opsui-shell.js registers the listener.
    source.addEventListener('reply', function (event) {
      var detail = {};
      try { detail = JSON.parse(event.data); } catch (e) { /* keep empty detail */ }
      window.dispatchEvent(new CustomEvent('opsui:live-reply', { detail: detail }));
      done(); // one reply is enough — the server closes its side too
    });

    // On any hard error (the server's 2-min cap closes the stream) just stop: the
    // banner keeps its server-rendered "routing…" text, which is honest.
    source.addEventListener('error', function () {
      if (source.readyState === EventSource.CLOSED) done();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
