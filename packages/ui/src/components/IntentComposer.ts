// IntentComposer — the one conversational command surface ("Intent in").
// A plain progressive-enhancement form: works with zero JS, posts `intent` to the
// app-provided action (the package never knows serving paths — the app passes them).
// Attachments: enctype="multipart/form-data" + file input. Paste/drop/chips are
// layered on by the app's composer client script (e.g. the console serves
// /console-composer.js) — the package never hardcodes that path.

import { esc } from '../render/html.ts';

export interface IntentComposerProps {
  /** Form POST target, provided by the app boundary (e.g. /intent?next=...). */
  action: string;
  /** Placeholder guidance. Default states the contract: anything, plain speech. */
  placeholder?: string;
  /** When the previous submit captured an item, its id — renders a confirmation chip. */
  capturedId?: string;
  /** App-resolved link target for the captured-item chip (e.g. the console's `/item/<id>`
   *  route). The package never knows the app's routes, so the boundary passes the full,
   *  already-resolved href. When absent, the chip renders as plain text (never a dead link). */
  capturedHref?: string;
  /** DOM id prefix for the textarea/label/file-input pair — defaults to 'opsui'. Only
   *  {@link IntentComposerModal} overrides this: the Command page still renders its own inline
   *  composer alongside the new global entry point, and duplicate element ids are
   *  invalid HTML. */
  idPrefix?: string;
}

export function IntentComposer(props: IntentComposerProps): string {
  const placeholder = props.placeholder
    ?? 'Build request, bug, question, decision, idea — plain speech, any language';
  const idPrefix = props.idPrefix ?? 'opsui';
  const intentId = `${idPrefix}-intent`;
  const attachmentId = `${idPrefix}-attachment`;
  // The captured-as chip confirms a fresh capture. When the app supplies `capturedHref`
  // (its already-resolved link to the item), the id links there so the confirm is never a
  // dead end; without it the id renders as plain text — never a hardcoded/dead link. (The
  // app's composer client script clears the chip from the URL so a refresh doesn't re-show
  // a stale confirm.)
  const capturedInner = props.capturedId
    ? props.capturedHref
      ? `<a class="opsui-composer__captured-link" href="${esc(props.capturedHref)}">` +
        `<strong>${esc(props.capturedId)}</strong></a>`
      : `<strong>${esc(props.capturedId)}</strong>`
    : '';
  const captured = props.capturedId
    ? `<p class="opsui-composer__captured" role="status">Captured as ${capturedInner} — routing…</p>`
    : '';
  return (
    `<form class="opsui-composer" method="post" enctype="multipart/form-data" action="${esc(props.action)}">` +
    `<label class="opsui-composer__label" for="${intentId}">Drop intent</label>` +
    `<textarea class="opsui-composer__input" id="${intentId}" name="intent" rows="3" required ` +
    `placeholder="${esc(placeholder)}"></textarea>` +
    `<div class="opsui-composer__chips" hidden></div>` +
    `<div class="opsui-composer__attach-row">` +
    `<label class="opsui-composer__file-label" for="${attachmentId}">+ Attach</label>` +
    `<input class="opsui-composer__file-input" type="file" id="${attachmentId}" name="attachment" ` +
    `accept="image/*,.pdf,.txt,.md,.csv" multiple>` +
    `<span class="opsui-composer__count" hidden></span>` +
    `</div>` +
    `<div class="opsui-composer__row">` +
    `<button class="opsui-btn opsui-btn--primary opsui-btn--md" type="submit">Send</button>` +
    `${captured}` +
    `</div>` +
    `</form>`
  );
}

/** IntentComposer wrapped as a shell-level modal dialog — the global "drop
 *  intent" entry point opened from the TopBar on every console page, not just Command.
 *  Ships hidden; opsui-shell.js toggles it on `data-opsui-shell="composer-open"` /
 *  `"composer-close"` (backdrop, Esc, and the explicit close button), mirroring the
 *  CommandPalette and BottomNav "More" sheet dialog pattern. */
export function IntentComposerModal(props: IntentComposerProps): string {
  return (
    `<div class="opsui-composer-modal" role="dialog" aria-modal="true" aria-label="Drop intent"` +
    ` data-opsui-shell="composer" hidden>` +
    `<div class="opsui-composer-modal__backdrop" data-opsui-shell="composer-close"></div>` +
    `<div class="opsui-composer-modal__panel">` +
    `<button type="button" class="opsui-composer-modal__close" data-opsui-shell="composer-close"` +
    ` aria-label="Close drop intent">×</button>` +
    IntentComposer({ ...props, idPrefix: props.idPrefix ?? 'opsui-modal' }) +
    `</div></div>`
  );
}
