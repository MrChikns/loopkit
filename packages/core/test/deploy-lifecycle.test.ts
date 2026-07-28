import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DeploySpawn,
} from '../src/beats/worktree-deps.js';
import {
  requestDeployOnMerge,
  stalePendingDeployEvents,
} from '../src/deploy.js';
import { fold } from '../src/fold.js';
import { appendEvents, loadAllEvents } from '../src/ledger.js';
import { isKnownType, makeEvent } from '../src/schema.js';

test('schema: deploy.requested and deploy.timed-out are known additive event types', () => {
  assert.equal(isKnownType('deploy.requested'), true);
  assert.equal(isKnownType('deploy.timed-out'), true);
  assert.equal(makeEvent('test', 'WI-001', 'deploy.requested', {}).type, 'deploy.requested');
  assert.equal(makeEvent('test', 'WI-001', 'deploy.timed-out', {
    reason: 'no receipt',
    requestedAt: '2026-01-01T00:00:00.000Z',
  }).type, 'deploy.timed-out');
});

test('fold: deploy lifecycle is explicit while deployed remains compatibility truth', () => {
  const base = [
    makeEvent('test', 'WI-001', 'item.captured', { source: 'test', text: 'ship' }, '2026-01-01T00:00:00.000Z'),
    makeEvent('test', 'WI-001', 'item.merged', { commit: 'abc', deployed: false }, '2026-01-01T00:01:00.000Z'),
  ];

  let rec = fold(base).items.get('WI-001')!;
  assert.equal(rec.deployStatus, 'not-configured');
  assert.equal(rec.deployed, false);

  const requested = makeEvent('dispatch', 'WI-001', 'deploy.requested', {}, '2026-01-01T00:02:00.000Z');
  rec = fold([...base, requested]).items.get('WI-001')!;
  assert.equal(rec.deployStatus, 'pending');
  assert.equal(rec.deployRequestedAt, requested.ts);
  assert.equal(rec.deployed, false);

  const timedOut = makeEvent('reactor', 'WI-001', 'deploy.timed-out', {
    reason: 'stale pending receipt',
    requestedAt: requested.ts,
  }, '2026-01-01T01:02:00.000Z');
  rec = fold([...base, requested, timedOut]).items.get('WI-001')!;
  assert.equal(rec.state, 'merged', 'a timeout is data-only and never rolls back the merge');
  assert.equal(rec.deployStatus, 'timed-out');
  assert.equal(rec.deployFailureReason, 'stale pending receipt');
  assert.equal(rec.deployed, false);

  const lateSuccess = makeEvent('deploy-hook', 'WI-001', 'deploy.succeeded', {
    commit: 'abc',
  }, '2026-01-01T01:03:00.000Z');
  rec = fold([...base, requested, timedOut, lateSuccess]).items.get('WI-001')!;
  assert.equal(rec.deployStatus, 'succeeded', 'a late terminal receipt remains latest-event truth');
  assert.equal(rec.deployFailureReason, undefined);
  assert.equal(rec.deployed, true);

  const retry = makeEvent('dispatch', 'WI-001', 'deploy.requested', {}, '2026-01-01T01:04:00.000Z');
  const failed = makeEvent('dispatch', 'WI-001', 'deploy.failed', {
    reason: 'spawn failed',
  }, '2026-01-01T01:04:01.000Z');
  rec = fold([...base, requested, timedOut, lateSuccess, retry, failed]).items.get('WI-001')!;
  assert.equal(rec.deployStatus, 'failed');
  assert.equal(rec.deployRequestedAt, retry.ts);
  assert.equal(rec.deployFailureReason, 'spawn failed');
  assert.equal(rec.deployed, false);
});

test('fold: legacy item.merged deployed:true stays compatible and projects succeeded', () => {
  const rec = fold([
    makeEvent('test', 'WI-002', 'item.captured', { source: 'test', text: 'legacy' }),
    makeEvent('test', 'WI-002', 'item.merged', { commit: 'legacy', deployed: true }),
  ]).items.get('WI-002')!;
  assert.equal(rec.deployed, true);
  assert.equal(rec.deployStatus, 'succeeded');
});

test('deploy: requested is durable before detached spawn is invoked', async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), 'deploy-request-order-'));
  try {
    await appendEvents(ledgerDir, [
      makeEvent('dispatch', 'WI-010', 'item.merged', { commit: 'abc', deployed: false }),
    ]);
    let observedRequestedAtSpawn = false;
    const spawnDeploy = (() => {
      const segment = readdirSync(ledgerDir).find(name => /^work-\d{4}-\d{2}\.jsonl$/.test(name));
      assert.ok(segment, 'the work segment must exist before spawn');
      const lines = readFileSync(join(ledgerDir, segment), 'utf8')
        .trim().split('\n').map(line => JSON.parse(line) as { type: string; item: string });
      observedRequestedAtSpawn = lines.some(e => e.type === 'deploy.requested' && e.item === 'WI-010');
      return { unref() {} };
    }) as unknown as DeploySpawn;

    const result = await requestDeployOnMerge({
      actor: 'dispatch',
      ledgerDir,
      repoRoot: ledgerDir,
      deployCommand: 'true',
      wiIds: ['WI-010'],
      spawnDeploy,
    });

    assert.equal(result.started, true);
    assert.equal(result.eventsWritten, 1);
    assert.equal(observedRequestedAtSpawn, true);
    const rec = fold(await loadAllEvents(ledgerDir)).items.get('WI-010')!;
    assert.equal(rec.deployStatus, 'pending');
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});

test('deploy: synchronous spawn failure appends failed after requested', async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), 'deploy-spawn-fail-'));
  try {
    await appendEvents(ledgerDir, [
      makeEvent('dispatch', 'WI-011', 'item.merged', { commit: 'def', deployed: false }),
    ]);
    const spawnDeploy = (() => {
      throw new Error('synthetic spawn failure');
    }) as unknown as DeploySpawn;

    const result = await requestDeployOnMerge({
      actor: 'dispatch',
      ledgerDir,
      repoRoot: ledgerDir,
      deployCommand: 'true',
      wiIds: ['WI-011'],
      spawnDeploy,
    });

    assert.equal(result.started, false);
    assert.equal(result.eventsWritten, 2);
    assert.match(result.reason ?? '', /synthetic spawn failure/);
    const events = (await loadAllEvents(ledgerDir)).filter(e => e.item === 'WI-011');
    assert.deepEqual(events.map(e => e.type), ['item.merged', 'deploy.requested', 'deploy.failed']);
    const rec = fold(events).items.get('WI-011')!;
    assert.equal(rec.deployStatus, 'failed');
    assert.equal(rec.deployed, false);
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});

test('deploy: stale pending timeout selection is exact, sorted, and idempotent after fold', () => {
  const requestedAt = '2026-01-01T00:00:00.000Z';
  const events = [
    makeEvent('test', 'WI-020', 'item.merged', { commit: 'a', deployed: false }, '2025-12-31T23:59:00.000Z'),
    makeEvent('test', 'WI-020', 'deploy.requested', {}, requestedAt),
    makeEvent('test', 'WI-003', 'item.merged', { commit: 'b', deployed: false }, '2025-12-31T23:59:00.000Z'),
    makeEvent('test', 'WI-003', 'deploy.requested', {}, requestedAt),
    makeEvent('test', 'WI-004', 'item.merged', { commit: 'c', deployed: false }, '2025-12-31T23:59:00.000Z'),
    makeEvent('test', 'WI-004', 'deploy.requested', {}, '2026-01-01T00:30:00.000Z'),
  ];
  const now = Date.parse('2026-01-01T01:00:00.000Z');
  const firstFold = fold(events);
  const timedOut = stalePendingDeployEvents(firstFold.items.values(), 'reactor', now, 3_600_000);

  assert.deepEqual(timedOut.map(e => e.item), ['WI-003', 'WI-020']);
  assert.ok(timedOut.every(e => e.type === 'deploy.timed-out'));
  assert.ok(timedOut.every(e => e.ts === '2026-01-01T01:00:00.000Z'));

  const secondFold = fold([...events, ...timedOut]);
  assert.deepEqual(
    stalePendingDeployEvents(secondFold.items.values(), 'reactor', now + 1, 3_600_000),
    [],
    'timed-out projection is terminal for this request, so later beats do not duplicate it',
  );
});
