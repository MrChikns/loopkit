// Shared widget disclosure behavior.
// Every .opsui-card with a direct header and body becomes a persisted disclosure:
// first visit = expanded, later visits restore the per-page state. A single control
// at the top of the workspace expands or collapses every widget on that page.
(function () {
  'use strict';

  var STORAGE_PREFIX = 'opsui.widgets.v1:';
  var READY = 'data-opsui-widget-ready';
  var workspace = document.querySelector('.opsui-shell__workspace');
  if (!workspace) return;

  var widgets = [];
  var controls;
  var toggleAll;

  function directChild(card, className) {
    for (var i = 0; i < card.children.length; i++) {
      var child = card.children[i];
      if (child.classList && child.classList.contains(className)) return child;
    }
    return null;
  }

  function storageKey() {
    return STORAGE_PREFIX + window.location.pathname;
  }

  function readState() {
    try {
      var parsed = JSON.parse(window.localStorage.getItem(storageKey()) || '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      return {};
    }
  }

  function writeState(state) {
    try {
      window.localStorage.setItem(storageKey(), JSON.stringify(state));
    } catch (error) {
      // Disabled/private storage: disclosure still works for the current page lifetime.
    }
  }

  function nearestRegionId(card) {
    var current = card.parentElement;
    while (current && current !== workspace) {
      if (current.id) return current.id;
      current = current.parentElement;
    }
    return '';
  }

  function keyBase(card, header) {
    if (card.id) return 'id:' + card.id;
    var regionId = nearestRegionId(card);
    if (regionId) return 'region:' + regionId;
    var title = header.querySelector('.opsui-card__title');
    var label = title ? title.textContent.trim().toLowerCase().replace(/\s+/g, '-') : '';
    return label ? 'title:' + label : 'widget';
  }

  function isExpanded(widget) {
    return widget.card.getAttribute('data-opsui-widget-state') !== 'collapsed';
  }

  function updateToggleAllLabel() {
    if (!toggleAll) return;
    var allCollapsed = widgets.length > 0 && widgets.every(function (widget) {
      return !isExpanded(widget);
    });
    toggleAll.textContent = allCollapsed ? 'Expand all' : 'Collapse all';
    toggleAll.setAttribute('aria-label', allCollapsed ? 'Expand all widgets' : 'Collapse all widgets');
  }

  function save(widget, expanded) {
    var state = readState();
    state[widget.key] = expanded;
    writeState(state);
  }

  function setExpanded(widget, expanded, persist) {
    widget.card.setAttribute('data-opsui-widget-state', expanded ? 'expanded' : 'collapsed');
    widget.header.setAttribute('aria-expanded', String(expanded));
    if (widget.nativeDetails) {
      widget.card.open = expanded;
    } else if (expanded) {
      widget.body.removeAttribute('hidden');
    } else {
      widget.body.setAttribute('hidden', '');
    }
    if (persist) save(widget, expanded);
    updateToggleAllLabel();
  }

  function interactiveTarget(target, header) {
    if (!target || target === header || !target.closest) return false;
    var interactive = target.closest('a, button, input, select, textarea, summary, [role="button"]');
    return Boolean(interactive && interactive !== header);
  }

  function ensureControls() {
    if (controls) return;
    controls = document.createElement('div');
    controls.className = 'opsui-widget-controls';
    controls.setAttribute('data-opsui-widget-controls', '');
    toggleAll = document.createElement('button');
    toggleAll.type = 'button';
    toggleAll.className = 'opsui-widget-controls__button';
    toggleAll.addEventListener('click', function () {
      var shouldExpand = widgets.length > 0 && widgets.every(function (widget) {
        return !isExpanded(widget);
      });
      widgets.forEach(function (widget) {
        setExpanded(widget, shouldExpand, true);
      });
    });
    controls.appendChild(toggleAll);
    workspace.insertBefore(controls, workspace.firstChild);
  }

  function enhanceAll() {
    var state = readState();
    var seen = {};
    var cards = Array.prototype.slice.call(workspace.querySelectorAll('.opsui-card'));
    widgets = [];

    cards.forEach(function (card, index) {
      var header = directChild(card, 'opsui-card__header');
      var body = directChild(card, 'opsui-card__body');
      if (!header || !body) return;

      var base = keyBase(card, header);
      seen[base] = (seen[base] || 0) + 1;
      var key = base + ':' + seen[base];
      var nativeDetails = card.tagName === 'DETAILS' && header.tagName === 'SUMMARY';
      var widget = { card: card, header: header, body: body, key: key, nativeDetails: nativeDetails };
      widgets.push(widget);

      if (!body.id) body.id = 'opsui-widget-body-' + index;
      header.setAttribute('aria-controls', body.id);

      if (!card.hasAttribute(READY)) {
        card.setAttribute(READY, '');
        header.setAttribute('data-opsui-widget-toggle', '');
        if (nativeDetails) {
          card.addEventListener('toggle', function () {
            var expanded = Boolean(card.open);
            card.setAttribute('data-opsui-widget-state', expanded ? 'expanded' : 'collapsed');
            header.setAttribute('aria-expanded', String(expanded));
            save(widget, expanded);
            updateToggleAllLabel();
          });
        } else {
          header.setAttribute('role', 'button');
          header.setAttribute('tabindex', '0');
          header.addEventListener('click', function (event) {
            if (interactiveTarget(event.target, header)) return;
            setExpanded(widget, !isExpanded(widget), true);
          });
          header.addEventListener('keydown', function (event) {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            setExpanded(widget, !isExpanded(widget), true);
          });
        }
      }

      setExpanded(widget, Object.prototype.hasOwnProperty.call(state, key) ? state[key] !== false : true, false);
    });

    if (widgets.length > 0) ensureControls();
    if (controls) controls.hidden = widgets.length === 0;
    updateToggleAllLabel();
  }

  enhanceAll();

  // Live projection swaps can replace a card without navigating. Enhance the replacement
  // and restore the same stable key instead of leaving it outside the disclosure system.
  var observer = new MutationObserver(function (records) {
    var needsRefresh = records.some(function (record) {
      return Array.prototype.some.call(record.addedNodes, function (node) {
        return node.nodeType === 1 && (
          node.classList.contains('opsui-card') ||
          node.querySelector('.opsui-card')
        );
      });
    });
    if (needsRefresh) enhanceAll();
  });
  observer.observe(workspace, { childList: true, subtree: true });
})();
