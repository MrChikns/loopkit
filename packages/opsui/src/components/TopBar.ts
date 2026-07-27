// TopBar — sticky banner: the breadcrumb/title of the current operating picture,
// optional operational status, drop-intent action, and theme toggle. The command
// palette remains a shell-level future-search surface, but has no TopBar trigger
// until it searches more than the already-visible navigation.

import { esc } from '../render/html.ts';
import { StatusBadge } from './StatusBadge.ts';
import type { StatusBadgeProps } from './StatusBadge.ts';
import type { Breadcrumb } from './types.ts';

export type TopBarProps = {
  title: string;
  /** Optional trail rendered before the title; the last hop is the title itself. */
  breadcrumbs?: Breadcrumb[];
  /** Optional operational status rendered between the page title and global actions. */
  status?: StatusBadgeProps;
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
  // The primary global action: a designed intent pill, not a bare glyph.
  const composerTrigger =
    `<button type="button" class="opsui-topbar__intent" data-opsui-shell="composer-open"` +
    ` aria-haspopup="dialog" aria-keyshortcuts="Control+I Meta+I" aria-label="Drop intent">` +
    `<span class="opsui-topbar__intent-icon" aria-hidden="true">+</span>` +
    `<span class="opsui-topbar__intent-hint">Drop intent</span>` +
    `<kbd class="opsui-topbar__kbd" aria-hidden="true">⌘I</kbd></button>`;
  const themeToggle =
    `<button type="button" class="opsui-topbar__theme" data-opsui-shell="theme-toggle"` +
    ` aria-label="Toggle colour theme"><span aria-hidden="true">◐</span></button>`;
  const status = props.status
    ? `<div class="opsui-topbar__status">${StatusBadge(props.status)}</div>`
    : '';
  return (
    `<header class="opsui-topbar" role="banner">` +
    `<div class="opsui-topbar__lead">${trail}` +
    `<h1 class="opsui-topbar__title">${esc(props.title)}</h1></div>` +
    status +
    `<div class="opsui-topbar__actions">${composerTrigger}${themeToggle}</div>` +
    `</header>`
  );
}
