/**
 * criteria-calibration.test.ts — WI-193 win 4: the judge's arm-ability is visible.
 *
 * Blocking on the judge is deferred "until calibration". Until this, that deferral had no
 * visible trigger — it lived in someone's memory, so the plane could sit on enough evidence
 * indefinitely with nobody noticing. These pin that the condition is now a number a reader can
 * see and argue with, and — the part that keeps it honest — that a judge which has never
 * disagreed with the operator does NOT read as calibrated.
 *
 * Explicitly NOT tested here because it is explicitly not built: the judge blocking anything.
 * It stays advisory and fail-open; this is the instrument, not the lever.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  JUDGE_ARM_AGREEMENT,
  JUDGE_CALIBRATION_SAMPLE,
  computeCalibration,
  projectVerdicts,
} from '../src/verdicts.js';
import { makeEvent, LedgerEvent } from '../src/schema.js';

// ---------------------------------------------------------------------------
// The readout
// ---------------------------------------------------------------------------

test('calibration: an empty ledger reports how far off it is, not a blank', () => {
  const c = computeCalibration({ withOutcome: 0, agreePass: 0, failWithOutcome: 0 });
  assert.equal(c.armable, false);
  assert.equal(c.agreementRate, null, 'no division by zero dressed up as 0%');
  assert.equal(c.remaining, JUDGE_CALIBRATION_SAMPLE);
  assert.match(c.blocker, new RegExp(`needs ${JUDGE_CALIBRATION_SAMPLE} more judged items`),
    'the operator wants the next thing to wait for, stated as a number');
});

test('calibration: an under-sized sample names the shortfall, even at 100% agreement', () => {
  const c = computeCalibration({ withOutcome: 5, agreePass: 5, failWithOutcome: 1 });
  assert.equal(c.agreementRate, 1);
  assert.equal(c.armable, false, 'five agreeing outcomes is not calibration');
  assert.equal(c.remaining, JUDGE_CALIBRATION_SAMPLE - 5);
  assert.match(c.blocker, /needs 25 more judged items/);
});

test('calibration: a judge that has NEVER disagreed is untested, not calibrated', () => {
  // Full sample, perfect agreement — but no judged-fail item ever had an outcome, so the
  // false-alarm cell is empty and the rate is 100% by construction.
  const c = computeCalibration({
    withOutcome: JUDGE_CALIBRATION_SAMPLE, agreePass: JUDGE_CALIBRATION_SAMPLE, failWithOutcome: 0,
  });
  assert.equal(c.agreementRate, 1);
  assert.equal(c.discriminating, false);
  assert.equal(c.armable, false,
    'a calibration set with no disagreement measures nothing — arming on it would be self-congratulation');
  assert.match(c.blocker, /cannot discriminate/);
});

test('calibration: a full, discriminating sample below the bar names the rate', () => {
  // 30 outcomes, 20 agreements = 67%, below the 90% bar.
  const c = computeCalibration({ withOutcome: 30, agreePass: 20, failWithOutcome: 10 });
  assert.equal(c.discriminating, true);
  assert.equal(c.armable, false);
  assert.match(c.blocker, /67% is below the 90% bar/);
});

test('calibration: all three conditions met reports arm-able', () => {
  const c = computeCalibration({ withOutcome: 30, agreePass: 28, failWithOutcome: 2 });
  assert.ok(c.agreementRate! >= JUDGE_ARM_AGREEMENT);
  assert.equal(c.discriminating, true);
  assert.equal(c.armable, true);
  assert.match(c.blocker, /arm-able/);
});

test('calibration: the thresholds are real numbers, written down rather than remembered', () => {
  assert.ok(Number.isInteger(JUDGE_CALIBRATION_SAMPLE) && JUDGE_CALIBRATION_SAMPLE > 0);
  assert.ok(JUDGE_ARM_AGREEMENT > 0 && JUDGE_ARM_AGREEMENT <= 1);
});

// ---------------------------------------------------------------------------
// Wired into the projection the CLI and the brief both read
// ---------------------------------------------------------------------------

function verdictEvents(specs: Array<{ wi: string; verdict: 'pass' | 'fail'; accepted?: boolean }>): LedgerEvent[] {
  const out: LedgerEvent[] = [];
  let t = 0;
  for (const s of specs) {
    const ts = new Date(Date.UTC(2026, 0, 1, 0, ++t)).toISOString();
    out.push(makeEvent('dispatch', s.wi, 'review.verdict', {
      verdict: s.verdict, confidence: 0.8, specSatisfied: 'yes', scopeCreep: 'none',
      testTheatre: 'none', reasons: [], model: 'sonnet', judge: 'merge-review',
    }, ts));
    if (s.accepted) {
      out.push(makeEvent('cli', s.wi, 'item.accepted', { by: 'operator' },
        new Date(Date.UTC(2026, 0, 1, 1, t)).toISOString()));
    }
  }
  return out;
}

test('verdicts projection: the calibration readout rides on the summary the CLI prints', () => {
  const s = projectVerdicts(verdictEvents([
    { wi: 'WI-101', verdict: 'pass', accepted: true },
    { wi: 'WI-102', verdict: 'pass', accepted: true },
    { wi: 'WI-103', verdict: 'fail', accepted: true },   // the disagreement
    { wi: 'WI-104', verdict: 'pass' },                    // no outcome yet
  ]));
  assert.equal(s.withOutcome, 3);
  assert.equal(s.calibration.withOutcome, 3, 'the readout must derive from the same cells, never a second count');
  assert.equal(s.calibration.discriminating, true, 'WI-103 is a judged fail with a recorded outcome');
  assert.equal(s.calibration.armable, false, '3 outcomes is nowhere near the sample target');
  assert.equal(s.calibration.remaining, JUDGE_CALIBRATION_SAMPLE - 3);
});

test('verdicts projection: provisional self-accepts do not inflate the calibration sample', () => {
  const events = [
    ...verdictEvents([{ wi: 'WI-110', verdict: 'pass' }]),
    makeEvent('reactor', 'WI-110', 'item.accepted', { by: 'plane', provisional: true }, '2026-01-02T00:00:00.000Z'),
  ];
  const s = projectVerdicts(events);
  assert.equal(s.calibration.withOutcome, 0,
    'a judge-conditioned self-accept counted as ground truth would make the judge agree with itself');
  assert.equal(s.provisionalAccepted, 1, 'it is still counted, just in its own bucket');
});
