// IntentComposer client behaviour: Enter-to-send, paste-to-attach, drag-drop,
// preview chips with ×-remove. Progressive enhancement — zero-JS path is a plain
// multipart submit via the `<label for="opsui-attachment">+ Attach</label>`.
// Scoped to `form.opsui-composer` only; never conflicts with ops-intent.js.
(function () {
  'use strict';

  // Enter-to-send: Shift+Enter inserts a newline; plain Enter submits.
  document.addEventListener('keydown', function (event) {
    var t = event.target;
    if (!t || t.tagName !== 'TEXTAREA' || t.name !== 'intent') return;
    if (!t.closest || !t.closest('form.opsui-composer')) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (t.form) t.form.requestSubmit();
    }
  });

  // Build a FileList by merging two FileList-alikes via DataTransfer.
  function mergeFiles(existing, incoming) {
    var dt = new DataTransfer();
    var i;
    for (i = 0; i < existing.length; i++) dt.items.add(existing[i]);
    for (i = 0; i < incoming.length; i++) dt.items.add(incoming[i]);
    return dt.files;
  }

  function syncAttach(form) {
    var input = form.querySelector('input[type="file"][name="attachment"]');
    var countEl = form.querySelector('.opsui-composer__count');
    var chipsEl = form.querySelector('.opsui-composer__chips');
    if (!input || !countEl || !chipsEl) return;
    var n = input.files.length;
    countEl.hidden = n === 0;
    countEl.textContent = n === 1 ? '1 file attached' : n + ' files attached';
    chipsEl.hidden = n === 0;
    // Rebuild chips — close over the input reference, not file objects, so
    // the remove handler always sees the live FileList at click time.
    chipsEl.innerHTML = '';
    for (var i = 0; i < n; i++) {
      (function (idx) {
        var chip = document.createElement('span');
        chip.className = 'opsui-composer__chip';
        var nameNode = document.createTextNode(input.files[idx].name);
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'opsui-composer__chip-remove';
        btn.setAttribute('aria-label', 'Remove ' + input.files[idx].name);
        btn.textContent = '×'; // ×
        btn.addEventListener('click', function () {
          var dt = new DataTransfer();
          for (var k = 0; k < input.files.length; k++) {
            if (k !== idx) dt.items.add(input.files[k]);
          }
          input.files = dt.files;
          syncAttach(form);
        });
        chip.appendChild(nameNode);
        chip.appendChild(btn);
        chipsEl.appendChild(chip);
      })(i);
    }
  }

  // Paste: grab any image items from the clipboard and move them onto the file input.
  function pasteIntoForm(event, form) {
    var input = form.querySelector('input[type="file"][name="attachment"]');
    if (!input) return;
    var items = (event.clipboardData && event.clipboardData.items) || [];
    var pasted = [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind !== 'file') continue;
      var file = items[i].getAsFile();
      if (!file || file.type.indexOf('image/') !== 0) continue;
      var ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
      pasted.push(new File([file], 'pasted-' + Date.now() + '-' + (i + 1) + '.' + ext, { type: file.type }));
    }
    if (!pasted.length) return;
    event.preventDefault();
    input.files = mergeFiles(input.files, pasted);
    syncAttach(form);
  }

  // Drop: accept any files dropped onto the form (images and other allowed types).
  function dropIntoForm(event, form) {
    var input = form.querySelector('input[type="file"][name="attachment"]');
    if (!input) return;
    var dt = event.dataTransfer;
    if (!dt || !dt.files || !dt.files.length) return;
    event.preventDefault();
    input.files = mergeFiles(input.files, dt.files);
    form.classList.remove('opsui-composer--drag-over');
    syncAttach(form);
  }

  // Delegation — survives DOM patches (SSE-driven chat panel updates).
  document.addEventListener('paste', function (event) {
    var t = event.target;
    var form = t && t.closest && t.closest('form.opsui-composer');
    if (!form) return;
    pasteIntoForm(event, form);
  });

  document.addEventListener('change', function (event) {
    var t = event.target;
    if (!t || t.tagName !== 'INPUT' || t.type !== 'file' || t.name !== 'attachment') return;
    var form = t.closest && t.closest('form.opsui-composer');
    if (!form) return;
    syncAttach(form);
  });

  document.addEventListener('dragover', function (event) {
    var t = event.target;
    var form = t && t.closest && t.closest('form.opsui-composer');
    if (!form) return;
    event.preventDefault();
    form.classList.add('opsui-composer--drag-over');
  });

  document.addEventListener('dragleave', function (event) {
    var t = event.target;
    var form = t && t.closest && t.closest('form.opsui-composer');
    if (!form) return;
    if (!form.contains(event.relatedTarget)) form.classList.remove('opsui-composer--drag-over');
  });

  document.addEventListener('drop', function (event) {
    var t = event.target;
    var form = t && t.closest && t.closest('form.opsui-composer');
    if (!form) return;
    dropIntoForm(event, form);
  });

  // Sync any form that is already in the DOM when the script loads.
  var forms = document.querySelectorAll('form.opsui-composer');
  for (var i = 0; i < forms.length; i++) syncAttach(forms[i]);

  // WI-178: after a capture round-trip the server redirects to ?captured=<id> so the
  // confirmation chip renders once. The captured item now also lives in the recent-intents
  // strip below the composer (durable), so we strip ?captured from the URL — a refresh or
  // bookmark then shows the live picture, never a stale "routing…" confirm for an old id.
  try {
    if (window.history && window.history.replaceState && window.location.search.indexOf('captured=') !== -1) {
      var params = new URLSearchParams(window.location.search);
      params.delete('captured');
      var qs = params.toString();
      var clean = window.location.pathname + (qs ? '?' + qs : '') + window.location.hash;
      window.history.replaceState(window.history.state, '', clean);
    }
  } catch (e) {
    /* history API unavailable — the chip simply persists until the next navigation */
  }
})();
