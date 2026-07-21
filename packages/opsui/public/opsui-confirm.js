// Progressive-enhancement client module (components render server-side;
// interactivity is layered under public/*.js) for run-controls hard-stop.
// Any <form> carrying
// `data-opsui-confirm="<message>"` is gated behind window.confirm() on submit —
// without JS the form still posts directly (no confirm gate), so the action
// never silently breaks; the gate is a UX safeguard, not the sole authorization
// boundary (the server-side verb is the real guard).
(function () {
  'use strict';
  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!form || !form.hasAttribute || !form.hasAttribute('data-opsui-confirm')) return;
    var message = form.getAttribute('data-opsui-confirm') || 'Are you sure?';
    if (!window.confirm(message)) {
      event.preventDefault();
    }
  });
})();
