// Operational states — one meaning across the entire product.
// Strict closed unions: never `string` for a semantic state.

export type OperationalState =
  | 'critical'
  | 'warning'
  | 'success'
  | 'progress'
  | 'info'
  | 'neutral';

export const OPERATIONAL_STATES: readonly OperationalState[] = [
  'critical',
  'warning',
  'success',
  'progress',
  'info',
  'neutral',
];

/** One-line meaning per state (canonical/semantic-states.json). */
export const STATE_MEANING: Record<OperationalState, string> = {
  critical: 'Blocking, failed, destructive, or immediate human attention',
  warning: 'Degraded, needs testing, approaching threshold, or non-blocking risk',
  success: 'Healthy, accepted, verified, shipped, or completed',
  progress: 'Actively changing or running',
  info: 'Informational guidance or recommendation',
  neutral:
    'Queued, waiting, parked without urgency, metadata, unavailable, or unknown',
};

/** Canonical work-item states. */
export type WorkState =
  | 'queued'
  | 'building'
  | 'testing'
  | 'needs-acceptance'
  | 'parked'
  | 'blocked'
  | 'shipped'
  | 'resolved'
  | 'retired';

/** Canonical SLO states. */
export type SloState = 'healthy' | 'degraded' | 'breached' | 'unknown';
