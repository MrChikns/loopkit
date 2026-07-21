// WI-057 regression coverage — the acceptance desk must render the leader-leader
// "certify, don't brief" payload (Could break / Detection / Rollback) when a merged item's
// `certification` field is present, and a visible "no certification provided" line when it
// is absent — never a silent blank (the founder should never mistake missing certification
// for a clean one).
//
// These tests exercise `acceptanceProjectionFromFold(...).data.queue` — the public entry
// point — mirroring recent-intents.test.ts's pattern.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { acceptanceProjectionFromFold } from '../src/projections/acceptance-adapter.ts';
import { AcceptanceProjection } from '../src/projections/acceptance-projection.ts';
import type { FoldSummary } from '../src/projections/fold-adapter.ts';

const NOW = '2026-07-20T12:00:00.000Z';

function baseFold(overrides: Partial<FoldSummary> = {}): FoldSummary {
  return {
    counts: {},
    active: [],
    recentMerged: [],
    generatedAt: NOW,
    ...overrides,
  };
}

const CERT = {
  couldBreak: 'The migration script could strand rows mid-batch.',
  detection: 'The nightly integrity check would flag orphaned rows.',
  rollback: 'Re-run the down-migration; it is idempotent.',
};

test('a merged item carrying a certification payload surfaces it on the acceptance queue', () => {
  const fold = baseFold({
    recentMerged: [
      { id: 'WI-950', spec: 'Add KMS drop-in', mergedAt: '2026-07-20T10:00:00.000Z', certification: CERT },
    ],
  });

  const envelope = acceptanceProjectionFromFold(fold, { ledgerSequence: 1 });
  const row = envelope.data.queue.find((r) => r.id === 'WI-950');

  assert.ok(row, 'the merged item appears on the acceptance queue');
  assert.deepEqual(row!.certification, CERT);
});

test('a merged item with NO certification payload still appears, marked absent (never silently blank)', () => {
  const fold = baseFold({
    recentMerged: [
      { id: 'WI-951', spec: 'Old-shape merge', mergedAt: '2026-07-20T10:00:00.000Z' },
    ],
  });

  const envelope = acceptanceProjectionFromFold(fold, { ledgerSequence: 1 });
  const row = envelope.data.queue.find((r) => r.id === 'WI-951');

  assert.ok(row, 'the merged item appears on the acceptance queue');
  assert.equal(row!.certification, undefined, 'no certification payload on an old-shape merge');
});

test('rendered HTML: a certification payload renders the three labeled fields', () => {
  const fold = baseFold({
    recentMerged: [
      { id: 'WI-952', spec: 'Add KMS drop-in', mergedAt: '2026-07-20T10:00:00.000Z', certification: CERT },
    ],
  });
  const envelope = acceptanceProjectionFromFold(fold, { ledgerSequence: 1 });
  const html = AcceptanceProjection(envelope);

  assert.ok(html.includes('Could break'), 'renders the Could-break label');
  assert.ok(html.includes('Detection'), 'renders the Detection label');
  assert.ok(html.includes('Rollback'), 'renders the Rollback label');
  assert.ok(html.includes(CERT.couldBreak), 'renders the couldBreak text');
  assert.ok(!html.includes('No certification provided'), 'a present payload never also shows the absent-line');
});

test('rendered HTML: NO certification payload renders a visible "No certification provided" line', () => {
  const fold = baseFold({
    recentMerged: [
      { id: 'WI-953', spec: 'Old-shape merge', mergedAt: '2026-07-20T10:00:00.000Z' },
    ],
  });
  const envelope = acceptanceProjectionFromFold(fold, { ledgerSequence: 1 });
  const html = AcceptanceProjection(envelope);

  assert.ok(html.includes('No certification provided'), 'absent certification renders a visible line, never blank');
});
