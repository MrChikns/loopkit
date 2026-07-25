/**
 * flow-e2e.test.ts — ADR-010 point 5: "one behaviourally-named end-to-end test per plane
 * flow." A repo-coverage audit found three composition rules with no real flow test: the
 * planning/decomposition lane, claims arbitration (only the PURE decideClaimArbitration
 * function was covered — see claim-arbitration.test.ts), and park→pathology→requeue
 * (pathology.test.ts synthesizes the park directly with hand-built makeEvent fixtures
 * rather than reaching it via a real dispatch/reactor flow).
 *
 * Each test below drives the REAL beat entrypoint (runDispatch / runReactor) against a real
 * ledger + a fake LlmProvider, and names the rule the test proves in its title — the name
 * alone should state the contract being defended.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { makeEvent, LedgerEvent } from '../src/schema.js';
import { appendEvents, loadAllEvents } from '../src/ledger.js';
import { fold } from '../src/fold.js';
import { runDispatch } from '../src/beats/dispatch.js';
import { runReactor } from '../src/beats/reactor.js';
import { LlmProvider, ProviderRequest, ProviderResult } from '../src/providers/types.js';
import { LoopkitConfig, CONFIG_DEFAULTS } from '../src/config.js';

let testCount = 0;

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), `loopkit-flow-${process.pid}-${++testCount}-`));
}

function cleanDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function makeTestConfig(overrides: Partial<LoopkitConfig> = {}): LoopkitConfig {
  return {
    ...CONFIG_DEFAULTS,
    gateCommand: 'exit 0',
    gateWorkdir: '.',
    breakerN: 3,
    promptsDir: '.ai/loops/prompts',
    notifyHook: '.ai/notify-phone.sh',
    ...overrides,
  };
}

async function seedLedger(ledgerDir: string, events: LedgerEvent[]): Promise<void> {
  mkdirSync(ledgerDir, { recursive: true });
  await appendEvents(ledgerDir, events);
}

// ===========================================================================
// Flow 1: planning / decomposition lane
// ===========================================================================

test('a queued planning-lane item is decomposed into a real child item via loopctl new, no worktree or commit involved', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });
  mkdirSync(join(repoRoot, '.ai', 'loops', 'prompts'), { recursive: true });
  writeFileSync(join(repoRoot, '.ai', 'loops', 'prompts', 'planner.md'), 'stub planner prompt');
  try {
    await seedLedger(ledgerDir, [
      makeEvent('reactor', 'WI-900', 'item.captured', { source: 'decompose:WI-899', text: 'decompose WI-899: too big' }),
      makeEvent('reactor', 'WI-900', 'item.queued', { spec: 'decompose WI-899: too big', lane: 'planning' }),
    ]);

    // The fake stands in for the planner worker: its ONLY licensed action is the same
    // `loopctl new --source decompose:<id>` command a real headless planner would run — it
    // appends the child directly to the SAME real ledger (no worktree exists for this lane
    // by design), exactly the effect a real `Bash(node <cli> new:*)` tool call would have.
    const provider: LlmProvider = {
      name: 'fake-planner',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        assert.equal(req.cwd, repoRoot, 'the planning lane runs against the primary tree, not a worktree');
        assert.ok(!req.tools?.some(t => t.startsWith('Bash(git') || t === 'Edit' || t === 'Write'),
          'the planner must never be granted git/Edit/Write tools — it can only read + call loopctl new');
        await appendEvents(ledgerDir, [
          makeEvent('cli', 'WI-901', 'item.captured', { source: 'decompose:WI-900', text: 'first buildable slice' }),
        ]);
        return { ok: true, text: 'QUEUED: first buildable slice\nREMAINING:\n- second slice' };
      },
    };

    await runDispatch({ repoRoot, ledgerDir, autonomy: 'on', provider, config: makeTestConfig(), authProbeResult: { ok: true } });

    const events = await loadAllEvents(ledgerDir);
    const folded = fold(events);

    // The epic itself resolves via the planning lane's non-code definition-of-done.
    assert.equal(folded.items.get('WI-900')?.state, 'merged', 'a successful decomposition merges the planning item');
    const merged = events.find(e => e.type === 'item.merged' && e.item === 'WI-900');
    assert.equal((merged?.data as { commit?: string }).commit, 'none (planning lane — no source changes)',
      'the planning lane must never fabricate a source commit');

    // The child is REAL: it exists as its own item in the same ledger, not a text description.
    assert.equal(folded.items.get('WI-901')?.state, 'captured', 'the decomposed child must be a real queued/capturable item');
    assert.equal(folded.items.get('WI-901')?.source, 'decompose:WI-900', 'the child carries provenance back to its epic');
  } finally {
    cleanDir(ledgerDir); cleanDir(repoRoot);
  }
});

// ===========================================================================
// Flow 2: claims arbitration
// ===========================================================================

test('an item claimed by a live attended session is not picked by a dispatch beat', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });
  try {
    const ATTENDED_SESSION = 'ses-attend01';
    const now = new Date();
    const iso = (deltaMs: number) => new Date(now.getTime() + deltaMs).toISOString();

    // A real attended session (session.started + a fresh heartbeat) holds a live claim on
    // WI-910 — the exact envelope an attended `conduct`/fast-drain session leaves behind.
    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-910', 'item.captured', { source: 'cli', text: 'do the thing' }, iso(-60_000)),
      makeEvent('cli', 'WI-910', 'item.queued', { spec: 'do the thing', touches: 'src/' }, iso(-59_000)),
      makeEvent('operator', ATTENDED_SESSION, 'session.started', { sessionId: ATTENDED_SESSION }, iso(-5_000)),
      makeEvent('operator', ATTENDED_SESSION, 'session.heartbeat', { sessionId: ATTENDED_SESSION }, iso(-2_000)),
      makeEvent('operator', 'WI-910', 'item.claimed', { sessionId: ATTENDED_SESSION, ttlMinutes: 60 }, iso(-1_000)),
    ]);

    // If dispatch ever built this item, the fake would be called — assert it never is.
    let providerCalled = false;
    const provider: LlmProvider = {
      name: 'fake',
      async run(): Promise<ProviderResult> {
        providerCalled = true;
        return { ok: true, text: 'done' };
      },
    };

    await runDispatch({ repoRoot, ledgerDir, autonomy: 'on', provider, config: makeTestConfig(), authProbeResult: { ok: true } });

    assert.equal(providerCalled, false, 'a dispatch beat must never spawn a worker for an item under a live foreign claim');

    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.filter(e => e.type === 'build.dispatched' && e.item === 'WI-910').length, 0,
      'no build.dispatched must be recorded for a claimed item the beat yielded on');

    const folded = fold(events);
    const rec = folded.items.get('WI-910')!;
    assert.equal(rec.state, 'queued', 'the item stays queued, untouched by the yielding beat');
    assert.equal(rec.claim?.sessionId, ATTENDED_SESSION, 'the attended session\'s claim survives the beat unpicked');
  } finally {
    cleanDir(ledgerDir); cleanDir(repoRoot);
  }
});

// ===========================================================================
// Flow 3: park -> pathology -> requeue
// ===========================================================================

test('a mis-scoped-gate park is diagnosed and requeued by the pathologist on the NEXT reactor beat', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });
  try {
    // Stage 1 — genesis of the park: a REAL reactor beat parks the item via the actual
    // gate-red-after-approved-merge path (breaker not yet exhausted would requeue directly;
    // an already-exhausted attempt count forces the real ops-park code path instead of a
    // hand-built item.parked fixture). This is the same shape as the existing
    // "gate red parks item as ops when breaker exhausted" test in beats.test.ts, reused here
    // as the genuine precondition for stage 2 rather than synthesized.
    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-920', 'item.captured', { source: 'cli', text: 'z' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-920', 'item.queued', {
        spec: 'fix tests', repairContext: 'Gate red after approved merge: prior test failure',
      }, '2026-01-01T00:01:00Z'),
      makeEvent('dispatch', 'WI-920', 'build.dispatched', { attempt: 3, branch: 'wi-920', pid: 1 }, '2026-01-01T00:02:00Z'),
      makeEvent('dispatch', 'WI-920', 'build.finished', { commit: 'abc' }, '2026-01-01T00:03:00Z'),
      makeEvent('operator', 'WI-920', 'item.approved', { by: 'operator' }, '2026-01-01T00:04:00Z'),
    ]);

    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on', provider: null, config: makeTestConfig(),
      gateRunner: () => ({ passed: false, timedOut: false, reason: 'transient: ENOBUFS spawning the diff' }),
    });

    const afterGenesis = fold(await loadAllEvents(ledgerDir));
    const genesisRec = afterGenesis.items.get('WI-920')!;
    assert.equal(genesisRec.state, 'parked', 'precondition: the real gate-red path must produce a genuine park');
    assert.equal(genesisRec.parkKind, 'ops', 'precondition: breaker-exhausted merge failure parks as ops, not decision');
    assert.ok(genesisRec.parkFingerprint, 'precondition: the fold must have computed a real parkFingerprint for the park');

    // Stage 2 — the pathologist's OWN beat, run separately (a later interval), with a
    // provider that classifies the failure as transient-infra so it requeues rather than
    // escalating. This is what actually exercises stepPathology's diagnose+requeue path
    // against a park the reactor itself produced, not one this test fabricated.
    const TRANSIENT_TEXT = `CLASSIFICATION: transient-infra
EVIDENCE:
- ENOBUFS on the diff spawn, unrelated to the change itself
PROPOSED_ACTION: retry as-is`;
    const provider: LlmProvider = {
      name: 'fake-pathology',
      async run(): Promise<ProviderResult> {
        return { ok: true, text: TRANSIENT_TEXT, usage: { in: 10, out: 20, usd: 0.001 } };
      },
    };

    // The pathologist's own transient-infra requeue path is ALSO breaker-gated
    // (rec.attempts >= cfg.breakerN escalates to parked-review instead of requeuing) — the
    // genesis park above deliberately reached attempts=breakerN(3) so stage 1 itself parks
    // (rather than requeues) via the reactor's own gate-red path. Widen the breaker for this
    // SECOND beat only, so stage 2 exercises the requeue arm of stepPathology rather than its
    // parked-review arm — the two stages test different breaker edges by construction, not by
    // accident.
    await runReactor({ repoRoot, ledgerDir, autonomy: 'on', provider, config: makeTestConfig({ breakerN: 5 }) });

    const events = await loadAllEvents(ledgerDir);
    const diag = events.filter(e => e.type === 'diagnosis.recorded' && e.item === 'WI-920');
    assert.equal(diag.length, 1, 'the pathologist must diagnose the genuine park exactly once');
    assert.equal((diag[0]!.data as { classification?: string }).classification, 'transient-infra');

    const requeued = events.filter(e => e.type === 'item.queued' && e.item === 'WI-920' && e.actor === 'reactor');
    assert.equal(requeued.length, 1, 'a transient-infra diagnosis must requeue the item, not leave it parked');

    const folded = fold(events);
    assert.equal(folded.items.get('WI-920')?.state, 'queued', 'the item is back in the queue after diagnosis');

    const note = events.find(e => e.type === 'msg.out' && e.item === 'WI-920'
      && (e.data as { text?: string }).text?.startsWith('pathology:'));
    assert.ok(note, 'a pathology: trail note must explain the requeue');
  } finally {
    cleanDir(ledgerDir); cleanDir(repoRoot);
  }
});
