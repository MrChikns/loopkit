/**
 * pathology.test.ts — WI-084 the park pathologist: reactor-level stepPathology tests.
 *
 * Covers the full test matrix from the WI-084 contract:
 *   1. transient-infra → requeue + diagnosis.recorded + msg.out; attempts < breakerN.
 *   2. transient-infra with attempts>=breakerN → NO requeue, parks for review.
 *   3. plane-infra-bug → new repair item.captured + item.blocked on victim; victim stays parked.
 *   4. blocked-victim release: blocker merges → victim requeues + blockedOn clears.
 *   5. items-own-code first failure → requeue once, repairContext carries the diagnosis.
 *   6. items-own-code second failure → parks for review with an escalation payload.
 *   7. fingerprint dedup: same fingerprint after a diagnosis → NO second provider call.
 *   8. provider-failure skip: provider ok:false → 'unavailable' skip, park unchanged.
 *   9. provider null → same skip path, zero provider calls.
 *   10. parkKind:'decision' → never diagnosed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { makeEvent, LedgerEvent, ParkKind } from '../src/schema.js';
import { appendEvents, loadAllEvents } from '../src/ledger.js';
import { fold } from '../src/fold.js';
import { runReactor } from '../src/beats/reactor.js';
import { LlmProvider, ProviderRequest, ProviderResult } from '../src/providers/types.js';
import { LoopkitConfig, CONFIG_DEFAULTS } from '../src/config.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let testCount = 0;

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), `loopkit-wi084-${process.pid}-${++testCount}-`));
  return dir;
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

/** A fake provider returning a fixed pathology-grammar text. */
function makePathologyProvider(text: string): LlmProvider {
  return {
    name: 'fake-pathology',
    async run(_req: ProviderRequest): Promise<ProviderResult> {
      return { ok: true, text, usage: { in: 10, out: 20, usd: 0.001 } };
    },
  };
}

/** A counting wrapper — asserts how many times provider.run() was actually invoked. */
function countingProvider(inner: LlmProvider): LlmProvider & { callCount: () => number } {
  let calls = 0;
  return {
    name: inner.name,
    async run(req: ProviderRequest): Promise<ProviderResult> {
      calls++;
      return inner.run(req);
    },
    callCount: () => calls,
  };
}

const TRANSIENT_TEXT = `CLASSIFICATION: transient-infra
EVIDENCE:
- ENOBUFS on the diff spawn
PROPOSED_ACTION: retry as-is`;

const PLANE_BUG_TEXT = `CLASSIFICATION: plane-infra-bug
EVIDENCE:
- the gate runner script itself threw, unrelated to the diff
PROPOSED_ACTION: fix the gate runner script`;

const OWN_CODE_TEXT = `CLASSIFICATION: items-own-code
EVIDENCE:
- test failure in the changed file
PROPOSED_ACTION: fix the failing assertion`;

/** Seed a minimal captured+queued+parked(ops) item, one build.dispatched to set attempts. */
function seedParkedOpsItem(
  id: string,
  opts: { attempt?: number; parkKind?: ParkKind; reason?: string } = {},
): LedgerEvent[] {
  const attempt = opts.attempt ?? 1;
  const parkKind = opts.parkKind ?? 'ops';
  const reason = opts.reason ?? 'gate red: tests failed';
  return [
    makeEvent('cli', id, 'item.captured', { source: 'cli', text: 'do the thing' }, '2026-01-01T00:00:00Z'),
    makeEvent('cli', id, 'item.queued', { spec: 'do the thing' }, '2026-01-01T00:00:01Z'),
    makeEvent('dispatch', id, 'build.dispatched', { attempt, branch: `${id.toLowerCase()}-a`, pid: 1 }, '2026-01-01T00:00:02Z'),
    makeEvent('dispatch', id, 'item.parked', { reason, parkKind }, '2026-01-01T00:00:03Z'),
  ];
}

// ---------------------------------------------------------------------------
// 1. transient-infra, attempts < breakerN → requeue
// ---------------------------------------------------------------------------

test('pathology: transient-infra requeues when attempts < breakerN', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  try {
    await seedLedger(ledgerDir, seedParkedOpsItem('WI-050', { attempt: 1 }));

    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on',
      provider: makePathologyProvider(TRANSIENT_TEXT),
      config: makeTestConfig({ breakerN: 3 }),
    });

    const events = await loadAllEvents(ledgerDir);
    const requeued = events.filter(e => e.type === 'item.queued' && e.item === 'WI-050' && e.actor === 'reactor');
    assert.equal(requeued.length, 1, 'must requeue once under the breaker');

    const diag = events.filter(e => e.type === 'diagnosis.recorded' && e.item === 'WI-050');
    assert.equal(diag.length, 1);
    assert.equal((diag[0].data as { actedAs?: string }).actedAs, 'requeued-transient');
    assert.equal((diag[0].data as { classification?: string }).classification, 'transient-infra');

    const notes = events.filter(e => e.type === 'msg.out' && e.item === 'WI-050'
      && (e.data as { text?: string }).text?.startsWith('pathology:'));
    assert.ok(notes.length >= 1, 'must append a pathology: msg.out note');

    assert.equal(fold(events).items.get('WI-050')?.state, 'queued');
  } finally {
    cleanDir(ledgerDir); cleanDir(repoRoot);
  }
});

// ---------------------------------------------------------------------------
// 2. transient-infra, breaker exhausted → parks for review, no requeue
// ---------------------------------------------------------------------------

test('pathology: transient-infra with breaker exhausted parks for review (no requeue)', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  try {
    await seedLedger(ledgerDir, seedParkedOpsItem('WI-051', { attempt: 3 }));

    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on',
      provider: makePathologyProvider(TRANSIENT_TEXT),
      config: makeTestConfig({ breakerN: 3 }),
    });

    const events = await loadAllEvents(ledgerDir);
    const requeued = events.filter(e => e.type === 'item.queued' && e.item === 'WI-051' && e.actor === 'reactor');
    assert.equal(requeued.length, 0, 'must NOT requeue once the breaker is exhausted');

    const parked = events.filter(e => e.type === 'item.parked' && e.item === 'WI-051' && e.actor === 'reactor');
    assert.equal(parked.length, 1, 'must park for review');
    assert.equal((parked[0].data as { parkKind?: string }).parkKind, 'decision');

    const diag = events.filter(e => e.type === 'diagnosis.recorded' && e.item === 'WI-051');
    assert.equal((diag[0].data as { actedAs?: string }).actedAs, 'parked-review');

    assert.equal(fold(events).items.get('WI-051')?.state, 'parked');
  } finally {
    cleanDir(ledgerDir); cleanDir(repoRoot);
  }
});

// ---------------------------------------------------------------------------
// 3. plane-infra-bug → repair WI captured + victim blocked
// ---------------------------------------------------------------------------

test('pathology: plane-infra-bug captures a repair WI and blocks the victim', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  try {
    await seedLedger(ledgerDir, seedParkedOpsItem('WI-052', { attempt: 1 }));

    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on',
      provider: makePathologyProvider(PLANE_BUG_TEXT),
      config: makeTestConfig({ breakerN: 3 }),
    });

    const events = await loadAllEvents(ledgerDir);

    const captured = events.filter(e => e.type === 'item.captured' && e.item !== 'WI-052');
    assert.equal(captured.length, 1, 'must capture exactly one new repair WI');
    const repairId = captured[0].item;
    assert.equal((captured[0].data as { source?: string }).source, 'reactor:pathology');
    assert.equal((captured[0].data as { lane?: string }).lane, 'engineering');

    const blocked = events.filter(e => e.type === 'item.blocked' && e.item === 'WI-052');
    assert.equal(blocked.length, 1);
    assert.equal((blocked[0].data as { onItem?: string }).onItem, repairId);

    const diag = events.filter(e => e.type === 'diagnosis.recorded' && e.item === 'WI-052');
    assert.equal((diag[0].data as { actedAs?: string }).actedAs, 'blocked-on-repair');
    assert.equal((diag[0].data as { repairItem?: string }).repairItem, repairId);

    const folded = fold(events);
    assert.equal(folded.items.get('WI-052')?.state, 'parked', 'victim stays parked');
    assert.equal(folded.items.get('WI-052')?.blockedOn, repairId);
  } finally {
    cleanDir(ledgerDir); cleanDir(repoRoot);
  }
});

// ---------------------------------------------------------------------------
// 4. blocked-victim release when the blocker merges
// ---------------------------------------------------------------------------

test('pathology: blocked victim requeues once its blocker merges (blockedOn clears)', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  try {
    await seedLedger(ledgerDir, [
      ...seedParkedOpsItem('WI-053', { attempt: 1 }),
      makeEvent('reactor', 'WI-053', 'item.blocked', { onItem: 'WI-054', reason: 'plane-infra-bug (pathology)' }, '2026-01-01T00:00:04Z'),
      makeEvent('reactor', 'WI-054', 'item.captured', { source: 'reactor:pathology', text: 'fix the plane bug', lane: 'engineering' }, '2026-01-01T00:00:05Z'),
      makeEvent('reactor', 'WI-054', 'item.queued', { spec: 'fix the plane bug' }, '2026-01-01T00:00:06Z'),
      makeEvent('reactor', 'WI-054', 'item.merged', { commit: 'deadbeef' }, '2026-01-01T00:00:07Z'),
    ]);

    const preFold = fold(await loadAllEvents(ledgerDir));
    assert.equal(preFold.items.get('WI-053')?.blockedOn, 'WI-054', 'pre-condition: victim blocked');
    assert.equal(preFold.items.get('WI-054')?.state, 'merged', 'pre-condition: blocker merged');

    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on',
      provider: null,   // release path needs no provider
      config: makeTestConfig({ breakerN: 3 }),
    });

    const events = await loadAllEvents(ledgerDir);
    const requeued = events.filter(e => e.type === 'item.queued' && e.item === 'WI-053' && e.actor === 'reactor');
    assert.equal(requeued.length, 1, 'must requeue the released victim');

    const folded = fold(events);
    assert.equal(folded.items.get('WI-053')?.state, 'queued');
    assert.equal(folded.items.get('WI-053')?.blockedOn, undefined, 'blockedOn must clear on requeue');
  } finally {
    cleanDir(ledgerDir); cleanDir(repoRoot);
  }
});

// ---------------------------------------------------------------------------
// 4b. WI-099: blocked-victim wait-timeout — a blocker that never merges
// ---------------------------------------------------------------------------

test('pathology: blocked victim past the wait-timeout re-parks as decision with diagnosis (blocker rejected)', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  try {
    await seedLedger(ledgerDir, [
      ...seedParkedOpsItem('WI-060', { attempt: 1 }),
      makeEvent('reactor', 'WI-060', 'item.blocked', { onItem: 'WI-061', reason: 'plane-infra-bug (pathology)' }, '2026-01-01T00:00:04Z'),
      makeEvent('reactor', 'WI-061', 'item.captured', { source: 'reactor:pathology', text: 'fix the plane bug', lane: 'engineering' }, '2026-01-01T00:00:05Z'),
      makeEvent('reactor', 'WI-061', 'item.queued', { spec: 'fix the plane bug' }, '2026-01-01T00:00:06Z'),
      makeEvent('operator', 'WI-061', 'item.rejected', { by: 'operator' }, '2026-01-01T00:00:07Z'),
    ]);

    const preFold = fold(await loadAllEvents(ledgerDir));
    assert.equal(preFold.items.get('WI-060')?.state, 'parked', 'pre-condition: victim parked');
    assert.equal(preFold.items.get('WI-060')?.blockedOn, 'WI-061');
    assert.equal(preFold.items.get('WI-061')?.state, 'rejected', 'pre-condition: blocker rejected, never merges');

    // 25 hours after the victim's item.parked (2026-01-01T00:00:03Z) — past the 24h default.
    const now = new Date('2026-01-02T01:00:03Z').getTime();

    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on',
      provider: null,   // release/timeout path needs no provider
      config: makeTestConfig({ breakerN: 3 }),
      now,
    });

    const events = await loadAllEvents(ledgerDir);
    const reparked = events.filter(e => e.type === 'item.parked' && e.item === 'WI-060' && e.actor === 'reactor');
    assert.equal(reparked.length, 1, 'must re-park the timed-out victim exactly once');
    const data = reparked[0].data as { reason?: string; parkKind?: string; escalation?: { intent: string; evidence: string; risk: string; recommendation: string } };
    assert.equal(data.parkKind, 'decision', 'must escalate to the operator desk, not the health lane');
    assert.match(data.reason ?? '', /WI-061/, 'reason must carry the original blocker id');
    assert.ok(data.escalation, 'must carry an escalation payload');
    assert.match(data.escalation!.evidence, /WI-061/);
    assert.match(data.escalation!.recommendation, /WI-061/);

    const msgOut = events.filter(e => e.type === 'msg.out' && e.item === 'WI-060' && e.actor === 'reactor');
    assert.ok(msgOut.some(e => (e.data as { text?: string }).text?.includes('wait-timeout')), 'must surface a thread note');

    const folded = fold(events);
    assert.equal(folded.items.get('WI-060')?.state, 'parked', 'victim stays parked (now as a decision park)');
    assert.equal(folded.items.get('WI-060')?.parkKind, 'decision');
  } finally {
    cleanDir(ledgerDir); cleanDir(repoRoot);
  }
});

test('pathology: blocked victim within the wait-timeout window stays parked (no re-park yet)', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  try {
    await seedLedger(ledgerDir, [
      ...seedParkedOpsItem('WI-062', { attempt: 1 }),
      makeEvent('reactor', 'WI-062', 'item.blocked', { onItem: 'WI-063', reason: 'plane-infra-bug (pathology)' }, '2026-01-01T00:00:04Z'),
      makeEvent('reactor', 'WI-063', 'item.captured', { source: 'reactor:pathology', text: 'fix the plane bug', lane: 'engineering' }, '2026-01-01T00:00:05Z'),
      makeEvent('reactor', 'WI-063', 'item.queued', { spec: 'fix the plane bug' }, '2026-01-01T00:00:06Z'),
      // WI-063 (the blocker) is still building — no terminal event at all.
    ]);

    // Only 1 hour after the victim's item.parked — well within the 24h default.
    const now = new Date('2026-01-01T01:00:03Z').getTime();

    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on',
      provider: null,
      config: makeTestConfig({ breakerN: 3 }),
      now,
    });

    const events = await loadAllEvents(ledgerDir);
    const reparked = events.filter(e => e.type === 'item.parked' && e.item === 'WI-062' && e.actor === 'reactor');
    assert.equal(reparked.length, 0, 'must NOT re-park before the wait-timeout elapses');
    const requeued = events.filter(e => e.type === 'item.queued' && e.item === 'WI-062' && e.actor === 'reactor');
    assert.equal(requeued.length, 0, 'blocker has not merged — no release either');

    const folded = fold(events);
    assert.equal(folded.items.get('WI-062')?.state, 'parked');
    assert.equal(folded.items.get('WI-062')?.blockedOn, 'WI-063', 'still genuinely blocked, unchanged');
  } finally {
    cleanDir(ledgerDir); cleanDir(repoRoot);
  }
});

test('pathology: blockedWaitTimeoutHours is configurable and respected', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  try {
    await seedLedger(ledgerDir, [
      ...seedParkedOpsItem('WI-064', { attempt: 1 }),
      makeEvent('reactor', 'WI-064', 'item.blocked', { onItem: 'WI-065', reason: 'plane-infra-bug (pathology)' }, '2026-01-01T00:00:04Z'),
      makeEvent('reactor', 'WI-065', 'item.captured', { source: 'reactor:pathology', text: 'fix the plane bug', lane: 'engineering' }, '2026-01-01T00:00:05Z'),
      makeEvent('reactor', 'WI-065', 'item.queued', { spec: 'fix the plane bug' }, '2026-01-01T00:00:06Z'),
      makeEvent('reactor', 'WI-065', 'item.parked', { reason: 'gate red', parkKind: 'ops' }, '2026-01-01T00:00:07Z'),
    ]);

    // 2 hours after the victim's park — past a configured 1h timeout.
    const now = new Date('2026-01-01T02:00:03Z').getTime();

    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on',
      provider: null,
      config: makeTestConfig({ breakerN: 3, pathology: { ...CONFIG_DEFAULTS.pathology, blockedWaitTimeoutHours: 1 } }),
      now,
    });

    const events = await loadAllEvents(ledgerDir);
    const reparked = events.filter(e => e.type === 'item.parked' && e.item === 'WI-064' && e.actor === 'reactor');
    assert.equal(reparked.length, 1, 'a shorter configured timeout must fire sooner');
    assert.equal((reparked[0].data as { parkKind?: string }).parkKind, 'decision');
  } finally {
    cleanDir(ledgerDir); cleanDir(repoRoot);
  }
});

test('pathology: wait-timeout escalation is one-shot across repeated beats (no re-parking every interval)', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  try {
    await seedLedger(ledgerDir, [
      ...seedParkedOpsItem('WI-066', { attempt: 1 }),
      makeEvent('reactor', 'WI-066', 'item.blocked', { onItem: 'WI-067', reason: 'plane-infra-bug (pathology)' }, '2026-01-01T00:00:04Z'),
      makeEvent('reactor', 'WI-067', 'item.captured', { source: 'reactor:pathology', text: 'fix the plane bug', lane: 'engineering' }, '2026-01-01T00:00:05Z'),
      makeEvent('reactor', 'WI-067', 'item.queued', { spec: 'fix the plane bug' }, '2026-01-01T00:00:06Z'),
      // WI-067 (the blocker) never merges or terminates — it just sits building forever.
    ]);

    const reactorArgs = {
      repoRoot, ledgerDir, autonomy: 'on' as const,
      provider: null,
      config: makeTestConfig({ breakerN: 3 }),
    };

    // Beat 1: 25 hours after the park — past the 24h default, escalation should fire.
    await runReactor({ ...reactorArgs, now: new Date('2026-01-02T01:00:03Z').getTime() });

    // Beat 2: another full timeout window later, blocker STILL hasn't merged. Under the bug,
    // parkedAt was reset by beat 1's re-park, so blockedOn+the age check alone would fire a
    // second escalation here.
    await runReactor({ ...reactorArgs, now: new Date('2026-01-03T02:00:03Z').getTime() });

    // Beat 3: yet another window later, for good measure.
    await runReactor({ ...reactorArgs, now: new Date('2026-01-04T03:00:03Z').getTime() });

    const events = await loadAllEvents(ledgerDir);
    const reparked = events.filter(e => e.type === 'item.parked' && e.item === 'WI-066' && e.actor === 'reactor');
    assert.equal(reparked.length, 1, 'escalation must fire exactly once, not on every subsequent beat');

    const escalationNotes = events.filter(e => e.type === 'msg.out' && e.item === 'WI-066' && e.actor === 'reactor'
      && (e.data as { text?: string }).text?.includes('wait-timeout'));
    assert.equal(escalationNotes.length, 1, 'must surface exactly one wait-timeout thread note');

    const folded = fold(events);
    assert.equal(folded.items.get('WI-066')?.state, 'parked');
    assert.equal(folded.items.get('WI-066')?.parkKind, 'decision', 'stays escalated, not silently re-diagnosed');
  } finally {
    cleanDir(ledgerDir); cleanDir(repoRoot);
  }
});

test('pathology: blocker merging after wait-timeout escalation does NOT auto-requeue past the decision park', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  try {
    await seedLedger(ledgerDir, [
      ...seedParkedOpsItem('WI-068', { attempt: 1 }),
      makeEvent('reactor', 'WI-068', 'item.blocked', { onItem: 'WI-069', reason: 'plane-infra-bug (pathology)' }, '2026-01-01T00:00:04Z'),
      makeEvent('reactor', 'WI-069', 'item.captured', { source: 'reactor:pathology', text: 'fix the plane bug', lane: 'engineering' }, '2026-01-01T00:00:05Z'),
      makeEvent('reactor', 'WI-069', 'item.queued', { spec: 'fix the plane bug' }, '2026-01-01T00:00:06Z'),
      // WI-069 (the blocker) is still building at the time the timeout fires.
    ]);

    const reactorArgs = {
      repoRoot, ledgerDir, autonomy: 'on' as const,
      provider: null,
      config: makeTestConfig({ breakerN: 3 }),
    };

    // Beat 1: past the 24h default — escalation fires, victim re-parks as parkKind:'decision'.
    await runReactor({ ...reactorArgs, now: new Date('2026-01-02T01:00:03Z').getTime() });

    const midFold = fold(await loadAllEvents(ledgerDir));
    assert.equal(midFold.items.get('WI-068')?.parkKind, 'decision', 'pre-condition: escalation fired');
    assert.equal(midFold.items.get('WI-068')?.blockedOn, 'WI-069', 'pre-condition: blockedOn survives the re-park');

    // The blocker merges AFTER the escalation already fired.
    await seedLedger(ledgerDir, [
      makeEvent('worker', 'WI-069', 'item.merged', { commit: 'deadbeef' }, '2026-01-02T02:00:00Z'),
    ]);

    // Beat 2: the blocker is now merged. The buggy release loop matches on blockedOn alone and
    // would auto-requeue the victim right past the operator's decision park.
    await runReactor({ ...reactorArgs, now: new Date('2026-01-02T03:00:03Z').getTime() });

    const events = await loadAllEvents(ledgerDir);
    const requeued = events.filter(e => e.type === 'item.queued' && e.item === 'WI-068' && e.actor === 'reactor');
    assert.equal(requeued.length, 0, 'must NOT auto-requeue an already-escalated victim just because the blocker later merged');

    const folded = fold(events);
    assert.equal(folded.items.get('WI-068')?.state, 'parked', 'victim stays parked for the operator');
    assert.equal(folded.items.get('WI-068')?.parkKind, 'decision', 'stays a decision park, not silently released');
  } finally {
    cleanDir(ledgerDir); cleanDir(repoRoot);
  }
});

// ---------------------------------------------------------------------------
// 5. items-own-code first failure → requeue once with diagnosis injected
// ---------------------------------------------------------------------------

test('pathology: items-own-code first failure requeues once with the diagnosis injected', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  try {
    await seedLedger(ledgerDir, seedParkedOpsItem('WI-055', { attempt: 1 }));

    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on',
      provider: makePathologyProvider(OWN_CODE_TEXT),
      config: makeTestConfig({ breakerN: 3 }),
    });

    const events = await loadAllEvents(ledgerDir);
    const requeued = events.filter(e => e.type === 'item.queued' && e.item === 'WI-055' && e.actor === 'reactor');
    assert.equal(requeued.length, 1);
    const repairContext = (requeued[0].data as { repairContext?: string }).repairContext ?? '';
    assert.ok(repairContext.includes('pathology(items-own-code)'), 'repairContext must carry the diagnosis');
    assert.ok(repairContext.includes('fix the failing assertion'));

    const diag = events.filter(e => e.type === 'diagnosis.recorded' && e.item === 'WI-055');
    assert.equal((diag[0].data as { actedAs?: string }).actedAs, 'requeued-own-code');

    assert.equal(fold(events).items.get('WI-055')?.ownCodeFailures, 1);
  } finally {
    cleanDir(ledgerDir); cleanDir(repoRoot);
  }
});

// ---------------------------------------------------------------------------
// 6. items-own-code SECOND failure → parks for review with an escalation payload
// ---------------------------------------------------------------------------

test('pathology: items-own-code second failure parks for review with escalation', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  try {
    // Seed a PRIOR own-code diagnosis (ownCodeFailures already 1) with a DIFFERENT fingerprint
    // (a fresh park reason) so the fresh park below is still eligible for diagnosis (dedup keys
    // off parkFingerprint, not ownCodeFailures).
    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-056', 'item.captured', { source: 'cli', text: 'do the thing' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-056', 'item.queued', { spec: 'do the thing' }, '2026-01-01T00:00:01Z'),
      makeEvent('dispatch', 'WI-056', 'build.dispatched', { attempt: 1, branch: 'wi-056-a', pid: 1 }, '2026-01-01T00:00:02Z'),
      makeEvent('dispatch', 'WI-056', 'item.parked', { reason: 'gate red: first failure', parkKind: 'ops' }, '2026-01-01T00:00:03Z'),
      makeEvent('reactor', 'WI-056', 'diagnosis.recorded', {
        parkFingerprint: 'prior-fingerprint-stub', classification: 'items-own-code',
        evidence: ['prior evidence'], proposedAction: 'prior fix', actedAs: 'requeued-own-code', model: 'opus',
      }, '2026-01-01T00:00:04Z'),
      makeEvent('reactor', 'WI-056', 'item.queued', { spec: 'do the thing', repairContext: 'pathology(items-own-code): prior fix' }, '2026-01-01T00:00:05Z'),
      makeEvent('dispatch', 'WI-056', 'build.dispatched', { attempt: 2, branch: 'wi-056-b', pid: 2 }, '2026-01-01T00:00:06Z'),
      // SECOND failure, a fresh park with a NEW reason (new fingerprint) so it's a live candidate.
      makeEvent('dispatch', 'WI-056', 'item.parked', { reason: 'gate red: second failure', parkKind: 'ops' }, '2026-01-01T00:00:07Z'),
    ]);

    const preFold = fold(await loadAllEvents(ledgerDir));
    assert.equal(preFold.items.get('WI-056')?.ownCodeFailures, 1, 'pre-condition: one prior own-code failure');

    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on',
      provider: makePathologyProvider(OWN_CODE_TEXT),
      config: makeTestConfig({ breakerN: 3 }),
    });

    const events = await loadAllEvents(ledgerDir);
    const newRequeues = events.filter(e => e.type === 'item.queued' && e.item === 'WI-056' && e.actor === 'reactor'
      && e.ts > '2026-01-01T00:00:07Z');
    assert.equal(newRequeues.length, 0, 'must NOT requeue on the second own-code failure');

    const parked = events.filter(e => e.type === 'item.parked' && e.item === 'WI-056' && e.actor === 'reactor');
    assert.equal(parked.length, 1);
    assert.equal((parked[0].data as { parkKind?: string }).parkKind, 'decision');
    const escalation = (parked[0].data as { escalation?: { intent: string; evidence: string; risk: string; recommendation: string } }).escalation;
    assert.ok(escalation, 'must carry an EscalationPayload');
    assert.ok(escalation!.intent && escalation!.evidence && escalation!.risk && escalation!.recommendation);

    assert.equal(fold(events).items.get('WI-056')?.ownCodeFailures, 2);
  } finally {
    cleanDir(ledgerDir); cleanDir(repoRoot);
  }
});

// ---------------------------------------------------------------------------
// 7. fingerprint dedup — no second provider call
// ---------------------------------------------------------------------------

test('pathology: fingerprint dedup — a repeat identical park spawns NO second provider call', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  try {
    await seedLedger(ledgerDir, seedParkedOpsItem('WI-057', { attempt: 1, reason: 'gate red: same failure' }));

    const provider = countingProvider(makePathologyProvider(TRANSIENT_TEXT));

    // First beat: diagnoses + requeues (transient-infra).
    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on', provider,
      config: makeTestConfig({ breakerN: 3 }),
    });
    assert.equal(provider.callCount(), 1, 'first beat must call the provider once');

    // Re-park with the EXACT SAME reason+parkKind → same fingerprint.
    await appendEvents(ledgerDir, [
      makeEvent('dispatch', 'WI-057', 'build.dispatched', { attempt: 2, branch: 'wi-057-b', pid: 2 }),
      makeEvent('dispatch', 'WI-057', 'item.parked', { reason: 'gate red: same failure', parkKind: 'ops' }),
    ]);

    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on', provider,
      config: makeTestConfig({ breakerN: 3 }),
    });

    assert.equal(provider.callCount(), 1, 'a repeat identical park must NOT spawn a second provider call');
  } finally {
    cleanDir(ledgerDir); cleanDir(repoRoot);
  }
});

// ---------------------------------------------------------------------------
// 8. provider-failure skip
// ---------------------------------------------------------------------------

test('pathology: provider failure → unavailable skip, park unchanged', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  try {
    await seedLedger(ledgerDir, seedParkedOpsItem('WI-058', { attempt: 1 }));

    const failingProvider: LlmProvider = {
      name: 'failing',
      async run(): Promise<ProviderResult> { return { ok: false, error: 'boom', code: 'unknown' }; },
    };

    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on', provider: failingProvider,
      config: makeTestConfig({ breakerN: 3 }),
    });

    const events = await loadAllEvents(ledgerDir);
    const requeued = events.filter(e => e.type === 'item.queued' && e.item === 'WI-058' && e.actor === 'reactor');
    assert.equal(requeued.length, 0, 'must NOT requeue on provider failure');

    const diag = events.filter(e => e.type === 'diagnosis.recorded' && e.item === 'WI-058');
    assert.equal(diag.length, 1);
    assert.equal((diag[0].data as { classification?: string }).classification, 'unavailable');
    assert.equal((diag[0].data as { actedAs?: string }).actedAs, 'skipped');
    assert.equal((diag[0].data as { reason?: string }).reason, 'boom');

    assert.equal(fold(events).items.get('WI-058')?.state, 'parked', 'park must stand unchanged');
  } finally {
    cleanDir(ledgerDir); cleanDir(repoRoot);
  }
});

// ---------------------------------------------------------------------------
// 9. provider null
// ---------------------------------------------------------------------------

test('pathology: provider null → same skip path, zero provider calls, park unchanged', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  try {
    await seedLedger(ledgerDir, seedParkedOpsItem('WI-059', { attempt: 1 }));

    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on', provider: null,
      config: makeTestConfig({ breakerN: 3 }),
    });

    const events = await loadAllEvents(ledgerDir);
    const diag = events.filter(e => e.type === 'diagnosis.recorded' && e.item === 'WI-059');
    assert.equal(diag.length, 1);
    assert.equal((diag[0].data as { classification?: string }).classification, 'unavailable');
    assert.equal((diag[0].data as { actedAs?: string }).actedAs, 'skipped');
    assert.equal((diag[0].data as { reason?: string }).reason, 'no provider');

    const requeued = events.filter(e => e.type === 'item.queued' && e.item === 'WI-059' && e.actor === 'reactor');
    assert.equal(requeued.length, 0);
    assert.equal(fold(events).items.get('WI-059')?.state, 'parked');
  } finally {
    cleanDir(ledgerDir); cleanDir(repoRoot);
  }
});

// ---------------------------------------------------------------------------
// 10. parkKind:'decision' → never diagnosed
// ---------------------------------------------------------------------------

test('pathology: parkKind decision is NEVER diagnosed', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  try {
    await seedLedger(ledgerDir, seedParkedOpsItem('WI-060', { attempt: 1, parkKind: 'decision', reason: 'operator: which vendor to use?' }));

    const provider = countingProvider(makePathologyProvider(TRANSIENT_TEXT));

    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on', provider,
      config: makeTestConfig({ breakerN: 3 }),
    });

    assert.equal(provider.callCount(), 0, 'a decision park must never be diagnosed');
    const events = await loadAllEvents(ledgerDir);
    const diag = events.filter(e => e.type === 'diagnosis.recorded' && e.item === 'WI-060');
    assert.equal(diag.length, 0);
    assert.equal(fold(events).items.get('WI-060')?.state, 'parked');
    assert.equal(fold(events).items.get('WI-060')?.parkKind, 'decision');
  } finally {
    cleanDir(ledgerDir); cleanDir(repoRoot);
  }
});

// ---------------------------------------------------------------------------
// 11. TRUST-HARDENING (FIX 2): a PRIVATE parked item is never diagnosed through
//     the beat-global (claude/internal) provider — the diagnosis prompt carries
//     the item's failure trail + worktree diff, so it must fail closed.
// ---------------------------------------------------------------------------

test('pathology: a PRIVATE item fails closed — never routed to the internal provider', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  try {
    // A private parked(ops) failure item.
    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-070', 'item.captured', { source: 'cli', text: 'secret', sensitivity: 'private' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-070', 'item.queued', { spec: 'secret' }, '2026-01-01T00:00:01Z'),
      makeEvent('dispatch', 'WI-070', 'build.dispatched', { attempt: 1, branch: 'wi-070-a', pid: 1 }, '2026-01-01T00:00:02Z'),
      makeEvent('dispatch', 'WI-070', 'item.parked', { reason: 'gate red: tests failed', parkKind: 'ops' }, '2026-01-01T00:00:03Z'),
    ]);

    // NO injected provider → runReactor builds a registry from cfg. internal → claude-cli,
    // private → empty (forbidden). The private item's per-item resolver must return null and the
    // pathology step must record a fail-closed skip WITHOUT invoking any provider.
    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on',
      config: makeTestConfig({
        breakerN: 3,
        sensitivityAllowlists: { internal: ['claude-cli'], public: ['claude-cli'] },
        chains: { internal: ['claude-cli'], public: ['claude-cli'], private: [] },
      } as Partial<LoopkitConfig>),
    });

    const events = await loadAllEvents(ledgerDir);
    const diag = events.filter(e => e.type === 'diagnosis.recorded' && e.item === 'WI-070');
    assert.equal(diag.length, 1, 'a fail-closed diagnosis skip is recorded');
    assert.equal((diag[0].data as { classification?: string }).classification, 'unavailable');
    assert.equal((diag[0].data as { actedAs?: string }).actedAs, 'skipped');
    assert.match((diag[0].data as { reason?: string }).reason ?? '', /sensitivity\(private\)/,
      'the skip names the fail-closed sensitivity');
    // The item stays parked — never diagnosed/requeued through a disallowed provider.
    assert.equal(fold(events).items.get('WI-070')?.state, 'parked');
  } finally {
    cleanDir(ledgerDir); cleanDir(repoRoot);
  }
});
