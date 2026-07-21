/**
 * pathology-fold.test.ts — WI-084 the park pathologist: fold back-compat + new-field tests.
 *
 * Covers:
 *   - a legacy event stream (no diagnosis.recorded/item.blocked) folds to an ItemRecord with
 *     blockedOn/lastDiagnosedFingerprint/ownCodeFailures all undefined — folding is
 *     byte-identical to before (no new required fields, unknown events still no-op).
 *   - item.blocked folds blockedOn (additive, non-transition, like item.escalated).
 *   - item.queued clears blockedOn (the release signal).
 *   - diagnosis.recorded sets lastDiagnosedFingerprint + bumps ownCodeFailures on
 *     classification 'items-own-code' (and does NOT bump it for other classifications).
 *   - a terminal item (merged) never diagnoses / never folds item.blocked into a live block.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fold } from '../src/fold.js';
import { makeEvent, LedgerEvent } from '../src/schema.js';

test('fold back-compat: a legacy event stream (no WI-084 events) leaves the new fields undefined', () => {
  const events: LedgerEvent[] = [
    makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'legacy item' }, '2026-01-01T00:00:00Z'),
    makeEvent('cli', 'WI-001', 'item.queued', { spec: 'legacy item' }, '2026-01-01T00:00:01Z'),
    makeEvent('dispatch', 'WI-001', 'build.dispatched', { attempt: 1, branch: 'wi-001', pid: 1 }, '2026-01-01T00:00:02Z'),
    makeEvent('dispatch', 'WI-001', 'build.finished', { commit: 'abc' }, '2026-01-01T00:00:03Z'),
    makeEvent('operator', 'WI-001', 'item.approved', { by: 'operator' }, '2026-01-01T00:00:04Z'),
    makeEvent('reactor', 'WI-001', 'item.merged', { commit: 'abc' }, '2026-01-01T00:00:05Z'),
  ];
  const result = fold(events);
  const rec = result.items.get('WI-001');
  assert.ok(rec);
  assert.equal(rec!.blockedOn, undefined);
  assert.equal(rec!.lastDiagnosedFingerprint, undefined);
  assert.equal(rec!.ownCodeFailures, undefined);
  assert.equal(rec!.state, 'merged');
});

test('fold: item.blocked sets blockedOn additively, without changing state', () => {
  const events: LedgerEvent[] = [
    makeEvent('cli', 'WI-002', 'item.captured', { source: 'cli', text: 'x' }, '2026-01-01T00:00:00Z'),
    makeEvent('cli', 'WI-002', 'item.queued', { spec: 'x' }, '2026-01-01T00:00:01Z'),
    makeEvent('dispatch', 'WI-002', 'build.dispatched', { attempt: 1, branch: 'wi-002', pid: 1 }, '2026-01-01T00:00:02Z'),
    makeEvent('dispatch', 'WI-002', 'item.parked', { reason: 'gate red', parkKind: 'ops' }, '2026-01-01T00:00:03Z'),
    makeEvent('reactor', 'WI-002', 'item.blocked', { onItem: 'WI-003', reason: 'plane-infra-bug (pathology)' }, '2026-01-01T00:00:04Z'),
  ];
  const result = fold(events);
  const rec = result.items.get('WI-002');
  assert.equal(rec!.state, 'parked', 'item.blocked must never transition state');
  assert.equal(rec!.blockedOn, 'WI-003');
});

test('fold: item.queued clears blockedOn (the release signal)', () => {
  const events: LedgerEvent[] = [
    makeEvent('cli', 'WI-004', 'item.captured', { source: 'cli', text: 'x' }, '2026-01-01T00:00:00Z'),
    makeEvent('cli', 'WI-004', 'item.queued', { spec: 'x' }, '2026-01-01T00:00:01Z'),
    makeEvent('dispatch', 'WI-004', 'build.dispatched', { attempt: 1, branch: 'wi-004', pid: 1 }, '2026-01-01T00:00:02Z'),
    makeEvent('dispatch', 'WI-004', 'item.parked', { reason: 'gate red', parkKind: 'ops' }, '2026-01-01T00:00:03Z'),
    makeEvent('reactor', 'WI-004', 'item.blocked', { onItem: 'WI-005' }, '2026-01-01T00:00:04Z'),
    makeEvent('reactor', 'WI-004', 'item.queued', { spec: 'x', repairContext: 'blocker WI-005 merged — auto-requeued (pathology)' }, '2026-01-01T00:00:05Z'),
  ];
  const result = fold(events);
  const rec = result.items.get('WI-004');
  assert.equal(rec!.state, 'queued');
  assert.equal(rec!.blockedOn, undefined, 'blockedOn must clear on the requeue');
});

test('fold: clearParkFields (unpark/approve/merge/accept/reject) also clears blockedOn', () => {
  const events: LedgerEvent[] = [
    makeEvent('cli', 'WI-006', 'item.captured', { source: 'cli', text: 'x' }, '2026-01-01T00:00:00Z'),
    makeEvent('cli', 'WI-006', 'item.queued', { spec: 'x' }, '2026-01-01T00:00:01Z'),
    makeEvent('dispatch', 'WI-006', 'build.dispatched', { attempt: 1, branch: 'wi-006', pid: 1 }, '2026-01-01T00:00:02Z'),
    makeEvent('dispatch', 'WI-006', 'item.parked', { reason: 'gate red', parkKind: 'ops' }, '2026-01-01T00:00:03Z'),
    makeEvent('reactor', 'WI-006', 'item.blocked', { onItem: 'WI-007' }, '2026-01-01T00:00:04Z'),
    makeEvent('operator', 'WI-006', 'item.unparked', { by: 'operator' }, '2026-01-01T00:00:05Z'),
  ];
  const result = fold(events);
  const rec = result.items.get('WI-006');
  assert.equal(rec!.state, 'queued');
  assert.equal(rec!.blockedOn, undefined, 'an explicit unpark must also release a pathologist block');
});

test('fold: diagnosis.recorded sets lastDiagnosedFingerprint, never transitions state', () => {
  const events: LedgerEvent[] = [
    makeEvent('cli', 'WI-008', 'item.captured', { source: 'cli', text: 'x' }, '2026-01-01T00:00:00Z'),
    makeEvent('cli', 'WI-008', 'item.queued', { spec: 'x' }, '2026-01-01T00:00:01Z'),
    makeEvent('dispatch', 'WI-008', 'build.dispatched', { attempt: 1, branch: 'wi-008', pid: 1 }, '2026-01-01T00:00:02Z'),
    makeEvent('dispatch', 'WI-008', 'item.parked', { reason: 'gate red', parkKind: 'ops' }, '2026-01-01T00:00:03Z'),
  ];
  const preFold = fold(events);
  const fp = preFold.items.get('WI-008')!.parkFingerprint!;
  assert.ok(fp);

  events.push(makeEvent('reactor', 'WI-008', 'diagnosis.recorded', {
    parkFingerprint: fp,
    classification: 'transient-infra',
    evidence: ['a blip'],
    proposedAction: 'retry',
    actedAs: 'requeued-transient',
    model: 'opus',
  }, '2026-01-01T00:00:04Z'));

  const result = fold(events);
  const rec = result.items.get('WI-008');
  assert.equal(rec!.state, 'parked', 'diagnosis.recorded must never transition state by itself');
  assert.equal(rec!.lastDiagnosedFingerprint, fp);
  assert.equal(rec!.ownCodeFailures, undefined, 'transient-infra must NOT bump ownCodeFailures');
});

test('fold: diagnosis.recorded bumps ownCodeFailures ONLY for items-own-code classification', () => {
  const base: LedgerEvent[] = [
    makeEvent('cli', 'WI-009', 'item.captured', { source: 'cli', text: 'x' }, '2026-01-01T00:00:00Z'),
    makeEvent('cli', 'WI-009', 'item.queued', { spec: 'x' }, '2026-01-01T00:00:01Z'),
    makeEvent('dispatch', 'WI-009', 'build.dispatched', { attempt: 1, branch: 'wi-009', pid: 1 }, '2026-01-01T00:00:02Z'),
    makeEvent('dispatch', 'WI-009', 'item.parked', { reason: 'gate red', parkKind: 'ops' }, '2026-01-01T00:00:03Z'),
  ];
  const fp = fold(base).items.get('WI-009')!.parkFingerprint!;

  const eventsOwnCode = [...base, makeEvent('reactor', 'WI-009', 'diagnosis.recorded', {
    parkFingerprint: fp, classification: 'items-own-code', evidence: [], proposedAction: '', actedAs: 'requeued-own-code', model: 'opus',
  }, '2026-01-01T00:00:04Z')];
  assert.equal(fold(eventsOwnCode).items.get('WI-009')?.ownCodeFailures, 1);

  const eventsPlaneBug = [...base, makeEvent('reactor', 'WI-009', 'diagnosis.recorded', {
    parkFingerprint: fp, classification: 'plane-infra-bug', evidence: [], proposedAction: '', actedAs: 'blocked-on-repair', model: 'opus',
  }, '2026-01-01T00:00:04Z')];
  assert.equal(fold(eventsPlaneBug).items.get('WI-009')?.ownCodeFailures, undefined);
});

test('fold: two diagnosis.recorded items-own-code events bump the counter monotonically (never reset)', () => {
  const base: LedgerEvent[] = [
    makeEvent('cli', 'WI-010', 'item.captured', { source: 'cli', text: 'x' }, '2026-01-01T00:00:00Z'),
    makeEvent('cli', 'WI-010', 'item.queued', { spec: 'x' }, '2026-01-01T00:00:01Z'),
    makeEvent('dispatch', 'WI-010', 'build.dispatched', { attempt: 1, branch: 'wi-010', pid: 1 }, '2026-01-01T00:00:02Z'),
    makeEvent('dispatch', 'WI-010', 'item.parked', { reason: 'gate red 1', parkKind: 'ops' }, '2026-01-01T00:00:03Z'),
    makeEvent('reactor', 'WI-010', 'diagnosis.recorded', {
      parkFingerprint: 'fp1', classification: 'items-own-code', evidence: [], proposedAction: '', actedAs: 'requeued-own-code', model: 'opus',
    }, '2026-01-01T00:00:04Z'),
    makeEvent('reactor', 'WI-010', 'item.queued', { spec: 'x' }, '2026-01-01T00:00:05Z'),
    makeEvent('dispatch', 'WI-010', 'build.dispatched', { attempt: 2, branch: 'wi-010-b', pid: 2 }, '2026-01-01T00:00:06Z'),
    makeEvent('dispatch', 'WI-010', 'item.parked', { reason: 'gate red 2', parkKind: 'ops' }, '2026-01-01T00:00:07Z'),
    makeEvent('reactor', 'WI-010', 'diagnosis.recorded', {
      parkFingerprint: 'fp2', classification: 'items-own-code', evidence: [], proposedAction: '', actedAs: 'parked-review', model: 'opus',
    }, '2026-01-01T00:00:08Z'),
  ];
  assert.equal(fold(base).items.get('WI-010')?.ownCodeFailures, 2);
});

test('fold: a terminal item (merged) no-ops a late item.blocked / diagnosis.recorded', () => {
  const events: LedgerEvent[] = [
    makeEvent('cli', 'WI-011', 'item.captured', { source: 'cli', text: 'x' }, '2026-01-01T00:00:00Z'),
    makeEvent('cli', 'WI-011', 'item.queued', { spec: 'x' }, '2026-01-01T00:00:01Z'),
    makeEvent('dispatch', 'WI-011', 'build.dispatched', { attempt: 1, branch: 'wi-011', pid: 1 }, '2026-01-01T00:00:02Z'),
    makeEvent('dispatch', 'WI-011', 'build.finished', { commit: 'abc' }, '2026-01-01T00:00:03Z'),
    makeEvent('operator', 'WI-011', 'item.approved', { by: 'operator' }, '2026-01-01T00:00:04Z'),
    makeEvent('reactor', 'WI-011', 'item.merged', { commit: 'abc' }, '2026-01-01T00:00:05Z'),
    // Stray late events after merge — must be no-ops (terminal-state guard).
    makeEvent('reactor', 'WI-011', 'item.blocked', { onItem: 'WI-012' }, '2026-01-01T00:00:06Z'),
    makeEvent('reactor', 'WI-011', 'diagnosis.recorded', {
      parkFingerprint: 'fp-x', classification: 'items-own-code', evidence: [], proposedAction: '', actedAs: 'skipped', model: 'opus',
    }, '2026-01-01T00:00:07Z'),
  ];
  const rec = fold(events).items.get('WI-011');
  assert.equal(rec!.state, 'merged', 'terminal state must not regress');
  assert.equal(rec!.blockedOn, undefined, 'a stray item.blocked after merge must no-op');
  assert.equal(rec!.ownCodeFailures, undefined, 'a stray diagnosis.recorded after merge must no-op');
});

test('isKnownType recognizes the new WI-084 event types', async () => {
  const { isKnownType } = await import('../src/schema.js');
  assert.ok(isKnownType('diagnosis.recorded'));
  assert.ok(isKnownType('item.blocked'));
});
