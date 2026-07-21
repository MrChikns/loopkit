/**
 * html-footer.test.ts — the shared provenance footer: every page ends with the ledger-trace
 * statement; views that pass fold metadata get event counts, generated-at, and per-pane CLI
 * equivalents; everything interpolated is escaped; the CLI list is a native <details> (zero JS).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { provenanceFooter, page } from '../src/html.js';

test('provenanceFooter: full metadata renders counts, generated-at, and the CLI table', () => {
  const html = provenanceFooter({
    generatedAt: '2026-07-02T00:00:00.000Z',
    eventCount: 42,
    itemCount: 7,
    cliEquivalents: [
      { label: 'Spend', command: 'loopctl costs --by loop' },
      { label: 'Verdicts', command: 'loopctl verdicts' },
    ],
  });
  assert.match(html, /<footer class="opsui-provenance">/);
  assert.match(html, /Provenance/);
  assert.match(html, /projection of the append-only ledger/);
  assert.match(html, /42 ledger event\(s\)/);
  assert.match(html, /7 work item\(s\)/);
  assert.match(html, /generated 2026-07-02T00:00:00\.000Z/);
  assert.match(html, /<details class="provenance__cli">/);
  assert.match(html, /<code>loopctl costs --by loop<\/code>/);
  assert.match(html, /<code>loopctl verdicts<\/code>/);
});

test('provenanceFooter: no metadata still renders the generic ledger-trace statement', () => {
  const html = provenanceFooter();
  assert.match(html, /Provenance/);
  assert.match(html, /projection of the append-only ledger/);
  assert.ok(!html.includes('ledger event(s)'));
  assert.ok(!html.includes('<details'));
});

test('provenanceFooter: escapes labels and commands — ledger-derived strings are untrusted', () => {
  const html = provenanceFooter({
    cliEquivalents: [{ label: '<script>alert(1)</script>', command: 'loopctl events | grep "<img>"' }],
  });
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(!html.includes('<img>'));
  assert.match(html, /&lt;script&gt;/);
});

test('page: every view ends with the provenance footer, with or without metadata', () => {
  const bare = page({ title: 'A view' }, '<p>body</p>');
  assert.match(bare, /opsui-provenance/);
  assert.match(bare, /projection of the append-only ledger/);
  // The footer sits inside the workspace, after the view body.
  assert.ok(bare.indexOf('opsui-provenance') > bare.indexOf('<p>body</p>'));

  const withMeta = page(
    { title: 'A view', provenance: { eventCount: 3, generatedAt: '2026-07-02T00:00:00.000Z' } },
    '<p>body</p>',
  );
  assert.match(withMeta, /3 ledger event\(s\)/);
});
