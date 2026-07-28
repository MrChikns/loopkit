import type { OperationalState } from '../states/operational-state.ts';
import type { FoldMergedItem } from './fold-adapter.ts';

export type DeployLifecycleStatus =
  | 'not-configured'
  | 'pending'
  | 'succeeded'
  | 'failed'
  | 'timed-out'
  | 'unknown';

export type DeployEvidence = {
  status: DeployLifecycleStatus;
  label: string;
  state: OperationalState;
  requestedAt?: string;
  completedAt?: string;
  reason?: string;
  commit?: string;
};

export type DeployLedgerEvent = {
  id: string;
  ts: string;
  item: string;
  type: string;
  data: Record<string, unknown>;
};

const STATUS_VIEW: Record<DeployLifecycleStatus, { label: string; state: OperationalState }> = {
  'not-configured': { label: 'Not configured', state: 'neutral' },
  pending: { label: 'Pending', state: 'progress' },
  succeeded: { label: 'Succeeded', state: 'success' },
  failed: { label: 'Failed', state: 'critical' },
  'timed-out': { label: 'Timed out', state: 'critical' },
  unknown: { label: 'Status unavailable for legacy record', state: 'neutral' },
};

export function deployStatusView(status: DeployLifecycleStatus): { label: string; state: OperationalState } {
  return STATUS_VIEW[status];
}

function isDeployStatus(value: unknown): value is DeployLifecycleStatus {
  return value === 'not-configured' || value === 'pending' || value === 'succeeded'
    || value === 'failed' || value === 'timed-out';
}

/** Fold truth wins. Raw events are a compatibility fallback for older summary producers. */
export function deployEvidenceFromMerged(
  item: FoldMergedItem,
  events: DeployLedgerEvent[] = [],
): DeployEvidence {
  let status: DeployLifecycleStatus | undefined =
    isDeployStatus(item.deployStatus) ? item.deployStatus : undefined;
  let requestedAt = item.deployRequestedAt;
  let completedAt = item.deployCompletedAt;
  let reason = item.deployFailureReason;
  let commit = item.mergeCommit;

  if (!status) {
    const last = events
      .filter((e) => e.item === item.id && (
        e.type === 'deploy.requested'
        || e.type === 'deploy.succeeded'
        || e.type === 'deploy.failed'
        || e.type === 'deploy.timed-out'
      ))
      .sort((a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id))
      .at(-1);
    if (last?.type === 'deploy.requested') {
      status = 'pending';
      requestedAt = last.ts;
    } else if (last?.type === 'deploy.succeeded') {
      status = 'succeeded';
      completedAt = last.ts;
      if (typeof last.data['commit'] === 'string') commit = last.data['commit'];
    } else if (last?.type === 'deploy.failed') {
      status = 'failed';
      completedAt = last.ts;
      if (typeof last.data['reason'] === 'string') reason = last.data['reason'];
    } else if (last?.type === 'deploy.timed-out') {
      status = 'timed-out';
      completedAt = last.ts;
      if (typeof last.data['reason'] === 'string') reason = last.data['reason'];
    }
  }

  // Absent lifecycle evidence is legacy/unknown, never inferred from the compatibility
  // `deployed` boolean. Current producers emit explicit configuration/lifecycle truth.
  status ??= item.deployConfigured === false ? 'not-configured' : 'unknown';
  const view = deployStatusView(status);
  const label = status === 'unknown' && item.deployConfigured === true
    ? 'Configured · receipt not recorded'
    : view.label;
  return {
    status,
    label,
    state: view.state,
    ...(requestedAt ? { requestedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(reason ? { reason } : {}),
    ...(commit ? { commit } : {}),
  };
}
