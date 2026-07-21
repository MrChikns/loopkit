/**
 * trajectory.ts — Per-attempt efficiency projection.
 *
 * Pure projection (no I/O; events in → data out). Computed on demand; no beat, no cron.
 *
 * Exported function: projectTrajectory(events, opts)
 *
 * PROXY CAVEAT (important for consumers):
 *   - `turns` ≈ agentic steps (from claude CLI `num_turns`) — NOT the exact count of
 *     individual tool calls. The CLI aggregates turns at the provider level; the real
 *     tool-call transcript is not available via --output-format json. Treat as an
 *     approximate measure of agent "depth" per attempt.
 *   - `durationMs` is the wall-clock time reported by the CLI, which includes provider
 *     think time + network round-trips. It is not a pure CPU measure.
 *   - Cost fields (tokens, usd) are drawn from `cost.usage` events with loop==='dispatch'.
 *     When an attempt spans multiple WI ids (batch), the cost.usage.wi is a comma-joined
 *     list; we attribute the cost to the carrier (first item) only. Per-WI totals are
 *     therefore approximate for batched builds (documented below at the join logic).
 *
 * COST JOIN IMPLEMENTATION:
 *   We use a per-attempt nearest-in-time join: for each build.dispatched event at
 *   position P, we search forward in the event stream for a cost.usage{loop:'dispatch'}
 *   event whose data.wi includes the item id AND whose timestamp is after the dispatch ts
 *   AND before the next build.dispatched for the same item. This is O(n²) over attempts but
 *   the ledger is bounded (a few thousand events over the window). Simple is intentional —
 *   a more expensive join would require indexing not warranted here.
 */

import { LedgerEvent } from './schema.js';

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface AttemptRecord {
  wi: string;
  attempt: number;
  dispatchedAt: string;                // ISO8601 timestamp of build.dispatched
  endedAt?: string;                    // ISO8601 of the terminal event (gate/crash/merge/parked)
  outcome: 'merged' | 'gate-failed' | 'crashed' | 'gate-parked' | 'in-flight';
  durationMinutes?: number;            // endedAt − dispatchedAt, in minutes
  tokens?: number;                     // from cost.usage{loop:'dispatch'}
  usd?: number;                        // from cost.usage{loop:'dispatch'}
  /** Agentic turn count proxy (claude CLI num_turns — approximate, not exact tool calls). */
  turns?: number;
  /**
   * Model alias used for this attempt (from build.dispatched data.model).
   * Used by buildRoutingTable() to group attempts per model for routing policy.
   */
  model?: string;
  briefed: boolean;                    // item had item.briefed before this dispatch
  judgeVerdict?: 'pass' | 'fail' | 'unparseable';  // latest review.verdict before terminal
}

export interface TrajectoryAggregates {
  attempts: number;
  distinctItems: number;
  merges: number;
  /** Items whose first attempt ended in gate.passed or item.merged / items with attempt-1 in window. */
  firstPassMergeRate: number;
  /** Items with attempt > 1 that eventually merged / items with attempt > 1 in window. */
  repairMergeRate: number;
  avgUsdPerMergedItem: number;
  /** Average agentic turns per attempt (only attempts where turns is present). */
  avgTurnsPerAttempt: number;
  avgDurationMinutes: number;
  /** Fraction of attempts where briefed=true (scout context pack was available). */
  scoutCoverage: number;
  /** Fraction of judge verdicts (where present) that are 'fail'. */
  judgeFailShare: number;
}

export interface TrajectoryProjection {
  window: { days: number; from: string; to: string };
  attempts: AttemptRecord[];
  aggregates: TrajectoryAggregates;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isoToMs(iso: string): number {
  const n = Date.parse(iso);
  return Number.isFinite(n) ? n : 0;
}

function msToMinutes(ms: number): number {
  return ms / 60_000;
}

const ZERO_AGGREGATES: TrajectoryAggregates = {
  attempts: 0,
  distinctItems: 0,
  merges: 0,
  firstPassMergeRate: 0,
  repairMergeRate: 0,
  avgUsdPerMergedItem: 0,
  avgTurnsPerAttempt: 0,
  avgDurationMinutes: 0,
  scoutCoverage: 0,
  judgeFailShare: 0,
};

// ---------------------------------------------------------------------------
// Main projection
// ---------------------------------------------------------------------------

/**
 * Project trajectory data from a ledger event stream.
 *
 * @param events - all events from the ledger (or a time-filtered subset)
 * @param opts.days  - window size in days (default 14). Events before `now - days` are excluded.
 * @param opts.now   - injectable "current time" ISO8601 string (for deterministic tests). Defaults to real now.
 */
export function projectTrajectory(
  events: LedgerEvent[],
  opts: { days?: number; now?: string } = {},
): TrajectoryProjection {
  const days = opts.days ?? 14;
  const nowMs = opts.now ? isoToMs(opts.now) : Date.now();
  const fromMs = nowMs - days * 24 * 60 * 60 * 1000;
  const from = new Date(fromMs).toISOString();
  const to = new Date(nowMs).toISOString();

  // -- Pass 1: collect per-item briefed timestamps (item.briefed events, all time) --
  // An item is considered "briefed" for an attempt if item.briefed appears before the
  // build.dispatched for that attempt. We record the earliest briefed timestamp per item.
  const briefedAtByItem = new Map<string, string>(); // wi → earliest briefed ts
  for (const ev of events) {
    if (ev.type === 'item.briefed') {
      const existing = briefedAtByItem.get(ev.item);
      if (!existing || ev.ts < existing) {
        briefedAtByItem.set(ev.item, ev.ts);
      }
    }
  }

  // -- Pass 2: collect cost.usage{loop:'dispatch'} events for join --
  // Key: we index by (wi id, position in stream) for fast lookup.
  // Each dispatch cost event carries data.wi which may be a comma-joined list (batch).
  // We store them all in an array with their position index for temporal ordering.
  interface CostEntry {
    idx: number;
    ts: string;
    wi: string;           // the comma-joined wi from data.wi (may be "WI-001,WI-002")
    tokens?: number;
    usd?: number;
    turns?: number;
    durationMs?: number;
  }
  const dispatchCosts: CostEntry[] = [];
  events.forEach((ev, idx) => {
    if (ev.type === 'cost.usage') {
      const d = ev.data as Record<string, unknown>;
      if (d['loop'] === 'dispatch') {
        dispatchCosts.push({
          idx,
          ts: ev.ts,
          wi: typeof d['wi'] === 'string' ? d['wi'] : ev.item,
          tokens: typeof d['tokens'] === 'number' ? d['tokens'] : undefined,
          usd: typeof d['usd'] === 'number' ? d['usd'] : undefined,
          turns: typeof d['turns'] === 'number' ? d['turns'] : undefined,
          durationMs: typeof d['durationMs'] === 'number' ? d['durationMs'] : undefined,
        });
      }
    }
  });

  // -- Pass 3: collect review.verdict events indexed by item --
  // For each attempt, we want the judge verdict that appeared between this attempt's
  // dispatch and its terminal event. We'll resolve this per-attempt below.
  interface VerdictEntry {
    idx: number;
    ts: string;
    wi: string;
    verdict: 'pass' | 'fail' | 'unparseable';
  }
  const verdictsByItem = new Map<string, VerdictEntry[]>();
  events.forEach((ev, idx) => {
    if (ev.type === 'review.verdict') {
      const d = ev.data as Record<string, unknown>;
      const v = d['verdict'];
      if (v === 'pass' || v === 'fail' || v === 'unparseable') {
        const list = verdictsByItem.get(ev.item) ?? [];
        list.push({ idx, ts: ev.ts, wi: ev.item, verdict: v });
        verdictsByItem.set(ev.item, list);
      }
    }
  });

  // -- Pass 4: walk build.dispatched events to build attempt records --
  const TERMINAL_TYPES = new Set([
    'gate.passed', 'gate.failed', 'gate.parked', 'build.crashed', 'item.merged',
  ]);

  const attemptRecords: AttemptRecord[] = [];

  // Track the stream index of each build.dispatched per item so we can bracket cost lookups.
  // Structure: map from wi → array of {dispatchIdx, attemptNum} in stream order.

  events.forEach((ev, dispatchIdx) => {
    if (ev.type !== 'build.dispatched') return;

    const wi = ev.item;
    const d = ev.data as Record<string, unknown>;
    const attemptNum = typeof d['attempt'] === 'number' ? d['attempt'] : 1;
    const dispatchedAt = ev.ts;
    const dispatchedMs = isoToMs(dispatchedAt);

    // Window filter: include if dispatchedAt is within [from, now]
    if (dispatchedMs < fromMs || dispatchedMs > nowMs) return;

    // -- Find terminal event for this attempt --
    // Search forward in stream for this wi's next terminal event.
    // Stop at the next build.dispatched for the same wi (new attempt begins).
    let terminalEv: LedgerEvent | undefined;
    for (let i = dispatchIdx + 1; i < events.length; i++) {
      const cand = events[i]!;
      if (cand.item !== wi) continue;
      if (cand.type === 'build.dispatched') break; // next attempt starts — stop
      if (TERMINAL_TYPES.has(cand.type)) {
        terminalEv = cand;
        break;
      }
    }

    // Outcome
    let outcome: AttemptRecord['outcome'] = 'in-flight';
    if (terminalEv) {
      if (terminalEv.type === 'item.merged' || terminalEv.type === 'gate.passed') {
        outcome = 'merged';
      } else if (terminalEv.type === 'build.crashed') {
        outcome = 'crashed';
      } else if (terminalEv.type === 'gate.parked') {
        outcome = 'gate-parked';
      } else {
        outcome = 'gate-failed';
      }
    }

    const endedAt = terminalEv?.ts;
    let durationMinutes: number | undefined;
    if (endedAt) {
      const diffMs = isoToMs(endedAt) - dispatchedMs;
      if (diffMs >= 0) durationMinutes = msToMinutes(diffMs);
    }

    // -- Cost join: nearest-in-time dispatch cost.usage for this wi, after dispatch, before next dispatch --
    // Find the index of the next build.dispatched for same wi (upper bound for the search).
    let nextDispatchIdx = events.length; // default: no upper bound
    for (let i = dispatchIdx + 1; i < events.length; i++) {
      if (events[i]!.item === wi && events[i]!.type === 'build.dispatched') {
        nextDispatchIdx = i;
        break;
      }
    }

    // Among dispatch cost events for this wi in (dispatchIdx, nextDispatchIdx), pick first.
    // The wi field may be comma-joined (batch) — check with includes.
    let costEntry: CostEntry | undefined;
    for (const c of dispatchCosts) {
      if (c.idx <= dispatchIdx) continue;
      if (c.idx >= nextDispatchIdx) break; // past next attempt — stop (costs are ordered by idx)
      // Attribute if this wi appears in the cost event's wi list.
      const wiList = c.wi.split(',').map(s => s.trim());
      if (wiList.includes(wi)) {
        costEntry = c;
        break; // first matching cost event wins (nearest-in-time)
      }
    }

    // Note: for batched builds (comma-joined wi), the cost is shared across all items in the
    // batch; each item in the batch claims the full cost. This is an approximation — per-attempt
    // costs are not individually metered. The per-WI total view is therefore over-counted for
    // batched items. Acceptable for trajectory calibration; a future refinement could divide by
    // batch size when that information is available.

    // -- Briefed: was item.briefed present before this dispatch? --
    const briefedTs = briefedAtByItem.get(wi);
    const briefed = briefedTs !== undefined && briefedTs < dispatchedAt;

    // -- Judge verdict: latest review.verdict for this wi between dispatch and terminal --
    let judgeVerdict: AttemptRecord['judgeVerdict'];
    const itemVerdicts = verdictsByItem.get(wi);
    if (itemVerdicts) {
      // Pick the latest verdict with idx in (dispatchIdx, nextDispatchIdx)
      for (let vi = itemVerdicts.length - 1; vi >= 0; vi--) {
        const ve = itemVerdicts[vi]!;
        if (ve.idx > dispatchIdx && ve.idx < nextDispatchIdx) {
          judgeVerdict = ve.verdict;
          break;
        }
      }
    }

    // -- Model: from build.dispatched data.model --
    const model = typeof d['model'] === 'string' && d['model'] ? d['model'] : undefined;

    attemptRecords.push({
      wi,
      attempt: attemptNum,
      dispatchedAt,
      ...(endedAt ? { endedAt } : {}),
      outcome,
      ...(durationMinutes !== undefined ? { durationMinutes } : {}),
      ...(costEntry?.tokens !== undefined ? { tokens: costEntry.tokens } : {}),
      ...(costEntry?.usd !== undefined ? { usd: costEntry.usd } : {}),
      ...(costEntry?.turns !== undefined ? { turns: costEntry.turns } : {}),
      ...(model !== undefined ? { model } : {}),
      briefed,
      ...(judgeVerdict !== undefined ? { judgeVerdict } : {}),
    });
  });

  if (attemptRecords.length === 0) {
    return {
      window: { days, from, to },
      attempts: [],
      aggregates: { ...ZERO_AGGREGATES },
    };
  }

  // -- Aggregates --

  // Group by item for rate calculations
  const byItem = new Map<string, AttemptRecord[]>();
  for (const a of attemptRecords) {
    const list = byItem.get(a.wi) ?? [];
    list.push(a);
    byItem.set(a.wi, list);
  }

  const distinctItems = byItem.size;
  const totalAttempts = attemptRecords.length;
  const merges = attemptRecords.filter(a => a.outcome === 'merged').length;

  // First-pass merge rate: items where attempt-1 ended in merged / items with attempt-1 in window
  let firstPassItems = 0;
  let firstPassMerges = 0;
  for (const recs of byItem.values()) {
    const attempt1 = recs.find(r => r.attempt === 1);
    if (attempt1) {
      firstPassItems++;
      if (attempt1.outcome === 'merged') firstPassMerges++;
    }
  }
  const firstPassMergeRate = firstPassItems > 0 ? firstPassMerges / firstPassItems : 0;

  // Repair merge rate: items with attempt > 1 that eventually merged / items with attempt > 1
  let repairItems = 0;
  let repairMerges = 0;
  for (const recs of byItem.values()) {
    const hasRepair = recs.some(r => r.attempt > 1);
    if (hasRepair) {
      repairItems++;
      if (recs.some(r => r.outcome === 'merged')) repairMerges++;
    }
  }
  const repairMergeRate = repairItems > 0 ? repairMerges / repairItems : 0;

  // Avg USD per merged item (sum of USD across all attempts for merged items / merged items)
  // Uses the item-level sum: all attempts attributed to a WI that eventually merged.
  const mergedWis = new Set(
    [...byItem.entries()]
      .filter(([, recs]) => recs.some(r => r.outcome === 'merged'))
      .map(([wi]) => wi),
  );
  let totalUsdMerged = 0;
  for (const wi of mergedWis) {
    for (const a of byItem.get(wi) ?? []) {
      totalUsdMerged += a.usd ?? 0;
    }
  }
  const avgUsdPerMergedItem = mergedWis.size > 0 ? totalUsdMerged / mergedWis.size : 0;

  // Avg turns per attempt (only attempts that have turns data)
  const withTurns = attemptRecords.filter(a => a.turns !== undefined);
  const avgTurnsPerAttempt = withTurns.length > 0
    ? withTurns.reduce((s, a) => s + (a.turns ?? 0), 0) / withTurns.length
    : 0;

  // Avg duration minutes (only attempts with duration data)
  const withDuration = attemptRecords.filter(a => a.durationMinutes !== undefined);
  const avgDurationMinutes = withDuration.length > 0
    ? withDuration.reduce((s, a) => s + (a.durationMinutes ?? 0), 0) / withDuration.length
    : 0;

  // Scout coverage: attempts where briefed / total attempts
  const briefedCount = attemptRecords.filter(a => a.briefed).length;
  const scoutCoverage = totalAttempts > 0 ? briefedCount / totalAttempts : 0;

  // Judge fail share: verdict=fail / verdicts present
  const withVerdict = attemptRecords.filter(a => a.judgeVerdict !== undefined);
  const judgeFailCount = withVerdict.filter(a => a.judgeVerdict === 'fail').length;
  const judgeFailShare = withVerdict.length > 0 ? judgeFailCount / withVerdict.length : 0;

  return {
    window: { days, from, to },
    attempts: attemptRecords,
    aggregates: {
      attempts: totalAttempts,
      distinctItems,
      merges,
      firstPassMergeRate,
      repairMergeRate,
      avgUsdPerMergedItem,
      avgTurnsPerAttempt,
      avgDurationMinutes,
      scoutCoverage,
      judgeFailShare,
    },
  };
}
