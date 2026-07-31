/**
 * knowledge-harvest.test.ts — ADR-015 Slice 3: the strict-auditor harvest step
 * (stepKnowledgeHarvest, see docs/decisions/ADR-015-verified-knowledge-promotion.md).
 *
 * Covers:
 *   parseKnowledgeAuditOutput — pure parse-wall unit tests (empty array, real-shaped, garbage)
 *   reactor stepKnowledgeHarvest (via runReactor):
 *     - a trivial merge with a stubbed empty-array response yields zero candidates (default-reject)
 *     - a real-shaped response creates a candidate item: correct source stamp, knowledge.candidate
 *       event, and a parkKind:'decision' park carrying provenance
 *     - re-harvesting the SAME merge produces no duplicates (source-stamp dedup)
 *     - a contentHash collision with a prior ratified lesson is dropped
 *     - provider-unavailable → visible skip, no candidates fabricated
 *     - flag-off (knowledgePromotion.enabled=false) → the step no-ops before reading anything
 *     - per-beat cap is respected (KNOWLEDGE_HARVEST_PER_BEAT_CAP)
 *     - END-TO-END: harvested candidate → approve via verbs → knowledge.ratified → materialize
 *       renders the lesson into the playbook (proves the Slice 2/3 shapes actually mate)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { makeEvent, LedgerEvent } from '../src/schema.js';
import { appendEvents, loadAllEvents } from '../src/ledger.js';
import { runReactor } from '../src/beats/reactor.js';
import { CONFIG_DEFAULTS, LoopkitConfig } from '../src/config.js';
import { LlmProvider, ProviderResult } from '../src/providers/types.js';
import { fold } from '../src/fold.js';
import { approveOrReject } from '../src/verbs.js';
import { parseKnowledgeAuditOutput } from '../src/knowledge-harvest.js';
import { PLAYBOOK_GENERATED_BANNER } from '../src/render-playbook.js';

function cfg(overrides: Partial<LoopkitConfig> = {}): LoopkitConfig {
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
  const base = mkdtempSync(join(tmpdir(), 'adr015-harvest-'));
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

/** A provider that answers any run() with a fixed text response. */
function makeHarvestProvider(text: string): LlmProvider {
  return {
    name: 'fakeauditor',
    async run(): Promise<ProviderResult> {
      return { ok: true, text, usage: { in: 30, out: 10, usd: 0.0002 } };
    },
  };
}

/** A provider that always errors (simulates provider-unavailable). */
function makeFailingProvider(): LlmProvider {
  return {
    name: 'fakebroken',
    async run(): Promise<ProviderResult> {
      return { ok: false, error: 'simulated provider outage' };
    },
  };
}

/** A merged plane item eligible for harvest: state=merged + mergeGateCommand present. */
function mergedItem(id: string, mergedAtIso: string, spec = 'add a feature'): LedgerEvent[] {
  return [
    makeEvent('operator', id, 'item.captured', { source: 'cli', text: `build ${id}` }),
    makeEvent('reactor', id, 'item.queued', { spec, touches: 'src/' }),
    makeEvent('reactor', id, 'item.merged', {
      commit: 'deadbeef', sessionId: 'ses-attended',
      baseSha: 'aaa', headSha: 'bbb', changedFiles: ['src/feature.ts'], gateCommand: 'npm test',
    }, mergedAtIso),
  ];
}

// ---------------------------------------------------------------------------
// parseKnowledgeAuditOutput — pure parse-wall unit tests
// ---------------------------------------------------------------------------

test('parseKnowledgeAuditOutput: an empty array is the expected default-reject output', () => {
  const r = parseKnowledgeAuditOutput('[]');
  assert.equal(r.candidates.length, 0);
  assert.equal(r.unparseable, undefined);
});

test('parseKnowledgeAuditOutput: a real-shaped single-candidate response validates', () => {
  const r = parseKnowledgeAuditOutput('[{"lesson": "Run the gate before merging.", "verifyPath": "src/feature.ts"}]');
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0]!.lesson, 'Run the gate before merging.');
  assert.equal(r.candidates[0]!.verifyPath, 'src/feature.ts');
});

test('parseKnowledgeAuditOutput: tolerates stray prose/fences around the JSON array', () => {
  const r = parseKnowledgeAuditOutput('Here is my answer:\n```json\n[{"lesson": "x"}]\n```\nDone.');
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0]!.lesson, 'x');
});

test('parseKnowledgeAuditOutput: garbage (no array at all) is unparseable, zero candidates', () => {
  const r = parseKnowledgeAuditOutput('I refuse to answer in JSON.');
  assert.equal(r.candidates.length, 0);
  assert.equal(r.unparseable, true);
});

test('parseKnowledgeAuditOutput: a malformed element (no lesson) is dropped, not fabricated', () => {
  const r = parseKnowledgeAuditOutput('[{"verifyPath": "x.ts"}, {"lesson": "keep me"}]');
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0]!.lesson, 'keep me');
});

test('parseKnowledgeAuditOutput: caps at 3 lessons even when the model emits more', () => {
  const many = JSON.stringify([1, 2, 3, 4, 5].map(n => ({ lesson: `lesson ${n}` })));
  const r = parseKnowledgeAuditOutput(many);
  assert.equal(r.candidates.length, 3);
});

// ---------------------------------------------------------------------------
// reactor stepKnowledgeHarvest — integration
// ---------------------------------------------------------------------------

test('reactor: a trivial merge with a stubbed empty-array response yields zero candidates (default-reject)', async () => {
  const { repoRoot, ledgerDir, cleanup } = makeEnv();
  try {
    await appendEvents(ledgerDir, mergedItem('WI-600', new Date().toISOString()));
    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on', provider: makeHarvestProvider('[]'), config: cfg(),
    });
    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.filter(e => e.type === 'knowledge.candidate').length, 0);
    assert.equal(events.filter(e => e.type === 'item.parked').length, 0);
  } finally { cleanup(); }
});

test('reactor: a real-shaped response creates a candidate item — source stamp, knowledge.candidate event, decision park with provenance', async () => {
  const { repoRoot, ledgerDir, cleanup } = makeEnv();
  try {
    await appendEvents(ledgerDir, mergedItem('WI-601', new Date().toISOString()));
    const response = '[{"lesson": "Always run the gate before merging a schema change.", "verifyPath": "src/feature.ts"}]';
    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on', provider: makeHarvestProvider(response), config: cfg(),
    });

    const events = await loadAllEvents(ledgerDir);
    const candidateEvents = events.filter(e => e.type === 'knowledge.candidate');
    assert.equal(candidateEvents.length, 1, 'exactly one candidate captured');
    const candItem = candidateEvents[0]!.item;

    const capturedEv = events.find(e => e.item === candItem && e.type === 'item.captured');
    assert.ok(capturedEv, 'the candidate has its own item.captured');
    const source = (capturedEv!.data as { source: string }).source;
    assert.match(source, /^knowledge:WI-601:[0-9a-f]+$/, 'source stamp is knowledge:<sourceWi>:<contentHash>');

    const candData = candidateEvents[0]!.data as {
      lesson: string; contentHash: string; sourceWi: string; method: string; model: string; gateCommand?: string;
    };
    assert.equal(candData.lesson, 'Always run the gate before merging a schema change.');
    assert.equal(candData.sourceWi, 'WI-601');
    assert.equal(candData.method, 'strict-auditor');
    assert.equal(candData.gateCommand, 'npm test');
    assert.ok(candData.contentHash, 'contentHash present');

    const parkEv = events.find(e => e.item === candItem && e.type === 'item.parked');
    assert.ok(parkEv, 'the candidate is parked');
    assert.equal((parkEv!.data as { parkKind: string }).parkKind, 'decision');
    const reason = (parkEv!.data as { reason: string }).reason;
    assert.match(reason, /WI-601/, 'park reason carries sourceWi provenance');

    const rec = fold(events).items.get(candItem)!;
    assert.equal(rec.state, 'parked');
    assert.equal(rec.parkKind, 'decision');
  } finally { cleanup(); }
});

test('reactor: re-harvesting the same merge produces no duplicate candidate (source-stamp dedup)', async () => {
  const { repoRoot, ledgerDir, cleanup } = makeEnv();
  try {
    await appendEvents(ledgerDir, mergedItem('WI-602', new Date().toISOString()));
    const response = '[{"lesson": "A durable lesson."}]';
    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on', provider: makeHarvestProvider(response), config: cfg(),
    });
    const afterFirst = await loadAllEvents(ledgerDir);
    assert.equal(afterFirst.filter(e => e.type === 'knowledge.candidate').length, 1);

    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on', provider: makeHarvestProvider(response), config: cfg(),
    });
    const afterSecond = await loadAllEvents(ledgerDir);
    assert.equal(afterSecond.filter(e => e.type === 'knowledge.candidate').length, 1,
      'the merge is not re-harvested — the source stamp already exists');
  } finally { cleanup(); }
});

test('reactor: a contentHash collision with a prior ratified lesson is dropped', async () => {
  const { repoRoot, ledgerDir, cleanup } = makeEnv();
  try {
    const lesson = 'always run the gate before merging.'; // normalized (lowercase) matches the harvest's own normalization
    // Seed a prior ratification for the SAME normalized lesson text from a different source.
    await appendEvents(ledgerDir, [
      makeEvent('operator', 'WI-500', 'knowledge.ratified', {
        contentHash: (await import('../src/render-playbook.js')).hashPlaybookContent(lesson),
        lesson: 'Always run the gate before merging.',
        sourceWi: 'WI-500',
        ratifiedBy: 'operator',
      }, '2026-01-01T00:00:00Z'),
    ]);
    await appendEvents(ledgerDir, mergedItem('WI-603', new Date().toISOString()));
    const response = '[{"lesson": "Always run the gate before merging."}]';
    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on', provider: makeHarvestProvider(response), config: cfg(),
    });
    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.filter(e => e.type === 'knowledge.candidate').length, 0,
      'a duplicate-content candidate must be dropped, never re-captured');
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// WI-270 defect 3: dedup set = live-ratified + pending/rejected candidates — a
// stale-EXPIRED-then-nothing-else lesson must be re-harvestable (ADR: "a stale lesson is
// re-surfaceable"), while a still-PENDING or REJECTED candidate stays blocked.
// ---------------------------------------------------------------------------

test('reactor: WI-270 defect 3 — a candidate still PENDING (parked, undecided) blocks re-harvest of the same content', async () => {
  const { repoRoot, ledgerDir, cleanup } = makeEnv();
  try {
    const lesson = 'always run the gate before merging.';
    const contentHash = (await import('../src/render-playbook.js')).hashPlaybookContent(lesson);
    // Seed an existing PARKED (undecided) candidate for the same content, from a different source.
    await appendEvents(ledgerDir, [
      makeEvent('reactor', 'WI-550', 'item.captured', { source: `knowledge:WI-549:${contentHash}`, text: 'x' }, '2026-01-01T00:00:00Z'),
      makeEvent('reactor', 'WI-550', 'knowledge.candidate', {
        lesson: 'Always run the gate before merging.', contentHash, sourceWi: 'WI-549', method: 'strict-auditor', model: 'm',
      }, '2026-01-01T00:00:01Z'),
      makeEvent('reactor', 'WI-550', 'item.parked', { reason: 'ratify', parkKind: 'decision' }, '2026-01-01T00:00:02Z'),
    ]);
    await appendEvents(ledgerDir, mergedItem('WI-651', new Date().toISOString()));
    const response = '[{"lesson": "Always run the gate before merging."}]';
    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on', provider: makeHarvestProvider(response), config: cfg(),
    });
    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.filter(e => e.type === 'knowledge.candidate').length, 1,
      'the still-pending candidate blocks a same-content re-harvest — only the original exists');
  } finally { cleanup(); }
});

test('reactor: WI-270 defect 3 — a REJECTED candidate is terminal and blocks re-harvest of the same content', async () => {
  const { repoRoot, ledgerDir, cleanup } = makeEnv();
  try {
    const lesson = 'always run the gate before merging.';
    const contentHash = (await import('../src/render-playbook.js')).hashPlaybookContent(lesson);
    await appendEvents(ledgerDir, [
      makeEvent('reactor', 'WI-560', 'item.captured', { source: `knowledge:WI-559:${contentHash}`, text: 'x' }, '2026-01-01T00:00:00Z'),
      makeEvent('reactor', 'WI-560', 'knowledge.candidate', {
        lesson: 'Always run the gate before merging.', contentHash, sourceWi: 'WI-559', method: 'strict-auditor', model: 'm',
      }, '2026-01-01T00:00:01Z'),
      makeEvent('reactor', 'WI-560', 'item.parked', { reason: 'ratify', parkKind: 'decision' }, '2026-01-01T00:00:02Z'),
    ]);
    await approveOrReject(ledgerDir, 'WI-560', 'reject', { repoRoot });

    await appendEvents(ledgerDir, mergedItem('WI-652', new Date().toISOString()));
    const response = '[{"lesson": "Always run the gate before merging."}]';
    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on', provider: makeHarvestProvider(response), config: cfg(),
    });
    const events = await loadAllEvents(ledgerDir);
    // The ORIGINAL (rejected) candidate's own knowledge.candidate event is still in the ledger
    // (append-only — rejection never retracts it); what must NOT happen is a SECOND one from
    // this new merge re-harvesting the same content.
    const candidateEvents = events.filter(e => e.type === 'knowledge.candidate');
    assert.equal(candidateEvents.length, 1,
      'a rejected candidate is terminal — the same content must never be re-harvested (ADR: rejection stays terminal)');
    assert.equal(candidateEvents[0]!.item, 'WI-560', 'the only candidate event is still the original, rejected one');
  } finally { cleanup(); }
});

test('reactor: WI-270 defect 3 — a lesson whose ONLY history is ratified-then-STALE-EXPIRED IS re-harvestable', async () => {
  const { repoRoot, ledgerDir, cleanup } = makeEnv();
  try {
    const lesson = 'always run the gate before merging.';
    const contentHash = (await import('../src/render-playbook.js')).hashPlaybookContent(lesson);
    // A prior ratification for the same content, now expired (stale) — no live fact, no pending
    // or rejected candidate anywhere. The ADR promises this is re-surfaceable.
    await appendEvents(ledgerDir, [
      makeEvent('operator', 'WI-570', 'knowledge.ratified', {
        contentHash, lesson: 'Always run the gate before merging.', sourceWi: 'WI-569', ratifiedBy: 'operator',
      }, '2026-01-01T00:00:00Z'),
      makeEvent('reactor', 'WI-570', 'knowledge.expired', { contentHash, reason: 'stale', failedAnchor: 'gone.ts' }, '2026-01-02T00:00:00Z'),
    ]);
    await appendEvents(ledgerDir, mergedItem('WI-653', new Date().toISOString()));
    const response = '[{"lesson": "Always run the gate before merging."}]';
    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on', provider: makeHarvestProvider(response), config: cfg(),
    });
    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.filter(e => e.type === 'knowledge.candidate').length, 1,
      'a stale-expired (never live, never pending/rejected elsewhere) lesson must be re-harvestable, not blocked forever');
  } finally { cleanup(); }
});

test('reactor: provider-unavailable yields a visible skip, never a fabricated candidate', async () => {
  const { repoRoot, ledgerDir, cleanup } = makeEnv();
  try {
    await appendEvents(ledgerDir, mergedItem('WI-604', new Date().toISOString()));
    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on', provider: makeFailingProvider(), config: cfg(),
    });
    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.filter(e => e.type === 'knowledge.candidate').length, 0);
    const skipMsg = events.find(e => e.item === 'WI-604' && e.type === 'msg.out'
      && String((e.data as { text?: string }).text ?? '').includes('provider unavailable'));
    assert.ok(skipMsg, 'a visible skip note is recorded');
  } finally { cleanup(); }
});

test('reactor: flag-off (knowledgePromotion.enabled=false) — the step no-ops, no events, no provider call', async () => {
  const { repoRoot, ledgerDir, cleanup } = makeEnv();
  try {
    await appendEvents(ledgerDir, mergedItem('WI-605', new Date().toISOString()));
    let called = false;
    const provider: LlmProvider = {
      name: 'shouldnotrun',
      async run(): Promise<ProviderResult> { called = true; return { ok: true, text: '[{"lesson":"x"}]' }; },
    };
    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on', provider,
      config: cfg({ knowledgePromotion: { enabled: false } }),
    });
    assert.equal(called, false, 'the harvest provider must never be invoked while the flag is off');
    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.filter(e => e.type === 'knowledge.candidate').length, 0);
  } finally { cleanup(); }
});

test('reactor: per-beat cap is respected — excess eligible merges are deferred, not skipped forever', async () => {
  const { repoRoot, ledgerDir, cleanup } = makeEnv();
  try {
    // 7 eligible merges > the 5-per-beat cap.
    const events: LedgerEvent[] = [];
    for (let i = 0; i < 7; i++) {
      events.push(...mergedItem(`WI-70${i}`, new Date(Date.now() - (7 - i) * 60_000).toISOString()));
    }
    await appendEvents(ledgerDir, events);
    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on', provider: makeHarvestProvider('[]'), config: cfg(),
    });
    const after = await loadAllEvents(ledgerDir);
    const usageEvents = after.filter(e => e.type === 'cost.usage' && (e.data as { loop?: string }).loop === 'knowledge-harvest');
    assert.equal(usageEvents.length, 5, 'only 5 merges are harvested this beat (per-beat cap)');
  } finally { cleanup(); }
});

test('reactor: WI-270 defect 1 — a successfully-parsed empty-array audit is durably recorded, so beat 2 harvests exactly the remaining eligible merges (no starvation)', async () => {
  const { repoRoot, ledgerDir, cleanup } = makeEnv();
  try {
    // 7 eligible merges > the 5-per-beat cap, oldest-first so eligibility ordering is deterministic.
    const events: LedgerEvent[] = [];
    for (let i = 0; i < 7; i++) {
      events.push(...mergedItem(`WI-71${i}`, new Date(Date.now() - (7 - i) * 60_000).toISOString()));
    }
    await appendEvents(ledgerDir, events);

    // Beat 1: every response is the empty-array default-reject — the common case this defect
    // was about (a non-fabricated, successfully-parsed, zero-candidate result).
    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on', provider: makeHarvestProvider('[]'), config: cfg(),
    });
    let all = await loadAllEvents(ledgerDir);
    const harvestedAfterBeat1 = all.filter(e => e.type === 'knowledge.harvested');
    assert.equal(harvestedAfterBeat1.length, 5, 'beat 1 durably records exactly the 5 it processed, even though every result was empty');

    // Beat 2: the OLD bug re-harvested the same oldest-5 forever (nothing was ever recorded for
    // an empty result), starving the 2 newest merges permanently. The fix must process exactly
    // the 2 remaining unharvested merges this beat.
    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on', provider: makeHarvestProvider('[]'), config: cfg(),
    });
    all = await loadAllEvents(ledgerDir);
    const usageEventsBeat2 = all.filter(e =>
      e.type === 'cost.usage' && (e.data as { loop?: string }).loop === 'knowledge-harvest'
      && !harvestedAfterBeat1.some(h => h.item === e.item),
    );
    const harvestedAfterBeat2 = all.filter(e => e.type === 'knowledge.harvested');
    assert.equal(harvestedAfterBeat2.length, 7, 'all 7 merges are now durably harvested — nothing left unrecorded');
    assert.equal(usageEventsBeat2.length, 2, 'beat 2 processes exactly the 2 merges beat 1 never got to — not a re-harvest of the first 5');

    // Beat 3: everything is now harvested — must be a total no-op (proves the fact is durable,
    // not just "this beat happens not to re-pick them").
    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on', provider: makeHarvestProvider('[]'), config: cfg(),
    });
    const afterBeat3 = await loadAllEvents(ledgerDir);
    const usageEventsBeat3 = afterBeat3.filter(e => e.type === 'cost.usage' && (e.data as { loop?: string }).loop === 'knowledge-harvest');
    assert.equal(usageEventsBeat3.length, 7, 'no NEW usage events on beat 3 — all 7 merges stay durably harvested');
  } finally { cleanup(); }
});

test('reactor: WI-270 defect 1 — a provider failure does NOT record knowledge.harvested (retries next beat)', async () => {
  const { repoRoot, ledgerDir, cleanup } = makeEnv();
  try {
    await appendEvents(ledgerDir, mergedItem('WI-720', new Date().toISOString()));
    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on', provider: makeFailingProvider(), config: cfg(),
    });
    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.filter(e => e.type === 'knowledge.harvested').length, 0,
      'a provider failure must never be mistaken for a completed (empty-result) audit');
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// END-TO-END: harvested candidate → approve → knowledge.ratified → materialize
// ---------------------------------------------------------------------------

test('END-TO-END: a harvested candidate, once approved, ratifies and materializes into the playbook', async () => {
  const { repoRoot, ledgerDir, cleanup } = makeEnv();
  try {
    await appendEvents(ledgerDir, mergedItem('WI-610', new Date().toISOString()));
    const response = '[{"lesson": "Always run the full gate before merging a schema change.", "verifyPath": "src/feature.ts"}]';

    // The candidate's verifyPath must actually resolve for it to survive
    // stepPlaybookMaterialize's read-time revalidation — mirror the fixture's own claim.
    mkdirSync(join(repoRoot, 'src'), { recursive: true });
    writeFileSync(join(repoRoot, 'src', 'feature.ts'), 'export const feature = 1;\n', 'utf8');

    // Beat 1: harvest produces the candidate, parked as a decision.
    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on', provider: makeHarvestProvider(response), config: cfg(),
    });
    let events = await loadAllEvents(ledgerDir);
    const candidateEv = events.find(e => e.type === 'knowledge.candidate')!;
    const candItem = candidateEv.item;
    assert.equal(fold(events).items.get(candItem)!.state, 'parked');

    // Operator approves via the existing verb.
    await approveOrReject(ledgerDir, candItem, 'approve', { repoRoot });

    // Beat 2: stepApplyVerbs ratifies the approved candidate; stepPlaybookMaterialize projects it.
    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on', provider: makeHarvestProvider('[]'), config: cfg(),
    });
    events = await loadAllEvents(ledgerDir);

    const ratified = events.filter(e => e.type === 'knowledge.ratified' && e.item === candItem);
    assert.equal(ratified.length, 1, 'exactly one knowledge.ratified for the approved candidate');
    const ratifiedData = ratified[0]!.data as { lesson: string; sourceWi: string; verifyPath?: string };
    assert.equal(ratifiedData.lesson, 'Always run the full gate before merging a schema change.');
    assert.equal(ratifiedData.sourceWi, 'WI-610');
    assert.equal(ratifiedData.verifyPath, 'src/feature.ts');

    const playbookPath = join(repoRoot, '.ai', 'loops', 'playbook.md');
    const content = readFileSync(playbookPath, 'utf8');
    assert.ok(content.includes(PLAYBOOK_GENERATED_BANNER));
    assert.ok(content.includes('Always run the full gate before merging a schema change.'),
      'the ratified lesson reaches the materialized playbook file');
  } finally { cleanup(); }
});
