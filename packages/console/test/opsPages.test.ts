/**
 * opsPages.test.ts — unit coverage for opsPages.ts's own logic (as opposed to server.test.ts's
 * end-to-end HTTP route coverage). Currently just the SLO board cache (WI-055 item 3):
 * `computeSloRows` runs several real `spawnSync` probes per call, so /health and /observability
 * cache the whole board for ~30s rather than re-probing on every GET.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig } from '@loopkit/core';

import { computeSloRows, resetSloCacheForTests } from '../src/opsPages.js';

async function withRepoRoot<T>(fn: (repoRoot: string) => Promise<T>): Promise<T> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'loopkit-opspages-test-'));
  try {
    return await fn(repoRoot);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

test('computeSloRows: a second call within the TTL window returns the cached rows (same reference)', async () => {
  await withRepoRoot(async (repoRoot) => {
    resetSloCacheForTests();
    const cfg = loadConfig(repoRoot);
    const runDir = join(repoRoot, 'runs', 'loopkit');
    const first = computeSloRows(cfg, repoRoot, runDir, []);
    const second = computeSloRows(cfg, repoRoot, runDir, []);
    // Same array instance — the second call never re-ran evaluateSloBoard's probes.
    assert.equal(second, first);
  });
});

test('computeSloRows: resetSloCacheForTests forces a fresh computation (new reference)', async () => {
  await withRepoRoot(async (repoRoot) => {
    resetSloCacheForTests();
    const cfg = loadConfig(repoRoot);
    const runDir = join(repoRoot, 'runs', 'loopkit');
    const first = computeSloRows(cfg, repoRoot, runDir, []);
    resetSloCacheForTests();
    const second = computeSloRows(cfg, repoRoot, runDir, []);
    assert.notEqual(second, first);
    // Still the same VALUE shape — clearing the cache changes identity, not correctness.
    assert.deepEqual(second, first);
  });
});

test('computeSloRows: two distinct repoRoot/runDir pairs never share a cache entry', async () => {
  await withRepoRoot(async (repoRootA) => {
    await withRepoRoot(async (repoRootB) => {
      resetSloCacheForTests();
      const cfgA = loadConfig(repoRootA);
      const cfgB = loadConfig(repoRootB);
      const runDirA = join(repoRootA, 'runs', 'loopkit');
      const runDirB = join(repoRootB, 'runs', 'loopkit');
      const a1 = computeSloRows(cfgA, repoRootA, runDirA, []);
      const b1 = computeSloRows(cfgB, repoRootB, runDirB, []);
      const a2 = computeSloRows(cfgA, repoRootA, runDirA, []);
      const b2 = computeSloRows(cfgB, repoRootB, runDirB, []);
      // Each key's own cache entry stays stable across repeated calls...
      assert.equal(a2, a1);
      assert.equal(b2, b1);
      // ...but the two keys never collide with each other's cached array.
      assert.notEqual(a1, b1);
    });
  });
});

test('computeSloRows: a live (non-cached) call still returns the real evaluateSloBoard shape', async () => {
  await withRepoRoot(async (repoRoot) => {
    resetSloCacheForTests();
    const cfg = loadConfig(repoRoot);
    const runDir = join(repoRoot, 'runs', 'loopkit');
    const rows = computeSloRows(cfg, repoRoot, runDir, []);
    assert.ok(Array.isArray(rows));
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.equal(typeof row.key, 'string');
      assert.equal(typeof row.status, 'string');
    }
  });
});
