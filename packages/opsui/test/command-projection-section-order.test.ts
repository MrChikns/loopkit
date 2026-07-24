// Founder-set board order (2026-07-24): Command's regions render as recent activity → pipeline →
// glance → decision desk → to test → shipped → conversations → active ops-parks → provenance.
// Recent activity and shipped are separate cards again (WI-128 had merged them into one).

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

  const wrapperIndex = html.indexOf('data-projection="command"');
  const recentActivityIndex = html.indexOf('id="recent-activity"');
  const pipelineIndex = html.indexOf('id="pipeline"');
  const glanceIndex = html.indexOf('opsui-card--glance');
  const decisionDeskIndex = html.indexOf('id="decision-desk"');
  const toTestIndex = html.indexOf('id="to-test"');
  const shippedIndex = html.indexOf('id="shipped"');
  const conversationsIndex = html.indexOf('id="conversations"');
  const opsParksIndex = html.indexOf('id="ops-parks"');
  const provenanceIndex = html.indexOf('Provenance');

  for (const [label, index] of [
    ['recent-activity', recentActivityIndex],
    ['pipeline', pipelineIndex],
    ['glance', glanceIndex],
    ['decision desk', decisionDeskIndex],
    ['to-test', toTestIndex],
    ['shipped', shippedIndex],
    ['conversations', conversationsIndex],
    ['ops-parks', opsParksIndex],
    ['provenance', provenanceIndex],
  ] as const) {
    assert.ok(index >= 0, `the ${label} section renders`);
  }

  assert.ok(wrapperIndex < recentActivityIndex, 'workspace wrapper opens before the first region');
  assert.ok(recentActivityIndex < pipelineIndex, 'Recent activity renders before Pipeline');
  assert.ok(pipelineIndex < glanceIndex, 'Pipeline renders before Glance');
  assert.ok(glanceIndex < decisionDeskIndex, 'Glance renders before Decision desk');
  assert.ok(decisionDeskIndex < toTestIndex, 'Decision desk renders before To test');
  assert.ok(toTestIndex < shippedIndex, 'To test renders before Shipped');
  assert.ok(shippedIndex < conversationsIndex, 'Shipped renders before Conversations');
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

test('the pipeline card carries board-live client-patch hooks without changing visible counts', () => {
  const fold = baseFold({
    counts: { queued: 2, routed: 1, building: 3, testing: 1, approved: 2, parked: 1 },
  });
  const envelope = commandProjectionFromFold(fold, { ledgerSequence: 1 });
  const html = CommandProjection(envelope);

  // Health badge patch target — the console's /command/live pushes health.headline into the
  // badge's label node, selected structurally (`.opsui-pipeline__header > .opsui-status ...`).
  // The badge must be the header's FIRST child (no wrapper element — an earlier wrapper span
  // shifted the header layout), so the structural selector resolves to it.
  assert.ok(
    !html.includes('data-opsui-live="pipeline-health"'),
    'health badge is patched structurally, not via a layout-shifting wrapper',
  );
  assert.match(
    html,
    /<div class="opsui-pipeline__header"><span class="opsui-status/,
    'pipeline header renders the health StatusBadge as its first (direct) child',
  );

  // Flow-stage patch targets — fixed preparing/queued/building order.
  for (const key of ['preparing', 'queued', 'building']) {
    assert.ok(html.includes(`data-opsui-live-flow="${key}"`), `flow stage "${key}" carries its board-live hook`);
  }

  // Stage-count patch targets — one per pipeline stage, keyed by the stage's own label (lower-
  // cased) rather than `state`, since two stages (Building/Approved) share the same `progress`
  // state and would otherwise collide on a single data-state selector.
  for (const stage of envelope.data.pipeline) {
    assert.ok(
      html.includes(`data-opsui-live-stage="${stage.label.toLowerCase()}"`),
      `stage "${stage.label}" carries its own board-live hook`,
    );
  }

  // No visible-output change: the same count cell markup from the prior test still renders.
  for (const stage of envelope.data.pipeline) {
    assert.ok(html.includes(`<span class="opsui-pipeline__count">${stage.count}</span>`));
  }
});

test('the Glance card carries a stable id hook for the client in-place window swap, with no visible change', () => {
  const envelope = commandProjectionFromFold(baseFold(), { ledgerSequence: 1 });
  const html = CommandProjection(envelope);

  // The client (opsui-live.js) targets #opsui-glance-card to swap only this card's markup on a
  // window-picker click, without a full page navigation/scroll reset.
  assert.match(
    html,
    /<section class="opsui-card opsui-card--glance" id="opsui-glance-card">/,
    'the Glance card outer section carries the id hook, additive-only (same class list as before)',
  );

  // Visible output is unchanged: the window picker still renders as plain `?window=` links with
  // aria-current on the active option — the zero-JS contract this hook must not disturb.
  assert.match(html, /href="\?window=24h"[^>]*aria-current="true"/, 'the default (24h) window link stays a plain marked-active anchor');
  assert.match(html, /class="opsui-window__btn"[^>]*href="\?window=7d"/, 'the 7d window link stays a plain anchor, unmodified');
});
