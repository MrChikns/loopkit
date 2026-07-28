import assert from 'node:assert/strict';
import { test } from 'node:test';

import { healthProjectionFromBoard } from '../src/projections/health-adapter.ts';
import { HealthProjection } from '../src/projections/health-projection.ts';

const board = {
  rollup: { status: 'met', label: 'healthy', breached: 0, atRisk: 0 },
  panes: [],
};

test('System keeps service, autonomy and flow independent when the service is alive but halted', () => {
  const envelope = healthProjectionFromBoard(board, {
    ledgerSequence: 1,
    generatedAt: '2026-07-20T12:00:00.000Z',
    systemAxes: [
      { key: 'service', label: 'Service', state: 'success', value: 'Healthy', detail: 'Runtime probes pass' },
      { key: 'autonomy', label: 'Autonomy', state: 'warning', value: 'Halted', detail: 'Kill switch stopped' },
      { key: 'flow', label: 'Flow', state: 'neutral', value: 'Paused', detail: 'No agentic work moves' },
    ],
    deployTargets: [
      {
        target: 'acme-web',
        status: 'pending',
        state: 'progress',
        label: 'Pending',
        detail: 'Requested now',
        configured: false,
        itemId: 'WI-100',
        surfaceUrl: 'https://acme.example.test/',
      },
    ],
  });
  const html = HealthProjection(envelope);
  assert.match(html, /Operating state/);
  assert.match(html, /Service/);
  assert.match(html, /Halted/);
  assert.match(html, /Paused/);
  assert.match(html, /Deployments by target/);
  assert.match(html, /acme-web/);
  assert.match(html, /WI-100/);
  assert.match(html, /No deploy command configured now/);
  assert.match(html, /Pending/, 'current configuration does not erase the latest durable receipt');
  assert.match(html, /https:\/\/acme\.example\.test\//);
});

test('System never renders a non-HTTP target surface as a link', () => {
  const envelope = healthProjectionFromBoard(board, {
    ledgerSequence: 1,
    deployTargets: [{
      target: 'unsafe',
      status: 'pending',
      state: 'progress',
      label: 'Pending',
      detail: 'Requested',
      surfaceUrl: 'javascript:alert(1)',
    }],
  });
  assert.ok(!HealthProjection(envelope).includes('javascript:'));
});
