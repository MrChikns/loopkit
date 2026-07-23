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
  const html = threadCard(baseCard({ externalRef: 'console', channel: 'console' }));
  assert.match(html, /href="\/item\/WI-907"/);
  assert.ok(!html.includes('/threads/console'), 'must never link at the unresolvable /threads/console');
});

test('a resolvable externalRef (e.g. "EXT-1") still links the card at /threads/<ref>', () => {
  const html = threadCard(baseCard({ externalRef: 'EXT-1' }));
  assert.match(html, /href="\/threads\/EXT-1"/);
});

test('no externalRef links straight at the item hub (same destination the WI-style /threads/:ref redirect would land on, no extra hop)', () => {
  const html = threadCard(baseCard());
  assert.match(html, /href="\/item\/WI-907"/);
});

// Regression: toCard() used to set label to a channel-style externalRef ('console'), which
// displaced the WI id in the id-chip slot. label must always be the id; the channel renders
// as a separate small tag ahead of the title instead.
test('channel-captured card renders id-chip/label as the WI id, with a "console" channel tag before the title', () => {
  const html = threadCard(baseCard({ externalRef: 'console', channel: 'console', title: 'Reported via console' }));

  assert.match(html, /<span class="opsui-threads__card-id">WI-907<\/span>/);
  assert.match(
    html,
    /<span class="opsui-threads__channel-tag">console<\/span>\s*<span class="opsui-threads__card-title">/,
  );
});

test('a resolvable externalRef renders no channel tag (existing ref-based behavior is unchanged)', () => {
  const html = threadCard(baseCard({ externalRef: 'EXT-1' }));
  assert.ok(!html.includes('opsui-threads__channel-tag'), 'a genuinely resolvable ref must not render a channel tag');
});
