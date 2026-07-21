/**
 * fixtures.ts — small synthetic ledgers built via @loopkit/core's public event helpers
 * (makeEvent), used across the console's test suites. No hand-rolled event shapes: every
 * fixture event goes through the same envelope the real ledger would produce.
 */

import { makeEvent, LedgerEvent } from '@loopkit/core';

/** A handful of items spanning the states the board/needs-you views group on. */
export function sampleLedger(): LedgerEvent[] {
  const events: LedgerEvent[] = [
    // WI-001: queued
    makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'add health view' }, '2026-07-01T09:00:00.000Z'),
    makeEvent('reactor', 'WI-001', 'item.routed', { route: 'build', reply: 'queuing' }, '2026-07-01T09:01:00.000Z'),
    makeEvent('reactor', 'WI-001', 'item.queued', { spec: 'add health view' }, '2026-07-01T09:02:00.000Z'),

    // WI-002: building
    makeEvent('cli', 'WI-002', 'item.captured', { source: 'cli', text: 'fix flaky test' }, '2026-07-01T10:00:00.000Z'),
    makeEvent('reactor', 'WI-002', 'item.routed', { route: 'build', reply: 'queuing' }, '2026-07-01T10:01:00.000Z'),
    makeEvent('reactor', 'WI-002', 'item.queued', { spec: 'fix flaky test' }, '2026-07-01T10:02:00.000Z'),
    makeEvent('dispatch', 'WI-002', 'build.dispatched', { attempt: 1 }, '2026-07-01T10:03:00.000Z'),

    // WI-003: parked (decision)
    makeEvent('cli', 'WI-003', 'item.captured', { source: 'cli', text: 'rename the public API' }, '2026-07-01T11:00:00.000Z'),
    makeEvent('reactor', 'WI-003', 'item.routed', { route: 'build', reply: 'queuing' }, '2026-07-01T11:01:00.000Z'),
    makeEvent('reactor', 'WI-003', 'item.queued', { spec: 'rename the public API' }, '2026-07-01T11:02:00.000Z'),
    makeEvent('dispatch', 'WI-003', 'build.dispatched', { attempt: 1 }, '2026-07-01T11:03:00.000Z'),
    makeEvent('conductor', 'WI-003', 'item.parked', { reason: 'touches a public API boundary', parkKind: 'decision' }, '2026-07-01T11:10:00.000Z'),

    // WI-004: merged, awaiting acceptance
    makeEvent('cli', 'WI-004', 'item.captured', { source: 'cli', text: 'tidy up docs' }, '2026-07-01T12:00:00.000Z'),
    makeEvent('reactor', 'WI-004', 'item.routed', { route: 'build', reply: 'queuing' }, '2026-07-01T12:01:00.000Z'),
    makeEvent('reactor', 'WI-004', 'item.queued', { spec: 'tidy up docs' }, '2026-07-01T12:02:00.000Z'),
    makeEvent('dispatch', 'WI-004', 'build.dispatched', { attempt: 1 }, '2026-07-01T12:03:00.000Z'),
    makeEvent('dispatch', 'WI-004', 'gate.passed', { tests: 'green' }, '2026-07-01T12:20:00.000Z'),
    makeEvent('reactor', 'WI-004', 'item.merged', { commit: 'abc1234' }, '2026-07-01T12:21:00.000Z'),

    // WI-005: accepted (terminal)
    makeEvent('cli', 'WI-005', 'item.captured', { source: 'cli', text: 'small copy fix' }, '2026-06-30T09:00:00.000Z'),
    makeEvent('reactor', 'WI-005', 'item.routed', { route: 'build', reply: 'queuing' }, '2026-06-30T09:01:00.000Z'),
    makeEvent('reactor', 'WI-005', 'item.queued', { spec: 'small copy fix' }, '2026-06-30T09:02:00.000Z'),
    makeEvent('dispatch', 'WI-005', 'build.dispatched', { attempt: 1 }, '2026-06-30T09:03:00.000Z'),
    makeEvent('dispatch', 'WI-005', 'gate.passed', { tests: 'green' }, '2026-06-30T09:20:00.000Z'),
    makeEvent('reactor', 'WI-005', 'item.merged', { commit: 'def5678' }, '2026-06-30T09:21:00.000Z'),
    makeEvent('operator', 'WI-005', 'item.accepted', { by: 'operator' }, '2026-06-30T10:00:00.000Z'),
  ];
  return events;
}

/**
 * A ledger of merged items spanning acceptance tiers, with the merge evidence
 * (baseSha/headSha/changedFiles/gateCommand) the acceptance desk renders and classifies from.
 * WI-101 has no changed files (auto — question/feedback); WI-102 touches only ordinary product
 * code (optional); WI-103 touches a declared surfacePrefix (review, when the caller's tier
 * config names one); WI-104's judge verdict failed (must).
 */
export function tieredMergeLedger(): LedgerEvent[] {
  const events: LedgerEvent[] = [];
  const item = (id: string, text: string, ts: string) => {
    events.push(makeEvent('cli', id, 'item.captured', { source: 'cli', text }, ts));
    events.push(makeEvent('reactor', id, 'item.routed', { route: 'build', reply: 'queuing' }, ts));
    events.push(makeEvent('reactor', id, 'item.queued', { spec: text }, ts));
    events.push(makeEvent('dispatch', id, 'build.dispatched', { attempt: 1 }, ts));
    events.push(makeEvent('dispatch', id, 'gate.passed', { tests: 'green' }, ts));
  };

  item('WI-101', 'answer a question, no code', '2026-07-03T09:00:00.000Z');
  events.push(
    makeEvent('reactor', 'WI-101', 'item.merged', { commit: 'aaa1111' }, '2026-07-03T09:05:00.000Z'),
  );

  item('WI-102', 'tidy up an internal helper', '2026-07-03T10:00:00.000Z');
  events.push(
    makeEvent(
      'reactor',
      'WI-102',
      'item.merged',
      {
        commit: 'bbb2222',
        baseSha: '1111111111111111111111111111111111aaaa',
        headSha: '2222222222222222222222222222222222bbbb',
        changedFiles: ['packages/core/src/helpers.ts'],
        gateCommand: 'npm test --workspace=@loopkit/core',
      },
      '2026-07-03T10:05:00.000Z',
    ),
  );

  item('WI-103', 'ship a console screen change', '2026-07-03T11:00:00.000Z');
  events.push(
    makeEvent(
      'reactor',
      'WI-103',
      'item.merged',
      {
        commit: 'ccc3333',
        baseSha: '3333333333333333333333333333333333cccc',
        headSha: '4444444444444444444444444444444444dddd',
        changedFiles: ['packages/console/src/views.ts'],
        gateCommand: 'npm test --workspace=@loopkit/console',
      },
      '2026-07-03T11:05:00.000Z',
    ),
  );

  item('WI-104', 'a build the judge failed', '2026-07-03T12:00:00.000Z');
  events.push(
    makeEvent(
      'judge',
      'WI-104',
      'review.verdict',
      {
        verdict: 'fail',
        confidence: 0.9,
        specSatisfied: 'no',
        scopeCreep: 'none',
        testTheatre: 'none',
        reasons: ['spec not satisfied'],
        model: 'sonnet',
        judge: 'merge-review',
      },
      '2026-07-03T12:04:00.000Z',
    ),
  );
  events.push(
    makeEvent(
      'reactor',
      'WI-104',
      'item.merged',
      {
        commit: 'ddd4444',
        baseSha: '5555555555555555555555555555555555eeee',
        headSha: '6666666666666666666666666666666666ffff',
        changedFiles: ['packages/core/src/fold.ts'],
        gateCommand: 'npm test --workspace=@loopkit/core',
      },
      '2026-07-03T12:05:00.000Z',
    ),
  );

  return events;
}

/**
 * Two decision parks whose approve outcomes differ — and whose approve buttons must say so:
 * WI-010 parked AFTER a build that recorded its branch (approving merges that branch);
 * WI-011 parked BEFORE any build was dispatched (approving unparks + requeues for a build).
 */
export function decisionParkVariantsLedger(): LedgerEvent[] {
  return [
    // WI-010: parked with a built branch on record
    makeEvent('cli', 'WI-010', 'item.captured', { source: 'cli', text: 'swap the storage adapter' }, '2026-07-01T13:00:00.000Z'),
    makeEvent('reactor', 'WI-010', 'item.routed', { route: 'build', reply: 'queuing' }, '2026-07-01T13:01:00.000Z'),
    makeEvent('reactor', 'WI-010', 'item.queued', { spec: 'swap the storage adapter' }, '2026-07-01T13:02:00.000Z'),
    makeEvent('dispatch', 'WI-010', 'build.dispatched', { attempt: 1, branch: 'work/WI-010', worktree: '/tmp/wt-WI-010' }, '2026-07-01T13:03:00.000Z'),
    makeEvent('conductor', 'WI-010', 'item.parked', { reason: 'schema boundary — needs an operator call', parkKind: 'decision' }, '2026-07-01T13:10:00.000Z'),

    // WI-011: parked before any build was dispatched
    makeEvent('cli', 'WI-011', 'item.captured', { source: 'cli', text: 'delete the legacy exporter' }, '2026-07-01T14:00:00.000Z'),
    makeEvent('reactor', 'WI-011', 'item.routed', { route: 'build', reply: 'queuing' }, '2026-07-01T14:01:00.000Z'),
    makeEvent('reactor', 'WI-011', 'item.queued', { spec: 'delete the legacy exporter' }, '2026-07-01T14:02:00.000Z'),
    makeEvent('reactor', 'WI-011', 'item.parked', { reason: 'irreversible delete — confirm first', parkKind: 'decision' }, '2026-07-01T14:03:00.000Z'),
  ];
}

/**
 * A now-relative ledger that drives the Command page's Glance footnotes into the states whose
 * canonical copy has drifted before (WI-053 shell-adoption guard). The fold's time windows
 * (24h flow, 7d reliability, recent-merged for acceptance) are measured against render-time
 * `now`, so these events are timestamped minutes ago rather than on a fixed calendar date:
 *
 *   - WI-201: merged ~20 min ago with a FAILED judge verdict → acceptance tier `must` →
 *     it lands in `awaitingAcceptance` ("To test" tile → "shipped, awaiting your verdict")
 *     and, as the sole first-attempt merge in the reliability window, drives
 *     "1/1 merged first try". No decision park and nothing stale ⇒ "all clear" / "none stuck".
 */
export function recentGlanceLedger(): LedgerEvent[] {
  const now = Date.now();
  const ago = (mins: number) => new Date(now - mins * 60_000).toISOString();
  return [
    makeEvent('cli', 'WI-201', 'item.captured', { source: 'cli', text: 'ship a slice' }, ago(60)),
    makeEvent('reactor', 'WI-201', 'item.routed', { route: 'build', reply: 'queuing' }, ago(59)),
    makeEvent('reactor', 'WI-201', 'item.queued', { spec: 'ship a slice' }, ago(58)),
    makeEvent('dispatch', 'WI-201', 'build.dispatched', { attempt: 1 }, ago(40)),
    makeEvent(
      'judge',
      'WI-201',
      'review.verdict',
      {
        verdict: 'fail',
        confidence: 0.9,
        specSatisfied: 'no',
        scopeCreep: 'none',
        testTheatre: 'none',
        reasons: ['spec not satisfied'],
        model: 'sonnet',
        judge: 'merge-review',
      },
      ago(22),
    ),
    makeEvent(
      'reactor',
      'WI-201',
      'item.merged',
      {
        commit: 'aaa1111',
        baseSha: '1'.repeat(38),
        headSha: '2'.repeat(38),
        changedFiles: ['packages/core/src/fold.ts'],
        gateCommand: 'npm test --workspace=@loopkit/core',
      },
      ago(20),
    ),
  ];
}

/** A single hostile-input item exercising HTML injection through every free-text field. */
export function hostileLedger(): LedgerEvent[] {
  const payload = '<script>alert(1)</script>&"\'';
  return [
    makeEvent('cli', 'WI-900', 'item.captured', { source: 'cli', text: payload }, '2026-07-02T09:00:00.000Z'),
    makeEvent('reactor', 'WI-900', 'item.routed', { route: 'build', reply: payload }, '2026-07-02T09:01:00.000Z'),
    makeEvent('reactor', 'WI-900', 'item.queued', { spec: payload }, '2026-07-02T09:02:00.000Z'),
    makeEvent('conductor', 'WI-900', 'item.parked', { reason: payload, parkKind: 'decision' }, '2026-07-02T09:10:00.000Z'),
  ];
}
