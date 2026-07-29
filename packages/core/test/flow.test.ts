import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  ITEM_FLOW,
  isAllowedItemTransition,
  isItemDependencyReady,
  projectDependencyGraph,
  validateItemFlowDefinition,
  wouldCreateDependencyCycle,
} from '../src/flow.js';
import { fold } from '../src/fold.js';
import { appendEvents, loadAllEvents } from '../src/ledger.js';
import { makeEvent, LedgerEvent } from '../src/schema.js';
import {
  makeClaimBeforePick,
  parkPlanningWithoutProvider,
  runDispatch,
} from '../src/beats/dispatch.js';
import { CONFIG_DEFAULTS } from '../src/config.js';

function itemEvents(id: string, state: 'queued' | 'merged' | 'accepted' = 'queued'): LedgerEvent[] {
  const events: LedgerEvent[] = [
    makeEvent('test', id, 'item.captured', { source: 'test', text: id }),
    makeEvent('test', id, 'item.queued', { spec: `build ${id}` }),
  ];
  if (state === 'merged' || state === 'accepted') {
    events.push(makeEvent('test', id, 'item.merged', { commit: `${id}-commit` }));
  }
  if (state === 'accepted') {
    events.push(makeEvent('test', id, 'item.accepted', { by: 'test' }));
  }
  return events;
}

test('typed item flow definition is internally valid and pins terminal exits', () => {
  assert.deepEqual(validateItemFlowDefinition(), []);
  assert.deepEqual(ITEM_FLOW.terminalStates, ['merged', 'rejected', 'accepted', 'answered', 'done']);
  assert.equal(isAllowedItemTransition('merged', 'queued', 'item.queued'), false);
  assert.equal(isAllowedItemTransition('merged', 'queued', 'item.reopened'), true);
  assert.equal(isAllowedItemTransition('merged', 'accepted', 'item.accepted'), true);
  assert.equal(isAllowedItemTransition('accepted', 'queued', 'item.reopened'), true);
  assert.equal(isAllowedItemTransition('accepted', 'merged', 'item.merged'), false);
});

test('fold uses flow transition rules: legacy sparse replay works and late terminal exits no-op', () => {
  const legacySparse = fold([
    makeEvent('test', 'WI-001', 'item.captured', { source: 'test', text: 'legacy' }),
    makeEvent('test', 'WI-001', 'item.merged', { commit: 'abc' }),
    makeEvent('test', 'WI-001', 'item.queued', { spec: 'late queue' }),
    makeEvent('test', 'WI-001', 'build.dispatched', { attempt: 2 }),
  ]).items.get('WI-001')!;
  assert.equal(legacySparse.state, 'merged', 'late state events cannot exit a terminal state');
  assert.equal(legacySparse.spec, undefined, 'late queue data cannot mutate terminal state-specific fields');
  assert.equal(legacySparse.queuedAt, undefined);
  assert.equal(legacySparse.attempts, 0, 'late dispatch data cannot create a terminal build attempt');
  assert.equal(legacySparse.currentBuild, undefined);

  const reopened = fold([
    makeEvent('test', 'WI-002', 'item.captured', { source: 'test', text: 'legacy' }),
    makeEvent('test', 'WI-002', 'item.merged', { commit: 'abc' }),
    makeEvent('test', 'WI-002', 'item.reopened', { by: 'operator', reason: 'again' }),
  ]).items.get('WI-002')!;
  assert.equal(reopened.state, 'queued');
});

test('dependency add/remove folds active edges from append-only history', () => {
  const result = fold([
    ...itemEvents('WI-001'),
    ...itemEvents('WI-002'),
    makeEvent('operator', 'WI-001', 'item.dependency-added', { onItem: 'WI-002' }),
    makeEvent('operator', 'WI-001', 'item.dependency-removed', { onItem: 'WI-002' }),
  ]);
  assert.deepEqual(result.items.get('WI-001')?.dependencies, []);
  assert.equal(projectDependencyGraph(result.items.values()).items.find(i => i.item === 'WI-001')?.ready, true);
});

test('same-timestamp legacy dependency facts fold identically regardless of event-id order', () => {
  const ts = '2026-07-29T12:00:00.000Z';
  const added = {
    ...makeEvent('operator', 'WI-001', 'item.dependency-added', { onItem: 'WI-002' }, ts),
    id: 'ev-Z-add',
  } as unknown as LedgerEvent;
  const removed = {
    ...makeEvent('operator', 'WI-001', 'item.dependency-removed', { onItem: 'WI-002' }, ts),
    id: 'ev-A-remove',
  } as unknown as LedgerEvent;
  const base = [...itemEvents('WI-001'), ...itemEvents('WI-002')];

  assert.deepEqual(fold([...base, added, removed]).items.get('WI-001')?.dependencies, []);
  assert.deepEqual(fold([...base, removed, added]).items.get('WI-001')?.dependencies, []);
});

test('higher dependency revision wins regardless of same-timestamp order or event id', () => {
  const ts = '2026-07-29T12:00:00.000Z';
  const addedRev2 = {
    ...makeEvent('operator', 'WI-001', 'item.dependency-added', { onItem: 'WI-002', revision: 2 }, ts),
    id: 'ev-A-add',
  } as unknown as LedgerEvent;
  const removedRev1 = {
    ...makeEvent('operator', 'WI-001', 'item.dependency-removed', { onItem: 'WI-002', revision: 1 }, ts),
    id: 'ev-Z-remove',
  } as unknown as LedgerEvent;
  const base = [...itemEvents('WI-001'), ...itemEvents('WI-002')];

  for (const facts of [[addedRev2, removedRev1], [removedRev1, addedRev2]]) {
    assert.deepEqual(fold([...base, ...facts]).items.get('WI-001')?.dependencies, [{
      item: 'WI-002',
      condition: 'merged-or-accepted',
      addedAt: ts,
    }]);
  }
});

test('divergent same-revision add/remove keeps the dependency active in both event orders', () => {
  const ts = '2026-07-29T12:00:00.000Z';
  const added = {
    ...makeEvent('branch-a', 'WI-001', 'item.dependency-added', {
      onItem: 'WI-002',
      revision: 7,
    }, ts),
    id: 'ev-Z-branch-add',
  } as unknown as LedgerEvent;
  const removed = {
    ...makeEvent('branch-b', 'WI-001', 'item.dependency-removed', {
      onItem: 'WI-002',
      revision: 7,
    }, ts),
    id: 'ev-A-branch-remove',
  } as unknown as LedgerEvent;
  const base = [...itemEvents('WI-001'), ...itemEvents('WI-002')];

  for (const facts of [[added, removed], [removed, added]]) {
    const result = fold([...base, ...facts]);
    assert.deepEqual(result.items.get('WI-001')?.dependencies, [{
      item: 'WI-002',
      condition: 'merged-or-accepted',
      addedAt: ts,
    }]);
    assert.equal(isItemDependencyReady(projectDependencyGraph(result.items.values()), 'WI-001'), false);
  }
});

test('multiple dependencies all resolve; missing references fail closed', () => {
  const result = fold([
    ...itemEvents('WI-001'),
    ...itemEvents('WI-002', 'merged'),
    ...itemEvents('WI-003'),
    makeEvent('operator', 'WI-001', 'item.dependency-added', { onItem: 'WI-002' }),
    makeEvent('operator', 'WI-001', 'item.dependency-added', { onItem: 'WI-003' }),
    makeEvent('operator', 'WI-003', 'item.dependency-added', { onItem: 'WI-999' }),
  ]);
  const graph = projectDependencyGraph(result.items.values());
  const one = graph.items.find(i => i.item === 'WI-001')!;
  assert.equal(one.ready, false, 'live WI-003 blocks even though WI-002 merged');
  assert.deepEqual(one.unresolved, ['WI-003']);
  const three = graph.items.find(i => i.item === 'WI-003')!;
  assert.equal(three.ready, false);
  assert.deepEqual(three.missing, ['WI-999']);

  const allResolved = fold([
    ...itemEvents('WI-001'),
    ...itemEvents('WI-002', 'merged'),
    ...itemEvents('WI-003', 'accepted'),
    makeEvent('operator', 'WI-001', 'item.dependency-added', { onItem: 'WI-002' }),
    makeEvent('operator', 'WI-001', 'item.dependency-added', { onItem: 'WI-003' }),
  ]);
  assert.equal(isItemDependencyReady(projectDependencyGraph(allResolved.items.values()), 'WI-001'), true);
});

test('malformed ledger cycles are detected and readiness fails closed', () => {
  const result = fold([
    ...itemEvents('WI-010'),
    ...itemEvents('WI-011'),
    ...itemEvents('WI-012'),
    makeEvent('manual', 'WI-010', 'item.dependency-added', { onItem: 'WI-011' }),
    makeEvent('manual', 'WI-011', 'item.dependency-added', { onItem: 'WI-012' }),
    makeEvent('manual', 'WI-012', 'item.dependency-added', { onItem: 'WI-010' }),
  ]);
  const graph = projectDependencyGraph(result.items.values());
  assert.deepEqual(graph.cycles, [['WI-010', 'WI-011', 'WI-012']]);
  for (const id of ['WI-010', 'WI-011', 'WI-012']) {
    assert.equal(isItemDependencyReady(graph, id), false);
  }
  assert.equal(wouldCreateDependencyCycle(result.items.values(), 'WI-010', 'WI-011'), true);
});

test('dispatch leaves dependent work queued, then selects it on the beat after blocker merge', async () => {
  const root = join(tmpdir(), `loopkit-flow-dispatch-${process.pid}-${Date.now()}`);
  const ledgerDir = join(root, 'ledger');
  const repoRoot = join(root, 'repo');
  mkdirSync(ledgerDir, { recursive: true });
  mkdirSync(repoRoot, { recursive: true });
  try {
    await appendEvents(ledgerDir, [
      ...itemEvents('WI-020'),
      makeEvent('test', 'WI-021', 'item.captured', { source: 'test', text: 'blocker' }),
      makeEvent('operator', 'WI-020', 'item.dependency-added', { onItem: 'WI-021' }),
    ]);
    const opts = {
      repoRoot,
      ledgerDir,
      autonomy: 'on' as const,
      dryRun: true,
      provider: null,
      config: { ...CONFIG_DEFAULTS, gateCommand: 'exit 0', gateWorkdir: '.' },
    };
    const waiting = await runDispatch(opts);
    assert.ok(!waiting.dispatched.some(row => row.item === 'WI-020'));
    assert.match(waiting.detail ?? '', /1 queued item\(s\) waiting on dependencies: WI-020/);
    assert.deepEqual(waiting.dependencyBlocked, { count: 1, items: ['WI-020'] });
    let events = await loadAllEvents(ledgerDir);
    assert.ok(!events.some(ev => ev.item === 'WI-020' && ev.type === 'build.dispatched'));
    assert.equal(fold(events).items.get('WI-020')?.state, 'queued');

    await appendEvents(ledgerDir, [
      makeEvent('test', 'WI-021', 'item.merged', { commit: 'blocker-commit' }),
    ]);
    const released = await runDispatch(opts);
    assert.ok(released.dispatched.some(row => row.item === 'WI-020' && row.dispatched),
      'next beat selects A without unpark/requeue');
    events = await loadAllEvents(ledgerDir);
    assert.ok(!events.some(ev => ev.item === 'WI-020' && ev.type === 'item.unparked'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fresh claim admission yields when a resolved blocker reopens after the picker fold', async () => {
  const root = join(tmpdir(), `loopkit-flow-claim-${process.pid}-${Date.now()}`);
  const ledgerDir = join(root, 'ledger');
  mkdirSync(ledgerDir, { recursive: true });
  try {
    await appendEvents(ledgerDir, [
      ...itemEvents('WI-030'),
      ...itemEvents('WI-031', 'merged'),
      makeEvent('operator', 'WI-030', 'item.dependency-added', { onItem: 'WI-031' }),
    ]);
    const initiallyReady = fold(await loadAllEvents(ledgerDir));
    assert.equal(isItemDependencyReady(projectDependencyGraph(initiallyReady.items.values()), 'WI-030'), true);

    await appendEvents(ledgerDir, [
      makeEvent('operator', 'WI-031', 'item.reopened', { by: 'operator', reason: 'repair required' }),
    ]);
    const decisions = await makeClaimBeforePick(ledgerDir, 'dispatch-test', 10)(['WI-030']);
    assert.deepEqual(decisions, [{ item: 'WI-030', keep: false, dependencyBlocked: true }]);

    const events = await loadAllEvents(ledgerDir);
    assert.equal(
      events.some(ev => ev.item === 'WI-030' && ev.type === 'item.claimed'),
      false,
      'freshly blocked planning candidates must not acquire a claim or reach build.dispatched',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fresh claim admission yields when an operator hold lands after the picker fold', async () => {
  const root = join(tmpdir(), `loopkit-flow-hold-${process.pid}-${Date.now()}`);
  const ledgerDir = join(root, 'ledger');
  mkdirSync(ledgerDir, { recursive: true });
  try {
    await appendEvents(ledgerDir, itemEvents('WI-040'));
    assert.equal(fold(await loadAllEvents(ledgerDir)).items.get('WI-040')?.state, 'queued');

    await appendEvents(ledgerDir, [
      makeEvent('operator', 'WI-040', 'item.parked', { reason: 'operator hold', parkKind: 'hold' }),
    ]);
    const decisions = await makeClaimBeforePick(ledgerDir, 'dispatch-test', 10)(['WI-040']);
    assert.deepEqual(decisions, [{
      item: 'WI-040',
      keep: false,
      stateChanged: { state: 'parked' },
    }]);

    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.some(ev => ev.item === 'WI-040' && ev.type === 'item.claimed'), false);
    assert.equal(events.some(ev => ev.item === 'WI-040' && ev.type === 'build.dispatched'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('no-provider planning atomically parks only fresh survivors after hold/dependency races', async () => {
  const root = join(tmpdir(), `loopkit-flow-no-provider-${process.pid}-${Date.now()}`);
  const ledgerDir = join(root, 'ledger');
  mkdirSync(ledgerDir, { recursive: true });
  try {
    await appendEvents(ledgerDir, [
      ...itemEvents('WI-050'),
      ...itemEvents('WI-051'),
      ...itemEvents('WI-052'),
      ...itemEvents('WI-053'),
    ]);
    const pickerFold = fold(await loadAllEvents(ledgerDir));
    const pickerGraph = projectDependencyGraph(pickerFold.items.values());
    for (const id of ['WI-050', 'WI-051', 'WI-053']) {
      assert.equal(isItemDependencyReady(pickerGraph, id), true, `${id} was a valid stale picker candidate`);
    }

    // Both changes land after the picker snapshot but before the no-provider terminal.
    await appendEvents(ledgerDir, [
      makeEvent('operator', 'WI-050', 'item.parked', { reason: 'operator hold', parkKind: 'hold' }),
      makeEvent('operator', 'WI-051', 'item.dependency-added', { onItem: 'WI-052' }),
    ]);

    const reason = 'infra: no provider available for dispatch';
    const decisions = await parkPlanningWithoutProvider(
      ledgerDir,
      ['WI-050', 'WI-051', 'WI-053'],
      'dispatch-test',
      10,
      reason,
    );
    assert.deepEqual(decisions, [
      { item: 'WI-050', keep: false, stateChanged: { state: 'parked' } },
      { item: 'WI-051', keep: false, dependencyBlocked: true },
      { item: 'WI-053', keep: true },
    ]);

    const events = await loadAllEvents(ledgerDir);
    assert.deepEqual(
      events
        .filter(ev => ev.actor === 'dispatch' && ev.type === 'item.parked')
        .map(ev => ev.item),
      ['WI-053'],
      'normal survivor is parked, while the hold and dependency-blocked item receive no stale park',
    );
    const result = fold(events);
    assert.equal(result.items.get('WI-050')?.parkKind, 'hold');
    assert.equal(result.items.get('WI-051')?.state, 'queued');
    assert.equal(result.items.get('WI-053')?.parkKind, 'ops');
    assert.ok(!events.some(ev => ev.type === 'item.claimed'),
      'no-provider terminal parks atomically without creating an intermediate claim');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
