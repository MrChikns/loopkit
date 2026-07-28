import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  WORK_GROUP_IDS,
  classifyWorkGroup,
  workProjectionFromFold,
  type WorkGroupId,
} from '../src/projections/work-adapter.ts';
import { WorkProjection } from '../src/projections/work-projection.ts';
import type { FoldActiveItem, FoldSummary } from '../src/projections/fold-adapter.ts';

const NOW = Date.parse('2026-07-28T12:00:00.000Z');
const ago = (hours: number) => new Date(NOW - hours * 60 * 60 * 1000).toISOString();

function summary(active: FoldActiveItem[], queueBlocking: FoldSummary['queueBlocking'] = []): FoldSummary {
  return {
    counts: {},
    active,
    recentMerged: [],
    queueBlocking,
    generatedAt: new Date(NOW).toISOString(),
  };
}

test('Work group classifier pins every semantic group', () => {
  const cases: Array<{
    label: string;
    item: FoldActiveItem;
    queue?: NonNullable<FoldSummary['queueBlocking']>[number];
    expected: WorkGroupId;
  }> = [
    { label: 'decision', item: { id: 'WI-1', state: 'parked', parkKind: 'decision' }, expected: 'needs-decision' },
    { label: 'breaker needs fresh unpark', item: { id: 'WI-2', state: 'queued' }, queue: { id: 'WI-2', runnable: false, reason: '5 attempts — needs fresh unpark' }, expected: 'needs-decision' },
    { label: 'building', item: { id: 'WI-3', state: 'building' }, expected: 'in-progress' },
    { label: 'blocked edge', item: { id: 'WI-4', state: 'parked', parkKind: 'ops', blockedOn: 'WI-40' }, expected: 'waiting-dependency' },
    { label: 'scope wait', item: { id: 'WI-5', state: 'queued' }, queue: { id: 'WI-5', runnable: false, reason: 'waiting on WI-3 (touches src)' }, expected: 'waiting-dependency' },
    { label: 'queued', item: { id: 'WI-6', state: 'queued' }, expected: 'queued' },
    { label: 'ops recovery', item: { id: 'WI-7', state: 'parked', parkKind: 'ops' }, expected: 'recovering' },
    { label: 'legacy recovery', item: { id: 'WI-8', state: 'parked' }, expected: 'recovering' },
    { label: 'hold', item: { id: 'WI-9', state: 'parked', parkKind: 'hold' }, expected: 'held' },
    { label: 'planner', item: { id: 'WI-10', state: 'parked', parkKind: 'decomposition' }, expected: 'planning' },
  ];

  for (const c of cases) {
    assert.equal(classifyWorkGroup(c.item, c.queue), c.expected, c.label);
  }
});

test('Work rows carry compact reason, age, blocker, and next action fields', () => {
  const env = workProjectionFromFold(summary([
    {
      id: 'WI-20',
      state: 'parked',
      parkKind: 'ops',
      parkReason: 'plane repair in progress',
      parkedAt: ago(9),
      blockedOn: 'WI-21',
      blockerState: 'parked',
      blockerParkKind: 'hold',
      spec: 'Deliver the dependent change',
    },
  ]), { ledgerSequence: 1 });

  const item = env.data.active[0]!;
  assert.equal(item.group, 'waiting-dependency');
  assert.equal(item.reason, 'Blocked on WI-21');
  assert.equal(item.age, '9h');
  assert.deepEqual(item.blocker, { id: 'WI-21', state: 'parked', parkKind: 'hold' });
  assert.equal(item.nextAction, 'Resume WI-21 first');

  const html = WorkProjection(env);
  assert.match(html, /plane repair in progress|Blocked on WI-21/);
  assert.match(html, /age 9h/);
  assert.match(html, /blocked by WI-21/);
  assert.match(html, /<strong>Next:<\/strong> Resume WI-21 first/);
  assert.match(html, /href="\/item\/WI-21"/);
  assert.doesNotMatch(html, /<details class="opsui-work__drill" open>/, 'evidence details stay closed by default');
});

test('Work groups filter without JS and paginate independently', () => {
  const decisionItems: FoldActiveItem[] = Array.from({ length: 9 }, (_, index) => ({
    id: `WI-${100 + index}`,
    state: 'parked',
    parkKind: 'decision',
    parkReason: 'operator call',
  }));
  const heldItems: FoldActiveItem[] = Array.from({ length: 9 }, (_, index) => ({
    id: `WI-${200 + index}`,
    state: 'parked',
    parkKind: 'hold',
    parkReason: 'hold: later',
  }));
  const env = workProjectionFromFold(summary([...decisionItems, ...heldItems]), {
    ledgerSequence: 1,
    pages: { 'needs-decision': 2, held: 2 },
  });

  assert.deepEqual(env.data.groups?.map((group) => group.id), [...WORK_GROUP_IDS]);
  const decision = env.data.groups?.find((group) => group.id === 'needs-decision');
  const held = env.data.groups?.find((group) => group.id === 'held');
  assert.equal(decision?.page, 2);
  assert.equal(decision?.items.length, 1);
  assert.match(decision?.prevHref ?? '', /decisionPage=1|#work-group-needs-decision/);
  assert.match(decision?.prevHref ?? '', /heldPage=2/, 'paging Decisions preserves Held page');
  assert.equal(held?.page, 2);
  assert.match(held?.prevHref ?? '', /decisionPage=2/, 'paging Held preserves Decisions page');

  const filtered = workProjectionFromFold(summary([...decisionItems, ...heldItems]), {
    ledgerSequence: 1,
    group: 'held',
  });
  const html = WorkProjection(filtered);
  assert.match(html, /aria-label="Filter work groups"/);
  assert.match(html, /href="\/work\?group=held#work-board" aria-current="page"/);
  assert.match(html, /data-work-group="held"/);
  assert.doesNotMatch(html, /data-work-group="needs-decision"/);
  assert.doesNotMatch(html, /WI-100 —/, 'filtered group does not render decision rows');
  assert.match(html, /WI-200 —|WI-200/);
  assert.doesNotMatch(html, /<script/u, 'group filtering remains zero-JS');
});
