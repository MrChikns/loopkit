/**
 * run-controls.test.ts — the console's Missions per-state run-control verb set (console parity
 * gap 2/13): stop / hold / resume / requeue / escalate / dismiss. Mirrors verbs.test.ts's
 * temp-ledger setup style; fold predicate coverage (isHeldPark/isOpsPark) sits alongside the
 * verb behavior it backs since both landed together.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { fold, isHeldPark, isOpsPark } from '../src/fold.js';
import { makeEvent, LedgerEvent } from '../src/schema.js';
import { appendEvents, loadAllEvents } from '../src/ledger.js';
import { stopBuild, holdItem, unparkItem, escalateItem, dismissItem, VerbError } from '../src/verbs.js';

function withTempLedger<T>(fn: (ledgerDir: string) => Promise<T>): Promise<T> {
  const base = mkdtempSync(join(tmpdir(), 'loopkit-run-controls-'));
  const ledgerDir = join(base, 'ledger');
  return (async () => {
    try {
      return await fn(ledgerDir);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  })();
}

// ---------------------------------------------------------------------------
// stopBuild — building → build.cancel-requested
// ---------------------------------------------------------------------------

test('stopBuild: a building item gets a build.cancel-requested for its current attempt', () =>
  withTempLedger(async (ledgerDir) => {
    await appendEvents(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'add a widget' }),
      makeEvent('conductor', 'WI-001', 'item.queued', { spec: 'spec' }),
      makeEvent('dispatch', 'WI-001', 'build.dispatched', { attempt: 1, worktree: '/wt/a' }),
    ]);
    const res = await stopBuild(ledgerDir, 'WI-001');
    assert.equal(res.wiId, 'WI-001');

    const events = await loadAllEvents(ledgerDir);
    const cancelEv = events.find((e) => e.item === 'WI-001' && e.type === 'build.cancel-requested');
    assert.ok(cancelEv, 'a build.cancel-requested must be appended');
    assert.deepEqual(cancelEv?.data, { attempt: 1, by: 'operator' });

    // Fold itself is a no-op on cancel-requested (see fold.ts) — the item stays building
    // until the dispatch beat actually kills the worker and records build.cancelled.
    const result = fold(events);
    assert.equal(result.items.get('WI-001')?.state, 'building');
  }));

test('stopBuild: a non-building item is rejected, nothing appended', () =>
  withTempLedger(async (ledgerDir) => {
    await appendEvents(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'add a widget' }),
      makeEvent('conductor', 'WI-001', 'item.queued', { spec: 'spec' }),
    ]);
    await assert.rejects(() => stopBuild(ledgerDir, 'WI-001'), VerbError);
    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.filter((e) => e.type === 'build.cancel-requested').length, 0);
  }));

// ---------------------------------------------------------------------------
// holdItem — queued → parked (parkKind 'hold')
// ---------------------------------------------------------------------------

test('holdItem: a queued item is parked with parkKind hold', () =>
  withTempLedger(async (ledgerDir) => {
    await appendEvents(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'add a widget' }),
      makeEvent('conductor', 'WI-001', 'item.queued', { spec: 'spec' }),
    ]);
    const res = await holdItem(ledgerDir, 'WI-001');
    assert.equal(res.wiId, 'WI-001');

    const events = await loadAllEvents(ledgerDir);
    const result = fold(events);
    const rec = result.items.get('WI-001');
    assert.equal(rec?.state, 'parked');
    assert.equal(rec?.parkKind, 'hold');
    assert.ok(isHeldPark(rec!));
    assert.ok(!isOpsPark(rec!));
  }));

test('holdItem: a non-queued item is rejected, nothing appended', () =>
  withTempLedger(async (ledgerDir) => {
    await appendEvents(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'add a widget' }),
    ]);
    await assert.rejects(() => holdItem(ledgerDir, 'WI-001'), VerbError);
    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.filter((e) => e.type === 'item.parked').length, 0);
  }));

// ---------------------------------------------------------------------------
// unparkItem — parked → queued, shared by the 'resume' (held) and 'requeue' (ops-parked) labels
// ---------------------------------------------------------------------------

test('unparkItem resume: a held item returns to queued via item.unparked', () =>
  withTempLedger(async (ledgerDir) => {
    await appendEvents(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'add a widget' }),
      makeEvent('conductor', 'WI-001', 'item.queued', { spec: 'spec' }),
      makeEvent('cli', 'WI-001', 'item.parked', { reason: 'held by operator', parkKind: 'hold' }),
    ]);
    const res = await unparkItem(ledgerDir, 'WI-001', 'resume');
    assert.equal(res.message, 'Resumed WI-001');

    const events = await loadAllEvents(ledgerDir);
    const result = fold(events);
    assert.equal(result.items.get('WI-001')?.state, 'queued');
  }));

test('unparkItem requeue: an ops-parked item returns to queued via item.unparked', () =>
  withTempLedger(async (ledgerDir) => {
    await appendEvents(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'add a widget' }),
      makeEvent('conductor', 'WI-001', 'item.queued', { spec: 'spec' }),
      makeEvent('dispatch', 'WI-001', 'item.parked', { reason: 'infra: no commit', parkKind: 'ops' }),
    ]);
    const before = fold(await loadAllEvents(ledgerDir)).items.get('WI-001')!;
    assert.ok(isOpsPark(before));

    const res = await unparkItem(ledgerDir, 'WI-001', 'requeue');
    assert.equal(res.message, 'Requeued WI-001');

    const events = await loadAllEvents(ledgerDir);
    assert.equal(fold(events).items.get('WI-001')?.state, 'queued');
  }));

test('unparkItem: a non-parked item is rejected, nothing appended', () =>
  withTempLedger(async (ledgerDir) => {
    await appendEvents(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'add a widget' }),
      makeEvent('conductor', 'WI-001', 'item.queued', { spec: 'spec' }),
    ]);
    await assert.rejects(() => unparkItem(ledgerDir, 'WI-001', 'resume'), VerbError);
    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.filter((e) => e.type === 'item.unparked').length, 0);
  }));

// ---------------------------------------------------------------------------
// escalateItem — building/queued → item.escalated, NEVER a state transition
// ---------------------------------------------------------------------------

test('escalateItem: a building item is flagged without leaving the building state', () =>
  withTempLedger(async (ledgerDir) => {
    await appendEvents(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'add a widget' }),
      makeEvent('conductor', 'WI-001', 'item.queued', { spec: 'spec' }),
      makeEvent('dispatch', 'WI-001', 'build.dispatched', { attempt: 1 }),
    ]);
    const res = await escalateItem(ledgerDir, 'WI-001', { reason: 'looks stuck' });
    assert.equal(res.wiId, 'WI-001');

    const events = await loadAllEvents(ledgerDir);
    const escEv = events.find((e) => e.type === 'item.escalated');
    assert.ok(escEv);
    assert.deepEqual(escEv?.data, { by: 'operator', reason: 'looks stuck' });

    const result = fold(events);
    const rec = result.items.get('WI-001');
    assert.equal(rec?.state, 'building', 'escalate must never move the item off its current state');
    assert.equal(rec?.escalatedBy, 'operator');
    assert.ok(rec?.escalatedAt);
  }));

test('escalateItem: a queued item can be escalated too', () =>
  withTempLedger(async (ledgerDir) => {
    await appendEvents(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'add a widget' }),
      makeEvent('conductor', 'WI-001', 'item.queued', { spec: 'spec' }),
    ]);
    await escalateItem(ledgerDir, 'WI-001');
    const result = fold(await loadAllEvents(ledgerDir));
    const rec = result.items.get('WI-001');
    assert.equal(rec?.state, 'queued');
    assert.ok(rec?.escalatedAt);
  }));

test('escalateItem: a merged item is rejected, nothing appended', () =>
  withTempLedger(async (ledgerDir) => {
    await appendEvents(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'add a widget' }),
      makeEvent('reactor', 'WI-001', 'item.merged', { commit: 'abc1234' }),
    ]);
    await assert.rejects(() => escalateItem(ledgerDir, 'WI-001'), VerbError);
    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.filter((e) => e.type === 'item.escalated').length, 0);
  }));

// ---------------------------------------------------------------------------
// dismissItem — ops-parked → item.rejected (reuses approveOrReject's reject path)
// ---------------------------------------------------------------------------

test('dismissItem: an ops-parked item is rejected (terminal), via the shared reject event', () =>
  withTempLedger(async (ledgerDir) => {
    await appendEvents(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'add a widget' }),
      makeEvent('conductor', 'WI-001', 'item.queued', { spec: 'spec' }),
      makeEvent('dispatch', 'WI-001', 'item.parked', { reason: 'infra: no commit', parkKind: 'ops' }),
    ]);
    const res = await dismissItem(ledgerDir, 'WI-001');
    assert.equal(res.label, 'Rejected');

    const events = await loadAllEvents(ledgerDir);
    const rejectEv = events.find((e) => e.type === 'item.rejected');
    assert.ok(rejectEv);
    assert.equal((rejectEv?.data as { by?: string }).by, 'operator');

    const result = fold(events);
    assert.equal(result.items.get('WI-001')?.state, 'rejected');
  }));

// ---------------------------------------------------------------------------
// isHeldPark / isOpsPark predicates
// ---------------------------------------------------------------------------

test('isHeldPark / isOpsPark: partition non-decision parks by kind', () => {
  const events: LedgerEvent[] = [
    makeEvent('cli', 'WI-101', 'item.captured', { source: 'cli', text: 'held' }),
    makeEvent('conductor', 'WI-101', 'item.queued', { spec: 'spec' }),
    makeEvent('cli', 'WI-101', 'item.parked', { reason: 'held by operator', parkKind: 'hold' }),
    makeEvent('cli', 'WI-102', 'item.captured', { source: 'cli', text: 'ops' }),
    makeEvent('conductor', 'WI-102', 'item.queued', { spec: 'spec' }),
    makeEvent('dispatch', 'WI-102', 'item.parked', { reason: 'infra: no commit', parkKind: 'ops' }),
    makeEvent('cli', 'WI-103', 'item.captured', { source: 'cli', text: 'decision' }),
    makeEvent('conductor', 'WI-103', 'item.queued', { spec: 'spec' }),
    makeEvent('conductor', 'WI-103', 'item.parked', { reason: 'spine review', parkKind: 'decision' }),
  ];
  const result = fold(events);
  const held = result.items.get('WI-101')!;
  const ops = result.items.get('WI-102')!;
  const decision = result.items.get('WI-103')!;

  assert.ok(isHeldPark(held));
  assert.ok(!isOpsPark(held));

  assert.ok(isOpsPark(ops));
  assert.ok(!isHeldPark(ops));

  assert.ok(!isHeldPark(decision));
  assert.ok(!isOpsPark(decision));
});
