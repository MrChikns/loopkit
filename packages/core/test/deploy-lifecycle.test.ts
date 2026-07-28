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
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

import {
  DeploySpawn,
} from '../src/beats/worktree-deps.js';
import {
  closeStalePendingDeploys,
  reconcileDeployIntents,
  requestDeployOnMerge,
  resumePendingDeploy,
  stalePendingDeployEvents,
} from '../src/deploy.js';
import { fold } from '../src/fold.js';
import { appendEvents, loadAllEvents, withLock } from '../src/ledger.js';
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
    makeEvent('test', 'WI-001', 'item.merged', {
      commit: 'abc',
      deployed: false,
      deployConfigured: false,
    }, '2026-01-01T00:01:00.000Z'),
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

test('fold: legacy merge booleans remain compatibility history and lifecycle stays unknown', () => {
  const events = [
    makeEvent('test', 'WI-002', 'item.merged', { commit: 'legacy-true', deployed: true }),
    makeEvent('test', 'WI-003', 'item.merged', { commit: 'legacy-false', deployed: false }),
    makeEvent('test', 'WI-004', 'item.merged', { commit: 'legacy-absent' }),
  ];
  const items = fold(events).items;
  assert.equal(items.get('WI-002')!.deployed, true);
  assert.equal(items.get('WI-002')!.deployStatus, undefined);
  assert.equal(items.get('WI-003')!.deployed, false);
  assert.equal(items.get('WI-003')!.deployStatus, undefined);
  assert.equal(items.get('WI-004')!.deployed, undefined);
  assert.equal(items.get('WI-004')!.deployStatus, undefined);
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
      return spawn('sh', ['-c', 'true'], { cwd: ledgerDir, detached: true, stdio: 'ignore' });
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

test('deploy: requested count remains truthful when the later failure receipt cannot persist', async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), 'deploy-failure-persist-'));
  try {
    let persistenceCalls = 0;
    const result = await requestDeployOnMerge({
      actor: 'dispatch',
      ledgerDir,
      repoRoot: ledgerDir,
      deployCommand: 'true',
      wiIds: ['WI-013'],
      spawnDeploy: (() => {
        throw new Error('synthetic launch failure');
      }) as unknown as DeploySpawn,
      persistEvents: async (dir, events) => {
        persistenceCalls++;
        if (persistenceCalls > 1) throw new Error('synthetic receipt write failure');
        await appendEvents(dir, events);
      },
    });

    assert.equal(result.eventsWritten, 1, 'the already-durable request is not erased from accounting');
    assert.match(result.reason ?? '', /receipt persistence failed.*synthetic receipt write failure/);
    const events = await loadAllEvents(ledgerDir);
    assert.deepEqual(events.map(e => e.type), ['deploy.requested']);
    assert.equal(fold(events).items.get('WI-013')!.deployStatus, 'pending');
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});

test('deploy: asynchronous ChildProcess launch error appends failed after requested', async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), 'deploy-async-spawn-fail-'));
  try {
    await appendEvents(ledgerDir, [
      makeEvent('dispatch', 'WI-012', 'item.merged', { commit: 'ghi', deployed: false }),
    ]);

    const result = await requestDeployOnMerge({
      actor: 'dispatch',
      ledgerDir,
      repoRoot: join(ledgerDir, 'missing-cwd'),
      deployCommand: 'true',
      wiIds: ['WI-012'],
    });

    assert.equal(result.started, false);
    assert.equal(result.eventsWritten, 2);
    assert.match(result.reason ?? '', /ENOENT|no such file or directory/i);
    const events = (await loadAllEvents(ledgerDir)).filter(e => e.item === 'WI-012');
    assert.deepEqual(events.map(e => e.type), ['item.merged', 'deploy.requested', 'deploy.failed']);
    assert.equal(fold(events).items.get('WI-012')!.deployStatus, 'failed');
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

test('deploy: terminal receipt committed before timeout lock acquisition prevents timeout', async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), 'deploy-timeout-race-'));
  try {
    const requestedAt = '2026-01-01T00:00:00.000Z';
    await appendEvents(ledgerDir, [
      makeEvent('test', 'WI-030', 'item.merged', { commit: 'abc', deployed: false }, '2025-12-31T23:59:00.000Z'),
      makeEvent('dispatch', 'WI-030', 'deploy.requested', {}, requestedAt),
    ]);

    let timeoutAttempt!: Promise<ReturnType<typeof stalePendingDeployEvents>>;
    await withLock(ledgerDir, async tx => {
      await tx.append([
        makeEvent('deploy-hook', 'WI-030', 'deploy.succeeded', { commit: 'abc' }, '2026-01-01T00:59:59.000Z'),
      ]);
      timeoutAttempt = closeStalePendingDeploys({
        ledgerDir,
        actor: 'reactor',
        nowMs: Date.parse('2026-01-01T01:00:00.000Z'),
        timeoutMs: 3_600_000,
      });
    });

    assert.deepEqual(await timeoutAttempt, []);
    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.filter(e => e.item === 'WI-030' && e.type === 'deploy.timed-out').length, 0);
    assert.equal(fold(events).items.get('WI-030')!.deployStatus, 'succeeded');

    assert.deepEqual(await closeStalePendingDeploys({
      ledgerDir,
      actor: 'reactor',
      nowMs: Date.parse('2026-01-01T02:00:00.000Z'),
      timeoutMs: 3_600_000,
    }), [], 'a later beat cannot append a timeout after any terminal receipt');
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});

test('deploy reconciliation: plane crash windows are at-least-once without duplicate request receipts', async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), 'deploy-reconcile-plane-'));
  try {
    await appendEvents(ledgerDir, [
      makeEvent('dispatch', 'WI-040', 'item.merged', {
        commit: 'abc',
        deployed: false,
        deployConfigured: true,
      }),
    ]);
    let launches = 0;
    const spawnDeploy = (() => {
      launches++;
      return spawn('sh', ['-c', 'true'], { cwd: ledgerDir, detached: true, stdio: 'ignore' });
    }) as unknown as DeploySpawn;

    let items = fold(await loadAllEvents(ledgerDir)).items;
    const missingRequest = await reconcileDeployIntents({
      ledgerDir,
      actor: 'reactor',
      items: items.values(),
      resolve: rec => {
        assert.equal(rec.target, undefined);
        return { ok: true, repoRoot: ledgerDir, deployCommand: 'true' };
      },
      spawnDeploy,
    });
    assert.equal(missingRequest.eventsWritten, 1);
    assert.equal(launches, 1);

    items = fold(await loadAllEvents(ledgerDir)).items;
    const pendingRequest = await reconcileDeployIntents({
      ledgerDir,
      actor: 'reactor',
      items: items.values(),
      resolve: () => ({ ok: true, repoRoot: ledgerDir, deployCommand: 'true' }),
      spawnDeploy,
    });
    assert.equal(pendingRequest.eventsWritten, 0);
    assert.equal(launches, 2, 'pending intent is safely re-invoked after restart');
    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.filter(e => e.item === 'WI-040' && e.type === 'deploy.requested').length, 1);
    assert.equal(fold(events).items.get('WI-040')!.deployStatus, 'pending');
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});

test('deploy reconciliation: success before resumed launch failure suppresses a lying failed receipt', async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), 'deploy-resume-race-'));
  try {
    await appendEvents(ledgerDir, [
      makeEvent('dispatch', 'WI-045', 'item.merged', {
        commit: 'abc',
        deployed: false,
        deployConfigured: true,
      }),
      makeEvent('dispatch', 'WI-045', 'deploy.requested', {}, '2026-01-01T00:00:00.000Z'),
    ]);
    const spawnDeploy = (() => {
      const child = new EventEmitter() as EventEmitter & { unref(): void };
      child.unref = () => {};
      queueMicrotask(async () => {
        await appendEvents(ledgerDir, [
          makeEvent('deploy-hook', 'WI-045', 'deploy.succeeded', { commit: 'abc' }),
        ]);
        child.emit('error', new Error('synthetic resumed launch failure'));
      });
      return child;
    }) as unknown as DeploySpawn;

    const result = await resumePendingDeploy({
      actor: 'reactor',
      ledgerDir,
      repoRoot: ledgerDir,
      deployCommand: 'true',
      wiIds: ['WI-045'],
      spawnDeploy,
    });

    assert.equal(result.started, false);
    assert.equal(result.eventsWritten, 0);
    assert.equal(result.reason, undefined, 'the now-terminal item suppresses the stale spawn error');
    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.filter(e => e.item === 'WI-045' && e.type === 'deploy.failed').length, 0);
    assert.equal(fold(events).items.get('WI-045')!.deployStatus, 'succeeded');
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});

test('deploy reconciliation: target crash recovery uses target execution and missing config fails visibly', async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), 'deploy-reconcile-target-'));
  const targetRoot = mkdtempSync(join(tmpdir(), 'deploy-reconcile-target-repo-'));
  try {
    await appendEvents(ledgerDir, [
      makeEvent('cli', 'WI-050', 'item.captured', {
        source: 'test',
        text: 'target work',
        target: 'customer-app',
      }),
      makeEvent('dispatch', 'WI-050', 'item.merged', {
        commit: 'def',
        deployed: false,
        deployConfigured: true,
      }),
      makeEvent('dispatch', 'WI-051', 'item.merged', {
        commit: 'ghi',
        deployed: false,
        deployConfigured: true,
      }),
    ]);
    const items = fold(await loadAllEvents(ledgerDir)).items;
    let targetLaunches = 0;
    const spawnDeploy = (() => {
      targetLaunches++;
      return spawn('sh', ['-c', 'true'], { cwd: targetRoot, detached: true, stdio: 'ignore' });
    }) as unknown as DeploySpawn;

    const result = await reconcileDeployIntents({
      ledgerDir,
      actor: 'reactor',
      items: items.values(),
      resolve: rec => rec.target === 'customer-app'
        ? { ok: true, repoRoot: targetRoot, deployCommand: 'true' }
        : { ok: false, reason: 'deploy reconciliation failed: configured plane command is no longer available' },
      spawnDeploy,
    });
    assert.equal(targetLaunches, 1);
    assert.equal(result.eventsWritten, 2, 'target request plus visible failure receipt are durable');
    const after = fold(await loadAllEvents(ledgerDir)).items;
    assert.equal(after.get('WI-050')!.deployStatus, 'pending');
    assert.equal(after.get('WI-051')!.deployStatus, 'failed');
    assert.match(after.get('WI-051')!.deployFailureReason ?? '', /no longer available/);
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
    rmSync(targetRoot, { recursive: true, force: true });
  }
});
