/**
 * Deploy lifecycle truth.
 *
 * A merge and a deployment are different facts. This module owns the durable hand-off:
 * request receipts are appended before a detached process is spawned, synchronous spawn
 * failures become receipts too, and a reactor beat closes requests that never report.
 * None of these events changes the item's delivery state or attempts a rollback.
 */

import { appendEvents, withLock } from './ledger.js';
import { fold, ItemRecord } from './fold.js';
import { LedgerEvent, makeEvent } from './schema.js';
import {
  DeploySpawn,
  fireDeployOnMerge,
} from './beats/worktree-deps.js';

export interface DeployRequest {
  actor: string;
  ledgerDir: string;
  repoRoot: string;
  deployCommand: string;
  wiIds: string[];
  spawnDeploy?: DeploySpawn;
  /** Exact published commit the deploy checkout must still be cleanly showing at launch. */
  expectedCommit?: string;
  /**
   * A caller-side handoff precondition failed after merge (for example, the primary
   * checkout could not be synchronized to the published commit without overwriting an
   * editor's intervening write). The request receipt is still claimed durably, then closed
   * as deploy.failed without invoking the command from a checkout known to be stale.
   */
  preflightFailure?: string;
  /** Test seam for deterministic persistence-failure coverage. */
  persistEvents?: typeof appendEvents;
}

export interface DeployRequestResult {
  configured: boolean;
  started: boolean;
  eventsWritten: number;
  reason?: string;
}

async function persistPendingDeployFailureIfStillPending(
  request: Pick<DeployRequest, 'actor' | 'ledgerDir' | 'persistEvents'>,
  wiIds: string[],
  reason: string,
): Promise<{ eventsWritten: number; reason?: string }> {
  try {
    return await withLock(request.ledgerDir, async tx => {
      const items = fold(await tx.loadAll()).items;
      const stillPending = wiIds.filter(wi => items.get(wi)?.deployStatus === 'pending');
      if (stillPending.length === 0) {
        return { eventsWritten: 0 };
      }
      const events = stillPending.map(wi => makeEvent(request.actor, wi, 'deploy.failed', { reason }));
      if (request.persistEvents) {
        await request.persistEvents(request.ledgerDir, events);
      } else {
        await tx.append(events);
      }
      return { eventsWritten: stillPending.length, reason };
    });
  } catch (error) {
    return {
      eventsWritten: 0,
      reason: `${reason}; deploy.failed receipt persistence failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/**
 * Append the durable per-launch attempt record. Passed to fireDeployOnMerge as its
 * onSpawnAttempt hook, so it only runs once configuration and the checkout preflight have both
 * passed — a preflight rejection is not a launch attempt and must not be recorded as one — and
 * it is awaited there BEFORE the detached process is actually spawned. This is the ledger's only
 * source of truth for "did a spawn actually happen": deploy.requested fires once per pending
 * cycle and eventsWritten is 0 on a reconciled re-launch, so neither can answer that question
 * (WI-219). Best-effort: if the append itself fails, the spawn still proceeds (a missing attempt
 * record undercounts but never blocks or duplicates a launch), and the fold's deployLaunchCount
 * for this item simply lags by one.
 */
async function persistLaunchAttempt(
  request: Pick<DeployRequest, 'actor' | 'ledgerDir'>,
  wiIds: string[],
): Promise<void> {
  try {
    await withLock(request.ledgerDir, async tx => {
      const items = fold(await tx.loadAll()).items;
      const events = wiIds
        .filter(wi => items.get(wi)?.deployStatus === 'pending')
        .map(wi => makeEvent(request.actor, wi, 'deploy.launched', {
          attempt: (items.get(wi)?.deployLaunchCount ?? 0) + 1,
        }));
      if (events.length > 0) await tx.append(events);
    });
  } catch {
    // Best-effort attempt accounting; never block or duplicate the spawn over a ledger write.
  }
}

async function persistReconciliationFailureIfStillActionable(
  request: Pick<DeployRequest, 'actor' | 'ledgerDir'>,
  wiId: string,
  reason: string,
): Promise<{ eventsWritten: number; reason?: string }> {
  try {
    return await withLock(request.ledgerDir, async tx => {
      const rec = fold(await tx.loadAll()).items.get(wiId);
      if (rec?.deployConfigured !== true ||
          (rec.deployStatus !== undefined && rec.deployStatus !== 'pending')) {
        return { eventsWritten: 0 };
      }
      await tx.append([makeEvent(request.actor, wiId, 'deploy.failed', { reason })]);
      return { eventsWritten: 1, reason };
    });
  } catch (error) {
    return {
      eventsWritten: 0,
      reason: `${reason}; deploy.failed receipt persistence failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

export interface DeployRequestClaim {
  claimed: string[];
  pending: string[];
  ignored: string[];
}

/**
 * The one request-claim transaction used by both the normal post-merge handoff and restart
 * reconciliation. A stale caller can never append deploy.requested after pending/terminal truth.
 */
export async function claimDeployRequest(
  request: Pick<DeployRequest, 'actor' | 'ledgerDir'>,
  wiIds: string[],
): Promise<DeployRequestClaim> {
  return withLock(request.ledgerDir, async tx => {
    const items = fold(await tx.loadAll()).items;
    const claim: DeployRequestClaim = { claimed: [], pending: [], ignored: [] };
    for (const wi of [...new Set(wiIds)].sort()) {
      const rec = items.get(wi);
      if (rec?.deployConfigured === true && rec.deployStatus === undefined) {
        claim.claimed.push(wi);
      } else if (rec?.deployConfigured === true && rec.deployStatus === 'pending') {
        claim.pending.push(wi);
      } else {
        claim.ignored.push(wi);
      }
    }
    if (claim.claimed.length > 0) {
      await tx.append(claim.claimed.map(wi => makeEvent(request.actor, wi, 'deploy.requested', {})));
    }
    return claim;
  });
}

/**
 * Persist the pending state before giving control to a detached deploy script.
 * Empty commands remain a strict no-op for backward compatibility.
 */
export async function requestDeployOnMerge(request: DeployRequest): Promise<DeployRequestResult> {
  if (!request.deployCommand) {
    return { configured: false, started: false, eventsWritten: 0 };
  }
  const wiIds = [...new Set(request.wiIds)].sort();
  if (wiIds.length === 0) {
    return { configured: true, started: false, eventsWritten: 0, reason: 'no merged items supplied' };
  }

  const claim = await claimDeployRequest(request, wiIds);
  const launchIds = [...claim.claimed, ...claim.pending].sort();
  if (launchIds.length === 0) {
    return {
      configured: true,
      started: false,
      eventsWritten: 0,
      reason: 'deploy request already terminal or lacks current configuration evidence',
    };
  }

  if (request.preflightFailure) {
    const failure = await persistPendingDeployFailureIfStillPending(
      request,
      launchIds,
      request.preflightFailure,
    );
    return {
      configured: true,
      started: false,
      eventsWritten: claim.claimed.length + failure.eventsWritten,
      reason: failure.reason,
    };
  }

  const spawnResult = await fireDeployOnMerge(
    request.repoRoot,
    request.deployCommand,
    launchIds,
    request.spawnDeploy,
    request.expectedCommit,
    () => persistLaunchAttempt(request, launchIds),
  );
  if (spawnResult.started) {
    return { configured: true, started: true, eventsWritten: claim.claimed.length };
  }

  const failure = await persistPendingDeployFailureIfStillPending(request, launchIds, spawnResult.reason);
  return {
    configured: true,
    started: false,
    // deploy.requested is already durable even if persisting the later failure receipt fails.
    eventsWritten: claim.claimed.length + failure.eventsWritten,
    reason: failure.reason,
  };
}

/** Re-invoke a configured, self-locking deploy for a durable pending request. */
export async function resumePendingDeploy(request: DeployRequest): Promise<DeployRequestResult> {
  if (!request.deployCommand) {
    return { configured: false, started: false, eventsWritten: 0 };
  }
  const wiIds = [...new Set(request.wiIds)].sort();
  if (wiIds.length === 0) {
    return { configured: true, started: false, eventsWritten: 0, reason: 'no pending items supplied' };
  }

  const spawnResult = await fireDeployOnMerge(
    request.repoRoot,
    request.deployCommand,
    wiIds,
    request.spawnDeploy,
    request.expectedCommit,
    () => persistLaunchAttempt(request, wiIds),
  );
  if (spawnResult.started) {
    return { configured: true, started: true, eventsWritten: 0 };
  }
  const failure = await persistPendingDeployFailureIfStillPending(request, wiIds, spawnResult.reason);
  return {
    configured: true,
    started: false,
    eventsWritten: failure.eventsWritten,
    reason: failure.reason,
  };
}

export type DeployExecutionResolution =
  | { ok: true; repoRoot: string; deployCommand: string; expectedCommit?: string }
  | { ok: false; reason: string };

export interface DeployReconcileResult {
  attempted: number;
  eventsWritten: number;
  failures: string[];
}

/**
 * Recover both crash windows around detached deploy launch:
 * - configured merge without deploy.requested: append the intent, then launch;
 * - pending request without a terminal receipt: safely re-invoke the self-locking command.
 *
 * The resolver deliberately runs at reconciliation time so target manifests and plane config
 * are current. Removed or unreadable configuration becomes a visible failed receipt.
 *
 * `minPendingAgeMs` (WI-219) guards only the already-pending branch: a request younger than one
 * beat interval is still in flight from the beat that just requested it (stepApplyVerbs and
 * stepDeployTimeouts can run in the same beat), so reconciling it here would be an immediate
 * duplicate spawn, not crash recovery. A pending item older than the threshold has survived at
 * least one full beat without a terminal receipt or a live in-beat requester, so it is a genuine
 * restart-recovery candidate. Items with no request at all (`deployStatus === undefined`) are
 * never gated — there is no prior spawn to duplicate.
 */
export async function reconcileDeployIntents(args: {
  ledgerDir: string;
  actor: string;
  items: Iterable<ItemRecord>;
  resolve: (item: ItemRecord) => DeployExecutionResolution;
  dryRun?: boolean;
  spawnDeploy?: DeploySpawn;
  excludeItems?: ReadonlySet<string>;
  /** Minimum age (ms) a pending request must have before it is eligible for re-launch. Default 0. */
  minPendingAgeMs?: number;
  nowMs?: number;
  /** Deterministic concurrency seam used to prove fresh-fold suppression. */
  beforeCandidate?: (item: ItemRecord) => Promise<void>;
}): Promise<DeployReconcileResult> {
  const minPendingAgeMs = args.minPendingAgeMs ?? 0;
  const nowMs = args.nowMs ?? Date.now();
  const candidates = [...args.items]
    .filter(rec => rec.deployConfigured === true)
    .filter(rec => rec.deployStatus === undefined || rec.deployStatus === 'pending')
    .filter(rec => !args.excludeItems?.has(rec.id))
    .filter(rec => {
      if (rec.deployStatus !== 'pending' || minPendingAgeMs <= 0) return true;
      const requestedMs = rec.deployRequestedAt ? Date.parse(rec.deployRequestedAt) : NaN;
      // An unparsable/missing timestamp on a pending record can't prove freshness — treat it as
      // eligible rather than silently stranding a pending deploy forever.
      if (!Number.isFinite(requestedMs)) return true;
      return nowMs - requestedMs >= minPendingAgeMs;
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  const result: DeployReconcileResult = { attempted: candidates.length, eventsWritten: 0, failures: [] };
  if (args.dryRun) return result;

  for (const rec of candidates) {
    await args.beforeCandidate?.(rec);
    const execution = args.resolve(rec);
    if (!execution.ok || !execution.deployCommand) {
      const reason = execution.ok
        ? 'deploy configuration was removed before the durable request could complete'
        : execution.reason;
      const failure = await persistReconciliationFailureIfStillActionable(args, rec.id, reason);
      result.eventsWritten += failure.eventsWritten;
      if (failure.reason) result.failures.push(`${rec.id}: ${failure.reason}`);
      continue;
    }

    const request: DeployRequest = {
      actor: args.actor,
      ledgerDir: args.ledgerDir,
      repoRoot: execution.repoRoot,
      deployCommand: execution.deployCommand,
      wiIds: [rec.id],
      spawnDeploy: args.spawnDeploy,
      ...(execution.expectedCommit ? { expectedCommit: execution.expectedCommit } : {}),
    };
    const launch = await requestDeployOnMerge(request);
    result.eventsWritten += launch.eventsWritten;
    if (!launch.started && launch.reason) result.failures.push(`${rec.id}: ${launch.reason}`);
  }
  return result;
}

/**
 * Deterministically close stale pending receipts. Sorting makes event order stable even if
 * the fold's insertion order came from multiple ledger segments. A non-positive threshold
 * disables the transition rather than timing everything out immediately.
 *
 * The reason text distinguishes (WI-219) "launched at least once and went silent" — the
 * command spawned (per the durable deploy.launched record) but never reported a terminal
 * receipt — from "never launched", which means reconciliation could not recover it (missing
 * configuration, an unresolvable target, or a checkout preflight failure already recorded as
 * its own failed receipt via a different path) and this request simply expired unattempted.
 */
export function stalePendingDeployEvents(
  items: Iterable<ItemRecord>,
  actor: string,
  nowMs: number,
  timeoutMs: number,
): LedgerEvent[] {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return [];

  const due = [...items]
    .filter(rec => rec.deployStatus === 'pending' && typeof rec.deployRequestedAt === 'string')
    .map(rec => ({ rec, requestedMs: Date.parse(rec.deployRequestedAt!) }))
    .filter(({ requestedMs }) => Number.isFinite(requestedMs) && nowMs - requestedMs >= timeoutMs)
    .sort((a, b) => a.rec.id.localeCompare(b.rec.id));

  const ts = new Date(nowMs).toISOString();
  return due.map(({ rec }) => {
    const launched = (rec.deployLaunchCount ?? 0) > 0;
    const reason = launched
      ? `deploy request exceeded ${timeoutMs}ms without a terminal receipt after ${
        rec.deployLaunchCount} launch attempt(s); the command spawned but never reported success or failure`
      : `deploy request exceeded ${timeoutMs}ms without ever being launched`;
    return makeEvent(actor, rec.id, 'deploy.timed-out', {
      reason,
      requestedAt: rec.deployRequestedAt!,
    }, ts);
  });
}

/**
 * Fold and close stale deploy requests under one ledger lock. Terminal receipts that
 * acquire the lock first are therefore visible to the fold, while a timeout append cannot
 * interleave with another receipt between observation and mutation.
 */
export async function closeStalePendingDeploys(args: {
  ledgerDir: string;
  actor: string;
  nowMs: number;
  timeoutMs: number;
  dryRun?: boolean;
}): Promise<LedgerEvent[]> {
  return withLock(args.ledgerDir, async tx => {
    const events = stalePendingDeployEvents(
      fold(await tx.loadAll()).items.values(),
      args.actor,
      args.nowMs,
      args.timeoutMs,
    );
    if (!args.dryRun && events.length > 0) {
      await tx.append(events);
    }
    return events;
  });
}
