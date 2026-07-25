/**
 * criteria.test.ts — WI-193 win 1: acceptance criteria as a typed, REQUIRED field.
 *
 * What these pin, in the order they matter:
 *   1. The normalizer is one funnel — a criterion means the same thing wherever it entered.
 *   2. The INDEPENDENCE property: only the routing wall and the operator may author criteria.
 *      A build actor cannot write, widen, or soften its own bar even with a well-formed event.
 *   3. The requirement itself: an item may NOT reach `queued` without criteria.
 *   4. Backward compatibility: pre-cutoff items are grandfathered and RECORDED as such —
 *      never stranded, never silently exempt.
 *   5. Carry-forward: a re-queue (unpark/repair/requeue) does not strip the bar off an item.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  CRITERIA_CONTRACT,
  CRITERIA_REQUIRED_FROM,
  MAX_CRITERIA,
  MAX_CRITERION_CHARS,
  adoptCriteriaFromEvent,
  criteriaGate,
  formatCriteriaLines,
  isCriteriaGrandfathered,
  normalizeCriteria,
} from '../src/criteria.js';
import { fold } from '../src/fold.js';
import { makeEvent } from '../src/schema.js';
import { appendEvents, loadAllEvents } from '../src/ledger.js';
import { runReactor } from '../src/beats/reactor.js';
import { parseRoutingDecision } from '../src/beats/reactor.js';
import { CONFIG_DEFAULTS, LoopkitConfig } from '../src/config.js';
import { LlmProvider, ProviderRequest, ProviderResult } from '../src/providers/types.js';

/** An ISO timestamp safely AFTER the grandfather cutoff (so the requirement is live). */
const AFTER_CUTOFF = '2099-01-01T00:00:00.000Z';
/** An ISO timestamp safely BEFORE it (so grandfathering applies). */
const BEFORE_CUTOFF = '2020-01-01T00:00:00.000Z';

// ---------------------------------------------------------------------------
// 1. The one normalizer
// ---------------------------------------------------------------------------

test('criteria: the normalizer strips bullet markers, trims, and drops blanks', () => {
  const c = normalizeCriteria('- first thing\n  * second thing\n\n3. third thing\n   \n');
  assert.deepEqual(c, ['first thing', 'second thing', 'third thing']);
});

test('criteria: an array from a ledger event goes through the same funnel as a raw block', () => {
  const fromBlock = normalizeCriteria('- alpha\n- beta');
  const fromArray = normalizeCriteria(['- alpha', 'beta']);
  assert.deepEqual(fromArray, fromBlock, 'array and block sources must normalize identically');
});

test('criteria: duplicates collapse case-insensitively (a repeated bar is not two bars)', () => {
  assert.deepEqual(normalizeCriteria('- The banner shows\n- the BANNER shows'), ['The banner shows']);
});

test('criteria: the list caps at MAX_CRITERIA and each entry at MAX_CRITERION_CHARS', () => {
  const many = normalizeCriteria(Array.from({ length: MAX_CRITERIA + 5 }, (_, i) => `- item ${i}`).join('\n'));
  assert.equal(many?.length, MAX_CRITERIA, 'a list longer than the cap is a spec, not a bar');

  const long = normalizeCriteria(['- ' + 'x'.repeat(MAX_CRITERION_CHARS + 50)]);
  assert.equal(long?.length, 1, 'an over-long criterion is truncated, never dropped');
  assert.ok(long![0].length <= MAX_CRITERION_CHARS, `truncated to ${long![0].length} chars`);
  assert.ok(long![0].endsWith('…'), 'truncation is visible, never silent');
});

test('criteria: absent and empty never diverge — both normalize to undefined, never []', () => {
  assert.equal(normalizeCriteria(undefined), undefined);
  assert.equal(normalizeCriteria([]), undefined);
  assert.equal(normalizeCriteria('   \n  \n'), undefined);
  assert.equal(normalizeCriteria(42), undefined);
});

// ---------------------------------------------------------------------------
// 2. The independence property — criteria are authored BEFORE build context
// ---------------------------------------------------------------------------

test('criteria: only the routing wall and the operator may author criteria', () => {
  const raw = ['- the bar'];
  assert.deepEqual(adoptCriteriaFromEvent('reactor', raw), ['the bar'], 'the routing wall authors from raw intent');
  assert.deepEqual(adoptCriteriaFromEvent('cli', raw), ['the bar'], 'the operator authors by hand');
  assert.equal(adoptCriteriaFromEvent('dispatch', raw), undefined, 'the build lane has seen the build — it may not author the bar');
  assert.equal(adoptCriteriaFromEvent('worker', raw), undefined, 'nor may a worker');
});

test('criteria: a BUILD actor cannot lower the bar by appending a well-formed event', async () => {
  const events = [
    makeEvent('cli', 'WI-700', 'item.captured', { source: 'test', text: 'ship the thing' }, AFTER_CUTOFF),
    makeEvent('reactor', 'WI-700', 'item.queued', {
      spec: 'ship the thing',
      criteria: ['The thing is shipped and visible on the detail view.'],
    }, AFTER_CUTOFF),
    // The builder now tries to replace a hard bar with a trivially-satisfiable one.
    makeEvent('dispatch', 'WI-700', 'item.queued', {
      spec: 'ship the thing',
      criteria: ['The code compiles.'],
    }, AFTER_CUTOFF),
  ];
  const rec = fold(events).items.get('WI-700');
  assert.deepEqual(
    rec?.criteria,
    ['The thing is shipped and visible on the detail view.'],
    'the builder-authored bar must be ignored — this is the independence property',
  );
});

test('criteria: a build actor cannot author a bar onto an item that has none', () => {
  const events = [
    makeEvent('cli', 'WI-701', 'item.captured', { source: 'test', text: 'x' }, BEFORE_CUTOFF),
    makeEvent('dispatch', 'WI-701', 'item.queued', { spec: 'x', criteria: ['- whatever I did'] }, BEFORE_CUTOFF),
  ];
  const rec = fold(events).items.get('WI-701');
  assert.equal(rec?.criteria, undefined, 'a self-issued bar is no bar at all');
  assert.equal(rec?.criteriaExempt, true, 'and the absence is recorded as the grandfathered exemption it is');
});

// ---------------------------------------------------------------------------
// 3. The requirement + 4. backward compatibility
// ---------------------------------------------------------------------------

test('criteria gate: a post-cutoff item with no criteria may not be queued', () => {
  const g = criteriaGate({ criteria: undefined, capturedAt: AFTER_CUTOFF, lane: 'engineering' });
  assert.equal(g.ok, false, 'the requirement is the whole point of win 1');
  assert.match((g as { reason: string }).reason, /acceptance criteria/i);
});

test('criteria gate: criteria present ⇒ queueable and NOT exempt', () => {
  const g = criteriaGate({ criteria: ['the bar'], capturedAt: AFTER_CUTOFF, lane: 'engineering' });
  assert.deepEqual(g, { ok: true, exempt: false });
});

test('criteria gate: a pre-cutoff item is grandfathered — queueable, and the exemption is RECORDED', () => {
  const g = criteriaGate({ criteria: undefined, capturedAt: BEFORE_CUTOFF, lane: 'engineering' });
  assert.deepEqual(g, { ok: true, exempt: true }, 'existing queued work must not be stranded...');
});

test('criteria gate: grandfathering is bounded by CRITERIA_REQUIRED_FROM, not open-ended', () => {
  assert.equal(isCriteriaGrandfathered(BEFORE_CUTOFF), true);
  assert.equal(isCriteriaGrandfathered(AFTER_CUTOFF), false);
  // The boundary itself is inclusive of the requirement: at the cutoff, criteria are required.
  assert.equal(isCriteriaGrandfathered(CRITERIA_REQUIRED_FROM), false);
  // Missing / unparseable capture time is a legacy replay — never strand it.
  assert.equal(isCriteriaGrandfathered(undefined), true);
  assert.equal(isCriteriaGrandfathered('not-a-date'), true);
});

test('criteria gate: the planning lane is exempt (it writes no code to measure)', () => {
  const g = criteriaGate({ criteria: undefined, capturedAt: AFTER_CUTOFF, lane: 'planning' });
  assert.deepEqual(g, { ok: true, exempt: true });
});

// ---------------------------------------------------------------------------
// 5. Fold behaviour: carry-forward, exemption recording, respec replacement
// ---------------------------------------------------------------------------

test('criteria: a re-queue that restates only the spec does not strip the bar', () => {
  const events = [
    makeEvent('cli', 'WI-702', 'item.captured', { source: 'test', text: 'x' }, AFTER_CUTOFF),
    makeEvent('reactor', 'WI-702', 'item.queued', { spec: 'x', criteria: ['the bar holds'] }, AFTER_CUTOFF),
    makeEvent('cli', 'WI-702', 'item.parked', { reason: 'gate red', parkKind: 'ops' }, AFTER_CUTOFF),
    makeEvent('cli', 'WI-702', 'item.unparked', { by: 'operator' }, AFTER_CUTOFF),
    // The doctor/repair requeue path: spec + touches only, no criteria field at all.
    makeEvent('cli', 'WI-702', 'item.queued', { spec: 'x', touches: 'src/' }, AFTER_CUTOFF),
  ];
  const rec = fold(events).items.get('WI-702');
  assert.deepEqual(rec?.criteria, ['the bar holds'], 'a re-queue must carry the bar forward, not erase it');
  assert.equal(rec?.criteriaExempt, undefined, 'an item WITH criteria is never marked exempt');
});

test('criteria: item.respec REPLACES the bar wholesale so a dropped criterion is really dropped', () => {
  const events = [
    makeEvent('cli', 'WI-703', 'item.captured', { source: 'test', text: 'x' }, AFTER_CUTOFF),
    makeEvent('reactor', 'WI-703', 'item.queued', { spec: 'x', criteria: ['keep this', 'drop this'] }, AFTER_CUTOFF),
    makeEvent('cli', 'WI-703', 'item.respec', { spec: 'x, narrower', reason: 'operator steer', criteria: ['keep this'] }, AFTER_CUTOFF),
  ];
  const rec = fold(events).items.get('WI-703');
  assert.deepEqual(rec?.criteria, ['keep this'],
    'WI-185: a respec that changes criteria must not leave the old ones standing');
});

test('criteria: a respec that only rewords the spec leaves the bar intact', () => {
  const events = [
    makeEvent('cli', 'WI-704', 'item.captured', { source: 'test', text: 'x' }, AFTER_CUTOFF),
    makeEvent('reactor', 'WI-704', 'item.queued', { spec: 'x', criteria: ['the bar'] }, AFTER_CUTOFF),
    makeEvent('cli', 'WI-704', 'item.respec', { spec: 'x but clearer', reason: 'wording' }, AFTER_CUTOFF),
  ];
  const rec = fold(events).items.get('WI-704');
  assert.deepEqual(rec?.criteria, ['the bar'], 'a wording steer must not silently erase the bar');
  assert.equal(rec?.spec, 'x but clearer');
});

test('criteria: the routing parser lifts a CRITERIA block off a build decision', () => {
  const d = parseRoutingDecision([
    'ROUTE: build',
    'SPEC: Add a closed-today banner.',
    'CRITERIA:',
    '- A closed day shows the banner on the day view.',
    '- An open day shows no banner.',
    'TOUCHES: src/calendar/',
    'REPLY: Queuing it.',
  ].join('\n'));
  assert.deepEqual(d.criteria, [
    'A closed day shows the banner on the day view.',
    'An open day shows no banner.',
  ]);
  assert.equal(d.spec, 'Add a closed-today banner.', 'CRITERIA must not bleed into SPEC');
  assert.equal(d.touches, 'src/calendar/', 'nor swallow the field after it');
});

test('criteria: absence renders an explicit note, never a blank (and never the wrong excuse)', () => {
  assert.deepEqual(formatCriteriaLines(['a', 'b'], { indent: '  ' }), ['  - a', '  - b']);
  const exempt = formatCriteriaLines(undefined, { exempt: true })[0];
  const missing = formatCriteriaLines(undefined, { exempt: false })[0];
  assert.match(exempt, /predates the requirement/, 'a grandfathered item says WHY it is blank');
  assert.doesNotMatch(missing, /predates/, 'a genuinely un-criteria\'d item must not borrow that excuse');
  assert.ok(missing.trim().length > 0, 'and it is never silence');
});

// ---------------------------------------------------------------------------
// The reactor gate, end to end
// ---------------------------------------------------------------------------

function testConfig(): LoopkitConfig {
  return { ...CONFIG_DEFAULTS, gateCommand: 'exit 0', promptsDir: '.ai/loops/prompts', notifyHook: '.ai/notify-phone.sh' };
}

function fixedProvider(text: string, seen?: string[]): LlmProvider {
  return {
    name: 'fake-router',
    async run(req: ProviderRequest): Promise<ProviderResult> {
      if (seen && req.prompt.includes('ROUTE THIS ITEM ONLY')) seen.push(req.prompt);
      return { ok: true, text, usage: { in: 0, out: 1, usd: 0 } };
    },
  };
}

async function routeOnce(opts: { block: string; capturedAt: string; seen?: string[] }) {
  const base = mkdtempSync(join(tmpdir(), 'criteria-gate-'));
  const repoRoot = join(base, 'plane');
  const ledgerDir = join(base, 'ledger');
  mkdirSync(join(repoRoot, '.ai', 'loops', 'prompts'), { recursive: true });
  writeFileSync(join(repoRoot, '.ai', 'loops', 'prompts', 'router.md'), 'stub routing prompt', 'utf8');
  await appendEvents(ledgerDir, [
    makeEvent('cli', 'WI-800', 'item.captured', { source: 'cli', text: 'add a banner' }, opts.capturedAt),
  ]);
  await runReactor({
    repoRoot, ledgerDir, autonomy: 'on',
    provider: fixedProvider(opts.block, opts.seen),
    config: testConfig(),
  });
  const events = await loadAllEvents(ledgerDir);
  rmSync(base, { recursive: true, force: true });
  return events;
}

const BLOCK_NO_CRITERIA = [
  'ROUTE: build',
  'SPEC: Add the banner slice.',
  'TOUCHES: src/',
  'REPLY: Queuing it now.',
].join('\n');

const BLOCK_WITH_CRITERIA = [
  'ROUTE: build',
  'SPEC: Add the banner slice.',
  'CRITERIA:',
  '- A closed day shows the banner.',
  'TOUCHES: src/',
  'REPLY: Queuing it now.',
].join('\n');

test('reactor: a post-cutoff build route with NO criteria does not reach the queue', async () => {
  const events = await routeOnce({ block: BLOCK_NO_CRITERIA, capturedAt: AFTER_CUTOFF });
  const queued = events.filter(e => e.type === 'item.queued' && e.item === 'WI-800');
  assert.equal(queued.length, 0, 'an item may NOT reach `queued` without acceptance criteria');
  // ...and the refusal is visible, not silent — the operator trail names it.
  const notes = events.filter(e => e.type === 'msg.out' && e.item === 'WI-800')
    .map(e => (e.data as { text: string }).text);
  assert.ok(notes.some(t => /acceptance criteria/i.test(t)),
    `the rejection must say why (trail: ${JSON.stringify(notes)})`);
});

test('reactor: the same block WITH criteria queues, and the bar lands on the event', async () => {
  const events = await routeOnce({ block: BLOCK_WITH_CRITERIA, capturedAt: AFTER_CUTOFF });
  const queued = events.filter(e => e.type === 'item.queued' && e.item === 'WI-800');
  assert.equal(queued.length, 1);
  assert.deepEqual((queued[0].data as { criteria?: string[] }).criteria, ['A closed day shows the banner.']);
});

test('reactor: a PRE-cutoff item with no criteria still queues (grandfathered, not stranded)', async () => {
  const events = await routeOnce({ block: BLOCK_NO_CRITERIA, capturedAt: BEFORE_CUTOFF });
  const queued = events.filter(e => e.type === 'item.queued' && e.item === 'WI-800');
  assert.equal(queued.length, 1, 'live queued work from before the change must not be stranded');
  const rec = fold(events).items.get('WI-800');
  assert.equal(rec?.criteriaExempt, true, 'and the exemption is recorded, never silently assumed');
});

test('reactor: the criteria contract is INJECTED into every routing prompt, whatever the target ships', async () => {
  const seen: string[] = [];
  await routeOnce({ block: BLOCK_WITH_CRITERIA, capturedAt: AFTER_CUTOFF, seen });
  assert.ok(seen.length > 0, 'sanity: a routing call happened');
  // The fixture's own router.md is the string 'stub routing prompt' — it contains no
  // criteria contract at all, which is exactly the pre-criteria target-prompt situation.
  assert.ok(seen[0].includes('stub routing prompt'), 'sanity: the target prompt is still used');
  assert.ok(
    seen[0].includes(CRITERIA_CONTRACT),
    'a target running an older router.md must still be told the CRITERIA contract, or its queue wedges',
  );
});
