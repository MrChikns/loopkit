// Progressive-enhancement client module (components render server-side;
// interactivity is layered under public/*.js). Turns a click on any element
// carrying `data-opsui-action="<kind>:<id>"` into one `opsui:action` CustomEvent.
// The console's command dispatcher listens for it; without JS the
// markup is still a valid, labelled button.
(function () {
  'use strict';
  document.addEventListener('click', function (event) {
    var target = event.target;
    var el = target && target.closest ? target.closest('[data-opsui-action]') : null;
    if (!el) return;
    var raw = el.getAttribute('data-opsui-action') || '';
    var sep = raw.indexOf(':');
    var detail =
      sep === -1
        ? { kind: raw, id: '' }
        : { kind: raw.slice(0, sep), id: raw.slice(sep + 1) };
    el.dispatchEvent(
      new CustomEvent('opsui:action', { bubbles: true, detail: detail })
    );
  });
})();
