// State precedence. When several conditions apply, render the
// highest-precedence state:
//
//   critical > warning > progress > success > info > neutral
//
// Exception: a live worker with a blocking failure is `critical`,
// not `progress`. Callers model that by passing `critical` for such a worker;
// this function only resolves the winner of a set.

import type { OperationalState } from './operational-state.ts';

export const STATE_PRECEDENCE: readonly OperationalState[] = [
  'critical',
  'warning',
  'progress',
  'success',
  'info',
  'neutral',
];

const RANK: Record<OperationalState, number> = {
  critical: 0,
  warning: 1,
  progress: 2,
  success: 3,
  info: 4,
  neutral: 5,
};

/** The highest-precedence state present. Empty input resolves to `neutral`. */
export function highestState(
  states: readonly OperationalState[],
): OperationalState {
  let winner: OperationalState = 'neutral';
  for (const state of states) {
    if (RANK[state] < RANK[winner]) winner = state;
  }
  return winner;
}
