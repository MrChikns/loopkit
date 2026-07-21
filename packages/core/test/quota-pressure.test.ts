/**
 * quota-pressure.test.ts — degraded-mode projection over quota.snapshot events.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeQuotaPressure } from '../src/quota-pressure.js';
import { makeEvent } from '../src/schema.js';

test('computeQuotaPressure: not degraded when no quota.snapshot events exist', () => {
  const result = computeQuotaPressure([], 80);
  assert.equal(result.degraded, false);
  assert.deepEqual(result.breaches, []);
});

test('computeQuotaPressure: not degraded when threshold is absent (fail-open)', () => {
  const events = [
    makeEvent('claude-quota-collector', 'claude', 'quota.snapshot', { provider: 'claude', window: 'five_hour', usedPct: 99 }),
  ];
  const result = computeQuotaPressure(events, undefined);
  assert.equal(result.degraded, false);
});

test('computeQuotaPressure: degraded when a window is at/above threshold', () => {
  const events = [
    makeEvent('claude-quota-collector', 'claude', 'quota.snapshot', { provider: 'claude', window: 'five_hour', usedPct: 85 }),
  ];
  const result = computeQuotaPressure(events, 80);
  assert.equal(result.degraded, true);
  assert.deepEqual(result.breaches, [{ provider: 'claude', window: 'five_hour', usedPct: 85 }]);
});

test('computeQuotaPressure: partial windows — one window over threshold trips degraded even if another is low', () => {
  const events = [
    makeEvent('claude-quota-collector', 'claude', 'quota.snapshot', { provider: 'claude', window: 'five_hour', usedPct: 90 }),
    makeEvent('claude-quota-collector', 'claude', 'quota.snapshot', { provider: 'claude', window: 'seven_day', usedPct: 60 }),
  ];
  const result = computeQuotaPressure(events, 80);
  assert.equal(result.degraded, true);
  assert.equal(result.breaches.length, 1);
  assert.equal(result.breaches[0].window, 'five_hour');
});

test('computeQuotaPressure: only the LATEST reading per provider:window counts, never a max/sum', () => {
  const events = [
    makeEvent('claude-quota-collector', 'claude', 'quota.snapshot', { provider: 'claude', window: 'seven_day', usedPct: 95 }, '2026-07-18T09:00:00.000Z'),
    // Window reset — a later, lower reading must supersede the earlier high one.
    makeEvent('claude-quota-collector', 'claude', 'quota.snapshot', { provider: 'claude', window: 'seven_day', usedPct: 10 }, '2026-07-19T09:00:00.000Z'),
  ];
  const result = computeQuotaPressure(events, 80);
  assert.equal(result.degraded, false, 'a window reset must not false-trigger on stale high history');
});

test('computeQuotaPressure: unparseable quota.snapshot events are skipped, never crash', () => {
  const malformed = makeEvent('claude-quota-collector', 'claude', 'quota.snapshot', {
    provider: 'claude', window: 'five_hour', usedPct: 95,
  });
  // Simulate a corrupt/legacy event missing required fields (e.g. a replay from before the
  // field existed) — the runtime guard must skip it, not throw.
  delete (malformed.data as unknown as Record<string, unknown>).usedPct;
  const result = computeQuotaPressure([malformed], 80);
  assert.equal(result.degraded, false);
});

test('computeQuotaPressure: provider windows are independent — one provider breach needs no other provider data', () => {
  const events = [
    makeEvent('codex-usage-collector', 'codex', 'quota.snapshot', { provider: 'codex', window: 'primary', usedPct: 82 }),
  ];
  const result = computeQuotaPressure(events, 80);
  assert.equal(result.degraded, true);
  assert.equal(result.breaches[0].provider, 'codex');
});
