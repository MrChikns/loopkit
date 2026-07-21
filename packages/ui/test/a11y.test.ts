// Accessibility contract — anti-drift gate. The
// component tests prove appearance/behaviour; this one pins the a11y invariants so
// a future edit cannot quietly drop a role, a landmark label, or — the spec's
// sharpest rule — leave an icon-only control with no accessible name.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BottomNav } from '../src/components/BottomNav.ts';
import { Button } from '../src/components/Button.ts';
import { CommandPalette } from '../src/components/CommandPalette.ts';
import { MetricTile } from '../src/components/MetricTile.ts';
import { NavigationRail } from '../src/components/NavigationRail.ts';
import { StatusBadge } from '../src/components/StatusBadge.ts';
import { TopBar } from '../src/components/TopBar.ts';
import type { NavDestination } from '../src/components/types.ts';

const DESTINATIONS: NavDestination[] = [
  { id: 'command', title: 'Command', purpose: 'The operating picture', href: '/ops', mobilePriority: 1 },
  { id: 'health', title: 'Health', purpose: 'SLOs and the pipeline', href: '/ops/health', mobilePriority: 2 },
];

// "No action identified only by icon without accessible label." A control
// whose only text content is inside an aria-hidden span MUST carry an aria-label.
function hasAccessibleName(controlHtml: string): boolean {
  if (/\baria-label="[^"]+"/.test(controlHtml)) return true;
  // Strip aria-hidden spans, then any remaining tags; visible text = accessible name.
  const withoutHidden = controlHtml.replace(/<span[^>]*aria-hidden="true"[^>]*>.*?<\/span>/g, '');
  const visibleText = withoutHidden.replace(/<[^>]+>/g, '').trim();
  return visibleText.length > 0;
}

test('every rendered button/link exposes an accessible name', () => {
  const surfaces = [
    NavigationRail({ destinations: DESTINATIONS, activeId: 'command' }),
    BottomNav({ destinations: DESTINATIONS, activeId: 'command' }),
    TopBar({ title: 'Command', breadcrumbs: [{ label: 'Ops', href: '/ops' }] }),
    MetricTile({ label: 'Latency', value: '4.2s', footnote: 'p95', state: 'success', open: { kind: 'projection', id: 'health' } }),
    Button({ label: 'Approve' }),
  ].join('');
  for (const m of surfaces.matchAll(/<(button|a)\b[^>]*>.*?<\/\1>/gs)) {
    assert.ok(hasAccessibleName(m[0]), `control lacks an accessible name: ${m[0]}`);
  }
});

test('icon-only shell toggles carry an aria-label, not just a glyph', () => {
  const rail = NavigationRail({ destinations: DESTINATIONS });
  const bar = TopBar({ title: 'Command' });
  // Rail width toggle, theme toggle: glyph-only, so aria-label is mandatory.
  assert.match(rail, /class="opsui-rail__toggle"[^>]*aria-label="[^"]+"/);
  assert.match(bar, /class="opsui-topbar__theme"[^>]*aria-label="[^"]+"/);
  assert.match(bar, /class="opsui-topbar__palette"[^>]*aria-label="[^"]+"/);
});

test('navigation landmarks are labelled and the active item is marked current', () => {
  const rail = NavigationRail({ destinations: DESTINATIONS, activeId: 'command' });
  const bottom = BottomNav({ destinations: DESTINATIONS, activeId: 'command' });
  assert.match(rail, /<nav[^>]*aria-label="Primary"/);
  assert.match(bottom, /<nav[^>]*aria-label="Primary \(mobile\)"/);
  assert.match(rail, /aria-current="page"/);
  assert.match(bottom, /aria-current="page"/);
});

test('TopBar is a banner landmark', () => {
  assert.match(TopBar({ title: 'Command' }), /<header[^>]*role="banner"/);
});

test('CommandPalette is a labelled modal dialog with combobox + listbox semantics', () => {
  const open = CommandPalette({
    open: true,
    groups: [{ heading: 'Projections', items: [{ action: 'projection:health', label: 'Health' }] }],
  });
  assert.match(open, /role="dialog"[^>]*aria-modal="true"/);
  assert.match(open, /aria-label="Command palette"/);
  assert.match(open, /role="combobox"[^>]*aria-expanded/);
  assert.match(open, /role="listbox"[^>]*aria-label="Results"/);
  assert.match(open, /role="option"/);
});

test('decorative glyphs are hidden from assistive tech', () => {
  // The rail/bottom-nav initial-letter glyphs and the topbar kbd hint are decorative.
  assert.match(BottomNav({ destinations: DESTINATIONS }), /<span aria-hidden="true">/);
  assert.match(TopBar({ title: 'Command' }), /<kbd[^>]*aria-hidden="true"/);
});

test('StatusBadge state meaning is available as text, not colour alone', () => {
  const html = StatusBadge({ state: 'critical', label: 'Blocking' });
  assert.match(html, />Blocking</, 'label text present alongside the colour class');
});
