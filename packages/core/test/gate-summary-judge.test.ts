/**
 * gate-summary-judge.test.ts — WI-234: the judge sees objective gate/test evidence.
 *
 * Before this, buildJudgePrompt reviewed spec + criteria + diff only — blind to whether the
 * gate (build/tests) that ran right before it actually passed, or how many tests passed/failed.
 * These pin that a compact, capped gate-result summary reaches the prompt for a gated item, is
 * cleanly omitted when no gate outcome is available, carries ONLY the gate's own verdict/reason/
 * counts (never the builder's manifest or transcript — independence must hold), and that the
 * parse wall (parseJudgeOutput) is untouched by any of it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildJudgePrompt, buildGateResultSummary, parseJudgeOutput } from '../src/judge.js';

const SPEC = 'Add a closed-today banner to the calendar day view.';
const DIFF = 'diff --git a/x b/x\n+banner';

// ---------------------------------------------------------------------------
// buildGateResultSummary — unit tests
// ---------------------------------------------------------------------------

test('buildGateResultSummary: undefined gate outcome yields undefined (nothing to summarize)', () => {
  assert.equal(buildGateResultSummary(undefined), undefined);
});

test('buildGateResultSummary: passed gate summarizes PASSED + reason', () => {
  const summary = buildGateResultSummary({ passed: true, reason: 'tests green', output: '' }, 'npm test');
  assert.ok(summary);
  assert.match(summary!, /Gate: PASSED/);
  assert.match(summary!, /Command: npm test/);
  assert.match(summary!, /Reason: tests green/);
});

test('buildGateResultSummary: failed gate summarizes FAILED + reason', () => {
  const summary = buildGateResultSummary({ passed: false, reason: 'gate exited 1: boom', output: '' });
  assert.ok(summary);
  assert.match(summary!, /Gate: FAILED/);
  assert.match(summary!, /Reason: gate exited 1: boom/);
});

test('buildGateResultSummary: extracts passing/failing counts from common test-runner output', () => {
  const output = '  42 passing (3s)\n  2 failing\n';
  const summary = buildGateResultSummary({ passed: false, reason: 'gate exited 1', output });
  assert.ok(summary);
  assert.match(summary!, /Tests: 42 passing, 2 failing/);
});

test('buildGateResultSummary: no recognizable counts in output → no Tests: line, still summarizes', () => {
  const summary = buildGateResultSummary({ passed: true, reason: 'tests green', output: 'ok, all good' });
  assert.ok(summary);
  assert.doesNotMatch(summary!, /Tests:/);
  assert.match(summary!, /Gate: PASSED/);
});

test('buildGateResultSummary: never includes builder manifest/transcript material', () => {
  // Simulate a gate whose reason/output happens to be adjacent to builder material in the
  // caller's scope — the summary must only ever be built from the gate outcome's OWN fields.
  const summary = buildGateResultSummary({ passed: true, reason: 'tests green', output: '10 passing' });
  assert.ok(summary);
  assert.doesNotMatch(summary!, /manifest/i);
  assert.doesNotMatch(summary!, /transcript/i);
});

test('buildGateResultSummary: long output is capped with a visible truncation marker', () => {
  const hugeReason = 'x'.repeat(5000);
  const summary = buildGateResultSummary({ passed: false, reason: hugeReason, output: '' });
  assert.ok(summary);
  assert.ok(summary!.length <= 600, 'summary must be capped');
  assert.match(summary!, /\[gate output truncated\]/);
});

// ---------------------------------------------------------------------------
// buildJudgePrompt — gate summary section present / absent
// ---------------------------------------------------------------------------

test('judge prompt: gate summary present for a gated item, under a visible section header', () => {
  const gateSummary = buildGateResultSummary({ passed: true, reason: 'tests green', output: '5 passing' }, 'npm test');
  const p = buildJudgePrompt('WI-234', SPEC, DIFF, 'src/', undefined, gateSummary);
  assert.match(p, /GATE RESULT/, 'must carry a visible gate-result section header');
  assert.match(p, /Gate: PASSED/);
  assert.match(p, /Tests: 5 passing/);
});

test('judge prompt: absent gate summary omits the section entirely', () => {
  const p = buildJudgePrompt('WI-234', SPEC, DIFF, 'src/');
  assert.doesNotMatch(p, /GATE RESULT/, 'no gate outcome available → no section, not an empty one');
});

test('judge prompt: gate summary is objective evidence — never the builder manifest or transcript', () => {
  const gateSummary = buildGateResultSummary({ passed: false, reason: 'gate exited 1: boom', output: '' });
  const p = buildJudgePrompt('WI-234', SPEC, DIFF, 'src/', undefined, gateSummary);
  assert.doesNotMatch(p, /manifest/i, 'independence: the judge must never see the builder manifest');
  assert.doesNotMatch(p, /transcript/i, 'independence: the judge must never see the builder transcript');
});

test('judge prompt: gate summary coexists with criteria without disturbing the criteria block', () => {
  const gateSummary = buildGateResultSummary({ passed: true, reason: 'tests green', output: '' });
  const criteria = ['A day marked closed shows the banner on the day view.'];
  const p = buildJudgePrompt('WI-234', SPEC, DIFF, 'src/', criteria, gateSummary);
  assert.match(p, /ACCEPTANCE CRITERIA/);
  assert.match(p, /GATE RESULT/);
});

// ---------------------------------------------------------------------------
// Parser unchanged
// ---------------------------------------------------------------------------

test('parseJudgeOutput: unchanged by the gate-summary addition (grammar + parsing intact)', () => {
  const text = [
    'VERDICT: pass',
    'CONFIDENCE: 0.9',
    'SPEC_SATISFIED: yes',
    'SCOPE_CREEP: none',
    'TEST_THEATRE: none',
    'REASONS:',
    '- looks good',
  ].join('\n');
  const result = parseJudgeOutput(text);
  assert.equal(result.verdict, 'pass');
  assert.equal(result.confidence, 0.9);
  assert.equal(result.specSatisfied, 'yes');
  assert.equal(result.scopeCreep, 'none');
  assert.equal(result.testTheatre, 'none');
  assert.deepEqual(result.reasons, ['looks good']);
});
