// WI-187 — the item hub must never assert a successful deploy it hasn't observed. Pins the
// three distinguishable states (nothing reported / deploy.succeeded / deploy.failed), which
// the console's own deployReceipt() (views.ts) already covers — this is the opsui-side twin,
// added because the equivalent branch here previously hardcoded `deployed: true` from bare
// mergeCommit presence with zero test coverage (the same gap that let it survive).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { itemHubProjectionFromInput } from '../src/projections/item-hub-adapter.ts';
import { ItemHubProjection } from '../src/projections/item-hub-projection.ts';
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

test('a legacy merged item with no lifecycle event reports unknown — never an invented success', () => {
  const env = itemHubProjectionFromInput(mergedFold(), { ...baseInput, events: [] }, { ledgerSequence: 1 });
  assert.equal(env.state, 'fresh');
  assert.equal(env.data.deployReceipt?.status, 'unknown');
  assert.equal(env.data.deployReceipt?.label, 'Status unavailable for legacy record');
});

test('a merged item whose deploy.succeeded landed reports succeeded with the reported commit', () => {
  const events = [
    { id: 'e1', ts: new Date().toISOString(), actor: 'deploy', item: 'WI-999', type: 'deploy.succeeded', data: { commit: 'def5678' } },
  ];
  const env = itemHubProjectionFromInput(mergedFold(), { ...baseInput, events }, { ledgerSequence: 1 });
  assert.equal(env.state, 'fresh');
  assert.equal(env.data.deployReceipt?.status, 'succeeded');
  assert.equal(env.data.deployReceipt?.commit, 'def5678');
});

test('a merged item whose deploy.failed landed reports ok:false with the failure reason — never a claimed success', () => {
  const events = [
    { id: 'e1', ts: new Date().toISOString(), actor: 'deploy', item: 'WI-999', type: 'deploy.failed', data: { reason: 'health check timed out' } },
  ];
  const env = itemHubProjectionFromInput(mergedFold(), { ...baseInput, events }, { ledgerSequence: 1 });
  assert.equal(env.state, 'fresh');
  assert.equal(env.data.deployReceipt?.status, 'failed');
  assert.equal(env.data.deployReceipt?.reason, 'health check timed out');
});

test('a re-deploy after a failure supersedes it — latest event wins, matching the console', () => {
  const events = [
    { id: 'e1', ts: '2026-01-01T00:00:00.000Z', actor: 'deploy', item: 'WI-999', type: 'deploy.failed', data: { reason: 'first attempt died' } },
    { id: 'e2', ts: '2026-01-01T00:05:00.000Z', actor: 'deploy', item: 'WI-999', type: 'deploy.succeeded', data: { commit: 'ghi9012' } },
  ];
  const env = itemHubProjectionFromInput(mergedFold(), { ...baseInput, events }, { ledgerSequence: 1 });
  assert.equal(env.data.deployReceipt?.status, 'succeeded');
  assert.equal(env.data.deployReceipt?.commit, 'ghi9012');
});

test('deploy events for a DIFFERENT item never leak into this item\'s receipt', () => {
  const events = [
    { id: 'e1', ts: new Date().toISOString(), actor: 'deploy', item: 'WI-111', type: 'deploy.succeeded', data: { commit: 'zzz0000' } },
  ];
  const env = itemHubProjectionFromInput(mergedFold(), { ...baseInput, events }, { ledgerSequence: 1 });
  assert.equal(env.data.deployReceipt?.status, 'unknown');
});

test('events defaults to [] when the caller omits it — degrades to legacy unknown, never throws', () => {
  const env = itemHubProjectionFromInput(mergedFold(), { ...baseInput }, { ledgerSequence: 1 });
  assert.equal(env.state, 'fresh');
  assert.equal(env.data.deployReceipt?.status, 'unknown');
});

test('all explicit lifecycle states are rendered from fold truth', () => {
  for (const status of ['not-configured', 'pending', 'succeeded', 'failed', 'timed-out'] as const) {
    const fold = mergedFold();
    fold.recentMerged[0]!.deployStatus = status;
    const env = itemHubProjectionFromInput(fold, { ...baseInput, events: [] }, { ledgerSequence: 1 });
    assert.equal(env.data.deployReceipt?.status, status);
  }
});

test('configured-without-receipt and explicit no-deploy remain distinguishable', () => {
  const configured = mergedFold();
  configured.recentMerged[0]!.deployConfigured = true;
  const configuredEnv = itemHubProjectionFromInput(configured, { ...baseInput, events: [] }, { ledgerSequence: 1 });
  assert.equal(configuredEnv.data.deployReceipt?.status, 'unknown');
  assert.equal(configuredEnv.data.deployReceipt?.label, 'Configured · receipt not recorded');

  const notConfigured = mergedFold();
  notConfigured.recentMerged[0]!.deployConfigured = false;
  const noDeployEnv = itemHubProjectionFromInput(notConfigured, { ...baseInput, events: [] }, { ledgerSequence: 1 });
  assert.equal(noDeployEnv.data.deployReceipt?.status, 'not-configured');
});

test('a failed deployment drives the Evidence card badge — it never says success because artifacts are empty', () => {
  const fold = mergedFold();
  fold.recentMerged[0]!.deployStatus = 'failed';
  fold.recentMerged[0]!.deployFailureReason = 'health check failed';
  const html = ItemHubProjection(itemHubProjectionFromInput(fold, { ...baseInput, events: [] }, { ledgerSequence: 1 }));
  assert.match(html, /opsui-status--critical/);
  assert.match(html, /deploy failed/);
  assert.ok(!html.includes('None yet'), 'missing artifacts must not overrule a failed deploy');
});
