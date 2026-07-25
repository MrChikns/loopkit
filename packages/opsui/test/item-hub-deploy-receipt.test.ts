// WI-187 — the item hub must never assert a successful deploy it hasn't observed. Pins the
// three distinguishable states (nothing reported / deploy.succeeded / deploy.failed), which
// the console's own deployReceipt() (views.ts) already covers — this is the opsui-side twin,
// added because the equivalent branch here previously hardcoded `deployed: true` from bare
// mergeCommit presence with zero test coverage (the same gap that let it survive).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { itemHubProjectionFromInput } from '../src/projections/item-hub-adapter.ts';
import type { FoldSummary } from '../src/projections/fold-adapter.ts';

function mergedFold(): FoldSummary {
  return {
    counts: {},
    active: [],
    recentMerged: [
      {
        id: 'WI-999',
        mergedAt: new Date().toISOString(),
        mergeCommit: 'abc1234',
        spec: 'A merged item',
      },
    ],
    generatedAt: new Date().toISOString(),
  };
}

const baseInput = {
  itemId: 'WI-999',
  timeline: [],
  artifacts: [],
  artifactsTruncated: false,
  nextPath: '/work',
};

test('a merged item with no deploy event reports NO receipt — never an invented success', () => {
  const env = itemHubProjectionFromInput(mergedFold(), { ...baseInput, events: [] }, { ledgerSequence: 1 });
  assert.equal(env.state, 'fresh');
  assert.equal(env.data.deployReceipt, undefined, 'absent mergeCommit-only evidence must not be read as a successful deploy');
});

test('a merged item whose deploy.succeeded landed reports ok:true with the reported commit', () => {
  const events = [
    { id: 'e1', ts: new Date().toISOString(), actor: 'deploy', item: 'WI-999', type: 'deploy.succeeded', data: { commit: 'def5678' } },
  ];
  const env = itemHubProjectionFromInput(mergedFold(), { ...baseInput, events }, { ledgerSequence: 1 });
  assert.equal(env.state, 'fresh');
  assert.deepEqual(env.data.deployReceipt, { label: 'deployed def5678', ok: true });
});

test('a merged item whose deploy.failed landed reports ok:false with the failure reason — never a claimed success', () => {
  const events = [
    { id: 'e1', ts: new Date().toISOString(), actor: 'deploy', item: 'WI-999', type: 'deploy.failed', data: { reason: 'health check timed out' } },
  ];
  const env = itemHubProjectionFromInput(mergedFold(), { ...baseInput, events }, { ledgerSequence: 1 });
  assert.equal(env.state, 'fresh');
  assert.deepEqual(env.data.deployReceipt, { label: 'deploy failed — health check timed out', ok: false });
});

test('a re-deploy after a failure supersedes it — latest event wins, matching the console', () => {
  const events = [
    { id: 'e1', ts: '2026-01-01T00:00:00.000Z', actor: 'deploy', item: 'WI-999', type: 'deploy.failed', data: { reason: 'first attempt died' } },
    { id: 'e2', ts: '2026-01-01T00:05:00.000Z', actor: 'deploy', item: 'WI-999', type: 'deploy.succeeded', data: { commit: 'ghi9012' } },
  ];
  const env = itemHubProjectionFromInput(mergedFold(), { ...baseInput, events }, { ledgerSequence: 1 });
  assert.deepEqual(env.data.deployReceipt, { label: 'deployed ghi9012', ok: true });
});

test('deploy events for a DIFFERENT item never leak into this item\'s receipt', () => {
  const events = [
    { id: 'e1', ts: new Date().toISOString(), actor: 'deploy', item: 'WI-111', type: 'deploy.succeeded', data: { commit: 'zzz0000' } },
  ];
  const env = itemHubProjectionFromInput(mergedFold(), { ...baseInput, events }, { ledgerSequence: 1 });
  assert.equal(env.data.deployReceipt, undefined);
});

test('events defaults to [] when the caller omits it — degrades to "not deployed", never throws', () => {
  const env = itemHubProjectionFromInput(mergedFold(), { ...baseInput }, { ledgerSequence: 1 });
  assert.equal(env.state, 'fresh');
  assert.equal(env.data.deployReceipt, undefined);
});
