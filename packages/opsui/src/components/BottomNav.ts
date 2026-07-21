// BottomNav — mobile-only bottom navigation for the highest
// mobilePriority destinations; everything the bar can't hold was unreachable on
// mobile (WI-258). A sixth "More" affordance opens a bottom sheet listing every
// overflow destination — palette-only ones AND any prioritised section ranked
// beyond the bar's limit — with the rail's icon + title + purpose row shape, so
// nothing is stranded behind the (desktop-only) command palette as the registry
// grows. Destinations come from the same registry list as the rail — ordered by
// mobilePriority.

import { cx, esc } from '../render/html.ts';
import type { NavDestination } from './types.ts';

export type BottomNavProps = {
  destinations: NavDestination[];
  activeId?: string;
  /** How many destinations to surface in the bar (five most important). */
  limit?: number;
};

function bottomItem(dest: NavDestination, activeId?: string): string {
  const active = dest.id === activeId;
  const className = cx('opsui-bottomnav__item', active && 'opsui-bottomnav__item--active');
  const current = active ? ' aria-current="page"' : '';
  const glyph = dest.icon ?? `<span aria-hidden="true">${esc(dest.title.slice(0, 1))}</span>`;
  return (
    `<a class="${className}" href="${esc(dest.href)}"${current}>` +
    `<span class="opsui-bottomnav__icon">${glyph}</span>` +
    `<span class="opsui-bottomnav__label">${esc(dest.title)}</span></a>`
  );
}

// The "More" trigger: an icon+label affordance matching the bar items, but a
// button (it opens the sheet) with an explicit accessible name and dialog wiring.
function moreButton(): string {
  return (
    `<button type="button" class="opsui-bottomnav__item opsui-bottomnav__more"` +
    ` data-opsui-shell="bottomsheet-open" aria-haspopup="dialog"` +
    ` aria-controls="opsui-bottomsheet" aria-label="More destinations">` +
    `<span class="opsui-bottomnav__icon" aria-hidden="true">⋯</span>` +
    `<span class="opsui-bottomnav__label">More</span></button>`
  );
}

// A sheet row mirrors the expanded rail item (icon + title + one-line purpose) but
// carries its own classes so the rail's compact-collapse rule can't hide its text.
function sheetItem(dest: NavDestination, activeId?: string): string {
  const active = dest.id === activeId;
  const className = cx('opsui-bottomsheet__item', active && 'opsui-bottomsheet__item--active');
  const current = active ? ' aria-current="page"' : '';
  const glyph = dest.icon ?? `<span aria-hidden="true">${esc(dest.title.slice(0, 1))}</span>`;
  return (
    `<a class="${className}" href="${esc(dest.href)}"${current}>` +
    `<span class="opsui-bottomsheet__icon">${glyph}</span>` +
    `<span class="opsui-bottomsheet__text">` +
    `<span class="opsui-bottomsheet__title">${esc(dest.title)}</span>` +
    `<span class="opsui-bottomsheet__purpose">${esc(dest.purpose)}</span>` +
    `</span></a>`
  );
}

// The overflow sheet: a labelled modal dialog, hidden until the client opens it.
// Backdrop click and Esc close it (wired in opsui-shell.js).
function bottomSheet(dests: NavDestination[], activeId?: string): string {
  const rows = dests.map((d) => sheetItem(d, activeId)).join('');
  return (
    `<div class="opsui-bottomsheet" id="opsui-bottomsheet" role="dialog" aria-modal="true"` +
    ` aria-label="More destinations" data-opsui-shell="bottomsheet" hidden>` +
    `<div class="opsui-bottomsheet__backdrop" data-opsui-shell="bottomsheet-close"></div>` +
    `<div class="opsui-bottomsheet__panel">` +
    `<div class="opsui-bottomsheet__grid">${rows}</div>` +
    `</div></div>`
  );
}

export function BottomNav(props: BottomNavProps): string {
  const limit = props.limit ?? 5;
  const chosen = props.destinations
    .filter((d) => d.mobilePriority != null)
    .sort((a, b) => (a.mobilePriority as number) - (b.mobilePriority as number))
    .slice(0, limit);
  const items = chosen.map((d) => bottomItem(d, props.activeId)).join('');

  // Anything the bar can't hold belongs behind "More" — palette-only destinations
  // (no mobilePriority) AND any prioritised destination ranked beyond `limit`. That
  // second class keeps the pattern scaling: a future 6th top-priority section is
  // still reachable on mobile, never stranded (WI-258 — all current+future sections).
  // The small four-item test fixtures (≤5 destinations) keep the original
  // drop-them-entirely behaviour via the length gate below.
  const chosenIds = new Set(chosen.map((d) => d.id));
  const overflow = props.destinations.filter((d) => !chosenIds.has(d.id));
  const showMore = props.destinations.length > 5 && overflow.length > 0;
  const more = showMore ? moreButton() : '';
  const sheet = showMore ? bottomSheet(overflow, props.activeId) : '';

  return `<nav class="opsui-bottomnav" aria-label="Primary (mobile)">${items}${more}</nav>${sheet}`;
}
