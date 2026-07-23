// WI-102 — Missions board (/work) operator-attention ordering. workProjectionFromFold's primary
// sort must surface the rows that actually need the operator first: decision parks lead, then
// in-flight work, then blocked, then queued/routed/captured, with plane-owned parks (ops/hold/
// decomposition — the plane resolves these itself, never an operator decision) sinking to the
// bottom. Priority (blocker > high > medium > low > unset) is the secondary key within every
// group; relative order otherwise holds (stable sort).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { workProjectionFromFold } from '../src/projections/work-adapter.ts';
import type { FoldSummary, FoldActiveItem } from '../src/projections/fold-adapter.ts';

function fold(active: FoldActiveItem[]): FoldSummary {
  return {
    counts: {},
    active,
    recentMerged: [],
    generatedAt: new Date().toISOString(),
  };
}

function ids(env: ReturnType<typeof workProjectionFromFold>): string[] {
  return env.data.active.map((i) => i.id);
}

test('decision parks sort above in-flight, blocked, queued, and plane-owned parks', () => {
  const active: FoldActiveItem[] = [
    { id: 'WI-1', state: 'parked', parkKind: 'ops', spec: 'plane-owned park' },
    { id: 'WI-2', state: 'queued', spec: 'queued item' },
    { id: 'WI-3', state: 'blocked', spec: 'blocked item' },
    { id: 'WI-4', state: 'building', spec: 'in-flight item' },
    { id: 'WI-5', state: 'parked', parkKind: 'decision', spec: 'needs the founder' },
  ];
  const env = workProjectionFromFold(fold(active), { ledgerSequence: 1 });
  assert.deepEqual(ids(env), ['WI-5', 'WI-4', 'WI-3', 'WI-2', 'WI-1'],
    'order must be: decision park, in-flight, blocked, queued, plane-owned park');
});

test('in-flight states (building/testing/gated) sort ahead of approved, ahead of blocked', () => {
  const active: FoldActiveItem[] = [
    { id: 'WI-10', state: 'approved', spec: 'approved' },
    { id: 'WI-11', state: 'blocked', spec: 'blocked' },
    { id: 'WI-12', state: 'gated', spec: 'gated' },
    { id: 'WI-13', state: 'testing', spec: 'testing' },
    { id: 'WI-14', state: 'building', spec: 'building' },
  ];
  const env = workProjectionFromFold(fold(active), { ledgerSequence: 1 });
  // building/testing/gated share a tier (stable order preserved among them); approved is its
  // own tier right after; blocked comes after all in-flight work.
  assert.deepEqual(ids(env), ['WI-12', 'WI-13', 'WI-14', 'WI-10', 'WI-11']);
});

test('queued/routed/captured share a tier below blocked, above plane-owned parks', () => {
  const active: FoldActiveItem[] = [
    { id: 'WI-20', state: 'parked', parkKind: 'hold', spec: 'plane park' },
    { id: 'WI-21', state: 'captured', spec: 'captured' },
    { id: 'WI-22', state: 'routed', spec: 'routed' },
    { id: 'WI-23', state: 'queued', spec: 'queued' },
    { id: 'WI-24', state: 'blocked', spec: 'blocked' },
  ];
  const env = workProjectionFromFold(fold(active), { ledgerSequence: 1 });
  assert.deepEqual(ids(env), ['WI-24', 'WI-21', 'WI-22', 'WI-23', 'WI-20']);
});

test('plane-owned parks: ops/hold sort ahead of decomposition; unknown parkKind lands with ops/hold', () => {
  const active: FoldActiveItem[] = [
    { id: 'WI-30', state: 'parked', parkKind: 'decomposition', spec: 'decomposition park' },
    { id: 'WI-31', state: 'parked', parkKind: 'ops', spec: 'ops park' },
    { id: 'WI-32', state: 'parked', spec: 'unknown parkKind (no parkKind set)' },
    { id: 'WI-33', state: 'parked', parkKind: 'hold', spec: 'hold park' },
  ];
  const env = workProjectionFromFold(fold(active), { ledgerSequence: 1 });
  const order = ids(env);
  // ops/hold/unknown-parkKind share the plane-owned tier; decomposition is strictly last.
  assert.equal(order.indexOf('WI-30'), 3, 'decomposition park must be last among the parked rows');
  assert.deepEqual(new Set(order.slice(0, 3)), new Set(['WI-31', 'WI-32', 'WI-33']));
});

test('priority breaks ties within a group: blocker > high > medium > low > unset', () => {
  const active: FoldActiveItem[] = [
    { id: 'WI-40', state: 'queued', priority: 'low', spec: 'low' },
    { id: 'WI-41', state: 'queued', spec: 'unset (no priority field)' },
    { id: 'WI-42', state: 'queued', priority: 'blocker', spec: 'blocker' },
    { id: 'WI-43', state: 'queued', priority: 'medium', spec: 'medium' },
    { id: 'WI-44', state: 'queued', priority: 'high', spec: 'high' },
  ];
  const env = workProjectionFromFold(fold(active), { ledgerSequence: 1 });
  assert.deepEqual(ids(env), ['WI-42', 'WI-44', 'WI-43', 'WI-40', 'WI-41']);
});

test('priority ordering applies within the decision-park group too, not just non-parked groups', () => {
  const active: FoldActiveItem[] = [
    { id: 'WI-50', state: 'parked', parkKind: 'decision', priority: 'low', spec: 'low-priority decision' },
    { id: 'WI-51', state: 'parked', parkKind: 'decision', priority: 'blocker', spec: 'blocker decision' },
    { id: 'WI-52', state: 'building', priority: 'blocker', spec: 'blocker in-flight — still below decision parks' },
  ];
  const env = workProjectionFromFold(fold(active), { ledgerSequence: 1 });
  assert.deepEqual(ids(env), ['WI-51', 'WI-50', 'WI-52'],
    'both decision parks (any priority) must sort above a blocker-priority in-flight item');
});

test('equal group and equal priority preserves the original relative order (stable sort)', () => {
  const active: FoldActiveItem[] = [
    { id: 'WI-60', state: 'queued', spec: 'first' },
    { id: 'WI-61', state: 'queued', spec: 'second' },
    { id: 'WI-62', state: 'queued', spec: 'third' },
  ];
  const env = workProjectionFromFold(fold(active), { ledgerSequence: 1 });
  assert.deepEqual(ids(env), ['WI-60', 'WI-61', 'WI-62']);
});
