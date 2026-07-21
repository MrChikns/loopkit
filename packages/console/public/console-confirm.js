// Progressive-enhancement client module: any <form> carrying `data-opsui-confirm="<message>"`
// is gated behind window.confirm() on submit. Without JS the form still posts directly (no
// confirm gate) — the gate is a UX safeguard, not the sole authorization boundary (the
// server-side verb is the real guard).
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
