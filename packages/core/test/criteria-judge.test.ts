/**
 * criteria-judge.test.ts — WI-193 win 2: the judge is handed the bar, not the narrative.
 *
 * The judge already demanded SPEC_SATISFIED. What it lacked was something worth judging
 * against: a free-prose `spec` is often written alongside the work and drifts toward describing
 * what got built, so "does the diff satisfy the spec" degrades into "does the diff resemble its
 * own description". These pin that acceptance criteria — authored before the work — become the
 * thing SPEC_SATISFIED measures, and that nothing about the judge's ADVISORY status changed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildJudgePrompt, parseJudgeOutput } from '../src/judge.js';

const SPEC = 'Add a closed-today banner to the calendar day view.';
const DIFF = 'diff --git a/x b/x\n+banner';
const CRITERIA = [
  'A day marked closed shows the banner on the day view.',
  'An open day shows no banner.',
];

test('judge prompt: acceptance criteria appear verbatim and numbered', () => {
  const p = buildJudgePrompt('WI-900', SPEC, DIFF, 'src/', CRITERIA);
  assert.match(p, /ACCEPTANCE CRITERIA/, 'the criteria must reach the judge at all');
  assert.match(p, /1\. A day marked closed shows the banner on the day view\./);
  assert.match(p, /2\. An open day shows no banner\./);
});

test('judge prompt: criteria are declared the bar, and the spec demoted to context', () => {
  const p = buildJudgePrompt('WI-900', SPEC, DIFF, 'src/', CRITERIA);
  assert.match(p, /written down BEFORE this work started/,
    'the judge must be told the criteria predate the diff — that is why they can be trusted as a bar');
  assert.match(p, /Evaluate the diff against the ACCEPTANCE CRITERIA/,
    'the instruction must point at the criteria, not the prose');
  assert.match(p, /Do not grade the spec prose/,
    'the spec stays as scope context; leaving it as a second bar re-opens the narrative hole');
  assert.ok(p.includes(SPEC), 'the spec is still present — scope-creep judgement needs it');
});

test('judge prompt: SPEC_SATISFIED is defined per-criterion, and unverifiable means unmet', () => {
  const p = buildJudgePrompt('WI-900', SPEC, DIFF, 'src/', CRITERIA);
  assert.match(p, /SPEC_SATISFIED is about the CRITERIA/);
  assert.match(p, /`yes` only if EVERY criterion is met/,
    'partial credit for a partially-implemented item is the whole point of the signal');
  assert.match(p, /cannot verify from the diff is NOT met/,
    'silence in a diff must not read as satisfaction');
});

test('judge prompt: an item with NO criteria gets the pre-criteria prompt, byte for byte', () => {
  const withNone = buildJudgePrompt('WI-901', SPEC, DIFF, 'src/');
  const withEmpty = buildJudgePrompt('WI-901', SPEC, DIFF, 'src/', []);
  assert.equal(withEmpty, withNone, 'an empty list must not be a different prompt from none');
  assert.doesNotMatch(withNone, /ACCEPTANCE CRITERIA/,
    'a grandfathered item must be judged exactly as it was before criteria existed');
  assert.match(withNone, /Evaluate the diff against the spec ONLY/);
  assert.doesNotMatch(withNone, /SPEC_SATISFIED is about the CRITERIA/);
});

test('judge prompt: the output grammar is unchanged (the parse wall still fits)', () => {
  for (const p of [buildJudgePrompt('WI-1', SPEC, DIFF, 'src/', CRITERIA), buildJudgePrompt('WI-1', SPEC, DIFF, 'src/')]) {
    for (const field of ['VERDICT: pass|fail', 'CONFIDENCE:', 'SPEC_SATISFIED: yes|partial|no', 'SCOPE_CREEP: none|minor|major', 'TEST_THEATRE: none|suspected', 'REASONS:']) {
      assert.ok(p.includes(field), `criteria must not disturb the grammar the wall parses (missing ${field})`);
    }
  }
});

test('judge prompt: the judge still has no tools and no repo — criteria do not smuggle context in', () => {
  const p = buildJudgePrompt('WI-900', SPEC, DIFF, 'src/', CRITERIA);
  assert.match(p, /You did NOT write this code/);
  // The only material is item id, spec, criteria, touches and the diff. Nothing invites a read.
  assert.doesNotMatch(p, /\b(Read|Grep|Glob|open the file|look at the repo)\b/);
});

test('judge: the parse wall still accepts a criteria-informed answer unchanged (advisory contract intact)', () => {
  const parsed = parseJudgeOutput([
    'VERDICT: fail',
    'CONFIDENCE: 0.8',
    'SPEC_SATISFIED: partial',
    'SCOPE_CREEP: none',
    'TEST_THEATRE: none',
    'REASONS:',
    '- criterion 2 unmet: an open day still renders the banner',
  ].join('\n'));
  assert.equal(parsed.verdict, 'fail');
  assert.equal(parsed.specSatisfied, 'partial');
  assert.deepEqual(parsed.reasons, ['criterion 2 unmet: an open day still renders the banner']);
});
