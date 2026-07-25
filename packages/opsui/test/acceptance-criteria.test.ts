// WI-193 win 3 — the acceptance desk renders the bar beside what shipped.
//
// The operator is the throughput bottleneck, so the payoff of acceptance criteria is not
// automation: it is that "what was promised" and "what shipped" sit on the same row, and the
// judgement gets faster with no new machinery. These pin that the criteria actually reach the
// desk, and — the part that makes them trustworthy — that an ABSENT bar renders a stated
// reason rather than a blank, the same doctrine the certification block already follows.
//
// Same entry point as acceptance-certification.test.ts: acceptanceProjectionFromFold(...).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { acceptanceProjectionFromFold } from '../src/projections/acceptance-adapter.ts';
import { AcceptanceProjection } from '../src/projections/acceptance-projection.ts';
import type { FoldSummary } from '../src/projections/fold-adapter.ts';

const NOW = '2026-07-20T12:00:00.000Z';
const MERGED_AT = '2026-07-20T10:00:00.000Z';

function baseFold(overrides: Partial<FoldSummary> = {}): FoldSummary {
  return { counts: {}, active: [], recentMerged: [], generatedAt: NOW, ...overrides };
}

const CRITERIA = [
  'A day marked closed shows the banner on the day view.',
  'An open day shows no banner.',
];

test('a merged item carrying acceptance criteria surfaces them on the queue row', () => {
  const fold = baseFold({
    recentMerged: [{ id: 'WI-960', spec: 'Closed-today banner', mergedAt: MERGED_AT, criteria: CRITERIA }],
  });
  const row = acceptanceProjectionFromFold(fold, { ledgerSequence: 1 }).data.queue.find((r) => r.id === 'WI-960');
  assert.ok(row, 'the merged item appears on the acceptance queue');
  assert.deepEqual(row!.criteria, CRITERIA, 'the bar must travel with the item, not be re-derived');
});

test('the rendered desk shows each criterion, and says they predate the work', () => {
  const fold = baseFold({
    recentMerged: [{ id: 'WI-961', spec: 'Closed-today banner', mergedAt: MERGED_AT, criteria: CRITERIA, tier: 'review' }],
  });
  const html = AcceptanceProjection(acceptanceProjectionFromFold(fold, { ledgerSequence: 1 }));
  for (const c of CRITERIA) {
    assert.ok(html.includes(c), `the desk must render the criterion verbatim: ${c}`);
  }
  assert.ok(
    /Promised before the work started/.test(html),
    'the operator needs to know the bar was written first — that is why it can be trusted as a bar',
  );
});

test('a merged item with NO criteria renders a visible reason, never a silent blank', () => {
  const fold = baseFold({
    recentMerged: [{ id: 'WI-962', spec: 'Old work', mergedAt: MERGED_AT, criteriaExempt: true, tier: 'review' }],
  });
  const html = AcceptanceProjection(acceptanceProjectionFromFold(fold, { ledgerSequence: 1 }));
  assert.ok(
    /predates the requirement/.test(html),
    'a blank where a promise should be reads like a promise that was kept — name the exemption',
  );
});

test('an un-exempt item with no criteria does NOT borrow the grandfathering excuse', () => {
  const fold = baseFold({
    recentMerged: [{ id: 'WI-963', spec: 'Recent work', mergedAt: MERGED_AT, tier: 'review' }],
  });
  const html = AcceptanceProjection(acceptanceProjectionFromFold(fold, { ledgerSequence: 1 }));
  assert.ok(/No acceptance criteria recorded/.test(html), 'the gap is still stated out loud');
  assert.ok(!/predates the requirement/.test(html), 'but not excused with a reason that is not true');
});

test('criteria are escaped, not injected — the desk renders operator text, not markup', () => {
  const fold = baseFold({
    recentMerged: [{
      id: 'WI-964', spec: 'x', mergedAt: MERGED_AT, tier: 'review',
      criteria: ['<img src=x onerror=alert(1)> shows the banner'],
    }],
  });
  const html = AcceptanceProjection(acceptanceProjectionFromFold(fold, { ledgerSequence: 1 }));
  assert.ok(!html.includes('<img src=x'), 'criteria text must be escaped before it reaches the DOM');
  assert.ok(html.includes('&lt;img src=x'), 'and still be readable to the operator');
});

test('the criteria block sits before the certification block (promise, then risk)', () => {
  const fold = baseFold({
    recentMerged: [{
      id: 'WI-965', spec: 'x', mergedAt: MERGED_AT, tier: 'review',
      criteria: ['UNIQUE_CRITERION_MARKER'],
      certification: { couldBreak: 'UNIQUE_CERT_MARKER', detection: 'd', rollback: 'r' },
    }],
  });
  const html = AcceptanceProjection(acceptanceProjectionFromFold(fold, { ledgerSequence: 1 }));
  const critAt = html.indexOf('UNIQUE_CRITERION_MARKER');
  const certAt = html.indexOf('UNIQUE_CERT_MARKER');
  assert.ok(critAt >= 0 && certAt >= 0, 'both blocks render');
  assert.ok(critAt < certAt, 'the operator reads "what was promised" before "what could break"');
});
