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
  rows: VerdictRow[];
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

  return { total, judgedFail, withOutcome, agreePass, falseAlarm, provisionalAccepted, rows };
}
