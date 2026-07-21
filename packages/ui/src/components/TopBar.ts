// TopBar — sticky banner: the breadcrumb/title of the current
// operating picture, the command-palette trigger (Cmd/Ctrl+K), and the theme
// toggle. Palette open and theme persistence are handled by the client module.

import { esc } from '../render/html.ts';
import type { Breadcrumb } from './types.ts';

export type TopBarProps = {
  title: string;
  /** Optional trail rendered before the title; the last hop is the title itself. */
  breadcrumbs?: Breadcrumb[];
};

function crumb(item: Breadcrumb): string {
  const label = esc(item.label);
  return item.href
    ? `<a class="opsui-topbar__crumb" href="${esc(item.href)}">${label}</a>`
    : `<span class="opsui-topbar__crumb">${label}</span>`;
}

export function TopBar(props: TopBarProps): string {
  const trail = (props.breadcrumbs ?? [])
    .map((c) => crumb(c) + '<span class="opsui-topbar__sep" aria-hidden="true">/</span>')
    .join('');
  const paletteTrigger =
    `<button type="button" class="opsui-topbar__palette" data-opsui-shell="palette-open"` +
    ` aria-keyshortcuts="Control+K Meta+K" aria-label="Open command palette">` +
    `<span class="opsui-topbar__palette-hint">Search</span>` +
    `<kbd class="opsui-topbar__kbd" aria-hidden="true">⌘K</kbd></button>`;
  // Peer of the Search pill: an intent affordance, not a bare glyph. Same pill
  // chrome (icon + hint + ⌘-shortcut), opens the shell-level composer dialog the
  // same way Search opens the palette.
  const composerTrigger =
    `<button type="button" class="opsui-topbar__intent" data-opsui-shell="composer-open"` +
    ` aria-haspopup="dialog" aria-keyshortcuts="Control+I Meta+I" aria-label="Drop intent">` +
    `<span class="opsui-topbar__intent-icon" aria-hidden="true">+</span>` +
    `<span class="opsui-topbar__intent-hint">Drop intent</span>` +
    `<kbd class="opsui-topbar__kbd" aria-hidden="true">⌘I</kbd></button>`;
  const themeToggle =
    `<button type="button" class="opsui-topbar__theme" data-opsui-shell="theme-toggle"` +
    ` aria-label="Toggle colour theme"><span aria-hidden="true">◐</span></button>`;
  return (
    `<header class="opsui-topbar" role="banner">` +
    `<div class="opsui-topbar__lead">${trail}` +
    `<h1 class="opsui-topbar__title">${esc(props.title)}</h1></div>` +
    `<div class="opsui-topbar__actions">${paletteTrigger}${composerTrigger}${themeToggle}</div>` +
    `</header>`
  );
}
