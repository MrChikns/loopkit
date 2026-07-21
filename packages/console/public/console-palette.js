// Command-palette client module. console-shell.js already opens/closes the palette
// (Cmd/Ctrl+K, the TopBar Search button, Esc, backdrop). This layers the SEARCH on top:
//   • fuzzy subsequence filter as you type, over the server-rendered option list
//   • keyboard nav (↑/↓ to move, Enter to activate, Home/End)
//   • navigate-on-activate for `navigate:<href>` actions
// Everything degrades: with JS off the palette stays hidden and every rail/nav link still
// works; with the palette open but JS-search failing, the full option list is still shown.
// Pure client-side filter over the already-rendered options — no fetch, no server endpoint.
(function () {
  'use strict';

  function palette() {
    return document.querySelector('[data-opsui-shell="palette"]');
  }
  function input(root) {
    return root.querySelector('.opsui-palette__input');
  }
  function options(root) {
    return Array.prototype.slice.call(root.querySelectorAll('.opsui-palette__option'));
  }

  // Fuzzy subsequence match: every char of the query appears in order in the text.
  function fuzzy(text, query) {
    if (!query) return true;
    var t = text.toLowerCase();
    var q = query.toLowerCase();
    var ti = 0;
    for (var qi = 0; qi < q.length; qi++) {
      var c = q.charAt(qi);
      if (c === ' ') continue;
      ti = t.indexOf(c, ti);
      if (ti === -1) return false;
      ti++;
    }
    return true;
  }

  function optionText(opt) {
    var label = opt.querySelector('.opsui-palette__label');
    var meta = opt.querySelector('.opsui-palette__meta');
    return (label ? label.textContent : '') + ' ' + (meta ? meta.textContent : '');
  }

  // Track the active (keyboard-highlighted) option among the currently-visible ones.
  var activeIndex = -1;

  function visibleOptions(root) {
    return options(root).filter(function (o) { return !o.hidden; });
  }

  function setActive(root, idx) {
    var vis = visibleOptions(root);
    vis.forEach(function (o) {
      o.classList.remove('opsui-palette__option--active');
      var btn = o.querySelector('.opsui-palette__optionbtn');
      if (btn) btn.removeAttribute('aria-selected');
    });
    if (idx < 0 || idx >= vis.length) { activeIndex = -1; return; }
    activeIndex = idx;
    var el = vis[idx];
    el.classList.add('opsui-palette__option--active');
    var b = el.querySelector('.opsui-palette__optionbtn');
    if (b) {
      b.setAttribute('aria-selected', 'true');
      if (b.scrollIntoView) b.scrollIntoView({ block: 'nearest' });
    }
  }

  function applyFilter(root) {
    var q = input(root) ? input(root).value : '';
    options(root).forEach(function (o) {
      o.hidden = !fuzzy(optionText(o), q);
    });
    // Reset the highlight to the first match on every keystroke.
    setActive(root, visibleOptions(root).length ? 0 : -1);
    // Hide a group heading whose options are all filtered out.
    Array.prototype.slice.call(root.querySelectorAll('.opsui-palette__group')).forEach(function (g) {
      var any = Array.prototype.slice.call(g.querySelectorAll('.opsui-palette__option'))
        .some(function (o) { return !o.hidden; });
      g.hidden = !any;
    });
  }

  // Activate a `navigate:<href>` action → go there. Other actions bubble as a custom event
  // so a future dispatcher can handle them; for now navigation is the only wired verb.
  function activate(btn) {
    if (!btn) return;
    var action = btn.getAttribute('data-opsui-action') || '';
    if (action.indexOf('navigate:') === 0) {
      window.location.href = action.slice('navigate:'.length);
      return;
    }
    window.dispatchEvent(new CustomEvent('opsui:palette-action', { detail: { action: action } }));
  }

  // Reset filter + highlight whenever the palette is opened (console-shell.js removes [hidden]).
  function onOpen(root) {
    if (input(root)) input(root).value = '';
    applyFilter(root);
  }

  // Watch for console-shell.js toggling the [hidden] attribute so we can reset on open.
  var root = palette();
  if (root && window.MutationObserver) {
    new MutationObserver(function () {
      if (!root.hasAttribute('hidden')) onOpen(root);
    }).observe(root, { attributes: true, attributeFilter: ['hidden'] });
  }

  document.addEventListener('input', function (event) {
    var root = palette();
    if (!root || root.hasAttribute('hidden')) return;
    if (event.target && event.target.classList && event.target.classList.contains('opsui-palette__input')) {
      applyFilter(root);
    }
  });

  document.addEventListener('keydown', function (event) {
    var root = palette();
    if (!root || root.hasAttribute('hidden')) return;
    var vis = visibleOptions(root);
    var key = event.key;
    if (key === 'ArrowDown') {
      event.preventDefault();
      setActive(root, vis.length ? (activeIndex + 1) % vis.length : -1);
    } else if (key === 'ArrowUp') {
      event.preventDefault();
      setActive(root, vis.length ? (activeIndex - 1 + vis.length) % vis.length : -1);
    } else if (key === 'Home') {
      event.preventDefault();
      setActive(root, vis.length ? 0 : -1);
    } else if (key === 'End') {
      event.preventDefault();
      setActive(root, vis.length ? vis.length - 1 : -1);
    } else if (key === 'Enter') {
      if (activeIndex >= 0 && activeIndex < vis.length) {
        event.preventDefault();
        activate(vis[activeIndex].querySelector('.opsui-palette__optionbtn'));
      }
    }
    // Esc is handled by console-shell.js (closePalette).
  });

  // Click / tap on an option button navigates too.
  document.addEventListener('click', function (event) {
    var t = event.target;
    var btn = t && t.closest ? t.closest('.opsui-palette__optionbtn') : null;
    if (!btn) return;
    var root = palette();
    if (!root || root.hasAttribute('hidden')) return;
    event.preventDefault();
    activate(btn);
  });
})();
