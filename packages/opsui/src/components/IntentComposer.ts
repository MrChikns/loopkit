// IntentComposer — the one conversational command surface ("Intent in").
// A plain progressive-enhancement form: works with zero JS, posts `intent` to the
// app-provided action (the package never knows serving paths — the app passes them).
// Attachments: enctype="multipart/form-data" + file input. Paste/drop/chips are
// layered on by opsui-composer.js (served at /ui/composer.js).

import { esc } from '../render/html.ts';

export interface IntentComposerProps {
  /** Form POST target, provided by the app boundary (e.g. /intent?next=...). */
  action: string;
  /** Placeholder guidance. Default states the contract: anything, plain speech. */
  placeholder?: string;
  /** When the previous submit captured an item, its id — renders a confirmation chip. */
  capturedId?: string;
  /** DOM id prefix for the textarea/label/file-input pair — defaults to 'opsui'. Only
   *  {@link IntentComposerModal} overrides this: the Command page still renders its own inline
   *  composer alongside the new global entry point (WI-262), and duplicate element ids are
   *  invalid HTML. */
  idPrefix?: string;
  /** Registered target display names. When more than one target is registered, a required
   *  `<select name="target">` is rendered so a bare capture names which plane it's for —
   *  mirrors the pre-port console (`loopctl new "<text>" --target <name>`) and the core
   *  captureIntent contract (>1 target with none named throws). With zero or exactly one
   *  target, no selector shows: the server stamps the sole target unchanged. */
  targets?: string[];
  /**
   * The plane's autonomy gate is OFF (`LOOPKIT_AUTONOMY` not 'on' — including unset, which is
   * the fail-safe default). Renders the halted notice directly above the input.
   *
   * This warning lives HERE, at the one door in, rather than on a status page, because halted is
   * exactly the state in which dropping an intent does not do what the operator expects: it is
   * captured and then nothing picks it up. A warning about that belongs where the action is, at
   * the moment of acting. The opposite state is deliberately silent — an armed plane is the
   * normal case and is reported on the ops observability page only (WI-204).
   */
  planeHalted?: boolean;
}

/**
 * The halted notice. It must teach, not alarm: because the gate fails safe, an unset
 * `LOOPKIT_AUTONOMY` means the very first thing a new reader of the public repo sees may be this
 * state. So it states, in the operator's terms and in this order:
 *   1. what happens to what you are about to type (captured, then it waits),
 *   2. that work already running is NOT aborted — the gate is checked once at the top of each
 *      beat and a build runs inside its beat, so halting only stops NEW work being taken on,
 *   3. that the operator is not blocked — attended/CLI work is unaffected,
 *   4. how to change it. Arming is a CLI/config act by design; there is no button here.
 * Nothing here implies the halt expires: it holds until someone changes it (founder decision).
 */
function haltedNotice(): string {
  return (
    `<div class="opsui-composer__halted" role="status">` +
    `<p class="opsui-composer__halted-head">` +
    `<span class="opsui-composer__halted-mark" aria-hidden="true">⏸</span>` +
    `<strong>The plane is halted — nothing will pick this up.</strong></p>` +
    `<p class="opsui-composer__halted-body">` +
    `Your intent is still recorded: it is captured to the ledger and waits in the queue. ` +
    `What is switched off is the autonomy gate, so the background beats take on no new work.` +
    `</p>` +
    `<ul class="opsui-composer__halted-list">` +
    `<li>Work already running <strong>continues</strong> — halting does not abort a beat or a build in flight.</li>` +
    `<li>You are not blocked: attended CLI work still runs normally, and every page stays readable.</li>` +
    `<li>It stays halted until you change it. There is no timer, and nothing re-arms on its own.</li>` +
    `</ul>` +
    `<p class="opsui-composer__halted-fix">` +
    `To arm the plane, set <code>LOOPKIT_AUTONOMY=on</code> in the environment used by the ` +
    `scheduler that launches the beats. For a standalone plane, set <code>LOOPKIT_HOME</code> ` +
    `there too; loopkit reads configuration from <code>$LOOPKIT_HOME/config/loopkit.json</code>. ` +
    `Reload the scheduler so the beats inherit that environment. This is deliberately not a ` +
    `button — arming the plane is an operator environment change.` +
    `</p>` +
    `</div>`
  );
}

export function IntentComposer(props: IntentComposerProps): string {
  const placeholder = props.placeholder
    ?? 'Build request, bug, question, decision, idea — plain speech, any language';
  const idPrefix = props.idPrefix ?? 'opsui';
  const intentId = `${idPrefix}-intent`;
  const attachmentId = `${idPrefix}-attachment`;
  const formId = `${idPrefix}-intent-form`;
  // The <select> is placed AFTER the </form> so it never nests inside a fieldset-free form for
  // free — it re-attaches to the form via the HTML `form=` attribute (same mechanism as the
  // pre-port console). Only shown when the operator actually has a choice to make.
  const targets = props.targets ?? [];
  const targetField = targets.length > 1
    ? `<label class="opsui-composer__target-label">Target` +
      `<select class="opsui-composer__target" name="target" form="${esc(formId)}" required>` +
      `<option value="" disabled selected>choose a target…</option>` +
      targets.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('') +
      `</select></label>`
    : '';
  // WI-178: the captured-as chip resolves into the recent-intents strip below — it links
  // to the item's ledger timeline so a fresh capture is never a dead end (the chip itself
  // is cleared from the URL by composer.js so a refresh doesn't re-show a stale confirm).
  const captured = props.capturedId
    ? `<p class="opsui-composer__captured" role="status">Captured as ` +
      `<a class="opsui-composer__captured-link" href="/timeline?item=${esc(props.capturedId)}">` +
      `<strong>${esc(props.capturedId)}</strong></a> — routing…</p>`
    : '';
  return (
    `<form id="${esc(formId)}" class="opsui-composer" method="post" enctype="multipart/form-data" action="${esc(props.action)}">` +
    `${props.planeHalted ? haltedNotice() : ''}` +
    `<label class="opsui-composer__label" for="${intentId}">Drop intent</label>` +
    `${targetField}` +
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

/** IntentComposer wrapped as a shell-level modal dialog (WI-262) — the global "drop
 *  intent" entry point opened from the TopBar on every /command page, not just Command.
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
