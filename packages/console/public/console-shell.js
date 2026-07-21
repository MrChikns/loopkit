// Shell client module — progressive enhancement for the TopBar's Search / Drop-intent /
// theme-toggle affordances plus the navigation rail's collapse toggle. The server always
// renders a working no-JS twin (a real <a>/<form>) immediately after each `data-opsui-shell`
// TopBar button (see console.css: the buttons render `display: none` until this module marks
// the document ready). Without JS every twin still works and the rail stays at its server
// (expanded) width; with JS, this module reveals the real buttons, hides the twins, and wires:
//   • command palette   (button + Cmd/Ctrl+K, Esc to close, backdrop click)
//   • drop-intent modal (button + Cmd/Ctrl+I, Esc to close, backdrop click)
//   • theme toggle       (button — submits the adjacent no-JS <form method="post"
//                          action="/theme"> so the cookie stays the single source of truth;
//                          flips <html data-theme> immediately for snappy feedback)
//   • rail collapse       (button + Cmd/Ctrl+B — purely a client-side visual state with no
//                          server counterpart, persisted to localStorage like the original)
(function () {
  'use strict';
  var RAIL_KEY = 'opsui.rail';

  function root() {
    return document.querySelector('[data-opsui-shell="root"]');
  }
  function palette() {
    return document.querySelector('[data-opsui-shell="palette"]');
  }
  function composer() {
    return document.querySelector('[data-opsui-shell="composer"]');
  }
  function sheet() {
    return document.querySelector('[data-opsui-shell="bottomsheet"]');
  }

  function readPref(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }
  function writePref(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (e) {
      /* private mode / disabled storage — degrade to session-only */
    }
  }

  // ---- rail ---------------------------------------------------------------------------------
  function setRail(state) {
    var el = root();
    if (!el) return;
    el.setAttribute('data-rail', state);
    var toggle = el.querySelector('[data-opsui-shell="rail-toggle"]');
    if (toggle) toggle.setAttribute('aria-expanded', String(state === 'expanded'));
    writePref(RAIL_KEY, state);
  }
  function toggleRail() {
    var el = root();
    if (!el) return;
    setRail(el.getAttribute('data-rail') === 'expanded' ? 'compact' : 'expanded');
  }

  // ---- theme ----------------------------------------------------------------------------
  // The cookie set by POST /theme is the single source of truth (server-rendered
  // <html data-theme>) — this module does not keep a parallel localStorage copy of it.
  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }
  function toggleTheme() {
    var next = currentTheme() === 'light' ? 'dark' : 'light';
    // Instant feedback — the POST below will confirm it server-side and persist the cookie.
    document.documentElement.setAttribute('data-theme', next);
    var themeForm = document.querySelector('.opsui-topbar__theme-form');
    if (themeForm) {
      var themeInput = themeForm.querySelector('input[name="theme"]');
      if (themeInput) themeInput.value = next;
      if (themeForm.requestSubmit) themeForm.requestSubmit();
      else themeForm.submit();
    }
  }

  // ---- palette ----------------------------------------------------------------------------
  var lastFocus = null;
  function openPalette() {
    var el = palette();
    if (!el || !el.hasAttribute('hidden')) return;
    lastFocus = document.activeElement;
    el.removeAttribute('hidden');
    var input = el.querySelector('.opsui-palette__input');
    if (input) input.focus();
  }
  function closePalette() {
    var el = palette();
    if (!el || el.hasAttribute('hidden')) return;
    el.setAttribute('hidden', '');
    if (lastFocus && lastFocus.focus) lastFocus.focus();
    lastFocus = null;
  }

  // ---- intent composer (the global "drop intent" modal) ----------------------------------
  var composerFocus = null;
  function openComposer(prefill) {
    var el = composer();
    if (!el || !el.hasAttribute('hidden')) return;
    composerFocus = document.activeElement;
    el.removeAttribute('hidden');
    // The panel is `position: fixed` (anchored to the viewport on its own), but without also
    // locking the page underneath, scrolling the background while the dialog is open reads as
    // the dialog itself drifting — WebKit repaints fixed elements at scroll-end, so the panel
    // visibly jumps mid-gesture (WI-073). Locking body scroll for the dialog's lifetime removes
    // the gesture that triggers it.
    document.body.style.overflow = 'hidden';
    var input = el.querySelector('.opsui-composer__input');
    if (input) {
      if (typeof prefill === 'string' && prefill) {
        input.value = prefill;
        var end = input.value.length;
        try { input.setSelectionRange(end, end); } catch (e) { /* unsupported — ignore */ }
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      input.focus();
    }
  }
  function closeComposer() {
    var el = composer();
    if (!el || el.hasAttribute('hidden')) return;
    el.setAttribute('hidden', '');
    document.body.style.overflow = '';
    if (composerFocus && composerFocus.focus) composerFocus.focus();
    composerFocus = null;
  }

  // ---- wiring -------------------------------------------------------------------------------
  // ---- bottom sheet (mobile "More" overflow) ------------------------------
  var sheetFocus = null;
  function openSheet() {
    var el = sheet();
    if (!el || !el.hasAttribute('hidden')) return;
    sheetFocus = document.activeElement;
    el.removeAttribute('hidden');
    var first = el.querySelector('.opsui-bottomsheet__item');
    if (first && first.focus) first.focus();
  }
  function closeSheet() {
    var el = sheet();
    if (!el || el.hasAttribute('hidden')) return;
    el.setAttribute('hidden', '');
    if (sheetFocus && sheetFocus.focus) sheetFocus.focus();
    sheetFocus = null;
  }
  function toggleSheet() {
    var el = sheet();
    if (!el) return;
    if (el.hasAttribute('hidden')) openSheet();
    else closeSheet();
  }

  document.addEventListener('click', function (event) {
    var t = event.target;
    var el = t && t.closest ? t.closest('[data-opsui-shell]') : null;
    if (!el) return;
    switch (el.getAttribute('data-opsui-shell')) {
      case 'rail-toggle':
        toggleRail();
        break;
      case 'theme-toggle':
        toggleTheme();
        break;
      case 'palette-open':
        openPalette();
        break;
      case 'palette-close':
        closePalette();
        break;
      case 'composer-open':
        openComposer(el.getAttribute('data-opsui-prefill') || undefined);
        break;
      case 'bottomsheet-open':
        event.preventDefault();
        toggleSheet();
        break;
      case 'bottomsheet-close':
        event.preventDefault();
        closeSheet();
        break;
      case 'composer-close':
        closeComposer();
        break;
    }
  });

  document.addEventListener('keydown', function (event) {
    var mod = event.metaKey || event.ctrlKey;
    var key = (event.key || '').toLowerCase();
    if (mod && key === 'k') {
      event.preventDefault();
      openPalette();
    } else if (mod && key === 'i') {
      event.preventDefault();
      openComposer();
    } else if (mod && key === 'b') {
      event.preventDefault();
      toggleRail();
    } else if (key === 'escape') {
      closePalette();
      closeComposer();
      closeSheet();
    }
  });

  // ---- restore the persisted rail state on load ------------------------------------------
  var savedRail = readPref(RAIL_KEY);
  if (savedRail === 'compact' || savedRail === 'expanded') setRail(savedRail);

  // ---- reveal the JS-driven buttons, hide the no-JS twins --------------------------------
  // Runs once the module has loaded and finished wiring, matching the console.css contract:
  // buttons render `display: none` by default; this class flips them on and hides the twins.
  document.documentElement.classList.add('opsui-js-ready');
})();
