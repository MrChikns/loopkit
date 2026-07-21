import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AppShell } from '../src/components/AppShell.ts';
import { BottomNav } from '../src/components/BottomNav.ts';
import { CommandPalette } from '../src/components/CommandPalette.ts';
import { ContextBar } from '../src/components/ContextBar.ts';
import { NavigationRail } from '../src/components/NavigationRail.ts';
import { TopBar } from '../src/components/TopBar.ts';
import type { NavDestination } from '../src/components/types.ts';

const DESTS: NavDestination[] = [
  { id: 'command', title: 'Command', purpose: 'Glance and act', href: '/ops', mobilePriority: 1 },
  { id: 'health', title: 'Health', purpose: 'SLOs and pipeline', href: '/ops/health', mobilePriority: 3 },
  { id: 'acceptance', title: 'Accept', purpose: 'Test what shipped', href: '/ops/accept', mobilePriority: 2 },
  { id: 'company', title: 'Knowledge', purpose: 'The knowledge stream', href: '/ops/company', mobilePriority: null },
];

test('NavigationRail marks the active item and shows purpose, not just title', () => {
  const html = NavigationRail({ destinations: DESTS, activeId: 'health', expanded: true });
  assert.match(html, /opsui-rail--expanded/);
  assert.match(html, /opsui-rail__item--active[^>]*href="\/ops\/health"|href="\/ops\/health"[^>]*aria-current="page"/);
  assert.match(html, /aria-current="page"/);
  assert.match(html, /opsui-rail__purpose">SLOs and pipeline</);
});

test('NavigationRail toggle advertises the Cmd/Ctrl+B shortcut and reflects width', () => {
  const compact = NavigationRail({ destinations: DESTS, expanded: false });
  assert.match(compact, /opsui-rail--compact/);
  assert.match(compact, /data-opsui-shell="rail-toggle"/);
  assert.match(compact, /aria-keyshortcuts="Control\+B Meta\+B"/);
  assert.match(compact, /aria-expanded="false"/);
});

test('NavigationRail falls back to an initial glyph when a destination has no icon', () => {
  const html = NavigationRail({ destinations: DESTS });
  assert.match(html, /opsui-rail__icon"><span aria-hidden="true">C<\/span>/);
});

test('NavigationRail escapes destination text', () => {
  const html = NavigationRail({
    destinations: [{ id: 'x', title: '<b>x</b>', purpose: '"quote"', href: '/a"b' }],
  });
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>x<\/b>/);
  assert.match(html, /href="\/a&quot;b"/);
});

test('TopBar renders the palette trigger, theme toggle, breadcrumb and title', () => {
  const html = TopBar({ title: 'Command', breadcrumbs: [{ label: 'Ops', href: '/ops' }] });
  assert.match(html, /role="banner"/);
  assert.match(html, /data-opsui-shell="palette-open"/);
  assert.match(html, /aria-keyshortcuts="Control\+K Meta\+K"/);
  assert.match(html, /data-opsui-shell="theme-toggle"/);
  assert.match(html, /opsui-topbar__crumb" href="\/ops">Ops</);
  assert.match(html, /opsui-topbar__title">Command</);
});

test('TopBar renders the drop-intent trigger as a Search-peer pill between Search and the theme toggle', () => {
  const html = TopBar({ title: 'Command' });
  // A designed pill (icon + hint + ⌘I), the write peer of Search — not a bare glyph.
  assert.match(html, /class="opsui-topbar__intent" data-opsui-shell="composer-open"/);
  assert.match(html, /class="opsui-topbar__intent"[^>]*aria-label="Drop intent"/);
  assert.match(html, /aria-keyshortcuts="Control\+I Meta\+I"/);
  assert.match(html, /opsui-topbar__intent-hint">Drop intent</);
  assert.match(html, /opsui-topbar__kbd" aria-hidden="true">⌘I</);
  const paletteIdx = html.indexOf('data-opsui-shell="palette-open"');
  const composerIdx = html.indexOf('data-opsui-shell="composer-open"');
  const themeIdx = html.indexOf('data-opsui-shell="theme-toggle"');
  assert.ok(paletteIdx < composerIdx && composerIdx < themeIdx, 'intent trigger sits between Search and theme toggle');
});

test('ContextBar reuses StatusBadge and announces politely', () => {
  const html = ContextBar({
    state: 'warning',
    stateLabel: '1 blocked',
    freshness: 'Updated 9s ago',
    meta: ['2 workers'],
  });
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /opsui-status--warning/);
  assert.match(html, /opsui-contextbar__freshness">Updated 9s ago</);
  assert.match(html, /opsui-contextbar__metaitem">2 workers</);
});

test('BottomNav surfaces prioritised destinations in order and drops palette-only ones', () => {
  const html = BottomNav({ destinations: DESTS, activeId: 'command' });
  // command(1) then accept(2) then health(3); company(null) excluded.
  const order = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['/ops', '/ops/accept', '/ops/health']);
  assert.doesNotMatch(html, /\/ops\/company/);
  assert.match(html, /opsui-bottomnav__item--active[^>]*href="\/ops"|href="\/ops"[^>]*aria-current/);
});

test('BottomNav respects the limit', () => {
  const html = BottomNav({ destinations: DESTS, limit: 2 });
  const order = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['/ops', '/ops/accept']);
});

// Registry with more destinations than the bar holds (5 prioritised + 2 palette-only):
// the "More" affordance surfaces the palette-only overflow that was stranded on mobile.
const OVERFLOW: NavDestination[] = [
  { id: 'command', title: 'Command', purpose: 'Glance and act', href: '/ops', mobilePriority: 1 },
  { id: 'accept', title: 'Accept', purpose: 'Test what shipped', href: '/ops/accept', mobilePriority: 2 },
  { id: 'decisions', title: 'Decisions', purpose: 'Answer blockers', href: '/ops/decisions', mobilePriority: 3 },
  { id: 'health', title: 'Health', purpose: 'SLOs and pipeline', href: '/ops/health', mobilePriority: 4 },
  { id: 'workforce', title: 'Workforce', purpose: 'Workers and sessions', href: '/ops/workforce', mobilePriority: 5 },
  { id: 'company', title: 'Knowledge', purpose: 'The knowledge stream', href: '/ops/company', mobilePriority: null },
  { id: 'threads', title: 'Threads', purpose: 'Conversation history', href: '/ops/threads', mobilePriority: null },
];

test('BottomNav adds a "More" button when the registry exceeds the bar (destinations > 5)', () => {
  const many = BottomNav({ destinations: OVERFLOW, activeId: 'command' });
  assert.match(many, /opsui-bottomnav__more[^>]*data-opsui-shell="bottomsheet-open"/);
  assert.match(many, /aria-label="More destinations"/);
  // Small fixtures (≤5) keep the original behaviour: no "More", palette-only dropped.
  assert.doesNotMatch(BottomNav({ destinations: DESTS }), /opsui-bottomnav__more/);
});

test('BottomNav More sheet is a hidden dialog listing each palette-only destination', () => {
  const html = BottomNav({ destinations: OVERFLOW, activeId: 'command' });
  assert.match(html, /class="opsui-bottomsheet"[^>]*role="dialog"[^>]*aria-modal="true"/);
  assert.match(html, /data-opsui-shell="bottomsheet"[^>]*hidden/);
  assert.match(html, /data-opsui-shell="bottomsheet-close"/);
  // Every palette-only destination appears with icon slot + title + one-line purpose…
  assert.match(html, /opsui-bottomsheet__title">Knowledge<[\s\S]*opsui-bottomsheet__purpose">The knowledge stream</);
  assert.match(html, /opsui-bottomsheet__title">Threads<[\s\S]*opsui-bottomsheet__purpose">Conversation history</);
  assert.match(html, /opsui-bottomsheet__item"[^>]*href="\/ops\/company"/);
  // …and prioritised (bar) destinations are NOT duplicated into the sheet.
  assert.doesNotMatch(html, /opsui-bottomsheet__item[^>]*href="\/ops"/);
});

// A registry that grows past the bar with MORE prioritised sections than fit (6
// prioritised, limit 5): the 6th must not vanish — it belongs in the "More" sheet.
const OVERFLOW_PRIORITISED: NavDestination[] = [
  { id: 'command', title: 'Command', purpose: 'Glance and act', href: '/ops', mobilePriority: 1 },
  { id: 'accept', title: 'Accept', purpose: 'Test what shipped', href: '/ops/accept', mobilePriority: 2 },
  { id: 'decisions', title: 'Decisions', purpose: 'Answer blockers', href: '/ops/decisions', mobilePriority: 3 },
  { id: 'health', title: 'Health', purpose: 'SLOs and pipeline', href: '/ops/health', mobilePriority: 4 },
  { id: 'workforce', title: 'Workforce', purpose: 'Workers and sessions', href: '/ops/workforce', mobilePriority: 5 },
  { id: 'reports', title: 'Reports', purpose: 'Extra reports', href: '/ops/reports', mobilePriority: 6 },
];

test('BottomNav sheet carries prioritised sections ranked beyond the bar limit (future-proof)', () => {
  const html = BottomNav({ destinations: OVERFLOW_PRIORITISED, activeId: 'reports' });
  // The bar shows only the first five; the 6th-priority "Reports" is not in the bar…
  const nav = html.slice(html.indexOf('<nav'), html.indexOf('</nav>'));
  assert.doesNotMatch(nav, /\/ops\/reports/);
  // …but a "More" affordance exists and the sheet surfaces Reports with its purpose, so
  // it is reachable rather than stranded, and marked active.
  assert.match(html, /opsui-bottomnav__more/);
  assert.match(html, /opsui-bottomsheet__title">Reports<[\s\S]*opsui-bottomsheet__purpose">Extra reports</);
  assert.match(html, /opsui-bottomsheet__item--active[^>]*href="\/ops\/reports"/);
});

test('CommandPalette ships hidden and opens with grouped, actionable results', () => {
  const hidden = CommandPalette({});
  assert.match(hidden, /data-opsui-shell="palette"/);
  assert.match(hidden, / hidden>/);
  assert.match(hidden, /role="dialog"/);
  assert.match(hidden, /aria-modal="true"/);

  const open = CommandPalette({
    open: true,
    groups: [{ heading: 'Decisions', items: [{ label: 'D-1', action: 'answer:D-1', meta: 'blocking' }] }],
  });
  assert.doesNotMatch(open, / hidden>/);
  assert.match(open, /role="listbox"/);
  assert.match(open, /opsui-palette__heading">Decisions</);
  assert.match(open, /data-opsui-action="answer:D-1"/);
  assert.match(open, /opsui-palette__meta">blocking</);
});

test('AppShell lays out the landmark regions and reflects the initial rail width', () => {
  const html = AppShell({
    rail: '<nav>RAIL</nav>',
    topBar: '<header>TOP</header>',
    contextBar: '<div>CTX</div>',
    workspace: '<p>WORK</p>',
    bottomNav: '<nav>BOTTOM</nav>',
    palette: '<div>PAL</div>',
    railExpanded: false,
  });
  assert.match(html, /data-opsui-shell="root"/);
  assert.match(html, /data-rail="compact"/);
  assert.match(html, /role="main"/);
  // Regions appear in layout order: rail, top, context, workspace, bottom, palette.
  assert.match(html, /RAIL[\s\S]*TOP[\s\S]*CTX[\s\S]*WORK[\s\S]*BOTTOM[\s\S]*PAL/);
});

test('AppShell defaults to an expanded rail and omits absent slots', () => {
  const html = AppShell({ rail: 'R', topBar: 'T', workspace: 'W' });
  assert.match(html, /data-rail="expanded"/);
  assert.doesNotMatch(html, /opsui-shell__workspace"[^>]*>W<\/main>.*<nav/);
  assert.doesNotMatch(html, /PAL|COMPOSER/);
});

test('AppShell slots the composerModal after the palette', () => {
  const html = AppShell({
    rail: 'R', topBar: 'T', workspace: 'W',
    palette: '<div>PAL</div>',
    composerModal: '<div>COMPOSER</div>',
  });
  assert.match(html, /PAL[\s\S]*COMPOSER/);
});
