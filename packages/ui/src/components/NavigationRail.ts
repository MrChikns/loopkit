// NavigationRail — two widths only (compact icons / expanded icon +
// title + one-line purpose). Destinations come from the projection registry;
// the rail never defines its own. Active item uses the inset accent
// edge; the toggle persists via the client module (Cmd/Ctrl+B).

import { cx, esc } from '../render/html.ts';
import type { NavDestination } from './types.ts';

export type NavigationRailProps = {
  destinations: NavDestination[];
  /** Id of the current destination — gets `aria-current` and the accent edge. */
  activeId?: string;
  /** Initial width. The client toggle flips this and persists the choice. */
  expanded?: boolean;
};

// Icon slot: the destination's inline SVG when present, else an initial glyph.
// Never the sole label — the title always accompanies it for a11y.
function icon(dest: NavDestination): string {
  const inner = dest.icon ?? `<span aria-hidden="true">${esc(dest.title.slice(0, 1))}</span>`;
  return `<span class="opsui-rail__icon">${inner}</span>`;
}

function railItem(dest: NavDestination, activeId?: string): string {
  const active = dest.id === activeId;
  const className = cx('opsui-rail__item', active && 'opsui-rail__item--active');
  const current = active ? ' aria-current="page"' : '';
  return (
    `<a class="${className}" href="${esc(dest.href)}"${current} title="${esc(dest.title)}">` +
    `${icon(dest)}` +
    `<span class="opsui-rail__text">` +
    `<span class="opsui-rail__title">${esc(dest.title)}</span>` +
    `<span class="opsui-rail__purpose">${esc(dest.purpose)}</span>` +
    `</span></a>`
  );
}

export function NavigationRail(props: NavigationRailProps): string {
  const expanded = props.expanded ?? true;
  const className = cx('opsui-rail', expanded ? 'opsui-rail--expanded' : 'opsui-rail--compact');
  const toggle =
    `<button type="button" class="opsui-rail__toggle" data-opsui-shell="rail-toggle"` +
    ` aria-expanded="${expanded}" aria-keyshortcuts="Control+B Meta+B" aria-label="Toggle navigation width">` +
    `<span aria-hidden="true">⇔</span></button>`;
  const items = props.destinations.map((d) => railItem(d, props.activeId)).join('');
  return (
    `<nav class="${className}" aria-label="Primary">${toggle}` +
    `<div class="opsui-rail__items">${items}</div></nav>`
  );
}
