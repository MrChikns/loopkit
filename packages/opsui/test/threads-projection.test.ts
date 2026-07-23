// WI-130 regression: the Conversations page's thread card links at
// `/threads/<externalRef ?? id>` — but the console composer stamps every item it captures
// with the literal channel marker `source: 'ext:console'` (server.ts's /intent handler), so
// core's summary.ts derives an externalRef of 'console' for it. 'console' isn't a unique
// per-intent address (every console-captured item shares it) and fails the router's
// /threads/:ref shape, so linking at it 404s. The card must fall back to the item hub for a
// ref shaped like this — see fold-adapter.ts's isResolvableExternalRef.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { threadCard } from '../src/projections/threads-projection.ts';
import type { ThreadCard } from '../src/projections/threads-adapter.ts';

function baseCard(overrides: Partial<ThreadCard> = {}): ThreadCard {
  return {
    id: 'WI-907',
    outCount: 0,
    messages: [],
    label: 'WI-907',
    state: 'unknown',
    title: '',
    ...overrides,
  };
}

test('a channel-marker externalRef (e.g. "console") links the card at the item hub, not /threads/console', () => {
  const html = threadCard(baseCard({ externalRef: 'console', label: 'console' }));
  assert.match(html, /href="\/item\/WI-907"/);
  assert.ok(!html.includes('/threads/console'), 'must never link at the unresolvable /threads/console');
});

test('a resolvable externalRef (e.g. "EXT-1") still links the card at /threads/<ref>', () => {
  const html = threadCard(baseCard({ externalRef: 'EXT-1', label: 'EXT-1' }));
  assert.match(html, /href="\/threads\/EXT-1"/);
});

test('no externalRef links straight at the item hub (same destination the WI-style /threads/:ref redirect would land on, no extra hop)', () => {
  const html = threadCard(baseCard());
  assert.match(html, /href="\/item\/WI-907"/);
});
