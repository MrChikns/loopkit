import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  commandProjectionFromFold,
  isStuckWorkItem,
  type FoldActiveItem,
  type FoldSummary,
} from '../src/projections/fold-adapter.ts';

const NOW = Date.parse('2026-07-28T12:00:00.000Z');
const HOURS = 60 * 60 * 1000;
const ago = (hours: number) => new Date(NOW - hours * HOURS).toISOString();

test('Command stuck transition matrix alarms only breaker ops parks and overdue builds', () => {
  const cases: Array<{ label: string; item: FoldActiveItem; expected: boolean }> = [
    { label: 'fresh ops recovery', item: { id: 'WI-1', state: 'parked', parkKind: 'ops', parkReason: 'gate red', parkedAt: ago(1) }, expected: false },
    { label: 'old ops recovery', item: { id: 'WI-2', state: 'parked', parkKind: 'ops', parkReason: 'gate red', parkedAt: ago(30) }, expected: false },
    { label: 'breaker ops park', item: { id: 'WI-3', state: 'parked', parkKind: 'ops', parkReason: 'breaker: attempts exhausted', parkedAt: ago(1) }, expected: true },
    { label: 'legacy breaker park', item: { id: 'WI-4', state: 'parked', parkReason: 'breaker: attempts exhausted', parkedAt: ago(1) }, expected: true },
    { label: 'old deliberate hold', item: { id: 'WI-5', state: 'parked', parkKind: 'hold', parkReason: 'hold: later', parkedAt: ago(30) }, expected: false },
    { label: 'old legacy hold', item: { id: 'WI-6', state: 'parked', parkReason: 'hold: later', parkedAt: ago(30) }, expected: false },
    { label: 'old operator decision', item: { id: 'WI-7', state: 'parked', parkKind: 'decision', parkedAt: ago(30) }, expected: false },
    { label: 'old planning park', item: { id: 'WI-8', state: 'parked', parkKind: 'decomposition', parkedAt: ago(30) }, expected: false },
    { label: 'old queue wait', item: { id: 'WI-9', state: 'queued', queuedAt: ago(30) }, expected: false },
    { label: 'build below threshold', item: { id: 'WI-10', state: 'building', buildingAt: ago(6) }, expected: false },
    { label: 'overdue build', item: { id: 'WI-11', state: 'building', buildingAt: ago(7) }, expected: true },
    { label: 'build without trustworthy age', item: { id: 'WI-12', state: 'building' }, expected: false },
  ];

  for (const c of cases) {
    assert.equal(isStuckWorkItem(c.item, NOW), c.expected, c.label);
  }
});

test('Command Stuck metric uses the canonical transition predicate and keeps hold neutral', () => {
  const active: FoldActiveItem[] = [
    { id: 'WI-20', state: 'parked', parkKind: 'hold', parkReason: 'hold: later', parkedAt: ago(30) },
    { id: 'WI-21', state: 'parked', parkKind: 'decision', parkedAt: ago(30) },
    { id: 'WI-22', state: 'parked', parkKind: 'decomposition', parkedAt: ago(30) },
    { id: 'WI-23', state: 'parked', parkKind: 'ops', parkReason: 'breaker: attempts exhausted', parkedAt: ago(2) },
    { id: 'WI-24', state: 'building', buildingAt: ago(7) },
  ];
  const fold: FoldSummary = {
    counts: {},
    active,
    recentMerged: [],
    generatedAt: new Date(NOW).toISOString(),
  };

  const metrics = commandProjectionFromFold(fold, { ledgerSequence: 1 }).data.glance;
  const stuck = metrics.find((metric) => metric.label === 'Stuck');
  const hold = metrics.find((metric) => metric.label === 'On hold');

  assert.equal(stuck?.value, 2, 'only the breaker park and overdue build are stuck');
  assert.equal(stuck?.footnote, '1 breaker-tripped · 1 build overdue 6h+ (oldest 7h)');
  assert.equal(hold?.value, 1);
  assert.equal(hold?.state, 'neutral');
});
