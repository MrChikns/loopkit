/**
 * park-reason-classification.test.ts — pins the decision desk's `classifyParkReason` (views.ts)
 * against @loopkit/core's `classifyReason` for the no-commit class.
 *
 * The defect this file exists to prevent: views.ts classified no-commit parks with its own
 * `/^no-commit:/i` regex, which only matched the post-WI-198 prefixed form. Core's
 * `classifyReason` also recognizes the pre-WI-198 unprefixed legacy literals ('target build
 * produced no commit', 'cluster produced no commit') — 22 archived events in the live ledger.
 * Those events classified as 'no-commit' in core's trajectory analytics but fell through to
 * 'other' on this desk, so an operator reading a parked item's explanation saw the wrong story
 * for a historical park. Every reason string below must agree between the two classifiers so
 * the two paths cannot silently drift apart again.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyReason } from '@loopkit/core';
import { classifyParkReason } from '../src/views.js';

const NO_COMMIT_REASONS = [
  'no-commit: worker produced no diff',
  'no-commit',
  // Pre-WI-198 legacy literals — verbatim from the live ledger (22 occurrences, 2026-07).
  'target build produced no commit',
  'target build produced no commit — left 2 out-of-scope change(s), all outside declared Touches: a.ts, b.ts',
  'cluster produced no commit',
  'build produced no commit',
];

const NON_NO_COMMIT_REASONS = [
  'held: awaiting founder decision',
  'operator took this over in a fast-drain — no commit expected from the plane',
  'merge conflict with target branch',
  'push to origin failed: timeout',
];

test('console classifies every no-commit reason (prefixed and legacy) the same as core', () => {
  for (const reason of NO_COMMIT_REASONS) {
    assert.equal(
      classifyReason(reason), 'no-commit',
      `sanity: core must classify "${reason}" as no-commit`,
    );
    assert.equal(
      classifyParkReason(reason).kind, 'no-commit',
      `console must classify "${reason}" as no-commit, matching core's classifyReason`,
    );
  }
});

test('console does not classify non-no-commit reasons as no-commit, matching core', () => {
  for (const reason of NON_NO_COMMIT_REASONS) {
    assert.notEqual(classifyReason(reason), 'no-commit', `sanity: core must not classify "${reason}" as no-commit`);
    assert.notEqual(
      classifyParkReason(reason).kind, 'no-commit',
      `console must not classify "${reason}" as no-commit, matching core's classifyReason`,
    );
  }
});
