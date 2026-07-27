// Board order (2026-07-24, unified operating picture): Command's regions render as recent
// activity → operating picture → decision desk → to test → shipped → conversations → active
// ops-parks → provenance. Recent activity and shipped are separate cards again (WI-128 had
// merged them into one). The former separate Glance card and Pipeline flow card are merged into
// ONE "Operating picture" widget: a tile grid (Decisions/To test/Stuck/On hold/Preparing/Queued/
// Building/Flow/Reliability) followed by a conditional "In flight now" list (preparing/queued/
// building rows), rendered only when at least one of those three carries a row. The former "Ops
// health & pipeline" stage-count strip is still deleted; its only unique element (the ops-health
// badge) is NOT in this widget's header either — "On hold" is now a tile in the grid instead.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CommandProjection } from '../src/projections/command-projection.ts';
import { commandProjectionFromFold } from '../src/projections/fold-adapter.ts';
import type { FoldSummary } from '../src/projections/fold-adapter.ts';
import { conversationsRegion } from '../src/projections/threads-projection.ts';
import type { ThreadCard } from '../src/projections/threads-adapter.ts';

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
  const operatingPictureIndex = html.indexOf('id="pipeline-flow"');
  const decisionDeskIndex = html.indexOf('id="decision-desk"');
  const toTestIndex = html.indexOf('id="to-test"');
  const shippedIndex = html.indexOf('id="shipped"');
  const conversationsIndex = html.indexOf('id="conversations"');
  const opsParksIndex = html.indexOf('id="ops-parks"');
  const provenanceIndex = html.indexOf('Provenance');

  for (const [label, index] of [
    ['recent-activity', recentActivityIndex],
    ['operating-picture', operatingPictureIndex],
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
  // The old separate Glance card is gone — its title/class marker no longer renders on its own;
  // the unified widget renders "Operating picture" instead (asserted below).
  assert.equal(html.indexOf('>Glance<'), -1, 'the old standalone "Glance" card title no longer renders');
  assert.ok(html.includes('>Operating picture<'), 'the unified "Operating picture" widget renders');

  assert.ok(wrapperIndex < recentActivityIndex, 'workspace wrapper opens before the first region');
  assert.ok(recentActivityIndex < operatingPictureIndex, 'Recent activity renders before the Operating picture widget');
  assert.ok(operatingPictureIndex < decisionDeskIndex, 'Operating picture renders before Decision desk');
  assert.ok(decisionDeskIndex < toTestIndex, 'Decision desk renders before To test');
  assert.ok(toTestIndex < shippedIndex, 'To test renders before Shipped');
  assert.ok(shippedIndex < conversationsIndex, 'Shipped renders before Conversations');
  assert.ok(conversationsIndex < opsParksIndex, 'Conversations renders before Active ops-parks');
  assert.ok(opsParksIndex < provenanceIndex, 'Active ops-parks renders before Provenance');
});

// 'Conductor' was this card's title before WI-128 folded it into the unified widget as the
// Building sub-badge (the data behind it is `CommandData.inFlight` now). The guard keeps the
// old title from coming back as a separate card.
test('the unified widget has no separate Conductor card and Conversations renders inline', () => {
  const envelope = commandProjectionFromFold(baseFold({
    threads: [{
      id: 'WI-901',
      externalRef: 'EXT-901',
      state: 'needs-you',
      messages: [{ id: 'MSG-1', direction: 'in', text: 'Can you clarify?', timestamp: NOW }],
    }],
  }), { ledgerSequence: 1 });
  const html = CommandProjection(envelope);

  assert.ok(!html.includes('>Conductor<'), 'Conductor no longer renders as its own card title');
  assert.ok(html.includes('opsui-threads__reply'), 'Conversations renders the shared inline thread/reply surface');
  assert.ok(!html.includes('View all conversations'), 'Conversations no longer requires a click-through to /threads');
  assert.ok(html.includes('next=%2Fcommand%23conversations'), 'inline replies return to the Command widget');
});

test('inline Conversations pagination stays on Command and anchors back to the widget', () => {
  const threads: ThreadCard[] = Array.from({ length: 21 }, (_, index) => ({
    id: `WI-${String(index + 1).padStart(3, '0')}`,
    label: `WI-${String(index + 1).padStart(3, '0')}`,
    externalRef: `EXT-${index + 1}`,
    title: `Thread ${index + 1}`,
    state: 'unknown',
    outCount: 0,
    messages: [],
  }));
  const html = conversationsRegion(
    threads,
    1,
    (page) => page <= 1 ? '/command#conversations' : `/command?threadsPage=${page}#conversations`,
  );

  assert.ok(html.includes('/command?threadsPage=2#conversations'));
  assert.ok(!html.includes('href="/threads?page=2"'));
});

test('the tile grid renders all nine tiles, Decisions/Stuck carry critical when non-zero, and On hold/Preparing/Queued/Building carry their board-live tile hooks', () => {
  const fold = baseFold({
    counts: { queued: 2, routed: 1, building: 3, testing: 1, approved: 2, parked: 1 },
    active: [
      { id: 'WI-900', state: 'parked', parkKind: 'decision', spec: 'needs a call' },
    ],
  });
  const envelope = commandProjectionFromFold(fold, { ledgerSequence: 1 });
  const html = CommandProjection(envelope);

  // No header health badge — the design deliberately does NOT add it back; On hold is a tile.
  assert.ok(
    !html.includes('data-opsui-live="pipeline-health"'),
    'no legacy pipeline-health live-patch wrapper renders',
  );
  const glanceSectionStart = html.indexOf('id="opsui-glance-card"');
  const glanceSectionHtml = html.slice(glanceSectionStart, html.indexOf('</section>', glanceSectionStart));
  const glanceHeaderHtml = glanceSectionHtml.slice(0, glanceSectionHtml.indexOf('opsui-card__body'));
  assert.doesNotMatch(
    glanceHeaderHtml,
    /opsui-status|opsui-window/,
    'the card header carries neither a health badge nor a misleading card-wide window filter',
  );

  // All nine tiles render, in the specified order.
  for (const label of ['Decisions', 'To test', 'Stuck', 'On hold', 'Preparing', 'Queued', 'Building', 'Flow', 'Reliability']) {
    assert.ok(html.includes(`>${label}<`), `the "${label}" tile renders`);
  }
  const idx = (label: string) => html.indexOf(`>${label}<`);
  assert.ok(idx('Decisions') < idx('To test'));
  assert.ok(idx('To test') < idx('Stuck'));
  assert.ok(idx('Stuck') < idx('On hold'));
  assert.ok(idx('On hold') < idx('Preparing'));
  assert.ok(idx('Preparing') < idx('Queued'));
  assert.ok(idx('Queued') < idx('Building'));
  assert.ok(idx('Building') < idx('Flow'));
  assert.ok(idx('Flow') < idx('Reliability'));
  const scopedWindowHeading = html.indexOf('>Flow &amp; reliability<');
  const picker = html.indexOf('role="group" aria-label="Time window"');
  assert.ok(
    idx('Building') < scopedWindowHeading && scopedWindowHeading < picker && picker < idx('Flow'),
    'the window picker sits in a Flow & reliability subheader immediately before the two metrics it scopes',
  );

  // Decisions carries critical (not warning) when a decision park exists.
  assert.match(html, /opsui-metric opsui-metric--critical" href="#decision-desk"/, 'the Decisions tile carries the critical state class when >0');

  // Board-live tile hooks — On hold / Preparing / Queued / Building only (the deliberate,
  // narrower live-patch surface for this build).
  for (const key of ['onhold', 'preparing', 'queued', 'building']) {
    assert.ok(html.includes(`data-opsui-live-tile="${key}"`), `the "${key}" tile carries its board-live hook`);
  }
  // Decisions/To test/Stuck/Flow/Reliability stay refresh-only — no live-tile hook on those.
  assert.ok(!html.includes('data-opsui-live-tile="decisions"'));
  assert.ok(!html.includes('data-opsui-live-tile="stuck"'));
});

test('the in-flight list is absent when idle and present when preparing/queued/building carries work', () => {
  const idleEnvelope = commandProjectionFromFold(baseFold(), { ledgerSequence: 1 });
  const idleHtml = CommandProjection(idleEnvelope);
  assert.ok(!idleHtml.includes('In flight now'), 'idle board renders the tile grid alone, no in-flight heading');
  assert.ok(!idleHtml.includes('opsui-pipelineflow'), 'idle board renders no in-flight list markup at all');

  const busyFold = baseFold({
    counts: { building: 1 },
    active: [{ id: 'WI-901', state: 'building', spec: 'in progress' }],
  });
  const busyEnvelope = commandProjectionFromFold(busyFold, { ledgerSequence: 1 });
  const busyHtml = CommandProjection(busyEnvelope);
  assert.ok(busyHtml.includes('In flight now'), 'a busy board renders the in-flight heading');
  assert.ok(busyHtml.includes('opsui-pipelineflow'), 'a busy board renders the in-flight stage list');

  // Flow-stage patch targets (the in-flight list itself) — fixed preparing/queued/building
  // order — are unchanged from before this build.
  for (const key of ['preparing', 'queued', 'building']) {
    assert.ok(busyHtml.includes(`data-opsui-live-flow="${key}"`), `flow stage "${key}" carries its board-live hook`);
  }
});

test('the Glance card keeps its stable live-replacement hook after the picker moves to its scoped subsection', () => {
  const envelope = commandProjectionFromFold(baseFold(), { ledgerSequence: 1 });
  const html = CommandProjection(envelope);

  // The client (opsui-live.js) targets #opsui-glance-card to swap only this card's markup on a
  // window-picker click, without a full page navigation/scroll reset.
  assert.match(
    html,
    /<section class="opsui-card opsui-card--glance" id="opsui-glance-card">/,
    'the Glance card outer section carries the id hook, additive-only (same class list as before)',
  );

  // The picker still renders as plain `?window=` links with aria-current on the active option —
  // moving it inside the card body must not disturb the zero-JS or live-replacement contract.
  assert.match(html, /href="\?window=24h"[^>]*aria-current="true"/, 'the default (24h) window link stays a plain marked-active anchor');
  assert.match(html, /class="opsui-window__btn"[^>]*href="\?window=7d"/, 'the 7d window link stays a plain anchor, unmodified');
});
