/**
 * lock-reclaim.test.ts — stale-lock reclaim in the beat lock ACQUIRE path itself.
 *
 * An interrupted beat (kill/crash mid lock-acquisition) can leave an EMPTY lock dir (no
 * pid file) or a lock owned by a dead pid. The doctor's orphan handling runs too late for
 * this — a wedged beat can't run its own doctor — so acquireReactorLock/acquireDispatchLock
 * must treat both cases as stale and reclaim, while a lock owned by a LIVE pid still
 * blocks. Per beat: empty lock dir reclaimed · dead-pid lock reclaimed · live-pid blocks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { acquireReactorLock, runReactor } from '../src/beats/reactor.js';
import { acquireDispatchLock } from '../src/beats/dispatch.js';
import { LoopkitConfig, CONFIG_DEFAULTS } from '../src/config.js';

let testCount = 0;
function makeTempDir(): string {
  const dir = join(tmpdir(), `lock-reclaim-${process.pid}-${++testCount}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
function cleanDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** A pid that provably belonged to an already-exited process. */
function deadPid(): number {
  const r = spawnSync('true', { stdio: 'pipe' });
  assert.ok(r.pid && r.pid > 0, 'spawnSync must report the child pid');
  return r.pid;
}

const DISPATCH_WEDGE_MS = 50 * 60 * 1000;

// ── Reactor lock ───────────────────────────────────────────────────────────

test('reactor lock: an empty lock dir (no pid file) is reclaimed as stale', () => {
  const runDir = makeTempDir();
  try {
    mkdirSync(join(runDir, 'reactor.lock'), { recursive: true }); // interrupted acquisition residue
    const lock = acquireReactorLock(runDir);
    assert.ok(lock, 'a pid-less lock dir must be reclaimed, not block the lane');
    assert.equal(lock.reclaimed, true);
    assert.ok(lock.reclaimedWhy?.includes('no readable owner pid'),
      `reclaim reason must name the missing pid (got: ${lock.reclaimedWhy})`);
    // The reclaimer stamps its own pid so the NEXT beat sees a live owner.
    assert.equal(readFileSync(join(runDir, 'reactor.lock', 'pid'), 'utf8').trim(), String(process.pid));
  } finally {
    cleanDir(runDir);
  }
});

test('reactor lock: a lock owned by a dead pid is reclaimed as stale', () => {
  const runDir = makeTempDir();
  try {
    const lockPath = join(runDir, 'reactor.lock');
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(join(lockPath, 'pid'), String(deadPid()), 'utf8');
    const lock = acquireReactorLock(runDir);
    assert.ok(lock, 'a dead-owner lock must be reclaimed');
    assert.equal(lock.reclaimed, true);
    assert.ok(lock.reclaimedWhy?.includes('owner pid dead'),
      `reclaim reason must name the dead owner (got: ${lock.reclaimedWhy})`);
  } finally {
    cleanDir(runDir);
  }
});

test('reactor lock: a lock owned by a live pid still blocks', () => {
  const runDir = makeTempDir();
  try {
    const lockPath = join(runDir, 'reactor.lock');
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(join(lockPath, 'pid'), String(process.pid), 'utf8'); // this test process is alive
    assert.equal(acquireReactorLock(runDir), null, 'a live-owner lock must be treated as held');
    assert.ok(existsSync(join(lockPath, 'pid')), 'the held lock must be left untouched');
  } finally {
    cleanDir(runDir);
  }
});

test('reactor lock: a fresh acquisition stamps the owner pid', () => {
  const runDir = makeTempDir();
  try {
    const lock = acquireReactorLock(runDir);
    assert.ok(lock);
    assert.equal(lock.reclaimed, false);
    assert.equal(readFileSync(join(lock.lockPath, 'pid'), 'utf8').trim(), String(process.pid));
  } finally {
    cleanDir(runDir);
  }
});

// ── Dispatch lock ──────────────────────────────────────────────────────────

test('dispatch lock: an empty lock dir (no pid file) is reclaimed as stale regardless of age', () => {
  const runDir = makeTempDir();
  try {
    mkdirSync(join(runDir, 'dispatch.lock'), { recursive: true }); // fresh mtime, no pid
    const lock = acquireDispatchLock(runDir, DISPATCH_WEDGE_MS);
    assert.ok(lock, 'a pid-less lock dir must be reclaimed even when younger than the wedge threshold');
    assert.equal(lock.reclaimed, true);
    assert.ok(lock.reclaimedWhy?.includes('no readable owner pid'),
      `reclaim reason must name the missing pid (got: ${lock.reclaimedWhy})`);
    assert.equal(readFileSync(join(runDir, 'dispatch.lock', 'pid'), 'utf8').trim(), String(process.pid));
  } finally {
    cleanDir(runDir);
  }
});

test('dispatch lock: a lock owned by a dead pid is reclaimed as stale', () => {
  const runDir = makeTempDir();
  try {
    const lockPath = join(runDir, 'dispatch.lock');
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(join(lockPath, 'pid'), String(deadPid()), 'utf8');
    const lock = acquireDispatchLock(runDir, DISPATCH_WEDGE_MS);
    assert.ok(lock, 'a dead-owner lock must be reclaimed');
    assert.equal(lock.reclaimed, true);
    assert.ok(lock.reclaimedWhy?.includes('owner pid dead'),
      `reclaim reason must name the dead owner (got: ${lock.reclaimedWhy})`);
  } finally {
    cleanDir(runDir);
  }
});

test('dispatch lock: a lock owned by a live pid still blocks', () => {
  const runDir = makeTempDir();
  try {
    const lockPath = join(runDir, 'dispatch.lock');
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(join(lockPath, 'pid'), String(process.pid), 'utf8');
    assert.equal(acquireDispatchLock(runDir, DISPATCH_WEDGE_MS), null,
      'a live-owner lock must be treated as held');
  } finally {
    cleanDir(runDir);
  }
});

// ── Beat-detail surfacing ──────────────────────────────────────────────────

test('reactor beat: a reclaimed stale lock is surfaced in the step detail', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  try {
    const runDir = join(repoRoot, '.ai', 'runs', 'loopkit');
    mkdirSync(join(runDir, 'reactor.lock'), { recursive: true }); // stale: empty, no pid
    const config: LoopkitConfig = {
      ...CONFIG_DEFAULTS,
      gateCommand: 'exit 0',
      promptsDir: '.ai/loops/prompts',
      notifyHook: '.ai/notify-phone.sh',
    };
    const result = await runReactor({ repoRoot, ledgerDir, autonomy: 'on', provider: null, config });
    const lockStep = result.steps.find(s => s.step === 'lock');
    assert.ok(lockStep, 'a reclaimed lock must surface as a lock step');
    assert.ok(lockStep.ok, 'the reclaim step is informational, not a failure');
    assert.ok(lockStep.detail?.includes('reclaimed stale lock'),
      `step detail must say the stale lock was reclaimed (got: ${lockStep.detail})`);
  } finally {
    cleanDir(ledgerDir);
    cleanDir(repoRoot);
  }
});
