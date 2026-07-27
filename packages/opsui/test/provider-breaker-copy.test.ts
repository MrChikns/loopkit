import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  planeObservabilityProjectionFromInput,
  type PlaneObservabilityInput,
} from '../src/projections/plane-observability-adapter.ts';
import { PlaneObservabilityProjection } from '../src/projections/plane-observability-projection.ts';

function renderProvider(status: NonNullable<PlaneObservabilityInput['providerStatus']>['status']): string {
  const input: PlaneObservabilityInput = {
    generatedAt: '2026-07-27T12:00:00.000Z',
    costs: null,
    budget: {},
    verdicts: null,
    repairs: [],
    trajectory: null,
    activeItems: [],
    tokenRows: [],
    trendPoints: [],
    transcriptSizes: [],
    acceptSplit: null,
    providerStatus: { status, value: 'legacy health-shaped source wording' },
    salvageFiles: [],
    manifestCoverage: null,
    ledgerHygiene: null,
    routing: null,
  };
  return PlaneObservabilityProjection(planeObservabilityProjectionFromInput(input, { ledgerSequence: 1 }));
}

test('provider card presents marker state and explicitly refuses to claim authentication readiness', () => {
  const html = renderProvider('met');
  assert.match(html, /Provider breaker markers/);
  assert.match(html, /Primary marker clear/);
  assert.match(html, /Authentication \/ API readiness: <strong>not checked<\/strong>/);
  assert.match(html, /does <strong>not<\/strong> test authentication, quota, network access, or live provider API readiness/i);
  assert.doesNotMatch(html, /legacy health-shaped source wording/,
    'the raw SLO value must not reintroduce an authentication-shaped health claim');
  assert.doesNotMatch(html, /LLM provider health — circuit breaker/i);
});

test('provider card names fallback and exhausted states as marker outcomes', () => {
  assert.match(renderProvider('at-risk'), /Fallback selected/);
  assert.match(renderProvider('breached'), /Chain marked blocked/);
});
