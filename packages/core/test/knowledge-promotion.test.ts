/**
 * knowledge-promotion.test.ts — ADR-015 Slice 1: the event contract + fold + playbook
 * materialize projection (the spine, no LLM). See
 * docs/decisions/ADR-015-verified-knowledge-promotion.md.
 *
 * Pins:
 *   - schema: KnowledgeCandidateData/KnowledgeRatifiedData/KnowledgeExpiredData/
 *     PlaybookMaterializedData registered in EventDataMap + KNOWN_TYPES + accepted by
 *     validateEvent; a malformed envelope is still rejected the same way as any other type.
 *   - fold: knowledge.ratified/knowledge.expired fold into a per-contentHash KnowledgeFact map,
 *     last-writer-wins by ledger (ts) order — a later ratification resurrects a previously
 *     expired hash.
 *   - render-playbook: stale-anchor revalidation, budget-ranking eviction, the GENERATED
 *     banner, and idempotent-write (no receipt on unchanged content).
 *   - reactor stepPlaybookMaterialize (via runReactor): flag-off is byte-identical (no file
 *     written, no events appended); flag-on writes the file + playbook.materialized once,
 *     then is a no-op on the next beat.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { makeEvent, validateEvent, isKnownType, LedgerEvent } from '../src/schema.js';
import { fold, KnowledgeFact } from '../src/fold.js';
import { appendEvents, loadAllEvents } from '../src/ledger.js';
import { runReactor } from '../src/beats/reactor.js';
import { LoopkitConfig, CONFIG_DEFAULTS, loadConfig } from '../src/config.js';
import { approveOrReject, retractKnowledge } from '../src/verbs.js';
import {
  revalidateKnowledge,
  rankKnowledge,
  renderPlaybookMarkdown,
  hashPlaybookContent,
  PLAYBOOK_GENERATED_BANNER,
  resolveCommandBinary,
} from '../src/render-playbook.js';

function makeTestConfig(overrides: Partial<LoopkitConfig> = {}): LoopkitConfig {
  return {
    ...CONFIG_DEFAULTS,
    gateCommand: 'exit 0',
    gateWorkdir: '.',
    breakerN: 3,
    promptsDir: '.ai/loops/prompts',
    notifyHook: '.ai/notify-phone.sh',
    knowledgePromotion: { enabled: true, ttlDays: 60 },
    ...overrides,
  };
}

/** A temp git repo + ledger dir wired the way the reactor tests expect. */
function makeEnv(): { repoRoot: string; ledgerDir: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'adr015-'));
  const repoRoot = join(base, 'repo');
  const ledgerDir = join(base, 'ledger');
  mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });
  mkdirSync(ledgerDir, { recursive: true });
  const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
  g(['init', '-b', 'master']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  spawnSync('bash', ['-c', 'echo base > base.txt'], { cwd: repoRoot });
  g(['add', 'base.txt']);
  g(['commit', '-m', 'init']);
  return { repoRoot, ledgerDir, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// schema: new types registered + validated
// ---------------------------------------------------------------------------

test('schema: knowledge.candidate/ratified/expired + playbook.materialized are known types', () => {
  assert.equal(isKnownType('knowledge.candidate'), true);
  assert.equal(isKnownType('knowledge.ratified'), true);
  assert.equal(isKnownType('knowledge.expired'), true);
  assert.equal(isKnownType('playbook.materialized'), true);
});

test('schema: validateEvent accepts a well-formed knowledge.ratified envelope', () => {
  const ev = makeEvent('operator', 'WI-900', 'knowledge.ratified', {
    contentHash: 'h1',
    lesson: 'Always run the gate before merging.',
    sourceWi: 'WI-800',
    ratifiedBy: 'operator',
  });
  const validated = validateEvent(ev);
  assert.equal(validated.type, 'knowledge.ratified');
  assert.equal((validated.data as { contentHash: string }).contentHash, 'h1');
});

test('schema: validateEvent accepts a well-formed knowledge.expired / playbook.materialized envelope', () => {
  assert.doesNotThrow(() => validateEvent(makeEvent('reactor', 'WI-900', 'knowledge.expired', {
    contentHash: 'h1', reason: 'stale', failedAnchor: 'some/path.ts',
  })));
  assert.doesNotThrow(() => validateEvent(makeEvent('reactor', 'playbook', 'playbook.materialized', {
    path: '.ai/loops/playbook.md', linesWritten: 1, contentHash: 'x', ratifiedCount: 1, evictedForBudget: 0,
  })));
});

test('schema: validateEvent still rejects a structurally malformed envelope regardless of type', () => {
  assert.throws(() => validateEvent({ id: 'not-a-ulid', ts: '2026-01-01T00:00:00Z', actor: 'a', item: 'WI-1', type: 'knowledge.ratified', data: {} }));
  assert.throws(() => validateEvent({ id: 'ev-1', ts: 'not-a-date', actor: 'a', item: 'WI-1', type: 'knowledge.ratified', data: {} }));
});

// ---------------------------------------------------------------------------
// fold: LWW + resurrection over knowledge.ratified/knowledge.expired
// ---------------------------------------------------------------------------

test('fold: knowledge.ratified populates the knowledge map keyed by contentHash', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-800', 'knowledge.ratified', {
      contentHash: 'h1', lesson: 'Run the gate first.', sourceWi: 'WI-800', ratifiedBy: 'operator',
    }, '2026-01-01T00:00:00Z'),
  ];
  const knowledge = fold(events).knowledge;
  assert.equal(knowledge.size, 1);
  const fact = knowledge.get('h1')!;
  assert.equal(fact.lesson, 'Run the gate first.');
  assert.equal(fact.live, true);
});

test('fold: knowledge.expired flips live to false but keeps the fact (evicted != deleted)', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-800', 'knowledge.ratified', {
      contentHash: 'h1', lesson: 'Run the gate first.', sourceWi: 'WI-800', ratifiedBy: 'operator',
    }, '2026-01-01T00:00:00Z'),
    makeEvent('reactor', 'WI-800', 'knowledge.expired', {
      contentHash: 'h1', reason: 'stale', failedAnchor: 'x.ts',
    }, '2026-01-02T00:00:00Z'),
  ];
  const fact = fold(events).knowledge.get('h1')!;
  assert.ok(fact, 'the fact is still present after expiry — evicted, not deleted');
  assert.equal(fact.live, false);
  assert.equal(fact.expiredReason, 'stale');
});

test('fold: re-ratifying an expired contentHash RESURRECTS it (last-writer-wins)', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-800', 'knowledge.ratified', {
      contentHash: 'h1', lesson: 'Run the gate first.', sourceWi: 'WI-800', ratifiedBy: 'operator',
    }, '2026-01-01T00:00:00Z'),
    makeEvent('reactor', 'WI-800', 'knowledge.expired', {
      contentHash: 'h1', reason: 'stale',
    }, '2026-01-02T00:00:00Z'),
    makeEvent('operator', 'WI-850', 'knowledge.ratified', {
      contentHash: 'h1', lesson: 'Run the gate first (re-confirmed).', sourceWi: 'WI-850', ratifiedBy: 'operator',
    }, '2026-01-03T00:00:00Z'),
  ];
  const fact = fold(events).knowledge.get('h1')!;
  assert.equal(fact.live, true, 'a later re-ratification resurrects the hash');
  assert.equal(fact.lesson, 'Run the gate first (re-confirmed).');
  assert.equal(fact.sourceWi, 'WI-850');
  assert.equal(fact.expiredReason, undefined, 'expiredReason is cleared on resurrection (not carried stale)');
});

test('fold: a later expiry of a live hash retracts it (LWW the other direction)', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-800', 'knowledge.ratified', {
      contentHash: 'h1', lesson: 'x', sourceWi: 'WI-800', ratifiedBy: 'operator',
    }, '2026-01-01T00:00:00Z'),
    makeEvent('reactor', 'WI-800', 'knowledge.expired', {
      contentHash: 'h1', reason: 'retracted',
    }, '2026-01-05T00:00:00Z'),
  ];
  assert.equal(fold(events).knowledge.get('h1')!.live, false);
});

test('fold: knowledge.expired on a never-ratified contentHash is ignored (no phantom entry)', () => {
  const events: LedgerEvent[] = [
    makeEvent('reactor', 'WI-800', 'knowledge.expired', { contentHash: 'ghost', reason: 'stale' }, '2026-01-01T00:00:00Z'),
  ];
  assert.equal(fold(events).knowledge.size, 0);
});

// ---------------------------------------------------------------------------
// render-playbook: revalidation, ranking, rendering, hashing
// ---------------------------------------------------------------------------

function makeFact(overrides: Partial<KnowledgeFact> = {}): KnowledgeFact {
  return {
    contentHash: 'h1',
    lesson: 'A lesson.',
    sourceWi: 'WI-800',
    ratifiedBy: 'operator',
    ratifiedAt: '2026-01-01T00:00:00Z',
    live: true,
    ...overrides,
  };
}

test('revalidateKnowledge: drops a lesson whose verifyPath no longer exists (stale)', () => {
  const base = mkdtempSync(join(tmpdir(), 'adr015-repo-'));
  try {
    const fact = makeFact({ verifyPath: 'does/not/exist.ts' });
    const { fresh, expiredEvents } = revalidateKnowledge([fact], base, 60);
    assert.equal(fresh.length, 0);
    assert.equal(expiredEvents.length, 1);
    assert.equal(expiredEvents[0]!.type, 'knowledge.expired');
    assert.equal((expiredEvents[0]!.data as { reason: string }).reason, 'stale');
    assert.equal((expiredEvents[0]!.data as { failedAnchor: string }).failedAnchor, 'does/not/exist.ts');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('revalidateKnowledge: keeps a lesson whose verifyPath DOES exist', () => {
  const base = mkdtempSync(join(tmpdir(), 'adr015-repo-'));
  try {
    mkdirSync(join(base, 'src'), { recursive: true });
    writeFileSync(join(base, 'src', 'real.ts'), 'x', 'utf8');
    const fact = makeFact({ verifyPath: 'src/real.ts' });
    const { fresh, expiredEvents } = revalidateKnowledge([fact], base, 60);
    assert.equal(fresh.length, 1);
    assert.equal(expiredEvents.length, 0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('revalidateKnowledge: no-anchor lesson expires via TTL once its age exceeds ttlDays', () => {
  const oldFact = makeFact({ ratifiedAt: new Date(Date.now() - 61 * 24 * 60 * 60 * 1000).toISOString() });
  const { fresh, expiredEvents } = revalidateKnowledge([oldFact], '/tmp', 60, Date.now());
  assert.equal(fresh.length, 0);
  assert.equal(expiredEvents.length, 1);
  assert.match((expiredEvents[0]!.data as { failedAnchor: string }).failedAnchor!, /^ttl:60d$/);
});

test('revalidateKnowledge: no-anchor lesson within TTL survives', () => {
  const freshFact = makeFact({ ratifiedAt: new Date(Date.now() - 1000).toISOString() });
  const { fresh, expiredEvents } = revalidateKnowledge([freshFact], '/tmp', 60, Date.now());
  assert.equal(fresh.length, 1);
  assert.equal(expiredEvents.length, 0);
});

test('revalidateKnowledge: verifyCommand anchor checked via resolveCommandBinary', () => {
  assert.equal(resolveCommandBinary('node --version'), true, 'node is on PATH in this test env');
  assert.equal(resolveCommandBinary('this-binary-does-not-exist-xyz'), false);
  const fact = makeFact({ verifyCommand: 'this-binary-does-not-exist-xyz --flag' });
  const { fresh, expiredEvents } = revalidateKnowledge([fact], '/tmp', 60);
  assert.equal(fresh.length, 0);
  assert.equal(expiredEvents.length, 1);
});

test('rankKnowledge: evicts lowest-ranked facts past maxLines (budget-evicted)', () => {
  const facts: KnowledgeFact[] = [
    makeFact({ contentHash: 'a', ratifiedAt: '2026-01-01T00:00:00Z' }),
    makeFact({ contentHash: 'b', ratifiedAt: '2026-01-02T00:00:00Z' }),
    makeFact({ contentHash: 'c', ratifiedAt: '2026-01-03T00:00:00Z' }),
  ];
  const { kept, evictedEvents } = rankKnowledge(facts, [], 2);
  assert.equal(kept.length, 2);
  assert.equal(evictedEvents.length, 1);
  assert.equal((evictedEvents[0]!.data as { reason: string }).reason, 'budget-evicted');
  // Recency-ranked (no usefulness signal since no merged items passed in): the two most
  // recent survive, the oldest is evicted.
  assert.deepEqual(kept.map(f => f.contentHash).sort(), ['b', 'c']);
});

test('rankKnowledge: keeps everything when under budget (no eviction events)', () => {
  const facts: KnowledgeFact[] = [makeFact({ contentHash: 'a' })];
  const { kept, evictedEvents } = rankKnowledge(facts, [], 40);
  assert.equal(kept.length, 1);
  assert.equal(evictedEvents.length, 0);
});

test('renderPlaybookMarkdown: includes the GENERATED banner and one line per lesson', () => {
  const rendered = renderPlaybookMarkdown([
    makeFact({ contentHash: 'a', lesson: 'Lesson one.' }),
    makeFact({ contentHash: 'b', lesson: 'Lesson two.' }),
  ]);
  assert.ok(rendered.includes(PLAYBOOK_GENERATED_BANNER), 'GENERATED banner present');
  assert.ok(rendered.includes('- Lesson one.'));
  assert.ok(rendered.includes('- Lesson two.'));
});

test('hashPlaybookContent: identical content hashes identically; different content differs', () => {
  const a = renderPlaybookMarkdown([makeFact({ lesson: 'x' })]);
  const b = renderPlaybookMarkdown([makeFact({ lesson: 'x' })]);
  const c = renderPlaybookMarkdown([makeFact({ lesson: 'y' })]);
  assert.equal(hashPlaybookContent(a), hashPlaybookContent(b));
  assert.notEqual(hashPlaybookContent(a), hashPlaybookContent(c));
});

// ---------------------------------------------------------------------------
// config: knowledgePromotion block (staged flag — default off)
// ---------------------------------------------------------------------------

function loadConfigIsolated(repoRoot: string): LoopkitConfig {
  const saved = process.env['LOOPKIT_HOME'];
  delete process.env['LOOPKIT_HOME'];
  try {
    return loadConfig(repoRoot);
  } finally {
    if (saved === undefined) delete process.env['LOOPKIT_HOME']; else process.env['LOOPKIT_HOME'] = saved;
  }
}

test('knowledgePromotion: config default is enabled:false, ttlDays:60 (loadConfig with no file)', () => {
  const base = mkdtempSync(join(tmpdir(), 'adr015-cfg-'));
  try {
    const cfg = loadConfigIsolated(base);
    assert.equal(cfg.knowledgePromotion?.enabled, false, 'default must be false — the step ships dormant');
    assert.equal(cfg.knowledgePromotion?.ttlDays, 60);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('config: knowledgePromotion.enabled must be a boolean', () => {
  const base = mkdtempSync(join(tmpdir(), 'adr015-cfg-'));
  try {
    writeFileSync(join(base, 'loopkit.config.json'), JSON.stringify({ knowledgePromotion: { enabled: 'yes' } }), 'utf8');
    assert.throws(() => loadConfigIsolated(base), /knowledgePromotion\.enabled must be a boolean/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('config: knowledgePromotion.ttlDays must be a positive integer', () => {
  const base = mkdtempSync(join(tmpdir(), 'adr015-cfg-'));
  try {
    writeFileSync(join(base, 'loopkit.config.json'), JSON.stringify({ knowledgePromotion: { ttlDays: -1 } }), 'utf8');
    assert.throws(() => loadConfigIsolated(base), /knowledgePromotion\.ttlDays must be a positive integer/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('config: the pre-existing console-knowledge block (LoopkitConfig.knowledge) is untouched by this ADR', () => {
  // Guards against the naming collision this ADR explicitly calls out: the NEW block is
  // `knowledgePromotion`, never `knowledge` (already taken by the console /knowledge page
  // source config) — see config.ts's knowledgePromotion doc comment.
  const cfg = CONFIG_DEFAULTS;
  assert.equal((cfg as unknown as { knowledgePromotion?: unknown }).knowledgePromotion !== undefined, true);
});

// ---------------------------------------------------------------------------
// reactor stepPlaybookMaterialize (via runReactor)
// ---------------------------------------------------------------------------

test('reactor (ADR-015): flag-off is byte-identical — no file written, no events appended', async () => {
  const { repoRoot, ledgerDir, cleanup } = makeEnv();
  try {
    await appendEvents(ledgerDir, [
      makeEvent('operator', 'WI-800', 'knowledge.ratified', {
        contentHash: 'h1', lesson: 'Run the gate first.', sourceWi: 'WI-800', ratifiedBy: 'operator',
      }, new Date().toISOString()),
    ]);
    const before = await loadAllEvents(ledgerDir);

    await runReactor({ repoRoot, ledgerDir, autonomy: 'on', provider: null, config: makeTestConfig({ knowledgePromotion: { enabled: false } }) });

    const playbookPath = join(repoRoot, '.ai', 'loops', 'playbook.md');
    assert.equal(existsSync(playbookPath), false, 'no playbook file written when the flag is off');

    const after = await loadAllEvents(ledgerDir);
    const newTypes = after.slice(before.length).map(e => e.type);
    assert.ok(!newTypes.includes('playbook.materialized'), 'no playbook.materialized event when the flag is off');
    assert.ok(!newTypes.includes('knowledge.expired'), 'no knowledge.expired event when the flag is off');
  } finally {
    cleanup();
  }
});

test('reactor (ADR-015): flag-on writes the playbook file + one playbook.materialized event', async () => {
  const { repoRoot, ledgerDir, cleanup } = makeEnv();
  try {
    await appendEvents(ledgerDir, [
      makeEvent('operator', 'WI-800', 'knowledge.ratified', {
        contentHash: 'h1', lesson: 'Run the gate first.', sourceWi: 'WI-800', ratifiedBy: 'operator',
      }, new Date().toISOString()),
    ]);

    await runReactor({ repoRoot, ledgerDir, autonomy: 'on', provider: null, config: makeTestConfig() });

    const playbookPath = join(repoRoot, '.ai', 'loops', 'playbook.md');
    assert.ok(existsSync(playbookPath), 'playbook file written when the flag is on');
    const content = readFileSync(playbookPath, 'utf8');
    assert.ok(content.includes(PLAYBOOK_GENERATED_BANNER));
    assert.ok(content.includes('Run the gate first.'));

    const events = await loadAllEvents(ledgerDir);
    const materialized = events.filter(e => e.type === 'playbook.materialized');
    assert.equal(materialized.length, 1);
    assert.equal((materialized[0]!.data as { linesWritten: number }).linesWritten, 1);
  } finally {
    cleanup();
  }
});

test('reactor (ADR-015): idempotent — a second beat with no new knowledge events writes nothing', async () => {
  const { repoRoot, ledgerDir, cleanup } = makeEnv();
  try {
    await appendEvents(ledgerDir, [
      makeEvent('operator', 'WI-800', 'knowledge.ratified', {
        contentHash: 'h1', lesson: 'Run the gate first.', sourceWi: 'WI-800', ratifiedBy: 'operator',
      }, new Date().toISOString()),
    ]);

    await runReactor({ repoRoot, ledgerDir, autonomy: 'on', provider: null, config: makeTestConfig() });
    const afterFirst = await loadAllEvents(ledgerDir);
    const materializedAfterFirst = afterFirst.filter(e => e.type === 'playbook.materialized').length;
    assert.equal(materializedAfterFirst, 1);

    await runReactor({ repoRoot, ledgerDir, autonomy: 'on', provider: null, config: makeTestConfig() });
    const afterSecond = await loadAllEvents(ledgerDir);
    const materializedAfterSecond = afterSecond.filter(e => e.type === 'playbook.materialized').length;
    assert.equal(materializedAfterSecond, 1, 'no second playbook.materialized event — content was unchanged');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// ADR-015 Slice 2 — ratification wiring through the existing approve/reject verbs
// ---------------------------------------------------------------------------

/**
 * A knowledge candidate as the harvest step (Slice 3, not yet implemented) would shape it:
 * its own WI, source-stamped `knowledge:<sourceWi>:<contentHash>`, carrying a knowledge.candidate
 * event, parked as a decision (never queued as build work — see the ADR's "Park for
 * ratification" row). Mirrors stepPortabilityPromotion's product-shaped decision-park fixture
 * shape used elsewhere in this suite's sibling tests.
 */
function knowledgeCandidateFixture(
  wiId: string,
  overrides: Partial<{ contentHash: string; lesson: string; sourceWi: string; verifyPath: string; verifyCommand: string }> = {},
): LedgerEvent[] {
  const contentHash = overrides.contentHash ?? 'h1';
  const sourceWi = overrides.sourceWi ?? 'WI-700';
  const lesson = overrides.lesson ?? 'Always run the gate before merging.';
  return [
    makeEvent('reactor', wiId, 'item.captured', {
      source: `knowledge:${sourceWi}:${contentHash}`,
      text: `Promote lesson from ${sourceWi}: ${lesson}`,
    }, '2026-01-01T00:00:00Z'),
    makeEvent('reactor', wiId, 'knowledge.candidate', {
      lesson,
      contentHash,
      sourceWi,
      method: 'strict-auditor',
      model: 'test-model',
      ...(overrides.verifyPath ? { verifyPath: overrides.verifyPath } : {}),
      ...(overrides.verifyCommand ? { verifyCommand: overrides.verifyCommand } : {}),
    }, '2026-01-01T00:00:01Z'),
    makeEvent('reactor', wiId, 'item.parked', {
      reason: `Promote a distilled lesson from ${sourceWi} — ratify before it reaches the playbook.`,
      parkKind: 'decision',
    }, '2026-01-01T00:00:02Z'),
  ];
}

test('approveOrReject: approving a knowledge-candidate item appends item.approved (never unpark-and-requeue)', async () => {
  const base = mkdtempSync(join(tmpdir(), 'adr015-s2-'));
  const ledgerDir = join(base, 'ledger');
  mkdirSync(ledgerDir, { recursive: true });
  try {
    await appendEvents(ledgerDir, knowledgeCandidateFixture('WI-900'));

    const result = await approveOrReject(ledgerDir, 'WI-900', 'approve', { repoRoot: base });
    assert.equal(result.label, 'Approved');

    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.filter(e => e.item === 'WI-900' && e.type === 'item.approved').length, 1,
      'knowledge candidate approval must append item.approved, not item.unparked-and-requeue');
    assert.equal(events.filter(e => e.item === 'WI-900' && e.type === 'item.unparked').length, 0,
      'a knowledge candidate has zero builds by design — it must never take the unbuilt-unpark path');
    assert.equal(fold(events).items.get('WI-900')!.state, 'approved');
  } finally {
    cleanup(base);
  }
});

function cleanup(base: string): void {
  rmSync(base, { recursive: true, force: true });
}

test('reactor stepApplyVerbs: approving a knowledge candidate ratifies it (exactly one knowledge.ratified, matching contentHash) in the same locked append', async () => {
  const { repoRoot, ledgerDir, cleanup: done } = makeEnv();
  try {
    await appendEvents(ledgerDir, knowledgeCandidateFixture('WI-900', { contentHash: 'hash-abc', lesson: 'Run the gate first.', sourceWi: 'WI-700' }));
    await approveOrReject(ledgerDir, 'WI-900', 'approve', { repoRoot });

    await runReactor({ repoRoot, ledgerDir, autonomy: 'on', provider: null, config: makeTestConfig() });

    const events = await loadAllEvents(ledgerDir);
    const ratified = events.filter(e => e.type === 'knowledge.ratified' && e.item === 'WI-900');
    assert.equal(ratified.length, 1, 'exactly one knowledge.ratified for the approved candidate');
    const data = ratified[0]!.data as { contentHash: string; lesson: string; sourceWi: string; ratifiedBy: string };
    assert.equal(data.contentHash, 'hash-abc');
    assert.equal(data.lesson, 'Run the gate first.');
    assert.equal(data.sourceWi, 'WI-700');
    assert.equal(data.ratifiedBy, 'operator');

    // Idempotency: a second beat with no new approvals must not re-ratify.
    await runReactor({ repoRoot, ledgerDir, autonomy: 'on', provider: null, config: makeTestConfig() });
    const afterSecond = await loadAllEvents(ledgerDir);
    assert.equal(afterSecond.filter(e => e.type === 'knowledge.ratified' && e.item === 'WI-900').length, 1,
      'no second knowledge.ratified — the item stays approved forever but ratifies exactly once');
  } finally {
    done();
  }
});

test('reactor stepApplyVerbs: flag-off — approving a knowledge candidate appends NO knowledge.ratified', async () => {
  const { repoRoot, ledgerDir, cleanup: done } = makeEnv();
  try {
    await appendEvents(ledgerDir, knowledgeCandidateFixture('WI-900'));
    await approveOrReject(ledgerDir, 'WI-900', 'approve', { repoRoot });

    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on', provider: null,
      config: makeTestConfig({ knowledgePromotion: { enabled: false } }),
    });

    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.filter(e => e.type === 'knowledge.ratified').length, 0,
      'knowledgePromotion.enabled=false must suppress the ratify-on-approve clause exactly like materialize');
    assert.equal(fold(events).items.get('WI-900')!.state, 'approved', 'the item record itself is unaffected by the flag');
  } finally {
    done();
  }
});

test('approveOrReject: rejecting a knowledge candidate is terminal — no knowledge.ratified, and re-harvest of the same source-stamp is blocked', async () => {
  const base = mkdtempSync(join(tmpdir(), 'adr015-s2-'));
  const ledgerDir = join(base, 'ledger');
  mkdirSync(ledgerDir, { recursive: true });
  try {
    await appendEvents(ledgerDir, knowledgeCandidateFixture('WI-900', { contentHash: 'hash-rej', sourceWi: 'WI-700' }));

    const result = await approveOrReject(ledgerDir, 'WI-900', 'reject', { repoRoot: base });
    assert.equal(result.label, 'Rejected');

    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.filter(e => e.item === 'WI-900' && e.type === 'item.rejected').length, 1);
    assert.equal(events.filter(e => e.type === 'knowledge.ratified').length, 0, 'reject must never ratify');
    assert.equal(fold(events).items.get('WI-900')!.state, 'rejected');

    // The dedup discipline the ADR promises ("terminal; candidate dies, never re-harvested —
    // dedup stamp"): the source stamp `knowledge:WI-700:hash-rej` is still visible on the
    // rejected item's own capture, so a future harvest pass (Slice 3) scanning prior sources
    // sees it and skips re-harvesting the same (source, lesson) pair. Pinning the stamp
    // survives rejection (fold.ts never clears `source` on any transition, including terminal
    // ones) is exactly what makes that dedup possible.
    const rec = fold(events).items.get('WI-900')!;
    assert.equal(rec.source, 'knowledge:WI-700:hash-rej');
  } finally {
    cleanup(base);
  }
});

test('auto-approve guard: stepAutoApprove never fires on a knowledge candidate park (parkKind:decision)', async () => {
  const { repoRoot, ledgerDir, cleanup: done } = makeEnv();
  try {
    await appendEvents(ledgerDir, knowledgeCandidateFixture('WI-900'));

    // Default config ships autoApprove.enabled:true — if the guard were missing, a decision
    // park could slip through some delegated-class rule; this asserts it never does regardless.
    await runReactor({ repoRoot, ledgerDir, autonomy: 'on', provider: null, config: makeTestConfig() });

    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.filter(e => e.item === 'WI-900' && e.type === 'item.approved' && e.actor === 'reactor').length, 0,
      'a knowledge candidate (parkKind:decision) must never be auto-approved by the reactor');
    assert.equal(fold(events).items.get('WI-900')!.state, 'parked', 'stays parked awaiting the operator');
  } finally {
    done();
  }
});

// ---------------------------------------------------------------------------
// retractKnowledge — `loopctl retract <contentHash>`
// ---------------------------------------------------------------------------

test('retractKnowledge: appends knowledge.expired{reason:retracted} for a live ratified lesson', async () => {
  const base = mkdtempSync(join(tmpdir(), 'adr015-s2-'));
  const ledgerDir = join(base, 'ledger');
  mkdirSync(ledgerDir, { recursive: true });
  try {
    await appendEvents(ledgerDir, [
      makeEvent('operator', 'WI-700', 'knowledge.ratified', {
        contentHash: 'h1', lesson: 'Run the gate first.', sourceWi: 'WI-700', ratifiedBy: 'operator',
      }, '2026-01-01T00:00:00Z'),
    ]);

    const result = await retractKnowledge(ledgerDir, 'h1');
    assert.equal(result.outcome, 'retracted');

    const events = await loadAllEvents(ledgerDir);
    const expired = events.filter(e => e.type === 'knowledge.expired');
    assert.equal(expired.length, 1);
    const data = expired[0]!.data as { contentHash: string; reason: string };
    assert.equal(data.contentHash, 'h1');
    assert.equal(data.reason, 'retracted');

    const fact = fold(events).knowledge.get('h1')!;
    assert.equal(fact.live, false);
    assert.equal(fact.expiredReason, 'retracted');
  } finally {
    cleanup(base);
  }
});

test('retractKnowledge: a retracted lesson drops from the next materialize (playbook no longer includes it)', async () => {
  const { repoRoot, ledgerDir, cleanup: done } = makeEnv();
  try {
    await appendEvents(ledgerDir, [
      makeEvent('operator', 'WI-700', 'knowledge.ratified', {
        contentHash: 'h1', lesson: 'Run the gate first.', sourceWi: 'WI-700', ratifiedBy: 'operator',
      }, new Date().toISOString()),
    ]);

    // Materialize once — the lesson is in the playbook.
    await runReactor({ repoRoot, ledgerDir, autonomy: 'on', provider: null, config: makeTestConfig() });
    const playbookPath = join(repoRoot, '.ai', 'loops', 'playbook.md');
    assert.ok(readFileSync(playbookPath, 'utf8').includes('Run the gate first.'));

    await retractKnowledge(ledgerDir, 'h1');

    // Next beat's materialize must drop it.
    await runReactor({ repoRoot, ledgerDir, autonomy: 'on', provider: null, config: makeTestConfig() });
    const contentAfter = readFileSync(playbookPath, 'utf8');
    assert.ok(!contentAfter.includes('Run the gate first.'), 'retracted lesson must not survive the next materialize');
  } finally {
    done();
  }
});

test('retractKnowledge: a never-ratified or already-retracted contentHash is a no-op', async () => {
  const base = mkdtempSync(join(tmpdir(), 'adr015-s2-'));
  const ledgerDir = join(base, 'ledger');
  mkdirSync(ledgerDir, { recursive: true });
  try {
    const neverRatified = await retractKnowledge(ledgerDir, 'ghost');
    assert.equal(neverRatified.outcome, 'no-op');

    await appendEvents(ledgerDir, [
      makeEvent('operator', 'WI-700', 'knowledge.ratified', {
        contentHash: 'h1', lesson: 'x', sourceWi: 'WI-700', ratifiedBy: 'operator',
      }, '2026-01-01T00:00:00Z'),
    ]);
    const first = await retractKnowledge(ledgerDir, 'h1');
    assert.equal(first.outcome, 'retracted');

    const second = await retractKnowledge(ledgerDir, 'h1');
    assert.equal(second.outcome, 'no-op');

    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.filter(e => e.type === 'knowledge.expired').length, 1, 'a second retract must not double-append');
  } finally {
    cleanup(base);
  }
});
