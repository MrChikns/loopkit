/**
 * dirty-tree-filter.test.ts — the dirty-tree check must not count dependency plumbing.
 *
 * setupWorktreeDeps provisions node_modules as SYMLINKS; gitignore's dir-only
 * `node_modules/` pattern does not match symlinks, so they appear as `??` in
 * `git status --porcelain` and would wrongly park a green committed build as
 * "no-commit: worktree has uncommitted changes". Real source dirt must still park.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isDependencyPlumbing } from '../src/beats/dispatch.js';

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
