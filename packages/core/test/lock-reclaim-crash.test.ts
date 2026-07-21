/**
 * lock-reclaim-crash.test.ts — beat-lock reclaim when the owner crashed MID-APPEND to its own
 * pid file.
 *
 * The empty-lock-dir and dead-pid cases are pinned in lock-reclaim.test.ts. This file covers the
 * remaining crash shape: a beat killed AFTER creating the lock dir + opening the pid file but
 * BEFORE finishing the write, leaving a partial/garbage/empty pid file. beatLockOwnerAlive
 * parseInt's the contents; non-numeric yields NaN then null ("no readable owner pid"), which the
 * acquire path must treat as reclaimable so a crash never wedges the lane. A LIVE numeric pid,
 * even with trailing residue, must still block.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { acquireReactorLock } from '../src/beats/reactor.js';
import { acquireDispatchLock, beatLockOwnerAlive } from '../src/beats/dispatch.js';

let testCount = 0;
function makeTempDir(): string {
  const dir = join(tmpdir(), `lock-crash-${process.pid}-${++testCount}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
function cleanDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

const DISPATCH_WEDGE_MS = 50 * 60 * 1000;

// A pid file whose write was interrupted leaves non-numeric / empty content.
const CRASH_PID_CONTENTS = ['', '   ', '\n', '12', 'not-a-pid', '  '];

test('beatLockOwnerAlive: a partial/garbage pid file reads as "no readable owner" (null), not alive', () => {
  const runDir = makeTempDir();
  try {
    const lockPath = join(runDir, 'x.lock');
    for (const contents of CRASH_PID_CONTENTS) {
      rmSync(lockPath, { recursive: true, force: true });
      mkdirSync(lockPath, { recursive: true });
      writeFileSync(join(lockPath, 'pid'), contents, 'utf8');
      const alive = beatLockOwnerAlive(lockPath);
      // '12' parses to a finite number, so it is a liveness question, not "unreadable";
      // every other crash residue is non-numeric -> null.
      if (contents.trim() === '12') {
        assert.notEqual(alive, null, `numeric pid content must be a liveness probe (got ${alive})`);
      } else {
        assert.equal(alive, null,
          `crash residue ${JSON.stringify(contents)} must read as no-readable-owner (got ${alive})`);
      }
    }
  } finally {
    cleanDir(runDir);
  }
});

test('reactor lock: a lock whose pid file was crash-truncated to garbage is reclaimed', () => {
  const runDir = makeTempDir();
  try {
    const lockPath = join(runDir, 'reactor.lock');
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(join(lockPath, 'pid'), 'not-a-pid', 'utf8'); // interrupted mid-append
    const lock = acquireReactorLock(runDir);
    assert.ok(lock, 'a crash-corrupted pid file must be reclaimed, not block the lane');
    assert.equal(lock.reclaimed, true);
    assert.ok(lock.reclaimedWhy?.includes('no readable owner pid'),
      `reclaim reason must name the unreadable owner (got: ${lock.reclaimedWhy})`);
    // The reclaimer re-stamps a valid pid so the next beat sees a live owner.
    assert.equal(readFileSync(join(lockPath, 'pid'), 'utf8').trim(), String(process.pid));
  } finally {
    cleanDir(runDir);
  }
});

test('reactor lock: an empty pid file (crash after open, before write) is reclaimed', () => {
  const runDir = makeTempDir();
  try {
    const lockPath = join(runDir, 'reactor.lock');
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(join(lockPath, 'pid'), '', 'utf8'); // opened, never written
    const lock = acquireReactorLock(runDir);
    assert.ok(lock, 'an empty pid file must be reclaimed');
    assert.equal(lock.reclaimed, true);
    assert.ok(lock.reclaimedWhy?.includes('no readable owner pid'),
      `reclaim reason must name the unreadable owner (got: ${lock.reclaimedWhy})`);
  } finally {
    cleanDir(runDir);
  }
});

test('dispatch lock: a crash-corrupted pid file is reclaimed regardless of age', () => {
  const runDir = makeTempDir();
  try {
    const lockPath = join(runDir, 'dispatch.lock');
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(join(lockPath, 'pid'), '\n', 'utf8'); // fresh mtime, unreadable content
    const lock = acquireDispatchLock(runDir, DISPATCH_WEDGE_MS);
    assert.ok(lock, 'a crash-corrupted pid must be reclaimed even when younger than the wedge threshold');
    assert.equal(lock.reclaimed, true);
    assert.ok(lock.reclaimedWhy?.includes('no readable owner pid'),
      `reclaim reason must name the unreadable owner (got: ${lock.reclaimedWhy})`);
  } finally {
    cleanDir(runDir);
  }
});

test('dispatch lock: a live pid with trailing crash residue still blocks (no false reclaim)', () => {
  const runDir = makeTempDir();
  try {
    const lockPath = join(runDir, 'dispatch.lock');
    mkdirSync(lockPath, { recursive: true });
    // A real, live owner whose write left trailing bytes -- parseInt stops at the number,
    // so liveness wins and the lock must be honoured (must NOT be reclaimed).
    writeFileSync(join(lockPath, 'pid'), `${process.pid}\n junk`, 'utf8');
    assert.equal(acquireDispatchLock(runDir, DISPATCH_WEDGE_MS), null,
      'a live-owner lock with trailing residue must still be treated as held');
  } finally {
    cleanDir(runDir);
  }
});
