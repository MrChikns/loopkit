/**
 * embedded-worktree-naming.test.ts — WI-238: the EMBEDDED (untargeted, single-repo) lane's
 * build worktree dir must be namespaced by repoRoot so concurrent builds of DIFFERENT repos
 * never collide on the same sibling path.
 *
 * Root cause (confirmed by a sibling agent's flake diagnosis): dispatch's embedded lane built
 * `wtPath` as `join(opts.repoRoot, '..', `${cfg.worktreePrefix}wi-${wiNum}-a${attemptNum}`)` —
 * no repoRoot-derived namespacing at all. `node --test` runs test files as concurrent
 * subprocesses; test repoRoots are created flat under `os.tmpdir()`, so `join(repoRoot, '..')`
 * collapses to the SAME `os.tmpdir()` for every one of them, and the near-universal
 * WI-001/attempt-1 fixture gave most of them the identical dirname (default worktreePrefix
 * 'loop-' -> 'loop-wi-001-a1'). ~19 test files exercising real runDispatch therefore raced
 * `git worktree add`/`remove --force` on the literal same path — the intermittent
 * 'dispatch: mid-build auth failure…' failure in beats.test.ts (passes isolated, flakes under
 * the full suite).
 *
 * The targeted lane already solved the analogous problem for target repos via
 * `targetWorktreeDirName` (namespaced by the target's opaque targetId). This gives the
 * embedded lane the same protection via `embeddedWorktreeDirName`, namespaced by a short
 * stable hash of `repoRoot` instead (there is no target/id concept in the embedded lane —
 * repoRoot IS the identity). The `wi-<n>-a<n>` suffix is preserved byte-for-byte so
 * `isManagedWorktreeName`/`extractWorktreeItemId` (worktree-reaper.ts), which pattern-match
 * only on that suffix, keep classifying these dirs unchanged.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { embeddedWorktreeDirName, targetWorktreeDirName } from '../src/beats/dispatch.js';
import { isManagedWorktreeName, extractWorktreeItemId } from '../src/worktree-reaper.js';

test('embeddedWorktreeDirName: two DIFFERENT repoRoots produce DISJOINT dirnames for the identical WI/attempt (the WI-238 collision)', () => {
  const base = mkdtempSync(join(tmpdir(), 'wi238-'));
  try {
    // The exact shape that flaked: every test process's repoRoot sits flat under the SAME
    // os.tmpdir() parent, and nearly every fixture uses WI-001, attempt 1.
    const repoRootA = join(base, 'repo-a');
    const repoRootB = join(base, 'repo-b');

    const dirA = embeddedWorktreeDirName('loop-', repoRootA, '001', 1);
    const dirB = embeddedWorktreeDirName('loop-', repoRootB, '001', 1);

    assert.notEqual(dirA, dirB, 'two different repoRoots must never produce the same sibling worktree dirname');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('embeddedWorktreeDirName: the SAME repoRoot + same WI/attempt is deterministic (idempotent across calls/beats)', () => {
  const repoRoot = '/some/fixed/repo/root';
  const first = embeddedWorktreeDirName('loop-', repoRoot, '042', 3);
  const second = embeddedWorktreeDirName('loop-', repoRoot, '042', 3);
  assert.equal(first, second, 'the same inputs must always produce the same dirname — a beat recovering/re-deriving this path must land on the same directory');
});

test('embeddedWorktreeDirName: a later attempt of the SAME repo+item still gets its OWN dirname (attempt-uniqueness preserved)', () => {
  const repoRoot = '/some/fixed/repo/root';
  const attempt1 = embeddedWorktreeDirName('loop-', repoRoot, '042', 1);
  const attempt2 = embeddedWorktreeDirName('loop-', repoRoot, '042', 2);
  assert.notEqual(attempt1, attempt2, 'different attempts must not collide — this is what actually serializes rebuilds of one item, unchanged by this fix');
});

test('embeddedWorktreeDirName: preserves the exact wi-<n>-a<n> suffix so worktree-reaper keeps classifying these dirs unchanged', () => {
  const dir = embeddedWorktreeDirName('loop-', '/host/repos/acme-web', '007', 2);
  assert.match(dir, /-wi-007-a2$/, 'the managed-worktree suffix must be byte-identical to the pre-fix shape');
  assert.equal(isManagedWorktreeName(dir), true, 'worktree-reaper must still recognize this as a managed (reapable-when-orphaned) worktree');
  assert.equal(extractWorktreeItemId(dir), 'WI-007', 'worktree-reaper must still recover the owning item id from the dirname');
});

test('embeddedWorktreeDirName vs targetWorktreeDirName: both preserve the identical wi-<n>-a<n> suffix convention (one naming family, two namespace strategies)', () => {
  const embedded = embeddedWorktreeDirName('loop-', '/host/repos/acme-web', '010', 1);
  const targeted = targetWorktreeDirName('loop-', 'tgt-abc123', '010', 1);
  const suffix = /-wi-010-a1$/;
  assert.match(embedded, suffix);
  assert.match(targeted, suffix);
});
