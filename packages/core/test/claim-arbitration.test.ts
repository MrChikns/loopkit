/**
 * claim-arbitration.test.ts — ADR-007 claim arbitration: the dispatch claim-before-pick
 * pure decision (decideClaimArbitration), the doctor's stale-claim reap
 * (reapStaleClaims), and focused fold assertions on claim set/clear lifecycle that this
 * slice depends on (isClaimActive, the queued-consuming/terminal claim-clear guarantee).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { makeEvent, LedgerEvent } from '../src/schema.js';
import { fold, isClaimActive, SessionRecord } from '../src/fold.js';
import { claimYieldDetail, decideClaimArbitration, runDispatch } from '../src/beats/dispatch.js';
import { reapStaleClaims } from '../src/doctor.js';
import { appendEvents, loadAllEvents } from '../src/ledger.js';
import { CONFIG_DEFAULTS, LoopkitConfig } from '../src/config.js';
import { LlmProvider, ProviderRequest, ProviderResult } from '../src/providers/types.js';
import { manifestHash, readTargetManifest } from '../src/target.js';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

/** Claim/build staleness window used by the arbitration decision (buildTimeout + 5min-ish). */
const BUILD_STALE_MS = 50 * 60_000;

const OP_SESSION = 'ses-attend01';   // an attended operator session
const DISPATCH_SESSION = 'ses-dispat1';   // a dispatch pseudo-session

function queuedItem(id: string, ts: number) {
  return [
    makeEvent('cli', id, 'item.captured', { source: 'cli', text: `${id} work` }, iso(ts)),
    makeEvent('cli', id, 'item.queued', { spec: `${id} spec`, touches: 'src/' }, iso(ts + 1000)),
  ];
}

function sessionsMap(...recs: SessionRecord[]): Map<string, SessionRecord> {
  return new Map(recs.map(r => [r.sessionId, r]));
}

function liveSession(sessionId: string, startedAt: number, lastHeartbeatAt?: number): SessionRecord {
  return { sessionId, startedAt: iso(startedAt), lastHeartbeatAt: lastHeartbeatAt !== undefined ? iso(lastHeartbeatAt) : undefined };
}

function endedSession(sessionId: string, startedAt: number, endedAt: number): SessionRecord {
  return { sessionId, startedAt: iso(startedAt), endedAt: iso(endedAt) };
}

// ---------------------------------------------------------------------------
// decideClaimArbitration (dispatch claim-before-pick pure decision)
// ---------------------------------------------------------------------------

test('decideClaimArbitration: foreign active claim yields', () => {
  const events = [
    ...queuedItem('WI-001', T0),
    makeEvent('cli', 'WI-001', 'item.claimed', { sessionId: OP_SESSION, ttlMinutes: 60 }, iso(T0 + 2000)),
  ];
  const nowMs = T0 + 3000;
  const sessions = sessionsMap(liveSession(OP_SESSION, T0, T0 + 2500));
  const result = fold(events);
  const decisions = decideClaimArbitration(['WI-001'], { ...result, sessions }, DISPATCH_SESSION, nowMs, BUILD_STALE_MS);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]!.keep, false, 'a live foreign claim wins the race');
  assert.equal(decisions[0]!.foreignSessionId, OP_SESSION);
});

test('decideClaimArbitration: dispatch keeps an item it already claimed itself (renewal)', () => {
  const events = [
    ...queuedItem('WI-002', T0),
    makeEvent('dispatch', 'WI-002', 'item.claimed', { sessionId: DISPATCH_SESSION, ttlMinutes: 45 }, iso(T0 + 2000)),
  ];
  const nowMs = T0 + 3000;
  const sessions = sessionsMap(liveSession(DISPATCH_SESSION, T0, T0 + 2500));
  const result = fold(events);
  const decisions = decideClaimArbitration(['WI-002'], { ...result, sessions }, DISPATCH_SESSION, nowMs, BUILD_STALE_MS);
  assert.equal(decisions[0]!.keep, true, 'a claim by dispatch\'s OWN session id is never foreign');
  assert.equal(decisions[0]!.foreignSessionId, undefined);
});

test('decideClaimArbitration: an inactive (expired ttl) foreign claim is kept, not yielded', () => {
  const events = [
    ...queuedItem('WI-003', T0),
    makeEvent('cli', 'WI-003', 'item.claimed', { sessionId: OP_SESSION, ttlMinutes: 1 }, iso(T0 + 2000)),
  ];
  const nowMs = T0 + 2000 + 5 * 60_000;   // 5 minutes later — well past the 1-minute ttl
  const sessions = sessionsMap(liveSession(OP_SESSION, T0, nowMs - 1000));   // heartbeat still fresh, but ttl expired
  const result = fold(events);
  const decisions = decideClaimArbitration(['WI-003'], { ...result, sessions }, DISPATCH_SESSION, nowMs, BUILD_STALE_MS);
  assert.equal(decisions[0]!.keep, true, 'an expired-ttl claim reads inactive — dispatch may take the item');
});

test('decideClaimArbitration: an inactive (dead-man / ended session) foreign claim is kept', () => {
  const events = [
    ...queuedItem('WI-004', T0),
    makeEvent('cli', 'WI-004', 'item.claimed', { sessionId: OP_SESSION, ttlMinutes: 60 }, iso(T0 + 2000)),
  ];
  const nowMs = T0 + 3000;
  const sessions = sessionsMap(endedSession(OP_SESSION, T0, T0 + 2500));
  const result = fold(events);
  const decisions = decideClaimArbitration(['WI-004'], { ...result, sessions }, DISPATCH_SESSION, nowMs, BUILD_STALE_MS);
  assert.equal(decisions[0]!.keep, true, 'an ended session\'s claim is inactive — dispatch may take the item');
});

test('decideClaimArbitration: an unclaimed item is kept', () => {
  const events = queuedItem('WI-005', T0);
  const result = fold(events);
  const decisions = decideClaimArbitration(['WI-005'], result, DISPATCH_SESSION, T0 + 3000, BUILD_STALE_MS);
  assert.equal(decisions[0]!.keep, true);
});

test('decideClaimArbitration: a vanished picker result fails closed with explicit missing detail', () => {
  const decisions = decideClaimArbitration(
    ['WI-999'],
    fold([]),
    DISPATCH_SESSION,
    T0,
    BUILD_STALE_MS,
  );
  assert.deepEqual(decisions, [{
    item: 'WI-999',
    keep: false,
    stateChanged: { state: 'missing' },
  }]);
  assert.match(claimYieldDetail(decisions[0]!), /fresh state is missing/);
});

test('decideClaimArbitration: a RECENT foreign build.dispatched (no claim) yields — WI-074', () => {
  // A foreign actor (attended fast-drain session, or a parallel beat) transitioned the item to
  // 'building' in the read-to-arbitrate window. build.dispatched consumed any claim, so there is
  // NO active claim to yield to — the in-flight-build check is what closes the double-build race.
  const dispatchedAt = T0 + 2000;
  const events = [
    ...queuedItem('WI-006', T0),
    makeEvent('cli', 'WI-006', 'build.dispatched', { attempt: 1 }, iso(dispatchedAt)),
  ];
  const result = fold(events);
  assert.equal(result.items.get('WI-006')!.state, 'building');
  assert.equal(result.items.get('WI-006')!.claim, undefined, 'build.dispatched consumed the claim');
  const nowMs = dispatchedAt + 30_000;   // 30s later — well within the stale window
  const decisions = decideClaimArbitration(['WI-006'], result, DISPATCH_SESSION, nowMs, BUILD_STALE_MS);
  assert.equal(decisions[0]!.keep, false, 'a recent foreign in-flight build blocks takeover');
  assert.equal(decisions[0]!.foreignBuild, true);
  assert.equal(decisions[0]!.foreignSessionId, undefined, 'no session id — it is a build, not a claim');
});

test('decideClaimArbitration: a STALE foreign build still yields until the doctor requeues it', () => {
  // An orphaned building record older than the stale window belongs to the doctor. Dispatch may
  // only admit a fresh queued record; it must not build directly from stale non-queued state.
  const dispatchedAt = T0 + 2000;
  const events = [
    ...queuedItem('WI-007', T0),
    makeEvent('cli', 'WI-007', 'build.dispatched', { attempt: 1 }, iso(dispatchedAt)),
  ];
  const result = fold(events);
  const nowMs = dispatchedAt + BUILD_STALE_MS + 60_000;   // past the stale window
  const decisions = decideClaimArbitration(['WI-007'], result, DISPATCH_SESSION, nowMs, BUILD_STALE_MS);
  assert.equal(decisions[0]!.keep, false);
  assert.deepEqual(decisions[0]!.stateChanged, { state: 'building' });
  assert.equal(decisions[0]!.foreignBuild, undefined,
    'old building state is a lifecycle change, not a claim that the foreign build is still live');
});

// ---------------------------------------------------------------------------
// reapStaleClaims (doctor stale-claim reap)
// ---------------------------------------------------------------------------

const HOUR_MS = 60 * 60_000;

test('reapStaleClaims: an inactive claim older than the reap age is released, naming the session', () => {
  const claimedAt = T0;
  const events = [
    ...queuedItem('WI-010', T0 - 10_000),
    makeEvent('cli', 'WI-010', 'item.claimed', { sessionId: OP_SESSION, ttlMinutes: 60 }, iso(claimedAt)),
  ];
  // Session ended shortly after claiming — the claim has read inactive ever since.
  const sessions = sessionsMap(endedSession(OP_SESSION, T0 - 10_000, T0 + 1000));
  const result = fold(events);
  const nowMs = claimedAt + 3 * HOUR_MS;   // well past the 2h default reap age
  const reapEvents = reapStaleClaims(result, sessions, nowMs);
  assert.equal(reapEvents.length, 1);
  assert.equal(reapEvents[0]!.type, 'item.released');
  assert.equal(reapEvents[0]!.item, 'WI-010');
  const data = reapEvents[0]!.data as { reason?: string; sessionId?: string };
  assert.equal(data.sessionId, OP_SESSION);
  assert.match(data.reason ?? '', new RegExp(OP_SESSION));
  assert.match(data.reason ?? '', /stale claim reaped/);
});

test('reapStaleClaims: a FRESH inactive claim (younger than the reap age) is NOT reaped', () => {
  const claimedAt = T0;
  const events = [
    ...queuedItem('WI-011', T0 - 10_000),
    makeEvent('cli', 'WI-011', 'item.claimed', { sessionId: OP_SESSION, ttlMinutes: 1 }, iso(claimedAt)),
  ];
  // ttl expired 1 minute after claiming, so at nowMs the claim reads inactive — but nowMs
  // itself is only minutes after claimedAt, nowhere near the default 2h reap age.
  const sessions = sessionsMap(liveSession(OP_SESSION, T0 - 10_000, T0 + 30_000));
  const result = fold(events);
  const nowMs = claimedAt + 10 * 60_000;   // 10 minutes later — inactive (ttl expired) but fresh
  const reapEvents = reapStaleClaims(result, sessions, nowMs);
  assert.equal(reapEvents.length, 0, 'a merely-lagged/just-expired claim is left alone');
});

test('reapStaleClaims: an ACTIVE claim (live session, unexpired ttl) is never reaped, no matter its age', () => {
  const claimedAt = T0;
  const events = [
    ...queuedItem('WI-012', T0 - 10_000),
    makeEvent('cli', 'WI-012', 'item.claimed', { sessionId: OP_SESSION, ttlMinutes: 24 * 60 }, iso(claimedAt)),
  ];
  const nowMs = claimedAt + 5 * HOUR_MS;   // past the default reap age, but ttl is 24h and heartbeat is fresh
  const sessions = sessionsMap(liveSession(OP_SESSION, T0 - 10_000, nowMs - 1000));
  const result = fold(events);
  const reapEvents = reapStaleClaims(result, sessions, nowMs);
  assert.equal(reapEvents.length, 0, 'isClaimActive gates the reap — an active claim is never touched');
});

test('reapStaleClaims: re-folding after a FRESH item.claimed protects the new claim (no-silent-erase)', () => {
  // The exact race this hardening closes: at the TOP of stepDoctor, an item's claim
  // (sesA) reads stale-inactive and is proposed for reap. Before the reap append lands,
  // an attended operator session claims the SAME item fresh (sesB) — e.g. a build.dispatched
  // never happened, sesA just died, and a human picked the item up by hand in the window
  // between the doctor's fold and its write. Re-folding immediately before the reap append
  // (as stepDoctor now does under the ledger lock) must see the item as actively claimed by
  // sesB and propose ZERO releases — proving the fresh claim is never erased.
  const claimedAt = T0;
  const staleEvents = [
    ...queuedItem('WI-030', T0 - 10_000),
    makeEvent('cli', 'WI-030', 'item.claimed', { sessionId: OP_SESSION, ttlMinutes: 60 }, iso(claimedAt)),
  ];
  // sesA (the original claimant) ended shortly after claiming — its claim has read
  // inactive ever since, same shape as the "reaped" test above.
  const staleSessions = sessionsMap(endedSession(OP_SESSION, T0 - 10_000, claimedAt + 1000));
  const nowMs = claimedAt + 3 * HOUR_MS;   // well past the default reap age

  // Sanity check: on the STALE fold alone (the doctor's top-of-step snapshot), this claim
  // IS reapable — establishing that the race is real, not vacuously guarded away.
  const staleResult = fold(staleEvents);
  const staleReap = reapStaleClaims(staleResult, staleSessions, nowMs);
  assert.equal(staleReap.length, 1, 'precondition: the stale claim alone reads reapable');

  // Now the race: a fresh operator session (sesB) claims the SAME item AFTER the stale
  // claim, landing between the doctor's fold and its under-lock re-verify.
  const FRESH_SESSION = 'ses-attend02';
  const freshClaimAt = claimedAt + 2.5 * HOUR_MS;   // still well before nowMs
  const freshEvents = [
    ...staleEvents,
    makeEvent('cli', 'WI-030', 'item.claimed', { sessionId: FRESH_SESSION, ttlMinutes: 60 }, iso(freshClaimAt)),
  ];
  const freshSessions = sessionsMap(
    endedSession(OP_SESSION, T0 - 10_000, claimedAt + 1000),
    liveSession(FRESH_SESSION, freshClaimAt, nowMs - 1000),
  );

  // This is what stepDoctor's under-lock withLock(tx => { fold(tx.loadAll()); reapStaleClaims(...) })
  // computes immediately before appending — the fresh re-fold.
  const freshResult = fold(freshEvents);
  const freshReap = reapStaleClaims(freshResult, freshSessions, nowMs);
  assert.equal(freshReap.length, 0, 'the fresh claim (sesB) reads active on re-fold — never released');

  const rec = freshResult.items.get('WI-030')!;
  assert.equal(rec.claim?.sessionId, FRESH_SESSION, 'the item now carries the fresh claim, not the stale one');
});

test('reapStaleClaims: a terminal-state item never carries a live claim — reap is a no-op', () => {
  const claimedAt = T0;
  const events = [
    ...queuedItem('WI-013', T0 - 10_000),
    makeEvent('cli', 'WI-013', 'item.claimed', { sessionId: OP_SESSION, ttlMinutes: 60 }, iso(claimedAt)),
    makeEvent('dispatch', 'WI-013', 'build.dispatched', { attempt: 1 }, iso(claimedAt + 1000)),
    makeEvent('dispatch', 'WI-013', 'item.merged', { commit: 'abc123' }, iso(claimedAt + 2000)),
  ];
  const sessions = sessionsMap(endedSession(OP_SESSION, T0 - 10_000, claimedAt + 1500));
  const result = fold(events);
  const rec = result.items.get('WI-013')!;
  assert.equal(rec.state, 'merged');
  assert.equal(rec.claim, undefined, 'the fold already cleared the claim on the terminal transition');
  const nowMs = claimedAt + 3 * HOUR_MS;
  const reapEvents = reapStaleClaims(result, sessions, nowMs);
  assert.equal(reapEvents.length, 0, 'no live claim on a terminal item — nothing to release');
});

// ---------------------------------------------------------------------------
// Fold: claim set/clear lifecycle this slice depends on (isClaimActive consumes it)
// ---------------------------------------------------------------------------

test('fold + isClaimActive: item.claimed sets an active claim; build.dispatched clears it', () => {
  const events = [
    ...queuedItem('WI-020', T0),
    makeEvent('cli', 'WI-020', 'item.claimed', { sessionId: OP_SESSION, ttlMinutes: 60 }, iso(T0 + 2000)),
  ];
  const sessions = sessionsMap(liveSession(OP_SESSION, T0, T0 + 2500));
  let result = fold(events);
  let rec = result.items.get('WI-020')!;
  assert.ok(rec.claim, 'claim set after item.claimed');
  assert.equal(isClaimActive(rec, sessions, T0 + 3000), true);

  result = fold([...events, makeEvent('dispatch', 'WI-020', 'build.dispatched', { attempt: 1 }, iso(T0 + 3000))]);
  rec = result.items.get('WI-020')!;
  assert.equal(rec.claim, undefined, 'build.dispatched (queued-consuming) clears the claim');
  assert.equal(isClaimActive(rec, sessions, T0 + 4000), false);
});

// ---------------------------------------------------------------------------
// WI-186: the TARGET lane reserves what it picks (ADR-007 gap 1, ported)
//
// Before this slice the target lane read the shared queue (which only defers to claims that
// were already written when the picker folded) and spawned WITHOUT reserving anything — so two
// concurrent pickers could both select the same targeted item in the read-to-spawn window.
// ---------------------------------------------------------------------------

let tmpCount = 0;
function makeTempDir(): string {
  const dir = join(tmpdir(), `loopkit-wi186-${process.pid}-${++tmpCount}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
function cleanDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function testConfig(overrides: Partial<LoopkitConfig> = {}): LoopkitConfig {
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

/** A minimal registered target repo on `main` with a trivial (always-green) manifest gate. */
function makeTargetRepo(root: string): { hash: string } {
  const g = (args: string[]) => spawnSync('git', args, { cwd: root, stdio: 'pipe' });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'loopkit.target.json'), JSON.stringify({
    name: 'acme', defaultBranch: 'main', gateCommand: 'exit 0', gateWorkdir: '.',
    deployCommand: '', worktreePrefix: 'loop-', touches: { conflictMode: 'prefix' },
    boundaries: { planePrefixes: [], surfacePrefixes: ['src/'], escalationPatterns: [] },
    buildTimeoutMinutes: 15,
  }), 'utf8');
  writeFileSync(join(root, 'src', 'seed.js'), '// seed\n', 'utf8');
  g(['init', '-b', 'main']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  g(['add', '-A']);
  g(['commit', '-m', 'init acme target']);
  return { hash: manifestHash(readTargetManifest(root)) };
}

/** Plane repo + ledger + runs dir, seeded with `events`. */
async function makePlaneEnv(events: LedgerEvent[]): Promise<{
  base: string; repoRoot: string; ledgerDir: string; runsDir: string;
}> {
  const base = makeTempDir();
  const repoRoot = join(base, 'repo');
  const ledgerDir = join(base, 'ledger');
  const runsDir = join(base, 'runs');
  mkdirSync(join(repoRoot, '.ai', 'loops', 'prompts'), { recursive: true });
  mkdirSync(ledgerDir, { recursive: true });
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(join(repoRoot, '.ai', 'loops', 'prompts', 'planner.md'), 'stub planner prompt', 'utf8');
  const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
  g(['init', '-b', 'master']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  writeFileSync(join(repoRoot, 'base.txt'), 'base', 'utf8');
  g(['add', 'base.txt']);
  g(['commit', '-m', 'init']);
  await appendEvents(ledgerDir, events);
  return { base, repoRoot, ledgerDir, runsDir };
}

const DISPATCH_PSEUDO_SESSION = 'ses-dispat9';

test('WI-186: the target lane RESERVES the item it picks — item.claimed precedes its build.dispatched', async () => {
  const targetRoot = join(makeTempDir(), 'acme');
  const { hash } = makeTargetRepo(targetRoot);
  const env = await makePlaneEnv([
    makeEvent('cli', 'acme', 'target.registered', { name: 'acme', repoPath: targetRoot, manifestHash: hash, defaultBranch: 'main' }),
    makeEvent('cli', 'WI-701', 'item.captured', { source: 'cli', text: 'add acme widget', target: 'acme' }),
    makeEvent('reactor', 'WI-701', 'item.queued', { spec: 'add acme widget', touches: 'src/' }),
  ]);

  try {
    const provider: LlmProvider = {
      name: 'fake-builder',
      async run(): Promise<ProviderResult> { return { ok: false, error: 'worker did nothing' }; },
    };

    await runDispatch({
      repoRoot: env.repoRoot,
      ledgerDir: env.ledgerDir,
      artifactRunsDir: env.runsDir,
      autonomy: 'on',
      provider,
      config: testConfig(),
      branchProbe: () => 'master',
      authProbeResult: { ok: true },
      pushProbe: () => ({ status: 0 }),
      scoutEnabled: false,
      judgeEnabled: false,
      dispatchSessionId: DISPATCH_PSEUDO_SESSION,
    });

    const events = await loadAllEvents(env.ledgerDir);
    const claimIdx = events.findIndex(e => e.type === 'item.claimed' && e.item === 'WI-701');
    const dispatchIdx = events.findIndex(e => e.type === 'build.dispatched' && e.item === 'WI-701');
    assert.ok(claimIdx >= 0, 'the target lane must reserve the item it picks (item.claimed) — WI-186');
    assert.ok(dispatchIdx >= 0, 'precondition: the targeted build was actually dispatched');
    assert.ok(claimIdx < dispatchIdx, 'the reservation must be written BEFORE the spawn, not after');
    const claimData = events[claimIdx]!.data as { sessionId?: string };
    assert.equal(claimData.sessionId, DISPATCH_PSEUDO_SESSION, 'the claim is held by dispatch\'s per-run pseudo-session (ADR-007 gap 2)');
    // Gap 2: a claim from a non-live identity reserves nothing, so the session must be announced.
    const started = events.find(e => e.type === 'session.started' && (e.data as { sessionId?: string }).sessionId === DISPATCH_PSEUDO_SESSION);
    const beat = events.find(e => e.type === 'session.heartbeat' && (e.data as { sessionId?: string }).sessionId === DISPATCH_PSEUDO_SESSION);
    assert.ok(started && beat, 'dispatch must claim under a LIVE pseudo-session (session.started + session.heartbeat)');
  } finally {
    cleanDir(env.base);
    cleanDir(targetRoot);
  }
});

test('WI-186: a foreign claim landing in the read-to-spawn window makes the target lane YIELD (never spawns)', async () => {
  // The race, reproduced exactly: the picker folds the ledger, and only AFTER that does an
  // attended operator session claim the targeted item. The planning lane (which runs before the
  // target lane in the same beat) is the injection point — its provider call is the window.
  const targetRoot = join(makeTempDir(), 'acme');
  const { hash } = makeTargetRepo(targetRoot);
  const env = await makePlaneEnv([
    makeEvent('cli', 'acme', 'target.registered', { name: 'acme', repoPath: targetRoot, manifestHash: hash, defaultBranch: 'main' }),
    makeEvent('cli', 'WI-710', 'item.captured', { source: 'cli', text: 'decompose an epic' }),
    makeEvent('reactor', 'WI-710', 'item.queued', { spec: 'decompose an epic', lane: 'planning' }),
    makeEvent('cli', 'WI-711', 'item.captured', { source: 'cli', text: 'add acme widget', target: 'acme' }),
    makeEvent('reactor', 'WI-711', 'item.queued', { spec: 'add acme widget', touches: 'src/' }),
  ]);

  try {
    const seenPrompts: string[] = [];
    const provider: LlmProvider = {
      name: 'fake-builder',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        seenPrompts.push(req.prompt);
        if (req.prompt.includes('stub planner prompt')) {
          // THE WINDOW: the picker's fold is already taken; an attended session claims WI-711 now.
          await appendEvents(env.ledgerDir, [
            makeEvent('cli', OP_SESSION, 'session.started', { sessionId: OP_SESSION, source: 'cli' }),
            makeEvent('cli', OP_SESSION, 'session.heartbeat', { sessionId: OP_SESSION }),
            makeEvent('cli', 'WI-711', 'item.claimed', { sessionId: OP_SESSION, ttlMinutes: 60 }),
          ]);
          return { ok: false, error: 'planner did nothing (injector only)' };
        }
        assert.fail(`the targeted build must never spawn once a foreign claim owns it (prompt: ${req.prompt.slice(0, 80)})`);
      },
    };

    const result = await runDispatch({
      repoRoot: env.repoRoot,
      ledgerDir: env.ledgerDir,
      artifactRunsDir: env.runsDir,
      autonomy: 'on',
      provider,
      config: testConfig(),
      branchProbe: () => 'master',
      authProbeResult: { ok: true },
      pushProbe: () => ({ status: 0 }),
      scoutEnabled: false,
      judgeEnabled: false,
      dispatchSessionId: DISPATCH_PSEUDO_SESSION,
    });

    assert.equal(seenPrompts.length, 1, 'exactly one provider call (the planning injector) — the targeted build never ran');
    const step = result.dispatched.find(d => d.item === 'WI-711');
    assert.ok(step, 'the yielded targeted item must be reported, not silently dropped');
    assert.equal(step!.dispatched, false);
    assert.match(step!.detail ?? '', new RegExp(`yielded to attended claim \\(session ${OP_SESSION}\\)`));

    const events = await loadAllEvents(env.ledgerDir);
    assert.equal(
      events.filter(e => e.type === 'build.dispatched' && e.item === 'WI-711').length, 0,
      'no build.dispatched for an item a foreign session owns — this is the double-build the lane used to allow',
    );
    assert.equal(
      events.filter(e => e.type === 'item.claimed' && e.item === 'WI-711' && (e.data as { sessionId?: string }).sessionId === DISPATCH_PSEUDO_SESSION).length, 0,
      'dispatch must not overwrite the operator\'s reservation with its own',
    );
    assert.equal(fold(events).items.get('WI-711')?.state, 'queued', 'the yielded item stays queued for its owner');
  } finally {
    cleanDir(env.base);
    cleanDir(targetRoot);
  }
});

test('fold + isClaimActive: item.merged and item.parked both clear a live claim', () => {
  const base = [
    ...queuedItem('WI-021', T0),
    makeEvent('cli', 'WI-021', 'item.claimed', { sessionId: OP_SESSION, ttlMinutes: 60 }, iso(T0 + 2000)),
  ];
  const sessions = sessionsMap(liveSession(OP_SESSION, T0, T0 + 2500));

  const mergedResult = fold([...base, makeEvent('dispatch', 'WI-021', 'item.merged', { commit: 'abc' }, iso(T0 + 3000))]);
  const mergedRec = mergedResult.items.get('WI-021')!;
  assert.equal(mergedRec.claim, undefined);
  assert.equal(isClaimActive(mergedRec, sessions, T0 + 4000), false);

  const parkedResult = fold([...base, makeEvent('cli', 'WI-021', 'item.parked', { reason: 'test', parkKind: 'ops' }, iso(T0 + 3000))]);
  const parkedRec = parkedResult.items.get('WI-021')!;
  assert.equal(parkedRec.claim, undefined);
  assert.equal(isClaimActive(parkedRec, sessions, T0 + 4000), false);
});
