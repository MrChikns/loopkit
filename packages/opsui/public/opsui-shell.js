// Shell client module (components render server-side,
// interactivity layers on top). Wires the three shell affordances entirely from
// declarative `data-opsui-shell` hooks — nothing here knows a projection:
//   • rail width toggle    (button + Cmd/Ctrl+B), persisted in localStorage
//   • colour theme toggle  (button), persisted + applied to <html data-theme>
//   • command palette       (button + Cmd/Ctrl+K, Esc to close, backdrop click)
// Without JS the rail renders at its server width, the theme is whatever <html>
// declares, and the palette stays hidden — every underlying link still works.
(function () {
  'use strict';
  var RAIL_KEY = 'opsui.rail';
  var THEME_KEY = 'opsui.theme';
  var SHEET_KEY = 'opsui.bottomsheet';

  function root() {
    return document.querySelector('[data-opsui-shell="root"]');
  }
  function palette() {
    return document.querySelector('[data-opsui-shell="palette"]');
  }
  function sheet() {
    return document.querySelector('[data-opsui-shell="bottomsheet"]');
  }
  function composer() {
    return document.querySelector('[data-opsui-shell="composer"]');
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

  // ---- rail ---------------------------------------------------------------
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

  // ---- theme --------------------------------------------------------------
  function setTheme(name) {
    document.documentElement.setAttribute('data-theme', name);
    writePref(THEME_KEY, name);
  }
  function toggleTheme() {
    var current = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    setTheme(current === 'light' ? 'dark' : 'light');
  }

  // ---- palette ------------------------------------------------------------
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

  // ---- intent composer (global "drop intent" entry point, WI-262) ---------
  var composerFocus = null;
  // `prefill` (optional) seeds the textarea — e.g. the acceptance desk's "Found a problem"
  // opens the composer with "Problem with WI-NNN (…): " so the founder finishes the sentence.
  function openComposer(prefill) {
    var el = composer();
    if (!el || !el.hasAttribute('hidden')) return;
    composerFocus = document.activeElement;
    el.removeAttribute('hidden');
    // The panel is `position: fixed` (anchored to the viewport, spec-correct on its own), but
    // without also locking the page underneath, scrolling the background while the dialog is
    // open reads as the dialog itself drifting — WebKit repaints fixed elements at scroll-end,
    // so the panel visibly jumps mid-gesture (WI-073). Locking body scroll for the dialog's
    // lifetime removes the gesture that triggers it.
    document.body.style.overflow = 'hidden';
    var input = el.querySelector('.opsui-composer__input');
    if (input) {
      if (typeof prefill === 'string' && prefill) {
        input.value = prefill;
        // Cursor at the end so typing continues the seeded sentence; notify listeners
        // (composer.js chip/count enhancement) that the value changed programmatically.
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

  // ---- bottom sheet (mobile "More" overflow, WI-258) ----------------------
  var sheetFocus = null;
  function openSheet() {
    var el = sheet();
    if (!el || !el.hasAttribute('hidden')) return;
    sheetFocus = document.activeElement;
    el.removeAttribute('hidden');
    var first = el.querySelector('.opsui-bottomsheet__item');
    if (first && first.focus) first.focus();
    writePref(SHEET_KEY, 'open');
  }
  function closeSheet() {
    var el = sheet();
    if (!el || el.hasAttribute('hidden')) return;
    el.setAttribute('hidden', '');
    if (sheetFocus && sheetFocus.focus) sheetFocus.focus();
    sheetFocus = null;
    writePref(SHEET_KEY, 'closed');
  }
  function toggleSheet() {
    var el = sheet();
    if (!el) return;
    if (el.hasAttribute('hidden')) openSheet();
    else closeSheet();
  }

  // ---- wiring -------------------------------------------------------------
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
      case 'composer-close':
        closeComposer();
        break;
      case 'bottomsheet-open':
        toggleSheet();
        break;
      case 'bottomsheet-close':
        closeSheet();
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

  // ---- restore persisted preferences on load ------------------------------
  var savedTheme = readPref(THEME_KEY);
  if (savedTheme === 'light' || savedTheme === 'dark') {
    document.documentElement.setAttribute('data-theme', savedTheme);
  }
  var savedRail = readPref(RAIL_KEY);
  if (savedRail === 'compact' || savedRail === 'expanded') setRail(savedRail);

  // Restore the sheet's last state (like the rail). Reveal without stealing focus
  // on load; the default is closed, so only an explicit 'open' reopens it.
  if (readPref(SHEET_KEY) === 'open') {
    var savedSheet = sheet();
    if (savedSheet) savedSheet.removeAttribute('hidden');
  }

  // Live-reply: ops-chat.js fires this when the conductor replies to the captured item (WI-171).
  // Reuses the existing /command/chat/stream SSE endpoint — no new endpoint built.
  window.addEventListener('opsui:live-reply', function () {
    var el = document.querySelector('.opsui-composer__captured');
    if (!el) return;
    var strong = el.querySelector('strong');
    el.textContent = '';
    el.appendChild(document.createTextNode('Captured as '));
    if (strong) el.appendChild(strong);
    el.appendChild(document.createTextNode(' — reply received'));
  });
})();
