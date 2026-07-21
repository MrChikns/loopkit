// Operator request: Command's "Ops health & pipeline" and "Pipeline" sections must render
// before the "Conversations" section (they previously rendered after it).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CommandProjection } from '../src/projections/command-projection.ts';
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

test('the Ops health & pipeline and Pipeline sections render before the Conversations section', () => {
  const envelope = commandProjectionFromFold(baseFold(), { ledgerSequence: 1 });
  const html = CommandProjection(envelope);

  const opsHealthIndex = html.indexOf('Ops health &amp; pipeline');
  const pipelineFlowIndex = html.indexOf('id="pipeline-flow"');
  const conversationsIndex = html.indexOf('id="conversations"');

  assert.ok(opsHealthIndex >= 0, 'the Ops health & pipeline section renders');
  assert.ok(pipelineFlowIndex >= 0, 'the Pipeline (pipeline-flow) section renders');
  assert.ok(conversationsIndex >= 0, 'the Conversations section renders');
  assert.ok(opsHealthIndex < conversationsIndex, 'Ops health & pipeline must render before Conversations');
  assert.ok(pipelineFlowIndex < conversationsIndex, 'Pipeline must render before Conversations');
});
