// Central, deterministic state mapping. No projection or component
// may redefine these. Domain states map to operational (visual) states here and
// nowhere else, so a colour meaning is chosen exactly once.

import type { OperationalState, SloState, WorkState } from './operational-state.ts';

/** Projection freshness/failure state → visual state, chosen once here
 *  so the ContextBar/ProjectionFailure never re-decide what "stale" or "failed" look
 *  like. */
export type ProjectionRenderState = 'fresh' | 'stale' | 'failed';

export const projectionStateToOperationalState: Record<ProjectionRenderState, OperationalState> = {
  fresh: 'success',
  stale: 'warning',
  failed: 'critical',
};

export function operationalStateForProjection(state: ProjectionRenderState): OperationalState {
  return projectionStateToOperationalState[state];
}

export const workStateToOperationalState: Record<WorkState, OperationalState> = {
  queued: 'neutral',
  building: 'progress',
  testing: 'progress',
  'needs-acceptance': 'warning',
  parked: 'neutral',
  blocked: 'critical',
  shipped: 'success',
  resolved: 'success',
  retired: 'neutral',
};

export const sloStateToOperationalState: Record<SloState, OperationalState> = {
  healthy: 'success',
  degraded: 'warning',
  breached: 'critical',
  unknown: 'neutral',
};

export function operationalStateForWork(state: WorkState): OperationalState {
  return workStateToOperationalState[state];
}

export function operationalStateForSlo(state: SloState): OperationalState {
  return sloStateToOperationalState[state];
}
