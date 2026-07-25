/**
 * commit-contract-pairing.test.ts — ADR-010's load-bearing pairing test.
 *
 * Two production defects on 2026-07-25 were the SAME root cause wearing different costumes:
 * a shared prompt told the worker "you do NOT hold a git-commit tool" while the spawn still
 * granted git add/commit (target lane, WI-166), or the reverse — a lane granted commit tools
 * but the prompt forbade committing, with no dispatch-side commit path either (the conductor
 * lane, always hard-parking on "cluster produced no commit"). The suite passed throughout both
 * incidents, because no single test paired what the PROMPT TEXT says against what the SPAWN'S
 * TOOLSET actually grants for a given commit contract.
 *
 * This file is that pairing test, once per commitMode, exercised through the SAME production
 * helpers every real spawn site now derives from (`toolsForCommitMode`, `buildPrompt`,
 * `buildBatchPrompt`) — not a hand-rolled duplicate of the pairing rule.
 *
 * ADR-010 requires this test to never be deleted: it is the single assertion that catches both
 * of the 2026-07-25 outage classes, and any future spawn site that hand-picks a toolset instead
 * of calling `toolsForCommitMode` is the exact failure mode this guards against.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPrompt,
  buildBatchPrompt,
  toolsForCommitMode,
  BUILDER_TOOLS,
  DISPATCH_BUILDER_TOOLS,
  CommitMode,
} from '../src/beats/dispatch.js';

const COMMIT_MODES: CommitMode[] = ['dispatch', 'worker'];

function hasCommitTools(tools: string[]): boolean {
  return tools.includes('Bash(git add:*)') || tools.includes('Bash(git commit:*)');
}

function promptSaysDoNotCommit(prompt: string): boolean {
  return prompt.includes('you do not hold a git-commit tool') || prompt.includes('you do NOT hold a git-commit tool');
}

function promptSaysCommitYourself(prompt: string): boolean {
  return /commit it yourself|commit them yourself/.test(prompt);
}

for (const mode of COMMIT_MODES) {
  test(`commitMode '${mode}': toolsForCommitMode toolset and buildPrompt's commit clause agree`, () => {
    const tools = toolsForCommitMode(mode);
    const prompt = buildPrompt('implement the thing', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, mode);

    if (mode === 'dispatch') {
      assert.equal(hasCommitTools(tools), false, 'dispatch mode must grant no git add/commit tool');
      assert.equal(promptSaysDoNotCommit(prompt), true, 'dispatch mode prompt must tell the worker it holds no commit tool');
      assert.equal(promptSaysCommitYourself(prompt), false, 'dispatch mode prompt must not instruct the worker to commit');
    } else {
      assert.equal(hasCommitTools(tools), true, 'worker mode must grant git add AND git commit');
      assert.ok(tools.includes('Bash(git add:*)') && tools.includes('Bash(git commit:*)'), 'worker mode must grant BOTH git add and git commit, not just one');
      assert.equal(promptSaysCommitYourself(prompt), true, 'worker mode prompt must instruct the worker to commit its own output');
      assert.equal(promptSaysDoNotCommit(prompt), false, 'worker mode prompt must not claim the worker holds no commit tool');
    }
  });

  test(`commitMode '${mode}': toolsForCommitMode toolset and buildBatchPrompt's commit clause agree`, () => {
    const tools = toolsForCommitMode(mode);
    const prompt = buildBatchPrompt(
      [{ id: 'WI-001', spec: 'do the thing' }, { id: 'WI-002', spec: 'do another thing' }],
      undefined,
      mode,
    );

    if (mode === 'dispatch') {
      assert.equal(hasCommitTools(tools), false, 'dispatch mode must grant no git add/commit tool');
      assert.equal(promptSaysDoNotCommit(prompt), true, 'dispatch mode batch prompt must tell the worker it holds no commit tool');
      assert.equal(promptSaysCommitYourself(prompt), false, 'dispatch mode batch prompt must not instruct the worker to commit');
    } else {
      assert.equal(hasCommitTools(tools), true, 'worker mode must grant git add AND git commit');
      assert.equal(promptSaysCommitYourself(prompt), true, 'worker mode batch prompt must instruct the worker to commit its own output');
      assert.equal(promptSaysDoNotCommit(prompt), false, 'worker mode batch prompt must not claim the worker holds no commit tool');
    }
  });
}

test('sanity: toolsForCommitMode is the ONLY divergence between BUILDER_TOOLS and DISPATCH_BUILDER_TOOLS', () => {
  // Guards against a future edit widening the divergence beyond git add/commit without
  // updating this pairing test's assumptions.
  assert.deepEqual(toolsForCommitMode('worker'), BUILDER_TOOLS);
  assert.deepEqual(toolsForCommitMode('dispatch'), DISPATCH_BUILDER_TOOLS);
  const onlyDiff = BUILDER_TOOLS.filter(t => !DISPATCH_BUILDER_TOOLS.includes(t));
  assert.deepEqual(onlyDiff.sort(), ['Bash(git add:*)', 'Bash(git commit:*)'].sort());
});

test('default commitMode (unset) is byte-for-byte the pre-ADR-010 dispatch-side-commit behaviour', () => {
  // ADR-010 rollback note: "commitMode defaults to the current per-lane behaviour, so an unset
  // value is byte-for-byte today's semantics." The batch/target lanes never passed a
  // commitMode before this refactor and must not have their prompt text change underneath them.
  const withDefault = buildPrompt('implement the thing');
  const withExplicitDispatch = buildPrompt('implement the thing', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'dispatch');
  assert.equal(withDefault, withExplicitDispatch);

  const batchWithDefault = buildBatchPrompt([{ id: 'WI-001', spec: 'do the thing' }]);
  const batchWithExplicitDispatch = buildBatchPrompt([{ id: 'WI-001', spec: 'do the thing' }], undefined, 'dispatch');
  assert.equal(batchWithDefault, batchWithExplicitDispatch);
});
