import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { CONFIG_DEFAULTS, loadConfig, LoopkitConfig } from '../src/config.js';
import {
  countInFlightWorkerSlots,
  engineeringInflightTouches,
  nextWorkerCapacityLane,
  runDispatch,
  selectWithinWorkerCapacity,
} from '../src/beats/dispatch.js';
import { appendEvents, loadAllEvents } from '../src/ledger.js';
import { fold, ItemRecord } from '../src/fold.js';
import { makeEvent } from '../src/schema.js';

function rec(id: string): ItemRecord {
  return {
    id, state: 'queued', attempts: 0, builds: [], messages: [], lane: 'engineering',
    spec: id, priority: 'medium',
  } as unknown as ItemRecord;
}

test('worker capacity: config defaults to a finite preview limit and rejects invalid values', () => {
  assert.equal(loadConfig('/missing-loopkit-capacity-config').execution?.maxConcurrentWorkers, 2);
  const repo = mkdtempSync(join(tmpdir(), 'loopkit-worker-cap-config-'));
  try {
    for (const bad of [0, -1, 1.5, Number.POSITIVE_INFINITY, '2']) {
      writeFileSync(join(repo, 'loopkit.config.json'), JSON.stringify({
        execution: { maxConcurrentWorkers: bad },
      }));
      assert.throws(
        () => loadConfig(repo),
        /execution\.maxConcurrentWorkers must be a positive integer/,
      );
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('worker capacity: mixed lanes share slots, target cannot starve, and co-location counts once', () => {
  const t1 = rec('WI-101');
  const t2 = rec('WI-102');
  const e1 = rec('WI-201');
  const e2 = rec('WI-202');
  const e3 = rec('WI-203');
  const selected = selectWithinWorkerCapacity([t1, t2], [[e1, e2], [e3]], 2);
  assert.deepEqual(selected.targeted.map(r => r.id), ['WI-101']);
  assert.deepEqual(selected.engineering.map(g => g.map(r => r.id)), [['WI-201', 'WI-202']],
    'two co-located items consume one engineering worker slot');
  assert.equal(selected.deferredItems, 2);
  assert.deepEqual(
    selectWithinWorkerCapacity([t1], [[e1]], 1).targeted.map(r => r.id),
    ['WI-101'],
    'the last mixed-lane slot protects the target lane from starvation',
  );
});

test('worker capacity: maxWorkers=1 alternates mixed lanes across consecutive beat histories', () => {
  const target = { ...rec('WI-111'), target: 'docs' };
  const engineering = rec('WI-211');
  const items = new Map([[target.id, target], [engineering.id, engineering]]);
  const baseEvents = [
    makeEvent('cli', target.id, 'item.captured', { source: 'test', text: 'target', target: 'docs' }),
    makeEvent('cli', engineering.id, 'item.captured', { source: 'test', text: 'engineering' }),
  ];

  const beat1Lane = nextWorkerCapacityLane(baseEvents, items);
  const beat1 = selectWithinWorkerCapacity([target], [[engineering]], 1, beat1Lane);
  assert.deepEqual(beat1.targeted.map(r => r.id), [target.id]);

  const afterTarget = [
    ...baseEvents,
    makeEvent('dispatch', target.id, 'build.dispatched', { attempt: 1 }),
  ];
  const beat2Lane = nextWorkerCapacityLane(afterTarget, items);
  const beat2 = selectWithinWorkerCapacity([target], [[engineering]], 1, beat2Lane);
  assert.deepEqual(beat2.engineering.map(group => group.map(r => r.id)), [[engineering.id]],
    'engineering receives the next free slot after a target admission');

  const afterEngineering = [
    ...afterTarget,
    makeEvent('dispatch', engineering.id, 'build.dispatched', { attempt: 1 }),
  ];
  assert.equal(nextWorkerCapacityLane(afterEngineering, items), 'target',
    'the durable tie-break flips back after engineering is admitted');
});

test('worker capacity: active target paths do not consume the free plane-engineering slot', () => {
  const activeTarget = {
    ...rec('WI-121'),
    state: 'building',
    target: 'docs',
    touches: undefined,
    currentBuild: { attempt: 1, pgid: 9101, worktree: '/tmp/target', branch: 'target-a1' },
  } as unknown as ItemRecord;
  const engineering = { ...rec('WI-221'), touches: 'src/' };

  assert.equal(engineeringInflightTouches([activeTarget]), undefined,
    'unknown target Touches belong to another repo and must not wildcard-block plane paths');
  const selected = selectWithinWorkerCapacity(
    [],
    [[engineering]],
    2 - countInFlightWorkerSlots(
      { items: new Map([[activeTarget.id, activeTarget]]) } as ReturnType<typeof fold>,
      '/missing-artifacts',
    ),
  );
  assert.deepEqual(selected.engineering.map(group => group.map(r => r.id)), [[engineering.id]]);
});

test('worker capacity: detached co-located members sharing one pgid consume one active slot', () => {
  const artifactDir = mkdtempSync(join(tmpdir(), 'loopkit-worker-cap-artifacts-'));
  try {
    const events = [
      makeEvent('cli', 'WI-301', 'item.captured', { source: 'test', text: 'a' }),
      makeEvent('reactor', 'WI-301', 'item.queued', { spec: 'a' }),
      makeEvent('dispatch', 'WI-301', 'build.dispatched', {
        attempt: 1, pgid: 7001, worktree: '/tmp/shared', branch: 'wi-301-a1',
      }),
      makeEvent('cli', 'WI-302', 'item.captured', { source: 'test', text: 'b' }),
      makeEvent('reactor', 'WI-302', 'item.queued', { spec: 'b' }),
      makeEvent('dispatch', 'WI-302', 'build.dispatched', {
        attempt: 1, pgid: 7001, worktree: '/tmp/shared', branch: 'wi-301-a1',
      }),
      makeEvent('cli', 'WI-303', 'item.captured', { source: 'test', text: 'c' }),
      makeEvent('reactor', 'WI-303', 'item.queued', { spec: 'c' }),
      makeEvent('dispatch', 'WI-303', 'build.dispatched', {
        attempt: 1, pgid: 7002, worktree: '/tmp/other', branch: 'wi-303-a1',
      }),
    ];
    assert.equal(countInFlightWorkerSlots(fold(events), artifactDir), 2);
  } finally {
    rmSync(artifactDir, { recursive: true, force: true });
  }
});

test('worker capacity: full detached occupancy is applied before claims; overflow has zero state churn', async () => {
  const base = mkdtempSync(join(tmpdir(), 'loopkit-worker-cap-claim-'));
  const repoRoot = join(base, 'repo');
  const ledgerDir = join(base, 'ledger');
  const runDir = join(base, 'runs');
  try {
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });
    mkdirSync(ledgerDir, { recursive: true });
    spawnSync('git', ['init', '-b', 'master'], { cwd: repoRoot, stdio: 'pipe' });
    spawnSync('git', ['config', 'user.email', 't@t'], { cwd: repoRoot, stdio: 'pipe' });
    spawnSync('git', ['config', 'user.name', 't'], { cwd: repoRoot, stdio: 'pipe' });
    writeFileSync(join(repoRoot, 'base.txt'), 'base\n');
    spawnSync('git', ['add', 'base.txt'], { cwd: repoRoot, stdio: 'pipe' });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: repoRoot, stdio: 'pipe' });

    await appendEvents(ledgerDir, [
      makeEvent('cli', 'WI-401', 'item.captured', { source: 'test', text: 'active', target: 'notes' }),
      makeEvent('reactor', 'WI-401', 'item.queued', { spec: 'active' }),
      makeEvent('dispatch', 'WI-401', 'build.dispatched', {
        attempt: 1, pgid: 8001, worktree: join(base, 'active-wt'), branch: 'loop-wi-401-a1',
      }),
      makeEvent('cli', 'WI-402', 'item.captured', { source: 'test', text: 'overflow', target: 'notes' }),
      makeEvent('reactor', 'WI-402', 'item.queued', { spec: 'overflow' }),
    ]);
    const before = await loadAllEvents(ledgerDir);
    const config: LoopkitConfig = {
      ...CONFIG_DEFAULTS,
      execution: { detachedDispatch: true, maxConcurrentWorkers: 1 },
    };
    await runDispatch({
      repoRoot,
      ledgerDir,
      runDir,
      artifactRunsDir: runDir,
      autonomy: 'on',
      provider: null,
      config,
      authProbeResult: { ok: true },
      commitResidue: () => ({ committed: false, detail: 'test no-op' }),
    });
    const after = await loadAllEvents(ledgerDir);
    assert.deepEqual(after, before, 'capacity overflow must append no claim or lifecycle event');
    assert.equal(fold(after).items.get('WI-402')?.state, 'queued');
    assert.equal(after.some(e => e.item === 'WI-402' && e.type === 'item.claimed'), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
