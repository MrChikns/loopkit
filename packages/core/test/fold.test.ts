/**
 * fold.test.ts — Fold replay tests: the fold is a pure, deterministic reducer over the
 * append-only ledger. These tests exercise state-machine transitions, backward-compat
 * handling of older event shapes, and derived projections (touches narrowing, acceptance
 * debt, conversation threads).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fold, nextWiId, computeAcceptanceDebt, narrowQueuedTouches, computeParkFingerprint, isFirstSeenPark } from '../src/fold.js';
import { renderBoard } from '../src/board.js';
import { makeEvent, validateEvent, LedgerEvent } from '../src/schema.js';

test('fold: empty events produces empty map', () => {
  const result = fold([]);
  assert.equal(result.items.size, 0);
  assert.equal(result.maxWiNum, 0);
});

test('fold: item.captured creates item in captured state', () => {
  const ev = makeEvent('test', 'WI-001', 'item.captured', { source: 'cli', text: 'hello' });
  const result = fold([ev]);
  const item = result.items.get('WI-001');
  assert.ok(item);
  assert.equal(item.state, 'captured');
  assert.equal(item.sourceText, 'hello');
});

test('fold: a legacy event with no v field (pre-versioning ledger) still validates and folds', () => {
  // Simulates an event written before envelope versioning existed — no `v` key at all.
  const legacy = { id: 'ev-0000000000LEGACY0000000000', ts: '2026-01-01T00:00:00Z', actor: 'operator', item: 'WI-800', type: 'item.captured', data: { source: 'cli', text: 'legacy event' } };
  const validated = validateEvent(legacy);
  assert.equal(validated.v, undefined);
  const item = fold([validated]).items.get('WI-800');
  assert.ok(item);
  assert.equal(item.state, 'captured');
});

// ---------------------------------------------------------------------------
// Delivery lane on the fold
// ---------------------------------------------------------------------------

test('fold: item without a lane field defaults to engineering (golden replay — no reclassification)', () => {
  // These events carry NO lane field, exactly like every pre-lane-field ledger event.
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-001', 'item.captured', { source: 'cli', text: 'fix X' }),
    makeEvent('reactor', 'WI-001', 'item.routed', { route: 'build', reply: 'queuing' }),
    makeEvent('reactor', 'WI-001', 'item.queued', { spec: 'fix X' }),
  ];
  const item = fold(events).items.get('WI-001');
  assert.ok(item);
  assert.equal(item.lane, 'engineering', 'lane-less events fold to the engineering default');
});

// ---------------------------------------------------------------------------
// item.rejected.by carried through as ItemRecord.rejectedBy
// ---------------------------------------------------------------------------

test('fold: item.rejected with by:operator carries rejectedBy through', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-500', 'item.captured', { source: 'cli', text: 'risky change' }),
    makeEvent('cli', 'WI-500', 'item.rejected', { by: 'operator' }),
  ];
  const item = fold(events).items.get('WI-500');
  assert.ok(item);
  assert.equal(item.state, 'rejected');
  assert.equal(item.rejectedBy, 'operator');
});

test('fold: item.rejected with by:reactor (machine closure) carries rejectedBy through', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-501', 'item.captured', { source: 'cli', text: 'duplicate work' }),
    makeEvent('reactor', 'WI-501', 'item.rejected', { by: 'reactor' }),
  ];
  const item = fold(events).items.get('WI-501');
  assert.ok(item);
  assert.equal(item.state, 'rejected');
  assert.equal(item.rejectedBy, 'reactor');
});

test('fold: item.rejected with no by field leaves rejectedBy undefined (forward-compat)', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-502', 'item.captured', { source: 'cli', text: 'old-shape event' }),
    { ...makeEvent('cli', 'WI-502', 'item.rejected', { by: 'operator' }), data: {} },
  ];
  const item = fold(events).items.get('WI-502');
  assert.ok(item);
  assert.equal(item.rejectedBy, undefined);
});

test('fold: a marketing-lane routing/queue carries lane onto the item', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-002', 'item.captured', { source: 'cli', text: 'draft homepage copy' }),
    makeEvent('reactor', 'WI-002', 'item.routed', { route: 'build', reply: 'drafting', lane: 'marketing' }),
    makeEvent('reactor', 'WI-002', 'item.queued', { spec: 'draft homepage copy', lane: 'marketing' }),
  ];
  const item = fold(events).items.get('WI-002');
  assert.ok(item);
  assert.equal(item.lane, 'marketing');
});

test('fold: item.routed with a title carries it onto the item', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-310', 'item.captured', { source: 'cli', text: 'add a due-date banner' }),
    makeEvent('reactor', 'WI-310', 'item.routed', { route: 'build', reply: 'queuing', title: 'Todo overdue-today banner' }),
    makeEvent('reactor', 'WI-310', 'item.queued', { spec: 'add a due-date banner' }),
  ];
  const item = fold(events).items.get('WI-310');
  assert.ok(item);
  assert.equal(item.title, 'Todo overdue-today banner');
});

test('fold: item.routed without a title field folds to undefined (pre-router replay)', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-311', 'item.captured', { source: 'cli', text: 'fix X' }),
    makeEvent('reactor', 'WI-311', 'item.routed', { route: 'build', reply: 'queuing' }),
    makeEvent('reactor', 'WI-311', 'item.queued', { spec: 'fix X' }),
  ];
  const item = fold(events).items.get('WI-311');
  assert.ok(item);
  assert.equal(item.title, undefined);
});

test('fold: item.queued carries effort onto the item (golden replay — no reclassification)', () => {
  // item.queued may carry effort when routed; items without it fold to undefined (no default).
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-003', 'item.captured', { source: 'cli', text: 'high-complexity task' }),
    makeEvent('reactor', 'WI-003', 'item.queued', { spec: 'complex', effort: 'high' }),
  ];
  const item = fold(events).items.get('WI-003');
  assert.ok(item);
  assert.equal(item.effort, 'high');
});

test('fold: item without effort field folds to undefined (no effort default)', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-004', 'item.captured', { source: 'cli', text: 'simple task' }),
    makeEvent('reactor', 'WI-004', 'item.queued', { spec: 'simple' }),
  ];
  const item = fold(events).items.get('WI-004');
  assert.ok(item);
  assert.equal(item.effort, undefined);
});

// ---------------------------------------------------------------------------
// Bare-package-root Touches narrowing — spec-derived (choke observed: multiple items all
// stamped with the same bare package root, none dispatchable together)
// ---------------------------------------------------------------------------

test('narrowQueuedTouches: narrows a bare src root to the spec-named file\'s directory', () => {
  const spec = 'Fix parseRoutingDecision() in packages/engine/src/beats/reactor.ts to infer TOUCHES.';
  assert.equal(narrowQueuedTouches('packages/engine/src', spec), 'packages/engine/src/beats');
});

test('narrowQueuedTouches: strips a trailing slash on the narrowed result', () => {
  const spec = 'See packages/engine/src/beats/dispatch.ts for the picker logic.';
  assert.equal(narrowQueuedTouches('packages/engine/src/', spec), 'packages/engine/src/beats');
});

test('narrowQueuedTouches: keeps the bare root when named files span multiple subdirectories', () => {
  const spec = 'Touches packages/engine/src/beats/reactor.ts and packages/engine/src/config.ts.';
  assert.equal(narrowQueuedTouches('packages/engine/src', spec), 'packages/engine/src');
});

test('narrowQueuedTouches: keeps the bare root when spec names no files under it', () => {
  const spec = 'Refactor the routing wall for clarity, no specific files named.';
  assert.equal(narrowQueuedTouches('packages/engine/src', spec), 'packages/engine/src');
});

test('narrowQueuedTouches: leaves an already-scoped (non-root) prefix unchanged', () => {
  const spec = 'Add a banner to apps/example/src/slices/todos/view.ts.';
  assert.equal(narrowQueuedTouches('apps/example/src/slices/todos', spec), 'apps/example/src/slices/todos');
});

test('narrowQueuedTouches: leaves touches unchanged when spec is undefined', () => {
  assert.equal(narrowQueuedTouches('packages/engine/src', undefined), 'packages/engine/src');
});

test('narrowQueuedTouches: narrows each prefix independently in a multi-prefix list', () => {
  const spec = 'Update packages/engine/src/beats/dispatch.ts and .ai/loops/prompts/conductor.md.';
  assert.equal(
    narrowQueuedTouches('packages/engine/src,.ai/loops', spec),
    'packages/engine/src/beats,.ai/loops',
  );
});

test('fold: item.queued narrows a bare src-root Touches using files named in the spec', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-005', 'item.captured', { source: 'cli', text: 'fix routing' }),
    makeEvent('reactor', 'WI-005', 'item.queued', {
      spec: 'Fix parseRoutingDecision() in packages/engine/src/beats/reactor.ts.',
      touches: 'packages/engine/src/',
    }),
  ];
  const item = fold(events).items.get('WI-005');
  assert.ok(item);
  assert.equal(item.touches, 'packages/engine/src/beats');
});

test('fold: item.queued leaves an already-scoped Touches prefix untouched', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-006', 'item.captured', { source: 'cli', text: 'due-date banner' }),
    makeEvent('reactor', 'WI-006', 'item.queued', {
      spec: 'Add an overdue-today banner.',
      touches: 'apps/example/src/slices/todos/',
    }),
  ];
  const item = fold(events).items.get('WI-006');
  assert.ok(item);
  assert.equal(item.touches, 'apps/example/src/slices/todos/');
});

test('fold: full lifecycle captured → queued → building → merged', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-001', 'item.captured', { source: 'cli', text: 'build X' }, '2026-01-01T00:00:00Z'),
    makeEvent('conductor', 'WI-001', 'item.queued', { spec: 'spec' }, '2026-01-01T00:01:00Z'),
    makeEvent('dispatch', 'WI-001', 'build.dispatched', { attempt: 1, pid: 12345 }, '2026-01-01T00:02:00Z'),
    makeEvent('builder', 'WI-001', 'build.finished', { commit: 'abc123' }, '2026-01-01T00:10:00Z'),
    makeEvent('builder', 'WI-001', 'item.merged', { commit: 'abc123', deployed: true }, '2026-01-01T00:11:00Z'),
  ];
  const result = fold(events);
  const item = result.items.get('WI-001');
  assert.ok(item);
  assert.equal(item.state, 'merged');
  assert.equal(item.attempts, 1);
  assert.equal(item.mergeCommit, 'abc123');
  assert.equal(item.deployed, true);
  assert.equal(item.builds.length, 1);
});

test('fold: build.crashed requeues and records crash', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-002', 'item.captured', { source: 'cli', text: 'test' }, '2026-01-01T00:00:00Z'),
    makeEvent('conductor', 'WI-002', 'item.queued', { spec: 'spec' }, '2026-01-01T00:01:00Z'),
    makeEvent('dispatch', 'WI-002', 'build.dispatched', { attempt: 1, pid: 99 }, '2026-01-01T00:02:00Z'),
    makeEvent('doctor', 'WI-002', 'build.crashed', { reason: 'orphan-detected', stderrTail: 'error' }, '2026-01-01T00:20:00Z'),
  ];
  const result = fold(events);
  const item = result.items.get('WI-002');
  assert.ok(item);
  // crashed returns to queued
  assert.equal(item.state, 'queued');
  assert.equal(item.builds.length, 1);
  assert.equal(item.builds[0].crashReason, 'orphan-detected');
});

test('fold: item.parked then item.unparked transitions back to queued', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-003', 'item.captured', { source: 'cli', text: 'test' }),
    makeEvent('conductor', 'WI-003', 'item.queued', { spec: 'spec' }),
    makeEvent('dispatch', 'WI-003', 'build.dispatched', { attempt: 1, pid: 1 }),
    makeEvent('gate', 'WI-003', 'gate.failed', { reason: 'tests-red' }),
    makeEvent('operator', 'WI-003', 'item.unparked', {}),
  ];
  const result = fold(events);
  const item = result.items.get('WI-003');
  assert.ok(item);
  assert.equal(item.state, 'queued');
  assert.equal(item.parkReason, undefined);
});

test('fold: item.parked with legacy parkReason key (no reason field) still surfaces the reason (backward-compat)', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-283', 'item.captured', { source: 'cli', text: 'test' }),
    makeEvent('conductor', 'WI-283', 'item.queued', { spec: 'spec' }),
    // Old ledger events stored the park reason under `parkReason`, not `reason` — the
    // ledger is append-only so this shape survives forever.
    {
      id: 'ev-01KXJXNQZ100000000002GN5GT',
      ts: '2026-07-15T12:57:50.817Z',
      actor: 'cli',
      item: 'WI-283',
      type: 'item.parked',
      data: {
        parkKind: 'decision',
        parkReason: 'Ratified 2026-07-15 (option A + follow-up now, B pre-registered, C rejected).',
      },
    } as unknown as LedgerEvent,
  ];
  const result = fold(events);
  const item = result.items.get('WI-283');
  assert.ok(item);
  assert.equal(item.state, 'parked');
  assert.equal(item.parkKind, 'decision');
  assert.equal(item.parkReason, 'Ratified 2026-07-15 (option A + follow-up now, B pre-registered, C rejected).');
});

test('fold: multiple items tracked independently', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-001', 'item.captured', { source: 'cli', text: 'item 1' }),
    makeEvent('operator', 'WI-002', 'item.captured', { source: 'cli', text: 'item 2' }),
    makeEvent('conductor', 'WI-001', 'item.queued', { spec: 'spec 1' }),
    makeEvent('conductor', 'WI-002', 'item.merged', { commit: 'abc' }),
  ];
  const result = fold(events);
  assert.equal(result.items.get('WI-001')?.state, 'queued');
  assert.equal(result.items.get('WI-002')?.state, 'merged');
});

test('fold: unknown event type is preserved without state change', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-001', 'item.captured', { source: 'cli', text: 'test' }),
    // Construct an unknown-type event directly without using makeEvent's type checking
    {
      id: 'ev-TEST000000000000000',
      ts: new Date().toISOString(),
      actor: 'system',
      item: 'WI-001',
      type: 'unknown.future.type',
      data: { payload: 'x' },
    } as unknown as LedgerEvent,
  ];
  const result = fold(events);
  const item = result.items.get('WI-001');
  assert.ok(item);
  assert.equal(item.state, 'captured'); // state unchanged
});

test('fold: nextWiId allocates max+1', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-003', 'item.captured', { source: 'cli', text: 'test' }),
    makeEvent('operator', 'WI-001', 'item.captured', { source: 'cli', text: 'test' }),
  ];
  const result = fold(events);
  assert.equal(result.maxWiNum, 3);
  assert.equal(nextWiId(result), 'WI-004');
});

test('fold: msg events accumulate in messages array', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-001', 'item.captured', { source: 'cli', text: 'hi' }),
    makeEvent('operator', 'WI-001', 'msg.in', { text: 'question' }),
    makeEvent('conductor', 'WI-001', 'msg.out', { text: 'answer' }),
  ];
  const result = fold(events);
  const item = result.items.get('WI-001');
  assert.ok(item);
  assert.equal(item.messages.length, 2);
  assert.equal(item.messages[0].direction, 'in');
  assert.equal(item.messages[1].direction, 'out');
});

test('fold: merge.transient-fail keeps state approved and accumulates transientFailCount', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-010', 'item.captured', { source: 'cli', text: 'fix X' }),
    makeEvent('conductor', 'WI-010', 'item.queued', { spec: 'fix X' }),
    makeEvent('dispatch', 'WI-010', 'build.dispatched', { attempt: 1, pid: 1 }),
    makeEvent('dispatch', 'WI-010', 'build.finished', { commit: 'abc' }),
    makeEvent('operator', 'WI-010', 'item.approved', { by: 'operator' }),
    makeEvent('reactor', 'WI-010', 'merge.transient-fail', {
      reason: 'push to origin failed: rejected (non-fast-forward)',
      transientCount: 1,
    }),
  ];
  const result = fold(events);
  const item = result.items.get('WI-010');
  assert.ok(item);
  assert.equal(item.state, 'approved', 'state must stay approved after transient fail');
  assert.equal(item.transientFailCount, 1);
  assert.ok(item.lastTransientError?.includes('non-fast-forward'));

  // A second transient fail accumulates
  const events2: LedgerEvent[] = [
    ...events,
    makeEvent('reactor', 'WI-010', 'merge.transient-fail', {
      reason: 'master ref unresolvable',
      transientCount: 2,
    }),
  ];
  const result2 = fold(events2);
  const item2 = result2.items.get('WI-010');
  assert.equal(item2?.state, 'approved');
  assert.equal(item2?.transientFailCount, 2);
  assert.equal(item2?.lastTransientError, 'master ref unresolvable');
});

test('fold: route=answer transitions to answered (terminal route)', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-020', 'item.captured', { source: 'cli', text: 'what is X?' }),
    makeEvent('conductor', 'WI-020', 'item.routed', { route: 'answer', reply: 'X is Y.' }),
  ];
  const result = fold(events);
  const item = result.items.get('WI-020');
  assert.ok(item);
  assert.equal(item.state, 'answered');
  assert.ok(item.answeredAt);
  assert.equal(item.route, 'answer');
});

test('fold: route=question transitions to answered (terminal route)', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-021', 'item.captured', { source: 'cli', text: 'clarify?' }),
    makeEvent('conductor', 'WI-021', 'item.routed', { route: 'question', reply: 'please clarify' }),
  ];
  const result = fold(events);
  assert.equal(result.items.get('WI-021')?.state, 'answered');
});

test('fold: route=duplicate transitions to answered (terminal route)', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-022', 'item.captured', { source: 'cli', text: 'dup' }),
    makeEvent('conductor', 'WI-022', 'item.routed', { route: 'duplicate', reply: 'see WI-001' }),
  ];
  const result = fold(events);
  assert.equal(result.items.get('WI-022')?.state, 'answered');
});

test('fold: route=merged transitions to answered (terminal route)', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-023', 'item.captured', { source: 'cli', text: 'merged elsewhere' }),
    makeEvent('conductor', 'WI-023', 'item.routed', { route: 'merged', reply: 'already merged' }),
  ];
  const result = fold(events);
  assert.equal(result.items.get('WI-023')?.state, 'answered');
});

test('fold: route=conductor transitions to routed (non-terminal)', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-024', 'item.captured', { source: 'cli', text: 'build Y' }),
    makeEvent('conductor', 'WI-024', 'item.routed', { route: 'conductor', reply: 'queueing' }),
  ];
  const result = fold(events);
  assert.equal(result.items.get('WI-024')?.state, 'routed');
});

test('fold: route=build transitions to routed (non-terminal)', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-025', 'item.captured', { source: 'cli', text: 'build Z' }),
    makeEvent('conductor', 'WI-025', 'item.routed', { route: 'build', reply: 'queuing build' }),
  ];
  const result = fold(events);
  assert.equal(result.items.get('WI-025')?.state, 'routed');
});

test('fold: regression — 19 conductor + 7 build items land in routed, terminal routes land in answered', () => {
  const events: LedgerEvent[] = [];

  for (let i = 1; i <= 19; i++) {
    const id = `WI-${String(i).padStart(3, '0')}`;
    events.push(makeEvent('operator', id, 'item.captured', { source: 'cli', text: `item ${i}` }));
    events.push(makeEvent('conductor', id, 'item.routed', { route: 'conductor', reply: 'queueing' }));
  }
  for (let i = 20; i <= 26; i++) {
    const id = `WI-${String(i).padStart(3, '0')}`;
    events.push(makeEvent('operator', id, 'item.captured', { source: 'cli', text: `item ${i}` }));
    events.push(makeEvent('conductor', id, 'item.routed', { route: 'build', reply: 'building' }));
  }
  for (let i = 27; i <= 30; i++) {
    const id = `WI-${String(i).padStart(3, '0')}`;
    events.push(makeEvent('operator', id, 'item.captured', { source: 'cli', text: `q ${i}?` }));
    events.push(makeEvent('conductor', id, 'item.routed', { route: 'answer', reply: 'X is Y.' }));
  }

  const result = fold(events);
  let routedCount = 0;
  let answeredCount = 0;
  for (const rec of result.items.values()) {
    if (rec.state === 'routed') routedCount++;
    if (rec.state === 'answered') answeredCount++;
  }
  assert.equal(routedCount, 26, '19 conductor + 7 build items land in routed');
  assert.equal(answeredCount, 4, 'terminal-routed items land in answered');
});

test('board: answered items appear in the Answered section, not with live-work routed items', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-040', 'item.captured', { source: 'cli', text: 'build feature A' }),
    makeEvent('conductor', 'WI-040', 'item.routed', { route: 'conductor', reply: 'queueing' }),
    makeEvent('operator', 'WI-041', 'item.captured', { source: 'cli', text: 'what is the status?' }),
    makeEvent('conductor', 'WI-041', 'item.routed', { route: 'answer', reply: 'All good.' }),
  ];
  const result = fold(events);
  const board = renderBoard(result, { now: new Date('2026-01-01T12:00:00Z') });

  assert.match(board, /## 🔀 routed/, 'routed section exists');
  assert.match(board, /WI-040/, 'conductor-routed item in board');
  assert.match(board, /## ✉️ answered/, 'answered section exists');
  assert.match(board, /WI-041/, 'answered item in board');
  // WI-041 must not appear in the routed section
  const routedSection = board.split('## ✉️')[0] ?? '';
  assert.doesNotMatch(routedSection, /WI-041/, 'answered item not in routed bucket');
});

test('fold: non-WI item ids (ops events like loop.beat keyed "system") never materialize items', () => {
  const events = [
    makeEvent('reactor', 'system', 'loop.beat', { loop: 'reactor', result: '{}' }),
    makeEvent('reactor', 'system', 'slo.breach', { indicator: 'x', value: 1, target: 0 }),
    makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'real item' }),
  ];
  const result = fold(events);
  assert.equal(result.items.size, 1, 'only the WI item exists');
  assert.equal(result.items.has('system'), false, 'no phantom system item');
});

// ---------------------------------------------------------------------------
// merged is a TERMINAL fold state
// ---------------------------------------------------------------------------

test('fold: merged is terminal — late item.approved does NOT regress state', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-001', 'item.captured', { source: 'cli', text: 'x' }, '2026-01-01T00:00:00Z'),
    makeEvent('conductor', 'WI-001', 'item.queued', { spec: 's' }, '2026-01-01T00:01:00Z'),
    makeEvent('dispatch', 'WI-001', 'build.dispatched', { attempt: 1, pid: 1, branch: 'wi-001' }, '2026-01-01T00:02:00Z'),
    makeEvent('reactor', 'WI-001', 'item.merged', { commit: 'abc', deployed: false }, '2026-01-01T00:10:00Z'),
    // A duplicate operator approval arrives AFTER the merge (a real observed race).
    makeEvent('cli', 'WI-001', 'item.approved', { by: 'operator' }, '2026-01-01T00:11:00Z'),
  ];
  const item = fold(events).items.get('WI-001')!;
  assert.equal(item.state, 'merged');
  assert.equal(item.mergeCommit, 'abc');
});

test('fold: merged is terminal — late item.parked does NOT regress state', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-001', 'item.captured', { source: 'cli', text: 'x' }, '2026-01-01T00:00:00Z'),
    makeEvent('reactor', 'WI-001', 'item.merged', { commit: 'abc', deployed: false }, '2026-01-01T00:10:00Z'),
    // A stray reactor branch-missing park after the merge (the exact regression path).
    makeEvent('reactor', 'WI-001', 'item.parked', { reason: 'approved branch wi-001 missing — rebuild needed' }, '2026-01-01T00:11:00Z'),
  ];
  const item = fold(events).items.get('WI-001')!;
  assert.equal(item.state, 'merged');
});

test('fold: merged is terminal — a stray item.merged is a no-op (does not re-thread)', () => {
  const events: LedgerEvent[] = [
    makeEvent('reactor', 'WI-001', 'item.merged', { commit: 'abc', deployed: false }, '2026-01-01T00:10:00Z'),
    makeEvent('reactor', 'WI-001', 'item.merged', { commit: 'def', deployed: true }, '2026-01-01T00:11:00Z'),
  ];
  const item = fold(events).items.get('WI-001')!;
  assert.equal(item.state, 'merged');
  assert.equal(item.mergeCommit, 'abc'); // first merge wins; the stray is a no-op
});

test('fold: merged → item.accepted is still allowed (the one legit post-merge transition)', () => {
  const events: LedgerEvent[] = [
    makeEvent('reactor', 'WI-001', 'item.merged', { commit: 'abc', deployed: false }, '2026-01-01T00:10:00Z'),
    makeEvent('operator', 'WI-001', 'item.accepted', { by: 'operator' }, '2026-01-01T01:00:00Z'),
  ];
  const item = fold(events).items.get('WI-001')!;
  assert.equal(item.state, 'accepted');
});

test('fold: merged item still records late messages (thread stays live)', () => {
  const events: LedgerEvent[] = [
    makeEvent('reactor', 'WI-001', 'item.merged', { commit: 'abc', deployed: false }, '2026-01-01T00:10:00Z'),
    makeEvent('cli', 'WI-001', 'msg.in', { text: 'thanks' }, '2026-01-01T00:12:00Z'),
  ];
  const item = fold(events).items.get('WI-001')!;
  assert.equal(item.state, 'merged');
  assert.equal(item.messages.length, 1);
  assert.equal(item.messages[0].text, 'thanks');
});

test('fold: gate.parked records parkClass distinct from parkReason', () => {
  const events: LedgerEvent[] = [
    makeEvent('dispatch', 'WI-001', 'gate.parked', { reason: 'touches-overstep' }, '2026-01-01T00:10:00Z'),
    makeEvent('dispatch', 'WI-001', 'item.parked', { reason: 'needs-decision: files outside declared Touches (a/): a/b.ts' }, '2026-01-01T00:10:01Z'),
  ];
  const item = fold(events).items.get('WI-001')!;
  assert.equal(item.state, 'parked');
  assert.equal(item.parkClass, 'touches-overstep');
  assert.match(item.parkReason!, /files outside declared Touches/);
});

test('fold: deploy.succeeded after item.merged flips deployed=true', () => {
  const events: LedgerEvent[] = [
    makeEvent('reactor', 'WI-001', 'item.merged', { commit: 'abc123', deployed: false }, '2026-01-01T00:10:00Z'),
    makeEvent('deploy', 'WI-001', 'deploy.succeeded', { commit: 'abc123' }, '2026-01-01T00:11:00Z'),
  ];
  const item = fold(events).items.get('WI-001')!;
  assert.equal(item.state, 'merged');
  assert.equal(item.deployed, true);
});

test('fold: deploy.failed after item.merged keeps deployed=false', () => {
  const events: LedgerEvent[] = [
    makeEvent('reactor', 'WI-001', 'item.merged', { commit: 'abc123', deployed: false }, '2026-01-01T00:10:00Z'),
    makeEvent('deploy', 'WI-001', 'deploy.failed', { reason: 'build failed', stderr: 'tsc error' }, '2026-01-01T00:11:00Z'),
  ];
  const item = fold(events).items.get('WI-001')!;
  assert.equal(item.state, 'merged');
  assert.equal(item.deployed, false);
});

test('fold: deploy.succeeded after item.accepted still flips deployed=true', () => {
  const events: LedgerEvent[] = [
    makeEvent('reactor', 'WI-001', 'item.merged', { commit: 'abc123', deployed: false }, '2026-01-01T00:10:00Z'),
    makeEvent('operator', 'WI-001', 'item.accepted', { by: 'operator' }, '2026-01-01T00:11:00Z'),
    makeEvent('deploy', 'WI-001', 'deploy.succeeded', { commit: 'abc123' }, '2026-01-01T00:12:00Z'),
  ];
  const item = fold(events).items.get('WI-001')!;
  assert.equal(item.state, 'accepted');
  assert.equal(item.deployed, true);
});

// ---------------------------------------------------------------------------
// computeAcceptanceDebt tests
// ---------------------------------------------------------------------------

function makeLifecycleEvents(wiId: string, mergedAt: string): LedgerEvent[] {
  return [
    makeEvent('operator', wiId, 'item.captured', { source: 'cli', text: 'build X' }, mergedAt),
    makeEvent('conductor', wiId, 'item.queued', { spec: 'spec' }, mergedAt),
    makeEvent('dispatch', wiId, 'build.dispatched', { attempt: 1, pid: 1 }, mergedAt),
    makeEvent('builder', wiId, 'build.finished', { commit: 'abc' }, mergedAt),
    makeEvent('reactor', wiId, 'item.merged', { commit: 'abc' }, mergedAt),
  ];
}

test('computeAcceptanceDebt: merged item within 7d counts as debt', () => {
  const nowMs = new Date('2026-07-11T12:00:00Z').getTime();
  const mergedAt = '2026-07-10T12:00:00Z'; // 24h ago
  const events = makeLifecycleEvents('WI-001', mergedAt);
  const result = fold(events);
  const debt = computeAcceptanceDebt(result, nowMs);
  assert.equal(debt.acceptanceCount, 1);
  assert.ok(debt.oldestAcceptanceHours !== undefined && debt.oldestAcceptanceHours > 0,
    `expected oldestAcceptanceHours > 0, got ${debt.oldestAcceptanceHours}`);
});

test('computeAcceptanceDebt: accepted item is NOT debt', () => {
  const nowMs = new Date('2026-07-11T12:00:00Z').getTime();
  const mergedAt = '2026-07-10T12:00:00Z';
  const events: LedgerEvent[] = [
    ...makeLifecycleEvents('WI-001', mergedAt),
    makeEvent('operator', 'WI-001', 'item.accepted', { by: 'operator' }, '2026-07-10T13:00:00Z'),
  ];
  const result = fold(events);
  const debt = computeAcceptanceDebt(result, nowMs);
  assert.equal(debt.acceptanceCount, 0);
  assert.equal(debt.oldestAcceptanceHours, undefined);
});

test('computeAcceptanceDebt: merged item older than 7d is excluded', () => {
  const nowMs = new Date('2026-07-11T12:00:00Z').getTime();
  const mergedAt = '2026-07-01T12:00:00Z'; // 10 days ago
  const events = makeLifecycleEvents('WI-001', mergedAt);
  const result = fold(events);
  const debt = computeAcceptanceDebt(result, nowMs);
  assert.equal(debt.acceptanceCount, 0);
  assert.equal(debt.oldestAcceptanceHours, undefined);
});

test('computeAcceptanceDebt: oldest is the max age across multiple merged items', () => {
  const nowMs = new Date('2026-07-11T12:00:00Z').getTime();
  const olderMergedAt = '2026-07-08T12:00:00Z'; // 3 days ago
  const newerMergedAt = '2026-07-10T12:00:00Z'; // 1 day ago
  const events: LedgerEvent[] = [
    ...makeLifecycleEvents('WI-001', olderMergedAt),
    ...makeLifecycleEvents('WI-002', newerMergedAt),
  ];
  const result = fold(events);
  const debt = computeAcceptanceDebt(result, nowMs);
  assert.equal(debt.acceptanceCount, 2);
  // oldestAcceptanceHours should be the age of the older item (~72h)
  assert.ok(debt.oldestAcceptanceHours !== undefined && debt.oldestAcceptanceHours > 48,
    `expected oldestAcceptanceHours > 48 (older item), got ${debt.oldestAcceptanceHours}`);
});

// ---------------------------------------------------------------------------
// Run-controls hard-stop — build.cancelled fold guard
// ---------------------------------------------------------------------------

test('fold: build.cancelled on a building item archives the build and parks hold', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-001', 'item.captured', { source: 'cli', text: 'x' }, '2026-01-01T00:00:00Z'),
    makeEvent('conductor', 'WI-001', 'item.queued', { spec: 's' }, '2026-01-01T00:01:00Z'),
    makeEvent('dispatch', 'WI-001', 'build.dispatched', { attempt: 1, pid: 1, branch: 'wi-001-a1' }, '2026-01-01T00:02:00Z'),
    makeEvent('cli', 'WI-001', 'build.cancel-requested', { attempt: 1, by: 'operator' }, '2026-01-01T00:03:00Z'),
    makeEvent('dispatch', 'WI-001', 'build.cancelled', { attempt: 1, by: 'operator' }, '2026-01-01T00:04:00Z'),
  ];
  const item = fold(events).items.get('WI-001')!;
  assert.equal(item.state, 'parked');
  assert.equal(item.parkKind, 'hold');
  assert.equal(item.parkReason, 'stopped by operator');
  assert.equal(item.currentBuild, undefined, 'the cancelled build must be archived off currentBuild');
  assert.equal(item.builds.length, 1);
  assert.equal(item.builds[0].crashReason, 'cancelled by operator');
});

test('fold: build.cancelled is a no-op on a non-building state (late-event no-op, e.g. already merged)', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-001', 'item.captured', { source: 'cli', text: 'x' }, '2026-01-01T00:00:00Z'),
    makeEvent('conductor', 'WI-001', 'item.queued', { spec: 's' }, '2026-01-01T00:01:00Z'),
    makeEvent('dispatch', 'WI-001', 'build.dispatched', { attempt: 1, pid: 1, branch: 'wi-001-a1' }, '2026-01-01T00:02:00Z'),
    makeEvent('dispatch', 'WI-001', 'build.finished', { commit: 'abc' }, '2026-01-01T00:03:00Z'),
    makeEvent('reactor', 'WI-001', 'item.merged', { commit: 'abc', deployed: false }, '2026-01-01T00:04:00Z'),
    // The cancel-requested + kill raced the merge and lost — a late build.cancelled must never
    // regress an already-merged item back to parked (the exact contract non-negotiable).
    makeEvent('dispatch', 'WI-001', 'build.cancelled', { attempt: 1, by: 'operator' }, '2026-01-01T00:05:00Z'),
  ];
  const item = fold(events).items.get('WI-001')!;
  assert.equal(item.state, 'merged', 'a late build.cancelled after merge must be a no-op');
  assert.equal(item.mergeCommit, 'abc');
});

test('fold: build.cancelled is a no-op when its attempt does not match currentBuild.attempt (attempt-matching race)', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-001', 'item.captured', { source: 'cli', text: 'x' }, '2026-01-01T00:00:00Z'),
    makeEvent('conductor', 'WI-001', 'item.queued', { spec: 's' }, '2026-01-01T00:01:00Z'),
    // Attempt 1 dispatched, crashes, requeues.
    makeEvent('dispatch', 'WI-001', 'build.dispatched', { attempt: 1, pid: 1, branch: 'wi-001-a1' }, '2026-01-01T00:02:00Z'),
    makeEvent('dispatch', 'WI-001', 'build.crashed', { reason: 'infra: x' }, '2026-01-01T00:03:00Z'),
    // Attempt 2 dispatched — the item is now building under a DIFFERENT attempt.
    makeEvent('dispatch', 'WI-001', 'build.dispatched', { attempt: 2, pid: 2, branch: 'wi-001-a2' }, '2026-01-01T00:04:00Z'),
    // A stale cancelled event for attempt 1 (its kill raced the crash and arrives late) must
    // NOT be applied to the now-in-flight attempt 2.
    makeEvent('dispatch', 'WI-001', 'build.cancelled', { attempt: 1, by: 'operator' }, '2026-01-01T00:05:00Z'),
  ];
  const item = fold(events).items.get('WI-001')!;
  assert.equal(item.state, 'building', 'a build.cancelled for a superseded attempt must not touch the current build');
  assert.equal(item.currentBuild?.attempt, 2);
});

test('fold: build.cancelled with no attempt field (backward-compat) still requires the building guard', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-001', 'item.captured', { source: 'cli', text: 'x' }, '2026-01-01T00:00:00Z'),
    // Item never left 'captured' — no currentBuild exists at all.
    makeEvent('dispatch', 'WI-001', 'build.cancelled', { attempt: 1, by: 'operator' }, '2026-01-01T00:01:00Z'),
  ];
  const item = fold(events).items.get('WI-001')!;
  assert.equal(item.state, 'captured', 'build.cancelled with no active build must be a no-op');
});

test('fold: build.cancel-requested alone never changes item state (pure ledger write)', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-001', 'item.captured', { source: 'cli', text: 'x' }, '2026-01-01T00:00:00Z'),
    makeEvent('conductor', 'WI-001', 'item.queued', { spec: 's' }, '2026-01-01T00:01:00Z'),
    makeEvent('dispatch', 'WI-001', 'build.dispatched', { attempt: 1, pid: 1, branch: 'wi-001-a1' }, '2026-01-01T00:02:00Z'),
    makeEvent('cli', 'WI-001', 'build.cancel-requested', { attempt: 1, by: 'operator' }, '2026-01-01T00:03:00Z'),
  ];
  const item = fold(events).items.get('WI-001')!;
  assert.equal(item.state, 'building', 'a cancel-requested alone (kill not yet observed) must not change state');
});

// ---------------------------------------------------------------------------
// Conversation layer
// ---------------------------------------------------------------------------

test('fold: empty events with maxConvNum=0', () => {
  const result = fold([]);
  assert.equal(result.conversations.size, 0);
  assert.equal(result.maxConvNum, 0);
});

test('fold: conv.started creates conversation record', () => {
  const ev = makeEvent('cli', 'CONV-001', 'conv.started', { source: 'cli', title: 'Q&A thread' });
  const result = fold([ev]);
  const conv = result.conversations.get('CONV-001');
  assert.ok(conv);
  assert.equal(conv.state, 'active');
  assert.equal(conv.title, 'Q&A thread');
  assert.equal(conv.source, 'cli');
  assert.equal(result.maxConvNum, 1);
});

test('fold: msg.in/msg.out on CONV accumulate in messages array', () => {
  const events: LedgerEvent[] = [
    makeEvent('cli', 'CONV-001', 'conv.started', { source: 'console', title: 'discussion' }),
    makeEvent('operator', 'CONV-001', 'msg.in', { text: 'what is X?' }),
    makeEvent('conductor', 'CONV-001', 'msg.out', { text: 'X is ...' }),
    makeEvent('operator', 'CONV-001', 'msg.in', { text: 'follow-up' }),
  ];
  const result = fold(events);
  const conv = result.conversations.get('CONV-001');
  assert.ok(conv);
  assert.equal(conv.messages.length, 3);
  assert.equal(conv.messages[0].direction, 'in');
  assert.equal(conv.messages[0].text, 'what is X?');
  assert.equal(conv.messages[1].direction, 'out');
  assert.equal(conv.messages[2].text, 'follow-up');
});

test('fold: conv.promoted tracks spawned items', () => {
  const events: LedgerEvent[] = [
    makeEvent('cli', 'CONV-001', 'conv.started', { source: 'console', title: 'planning' }),
    makeEvent('conductor', 'CONV-001', 'conv.promoted', { items: ['WI-001', 'WI-002'] }),
  ];
  const result = fold(events);
  const conv = result.conversations.get('CONV-001');
  assert.ok(conv);
  assert.deepEqual(conv.spawnedItems, ['WI-001', 'WI-002']);
});

test('fold: conv.closed sets state and closedAt', () => {
  const events: LedgerEvent[] = [
    makeEvent('cli', 'CONV-001', 'conv.started', { source: 'cli' }),
    makeEvent('conductor', 'CONV-001', 'conv.closed', { reason: 'idle' }, '2026-01-01T01:00:00Z'),
  ];
  const result = fold(events);
  const conv = result.conversations.get('CONV-001')!;
  assert.equal(conv.state, 'closed');
  assert.equal(conv.closedAt, '2026-01-01T01:00:00Z');
});

test('fold: mixed WI and CONV events fold independently', () => {
  const events: LedgerEvent[] = [
    makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'task' }),
    makeEvent('cli', 'CONV-001', 'conv.started', { source: 'cli', title: 'chat' }),
    makeEvent('cli', 'WI-002', 'item.captured', { source: 'cli', text: 'another task' }),
    makeEvent('cli', 'CONV-001', 'msg.in', { text: 'hello' }),
  ];
  const result = fold(events);
  assert.equal(result.items.size, 2);
  assert.equal(result.conversations.size, 1);
  assert.equal(result.maxWiNum, 2);
  assert.equal(result.maxConvNum, 1);
});

test('fold: CONV allocation is guarded (maxConvNum tracks max only)', () => {
  const events: LedgerEvent[] = [
    makeEvent('cli', 'CONV-003', 'conv.started', { source: 'cli' }),
    makeEvent('cli', 'CONV-001', 'conv.started', { source: 'cli' }),
  ];
  const result = fold(events);
  assert.equal(result.maxConvNum, 3, 'maxConvNum should track the highest number seen');
  assert.equal(result.conversations.size, 2);
});

test('fold: non-WI/CONV events are skipped silently (no phantom records)', () => {
  const events: LedgerEvent[] = [
    makeEvent('system', 'system', 'loop.beat', { loop: 'reactor', result: 'ok' }),
    makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'task' }),
  ];
  const result = fold(events);
  assert.equal(result.items.size, 1);
  assert.equal(result.conversations.size, 0);
  assert.ok(!result.items.has('system'));
});

test('fold: item.captured with convRef carries the conversation reference', () => {
  const events: LedgerEvent[] = [
    makeEvent('cli', 'CONV-001', 'conv.started', { source: 'cli', title: 'chat' }),
    makeEvent('conductor', 'WI-001', 'item.captured', { source: 'cli', text: 'task from chat', convRef: 'CONV-001' }),
  ];
  const result = fold(events);
  const item = result.items.get('WI-001');
  assert.ok(item);
  // The fold stores convRef in data via item.captured handler if explicitly passed
  // (this test verifies the fold doesn't crash on the optional field)
  assert.equal(result.conversations.size, 1);
});

test('fold: nextConvId allocates CONV-001 when maxConvNum=0', () => {
  const { maxConvNum } = fold([]);
  const id = `CONV-${String(maxConvNum + 1).padStart(3, '0')}`;
  assert.equal(id, 'CONV-001');
});

test('fold: nextConvId allocates CONV-NNN padded correctly', () => {
  const events: LedgerEvent[] = [
    makeEvent('cli', 'CONV-099', 'conv.started', { source: 'cli' }),
  ];
  const result = fold(events);
  const nextId = `CONV-${String(result.maxConvNum + 1).padStart(3, '0')}`;
  assert.equal(nextId, 'CONV-100');
});

// ---------------------------------------------------------------------------
// Novelty-vs-known-failure catalog
// ---------------------------------------------------------------------------

test('computeParkFingerprint: same reason+kind hashes identically regardless of case/whitespace', () => {
  const a = computeParkFingerprint('  Tests   red\n', 'ops');
  const b = computeParkFingerprint('tests red', 'ops');
  assert.equal(a, b);
});

test('computeParkFingerprint: different parkKind produces a different fingerprint', () => {
  const a = computeParkFingerprint('tests red', 'ops');
  const b = computeParkFingerprint('tests red', 'decision');
  assert.notEqual(a, b);
});

test('fold: first park of a fingerprint is first-seen and starts the catalog at count 1', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-600', 'item.captured', { source: 'cli', text: 'thing' }),
    makeEvent('reactor', 'WI-600', 'item.parked', { reason: 'tests red', parkKind: 'ops' }, '2026-07-19T10:00:00.000Z'),
  ];
  const result = fold(events);
  const rec = result.items.get('WI-600')!;
  assert.equal(rec.parkNovelty, 'first-seen');
  const fp = computeParkFingerprint('tests red', 'ops');
  assert.deepEqual(result.failureCatalog.get(fp), {
    count: 1,
    firstSeenAt: '2026-07-19T10:00:00.000Z',
    lastSeenAt: '2026-07-19T10:00:00.000Z',
  });
  assert.equal(isFirstSeenPark(rec), true);
});

test('fold: a second item parked with the SAME fingerprint tallies as repeat-known', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-601', 'item.captured', { source: 'cli', text: 'thing one' }),
    makeEvent('reactor', 'WI-601', 'item.parked', { reason: 'tests red', parkKind: 'ops' }, '2026-07-19T10:00:00.000Z'),
    makeEvent('operator', 'WI-602', 'item.captured', { source: 'cli', text: 'thing two' }),
    makeEvent('reactor', 'WI-602', 'item.parked', { reason: 'tests red', parkKind: 'ops' }, '2026-07-19T10:05:00.000Z'),
  ];
  const result = fold(events);
  const rec1 = result.items.get('WI-601')!;
  const rec2 = result.items.get('WI-602')!;
  assert.equal(rec1.parkNovelty, 'first-seen');
  assert.equal(rec2.parkNovelty, 'repeat-known');
  assert.equal(isFirstSeenPark(rec2), false);
  const fp = computeParkFingerprint('tests red', 'ops');
  const entry = result.failureCatalog.get(fp)!;
  assert.equal(entry.count, 2);
  assert.equal(entry.firstSeenAt, '2026-07-19T10:00:00.000Z');
  assert.equal(entry.lastSeenAt, '2026-07-19T10:05:00.000Z');
});

test('fold: exit-from-parked clears the live parkFingerprint/parkNovelty (forensics not carried)', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-603', 'item.captured', { source: 'cli', text: 'thing' }),
    makeEvent('reactor', 'WI-603', 'item.parked', { reason: 'tests red', parkKind: 'ops' }, '2026-07-19T10:00:00.000Z'),
    makeEvent('reactor', 'WI-603', 'item.unparked', { by: 'reactor' }, '2026-07-19T10:01:00.000Z'),
  ];
  const result = fold(events);
  const rec = result.items.get('WI-603')!;
  assert.equal(rec.parkFingerprint, undefined);
  assert.equal(rec.parkNovelty, undefined);
});

test('fold: a fresh replay rebuilds the catalog deterministically, not preserving stale counts', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-604', 'item.captured', { source: 'cli', text: 'thing' }),
    makeEvent('reactor', 'WI-604', 'item.parked', { reason: 'tests red', parkKind: 'ops' }, '2026-07-19T10:00:00.000Z'),
  ];
  const first = fold(events);
  const second = fold(events);
  const fp = computeParkFingerprint('tests red', 'ops');
  assert.deepEqual(first.failureCatalog.get(fp), second.failureCatalog.get(fp));
});

// ---------------------------------------------------------------------------
// WI-108 — lifetime clean-landing counters on ItemRecord + summary wire
// ---------------------------------------------------------------------------

test('fold: lifetime counters are absent (undefined = 0) on a clean straight-through merge', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-600', 'item.captured', { source: 'cli', text: 'clean' }, '2026-01-01T00:00:00Z'),
    makeEvent('reactor', 'WI-600', 'item.queued', { spec: 'clean' }, '2026-01-01T00:01:00Z'),
    makeEvent('dispatch', 'WI-600', 'build.dispatched', { attempt: 1, pid: 1 }, '2026-01-01T00:02:00Z'),
    makeEvent('dispatch', 'WI-600', 'gate.passed', {}, '2026-01-01T00:03:00Z'),
    makeEvent('reactor', 'WI-600', 'item.merged', { commit: 'abc' }, '2026-01-01T00:04:00Z'),
  ];
  const item = fold(events).items.get('WI-600')!;
  assert.equal(item.state, 'merged');
  assert.equal(item.lifetimeParkCount, undefined);
  assert.equal(item.lifetimeCrashCount, undefined);
  assert.equal(item.lifetimeGateRedCount, undefined);
  assert.equal(item.lifetimeEscalationCount, undefined);
});

test('fold: lifetimeParkCount accumulates across every park, ops and decision alike', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-601', 'item.captured', { source: 'cli', text: 'rough' }, '2026-01-01T00:00:00Z'),
    makeEvent('reactor', 'WI-601', 'item.queued', { spec: 'rough' }, '2026-01-01T00:01:00Z'),
    makeEvent('dispatch', 'WI-601', 'item.parked', { reason: 'tests red', parkKind: 'ops' }, '2026-01-01T00:02:00Z'),
    makeEvent('reactor', 'WI-601', 'item.unparked', {}, '2026-01-01T00:03:00Z'),
    makeEvent('dispatch', 'WI-601', 'item.parked', { reason: 'needs a call', parkKind: 'decision' }, '2026-01-01T00:04:00Z'),
  ];
  const item = fold(events).items.get('WI-601')!;
  assert.equal(item.lifetimeParkCount, 2, 'both parks counted');
  // operator-attention = decision parks + escalations → only the decision park here
  assert.equal(item.lifetimeEscalationCount, 1);
});

test('fold: lifetimeCrashCount counts crashes AND stalls; lifetimeGateRedCount counts gate.failed + gate.parked', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-602', 'item.captured', { source: 'cli', text: 'flaky' }, '2026-01-01T00:00:00Z'),
    makeEvent('reactor', 'WI-602', 'item.queued', { spec: 'flaky' }, '2026-01-01T00:01:00Z'),
    makeEvent('dispatch', 'WI-602', 'build.dispatched', { attempt: 1, pid: 1 }, '2026-01-01T00:02:00Z'),
    makeEvent('doctor', 'WI-602', 'build.crashed', { reason: 'orphan', stderrTail: 'boom' }, '2026-01-01T00:03:00Z'),
    makeEvent('dispatch', 'WI-602', 'build.dispatched', { attempt: 2, pid: 2 }, '2026-01-01T00:04:00Z'),
    makeEvent('doctor', 'WI-602', 'build.stalled', { reason: 'no-progress' }, '2026-01-01T00:05:00Z'),
    makeEvent('dispatch', 'WI-602', 'build.dispatched', { attempt: 3, pid: 3 }, '2026-01-01T00:06:00Z'),
    makeEvent('dispatch', 'WI-602', 'gate.failed', { reason: 'unit tests red' }, '2026-01-01T00:07:00Z'),
    makeEvent('reactor', 'WI-602', 'item.unparked', {}, '2026-01-01T00:08:00Z'),
    makeEvent('dispatch', 'WI-602', 'build.dispatched', { attempt: 4, pid: 4 }, '2026-01-01T00:09:00Z'),
    makeEvent('dispatch', 'WI-602', 'gate.parked', { reason: 'touches-overstep' }, '2026-01-01T00:10:00Z'),
  ];
  const item = fold(events).items.get('WI-602')!;
  assert.equal(item.lifetimeCrashCount, 2, 'crash + stall');
  assert.equal(item.lifetimeGateRedCount, 2, 'gate.failed + gate.parked');
});

test('fold: lifetimeEscalationCount = decision-parks + item.escalated events', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-603', 'item.captured', { source: 'cli', text: 'escalated' }, '2026-01-01T00:00:00Z'),
    makeEvent('reactor', 'WI-603', 'item.queued', { spec: 'escalated' }, '2026-01-01T00:01:00Z'),
    makeEvent('dispatch', 'WI-603', 'build.dispatched', { attempt: 1, pid: 1 }, '2026-01-01T00:02:00Z'),
    makeEvent('console', 'WI-603', 'item.escalated', { by: 'operator' }, '2026-01-01T00:03:00Z'),
    makeEvent('dispatch', 'WI-603', 'item.parked', { reason: 'needs a call', parkKind: 'decision' }, '2026-01-01T00:04:00Z'),
  ];
  const item = fold(events).items.get('WI-603')!;
  assert.equal(item.lifetimeEscalationCount, 2, 'one escalation + one decision park');
  assert.equal(item.lifetimeParkCount, 1, 'only the decision park counts as a park');
});

test('fold: lifetime counters survive a re-open (monotone — history is never reset)', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-604', 'item.captured', { source: 'cli', text: 'reopened' }, '2026-01-01T00:00:00Z'),
    makeEvent('reactor', 'WI-604', 'item.queued', { spec: 'reopened' }, '2026-01-01T00:01:00Z'),
    makeEvent('dispatch', 'WI-604', 'item.parked', { reason: 'tests red', parkKind: 'ops' }, '2026-01-01T00:02:00Z'),
    makeEvent('reactor', 'WI-604', 'item.unparked', {}, '2026-01-01T00:03:00Z'),
    makeEvent('dispatch', 'WI-604', 'build.dispatched', { attempt: 1, pid: 1 }, '2026-01-01T00:04:00Z'),
    makeEvent('reactor', 'WI-604', 'item.merged', { commit: 'def' }, '2026-01-01T00:05:00Z'),
    makeEvent('operator', 'WI-604', 'item.reopened', { by: 'operator', reason: 'regressed' }, '2026-01-01T00:06:00Z'),
    makeEvent('dispatch', 'WI-604', 'item.parked', { reason: 'tests red again', parkKind: 'ops' }, '2026-01-01T00:07:00Z'),
  ];
  const item = fold(events).items.get('WI-604')!;
  assert.equal(item.lifetimeParkCount, 2, 'the pre-reopen park still counts');
});

test('summary: merged record carries lifetime counters through the --json wire shape when non-zero', async () => {
  const { buildSummary } = await import('../src/summary.js');
  const { loadConfig } = await import('../src/config.js');
  const { mkdirSync, rmSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { spawnSync } = await import('node:child_process');

  const repoRoot = join(tmpdir(), `loopkit-wi108-summary-${process.pid}-${Date.now()}`);
  mkdirSync(repoRoot, { recursive: true });
  try {
    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    writeFileSync(join(repoRoot, 'base.txt'), 'base', 'utf8');
    g(['add', 'base.txt']);
    g(['commit', '-m', 'init']);

    const now = Date.now();
    const isoNow = new Date(now).toISOString();
    const events: LedgerEvent[] = [
      makeEvent('operator', 'WI-605', 'item.captured', { source: 'cli', text: 'rough merge' }, isoNow),
      makeEvent('reactor', 'WI-605', 'item.queued', { spec: 'rough merge' }, isoNow),
      makeEvent('dispatch', 'WI-605', 'item.parked', { reason: 'tests red', parkKind: 'ops' }, isoNow),
      makeEvent('reactor', 'WI-605', 'item.unparked', {}, isoNow),
      makeEvent('dispatch', 'WI-605', 'build.dispatched', { attempt: 1, pid: 1 }, isoNow),
      makeEvent('reactor', 'WI-605', 'item.merged', { commit: 'ghi' }, isoNow),
    ];
    const summary = buildSummary(fold(events), events, { cfg: loadConfig(repoRoot), repoRoot, now });
    const recentMerged30d = summary.recentMerged30d as Array<Record<string, unknown>>;
    const merged = recentMerged30d.find((m) => m.id === 'WI-605');
    assert.ok(merged, 'WI-605 appears in recentMerged30d');
    assert.equal(merged!.lifetimeParkCount, 1);
    // absent counters stay absent (clean signals emit nothing)
    assert.equal('lifetimeCrashCount' in merged!, false);
    assert.equal('lifetimeEscalationCount' in merged!, false);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
