// Operator request (WI-128): Command's regions render operator-attention first — decision desk,
// then To test, then the unified Pipeline card, then Glance, then the unified recent-activity
// feed (Conversations demoted to a link within it), then Active ops-parks, then Provenance.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CommandProjection } from '../src/projections/command-projection.ts';
import { commandProjectionFromFold } from '../src/projections/fold-adapter.ts';
import type { FoldMergedItem, FoldSummary } from '../src/projections/fold-adapter.ts';

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

test('Command sections render in operator-attention order', () => {
  const envelope = commandProjectionFromFold(baseFold(), { ledgerSequence: 1 });
  const html = CommandProjection(envelope);

  const decisionDeskIndex = html.indexOf('id="decision-desk"');
  const toTestIndex = html.indexOf('id="to-test"');
  const pipelineIndex = html.indexOf('id="pipeline"');
  const wrapperIndex = html.indexOf('data-projection="command"');
  const recentActivityIndex = html.indexOf('id="recent-activity"');
  const conversationsIndex = html.indexOf('id="conversations"');
  const opsParksIndex = html.indexOf('id="ops-parks"');
  const provenanceIndex = html.indexOf('Provenance');

  for (const [label, index] of [
    ['decision desk', decisionDeskIndex],
    ['to-test', toTestIndex],
    ['pipeline', pipelineIndex],
    ['recent-activity', recentActivityIndex],
    ['conversations', conversationsIndex],
    ['ops-parks', opsParksIndex],
    ['provenance', provenanceIndex],
  ] as const) {
    assert.ok(index >= 0, `the ${label} section renders`);
  }

  assert.ok(wrapperIndex < decisionDeskIndex, 'workspace wrapper opens before the first region');
  assert.ok(decisionDeskIndex < toTestIndex, 'Decision desk renders before To test');
  assert.ok(toTestIndex < pipelineIndex, 'To test renders before the unified Pipeline card');
  assert.ok(pipelineIndex < recentActivityIndex, 'Pipeline renders before the recent-activity feed');
  assert.ok(recentActivityIndex < conversationsIndex, 'Recent activity renders before the demoted Conversations link');
  assert.ok(conversationsIndex < opsParksIndex, 'Conversations renders before Active ops-parks');
  assert.ok(opsParksIndex < provenanceIndex, 'Active ops-parks renders before Provenance');
});

test('the unified Pipeline card has no separate Conductor card and Conversations is a link, not a full list', () => {
  const envelope = commandProjectionFromFold(baseFold(), { ledgerSequence: 1 });
  const html = CommandProjection(envelope);

  assert.ok(!html.includes('>Conductor<'), 'Conductor no longer renders as its own card title');
  assert.ok(!html.includes('opsui-threads__reply'), 'Conversations no longer renders the full inline thread list/reply composer');
  assert.ok(html.includes('View all conversations'), 'Conversations renders as a link to the full /threads page');
});

test("the unified pipeline card's stage counts equal the fold summary buckets", () => {
  const fold = baseFold({
    counts: { queued: 2, routed: 1, building: 3, testing: 1, approved: 2, parked: 1 },
    recentMerged: [
      { id: 'WI-801', mergedAt: NOW, accepted: true },
      { id: 'WI-802', mergedAt: NOW, accepted: false, tier: 'must' },
      { id: 'WI-803', mergedAt: NOW, accepted: false, tier: 'optional' },
      { id: 'WI-804', mergedAt: NOW, accepted: true },
    ] satisfies FoldMergedItem[],
  });
  const envelope = commandProjectionFromFold(fold, { ledgerSequence: 1 });
  const html = CommandProjection(envelope);

  for (const stage of envelope.data.pipeline) {
    const cell = `<span class="opsui-pipeline__count">${stage.count}</span>`;
    assert.ok(
      html.includes(cell),
      `pipeline card shows ${stage.count} for stage "${stage.label}" (fold bucket count)`,
    );
  }
});
