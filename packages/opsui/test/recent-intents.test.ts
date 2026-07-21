// WI-061 regression coverage — the Command "Recent work items" strip must surface
// recently-touched work even when it never became a "thread" (core summary.ts isThread:
// a thread only exists once a msg.out reply or a legacy externalRef is present). In attended
// fast-drain mode nothing ever replies, so a captured+merged item with zero messages used
// to be invisible on the strip even though fold.recentMerged already carried it fresh.
//
// These tests exercise `commandProjectionFromFold(...).data.recentIntents` — the public
// entry point — rather than reaching into the unexported `buildRecentIntents`, so they
// pin the observable contract, not the internal helper shape.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { commandProjectionFromFold } from '../src/projections/fold-adapter.ts';
import type { FoldSummary } from '../src/projections/fold-adapter.ts';

const NOW = '2026-07-20T12:00:00.000Z';

// Deterministic-clock pattern (mirrors core's slo.ts SloProbes.now): buildRecentIntents'
// 24h-window filter reads `opts.now` instead of the real wall clock. Every fixture below is
// authored relative to NOW, so every call must pin the SAME clock — otherwise the filter
// judges fixed-in-the-past fixture timestamps against whatever moment the suite happens to
// run, and a fixture ages out of the 24h window overnight (the flake this fixes).
const FIXED_NOW = (): number => new Date(NOW).getTime();

function baseFold(overrides: Partial<FoldSummary> = {}): FoldSummary {
  return {
    counts: {},
    active: [],
    recentMerged: [],
    generatedAt: NOW,
    ...overrides,
  };
}

test('a captured+merged item with zero messages and no externalRef appears on the strip as merged', () => {
  const fold = baseFold({
    recentMerged: [
      { id: 'WI-900', spec: 'Add the widget', mergedAt: '2026-07-20T10:00:00.000Z' },
    ],
    // No `threads` at all — this item never received a conductor reply and carries no
    // externalRef, so under the old thread-only sourcing it would never appear here.
  });

  const envelope = commandProjectionFromFold(fold, { ledgerSequence: 1, now: FIXED_NOW });
  const row = envelope.data.recentIntents.find((r) => r.id === 'WI-900');

  assert.ok(row, 'merged item with no thread must still appear on the strip');
  assert.equal(row!.foldState, 'merged');
  assert.equal(row!.text, 'Add the widget');
  assert.equal(row!.timelineHref, '/item/WI-900');
  assert.equal(row!.externalRef, undefined);
  assert.equal(row!.threadHref, undefined);
});

test('a >24h-old merged item is excluded from the strip', () => {
  const fold = baseFold({
    recentMerged: [
      // mergedAt is 30h before `generatedAt` (NOW) — outside the 24h window.
      { id: 'WI-901', spec: 'Old shipped thing', mergedAt: '2026-07-19T06:00:00.000Z' },
    ],
  });

  const envelope = commandProjectionFromFold(fold, { ledgerSequence: 1, now: FIXED_NOW });
  const row = envelope.data.recentIntents.find((r) => r.id === 'WI-901');

  assert.equal(row, undefined, '>24h-old merged item must not appear on the strip');
});

test('an active item (no thread, no merge) still appears, sourced from fold.active', () => {
  const fold = baseFold({
    active: [
      { id: 'WI-902', state: 'building', spec: 'Build the thing', buildingAt: '2026-07-20T11:30:00.000Z' },
    ],
  });

  const envelope = commandProjectionFromFold(fold, { ledgerSequence: 1, now: FIXED_NOW });
  const row = envelope.data.recentIntents.find((r) => r.id === 'WI-902');

  assert.ok(row, 'active item must appear even with no thread');
  assert.equal(row!.foldState, 'building');
  assert.equal(row!.text, 'Build the thing');
});

test('an active item stale beyond 24h (last activity old) is excluded', () => {
  const fold = baseFold({
    active: [
      { id: 'WI-903', state: 'parked', spec: 'Stale park', parkedAt: '2026-07-18T12:00:00.000Z' },
    ],
  });

  const envelope = commandProjectionFromFold(fold, { ledgerSequence: 1, now: FIXED_NOW });
  const row = envelope.data.recentIntents.find((r) => r.id === 'WI-903');

  assert.equal(row, undefined, 'active item whose last activity is >24h old must not appear');
});

test('a captured-only thread (zero messages, no externalRef) still appears via the threads union', () => {
  const fold = baseFold({
    threads: [
      { id: 'WI-904', outCount: 0, messages: [] },
    ],
  });

  const envelope = commandProjectionFromFold(fold, { ledgerSequence: 1, now: FIXED_NOW });
  const row = envelope.data.recentIntents.find((r) => r.id === 'WI-904');

  assert.ok(row, 'a captured thread with zero messages must still surface');
  assert.equal(row!.foldState, 'captured');
  // No opening message and no matching active/merged item to source spec from — falls
  // back to the bare id, never "undefined".
  assert.equal(row!.text, 'WI-904');
});

test('an item present in BOTH threads and recentMerged renders once, preferring the richer row', () => {
  const fold = baseFold({
    recentMerged: [
      { id: 'WI-905', spec: 'Fallback spec text', mergedAt: '2026-07-20T09:00:00.000Z' },
    ],
    threads: [
      {
        id: 'WI-905',
        externalRef: 'EXT-42',
        outCount: 1,
        lastOutTs: '2026-07-20T09:05:00.000Z',
        messages: [
          { ts: '2026-07-20T08:00:00.000Z', direction: 'in', text: 'Please build the widget' },
          { ts: '2026-07-20T09:05:00.000Z', direction: 'out', text: 'Shipped it' },
        ],
      },
    ],
  });

  const envelope = commandProjectionFromFold(fold, { ledgerSequence: 1, now: FIXED_NOW });
  const rows = envelope.data.recentIntents.filter((r) => r.id === 'WI-905');

  assert.equal(rows.length, 1, 'a dual-sourced item must render exactly once');
  const row = rows[0]!;
  // Richer row: thread text (opening message) + merged state + the EXT chip/link.
  assert.equal(row.foldState, 'merged');
  assert.equal(row.text, 'Please build the widget');
  assert.equal(row.externalRef, 'EXT-42');
  assert.equal(row.threadHref, '/threads/EXT-42');
});

test('cap-at-5 and newest-first ordering hold across the unioned sources', () => {
  const recentMerged = Array.from({ length: 4 }, (_, i) => ({
    id: `WI-91${i}`,
    spec: `Merged item ${i}`,
    // Staggered mergedAt, all within the last 24h, oldest first in the input array to
    // prove the output re-sorts rather than trusting input order.
    mergedAt: new Date(new Date(NOW).getTime() - (i + 1) * 60 * 60 * 1000).toISOString(),
  }));
  const active = [
    { id: 'WI-920', state: 'building', spec: 'Active item', buildingAt: new Date(new Date(NOW).getTime() - 30 * 60 * 1000).toISOString() },
  ];

  const fold = baseFold({ recentMerged, active });
  const envelope = commandProjectionFromFold(fold, { ledgerSequence: 1, now: FIXED_NOW });
  const rows = envelope.data.recentIntents;

  assert.equal(rows.length, 5, 'the strip must cap at 5 rows even with 5 qualifying candidates');
  // Newest first: the active item (30 min ago) precedes all four merged items (1h..4h ago).
  assert.equal(rows[0]!.id, 'WI-920');
  assert.equal(rows[1]!.id, 'WI-910');
  assert.equal(rows[2]!.id, 'WI-911');
  assert.equal(rows[3]!.id, 'WI-912');
  assert.equal(rows[4]!.id, 'WI-913');
});
