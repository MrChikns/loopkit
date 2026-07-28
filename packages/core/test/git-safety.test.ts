import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { requireCleanCheckout } from '../src/git-safety.js';
import { closeMergedCluster } from '../src/beats/dispatch.js';

function git(cwd: string, args: string[]) {
  return spawnSync('git', args, { cwd, stdio: 'pipe' });
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'loopkit-git-safety-'));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 't@t']);
  git(root, ['config', 'user.name', 't']);
  writeFileSync(join(root, 'tracked.txt'), 'base\n', 'utf8');
  git(root, ['add', 'tracked.txt']);
  git(root, ['commit', '-m', 'init']);
  return root;
}

test('requireCleanCheckout ignores commit history but reports exact staged, unstaged, and untracked path evidence', () => {
  const root = makeRepo();
  try {
    git(root, ['checkout', '-b', 'ahead']);
    writeFileSync(join(root, 'committed.txt'), 'committed\n', 'utf8');
    git(root, ['add', 'committed.txt']);
    git(root, ['commit', '-m', 'ahead commit']);
    assert.deepEqual(requireCleanCheckout(root), { ok: true },
      'a clean checkout with different commit history must remain eligible');

    writeFileSync(join(root, 'tracked.txt'), 'operator draft\n', 'utf8');
    writeFileSync(join(root, 'staged.txt'), 'staged\n', 'utf8');
    git(root, ['add', 'staged.txt']);
    writeFileSync(join(root, 'untracked.txt'), 'untracked\n', 'utf8');

    const result = requireCleanCheckout(root);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.evidence.includes(' M tracked.txt'));
    assert.ok(result.evidence.includes('A  staged.txt'));
    assert.ok(result.evidence.includes('?? untracked.txt'));
    assert.match(result.reason, /refusing git operation to preserve operator state/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('closeMergedCluster refuses a dirty destination before checkout or merge and preserves operator state', () => {
  const root = makeRepo();
  try {
    git(root, ['checkout', '-b', 'build']);
    writeFileSync(join(root, 'built.txt'), 'built\n', 'utf8');
    git(root, ['add', 'built.txt']);
    git(root, ['commit', '-m', 'built']);
    git(root, ['checkout', '-b', 'operator-work', 'main']);
    writeFileSync(join(root, 'tracked.txt'), 'operator draft\n', 'utf8');

    const mainBefore = git(root, ['rev-parse', 'main']).stdout.toString().trim();
    const result = closeMergedCluster(root, root, 'build', 'main', 'merge build');

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.stage, 'precondition');
    assert.match(result.reason, / M tracked\.txt/);
    assert.equal(git(root, ['branch', '--show-current']).stdout.toString().trim(), 'operator-work');
    assert.equal(readFileSync(join(root, 'tracked.txt'), 'utf8'), 'operator draft\n');
    assert.equal(git(root, ['rev-parse', 'main']).stdout.toString().trim(), mainBefore);
    assert.equal(git(root, ['merge-base', '--is-ancestor', 'build', 'main']).status, 1,
      'the build branch must not be merged into the destination');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('closeMergedCluster refuses a destination that moved after the caller gated its expected tip', () => {
  const root = makeRepo();
  try {
    const expectedMain = git(root, ['rev-parse', 'main']).stdout.toString().trim();
    git(root, ['checkout', '-b', 'build']);
    writeFileSync(join(root, 'built.txt'), 'built\n', 'utf8');
    git(root, ['add', 'built.txt']);
    git(root, ['commit', '-m', 'built']);
    git(root, ['checkout', 'main']);
    writeFileSync(join(root, 'concurrent.txt'), 'advanced\n', 'utf8');
    git(root, ['add', 'concurrent.txt']);
    git(root, ['commit', '-m', 'concurrent advance']);
    const advancedMain = git(root, ['rev-parse', 'main']).stdout.toString().trim();

    const result = closeMergedCluster(root, root, 'build', 'main', 'merge build', expectedMain);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.stage, 'destination-moved');
    assert.match(result.reason, new RegExp(expectedMain));
    assert.match(result.reason, new RegExp(advancedMain));
    assert.equal(git(root, ['rev-parse', 'main']).stdout.toString().trim(), advancedMain);
    assert.equal(git(root, ['merge-base', '--is-ancestor', 'build', 'main']).status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
