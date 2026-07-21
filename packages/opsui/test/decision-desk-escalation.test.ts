// WI-056 regression coverage — the decision desk must render the leader-leader escalation
// payload (Intent/Evidence/Risk/Recommendation) when a parked item's `escalation` field is
// present, and fall back to the existing derived What-it-is/Why-parked pair when it is absent
// (legacy park events may omit this field).
//
// These tests exercise `commandProjectionFromFold(...).data.decisionDesk` — the public
// entry point — mirroring recent-intents.test.ts's pattern (assert on the projection's public
// output, not the unexported `buildDecisionBlock` helper).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { commandProjectionFromFold } from '../src/projections/fold-adapter.ts';
import type { FoldSummary } from '../src/projections/fold-adapter.ts';

const NOW = '2026-07-20T12:00:00.000Z';

function baseFold(overrides: Partial<FoldSummary> = {}): FoldSummary {
  return {
    counts: {},
    active: [],
    recentMerged: [],
    generatedAt: NOW,
    ...overrides,
  };
}

const ESCALATION = {
  intent: 'I intend to add a KMS drop-in behind the existing secrets port.',
  evidence: 'The port already abstracts key storage; only one adapter exists today.',
  risk: 'A migration bug could strand secrets mid-cutover.',
  recommendation: 'Approve — the adapter ships behind a flag, rollback is a config flip.',
};

test('a decision park carrying an escalation payload renders it on the decision block', () => {
  const fold = baseFold({
    active: [
      {
        id: 'WI-700',
        state: 'parked',
        parkKind: 'decision',
        spec: 'Add KMS drop-in',
        parkReason: 'needs decision: hosting KMS approach',
        escalation: ESCALATION,
      },
    ],
  });

  const envelope = commandProjectionFromFold(fold, { ledgerSequence: 1 });
  const row = envelope.data.decisionDesk.find((r) => r.evidence?.id === 'WI-700');

  assert.ok(row, 'the parked item appears on the decision desk');
  assert.ok(row!.decisionBlock, 'a decision block is rendered');
  assert.deepEqual(row!.decisionBlock!.escalation, ESCALATION);
});

test('a decision park with NO escalation payload still renders the derived What-it-is/Why-parked pair (fallback)', () => {
  const fold = baseFold({
    active: [
      {
        id: 'WI-701',
        state: 'parked',
        parkKind: 'decision',
        spec: 'Old-shape park',
        parkReason: 'needs decision: hosting',
      },
    ],
  });

  const envelope = commandProjectionFromFold(fold, { ledgerSequence: 1 });
  const row = envelope.data.decisionDesk.find((r) => r.evidence?.id === 'WI-701');

  assert.ok(row, 'the parked item appears on the decision desk');
  assert.ok(row!.decisionBlock, 'a decision block is rendered');
  assert.equal(row!.decisionBlock!.escalation, undefined, 'no escalation payload on an old-shape park');
  assert.ok(row!.decisionBlock!.whatItIs, 'the derived whatItIs fallback still renders');
  assert.ok(row!.decisionBlock!.whyParked, 'the derived whyParked fallback still renders');
});
