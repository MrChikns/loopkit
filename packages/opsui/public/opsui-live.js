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
// (`.opsui-pipelineflow` present), it opens the server's board-level push (`/command/live`) and
// patches the Pipeline flow card's numbers and the Glance card's health badge label in place as
// `event: pipeline` frames arrive — so the card updates without a reload. That stream stays open
// for the session (the server caps it and the client reconnects automatically); only the numbers
// patch, never the lane event lists underneath. (The former "Ops health & pipeline" stage-count
// strip and its `.opsui-pipeline__stage` patch targets are gone — that card was deleted; the
// server route may still send a `stages` payload key, which the client now simply ignores.)
//
// A third, independent enhancement: the Glance card's window picker (24h/7d/30d) is a plain
// `?window=` link (zero-JS baseline — see WindowPicker.ts). With JS, a click on one of those
// links is intercepted, the target URL is fetched, and only the Glance card's markup
// (`#opsui-glance-card`, a stable additive hook — see Card.ts / command-projection.ts) is
// swapped in place — no full navigation, no reload, no scroll-position loss. The URL is
// updated via history.pushState so the window choice stays bookmarkable and back/forward
// still works. Any failure (fetch error, non-200, missing card in the response) falls back to
// a normal `location.href` navigation — the enhancement must never leave the picker inert.
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
    if (!document.querySelector('.opsui-pipelineflow')) return; // not the board page

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

      // The former stage-count strip (`.opsui-pipeline__stage`) is deleted along with the "Ops
      // health & pipeline" card — the server route may still send `payload.stages`, harmless and
      // intentionally ignored here (no patch target exists for it anymore).

      if (payload && payload.flow) {
        for (var key in payload.flow) {
          if (!Object.prototype.hasOwnProperty.call(payload.flow, key)) continue;
          patchText('[data-opsui-live-flow="' + key + '"]', payload.flow[key]);
        }
      }

      if (payload && payload.health && payload.health.headline) {
        // The health badge renders via Card's own `headerAside` slot on the Glance card
        // (moved there when the "Ops health & pipeline" strip card was deleted) — scoped to
        // `#opsui-glance-card` (that card's stable id, also the in-place window-swap hook) so
        // this never risks matching a header badge on any other card. No wrapper element is
        // introduced: the badge is Card's normal aside markup, rendered ahead of the
        // WindowPicker within the same aside.
        var healthEl = document.querySelector('#opsui-glance-card .opsui-card__aside .opsui-status .opsui-status__label');
        if (healthEl) healthEl.textContent = String(payload.health.headline);
      }
    });

    // Transient errors are exactly what EventSource auto-reconnect is for — only stop once
    // the browser itself has given up (readyState CLOSED), same discipline as the item tail.
    source.addEventListener('error', function () {
      if (source.readyState === EventSource.CLOSED) done();
    });
  }

  // Glance window picker: in-place swap on click, progressive enhancement over the
  // zero-JS `?window=` links. Scoped to `#opsui-glance-card` only — the WindowPicker
  // component is reused on other pages (e.g. analytics' self-heal window), and those must
  // keep navigating normally; this handler never touches them.
  function startGlanceWindowSwap() {
    if (typeof window.fetch === 'undefined') return; // no fetch → links stay plain navigation

    var card = document.getElementById('opsui-glance-card');
    if (!card) return; // not the Command board, or the hook isn't present

    function activePicker() {
      return document.getElementById('opsui-glance-card');
    }

    function swapFromHtml(html, url) {
      var parser = new DOMParser();
      var doc;
      try {
        doc = parser.parseFromString(html, 'text/html');
      } catch (e) {
        return false;
      }
      var freshCard = doc.getElementById('opsui-glance-card');
      var current = activePicker();
      if (!freshCard || !current) return false;
      current.replaceWith(freshCard);
      return true;
    }

    function navigateFallback(url) {
      window.location.href = url;
    }

    function onWindowLinkClick(event) {
      var link = event.target && event.target.closest ? event.target.closest('a') : null;
      if (!link) return;
      var container = activePicker();
      if (!container || !container.contains(link)) return; // click outside this card's picker
      if (!link.classList || !link.classList.contains('opsui-window__btn')) return;

      // Respect modified clicks (new tab / new window / etc) — let the browser handle those.
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey ||
          event.shiftKey || event.altKey) {
        return;
      }

      var href = link.getAttribute('href');
      if (!href) return;
      var url = new URL(href, window.location.href);
      if (url.origin !== window.location.origin) return; // same-origin only

      event.preventDefault();

      fetch(url.href, { credentials: 'same-origin' })
        .then(function (res) {
          if (!res.ok) throw new Error('bad status ' + res.status);
          return res.text();
        })
        .then(function (html) {
          var ok = swapFromHtml(html, url.href);
          if (!ok) {
            navigateFallback(url.href);
            return;
          }
          try {
            window.history.pushState({ opsuiGlanceWindow: true }, '', url.href);
          } catch (e) {
            /* pushState failure is non-fatal — the swap already happened */
          }
        })
        .catch(function () {
          navigateFallback(url.href); // any failure degrades to a normal navigation
        });
    }

    document.addEventListener('click', onWindowLinkClick);

    // Back/forward after an in-place swap: re-fetch and re-swap so the card matches the URL.
    // Non-Glance popstate navigations (any other history entry) are ignored — the browser's
    // own default handling already applies to those since we never called pushState for them.
    window.addEventListener('popstate', function (event) {
      if (!event.state || !event.state.opsuiGlanceWindow) return;
      fetch(window.location.href, { credentials: 'same-origin' })
        .then(function (res) {
          if (!res.ok) throw new Error('bad status ' + res.status);
          return res.text();
        })
        .then(function (html) {
          swapFromHtml(html, window.location.href);
        })
        .catch(function () {
          window.location.reload(); // fall back to a real reload rather than a stale card
        });
    });
  }

  function start() {
    startCapturedBannerLive();
    startBoardLive();
    startGlanceWindowSwap();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
