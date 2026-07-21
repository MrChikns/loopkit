/**
 * pathology-parser.test.ts — WI-084 the park pathologist: parser + prompt/trail unit tests.
 *
 * Covers:
 *   parsePathologyOutput — happy parse of each classification, unparseable on missing
 *     CLASSIFICATION, evidence bullets extracted (capped at 5), never throws on garbage.
 *   formatEventTrail      — compact trail formatting, caps at `max`, handles empty input.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parsePathologyOutput, formatEventTrail, buildPathologyPrompt } from '../src/pathology.js';

// ---------------------------------------------------------------------------
// parsePathologyOutput
// ---------------------------------------------------------------------------

test('parsePathologyOutput: happy parse — transient-infra', () => {
  const text = `CLASSIFICATION: transient-infra
EVIDENCE:
- ENOBUFS on the diff capture spawn
- timeout after 300s with no repo changes
PROPOSED_ACTION: retry the build as-is`;
  const parsed = parsePathologyOutput(text);
  assert.equal(parsed.classification, 'transient-infra');
  assert.deepEqual(parsed.evidence, ['ENOBUFS on the diff capture spawn', 'timeout after 300s with no repo changes']);
  assert.equal(parsed.proposedAction, 'retry the build as-is');
  assert.equal(parsed.raw, undefined);
});

test('parsePathologyOutput: happy parse — plane-infra-bug', () => {
  const text = `CLASSIFICATION: plane-infra-bug
EVIDENCE:
- gate runner script threw a TypeError unrelated to the diff
PROPOSED_ACTION: fix the gate runner`;
  const parsed = parsePathologyOutput(text);
  assert.equal(parsed.classification, 'plane-infra-bug');
  assert.equal(parsed.evidence.length, 1);
  assert.equal(parsed.proposedAction, 'fix the gate runner');
});

test('parsePathologyOutput: happy parse — items-own-code', () => {
  const text = `CLASSIFICATION: items-own-code
EVIDENCE:
- test failure in the changed file foo.test.ts
PROPOSED_ACTION: fix the assertion in foo.test.ts`;
  const parsed = parsePathologyOutput(text);
  assert.equal(parsed.classification, 'items-own-code');
  assert.equal(parsed.proposedAction, 'fix the assertion in foo.test.ts');
});

test('parsePathologyOutput: missing CLASSIFICATION → unparseable', () => {
  const text = `EVIDENCE:\n- something\nPROPOSED_ACTION: do something`;
  const parsed = parsePathologyOutput(text);
  assert.equal(parsed.classification, 'unparseable');
  assert.ok(parsed.raw);
  assert.equal(parsed.evidence.length, 1);
  assert.ok(parsed.evidence[0].includes('unparseable pathology output'));
});

test('parsePathologyOutput: invalid CLASSIFICATION value → unparseable', () => {
  const text = `CLASSIFICATION: something-else\nEVIDENCE:\n- x\nPROPOSED_ACTION: y`;
  const parsed = parsePathologyOutput(text);
  assert.equal(parsed.classification, 'unparseable');
});

test('parsePathologyOutput: case-insensitive field matching', () => {
  const text = `classification: TRANSIENT-INFRA\nevidence:\n- a blip\nproposed_action: retry`;
  const parsed = parsePathologyOutput(text);
  assert.equal(parsed.classification, 'transient-infra');
  assert.equal(parsed.proposedAction, 'retry');
});

test('parsePathologyOutput: evidence capped at 5 bullets', () => {
  const text = `CLASSIFICATION: items-own-code
EVIDENCE:
- one
- two
- three
- four
- five
- six
- seven
PROPOSED_ACTION: fix it`;
  const parsed = parsePathologyOutput(text);
  assert.equal(parsed.evidence.length, 5);
  assert.deepEqual(parsed.evidence, ['one', 'two', 'three', 'four', 'five']);
});

test('parsePathologyOutput: missing EVIDENCE block → empty evidence array, never throws', () => {
  const text = `CLASSIFICATION: items-own-code\nPROPOSED_ACTION: fix it`;
  const parsed = parsePathologyOutput(text);
  assert.equal(parsed.classification, 'items-own-code');
  assert.deepEqual(parsed.evidence, []);
  assert.equal(parsed.proposedAction, 'fix it');
});

test('parsePathologyOutput: never throws on garbage input', () => {
  const garbageInputs = ['', '   ', '{}', '\x00\x01\x02', 'CLASSIFICATION:', 'a'.repeat(10_000)];
  for (const g of garbageInputs) {
    assert.doesNotThrow(() => parsePathologyOutput(g));
    const parsed = parsePathologyOutput(g);
    assert.equal(parsed.classification, 'unparseable');
  }
});

test('parsePathologyOutput: missing PROPOSED_ACTION defaults to empty string', () => {
  const text = `CLASSIFICATION: transient-infra\nEVIDENCE:\n- a blip`;
  const parsed = parsePathologyOutput(text);
  assert.equal(parsed.proposedAction, '');
});

// ---------------------------------------------------------------------------
// formatEventTrail
// ---------------------------------------------------------------------------

test('formatEventTrail: empty input', () => {
  assert.equal(formatEventTrail([]), '(no prior events)');
});

test('formatEventTrail: caps at max events, keeps the LAST N', () => {
  const events = Array.from({ length: 20 }, (_, i) => ({
    ts: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`,
    type: 'item.queued',
    data: { n: i },
  }));
  const out = formatEventTrail(events, 5);
  const lines = out.split('\n');
  assert.equal(lines.length, 5);
  assert.ok(lines[0].includes('"n":15'));
  assert.ok(lines[4].includes('"n":19'));
});

test('formatEventTrail: truncates very long data', () => {
  const events = [{ ts: '2026-01-01T00:00:00Z', type: 'item.queued', data: { spec: 'x'.repeat(500) } }];
  const out = formatEventTrail(events);
  assert.ok(out.length < 500);
  assert.ok(out.includes('…'));
});

// ---------------------------------------------------------------------------
// buildPathologyPrompt
// ---------------------------------------------------------------------------

test('buildPathologyPrompt: includes item id, park reason, trail, tail, and diff', () => {
  const prompt = buildPathologyPrompt('WI-042', 'gate red: tests failed', 'ops', 'trail-line', 'tail-line', 'diff-line');
  assert.ok(prompt.includes('WI-042'));
  assert.ok(prompt.includes('gate red: tests failed'));
  assert.ok(prompt.includes('trail-line'));
  assert.ok(prompt.includes('tail-line'));
  assert.ok(prompt.includes('diff-line'));
  assert.ok(prompt.includes('CLASSIFICATION: transient-infra|plane-infra-bug|items-own-code'));
});

test('buildPathologyPrompt: handles absent diff with a legible placeholder', () => {
  const prompt = buildPathologyPrompt('WI-042', 'reason', undefined, '', '', undefined);
  assert.ok(prompt.includes('(empty diff'));
  assert.ok(prompt.includes('(none)'));
});
