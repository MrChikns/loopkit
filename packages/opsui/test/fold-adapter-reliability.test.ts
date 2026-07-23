// WI-089 — Reliability glance tile measures per-WI clean-landing from the WI-108 lifetime
// counters, not attempt count alone. These tests fixture the REAL `loopctl summary --json`
// shapes: lifetime counters are ABSENT (undefined) when zero — never present-as-0 — and
// merged-item `touches` (unused here, but shared type) is a comma-joined string, not an array.
// An always-present-counters or array-touches fixture would hide exactly the bugs this tile
// has had before (WI-020 touches misclassification, WI-108 absent-vs-zero).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandProjectionFromFold, type FoldMergedItem, type FoldSummary, type GlanceWindow } from '../src/projections/fold-adapter.ts';

const NOW = '2026-07-23T12:00:00.000Z';

function baseFold(overrides: Partial<FoldSummary> = {}): FoldSummary {
  return {
    counts: {},
    active: [],
    recentMerged: [],
    generatedAt: NOW,
    ...overrides,
  };
}

// WI-129: the headline now follows the Glance window picker (default 24h — DEFAULT_GLANCE_WINDOW)
// instead of a hardcoded 7d, so callers that care about the 7d/30d split must select it explicitly.
function reliabilityTile(fold: FoldSummary, window?: GlanceWindow) {
  const envelope = commandProjectionFromFold(fold, { ledgerSequence: 0, ...(window ? { window } : {}) });
  assert.equal(envelope.state, 'fresh');
  const tile = envelope.data.glance.find((m) => m.label === 'Reliability');
  assert.ok(tile, 'Reliability tile is present');
  return tile!;
}

test('Reliability: a merged item with every lifetime counter ABSENT counts as clean (absent === 0, never fabricated)', () => {
  const clean: FoldMergedItem = { id: 'WI-700', mergedAt: NOW, attempts: 1 };
  const fold = baseFold({ recentMerged: [clean], recentMerged30d: [clean] });
  const tile = reliabilityTile(fold, '7d');
  assert.equal(tile.value, '100%');
  assert.match(tile.footnote, /1\/1 clean landing \(7d\)/);
  assert.match(tile.footnote, /1\/1 clean \(30d\)/);
});

test('Reliability: ANY non-zero lifetime counter marks the WI dirty, even if it merged first-attempt', () => {
  // attempts===1 (would read "first try" under the OLD attempt-only metric) but it parked
  // once on the way — WI-089's whole point is to stop calling this a clean landing.
  const roughButFirstTry: FoldMergedItem = {
    id: 'WI-701', mergedAt: NOW, attempts: 1, lifetimeParkCount: 1,
  };
  const fold = baseFold({ recentMerged: [roughButFirstTry], recentMerged30d: [roughButFirstTry] });
  const tile = reliabilityTile(fold, '7d');
  assert.equal(tile.value, '0%');
  assert.match(tile.footnote, /0\/1 clean landing \(7d\)/);
});

test('Reliability: each of the four lifetime counters independently dirties a WI', () => {
  const items: FoldMergedItem[] = [
    { id: 'WI-710', mergedAt: NOW, lifetimeParkCount: 2 },
    { id: 'WI-711', mergedAt: NOW, lifetimeCrashCount: 1 },
    { id: 'WI-712', mergedAt: NOW, lifetimeGateRedCount: 1 },
    { id: 'WI-713', mergedAt: NOW, lifetimeEscalationCount: 1 },
    { id: 'WI-714', mergedAt: NOW }, // the one clean WI in the batch
  ];
  const fold = baseFold({ recentMerged: items, recentMerged30d: items });
  const tile = reliabilityTile(fold, '7d');
  assert.equal(tile.value, '20%'); // 1/5 clean
  assert.match(tile.footnote, /1\/5 clean landing \(7d\)/);
});

test('Reliability: 7d and 30d windows are read from their own pre-trimmed fold arrays, independently', () => {
  const clean: FoldMergedItem = { id: 'WI-720', mergedAt: NOW };
  const dirty: FoldMergedItem = { id: 'WI-721', mergedAt: NOW, lifetimeCrashCount: 3 };
  // 7d only sees the clean one; 30d (the superset) also carries an older dirty merge.
  const fold = baseFold({ recentMerged: [clean], recentMerged30d: [clean, dirty] });
  const tile = reliabilityTile(fold, '7d');
  assert.match(tile.footnote, /1\/1 clean landing \(7d\)/);
  assert.match(tile.footnote, /1\/2 clean \(30d\)/);
});

test('Reliability: absent recentMerged30d falls back to the 7d array (older CLI), never fabricates an empty 30d window', () => {
  const clean: FoldMergedItem = { id: 'WI-730', mergedAt: NOW };
  const fold = baseFold({ recentMerged: [clean] }); // no recentMerged30d key at all
  const tile = reliabilityTile(fold);
  assert.match(tile.footnote, /1\/1 clean \(30d\)/);
});

test('Reliability: the footnote carries the 90% target marker and the relabeled attempt-level secondary', () => {
  const clean: FoldMergedItem = { id: 'WI-740', mergedAt: NOW, attempts: 1 };
  const fold = baseFold({ recentMerged: [clean], recentMerged30d: [clean] });
  const tile = reliabilityTile(fold);
  assert.match(tile.footnote, /target 90%/);
  // The old "merged first try" attempt-level stat survives but is explicitly relabeled so it's
  // never mistaken for the new clean-landing headline.
  assert.match(tile.footnote, /this try: 1\/1/);
});

test('Reliability: state is success once the 7d clean-landing rate clears the 90% target, warning below it', () => {
  const clean: FoldMergedItem = { id: 'WI-750', mergedAt: NOW };
  const cleanFold = baseFold({ recentMerged: [clean], recentMerged30d: [clean] });
  assert.equal(reliabilityTile(cleanFold).state, 'success');

  const dirty: FoldMergedItem = { id: 'WI-751', mergedAt: NOW, lifetimeParkCount: 1 };
  const dirtyFold = baseFold({ recentMerged: [dirty], recentMerged30d: [dirty] });
  assert.equal(reliabilityTile(dirtyFold).state, 'warning');
});

test('Reliability: no merges anywhere reads "–" / neutral, never a fabricated 0% or NaN%', () => {
  const fold = baseFold({ recentMerged: [], recentMerged30d: [] });
  const tile = reliabilityTile(fold, '7d');
  assert.equal(tile.value, '–');
  assert.equal(tile.state, 'neutral');
  assert.match(tile.footnote, /no merges yet \(7d\)/);
  assert.match(tile.footnote, /target 90%/);
});

test('Reliability: one-tap link follows the existing Missions/Flow drill convention (/work), not a bespoke route', () => {
  const clean: FoldMergedItem = { id: 'WI-760', mergedAt: NOW };
  const fold = baseFold({ recentMerged: [clean], recentMerged30d: [clean] });
  const tile = reliabilityTile(fold);
  assert.equal(tile.href, '/work');
  assert.deepEqual(tile.open, { kind: 'projection', id: 'work' });
});

// WI-129 — the headline (and its denominator) used to hardcode fold.recentMerged (a fixed 7d
// slice) regardless of opts.window, so the Glance window picker moved every other tile except
// this one's headline. It must now read the SAME window-filtered set as the picker, same as Flow.
test('Reliability: the headline follows the selected Glance window, not a hardcoded 7d (WI-129)', () => {
  const clean: FoldMergedItem = { id: 'WI-800', mergedAt: NOW };
  const dirty: FoldMergedItem = { id: 'WI-801', mergedAt: NOW, lifetimeCrashCount: 1 };
  // 7d (== recentMerged) sees both merges; 30d (the superset) adds nothing new here — the point
  // is that the HEADLINE's count/label move when the window arg changes, not the 30d reference.
  const fold = baseFold({ recentMerged: [clean, dirty], recentMerged30d: [clean, dirty] });

  const tile7d = reliabilityTile(fold, '7d');
  assert.equal(tile7d.value, '50%');
  assert.match(tile7d.footnote, /1\/2 clean landing \(7d\)/);

  const tile30d = reliabilityTile(fold, '30d');
  assert.equal(tile30d.value, '50%');
  assert.match(tile30d.footnote, /1\/2 clean landing \(30d\)/);
});

// No explicit window ⇒ falls back to DEFAULT_GLANCE_WINDOW ('24h'), the SAME default the picker
// chip highlights and every other Glance tile (Flow) already falls back to — a no-param headline
// must never disagree with the chip the founder sees lit up.
test('Reliability: an unset window defaults the headline to 24h, matching the picker default and every other tile', () => {
  const clean: FoldMergedItem = { id: 'WI-810', mergedAt: NOW };
  const fold = baseFold({ recentMerged: [clean], recentMerged30d: [clean] });
  const tile = reliabilityTile(fold);
  assert.match(tile.footnote, /1\/1 clean landing \(24h\)/);
});
