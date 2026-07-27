import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  planeObservabilityProjectionFromInput,
  type PlaneObservabilityInput,
} from '../src/projections/plane-observability-adapter.ts';
import { PlaneObservabilityProjection } from '../src/projections/plane-observability-projection.ts';

function input(agentRuntime: PlaneObservabilityInput['agentRuntime']): PlaneObservabilityInput {
  return {
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
    providerStatus: null,
    salvageFiles: [],
    manifestCoverage: null,
    ledgerHygiene: null,
    routing: null,
    agentRuntime,
  };
}

test('Agent runtime renders an honest read-only configuration contract for all six stages', () => {
  const stages = ['router', 'planner', 'scout', 'builder', 'judge', 'pathologist'] as const;
  const statuses = ['configured', 'requested', 'not-recorded', 'not-recorded', 'configured', 'not-recorded'] as const;
  const html = PlaneObservabilityProjection(planeObservabilityProjectionFromInput(input({
    rows: stages.map((stage, i) => ({
      stage,
      enabled: stage !== 'scout',
      providerRule: `rule for ${stage}`,
      effectiveDefault: 'internal chain: claude-cli',
      modelSource: `${stage}.model source`,
      modelValue: `${stage}-model`,
      reasoningStatus: statuses[i]!,
      reasoningDetail: `reasoning evidence for ${stage}`,
      promptSource: `safe ${stage} prompt source`,
      instructionDiscovery: `safe ${stage} instruction mode`,
    })),
  }), { ledgerSequence: 7 }));

  assert.match(html, /Agent runtime/);
  assert.match(html, /Current\/default configuration by stage/);
  assert.match(html, /Configuration snapshot, not execution history/i);
  assert.match(html, /actual run may differ/i);
  for (const stage of stages) {
    assert.match(html, new RegExp(`>${stage}<`), `expected ${stage} stage`);
    assert.match(html, new RegExp(`${stage}-model`), `expected ${stage} model`);
    assert.match(html, new RegExp(`safe ${stage} prompt source`), `expected ${stage} prompt source`);
    assert.match(html, new RegExp(`safe ${stage} instruction mode`), `expected ${stage} instruction mode`);
  }
  assert.match(html, />configured</);
  assert.match(html, />requested</);
  assert.match(html, />not recorded</);
  assert.match(html, />disabled</, 'disabled stages must remain visible and explicit');
  assert.doesNotMatch(html, /<form\b/i, 'the configuration panel must not expose mutation UI');
  assert.doesNotMatch(html, /\/Users\/|\/private\/|private-prompts/i, 'private host paths must not leak');
});

test('Agent runtime fails soft when an older caller does not report configuration', () => {
  const html = PlaneObservabilityProjection(planeObservabilityProjectionFromInput(input(undefined), { ledgerSequence: 0 }));
  assert.match(html, /Agent runtime/);
  assert.match(html, /configuration unavailable/i);
  assert.doesNotMatch(html, /internal chain:|builder\/group provider/);
});
