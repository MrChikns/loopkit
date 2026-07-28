/**
 * criteria-surfaces.test.ts — WI-193 win 3: the bar is rendered beside the work.
 *
 * This is the win that pays without any new automation: the operator is the throughput
 * bottleneck, and showing what was promised next to what shipped makes the human judgement
 * faster. These pin the three properties that make it trustworthy rather than decorative:
 *
 *   - the board and the fold summary actually carry the criteria;
 *   - WI-185 — a respec that amends the bar must not leave the OLD bar on screen, exactly as
 *     the amended `spec` already replaces the superseded capture text;
 *   - an absent bar renders a stated reason, never a blank that reads like compliance.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fold } from '../src/fold.js';
import { makeEvent } from '../src/schema.js';
import { renderBoard } from '../src/board.js';
import { buildSummary } from '../src/summary.js';
import { CONFIG_DEFAULTS } from '../src/config.js';

const AFTER_CUTOFF = '2099-01-01T00:00:00.000Z';
const BEFORE_CUTOFF = '2020-01-01T00:00:00.000Z';

function boardFor(events: Parameters<typeof fold>[0]): string {
  return renderBoard(fold(events));
}

function summaryFor(events: Parameters<typeof fold>[0]) {
  const result = fold(events);
  return buildSummary(result, events, { cfg: CONFIG_DEFAULTS, repoRoot: process.cwd() });
}

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

test('board: a queued item renders its acceptance criteria beside the spec', () => {
  const md = boardFor([
    makeEvent('cli', 'WI-950', 'item.captured', { source: 'test', text: 'add a banner' }, AFTER_CUTOFF),
    makeEvent('reactor', 'WI-950', 'item.queued', {
      spec: 'Add a closed-today banner.',
      criteria: ['A closed day shows the banner.', 'An open day shows no banner.'],
    }, AFTER_CUTOFF),
  ]);
  assert.match(md, /acceptance criteria:/);
  assert.match(md, /- A closed day shows the banner\./);
  assert.match(md, /- An open day shows no banner\./);
  assert.match(md, /Add a closed-today banner\./, 'the spec is still there — criteria sit beside it, not instead of it');
});

test('board: WI-185 — a respec\'d bar shows the NEW criteria and not the superseded ones', () => {
  const md = boardFor([
    makeEvent('cli', 'WI-951', 'item.captured', { source: 'test', text: 'x' }, AFTER_CUTOFF),
    makeEvent('reactor', 'WI-951', 'item.queued', {
      spec: 'original', criteria: ['SUPERSEDED promise', 'kept promise'],
    }, AFTER_CUTOFF),
    makeEvent('cli', 'WI-951', 'item.respec', {
      spec: 'narrowed', reason: 'operator steer', criteria: ['kept promise'],
    }, AFTER_CUTOFF),
  ]);
  assert.doesNotMatch(md, /SUPERSEDED promise/,
    'a withdrawn promise must not keep sitting on the board — the operator would test against it');
  assert.match(md, /- kept promise/);
  assert.match(md, /narrowed/, 'and the amended spec renders too (the rule this follows)');
});

test('board: an item with NO bar says so, and says why, rather than rendering silence', () => {
  const grandfathered = boardFor([
    makeEvent('cli', 'WI-952', 'item.captured', { source: 'test', text: 'x' }, BEFORE_CUTOFF),
    makeEvent('reactor', 'WI-952', 'item.queued', { spec: 'old work' }, BEFORE_CUTOFF),
  ]);
  assert.match(grandfathered, /predates the requirement/,
    'a blank where a bar should be reads like a bar that was met — name the exemption');
});

test('board: the absence note is scoped to states where a bar was expected', () => {
  // An `answered` item was never going to be measured against a bar; a note there is noise
  // that trains the eye to skip the line that matters.
  const md = boardFor([
    makeEvent('cli', 'WI-953', 'item.captured', { source: 'test', text: 'is the plane up?' }, AFTER_CUTOFF),
    makeEvent('reactor', 'WI-953', 'item.routed', { route: 'answer', reply: 'yes, all green' }, AFTER_CUTOFF),
  ]);
  assert.equal(fold([
    makeEvent('cli', 'WI-953', 'item.captured', { source: 'test', text: 'is the plane up?' }, AFTER_CUTOFF),
    makeEvent('reactor', 'WI-953', 'item.routed', { route: 'answer', reply: 'yes, all green' }, AFTER_CUTOFF),
  ]).items.get('WI-953')?.state, 'answered', 'sanity: the fixture is an answered item');
  assert.doesNotMatch(md, /acceptance criteria/i);
  assert.doesNotMatch(md, /predates the requirement/);
});

// ---------------------------------------------------------------------------
// The fold summary — what the console and the acceptance desk actually read
// ---------------------------------------------------------------------------

test('summary: an active item carries its criteria to the console', () => {
  const s = summaryFor([
    makeEvent('cli', 'WI-954', 'item.captured', { source: 'test', text: 'x' }, AFTER_CUTOFF),
    makeEvent('reactor', 'WI-954', 'item.queued', { spec: 'do it', criteria: ['the bar'] }, AFTER_CUTOFF),
  ]);
  const active = (s.active as Array<Record<string, unknown>>).find(a => a.id === 'WI-954');
  assert.deepEqual(active?.criteria, ['the bar']);
});

test('summary: a gated item remains active and carries its stage timestamp to the console', () => {
  const gatedAt = '2099-01-01T00:03:00.000Z';
  const s = summaryFor([
    makeEvent('cli', 'WI-959', 'item.captured', { source: 'test', text: 'x' }, AFTER_CUTOFF),
    makeEvent('reactor', 'WI-959', 'item.queued', { spec: 'gate it' }, '2099-01-01T00:01:00.000Z'),
    makeEvent('dispatch', 'WI-959', 'build.dispatched', { attempt: 1, pid: 1 }, '2099-01-01T00:02:00.000Z'),
    makeEvent('dispatch', 'WI-959', 'gate.passed', {}, gatedAt),
  ]);
  const active = (s.active as Array<Record<string, unknown>>).find(a => a.id === 'WI-959');

  assert.equal(active?.state, 'gated');
  assert.equal(active?.gatedAt, gatedAt);
});

test('summary: a MERGED item carries its criteria — this is the acceptance-desk pair', () => {
  const mergedAt = '2099-06-01T00:00:00.000Z';
  const s = summaryFor([
    makeEvent('cli', 'WI-955', 'item.captured', { source: 'test', text: 'x' }, AFTER_CUTOFF),
    makeEvent('reactor', 'WI-955', 'item.queued', { spec: 'do it', criteria: ['the bar'] }, AFTER_CUTOFF),
    makeEvent('dispatch', 'WI-955', 'item.merged', { commit: 'abc1234' }, mergedAt),
  ], );
  const merged = (s.recentMerged30d as Array<Record<string, unknown>>).find(m => m.id === 'WI-955');
  assert.ok(merged, 'sanity: the merged item is in the window');
  assert.deepEqual(merged!.criteria, ['the bar'],
    'the operator must see what was promised beside what shipped — that is the whole win');
});

test('summary: changed-surface links come only from an explicit HTTP(S) config value', () => {
  const mergedAt = '2099-06-01T00:00:00.000Z';
  const events = [
    makeEvent('cli', 'WI-970', 'item.captured', { source: 'test', text: 'ship UI' }, mergedAt),
    makeEvent('reactor', 'WI-970', 'item.queued', { spec: 'ship UI', touches: 'ui/' }, mergedAt),
    makeEvent('dispatch', 'WI-970', 'item.merged', { commit: 'abc970' }, mergedAt),
  ];
  const result = fold(events);
  const explicit = buildSummary(result, events, {
    cfg: { ...CONFIG_DEFAULTS, surfaceUrl: 'https://product.example.test/app' },
    repoRoot: '/checkout/is-not-a-url',
  });
  const explicitRow = (explicit.recentMerged as Array<Record<string, unknown>>)[0]!;
  assert.equal(explicitRow.surfaceUrl, 'https://product.example.test/app');

  const invalid = buildSummary(result, events, {
    cfg: { ...CONFIG_DEFAULTS, surfaceUrl: '/checkout/is-not-a-url' },
    repoRoot: '/checkout/is-not-a-url',
  });
  const invalidRow = (invalid.recentMerged as Array<Record<string, unknown>>)[0]!;
  assert.equal(invalidRow.surfaceUrl, undefined, 'repo paths never become product links');
});

test('summary: WI-185 — the merged record carries the AMENDED bar, not the original', () => {
  const mergedAt = '2099-06-01T00:00:00.000Z';
  const s = summaryFor([
    makeEvent('cli', 'WI-956', 'item.captured', { source: 'test', text: 'x' }, AFTER_CUTOFF),
    makeEvent('reactor', 'WI-956', 'item.queued', { spec: 'a', criteria: ['SUPERSEDED', 'kept'] }, AFTER_CUTOFF),
    makeEvent('cli', 'WI-956', 'item.respec', { spec: 'b', reason: 'steer', criteria: ['kept'] }, AFTER_CUTOFF),
    makeEvent('dispatch', 'WI-956', 'item.merged', { commit: 'abc1234' }, mergedAt),
  ]);
  const merged = (s.recentMerged30d as Array<Record<string, unknown>>).find(m => m.id === 'WI-956');
  assert.deepEqual(merged!.criteria, ['kept'],
    'accepting against a withdrawn promise is exactly the failure WI-185 exists to prevent');
});

test('summary: a grandfathered merged item carries the exemption flag, not a bare absence', () => {
  const mergedAt = '2099-06-01T00:00:00.000Z';
  const s = summaryFor([
    makeEvent('cli', 'WI-957', 'item.captured', { source: 'test', text: 'x' }, BEFORE_CUTOFF),
    makeEvent('reactor', 'WI-957', 'item.queued', { spec: 'old work' }, BEFORE_CUTOFF),
    makeEvent('dispatch', 'WI-957', 'item.merged', { commit: 'abc1234' }, mergedAt),
  ]);
  const merged = (s.recentMerged30d as Array<Record<string, unknown>>).find(m => m.id === 'WI-957');
  assert.equal(merged!.criteria, undefined);
  assert.equal(merged!.criteriaExempt, true,
    'the desk needs the reason to render "predates the requirement" instead of a blank');
});
