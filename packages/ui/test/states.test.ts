import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  OPERATIONAL_STATES,
  type OperationalState,
  type SloState,
  type WorkState,
} from '../src/states/operational-state.ts';
import {
  sloStateToOperationalState,
  workStateToOperationalState,
} from '../src/states/state-map.ts';
import {
  STATE_PRECEDENCE,
  highestState,
} from '../src/states/state-precedence.ts';

test('precedence is critical > warning > progress > success > info > neutral', () => {
  assert.deepEqual(STATE_PRECEDENCE, [
    'critical',
    'warning',
    'progress',
    'success',
    'info',
    'neutral',
  ]);
});

test('highestState picks the winner of a mixed set', () => {
  assert.equal(highestState(['neutral', 'progress', 'success']), 'progress');
  assert.equal(highestState(['info', 'warning', 'critical']), 'critical');
  assert.equal(highestState(['success', 'info']), 'success');
});

test('highestState defaults to neutral on empty input', () => {
  assert.equal(highestState([]), 'neutral');
});

test('work-state map is total over every WorkState', () => {
  const all: WorkState[] = [
    'queued',
    'building',
    'testing',
    'needs-acceptance',
    'parked',
    'blocked',
    'shipped',
    'resolved',
    'retired',
  ];
  for (const s of all) {
    const mapped: OperationalState = workStateToOperationalState[s];
    assert.ok(OPERATIONAL_STATES.includes(mapped));
  }
  assert.equal(workStateToOperationalState.blocked, 'critical');
  assert.equal(workStateToOperationalState.building, 'progress');
  assert.equal(workStateToOperationalState['needs-acceptance'], 'warning');
});

test('slo-state map matches the spec', () => {
  const all: SloState[] = ['healthy', 'degraded', 'breached', 'unknown'];
  for (const s of all) assert.ok(OPERATIONAL_STATES.includes(sloStateToOperationalState[s]));
  assert.equal(sloStateToOperationalState.breached, 'critical');
  assert.equal(sloStateToOperationalState.healthy, 'success');
});
