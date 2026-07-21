/**
 * executionConfig.ts — "Which execution configuration produces ACCEPTED outcomes"
 * aggregation, grouped by model.
 *
 * Deliberately NOT an "agent performance" scoreboard: every metric here is a ratio
 * over ledger events (build.dispatched / gate.passed / item.merged / item.accepted /
 * cost.usage), grouped by the model that carried the item. No anthropomorphic framing,
 * no invented baselines, no speed/quality/reliability axes.
 *
 * Pure projection over EXISTING events — no new event type, no ledger schema change.
 * Reuses projectTrajectory() for the cost→item join (trajectory.ts) rather than
 * re-implementing the terminal-event walk; folds items for item-level state
 * (accepted / merged / attempts) via fold().
 *
 * MODEL ATTRIBUTION: an item can, in principle, be re-dispatched under a different
 * model across repair attempts (routing.ts 'active' mode). This aggregation attributes
 * the WHOLE item to the model of its FIRST attempt (attempt 1) — the execution
 * configuration that was actually chosen for the item, not each individual retry.
 * Items whose attempt-1 record carries no model (legacy events predating model attribution, or a build that
 * never reached build.dispatched with a model field) are excluded — they cannot be
 * attributed to any execution configuration.
 *
 * "Reached a gate" (denominator for first-pass gate rate) = the item has at least one
 * attempt whose outcome is 'merged', 'gate-failed', or 'gate-parked' (i.e. a
 * gate.passed/gate.failed/gate.parked terminal event was recorded for some attempt).
 * 'crashed' and 'in-flight' attempts never reached the gate.
 */

import { LedgerEvent } from './schema.js';
import { AttemptRecord, projectTrajectory } from './trajectory.js';
import { ItemRecord, fold } from './fold.js';

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface ExecutionConfigCell {
  model: string;
  /** Sample size — the number of items attributed to this model. REQUIRED alongside every ratio. */
  n: number;
  /** accepted items / merged items. Undefined when merged=0 (nothing to divide). */
  acceptRate?: number;
  /** items whose gate passed on attempt 1 / items that reached a gate. Undefined when the denominator is 0. */
  firstPassGateRate?: number;
  /** sum(cost.usage.usd across the item's builds) / accepted count. Undefined when accepted=0. */
  costPerAcceptedUsd?: number;
  /** sum(max(attempts-1,0)) / accepted count. Undefined when accepted=0. */
  retriesPerAccept?: number;
  // Raw counts backing the ratios above — always present, so a consumer can render
  // "insufficient data" honestly instead of inferring it from an undefined ratio alone.
  merged: number;
  accepted: number;
  gated: number;
  gatedFirstPass: number;
  totalUsd: number;
  totalRetries: number;
}

export interface ExecutionConfigProjection {
  /** Sample-size floor below which ratios are NOT computed (insufficient-data path). */
  minSamples: number;
  window: { days: number; from: string; to: string };
  cells: ExecutionConfigCell[];
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/**
 * Build the execution-config-by-model aggregation.
 *
 * @param events - all ledger events (or a time-filtered subset)
 * @param opts.days - trajectory window in days (default 30, wider than the 14-day
 *   trajectory default since accept rate needs the acceptance tail after merge).
 * @param opts.now - injectable "now" ISO8601 (deterministic tests).
 * @param opts.minSamples - sample-size floor for the insufficient-data gate (default 5).
 */
export function projectExecutionConfig(
  events: LedgerEvent[],
  opts: { days?: number; now?: string; minSamples?: number } = {},
): ExecutionConfigProjection {
  const days = opts.days ?? 30;
  const minSamples = opts.minSamples ?? 5;
  const trajectory = projectTrajectory(events, { days, now: opts.now });
  const { items } = fold(events);

  // Group attempts by item (attempt-1 gives model attribution + first-pass gate signal).
  const attemptsByItem = new Map<string, AttemptRecord[]>();
  for (const a of trajectory.attempts) {
    const list = attemptsByItem.get(a.wi) ?? [];
    list.push(a);
    attemptsByItem.set(a.wi, list);
  }

  // Accumulator per model.
  interface Acc {
    itemIds: Set<string>;
    merged: number;
    accepted: number;
    gated: number;
    gatedFirstPass: number;
    totalUsd: number;
    totalRetries: number;
  }
  const acc = new Map<string, Acc>();

  const GATED_OUTCOMES = new Set(['merged', 'gate-failed', 'gate-parked']);

  for (const [wi, attempts] of attemptsByItem) {
    const attempt1 = attempts.find((a) => a.attempt === 1);
    const model = attempt1?.model;
    if (!model) continue; // no attribution possible — excluded from every model's cell

    const rec: ItemRecord | undefined = items.get(wi);
    const cell = acc.get(model) ?? {
      itemIds: new Set<string>(),
      merged: 0, accepted: 0, gated: 0, gatedFirstPass: 0, totalUsd: 0, totalRetries: 0,
    };
    cell.itemIds.add(wi);

    const isMerged = rec ? (rec.state === 'merged' || rec.state === 'accepted') : attempts.some((a) => a.outcome === 'merged');
    const isAccepted = rec ? rec.state === 'accepted' : false;
    if (isMerged) cell.merged++;
    if (isAccepted) cell.accepted++;

    // "Reached a gate": any attempt terminated in a gate-adjacent outcome.
    const reachedGate = attempts.some((a) => GATED_OUTCOMES.has(a.outcome));
    if (reachedGate) {
      cell.gated++;
      if (attempt1.outcome === 'merged') cell.gatedFirstPass++;
    }

    // Cost: sum across ALL of the item's builds (all attempts), not just the window's.
    for (const a of attempts) cell.totalUsd += a.usd ?? 0;

    // Retries: attempts-1, floored at 0, using the item's actual attempts count when
    // available (rec.attempts is the authoritative fold count); fall back to the
    // in-window attempt count when the item isn't in the fold (shouldn't normally happen).
    const attemptsCount = rec?.attempts ?? attempts.length;
    cell.totalRetries += Math.max(attemptsCount - 1, 0);

    acc.set(model, cell);
  }

  const cells: ExecutionConfigCell[] = [...acc.entries()]
    .map(([model, cell]) => {
      const n = cell.itemIds.size;
      const out: ExecutionConfigCell = {
        model,
        n,
        merged: cell.merged,
        accepted: cell.accepted,
        gated: cell.gated,
        gatedFirstPass: cell.gatedFirstPass,
        totalUsd: cell.totalUsd,
        totalRetries: cell.totalRetries,
      };
      if (cell.merged > 0) out.acceptRate = cell.accepted / cell.merged;
      if (cell.gated > 0) out.firstPassGateRate = cell.gatedFirstPass / cell.gated;
      if (cell.accepted > 0) {
        out.costPerAcceptedUsd = cell.totalUsd / cell.accepted;
        out.retriesPerAccept = cell.totalRetries / cell.accepted;
      }
      return out;
    })
    .sort((a, b) => b.n - a.n || a.model.localeCompare(b.model));

  return {
    minSamples,
    window: trajectory.window,
    cells,
  };
}
