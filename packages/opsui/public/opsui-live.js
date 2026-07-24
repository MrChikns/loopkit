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
//
// A second, independent enhancement lives in this same file: on the Command board page
// (`.opsui-pipeline` present), it opens the server's board-level push (`/command/live`) and
// patches the Pipeline card's numbers in place as `event: pipeline` frames arrive — the stage
// counts, the three flow-stage counts, and the health badge label — so the card updates
// without a reload. That stream stays open for the session (the server caps it and the client
// reconnects automatically); only the numbers patch, never the lane event lists underneath.
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

  function startCapturedBannerLive() {
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

  // Board-level live push: patches the Pipeline card's numbers (stage counts, the three
  // flow-stage counts, and the health badge label) as the server pushes `event: pipeline`
  // frames. Only runs on the Command board page (`.opsui-pipeline` present) and is fully
  // independent of the captured-banner tail above — either can run, both can run, neither
  // depends on the other's state.
  function startBoardLive() {
    if (typeof EventSource === 'undefined') return; // no SSE support → page stays refresh-only
    if (!document.querySelector('.opsui-pipeline')) return; // not the board page

    var source;
    try {
      source = new EventSource('/command/live');
    } catch (e) {
      return;
    }

    function done() {
      try { source.close(); } catch (e) { /* already closed */ }
    }

    function patchText(selector, text) {
      var el = document.querySelector(selector);
      if (!el) return; // defensive: missing node just means no patch, never an error
      el.textContent = String(text);
    }

    source.addEventListener('pipeline', function (event) {
      var payload;
      try {
        payload = JSON.parse(event.data);
      } catch (e) {
        return; // malformed frame — skip, the next tick tries again
      }

      if (payload && payload.stages) {
        for (var state in payload.stages) {
          if (!Object.prototype.hasOwnProperty.call(payload.stages, state)) continue;
          patchText(
            '.opsui-pipeline__stage[data-opsui-live-stage="' + state + '"] .opsui-pipeline__count',
            payload.stages[state],
          );
        }
      }

      if (payload && payload.flow) {
        for (var key in payload.flow) {
          if (!Object.prototype.hasOwnProperty.call(payload.flow, key)) continue;
          patchText('[data-opsui-live-flow="' + key + '"]', payload.flow[key]);
        }
      }

      if (payload && payload.health && payload.health.headline) {
        var healthEl = document.querySelector('[data-opsui-live="pipeline-health"] .opsui-status__label');
        if (healthEl) healthEl.textContent = String(payload.health.headline);
      }
    });

    // Transient errors are exactly what EventSource auto-reconnect is for — only stop once
    // the browser itself has given up (readyState CLOSED), same discipline as the item tail.
    source.addEventListener('error', function () {
      if (source.readyState === EventSource.CLOSED) done();
    });
  }

  function start() {
    startCapturedBannerLive();
    startBoardLive();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
