// WI-127 — deriveThreadState's parked branch used to collapse EVERY non-decision park
// (ops, hold, decomposition alike) into the 'building' ThreadState, so a founder looking at
// a thread card for an item parked awaiting the planner (or deliberately put on hold) saw
// "Building" — actively-in-progress framing for an item nothing is building. The parked
// branch now routes through deriveItemStatus (status-catalog.ts, the ONE status deriver
// every other adapter already uses) and narrows its parked-status ids down to distinct
// ThreadStates for 'decomposition' and 'hold', while parked-ops/awaiting-retry deliberately
// keep folding to 'building' (a plane-owned, auto-recovering park is never an operator
// action target — see PARKED_STATUS_TO_THREAD_STATE's comment in threads-adapter.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { deriveItemStatus, type ItemStatusInput } from '../src/states/status-catalog.ts';
import type { FoldActiveItem, FoldMergedItem, FoldSummary, FoldThread } from '../src/projections/fold-adapter.ts';
import { THREAD_STATE_BADGE, shortTitle, threadsProjectionFromFold, toCard } from '../src/projections/threads-adapter.ts';

function fold(overrides: Partial<FoldSummary> = {}): FoldSummary {
  return {
    counts: {},
    active: [],
    recentMerged: [],
    generatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function thread(id: string): FoldThread {
  return { id, outCount: 0 };
}

test('parkKind=decomposition never renders \'Building\' — it reads as Awaiting planner', () => {
  const active: FoldActiveItem = { id: 'WI-1', state: 'parked', parkKind: 'decomposition', spec: 'too large, needs a split' };
  const card = toCard(thread('WI-1'), fold({ active: [active] }));

  assert.equal(card.state, 'awaiting-planner');
  assert.notEqual(card.state, 'building');
  assert.equal(THREAD_STATE_BADGE[card.state].label, 'Awaiting planner');
  assert.notEqual(THREAD_STATE_BADGE[card.state].label, 'Building');
});

test('parkKind=hold renders On hold', () => {
  const active: FoldActiveItem = { id: 'WI-2', state: 'parked', parkKind: 'hold', spec: 'deliberately paused' };
  const card = toCard(thread('WI-2'), fold({ active: [active] }));

  assert.equal(card.state, 'on-hold');
  assert.equal(THREAD_STATE_BADGE[card.state].label, 'On hold');
});

test('parkKind=decision still renders Needs you (unchanged by the routing fix)', () => {
  const active: FoldActiveItem = { id: 'WI-3', state: 'parked', parkKind: 'decision', parkReason: 'touches-overstep', spec: 'needs a call' };
  const card = toCard(thread('WI-3'), fold({ active: [active] }));

  assert.equal(card.state, 'needs-you');
  assert.equal(card.parkReason, 'touches-overstep');
});

// Deliberately preserved carve-out (see PARKED_STATUS_TO_THREAD_STATE in threads-adapter.ts):
// a mechanical/infra park the plane auto-recovers from is never an operator action target, so
// the thread card still reads as in motion. This is a pinned exception, not part of the
// coherence guard below (deriveItemStatus reads these as a 'warning' tone; the thread card
// intentionally keeps the calmer 'building'/progress framing it always has).
test('parkKind=ops (and an unstamped legacy park) still render Building, unchanged by this fix', () => {
  const opsActive: FoldActiveItem = { id: 'WI-4', state: 'parked', parkKind: 'ops', parkReason: 'breaker:build-timeout', spec: 'mechanical failure' };
  const legacyActive: FoldActiveItem = { id: 'WI-5', state: 'parked', spec: 'pre-parkKind replay' };

  const opsCard = toCard(thread('WI-4'), fold({ active: [opsActive] }));
  const legacyCard = toCard(thread('WI-5'), fold({ active: [legacyActive] }));

  assert.equal(opsCard.state, 'building');
  assert.equal(legacyCard.state, 'building');
});

// Coherence guard (WI-086/WI-087 invariant): a thread card is a conversation-level view of
// the same underlying work item Command/Missions render, so its badge TONE can never
// legitimately diverge from what deriveItemStatus says about the same row. Covers every
// row shape this fix touches (queued/routed, in-flight, all three founder-visible park
// kinds, merged/accepted, rejected/superseded, unknown) — parked-ops/awaiting-retry are
// excluded here because that divergence is the documented, deliberate exception pinned above.
const COHERENCE_CASES: Array<{ label: string; buildFold: () => FoldSummary; expected: ItemStatusInput }> = [
  { label: 'queued', buildFold: () => fold({ active: [{ id: 'WI-10', state: 'queued' }] }), expected: { state: 'queued' } },
  { label: 'routed', buildFold: () => fold({ active: [{ id: 'WI-10', state: 'routed' }] }), expected: { state: 'routed' } },
  { label: 'building', buildFold: () => fold({ active: [{ id: 'WI-10', state: 'building' }] }), expected: { state: 'building' } },
  { label: 'testing', buildFold: () => fold({ active: [{ id: 'WI-10', state: 'testing' }] }), expected: { state: 'testing' } },
  { label: 'approved', buildFold: () => fold({ active: [{ id: 'WI-10', state: 'approved' }] }), expected: { state: 'approved' } },
  {
    label: 'parked-decision',
    buildFold: () => fold({ active: [{ id: 'WI-10', state: 'parked', parkKind: 'decision' }] }),
    expected: { state: 'parked', parkKind: 'decision' },
  },
  {
    label: 'parked-decomposition',
    buildFold: () => fold({ active: [{ id: 'WI-10', state: 'parked', parkKind: 'decomposition' }] }),
    expected: { state: 'parked', parkKind: 'decomposition' },
  },
  {
    label: 'parked-hold',
    buildFold: () => fold({ active: [{ id: 'WI-10', state: 'parked', parkKind: 'hold' }] }),
    expected: { state: 'parked', parkKind: 'hold' },
  },
  {
    label: 'merged, not yet accepted',
    buildFold: () => fold({ recentMerged: [{ id: 'WI-10' } as FoldMergedItem] }),
    expected: { state: 'merged' },
  },
  {
    label: 'merged and accepted',
    buildFold: () => fold({ recentMerged: [{ id: 'WI-10', accepted: true } as FoldMergedItem] }),
    expected: { state: 'merged', accepted: true },
  },
  {
    label: 'rejected by the founder',
    buildFold: () => fold({ recentRejected: [{ id: 'WI-10', rejectedBy: 'founder' }] }),
    expected: { state: 'rejected', rejectedBy: 'founder' },
  },
  {
    label: 'rejected by the reactor (superseded)',
    buildFold: () => fold({ recentRejected: [{ id: 'WI-10', rejectedBy: 'reactor' }] }),
    expected: { state: 'rejected', rejectedBy: 'reactor' },
  },
  { label: 'unknown (no matching bucket)', buildFold: () => fold(), expected: { state: 'unknown' } },
];

for (const { label, buildFold, expected } of COHERENCE_CASES) {
  test(`coherence guard: thread badge tone matches deriveItemStatus tone — ${label}`, () => {
    const card = toCard(thread('WI-10'), buildFold());
    const badgeTone = THREAD_STATE_BADGE[card.state].state;
    const catalogTone = deriveItemStatus(expected).tone;
    assert.equal(badgeTone, catalogTone, `thread badge tone for '${card.state}' must equal deriveItemStatus(...).tone`);
  });
}

// Channel-captured items must resolve to the WI id, with the channel carried as a tag, not
// displacing the id-chip label (regression for the toCard label bug described at the top of
// threads-adapter.ts).
test('a channel-style externalRef (e.g. "console") never displaces the WI id in label — it is captured as channel', () => {
  const channelThread: FoldThread = { id: 'WI-907', externalRef: 'console', outCount: 0 };
  const card = toCard(channelThread, fold());

  assert.equal(card.label, 'WI-907');
  assert.equal(card.channel, 'console');
  assert.equal(card.externalRef, 'console');
});

test('a genuinely resolvable per-intent externalRef (e.g. "EXT-77") keeps its existing behavior — no channel tag', () => {
  const resolvableThread: FoldThread = { id: 'WI-908', externalRef: 'EXT-77', outCount: 0 };
  const card = toCard(resolvableThread, fold());

  assert.equal(card.label, 'WI-908');
  assert.equal(card.externalRef, 'EXT-77');
  assert.equal(card.channel, undefined);
});

test('sort order for channel-captured threads is by WI id, not the shared channel externalRef', () => {
  const raw = fold({
    threads: [
      { id: 'WI-1', externalRef: 'zzz-channel', outCount: 0 },
      { id: 'WI-2', externalRef: 'aaa-channel', outCount: 0 },
    ],
  });

  const envelope = threadsProjectionFromFold(raw, { ledgerSequence: 1 });
  assert.equal(envelope.state, 'fresh');
  assert.deepEqual(envelope.data.threads.map((t) => t.id), ['WI-1', 'WI-2']);
});

test('shortTitle on a path-heavy first line cuts mid-token at 48 chars instead of collapsing to a near-empty title', () => {
  const spec = 'In packages/opsui/src/projections/fold-adapter.ts, the Glance window picker should drive the headline';
  const title = shortTitle(spec);

  assert.ok(title.length >= 12, `expected a usable title, got "${title}" (length ${title.length})`);
  assert.notEqual(title, 'In…');
});
