// CommandPalette — the Cmd/Ctrl+K surface that searches projections,
// work items, decisions, threads, SLOs, workers, evidence receipts, and commands.
// This renders the shell + a data-driven result list; the console supplies the
// (permission- and context-aware) groups and wires live search. It ships hidden
// and is opened by the client module — a progressive enhancement, not required
// for the underlying links to work.

import { esc } from '../render/html.ts';
import type { PaletteGroup } from './types.ts';

export type CommandPaletteProps = {
  /** Result groups; permission/context filtering happens before render. */
  groups?: PaletteGroup[];
  placeholder?: string;
  /** Rendered open (for stories / SSR). Default hidden — the client toggles it. */
  open?: boolean;
};

function resultItem(action: string, label: string, meta?: string): string {
  const metaHtml = meta ? `<span class="opsui-palette__meta">${esc(meta)}</span>` : '';
  return (
    `<li class="opsui-palette__option" role="option">` +
    `<button type="button" class="opsui-palette__optionbtn" data-opsui-action="${esc(action)}">` +
    `<span class="opsui-palette__label">${esc(label)}</span>${metaHtml}</button></li>`
  );
}

function group(g: PaletteGroup): string {
  const items = g.items.map((i) => resultItem(i.action, i.label, i.meta)).join('');
  return (
    `<li class="opsui-palette__group" role="presentation">` +
    `<p class="opsui-palette__heading">${esc(g.heading)}</p>` +
    `<ul class="opsui-palette__options" role="group" aria-label="${esc(g.heading)}">${items}</ul></li>`
  );
}

export function CommandPalette(props: CommandPaletteProps): string {
  const groups = props.groups ?? [];
  const hidden = props.open ? '' : ' hidden';
  const body = groups.length
    ? `<ul class="opsui-palette__results" role="listbox" aria-label="Results">` +
      groups.map(group).join('') +
      `</ul>`
    : `<p class="opsui-palette__empty">Type to search projections, work items, decisions, threads, SLOs, workers, receipts and commands.</p>`;
  return (
    `<div class="opsui-palette" role="dialog" aria-modal="true" aria-label="Command palette"` +
    ` data-opsui-shell="palette"${hidden}>` +
    `<div class="opsui-palette__backdrop" data-opsui-shell="palette-close"></div>` +
    `<div class="opsui-palette__panel">` +
    `<input type="search" class="opsui-palette__input" role="combobox" aria-expanded="true"` +
    ` aria-controls="opsui-palette-results" autocomplete="off"` +
    ` placeholder="${esc(props.placeholder ?? 'Search everything…')}" />` +
    `<div id="opsui-palette-results" class="opsui-palette__scroll">${body}</div>` +
    `</div></div>`
  );
}
