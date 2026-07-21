// Live-tail client module — progressive enhancement only, activates solely when the URL
// carries `?captured=<id>` (the confirmation-chip query param every capture/reply redirect
// already sets). Without JS, or on any page without that param, this module does nothing: the
// page is already fully functional and an operator sees the reply on their next manual refresh.
// With JS, it opens an EventSource against the read-only tail route (server.ts's
// `/item/<id>/live`) and reloads the page the moment the plane's first reply lands, so the
// thread region shows up-to-date content without the operator polling by hand. The connection is
// itself server-bounded (closes after one reply or ~2min) — this module just lets it expire.
(function () {
  'use strict';
  if (!window.EventSource) return;

  var params = new URLSearchParams(window.location.search);
  var capturedId = params.get('captured');
  if (!capturedId) return;

  var source = new EventSource('/item/' + encodeURIComponent(capturedId) + '/live');
  source.addEventListener('reply', function () {
    source.close();
    window.location.reload();
  });
  // A tail that errors out (server closed it, network hiccup) is not retried — the page still
  // works with a manual refresh, and EventSource's own auto-retry would otherwise reopen a tail
  // past the point the operator cares about it.
  source.addEventListener('error', function () {
    source.close();
  });
})();
