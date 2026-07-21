/**
 * judge-diff-buffer.test.ts — captureWorktreeDiff must not silently lose a large diff.
 *
 * spawnSync's DEFAULT maxBuffer is 1 MiB. A real multi-file slice's raw `git diff` routinely
 * exceeds that; on overflow Node truncates stdout at ~1 MiB and sets error.code ENOBUFS WITHOUT
 * throwing, so the old code returned a leading fragment as if it were the whole diff. These tests
 * pin the hardened behaviour: (1) a >1 MiB raw diff is captured whole (no 1 MiB clip) and, being
 * over the char cap, carries the visible truncation marker; (2) a small diff is returned verbatim.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { captureWorktreeDiff } from '../src/judge.js';

let n = 0;
function makeRepo(): { dir: string; base: string } {
  const dir = join(tmpdir(), `judge-diff-${process.pid}-${++n}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) =>
    spawnSync('git', args, { cwd: dir, stdio: 'pipe', encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'seed.txt'), 'seed\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'seed');
  const base = git('rev-parse', 'HEAD').stdout.trim();
  return { dir, base };
}
function commit(dir: string, msg: string): void {
  const git = (...args: string[]) =>
    spawnSync('git', args, { cwd: dir, stdio: 'pipe', encoding: 'utf8' });
  git('add', '-A');
  git('commit', '-q', '-m', msg);
}
function clean(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

test('captureWorktreeDiff: a raw diff over 1 MiB is captured whole (not clipped at the default maxBuffer)', () => {
  const { dir, base } = makeRepo();
  try {
    // ~3 MiB of added content across a file — the raw `git diff` comfortably exceeds the
    // 1 MiB spawnSync default that the old code silently truncated at.
    const big = Array.from({ length: 60_000 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n');
    writeFileSync(join(dir, 'big.txt'), big + '\n');
    commit(dir, 'add big file');

    // Ask for a cap ABOVE 1 MiB so, if spawnSync had clipped at 1 MiB, we'd see a short
    // fragment. Hardened behaviour: the whole diff is captured, so length exceeds 1 MiB.
    const capOverOneMiB = 2 * 1024 * 1024;
    const out = captureWorktreeDiff(dir, base, capOverOneMiB);
    assert.ok(out.length > 1_200_000,
      `expected the full >1 MiB diff, got ${out.length} bytes (a ~1 MiB result means the default maxBuffer clipped it)`);
    assert.ok(out.includes('big.txt'), 'the diff must name the changed file');

    // With a SMALL cap, the code's own truncation runs and stamps the visible marker.
    const small = captureWorktreeDiff(dir, base, 5_000);
    assert.ok(small.length <= 5_000, 'small-cap output must respect the cap');
    assert.ok(small.includes('[diff truncated'), 'an over-cap diff must carry the truncation marker');
  } finally {
    clean(dir);
  }
});

test('captureWorktreeDiff: a small diff under the cap is returned verbatim with no marker', () => {
  const { dir, base } = makeRepo();
  try {
    writeFileSync(join(dir, 'small.txt'), 'hello world\n');
    commit(dir, 'add small file');
    const out = captureWorktreeDiff(dir, base, 100_000);
    assert.ok(out.includes('small.txt'), 'the diff must name the changed file');
    assert.ok(!out.includes('[diff truncated'), 'a small diff must NOT be marked truncated');
  } finally {
    clean(dir);
  }
});

test('captureWorktreeDiff: missing args fail-soft to empty string', () => {
  assert.equal(captureWorktreeDiff('', 'HEAD', 1000), '');
  assert.equal(captureWorktreeDiff('/nonexistent', '', 1000), '');
});
