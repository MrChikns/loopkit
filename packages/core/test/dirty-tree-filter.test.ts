/**
 * dirty-tree-filter.test.ts — the dirty-tree check must not count dependency plumbing OR
 * the plane's own runtime evidence (WI-222 D22).
 *
 * setupWorktreeDeps provisions node_modules as SYMLINKS; gitignore's dir-only
 * `node_modules/` pattern does not match symlinks, so they appear as `??` in
 * `git status --porcelain` and would wrongly park a green committed build as
 * "no-commit: worktree has uncommitted changes". Real source dirt must still park.
 *
 * The plane also writes runtime evidence (gate logs, diffs, watermarks, heartbeats, locks)
 * under `.ai/runs/` at the repo root on every build. A target repo that doesn't gitignore
 * that directory must not have `requireCleanCheckout` refuse forever on the plane's own
 * writes (that produced an infinite push-race-recovery park loop, D22).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { isDependencyPlumbing } from '../src/beats/dispatch.js';
import { requireCleanCheckout, isPlaneRuntimeEvidence, isPlaneArtifact } from '../src/git-safety.js';

test('dependency plumbing lines are exempt from the dirty check', () => {
  const plumbing = [
    '?? node_modules',
    '?? node_modules/',
    '?? packages/engine/node_modules',
    '?? packages/ui/node_modules/',
    '?? apps/example/node_modules',
    ' M packages/ui/node_modules/left-pad/index.js',
  ];
  for (const line of plumbing) {
    assert.equal(isDependencyPlumbing(line), true, `should exempt: ${line}`);
  }
});

test('real work dirt still counts as dirty', () => {
  const dirt = [
    '?? packages/engine/src/new-file.ts',
    ' M apps/example/src/seed/config.ts',
    '?? README-node_modules-notes.md',   // contains the word, not the path segment
    ' M src/node_modules_helper.ts',      // same
    '?? .ai/ledger/work-2026-07.jsonl',
  ];
  for (const line of dirt) {
    assert.equal(isDependencyPlumbing(line), false, `should NOT exempt: ${line}`);
  }
});

test('plane runtime evidence lines are exempt from the dirty check', () => {
  const evidence = [
    '?? .ai/runs',
    '?? .ai/runs/',
    '?? .ai/runs/loopkit',
    '?? .ai/runs/loopkit/WI-100-attempt-1.log',
    ' M .ai/runs/loopkit/doctor-maxids.json',
    '?? .ai/runs/dispatch/lastrun',
    '?? nested/target/.ai/runs/loopkit/WI-1-attempt-1.gate.log',
  ];
  for (const line of evidence) {
    assert.equal(isPlaneRuntimeEvidence(line), true, `should exempt: ${line}`);
    assert.equal(isPlaneArtifact(line), true, `isPlaneArtifact should exempt: ${line}`);
  }
});

test('paths that merely contain ".ai/runs" as a substring, not a path segment, still count as dirty', () => {
  const dirt = [
    '?? notes-about.ai/runs-folder.md',
    '?? .ai/runsheet.md',
    '?? src/new-file.ts',
  ];
  for (const line of dirt) {
    assert.equal(isPlaneRuntimeEvidence(line), false, `should NOT exempt: ${line}`);
  }
});

function git(cwd: string, args: string[]) {
  return spawnSync('git', args, { cwd, stdio: 'pipe' });
}

test('requireCleanCheckout no longer refuses on a checkout dirty with only plane runtime evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'loopkit-artifact-filter-'));
  try {
    git(root, ['init', '-b', 'main']);
    git(root, ['config', 'user.email', 't@t']);
    git(root, ['config', 'user.name', 't']);
    writeFileSync(join(root, 'tracked.txt'), 'base\n', 'utf8');
    git(root, ['add', 'tracked.txt']);
    git(root, ['commit', '-m', 'init']);

    // Target repo does NOT gitignore .ai/runs — the exact D22 scenario: the plane's own
    // evidence writes surface as untracked residue in this checkout's own status.
    mkdirSync(join(root, '.ai', 'runs', 'loopkit'), { recursive: true });
    writeFileSync(join(root, '.ai', 'runs', 'loopkit', 'WI-1-attempt-1.log'), 'log\n', 'utf8');
    mkdirSync(join(root, 'node_modules', '@scope'), { recursive: true });
    writeFileSync(join(root, 'node_modules', '@scope', 'pkg.js'), '', 'utf8');

    assert.equal(requireCleanCheckout(root).ok, true,
      'plane-artifact-only residue must not refuse the guard');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('requireCleanCheckout still refuses when genuine operator work is mixed in with plane artifacts', () => {
  const root = mkdtempSync(join(tmpdir(), 'loopkit-artifact-filter-real-dirt-'));
  try {
    git(root, ['init', '-b', 'main']);
    git(root, ['config', 'user.email', 't@t']);
    git(root, ['config', 'user.name', 't']);
    writeFileSync(join(root, 'tracked.txt'), 'base\n', 'utf8');
    git(root, ['add', 'tracked.txt']);
    git(root, ['commit', '-m', 'init']);

    mkdirSync(join(root, '.ai', 'runs', 'loopkit'), { recursive: true });
    writeFileSync(join(root, '.ai', 'runs', 'loopkit', 'WI-1-attempt-1.log'), 'log\n', 'utf8');
    // Genuine operator work mixed into the same checkout.
    writeFileSync(join(root, 'tracked.txt'), 'operator draft\n', 'utf8');

    const result = requireCleanCheckout(root);
    assert.equal(result.ok, false, 'real work dirt must still refuse even alongside plane artifacts');
    if (result.ok) return;
    assert.match(result.reason, / M tracked\.txt/);
    assert.doesNotMatch(result.reason, /\.ai\/runs/, 'the plane-artifact line must not appear in the refusal evidence');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
