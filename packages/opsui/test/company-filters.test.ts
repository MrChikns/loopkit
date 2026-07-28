import assert from 'node:assert/strict';
import { test } from 'node:test';

import { companyProjectionFromInput, type DecisionCard } from '../src/projections/company-adapter.ts';
import { CompanyProjection } from '../src/projections/company-projection.ts';

const decisions: DecisionCard[] = [
  { id: 'RFC-904', title: 'Current API', date: '2026-04-01', status: 'Active', targetName: 'api' },
  { id: 'RFC-903', title: 'Old API', date: '2026-03-01', status: 'Superseded by RFC-904', targetName: 'api' },
  { id: 'RFC-902', title: 'Current web', date: '2026-02-01', status: 'Active', targetName: 'web' },
  { id: 'RFC-901', title: 'Old web', date: '2026-01-01', status: 'Superseded', targetName: 'web' },
];

test('Decisions & docs defaults to active decisions and hides superseded entries', () => {
  const env = companyProjectionFromInput(
    { decisions },
    { ledgerSequence: 1, generatedAt: '2026-07-28T00:00:00.000Z', targetNames: ['api', 'web'] },
  );

  assert.deepEqual(env.data.decisions.map((decision) => decision.id), ['RFC-904', 'RFC-902']);
  assert.equal(env.data.statusFilter, 'active');
  const html = CompanyProjection(env);
  assert.match(html, /RFC-904 — Current API/);
  assert.doesNotMatch(html, /RFC-903 — Old API/);
});

test('decision query/status/target/page links preserve the other filters', () => {
  const many = Array.from({ length: 5 }, (_, index): DecisionCard => ({
    id: `RFC-${920 - index}`,
    title: `API choice ${index}`,
    date: `2026-04-0${index + 1}`,
    status: index === 4 ? 'Active' : 'Superseded',
    targetName: 'api',
  }));
  const env = companyProjectionFromInput(
    { decisions: many },
    {
      ledgerSequence: 1,
      generatedAt: '2026-07-28T00:00:00.000Z',
      targetNames: ['api', 'web'],
      query: 'API',
      status: 'all',
      target: 'api',
      page: 2,
      pageSize: 2,
    },
  );

  assert.equal(env.data.page, 2);
  assert.equal(env.data.pageCount, 3);
  assert.match(env.data.nextHref ?? '', /q=API/);
  assert.match(env.data.nextHref ?? '', /status=all/);
  assert.match(env.data.nextHref ?? '', /target=api/);
  assert.match(env.data.nextHref ?? '', /page=3/);
  assert.match(env.data.statusLinks.find((link) => link.value === 'superseded')?.href ?? '', /q=API/);
  assert.match(env.data.statusLinks.find((link) => link.value === 'superseded')?.href ?? '', /target=api/);
  assert.doesNotMatch(env.data.statusLinks.find((link) => link.value === 'superseded')?.href ?? '', /page=/);
  assert.match(env.data.targetLinks.find((link) => link.value === 'web')?.href ?? '', /status=all/);
  assert.match(env.data.targetLinks.find((link) => link.value === 'web')?.href ?? '', /q=API/);
});
