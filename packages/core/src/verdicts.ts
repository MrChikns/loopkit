/**
 * verdicts.ts — calibration projection over judge review verdicts.
 *
 * For every item that has a review.verdict event, report:
 *   - wi, verdict, confidence, outcome (accepted | provisional | none-yet)
 *   - summary: total, fail-count, agreement stats where outcome exists.
 *
 * Outcome detection is intentionally SIMPLE and documented:
 *   accepted    = item.accepted event with no provisional flag exists after review.verdict
 *   provisional = item.accepted event WITH provisional=true (self-accept — EXCLUDED
 *                 from agreement cells to avoid selection-bias: only judge-pass items are
 *                 provisionally accepted, so counting them as "accepted" would make the judge
 *                 appear to agree with the operator by construction)
 *   none-yet    = no item.accepted yet (item may be in any state)
 *
 * Repair-followed outcome (a later gate.failed on same item after merge/re-work)
 * is rare and requires linking repairs across items — not cheaply derivable from
 * events alone. Omitted for now; calibration proceeds on accepted|none-yet only.
 * Extend here when the pattern is common enough to warrant the join.
 */

import { LedgerEvent } from './schema.js';
import { ReviewVerdictData } from './schema.js';

// ---------------------------------------------------------------------------
// Outcome classification
// ---------------------------------------------------------------------------

export type VerdictOutcome = 'accepted' | 'provisional' | 'none-yet';

export interface VerdictRow {
  wi: string;
  verdict: ReviewVerdictData['verdict'];
  confidence: number;
  /** ISO8601 timestamp of the review.verdict event */
  at: string;
  outcome: VerdictOutcome;
  /** ISO8601 timestamp of item.accepted (if accepted or provisional) */
  acceptedAt?: string;
}

// ---------------------------------------------------------------------------
// Arm-ability thresholds — the written-down trigger for arming the judge
// ---------------------------------------------------------------------------

/**
 * Human-accepted outcomes needed before an agreement rate means anything.
 *
 * WHY THIS EXISTS (WI-193 win 4). Blocking on the judge is deferred "until calibration", and
 * until now that deferral had no visible trigger — it lived in someone's head, so the plane
 * could accumulate calibration data indefinitely without anyone noticing it had enough. These
 * constants make the condition a number the board can render and a reader can argue with.
 *
 * They gate NOTHING today. The judge stays advisory and fail-open; turning it into a blocker is
 * a separate step. This is the instrument, not the lever.
 */
export const JUDGE_CALIBRATION_SAMPLE = 30;

/** Agreement rate at or above which arming the judge is defensible. */
export const JUDGE_ARM_AGREEMENT = 0.9;

/**
 * Calibration progress — "is the judge arm-able yet, and if not, what is missing?"
 *
 * Three conditions, all necessary. The third is the one that is easy to forget: a judge that has
 * never returned `fail` on an item you later accepted has an empty false-alarm cell, so its
 * agreement rate is 100% by construction and measures nothing. A calibration set with no
 * disagreement is not a calibrated judge; it is an untested one.
 */
export interface CalibrationProgress {
  /** Judged items carrying a recorded human outcome (the usable calibration sample). */
  withOutcome: number;
  /** How many such outcomes are wanted before the rate is meaningful. */
  sampleTarget: number;
  /** Outcomes still needed to reach `sampleTarget` (0 once met). */
  remaining: number;
  /** agreePass / withOutcome, or null when there is nothing to divide by. */
  agreementRate: number | null;
  /** The rate at or above which arming is defensible. */
  agreementTarget: number;
  /** At least one judged-`fail` item has a recorded outcome, so the rate can discriminate. */
  discriminating: boolean;
  /** All three conditions met. Advisory readout only — nothing in the plane reads this to gate. */
  armable: boolean;
  /** One operator-facing sentence: what is still missing, or that nothing is. */
  blocker: string;
}

export interface VerdictSummary {
  total: number;
  judgedFail: number;
  /** Items with a human-accepted outcome available for agreement stats (excludes provisional) */
  withOutcome: number;
  /** Judge said pass AND outcome = accepted (true positive / agreement; excludes provisional) */
  agreePass: number;
  /** Judge said fail AND outcome = accepted (false alarm — judge over-called; excludes provisional) */
  falseAlarm: number;
  /**
   * Items auto-accepted as provisional (judge-conditioned, excluded from agreement cells
   * to avoid selection bias — counting them would make the judge appear to agree by construction).
   */
  provisionalAccepted: number;
  /** Arm-ability readout — see {@link CalibrationProgress}. Never gates anything. */
  calibration: CalibrationProgress;
  rows: VerdictRow[];
}

/**
 * Derive the arm-ability readout from the agreement cells. Pure; exported so the CLI, the
 * brief and the tests all read the SAME judgement rather than each re-deciding what "enough
 * calibration" means.
 */
export function computeCalibration(cells: {
  withOutcome: number;
  agreePass: number;
  failWithOutcome: number;
}): CalibrationProgress {
  const { withOutcome, agreePass, failWithOutcome } = cells;
  const agreementRate = withOutcome > 0 ? agreePass / withOutcome : null;
  const remaining = Math.max(0, JUDGE_CALIBRATION_SAMPLE - withOutcome);
  const discriminating = failWithOutcome > 0;
  const sampleMet = remaining === 0;
  const rateMet = agreementRate !== null && agreementRate >= JUDGE_ARM_AGREEMENT;
  const armable = sampleMet && rateMet && discriminating;

  // Name the FIRST unmet condition rather than listing all three — the operator wants the next
  // thing to wait for, not a scorecard.
  let blocker: string;
  if (armable) {
    blocker = 'arm-able: sample, agreement and discrimination all met';
  } else if (!sampleMet) {
    blocker = `needs ${remaining} more judged item${remaining === 1 ? '' : 's'} with a recorded outcome`;
  } else if (!discriminating) {
    blocker = 'no judged-fail item has an outcome yet — the agreement rate cannot discriminate';
  } else {
    blocker = `agreement ${((agreementRate ?? 0) * 100).toFixed(0)}% is below the ${(JUDGE_ARM_AGREEMENT * 100).toFixed(0)}% bar`;
  }

  return {
    withOutcome,
    sampleTarget: JUDGE_CALIBRATION_SAMPLE,
    remaining,
    agreementRate,
    agreementTarget: JUDGE_ARM_AGREEMENT,
    discriminating,
    armable,
    blocker,
  };
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/**
 * Project review.verdict events from the ledger into a calibration report.
 * Events must be in timestamp order (as returned by loadAllEvents).
 *
 * Calibration decontamination: provisional accepts are in their
 * own bucket and EXCLUDED from agreePass/falseAlarm/withOutcome. Only human
 * accepts (no provisional flag) count as ground truth for the agreement matrix.
 */
export function projectVerdicts(events: LedgerEvent[]): VerdictSummary {
  // Collect the LATEST review.verdict per item (earlier runs are superseded)
  const latestVerdict = new Map<string, { data: ReviewVerdictData; ts: string }>();
  // Collect item.accepted per item (latest timestamp wins, but typically one)
  // Track whether the accept is provisional (self-accept) or human.
  const acceptedInfo = new Map<string, { ts: string; provisional: boolean }>();

  for (const ev of events) {
    if (!/^WI-\d+$/.test(ev.item)) continue;
    if (ev.type === 'review.verdict') {
      latestVerdict.set(ev.item, { data: ev.data as unknown as ReviewVerdictData, ts: ev.ts });
    }
    if (ev.type === 'item.accepted') {
      const d = ev.data as { by?: string; provisional?: boolean };
      acceptedInfo.set(ev.item, {
        ts: ev.ts,
        provisional: d.provisional === true,
      });
    }
  }

  const rows: VerdictRow[] = [];
  for (const [wi, { data, ts }] of latestVerdict) {
    const acc = acceptedInfo.get(wi);
    let outcome: VerdictOutcome = 'none-yet';
    if (acc) {
      outcome = acc.provisional ? 'provisional' : 'accepted';
    }
    rows.push({
      wi,
      verdict: data.verdict,
      confidence: data.confidence,
      at: ts,
      outcome,
      ...(acc ? { acceptedAt: acc.ts } : {}),
    });
  }

  // Sort by wi id (WI-NNN lexicographic — stable)
  rows.sort((a, b) => a.wi.localeCompare(b.wi));

  const total = rows.length;
  const judgedFail = rows.filter(r => r.verdict === 'fail').length;
  // Agreement stats use ONLY human accepts (outcome === 'accepted', not 'provisional').
  const withOutcome = rows.filter(r => r.outcome === 'accepted').length;
  const agreePass = rows.filter(r => r.verdict === 'pass' && r.outcome === 'accepted').length;
  const falseAlarm = rows.filter(r => r.verdict === 'fail' && r.outcome === 'accepted').length;
  const provisionalAccepted = rows.filter(r => r.outcome === 'provisional').length;
  // `falseAlarm` IS the judged-fail-with-outcome count: a fail verdict on an item the operator
  // accepted anyway. It is the only cell that proves the judge is capable of disagreeing with
  // the ground truth, which is what makes the agreement rate a measurement rather than a tautology.
  const calibration = computeCalibration({ withOutcome, agreePass, failWithOutcome: falseAlarm });

  return { total, judgedFail, withOutcome, agreePass, falseAlarm, provisionalAccepted, calibration, rows };
}
