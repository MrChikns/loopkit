import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  HEAL_ACTIVITY_RENDER_LIMIT,
  healthProjectionFromBoard,
  type HealActivityEntry,
} from '../src/projections/health-adapter.ts';
import { HealthProjection } from '../src/projections/health-projection.ts';

const NOW = '2026-07-27T12:00:00.000Z';
const BOARD = {
  rollup: { status: 'met', label: 'Healthy', breached: 0, atRisk: 0 },
  panes: [],
};

function proposedAt(minutesAgo: number, key = `rule-${minutesAgo}`): HealActivityEntry {
  return {
    ts: new Date(new Date(NOW).getTime() - minutesAgo * 60_000).toISOString(),
    key,
    kind: 'proposed',
    action: 'inspect',
  };
}

test('self-heal feed defaults to 24h and wider windows keep every in-window row below the explicit bound', () => {
  const activity = Array.from({ length: 75 }, (_, index) => proposedAt((index + 1) * 6 * 60));

  const defaultEnvelope = healthProjectionFromBoard(BOARD, {
    ledgerSequence: 1,
    generatedAt: NOW,
    healActivity: activity,
  });
  assert.equal(defaultEnvelope.state, 'fresh');
  if (defaultEnvelope.state === 'failed') return;
  assert.equal(defaultEnvelope.data.healWindow, '24h');
  assert.equal(defaultEnvelope.data.healActivity?.length, 3, '24h includes only the first three six-hour rows');

  const wideEnvelope = healthProjectionFromBoard(BOARD, {
    ledgerSequence: 1,
    generatedAt: NOW,
    healActivity: activity,
    window: '30d',
  });
  assert.equal(wideEnvelope.state, 'fresh');
  if (wideEnvelope.state === 'failed') return;
  assert.equal(wideEnvelope.data.healActivity?.length, 75, '30d must not silently stop at the former 30-row pre-filter cap');
  assert.equal(wideEnvelope.data.healActivityTruncated, undefined);
});

test('self-heal feed bounds only after window filtering and surfaces the truncation', () => {
  const activity = Array.from(
    { length: HEAL_ACTIVITY_RENDER_LIMIT + 1 },
    (_, index) => proposedAt(index + 1),
  );
  const envelope = healthProjectionFromBoard(BOARD, {
    ledgerSequence: 1,
    generatedAt: NOW,
    healActivity: activity,
  });
  assert.equal(envelope.state, 'fresh');
  if (envelope.state === 'failed') return;
  assert.equal(envelope.data.healActivity?.length, HEAL_ACTIVITY_RENDER_LIMIT);
  assert.equal(envelope.data.healActivityTruncated, true);

  const html = HealthProjection(envelope);
  assert.match(html, new RegExp(`Showing the newest ${HEAL_ACTIVITY_RENDER_LIMIT} events; more exist in this window\\.`));
});

test('an escalation count is a neutral event count, not a claim about the selected window', () => {
  const envelope = healthProjectionFromBoard(BOARD, {
    ledgerSequence: 1,
    generatedAt: NOW,
    healActivity: [{
      ts: proposedAt(10).ts,
      key: 'no-commit-park',
      kind: 'escalated',
      action: 'still blocked',
      count: 9,
    }],
  });
  const html = HealthProjection(envelope);
  assert.match(html, />count: 9</);
  assert.doesNotMatch(html, /9× in window/);
});
