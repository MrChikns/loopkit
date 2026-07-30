import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { requireCleanCheckout, isPlaneArtifact } from '../src/git-safety.js';
import {
  closeMergedCluster,
  constructTargetMergeCandidate,
} from '../src/beats/dispatch.js';

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
    const expectedMain = git(root, ['rev-parse', 'main']).stdout.toString().trim();
    const candidate = constructTargetMergeCandidate(root, 'build', expectedMain, 'merge build');
    assert.equal(candidate.ok, true);
    if (!candidate.ok) return;
    git(root, ['checkout', '-b', 'operator-work', 'main']);
    writeFileSync(join(root, 'tracked.txt'), 'operator draft\n', 'utf8');

    const mainBefore = git(root, ['rev-parse', 'main']).stdout.toString().trim();
    const result = closeMergedCluster(root, candidate.commit, 'main', expectedMain);

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

test('closeMergedCluster CAS rejects a destination advance at the publication boundary', () => {
  const root = makeRepo();
  try {
    const expectedMain = git(root, ['rev-parse', 'main']).stdout.toString().trim();
    git(root, ['checkout', '-b', 'build']);
    writeFileSync(join(root, 'built.txt'), 'built\n', 'utf8');
    git(root, ['add', 'built.txt']);
    git(root, ['commit', '-m', 'built']);
    git(root, ['checkout', 'main']);
    const candidate = constructTargetMergeCandidate(root, 'build', expectedMain, 'merge build');
    assert.equal(candidate.ok, true);
    if (!candidate.ok) return;
    let advancedMain = '';

    const result = closeMergedCluster(root, candidate.commit, 'main', expectedMain, {
      beforePublish: () => {
        git(root, ['checkout', 'main']);
        writeFileSync(join(root, 'concurrent.txt'), 'advanced\n', 'utf8');
        git(root, ['add', 'concurrent.txt']);
        git(root, ['commit', '-m', 'concurrent advance']);
        advancedMain = git(root, ['rev-parse', 'main']).stdout.toString().trim();
      },
    });

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

test('ordinary post-CAS checkout preserves an editor write at the synchronization boundary', () => {
  const root = makeRepo();
  try {
    const expectedMain = git(root, ['rev-parse', 'main']).stdout.toString().trim();
    git(root, ['checkout', '-b', 'build']);
    writeFileSync(join(root, 'tracked.txt'), 'candidate version\n', 'utf8');
    git(root, ['add', 'tracked.txt']);
    git(root, ['commit', '-m', 'built']);
    git(root, ['checkout', 'main']);
    const candidate = constructTargetMergeCandidate(root, 'build', expectedMain, 'merge build');
    assert.equal(candidate.ok, true);
    if (!candidate.ok) return;

    const result = closeMergedCluster(root, candidate.commit, 'main', expectedMain, {
      afterPublishBeforeSync: () => {
        writeFileSync(join(root, 'tracked.txt'), 'operator edit during publish\n', 'utf8');
      },
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.checkoutSynced, false);
    assert.match(result.warning ?? '', /preserved an intervening edit/);
    assert.equal(git(root, ['rev-parse', 'main']).stdout.toString().trim(), candidate.commit,
      'the atomic publication remains successful');
    assert.equal(git(root, ['rev-parse', 'HEAD']).stdout.toString().trim(), expectedMain,
      'the primary tree stays safely detached at its pre-publication commit');
    assert.equal(readFileSync(join(root, 'tracked.txt'), 'utf8'), 'operator edit during publish\n');
    assert.match(git(root, ['status', '--short']).stdout.toString(), / M tracked\.txt/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('exact merge candidate is no-ff, atomically published, and syncs a clean checked-out destination', () => {
  const root = makeRepo();
  try {
    const expectedMain = git(root, ['rev-parse', 'main']).stdout.toString().trim();
    git(root, ['checkout', '-b', 'build']);
    writeFileSync(join(root, 'built.txt'), 'built\n', 'utf8');
    git(root, ['add', 'built.txt']);
    git(root, ['commit', '-m', 'built']);
    const buildSha = git(root, ['rev-parse', 'build']).stdout.toString().trim();
    git(root, ['checkout', 'main']);

    const candidate = constructTargetMergeCandidate(root, 'build', expectedMain, 'merge build');
    assert.equal(candidate.ok, true);
    if (!candidate.ok) return;
    assert.equal(
      git(root, ['show', '-s', '--format=%P', candidate.commit]).stdout.toString().trim(),
      `${expectedMain} ${buildSha}`,
      'the gated candidate has the exact destination and build parents',
    );

    const result = closeMergedCluster(root, candidate.commit, 'main', expectedMain);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.commit, candidate.commit);
    assert.equal(result.checkoutSynced, true);
    assert.equal(git(root, ['rev-parse', 'main']).stdout.toString().trim(), candidate.commit);
    assert.equal(git(root, ['rev-parse', 'HEAD']).stdout.toString().trim(), candidate.commit);
    assert.equal(readFileSync(join(root, 'built.txt'), 'utf8'), 'built\n');
    assert.equal(requireCleanCheckout(root).ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a prior publish that crashed between detach and restore leaves a clean detached checkout that the NEXT merge re-attaches honestly', () => {
  const root = makeRepo();
  try {
    const expectedMain = git(root, ['rev-parse', 'main']).stdout.toString().trim();

    // Simulate exactly the on-disk state a crash between closeMergedCluster's detach and its
    // restore checkout leaves behind: primary checkout detached, HEAD at the (still-current)
    // destination tip, tree clean. No live process needs to actually crash for this — the
    // recoverable STATE is what matters, not how it was produced.
    git(root, ['checkout', '--detach', expectedMain]);
    assert.equal(git(root, ['branch', '--show-current']).stdout.toString().trim(), '',
      'precondition: primary checkout is detached, simulating the post-crash wedge');
    assert.equal(requireCleanCheckout(root).ok, true, 'precondition: tree is clean');

    // A second, unrelated build now completes and reaches its own closeMergedCluster call —
    // this is the "next merge" that must observe and repair the wedge, not fail open.
    git(root, ['branch', 'build2', expectedMain]);
    git(root, ['checkout', 'build2']);
    writeFileSync(join(root, 'second.txt'), 'second\n', 'utf8');
    git(root, ['add', 'second.txt']);
    git(root, ['commit', '-m', 'second build']);
    const build2Sha = git(root, ['rev-parse', 'build2']).stdout.toString().trim();
    // Re-create the detached-at-tip wedge as the ACTUAL primary-checkout state entering the
    // next closeMergedCluster call (constructTargetMergeCandidate doesn't require a specific
    // checked-out branch, so building the candidate from build2 is independent of it).
    git(root, ['checkout', '--detach', expectedMain]);
    const candidate = constructTargetMergeCandidate(root, 'build2', expectedMain, 'merge build2');
    assert.equal(candidate.ok, true);
    if (!candidate.ok) return;

    const result = closeMergedCluster(root, candidate.commit, 'main', expectedMain);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.checkoutSynced, true,
      'the wedge must be detected and repaired within this same call, not left detached');
    assert.equal(result.syncFailureReason, undefined);
    assert.equal(git(root, ['branch', '--show-current']).stdout.toString().trim(), 'main',
      'the primary checkout must be re-attached to the destination branch, not left detached');
    assert.equal(git(root, ['rev-parse', 'main']).stdout.toString().trim(), candidate.commit);
    assert.equal(git(root, ['rev-parse', 'HEAD']).stdout.toString().trim(), candidate.commit);
    assert.equal(readFileSync(join(root, 'second.txt'), 'utf8'), 'second\n');
    assert.equal(build2Sha !== candidate.commit, true, 'sanity: candidate is the merge, not the raw build tip');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a checkout genuinely detached at operator-inspected history (not the destination tip) is left alone, not force-reattached', () => {
  const root = makeRepo();
  try {
    const expectedMain = git(root, ['rev-parse', 'main']).stdout.toString().trim();
    git(root, ['checkout', '-b', 'build']);
    writeFileSync(join(root, 'built.txt'), 'built\n', 'utf8');
    git(root, ['add', 'built.txt']);
    git(root, ['commit', '-m', 'built']);
    git(root, ['checkout', 'main']);
    const candidate = constructTargetMergeCandidate(root, 'build', expectedMain, 'merge build');
    assert.equal(candidate.ok, true);
    if (!candidate.ok) return;

    // The operator is deliberately inspecting a commit that is NOT the destination tip —
    // this must not be mistaken for the crash wedge (which is always detached exactly at the
    // destination tip).
    git(root, ['checkout', '--detach', expectedMain === '' ? 'HEAD' : expectedMain]);
    writeFileSync(join(root, 'tracked.txt'), 'base\n', 'utf8'); // keep tree clean, re-affirm content
    const historicalSha = git(root, ['rev-parse', 'HEAD~0']).stdout.toString().trim();
    assert.equal(historicalSha, expectedMain);

    // closeMergedCluster only sees the checked-out state at call time — build an unrelated
    // detach at a DIFFERENT commit than expectedDestinationSha to prove the narrow match.
    git(root, ['commit', '--allow-empty', '-m', 'operator inspection commit']);
    const operatorSha = git(root, ['rev-parse', 'HEAD']).stdout.toString().trim();
    assert.notEqual(operatorSha, expectedMain);

    const result = closeMergedCluster(root, candidate.commit, 'main', expectedMain);
    // Not the crash wedge shape (HEAD != expectedDestinationSha) — falls through to the
    // ordinary "not currently on the destination branch" path: publishes, does not touch or
    // restore the primary checkout.
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.checkoutSynced, false);
    assert.equal(result.syncFailureReason, undefined);
    assert.equal(git(root, ['rev-parse', 'HEAD']).stdout.toString().trim(), operatorSha,
      'the operator-inspected detached HEAD must be left exactly as found');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
