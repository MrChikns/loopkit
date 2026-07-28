import assert from 'node:assert/strict';
import { test } from 'node:test';

import { acceptanceModeFor, acceptanceProjectionFromFold } from '../src/projections/acceptance-adapter.ts';
import { AcceptanceProjection } from '../src/projections/acceptance-projection.ts';
import type { FoldMergedItem, FoldSummary } from '../src/projections/fold-adapter.ts';

const NOW = '2026-07-20T12:00:00.000Z';
const MERGED = '2026-07-20T10:00:00.000Z';

function foldFor(items: FoldMergedItem[]): FoldSummary {
  return { counts: {}, active: [], recentMerged: items, generatedAt: NOW };
}

test('acceptance timer eligibility matches the core deploy prerequisite in all seven lifecycle cases', () => {
  const cases: Array<{
    id: string;
    deployConfigured?: boolean;
    deployStatus?: FoldMergedItem['deployStatus'];
    mode: ReturnType<typeof acceptanceModeFor>;
    label?: string;
  }> = [
    { id: 'not-configured', deployConfigured: false, mode: 'timer' },
    { id: 'succeeded', deployConfigured: true, deployStatus: 'succeeded', mode: 'timer' },
    { id: 'pending', deployConfigured: true, deployStatus: 'pending', mode: 'waiting-deploy', label: 'Deploy pending' },
    { id: 'failed', deployConfigured: true, deployStatus: 'failed', mode: 'deploy-attention', label: 'Deploy failed' },
    { id: 'timed-out', deployConfigured: true, deployStatus: 'timed-out', mode: 'deploy-attention', label: 'Deploy timed out' },
    { id: 'configured-missing', deployConfigured: true, mode: 'deploy-attention', label: 'Deploy status missing' },
    { id: 'legacy-unknown', mode: 'deploy-attention', label: 'Deploy status unknown' },
  ];
  const items = cases.map((c, index): FoldMergedItem => ({
    id: `WI-${980 + index}`,
    spec: c.id,
    mergedAt: MERGED,
    tier: 'auto',
    ...(typeof c.deployConfigured === 'boolean' ? { deployConfigured: c.deployConfigured } : {}),
    ...(c.deployStatus ? { deployStatus: c.deployStatus } : {}),
  }));

  const envelope = acceptanceProjectionFromFold(foldFor(items), { ledgerSequence: 1 });
  for (const [index, expected] of cases.entries()) {
    const row = envelope.data.queue[index]!;
    assert.equal(row.acceptanceMode, expected.mode, expected.id);
    if (expected.label) assert.equal(row.badge.label, expected.label, expected.id);
  }
  assert.equal(envelope.data.glance[0]?.value, '5 need testing · 2 auto-accepting');

  const html = AcceptanceProjection(envelope);
  assert.match(html, /Auto-accepting soon/);
  assert.match(html, /Deploy pending/);
  assert.match(html, /Deploy failed/);
  assert.doesNotMatch(
    html.slice(html.indexOf('Waiting on your test'), html.indexOf('Auto-accepting soon')),
    /No action needed/,
  );
  assert.match(
    html.slice(html.indexOf('WI-982'), html.indexOf('WI-983')),
    /Works — accept/,
    'an auto-tier item blocked on deploy retains a manual verdict path',
  );
});

test('acceptance origin counts, filter and displayed touches all use actual diff before declared touches', () => {
  const item: FoldMergedItem = {
    id: 'WI-990',
    spec: 'Actual target change',
    mergedAt: MERGED,
    tier: 'review',
    touches: 'packages/console/',
    mergeChangedFiles: ['src/product.ts'],
  };
  const all = acceptanceProjectionFromFold(foldFor([item]), { ledgerSequence: 1 });
  assert.deepEqual(all.data.counts, { all: 1, target: 1, plane: 0, other: 0 });
  assert.equal(all.data.queue[0]?.origin, 'target');
  assert.deepEqual(all.data.queue[0]?.touches, ['src/product.ts']);

  const target = acceptanceProjectionFromFold(foldFor([item]), { ledgerSequence: 1, filter: 'target' });
  const plane = acceptanceProjectionFromFold(foldFor([item]), { ledgerSequence: 1, filter: 'plane' });
  assert.equal(target.data.queue.length, 1);
  assert.equal(plane.data.queue.length, 0);
  const html = AcceptanceProjection(all);
  assert.match(html, /src\/product\.ts/);
  assert.doesNotMatch(html, /packages\/console/);
});

test('an explicit empty actual diff does not fall back to conflicting declared touches', () => {
  const item: FoldMergedItem = {
    id: 'WI-991',
    mergedAt: MERGED,
    tier: 'auto',
    deployConfigured: false,
    touches: 'packages/console/',
    mergeChangedFiles: [],
  };
  const envelope = acceptanceProjectionFromFold(foldFor([item]), { ledgerSequence: 1 });
  assert.deepEqual(envelope.data.counts, { all: 1, target: 0, plane: 0, other: 1 });
  assert.equal(envelope.data.queue[0]?.origin, undefined);
  assert.equal(envelope.data.queue[0]?.touches, undefined);
});
