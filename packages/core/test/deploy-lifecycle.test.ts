import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
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

test('schema: deploy.requested, deploy.launched and deploy.timed-out are known additive event types', () => {
  assert.equal(isKnownType('deploy.requested'), true);
  assert.equal(isKnownType('deploy.launched'), true);
  assert.equal(isKnownType('deploy.timed-out'), true);
  assert.equal(makeEvent('test', 'WI-001', 'deploy.requested', {}).type, 'deploy.requested');
  assert.equal(makeEvent('test', 'WI-001', 'deploy.launched', { attempt: 1 }).type, 'deploy.launched');
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
  assert.equal(rec.deployLaunchCount, 0, 'a bare request has not yet recorded a launch attempt');

  const launched = makeEvent('dispatch', 'WI-001', 'deploy.launched', { attempt: 1 }, '2026-01-01T00:02:01.000Z');
  rec = fold([...base, requested, launched]).items.get('WI-001')!;
  assert.equal(rec.deployStatus, 'pending', 'a launch attempt is not itself a terminal receipt');
  assert.equal(rec.deployLaunchCount, 1);
  assert.equal(rec.deployLastLaunchedAt, launched.ts);

  const timedOut = makeEvent('reactor', 'WI-001', 'deploy.timed-out', {
    reason: 'stale pending receipt',
    requestedAt: requested.ts,
  }, '2026-01-01T01:02:00.000Z');
  rec = fold([...base, requested, launched, timedOut]).items.get('WI-001')!;
  assert.equal(rec.state, 'merged', 'a timeout is data-only and never rolls back the merge');
  assert.equal(rec.deployStatus, 'timed-out');
  assert.equal(rec.deployFailureReason, 'stale pending receipt');
  assert.equal(rec.deployed, false);

  const lateSuccess = makeEvent('deploy-hook', 'WI-001', 'deploy.succeeded', {
    commit: 'abc',
  }, '2026-01-01T01:03:00.000Z');
  rec = fold([...base, requested, launched, timedOut, lateSuccess]).items.get('WI-001')!;
  assert.equal(rec.deployStatus, 'succeeded', 'a late terminal receipt remains latest-event truth');
  assert.equal(rec.deployFailureReason, undefined);
  assert.equal(rec.deployed, true);

  const retry = makeEvent('dispatch', 'WI-001', 'deploy.requested', {}, '2026-01-01T01:04:00.000Z');
  const failed = makeEvent('dispatch', 'WI-001', 'deploy.failed', {
    reason: 'spawn failed',
  }, '2026-01-01T01:04:01.000Z');
  rec = fold([...base, requested, launched, timedOut, lateSuccess, retry, failed]).items.get('WI-001')!;
  assert.equal(rec.deployStatus, 'failed');
  assert.equal(rec.deployRequestedAt, retry.ts);
  assert.equal(rec.deployFailureReason, 'spawn failed');
  assert.equal(rec.deployed, false);
  assert.equal(rec.deployLaunchCount, 0, 'the retry cycle resets the launch counter for its own attempts');
});

test('fold: deploy.launched count resets per request cycle and never regresses across a retry', () => {
  const events = [
    makeEvent('test', 'WI-005', 'item.merged', {
      commit: 'a', deployed: false, deployConfigured: true,
    }, '2026-01-01T00:00:00.000Z'),
    makeEvent('dispatch', 'WI-005', 'deploy.requested', {}, '2026-01-01T00:01:00.000Z'),
    makeEvent('dispatch', 'WI-005', 'deploy.launched', { attempt: 1 }, '2026-01-01T00:01:01.000Z'),
    makeEvent('reactor', 'WI-005', 'deploy.launched', { attempt: 2 }, '2026-01-01T01:01:01.000Z'),
  ];
  let rec = fold(events).items.get('WI-005')!;
  assert.equal(rec.deployLaunchCount, 2, 'two recorded attempts on the same pending cycle');
  assert.equal(rec.deployLastLaunchedAt, '2026-01-01T01:01:01.000Z');

  const retried = [
    ...events,
    makeEvent('reactor', 'WI-005', 'deploy.timed-out', {
      reason: 'stale', requestedAt: '2026-01-01T00:01:00.000Z',
    }, '2026-01-01T02:00:00.000Z'),
    makeEvent('dispatch', 'WI-005', 'deploy.requested', {}, '2026-01-01T03:00:00.000Z'),
  ];
  rec = fold(retried).items.get('WI-005')!;
  assert.equal(rec.deployLaunchCount, 0, 'a fresh request cycle starts its own attempt count at zero');
  assert.equal(rec.deployLastLaunchedAt, undefined);
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
      makeEvent('dispatch', 'WI-010', 'item.merged', {
        commit: 'abc', deployed: false, deployConfigured: true,
      }),
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
      makeEvent('dispatch', 'WI-011', 'item.merged', {
        commit: 'def', deployed: false, deployConfigured: true,
      }),
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
    assert.deepEqual(events.map(e => e.type),
      ['item.merged', 'deploy.requested', 'deploy.launched', 'deploy.failed'],
      'the launch-attempt record is durable even though the synchronous spawn call itself threw');
    const rec = fold(events).items.get('WI-011')!;
    assert.equal(rec.deployStatus, 'failed');
    assert.equal(rec.deployed, false);
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});

test('deploy: expected commit is preflighted at launch and exported to the child', async () => {
  const base = mkdtempSync(join(tmpdir(), 'deploy-expected-commit-'));
  const repoRoot = join(base, 'repo');
  const ledgerDir = join(base, 'ledger');
  try {
    mkdirSync(repoRoot);
    spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'pipe' });
    spawnSync('git', ['config', 'user.email', 't@t'], { cwd: repoRoot, stdio: 'pipe' });
    spawnSync('git', ['config', 'user.name', 't'], { cwd: repoRoot, stdio: 'pipe' });
    writeFileSync(join(repoRoot, 'app.txt'), 'clean\n');
    spawnSync('git', ['add', 'app.txt'], { cwd: repoRoot, stdio: 'pipe' });
    spawnSync('git', ['commit', '-m', 'published'], { cwd: repoRoot, stdio: 'pipe' });
    const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim();
    await appendEvents(ledgerDir, [
      makeEvent('dispatch', 'WI-014', 'item.merged', {
        commit, deployed: false, deployConfigured: true,
      }),
    ]);
    let childCommit = '';
    const spawnDeploy = ((_command: string, _args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
      childCommit = options.env?.['DEPLOY_COMMIT'] ?? '';
      return spawn('sh', ['-c', 'true'], { cwd: repoRoot, detached: true, stdio: 'ignore' });
    }) as unknown as DeploySpawn;
    const result = await requestDeployOnMerge({
      actor: 'dispatch', ledgerDir, repoRoot, deployCommand: 'true',
      wiIds: ['WI-014'], expectedCommit: commit, spawnDeploy,
    });
    assert.equal(result.started, true);
    assert.equal(childCommit, commit);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('deploy: requested count remains truthful when the later failure receipt cannot persist', async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), 'deploy-failure-persist-'));
  try {
    await appendEvents(ledgerDir, [
      makeEvent('dispatch', 'WI-013', 'item.merged', {
        commit: 'jkl',
        deployed: false,
        deployConfigured: true,
      }),
    ]);
    const result = await requestDeployOnMerge({
      actor: 'dispatch',
      ledgerDir,
      repoRoot: ledgerDir,
      deployCommand: 'true',
      wiIds: ['WI-013'],
      spawnDeploy: (() => {
        throw new Error('synthetic launch failure');
      }) as unknown as DeploySpawn,
      persistEvents: async () => {
        throw new Error('synthetic receipt write failure');
      },
    });

    assert.equal(result.eventsWritten, 1, 'the already-durable request is not erased from accounting');
    assert.match(result.reason ?? '', /receipt persistence failed.*synthetic receipt write failure/);
    const events = await loadAllEvents(ledgerDir);
    assert.deepEqual(events.map(e => e.type), ['item.merged', 'deploy.requested', 'deploy.launched'],
      'the launch-attempt record is best-effort/independent of the later failure-receipt persistence failure');
    assert.equal(fold(events).items.get('WI-013')!.deployStatus, 'pending');
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});

test('deploy: asynchronous ChildProcess launch error appends failed after requested', async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), 'deploy-async-spawn-fail-'));
  try {
    await appendEvents(ledgerDir, [
      makeEvent('dispatch', 'WI-012', 'item.merged', {
        commit: 'ghi', deployed: false, deployConfigured: true,
      }),
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
    assert.deepEqual(events.map(e => e.type),
      ['item.merged', 'deploy.requested', 'deploy.launched', 'deploy.failed']);
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

// WI-219 (D18): the timeout reason must distinguish "launched and went silent" (reconciliation
// spawned it — per the durable deploy.launched record — but it never reported a terminal
// receipt) from "never launched" (reconciliation could not recover it at all, e.g. missing
// config/unresolvable target). Before this fix the reason text was identical for both, so a
// receipt asserting "timed out" could describe a deploy that never actually started.
test('deploy: timeout reason states whether the request was ever actually launched', () => {
  const requestedAt = '2026-01-01T00:00:00.000Z';
  const now = Date.parse('2026-01-01T01:00:00.000Z');

  const launchedThenSilent = fold([
    makeEvent('test', 'WI-070', 'item.merged', { commit: 'a', deployed: false }, '2025-12-31T23:59:00.000Z'),
    makeEvent('dispatch', 'WI-070', 'deploy.requested', {}, requestedAt),
    makeEvent('dispatch', 'WI-070', 'deploy.launched', { attempt: 1 }, '2026-01-01T00:00:01.000Z'),
  ]).items.values();
  const [launchedEvent] = stalePendingDeployEvents(launchedThenSilent, 'reactor', now, 3_600_000);
  const launchedReason = (launchedEvent.data as { reason: string }).reason;
  assert.match(launchedReason, /1 launch attempt/);
  assert.match(launchedReason, /spawned but never reported/);

  const neverLaunched = fold([
    makeEvent('test', 'WI-071', 'item.merged', { commit: 'b', deployed: false }, '2025-12-31T23:59:00.000Z'),
    makeEvent('dispatch', 'WI-071', 'deploy.requested', {}, requestedAt),
  ]).items.values();
  const [neverLaunchedEvent] = stalePendingDeployEvents(neverLaunched, 'reactor', now, 3_600_000);
  const neverLaunchedReason = (neverLaunchedEvent.data as { reason: string }).reason;
  assert.match(neverLaunchedReason, /without ever being launched/);
  assert.doesNotMatch(neverLaunchedReason, /launch attempt/);
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

test('deploy reconciliation: a missing request is recovered and launched exactly once (no age gate applies)', async () => {
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

    const items = fold(await loadAllEvents(ledgerDir)).items;
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
    // eventsWritten counts deploy.requested/deploy.failed only (the pre-existing accounting
    // contract, deliberately unchanged — WI-219 explicitly forbids inflating this counter as a
    // stand-in for real launch evidence). The durable deploy.launched record below is that
    // evidence instead.
    assert.equal(missingRequest.eventsWritten, 1);
    assert.equal(launches, 1);
    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.filter(e => e.item === 'WI-040' && e.type === 'deploy.requested').length, 1);
    assert.equal(events.filter(e => e.item === 'WI-040' && e.type === 'deploy.launched').length, 1);
    assert.equal(fold(events).items.get('WI-040')!.deployStatus, 'pending');
    assert.equal(fold(events).items.get('WI-040')!.deployLaunchCount, 1);
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});

// WI-219 (D17): a pending request already-recovered-and-still-in-flight must not be relaunched
// on every reconciliation pass — that was the bug (unbounded re-invocation, up to ~120
// concurrent spawns into the same beat's target). minPendingAgeMs is the fix's gate: a pending
// request younger than the threshold is presumed still in flight from the beat that requested
// it; only once it outlives at least one full beat interval without a terminal receipt does it
// become a genuine crash-recovery candidate.
test('deploy reconciliation: a pending intent younger than minPendingAgeMs is never relaunched', async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), 'deploy-reconcile-fresh-pending-'));
  try {
    const requestedAt = '2026-01-01T00:00:00.000Z';
    await appendEvents(ledgerDir, [
      makeEvent('dispatch', 'WI-041', 'item.merged', {
        commit: 'abc', deployed: false, deployConfigured: true,
      }, '2025-12-31T23:59:00.000Z'),
      makeEvent('dispatch', 'WI-041', 'deploy.requested', {}, requestedAt),
    ]);
    let launches = 0;
    const spawnDeploy = (() => {
      launches++;
      return spawn('sh', ['-c', 'true'], { cwd: ledgerDir, detached: true, stdio: 'ignore' });
    }) as unknown as DeploySpawn;

    const items = fold(await loadAllEvents(ledgerDir)).items;
    const result = await reconcileDeployIntents({
      ledgerDir,
      actor: 'reactor',
      items: items.values(),
      resolve: () => ({ ok: true, repoRoot: ledgerDir, deployCommand: 'true' }),
      spawnDeploy,
      minPendingAgeMs: 30_000,
      nowMs: Date.parse(requestedAt) + 5_000,
    });

    assert.equal(result.attempted, 0, 'the fresh pending intent is not even a candidate this pass');
    assert.equal(result.eventsWritten, 0);
    assert.equal(launches, 0, 'a sub-interval-old pending request must never be relaunched');
    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.filter(e => e.item === 'WI-041' && e.type === 'deploy.launched').length, 0);
    assert.equal(fold(events).items.get('WI-041')!.deployStatus, 'pending');
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});

test('deploy reconciliation: a pending intent older than minPendingAgeMs is recovered exactly once', async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), 'deploy-reconcile-stale-pending-'));
  try {
    const requestedAt = '2026-01-01T00:00:00.000Z';
    await appendEvents(ledgerDir, [
      makeEvent('dispatch', 'WI-042', 'item.merged', {
        commit: 'abc', deployed: false, deployConfigured: true,
      }, '2025-12-31T23:59:00.000Z'),
      makeEvent('dispatch', 'WI-042', 'deploy.requested', {}, requestedAt),
    ]);
    let launches = 0;
    const spawnDeploy = (() => {
      launches++;
      return spawn('sh', ['-c', 'true'], { cwd: ledgerDir, detached: true, stdio: 'ignore' });
    }) as unknown as DeploySpawn;

    const items = fold(await loadAllEvents(ledgerDir)).items;
    const result = await reconcileDeployIntents({
      ledgerDir,
      actor: 'reactor',
      items: items.values(),
      resolve: () => ({ ok: true, repoRoot: ledgerDir, deployCommand: 'true' }),
      spawnDeploy,
      minPendingAgeMs: 30_000,
      nowMs: Date.parse(requestedAt) + 45_000,
    });

    assert.equal(result.attempted, 1, 'the now-stale pending intent is a genuine recovery candidate');
    assert.equal(result.eventsWritten, 0, 'no NEW deploy.requested — the request was already durable');
    assert.equal(launches, 1, 'exactly one recovery relaunch');
    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.filter(e => e.item === 'WI-042' && e.type === 'deploy.requested').length, 1,
      'still exactly one request receipt — no duplicate');
    assert.equal(events.filter(e => e.item === 'WI-042' && e.type === 'deploy.launched').length, 1,
      'the durable launch-attempt record is the ledger evidence of the recovery spawn');
    assert.equal(fold(events).items.get('WI-042')!.deployStatus, 'pending');
    assert.equal(fold(events).items.get('WI-042')!.deployLaunchCount, 1);
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});

test('deploy reconciliation: a pending intent with no minPendingAgeMs argument keeps legacy always-eligible behavior', async () => {
  // Callers that don't pass minPendingAgeMs (e.g. a future direct caller outside the reactor
  // beat) keep the pre-WI-219 unconditional-recovery behavior — the gate is opt-in via the
  // argument, not a silent behavior change to every caller of reconcileDeployIntents.
  const ledgerDir = mkdtempSync(join(tmpdir(), 'deploy-reconcile-default-age-'));
  try {
    await appendEvents(ledgerDir, [
      makeEvent('dispatch', 'WI-043', 'item.merged', {
        commit: 'abc', deployed: false, deployConfigured: true,
      }),
      makeEvent('dispatch', 'WI-043', 'deploy.requested', {}),
    ]);
    let launches = 0;
    const spawnDeploy = (() => {
      launches++;
      return spawn('sh', ['-c', 'true'], { cwd: ledgerDir, detached: true, stdio: 'ignore' });
    }) as unknown as DeploySpawn;

    const items = fold(await loadAllEvents(ledgerDir)).items;
    const result = await reconcileDeployIntents({
      ledgerDir,
      actor: 'reactor',
      items: items.values(),
      resolve: () => ({ ok: true, repoRoot: ledgerDir, deployCommand: 'true' }),
      spawnDeploy,
    });

    assert.equal(result.attempted, 1);
    assert.equal(launches, 1);
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

test('deploy reconciliation: pending target intent rechecks expected commit and fails dirty checkout without spawning', async () => {
  const base = mkdtempSync(join(tmpdir(), 'deploy-reconcile-target-preflight-'));
  const targetRoot = join(base, 'target');
  const ledgerDir = join(base, 'ledger');
  try {
    mkdirSync(targetRoot);
    spawnSync('git', ['init', '-b', 'main'], { cwd: targetRoot, stdio: 'pipe' });
    spawnSync('git', ['config', 'user.email', 't@t'], { cwd: targetRoot, stdio: 'pipe' });
    spawnSync('git', ['config', 'user.name', 't'], { cwd: targetRoot, stdio: 'pipe' });
    writeFileSync(join(targetRoot, 'app.txt'), 'published\n');
    spawnSync('git', ['add', 'app.txt'], { cwd: targetRoot, stdio: 'pipe' });
    spawnSync('git', ['commit', '-m', 'published'], { cwd: targetRoot, stdio: 'pipe' });
    const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: targetRoot, encoding: 'utf8' }).stdout.trim();
    await appendEvents(ledgerDir, [
      makeEvent('cli', 'WI-052', 'item.captured', {
        source: 'test', text: 'target work', target: 'customer-app',
      }),
      makeEvent('dispatch', 'WI-052', 'item.merged', {
        commit, deployed: false, deployConfigured: true,
      }),
      makeEvent('dispatch', 'WI-052', 'deploy.requested', {}),
    ]);
    writeFileSync(join(targetRoot, 'app.txt'), 'editor draft\n');
    let spawnCalls = 0;
    const result = await reconcileDeployIntents({
      ledgerDir,
      actor: 'reactor',
      items: fold(await loadAllEvents(ledgerDir)).items.values(),
      resolve: () => ({
        ok: true, repoRoot: targetRoot, deployCommand: 'true', expectedCommit: commit,
      }),
      spawnDeploy: (() => {
        spawnCalls++;
        return spawn('sh', ['-c', 'true'], { cwd: targetRoot, detached: true, stdio: 'ignore' });
      }) as unknown as DeploySpawn,
    });
    assert.equal(spawnCalls, 0);
    assert.equal(result.eventsWritten, 1, 'the existing pending request closes with one failed receipt');
    const rec = fold(await loadAllEvents(ledgerDir)).items.get('WI-052')!;
    assert.equal(rec.deployStatus, 'failed');
    assert.match(rec.deployFailureReason ?? '', /deploy checkout preflight failed/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('deploy reconciliation: older pending target item preflights the current newer target tip', async () => {
  const base = mkdtempSync(join(tmpdir(), 'deploy-reconcile-newer-target-tip-'));
  const targetRoot = join(base, 'target');
  const ledgerDir = join(base, 'ledger');
  try {
    mkdirSync(targetRoot);
    spawnSync('git', ['init', '-b', 'main'], { cwd: targetRoot, stdio: 'pipe' });
    spawnSync('git', ['config', 'user.email', 't@t'], { cwd: targetRoot, stdio: 'pipe' });
    spawnSync('git', ['config', 'user.name', 't'], { cwd: targetRoot, stdio: 'pipe' });
    writeFileSync(join(targetRoot, 'app.txt'), 'older\n');
    spawnSync('git', ['add', 'app.txt'], { cwd: targetRoot, stdio: 'pipe' });
    spawnSync('git', ['commit', '-m', 'older merge'], { cwd: targetRoot, stdio: 'pipe' });
    const older = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: targetRoot, encoding: 'utf8' }).stdout.trim();
    writeFileSync(join(targetRoot, 'newer.txt'), 'newer\n');
    spawnSync('git', ['add', 'newer.txt'], { cwd: targetRoot, stdio: 'pipe' });
    spawnSync('git', ['commit', '-m', 'newer merge'], { cwd: targetRoot, stdio: 'pipe' });
    const currentTip = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: targetRoot, encoding: 'utf8' }).stdout.trim();
    await appendEvents(ledgerDir, [
      makeEvent('cli', 'WI-053', 'item.captured', {
        source: 'test', text: 'older target work', target: 'customer-app',
      }),
      makeEvent('dispatch', 'WI-053', 'item.merged', {
        commit: older, deployed: false, deployConfigured: true,
      }),
      makeEvent('dispatch', 'WI-053', 'deploy.requested', {}),
    ]);
    let exportedCommit = '';
    const result = await reconcileDeployIntents({
      ledgerDir,
      actor: 'reactor',
      items: fold(await loadAllEvents(ledgerDir)).items.values(),
      resolve: () => ({
        ok: true, repoRoot: targetRoot, deployCommand: 'true', expectedCommit: currentTip,
      }),
      spawnDeploy: ((_command: string, _args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
        exportedCommit = options.env?.['DEPLOY_COMMIT'] ?? '';
        return spawn('sh', ['-c', 'true'], { cwd: targetRoot, detached: true, stdio: 'ignore' });
      }) as unknown as DeploySpawn,
    });
    assert.equal(result.failures.length, 0);
    assert.equal(exportedCommit, currentTip);
    assert.notEqual(exportedCommit, older, 'historical item commit must not falsely pin an older target tip');
    assert.equal(fold(await loadAllEvents(ledgerDir)).items.get('WI-053')?.deployStatus, 'pending');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('deploy reconciliation: concurrent requested plus success wins before a stale missing-request claim', async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), 'deploy-reconcile-claim-race-'));
  try {
    await appendEvents(ledgerDir, [
      makeEvent('dispatch', 'WI-060', 'item.merged', {
        commit: 'abc', deployed: false, deployConfigured: true,
      }),
    ]);
    const staleItems = fold(await loadAllEvents(ledgerDir)).items;
    let launches = 0;
    const spawnDeploy = (() => {
      launches++;
      return spawn('sh', ['-c', 'true'], { cwd: ledgerDir, detached: true, stdio: 'ignore' });
    }) as unknown as DeploySpawn;

    const result = await reconcileDeployIntents({
      ledgerDir,
      actor: 'reactor',
      items: staleItems.values(),
      resolve: () => ({ ok: true, repoRoot: ledgerDir, deployCommand: 'true' }),
      spawnDeploy,
      beforeCandidate: async rec => {
        if (rec.id !== 'WI-060') return;
        await appendEvents(ledgerDir, [
          makeEvent('dispatch', rec.id, 'deploy.requested', {}),
          makeEvent('deploy-hook', rec.id, 'deploy.succeeded', { commit: 'abc' }),
        ]);
      },
    });

    assert.equal(result.eventsWritten, 0);
    assert.equal(launches, 0, 'a fresh terminal fold suppresses the stale launch');
    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.filter(e => e.item === 'WI-060' && e.type === 'deploy.requested').length, 1);
    assert.equal(fold(events).items.get('WI-060')!.deployStatus, 'succeeded');
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});

test('deploy reconciliation: concurrent success suppresses stale missing-config failure', async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), 'deploy-reconcile-config-race-'));
  try {
    await appendEvents(ledgerDir, [
      makeEvent('dispatch', 'WI-061', 'item.merged', {
        commit: 'def', deployed: false, deployConfigured: true,
      }),
    ]);
    const staleItems = fold(await loadAllEvents(ledgerDir)).items;
    const result = await reconcileDeployIntents({
      ledgerDir,
      actor: 'reactor',
      items: staleItems.values(),
      resolve: () => ({ ok: false, reason: 'configured deploy command disappeared' }),
      beforeCandidate: async rec => {
        await appendEvents(ledgerDir, [
          makeEvent('dispatch', rec.id, 'deploy.requested', {}),
          makeEvent('deploy-hook', rec.id, 'deploy.succeeded', { commit: 'def' }),
        ]);
      },
    });

    assert.equal(result.eventsWritten, 0);
    assert.deepEqual(result.failures, []);
    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.filter(e => e.item === 'WI-061' && e.type === 'deploy.failed').length, 0);
    assert.equal(fold(events).items.get('WI-061')!.deployStatus, 'succeeded');
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});
