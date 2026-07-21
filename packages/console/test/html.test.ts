/**
 * html.test.ts — the `esc` escaping primitive every view routes through, plus the nav
 * overflow split/disclosure helpers behind the rail/bottom-nav "More" affordance.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { esc, page, splitNavForBar, moreDisclosure, NAV_DESTINATIONS } from '../src/html.js';

test('esc: escapes the five HTML-significant characters', () => {
  assert.equal(esc(`<script>alert(1)</script>&"'`), '&lt;script&gt;alert(1)&lt;/script&gt;&amp;&quot;&#39;');
});

test('esc: passes plain text through unchanged', () => {
  assert.equal(esc('add health view'), 'add health view');
});

test('esc: coerces non-string values and treats null/undefined as empty', () => {
  assert.equal(esc(42), '42');
  assert.equal(esc(undefined), '');
  assert.equal(esc(null), '');
});

// ---------------------------------------------------------------------------
// Nav overflow — destinations past the fifth mobilePriority
// ---------------------------------------------------------------------------

const SIX_DESTINATIONS = [
  { id: 'a', title: 'Alpha', purpose: 'A', href: '/a', mobilePriority: 1 },
  { id: 'b', title: 'Bravo', purpose: 'B', href: '/b', mobilePriority: 2 },
  { id: 'c', title: 'Charlie', purpose: 'C', href: '/c', mobilePriority: 3 },
  { id: 'd', title: 'Delta', purpose: 'D', href: '/d', mobilePriority: 4 },
  { id: 'e', title: 'Echo', purpose: 'E', href: '/e', mobilePriority: 5 },
  { id: 'f', title: 'Foxtrot', purpose: 'F', href: '/f', mobilePriority: 6 },
];

test('splitNavForBar: keeps the top five by mobilePriority, overflows the rest', () => {
  const { primary, overflow } = splitNavForBar(SIX_DESTINATIONS);
  assert.deepEqual(primary.map((d) => d.id), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(overflow.map((d) => d.id), ['f']);
});

test('splitNavForBar: the real NAV_DESTINATIONS keep five primary; Knowledge overflows by design', () => {
  const { primary, overflow } = splitNavForBar(NAV_DESTINATIONS);
  assert.equal(primary.length, 5);
  assert.deepEqual(overflow.map((d) => d.id), ['knowledge']);
});

test('moreDisclosure: empty overflow renders nothing', () => {
  assert.equal(moreDisclosure([], 'a', 'opsui-rail__item'), '');
});

test('moreDisclosure: renders a native <details class="opsui-more"> with an item per destination', () => {
  const html = moreDisclosure(SIX_DESTINATIONS.slice(5), 'f', 'opsui-rail__item');
  assert.match(html, /^<details class="opsui-more"><summary class="opsui-more__summary">More<\/summary>/);
  assert.match(html, /<a class="opsui-rail__item opsui-rail__item--active" href="\/f" aria-current="page">Foxtrot<\/a>/);
  assert.match(html, /<\/details>$/);
});

test('moreDisclosure: escapes destination text', () => {
  const html = moreDisclosure(
    [{ id: 'x', title: '<b>X</b>', purpose: 'p', href: '/x?y=1&z=2' }],
    undefined,
    'opsui-rail__item',
  );
  assert.match(html, /href="\/x\?y=1&amp;z=2"/);
  assert.match(html, /&lt;b&gt;X&lt;\/b&gt;/);
});

test('page(): the desktop rail lists Knowledge flat; only the mobile bottom-nav folds it into More', () => {
  const html = page({ title: 'Test', activeNav: 'command' }, '<p>body</p>');
  // The vertical rail renders every destination as a full rail item — no "More" overflow.
  assert.match(html, /class="opsui-rail__item"[^>]*href="\/knowledge"/);
  // The mobile bottom-nav bar still folds the sixth destination into a native <details> More.
  assert.match(html, /opsui-more/);
  assert.match(html, /href="\/knowledge"/);
});
