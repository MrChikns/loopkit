// WI-071 follow-up (to WI-072's ordering fix) — the thread-detail header must show a
// clearly-visible capture date/time, formatted local (not UTC) like every other
// timestamp on this surface (formatLocal renders local time).
// Previously this projection had its own `fmtTs` that hardcoded UTC output, out of step
// with `threads-projection.ts`'s "Last reply <local ts>" pattern on the same CSS class.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatLocal } from '../src/render/html.ts';
import { ThreadDetailProjection } from '../src/projections/thread-detail-projection.ts';
import type { ThreadDetailData } from '../src/projections/thread-detail-projection.ts';
import { STATUS_CATALOG } from '../src/states/status-catalog.ts';

function baseData(overrides: Partial<ThreadDetailData> = {}): ThreadDetailData {
  return {
    externalRef: 'EXT-1',
    wiRef: 'WI-071',
    itemState: 'routed',
    originalText: 'Please build the widget',
    attachments: [],
    messages: [],
    outCount: 0,
    ...overrides,
  };
}

test('the header shows a clearly-labeled, local-time capture timestamp when capturedAt is present', () => {
  const capturedAt = '2026-07-20T14:32:00.000Z';
  const html = ThreadDetailProjection(baseData({ capturedAt }));

  const expected = formatLocal(new Date(capturedAt));
  assert.match(html, /opsui-threads__last-ts/, 'the capture timestamp must use the visible last-ts style');
  assert.match(html, new RegExp(`Captured ${expected.replace(/[-:]/g, '\\$&')}`), 'the header must render "Captured <local ts>"');
  assert.ok(!html.includes('UTC'), 'the capture timestamp must render in local time, not UTC');
});

test('no header timestamp span is rendered when capturedAt is absent', () => {
  const html = ThreadDetailProjection(baseData());
  assert.ok(!html.includes('opsui-threads__last-ts'), 'no capture timestamp should render without capturedAt');
});

// WI-086/WI-087 regression: this projection used to keep its own FOLD_STATE_TO_OP tone
// table and render the raw fold state string as the badge label (e.g. bare 'parked'
// instead of the catalog's 'Awaiting retry' / 'Needs your decision'). It must now defer
// to the same status-catalog.ts every other surface uses.
test('the header badge renders the status-catalog label, never the raw fold state string', () => {
  const html = ThreadDetailProjection(baseData({ itemState: 'parked' }));
  assert.ok(html.includes(STATUS_CATALOG['awaiting-retry'].label), 'a parked item with no park-kind data must render the catalog fallback label');
  assert.ok(!html.includes('>parked<'), 'the raw fold state must never be rendered verbatim as the badge label');
});

test('the header badge matches the catalog label for a routed item, not the raw "routed" string', () => {
  const html = ThreadDetailProjection(baseData({ itemState: 'routed' }));
  assert.ok(html.includes(STATUS_CATALOG.routing.label));
  assert.ok(!html.includes('>routed<'));
});

// WI-130 regression: this projection backs both the standalone /threads/:ref page AND the
// item hub's embedded conversation region (item-hub-adapter.ts's conversationRegion). A
// channel-style externalRef (the console composer's literal 'console' marker — see
// server.ts's /intent handler and core's summary.ts) isn't a resolvable per-intent address,
// so the reply form's post-submit redirect must land on the item hub, not the unresolvable
// /threads/console the router 404s on.
test('the reply form redirects to the item hub when externalRef is a channel marker, not a resolvable ref', () => {
  const html = ThreadDetailProjection(baseData({ externalRef: 'console', wiRef: 'WI-129' }));
  assert.match(html, /action="\/intent\?next=%2Fitem%2FWI-129"/, 'next must resolve to the item hub');
  assert.ok(!html.includes('%2Fthreads%2Fconsole'), 'next must never point at the unresolvable /threads/console');
});

test('the reply form still redirects to /threads/<ref> for a resolvable externalRef', () => {
  const html = ThreadDetailProjection(baseData({ externalRef: 'EXT-1', wiRef: 'WI-071' }));
  assert.match(html, /action="\/intent\?next=%2Fthreads%2FEXT-1"/);
});
