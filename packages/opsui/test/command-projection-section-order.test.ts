// Founder-set board order (2026-07-24): Command's regions render as recent activity → pipeline
// flow → glance → decision desk → to test → shipped → conversations → active ops-parks →
// provenance. Recent activity and shipped are separate cards again (WI-128 had merged them into
// one). The former "Ops health & pipeline" stage-count strip (a separate card ahead of the
// "Pipeline" preparing/queued/building flow card) is deleted (same-day follow-up): it duplicated
// data already shown elsewhere on the board (Queued/Building in the flow card's own lane counts,
// Merged in Shipped, Parked in Decision desk/ops-parks). Its only unique element — the ops-health
// badge — now renders in the Glance card's header, ahead of the WindowPicker.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CommandProjection } from '../src/projections/command-projection.ts';
import { commandProjectionFromFold } from '../src/projections/fold-adapter.ts';
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

test('Command sections render in operator-attention order', () => {
  const envelope = commandProjectionFromFold(baseFold(), { ledgerSequence: 1 });
  const html = CommandProjection(envelope);

  const wrapperIndex = html.indexOf('data-projection="command"');
  const recentActivityIndex = html.indexOf('id="recent-activity"');
  const pipelineFlowIndex = html.indexOf('id="pipeline-flow"');
  const glanceIndex = html.indexOf('opsui-card--glance');
  const decisionDeskIndex = html.indexOf('id="decision-desk"');
  const toTestIndex = html.indexOf('id="to-test"');
  const shippedIndex = html.indexOf('id="shipped"');
  const conversationsIndex = html.indexOf('id="conversations"');
  const opsParksIndex = html.indexOf('id="ops-parks"');
  const provenanceIndex = html.indexOf('Provenance');

  for (const [label, index] of [
    ['recent-activity', recentActivityIndex],
    ['pipeline-flow', pipelineFlowIndex],
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

  assert.equal(html.indexOf('id="pipeline"'), -1, 'the "Ops health & pipeline" strip section no longer renders');

  assert.ok(wrapperIndex < recentActivityIndex, 'workspace wrapper opens before the first region');
  assert.ok(recentActivityIndex < pipelineFlowIndex, 'Recent activity renders before the Pipeline flow card');
  assert.ok(pipelineFlowIndex < glanceIndex, 'Pipeline flow card renders before Glance');
  assert.ok(glanceIndex < decisionDeskIndex, 'Glance renders before Decision desk');
  assert.ok(decisionDeskIndex < toTestIndex, 'Decision desk renders before To test');
  assert.ok(toTestIndex < shippedIndex, 'To test renders before Shipped');
  assert.ok(shippedIndex < conversationsIndex, 'Shipped renders before Conversations');
  assert.ok(conversationsIndex < opsParksIndex, 'Conversations renders before Active ops-parks');
  assert.ok(opsParksIndex < provenanceIndex, 'Active ops-parks renders before Provenance');
});

test('the pipeline flow card has no separate Conductor card and Conversations is a link, not a full list', () => {
  const envelope = commandProjectionFromFold(baseFold(), { ledgerSequence: 1 });
  const html = CommandProjection(envelope);

  assert.ok(!html.includes('>Conductor<'), 'Conductor no longer renders as its own card title');
  assert.ok(!html.includes('opsui-threads__reply'), 'Conversations no longer renders the full inline thread list/reply composer');
  assert.ok(html.includes('View all conversations'), 'Conversations renders as a link to the full /threads page');
});

test('the ops-health badge renders inside the Glance card header, and the pipeline flow card carries board-live client-patch hooks', () => {
  const fold = baseFold({
    counts: { queued: 2, routed: 1, building: 3, testing: 1, approved: 2, parked: 1 },
  });
  const envelope = commandProjectionFromFold(fold, { ledgerSequence: 1 });
  const html = CommandProjection(envelope);

  // Health badge patch target — the console's /command/live pushes health.headline into the
  // badge's label node, selected structurally as `#opsui-glance-card .opsui-card__aside
  // .opsui-status .opsui-status__label` (opsui-live.js). The badge renders via Card's normal
  // `headerAside` slot — no bespoke wrapper element — so it's byte-identical to every other
  // card's header badge on this board, scoped by the Glance card's stable `#opsui-glance-card`
  // id (the same hook the in-place window swap already uses), and rendered ahead of the
  // WindowPicker within that same aside.
  assert.ok(
    !html.includes('data-opsui-live="pipeline-health"'),
    'health badge is patched structurally, not via a layout-shifting wrapper',
  );
  const glanceSectionStart = html.indexOf('id="opsui-glance-card"');
  const glanceSectionHtml = html.slice(glanceSectionStart, html.indexOf('</section>', glanceSectionStart));
  assert.match(
    glanceSectionHtml,
    /<div class="opsui-card__aside"><span class="opsui-status/,
    'the Glance card renders the health StatusBadge via the normal Card aside slot, ahead of the WindowPicker',
  );
  assert.ok(
    glanceSectionHtml.indexOf('opsui-status') < glanceSectionHtml.indexOf('opsui-window'),
    'the health badge renders before the WindowPicker within the shared aside',
  );

  // The former "Ops health & pipeline" strip and its per-stage patch hooks are gone.
  assert.equal(html.indexOf('id="pipeline"'), -1, 'the strip section no longer renders');
  assert.ok(!html.includes('opsui-pipeline__stage'), 'no strip stage markup renders');
  assert.ok(!html.includes('data-opsui-live-stage'), 'no per-stage board-live hooks render');

  // Flow-stage patch targets — fixed preparing/queued/building order — are unchanged.
  for (const key of ['preparing', 'queued', 'building']) {
    assert.ok(html.includes(`data-opsui-live-flow="${key}"`), `flow stage "${key}" carries its board-live hook`);
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
