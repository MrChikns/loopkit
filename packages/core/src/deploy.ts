/**
 * Deploy lifecycle truth.
 *
 * A merge and a deployment are different facts. This module owns the durable hand-off:
 * request receipts are appended before a detached process is spawned, synchronous spawn
 * failures become receipts too, and a reactor beat closes requests that never report.
 * None of these events changes the item's delivery state or attempts a rollback.
 */

import { appendEvents } from './ledger.js';
import { ItemRecord } from './fold.js';
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
}

export interface DeployRequestResult {
  configured: boolean;
  started: boolean;
  eventsWritten: number;
  reason?: string;
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

  await appendEvents(
    request.ledgerDir,
    wiIds.map(wi => makeEvent(request.actor, wi, 'deploy.requested', {})),
  );

  const spawnResult = fireDeployOnMerge(
    request.repoRoot,
    request.deployCommand,
    wiIds,
    request.spawnDeploy,
  );
  if (spawnResult.started) {
    return { configured: true, started: true, eventsWritten: wiIds.length };
  }

  await appendEvents(
    request.ledgerDir,
    wiIds.map(wi => makeEvent(request.actor, wi, 'deploy.failed', {
      reason: spawnResult.reason,
    })),
  );
  return {
    configured: true,
    started: false,
    eventsWritten: wiIds.length * 2,
    reason: spawnResult.reason,
  };
}

/**
 * Deterministically close stale pending receipts. Sorting makes event order stable even if
 * the fold's insertion order came from multiple ledger segments. A non-positive threshold
 * disables the transition rather than timing everything out immediately.
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
  return due.map(({ rec }) => makeEvent(actor, rec.id, 'deploy.timed-out', {
    reason: `deploy request exceeded ${timeoutMs}ms without a terminal receipt`,
    requestedAt: rec.deployRequestedAt!,
  }, ts));
}
